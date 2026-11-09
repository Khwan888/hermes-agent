"""Authenticated per-conversation subagent settings and the profile's preset library.
No legacy gateway or plugin imports."""

import asyncio
from functools import partial

from hermes_state_runtime import RuntimeStoreError


def handlers(connection):
    return {"delegation.settings": partial(settings, connection),
            "delegation.presets": partial(presets, connection)}


async def settings(connection, ref, params):
    from agent.delegation_settings import settings_for_session, update_settings
    from gateway.session_busy_controls import authorize

    write = "override" in params or "preset_name" in params
    if write and not ref.session_id:
        raise RuntimeStoreError("invalid_params", field="session_id", detail="a settings write needs a session")
    if connection.actor.profile_id != connection.authority.profile_id:
        raise RuntimeStoreError("profile_mismatch")
    if "session:read" not in connection.actor.capabilities:
        raise RuntimeStoreError("permission_denied")
    authority = connection.authority
    if ref.session_id:
        authorize(connection, ref, params, "session:control" if write else "session:read")
    agent = authority.agent(ref) if ref.session_id else None

    def run():
        from gateway.session_authorities import owner_scope
        ignore = _ignores_user_config(authority, ref.session_id)
        with owner_scope(authority):
            if write:
                fields = {k: params[k] for k in ("override", "preset_name") if k in params}
                update_settings(authority.db, ref.session_id, ignore_user_config=ignore, **fields)
            return settings_for_session(authority.db, ref.session_id, agent, ignore_user_config=ignore)
    try:
        return await asyncio.to_thread(run)
    except ValueError as exc:
        raise RuntimeStoreError("invalid_params", detail=str(exc)) from exc


def _ignores_user_config(authority, session_id):
    """The session's own frozen launch flag (one gateway serves ordinary and bypass chats).
    Only LOCAL sessions carry a launch receipt, and only they can be bypass launches."""
    if not session_id:
        return None
    from hermes_state_local import local_receipt
    try:
        policy = local_receipt(authority.db, session_id).get("policy")
    except RuntimeStoreError:
        return False
    return bool(policy.get("ignore_user_config") or policy.get("safe_mode")) if isinstance(policy, dict) else False


async def presets(connection, ref, params):
    """The owning profile's preset library. Reading needs ``session:read``; changing it is a profile-wide
    write, so only the profile operator may do it (a restricted integration never can)."""
    from agent.subagent_presets import presets as manage
    from gateway.session_authorities import owner_scope

    write = params.get("action", "list") != "list"
    if connection.actor.profile_id != connection.authority.profile_id:
        raise RuntimeStoreError("profile_mismatch")
    if ("session:control" if write else "session:read") not in connection.actor.capabilities:
        raise RuntimeStoreError("permission_denied")
    if write and getattr(connection, "_operator", False) is not True:
        raise RuntimeStoreError("permission_denied")
    fields = {k: params[k] for k in ("action", "name", "new_name", "settings") if k in params}

    def run():
        with owner_scope(connection.authority):
            return manage(**fields)
    try:
        return await asyncio.to_thread(run)
    except ValueError as exc:
        raise RuntimeStoreError("invalid_params", detail=str(exc)) from exc


def offers_delegation(toolsets):
    """Whether a chat with these enabled toolsets is given ``delegate_task`` at all."""
    from toolsets import resolve_toolset
    return any("delegate_task" in resolve_toolset(name) for name in toolsets)


def creation_settings(params, config, *, ignore_user_config=False, offers_delegation=False):
    """Freeze the chat's delegation defaults and explicit override before its first model request.

    ``delegation_preset`` names the preset a client chose for the new chat. Sent alone, the backend captures
    that preset now. Sent with ``delegation_override``, it only labels the override: the client already
    froze that preset's settings when the user picked it, so a later library edit cannot change them.
    Without either, a chat that is given ``delegate_task`` captures the profile's default preset. Later
    library edits never change a created chat; bypass chats never read the library."""
    from agent.delegation_credentials import merge_settings, normalize_override
    from agent.delegation_settings import (_BASE, preset_override, runtime_projection, user_config_ignored,
                                           validate_override)

    override = params.get("delegation_override")
    name = params.get("delegation_preset")
    if name is not None:
        from agent.subagent_presets import _name
        if user_config_ignored(ignore_user_config):
            raise ValueError("This chat ignores user config, so profile subagent presets are unavailable.")
        name = _name(name)
    defaults = {**_BASE, **({} if ignore_user_config else (config.get("delegation") or {}))}
    if override is not None:
        override = validate_override(normalize_override(override, defaults))
    elif name is not None:
        override = preset_override(name)
    elif offers_delegation and not ignore_user_config:
        from agent.subagent_presets import default_preset
        name, preset = default_preset()
        if preset:
            return {"override": None, "preset_name": name,
                    "effective": runtime_projection({**defaults, **preset})}
    state = {"override": override, "effective": runtime_projection(merge_settings(defaults, override))}
    return {**state, "preset_name": name} if name is not None else state
