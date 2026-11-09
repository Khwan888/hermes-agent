"""Choosing another provider for a route replaces its whole transport, top-level or named."""

import copy

import pytest

from tests.tools.test_delegation_backends import _home, _parent

pytest_plugins = ["tests.tools.test_delegation_backends"]

OLD_URL = "http://127.0.0.1:9/v1"
FAST = {"name": "fast", "description": "quick", "provider": "custom", "model": "old-model", "base_url": OLD_URL,
        "api_key": "old-endpoint-secret", "api_mode": "anthropic_messages",
        "request_overrides": {"extra_body": {"endpoint": "old"}}}
DEEP = {"name": "deep", "description": "careful", "provider": "custom", "model": "deep-model",
        "base_url": "http://127.0.0.1:8/v1"}


@pytest.fixture
def runtime(monkeypatch):
    """The provider system's answer for a named provider (no network, no credentials read)."""
    calls = []

    def resolve(requested=None, target_model=None, **_):
        calls.append(requested)
        return {"provider": requested, "base_url": f"https://{requested}.example/v1", "api_key": "provider-key",
                "api_mode": "chat_completions"}
    monkeypatch.setattr("hermes_cli.runtime_provider.resolve_runtime_provider", resolve)
    return calls


def _editor_pick(effective, provider, model):
    """What the typing-bar editor sends: the chat's settings with the selected named route edited."""
    sent = copy.deepcopy(effective)
    block = sent["backends"]["probe-options"]
    block["options"] = [{**r, "provider": provider, "model": model} if r["name"] == "fast" else r
                        for r in block["options"]]
    return sent


def _route(db, sid, name):
    from agent.delegation_credentials import resolve
    from agent.delegation_settings import runtime_projection
    state = db.get_session_model_config_value(sid, "_delegation_settings")
    options = resolve(runtime_projection(state["effective"]))["backends"]["probe-options"]["options"]
    return next(r for r in options if r["name"] == name)


def test_named_route_provider_change_drops_the_old_endpoint_and_key(tmp_path, monkeypatch, runtime):
    from agent.delegation_settings import settings_for_session, update_settings
    from hermes_state import SessionDB
    from tools.delegate_tool import _resolve_delegation_credentials

    home, manager = _home(tmp_path, monkeypatch, {"backend": "probe-options", "backends": {
        "probe-options": {"default": "fast", "options": [FAST, DEEP]}}})
    try:
        with SessionDB(db_path=home / "state.db") as db:
            db.ensure_session("chat", source="gui")
            effective = settings_for_session(db, "chat")["effective"]
            assert effective["backends"]["probe-options"]["options"][0]["base_url"] == OLD_URL
            update_settings(db, "chat", override=_editor_pick(effective, "openrouter", "new-model"))
            fast = _route(db, "chat", "fast")
            for stale in ("base_url", "api_key", "api_mode", "request_overrides"):
                assert stale not in fast, fast
            creds = _resolve_delegation_credentials(fast, _parent("chat"))
            assert (creds["provider"], creds["base_url"], creds["model"]) == (
                "openrouter", "https://openrouter.example/v1", "new-model")
            assert creds["api_key"] == "provider-key" and runtime == ["openrouter"]
            # The untouched sibling keeps its endpoint, and the reread chat settings stay clean.
            assert _route(db, "chat", "deep")["base_url"] == "http://127.0.0.1:8/v1"
            reread = settings_for_session(db, "chat")["override"]["backends"]["probe-options"]["options"][0]
            assert "base_url" not in reread and "api_mode" not in reread
            # A second edit from the reread settings is stable (no stale transport comes back).
            again = settings_for_session(db, "chat")["effective"]
            update_settings(db, "chat", override=_editor_pick(again, "anthropic", "newer-model"))
            assert "base_url" not in _route(db, "chat", "fast")
    finally:
        manager.unload()


def test_named_route_keeps_a_newly_supplied_endpoint(tmp_path, monkeypatch, runtime):
    from agent.delegation_settings import settings_for_session, update_settings
    from hermes_state import SessionDB

    home, manager = _home(tmp_path, monkeypatch, {"backend": "probe-options", "backends": {
        "probe-options": {"options": [FAST]}}})
    try:
        with SessionDB(db_path=home / "state.db") as db:
            db.ensure_session("chat", source="gui")
            sent = _editor_pick(settings_for_session(db, "chat")["effective"], "openrouter", "m")
            sent["backends"]["probe-options"]["options"][0]["base_url"] = "https://proxy.example/v1"
            update_settings(db, "chat", override=sent)
            assert _route(db, "chat", "fast")["base_url"] == "https://proxy.example/v1"
            assert "api_key" not in _route(db, "chat", "fast")  # the old endpoint's key never follows
    finally:
        manager.unload()


def test_named_route_inherit_without_an_endpoint_is_refused(tmp_path, monkeypatch):
    from agent.delegation_settings import settings_for_session, update_settings
    from hermes_state import SessionDB

    home, manager = _home(tmp_path, monkeypatch, {"backend": "probe-options", "backends": {
        "probe-options": {"options": [FAST]}}})
    try:
        with SessionDB(db_path=home / "state.db") as db:
            db.ensure_session("chat", source="gui")
            before = settings_for_session(db, "chat")
            with pytest.raises(ValueError, match="provider or base_url"):
                update_settings(db, "chat", override=_editor_pick(before["effective"], "", "m"))
            assert settings_for_session(db, "chat") == before
    finally:
        manager.unload()


def test_top_level_endpoint_to_provider_and_inherit(tmp_path, monkeypatch, runtime):
    from agent.delegation_settings import update_settings
    from hermes_state import SessionDB
    from tools.delegate_tool import _resolve_delegation_credentials

    home, manager = _home(tmp_path, monkeypatch, {"provider": "custom", "model": "old-model", "base_url": OLD_URL,
                                                  "api_key": "old-endpoint-secret"}, plugins=())
    try:
        with SessionDB(db_path=home / "state.db") as db:
            for sid, provider in (("named", "openrouter"), ("inherit", "")):
                db.ensure_session(sid, source="gui")
                update_settings(db, sid, override={"provider": provider, "model": "new-model"})
                state = db.get_session_model_config_value(sid, "_delegation_settings")["effective"]
                assert "base_url" not in state and "_credential_refs" not in state
                creds = _resolve_delegation_credentials(state, _parent(sid))
                assert creds["base_url"] == ("https://openrouter.example/v1" if provider else None)
                assert creds["api_key"] != "old-endpoint-secret"
    finally:
        manager.unload()
