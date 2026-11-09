"""Live subagent attention: a running child that needs the human (``waiting`` on a prompt, ``stuck`` with no
event of its own), plus the persisted finished-unread / over-budget marks on the child's stored session.

Live state sits on the registry record (``attention`` / ``attention_reason`` / ``attention_since``) and every
transition is relayed as a text-less ``subagent.progress`` through the child's own progress relay, so the
identity kwargs ride along and a grandchild's transition passes through its parent's relay unchanged.
Nothing here stops a child: these are flags for the human, never a budget.
"""

from __future__ import annotations

import time
from typing import Any, Optional

from tools.delegate_tool_progress import _ChildProgressRelay, _quiet
from tools import delegate_tool_registry as reg

WAITING, STUCK = "waiting", "stuck"
_ANY = object()

# Terminal exits the human hears about through the stored session's ``end_reason`` (first reason wins,
# written before the child's own ``agent_close``).
_TERMINAL_END_REASONS = {"max_iterations": "subagent_max_iterations", "timeout": "subagent_timeout"}


def _relay_of(callback: Any) -> Optional[_ChildProgressRelay]:
    """The child's own relay under any ``__wrapped__`` tee (the live transcript writer wraps it)."""
    for _ in range(4):
        if isinstance(callback, _ChildProgressRelay) or callback is None:
            return callback
        callback = getattr(callback, "__wrapped__", None)
    return None


def _set_attention(
    subagent_id: str, state: Optional[str], reason: Optional[str] = None, *, expect: Any = _ANY,
) -> bool:
    """Write one transition on the live record and relay it; False (nothing emitted) when the record is gone,
    or its current state is not ``expect``, or the state would not change."""
    with reg._active_subagents_lock:
        record = reg._active_subagents.get(subagent_id)
        if record is None or (expect is not _ANY and record.get("attention") != expect):
            return False
        if record.get("attention") == state and record.get("attention_reason") == reason:
            return False
        since = time.time() if state else None
        record.update(attention=state, attention_reason=reason, attention_since=since)
        relay = _relay_of(getattr(record.get("agent"), "tool_progress_callback", None))
    if relay is not None:
        relay._relay("subagent.progress", attention=state, attention_reason=reason, attention_since=since)
    return True


def clear_stuck(subagent_id: str) -> None:
    """The child relayed an event of its own: a ``stuck`` flag (and only that) clears."""
    _set_attention(subagent_id, None, expect=STUCK)


def _current_child_subagent_id() -> Optional[str]:
    """The live record of the delegated child running in this context, matched by the task-local session id
    ``delegated_child_context`` binds (the child's own stored session)."""
    from agent.delegation_context import is_delegated_child_context
    if not is_delegated_child_context():
        return None
    from gateway.session_context import get_session_env
    session_id = get_session_env("HERMES_SESSION_ID")
    if not session_id:
        return None
    with reg._active_subagents_lock:
        return next((sid for sid, record in reg._active_subagents.items()
                     if getattr(record.get("agent"), "session_id", None) == session_id), None)


def mark_waiting(kind: str) -> Optional[str]:
    """Flag the delegated child running here as ``waiting`` (reason = ``kind``: approval / sudo / clarify) while
    a human prompt blocks it; returns its subagent_id for :func:`clear_waiting`, or None outside a child."""
    subagent_id = _current_child_subagent_id()
    if subagent_id is None or not _set_attention(subagent_id, WAITING, kind):
        return None
    return subagent_id


def clear_waiting(subagent_id: str) -> None:
    """The prompt resolved: clear ``waiting`` and restart the relay's clock, so time spent on the human never
    reads as the child being stuck."""
    with reg._active_subagents_lock:
        record = reg._active_subagents.get(subagent_id)
        relay = _relay_of(getattr(record.get("agent"), "tool_progress_callback", None)) if record else None
    if relay is not None:
        relay.last_event_at = time.monotonic()
    _set_attention(subagent_id, None, expect=WAITING)


def _has_running_child(subagent_id: str) -> bool:
    return any(r.get("parent_id") == subagent_id and r.get("status") == "running" for r in reg._active_subagents.values())


class StuckWatch:
    """One child's ``stuck`` check on the shared periodic scheduler (same as ``_Heartbeat``). A running child
    with no running child of its own that is not ``waiting`` is flagged once when its relay's last own event is
    ``stuck_after`` seconds old; the relay clears the flag on the next event."""

    def __init__(self, subagent_id: str, relay: _ChildProgressRelay, stuck_after: float):
        self.subagent_id, self.relay, self.stuck_after = subagent_id, relay, stuck_after
        self.handle = None

    @property
    def interval(self) -> float:
        return min(30.0, max(1.0, self.stuck_after / 4))

    def start(self) -> None:
        from agent.periodic_scheduler import schedule
        self.handle = schedule(self.tick, self.interval)

    def stop(self) -> None:
        if self.handle is not None:
            self.handle.cancel(wait=5)

    def tick(self):
        """Returning False stops the periodic callback (the record is gone)."""
        with reg._active_subagents_lock:
            record = reg._active_subagents.get(self.subagent_id)
            if record is None:
                return False
            if (record.get("status") != "running" or record.get("attention") is not None
                    or _has_running_child(self.subagent_id)):
                return None
        if time.monotonic() - self.relay.last_event_at >= self.stuck_after:
            _set_attention(self.subagent_id, STUCK, expect=None)
        return None


def start_stuck_watch(child: Any, subagent_id: Optional[str]) -> Optional[StuckWatch]:
    """Start the child's stuck watch, or None when it has no registry id, no relay (nobody to tell) or
    ``delegation.stuck_after_seconds`` is 0."""
    from tools.delegate_tool_config import _get_stuck_after_seconds
    relay = _relay_of(getattr(child, "tool_progress_callback", None))
    stuck_after = _get_stuck_after_seconds()
    if not subagent_id or relay is None or stuck_after <= 0:
        return None
    watch = StuckWatch(subagent_id, relay, stuck_after)
    watch.start()
    return watch


def persist_terminal_attention(child: Any, status: Optional[str], exit_reason: Optional[str]) -> None:
    """Mark a finished child's stored session unread (any end but a deliberate stop) and, for a budget stop,
    record why it ended. Runs before the child's close() writes ``agent_close``; ``end_session`` is
    first-reason-wins, so the specific reason sticks."""
    if status == "interrupted" or exit_reason == "interrupted":
        return
    db, session_id = getattr(child, "_session_db", None), getattr(child, "session_id", None)
    if db is None or not isinstance(session_id, str) or not session_id:
        return
    end_reason = _TERMINAL_END_REASONS.get("timeout" if status == "timeout" else exit_reason or "")
    with _quiet("subagent: persisting finished-unread for %s failed: %s", session_id):
        if end_reason:
            db.end_session(session_id, end_reason)
        db.set_session_read(session_id, False)


def live_attention_owners() -> list[tuple[str, str]]:
    """``(attention, owner_agent_session_id of the depth-0 ancestor)`` for every flagged live child at any
    depth: a grandchild's flag belongs to the conversation that spawned its tree."""
    with reg._active_subagents_lock:
        records = {sid: dict(r) for sid, r in reg._active_subagents.items()}
    owners = []
    for record in records.values():
        if not record.get("attention"):
            continue
        root, hops = record, 0
        while root.get("parent_id") in records and hops < 16:
            root, hops = records[root["parent_id"]], hops + 1
        owners.append((record["attention"], str(root.get("owner_agent_session_id") or "")))
    return owners
