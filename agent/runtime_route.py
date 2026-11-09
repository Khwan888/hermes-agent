"""Secret-free runtime route projection shared by subagent events and roster reads.

Read the child, not the launch route or a profile's saved model_config. Observe the
request each attempt hands the provider client (after request and execution
middleware), so provider defaults, clamping, rewrites and rejected controls are
reflected without replaying resolvers, consuming overrides or probing APIs. Until a
request is observed only the configured intent is known; it is never reported as
effective.
"""
import hashlib
import re
from typing import Any

# Model/deployment IDs, incl. router paths, Bedrock ARNs and Vertex ``model@version``.
_MODEL_LABEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,199}")


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def safe_model_label(value: Any) -> str | None:
    """``value`` when it is shaped like a model ID, else ``None``.

    A routing proxy's served-model header may be its upstream API base (LiteLLM's
    ``x-litellm-model-api-base``), a URL that can carry userinfo, a key query or a
    fragment. That is an endpoint, not a model, so it is never displayed as one.
    """
    text = _text(value)
    if text is None or not _MODEL_LABEL.fullmatch(text) or "//" in text:
        return None
    if "@" in text:
        user, _, host = text.rpartition("@")
        if ":" in user or any(mark in host for mark in ".:/"):
            return None  # URL userinfo (``token@host``, ``user:pass@host``), not ``model@version``
    return text


def _configured_effort(config: Any) -> str | None:
    if not isinstance(config, dict):
        return None
    if config.get("enabled") is False:
        return "none"
    return _text(config.get("effort"))


def _sent_body(kwargs: dict) -> dict:
    """The JSON body the SDK sends: ``extra_body`` keys override same-named parameters
    (the OpenAI and Anthropic SDKs merge it last, shallowly)."""
    body = {key: value for key, value in kwargs.items() if key != "extra_body"}
    extra = kwargs.get("extra_body")
    if isinstance(extra, dict):
        body.update(extra)
    return body


def _reasoning_fields(body: dict, bedrock: Any) -> tuple[str | None, str]:
    """Only standardized reasoning controls; never retain the full request."""
    for scope in (body, bedrock if isinstance(bedrock, dict) else {}):
        effort = _text(scope.get("reasoning_effort"))
        reasoning = scope.get("reasoning")
        if effort is None:
            effort = _configured_effort(reasoning)
        output = scope.get("output_config")
        if effort is None and isinstance(output, dict):
            effort = _text(output.get("effort"))
        if effort:
            return effort, "disabled" if effort in {"none", "off"} else "enabled"
        thinking = scope.get("thinking")
        if isinstance(thinking, dict) and thinking.get("type") in {"enabled", "adaptive", "disabled"}:
            return None, "disabled" if thinking["type"] == "disabled" else "enabled"
        if isinstance(reasoning, dict) and isinstance(reasoning.get("enabled"), bool):
            return None, "enabled" if reasoning["enabled"] else "disabled"
        if isinstance(scope.get("enable_thinking"), bool):
            return None, "enabled" if scope["enable_thinking"] else "disabled"
    return None, "unknown"


def _route_key(agent: Any) -> tuple:
    """Provider, model and normalized endpoint: the same identity route verdicts are bound to,
    so a pool rotation or refreshed base URL starts a new observation like it resets verdicts."""
    from agent.route_verdicts import route_endpoint

    # A digest: an endpoint URL may carry a key in its query string.
    endpoint = hashlib.sha256(route_endpoint(agent).encode()).hexdigest()[:16]
    return _text(getattr(agent, "provider", None)), _text(getattr(agent, "model", None)), endpoint


def record_runtime_route(agent: Any, kwargs: dict) -> None:
    """Observe the request handed to the provider client, after every rewrite.

    Keeps only the requested model (when ID-shaped) and the reasoning controls: no
    prompts, endpoint URLs, credentials or mutable request objects. A route change
    fences both the effort and the previous proxy's model header.
    """
    key = _route_key(agent)
    previous = getattr(agent, "_runtime_route_observation", None)
    if isinstance(previous, dict) and previous.get("route") != key:
        agent.last_served_model = None
    kwargs = kwargs if isinstance(kwargs, dict) else {}
    body = _sent_body(kwargs)
    effort, status = _reasoning_fields(body, kwargs.get("additionalModelRequestFields"))
    agent._runtime_route_observation = {
        "route": key, "request_model": safe_model_label(body.get("model") or body.get("modelId")),
        "wire_effort": effort, "reasoning_status": status,
    }


def runtime_route(agent: Any) -> dict:
    """Current provider/model and reasoning; safe on partial plugin agents.

    ``observed`` stays false until a request on the current route is dispatched: only
    the configured intent (``requested_effort``) is known then, so effective effort and
    reasoning status are unknown. After one, an omitted control is unknown (not
    disabled), and provider/harness-internal defaults with no wire evidence stay unknown.
    The model is the proxy's served model ID, else the dispatched one, else the child's.
    """
    provider = _text(getattr(agent, "provider", None))
    model = _text(getattr(agent, "model", None))
    requested = _configured_effort(getattr(agent, "reasoning_config", None))
    observation = getattr(agent, "_runtime_route_observation", None)
    observed = observation if isinstance(observation, dict) else {}
    current = bool(observed) and observed.get("route") == _route_key(agent)
    effort = _text(observed.get("wire_effort")) if current else None
    status = observed.get("reasoning_status", "unknown") if current else "unknown"
    served = safe_model_label(getattr(agent, "last_served_model", None)) if current else None
    sent = _text(observed.get("request_model")) if current else None
    fallback = getattr(agent, "_fallback_activated", None)
    return {
        "provider": provider, "model": served or sent or model,
        "requested_effort": requested, "wire_effort": effort, "effective_effort": effort,
        "effort_source": "configured" if requested else "default" if effort else "unknown",
        "reasoning_status": status, "observed": current,
        "fallback_activated": fallback if isinstance(fallback, bool) else None,
    }
