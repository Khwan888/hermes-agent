"""``subagent_attention`` on session rows: unread and over-budget subagents at ANY depth below a row, counted
once per subagent lineage, in one batched query per page, and absent when nothing needs the human."""

from pathlib import Path

import pytest
from starlette.testclient import TestClient

from hermes_state import SessionDB


@pytest.fixture
def client(tmp_path, monkeypatch):
    import hermes_state
    from hermes_cli import web_server

    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", home / "state.db")

    with SessionDB(db_path=home / "state.db") as db:
        db.create_session("root", source="cli")
        # alpha: a finished leaf subagent, unread.
        db.create_session("alpha", source="subagent", parent_session_id="root")
        # beta: an orchestrator subagent (read) whose own subagent gamma ran out of budget; gamma compressed once,
        # so its lineage is two rows but ONE subagent.
        db.create_session("beta", source="cli", parent_session_id="root", model_config={"_delegate_from": "root"})
        db.create_session("gamma", source="subagent", parent_session_id="beta")
        db.create_session("gamma-2", source="subagent", parent_session_id="gamma")
        # delta: finished and already opened (never marked unread).
        db.create_session("delta", source="subagent", parent_session_id="root")
        db.create_session("quiet", source="cli")
        db.create_session("quiet-subagent", source="subagent", parent_session_id="quiet")
        for sid in ("root", "alpha", "beta", "gamma", "gamma-2", "delta", "quiet", "quiet-subagent"):
            db.append_message(sid, "user", f"Question for {sid}")
        db.end_session("gamma", "compression")
        db.end_session("gamma-2", "subagent_max_iterations")
        db.set_session_read("alpha", False)
        db.set_session_read("gamma-2", False)

    api = TestClient(web_server.app)
    api.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    yield api, home


def _rows(api, path):
    return {row["id"]: row for row in api.get(path).json()["sessions"]}


def test_session_rows_roll_up_unread_and_over_budget_subagents_of_every_depth(client):
    api, _ = client
    rows = _rows(api, "/api/sessions?limit=50")
    assert rows["root"]["subagent_attention"] == {"unread": 2, "over_budget": 1}
    assert rows["quiet"]["subagent_attention"] == {"unread": 0, "over_budget": 0}  # has a subagent, none needs you
    subagents = _rows(api, "/api/sessions/root/subagents")
    assert subagents["beta"]["subagent_attention"] == {"unread": 1, "over_budget": 1}
    assert "subagent_attention" not in subagents["alpha"] and "subagent_attention" not in subagents["delta"]  # no subagents


def test_opening_a_subagent_clears_it_from_every_ancestor_roll_up(client):
    api, home = client
    with SessionDB(db_path=home / "state.db") as db:
        db.set_session_read("gamma", True)  # the lineage stamp the open path writes
    rows = _rows(api, "/api/sessions?limit=50")
    assert rows["root"]["subagent_attention"] == {"unread": 1, "over_budget": 0}
    assert _rows(api, "/api/sessions/root/subagents")["beta"]["subagent_attention"] == {"unread": 0, "over_budget": 0}


def test_one_session_read_carries_the_same_roll_up_and_subagent_rows_say_they_are_subagents(client):
    """The desktop re-reads one parent after opening a subagent; that read must agree with the list row."""
    api, home = client
    detail = api.get("/api/sessions/root").json()
    assert detail["subagent_count"] == 3 and detail["subagent_attention"] == {"unread": 2, "over_budget": 1}
    # A parked delegate card reads ONE child through this route: it must say unread like the list row.
    assert api.get("/api/sessions/alpha").json()["unread"] is True
    assert api.get("/api/sessions/delta").json()["unread"] is False
    assert all(row["is_internal_child"] is True for row in _rows(api, "/api/sessions/root/subagents").values())
    with SessionDB(db_path=home / "state.db") as db:
        db.set_session_read("alpha", True)
        db.set_session_read("gamma", True)
    assert api.get("/api/sessions/root").json()["subagent_attention"] == {"unread": 0, "over_budget": 0}
    assert api.get("/api/sessions/alpha").json()["unread"] is False


def test_timeout_remains_unread_without_counting_as_iteration_budget_exhaustion(client):
    api, home = client
    with SessionDB(db_path=home / "state.db") as db:
        db.create_session("timed-out", source="subagent", parent_session_id="root")
        db.append_message("timed-out", "user", "Slow tool")
        db.end_session("timed-out", "subagent_timeout")
        db.set_session_read("timed-out", False)
    rows = _rows(api, "/api/sessions?limit=50")
    assert rows["root"]["subagent_attention"] == {"unread": 3, "over_budget": 1}
    assert _rows(api, "/api/sessions/root/subagents")["beta"]["subagent_attention"] == {"unread": 1, "over_budget": 1}


def test_one_page_costs_one_roll_up_query(client, monkeypatch):
    from hermes_cli import session_listing

    api, home = client
    with SessionDB(db_path=home / "state.db") as db:
        for i in range(5):
            db.create_session(f"p{i}", source="cli")
            db.create_session(f"p{i}-h", source="subagent", parent_session_id=f"p{i}")
            db.append_message(f"p{i}-h", "user", "work")
            db.set_session_read(f"p{i}-h", False)
    calls = []
    real = session_listing._subagent_attention_sql
    monkeypatch.setattr(session_listing, "_subagent_attention_sql", lambda ids: calls.append(ids) or real(ids))
    rows = _rows(api, "/api/sessions?limit=50")
    assert len(calls) == 1
    assert all(rows[f"p{i}"]["subagent_attention"] == {"unread": 1, "over_budget": 0} for i in range(5))
