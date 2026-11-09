"""Cancelling a real child runner while queued does not start it after capacity opens."""

import contextvars
import threading

from tests.agent.test_delegation_capacity import LIMIT_ONE, _CountingCondition
from tests.tools.test_delegate_capacity_interrupt import _ControlledChild, _Parent
from tests.waiting import wait_until


def test_real_queued_child_runner_is_stopped_before_registration(monkeypatch):
    from agent import delegation_capacity
    from agent.delegation_settings import settings_scope
    from tools.delegate_tool import _run_single_child

    slots = _CountingCondition()
    monkeypatch.setattr(delegation_capacity, "_slots", slots)
    parent, child = _Parent(), _ControlledChild()
    parent._active_children.append(child)
    release, occupied = threading.Event(), threading.Event()
    outcome = {}

    @delegation_capacity.child_capacity
    def incumbent(*, parent_agent):
        occupied.set()
        assert release.wait(20)

    def start(fn):
        def scoped():
            with settings_scope(LIMIT_ONE):
                fn()
        thread = threading.Thread(target=contextvars.copy_context().run, args=(scoped,), daemon=True)
        thread.start()
        return thread

    occupying = start(lambda: incumbent(parent_agent=parent))
    assert occupied.wait(5)
    queued = start(lambda: outcome.update(entry=_run_single_child(
        task_index=1, goal="Queued child", child=child, parent_agent=parent)))
    try:
        assert wait_until(lambda: slots.waits >= 1, timeout=5)
        parent.hard_interrupt("stop queued child")
        queued.join(5)
        assert not queued.is_alive(), "stop must return without releasing the incumbent"
        assert outcome["entry"]["status"] == "interrupted"
        assert child.closed.is_set() and child.close_count == 1
        assert not child.started.is_set()
        assert child not in parent._active_children
    finally:
        release.set()
        child.allow_finish.set()
        occupying.join(5)
        queued.join(5)
    assert not child.started.is_set()  # freeing capacity cannot start stopped work late
    assert delegation_capacity._active == {}


def test_timed_out_child_keeps_its_slot_until_its_worker_settles(monkeypatch):
    """A timeout returns at once, but the abandoned worker still runs: the next child queues (and stays
    cancellable) until that worker actually settles, which releases the slot exactly once."""
    from agent import delegation_capacity
    from agent.delegation_settings import settings_scope
    from tools import delegate_tool as dt

    slots = _CountingCondition()
    monkeypatch.setattr(delegation_capacity, "_slots", slots)
    monkeypatch.setattr(dt, "_get_child_timeout", lambda: 0.1)
    monkeypatch.setattr(dt, "_dump_subagent_timeout_diagnostic", lambda **kw: None)
    parent, first, second, third = _Parent(), _ControlledChild(), _ControlledChild(), _ControlledChild()
    second.session_id += "-second"
    third.session_id += "-third"
    parent._active_children.extend([first, second, third])
    scope = {**LIMIT_ONE, "worktree_isolation": False}
    outcome = {}

    def start(name, **kwargs):
        def scoped():
            with settings_scope(scope):
                outcome[name] = dt._run_single_child(parent_agent=parent, **kwargs)
        thread = threading.Thread(target=contextvars.copy_context().run, args=(scoped,), daemon=True)
        thread.start()
        return thread

    try:
        with settings_scope(scope):
            timed_out = dt._run_single_child(task_index=0, goal="first", child=first, parent_agent=parent)
        assert timed_out["status"] == "timeout"  # the timeout itself returned promptly
        assert first.unwinding.wait(5) and not first.finished.is_set()
        assert sum(delegation_capacity._active.values()) == 1  # still owned by the running worker

        # A queued child stays cancellable while the slot is held.
        cancelled = start("cancelled", task_index=1, goal="cancelled", child=second)
        assert wait_until(lambda: slots.waits >= 1, timeout=5)
        second._interrupt_requested = True
        cancelled.join(5)
        assert not cancelled.is_alive() and outcome["cancelled"]["status"] == "interrupted"
        assert not second.started.is_set()

        waits = slots.waits
        queued = start("queued", task_index=2, goal="queued", child=third)
        assert wait_until(lambda: slots.waits >= waits + 2, timeout=5)
        assert not third.started.is_set(), "a second worker started while the timed-out one still runs"

        first.allow_finish.set()  # the abandoned worker settles: its slot opens exactly once
        assert wait_until(lambda: first.closed.is_set(), timeout=5)
        assert wait_until(lambda: third.started.is_set(), timeout=5)
        # Released once: the queued child now holds the only slot (a second release would empty it).
        assert sum(delegation_capacity._active.values()) == 1 and not third.finished.is_set()
        third.allow_finish.set()  # it times out the same way; its own worker then settles
        queued.join(10)
        assert not queued.is_alive() and outcome["queued"]["status"] == "timeout"
    finally:
        for child in (first, second, third):
            child.allow_finish.set()
            child.stop_received.set()  # never leave a worker parked if an assertion above failed
    assert wait_until(lambda: delegation_capacity._active == {}, timeout=5)  # every slot returned, none twice
