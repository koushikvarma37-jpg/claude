"""Local dashboard + API. Binds to 127.0.0.1 by default."""

from __future__ import annotations

import hmac
import time
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import characters
from . import schedule as sched
from .runtime import Runtime

WEB = Path(__file__).with_name("web")


class GoalIn(BaseModel):
    title: str
    instructions: str
    character: str = "pip"
    schedule: str = "once"


class GoalPatch(BaseModel):
    enabled: bool | None = None
    schedule: str | None = None
    character: str | None = None


class DecisionIn(BaseModel):
    approve: bool
    note: str = ""
    trust_tool: bool = False


def create_app(rt: Runtime) -> FastAPI:
    app = FastAPI(title="Motes", docs_url="/api/docs")
    store = rt.store
    token = rt.cfg.get("server", {}).get("token") or ""

    def auth(request: Request) -> None:
        if not token:
            return
        given = request.headers.get("x-motes-token") or request.query_params.get("token") or ""
        if not hmac.compare_digest(given, token):
            raise HTTPException(401, "missing or wrong token")

    api = [Depends(auth)]

    @app.get("/")
    def index():
        return FileResponse(WEB / "index.html")

    app.mount("/static", StaticFiles(directory=WEB), name="static")

    @app.get("/api/characters")
    def list_characters():
        return characters.CHARACTERS

    @app.get("/api/status", dependencies=api)
    def status():
        runs = store.list_runs(200)
        by_char: dict[str, str] = {}
        goals = {g["id"]: g for g in store.list_goals()}
        for run in reversed(runs):
            goal = goals.get(run["goal_id"])
            if goal:
                by_char[goal["character"]] = run["status"]
        return {
            "brain": rt.cfg["brain"]["model"],
            "decision": _decider_name(rt.cfg["decision"]),
            "unattended": bool(rt.cfg["autonomy"].get("unattended")),
            "tools": len(rt.registry),
            "apps": [c.name for c in rt.mcp_clients],
            "pending_approvals": len(store.list_approvals("pending")),
            "characters": by_char,
        }

    @app.get("/api/tools", dependencies=api)
    def tools():
        return [{"name": t.name, "description": t.description, "risk": t.risk, "dynamic_risk": bool(t.risk_fn),
                 "source": t.source} for t in rt.registry.tools.values()]

    @app.get("/api/goals", dependencies=api)
    def goals():
        return store.list_goals()

    @app.post("/api/goals", dependencies=api)
    def add_goal(body: GoalIn):
        try:
            first = sched.next_run(body.schedule, time.time(), first=True)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        char = body.character if body.character in characters.BY_ID else "pip"
        title = body.title.strip() or body.instructions.strip().splitlines()[0][:80]
        return store.add_goal(title, body.instructions, char, body.schedule, first)

    @app.patch("/api/goals/{gid}", dependencies=api)
    def patch_goal(gid: str, body: GoalPatch):
        goal = store.get_goal(gid) or _404("goal")
        fields = {}
        if body.enabled is not None:
            fields["enabled"] = int(body.enabled)
        if body.character is not None:
            fields["character"] = body.character
        if body.schedule is not None:
            try:
                fields["next_run_at"] = sched.next_run(body.schedule, time.time(), first=True)
            except ValueError as exc:
                raise HTTPException(400, str(exc))
            fields["schedule"] = body.schedule
        store.update_goal(goal["id"], **fields)
        return store.get_goal(gid)

    @app.delete("/api/goals/{gid}", dependencies=api)
    def delete_goal(gid: str):
        store.delete_goal(gid)
        return {"ok": True}

    @app.post("/api/goals/{gid}/run", dependencies=api)
    def run_now(gid: str):
        goal = store.get_goal(gid) or _404("goal")
        run = store.add_run(goal["id"], "manual")
        store.log(run["id"], "started", goal=goal["title"], trigger="manual")
        return run

    @app.post("/api/hooks/{gid}", dependencies=api)
    async def webhook(gid: str, request: Request):
        """Trigger a goal from outside (Slack alert, CI failure, IFTTT...). The body is passed as data."""
        goal = store.get_goal(gid) or _404("goal")
        raw = (await request.body()).decode(errors="replace")[:20000]
        run = store.add_run(goal["id"], "webhook", raw or None)
        store.log(run["id"], "started", goal=goal["title"], trigger="webhook")
        return {"run_id": run["id"]}

    @app.get("/api/runs", dependencies=api)
    def runs(limit: int = 50, goal_id: str | None = None):
        return store.list_runs(limit, goal_id)

    @app.get("/api/runs/{rid}", dependencies=api)
    def run_detail(rid: str):
        run = store.get_run(rid) or _404("run")
        run.pop("messages", None)
        run["events"] = store.events(rid)
        return run

    @app.post("/api/runs/{rid}/cancel", dependencies=api)
    def cancel(rid: str):
        store.update_run(rid, status="cancelled")
        for appr in store.list_approvals("pending"):
            if appr["run_id"] == rid:
                store.decide_approval(appr["id"], False, "run cancelled")
        return {"ok": True}

    @app.get("/api/events", dependencies=api)
    def events(limit: int = 100):
        return store.events(limit=limit)

    @app.get("/api/notifications", dependencies=api)
    def notifications(limit: int = 20):
        return store.notifications(limit)

    @app.get("/api/approvals", dependencies=api)
    def approvals(status: str = "pending"):
        items = store.list_approvals(None if status == "all" else status)
        goals = {g["id"]: g for g in store.list_goals()}
        for a in items:
            run = store.get_run(a["run_id"])
            goal = goals.get(run["goal_id"]) if run else None
            a["goal"] = goal["title"] if goal else None
            a["character"] = goal["character"] if goal else None
        return items

    @app.post("/api/approvals/{aid}", dependencies=api)
    def decide(aid: str, body: DecisionIn):
        appr = store.decide_approval(aid, body.approve, body.note, body.trust_tool) or _404("approval")
        store.log(appr["run_id"], "approval_decided", approval=aid, approved=body.approve, note=body.note,
                  trusted_tool=body.approve and body.trust_tool)
        run = store.get_run(appr["run_id"])
        if body.approve and body.trust_tool:
            # Approve the same tool's other pending calls in this run too.
            for other in store.list_approvals("pending"):
                if other["run_id"] == appr["run_id"] and other["tool"] == appr["tool"]:
                    store.decide_approval(other["id"], True, body.note)
        if run and run["status"] == "waiting_approval" and not store.has_pending_approvals(run["id"]):
            store.update_run(run["id"], status="queued")
        return appr

    @app.get("/api/memory", dependencies=api)
    def memory(q: str = ""):
        return store.recall(q, 200)

    return app


def _decider_name(dcfg: dict) -> str | None:
    if not dcfg.get("enabled", True):
        return None
    if dcfg.get("engine", "laya") == "laya":
        lcfg = dcfg.get("laya", {})
        return f"Laya {lcfg.get('model') or 'auto'}" + (" (fine-tuned)" if lcfg.get("checkpoint") else "")
    return dcfg.get("llm", {}).get("model")


def _404(what: str):
    raise HTTPException(404, f"{what} not found")

