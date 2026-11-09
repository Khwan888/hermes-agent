"""Route observability never mistakes an omitted or unsupported control for off."""
from types import SimpleNamespace

import pytest

from agent.runtime_route import record_runtime_route, runtime_route


@pytest.mark.parametrize("wire, effort, status", [
    ({"reasoning": {"effort": "low"}}, "low", "enabled"),
    ({"extra_body": {"reasoning": {"enabled": False}}}, "none", "disabled"),
    ({"thinking": {"type": "adaptive"}, "output_config": {"effort": "high"}}, "high", "enabled"),
    ({"thinking": {"type": "enabled", "budget_tokens": 1024}}, None, "enabled"),
    ({"extra_body": {"enable_thinking": False}}, None, "disabled"),
    ({}, None, "unknown"),
])
def test_provider_defaults_are_observed_without_replaying_provider_hooks(wire, effort, status):
    child = SimpleNamespace(provider="plugin", model="model", reasoning_config=None)
    record_runtime_route(child, {**wire, "messages": [{"content": "private"}], "api_key": "secret"})
    route = runtime_route(child)
    assert route["wire_effort"] == effort
    assert route["effective_effort"] == effort
    assert route["reasoning_status"] == status
    assert route["effort_source"] == ("default" if effort else "unknown")
    assert route["observed"] is True
    assert "private" not in str(child._runtime_route_observation)
    assert "secret" not in str(child._runtime_route_observation)


def test_rejected_disable_becomes_unknown_not_off_and_stale_route_cannot_leak():
    child = SimpleNamespace(provider="relay", model="alias", reasoning_config={"enabled": False},
                            _fallback_activated=False)
    record_runtime_route(child, {})  # rejection recovery omitted the control
    child.last_served_model = "deployment-a"
    route = runtime_route(child)
    assert route["model"] == "deployment-a"
    assert route["requested_effort"] == "none"
    assert route["effective_effort"] is None
    assert route["reasoning_status"] == "unknown"
    child.provider, child.model, child._fallback_activated = "backup", "new-model", True
    child.reasoning_config = None
    route = runtime_route(child)
    assert route["model"] == "new-model"
    assert route["wire_effort"] is None
    assert route["reasoning_status"] == "unknown"
    assert route["fallback_activated"] is True
    record_runtime_route(child, {"reasoning_effort": "medium"})
    assert runtime_route(child)["model"] == "new-model"  # no old proxy header on the new route


def test_an_endpoint_move_on_the_same_model_is_a_new_route():
    """Route verdicts are bound to the endpoint; so is the observed wire effort and proxy header."""
    child = SimpleNamespace(provider="custom", model="m", reasoning_config=None,
                            base_url="https://pool-a.example/v1?key=secret-a")
    record_runtime_route(child, {"reasoning_effort": "high"})
    child.last_served_model = "deployment-a"
    assert runtime_route(child)["effective_effort"] == "high"
    assert "secret-a" not in str(child._runtime_route_observation)
    child.base_url = "https://pool-b.example/v1"
    route = runtime_route(child)
    assert (route["wire_effort"], route["effective_effort"], route["model"]) == (None, None, "m")
    assert route["reasoning_status"] == "unknown"
    record_runtime_route(child, {})
    assert child.last_served_model is None


@pytest.mark.parametrize("configured, requested", [
    ({"enabled": True, "effort": "ultra"}, "ultra"),
    ({"enabled": False}, "none"),
    (None, None),
])
def test_configured_intent_is_not_reported_as_effective_before_a_request(configured, requested):
    """A transport may clamp ``ultra`` or reject a disable: until a request is observed only the
    intent is known, and it stays in ``requested_effort``."""
    child = SimpleNamespace(provider="custom", model="m", reasoning_config=configured)
    route = runtime_route(child)
    assert route["requested_effort"] == requested
    assert (route["wire_effort"], route["effective_effort"], route["reasoning_status"]) == (None, None, "unknown")
    assert route["effort_source"] == ("configured" if requested else "unknown")
    assert route["observed"] is False


def test_sdk_extra_body_wins_over_a_conflicting_parameter():
    child = SimpleNamespace(provider="custom", model="alias", reasoning_config={"effort": "high"})
    record_runtime_route(child, {"model": "alias", "reasoning_effort": "high",
                                 "extra_body": {"model": "wire-model", "reasoning_effort": "low"}})
    route = runtime_route(child)
    assert (route["model"], route["wire_effort"], route["requested_effort"]) == ("wire-model", "low", "high")


SYNTHETIC_SECRETS = ("SYNTHETIC_PASS", "SYNTHETIC_QUERY_KEY", "SYNTHETIC_FRAGMENT", "SYNTHETIC_TOKEN")


@pytest.mark.parametrize("label", [
    "https://user:SYNTHETIC_PASS@deployment.invalid/v1",
    "https://deployment.invalid/v1?api_key=SYNTHETIC_QUERY_KEY",
    "https://deployment.invalid/v1#SYNTHETIC_FRAGMENT",
    "//deployment.invalid/v1?key=SYNTHETIC_QUERY_KEY",
    "SYNTHETIC_TOKEN@deployment.invalid/v1",
    "user:SYNTHETIC_PASS@deployment.invalid",
    "https%3A%2F%2Fuser%3ASYNTHETIC_PASS%40deployment.invalid",
    "model SYNTHETIC_TOKEN",
])
def test_endpoint_or_secret_shaped_identities_are_never_a_model_label(label):
    child = SimpleNamespace(provider="custom:proxy", model="launch-alias", reasoning_config=None)
    record_runtime_route(child, {"model": label})
    child.last_served_model = label
    route = runtime_route(child)
    assert route["model"] == "launch-alias"
    assert not any(secret in str(route) or secret in str(child._runtime_route_observation)
                   for secret in SYNTHETIC_SECRETS)


@pytest.mark.parametrize("label", [
    "azure-gpt-4o-eu", "openrouter/anthropic/claude-sonnet-4", "claude-sonnet-4@20250514",
    "arn:aws:bedrock:us-east-1:000000000000:inference-profile/us.anthropic.claude", "llama3.1:8b",
])
def test_model_and_deployment_ids_survive(label):
    child = SimpleNamespace(provider="custom:proxy", model="launch-alias", reasoning_config=None)
    record_runtime_route(child, {"model": "launch-alias"})
    child.last_served_model = label
    assert runtime_route(child)["model"] == label


def test_safe_model_label_accepts_ids_and_rejects_endpoints():
    from agent.runtime_route import safe_model_label

    assert safe_model_label("claude-sonnet-4@20250514") == "claude-sonnet-4@20250514"
    assert safe_model_label("openrouter/anthropic/claude-sonnet-4") == "openrouter/anthropic/claude-sonnet-4"
    for value in ("https://deployment.invalid/v1", "SYNTHETIC_TOKEN@deployment.invalid", "", None, 7, "a" * 201):
        assert safe_model_label(value) is None
