"""Per-conversation subagent choices are detached, durable snapshots, never profile edits."""

import json
import threading

import pytest

from tests.tools.test_delegation_backends import _home, _parent

pytest_plugins = ["tests.tools.test_delegation_backends"]


def test_two_chats_keep_routes_and_limits_across_resume(tmp_path, monkeypatch, recorded):
    from agent.delegation_settings import initialize_settings, settings_for_session, update_settings
    from hermes_state import SessionDB
    from tools.delegate_tool import delegate_task

    home, manager = _home(tmp_path, monkeypatch, {"model": "profile-model"})
    db = SessionDB(db_path=home / "state.db")
    try:
        for sid in ("chat-a", "chat-b"):
            db.ensure_session(sid, source="gui")
        update_settings(db, "chat-a", override={"model": "chat-model", "reasoning_effort": "high",
                                               "max_spawn_depth": 2, "max_concurrent_children": 1})
        a, b = _parent("chat-a"), _parent("chat-b")
        initialize_settings(a, "chat-a", db)
        initialize_settings(b, "chat-b", db)
        assert json.loads(delegate_task(goal="first", parent_agent=a))["results"][0]["status"] == "completed"
        assert recorded[-1]["model"] == "chat-model"
        assert recorded[-1]["override_reasoning_effort"] == "high"
        assert json.loads(delegate_task(goal="other chat", parent_agent=b))["results"][0]["status"] == "completed"
        assert recorded[-1]["model"] == "profile-model"
        resumed = _parent("chat-a")
        initialize_settings(resumed, "chat-a", db)
        assert settings_for_session(db, "chat-a")["override"]["max_concurrent_children"] == 1
        assert json.loads(delegate_task(goal="resumed", parent_agent=resumed))["results"][0]["status"] == "completed"
        assert recorded[-1]["model"] == "chat-model"
    finally:
        db.close()
        manager.unload()


def test_async_calls_keep_their_snapshot_and_chat_capacity(tmp_path, monkeypatch, recorded):
    from agent.delegation_settings import current_settings, initialize_settings, update_settings
    from hermes_state import SessionDB
    from tools import async_delegation as ad, delegate_tool as dt
    from tests.waiting import wait_until

    home, manager = _home(tmp_path, monkeypatch, {})
    db = SessionDB(db_path=home / "state.db")
    release = threading.Event()
    started = {sid: threading.Event() for sid in ("async-a", "async-b")}
    seen = {}
    ad._reset_for_tests()

    def run(task_index, goal, child=None, parent_agent=None, **kw):
        sid = parent_agent.session_id
        seen[sid] = dict(current_settings())
        started[sid].set()
        assert release.wait(10)
        assert current_settings()["model"] == seen[sid]["model"]
        return {"task_index": task_index, "status": "completed", "summary": "ok", "api_calls": 1,
                "duration_seconds": 0}

    monkeypatch.setattr(dt, "_run_single_child", run)
    try:
        parents = []
        for sid in ("async-a", "async-b"):
            db.ensure_session(sid, source="gui")
            update_settings(db, sid, override={"model": sid, "max_concurrent_children": 1})
            parent = _parent(sid)
            parent._session_db = db
            initialize_settings(parent, sid, db)
            parents.append(parent)
            monkeypatch.setattr(dt, "_capture_origin", lambda sid=sid: (sid, sid, None, None, True))
            out = json.loads(dt.delegate_task(goal="Long running test subagent", parent_agent=parent, background=True))
            assert out["status"] == "dispatched", out
            assert started[sid].wait(10)
        assert set(seen) == {"async-a", "async-b"}  # both own a slot, not a shared profile cap
        update_settings(db, "async-a", override={"model": "changed", "max_concurrent_children": 2})
        assert seen["async-a"]["model"] == "async-a"  # already running remains unchanged
        assert seen["async-b"]["max_concurrent_children"] == 1
        tasks = [{"goal": "First meaningful task"}, {"goal": "Second meaningful task"}]
        refused = json.loads(dt.delegate_task(tasks=tasks, parent_agent=parents[1]))
        assert "max_concurrent_children is 1" in refused["error"]
    finally:
        release.set()
        assert wait_until(lambda: not any(r["status"] in {"running", "dispatched", "stalling"}
                                         for r in ad.list_async_delegations()), timeout=10)
        ad._reset_for_tests()
        db.close()
        manager.unload()


@pytest.mark.parametrize("override", [{"max_spawn_depth": 0}, {"max_concurrent_children": True},
                                      {"reasoning_effort": "typo"}, {"backend": "missing-plugin"},
                                      {"backends": {"default": {"api_key": "not-allowed"}}}])
