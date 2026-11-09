"""The stored session of a delegated child, addressed by its ``subagent_id``.

``delegate_tool._build_child_agent`` stamps the child's ``model_config`` with ``SUBAGENT_ID_KEY``
beside ``_delegate_from``. Compression copies ``model_config`` onto every continuation, so each
segment of the child carries it. The live registry forgets a child when it ends; this marker is
how a viewer that only holds the ``subagent_id`` (the dispatch result, a ``subagent.list`` row)
still finds the child's stored transcript afterwards.

``delegate_call_children`` answers the question a transcript card asks: which stored session ran
task *i* of the ``delegate_task`` call it renders. It needs no marker at all, so it also links the
subagents spawned before ``_subagent_id`` existed (most of a long-lived store).
"""

from __future__ import annotations

import json
from bisect import bisect_right
from typing import Any, Iterable, Optional

SUBAGENT_ID_KEY = "_subagent_id"


def stored_child_session(db: Any, subagent_id: str, conversation_ids: Iterable[str]) -> Optional[str]:
    """The newest segment of child *subagent_id* when it descends from one of *conversation_ids*,
    else None.

    A ``subagent_id`` is a random 32-bit suffix, so a match alone proves nothing: the row's
    ``parent_session_id`` chain must reach the conversation, and a hop is followed only when the
    row is its parent's delegate child or compression continuation. A branch or reset fork of the
    conversation, or any unrelated session, never lends its children. Every segment carries the
    marker, so the tip is the owned segment that no owned segment continues by compression
    (``get_compression_tip`` does not follow a delegate child's rotations: its chain step skips rows
    carrying ``_delegate_from``)."""
    ancestors = frozenset(sid for sid in conversation_ids if sid)
    if not subagent_id or not ancestors:
        return None
    candidates = db.subagent_session_ids(subagent_id, SUBAGENT_ID_KEY)
    get, owns = _lineage_reader(db, ancestors)
    owned = [sid for sid in candidates if owns(sid)]
    # The tip is the owned segment no owned segment continues by compression; ``started_at`` only breaks
    # a tie, since the wall clock can step back between a rotation's two rows.
    owned_ids = frozenset(owned)
    continued = {seg["parent_session_id"] for seg in map(get, owned)
                 if seg is not None and seg.get("parent_session_id") in owned_ids and _continues(db, seg, get)}
    return next((sid for sid in owned if sid not in continued), None)


def _lineage_reader(db: Any, ancestors: frozenset[str]):
    """``(get, owns)`` for one lookup. ``get`` reads each session row at most once; ``owns(sid)`` says whether
    *sid*'s chain reaches *ancestors* and records the verdict for every row it walked, since all of a
    child's segments share the chain above them (with ``compression.in_place: false`` every rotation is
    one more segment). Each rotation is a hop, so a long-lived child's chain has no useful bound; a row
    met twice on one walk ends a cycle."""
    rows: dict[str, Any] = {}
    verdicts: dict[str, bool] = {}

    def get(session_id: str) -> Any:
        if session_id not in rows:
            rows[session_id] = db.get_session(session_id)
        return rows[session_id]

    def owns(session_id: str) -> bool:
        path: dict[str, None] = {}
        current, verdict = get(session_id), False
        while current is not None:
            sid = current["id"]
            if sid in verdicts or sid in ancestors:
                verdict = verdicts.get(sid, True)
                break
            if sid in path:
                break
            path[sid] = None
            parent = current.get("parent_session_id")
            if not parent or not (_delegated_from(current, parent) or _continues(db, current, get)):
                break
            current = get(parent)
        verdicts.update(dict.fromkeys(path, verdict))
        return verdict

    return get, owns


def _continues(db: Any, row: dict[str, Any], get) -> bool:
    """``SessionDB._is_compression_child_row`` over the lookup's cached rows: not a branch, delegate, tool or
    reset child of its parent, and the parent ended ``compression``."""
    parent = get(row["parent_session_id"]) if row.get("parent_session_id") else None
    return bool(parent and not db._is_explicit_fork_child_row(row, include_reset=True)
                and parent.get("end_reason") == "compression")


