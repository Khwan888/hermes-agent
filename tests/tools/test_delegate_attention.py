"""A running subagent that needs the human is flagged on its live record and relayed as a transition event:
``waiting`` while a human prompt blocks it, ``stuck`` when it relays nothing of its own for
``delegation.stuck_after_seconds`` (an orchestrator waiting on a live child is not stuck). A finished subagent's
stored session is left unread, and a budget stop records why it ended, before the child's own close."""

from __future__ import annotations

import time
from types import SimpleNamespace

import pytest

from agent.delegation_context import delegated_child_context
from tools import delegate_tool_registry as reg
from tools.delegate_tool_child_run import _register_child
from tools.delegate_tool_progress import _build_child_progress_callback
from tools.human_input_hooks import human_input_request
from tui_gateway.tool_progress import _subagent_payload

_ATTENTION_KEYS = ("attention", "attention_reason", "attention_since")


@pytest.fixture
def live():
    """Register fake live children in the real registry (the relay reads it) and drop them afterwards."""
    registered: list[str] = []

    def spawn(subagent_id, *, session_id, parent=None, parent_id=None, depth=1):
        events: list[tuple[str, dict]] = []
        parent_cb = parent if parent is not None else (lambda kind, name, preview, args, **kw: events.append((kind, kw)))
        relay = _build_child_progress_callback(
            0, f"goal of {subagent_id}", SimpleNamespace(tool_progress_callback=parent_cb),
            subagent_id=subagent_id, parent_id=parent_id, depth=depth - 1, session_ref={"session_id": session_id},
        )
        child = SimpleNamespace(_subagent_id=subagent_id, _parent_subagent_id=parent_id, _delegate_depth=depth,
                                session_id=session_id, tool_progress_callback=relay, model="m")
        _register_child(child, None, f"goal of {subagent_id}", owner_session_id=None, owner_transport=None,
                        owner_session_record=None)
        registered.append(subagent_id)
        return relay, events

    yield spawn
    for subagent_id in registered:
        reg._unregister_subagent(subagent_id)


def _record(subagent_id):
    return {k: reg._active_subagents[subagent_id].get(k) for k in _ATTENTION_KEYS}


def _transitions(events):
    return [(kind, {k: kw[k] for k in _ATTENTION_KEYS}) for kind, kw in events if "attention" in kw]


def test_a_human_prompt_inside_a_delegated_child_flags_it_waiting_until_the_prompt_resolves(live):
    _relay, events = live("sa-0-wait", session_id="child-wait")
    with delegated_child_context("child-wait"):
        with human_input_request("approval", prompt="rm -rf /tmp/x") as human:
            during = _record("sa-0-wait")
            human.outcome = "approved"
    assert during["attention"] == "waiting" and during["attention_reason"] == "approval"
    assert isinstance(during["attention_since"], float)
    assert _record("sa-0-wait") == {"attention": None, "attention_reason": None, "attention_since": None}
    (start_kind, started), (end_kind, ended) = _transitions(events)
    assert start_kind == end_kind == "subagent.progress"
    assert started == during
    assert ended == {"attention": None, "attention_reason": None, "attention_since": None}
    # Transition frames carry the child's identity and no text.
    first = next(kw for _, kw in events if "attention" in kw)
    assert first["subagent_id"] == "sa-0-wait" and first["child_session_id"] == "child-wait"
    payload = _subagent_payload("subagent.progress", None, None, first, show_reasoning=False)
    assert payload["attention"] == "waiting" and payload["attention_reason"] == "approval"
    assert "text" not in payload


def test_a_prompt_outside_a_delegated_child_flags_nothing(live):
    _relay, events = live("sa-0-main", session_id="main-sid")
    with human_input_request("sudo", prompt="sudo ls") as human:
        assert _record("sa-0-main")["attention"] is None
        human.outcome = "approved"
    assert _transitions(events) == []


def test_a_prompt_that_raises_still_clears_the_flag(live):
    _relay, events = live("sa-0-raise", session_id="child-raise")
    with pytest.raises(RuntimeError), delegated_child_context("child-raise"):
        with human_input_request("sudo", prompt="sudo ls"):
            raise RuntimeError("prompt transport died")
    assert _record("sa-0-raise")["attention"] is None
    assert [t["attention"] for _, t in _transitions(events)] == ["waiting", None]


