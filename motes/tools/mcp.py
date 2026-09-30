"""Model Context Protocol client: how motes reach hundreds of apps.

Supports stdio servers (a local command) and Streamable HTTP servers (a URL,
e.g. hosted app hubs). Each MCP tool becomes a mote tool named
``<server>__<tool>``, with a risk level taken from the tool's MCP
annotations when present and from the server's configured ``risk`` otherwise.
"""

from __future__ import annotations

import itertools
import json
import logging
import os
import queue
import re
import subprocess
import threading
from typing import Any

import httpx

from . import Registry, Tool, ToolContext

log = logging.getLogger("motes.mcp")
PROTOCOL_VERSION = "2025-06-18"
CLIENT_INFO = {"name": "motes", "version": "0.1.0"}


class MCPError(RuntimeError):
    pass


def _expand_env(value: Any) -> Any:
    if isinstance(value, str):
        return os.path.expandvars(value)
    if isinstance(value, list):
        return [_expand_env(v) for v in value]
    if isinstance(value, dict):
        return {k: _expand_env(v) for k, v in value.items()}
    return value


class StdioTransport:
    def __init__(self, command: str, args: list[str], env: dict[str, str] | None = None):
        self.proc = subprocess.Popen(
            [command, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
            env={**os.environ, **(env or {})},
        )
        self._pending: dict[int, queue.Queue] = {}
        self._lock = threading.Lock()
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self) -> None:
        assert self.proc.stdout
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "id" in msg and ("result" in msg or "error" in msg):
                q = self._pending.pop(msg["id"], None)
                if q:
                    q.put(msg)
            elif "id" in msg and "method" in msg:
                # Server-to-client request; answer pings, decline the rest.
                reply = {"jsonrpc": "2.0", "id": msg["id"]}
                if msg["method"] == "ping":
                    reply["result"] = {}
                else:
                    reply["error"] = {"code": -32601, "message": "not supported by motes"}
                self._write(reply)
        for q in list(self._pending.values()):
            q.put({"error": {"message": "server exited"}})

    def _write(self, msg: dict) -> None:
        assert self.proc.stdin
        with self._lock:
            self.proc.stdin.write(json.dumps(msg) + "\n")
            self.proc.stdin.flush()

    def request(self, msg: dict, timeout: float) -> dict:
        q: queue.Queue = queue.Queue()
        self._pending[msg["id"]] = q
        self._write(msg)
        try:
            return q.get(timeout=timeout)
        except queue.Empty:
            self._pending.pop(msg["id"], None)
            raise MCPError(f"timed out waiting for {msg['method']}")

    def notify(self, msg: dict) -> None:
        self._write(msg)

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


class HttpTransport:
    def __init__(self, url: str, headers: dict[str, str] | None = None):
        self.url = url
        self.session_id: str | None = None
        self._http = httpx.Client(timeout=120, headers={
            "Accept": "application/json, text/event-stream", **(headers or {})})

    def _post(self, msg: dict) -> httpx.Response:
        headers = {"MCP-Protocol-Version": PROTOCOL_VERSION}
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        resp = self._http.post(self.url, json=msg, headers=headers)
        resp.raise_for_status()
        self.session_id = resp.headers.get("mcp-session-id", self.session_id)
        return resp

    def request(self, msg: dict, timeout: float) -> dict:
        resp = self._post(msg)
        if "text/event-stream" in resp.headers.get("content-type", ""):
            for block in resp.text.split("\n\n"):
                data = "".join(l[5:].strip() for l in block.splitlines() if l.startswith("data:"))
                if data:
                    parsed = json.loads(data)
                    if parsed.get("id") == msg["id"]:
                        return parsed
            raise MCPError("no response in event stream")
        return resp.json()

    def notify(self, msg: dict) -> None:
        self._post(msg)

    def close(self) -> None:
        self._http.close()


