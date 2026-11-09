"""The managed worker's receipt contract accepts the policy sent with its tools."""

import json

import pytest

from agent.runtime_session_store import RuntimeSessionStore
from hermes_state import SessionDB
from hermes_state_runtime import begin_runtime_epoch, mutate_worker_execution, register_worker_execution


def test_worker_round_trips_tool_policy_and_explicit_switch_state(tmp_path):
    with SessionDB(tmp_path / "state.db") as db:
        db.create_session("owned", "cli")
        db.create_session("foreign", "cli")
        epoch = begin_runtime_epoch(db, instance_id="fixture")
        scope = dict(epoch=epoch, execution_id="worker", session_id="owned", generation=0)
        register_worker_execution(db, **scope, kind="compute", adoption_secret="test-secret")
        store = RuntimeSessionStore(lambda method, **p: mutate_worker_execution(db, **p), scope, tmp_path / "outbox")
        policy = {"backend": "default", "model": "chat-child", "max_spawn_depth": 1}
        pin = {"version": "test-version", "tools": [], "delegation_backend": "default", "delegation_config": policy}
        try:
            store.update_session_tool_names("owned", pin)
            assert json.loads(store.get_session("owned")["tool_names"]) == pin
            state = {"override": None, "effective": policy}
            store.patch_session_model_config("owned", {"_delegation_settings": state})
            assert store.get_session_model_config_value("owned", "_delegation_settings") == state
            assert db.get_session_model_config_value("foreign", "_delegation_settings") is None
        finally:
            store.close()


@pytest.mark.parametrize("bad", ["not a policy", None, []])
def test_worker_refuses_malformed_policy_without_replacing_pin(tmp_path, bad):
    with SessionDB(tmp_path / "state.db") as db:
        db.create_session("owned", "cli")
        epoch = begin_runtime_epoch(db, instance_id="fixture")
        scope = dict(epoch=epoch, execution_id="worker", session_id="owned", generation=0)
        register_worker_execution(db, **scope, kind="compute", adoption_secret="test-secret")
        pin = {"version": "v", "tools": [], "delegation_backend": "default", "delegation_config": bad}
        with pytest.raises(Exception, match="invalid_params"):
            mutate_worker_execution(db, **scope, sequence=1, operation="session.tools", payload={"tool_names": pin})
        assert db.get_session("owned")["tool_names"] is None
