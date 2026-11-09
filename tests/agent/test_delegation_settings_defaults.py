"""Unselected policy preserves the default tool/route; optional libraries are never read."""

import json
import types

import pytest

from tests.tools.test_delegation_backends import _definition, _home, _parent

pytest_plugins = ["tests.tools.test_delegation_backends", "tests.agent.test_delegation_switch_next_session"]


@pytest.mark.parametrize("library", ["{}", "not JSON", '{"default_preset":"missing"}',
                                     '{"presets":{"team":{"model":"wrong"}},"default_preset":"team"}'])
def test_no_override_keeps_default_schema_and_spawn_without_reading_presets(tmp_path, monkeypatch, recorded, library):
    from agent.delegation_settings import initialize_settings, settings_for_session, settings_scope
    from tools.delegate_tool import delegate_task

    home, manager = _home(tmp_path, monkeypatch, {}, plugins=())
    (home / "subagent-presets.json").write_text(library)
    try:
        original = _definition()
        legacy = _parent("unselected")
        baseline = json.loads(delegate_task(goal="Default child", parent_agent=legacy))
        baseline_build = recorded[-1]
        pinned = legacy
        initialize_settings(pinned, "unselected", None)
        with settings_scope(pinned._delegation_config):
            assert _definition() == original
        actual = json.loads(delegate_task(goal="Default child", parent_agent=pinned))
        for field in ("status", "summary", "api_calls"):
            assert actual["results"][0][field] == baseline["results"][0][field]
        assert recorded[-1] == baseline_build
        assert pinned._delegation_config["max_spawn_depth"] == 1
        assert settings_for_session()["override"] is None
    finally:
        manager.unload()


@pytest.mark.parametrize("ignore", [False, True])
def test_session_ignore_policy_is_not_a_process_wide_setting(tmp_path, monkeypatch, ignore):
    from agent.delegation_settings import initialize_settings, settings_for_session
    from gateway.session_policy import _ACTIVE_POLICY

    _, manager = _home(tmp_path, monkeypatch, {"model": "profile-model", "max_spawn_depth": 3}, plugins=())
    monkeypatch.delenv("HERMES_IGNORE_USER_CONFIG", raising=False)
    token = _ACTIVE_POLICY.set(types.SimpleNamespace(ignore_user_config=ignore))
    try:
        agent = _parent("isolated")
        initialize_settings(agent, "isolated", None)
        expected = ("", 1) if ignore else ("profile-model", 3)
        assert (agent._delegation_config["model"], agent._delegation_config["max_spawn_depth"]) == expected
        defaults = settings_for_session()["defaults"]
        assert (defaults["model"], defaults["max_spawn_depth"]) == expected
    finally:
        _ACTIVE_POLICY.reset(token)
        manager.unload()


def test_cli_ignore_flag_uses_builtin_defaults(tmp_path, monkeypatch):
    from agent.delegation_settings import initialize_settings

    _, manager = _home(tmp_path, monkeypatch, {"model": "profile-model", "max_spawn_depth": 3}, plugins=())
    monkeypatch.setenv("HERMES_IGNORE_USER_CONFIG", "1")
    try:
        parent = _parent("clean")
        initialize_settings(parent, "clean", None)
        assert parent._delegation_config["model"] == ""
        assert parent._delegation_config["max_spawn_depth"] == 1
    finally:
        manager.unload()


def test_safe_worker_uses_only_its_frozen_delegation_config(tmp_path):
    from tests.agent.test_safe_worker_policy import run_worker

    result = run_worker(tmp_path, '''
        import json, sys
        from pathlib import Path
        from types import SimpleNamespace
        from agent.safe_worker_policy import _bind_safe_worker_policy
        _bind_safe_worker_policy(safe_mode=True, ignore_user_config=True,
                                config={"delegation": {"model": "worker-model", "max_spawn_depth": 1}})
        reads = []
        def audit(event, args):
            if event == "open" and Path(str(args[0])).name in {"config.yaml", "subagent-presets.json"}:
                reads.append(str(args[0]))
        sys.addaudithook(audit)
        from agent.delegation_settings import initialize_settings
        agent = SimpleNamespace()
        initialize_settings(agent, "worker", None)
        print(json.dumps({"model": agent._delegation_config["model"], "reads": reads}))
    ''')
    assert result == {"model": "worker-model", "reads": []}


def test_ordinary_agent_construction_does_not_open_a_preset_file(options_backend, monkeypatch):
    from pathlib import Path
    from tests.agent.test_delegation_switch_next_session import _agent

    srv, home = options_backend
    (home / "subagent-presets.json").write_text("not JSON")
    original = Path.open

    def guarded(path, *args, **kwargs):
        assert path.name != "subagent-presets.json", "ordinary construction must not read an optional library"
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", guarded)
    parent = _agent(srv, home, "no-preset-io")
    try:
        assert parent._delegation_config["max_spawn_depth"] == 1
    finally:
        parent.close()
