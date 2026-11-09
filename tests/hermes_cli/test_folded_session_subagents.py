"""Folded sidebar subagents are direct, paged and scoped to the selected store."""

from pathlib import Path

import pytest
from starlette.testclient import TestClient

from hermes_state import SessionDB


@pytest.fixture
def subagent_client(tmp_path, monkeypatch):
    import hermes_state
    from hermes_cli import web_server

    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", home / "state.db")

    with SessionDB(db_path=home / "state.db") as db:
        db.create_session("root", source="cli")
        db.create_session("alpha", source="subagent", parent_session_id="root")
        db.create_session("beta", source="cli", parent_session_id="root",
                          model_config={"_delegate_from": "root"})
        db.create_session("gamma", source="subagent", parent_session_id="beta")
        db.create_session("branch", source="cli", parent_session_id="root",
                          model_config={"_branched_from": "root"})
        db.create_session("reset", source="cli", parent_session_id="root",
                          model_config={"_reset_from": "root"})
        db.create_session("unrelated", source="cli")
        for sid in ("root", "alpha", "beta", "gamma", "branch", "reset", "unrelated"):
            db.append_message(sid, "user", f"Question for {sid}")

    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    yield client, home


def test_parent_pages_keep_their_rows_and_total_with_direct_subagent_counts(subagent_client):
    client, _ = subagent_client
    pages = [client.get(f"/api/sessions?limit=1&offset={i}&order=recent").json()
             for i in range(4)]
    assert [p["total"] for p in pages] == [4, 4, 4, 4]
    rows = [p["sessions"][0] for p in pages]
    assert {row["id"] for row in rows} == {"root", "branch", "reset", "unrelated"}
    assert {row["id"]: row["subagent_count"] for row in rows} == {
        "root": 2, "branch": 0, "reset": 0, "unrelated": 0}


def test_subagent_endpoint_pages_only_direct_children_and_projects_normal_rows(subagent_client):
    client, _ = subagent_client
    first = client.get("/api/sessions/root/subagents?limit=1&offset=0")
    assert first.status_code == 200
    data = first.json()
    assert {key: data[key] for key in ("total", "limit", "offset", "has_more")} == {
        "total": 2, "limit": 1, "offset": 0, "has_more": True}
    second = client.get("/api/sessions/root/subagents?limit=1&offset=1").json()
    assert second["has_more"] is False
    children = data["sessions"] + second["sessions"]
    assert {row["id"]: row["subagent_count"] for row in children} == {"alpha": 0, "beta": 1}
    for row in children:
        assert row["profile"] == "default"
        assert row["is_default_profile"] is True
        assert isinstance(row["archived"], bool)
        assert isinstance(row["pinned"], bool)
        assert isinstance(row["unread"], bool)
        assert "preview" in row and "last_active" in row and "is_active" in row
        assert "model_config" not in row and "system_prompt" not in row
    nested = client.get("/api/sessions/beta/subagents").json()
    assert [row["id"] for row in nested["sessions"]] == ["gamma"]
    empty = client.get("/api/sessions/root/subagents?limit=1&offset=20").json()
    assert empty == {"sessions": [], "total": 2, "limit": 1, "offset": 20, "has_more": False}


