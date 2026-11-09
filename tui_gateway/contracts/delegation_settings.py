"""Per-chat subagent policy and the profile's subagent presets, on both native transports."""

from __future__ import annotations

from typing import Literal

from .base import JsonValue, Params, Result
from .registry import canonical_method, method


class DelegationSettingsParams(Params):
    profile: str | None = None
    session_id: str | None = None
    override: dict[str, JsonValue] | None = None
    preset_name: str | None = None


class DelegationSettingsResult(Result):
    override: dict[str, JsonValue] | None
    effective: dict[str, JsonValue]
    defaults: dict[str, JsonValue]
    available_backends: list[str]
    pending_schema: bool = False
    preset_name: str | None = None


class DelegationPresetsParams(Params):
    profile: str | None = None
    action: Literal["list", "save", "rename", "delete", "default"] = "list"
    name: str | None = None
    new_name: str | None = None
    settings: dict[str, JsonValue] | None = None


class DelegationPreset(Result):
    name: str
    settings: dict[str, JsonValue]


class DelegationPresetsResult(Result):
    presets: list[DelegationPreset]
    default_preset: str | None


for register in (method, canonical_method):
    register("delegation.settings", params=DelegationSettingsParams, result=DelegationSettingsResult,
             doc="Read defaults, or replace one chat's durable subagent settings (override or a captured preset). "
                 "Existing children keep their policy.")
    register("delegation.presets", params=DelegationPresetsParams, result=DelegationPresetsResult,
             doc="List, save, rename or delete the profile's subagent presets, or choose the one new chats start from.")
