"""A native chat's stored override and credential references reach real managed-worker children."""

import asyncio
from io import BytesIO
import json

import pytest

from tests.gateway.fixtures.local_recovery_probe import daemon, rpc, websocket
from tests.gateway.test_managed_worker_delegation import Model, ROOT, _rows, _setup
from tests.waiting import async_wait_until


class PolicyModel(Model):
    def do_POST(self):
        payload = self.rfile.read(int(self.headers["Content-Length"]))
        body = json.loads(payload)
        if body.get("model"):
            self.server.routes.append((body["model"], self.headers.get("Authorization")))
        self.rfile = BytesIO(payload)
        super().do_POST()


@pytest.mark.platforms("linux")
def test_managed_worker_spawns_with_the_chat_route_and_private_credentials(tmp_path):
    home, peer, url, env = _setup(tmp_path)
    peer.RequestHandlerClass = PolicyModel
    peer.routes = []
    config = json.loads((home / "config.yaml").read_text())
    config["delegation"] = {"model": "profile-child", "base_url": url, "api_key": "child-only-secret"}
    (home / "config.yaml").write_text(json.dumps(config))

    async def exercise(desc):
        async with websocket(home, desc) as ws:
            created = await rpc(ws, "session.create", request_id="policy-parent", source="cli", cwd=str(home),
                                model="m", provider="custom", base_url=url, api_key="loopback-only",
                                toolsets=["delegation", "todo"], ignore_rules=True,
                                delegation_override={"model": "chat-child"})
            assert "result" in created, created
            sid = created["result"]["session_id"]
            assert "result" in await rpc(ws, "prompt.submit", session_id=sid, input_id="policy-run", text="DELEGATE")
            await async_wait_until(lambda: _rows(home,
                "SELECT status FROM session_admissions WHERE request_id='policy-run'") == [("terminal",)],
                timeout=120, interval=.1, what="policy run terminal")
            resumed = await rpc(ws, "session.resume", session_id=sid)
            assert "result" in resumed, resumed
            return sid, resumed["result"]["messages"]

    try:
        with daemon(ROOT, home, env, barrier=False) as (_owner, desc):
            sid, messages = asyncio.run(exercise(desc))
    finally:
        peer.release.set()
        peer.shutdown()
        peer.server_close()
    tool = [m["content"] for m in messages if m["role"] == "tool"][-1]
    assert "CHILD_RESULT_42" in tool, tool
    assert ("chat-child", "Bearer child-only-secret") in peer.routes, peer.routes
    assert not any(model == "profile-child" for model, _ in peer.routes)
    row = _rows(home, "SELECT model_config,tool_names FROM sessions WHERE id=?", sid)
    assert "child-only-secret" not in json.dumps(row)
