"""Per-chat delegation policy, shared by tool construction and every spawn.

The tools[] pin carries the policy it describes. Explicit chat settings are stored separately in
model_config so a mid-turn write cannot be lost when the old tool snapshot is persisted. Threads
inherit a detached call snapshot; a running child never consults its parent's new settings.
"""

from __future__ import annotations

import copy
import json
import os
import sys
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps

_KEY = "_delegation_settings"
_SCOPED: ContextVar[dict | None] = ContextVar("delegation_settings", default=None)
_EDITABLE = frozenset({"backend", "model", "provider", "reasoning_effort", "max_spawn_depth",
                       "max_concurrent_children", "backends"})
_BASE = {"backend": "default", "model": "", "provider": "", "reasoning_effort": "",
         "max_spawn_depth": 1, "max_concurrent_children": 10, "backends": {}}
_MISSING = object()


def current_settings():
    return _SCOPED.get()


@contextmanager
def settings_scope(config):
    token = _SCOPED.set(copy.deepcopy(config))
    try:
        yield
    finally:
        _SCOPED.reset(token)


def settings_cache_key():
    config = current_settings()
    return json.dumps(config, sort_keys=True, separators=(",", ":")) if config is not None else None


def user_config_ignored(session_flag=None):
    """Whether this chat ignores user config (``--ignore-user-config`` / safe mode).

    A gateway serves ordinary and bypass chats in one process, so the process flag alone cannot
    decide: a caller that knows the session passes its frozen flag, and an in-process turn's own
    launch policy decides otherwise. The CLI flag (``HERMES_IGNORE_USER_CONFIG=1``) always wins."""
    if os.environ.get("HERMES_IGNORE_USER_CONFIG") == "1":
        return True
    if session_flag is not None:
        return bool(session_flag)
    if "gateway.session_policy" in sys.modules:  # no turn policy can be active before it is imported
        from gateway.session_policy import active_policy
        return bool(getattr(active_policy(), "ignore_user_config", False))
    return False


def profile_defaults(ignore_user_config=None):
    from agent.delegation_credentials import protect
    from tools.delegate_tool_config import _load_config
    if user_config_ignored(ignore_user_config) and os.environ.get("HERMES_IGNORE_USER_CONFIG") != "1":
        return protect(copy.deepcopy(_BASE))  # built-in defaults; the profile's config.yaml is never read
    with settings_scope(None):
        return protect({**_BASE, **_load_config()})


def runtime_projection(config):
    config = copy.deepcopy(config)
    backend = config.get("backend") or "default"
    block = (config.get("backends") or {}).get(backend)
    # Inactive backend / preset libraries are never part of the conversation's durable pin.
    config["backends"] = {backend: {k: v for k, v in block.items() if k not in {"presets", "active_preset"}}} \
        if isinstance(block, dict) else {}
    from agent.delegation_credentials import protect
    return protect(config)


def _public(config):
    return {k: _without_secrets(copy.deepcopy(config.get(k, _BASE[k])), (k,)) for k in _EDITABLE}


def _without_secrets(value, path=()):
    from agent.delegation_credentials import is_credential
    if isinstance(value, dict):
        return {k: _without_secrets(v, (*path, k)) for k, v in value.items()
                if not is_credential(k, path) and k != "presets"}
    return [_without_secrets(v, path) for v in value] if isinstance(value, list) else value


def _validate_value(value, path=()):
    from agent.delegation_credentials import is_credential
    where = ".".join(map(str, path)) or "settings"
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or is_credential(key, path) or any(
                    part in key.lower() for part in ("command", "presets")):
                raise ValueError(f"{where}: credentials (including request headers), commands and preset libraries "
                                 "are not subagent settings; keep them in the profile config.")
            _validate_value(item, (*path, key))
    elif isinstance(value, list):
        for item in value:
            _validate_value(item, path)
    elif value is not None and not isinstance(value, (str, bool, int, float)):
        raise ValueError(f"{where}: settings must be JSON values.")
    if path[-1:] == ("reasoning_effort",) and value not in (None, ""):
        from hermes_constants import parse_reasoning_effort
        if parse_reasoning_effort(value) is None:
            raise ValueError(f"{where}: unknown reasoning effort.")