def test_a_silent_child_is_flagged_stuck_once_and_its_next_event_clears_it(live):
    from tools.delegate_tool_attention import StuckWatch

    relay, events = live("sa-0-quiet", session_id="child-quiet")
    watch = StuckWatch("sa-0-quiet", relay, stuck_after=300)
    relay.last_event_at = time.monotonic() - 299
    watch.tick()
    assert _record("sa-0-quiet")["attention"] is None
    relay.last_event_at = time.monotonic() - 301
    watch.tick()
    watch.tick()  # once per transition
    assert _record("sa-0-quiet")["attention"] == "stuck"
    assert [t["attention"] for _, t in _transitions(events)] == ["stuck"]

    relay("tool.started", "terminal", "ls -la")
    assert _record("sa-0-quiet") == {"attention": None, "attention_reason": None, "attention_since": None}
    assert [t["attention"] for _, t in _transitions(events)] == ["stuck", None]
    cleared = [kw for _, kw in events if "attention" in kw][-1]
    payload = _subagent_payload("subagent.progress", None, None, cleared, show_reasoning=False)
    assert {k: payload[k] for k in _ATTENTION_KEYS} == {"attention": None, "attention_reason": None,
                                                         "attention_since": None}
    assert relay.last_event_at > time.monotonic() - 5


def test_a_child_teed_into_its_live_transcript_is_still_watched_and_flagged(live, monkeypatch):
    """Real children carry the live-transcript tee around their relay; the flag must still reach the parent."""
    from tools.delegate_tool_attention import start_stuck_watch
    from tools.delegation_live_log import wrap_progress_callback

    relay, events = live("sa-0-tee", session_id="child-tee")
    child = reg._active_subagents["sa-0-tee"]["agent"]
    writer = SimpleNamespace(observe=lambda *a, **k: None, flush_stream=lambda: None)
    child.tool_progress_callback = wrap_progress_callback(relay, writer)
    monkeypatch.setattr("tools.delegate_tool_config._get_stuck_after_seconds", lambda: 300)
    watch = start_stuck_watch(child, "sa-0-tee")
    assert watch is not None
    try:
        relay.last_event_at = time.monotonic() - 301
        watch.tick()
    finally:
        watch.stop()
    assert [t["attention"] for _, t in _transitions(events)] == ["stuck"]
    child.tool_progress_callback("tool.started", "terminal", "ls")
    assert [t["attention"] for _, t in _transitions(events)] == ["stuck", None]


@pytest.mark.parametrize("event", [("_thinking", "planning"), ("subagent.text", None, "partial reply"),
                                   ("subagent_progress", "batched summary"), ("subagent.start", None, "goal")])
def test_every_own_event_restarts_the_stuck_clock(live, event):
    relay, _events = live("sa-0-tick", session_id="child-tick")
    relay.last_event_at = 0.0
    relay(*event)
    assert relay.last_event_at > time.monotonic() - 5


def test_an_orchestrator_waiting_on_a_live_child_is_not_stuck_but_its_silent_child_is(live):
    from tools.delegate_tool_attention import StuckWatch

    outer, events = live("sa-0-outer", session_id="outer-sid")
    inner, _ = live("sa-0-inner", session_id="inner-sid", parent=outer, parent_id="sa-0-outer", depth=2)
    for relay in (outer, inner):
        relay.last_event_at = time.monotonic() - 1000
    StuckWatch("sa-0-outer", outer, 300).tick()
    StuckWatch("sa-0-inner", inner, 300).tick()
    assert _record("sa-0-outer")["attention"] is None
    assert _record("sa-0-inner")["attention"] == "stuck"
    # The grandchild's transition passes through its parent's relay with its own identity.
    (kind, kw), = [(k, kw) for k, kw in events if "attention" in kw]
    assert kind == "subagent.progress" and kw["subagent_id"] == "sa-0-inner" and kw["parent_id"] == "sa-0-outer"
    # The orchestrator's clock is its OWN: grandchild traffic never stamps it.
    assert outer.last_event_at < time.monotonic() - 900


def test_a_waiting_child_is_never_flagged_stuck_and_the_wait_does_not_count_as_silence(live):
    from tools.delegate_tool_attention import StuckWatch, clear_waiting, mark_waiting

    relay, events = live("sa-0-held", session_id="child-held")
    with delegated_child_context("child-held"):
        subagent_id = mark_waiting("approval")
    relay.last_event_at = time.monotonic() - 1000
    watch = StuckWatch("sa-0-held", relay, 300)
    watch.tick()
    assert _record("sa-0-held")["attention"] == "waiting"
    clear_waiting(subagent_id)
    watch.tick()
    assert _record("sa-0-held")["attention"] is None
    assert [t["attention"] for _, t in _transitions(events)] == ["waiting", None]


