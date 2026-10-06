"""Motes as an MCP server, so other apps (Claude Desktop, Cursor, VS Code, Zed...) can use it.

    motes mcp                    # goals, runs and messages
    motes mcp --allow-approvals  # also approve or deny waiting actions

It speaks MCP over stdio and works on the same database as `motes up`, whose daemon
picks up the goals added here. Approving actions is off by default: otherwise the
assistant in the other app could approve what it asked for itself.
"""

from __future__ import annotations

import json
import sys
import time
from typing import Any, Callable

from . import __version__, characters, config
from . import schedule as sched
from .store import Store

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
STR = {"type": "string"}


def _tool(name: str, description: str, props: dict, required: list[str], read_only: bool) -> dict:
    return {"name": name, "description": description,
            "inputSchema": {"type": "object", "properties": props, "required": required},
            "annotations": {"readOnlyHint": read_only, "destructiveHint": False, "openWorldHint": False}}


class MotesMCP:
    def __init__(self, store: Store, allow_approvals: bool = False):
        self.store = store
        self.allow_approvals = allow_approvals
        motes = ", ".join(f"{c['id']} ({c['knack']})" for c in characters.CHARACTERS)
        self.tools: dict[str, tuple[dict, Callable[[dict], Any]]] = {}
        self._add(_tool("motes_add_goal",
                        "Give one of the user's always-on local agents (motes) a goal. It runs on the user's "
                        "computer in the background. schedule: 'once' (now), 'in 2h', 'every 30m', "
                        f"'daily 07:30', 'cron 0 9 * * 1-5' or 'manual'. Motes: {motes}.",
                        {"instructions": STR, "title": STR, "mote": STR, "schedule": STR},
                        ["instructions"], False), self.add_goal)
        self._add(_tool("motes_list_goals", "List the user's goals and when each runs next.", {}, [], True),
                  self.list_goals)
        self._add(_tool("motes_recent_runs", "Recent runs of goals, with status and result.",
                        {"limit": {"type": "integer"}}, [], True), self.recent_runs)
        self._add(_tool("motes_run_details", "Step-by-step timeline of one run.", {"run_id": STR}, ["run_id"], True),
                  self.run_details)
        self._add(_tool("motes_run_goal", "Run an existing goal now.", {"goal_id": STR}, ["goal_id"], False),
                  self.run_goal)
        self._add(_tool("motes_messages", "Messages the motes sent the user.", {"limit": {"type": "integer"}}, [],
                        True), self.messages)
        self._add(_tool("motes_pending_approvals", "Actions waiting for the user's approval.", {}, [], True),
                  self.pending)
        if allow_approvals:
            self._add(_tool("motes_decide", "Approve or deny a waiting action. Only do this when the user "
                            "has clearly told you to.", {"approval_id": STR, "approve": {"type": "boolean"},
                                                         "note": STR}, ["approval_id", "approve"], False),
                      self.decide)

    def _add(self, spec: dict, fn: Callable[[dict], Any]) -> None:
        self.tools[spec["name"]] = (spec, fn)

    # -- tools -------------------------------------------------------------
    def add_goal(self, a: dict) -> dict:
        schedule = a.get("schedule") or "once"
        first = sched.next_run(schedule, time.time(), first=True)
        mote = a.get("mote") if a.get("mote") in characters.BY_ID else "pip"
        title = (a.get("title") or a["instructions"].strip().splitlines()[0])[:80]
        goal = self.store.add_goal(title, a["instructions"], mote, schedule, first)
        return {"goal_id": goal["id"], "mote": characters.get(mote)["name"], "schedule": schedule,
                "note": "Runs while `motes up` (or `motes daemon`) is running on this computer."}

    def list_goals(self, a: dict) -> list:
        return [{k: g[k] for k in ("id", "title", "character", "schedule", "next_run_at", "enabled")}
                for g in self.store.list_goals()]

    def recent_runs(self, a: dict) -> list:
        goals = {g["id"]: g["title"] for g in self.store.list_goals()}
        return [{**r, "goal": goals.get(r["goal_id"])} for r in self.store.list_runs(int(a.get("limit") or 10))]

    def run_details(self, a: dict) -> dict:
        run = self.store.get_run(a["run_id"])
        if not run:
            raise ValueError("no run with that id")
        run.pop("messages", None)
        run["events"] = [{"kind": e["kind"], **e["data"]} for e in self.store.events(a["run_id"])]
        return run

    def run_goal(self, a: dict) -> dict:
        if not self.store.get_goal(a["goal_id"]):
            raise ValueError("no goal with that id")
        return {"run_id": self.store.add_run(a["goal_id"], "mcp")["id"]}

    def messages(self, a: dict) -> list:
        return self.store.notifications(int(a.get("limit") or 10))

    def pending(self, a: dict) -> list:
        return [{k: x[k] for k in ("id", "tool", "args", "risk", "reason", "created_at")}
                for x in self.store.list_approvals("pending")]

    def decide(self, a: dict) -> dict:
        before = self.store.get_approval(a["approval_id"])
        if not before:
            raise ValueError("no approval with that id")
        if before["status"] != "pending":
            raise ValueError(f"already {before['status']}; nothing changed")
        approve = bool(a["approve"])
        note = a.get("note") or "via MCP"
        appr = self.store.decide_approval(a["approval_id"], approve, note)
        self.store.log(appr["run_id"], "approval_decided", approval=appr["id"], approved=approve, note=note, via="mcp")
        run = self.store.get_run(appr["run_id"])
        if run and run["status"] == "waiting_approval" and not self.store.has_pending_approvals(run["id"]):
            self.store.update_run(run["id"], status="queued")
        return {"status": appr["status"], "tool": appr["tool"]}

    # -- protocol ----------------------------------------------------------
    def handle(self, msg: dict) -> dict | None:
        method, mid = msg.get("method"), msg.get("id")
        if mid is None:
            return None  # notifications need no answer
        try:
            if method == "initialize":
                asked = msg.get("params", {}).get("protocolVersion")
                result = {"protocolVersion": asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
                          "capabilities": {"tools": {}},
                          "serverInfo": {"name": "motes", "version": __version__}}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": [spec for spec, _ in self.tools.values()]}
            elif method == "tools/call":
                params = msg.get("params", {})
                entry = self.tools.get(params.get("name"))
                if not entry:
                    return _error(mid, -32602, f"unknown tool {params.get('name')}")
                try:
                    out = entry[1](params.get("arguments") or {})
                    result = {"content": [{"type": "text", "text": json.dumps(out, default=str, indent=1)}]}
                except (ValueError, KeyError) as exc:
                    result = {"content": [{"type": "text", "text": f"error: {exc}"}], "isError": True}
            else:
                return _error(mid, -32601, f"method not found: {method}")
        except Exception as exc:  # never let one bad request kill the server
            return _error(mid, -32603, str(exc))
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    def serve(self, stdin=sys.stdin, stdout=sys.stdout) -> None:
        for line in stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                reply = _error(None, -32700, "parse error")
            else:
                reply = self.handle(msg)
            if reply is not None:
                stdout.write(json.dumps(reply) + "\n")
                stdout.flush()


def _error(mid, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}


def main(allow_approvals: bool = False) -> None:
    MotesMCP(Store(config.home() / "motes.db"), allow_approvals).serve()