def test_invalid_settings_fail_without_changing_chat(tmp_path, monkeypatch, override):
    from agent.delegation_settings import settings_for_session, update_settings
    from hermes_state import SessionDB

    home, manager = _home(tmp_path, monkeypatch, {}, plugins=())
    with SessionDB(db_path=home / "state.db") as db:
        db.ensure_session("valid", source="gui")
        before = settings_for_session(db, "valid")
        with pytest.raises(ValueError):
            update_settings(db, "valid", override=override)
        assert settings_for_session(db, "valid") == before
    manager.unload()


_MARKER = "SYNTHETIC-HEADER-CREDENTIAL"


def _header_override(name):
    return {"backends": {"default": {"request_overrides": {"extra_headers": {name: f"Bearer {_MARKER}"}}}}}


@pytest.mark.parametrize("override", [
    _header_override("Authorization"), _header_override("authorization"), _header_override("PROXY-AUTHORIZATION"),
    _header_override("x-api-key"), _header_override("X-Title"),
    {"backends": {"default": {"Api-Key": _MARKER}}},
    {"backends": {"default": {"request_overrides": {"extra_body": {"access-token": _MARKER}}}}},
    {"backends": {"model_map": {"options": [{"name": "fast", "description": "d", "model": "m",
                                             "provider": "custom", "X_API_KEY": _MARKER}]}}}],
    ids=["Authorization", "lowercase", "proxy-uppercase", "x-api-key", "any-header", "hyphen-api-key",
         "nested-access-token", "route-entry"])
def test_credential_override_is_refused_before_anything_is_written(tmp_path, monkeypatch, override):
    from agent.delegation_settings import update_settings
    from hermes_state import SessionDB

    home, manager = _home(tmp_path, monkeypatch, {}, plugins=())
    try:
        with SessionDB(db_path=home / "state.db") as db:
            db.ensure_session("chat", source="gui")
            update_settings(db, "chat", override={"model": "kept"})
            before = db.get_session("chat")
            with pytest.raises(ValueError, match="credentials"):
                update_settings(db, "chat", override=override)
            assert db.get_session("chat") == before  # the earlier selection is untouched
            assert _MARKER not in json.dumps(db.get_session("chat"))
    finally:
        manager.unload()


def test_noncredential_extension_json_round_trips_and_stored_credentials_are_never_echoed(tmp_path, monkeypatch):
    from agent.delegation_settings import _KEY, settings_for_session, update_settings
    from hermes_state import SessionDB

    home, manager = _home(tmp_path, monkeypatch, {}, plugins=())
    extension = {"request_overrides": {"extra_body": {"max_tokens": 512, "token_budget": 3,
                                                      "provider": {"order": ["a", "b"]}}},
                 "service_tier": "flex", "vendor_option": {"nested": [1, True, None]}}
    try:
        with SessionDB(db_path=home / "state.db") as db:
            db.ensure_session("chat", source="gui")
            written = update_settings(db, "chat", override={"backends": {"default": extension}})
            assert written["override"]["backends"]["default"] == extension
            assert settings_for_session(db, "chat")["effective"]["backends"]["default"] == extension
            # A row this code never writes (credential refused at the write) is still not echoed by a read.
            state = db.get_session_model_config_value("chat", _KEY)
            state["override"]["backends"]["default"]["request_overrides"]["extra_headers"] = {
                "Authorization": _MARKER}
            db.patch_session_model_config("chat", {_KEY: state})
            assert _MARKER not in json.dumps(settings_for_session(db, "chat"))
    finally:
        manager.unload()


@pytest.mark.parametrize("name", ["Authorization", "x-api-key"])
def test_session_create_refuses_a_credential_override_without_creating_the_chat(tmp_path, monkeypatch, name):
    import asyncio
    from tests.gateway.test_local_create_env_refs import _owner

    async def exercise():
        home = tmp_path / "home"
        home.mkdir()
        (home / "config.yaml").write_text(
            "platform_toolsets: {gui: []}\nmodel: {provider: custom, default: main, base_url: http://127.0.0.1:9/v1}\n")
        authority, connection = await _owner(home, monkeypatch)
        try:
            reply = await connection.dispatch({"id": 1, "method": "session.create", "params": {
                "request_id": "with-header", "source": "gui", "cwd": str(home), "toolsets": [],
                "delegation_override": _header_override(name)}})
            assert reply.get("error", {}).get("message") == "invalid_params", reply
            assert _MARKER not in json.dumps(reply)
            listed = authority.db.list_sessions_rich(limit=50) if hasattr(authority.db, "list_sessions_rich") else []
            assert _MARKER not in json.dumps(listed, default=str)
        finally:
            await connection.close()
            authority.db.close()
        for path in home.rglob("state.db*"):
            assert _MARKER.encode() not in path.read_bytes()
    asyncio.run(exercise())


@pytest.mark.parametrize("name", ["Authorization", "Cookie"])
def test_legacy_create_refuses_a_credential_override(name):
    from gateway.session_delegation_settings import creation_settings
    with pytest.raises(ValueError, match="credentials"):
        creation_settings({"delegation_override": _header_override(name)}, {})
