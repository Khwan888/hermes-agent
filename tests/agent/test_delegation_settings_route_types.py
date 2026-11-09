"""Named routes are field-typed before anything is persisted."""

import json

import pytest

from tests.tools.test_delegation_backends import _home

pytest_plugins = ["tests.tools.test_delegation_backends"]

ROUTE = {"name": "fast", "description": "quick", "model": "fast-model", "provider": "openrouter"}


def _options(**fields):
    return {"backends": {"probe-options": {"options": [{**ROUTE, **fields}]}}}


MALFORMED = {
    "object-model": _options(model={"id": "fast-model"}),
    "list-provider": _options(provider=["openrouter"]),
    "number-base-url": _options(base_url=9),
    "list-description": _options(description=["quick"]),
    "number-api-mode": _options(api_mode=1),
    "string-request-overrides": _options(request_overrides="temperature=0"),
    "string-fallback-providers": _options(fallback_providers="openrouter"),
    "object-label": _options(label={"text": "fast"}),
    "number-profile": {"backends": {"probe-options": {"profiles": [{"name": "work", "profile": 7}]}}},
    "number-default": {"backends": {"probe-options": {"default": 3, "options": [ROUTE]}}},
}


@pytest.mark.parametrize("override", MALFORMED.values(), ids=MALFORMED)
def test_malformed_nested_route_is_refused_without_a_write(tmp_path, monkeypatch, override):
    from agent.delegation_settings import settings_for_session, update_settings
    from hermes_state import SessionDB

    home, manager = _home(tmp_path, monkeypatch, {})
    with SessionDB(db_path=home / "state.db") as db:
        db.ensure_session("chat", source="gui")
        before = settings_for_session(db, "chat")
        with pytest.raises(ValueError):
            update_settings(db, "chat", override=override)
        assert settings_for_session(db, "chat") == before
        assert db.get_session_model_config_value("chat", "_delegation_settings") is None
    manager.unload()


def test_provider_extension_keys_are_kept_as_authored(tmp_path, monkeypatch):
    from agent.delegation_settings import update_settings
    from hermes_state import SessionDB

    home, manager = _home(tmp_path, monkeypatch, {})
    extension = {"x_vendor_hints": {"tier": "batch", "weights": [1, 2]}, "priority": 2}
    with SessionDB(db_path=home / "state.db") as db:
        db.ensure_session("chat", source="gui")
        update_settings(db, "chat", override={"backend": "probe-options", **_options(
            **extension, request_overrides={"temperature": 0}, fallback_providers=[], service_tier="")})
        stored = db.get_session_model_config_value("chat", "_delegation_settings")
    route = stored["effective"]["backends"]["probe-options"]["options"][0]
    assert {k: route[k] for k in extension} == extension
    assert json.dumps(route["model"]) == '"fast-model"'
    manager.unload()
