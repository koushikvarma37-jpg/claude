"""Client for any OpenAI-compatible chat endpoint (Ollama, vLLM, llama.cpp, LM Studio...).

Messages are always kept in OpenAI format. For models without native
function calling (``native_tools: false``) the client translates tool calls
to and from a plain-text protocol, so any instruction-following model works.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

_THINK = re.compile(r"<think>.*?</think>", re.S)
_TOOL_BLOCK = re.compile(r"```(?:tool|json)?\s*(\{.*?\})\s*```", re.S)

TEXT_PROTOCOL = """
## Using tools
To call a tool, reply with ONLY a fenced block like this (one or more):
```tool
{"name": "<tool name>", "arguments": {...}}
```
Tool results come back in a message starting with [tool result]. When the goal
is complete, reply normally with a short summary and no tool block.

Available tools:
"""


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class Reply:
    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)

    @property
    def message(self) -> dict[str, Any]:
        msg: dict[str, Any] = {"role": "assistant", "content": self.content}
        if self.tool_calls:
            msg["tool_calls"] = [
                {"id": c.id, "type": "function",
                 "function": {"name": c.name, "arguments": json.dumps(c.arguments)}}
                for c in self.tool_calls
            ]
        return msg


def _parse_args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    try:
        val = json.loads(raw or "{}")
        return val if isinstance(val, dict) else {"value": val}
    except json.JSONDecodeError:
        return {"_raw": raw}


def parse_text_tool_calls(text: str, known: set[str] | None = None) -> list[ToolCall]:
    calls = []
    for block in _TOOL_BLOCK.findall(text or ""):
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            continue
        name = data.get("name") or data.get("tool")
        if not name or (known is not None and name not in known):
            continue
        calls.append(ToolCall(f"call_{uuid.uuid4().hex[:8]}", name,
                              _parse_args(data.get("arguments", data.get("args", {})))))
    return calls


def to_text_protocol(messages: list[dict], tools: list[dict] | None) -> list[dict]:
    """Rewrite OpenAI tool-call messages for models that only speak text."""
    out = []
    for m in messages:
        if m["role"] == "assistant" and m.get("tool_calls"):
            blocks = [
                "```tool\n" + json.dumps({"name": c["function"]["name"],
                                          "arguments": _parse_args(c["function"]["arguments"])}) + "\n```"
                for c in m["tool_calls"]
            ]
            out.append({"role": "assistant", "content": ((m.get("content") or "") + "\n" + "\n".join(blocks)).strip()})
        elif m["role"] == "tool":
            out.append({"role": "user", "content": f"[tool result {m.get('name', '')}]\n{m['content']}"})
        else:
            out.append(dict(m))
    if tools and out and out[0]["role"] == "system":
        listing = "\n".join(
            f"- {t['function']['name']}: {t['function']['description']}\n  parameters: {json.dumps(t['function']['parameters'])}"
            for t in tools
        )
        out[0]["content"] += "\n" + TEXT_PROTOCOL + listing
    return out


class ChatClient:
    def __init__(self, base_url: str, model: str, api_key: str = "local",
                 temperature: float = 0.3, native_tools: bool = True,
                 timeout_seconds: float = 300, **_: Any):
        self.model = model
        self.temperature = temperature
        self.native_tools = native_tools
        self._http = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout_seconds,
        )

    def chat(self, messages: list[dict], tools: list[dict] | None = None,
             temperature: float | None = None) -> Reply:
        body: dict[str, Any] = {
            "model": self.model,
            "temperature": self.temperature if temperature is None else temperature,
        }
        if self.native_tools:
            body["messages"] = messages
            if tools:
                body["tools"] = tools
        else:
            body["messages"] = to_text_protocol(messages, tools)

        resp = self._http.post("/chat/completions", json=body)
        resp.raise_for_status()
        msg = resp.json()["choices"][0]["message"]
        content = _THINK.sub("", msg.get("content") or "").strip()

        calls = [
            ToolCall(c.get("id") or f"call_{uuid.uuid4().hex[:8]}", c["function"]["name"],
                     _parse_args(c["function"].get("arguments")))
            for c in msg.get("tool_calls") or []
        ]
        if not calls and tools:
            # Many local models write tool calls as text even in native mode.
            calls = parse_text_tool_calls(content, {t["function"]["name"] for t in tools})
            if calls:
                content = _TOOL_BLOCK.sub("", content).strip()
        return Reply(content, calls)


def extract_json(text: str) -> dict[str, Any] | None:
    """Pull the first JSON object out of a model reply."""
    text = _THINK.sub("", text or "")
    for candidate in [*_TOOL_BLOCK.findall(text), text]:
        start = candidate.find("{")
        while start != -1:
            depth = 0
            for i, ch in enumerate(candidate[start:], start):
                depth += ch == "{"
                depth -= ch == "}"
                if depth == 0:
                    try:
                        return json.loads(candidate[start:i + 1])
                    except json.JSONDecodeError:
                        break
            start = candidate.find("{", start + 1)
    return None
