"""Profile-owned subagent presets: named snapshots of the built-in delegation policy.

The library lives in the owning profile (``subagent-presets.json``). Entries hold the same public fields as
a chat's settings plus credential *references*, never credential values. A chat captures a preset's settings
when it starts, so later library edits never change an existing chat. The library is optional: an unreadable
file is reported to the management calls and left untouched for recovery, while ordinary chats fall back to
the profile defaults.
"""

from __future__ import annotations

import json
import logging
from contextlib import contextmanager

logger = logging.getLogger(__name__)

_FILE = "subagent-presets.json"
_ACTIONS = frozenset({"list", "save", "rename", "delete", "default"})


class PresetLibraryError(ValueError):
    """The on-disk library is unusable. The file is left untouched so the user can recover it."""


def _path():
    from hermes_constants import get_hermes_home
    return get_hermes_home() / _FILE


def _parse(path):
    """The validated library envelope. ``{}`` is an empty library; anything else malformed raises."""
    from agent.delegation_settings import validate_fields

    def bad(detail):
        return PresetLibraryError(f"Subagent preset library {path.name} is malformed ({detail}); "
                                  "fix or remove the file. It was not modified.")
    try:
        state = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise bad(f"unreadable JSON: {type(exc).__name__}") from exc
    if not isinstance(state, dict):
        raise bad("not a JSON object")
    library, default = state.setdefault("presets", {}), state.setdefault("default_preset", None)
    if not isinstance(library, dict):
        raise bad("'presets' is not an object")
    if default is not None and not isinstance(default, str):
        raise bad("'default_preset' is not a name")
    for name, entry in library.items():
        if not isinstance(entry, dict):
            raise bad(f"preset {name!r} is not an object")
        try:
            validate_fields({k: v for k, v in entry.items() if not k.startswith("_credential_")})
        except ValueError as exc:
            raise bad(f"preset {name!r}: {exc}") from exc
        if not isinstance(entry.get("_credential_refs", []), list) or not isinstance(
                entry.get("_credential_home", ""), str):
            raise bad(f"preset {name!r} has malformed credential references")
    return state


@contextmanager
def _library():
    """The library under the profile's exclusive lock; writes inside are atomic replacements."""
    from hermes_cli.active_sessions import _FileLock

    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with _FileLock(path.with_suffix(".lock"), timeout=10):
        yield _parse(path) if path.exists() else {"presets": {}, "default_preset": None}


def _default_name(state):
    name = state["default_preset"]
    return name if name in state["presets"] else None


def _save(state):
    from utils import atomic_json_write
    atomic_json_write(_path(), state, mode=0o600, fsync_dir=True)


def _name(value):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 80 or any(
            ord(ch) < 32 for ch in value):
        raise ValueError("Preset name must contain 1–80 printable characters.")
    return value.strip()


def default_preset():
    """``(name, settings)`` of the profile default, or ``(None, None)``.

    Never raises: the library is optional, so an unreadable one must not stop a chat from starting.
    Safe workers and chats that ignore user config never read it (the library is user config too)."""
    from agent.delegation_settings import user_config_ignored
    from agent.safe_worker_policy import safe_worker_enabled, worker_config_snapshot
    if safe_worker_enabled() or worker_config_snapshot() is not None or user_config_ignored():
        return None, None
    if not _path().exists():
        return None, None  # no library: no lock file, no directory, nothing written
    try:
        with _library() as state:
            name = _default_name(state)
            if state["default_preset"] is not None and name is None:
                logger.warning("Default subagent preset %r is missing from %s; using profile defaults.",
                               state["default_preset"], _FILE)
            return name, state["presets"][name] if name else None
    except (PresetLibraryError, OSError, RuntimeError) as exc:
        logger.warning("%s Using profile subagent defaults.", exc)
        return None, None


def presets(*, action="list", name=None, new_name=None, settings=None):
    """List the library, or save/rename/delete a preset, or choose (``None`` clears) the default."""
    from agent.delegation_settings import _public, profile_defaults, validate_override

    if action not in _ACTIONS:
        raise ValueError("Unknown subagent preset action.")
    with _library() as state:
        library = state["presets"]
        if action == "save":
            name = _name(name)
            if name in library:
                raise ValueError(f"Subagent preset {name!r} already exists.")
            if not isinstance(settings, dict):
                raise ValueError("Saving a preset requires settings.")
            from agent.delegation_credentials import merge_settings, normalize_override, protect
            defaults = profile_defaults()
            supplied = validate_override(normalize_override(settings, defaults))
            merged = protect(merge_settings(defaults, supplied))
            library[name] = {**_public(merged), **{k: v for k, v in merged.items() if k.startswith("_credential_")}}
        elif action in {"rename", "delete"}:
            name = _name(name)
            if name not in library:
                raise ValueError(f"Subagent preset {name!r} does not exist.")
            if action == "rename":
                new_name = _name(new_name)
                if new_name in library:
                    raise ValueError(f"Subagent preset {new_name!r} already exists.")
                library[new_name] = library.pop(name)
            else:
                library.pop(name)
            if state["default_preset"] == name:
                state["default_preset"] = new_name if action == "rename" else None
        elif action == "default":
            name = None if name is None else _name(name)
            if name is not None and name not in library:
                raise ValueError(f"Subagent preset {name!r} does not exist.")
            state["default_preset"] = name
        state["default_preset"] = _default_name(state)  # a dangling default is shown and saved as none
        if action != "list":
            _save(state)
        return {"presets": [{"name": n, "settings": _public(s)} for n, s in sorted(library.items())],
                "default_preset": state["default_preset"]}
