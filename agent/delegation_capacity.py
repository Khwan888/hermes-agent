"""One direct-child execution budget per conversation, across joined and detached calls."""

from contextlib import nullcontext
from contextvars import ContextVar
from functools import wraps
from threading import Condition, Lock

from hermes_constants import hermes_home_key

_slots = Condition()
_active = {}
_POLL_SECONDS = 0.1  # how quickly a queued child notices a stop; slot releases still wake it at once
_LEASE: ContextVar = ContextVar("delegation_capacity_lease", default=None)


class _Lease:
    """One child's slot. Released exactly once: when its run returns, or — if a timed-out worker still owns
    the child — when that worker actually settles."""

    def __init__(self, key, child):
        self.key, self.child, self.deferred = key, child, False
        self._lock, self._released = Lock(), False

    def release(self):
        with self._lock:
            if self._released:
                return
            self._released = True
        with _slots:
            remaining = _active[self.key] - 1
            if remaining:
                _active[self.key] = remaining
            else:
                del _active[self.key]
            _slots.notify_all()


def release_when_settled(child, future):
    """A timed-out child returns before its worker stops: keep its slot until that worker settles.

    The timeout itself still returns at once; only the slot release moves to the worker's completion."""
    lease = _LEASE.get()
    if lease is None or lease.child is not child:
        return
    lease.deferred = True
    future.add_done_callback(lambda _done: lease.release())


def _attached(parent, child):
    children = getattr(parent, "_active_children", None)
    if children is None:
        return False
    with getattr(parent, "_active_children_lock", None) or nullcontext():
        return any(c is child for c in children)


def _cancelled(parent, child, joined):
    """A queued child stops waiting when it is stopped itself, or — only while it is joined to the
    parent's turn — when that turn is stopped or the parent closes its children. A detached
    (background) child outlives the parent's turn, so the turn's stop does not cancel it."""
    if getattr(child, "_interrupt_requested", False) is True:
        return True
    return joined and (getattr(parent, "_interrupt_requested", False) is True or not _attached(parent, child))


def _skip_unstarted(parent, child, task_index):
    """Same teardown as a batch child that never started; it never held a slot."""
    from tools.delegate_tool_child_run import _close_child, _detach_child, _fabricated_entry
    _detach_child(parent, child)
    _close_child(child, "Failed to close a subagent stopped while waiting for a slot")
    return _fabricated_entry(task_index, "interrupted", "Stopped while waiting for a free subagent slot", child)


def child_capacity(fn):
    @wraps(fn)
    def run(*args, **kwargs):
        from agent.delegation_settings import current_settings
        config = current_settings()
        parent = kwargs.get("parent_agent")
        if not isinstance(config, dict) or parent is None:
            token = _LEASE.set(None)  # a nested unbudgeted run never moves an outer child's slot
            try:
                return fn(*args, **kwargs)
            finally:
                _LEASE.reset(token)
        db = getattr(parent, "_session_db", None)
        key = (str(getattr(db, "db_path", "")) or hermes_home_key(), str(getattr(parent, "session_id", "")))
        from tools.delegate_tool_config import _get_max_concurrent_children
        limit = _get_max_concurrent_children()
        child = kwargs.get("child")
        joined = child is not None and _attached(parent, child)
        # Existing children keep their policy and continue running if the limit is lowered. New
        # children wait for room; an async-capacity fallback cannot bypass the same chat's budget.
        # A child that had to wait is rechecked under the lock before it takes the slot, so a stop
        # that landed meanwhile never runs it late and never consumes or leaks a slot.
        def stopped():
            return child is not None and _cancelled(parent, child, joined)

        with _slots:
            queued = _active.get(key, 0) >= limit
            while _active.get(key, 0) >= limit and not stopped():
                _slots.wait(_POLL_SECONDS)
            skip = queued and stopped()
            if not skip:
                _active[key] = _active.get(key, 0) + 1
        if skip:
            return _skip_unstarted(parent, child, kwargs.get("task_index", args[0] if args else -1))
        lease = _Lease(key, child)
        token = _LEASE.set(lease)
        try:
            return fn(*args, **kwargs)
        finally:
            _LEASE.reset(token)
            if not lease.deferred:
                lease.release()
    return run