def test_parent_and_subagent_rotations_keep_one_slot_and_nested_counts(subagent_client):
    client, home = subagent_client
    with SessionDB(db_path=home / "state.db") as db:
        db.end_session("root", "compression")
        db.create_session("root-tip", source="cli", parent_session_id="root")
        db.create_session("delta", source="subagent", parent_session_id="root-tip",
                          model_config={"_delegate_from": "root-tip"})
        db.end_session("beta", "compression")
        db.create_session("beta-tip", source="cli", parent_session_id="beta",
                          model_config={"_delegate_from": "root"})
        db.create_session("epsilon", source="subagent", parent_session_id="beta-tip")
        db.create_session("subagent-branch", source="subagent", parent_session_id="beta",
                          model_config={"_delegate_from": "root", "_branched_from": "beta"})
        db.create_session("subagent-reset", source="subagent", parent_session_id="beta",
                          model_config={"_delegate_from": "root", "_reset_from": "beta"})
    for parent in ("root", "root-tip"):
        page = client.get(f"/api/sessions/{parent}/subagents").json()
        assert page["total"] == 3
        rows = {row["id"]: row for row in page["sessions"]}
        assert set(rows) == {"alpha", "beta-tip", "delta"}
        assert rows["beta-tip"]["subagent_count"] == 2
        assert rows["beta-tip"]["_lineage_root_id"] == "beta"
        assert set(rows["beta-tip"]["_lineage_ids"]) == {"beta", "beta-tip"}
        assert rows["beta-tip"]["parent_session_id"] == "root"
    listed = client.get("/api/sessions?order=recent").json()["sessions"]
    assert next(row for row in listed if row["id"] == "root-tip")["subagent_count"] == 3
    nested = client.get("/api/sessions/beta-tip/subagents").json()
    assert {row["id"] for row in nested["sessions"]} == {"gamma", "epsilon"}


def test_source_only_nested_subagents_of_active_subagents_remain_discoverable(subagent_client):
    client, home = subagent_client
    with SessionDB(db_path=home / "state.db") as db:
        db.create_session("source-parent", source="subagent", parent_session_id="alpha")
        db.create_session("source-grandchild", source="subagent", parent_session_id="source-parent")
    page = client.get("/api/sessions/alpha/subagents").json()
    assert {row["id"]: row["subagent_count"] for row in page["sessions"]} == {"source-parent": 1}
    nested = client.get("/api/sessions/source-parent/subagents").json()
    assert [row["id"] for row in nested["sessions"]] == ["source-grandchild"]


def test_legacy_branch_is_not_a_subagent_even_with_subagent_source(subagent_client):
    client, home = subagent_client
    with SessionDB(db_path=home / "state.db") as db:
        db.end_session("beta", "branched")
        db.create_session("legacy-branch", source="subagent", parent_session_id="beta")
    page = client.get("/api/sessions/beta/subagents").json()
    assert {row["id"] for row in page["sessions"]} == {"gamma"}


@pytest.mark.parametrize("query", ["limit=0", "limit=-1", "limit=101", "offset=-1"])
def test_subagent_pagination_is_bounded(subagent_client, query):
    client, _ = subagent_client
    assert client.get(f"/api/sessions/root/subagents?{query}").status_code == 422


def test_missing_parent_and_empty_leaf_are_distinct(subagent_client):
    client, _ = subagent_client
    assert client.get("/api/sessions/not-a-session/subagents").status_code == 404
    empty = client.get("/api/sessions/unrelated/subagents").json()
    assert empty == {"sessions": [], "total": 0, "limit": 50, "offset": 0, "has_more": False}


def test_subagents_use_only_the_selected_profile_store(subagent_client):
    client, home = subagent_client
    other = home / "profiles" / "worker"
    other.mkdir(parents=True)
    (other / "config.yaml").write_text("model: test-model\n")
    with SessionDB(db_path=other / "state.db") as db:
        db.create_session("root", source="cli", profile_name="worker")
        db.create_session("worker-subagent", source="subagent", parent_session_id="root")
        db.create_session("wrong-owner", source="subagent", parent_session_id="root",
                          profile_name="default")
    page = client.get("/api/sessions/root/subagents?profile=worker").json()
    assert page["total"] == 1
    assert [row["id"] for row in page["sessions"]] == ["worker-subagent"]
    assert page["sessions"][0]["profile"] == "worker"
    assert page["sessions"][0]["is_default_profile"] is False
    assert client.get("/api/sessions/alpha/subagents?profile=worker").status_code == 404
    assert client.get("/api/sessions/root/subagents?profile=default").json()["total"] == 2
    assert client.get("/api/sessions/root/subagents?profile=unknown").status_code == 404


