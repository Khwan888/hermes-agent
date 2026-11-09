# Per-conversation delegation policy

A conversation captures delegation settings with its tool definitions. Profile defaults still select the initial route; an explicit per-chat override is stored in that session, not in `config.yaml`. Running children retain their launch snapshot.

Both native gateway transports expose `delegation.settings`:

```json
{"method":"delegation.settings","params":{"session_id":"<session-id>"}}
{"method":"delegation.settings","params":{"session_id":"<session-id>","override":{"model":"child-model","reasoning_effort":"high","max_spawn_depth":2,"max_concurrent_children":2}}}
{"method":"delegation.settings","params":{"session_id":"<session-id>","override":null}}
```

Omitting `session_id` reads profile defaults only. Writes require an owned session and its existing control authority. `override` replaces the previous override; `null` captures the current profile defaults again. The result includes `override`, sanitized `effective` settings, `defaults`, `available_backends` and `pending_schema`.

`session.create` accepts an optional `delegation_override` with the same fields. Available override fields are `backend`, `model`, `provider`, `reasoning_effort`, `max_spawn_depth`, `max_concurrent_children` and `backends`. No delegation plugin is required to use the built-in backend. Nested backend routes retain provider-extension JSON fields, but known route fields are type-checked before persistence. Credentials (keys such as `api_key`, `Authorization`, `X-API-Key` or `access_token`, in any case or separator, and every value in a request-header map) and commands are refused before anything is stored; keep them in the profile config.

## Application boundaries

- Compatible route, effort and limit changes affect future spawns, including later calls in an active turn. Existing tool definitions are not rewritten mid-turn.
- A backend edit that changes the advertised per-task parameters or guidance reports `pending_schema: true`. The explicit edit takes effect at the next turn boundary, where tools and routing are rebuilt and pinned together.
- Resume restores the settings captured with the tools; a later profile route edit cannot silently change what the old schema's route names mean.
- Capacity belongs to the conversation, not the whole process. Lowering the limit does not kill existing children. Queued children can be stopped without waiting for an occupied slot and cannot execute late after cancellation. A child whose wait timed out returns at once but keeps its slot until its worker actually finishes unwinding. Detached background children retain the existing rule: stopping the parent turn alone does not cancel them.
- Ignore-user-config sessions use built-in defaults plus explicit chat selections. Managed workers keep using their frozen configuration and existing safe-worker restrictions.

Snapshots store credential references, not credential values. Each credential belongs to its own route — the top level, a backend block, a named route, or an unnamed `fallback_providers` entry — and is bound to that route's provider and endpoint. Spawn resolves the references under their owning profile: a rotated key on the same endpoint is picked up, a reordered fallback list still pairs each key with its own endpoint, and a removed route or a changed provider/endpoint is refused rather than pairing a new key with an old endpoint.

The new create field is optional and old payloads remain accepted. Older gateways implement neither `delegation.settings` nor the create field (they reject `delegation_override` as `invalid_params`). Clients must check availability first and omit the field when it is unavailable, never falling back to a profile-wide write. Older tool pins without a full policy snapshot can retain their captured backend, but cannot recover route values that were never stored.

## Profile subagent presets

A profile can keep named presets in `subagent-presets.json` in its Hermes home. Desktop manages them under **Settings → Model → Subagents**; both native transports expose `delegation.presets`:

```json
{"method":"delegation.presets","params":{}}
{"method":"delegation.presets","params":{"action":"save","name":"fast-team","settings":{"model":"child-model","max_spawn_depth":2}}}
{"method":"delegation.presets","params":{"action":"rename","name":"fast-team","new_name":"research"}}
{"method":"delegation.presets","params":{"action":"default","name":"research"}}
{"method":"delegation.presets","params":{"action":"delete","name":"research"}}
```

Every call returns `{presets: [{name, settings}], default_preset}`. A saved preset is a snapshot of the profile defaults at save time plus the supplied fields (`{}` saves the current defaults); it uses the same field validation as `override` and keeps credential references, never values. `default` with `name: null` clears the default. Reads need session read access; changes are profile-wide writes, so the native gateway accepts them only from the profile's operator connection. Writes are serialized by a lock file next to the library and replace it atomically.

A new chat that is given `delegate_task` and has no explicit override starts from the default preset; `delegation.settings` reports its name as `preset_name`. Only then is the library read. Existing chats, resumed chats and running children keep what they captured, so renaming, deleting or changing the default affects new chats only. Resetting a chat's override (`null`) returns it to the plain profile defaults. Ignore-user-config chats and managed workers never read the library.

The library is optional. A missing, empty or malformed file never stops a chat from starting: chats fall back to the profile defaults and a warning is logged. Management calls report the problem instead, and the file is left untouched so it can be repaired. Older gateways do not implement `delegation.presets`; clients should hide preset controls on method-not-found.
