"""The subagent route is runtime truth on both gateway transports, including after fallback."""
import json
from types import SimpleNamespace

import pytest


def test_snapshot_and_events_follow_the_child_after_fallback(monkeypatch):
    from gateway.session_ancillary import subagent_row
    from tools import delegate_tool_registry as registry
    from tools.delegate_tool_child_run import _register_child
    from tools.delegate_tool_progress import _build_child_progress_callback
    from tui_gateway import server

    transport = SimpleNamespace(write=lambda frame: True)
    owner = {"transport": transport, "history": []}
    monkeypatch.setattr(server, "_sessions", {"parent": owner})
    monkeypatch.setattr(registry, "_active_subagents", {})
    child = SimpleNamespace(_subagent_id="child", _delegate_depth=2, provider="custom:relay",
                            model="initial", reasoning_config={"effort": "high"},
                            _fallback_activated=False, session_id="stored-child")
    _register_child(child, None, "work", owner_session_id="parent", owner_transport=transport,
                    owner_session_record=owner)
    events = []
    relay = _build_child_progress_callback(0, "work", SimpleNamespace(
        tool_progress_callback=lambda kind, name, preview, args, **kw: events.append((kind, kw))),
        subagent_id="child", depth=1, model="initial", session_ref={"_child": child})
    relay("subagent.start")
    child.provider, child.model, child._fallback_activated = "fallback-provider", "actual-model", True
    child.reasoning_config = {"enabled": False}
    relay("subagent.complete", status="completed")
    response = server.dispatch({"id": 1, "method": "subagent.list", "params": {"session_id": "parent"}},
                               transport=transport)
    row = response["result"]["subagents"][0]
    # The fallback route has no request yet: its configured disable is intent, not evidence.
    assert row["route"] == {
        "provider": "fallback-provider", "model": "actual-model", "requested_effort": "none",
        "wire_effort": None, "effective_effort": None, "effort_source": "configured",
        "reasoning_status": "unknown", "observed": False, "fallback_activated": True,
    }
    assert row["model"] == "actual-model"
    assert subagent_row(registry._active_subagents["child"])["route"] == row["route"]
    assert events[0][1]["route"]["model"] == "initial"
    kind, kwargs = events[-1]
    payload = server._subagent_payload(kind, None, None, kwargs, show_reasoning=False)
    assert payload["route"] == row["route"]
    assert payload["model"] == "actual-model"
    assert payload["depth"] == 1


def test_nested_route_identity_and_unknown_plugin_metadata_survive_relay():
    from agent.runtime_route import runtime_route
    from tools.delegate_tool_progress import _build_child_progress_callback
    from tui_gateway import server

    events = []
    parent = SimpleNamespace(tool_progress_callback=lambda kind, name, preview, args, **kw: events.append((kind, kw)))
    relay = _build_child_progress_callback(0, "orchestrator", parent, subagent_id="outer", model="outer-model")
    assert relay is not None
    route = runtime_route(SimpleNamespace())  # a plugin need not expose built-in agent attributes
    assert route == {"provider": None, "model": None, "requested_effort": None, "wire_effort": None,
                     "effective_effort": None, "effort_source": "unknown", "reasoning_status": "unknown",
                     "observed": False, "fallback_activated": None}
    for kind in ("subagent.start", "subagent.tool", "subagent.thinking", "subagent.text", "subagent.complete"):
        relay(kind, "read_file", "hello", subagent_id="inner", parent_id="outer", depth=1,
              child_session_id="inner-session", route=route, model="plugin-model")
    assert [kind for kind, _ in events] == ["subagent.start", "subagent.tool", "subagent.thinking", "subagent.text", "subagent.complete"]
    for kind, kwargs in events:
        payload = server._subagent_payload(kind, None, None, kwargs, show_reasoning=False)
        assert payload["subagent_id"] == "inner"
        assert payload["parent_id"] == "outer"
        assert payload["route"] == route


