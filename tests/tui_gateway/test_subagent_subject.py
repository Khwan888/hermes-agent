"""An attached subagent page controls only its own original child, without attaching its parent."""
from types import SimpleNamespace
import threading

import pytest


@pytest.fixture
def subject_runtime(monkeypatch):
    from tui_gateway import server
    from tools import delegate_tool_registry as registry
    from tools.delegate_tool_child_run import _register_child

    parent_transport = SimpleNamespace(write=lambda frame: True)
    viewer_transport = SimpleNamespace(write=lambda frame: True)
    parent = {"session_key": "parent-key", "transport": parent_transport, "profile_home": None}
    viewer = {"session_key": "child-key", "transport": viewer_transport, "agent": None, "lazy": True,
              "profile_home": None, "history_lock": threading.Lock(), "running": False}
    monkeypatch.setattr(server, "_sessions", {"parent": parent, "viewer": viewer})
    monkeypatch.setattr(registry, "_active_subagents", {})
    steers, stops = [], []
    child = SimpleNamespace(_subagent_id="subagent", _delegate_depth=1, session_id="child-key", model="fake",
                            steer=lambda text: steers.append(text) or True,
                            hard_interrupt=lambda *args, **kwargs: stops.append(args) or True)
    _register_child(child, None, "work", owner_session_id="parent", owner_transport=parent_transport,
                    owner_session_record=parent)

    def call(method, *, transport=viewer_transport, **kwargs):
        return server.dispatch({"id": 1, "method": method, "params": {"session_id": "viewer", **kwargs}},
                               transport=transport)
    return server, registry, parent, viewer, child, call, steers, stops


def test_subject_and_controls_use_attached_child_without_stealing_parent_transport(subject_runtime):
    _server, registry, parent, viewer, _child, call, steers, stops = subject_runtime
    before = parent["transport"]
    reply = call("subagent.subject")
    assert "result" in reply, reply
    subject = reply["result"]
    assert subject["available"] is True
    assert subject["parent_session_id"] == "parent"
    assert subject["subagent"]["subagent_id"] == "subagent"
    assert subject["subagent"]["child_session_id"] == "child-key"
    assert "usage" in subject["subagent"]
    assert call("subagent.steer", subagent_id="subagent", text="focus")["result"]["status"] == "queued"
    assert call("subagent.interrupt", subagent_id="subagent")["result"]["found"] is True
    assert steers == ["focus"] and len(stops) == 1
    assert parent["transport"] is before
    assert viewer["agent"] is None and viewer["lazy"] is True
    registry._active_subagents.clear()
    assert call("subagent.subject")["result"] == {"available": False, "parent_session_id": None, "subagent": None}


@pytest.mark.parametrize("mismatch", ["profile", "child", "parent-generation", "detached", "finalized"])
def test_subject_does_not_grant_authority_to_foreign_or_retired_viewers(subject_runtime, mismatch):
    server, _registry, parent, viewer, _child, call, steers, stops = subject_runtime
    mismatches = {
        "profile": lambda: viewer.update(profile_home="/other-profile"),
        "child": lambda: viewer.update(session_key="sibling-child-key"),
        "parent-generation": lambda: server._sessions.update(parent={**parent}),
        "detached": lambda: viewer.update(transport=SimpleNamespace(write=lambda frame: True)),
        "finalized": lambda: parent.update(_finalized=True),
    }
    mismatches[mismatch]()
    subject = call("subagent.subject")
    assert "error" in subject or subject["result"]["available"] is False
    steer = call("subagent.steer", subagent_id="subagent", text="forbidden")
    assert "error" in steer or steer["result"]["status"] == "rejected"
    stop = call("subagent.interrupt", subagent_id="subagent")
    assert "error" in stop or stop["result"]["found"] is False
    assert steers == stops == []


