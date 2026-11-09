"""The profile's subagent preset library: validated, locked, atomic, recoverable, credential-free."""

import json
import threading

import pytest

from tests.tools.test_delegation_backends import _home

pytest_plugins = ["tests.tools.test_delegation_backends"]

MALFORMED = {
    "invalid-json": "{not json",
    "wrong-envelope": "[]",
    "presets-not-object": '{"presets": [], "default_preset": null}',
    "default-not-string": '{"presets": {}, "default_preset": 7}',
    "entry-not-object": '{"presets": {"fast": "gpt"}, "default_preset": "fast"}',
    "entry-bad-field": '{"presets": {"fast": {"max_spawn_depth": "deep"}}, "default_preset": "fast"}',
    "entry-unknown-key": '{"presets": {"fast": {"command": "rm"}}, "default_preset": "fast"}',
    "entry-bad-credentials": '{"presets": {"fast": {"_credential_refs": "x"}}, "default_preset": "fast"}',
}


def _write(home, text):
    path = home / "subagent-presets.json"
    path.write_text(text, encoding="utf-8")
    return path


def test_save_rename_default_delete_round_trip(tmp_path, monkeypatch):
    from agent.subagent_presets import presets

    home, manager = _home(tmp_path, monkeypatch, {"model": "profile-model", "max_spawn_depth": 2}, plugins=())
    try:
        assert presets() == {"presets": [], "default_preset": None}
        assert not (home / "subagent-presets.json").exists()  # a read never creates the library
        saved = presets(action="save", name="  fast team ", settings={"model": "fast-child", "max_concurrent_children": 2})
        [entry] = saved["presets"]
        # A snapshot: the profile defaults at save time plus the supplied fields.
        assert entry["name"] == "fast team"
        assert entry["settings"]["model"] == "fast-child" and entry["settings"]["max_spawn_depth"] == 2
        assert presets(action="default", name="fast team")["default_preset"] == "fast team"
        renamed = presets(action="rename", name="fast team", new_name="renamed")
        assert [p["name"] for p in renamed["presets"]] == ["renamed"] and renamed["default_preset"] == "renamed"
        deleted = presets(action="delete", name="renamed")
        assert deleted == {"presets": [], "default_preset": None}
        on_disk = json.loads((home / "subagent-presets.json").read_text(encoding="utf-8"))
        assert on_disk == {"presets": {}, "default_preset": None}
        assert (home / "subagent-presets.json").stat().st_mode & 0o777 == 0o600
    finally:
        manager.unload()


@pytest.mark.parametrize("call, message", [
    (dict(action="save", name="", settings={}), "1–80"),
    (dict(action="save", name="x" * 81, settings={}), "1–80"),
    (dict(action="save", name="bad\nname", settings={}), "1–80"),
    (dict(action="save", name="ok"), "requires settings"),
    (dict(action="save", name="ok", settings={"max_spawn_depth": 0}), "positive integer"),
    (dict(action="save", name="ok", settings={"backends": {"default": {"api_key": "sk"}}}), "credentials"),
    (dict(action="rename", name="missing", new_name="x"), "does not exist"),
    (dict(action="delete", name="missing"), "does not exist"),
    (dict(action="default", name="missing"), "does not exist"),
    (dict(action="erase"), "Unknown"),
])
def test_invalid_requests_are_refused_without_writing(tmp_path, monkeypatch, call, message):
    from agent.subagent_presets import presets

    home, manager = _home(tmp_path, monkeypatch, {}, plugins=())
    try:
        with pytest.raises(ValueError, match=message):
            presets(**call)
        assert not (home / "subagent-presets.json").exists()
    finally:
        manager.unload()


def test_duplicate_names_are_refused(tmp_path, monkeypatch):
    from agent.subagent_presets import presets

    _, manager = _home(tmp_path, monkeypatch, {}, plugins=())
    try:
        presets(action="save", name="a", settings={})
        presets(action="save", name="b", settings={})
        with pytest.raises(ValueError, match="already exists"):
            presets(action="save", name="a", settings={})
        with pytest.raises(ValueError, match="already exists"):
            presets(action="rename", name="a", new_name="b")
    finally:
        manager.unload()


