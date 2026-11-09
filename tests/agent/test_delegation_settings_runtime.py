"""Real delegate_task builds/runs children against a recording loopback provider."""

import json

import pytest

from tests.agent.test_delegation_switch_next_session import _agent
from tests.fakes.fake_llm_provider import Text, ToolCall
pytest_plugins = ["tests.agent.test_delegation_switch_next_session", "tests.tools.test_delegation_backends"]


@pytest.mark.parametrize("depth", [1, 2])
def test_real_child_and_grandchild_use_one_session_snapshot(options_backend, depth):
    from agent.delegation_settings import update_settings
    from hermes_state import SessionDB
    from tools.delegate_tool import delegate_task

    srv, home = options_backend
    with SessionDB(db_path=home / "state.db") as db:
        db.ensure_session("nested", source="cli")
        update_settings(db, "nested", override={"backend": "default", "model": "team-model",
                                               "reasoning_effort": "high", "max_spawn_depth": depth})
    parent = _agent(srv, home, "nested")
    try:
        if depth == 2:
            srv._script[:] = [ToolCall("delegate_task", {"tasks": [{"goal": "Nested grandchild task"}]}),
                              Text("grandchild completed"), Text("child completed")]
        result = json.loads(delegate_task(goal="Outer child task", parent_agent=parent))
        assert result["results"][0]["status"] == "completed", result
        requests = srv.main_requests()
        assert requests and all(r["model"] == "team-model" for r in requests)
        tools = [{t["function"]["name"] for t in r["tools"]} for r in requests]
        assert ("delegate_task" in tools[0]) == (depth == 2)
        if depth == 2:
            assert len(requests) == 3
            assert "delegate_task" not in tools[1]  # depth two is always the leaf
    finally:
        parent.close()


def test_same_route_name_profile_edits_do_not_change_existing_or_resumed_chat(options_backend, recorded):
    from hermes_cli.config import atomic_config_write, read_user_config_raw
    from tools.delegate_tool import delegate_task

    srv, home = options_backend
    agent = _agent(srv, home, "pinned-routes")
    history = agent.run_conversation("Pin this chat", conversation_history=[], task_id="t")["messages"]
    before = json.dumps(agent.tools, sort_keys=True)
    cfg = read_user_config_raw(home / "config.yaml")
    cfg["delegation"]["backends"]["probe-options"]["options"][0]["model"] = "edited-model"
    atomic_config_write(home / "config.yaml", cfg)
    try:
        delegate_task(tasks=[{"goal": "Use the fast route", "option": "fast"}], parent_agent=agent)
        assert recorded[-1]["model"] == "fast-model"
        agent.close()
        resumed = _agent(srv, home, "pinned-routes")
        try:
            resumed.run_conversation("Same chat after restart", conversation_history=history, task_id="t")
            delegate_task(tasks=[{"goal": "Use the same fast route", "option": "fast"}], parent_agent=resumed)
            assert recorded[-1]["model"] == "fast-model"
            assert json.dumps(resumed.tools, sort_keys=True) == before
        finally:
            resumed.close()
    finally:
        agent.close()


def test_mid_turn_route_edit_applies_to_next_spawn_not_existing_child(options_backend, monkeypatch):
    from agent.delegation_settings import update_settings
    from tools import delegate_tool as dt

    srv, home = options_backend
    parent = _agent(srv, home, "next-spawn")
    children = []
    original = dt._build_child_preserving_parent_tools

    def remember(**kwargs):
        child = original(**kwargs)
        children.append(child)
        return child

    monkeypatch.setattr(dt, "_build_child_preserving_parent_tools", remember)
    try:
        update_settings(parent._session_db, parent.session_id, override={"backend": "default", "model": "old-route",
                                                                       "max_spawn_depth": 2})
        # Mode changes its task parameters: explicit turn boundary applies the requested schema update.
        parent.run_conversation("First turn", conversation_history=[], task_id="t")
        assert json.loads(dt.delegate_task(goal="Old child", parent_agent=parent))["results"][0]["status"] == "completed"
        old = children[-1]
        old_schema = json.dumps(parent.tools, sort_keys=True)
        update_settings(parent._session_db, parent.session_id, override={"backend": "default", "model": "new-route",
                                                                       "reasoning_effort": "high", "max_spawn_depth": 1})
        assert json.loads(dt.delegate_task(goal="New child", parent_agent=parent))["results"][0]["status"] == "completed"
        assert old.model == "old-route" and old._delegation_config["max_spawn_depth"] == 2
        assert children[-1].model == "new-route" and children[-1].reasoning_config["effort"] == "high"
        assert children[-1]._delegate_role == "leaf"
        assert json.dumps(parent.tools, sort_keys=True) == old_schema  # no mid-turn cache mutation
    finally:
        parent.close()
