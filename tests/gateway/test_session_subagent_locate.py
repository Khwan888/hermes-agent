"""``subagent.locate``: a transcript card's ``delegate_task`` call names the stored subagent behind each task.

Through the canonical dispatch on a real gateway runtime and SessionDB: the call's own result ids win, a
result that names no child (every call stored before those keys existed) still links each task by the
stored delegation, and another conversation's call or subagent is never answered.
"""
import asyncio
import json
from pathlib import Path

from gateway.config import GatewayConfig
from gateway.run import GatewayRunner
from gateway.run_runtime import initialize_gateway_runtime
from gateway.runtime_ownership import process_ownership


def _call(db, session, call_id, goals, ts, result):
    db.append_message(session, role='assistant', content='', timestamp=ts, tool_calls=[{
        'id': call_id, 'type': 'function',
        'function': {'name': 'delegate_task', 'arguments': json.dumps({'tasks': [{'goal': g} for g in goals]})}}])
    db.append_message(session, role='tool', tool_name='delegate_task', tool_call_id=call_id, timestamp=ts + 0.5,
                      content=json.dumps(result))


def _child(db, sid, parent, goal, started, **marker):
    db.create_session(sid, source='subagent', parent_session_id=parent, model_config={'_delegate_from': parent, **marker})
    db._execute_write(lambda conn: conn.execute('UPDATE sessions SET started_at = ? WHERE id = ?', (started, sid)))
    db.append_message(sid, role='user', content=goal)


def test_a_card_locates_its_subagents_by_result_ids_and_by_stored_delegation(tmp_path, monkeypatch):
    asyncio.run(_locates(tmp_path, monkeypatch))


async def _locates(tmp_path, monkeypatch):
    from gateway import run
    from gateway.session_ancillary import physical_target
    from gateway.session_authorities import owner_scope
    from gateway.session_controls import AuthorityConnection
    from gateway.session_local import create_local_session

    monkeypatch.setattr(run, '_load_gateway_config', lambda *a: {
        'platform_toolsets': {'cli': [], 'tui': []},
        'model': {'provider': 'custom', 'base_url': 'http://127.0.0.1:9/v1', 'api_key': 'loopback-only'}})
    root = tmp_path / '.hermes'
    root.mkdir(mode=0o700)
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    monkeypatch.setenv('HERMES_HOME', str(root))
    import hermes_state
    monkeypatch.setattr(hermes_state, 'DEFAULT_DB_PATH', hermes_state._IMPORT_DEFAULT_DB_PATH)
    homes = [('default', root)]
    config = GatewayConfig()
    config._runtime_profile_homes = tuple(homes)
    runner = GatewayRunner(config)
    process_ownership.reserve([root])
    connection = None
    try:
        await initialize_gateway_runtime(runner)
        authority = runner.session_authorities.for_home(root)
        connection = AuthorityConnection(authority, object(), {'user_id': 'human'})
        with owner_scope(authority):
            ref = create_local_session(authority, connection.actor, dict(
                request_id='desktop', source='tui', cwd=str(tmp_path), model='default-a', toolsets=[]))
        parent = physical_target(authority, ref)
        db = authority.db
        db.create_session('other', source='cli')
        # A new call: its result names the children.
        _child(db, 'alpha', parent, 'alpha goal', 1000.2)
        _child(db, 'beta', parent, 'beta goal', 1000.3)
        _call(db, parent, 'call-new', ['alpha goal', 'beta goal'], 1000.0,
              {'status': 'dispatched', 'child_session_ids': ['alpha', 'beta']})
        # An old call: no ids anywhere, one task never started (refused); another conversation's same goal.
        _child(db, 'legacy', parent, 'legacy goal', 2000.2)
        _child(db, 'decoy', 'other', 'legacy goal', 2000.1)
        _call(db, parent, 'call-old', ['legacy goal', 'refused goal'], 2000.0, {'status': 'dispatched'})
        _call(db, 'other', 'call-foreign', ['legacy goal'], 2000.0, {'status': 'dispatched'})

        async def locate(call_id):
            response = await connection.dispatch({'id': 1, 'method': 'subagent.locate', 'params': {
                'session_id': ref.session_id, 'tool_call_id': call_id}})
            assert 'result' in response, response
            return [(c['task_index'], c['child_session_id'], c['running']) for c in response['result']['children']]

        assert await locate('call-new') == [(0, 'alpha', False), (1, 'beta', False)]
        assert await locate('call-old') == [(0, 'legacy', False), (1, None, False)]
        assert await locate('call-foreign') == []
        # A read-only, detached child is a history mount, not a writer route.
        # The nested call may have been interrupted before producing a tool result.
        _child(db, 'gamma', 'beta', 'gamma goal', 3000.2)
        db.append_message('beta', role='assistant', content='beta delegating', timestamp=3000.0, tool_calls=[{
            'id': 'call-nested', 'type': 'function',
            'function': {'name': 'delegate_task', 'arguments': json.dumps({'goal': 'gamma goal'})}}])
        authority._native_legacy_transports = {connection.actor.transport_id: connection.actor}
        resumed = await connection.dispatch({'id': 3, 'method': 'session.resume', 'params': {'session_id': 'beta'}})
        assert 'result' in resumed, resumed
        nested = await connection.dispatch({'id': 4, 'method': 'subagent.locate', 'params': {
            'session_id': resumed['result']['session_id'], 'tool_call_id': 'call-nested'}})
        assert nested.get('result', {}).get('children') == [
            {'task_index': 0, 'child_session_id': 'gamma', 'running': False}], nested
        foreign = await connection.dispatch({'id': 5, 'method': 'subagent.locate', 'params': {
            'session_id': resumed['result']['session_id'], 'tool_call_id': 'call-foreign'}})
        assert foreign.get('result', {}).get('children') == [], foreign
        outsider = AuthorityConnection(authority, object(), {'user_id': 'outsider'})
        try:
            denied = await outsider.dispatch({'id': 6, 'method': 'subagent.locate', 'params': {
                'session_id': resumed['result']['session_id'], 'tool_call_id': 'call-nested'}})
            assert 'error' in denied, denied
        finally:
            await outsider.close()
        bad = await connection.dispatch({'id': 2, 'method': 'subagent.locate', 'params': {
            'session_id': ref.session_id}})
        assert 'error' in bad, bad
    finally:
        if connection is not None:
            await connection.close()
        for each in list(getattr(runner, 'session_authorities', []) or []):
            each.db.close()
        process_ownership.release(root)