def test_concurrent_saves_are_serialized_by_the_profile_lock(tmp_path, monkeypatch):
    """Each write is a read-modify-write under one lock: no concurrent save is lost."""
    from agent.subagent_presets import presets

    _, manager = _home(tmp_path, monkeypatch, {}, plugins=())
    errors = []

    def save(i):
        try:
            presets(action="save", name=f"p{i}", settings={"model": f"m{i}"})
        except Exception as exc:  # pragma: no cover - reported below
            errors.append(exc)
    try:
        threads = [threading.Thread(target=save, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert not errors
        assert [p["name"] for p in presets()["presets"]] == [f"p{i}" for i in range(8)]
    finally:
        manager.unload()


def test_failed_write_keeps_the_previous_library(tmp_path, monkeypatch):
    import utils
    from agent.subagent_presets import presets

    home, manager = _home(tmp_path, monkeypatch, {}, plugins=())
    try:
        presets(action="save", name="kept", settings={"model": "m"})
        before = (home / "subagent-presets.json").read_text(encoding="utf-8")

        def broken(*args, **kwargs):
            raise OSError("disk full")
        monkeypatch.setattr(utils, "atomic_json_write", broken)
        with pytest.raises(OSError):
            presets(action="save", name="lost", settings={"model": "m"})
        assert (home / "subagent-presets.json").read_text(encoding="utf-8") == before
    finally:
        manager.unload()


@pytest.mark.parametrize("text", MALFORMED.values(), ids=MALFORMED)
def test_management_reports_a_malformed_library_without_overwriting_it(tmp_path, monkeypatch, text):
    from agent.subagent_presets import presets

    home, manager = _home(tmp_path, monkeypatch, {}, plugins=())
    path = _write(home, text)
    try:
        for call in (lambda: presets(), lambda: presets(action="save", name="new", settings={"model": "m"}),
                     lambda: presets(action="default", name=None)):
            with pytest.raises(ValueError, match="subagent-presets.json"):
                call()
        assert path.read_text(encoding="utf-8") == text
    finally:
        manager.unload()


def test_empty_library_and_dangling_default_stay_manageable(tmp_path, monkeypatch):
    from agent.subagent_presets import presets

    home, manager = _home(tmp_path, monkeypatch, {}, plugins=())
    try:
        _write(home, "{}")
        assert presets() == {"presets": [], "default_preset": None}
        _write(home, '{"presets": {}, "default_preset": "gone"}')
        assert presets()["default_preset"] is None
        saved = presets(action="save", name="fast", settings={"model": "m"})
        assert [p["name"] for p in saved["presets"]] == ["fast"] and saved["default_preset"] is None
    finally:
        manager.unload()


def test_utf8_names_round_trip(tmp_path, monkeypatch):
    from agent.subagent_presets import presets

    home, manager = _home(tmp_path, monkeypatch, {}, plugins=())
    try:
        presets(action="save", name="快速 équipe", settings={"model": "m"})
        assert "快速 équipe" in (home / "subagent-presets.json").read_text(encoding="utf-8")
        assert [p["name"] for p in presets()["presets"]] == ["快速 équipe"]
    finally:
        manager.unload()


def test_saved_preset_keeps_credential_references_never_values(tmp_path, monkeypatch):
    from agent.subagent_presets import presets

    marker = "sk-preset-secret-marker"
    home, manager = _home(tmp_path, monkeypatch, {"model": "child-model", "api_key": marker,
                                                "base_url": "http://127.0.0.1:9/v1"}, plugins=())
    try:
        listed = presets(action="save", name="with-route", settings={"model": "m"})
        raw = (home / "subagent-presets.json").read_text(encoding="utf-8")
        assert marker not in raw and marker not in json.dumps(listed)
        assert "_credential_" not in json.dumps(listed)  # references stay server-side
    finally:
        manager.unload()
