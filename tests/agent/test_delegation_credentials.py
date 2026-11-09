"""Snapshots keep secure references, never copies of profile authentication material."""

import json
from types import SimpleNamespace

import pytest

from tests.tools.test_delegation_backends import _definition, _home, _parent

pytest_plugins = ["tests.tools.test_delegation_backends"]


def test_credentials_are_resolved_for_spawn_but_never_persisted(tmp_path, monkeypatch, recorded):
    from agent.delegation_settings import initialize_settings, settings_for_session, update_settings
    from hermes_state import SessionDB
    from tools.delegate_tool import delegate_task
    from tools.mcp_tool_agent import persist_agent_tool_names

    marker = "test-only-secret-value"
    home, manager = _home(tmp_path, monkeypatch, {"model": "child-model", "api_key": marker,
                                                "base_url": "http://127.0.0.1:9/v1"})
    with SessionDB(db_path=home / "state.db") as db:
        try:
            db.ensure_session("secret-chat", source="gui")
            update_settings(db, "secret-chat", override={"model": "pinned-child"})
            parent = _parent("secret-chat")
            parent._session_db = db
            initialize_settings(parent, parent.session_id, db)
            parent.tools = [{"type": "function", "function": _definition()}]
            persist_agent_tool_names(parent)
            result = json.loads(delegate_task(goal="Use owning profile credentials", parent_agent=parent))
            assert result["results"][0]["status"] == "completed", result
            assert recorded[-1]["override_api_key"] == marker
            row = db.get_session("secret-chat")
            assert marker not in json.dumps(row)
            public = settings_for_session(db, "secret-chat", parent)
            assert marker not in json.dumps(public) and "_credential_home" not in json.dumps(public)
        finally:
            manager.unload()


def test_named_route_credential_references_follow_names_not_list_indexes(tmp_path, monkeypatch):
    import hermes_yaml as yaml
    from agent.delegation_credentials import protect, resolve
    from hermes_cli.config import atomic_config_write

    config = {"backend": "default", "backends": {"model_map": {"options": [
        {"name": "fast", "provider": "custom", "base_url": "http://127.0.0.1:9/v1", "api_key": "fast-secret"},
        {"name": "deep", "provider": "custom", "base_url": "http://127.0.0.1:8/v1", "api_key": "deep-secret"}]}}}
    home, manager = _home(tmp_path, monkeypatch, config)
    try:
        snapshot = protect(config)
        config["backends"]["model_map"]["options"].reverse()
        config["backends"]["model_map"]["options"][1]["api_key"] = "rotated-secret"
        raw = yaml.safe_load((home / "config.yaml").read_text())
        raw["delegation"] = config
        atomic_config_write(home / "config.yaml", raw)
        resolved = resolve(snapshot)
        assert resolved["backends"]["model_map"]["options"][0]["api_key"] == "rotated-secret"
        assert resolved["backends"]["model_map"]["options"][1]["api_key"] == "deep-secret"
        assert "secret" not in json.dumps(snapshot)
    finally:
        manager.unload()


_FALLBACKS = [
    {"provider": "custom", "model": "fallback-a", "base_url": "http://127.0.0.1:8/v1", "api_key": "a-secret"},
    {"provider": "custom", "model": "fallback-b", "base_url": "http://127.0.0.1:7/v1", "api_key": "b-secret"}]
_PRIMARY = {"model": "primary", "provider": "custom", "base_url": "http://127.0.0.1:9/v1", "api_key": "primary-secret"}


def _edit_profile(home, edit):
    from hermes_cli.config import atomic_config_write, read_user_config_raw
    raw = read_user_config_raw(home / "config.yaml")
    edit(raw["delegation"])
    atomic_config_write(home / "config.yaml", raw)


def _fallback_pairs(materialized):
    from tools.delegate_tool_config import _resolve_child_fallback_chain
    chain = _resolve_child_fallback_chain(SimpleNamespace(_fallback_chain=None), materialized, pinned=True)
    return [(entry["base_url"], entry["api_key"]) for entry in chain]


