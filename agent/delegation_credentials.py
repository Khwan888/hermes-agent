"""Credential-free delegation snapshots with owner-scoped, fail-closed secret references."""

from __future__ import annotations

import copy
import re
from itertools import pairwise


_CREDENTIAL_WORDS = frozenset({"secret", "secrets", "password", "passwd", "passphrase", "authorization",
                               "cookie", "credential", "credentials", "apikey", "bearer"})
_KEY_QUALIFIERS = frozenset({"api", "access", "private", "secret", "signing", "session", "auth"})
_HEADER_MAPS = frozenset({"headers", "extra_headers", "default_headers", "http_headers"})


def is_credential(key, path=()):
    """The one credential test for settings writes, durable snapshots and public projections.

    Case, ``-`` and ``_`` do not matter (``Authorization``, ``X-API-Key``, ``access_token``). Every value inside a
    request-header map counts: a header carries authentication as often as not. ``max_tokens`` or ``token_budget`` do not."""
    words = [w for w in re.split(r"[^a-z0-9]+", str(key).lower()) if w]
    if any(w in _CREDENTIAL_WORDS for w in words) or words[-1:] == ["token"]:
        return True
    if any(a in _KEY_QUALIFIERS and b == "key" for a, b in pairwise(words)):
        return True
    return any(isinstance(part, str) and part.lower().replace("-", "_") in _HEADER_MAPS for part in path)


_TRANSPORT = ("base_url", "api_key", "api_mode", "command", "args", "request_overrides")


def _provider(route):
    return str(route.get("provider") or "").strip().lower()


def normalize_override(override, *sources):
    """A named route whose provider changed keeps only the transport supplied WITH the new provider.

    Editors send whole route objects, so a carried-over endpoint/API mode/command/request override
    is the value the same-named route had in a source (profile defaults or the chat's current
    settings) whose provider differs; such a value, and any credential reference, is dropped. A
    newly typed endpoint is kept. Same rule as the top level, where transport keys never travel in
    an override and are dropped on a provider change (``merge_settings``)."""
    if not isinstance(override, dict) or not isinstance(override.get("backends"), dict):
        return override
    result = copy.deepcopy(override)
    for backend, block in result["backends"].items():
        for collection in ("options", "profiles"):
            entries = block.get(collection) if isinstance(block, dict) else None
            if not isinstance(entries, list):
                continue
            for i, route in enumerate(entries):
                if not isinstance(route, dict):
                    continue
                stale = set()
                for source in sources:
                    old = _named(source, backend, collection, route.get("name"))
                    if old is not None and _provider(old) != _provider(route):
                        stale |= {k for k in _TRANSPORT if k in route and route[k] == old.get(k)}
                if stale:
                    entries[i] = {k: v for k, v in route.items() if k not in stale and not k.startswith("_credential_")}
    return result


def _named(config, backend, collection, name):
    try:
        entries = config["backends"][backend][collection]
    except (KeyError, TypeError):
        return None
    return next((r for r in entries if isinstance(r, dict) and name and r.get("name") == name), None) \
        if isinstance(entries, list) else None


def merge_settings(defaults, override, previous=None):
    override = normalize_override(override, defaults, *([previous] if previous else []))
    result = {**defaults, **(override or {})}
    if override and "provider" in override and override["provider"] != defaults.get("provider", ""):
        for key in _TRANSPORT:
            if key not in override:
                result.pop(key, None)
    return result


_IDENTITY = ("provider", "base_url")


def _identity(route):
    return {k: route.get(k) or "" for k in _IDENTITY}


def _has_identity(value):
    return any(isinstance(value.get(k), str) for k in _IDENTITY)


def _is_route(value, target):
    """A dict that owns its credentials: the top level, a backend block, a named route, or any entry with its own
    provider/endpoint (an unnamed ``fallback_providers`` entry). Its credentials bind to ITS endpoint."""
    return not target or "name" in value or _has_identity(value) or (len(target) == 2 and target[0] == "backends")


def _selector(entries, i):
    """How a credential source finds list entry ``i`` again in the live profile. Named entries by name; an
    unnamed route by its provider/endpoint (the nth such entry), never by a list index that a reorder or an
    edited endpoint would silently point at another route."""
    entry = entries[i]
    if not isinstance(entry, dict):
        return i
    if entry.get("name"):
        return {"name": entry["name"]}
    if _has_identity(entry):
        match = _identity(entry)
        nth = sum(1 for e in entries[:i] if isinstance(e, dict) and not e.get("name") and _identity(e) == match)
        return {"match": match, "nth": nth}
    return i


def protect(config):
    from hermes_constants import get_hermes_home

    config = copy.deepcopy(config)
    refs = copy.deepcopy(config.pop("_credential_refs", []))
    kept = []
    for ref in refs:
        try:
            route = _lookup(config, ref["route"])
            _lookup(config, ref["target"][:-1])
            if _identity(route) == ref["identity"]:
                kept.append(ref)
        except (KeyError, IndexError, StopIteration, TypeError):
            continue  # a user-selected replacement route no longer owns the old credential source
    refs = kept
    home = config.get("_credential_home") or str(get_hermes_home())

    def walk(value, target, source, route, identity):
        if isinstance(value, list):
            for i, entry in enumerate(value):
                selector = _selector(value, i)
                walk(entry, [*target, selector], [*source, selector], route, identity)
        elif isinstance(value, dict):
            if _is_route(value, target):
                route, identity = source, _identity(value)
            for key in list(value):
                if key.startswith("_credential_"):
                    continue
                if is_credential(key, target) and value[key]:
                    path = [*target, key]
                    if not any(ref["target"] == path for ref in refs):
                        refs.append({"target": path, "source": [*source, key], "route": route, "identity": identity})
                    del value[key]
                else:
                    walk(value[key], [*target, key], [*source, key], route, identity)
    walk(config, [], [], [], {})
    if refs:
        config["_credential_refs"], config["_credential_home"] = refs, home
    return config


def _lookup(value, path):
    for part in path:
        if isinstance(part, dict) and "match" in part:
            found = [e for e in value if isinstance(e, dict) and not e.get("name") and _identity(e) == part["match"]]
            value = found[part.get("nth", 0)] if part.get("nth", 0) < len(found) else None
        elif isinstance(part, dict):
            value = next((entry for entry in value if isinstance(entry, dict) and entry.get("name") == part["name"]), None)
        else:
            value = value[part]
        if value is None:
            raise KeyError("missing credential source")
    return value


def resolve(config):
    """Materialize secrets only for this spawn; never attach this value to an agent or DB row."""
    refs = config.get("_credential_refs")
    if not refs:
        return config
    from agent.delegation_settings import settings_scope
    from tools.delegate_tool_config import _load_config
    from tools.delegate_tool_routes import delegated_profile_scope

    with delegated_profile_scope(config["_credential_home"]), settings_scope(None):
        source = _load_config()
    result = copy.deepcopy(config)
    for ref in refs:
        try:
            route = _lookup(source, ref["route"])
            if _identity(route) != ref["identity"]:
                raise KeyError("credential route changed")
            secret = _lookup(source, ref["source"])
            if not secret:
                raise KeyError("credential source empty")
            target = _lookup(result, ref["target"][:-1])
            target[ref["target"][-1]] = secret
        except (KeyError, IndexError, StopIteration, TypeError) as exc:
            raise ValueError("The pinned subagent credential source was removed or its endpoint/provider changed. "
                             "Re-select subagent settings to capture the new route.") from exc
    return result
