"""A child queued behind the chat's subagent limit can be stopped while it waits, and never runs late."""

import contextvars
import threading
import types

import pytest

from tests.waiting import wait_until

LIMIT_ONE = {"backend": "default", "model": "", "provider": "", "reasoning_effort": "", "max_spawn_depth": 1,
             "max_concurrent_children": 1, "backends": {}}


class _CountingCondition(threading.Condition):
    """Counts slot waits so a test knows the queued call is waiting and re-checking, not sleeping."""

    def __init__(self):
        super().__init__()
        self.waits = 0

    def wait(self, timeout=None):
        self.waits += 1
        return super().wait(timeout)


@pytest.fixture
def slots(monkeypatch):
    from agent import delegation_capacity
    condition = _CountingCondition()
    monkeypatch.setattr(delegation_capacity, "_slots", condition)
    return condition


def _child(name):
    child = types.SimpleNamespace(name=name, _interrupt_requested=False, closed=False, _delegate_role="leaf")
    child.close = lambda: setattr(child, "closed", True)
    return child


def _parent():
    return types.SimpleNamespace(session_id="capacity-chat", _session_db=None, _interrupt_requested=False,
                                 _active_children=[], _active_children_lock=threading.Lock())


def _start(fn, **kwargs):
    from agent.delegation_settings import settings_scope
    out = {}

    def target():
        with settings_scope(LIMIT_ONE):
            out["entry"] = fn(**kwargs)
    thread = threading.Thread(target=contextvars.copy_context().run, args=(target,), daemon=True)
    thread.start()
    return thread, out


def _runner(release, entered):
    from agent.delegation_capacity import child_capacity

    @child_capacity
    def run(task_index, goal, child=None, parent_agent=None, **_):
        entered.append(task_index)
        if task_index == 0:
            assert release.wait(10)
        return {"task_index": task_index, "status": "completed", "summary": "ok"}
    return run


def _stop_parent(parent, child):
    parent._interrupt_requested = True


def _stop_child(parent, child):
    child._interrupt_requested = True


def _close_parent(parent, child):
    with parent._active_children_lock:
        parent._active_children.clear()  # AIAgent.close() → _close_active_children


@pytest.mark.parametrize("joined,cancel", [(True, _stop_parent), (True, _stop_child), (True, _close_parent),
                                           (False, _stop_child)],
                         ids=["parent-stop", "child-stop", "parent-closed", "detached-child-stop"])
def test_queued_child_is_cancelled_without_a_slot_or_late_run(slots, joined, cancel):
    from agent import delegation_capacity

    release, entered, parent = threading.Event(), [], _parent()
    run = _runner(release, entered)
    incumbent, _ = _start(run, task_index=0, goal="hung incumbent", child=_child("a"), parent_agent=parent)
    assert wait_until(lambda: entered == [0], timeout=5)
    queued_child = _child("b")
    if joined:
        parent._active_children.append(queued_child)
    queued, out = _start(run, task_index=1, goal="queued", child=queued_child, parent_agent=parent)
    assert wait_until(lambda: slots.waits >= 1, timeout=5)
    assert queued.is_alive() and entered == [0]  # really waiting for the slot
    try:
        cancel(parent, queued_child)
        queued.join(3)  # the incumbent still holds the only slot
        assert not queued.is_alive(), "a stopped call stayed blocked behind the hung incumbent"
        assert out["entry"]["status"] == "interrupted" and out["entry"]["task_index"] == 1
        assert queued_child.closed and queued_child not in parent._active_children
    finally:
        release.set()
        incumbent.join(5)
        queued.join(5)
    assert entered == [0]  # never executed after capacity opened
    assert delegation_capacity._active == {}  # no slot leaked or double-released


def test_detached_child_ignores_the_parent_turn_stop_and_runs_when_a_slot_opens(slots):
    from agent import delegation_capacity

    release, entered, parent = threading.Event(), [], _parent()
    run = _runner(release, entered)
    incumbent, _ = _start(run, task_index=0, goal="incumbent", child=_child("a"), parent_agent=parent)
    assert wait_until(lambda: entered == [0], timeout=5)
    background = _child("b")  # a background unit's child is detached from the parent's turn
    queued, out = _start(run, task_index=2, goal="background", child=background, parent_agent=parent)
    assert wait_until(lambda: slots.waits >= 1, timeout=5)
    parent._interrupt_requested = True
    seen = slots.waits
    assert wait_until(lambda: slots.waits >= seen + 2, timeout=5)  # re-checked the stop, kept waiting
    assert queued.is_alive() and entered == [0]
    release.set()
    incumbent.join(5)
    queued.join(5)
    assert entered == [0, 2] and out["entry"]["status"] == "completed" and not background.closed
    assert delegation_capacity._active == {}
