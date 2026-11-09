"""Native ``delegation.presets``: the owning profile's library, written only by its operator.

New chats that can delegate capture the default preset at creation; existing chats keep what they captured."""

import json
from dataclasses import replace

import pytest

from tests.gateway.test_local_create_env_refs import _owner

PROFILE = ("platform_toolsets: {gui: []}\nmodel: {provider: custom, default: main, base_url: http://127.0.0.1:9/v1}\n"
           "delegation: {model: profile-model}\n")


async def _operator(tmp_path, monkeypatch, config=PROFILE):
    from gateway.session_controls import AuthorityConnection

    home = tmp_path / "home"
    home.mkdir()
    (home / "config.yaml").write_text(config)
    authority, initial = await _owner(home, monkeypatch)
    await initial.close()
    return home, authority, AuthorityConnection(authority, object(), {"user_id": "owner"}, operator=True)


def _rpc(connection):
    async def rpc(method, **params):
        reply = await connection.dispatch({"id": 1, "method": method, "params": params})
        assert "error" not in reply, reply
        return reply["result"]
    return rpc


@pytest.mark.asyncio
async def test_operator_manages_the_library_and_new_chats_capture_the_default(tmp_path, monkeypatch):
    home, authority, connection = await _operator(tmp_path, monkeypatch)
    rpc = _rpc(connection)
    try:
        assert await rpc("delegation.presets") == {"presets": [], "default_preset": None}
        bundle = {"model": "fast-child", "reasoning_effort": "high", "max_spawn_depth": 2}
        saved = await rpc("delegation.presets", action="save", name="fast-team", settings=bundle)
        assert saved["presets"][0]["settings"]["model"] == "fast-child"
        await rpc("delegation.presets", action="default", name="fast-team")
        first = (await rpc("session.create", request_id="captures", source="gui", cwd=str(home),
                           toolsets=["delegation"]))["session_id"]
        captured = await rpc("delegation.settings", session_id=first)
        assert captured["preset_name"] == "fast-team" and captured["override"] is None
        assert captured["effective"]["model"] == "fast-child" and captured["effective"]["max_spawn_depth"] == 2
        assert captured["defaults"]["model"] == "profile-model"
        # A chat that cannot delegate never reads the library.
        plain = (await rpc("session.create", request_id="plain", source="gui", cwd=str(home),
                           toolsets=[]))["session_id"]
        read = await rpc("delegation.settings", session_id=plain)
        assert read["preset_name"] is None and read["effective"]["model"] == "profile-model"
        # Library edits never change an existing chat; the new default applies to new chats only.
        await rpc("delegation.presets", action="rename", name="fast-team", new_name="renamed")
        await rpc("delegation.presets", action="save", name="other", settings={"model": "other-model"})
        await rpc("delegation.presets", action="default", name="other")
        await rpc("delegation.presets", action="delete", name="renamed")
        assert await rpc("delegation.settings", session_id=first) == captured
        second = (await rpc("session.create", request_id="later", source="gui", cwd=str(home),
                            toolsets=["delegation"]))["session_id"]
        assert (await rpc("delegation.settings", session_id=second))["effective"]["model"] == "other-model"
        # An explicit chat override wins over the default preset entirely.
        explicit = (await rpc("session.create", request_id="explicit", source="gui", cwd=str(home),
                              toolsets=["delegation"], delegation_override={"model": "chosen"}))["session_id"]
        chosen = await rpc("delegation.settings", session_id=explicit)
        assert chosen["preset_name"] is None and chosen["effective"]["model"] == "chosen"
        # Resetting a captured chat returns it to the plain profile defaults.
        reset = await rpc("delegation.settings", session_id=second, override=None)
        assert reset["preset_name"] is None and reset["effective"]["model"] == "profile-model"
        assert "profile-model" in (home / "config.yaml").read_text()  # profile config never written
    finally:
        await connection.close()
        authority.db.close()