def _move_endpoint(delegation):
    delegation["fallback_providers"][0].update(base_url="http://127.0.0.1:6/v1", api_key="new-endpoint-secret")


def _change_provider(delegation):
    delegation["fallback_providers"][0].update(provider="openrouter", api_key="other-provider-secret")


def _remove_entry(delegation):
    del delegation["fallback_providers"][0]


def _move_backend_block(delegation):
    delegation["backends"]["default"].update(base_url="http://127.0.0.1:5/v1", api_key="new-block-secret")


@pytest.mark.parametrize("edit", [_move_endpoint, _change_provider, _remove_entry, _move_backend_block],
                         ids=["fallback-endpoint", "fallback-provider", "fallback-removed", "backend-block-endpoint"])
def test_unnamed_route_credential_never_moves_to_a_replaced_endpoint(tmp_path, monkeypatch, edit):
    """An unnamed fallback entry or backend block owns its own credential: editing only that route's endpoint or
    provider in the profile refuses the frozen snapshot instead of sending the new key to the old endpoint."""
    from agent.delegation_credentials import protect, resolve

    config = {**_PRIMARY, "fallback_providers": [dict(e) for e in _FALLBACKS], "backend": "default", "backends": {
        "default": {"provider": "custom", "base_url": "http://127.0.0.1:4/v1", "api_key": "block-secret"}}}
    home, manager = _home(tmp_path, monkeypatch, config, plugins=())
    try:
        snapshot = protect(config)
        assert "secret" not in json.dumps({k: v for k, v in snapshot.items() if k != "_credential_refs"})
        _edit_profile(home, edit)
        with pytest.raises(ValueError, match="endpoint/provider changed"):
            resolve(snapshot)
    finally:
        manager.unload()


def test_fallback_credentials_follow_their_endpoint_through_reorder_and_key_rotation(tmp_path, monkeypatch):
    from agent.delegation_credentials import protect, resolve

    config = {**_PRIMARY, "fallback_providers": [dict(e) for e in _FALLBACKS]}
    home, manager = _home(tmp_path, monkeypatch, config, plugins=())
    try:
        snapshot = protect(config)
        assert _fallback_pairs(resolve(snapshot)) == [("http://127.0.0.1:8/v1", "a-secret"),
                                                      ("http://127.0.0.1:7/v1", "b-secret")]

        def reorder_and_rotate(delegation):
            delegation["fallback_providers"].reverse()
            delegation["fallback_providers"][0]["api_key"] = "b-rotated"  # same endpoint, new key
            delegation["base_url"] = "http://127.0.0.1:3/v1"  # the primary's own edit is not the fallback's

        _edit_profile(home, reorder_and_rotate)
        with pytest.raises(ValueError):
            resolve(snapshot)  # the primary route itself moved
        _edit_profile(home, lambda d: d.update(base_url=_PRIMARY["base_url"]))
        # Each frozen endpoint keeps its own (current) key, in the snapshot's order.
        assert _fallback_pairs(resolve(snapshot)) == [("http://127.0.0.1:8/v1", "a-secret"),
                                                      ("http://127.0.0.1:7/v1", "b-rotated")]
    finally:
        manager.unload()


@pytest.mark.parametrize("key,path,secret", [
    ("Authorization", ("extra_headers",), True), ("AUTHORIZATION", (), True), ("proxy-authorization", (), True),
    ("X-API-Key", (), True), ("x_api_key", (), True), ("Api-Key", (), True), ("access-token", (), True),
    ("client_secret", (), True), ("Cookie", (), True), ("X-Title", ("request_overrides", "extra_headers"), True),
    ("max_tokens", (), False), ("token_budget", (), False), ("temperature", ("extra_body",), False),
    ("model", (), False), ("base_url", (), False)])
def test_one_credential_classifier_ignores_case_and_separators(key, path, secret):
    from agent.delegation_credentials import is_credential
    assert is_credential(key, path) is secret
