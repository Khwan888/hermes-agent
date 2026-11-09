"""The child-page exception never grants sibling/profile or unmounted control authority."""
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize("mismatch", ["profile", "sibling", "unsubscribed", "read-only-actor"])
def test_child_page_control_requires_exact_database_subscription_and_capability(monkeypatch, tmp_path, mismatch):
    from gateway import session_subagent_subject as subject
    from hermes_state_runtime import RuntimeStoreError
    from tools import delegate_tool_registry as registry

    db = SimpleNamespace(db_path=str(tmp_path / "state.db"))
    child = SimpleNamespace(session_id="child", _session_db=db)
    monkeypatch.setattr(registry, "_active_subagents", {
        "child-run": {"agent": child, "subagent_id": "child-run", "child_origin_session_id": "child"}
    })
    connection = SimpleNamespace(authority=SimpleNamespace(db=db), subscriptions={"child"},
                                 actor=SimpleNamespace(capabilities={"session:read", "session:control"}))
    ref = SimpleNamespace(session_id="child")
    # The ordinary read authorization is independently tested by the real socket fixture;
    # this isolates the additional exact-child exception's mandatory gates.
    monkeypatch.setattr(subject, "authorize", lambda *args: None)
    params = {"session_id": "child", "subagent_id": "child-run"}
    assert subject.controlled_child(connection, ref, params) is child
    if mismatch == "profile":
        connection.authority.db = SimpleNamespace(db_path=str(tmp_path / "foreign.db"))
    elif mismatch == "sibling":
        params["subagent_id"] = "sibling-run"
    elif mismatch == "unsubscribed":
        connection.subscriptions.clear()
    else:
        connection.actor.capabilities = {"session:read"}
    if mismatch in {"profile", "sibling"}:
        assert subject.controlled_child(connection, ref, params) is None
    else:
        with pytest.raises(RuntimeStoreError):
            subject.controlled_child(connection, ref, params)
