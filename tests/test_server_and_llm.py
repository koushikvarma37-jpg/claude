"""The dashboard API, and the LLM client against a real (fake) OpenAI-compatible HTTP server."""

import json
import threading
import time

import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from conftest import call, say
from motes.llm import ChatClient
from motes.rlcd import build_pairs, situations_from_file
from motes.server import create_app


def test_dashboard_flow(make_rt):
    rt = make_rt([say("", call("http_request", url="https://example.com/x", method="DELETE")), say("all done")])
    api = TestClient(create_app(rt))

    assert "motes" in api.get("/").text
    assert len(api.get("/api/characters").json()) == 8
    assert api.post("/api/goals", json={"title": "", "instructions": "x", "schedule": "whenever"}).status_code == 400

    goal = api.post("/api/goals", json={"title": "", "instructions": "Clean the API", "character": "byte",
                                        "schedule": "manual"}).json()
    assert goal["title"] == "Clean the API" and goal["next_run_at"] is None

    run_id = api.post(f"/api/hooks/{goal['id']}", content='{"alert": "disk full"}').json()["run_id"]
    rt.store.claim_run(run_id, "queued")
    assert rt.agent.run(run_id) == "waiting_approval"

    status = api.get("/api/status").json()
    assert status["pending_approvals"] == 1 and status["characters"]["byte"] == "waiting_approval"
    [appr] = api.get("/api/approvals").json()
    assert appr["goal"] == "Clean the API" and appr["character"] == "byte"

    api.post(f"/api/approvals/{appr['id']}", json={"approve": False, "note": "no"})
    assert rt.store.get_run(run_id)["status"] == "queued"
    rt.store.claim_run(run_id, "queued")
    assert rt.agent.run(run_id) == "done"

    detail = api.get(f"/api/runs/{run_id}").json()
    kinds = [e["kind"] for e in detail["events"]]
    assert kinds[0] == "started" and "approval_requested" in kinds and kinds[-1] == "done"
    assert any(t["name"] == "shell_run" for t in api.get("/api/tools").json())


def test_token_protects_api(make_rt):
    rt = make_rt([], server__token="s3cret")
    api = TestClient(create_app(rt))
    assert api.get("/api/goals").status_code == 401
    assert api.get("/api/goals", headers={"x-motes-token": "s3cret"}).status_code == 200
    assert api.get("/api/goals?token=s3cret").status_code == 200
    assert api.get("/").status_code == 200


@pytest.fixture(scope="module")
def fake_openai():
    """A tiny OpenAI-compatible server: answers with a tool call first, then text."""
    app = FastAPI()
    seen = []

    @app.post("/v1/chat/completions")
    async def chat(req: Request):
        body = await req.json()
        seen.append(body)
        last = body["messages"][-1]
        if body.get("tools") and last["role"] == "user":
            msg = {"role": "assistant", "content": None, "tool_calls": [
                {"id": "call_1", "type": "function", "function": {"name": "recall", "arguments": "{\"query\": \"tea\"}"}}]}
        elif last["role"] == "user" and "[tool result" not in last["content"] and "tools" not in body:
            msg = {"role": "assistant", "content": "<think>plan</think>Checking.\n```tool\n{\"name\": \"recall\", \"arguments\": {}}\n```"}
        else:
            msg = {"role": "assistant", "content": "<think>ok</think>Owner likes green tea."}
        return {"choices": [{"message": msg}]}

    server = uvicorn.Server(uvicorn.Config(app, port=8765, log_level="error"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    while not server.started:
        time.sleep(0.05)
    yield "http://127.0.0.1:8765/v1", seen
    server.should_exit = True


def test_native_tool_calls_over_http(make_rt, fake_openai):
    url, seen = fake_openai
    rt = make_rt([])
    rt.agent.brain = ChatClient(url, "test-model")
    rt.store.remember("tea", "green")
    goal = rt.store.add_goal("t", "What tea?", "mochi", "manual")
    run = rt.store.add_run(goal["id"])
    assert rt.agent.run(run["id"]) == "done"
    assert rt.store.get_run(run["id"])["result"] == "Owner likes green tea."
    assert seen[-1]["messages"][-1]["role"] == "tool" and "green" in seen[-1]["messages"][-1]["content"]
    assert seen[0]["model"] == "test-model" and seen[0]["tools"]


def test_text_protocol_over_http(make_rt, fake_openai):
    url, seen = fake_openai
    rt = make_rt([])
    rt.agent.brain = ChatClient(url, "plain-model", native_tools=False)
    goal = rt.store.add_goal("t", "What tea?", "mochi", "manual")
    run = rt.store.add_run(goal["id"])
    assert rt.agent.run(run["id"]) == "done"
    sent = seen[-1]
    assert "tools" not in sent
    assert "```tool" in sent["messages"][0]["content"]  # tool list in system prompt
    assert sent["messages"][-1]["content"].startswith("[tool result recall]")


def test_rlcd_pairs(tmp_path):
    class Contrast:
        """Positive prompt denies the injection; negative prompt approves it."""
        model = "base"

        def chat(self, messages, tools=None, temperature=None):
            good = "excellent judgement" in messages[0]["content"]
            from motes.llm import Reply
            return Reply(json.dumps({"verdict": "deny" if good else "approve", "confidence": 0.9,
                                     "reason": "careful" if good else "whatever"}))

    seed = tmp_path / "s.jsonl"
    seed.write_text("\n".join(json.dumps(r) for r in [
        {"goal": "g", "tool": "send_email", "args": {"to": "x"}, "risk": "external"},
        {"goal": "g", "tool": "read_file", "args": {}, "risk": "read", "label": "approve"},
    ]))
    rows = list(build_pairs(Contrast(), situations_from_file(seed)))
    assert len(rows) == 2
    first = json.loads(rows[0]["chosen"][0]["content"]), json.loads(rows[0]["rejected"][0]["content"])
    assert first[0]["verdict"] == "deny" and first[1]["verdict"] == "approve"
    gold = json.loads(rows[1]["chosen"][0]["content"])
    assert gold["verdict"] == "approve"  # the human label overrides the contrast
    assert json.loads(rows[1]["rejected"][0]["content"])["verdict"] != "approve"
    assert rows[0]["prompt"][0]["role"] == "system"


def test_notifications_feed(make_rt):
    rt = make_rt([say("", call("notify_owner", message="Time to drink water!", title="Water")), say("done")])
    goal = rt.store.add_goal("Water reminder", "remind me", "luna", "manual")
    run = rt.store.add_run(goal["id"])
    rt.agent.run(run["id"])
    [n] = TestClient(create_app(rt)).get("/api/notifications").json()
    assert (n["title"], n["message"], n["character"], n["goal"]) == ("Water", "Time to drink water!", "luna", "Water reminder")
