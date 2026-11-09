"""A delegated child's stored session stays addressable by its subagent_id after the registry forgets it.

Through ``_build_child_agent`` with real AIAgents and a real SessionDB in a temp HERMES_HOME: the
child's row carries the id it was spawned with, and only the conversation it descends from (directly
or through an orchestrator child) resolves it.
"""


def test_spawned_children_resolve_by_subagent_id_only_under_their_conversation(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    from hermes_state import SessionDB
    from run_agent import AIAgent
    from tools import delegate_tool as dt
    import tools.delegate_tool_config as dtc
    from tools.delegate_tool_sessions import stored_child_session
    cfg = {"max_spawn_depth": 3}
    monkeypatch.setattr(dt, "_load_config", lambda: cfg)
    monkeypatch.setattr(dtc, "_load_config", lambda: cfg)
    db = SessionDB(db_path=tmp_path / "state.db")
    kw = dict(api_key="k", base_url="https://openrouter.ai/api/v1", provider="openrouter",
              api_mode="chat_completions", model="anthropic/claude-sonnet-4.6", platform="cli", quiet_mode=True,
              skip_context_files=True, skip_memory=True, save_trajectories=False, enabled_toolsets=["file"])
    parent = AIAgent(session_id="parent", session_db=db, **kw)
    agents = [parent]
    try:
        parent._ensure_db_session()
        mid = dt._build_child_agent(task_index=0, goal="mid", context=None, toolsets=["file"], model=None,
                                    max_iterations=4, task_count=1, parent_agent=parent)
        agents.append(mid)
        worker = dt._build_child_agent(task_index=0, goal="worker", context=None, toolsets=["file"], model=None,
                                       max_iterations=4, task_count=1, parent_agent=mid)
        agents.append(worker)
        for child in (mid, worker):
            child._ensure_db_session()
        assert stored_child_session(db, mid._subagent_id, ["parent"]) == mid.session_id
        assert stored_child_session(db, worker._subagent_id, ["parent"]) == worker.session_id
        db.create_session("elsewhere", source="cli")
        assert stored_child_session(db, mid._subagent_id, ["elsewhere"]) is None
        assert stored_child_session(db, "sa-0-00000000", ["parent"]) is None
    finally:
        for agent in reversed(agents):
            agent.close()
        db.close()


def test_a_child_rotated_past_any_hop_budget_resolves_to_its_newest_segment(tmp_path):
    """Compression rotations count as hops on the walk to the conversation: a long-lived child
    (compression.in_place: false) must still resolve to its newest segment, never an older one."""
    from hermes_state import SessionDB
    from tools.delegate_tool_sessions import stored_child_session
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("parent", source="cli")
        marker = {"_delegate_from": "parent", "_subagent_id": "sa-0-long"}
        db.create_session("seg-000", source="subagent", parent_session_id="parent", model_config=marker)
        for i in range(1, 80):
            db.end_session(f"seg-{i - 1:03d}", "compression")
            db.create_session(f"seg-{i:03d}", source="subagent", parent_session_id=f"seg-{i - 1:03d}",
                              model_config=marker)
        reads, get_session = [], db.get_session
        db.get_session = lambda sid: reads.append(sid) or get_session(sid)
        assert stored_child_session(db, "sa-0-long", ["parent"]) == "seg-079"
        # The 80 segments share their chain: one lookup reads each row once, not a walk per segment.
        assert len(reads) == len(set(reads)) == 81, len(reads)
    finally:
        db.close()


def test_a_finished_child_resolves_to_its_continuation_after_a_backward_clock_step(tmp_path):
    """The terminal segment follows verified compression links, not ``started_at``: a wall clock that
    stepped back between the rotation's two rows must not hand back the root."""
    from hermes_state import SessionDB
    from tools.delegate_tool_sessions import stored_child_session
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("parent", source="cli")
        marker = {"_delegate_from": "parent", "_subagent_id": "sa-0-clock"}
        db.create_session("clock-root", source="subagent", parent_session_id="parent", model_config=marker)
        db.end_session("clock-root", "compression")
        db.create_session("clock-tip", source="subagent", parent_session_id="clock-root", model_config=marker)
        db._execute_write(lambda conn: conn.executemany(
            "UPDATE sessions SET started_at = ? WHERE id = ?", [(1002.0, "clock-root"), (1001.0, "clock-tip")]))
        assert stored_child_session(db, "sa-0-clock", ["parent"]) == "clock-tip"
    finally:
        db.close()


def _call(db, session, call_id, goals, ts, result=None):
    """A stored ``delegate_task`` call of *goals* at *ts* and its tool result."""
    import json
    db.append_message(session, role="assistant", content="", timestamp=ts, tool_calls=[{
        "id": call_id, "type": "function",
        "function": {"name": "delegate_task", "arguments": json.dumps({"tasks": [{"goal": g} for g in goals]})}}])
    db.append_message(session, role="tool", tool_name="delegate_task", tool_call_id=call_id, timestamp=ts + 0.5,
                      content=json.dumps(result if result is not None else {"status": "dispatched", "goals": goals}))


def _child(db, sid, parent, goal, started, suffix="", **marker):
    """A delegate child whose first user message is its goal (the task's ``context`` goes into its system
    prompt, not this message), plus *suffix* when the delegate tool wrapped it."""
    db.create_session(sid, source="subagent", parent_session_id=parent,
                      model_config={"_delegate_from": parent, **marker})
    db._execute_write(lambda conn: conn.execute("UPDATE sessions SET started_at = ? WHERE id = ?", (started, sid)))
    db.append_message(sid, role="user", content=goal + suffix)


def test_cards_written_before_any_child_id_link_their_subagents_through_the_stored_delegation(tmp_path):
    """Most stored subagents predate ``_subagent_id`` and their call results name no child: each task still
    links to the delegate child that started after its call with that task's goal, earlier calls claim
    first, and a branch or another conversation's subagent with the same goal never links."""
    from hermes_state import SessionDB
    from tools.delegate_tool_sessions import delegate_call_children
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("parent", source="cli")
        db.create_session("other", source="cli")
        _call(db, "parent", "call-1", ["review the plan", "write tests"], 1000.0)
        _call(db, "parent", "call-2", ["review the plan"], 2000.0)
        _child(db, "c1-review", "parent", "review the plan", 1000.4)
        _child(db, "c1-tests", "parent", "write tests", 1000.3)
        _child(db, "c2-review", "parent", "review the plan", 2000.2)
        _child(db, "elsewhere", "other", "write tests", 1000.1)
        db.create_session("branch", source="subagent", parent_session_id="parent",
                          model_config={"_branched_from": "parent"})
        db.append_message("branch", role="user", content="review the plan")
        assert delegate_call_children(db, ["parent"], "call-1") == ["c1-review", "c1-tests"]
        assert delegate_call_children(db, ["parent"], "call-2") == ["c2-review"]
        assert delegate_call_children(db, ["other"], "call-1") is None
        assert delegate_call_children(db, ["parent"], "no-such-call") is None
    finally:
        db.close()


def test_a_call_whose_result_names_its_children_links_exactly_and_ignores_foreign_ids(tmp_path):
    from hermes_state import SessionDB
    from tools.delegate_tool_sessions import delegate_call_children
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("parent", source="cli")
        db.create_session("other", source="cli")
        _child(db, "foreign", "other", "same goal", 1000.2)
        # Two children with the same goal: only the ids in the result can tell them apart.
        _child(db, "by-marker", "parent", "same goal", 1000.1, _subagent_id="sa-0-aaaa")
        _child(db, "by-id", "parent", "same goal", 1000.3)
        _call(db, "parent", "call-1", ["same goal", "same goal", "same goal"], 1000.0, result={
            "status": "dispatched", "subagent_ids": ["sa-0-aaaa", None, None],
            "child_session_ids": [None, "by-id", "foreign"]})
        # The foreign id is not this conversation's delegate child; nothing else is left to link.
        assert delegate_call_children(db, ["parent"], "call-1") == ["by-marker", "by-id", None]
    finally:
        db.close()


def test_a_settled_result_entry_names_its_child_and_a_rotated_child_opens_at_its_newest_segment(tmp_path):
    from hermes_state import SessionDB
    from tools.delegate_tool_sessions import delegate_call_children
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("parent", source="cli")
        _child(db, "root", "parent", "long task", 1000.1)
        db.end_session("root", "compression")
        db.create_session("tip", source="subagent", parent_session_id="root",
                          model_config={"_delegate_from": "parent"})
        _call(db, "parent", "call-1", ["long task"], 1000.0, result={
            "results": [{"task_index": 0, "status": "completed", "child_session_id": "root"}]})
        assert delegate_call_children(db, ["parent"], "call-1") == ["tip"]
    finally:
        db.close()


def _legacy_db(tmp_path):
    from hermes_state import SessionDB
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session("parent", source="cli")
    return db


def test_a_goal_that_prefixes_a_sibling_goal_never_takes_the_siblings_child(tmp_path):
    """``Review auth`` and ``Review auth tests`` in one batch, the second child started first: each task
    opens its own child (exact goals are allocated before any wrapped-goal fallback)."""
    from tools.delegate_tool_sessions import delegate_call_children
    db = _legacy_db(tmp_path)
    try:
        _call(db, "parent", "call-1", ["Review auth", "Review auth tests"], 1000.0)
        _child(db, "c-tests", "parent", "Review auth tests", 1000.1)
        _child(db, "c-auth", "parent", "Review auth", 1000.2)
        assert delegate_call_children(db, ["parent"], "call-1") == ["c-auth", "c-tests"]
    finally:
        db.close()


def test_repeated_identical_goals_link_in_start_order_only_when_the_order_is_known(tmp_path):
    """Identical exact goals in one batch go out by ``started_at`` (tasks start in task order); a tie, or
    fewer children than tasks, cannot say which task ran which child, so those tasks stay None."""
    from tools.delegate_tool_sessions import delegate_call_children
    db = _legacy_db(tmp_path)
    try:
        _call(db, "parent", "ordered", ["lint", "lint"], 1000.0)
        _child(db, "lint-2", "parent", "lint", 1000.3)
        _child(db, "lint-1", "parent", "lint", 1000.2)
        _call(db, "parent", "tied", ["fmt", "fmt", "other"], 2000.0)
        _child(db, "fmt-a", "parent", "fmt", 2000.2)
        _child(db, "fmt-b", "parent", "fmt", 2000.2)
        _child(db, "other", "parent", "other", 2000.3)
        _call(db, "parent", "short", ["docs", "docs"], 3000.0)
        _child(db, "docs-1", "parent", "docs", 3000.2)
        assert delegate_call_children(db, ["parent"], "ordered") == ["lint-1", "lint-2"]
        assert delegate_call_children(db, ["parent"], "tied") == [None, None, "other"]
        assert delegate_call_children(db, ["parent"], "short") == [None, None]
    finally:
        db.close()


def test_exact_ids_and_legacy_goals_mix_in_one_batch(tmp_path):
    from tools.delegate_tool_sessions import delegate_call_children
    db = _legacy_db(tmp_path)
    try:
        _child(db, "named", "parent", "Review auth", 1000.1, _subagent_id="sa-1-bbbb")
        _child(db, "legacy", "parent", "Review auth", 1000.2)
        _call(db, "parent", "call-1", ["Review auth", "Review auth"], 1000.0,
              result={"status": "dispatched", "subagent_ids": ["sa-1-bbbb"]})
        assert delegate_call_children(db, ["parent"], "call-1") == ["legacy", "named"]
    finally:
        db.close()


def test_a_wrapped_goal_links_only_through_the_delegate_tools_own_wrapper_and_only_when_unique(tmp_path):
    """The worktree note / image hints the delegate tool appends still link; any other suffix is another goal,
    and two wrapped candidates for one task leave it None."""
    from tools.delegate_tool_sessions import delegate_call_children
    db = _legacy_db(tmp_path)
    try:
        _call(db, "parent", "wrapped", ["Fix bug", "Add docs"], 1000.0)
        _child(db, "fix", "parent", "Fix bug", 1000.1, suffix="\n\n[WORKTREE ISOLATION] You are working in ...")
        _child(db, "docs", "parent", "Add docs", 1000.2, suffix="\n\n[Image attached at: /tmp/a.png]")
        _call(db, "parent", "unknown", ["Review auth"], 2000.0)
        _child(db, "other-goal", "parent", "Review auth", 2000.1, suffix=" tests")
        _child(db, "other-text", "parent", "Review auth", 2000.2, suffix="\n\nContext: from the parent")
        _call(db, "parent", "ambiguous", ["Ship it"], 3000.0)
        _child(db, "ship-a", "parent", "Ship it", 3000.1, suffix="\n\n[WORKTREE ISOLATION] a")
        _child(db, "ship-b", "parent", "Ship it", 3000.2, suffix="\n\n[WORKTREE ISOLATION] b")
        assert delegate_call_children(db, ["parent"], "wrapped") == ["fix", "docs"]
        assert delegate_call_children(db, ["parent"], "unknown") == [None]
        assert delegate_call_children(db, ["parent"], "ambiguous") == [None]
    finally:
        db.close()


def test_a_multimodal_first_message_links_by_its_text_part(tmp_path):
    from tools.delegate_tool_sessions import delegate_call_children
    db = _legacy_db(tmp_path)
    try:
        _call(db, "parent", "call-1", ["Describe the chart"], 1000.0)
        db.create_session("vision", source="subagent", parent_session_id="parent",
                          model_config={"_delegate_from": "parent"})
        db._execute_write(lambda conn: conn.execute("UPDATE sessions SET started_at = 1000.1 WHERE id = 'vision'"))
        db.append_message("vision", role="user", content=[
            {"type": "text", "text": "Describe the chart"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}])
        assert delegate_call_children(db, ["parent"], "call-1") == ["vision"]
    finally:
        db.close()


def test_every_result_names_each_child_session_by_task_so_its_card_reopens_it():
    """A background call's dispatch handle lists each task's own stored session by task index (a refused
    task is None), and every settled or fabricated entry names its child; a child that never got a session
    names nothing."""
    import dataclasses
    from types import SimpleNamespace
    from tools.delegate_tool_child_run import _SchemaOutcome, _build_result_entry, _fabricated_entry
    from tools.delegate_tool_dispatch import _Batch, _dispatched_payload

    child = SimpleNamespace(model="m", session_estimated_cost_usd=0.0, session_cost_status="unknown",
                            session_prompt_tokens=1, session_completion_tokens=1, _delegate_role="leaf",
                            session_id="child-0", _subagent_id="sa-0-abcd1234")
    entry = _build_result_entry(child, {"final_response": "ok", "completed": True}, 0, 1.0,
                                _SchemaOutcome(None, None, [], 0))
    assert (entry["subagent_id"], entry["child_session_id"]) == ("sa-0-abcd1234", "child-0")
    assert _fabricated_entry(0, "error", "boom", child)["child_session_id"] == "child-0"
    assert "child_session_id" not in _fabricated_entry(0, "error", "boom", None)

    later = SimpleNamespace(session_id="child-2", _subagent_id="sa-2-ffff0000")
    fields = {f.name: None for f in dataclasses.fields(_Batch) if f.default is dataclasses.MISSING}
    batch = _Batch(**{**fields, "task_list": [{"goal": "a"}, {"goal": "refused"}, {"goal": "c"}],
                      "children": [(0, None, child), (2, None, later)], "live_paths": [], "refused": None})
    payload = _dispatched_payload(batch, [(batch, "deleg_1")])
    assert payload["child_session_ids"] == ["child-0", None, "child-2"]
    assert payload["subagent_ids"] == ["sa-0-abcd1234", "sa-2-ffff0000"]
