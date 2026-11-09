"""A per-chat backend edit waits for the next turn; tools already sent stay byte-stable."""

import json

from tests.agent.test_delegation_switch_next_session import _agent, _sent_task_fields

pytest_plugins = ["tests.agent.test_delegation_switch_next_session", "tests.tools.test_delegation_backends"]


def test_schema_changing_chat_edit_is_pending_until_turn_entry(options_backend, recorded):
    from agent.delegation_settings import settings_for_session, update_settings
    from tools.delegate_tool import delegate_task

    srv, home = options_backend
    parent = _agent(srv, home, "schema-boundary")
    try:
        history = parent.run_conversation("Pin options schema", conversation_history=[], task_id="t")["messages"]
        before = json.dumps(parent.tools, sort_keys=True)
        assert "option" in _sent_task_fields(srv)
        update_settings(parent._session_db, parent.session_id, override={"backend": "default", "model": "new-child"})
        assert settings_for_session(parent._session_db, parent.session_id, parent)["pending_schema"] is True
        existing = json.loads(delegate_task(tasks=[{"goal": "Use the advertised route", "option": "fast"}],
                                            parent_agent=parent))
        assert existing["results"][0]["status"] == "completed"
        assert recorded[-1]["model"] == "fast-model"
        assert json.dumps(parent.tools, sort_keys=True) == before
        parent.run_conversation("Apply the explicit chat selection", conversation_history=history, task_id="t")
        assert "option" not in _sent_task_fields(srv)
        assert settings_for_session(parent._session_db, parent.session_id, parent)["pending_schema"] is False
        json.loads(delegate_task(goal="Use the new backend", parent_agent=parent))
        assert recorded[-1]["model"] == "new-child"
    finally:
        parent.close()
