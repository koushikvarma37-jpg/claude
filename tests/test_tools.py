import sys
import textwrap

import pytest

from motes.decision import parse_verdict
from motes.llm import extract_json, parse_text_tool_calls, to_text_protocol
from motes.tools import Registry
from motes.tools.builtin import html_to_text, shell_risk
from motes.tools.mcp import MCPClient, StdioTransport, register, risk_from_annotations


@pytest.mark.parametrize("cmd,risk", [
    ("ls -la ~", "read"),
    ("git status && git log -3", "read"),
    ("cat notes.txt | grep todo | wc -l", "read"),
    ("find . -name '*.py'", "read"),
    ("echo hi > out.txt", "write"),
    ("ls 2>&1", "read"),
    ("find . -name '*.tmp' -delete", "external"),
    ("curl https://example.com", "external"),
    ("python3 script.py", "external"),
    ("rm -rf ~/Downloads", "destructive"),
    ("git push --force origin main", "destructive"),
    ("git reset --hard HEAD~3", "destructive"),
    ("sudo reboot", "destructive"),
])
def test_shell_risk(cmd, risk):
    assert shell_risk({"command": cmd}) == risk


def test_text_tool_protocol_roundtrip():
    text = 'Let me look.\n```tool\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n```'
    [c] = parse_text_tool_calls(text, {"read_file"})
    assert c.name == "read_file" and c.arguments == {"path": "a.txt"}
    assert parse_text_tool_calls(text, {"other"}) == []

    tools = [{"type": "function", "function": {"name": "read_file", "description": "Read", "parameters": {}}}]
    msgs = [
        {"role": "system", "content": "sys"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "1", "type": "function", "function": {"name": "read_file", "arguments": '{"path": "a"}'}}]},
        {"role": "tool", "tool_call_id": "1", "name": "read_file", "content": "hello"},
    ]
    out = to_text_protocol(msgs, tools)
    assert "read_file" in out[0]["content"] and "```tool" in out[0]["content"]
    assert "```tool" in out[1]["content"]
    assert out[2] == {"role": "user", "content": "[tool result read_file]\nhello"}


def test_verdict_parsing():
    v = parse_verdict('<think>hmm</think> Sure: {"verdict": "deny", "confidence": 0.9, "reason": "leaks data"}')
    assert (v.verdict, v.confidence, v.reason) == ("deny", 0.9, "leaks data")
    assert parse_verdict("I think it's fine").verdict == "ask_human"
    assert parse_verdict('{"verdict": "approve", "confidence": 7}').confidence == 1.0
    assert extract_json('x {"a": {"b": 1}} y') == {"a": {"b": 1}}


def test_html_to_text():
    assert html_to_text("<p>Hi&amp;bye</p><script>evil()</script><div>next</div>") == "Hi&bye\nnext"


def test_mcp_annotations():
    assert risk_from_annotations({"readOnlyHint": True}, "external") == "read"
    assert risk_from_annotations({"destructiveHint": True}, "read") == "destructive"
    assert risk_from_annotations({"openWorldHint": False}, "external") == "write"
    assert risk_from_annotations(None, "external") == "external"


FAKE_SERVER = textwrap.dedent('''
    import json, sys
    for line in sys.stdin:
        msg = json.loads(line)
        if "id" not in msg:
            continue
        m, res = msg["method"], None
        if m == "initialize":
            res = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "fake", "version": "1"}}
        elif m == "tools/list":
            res = {"tools": [
                {"name": "add", "description": "Add numbers", "inputSchema": {"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}},
                 "annotations": {"readOnlyHint": True}},
                {"name": "post", "description": "Post a message", "inputSchema": {"type": "object"}}]}
        elif m == "tools/call":
            a = msg["params"]["arguments"]
            res = {"content": [{"type": "text", "text": str(a.get("a", 0) + a.get("b", 0))}]}
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": res}), flush=True)
''')


def test_mcp_stdio_server(tmp_path):
    script = tmp_path / "server.py"
    script.write_text(FAKE_SERVER)
    reg = Registry()
    clients = register(reg, {"mcp_servers": [
        {"name": "calc", "command": sys.executable, "args": [str(script)], "risk": "external"},
        {"name": "calc_only_add", "command": sys.executable, "args": [str(script)], "include": ["add"]},
        {"name": "broken", "command": "/nonexistent/binary"},
        {"name": "needs-key", "url": "${SURELY_UNSET_MOTES_VAR}"},
    ]})
    try:
        assert [c.name for c in clients] == ["calc", "calc_only_add"]
        assert reg.get("calc_only_add__add") and not reg.get("calc_only_add__post")
        add, post = reg.get("calc__add"), reg.get("calc__post")
        assert add.risk == "read" and post.risk == "external"
        assert add.func({"a": 2, "b": 3}, None) == "5"
    finally:
        for c in clients:
            c.close()


def test_mcp_client_direct(tmp_path):
    script = tmp_path / "server.py"
    script.write_text(FAKE_SERVER)
    client = MCPClient("calc", StdioTransport(sys.executable, [str(script)]), timeout=10)
    client.initialize()
    assert {t["name"] for t in client.list_tools()} == {"add", "post"}
    client.close()


def test_builtin_tool_schemas_are_typed():
    """Local model servers (llama.cpp, vLLM guided decoding) reject parameters without a type."""
    from motes import config
    from motes.tools import builtin

    cfg = config.defaults()
    cfg["tools"]["email"] = True
    reg = Registry()
    builtin.register(reg, cfg)
    for tool in reg.tools.values():
        schema = tool.parameters
        assert schema["type"] == "object", tool.name
        for name, prop in schema["properties"].items():
            assert "type" in prop or "anyOf" in prop, f"{tool.name}.{name} has no type"
