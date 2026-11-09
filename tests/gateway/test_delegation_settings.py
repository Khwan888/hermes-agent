"""Native settings RPC stores one chat's policy, never a profile-wide route."""

from dataclasses import replace

import pytest

from tests.gateway.test_local_create_env_refs import _owner


@pytest.mark.asyncio
async def test_native_create_settings_and_resume_are_chat_scoped(tmp_path, monkeypatch):
    from gateway.session_controls import AuthorityConnection
    from hermes_state import SessionDB
    from agent.delegation_settings import initialize_settings
    from types import SimpleNamespace

    home = tmp_path / "home"
    home.mkdir()
    profile_config = "platform_toolsets: {gui: []}\nmodel: {provider: custom, default: main, base_url: http://127.0.0.1:9/v1}\n"
    (home / "config.yaml").write_text(profile_config)
    authority, connection = await _owner(home, monkeypatch)

    async def rpc(method, **params):
        reply = await connection.dispatch({"id": 1, "method": method, "params": params})
        assert "error" not in reply, reply
        return reply["result"]

    try:
        defaults = await rpc("delegation.settings")
        assert defaults["override"] is None and defaults["effective"]["max_spawn_depth"] == 1
        bundle = {"model": "fast-child", "reasoning_effort": "high", "max_spawn_depth": 2,
                  "max_concurrent_children": 2}
        created = await rpc("session.create", request_id="chat-one", source="gui", cwd=str(home),
                            toolsets=[], delegation_override=bundle)
        sid = created["session_id"]
        selected = await rpc("delegation.settings", session_id=sid)
        assert selected["override"] == bundle and selected["effective"]["model"] == "fast-child"
        second = await rpc("session.create", request_id="chat-two", source="gui", cwd=str(home), toolsets=[])
        assert (await rpc("delegation.settings", session_id=second["session_id"]))["override"] is None
        edited = {"model": "edited-child", "max_concurrent_children": 1}
        await rpc("delegation.settings", session_id=sid, override=edited)
        # A new connection and an independent DB handle recover the same selection.
        other = AuthorityConnection(authority, object(), {"user_id": "owner"})
        try:
            read = await other.dispatch({"id": 2, "method": "delegation.settings", "params": {"session_id": sid}})
            assert read["result"]["override"] == edited
        finally:
            await other.close()
        with SessionDB(db_path=home / "state.db") as reopened:
            resumed = SimpleNamespace()
            initialize_settings(resumed, sid, reopened)
            assert resumed._delegation_config["model"] == "edited-child"
        before = await rpc("delegation.settings", session_id=sid)
        denied_actor = replace(connection.actor, capabilities=connection.actor.capabilities - {"session:control"})
        with monkeypatch.context() as scope:
            scope.setattr(connection, "actor", denied_actor)
            denied = await connection.dispatch({"id": 3, "method": "delegation.settings", "params": {
                "session_id": sid, "override": {"model": "forbidden"}}})
        assert denied["error"]["message"] == "permission_denied"
        bad = await connection.dispatch({"id": 3, "method": "delegation.settings", "params": {
            "session_id": sid, "override": {"max_spawn_depth": 0}}})
        assert bad["error"]["message"] == "invalid_params"
        assert await rpc("delegation.settings", session_id=sid) == before
        await rpc("delegation.settings", session_id=sid, override=None)
        assert (await rpc("delegation.settings", session_id=sid))["effective"]["model"] == ""
        assert (home / "config.yaml").read_text() == profile_config
    finally:
        await connection.close()
        authority.db.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("safe_mode", [False, True])
async def test_bypass_create_and_settings_never_read_profile_delegation(tmp_path, monkeypatch, safe_mode):
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.yaml").write_text(
        "platform_toolsets: {gui: []}\nmodel: {provider: custom, default: main, base_url: http://127.0.0.1:9/v1}\n"
        "delegation: {model: profile-only, max_spawn_depth: 3}\n")
    (home / "subagent-presets.json").write_text("not JSON")
    authority, connection = await _owner(home, monkeypatch)

    async def rpc(method, **params):
        reply = await connection.dispatch({"id": 1, "method": method, "params": params})
        assert "error" not in reply, reply
        return reply["result"]

    try:
        created = await rpc("session.create", request_id="clean", source="gui", cwd=str(home), toolsets=[],
                            ignore_user_config=True, safe_mode=safe_mode, provider="custom", model="main",
                            base_url="http://127.0.0.1:9/v1")
        sid = created["session_id"]
        read = await rpc("delegation.settings", session_id=sid)
        assert read["override"] is None
        for view in (read["effective"], read["defaults"]):
            assert view["model"] == "" and view["max_spawn_depth"] == 1
        written = await rpc("delegation.settings", session_id=sid, override={"model": "chat-pick"})
        assert written["effective"]["model"] == "chat-pick" and written["effective"]["max_spawn_depth"] == 1
    finally:
        await connection.close()
        authority.db.close()
