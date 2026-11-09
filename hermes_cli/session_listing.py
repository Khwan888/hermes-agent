"""Shared session-listing helpers for CLI and gateway slash surfaces."""

from __future__ import annotations

import shlex
from pathlib import Path
from typing import Any

from utils import is_truthy_value

_LIST_WORDS = {"list", "ls", "browse"}
_SEARCH_WORDS = {"search", "find"}
SUBAGENT_SOURCE = "subagent"


def show_subagent_sessions(hermes_home: str | Path) -> bool:
    """``sessions.show_subagents`` from *hermes_home*'s own config.yaml. One ``serve`` lists many
    profiles' stores, so the store's home decides, never the process ``HERMES_HOME``. False when
    the config cannot be read (the listing keeps its default shape)."""
    from hermes_cli.config import load_config_readonly
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    token = set_hermes_home_override(str(hermes_home))
    try:
        sessions_cfg = load_config_readonly().get("sessions") or {}
    except Exception:
        return False
    finally:
        reset_hermes_home_override(token)
    return isinstance(sessions_cfg, dict) and is_truthy_value(sessions_cfg.get("show_subagents"))


def subagent_listing_scope(
    hermes_home: str | Path, *, source: str | None = None, sources: list[str] | None = None,
    exclude_sources: list[str] | None = None,
) -> tuple[bool, list[str] | None]:
    """``(include_subagents, exclude_sources)`` for one human-facing session list (#97202).

    With ``sessions.show_subagents`` on, delegate runs join a list that is not scoped to named
    sources and either has no exclusions or excludes the ``subagent`` source itself (the desktop
    recents shape); that exclusion is dropped so the runs actually land. A slice that excludes
    other sources without ``subagent`` (the per-platform messaging lists) keeps its shape.
    """
    excluded = list(exclude_sources or [])
    if source or sources or (excluded and SUBAGENT_SOURCE not in excluded):
        return False, exclude_sources
    if not show_subagent_sessions(hermes_home):
        return False, exclude_sources
    return True, [s for s in excluded if s != SUBAGENT_SOURCE] or None


# An atomic rotation inserts its child moments before stamping the parent's ended_at,
# so the boundary allows that skew; a subagent the parent spawned earlier predates it.
_ROTATION_SKEW_SECONDS = 5.0


# Match markers to this edge: rotations inherit model_config, so marker presence
# alone would turn every compressed subagent segment into another subagent. An
# unmarked (source-only) child that started before the rotation is not the
# continuation, however its parent later ended.
def _compression_edge_sql() -> str:
    from hermes_state_common import _non_continuation_child_sql

    return ("COALESCE(parent.end_reason = 'compression', 0) "
            "AND child.profile_name IS parent.profile_name "
            "AND COALESCE(child.source, '') = COALESCE(parent.source, '') "
            f"AND COALESCE(child.started_at >= parent.ended_at - {_ROTATION_SKEW_SECONDS}, 1) "
            + _non_continuation_child_sql('child.', 'parent.id'))


def _subagent_child_sql() -> str:
    """``child`` is a subagent of ``parent`` (the one predicate every subagent count and roll-up shares)."""
    from hermes_state_common import _sql_json_extract, _legacy_reset_child_sql, _RESET_END_REASONS_SQL

    compression = _compression_edge_sql()
    delegate = _sql_json_extract('child.model_config', '$._delegate_from')
    branch = _sql_json_extract('child.model_config', '$._branched_from')
    reset = _sql_json_extract('child.model_config', '$._reset_from')
    return f"""child.profile_name IS parent.profile_name AND child.hidden = 0
          AND COALESCE({branch}, '') != parent.id
          AND COALESCE({reset}, '') != parent.id
          AND NOT COALESCE(parent.end_reason = 'branched'
                           AND child.started_at >= parent.ended_at, 0)
          AND NOT ({_legacy_reset_child_sql('child', _RESET_END_REASONS_SQL)})
          AND ({delegate} = parent.id OR
               (child.source = 'subagent' AND NOT ({compression})))"""