def test_finished_archived_and_empty_subagents_remain_discoverable(subagent_client):
    client, home = subagent_client
    with SessionDB(db_path=home / "state.db") as db:
        db.end_session("alpha", "completed")
        db.set_session_archived("alpha", True)
        db.create_session("empty-subagent", source="subagent", parent_session_id="root")
        db.create_session("hidden-subagent", source="subagent", parent_session_id="root")
        db.set_session_hidden("hidden-subagent", True)
    page = client.get("/api/sessions/root/subagents").json()
    assert page["total"] == 3
    rows = {row["id"]: row for row in page["sessions"]}
    assert set(rows) == {"alpha", "beta", "empty-subagent"}
    assert rows["alpha"]["archived"] is True
    assert rows["alpha"]["is_active"] is False


def test_batched_sidebar_and_profile_pages_have_the_same_counts(subagent_client):
    client, _ = subagent_client
    sidebar = client.get("/api/profiles/sessions/sidebar?recents_profile=default").json()
    rows = sidebar["recents"]["sessions"]
    assert {row["id"]: row["subagent_count"] for row in rows} == {
        "root": 2, "branch": 0, "reset": 0, "unrelated": 0}
    page = client.get("/api/profiles/sessions?profile=default&limit=1").json()
    assert page["total"] == 4
    assert len(page["sessions"]) == 1
    assert isinstance(page["sessions"][0]["subagent_count"], int)


def test_subagent_pages_stay_bounded_even_with_pinned_subagents(subagent_client):
    client, home = subagent_client
    with SessionDB(db_path=home / "state.db") as db:
        for i in range(123):
            sid = f"many-subagent-{i:03d}"
            db.create_session(sid, source="subagent", parent_session_id="root")
            db.set_session_pinned(sid, True)
    first = client.get("/api/sessions/root/subagents").json()
    assert first["limit"] == 50 and len(first["sessions"]) == 50
    assert first["total"] == 125 and first["has_more"] is True
    second = client.get("/api/sessions/root/subagents?offset=50").json()
    third = client.get("/api/sessions/root/subagents?offset=100").json()
    assert len(second["sessions"]) == 50
    assert len(third["sessions"]) == 25 and third["has_more"] is False
    assert len({row["id"] for page in (first, second, third) for row in page["sessions"]}) == 125
    maximum = client.get("/api/sessions/root/subagents?limit=100").json()
    assert len(maximum["sessions"]) == 100 and maximum["has_more"] is True


def test_source_only_subagent_compression_is_not_an_extra_subagent(subagent_client):
    client, home = subagent_client
    with SessionDB(db_path=home / "state.db") as db:
        db.end_session("alpha", "compression")
        db.create_session("alpha-tip", source="subagent", parent_session_id="alpha")
    page = client.get("/api/sessions/root/subagents").json()
    assert page["total"] == 2
    assert {row["id"] for row in page["sessions"]} == {"alpha-tip", "beta"}
    leaf = client.get("/api/sessions/alpha/subagents").json()
    assert leaf["total"] == 0 and leaf["sessions"] == []


