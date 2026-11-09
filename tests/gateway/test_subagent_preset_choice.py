"""Choosing a profile subagent preset for ONE chat: ``delegation.settings`` ``preset_name`` and
``session.create`` ``delegation_preset``. The chat captures the preset; library edits never reach it."""

import json
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from tests.gateway.test_subagent_presets_rpc import _operator, _rpc

LIBRARY = {"presets": {"fast-team": {"model": "fast-child", "reasoning_effort": "high", "max_spawn_depth": 2},
                       "deep-team": {"model": "deep-child", "max_spawn_depth": 3}},
           "default_preset": None}


async def _with_library(tmp_path, monkeypatch):
    home, authority, connection = await _operator(tmp_path, monkeypatch)
    (home / "subagent-presets.json").write_text(json.dumps(LIBRARY))
    return home, authority, connection


async def _chat(rpc, home, request_id, **extra):
    return (await rpc("session.create", request_id=request_id, source="gui", cwd=str(home),
                      toolsets=["delegation"], **extra))["session_id"]


@pytest.mark.asyncio
async def test_a_chat_captures_the_chosen_preset_and_other_chats_keep_theirs(tmp_path, monkeypatch):
    home, authority, connection = await _with_library(tmp_path, monkeypatch)
    rpc = _rpc(connection)
    try:
        first, second = await _chat(rpc, home, "first"), await _chat(rpc, home, "second")
        untouched = await rpc("delegation.settings", session_id=second)
        chosen = await rpc("delegation.settings", session_id=first, preset_name="fast-team")
        assert chosen["preset_name"] == "fast-team"
        assert chosen["effective"]["model"] == "fast-child" and chosen["effective"]["max_spawn_depth"] == 2
        assert chosen["defaults"]["model"] == "profile-model"
        assert await rpc("delegation.settings", session_id=first) == chosen
        assert await rpc("delegation.settings", session_id=second) == untouched  # chat-scoped
        # The chat captured the preset: editing the library afterwards never changes it.
        await rpc("delegation.presets", action="delete", name="fast-team")
        await rpc("delegation.presets", action="save", name="fast-team", settings={"model": "edited"})
        assert await rpc("delegation.settings", session_id=first) == chosen
        # Reset is explicit and returns to the plain profile defaults.
        reset = await rpc("delegation.settings", session_id=first, override=None)
        assert reset["preset_name"] is None and reset["override"] is None
        assert reset["effective"]["model"] == "profile-model"
        # A hand-edited override is no longer labelled with a preset.
        await rpc("delegation.settings", session_id=first, preset_name="deep-team")
        edited = await rpc("delegation.settings", session_id=first, override={"model": "mine"})
        assert edited["preset_name"] is None and edited["effective"]["model"] == "mine"
        assert "profile-model" in (home / "config.yaml").read_text()  # profile config never written
    finally:
        await connection.close()
        authority.db.close()


@pytest.mark.asyncio
async def test_invalid_preset_choices_are_refused_without_a_write(tmp_path, monkeypatch):
    home, authority, connection = await _with_library(tmp_path, monkeypatch)
    rpc = _rpc(connection)
    try:
        sid = await _chat(rpc, home, "chat")
        before = await rpc("delegation.settings", session_id=sid)
        library = (home / "subagent-presets.json").read_text()
        for params in ({"preset_name": "missing"}, {"preset_name": ""},
                       {"preset_name": "fast-team", "override": {"model": "x"}}):
            reply = await connection.dispatch({"id": 2, "method": "delegation.settings",
                                               "params": {"session_id": sid, **params}})
            assert reply["error"]["message"] == "invalid_params", params
        draft = await connection.dispatch({"id": 3, "method": "delegation.settings",
                                           "params": {"preset_name": "fast-team"}})
        assert draft["error"]["message"] == "invalid_params"  # a write always names a chat
        assert await rpc("delegation.settings", session_id=sid) == before
        assert (home / "subagent-presets.json").read_text() == library
    finally:
        await connection.close()
        authority.db.close()