def test_child_viewer_cannot_control_sibling_even_in_same_profile(subject_runtime):
    _server, registry, _parent, _viewer, child, call, steers, stops = subject_runtime
    sibling = {**registry._active_subagents["subagent"], "subagent_id": "sibling",
               "child_origin_session_id": "sibling-key",
               "agent": SimpleNamespace(session_id="sibling-key", steer=child.steer, hard_interrupt=child.hard_interrupt)}
    registry._active_subagents["sibling"] = sibling
    assert call("subagent.steer", subagent_id="sibling", text="no")["result"]["status"] == "rejected"
    assert call("subagent.interrupt", subagent_id="sibling")["result"]["found"] is False
    assert steers == stops == []


def test_full_child_page_resolves_subject_without_adopting_original_agent(subject_runtime):
    _server, _registry, parent, viewer, child, call, steers, _stops = subject_runtime
    page_agent = SimpleNamespace(session_id="child-key")
    viewer.update(agent=page_agent, lazy=False)
    original_parent_transport = parent["transport"]
    assert call("subagent.subject")["result"]["subagent"]["subagent_id"] == "subagent"
    assert call("subagent.steer", subagent_id="subagent", text="full page steer")["result"]["status"] == "queued"
    assert steers == ["full page steer"]
    assert viewer["agent"] is page_agent and viewer["agent"] is not child
    assert parent["transport"] is original_parent_transport


def test_open_child_page_keeps_subject_when_child_compresses(subject_runtime):
    _server, _registry, _parent, viewer, child, call, steers, _stops = subject_runtime
    child.session_id = "compressed-child-key"
    reply = call("subagent.subject")
    assert "result" in reply, reply
    subject = reply["result"]
    assert subject["available"] is True
    assert subject["subagent"]["child_session_id"] == "compressed-child-key"
    assert viewer["session_key"] == "child-key"
    assert call("subagent.steer", subagent_id="subagent", text="continue")["result"]["status"] == "queued"
    assert steers == ["continue"]


def test_queued_watcher_prompt_does_not_close_live_mirror(subject_runtime, monkeypatch):
    server, _registry, _parent, viewer, _child, _call, _steers, _stops = subject_runtime
    frames, dispatches = [], []
    monkeypatch.setattr(server, "_emit", lambda kind, sid, payload=None: frames.append((kind, sid, payload)))
    monkeypatch.setattr(server, "_run_prompt_submit", lambda *args, **kwargs: dispatches.append(args))
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda *args: False)
    monkeypatch.setattr(server, "_replace_queued_user_row_for_turn", lambda *args, **kwargs: None)
    queued = {"text": "stale browser queue"}
    viewer["queued_prompt"] = queued
    server._on_tool_progress("parent", "subagent.text", preview="first", child_session_id="child-key")
    assert server._drain_queued_prompt("drain", "viewer", viewer) is False
    assert dispatches == []
    assert viewer["queued_prompt"] is queued and viewer["running"] is False
    server._on_tool_progress("parent", "subagent.text", preview=" second", child_session_id="child-key")
    assert [(kind, payload) for kind, sid, payload in frames if sid == "viewer"] == [
        ("message.start", None), ("message.delta", {"text": "first"}),
        ("message.delta", {"text": " second"}),
    ]
    server._child_mirrors.clear()
    server._active_child_runs.clear()


def test_quiet_original_child_blocks_native_submit_and_build_without_relay_liveness(subject_runtime, monkeypatch):
    server, _registry, _parent, viewer, _child, _call, _steers, _stops = subject_runtime
    # A child silent in a long tool still owns the stored transcript, even when
    # the relay's last-event timestamp expired or has not arrived at this viewer.
    monkeypatch.setattr(server, "_active_child_runs", {})
    builds = []
    monkeypatch.setattr(server.threading, "Thread", lambda **kwargs: SimpleNamespace(start=lambda: builds.append(True)))
    viewer["agent_ready"] = threading.Event()
    server._start_agent_build("viewer", viewer)
    assert builds == []
    assert viewer.get("agent_build_started") is not True
    error, _fields = server._lock_in_submit_turn("send", "viewer", viewer, "wrong runner", {}, False, None, None, None)
    assert error["error"]["code"] == 4009
    viewer["queued_prompt"] = {"text": "stale browser queue"}
    assert server._drain_queued_prompt("drain", "viewer", viewer) is False
    assert viewer["agent"] is None and viewer["running"] is False