def _delegated_from(row: dict[str, Any], parent: str) -> bool:
    """The marker only counts when it names the row's own parent: a compression continuation
    inherits the root's ``_delegate_from`` and reaches the delegator through its compression hops."""
    cfg = row.get("model_config")
    if isinstance(cfg, str):
        try:
            cfg = json.loads(cfg)
        except ValueError:
            return False
    return isinstance(cfg, dict) and cfg.get("_delegate_from") == parent


# A child row is written a moment after the assistant message that asked for it; the message timestamp is
# taken before the tool runs, so a child never starts earlier than this much before its call.
_CALL_CLOCK_SLACK = 1.0


def delegate_call_children(db: Any, conversation_ids: Iterable[str],
                           tool_call_id: str) -> Optional[list[Optional[str]]]:
    """The stored session (newest segment) that ran each task of ``delegate_task`` call *tool_call_id*,
    in task order (None where none is proven), or None when the conversation holds no such call.

    *conversation_ids* is the conversation's compression lineage. Only its delegate children count: a
    ``source='subagent'`` row whose ``parent_session_id`` is in the lineage and whose ``_delegate_from``
    names that same parent, so a branch, reset or another conversation's subagent is never linked.

    Exact ids first: the call's stored result names its children (``child_session_ids``, a settled
    entry's ``child_session_id``, or ``subagent_ids`` matched to the ``_subagent_id`` marker). A failed or
    timed-out child that ran is named like any other. Children of calls whose result names nobody (every
    result written before those keys existed, a result too big to keep inline, or a call with no result
    yet) are linked by what the row itself proves: its first user message is that task's goal (see
    ``_goal_matches``), and it started inside its call's window (see ``_claim_goal_children``). A call its
    tool rejected outright, and a task its backend refused, spawned nothing and never claim a row. Every
    exact goal match is allocated before any wrapped-goal match, so ``Review auth`` never takes the child of
    ``Review auth tests`` whichever started first, and a legacy record that could name more than one child
    stays None rather than open the wrong transcript."""
    lineage = frozenset(sid for sid in conversation_ids if sid)
    if not tool_call_id or not lineage:
        return None
    calls = _delegate_calls(db.delegate_call_rows(lineage))
    if not any(call["id"] == tool_call_id for call in calls):
        return None
    roots = [row for row in db.subagent_rows_under(lineage)
             if row.get("delegate_from") and row["delegate_from"] == row.get("parent_session_id")]
    by_id = {row["id"]: row for row in roots}
    by_marker = {row["subagent_marker"]: row["id"] for row in roots if row.get("subagent_marker")}
    claimed: set[str] = set()
    links: dict[str, list[Optional[str]]] = {}
    for call in calls:  # exact ids, every call, before any goal is matched
        exact = [_exact_child(call, i, by_id, by_marker) for i in range(len(call["goals"]))]
        exact = [sid if sid not in claimed else None for sid in exact]
        claimed.update(sid for sid in exact if sid)
        links[call["id"]] = exact
    texts = {row["id"]: _first_user_text(db, row.get("first_user")) for row in roots}
    for kind in ("exact", "wrapped"):  # every exact match, every call, before any wrapped one
        _claim_goal_children(calls, links, roots, texts, claimed, kind)
    found = links[tool_call_id]
    return [_newest_segment(db, sid) if sid else None for sid in found]