@pytest.mark.asyncio
async def test_first_create_captures_a_named_preset_or_keeps_the_frozen_draft(tmp_path, monkeypatch):
    home, authority, connection = await _with_library(tmp_path, monkeypatch)
    rpc = _rpc(connection)
    try:
        named = await _chat(rpc, home, "named", delegation_preset="deep-team")
        read = await rpc("delegation.settings", session_id=named)
        assert read["preset_name"] == "deep-team" and read["effective"]["max_spawn_depth"] == 3
        assert read["effective"]["model"] == "deep-child"
        # A draft froze the preset's settings when the user picked it; the name only labels them, so a
        # library edit while typing never changes the first subagent's route.
        frozen = await _chat(rpc, home, "frozen", delegation_preset="fast-team",
                             delegation_override={"model": "picked-earlier", "max_spawn_depth": 1})
        kept = await rpc("delegation.settings", session_id=frozen)
        assert kept["preset_name"] == "fast-team" and kept["effective"]["model"] == "picked-earlier"
        assert kept["effective"]["max_spawn_depth"] == 1
        missing = await connection.dispatch({"id": 4, "method": "session.create", "params": {
            "request_id": "missing", "source": "gui", "cwd": str(home), "toolsets": ["delegation"],
            "delegation_preset": "gone"}})
        assert "error" in missing and "gone" in json.dumps(missing["error"])
    finally:
        await connection.close()
        authority.db.close()


@pytest.mark.asyncio
async def test_a_bypass_chat_cannot_choose_a_profile_preset(tmp_path, monkeypatch):
    home, authority, connection = await _with_library(tmp_path, monkeypatch)
    monkeypatch.delenv("HERMES_IGNORE_USER_CONFIG", raising=False)
    rpc = _rpc(connection)
    bypass = {"ignore_user_config": True, "provider": "custom", "model": "main", "base_url": "http://127.0.0.1:9/v1"}
    try:
        sid = await _chat(rpc, home, "clean", **bypass)
        refused = await connection.dispatch({"id": 2, "method": "delegation.settings",
                                             "params": {"session_id": sid, "preset_name": "fast-team"}})
        assert refused["error"]["message"] == "invalid_params"
        assert (await rpc("delegation.settings", session_id=sid))["preset_name"] is None
        create = await connection.dispatch({"id": 3, "method": "session.create", "params": {
            "request_id": "clean-2", "source": "gui", "cwd": str(home), "toolsets": ["delegation"],
            "delegation_preset": "fast-team", **bypass}})
        assert "error" in create
    finally:
        await connection.close()
        authority.db.close()


def test_legacy_transport_chooses_a_preset_for_its_own_chat(tmp_path, monkeypatch):
    from hermes_state import SessionDB
    from tui_gateway import server

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("HERMES_IGNORE_USER_CONFIG", raising=False)
    (tmp_path / "subagent-presets.json").write_text(json.dumps(LIBRARY))
    transport = SimpleNamespace(write=lambda frame: True)
    monkeypatch.setattr(server, "_sessions", {"ui-chat": {"session_key": "chat", "history": [], "transport": transport}})
    with SessionDB(db_path=tmp_path / "state.db") as db:
        db.ensure_session("chat", source="gui")

        @contextmanager
        def database(session):
            yield db

        monkeypatch.setattr(server, "_session_db", database)
        monkeypatch.setattr(server, "_ensure_session_db_row", lambda session: True)

        def call(**params):
            return server.dispatch({"id": 1, "method": "delegation.settings", "params": params}, transport=transport)

        chosen = call(session_id="ui-chat", preset_name="deep-team")["result"]
        assert chosen["preset_name"] == "deep-team" and chosen["effective"]["max_spawn_depth"] == 3
        assert call(session_id="ui-chat")["result"] == chosen
        assert call(session_id="ui-chat", preset_name="missing")["error"]["code"] == 4000
        assert call(preset_name="deep-team")["error"]["code"] == 4000  # a write always names a chat
        foreign = server.dispatch({"id": 2, "method": "delegation.settings",
                                   "params": {"session_id": "ui-chat", "preset_name": "fast-team"}},
                                  transport=SimpleNamespace(write=lambda frame: True))
        assert foreign["error"]["code"] == 4001
        assert call(session_id="ui-chat")["result"]["preset_name"] == "deep-team"


def test_legacy_create_captures_a_named_preset(monkeypatch, tmp_path):
    from gateway.session_delegation_settings import creation_settings

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("HERMES_IGNORE_USER_CONFIG", raising=False)
    (tmp_path / "subagent-presets.json").write_text(json.dumps(LIBRARY))
    captured = creation_settings({"delegation_preset": "fast-team"}, {"delegation": {"model": "profile-model"}})
    assert captured["preset_name"] == "fast-team" and captured["effective"]["model"] == "fast-child"
    plain = creation_settings({}, {"delegation": {"model": "profile-model"}})
    assert "preset_name" not in plain and plain["effective"]["model"] == "profile-model"
    monkeypatch.setenv("HERMES_IGNORE_USER_CONFIG", "1")
    with pytest.raises(ValueError):
        creation_settings({"delegation_preset": "fast-team"}, {})