def _subagent_family_sql(session_ids: list[str]) -> str:
    compression = _compression_edge_sql()
    return f"""WITH RECURSIVE family(owner_id, id) AS (
        SELECT id, id FROM sessions WHERE id IN ({','.join('?' for _ in session_ids)})
        UNION
        SELECT f.owner_id, parent.id FROM family f
        JOIN sessions child ON child.id = f.id
        JOIN sessions parent ON parent.id = child.parent_session_id
        WHERE {compression}
        UNION
        SELECT f.owner_id, child.id FROM family f
        JOIN sessions parent ON parent.id = f.id
        JOIN sessions child ON child.parent_session_id = parent.id
        WHERE {compression}
    ), subagents AS (
        SELECT DISTINCT f.owner_id, child.id FROM family f
        JOIN sessions parent ON parent.id = f.id
        JOIN sessions child ON child.parent_session_id = parent.id
        WHERE {_subagent_child_sql()}
    ) """


def annotate_subagent_counts(db: Any, sessions: list[dict[str, Any]]) -> None:
    """Add direct (not recursive) subagent counts after the parent page is cut.

    Shared by every rich listing, including the cross-profile sidebar. Only
    this store's page ids seed the walk; transcripts and off-page rows are not
    hydrated. Archived/empty subagents remain discoverable; hidden subagents do not.
    """
    from hermes_state_common import _id_chunks

    counts = {}
    for ids in _id_chunks([s['id'] for s in sessions]):
        rows = db._read_all(_subagent_family_sql(ids) +
                            "SELECT owner_id, COUNT(*) AS n FROM subagents GROUP BY owner_id", ids)
        counts.update((row['owner_id'], row['n']) for row in rows)
    for session in sessions:
        session['subagent_count'] = counts.get(session['id'], 0)
    annotate_subagent_attention(db, [s for s in sessions if s['subagent_count']])


# Stored end reasons of a subagent that ended on an existing limit (tools/delegate_tool_attention.py).
_OVER_BUDGET_END_REASONS_SQL = "'subagent_max_iterations'"
# Nesting is bounded by delegation.max_spawn_depth; the bound only stops a corrupt parent cycle.
_ATTENTION_MAX_DEPTH = 8


def _subagent_attention_sql(session_ids: list[str]) -> str:
    """Per owner: unread subagents at ANY depth (each subagent's compression lineage is one subagent) and, among
    them, those that ended over budget. ``subagent_id`` is the subagent root a lineage segment belongs to."""
    from hermes_state_common import _sql_session_last_active

    compression = _compression_edge_sql()
    return f"""WITH RECURSIVE tree(owner_id, id, subagent_id, depth) AS (
        SELECT id, id, '', 0 FROM sessions WHERE id IN ({','.join('?' for _ in session_ids)})
        UNION
        SELECT t.owner_id, parent.id, t.subagent_id, t.depth FROM tree t
        JOIN sessions child ON child.id = t.id
        JOIN sessions parent ON parent.id = child.parent_session_id
        WHERE {compression}
        UNION
        SELECT t.owner_id, child.id, t.subagent_id, t.depth FROM tree t
        JOIN sessions parent ON parent.id = t.id
        JOIN sessions child ON child.parent_session_id = parent.id
        WHERE {compression}
        UNION
        SELECT t.owner_id, child.id, child.id, t.depth + 1 FROM tree t
        JOIN sessions parent ON parent.id = t.id
        JOIN sessions child ON child.parent_session_id = parent.id
        WHERE t.depth < {_ATTENTION_MAX_DEPTH} AND {_subagent_child_sql()}
    ), subagent_state AS (
        SELECT t.owner_id, t.subagent_id,
               MAX(s.last_read_at IS NOT NULL AND {_sql_session_last_active('s')} > s.last_read_at) AS unread,
               MAX(COALESCE(s.end_reason IN ({_OVER_BUDGET_END_REASONS_SQL}), 0)) AS over_budget
        FROM tree t JOIN sessions s ON s.id = t.id
        WHERE t.subagent_id != ''
        GROUP BY t.owner_id, t.subagent_id
    )
    SELECT owner_id, SUM(unread) AS unread, SUM(unread AND over_budget) AS over_budget
    FROM subagent_state GROUP BY owner_id"""