def test_stuck_after_seconds_comes_from_config_and_zero_disables_the_watch(live, tmp_path, monkeypatch):
    from tools.delegate_tool_attention import start_stuck_watch

    relay, _ = live("sa-0-cfg", session_id="child-cfg")
    child = SimpleNamespace(tool_progress_callback=relay)
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    (home / "config.yaml").write_text("delegation:\n  stuck_after_seconds: 0\n")
    assert start_stuck_watch(child, "sa-0-cfg") is None
    (home / "config.yaml").write_text("delegation:\n  stuck_after_seconds: 40\n")
    watch = start_stuck_watch(child, "sa-0-cfg")
    try:
        assert watch is not None and watch.stuck_after == 40 and watch.interval == 10
    finally:
        watch.stop()


# ── finished subagents: exit_reason on the wire, unread + over-budget on the stored session ──


def _parent_with_child(tmp_path, monkeypatch, events, *, toolsets=None):
    from hermes_state import SessionDB
    from run_agent import AIAgent
    from tools import delegate_tool as dt
    import tools.delegate_tool_config as dtc

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    cfg = {"stuck_after_seconds": 0}
    monkeypatch.setattr(dt, "_load_config", lambda: cfg)
    monkeypatch.setattr(dtc, "_load_config", lambda: cfg)
    db = SessionDB(db_path=tmp_path / "state.db")
    parent = AIAgent(session_id="parent", session_db=db, api_key="k", base_url="https://openrouter.ai/api/v1",
                     provider="openrouter", api_mode="chat_completions", model="anthropic/claude-sonnet-4.6",
                     platform="cli", quiet_mode=True, skip_context_files=True, skip_memory=True,
                     save_trajectories=False, enabled_toolsets=toolsets or ["file"])
    parent._ensure_db_session()
    parent.tool_progress_callback = lambda kind, name=None, preview=None, args=None, **kw: events.append((kind, kw))
    child = dt._build_child_agent(task_index=0, goal="work", context=None, toolsets=toolsets or ["file"], model=None,
                                  max_iterations=4, task_count=1, parent_agent=parent)
    return dt, db, parent, child


@pytest.mark.parametrize(("result", "exit_reason", "end_reason", "unread"), [
    ({"final_response": "ran out", "completed": False, "api_calls": 4, "messages": []},
     "max_iterations", "subagent_max_iterations", True),
    ({"final_response": "done", "completed": True, "api_calls": 2, "messages": []},
     "completed", "agent_close", True),
    ({"final_response": "Operation interrupted.", "interrupted": True, "api_calls": 1, "messages": []},
     "interrupted", "agent_close", False),
])
def test_a_finished_child_reports_its_exit_and_leaves_its_session_unread(
        tmp_path, monkeypatch, result, exit_reason, end_reason, unread):
    events: list[tuple[str, dict]] = []
    dt, db, parent, child = _parent_with_child(tmp_path, monkeypatch, events)
    child_sid = child.session_id
    try:
        child.run_conversation = lambda **_kw: dict(result)
        entry = dt._run_single_child(0, "work", child=child, parent_agent=parent)
        assert entry["exit_reason"] == exit_reason
        (kind, complete), = [(k, kw) for k, kw in events if k == "subagent.complete"]
        assert complete["exit_reason"] == exit_reason
        assert _subagent_payload(kind, None, None, complete, show_reasoning=False)["exit_reason"] == exit_reason
        row = db.get_session(child_sid)
        # The child's own close() ran after: the specific reason won (first-reason-wins).
        assert row["end_reason"] == end_reason
        assert (row["last_read_at"] == 0) is unread
        assert db.session_unread({**row, "last_active": time.time()}) is unread
    finally:
        parent.close()
        db.close()


def test_a_timed_out_child_records_subagent_timeout_before_its_close(tmp_path, monkeypatch):
    from hermes_state import SessionDB
    from tools.delegate_tool_attention import persist_terminal_attention

    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("parent", source="cli")
        db.create_session("subagent", source="subagent", parent_session_id="parent")
        persist_terminal_attention(SimpleNamespace(_session_db=db, session_id="subagent"), "timeout", "timeout")
        db.end_session("subagent", "agent_close")
        row = db.get_session("subagent")
        assert row["end_reason"] == "subagent_timeout" and row["last_read_at"] == 0
    finally:
        db.close()
