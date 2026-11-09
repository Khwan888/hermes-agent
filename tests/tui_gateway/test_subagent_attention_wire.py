"""Subagent attention on the gateway wire: ``subagent.list`` rows carry the live flag (null when none), and
``subagent.roster`` counts flagged children of every depth on the conversation that spawned the tree, adding
the key only when something needs the human."""

import threading
from types import SimpleNamespace

import pytest


def test_subagent_list_rows_carry_the_live_attention_flag(monkeypatch):
    from tools import delegate_tool_registry as registry
    from tools.delegate_tool_child_run import _register_child
    from tui_gateway import server

    transport = SimpleNamespace(write=lambda frame: True)
    owner = {"transport": transport, "history": []}
    monkeypatch.setattr(server, "_sessions", {"parent": owner})
    monkeypatch.setattr(registry, "_active_subagents", {})
    for subagent_id in ("calm", "blocked"):
        child = SimpleNamespace(_subagent_id=subagent_id, _delegate_depth=1, model="m", session_id=f"{subagent_id}-sid")
        _register_child(child, None, "work", owner_session_id="parent", owner_transport=transport,
                        owner_session_record=owner)
    registry._active_subagents["blocked"].update(attention="waiting", attention_reason="sudo", attention_since=12.5)

    response = server.dispatch({"id": 1, "method": "subagent.list", "params": {"session_id": "parent"}},
                               transport=transport)
    rows = {row["subagent_id"]: row for row in response["result"]["subagents"]}
    def pick(row):
        return {k: row[k] for k in ("attention", "attention_reason", "attention_since")}

    assert pick(rows["calm"]) == {"attention": None, "attention_reason": None, "attention_since": None}
    assert pick(rows["blocked"]) == {"attention": "waiting", "attention_reason": "sudo", "attention_since": 12.5}


@pytest.fixture()
def roster(monkeypatch, tmp_path):
    from hermes_state import SessionDB
    from tools import delegate_tool_registry as reg
    from tui_gateway import server

    db = SessionDB(db_path=tmp_path / "state.db")
    for sid in ("parent-a", "parent-b"):
        db.create_session(sid, source="tui")
    monkeypatch.setattr(server, "_get_db", lambda: db)
    monkeypatch.setattr(reg, "_active_subagents", {})
    monkeypatch.setattr(reg, "_active_subagents_lock", threading.RLock())

    def call():
        resp = server.handle_request({"jsonrpc": "2.0", "id": 1, "method": "subagent.roster", "params": {}})
        return {e["session_id"]: e for e in resp["result"]["sessions"]}

    yield reg._active_subagents, call
    db.close()


def test_roster_counts_flagged_children_of_any_depth_on_the_spawning_conversation(roster):
    active, call = roster
    active["c1"] = {"subagent_id": "c1", "depth": 0, "owner_agent_session_id": "parent-a", "status": "running"}
    active["c2"] = {"subagent_id": "c2", "depth": 0, "owner_agent_session_id": "parent-a", "status": "running",
                    "attention": "stuck"}
    # A grandchild's own owner is its orchestrator's stored session: it still lights the root conversation.
    active["g1"] = {"subagent_id": "g1", "parent_id": "c1", "depth": 1, "owner_agent_session_id": "c1-sid",
                    "status": "running", "attention": "waiting", "attention_reason": "approval"}
    active["g2"] = {"subagent_id": "g2", "parent_id": "g1", "depth": 2, "owner_agent_session_id": "g1-sid",
                    "status": "running", "attention": "waiting", "attention_reason": "sudo"}
    active["b1"] = {"subagent_id": "b1", "depth": 0, "owner_agent_session_id": "parent-b", "status": "running"}

    sessions = call()
    assert sessions["parent-a"] == {"session_id": "parent-a", "subagents": 2, "background": 0,
                                    "attention": {"waiting": 2, "stuck": 1}}
    # Nothing needs the human here: the key is absent, not zeroed.
    assert sessions["parent-b"] == {"session_id": "parent-b", "subagents": 1, "background": 0}


def test_subagent_payload_passes_cleared_attention_and_exit_reason():
    from tui_gateway.tool_progress import _subagent_payload

    cleared = _subagent_payload("subagent.progress", None, None,
                                {"goal": "g", "subagent_id": "s", "attention": None, "attention_reason": None,
                                 "attention_since": None}, show_reasoning=False)
    assert {k: cleared[k] for k in ("attention", "attention_reason", "attention_since")} == {
        "attention": None, "attention_reason": None, "attention_since": None}
    plain = _subagent_payload("subagent.progress", None, "🔀 terminal", {"goal": "g", "subagent_id": "s"},
                              show_reasoning=False)
    assert not {"attention", "attention_reason", "attention_since", "exit_reason"} & set(plain)
    done = _subagent_payload("subagent.complete", None, "ran out",
                             {"goal": "g", "status": "completed", "exit_reason": "max_iterations"},
                             show_reasoning=False)
    assert done["exit_reason"] == "max_iterations"
