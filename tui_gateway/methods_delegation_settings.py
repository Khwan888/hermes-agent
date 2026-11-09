"""Legacy TUI transport adapter for the shared per-chat subagent policy."""

from .method_ctx import HandlerRegistry, bind_module

_registry = HandlerRegistry()
method = _registry.method
_profile_scoped = _registry.profile_scoped


@method("delegation.settings")
@_profile_scoped
def delegation_settings_rpc(rid, params):
    from agent.delegation_settings import settings_for_session, update_settings

    sid = params.get("session_id") or ""
    write = "override" in params
    if not sid:
        return _err(rid, 4000, "A settings write needs a session") if write else _ok(rid, settings_for_session())
    _, owner = _current_session_steer_authority(sid)
    if owner is None:
        return _err(rid, 4001, "session not found or not owned by this transport")
    if write and _ensure_session_db_row(owner) is False:
        return _err(rid, 5001, "session database unavailable")
    try:
        with _session_db(owner) as db:
            key = _session_lookup_key(owner)
            if write:
                update_settings(db, key, override=params["override"])
                return _ok(rid, settings_for_session(db, key, owner.get("agent")))
            return _ok(rid, settings_for_session(db, key, owner.get("agent")))
    except ValueError as exc:
        return _err(rid, 4000, str(exc))


@method("delegation.presets")
@_profile_scoped
def subagent_presets_rpc(rid, params):
    from agent.subagent_presets import presets
    try:
        return _ok(rid, presets(**{k: params[k] for k in ("action", "name", "new_name", "settings") if k in params}))
    except ValueError as exc:
        return _err(rid, 4000, str(exc))


def register(server):
    bind_module(globals(), server)