def annotate_subagent_attention(db: Any, sessions: list[dict[str, Any]]) -> None:
    """``subagent_attention: {unread, over_budget}`` over every descendant subagent (zeros when none need the human).
    One batched query per page chunk; callers pass only rows that have subagents."""
    from hermes_state_common import _id_chunks

    rows = {}
    for ids in _id_chunks([s['id'] for s in sessions]):
        rows.update((row['owner_id'], dict(row)) for row in db._read_all(_subagent_attention_sql(ids), ids))
    for session in sessions:
        # Explicit zeros, not an absent key: clients merge list pages over cached rows, and an absent key
        # would keep a roll-up the human already cleared.
        row = rows.get(session['id']) or {}
        session['subagent_attention'] = {'unread': row.get('unread') or 0, 'over_budget': row.get('over_budget') or 0}




def query_session_subagents(db: Any, session_id: str, *, limit: int, offset: int) -> dict[str, Any]:
    """A bounded page of direct subagents across the parent's compression lineage.

    Select ids before the normal rich-row projection. No pinned backfill and no
    transcript reads; a subagent's own compression segments occupy just one slot.
    """
    sql = _subagent_family_sql([session_id])
    total = db._read_one(sql + "SELECT COUNT(*) FROM subagents", [session_id])[0]
    page = db._read_all(sql + """SELECT h.id FROM subagents h
        JOIN sessions s ON s.id = h.id
        ORDER BY s.started_at DESC, s.id DESC LIMIT ? OFFSET ?""", [session_id, limit, offset])
    ids = [row['id'] for row in page]
    sessions = _project_subagent_rows(db, ids)
    annotate_subagent_counts(db, sessions)
    for session in sessions:
        session['unread'] = db.session_unread(session)
        session['is_internal_child'] = True
    return dict(sessions=sessions, total=total, limit=limit, offset=offset,
                has_more=offset + len(sessions) < total)


def _project_subagent_rows(db: Any, ids: list[str]) -> list[dict[str, Any]]:
    if not ids:
        return []
    # family follows compression only: no nested subagent, branch or reset can
    # supply a tip. UNION terminates corrupt cycles without a recursive blowup.
    rows = db._read_all(_subagent_family_sql(ids) + f"""SELECT f.owner_id, f.id,
        NOT EXISTS (SELECT 1 FROM sessions parent
                    JOIN sessions child ON child.parent_session_id = parent.id
                    WHERE parent.id = f.id AND {_compression_edge_sql()}) AS is_tip
        FROM family f JOIN sessions s ON s.id = f.id
        ORDER BY s.started_at DESC, s.id DESC""", ids)
    chains: dict[str, list[str]] = {}
    tips = {}
    for row in rows:
        chains.setdefault(row['owner_id'], []).append(row['id'])
        if row['is_tip']:
            tips.setdefault(row['owner_id'], row['id'])
    rich = db._get_session_rich_rows_batch(set(ids) | set(tips.values()), compact_rows=True)
    result = []
    for sid in ids:
        session = dict(rich[sid])
        tip = tips.get(sid, sid)
        if tip != sid:
            session.update(rich[tip])
            session.update(started_at=rich[sid]['started_at'],
                           parent_session_id=rich[sid]['parent_session_id'],
                           _lineage_root_id=sid, _lineage_ids=chains[sid],
                           continuation_kind='compression')
            session['title'] = session.get('title') or rich[sid].get('title')
        result.append(session)
    return result