_ROUTE_STRINGS = frozenset({"name", "description", "model", "provider", "base_url", "api_mode", "reasoning_effort",
                            "service_tier", "profile", "label", "default"})
_ROUTE_TYPES = {"request_overrides": (dict, "an object"), "fallback_providers": (list, "a list")}


def _validate_route_fields(route, path):
    """Known route keys must have the type the resolver reads; other keys are provider extensions
    and stay as authored JSON (never coerced into a model/provider string)."""
    for key, value in route.items():
        if value is None:
            continue
        if key in _ROUTE_STRINGS and not isinstance(value, str):
            raise ValueError(f"{path}.{key} must be a string.")
        if key in _ROUTE_TYPES and not isinstance(value, _ROUTE_TYPES[key][0]):
            raise ValueError(f"{path}.{key} must be {_ROUTE_TYPES[key][1]}.")


def _validate_backend_blocks(backends):
    for backend, block in backends.items():
        _validate_route_fields({k: v for k, v in block.items() if k not in {"options", "profiles"}},
                               f"backends.{backend}")
        for collection in ("options", "profiles"):
            if collection not in block:
                continue
            entries = block[collection]
            if not isinstance(entries, list) or any(not isinstance(e, dict) for e in entries):
                raise ValueError(f"backends.{backend}.{collection} must be a list of route objects.")
            names = []
            for entry in entries:
                _validate_route_fields(entry, f"backends.{backend}.{collection}")
                name = entry.get("name")
                if not isinstance(name, str) or not name.strip() or name in names:
                    raise ValueError(f"backends.{backend}.{collection} needs unique, nonempty route names.")
                names.append(name)
                if collection == "options" and (not entry.get("model") or not entry.get("description")
                                                 or not (entry.get("provider") or entry.get("base_url"))):
                    raise ValueError(f"Route {name!r} needs description, model and provider or base_url.")
            if block.get("default") not in (None, "") and block["default"] not in names:
                raise ValueError(f"backends.{backend}.default is not a configured route.")


def validate_override(override):
    from agent.delegation_backends import list_backends
    from hermes_cli.plugins import discover_plugins

    override = validate_fields(override)
    if "backend" in override:
        discover_plugins()
        available = {b.name for b in list_backends() if b.available}
        if override["backend"] not in available:
            raise ValueError(f"Subagent backend {override['backend']!r} is not available.")
    return override


def validate_fields(override):
    """Shape and type checks that need no plugin discovery (also the preset library's entry check)."""
    from hermes_constants import parse_reasoning_effort

    if not isinstance(override, dict) or set(override) - _EDITABLE:
        raise ValueError("Unknown subagent setting; use backend, model, provider, reasoning_effort, depth, concurrency or backends.")
    for key in ("max_spawn_depth", "max_concurrent_children"):
        if key in override and (type(override[key]) is not int or override[key] < 1):
            raise ValueError(f"{key} must be a positive integer.")
    for key in ("backend", "model", "provider"):
        if key in override and not isinstance(override[key], str):
            raise ValueError(f"{key} must be a string.")
    if "reasoning_effort" in override:
        effort = override["reasoning_effort"]
        if effort != "" and (not isinstance(effort, (str, bool)) or parse_reasoning_effort(effort) is None):
            raise ValueError("Unknown subagent reasoning_effort.")
    if "backends" in override and (not isinstance(override["backends"], dict)
                                   or any(not isinstance(v, dict) for v in override["backends"].values())):
        raise ValueError("backends must map backend names to settings objects.")
    _validate_value(override)
    _validate_backend_blocks(override.get("backends", {}))
    if len(json.dumps(override, allow_nan=False)) > 262144:
        raise ValueError("Subagent settings are too large (maximum 256 KiB).")
    return copy.deepcopy(override)


def _stored(db, session_id):
    if not db or not session_id:
        return None
    # Relay can invoke the spawn callback on its private loop. A worker's store reads are
    # synchronous owner RPCs, so use the same context-preserving hop as child construction.
    from agent.runtime_session_store import call_off_event_loop
    return call_off_event_loop(db.get_session_model_config_value, session_id, _KEY)


