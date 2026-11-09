"""Authenticated owner fixture: Desktop's per-child Steer/Stop reach only this session's children."""
import asyncio
import json
import os
from pathlib import Path
import sys
import traceback
import weakref


async def probe():
    from gateway.run import GatewayRunner
    from gateway.session_authority import initialize_session_authority
    from gateway.run_api import start_gateway_api, stop_gateway_api
    from hermes_cli import web_server
    from hermes_cli.dashboard_auth.ws_tickets import mint_ticket
    from tests.gateway.fixtures.local_recovery_probe import rpc
    from tools.delegate_tool_child_run import _register_child
    from tools.delegate_tool_registry import _close_subagent_steering, _unregister_subagent
    from websockets.asyncio.client import connect

    home = Path(os.environ['HERMES_HOME'])
    (home / 'config.yaml').write_text('gateway:\n  multiplex_profiles: false\nmodel:\n  provider: custom\n  default: no-inference\n  base_url: http://127.0.0.1:1/v1\nauxiliary:\n  title_generation:\n    enabled: false\n')
    runner = GatewayRunner()
    authority = await initialize_session_authority(runner, profile_id=str(home), instance_id='subagent-controls')
    api = await start_gateway_api(runner)
    web_server.app.state.auth_required = True
    receipt = {}

    class Agent:
        def __init__(self):
            self.steered, self.stopped = [], []

        def steer(self, text):
            self.steered.append(text)
            return True

        def hard_interrupt(self, message=None):
            self.stopped.append(message)
            return True

    ticket = mint_ticket(user_id='owner', provider='fixture')
    async with connect(api.api_origin.replace('http:', 'ws:') + '/api/ws?ticket=' + ticket) as ws:
        created = await rpc(ws, 'session.create', request_id='controls-owner', source='gui', toolsets=[])
        sid = created['result']['session_id']
        live = authority.sessions[sid]
        parent, other_parent = Agent(), Agent()
        parent.session_id, other_parent.session_id = sid, 'foreign-session'
        authority.db.create_session('foreign-session', source='subagent')
        with runner._agent_cache_lock:
            runner._agent_cache[live.route] = (parent, 'fixture')
        children = {}
        try:
            for name, ancestor in [('owned', parent), ('sibling', other_parent), ('nested', None)]:
                ancestor = ancestor or children['owned']
                child = children[name] = Agent()
                child._subagent_id = name
                child.session_id = 'stored-' + name
                child._session_db = authority.db
                authority.db.create_session(child.session_id, source='subagent', parent_session_id=ancestor.session_id,
                                            model_config={'_delegate_from': ancestor.session_id})
                authority.db.append_message(child.session_id, role='user', content=name + '-goal')
                child._delegate_parent_ref = weakref.ref(ancestor)
                child._parent_session_id = ancestor.session_id
                _register_child(child, ancestor, name + '-goal', owner_session_id=None,
                                owner_transport=None, owner_session_record=None)
            authority.db.append_message('stored-owned', role='assistant', content='', tool_calls=[{
                'id': 'nested-call', 'type': 'function', 'function': {'name': 'delegate_task',
                'arguments': json.dumps({'goal': 'nested-goal'})}}])
            watched = await rpc(ws, 'session.resume', session_id='stored-owned')
            assert 'result' in watched, watched
            viewer = watched['result']['session_id']
            snapshot = await rpc(ws, 'subagent.subject', session_id=viewer)
            receipt['subject'] = snapshot
            receipt['watch_children'] = await rpc(ws, 'subagent.list', session_id=viewer)
            receipt['watch_located'] = await rpc(ws, 'subagent.locate', session_id=viewer, tool_call_id='nested-call')
            receipt['watch_steer'] = await rpc(ws, 'subagent.steer', session_id=viewer, subagent_id='owned', text='watch steer')
            receipt['watch_stop'] = await rpc(ws, 'subagent.interrupt', session_id=viewer, subagent_id='owned')
            receipt['watch_sibling'] = await rpc(ws, 'subagent.interrupt', session_id=viewer, subagent_id='sibling')
            # The exact Desktop producer frames (subagent-controls.tsx).
            for name in ('owned', 'sibling'):
                steer = await rpc(ws, 'subagent.steer', session_id=sid, subagent_id=name, text='check ' + name)
                stop = await rpc(ws, 'subagent.interrupt', session_id=sid, subagent_id=name)
                receipt[name] = {'steer': steer.get('result', steer.get('error')),
                                 'stop': stop.get('result', stop.get('error'))}
            receipt['delivered'] = {name: [child.steered, len(child.stopped)] for name, child in children.items()}
            # A child past its final steer drain refuses instead of dropping the text.
            _close_subagent_steering('owned', children['owned'])
            late = await rpc(ws, 'subagent.steer', session_id=sid, subagent_id='owned', text='too late')
            receipt['late'] = late.get('result', late.get('error'))
        finally:
            for name, child in children.items():
                _unregister_subagent(name, agent=child)
    await stop_gateway_api(api)
    (home / 'receipt.json').write_text(json.dumps(receipt))


if __name__ == '__main__':
    status = 0
    try:
        asyncio.run(probe())
    except BaseException:
        traceback.print_exc()
        status = 1
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(status)