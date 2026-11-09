"""Iteration-budget attention through the real child conversation and teardown."""

import json

from openai.types.chat import ChatCompletion

from tests.tools.test_delegate_attention import _parent_with_child


def test_real_budget_exhaustion_persists_before_child_cleanup(tmp_path, monkeypatch):
    events = []
    dt, db, parent, child = _parent_with_child(tmp_path, monkeypatch, events)
    child_sid = child.session_id
    calls = []
    child.max_iterations = 2
    child._auto_recovery_cycles = 0
    child.iteration_budget.max_total = 2
    target = tmp_path / "input.txt"
    target.write_text("fixture input", encoding="utf-8")

    def provider(kwargs):
        calls.append(kwargs)
        return ChatCompletion.model_validate({
            "id": f"fake-{len(calls)}", "object": "chat.completion", "created": 0, "model": "fake-model",
            "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": "partial work", "tool_calls": [{
                    "id": f"call-{len(calls)}", "type": "function", "function": {
                        "name": "read_file", "arguments": json.dumps({"path": str(target)}),
                    },
                }],
            }}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110},
        })

    child._disable_streaming = True
    monkeypatch.setattr(child, "_interruptible_api_call", provider)
    monkeypatch.setattr(child, "_handle_max_iterations", lambda *_a, **_kw: "budget checkpoint")
    try:
        entry = dt._run_single_child(0, "work", child=child, parent_agent=parent)
        assert len(calls) == 2, entry
        assert entry["exit_reason"] == "max_iterations", entry
        assert entry["truncated"] is True
        row = db.get_session(child_sid)
        assert row["end_reason"] == "subagent_max_iterations"
        assert row["last_read_at"] == 0
    finally:
        parent.close()
        db.close()