def _delegate_calls(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """``{id, ts, goals, result, closed}`` per spawning ``delegate_task`` call, in the order it was made (the
    first stored copy of a call wins: compaction can write it again). ``closed`` holds the task indexes that
    provably started no child (see ``_no_child_tasks``)."""
    calls: dict[str, dict[str, Any]] = {}
    results: dict[str, Any] = {}
    for row in rows:
        if row.get("role") == "tool":
            results.setdefault(row.get("tool_call_id") or "", row.get("content"))
            continue
        for call in _json(row.get("tool_calls"), list):
            fn = call.get("function") if isinstance(call, dict) else None
            if not isinstance(fn, dict) or fn.get("name") != "delegate_task" or not call.get("id"):
                continue
            args = _json(fn.get("arguments"), dict)
            if args.get("action") in ("list", "steer", "stop"):
                continue  # live control spawns nothing; the default action is "spawn"
            tasks = args.get("tasks") if isinstance(args.get("tasks"), list) else None
            goals = ([_text(t.get("goal")) if isinstance(t, dict) else "" for t in tasks] if tasks
                     else [_text(args.get("goal"))] if args.get("goal") else [])
            calls.setdefault(call["id"], {"id": call["id"], "ts": row.get("timestamp") or 0.0, "goals": goals})
    for call in calls.values():
        call["result"] = _json(results.get(call["id"]), dict)
        call["closed"] = _no_child_tasks(call["result"], len(call["goals"]))
    return sorted(calls.values(), key=lambda call: call["ts"])


# Keys only a call that got as far as dispatching writes; a bare ``tool_error`` envelope has none of them.
_DISPATCH_KEYS = ("status", "results", "child_session_ids", "subagent_ids", "delegation_id", "refused")


def _no_child_tasks(result: dict[str, Any], count: int) -> frozenset[int]:
    """The task indexes of a call that provably started no child: every task when the tool rejected the call
    before building any child (its result is only ``tool_error``'s ``{"error": ...}``), else the tasks its
    backend refused (listed under ``refused``, or an entry whose ``route`` says ``refused``). A missing or
    unreadable result proves nothing, and a failed or timed-out child did run: neither closes a task."""
    if result.get("error") and not any(key in result for key in _DISPATCH_KEYS):
        return frozenset(range(count))
    refused = [e for e in result.get("refused") or [] if isinstance(e, dict)]
    refused += [e for e in result.get("results") or []
                if isinstance(e, dict) and isinstance(e.get("route"), dict) and e["route"].get("refused") is True]
    return frozenset(e["task_index"] for e in refused if isinstance(e.get("task_index"), int))


def _exact_child(call: dict[str, Any], index: int, by_id: dict[str, Any], by_marker: dict[str, str]) -> Optional[str]:
    result = call["result"]
    entries = [e for e in result.get("results") or [] if isinstance(e, dict) and e.get("task_index") == index]
    for candidate in (_at(result.get("child_session_ids"), index),
                      *(e.get("child_session_id") for e in entries)):
        if isinstance(candidate, str) and candidate in by_id:
            return candidate
    # ``subagent_ids`` lists the children that started (a refused task has none); each id is ``sa-<task>-…``.
    listed = [s for s in result.get("subagent_ids") or [] if isinstance(s, str) and s.startswith(f"sa-{index}-")]
    for marker in (*listed, *(e.get("subagent_id") for e in entries)):
        if isinstance(marker, str) and marker in by_marker:
            return by_marker[marker]
    return None


# What the delegate tool itself appends to a child's goal in its first user message: the worktree isolation
# note (``subagent_worktree.build_worktree_context_note``) and text-mode image hints
# (``delegate_tool_child_run._build_child_goal_message``). Any other suffix is a different goal.
_GOAL_WRAPPERS = ("[WORKTREE ISOLATION]", "[Image attached")


def _goal_matches(text: str, goal: str, kind: str) -> bool:
    """``exact``: the first user message is the goal. ``wrapped``: the goal, a line break, then one of the
    delegate tool's own ``_GOAL_WRAPPERS``."""
    if kind == "exact":
        return text == goal
    rest = text[len(goal):] if text.startswith(goal) else ""
    return rest[:1] == "\n" and rest.lstrip().startswith(_GOAL_WRAPPERS)


def _claim_goal_children(calls: list[dict[str, Any]], links: dict[str, list[Optional[str]]],
                         roots: list[dict[str, Any]], texts: dict[str, str], claimed: set[str], kind: str) -> None:
    """Link the open tasks of *calls* (unlinked, not closed) to unclaimed children whose first user message
    matches the task's goal by *kind*, using only what proves which call ran a child.

    A child's row is written while its call runs, before the parent's next turn, so a row belongs to the
    calls made at the latest call instant at or before its start (``_CALL_CLOCK_SLACK`` allowed): never to an
    earlier call, never to a later one. Calls of one instant are one assistant message. Within that window the
    open tasks of one goal and the matching rows must pair up exactly: exact matches go out by ``started_at``
    (tasks start in task order, and the rows are identical apart from that) only when one call holds every
    such task, the rows number the tasks, and no two started at the same instant; a wrapped match must be
    the only row for a single task. Anything else is ambiguous and stays None; its rows are not handed to any
    other task."""
    instants = sorted({call["ts"] for call in calls})
    windows: dict[tuple[float, str], list[dict[str, Any]]] = {}
    for row in roots:
        start = row.get("started_at")
        if row["id"] in claimed or not isinstance(start, (int, float)):
            continue
        at = bisect_right(instants, start + _CALL_CLOCK_SLACK) - 1
        if at < 0:
            continue
        goals = {goal.strip() for call in calls if call["ts"] == instants[at]
                 for i, goal in enumerate(call["goals"]) if _open(call, links, i)}
        for goal in goals:
            if _goal_matches(texts[row["id"]], goal, kind):
                windows.setdefault((instants[at], goal), []).append(row)
    for (ts, goal), rows in windows.items():
        slots = [(call, i) for call in calls if call["ts"] == ts
                 for i, g in enumerate(call["goals"]) if _open(call, links, i) and g.strip() == goal]
        one_call = len({call["id"] for call, _ in slots}) == 1
        if kind == "exact":
            starts = {row.get("started_at") for row in rows}
            taken = rows if one_call and len(rows) == len(slots) == len(starts) else []
        else:
            taken = rows if len(slots) == 1 and len(rows) == 1 else []
        claimed.update(row["id"] for row in rows)  # a row of an ambiguous window is never lent to another task
        for (call, i), row in zip(slots, taken):
            links[call["id"]][i] = row["id"]


def _open(call: dict[str, Any], links: dict[str, list[Optional[str]]], index: int) -> bool:
    """Task *index* of *call* is still unlinked, has a goal, and may have started a child."""
    return links[call["id"]][index] is None and index not in call["closed"] and bool(call["goals"][index].strip())


def _first_user_text(db: Any, content: Any) -> str:
    """The goal text of a child's first user message: the text parts of a stored multimodal message
    (an image-forwarding task on a vision child), else the message itself; stripped."""
    decode = getattr(db, "_decode_content", None)
    if callable(decode) and isinstance(content, str):
        content = decode(content)
    if isinstance(content, list):
        content = "".join(part.get("text") or "" for part in content
                          if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str))
    return _text(content).strip()


def _newest_segment(db: Any, root: str) -> str:
    """*root*'s newest compression continuation (a delegate child rotates like any session)."""
    rows: dict[str, Any] = {}

    def get(session_id: str) -> Any:
        if session_id not in rows:
            rows[session_id] = db.get_session(session_id)
        return rows[session_id]

    current, seen = root, {root}
    while True:
        nxt = next((row["id"] for row in reversed(db.subagent_rows_under([current]))
                    if row["id"] not in seen and (full := get(row["id"])) is not None
                    and _continues(db, full, get)), None)
        if nxt is None:
            return current
        seen.add(nxt)
        current = nxt


def _json(value: Any, kind: type) -> Any:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return kind()
    return value if isinstance(value, kind) else kind()


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _at(values: Any, index: int) -> Any:
    return values[index] if isinstance(values, list) and 0 <= index < len(values) else None
