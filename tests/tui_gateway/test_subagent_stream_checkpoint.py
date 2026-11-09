"""A stopped backend must not erase already received subagent work."""
from types import SimpleNamespace


def test_first_received_subagent_text_survives_without_completion(monkeypatch, tmp_path):
    from hermes_state import SessionDB
    from tools import delegate_tool_progress as progress
    from tools import delegate_tool_registry as registry
    from tools.delegate_tool_child_run import _register_child
    from tools.delegate_tool_usage import stored_subagent

    db_path = tmp_path / "state.db"
    db = SessionDB(db_path)
    db.create_session("parent", source="gui")
    db.create_session("child", source="subagent", parent_session_id="parent")
    child = SimpleNamespace(_subagent_id="live-child", _session_db=db, session_id="child",
                            model="actual", provider="fake", session_output_tokens=0)
    monkeypatch.setattr(registry, "_active_subagents", {})
    monkeypatch.setattr(progress, "_active_subagents", registry._active_subagents)
    _register_child(child, None, "work", owner_session_id=None,
                    owner_transport=None, owner_session_record=None)
    relay = progress._build_child_progress_callback(
        0, "work", SimpleNamespace(tool_progress_callback=lambda *a, **k: None),
        subagent_id="live-child", session_ref={"_child": child, "session_id": "child"})
    clock = [100.0]
    monkeypatch.setattr(progress.time, "monotonic", lambda: clock[0])
    relay("subagent.text", preview="actual work received before a crash")
    relay("subagent.text", preview=" subsequent chunk")
    # The first chunk is durable immediately; further chunks are throttled, not every token.
    assert stored_subagent(db, "child")["live_text"] == "actual work received before a crash"
    clock[0] += 1.1
    relay("subagent.text", preview="x" * 70000)
    assert len(stored_subagent(db, "child")["live_text"]) == 65536
    relay("tool.started", "terminal", "boundary")
    assert not stored_subagent(db, "child")["live_text"]
    relay("subagent.text", preview="actual work received before a crash")
    clock[0] += 1.1
    relay("subagent.text", preview="")
    # No completion callback: the next reader has only the durable store, not the live child.
    registry._active_subagents.clear()
    db.close()
    reopened = SessionDB(db_path)
    try:
        observed = stored_subagent(reopened, "child")
        assert observed is not None
        assert observed["live_text"] == "actual work received before a crash"
        assert observed["route"]["model"] == "actual"
        assert observed["status"] == "running"
    finally:
        reopened.close()
