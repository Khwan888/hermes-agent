"""Cheap, secret-free subagent meters read from the child already doing the work.

Missing/plugin measurements stay unknown. No viewer agent is constructed, no model
metadata is fetched, and no wall-clock run duration is mislabeled generation time.
"""
from __future__ import annotations

import logging
import math
from collections import deque

logger = logging.getLogger(__name__)


def _count(value):
    return value if type(value) is int and value >= 0 else None


def _tokens_per_second(agent):
    # Match the ordinary status bar's rolling API throughput, not cumulative
    # output divided by a ten-call window (nor tokens / time spent in tools).
    latencies = getattr(agent, "_api_latency_history", None)
    outputs = getattr(agent, "_api_output_history", None)
    if not isinstance(latencies, (list, tuple, deque)) or not isinstance(outputs, (list, tuple, deque)):
        return None
    latencies, outputs = list(latencies), list(outputs)
    n = min(len(latencies), len(outputs))
    if not n:
        return None
    latencies, outputs = latencies[-n:], outputs[-n:]
    if (any(type(v) not in (int, float) or not math.isfinite(v) or v <= 0 for v in latencies)
            or any(_count(v) is None for v in outputs)):
        return None
    elapsed = sum(latencies)
    return round(sum(outputs) / elapsed, 2) if math.isfinite(elapsed) else None


def subagent_usage(agent) -> dict:
    """Nullable counters of THIS child. ``input_tokens`` excludes cache; ``prompt_tokens`` includes it.

    ``generation_seconds`` is unknown: core tracks rolling API latency, not
    generation-only elapsed time. ``tokens_per_second`` uses those matched
    rolling samples, including request latency, just like the normal chat bar.
    """
    compressor = getattr(agent, "context_compressor", None)
    context = _count(getattr(compressor, "last_prompt_tokens", None))
    window = _count(getattr(compressor, "context_length", None))
    return {
        "context_tokens": context if context else None,
        "context_window": window if window else None,
        "input_tokens": _count(getattr(agent, "session_input_tokens", None)),
        "cached_tokens": _count(getattr(agent, "session_cache_read_tokens", None)),
        "output_tokens": _count(getattr(agent, "session_output_tokens", None)),
        "generation_seconds": None,
        "prompt_tokens": _count(getattr(agent, "session_prompt_tokens", None)),
        "tokens_per_second": _tokens_per_second(agent),
    }

_OBSERVATION_KEY = "subagent-observation:"


def remember_subagent(child, record, status, duration_seconds):
    """Keep measured route/meters and a bounded unfinished reply for the child's page after restart."""
    import json
    from agent.runtime_route import runtime_route

    db = getattr(child, "_session_db", None)
    save = getattr(db, "set_meta", None)
    sid = getattr(child, "session_id", None)
    if not callable(save) or not isinstance(sid, str):
        return
    route = runtime_route(child)
    snapshot = {
        "subagent_id": record.get("subagent_id"), "child_session_id": sid,
        "parent_id": record.get("parent_id"), "started_at": record.get("started_at"),
        "status": status, "duration_seconds": duration_seconds,
        "live_text": record.get("live_text") if status == "running" else None,
        "model": route["model"], "route": route, "usage": subagent_usage(child),
    }
    data = json.dumps(snapshot)
    for key in {sid, record.get("child_origin_session_id")} - {None, ""}:
        save(_OBSERVATION_KEY + key, data)


# Optional stored observation fields that must be objects; a wrong-typed one is dropped, not trusted.
_OBSERVATION_OBJECTS = ("route", "usage")


def stored_subagent(db, sid):
    """The child's last remembered observation, or None when it is absent or unusable.

    The observation is optional measurement data: invalid JSON or a non-object reads as unavailable and a
    wrong-typed ``route``/``usage`` reads as unknown (None), so a finished child's subject read never fails on
    it. The stored meta is kept as is for diagnosis.
    """
    import json

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
    for key in _OBSERVATION_OBJECTS:
        if key in value and value[key] is not None and not isinstance(value[key], dict):
            logger.debug("subagent observation for %s has a non-object %s; dropping it", sid, key)
            value[key] = None
    return value
