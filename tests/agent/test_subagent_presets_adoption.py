"""A new chat starts from the profile's default subagent preset only when it can delegate at all.

The library is optional user config: a missing, empty or malformed one, a chat without ``delegate_task``,
an ignore-user-config chat and a safe worker all keep the plain profile defaults and never fail."""

import json
import logging
import types

import pytest

from tests.tools.test_delegation_backends import _home, _parent

pytest_plugins = ["tests.tools.test_delegation_backends", "tests.agent.test_delegation_switch_next_session"]

TEAM = {"model": "preset-model", "max_spawn_depth": 3, "max_concurrent_children": 1}
MALFORMED = {
    "invalid-json": "{not json",
    "wrong-envelope": "[]",
    "presets-not-object": '{"presets": [], "default_preset": "team"}',
    "default-not-string": '{"presets": {}, "default_preset": 7}',
    "entry-not-object": '{"presets": {"team": "gpt"}, "default_preset": "team"}',
    "entry-bad-field": '{"presets": {"team": {"max_spawn_depth": "deep"}}, "default_preset": "team"}',
}
UNUSABLE_DEFAULT = {"empty-object": "{}", "missing-selected-preset": '{"presets": {}, "default_preset": "gone"}'}


def _library(home, text=None):
    path = home / "subagent-presets.json"
    path.write_text(text if text is not None else json.dumps({"presets": {"team": TEAM}, "default_preset": "team"}),
                    encoding="utf-8")
    return path


def _start(session_id, offers_delegation=True):
    """A new chat's construction: its tools are loaded once, under the policy it starts from."""
    from agent.delegation_settings import load_tools_with_policy

    agent, loads = _parent(session_id), []

    def load():
        from agent.delegation_settings import current_settings
        loads.append(current_settings()["model"])
        agent.valid_tool_names = {"delegate_task", "terminal"} if offers_delegation else {"terminal"}
    load_tools_with_policy(agent, session_id, None, load)
    return agent, loads


def _adopted(agent):
    config = agent._delegation_config
    return agent._delegation_preset_name, config["model"], config["max_spawn_depth"]


def test_no_library_is_a_no_op_that_never_touches_the_profile_home(tmp_path, monkeypatch):
    home, manager = _home(tmp_path, monkeypatch, {"model": "profile-model"}, plugins=())
    try:
        agent, loads = _start("plain")
        assert _adopted(agent) == (None, "profile-model", 1) and loads == ["profile-model"]
        assert not (home / "subagent-presets.json").exists() and not (home / "subagent-presets.lock").exists()
    finally:
        manager.unload()


def test_new_chat_with_delegation_starts_from_the_default_preset(tmp_path, monkeypatch):
    home, manager = _home(tmp_path, monkeypatch, {"model": "profile-model"}, plugins=())
    _library(home)
    try:
        agent, loads = _start("delegating")
        assert _adopted(agent) == ("team", "preset-model", 3)
        assert loads == ["profile-model", "preset-model"]  # tools rebuilt under the adopted policy
        from agent.delegation_settings import settings_for_session
        read = settings_for_session(agent=agent)
        assert read["preset_name"] == "team" and read["effective"]["model"] == "preset-model"
        assert read["defaults"]["model"] == "profile-model" and read["override"] is None
    finally:
        manager.unload()


def test_chat_without_delegate_task_never_reads_the_library(tmp_path, monkeypatch):
    from pathlib import Path

    home, manager = _home(tmp_path, monkeypatch, {"model": "profile-model"}, plugins=())
    _library(home)
    original = Path.read_text

    def guarded(path, *args, **kwargs):
        assert path.name != "subagent-presets.json", "a chat that cannot delegate must not read presets"
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, "read_text", guarded)
    try:
        agent, loads = _start("no-delegation", offers_delegation=False)
        assert _adopted(agent) == (None, "profile-model", 1) and loads == ["profile-model"]
    finally:
        manager.unload()


@pytest.mark.parametrize("text", [*MALFORMED.values(), *UNUSABLE_DEFAULT.values()],
                         ids=[*MALFORMED, *UNUSABLE_DEFAULT])
def test_unusable_library_falls_back_to_profile_defaults(tmp_path, monkeypatch, caplog, text):
    home, manager = _home(tmp_path, monkeypatch, {"model": "profile-model"}, plugins=())
    path = _library(home, text)
    try:
        with caplog.at_level(logging.WARNING, logger="agent.subagent_presets"):
            agent, loads = _start("plain-chat")
        assert _adopted(agent) == (None, "profile-model", 1) and loads == ["profile-model"]
        assert path.read_text(encoding="utf-8") == text  # kept for recovery, never rewritten
        if text in MALFORMED.values():
            assert any("subagent-presets.json" in r.getMessage() for r in caplog.records)
    finally:
        manager.unload()


