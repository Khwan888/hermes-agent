"""Subagent meters describe the existing child, not its lazy viewer or parent."""
from types import SimpleNamespace

import pytest


UNKNOWN = {
    "context_tokens": None, "context_window": None, "input_tokens": None,
    "cached_tokens": None, "output_tokens": None, "generation_seconds": None,
    "prompt_tokens": None, "tokens_per_second": None,
}
MEASURED = {
    "context_tokens": 400, "context_window": 8192, "input_tokens": 300,
    "cached_tokens": 600, "output_tokens": 120, "generation_seconds": None,
    "prompt_tokens": 1000, "tokens_per_second": 20.0,
}


def test_list_and_progress_measure_original_child_without_upgrading_viewer(monkeypatch):
    from gateway.session_ancillary import subagent_row
    from tools import delegate_tool_registry as registry
    from tools.delegate_tool_child_run import _register_child
    from tools.delegate_tool_progress import _build_child_progress_callback
    from tui_gateway import server
    from tui_gateway.contracts.events import SubagentEventPayload
    from tui_gateway.contracts.profiles_vault_complete_foreign_subagents import SubagentSnapshot

    frames = []
    transport = SimpleNamespace(write=lambda frame: frames.append(frame))
    owner = {"transport": transport, "history": [], "agent": SimpleNamespace(session_input_tokens=99999)}
    viewer = {"agent": None, "lazy": True, "session_key": "stored-child"}
    monkeypatch.setattr(server, "_sessions", {"parent": owner, "viewer": viewer})
    monkeypatch.setattr(registry, "_active_subagents", {})
    child = SimpleNamespace(
        _subagent_id="child", _delegate_depth=1, model="fake", provider="fake",
        session_id="stored-child", context_compressor=SimpleNamespace(last_prompt_tokens=400, context_length=8192),
        session_input_tokens=300, session_cache_read_tokens=600, session_prompt_tokens=1000,
        session_output_tokens=120, session_api_calls=2, _api_latency_history=[2.0, 4.0],
        _api_output_history=[40, 80],
    )
    _register_child(child, None, "work", owner_session_id="parent", owner_transport=transport,
                    owner_session_record=owner)
    relay = _build_child_progress_callback(0, "work", SimpleNamespace(
        tool_progress_callback=lambda kind, name, preview, args, **kw: server._on_tool_progress(
            "parent", kind, name, preview, args, **kw)), subagent_id="child",
        session_ref={"_child": child, "session_id": "stored-child"})
    relay("tool.started", "read_file", "inspect")
    result = server.dispatch({"id": 1, "method": "subagent.list", "params": {"session_id": "parent"}},
                             transport=transport)
    row = result["result"]["subagents"][0]
    assert row["usage"] == MEASURED
    assert subagent_row(registry._active_subagents["child"])["usage"] == MEASURED
    event = next(f["params"]["payload"] for f in frames if f.get("params", {}).get("type") == "subagent.tool")
    assert event["usage"] == MEASURED
    assert event["child_session_id"] == row["child_session_id"] == "stored-child"
    SubagentSnapshot.model_validate(row)
    SubagentEventPayload.model_validate(event)
    assert viewer["agent"] is None and viewer["lazy"] is True
    # A later poll reads current child counters, not a stale registration-time copy.
    child.session_output_tokens = 200
    result = server.dispatch({"id": 2, "method": "subagent.list", "params": {"session_id": "parent"}},
                             transport=transport)
    assert result["result"]["subagents"][0]["usage"]["output_tokens"] == 200


@pytest.mark.parametrize("child", [SimpleNamespace(), SimpleNamespace(_api_latency_history=42), SimpleNamespace(
    session_input_tokens=False, session_cache_read_tokens=-1, session_output_tokens=float("nan"),
    session_prompt_tokens="10", context_compressor=SimpleNamespace(last_prompt_tokens=-1, context_length=0),
    _api_latency_history=[float("inf")], _api_output_history=[2],
)])
def test_unavailable_child_measurements_are_null_not_fabricated_zero(child):
    from gateway.session_ancillary import subagent_row
    assert subagent_row({"agent": child})["usage"] == UNKNOWN


def test_observed_zero_and_unknown_context_remain_distinct():
    from gateway.session_ancillary import subagent_row
    child = SimpleNamespace(session_input_tokens=0, session_cache_read_tokens=0, session_output_tokens=0,
                            session_prompt_tokens=0, session_api_calls=1,
                            context_compressor=SimpleNamespace(last_prompt_tokens=-1, context_length=8192))
    assert subagent_row({"agent": child})["usage"] == {
        **UNKNOWN, "context_window": 8192, "input_tokens": 0, "cached_tokens": 0,
        "output_tokens": 0, "prompt_tokens": 0,
    }


