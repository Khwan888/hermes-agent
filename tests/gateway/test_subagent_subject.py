"""A read-only child mount can control ONLY the child it displays, through the real owner socket."""
import json
from pathlib import Path
import subprocess
import sys

from tests.gateway.fixtures.local_recovery_probe import child_env


def test_subagent_page_resolves_and_controls_own_child_but_refuses_sibling(tmp_path):
    root = Path(__file__).resolve().parents[2]
    home, user = tmp_path / 'state', tmp_path / 'user'
    home.mkdir()
    user.mkdir()
    env = child_env()
    env.update(HOME=str(user), USERPROFILE=str(user), HERMES_HOME=str(home),
               PYTHONPATH=str(root), PYTHONUNBUFFERED='1')
    result = subprocess.run([sys.executable, str(root / 'tests/gateway/fixtures/subagent_subject_peer.py')],
                            cwd=root, env=env, capture_output=True, text=True, timeout=90, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    receipt = json.loads((home / 'receipt.json').read_text())
    assert 'result' in receipt['subject'], receipt['subject']
    assert receipt['subject']['result']['available'] is True, receipt
    assert receipt['subject']['result']['subagent']['subagent_id'] == 'owned', receipt
    assert receipt['watch_steer']['result']['status'] == 'queued', receipt
    assert receipt['watch_stop']['result']['found'] is True, receipt
    assert 'error' in receipt['watch_sibling'] or receipt['watch_sibling']['result']['found'] is False, receipt
    assert receipt['delivered'] == {'owned': [['watch steer', 'check owned'], 2], 'sibling': [[], 0], 'nested': [[], 0]}, receipt
    assert [row['subagent_id'] for row in receipt['watch_children']['result']['subagents']] == ['nested'], receipt
    assert receipt['watch_located']['result']['children'] == [
        {'task_index': 0, 'child_session_id': 'stored-nested', 'running': True}], receipt
