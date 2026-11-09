"""A finished subagent's measured ending, kept with its session for reads after a restart.

The live Agents row knows how a child ended and which route actually served it. After a
renderer reload or backend restart only the stored session row is left, which carries the
launch model and an end reason but neither the observed route (fallback, effort) nor a
deliberate interruption. One small secret-free snapshot per child closes that gap.

Only measured values are written: the launch config never fills a gap.
"""
from __future__ import annotations

import json
import logging

logger = logging.getLogger(__name__)

_OBSERVATION_KEY = "subagent-observation:"


def remember_subagent(child, record, status, duration_seconds):
    """Persist ``{status, duration_seconds, route}`` for the child's own session (best effort)."""
    from agent.runtime_route import runtime_route

    db = getattr(child, "_session_db", None)
    save = getattr(db, "set_meta", None)
    sid = getattr(child, "session_id", None)
    if not callable(save) or not isinstance(sid, str) or not sid:
        return
    save(_OBSERVATION_KEY + sid, json.dumps({
        "subagent_id": record.get("subagent_id"), "status": status,
        "duration_seconds": duration_seconds, "route": runtime_route(child),
    }))


def stored_subagent(db, sid):
    """The child's last remembered observation, or None when it is absent or unusable.

    The observation is optional measurement data: invalid JSON or a non-object reads as
    unavailable, and a wrong-typed ``route`` reads as unknown (None), so a listing never fails
    on it. The stored meta is kept as is for diagnosis.
    """
    row = db.get_session(sid)
    if row is None or not row.get("parent_session_id"):
        return None
    raw = db.get_meta(_OBSERVATION_KEY + sid)
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        logger.debug("subagent observation for %s is not valid JSON; treating it as unavailable", sid)
        return None
    if not isinstance(value, dict):
        logger.debug("subagent observation for %s is not an object; treating it as unavailable", sid)
        return None
    if value.get("route") is not None and not isinstance(value["route"], dict):
        logger.debug("subagent observation for %s has a non-object route; dropping it", sid)
        value["route"] = None
    return value
