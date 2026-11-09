"""Real terminal approval waits retain the parent prompt queue but flag the child."""

import pytest

from gateway.session_context import clear_session_vars, set_session_vars
from tests.tools.test_delegate_attention import _parent_with_child
from tools import approval, approval_context, delegate_tool_registry as registry


@pytest.mark.parametrize("parent_prompt_available", [True, False])
def test_child_approval_uses_parent_prompt_queue_not_child_watch(tmp_path, monkeypatch, parent_prompt_available):
    events = []
    dt, db, parent, child = _parent_with_child(tmp_path, monkeypatch, events, toolsets=["terminal"])
    assert "terminal" in child.valid_tool_names and "clarify" not in child.valid_tool_names
    key = "local:parent-approval"
    seen = []
    outcomes = []
    monkeypatch.setenv("HERMES_EXEC_ASK", "1")
    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "manual")
    monkeypatch.setattr(approval_context, "_get_approval_config", lambda: {"mode": "manual", "timeout": 2})
    tokens = set_session_vars(platform="local", source="desktop", session_key=key, session_id=parent.session_id)
    approval_token = approval_context.set_current_session_key(key)

    def notify(data):
        record = registry._active_subagents[child._subagent_id]
        seen.append((record["attention"], record["attention_reason"],
                     len(approval.list_gateway_approvals(key)),
                     len(approval.list_gateway_approvals(child.session_id))))
        assert approval.resolve_gateway_approval(key, "deny", request_id=data["request_id"])

    def conversation(**_kwargs):
        # Only evaluate the real command guard: never execute a destructive command.
        outcomes.append(approval.check_all_command_guards(f"rm -rf {tmp_path / 'victim'}", "local"))
        return {"final_response": "approval evaluated", "completed": True, "api_calls": 0, "messages": []}

    if parent_prompt_available:
        approval.register_gateway_notify(key, notify)
    child.run_conversation = conversation
    try:
        dt._run_single_child(0, "work", child=child, parent_agent=parent)
        waiting = [kw["attention"] for _, kw in events if "attention" in kw]
        if parent_prompt_available:
            assert seen == [("waiting", "approval", 1, 0)]
            assert waiting == ["waiting", None]
            assert outcomes[0]["approved"] is False
            assert outcomes[0]["outcome"] == "denied"
        else:
            assert seen == [] and waiting == []
            assert outcomes[0]["status"] == "pending_approval"
    finally:
        approval.unregister_gateway_notify(key)
        approval_context.reset_current_session_key(approval_token)
        clear_session_vars(tokens)
        parent.close()
        db.close()