def _register_and_relay(monkeypatch, child):
    from tools import delegate_tool_registry as registry
    from tools.delegate_tool_child_run import _register_child
    from tools.delegate_tool_progress import _build_child_progress_callback
    from tui_gateway import server

    transport = SimpleNamespace(write=lambda frame: True)
    owner = {"transport": transport, "history": []}
    monkeypatch.setattr(server, "_sessions", {"parent": owner})
    monkeypatch.setattr(registry, "_active_subagents", {})
    _register_child(child, None, "work", owner_session_id="parent", owner_transport=transport,
                    owner_session_record=owner)
    events = []
    relay = _build_child_progress_callback(0, "work", SimpleNamespace(
        tool_progress_callback=lambda kind, name, preview, args, **kw: events.append((kind, kw))),
        subagent_id="child", depth=1, model=child.model, session_ref={"_child": child})

    def list_row():
        response = server.dispatch({"id": 1, "method": "subagent.list", "params": {"session_id": "parent"}},
                                   transport=transport)
        return response["result"]["subagents"][0]

    def event(kind, **kw):
        relay(kind, **kw)
        kind, kwargs = events[-1]
        return server._subagent_payload(kind, None, None, kwargs, show_reasoning=False)

    return list_row, event


def test_a_child_that_fails_before_any_request_shows_only_its_configured_intent(monkeypatch):
    child = SimpleNamespace(_subagent_id="child", _delegate_depth=2, provider="custom:relay", model="m",
                            reasoning_config={"enabled": True, "effort": "ultra"}, _fallback_activated=False,
                            session_id="stored-child")
    list_row, event = _register_and_relay(monkeypatch, child)
    for route in (list_row()["route"], event("subagent.start")["route"],
                  event("subagent.complete", status="failed")["route"]):
        assert route["requested_effort"] == "ultra"
        assert (route["wire_effort"], route["effective_effort"], route["reasoning_status"]) == (None, None, "unknown")
        assert route["observed"] is False


@pytest.mark.parametrize("header, value, shown", [
    ("x-litellm-model-api-base", "https://user:SYNTHETIC_PASS@deployment.invalid/v1", "launch-alias"),
    ("x-litellm-model-api-base", "https://deployment.invalid/v1?api_key=SYNTHETIC_QUERY_KEY", "launch-alias"),
    ("x-litellm-model-api-base", "https://deployment.invalid/v1#SYNTHETIC_FRAGMENT", "launch-alias"),
    ("x-litellm-model-id", "SYNTHETIC_TOKEN@deployment.invalid/v1", "launch-alias"),
    ("x-litellm-model-id", "azure-gpt-4o-eu", "azure-gpt-4o-eu"),
    ("x-litellm-model-id", "claude-sonnet-4@20250514", "claude-sonnet-4@20250514"),
])
def test_served_model_header_reaches_list_and_events_only_as_a_safe_model_label(monkeypatch, header, value, shown):
    """The real capture hook on a real SDK client (httpx.MockTransport; all values synthetic):
    an API-base URL is an endpoint, never a model label, in the route or the legacy ``model``."""
    import httpx
    from openai import OpenAI

    from agent.runtime_route import record_runtime_route
    from agent.served_model import install_served_model_capture

    def receive(request):
        body = json.loads(request.content)
        return httpx.Response(200, request=request, headers={header: value}, json={
            "id": "offline", "object": "chat.completion", "created": 0, "model": body["model"],
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
        })

    child = SimpleNamespace(_subagent_id="child", _delegate_depth=2, provider="custom:proxy", model="launch-alias",
                            base_url="https://proxy.invalid/v1", reasoning_config={"effort": "high"},
                            _fallback_activated=False, session_id="stored-child")
    client = OpenAI(api_key="synthetic", base_url=child.base_url, max_retries=0,
                    http_client=httpx.Client(transport=httpx.MockTransport(receive)))
    install_served_model_capture(child, client)
    list_row, event = _register_and_relay(monkeypatch, child)
    request = {"model": child.model, "messages": [{"role": "user", "content": "offline"}], "reasoning_effort": "high"}
    record_runtime_route(child, request)  # the dispatch boundary, then the SDK sends it
    client.chat.completions.create(**request)
    client.close()
    assert child.last_served_model == value  # the capture itself is unchanged
    row, payload = list_row(), event("subagent.complete", status="completed")
    for projected in (row, payload):
        assert projected["model"] == shown
        assert projected["route"]["model"] == shown
        serialized = json.dumps(projected)
        assert not any(secret in serialized for secret in
                       ("SYNTHETIC_PASS", "SYNTHETIC_QUERY_KEY", "SYNTHETIC_FRAGMENT", "SYNTHETIC_TOKEN", "deployment.invalid"))