def _pinned_settings(db, session_id):
    pin = (db.get_session(session_id) or {}).get("tool_names") if db and session_id else None
    if isinstance(pin, str):
        pin = json.loads(pin)
    return pin if isinstance(pin, dict) else {}


def _pinned_config(db, session_id):
    return _pinned_settings(db, session_id).get("delegation_config")


def initialize_settings(agent, session_id, db, *, ignore_user_config=None):
    """Seed the chat's policy. True when it starts from the profile defaults (a new, unpinned chat)."""
    inherited = current_settings()
    agent._delegation_preset_name = None
    state = _stored(db, session_id)
    pin = _pinned_settings(db, session_id)
    pinned = pin.get("delegation_config")
    if inherited is not None:
        config = inherited
    elif isinstance(pinned, dict):
        config = pinned
    elif isinstance(pin.get("delegation_backend"), str) and pin["delegation_backend"]:
        # Pre-policy pins stored only the backend. Its historical routes cannot be recovered,
        # but it still owns the restored tools until an explicit pending edit reaches turn entry.
        config = profile_defaults(ignore_user_config)
        config["backend"] = pin["delegation_backend"]
    elif isinstance(state, dict):
        config = state["effective"]
        agent._delegation_preset_name = state.get("preset_name")
    else:
        config = profile_defaults(ignore_user_config)
    agent._delegation_config = runtime_projection(config)
    agent._delegation_backend = agent._delegation_config.get("backend", "default")
    return inherited is None and not pin and not isinstance(state, dict)


def load_tools_with_policy(agent, session_id, db, load_tools):
    """Build the chat's tools under its policy. A new chat that actually offers ``delegate_task`` starts
    from the profile's default subagent preset, if one is set; otherwise the optional library is never read."""
    from_defaults = initialize_settings(agent, session_id, db)
    with settings_scope(agent._delegation_config):
        load_tools()
    if not from_defaults or "delegate_task" not in (getattr(agent, "valid_tool_names", None) or ()):
        return
    config, name = default_preset_config()
    if name is None:
        return
    agent._delegation_preset_name = name
    config = runtime_projection(config)
    if config == agent._delegation_config:
        return
    agent._delegation_config, agent._delegation_backend = config, config.get("backend", "default")
    quiet = getattr(agent, "quiet_mode", True)
    agent.quiet_mode = True  # the tool list was already reported once
    try:
        with settings_scope(config):
            load_tools()
    finally:
        agent.quiet_mode = quiet


def default_preset_config(ignore_user_config=None):
    """``(settings, name)`` a new chat starts from: the profile default preset's captured snapshot, or the
    plain profile defaults with no name. Never raises; bypass chats and safe workers never read the library."""
    defaults = profile_defaults(ignore_user_config)
    if user_config_ignored(ignore_user_config):
        return defaults, None
    from agent.subagent_presets import default_preset
    name, preset = default_preset()
    return ({**defaults, **preset}, name) if preset else (defaults, None)


def settings_for_session(db=None, session_id="", agent=None, *, ignore_user_config=None):
    from agent.delegation_backends import list_backends
    from hermes_cli.plugins import discover_plugins

    defaults = profile_defaults(ignore_user_config)
    state = _stored(db, session_id)
    effective = state["effective"] if isinstance(state, dict) else (
        getattr(agent, "_delegation_config", None) or _pinned_config(db, session_id) or defaults)
    discover_plugins()
    from tools.delegate_tool_routes import schema_extension
    active = getattr(agent, "_delegation_config", None) or _pinned_config(db, session_id)
    pending = isinstance(active, dict) and schema_extension(active) != schema_extension(effective)
    override = state.get("override") if state else None
    # Writes refuse credentials; the read projection applies the same classifier as a second boundary.
    public_override = {k: _without_secrets(v, (k,)) for k, v in override.items() if k in _EDITABLE} \
        if override is not None else None
    preset_name = state.get("preset_name") if state else getattr(agent, "_delegation_preset_name", None)
    return {"pending_schema": pending, "override": public_override,
            "effective": _public(effective), "defaults": _public(defaults),
            "available_backends": [b.name for b in list_backends() if b.available],
            "preset_name": preset_name if isinstance(preset_name, str) else None}


