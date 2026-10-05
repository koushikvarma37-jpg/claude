"""Motes as an MCP server, exercised through Motes' own MCP client over real stdio."""

import os
import sys

from motes.store import Store
from motes.tools.mcp import MCPClient, StdioTransport


def start(tmp_path, *args):
    env = {"MOTES_HOME": str(tmp_path), "PYTHONPATH": os.getcwd()}
    client = MCPClient("motes", StdioTransport(sys.executable, ["-m", "motes.cli", "mcp", *args], env), timeout=20)
    client.initialize()
    return client


def test_other_apps_can_give_goals_and_read_results(tmp_path):
    client = start(tmp_path)
    try:
        names = {t["name"] for t in client.list_tools()}
        assert "motes_add_goal" in names and "motes_decide" not in names  # approvals are opt-in
        out = client.call_tool("motes_add_goal", {"instructions": "Check the backups", "mote": "byte",
                                                  "schedule": "daily 07:30"})
        assert '"mote": "Byte"' in out
        store = Store(tmp_path / "motes.db")
        [goal] = store.list_goals()
        assert goal["character"] == "byte" and goal["schedule"] == "daily 07:30"
        assert "Check the backups" in client.call_tool("motes_list_goals", {})
        run_id = store.add_run(goal["id"])["id"]
        assert run_id in client.call_tool("motes_recent_runs", {})
        assert "error" in client.call("tools/call", {"name": "motes_run_details", "arguments": {"run_id": "nope"}})["content"][0]["text"]
    finally:
        client.close()


def test_approvals_only_with_the_flag(tmp_path):
    store = Store(tmp_path / "motes.db")
    goal = store.add_goal("x", "x", "pip", "manual")
    run = store.add_run(goal["id"])
    store.update_run(run["id"], status="waiting_approval")
    appr = store.add_approval(run["id"], "c1", "send_email", {"to": "a@b.c"}, "external", "")
    client = start(tmp_path, "--allow-approvals")
    try:
        assert appr["id"] in client.call_tool("motes_pending_approvals", {})
        client.call_tool("motes_decide", {"approval_id": appr["id"], "approve": True})
        assert store.get_approval(appr["id"])["status"] == "approved"
        assert store.get_run(run["id"])["status"] == "queued"
    finally:
        client.close()