def test_source_only_subagent_spawned_before_parent_compression_stays_a_subagent(subagent_client):
    client, home = subagent_client
    with SessionDB(db_path=home / "state.db") as db:
        db.create_session("legacy-nested", source="subagent", parent_session_id="alpha")
        db.append_message("legacy-nested", "user", "Legacy source-only nested goal")
        # It ran a while before its parent compressed.
        with db._lock:
            db._conn.execute("UPDATE sessions SET started_at = started_at - 60 WHERE id = ?",
                             ("legacy-nested",))
            db._conn.commit()
    before = client.get("/api/sessions/alpha/subagents").json()
    assert {row["id"] for row in before["sessions"]} == {"legacy-nested"}
    with SessionDB(db_path=home / "state.db") as db:
        db.create_session("marked-nested", source="subagent", parent_session_id="alpha",
                          model_config={"_delegate_from": "alpha"})
        # The real rotation inserts the continuation just before stamping alpha's ended_at.
        db.publish_compression_child(
            parent_session_id="alpha", child_session_id="alpha-tip", source="subagent",
            messages=[{"role": "user", "content": "Question for alpha"}],
            require_compression_lease=False)
    for parent in ("alpha", "alpha-tip"):
        page = client.get(f"/api/sessions/{parent}/subagents").json()
        assert page["total"] == 2
        assert {row["id"] for row in page["sessions"]} == {"legacy-nested", "marked-nested"}
    root = client.get("/api/sessions/root/subagents").json()
    assert root["total"] == 2
    rows = {row["id"]: row for row in root["sessions"]}
    assert set(rows) == {"alpha-tip", "beta"}
    assert rows["alpha-tip"]["continuation_kind"] == "compression"
    assert rows["alpha-tip"]["_lineage_root_id"] == "alpha"
    assert rows["alpha-tip"]["subagent_count"] == 2


def test_subagent_route_requires_the_normal_session_token(subagent_client):
    client, _ = subagent_client
    from hermes_cli.web_server import _SESSION_HEADER_NAME

    del client.headers[_SESSION_HEADER_NAME]
    assert client.get("/api/sessions/root/subagents").status_code == 401


@pytest.mark.parametrize("problem", ["disk I/O error", "database disk image is malformed"])
def test_unavailable_subagent_store_is_retryable_not_an_empty_page(subagent_client, monkeypatch, problem):
    import sqlite3
    from hermes_cli import web_server_sessions

    client, _ = subagent_client

    def unavailable(*args, **kwargs):
        raise sqlite3.OperationalError(problem)

    monkeypatch.setattr(web_server_sessions, "_open_session_db_for_profile", unavailable)
    assert client.get("/api/sessions/root/subagents").status_code == 503


def test_finished_subagent_rows_carry_their_stored_runtime_observation(subagent_client):
    """After a reload the Agents tab reads finished subagents from this page: each row carries the child's own
    measured status/route/duration (an interrupted child is not 'completed'; a fallback route is visible),
    never live text or meters, and null when the observation is missing or unusable."""
    import json

    client, home = subagent_client
    route = {"provider": "openrouter", "model": "fallback/model", "requested_effort": "high",
             "wire_effort": "medium", "effective_effort": "medium", "effort_source": "configured",
             "reasoning_status": "enabled", "fallback_activated": True, "secret_header": {"x": "y"}}
    with SessionDB(db_path=home / "state.db") as db:
        db.set_meta("subagent-observation:alpha", json.dumps({
            "status": "interrupted", "duration_seconds": 7.5, "model": "fallback/model", "route": route,
            "live_text": "partial reply", "usage": {"output_tokens": 9}}))
        db.set_meta("subagent-observation:beta", "{not json")
        db.create_session("zeta", source="subagent", parent_session_id="root")
        db.end_session("zeta", "compression")
        db.create_session("zeta-tip", source="subagent", parent_session_id="zeta")
        db.set_meta("subagent-observation:zeta", json.dumps({"status": "completed", "duration_seconds": 3,
                                                               "route": "not-a-dict"}))
    rows = {row["id"]: row for row in client.get("/api/sessions/root/subagents").json()["sessions"]}
    assert rows["alpha"]["subagent_observation"] == {
        "status": "interrupted", "duration_seconds": 7.5,
        "route": {key: value for key, value in route.items() if key != "secret_header"}}
    assert rows["beta"]["subagent_observation"] is None
    # A rotated child falls back to its root's observation; a wrong-typed route is unknown, not guessed.
    assert rows["zeta-tip"]["subagent_observation"] == {"status": "completed", "duration_seconds": 3, "route": None}
    nested = client.get("/api/sessions/beta/subagents").json()["sessions"]
    assert [row["subagent_observation"] for row in nested] == [None]