def test_nested_progress_keeps_subject_usage_separate_from_orchestrator():
    from tools.delegate_tool_progress import _build_child_progress_callback
    from tui_gateway.tool_progress import _subagent_payload
    events = []
    relay = _build_child_progress_callback(0, "outer", SimpleNamespace(
        tool_progress_callback=lambda kind, name, preview, args, **kw: events.append((kind, kw))),
        subagent_id="outer", session_ref={"_child": SimpleNamespace(session_output_tokens=99999)})
    relay("subagent.tool", "terminal", "inner work", subagent_id="inner", parent_id="outer",
          child_session_id="inner-stored", usage=MEASURED)
    kind, kwargs = events[0]
    payload = _subagent_payload(kind, None, None, kwargs, show_reasoning=False)
    assert payload["usage"] == MEASURED
    assert payload["subagent_id"] == "inner"
    assert payload["child_session_id"] == "inner-stored"

def test_subagent_stream_snapshot_and_finished_meters_survive_the_live_record(monkeypatch, tmp_path):
    import json
    from hermes_state import SessionDB
    from tools import delegate_tool_registry as registry
    from tools.delegate_tool_child_run import _register_child
    from tools.delegate_tool_progress import _build_child_progress_callback
    from tools.delegate_tool_usage import stored_subagent
    from gateway.session_ancillary import subagent_row

    from tools import delegate_tool_progress as progress

    db = SessionDB(tmp_path / "state.db")
    db.create_session("parent", source="gui")
    db.create_session("stored-child", source="subagent", parent_session_id="parent")
    child = SimpleNamespace(_subagent_id="child", _session_db=db, session_id="stored-child",
                            model="actual", provider="fake", session_prompt_tokens=1200,
                            session_cache_read_tokens=900, session_output_tokens=60)
    monkeypatch.setattr(registry, "_active_subagents", {})
    monkeypatch.setattr(progress, "_active_subagents", registry._active_subagents)
    _register_child(child, None, "work", owner_session_id=None, owner_transport=None, owner_session_record=None)
    relay = _build_child_progress_callback(0, "work", SimpleNamespace(tool_progress_callback=lambda *a, **k: None),
        subagent_id="child", session_ref={"_child": child, "session_id": "stored-child"})
    relay("subagent.text", preview="live ")
    relay("subagent.text", preview="reply")
    assert subagent_row(registry._active_subagents["child"])["live_text"] == "live reply"
    relay("tool.started", "terminal", "checkpoint")
    assert subagent_row(registry._active_subagents["child"])["live_text"] is None
    assert not stored_subagent(db, "stored-child")["live_text"]
    relay("subagent.complete", status="completed", duration_seconds=12)
    registry._active_subagents.clear()
    snapshot = stored_subagent(db, "stored-child")
    assert snapshot["route"]["model"] == "actual"
    assert snapshot["usage"]["cached_tokens"] == 900
    assert snapshot["duration_seconds"] == 12
    assert snapshot["status"] == "completed"
    assert snapshot["live_text"] is None
    assert json.loads(db.get_meta("subagent-observation:stored-child"))["subagent_id"] == "child"
    db.close()


@pytest.mark.parametrize("raw, expected", [
    ("{not json", None),
    ('["a", "list"]', None),
    ('{"status": "completed", "duration_seconds": 3, "usage": [1, 2], "route": "fallback"}',
     {"status": "completed", "duration_seconds": 3, "usage": None, "route": None}),
])
def test_unusable_stored_observation_reads_as_unavailable_and_subject_still_answers(tmp_path, monkeypatch, raw, expected):
    """Optional observation data never fails the finished child's ``subagent.subject`` read; meta is kept."""
    import asyncio
    from hermes_state import SessionDB
    from tools.delegate_tool_usage import stored_subagent
    import gateway.session_subagent_subject as subject_mod

    db = SessionDB(tmp_path / "state.db")
    try:
        db.create_session("parent", source="gui")
        db.create_session("stored-child", source="subagent", parent_session_id="parent")
        db.set_meta("subagent-observation:stored-child", raw)
        assert stored_subagent(db, "stored-child") == expected
        connection = SimpleNamespace(authority=SimpleNamespace(db=db))
        ref = SimpleNamespace(session_id="stored-child")
        monkeypatch.setattr(subject_mod, "authorize", lambda *a, **k: None)
        reply = asyncio.run(subject_mod.subject(connection, ref, {"session_id": "stored-child"}))
        assert reply == {"available": False, "parent_session_id": "parent", "subagent": expected}
        assert db.get_meta("subagent-observation:stored-child") == raw
    finally:
        db.close()