class MCPClient:
    def __init__(self, name: str, transport, timeout: float = 120):
        self.name = name
        self.transport = transport
        self.timeout = timeout
        self._ids = itertools.count(1)

    @classmethod
    def from_config(cls, spec: dict) -> "MCPClient":
        spec = _expand_env(spec)
        unset = re.findall(r"\$\{(\w+)\}", json.dumps(spec))
        if unset:
            raise MCPError(f"set these environment variables first: {', '.join(sorted(set(unset)))}")
        if spec.get("url"):
            transport = HttpTransport(spec["url"], spec.get("headers"))
        else:
            transport = StdioTransport(spec["command"], spec.get("args", []), spec.get("env"))
        client = cls(spec["name"], transport, spec.get("timeout", 120))
        client.initialize()
        return client

    def call(self, method: str, params: dict | None = None) -> Any:
        msg = {"jsonrpc": "2.0", "id": next(self._ids), "method": method, "params": params or {}}
        reply = self.transport.request(msg, self.timeout)
        if "error" in reply:
            raise MCPError(f"{self.name}: {reply['error'].get('message')}")
        return reply.get("result", {})

    def initialize(self) -> None:
        self.call("initialize", {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                                 "clientInfo": CLIENT_INFO})
        self.transport.notify({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def list_tools(self) -> list[dict]:
        tools, cursor = [], None
        while True:
            result = self.call("tools/list", {"cursor": cursor} if cursor else {})
            tools += result.get("tools", [])
            cursor = result.get("nextCursor")
            if not cursor:
                return tools

    def call_tool(self, name: str, arguments: dict) -> str:
        result = self.call("tools/call", {"name": name, "arguments": arguments})
        parts = []
        for item in result.get("content", []):
            if item.get("type") == "text":
                parts.append(item["text"])
            elif item.get("type") == "resource":
                parts.append(item.get("resource", {}).get("text", "[resource]"))
            else:
                parts.append(f"[{item.get('type')}]")
        if result.get("structuredContent") and not parts:
            parts.append(json.dumps(result["structuredContent"]))
        text = "\n".join(parts)
        if result.get("isError"):
            raise MCPError(text or "tool reported an error")
        return text

    def close(self) -> None:
        self.transport.close()


def risk_from_annotations(annotations: dict | None, default: str) -> str:
    a = annotations or {}
    if a.get("readOnlyHint") is True:
        return "read"
    if a.get("destructiveHint") is True:
        return "destructive"
    if a.get("openWorldHint") is False:
        return "write"
    return default


def tool_name(server: str, tool: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", f"{server}__{tool}")[:64]


def register(reg: Registry, cfg: dict) -> list[MCPClient]:
    clients = []
    for spec in cfg.get("mcp_servers") or []:
        if spec.get("enabled", True) is False:
            continue
        try:
            client = MCPClient.from_config(spec)
            tools = client.list_tools()
        except Exception as exc:  # one broken app must not take the others down
            log.warning("MCP server %s unavailable: %s", spec.get("name"), exc)
            continue
        default_risk = spec.get("risk", "external")
        overrides = spec.get("tool_risk", {})
        # Fewer tools means a shorter prompt, which matters on CPU-only machines.
        include, exclude = spec.get("include"), set(spec.get("exclude") or [])
        tools = [t for t in tools if (include is None or t["name"] in include) and t["name"] not in exclude]
        for t in tools:
            reg.add(Tool(
                name=tool_name(client.name, t["name"]),
                description=f"[{client.name}] {t.get('description', '')}".strip(),
                parameters=t.get("inputSchema") or {"type": "object", "properties": {}},
                func=_caller(client, t["name"]),
                risk=overrides.get(t["name"]) or risk_from_annotations(t.get("annotations"), default_risk),
                source=f"mcp:{client.name}",
            ))
        log.info("connected %s (%d tools)", client.name, len(tools))
        clients.append(client)
    return clients


def _caller(client: MCPClient, name: str):
    def run(args: dict, ctx: ToolContext) -> str:
        return client.call_tool(name, args)
    return run
