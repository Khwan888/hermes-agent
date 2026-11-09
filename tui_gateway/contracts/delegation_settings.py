"""Per-chat subagent policy, on both native transports."""

from __future__ import annotations

from .base import JsonValue, Params, Result
from .registry import canonical_method, method


class DelegationSettingsParams(Params):
    profile: str | None = None
    session_id: str | None = None
    override: dict[str, JsonValue] | None = None


class DelegationSettingsResult(Result):
    override: dict[str, JsonValue] | None
    effective: dict[str, JsonValue]
    defaults: dict[str, JsonValue]
    available_backends: list[str]
    pending_schema: bool = False


for register in (method, canonical_method):
    register("delegation.settings", params=DelegationSettingsParams, result=DelegationSettingsResult,
             doc="Read defaults or read/replace one chat's durable subagent settings. Existing children keep their policy.")
