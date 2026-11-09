"""Legacy server boot and exact-transport subagent settings contract."""

from contextlib import contextmanager
from types import SimpleNamespace


def test_legacy_settings_boot_read_write_and_transport_authority(tmp_path, monkeypatch):
    from hermes_state import SessionDB
    from tui_gateway import server

    transport = SimpleNamespace(write=lambda frame: True)
    owner = {"session_key": "chat", "history": [], "transport": transport}
    monkeypatch.setattr(server, "_sessions", {"ui-chat": owner})
    with SessionDB(db_path=tmp_path / "state.db") as db:
        db.ensure_session("chat", source="gui")

        @contextmanager
        def database(session):
            yield db

        monkeypatch.setattr(server, "_session_db", database)
        monkeypatch.setattr(server, "_ensure_session_db_row", lambda session: True)
        request = {"id": 1, "method": "delegation.settings", "params": {
            "session_id": "ui-chat", "override": {"model": "isolated-subagent", "max_spawn_depth": 2}}}
        changed = server.dispatch(request, transport=transport)
        assert changed["result"]["effective"]["model"] == "isolated-subagent"
        request["params"] = {"session_id": "ui-chat"}
        assert server.dispatch(request, transport=transport)["result"]["override"]["max_spawn_depth"] == 2
        foreign = server.dispatch(request, transport=SimpleNamespace(write=lambda frame: True))
        assert foreign["error"]["code"] == 4001
        draft = server.dispatch({"id": 2, "method": "delegation.settings", "params": {}}, transport=transport)
        assert draft["result"]["override"] is None