def test_cli_ignore_user_config_never_adopts_the_default_preset(tmp_path, monkeypatch):
    from agent.delegation_settings import settings_for_session

    home, manager = _home(tmp_path, monkeypatch, {}, plugins=())
    _library(home)
    try:
        monkeypatch.setenv("HERMES_IGNORE_USER_CONFIG", "1")
        agent, _ = _start("clean")
        assert _adopted(agent)[0] is None and _adopted(agent)[1:] != ("preset-model", 3)
        assert settings_for_session(agent=agent)["preset_name"] is None
    finally:
        manager.unload()


def test_per_session_policy_decides_in_a_multiplexed_process(tmp_path, monkeypatch):
    """The env flag is process-wide; a gateway runs ordinary and bypass chats side by side."""
    from gateway.session_policy import _ACTIVE_POLICY

    home, manager = _home(tmp_path, monkeypatch, {}, plugins=())
    _library(home)
    monkeypatch.delenv("HERMES_IGNORE_USER_CONFIG", raising=False)
    try:
        for ignore, expected in ((True, (None, "", 1)), (False, ("team", "preset-model", 3))):
            token = _ACTIVE_POLICY.set(types.SimpleNamespace(ignore_user_config=ignore))
            try:
                agent, _ = _start(f"chat-{ignore}")
            finally:
                _ACTIVE_POLICY.reset(token)
            assert _adopted(agent) == expected
    finally:
        manager.unload()


def test_existing_chats_keep_their_captured_policy(tmp_path, monkeypatch):
    """Pinned/resumed chats and subagents never re-read the library; a later default applies to new chats."""
    from agent.delegation_settings import load_tools_with_policy, settings_scope
    from hermes_state import SessionDB
    from tools.mcp_tool_agent import persist_agent_tool_names

    home, manager = _home(tmp_path, monkeypatch, {"model": "profile-model"}, plugins=())
    _library(home)
    try:
        with SessionDB(db_path=home / "state.db") as db:
            db.ensure_session("kept", source="cli")
            agent, _ = _start("kept")
            agent._session_db, agent.tools = db, []
            persist_agent_tool_names(agent)
            _library(home, json.dumps({"presets": {"team": {**TEAM, "model": "edited"}}, "default_preset": "team"}))
            resumed = _parent("kept")
            load_tools_with_policy(resumed, "kept", db, lambda: setattr(resumed, "valid_tool_names", {"delegate_task"}))
            assert resumed._delegation_config["model"] == "preset-model"
            child = _parent("child")
            with settings_scope({**agent._delegation_config, "model": "parent-snapshot"}):
                load_tools_with_policy(child, "child", None, lambda: setattr(child, "valid_tool_names", {"delegate_task"}))
            assert child._delegation_config["model"] == "parent-snapshot" and child._delegation_preset_name is None
            assert _adopted(_start("new")[0])[1] == "edited"
    finally:
        manager.unload()


def test_safe_worker_never_reads_the_library(tmp_path):
    from tests.agent.test_safe_worker_policy import run_worker

    result = run_worker(tmp_path, '''
        import json, os, sys
        from pathlib import Path
        from types import SimpleNamespace
        home = Path(os.environ["HERMES_HOME"])
        home.mkdir(parents=True, exist_ok=True)
        (home / "subagent-presets.json").write_text(json.dumps(
            {"presets": {"team": {"model": "preset-model"}}, "default_preset": "team"}))
        from agent.safe_worker_policy import _bind_safe_worker_policy
        _bind_safe_worker_policy(safe_mode=True, ignore_user_config=True,
                                config={"delegation": {"model": "worker-model", "max_spawn_depth": 1}})
        reads = []
        def audit(event, args):
            if event == "open" and Path(str(args[0])).name == "subagent-presets.json":
                reads.append(str(args[0]))
        sys.addaudithook(audit)
        from agent.delegation_settings import load_tools_with_policy
        agent = SimpleNamespace()
        load_tools_with_policy(agent, "worker", None, lambda: setattr(agent, "valid_tool_names", {"delegate_task"}))
        print(json.dumps({"model": agent._delegation_config["model"], "reads": reads}))
    ''')
    assert result == {"model": "worker-model", "reads": []}


def test_real_agent_rebuilds_delegate_task_under_the_adopted_preset(options_backend):
    """The profile routes through a plugin backend that adds a per-task ``option``; the default preset picks
    the built-in backend, so the new chat's advertised schema and its route agree on the built-in one."""
    from tests.agent.test_delegation_switch_next_session import _agent

    srv, home = options_backend
    _library(home, json.dumps({"presets": {"builtin": {"backend": "default", "max_spawn_depth": 2}},
                               "default_preset": "builtin"}))
    parent = _agent(srv, home, "preset-chat")
    try:
        tool = next(t for t in parent.tools if t["function"]["name"] == "delegate_task")
        assert "option" not in tool["function"]["parameters"]["properties"]["tasks"]["items"]["properties"]
        assert parent._delegation_backend == "default" and parent._delegation_config["max_spawn_depth"] == 2
        assert parent._delegation_preset_name == "builtin"
    finally:
        parent.close()