def parse_session_listing_args(raw_args: str) -> tuple[bool, bool, str, str | None]:
    """Parse `/sessions`-style args into ``(include_all_sources, include_unnamed, target, search_query)``.

    ``all`` widens source scope, ``full`` keeps unnamed sessions, ``search``/``find`` makes the rest
    a query (``None`` = not requested, ``""`` = requested with no terms). Flags are honored only
    before the first positional word so titles containing "all" aren't misparsed; anything else is
    a target so `/sessions <id-or-title>` can delegate to `/resume`.
    """
    parts = shlex.split(raw_args or "")
    flags = {"all": False, "full": False}
    target_parts: list[str] = []
    for i, part in enumerate(parts):
        lower = part.strip().lower()
        if not target_parts:
            if lower in _LIST_WORDS:
                continue
            if lower in {"all", "--all", "full", "--full"}:
                flags[lower.lstrip("-")] = True
                continue
            if lower in _SEARCH_WORDS:
                return flags["all"], flags["full"], "", " ".join(parts[i + 1:]).strip()
        target_parts.append(part)
    return flags["all"], flags["full"], " ".join(target_parts).strip(), None


def query_session_listing(
    session_db: Any,
    *,
    source: str | None,
    session_key: str | None = None,
    current_session_id: str | None = None,
    include_current_session: bool = False,
    include_all_sources: bool = False,
    include_unnamed: bool = False,
    search_query: str | None = None,
    limit: int = 10,
    exclude_sources: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Return session rows for interactive listing surfaces (shared CLI/gateway policy).

    Source-scoped unless global is requested; unnamed hidden unless a full listing is asked for;
    current session hidden unless requested (then marked ``is_current_session``); ``session_key``
    restricts gateway callers to one lane before the DB limit applies. With ``search_query`` rows
    are filtered by title/id in SQL, ordered by recent activity, and unnamed sessions stay visible
    since an id match may be the only handle.
    """
    search = (search_query or "").strip()
    rows = session_db.list_sessions_rich(
        source=None if include_all_sources else source,
        session_key=session_key,
        exclude_sources=exclude_sources,
        limit=max(limit * 4, limit),
        search_query=search or None,
        order_by_last_active=bool(search),
    )
    result: list[dict[str, Any]] = []
    for row in rows:
        is_current = bool(current_session_id and row.get("id") == current_session_id)
        if (is_current and not include_current_session) or (
            not include_unnamed and not row.get("title") and not search and not is_current
        ):
            continue
        result.append({**row, "is_current_session": True} if is_current else row)
        if len(result) >= limit:
            break
    return result


def format_gateway_session_listing(
    rows: list[dict[str, Any]],
    *,
    include_source: bool = False,
    title: str = "Sessions",
    notice: str | None = None,
) -> str:
    """Render a compact Markdown-ish session list for gateway messengers.

    ``notice`` adds an explanatory line above the footer — e.g. when a requested scope widening
    (``all``) was declined, so the caller isn't left guessing why sessions are missing.
    """
    if not rows:
        return "\n".join([
            "No sessions found.\n"
            "Use `/title My Session` to name this chat, or `/sessions full` "
            "to include unnamed sessions.",
            *([notice] if notice else []),
        ])
    lines = [f"📋 **{title}**", ""]
    for idx, row in enumerate(rows, start=1):
        current_part = " (current)" if row.get("is_current_session") else ""
        preview = str(row.get("preview") or "")[:40]
        source = str(row.get("source") or "")
        source_part = f" `{source}`" if include_source and source else ""
        preview_part = f" — _{preview}_" if preview else ""
        lines.append(
            f"{idx}. **{row.get('title') or '—'}**{current_part}{source_part}"
            f" — `{row.get('id') or ''}`{preview_part}"
        )
    return "\n".join([
        *lines, "", *([notice] if notice else []),
        "Resume: `/resume <session id>` or `/resume <number>` from `/resume`.",
        "More: `/sessions all`, `/sessions full`, `/sessions search <query>`.",
    ])
