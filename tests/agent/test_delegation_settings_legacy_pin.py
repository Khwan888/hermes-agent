"""Pre-policy tool pins still choose their captured backend when a chat resumes."""

import json

import pytest

from tests.agent.test_delegation_switch_next_session import _agent, _routed_on, _sent_task_fields

pytest_plugins = ["tests.agent.test_delegation_switch_next_session"]


@pytest.mark.parametrize("pending", [False, True])
def test_legacy_backend_only_tool_pin_is_not_replaced_by_current_profile(options_backend, pending):
    from agent.delegation_backends import set_global_backend

    srv, home = options_backend
    parent = _agent(srv, home, "legacy-pin")
    try:
        history = parent.run_conversation("Old chat", conversation_history=[], task_id="t")["messages"]
        pin = json.loads(parent._session_db.get_session(parent.session_id)["tool_names"])
        pin.pop("delegation_config", None)  # the tool pin written by pre-policy backends
        parent._session_db.update_session_tool_names(parent.session_id, pin)
        set_global_backend("default")
        if pending:
            from agent.delegation_settings import update_settings
            update_settings(parent._session_db, parent.session_id, override={"backend": "default"})
    finally:
        parent.close()
    resumed = _agent(srv, home, "legacy-pin")
    try:
        resumed.run_conversation("Resume old chat", conversation_history=history, task_id="t")
        assert ("option" in _sent_task_fields(srv)) is not pending
        assert _routed_on(resumed) == ("default" if pending else "probe-options")
    finally:
        resumed.close()
