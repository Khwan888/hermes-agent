"""A finished subagent's observed ending survives its live record (read back after a restart)."""

import json
from types import SimpleNamespace

import pytest

from hermes_state import SessionDB


@pytest.fixture
def db(tmp_path):
    store = SessionDB(tmp_path / "state.db")
    store.create_session("parent", source="gui")
    store.create_session("stored-child", source="subagent", parent_session_id="parent")
    yield store
    store.close()


def test_completion_persists_the_observed_route_and_ending_after_the_live_record_is_gone(db, monkeypatch):
    from tools import delegate_tool_progress as progress
    from tools import delegate_tool_registry as registry
    from tools.delegate_tool_child_run import _register_child
    from tools.delegate_tool_observation import stored_subagent

    child = SimpleNamespace(_subagent_id="child", _session_db=db, session_id="stored-child",
                            model="launch-model", provider="backup", last_served_model="served-model",
                            _fallback_activated=True)
    monkeypatch.setattr(registry, "_active_subagents", {})
    monkeypatch.setattr(progress, "_active_subagents", registry._active_subagents)
    _register_child(child, None, "work", owner_session_id=None, owner_transport=None, owner_session_record=None)
    relay = progress._build_child_progress_callback(
        0, "work", SimpleNamespace(tool_progress_callback=lambda *a, **k: None),
        subagent_id="child", session_ref={"_child": child, "session_id": "stored-child"})

    relay("subagent.complete", status="interrupted", duration_seconds=12)
    registry._active_subagents.clear()

    observed = stored_subagent(db, "stored-child")
    assert observed["status"] == "interrupted"
    assert observed["duration_seconds"] == 12
    assert observed["route"]["provider"] == "backup"
    assert observed["route"]["fallback_activated"] is True
    # Only the measured ending: no reply text or meters are kept.
    assert set(json.loads(db.get_meta("subagent-observation:stored-child"))) == {
        "subagent_id", "status", "duration_seconds", "route"}


def test_a_child_without_a_store_or_record_completes_without_writing(monkeypatch):
    from tools import delegate_tool_progress as progress
    from tools import delegate_tool_registry as registry

    monkeypatch.setattr(registry, "_active_subagents", {})
    monkeypatch.setattr(progress, "_active_subagents", registry._active_subagents)
    events = []
    relay = progress._build_child_progress_callback(
        0, "work", SimpleNamespace(tool_progress_callback=lambda kind, *a, **k: events.append(kind)),
        subagent_id="ghost", session_ref={})
    relay("subagent.complete", status="completed", duration_seconds=1)
    assert events == ["subagent.complete"]


@pytest.mark.parametrize("raw, expected", [
    ("{not json", None),
    ('["a", "list"]', None),
    ('{"status": "completed", "duration_seconds": 3, "route": "fallback"}',
     {"status": "completed", "duration_seconds": 3, "route": None}),
])
def test_unusable_stored_observation_reads_as_unavailable_and_is_kept(db, raw, expected):
    from tools.delegate_tool_observation import stored_subagent

    db.set_meta("subagent-observation:stored-child", raw)
    assert stored_subagent(db, "stored-child") == expected
    assert db.get_meta("subagent-observation:stored-child") == raw


def test_only_a_child_session_has_an_observation(db):
    from tools.delegate_tool_observation import stored_subagent

    db.set_meta("subagent-observation:parent", json.dumps({"status": "completed"}))
    assert stored_subagent(db, "parent") is None
    assert stored_subagent(db, "missing") is None