def update_settings(db, session_id, *, override=_MISSING, ignore_user_config=None):
    if not db or not db.get_session(session_id):
        raise ValueError("Session is not persisted.")
    defaults = profile_defaults(ignore_user_config)
    if override is not _MISSING and override is not None:
        from agent.delegation_credentials import normalize_override
        current = _stored(db, session_id)
        previous = current.get("effective") if isinstance(current, dict) else _pinned_config(db, session_id)
        # Normalize before validating: a provider change must not keep the old endpoint, and a named
        # route left with neither provider nor endpoint is refused rather than silently inherited.
        override = validate_override(normalize_override(override, defaults, *([previous] if previous else [])))
    elif override is _MISSING:
        raise ValueError("A settings write needs override.")
    from agent.delegation_credentials import merge_settings
    state = {"override": override, "effective": runtime_projection(merge_settings(defaults, override))}
    db.patch_session_model_config(session_id, {_KEY: state})
    return settings_for_session(db, session_id, ignore_user_config=ignore_user_config)


def apply_settings_at_turn(agent):
    if getattr(agent, "_delegate_depth", 0) or getattr(agent, "_turn_origin", None):
        return False
    db, sid = getattr(agent, "_session_db", None), getattr(agent, "session_id", "")
    state = _stored(db, sid)
    if not isinstance(state, dict):
        return False
    config = runtime_projection(state["effective"])
    if config == getattr(agent, "_delegation_config", None):
        return False
    from tools.mcp_tool_agent import persist_agent_tool_names, refresh_agent_mcp_tools
    before = copy.deepcopy(agent.tools)
    with settings_scope(config):
        refresh_agent_mcp_tools(agent, quiet_mode=True, content_aware=True)
    agent._delegation_config, agent._delegation_backend = config, config["backend"]
    agent._delegation_preset_name = state.get("preset_name")
    persist_agent_tool_names(agent)  # route-only edits also survive eviction/restart
    changed = before != agent.tools
    if changed:
        from hermes_cli.observability.shared_metrics_efficiency import record_cache_break
        record_cache_break(agent, "toolset_change")
    return changed


def commit_global_switch(agent, config):
    """An explicit /delegation --now supersedes any older pending chat selection too."""
    agent._delegation_preset_name = None
    db, sid = getattr(agent, "_session_db", None), getattr(agent, "session_id", "")
    if db and sid:
        db.patch_session_model_config(sid, {_KEY: {"override": None,
                                                 "effective": runtime_projection(config)}})


def scoped_refresh(fn):
    @wraps(fn)
    def refresh(agent, *args, **kwargs):
        config = current_settings()
        if config is None:
            config = getattr(agent, "_delegation_config", None)
        with settings_scope(config):
            return fn(agent, *args, **kwargs)
    return refresh


def scoped_spawn(fn):
    @wraps(fn)
    def call(*args, **kwargs):
        parent = kwargs.get("parent_agent")
        config = getattr(parent, "_delegation_config", None)
        if not isinstance(config, dict):
            return fn(*args, **kwargs)  # lifecycle/internal callers with no tools pin keep their existing behavior
        if not getattr(parent, "_delegate_depth", 0):
            state = _stored(getattr(parent, "_session_db", None), getattr(parent, "session_id", ""))
            if isinstance(state, dict):
                from tools.delegate_tool_routes import schema_extension
                desired = runtime_projection(state["effective"])
                # Routes, effort and limits apply at the NEXT spawn, including in a running turn. A changed
                # per-task parameter contract waits for the explicit tools rebuild at the next turn boundary.
                if schema_extension(config) == schema_extension(desired):
                    config = desired
        from agent.delegation_credentials import resolve
        try:
            materialized = resolve(config)
        except ValueError as exc:
            from tools.registry import tool_error
            return tool_error(str(exc))
        with settings_scope(materialized):
            return fn(*args, **kwargs)
    return call