@pytest.mark.asyncio
async def test_only_the_profile_operator_can_change_the_library(tmp_path, monkeypatch):
    from gateway.session_controls import AuthorityConnection

    home, authority, connection = await _operator(tmp_path, monkeypatch)
    await _rpc(connection)("delegation.presets", action="save", name="kept", settings={"model": "m"})
    before = (home / "subagent-presets.json").read_text()
    integration = AuthorityConnection(authority, object(), {"user_id": "owner"})  # not the operator
    try:
        listed = await integration.dispatch({"id": 2, "method": "delegation.presets", "params": {}})
        assert [p["name"] for p in listed["result"]["presets"]] == ["kept"]
        for params in ({"action": "save", "name": "x", "settings": {}}, {"action": "delete", "name": "kept"},
                       {"action": "rename", "name": "kept", "new_name": "y"}, {"action": "default", "name": "kept"}):
            refused = await integration.dispatch({"id": 3, "method": "delegation.presets", "params": params})
            assert refused["error"]["message"] == "permission_denied", params
        denied = replace(connection.actor, capabilities=connection.actor.capabilities - {"session:control"})
        with monkeypatch.context() as scope:
            scope.setattr(connection, "actor", denied)
            refused = await connection.dispatch({"id": 4, "method": "delegation.presets",
                                                 "params": {"action": "delete", "name": "kept"}})
        assert refused["error"]["message"] == "permission_denied"
        assert (home / "subagent-presets.json").read_text() == before
        bad = await connection.dispatch({"id": 5, "method": "delegation.presets",
                                         "params": {"action": "save", "name": "x", "settings": {"api_key": "s"}}})
        assert bad["error"]["message"] == "invalid_params"
    finally:
        await integration.close()
        await connection.close()
        authority.db.close()


@pytest.mark.asyncio
async def test_malformed_library_is_reported_but_never_blocks_chats(tmp_path, monkeypatch):
    home, authority, connection = await _operator(tmp_path, monkeypatch)
    (home / "subagent-presets.json").write_text("{not json")
    rpc = _rpc(connection)
    try:
        failed = await connection.dispatch({"id": 2, "method": "delegation.presets", "params": {}})
        assert failed["error"]["message"] == "invalid_params"
        sid = (await rpc("session.create", request_id="still-starts", source="gui", cwd=str(home),
                         toolsets=["delegation"]))["session_id"]
        read = await rpc("delegation.settings", session_id=sid)
        assert read["preset_name"] is None and read["effective"]["model"] == "profile-model"
        assert (home / "subagent-presets.json").read_text() == "{not json"
    finally:
        await connection.close()
        authority.db.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("safe_mode", [False, True])
async def test_bypass_chat_never_captures_profile_presets(tmp_path, monkeypatch, safe_mode):
    home, authority, connection = await _operator(tmp_path, monkeypatch)
    (home / "subagent-presets.json").write_text(json.dumps(
        {"presets": {"team": {"model": "preset-model", "max_spawn_depth": 3}}, "default_preset": "team"}))
    monkeypatch.delenv("HERMES_IGNORE_USER_CONFIG", raising=False)
    rpc = _rpc(connection)
    try:
        bypass = (await rpc("session.create", request_id="clean", source="gui", cwd=str(home),
                            toolsets=["delegation"], ignore_user_config=True, safe_mode=safe_mode,
                            provider="custom", model="main", base_url="http://127.0.0.1:9/v1"))["session_id"]
        ordinary = (await rpc("session.create", request_id="normal", source="gui", cwd=str(home),
                              toolsets=["delegation"]))["session_id"]
        assert (await rpc("delegation.settings", session_id=ordinary))["preset_name"] == "team"
        read = await rpc("delegation.settings", session_id=bypass)
        assert read["preset_name"] is None
        for view in (read["effective"], read["defaults"]):
            assert view["model"] not in {"preset-model", "profile-model"} and view["max_spawn_depth"] == 1
    finally:
        await connection.close()
        authority.db.close()
