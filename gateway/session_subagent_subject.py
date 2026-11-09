"""A subagent page observes/controls its own child, never attaches the parent's transport."""
from pathlib import Path
import sys

from gateway.session_busy_controls import authorize
from hermes_state_runtime import RuntimeStoreError


def subject_record(authority, session_id):
    """An exact child of this profile's database, including its pre-compression origin."""
    registry = sys.modules.get('tools.delegate_tool_registry')
    if registry is None:
        return None
    expected = Path(authority.db.db_path).resolve()
    with registry._active_subagents_lock:
        for record in registry._active_subagents.values():
            child = record.get('agent')
            if session_id not in (getattr(child, 'session_id', None), record.get('child_origin_session_id')):
                continue
            child_path = getattr(getattr(child, '_session_db', None), 'db_path', None)
            if child_path is not None and Path(child_path).resolve() == expected:
                return dict(record)
    return None


def require_subagent_read_owner(authority, ref):
    """A live child's read-only mount has no writer route generation of its own.

    Its exact database-qualified registry identity authorizes descendant reads;
    every normal conversation still needs the current writer-generation guard.
    This never grants the viewer parent-style control over other children.
    """
    from gateway.session_ancillary import _require_current_route, physical_target
    if subject_record(authority, physical_target(authority, ref)) is None:
        _require_current_route(authority, ref)


async def subject(connection, ref, params):
    if set(params) - {'session_id', 'profile'} or not ref.session_id:
        raise RuntimeStoreError('invalid_params')
    authorize(connection, ref, params, 'session:read')
    from gateway.session_ancillary import subagent_row
    authority = connection.authority
    record = subject_record(authority, ref.session_id)
    if record is not None:
        return {'available': True, 'parent_session_id': record.get('owner_agent_session_id'),
                'subagent': subagent_row(record)}
    from tools.delegate_tool_usage import stored_subagent
    row = authority.db.get_session(ref.session_id)
    return {'available': False, 'parent_session_id': row.get('parent_session_id') if row else None,
            'subagent': stored_subagent(authority.db, ref.session_id)}


def controlled_child(connection, ref, params):
    """Read ownership + explicit control capability on an attached child page, not history write access.

    The mount remains read-only for prompt/rewind/reset. Only its exact live subagent
    can be steered/stopped; a sibling id still takes the ordinary parent-owner check.
    """
    authorize(connection, ref, params, 'session:read')
    record = subject_record(connection.authority, ref.session_id)
    if record is None or record.get('subagent_id') != params.get('subagent_id'):
        return None
    if ref.session_id not in connection.subscriptions or 'session:control' not in connection.actor.capabilities:
        raise RuntimeStoreError('permission_denied')
    return record['agent']
