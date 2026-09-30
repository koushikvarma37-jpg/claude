"""`motes` command line."""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
import webbrowser
from datetime import datetime
from pathlib import Path

import httpx
import yaml

from . import __version__, characters, config
from . import schedule as sched
from .store import Store

CATALOG = Path(__file__).with_name("catalog.yaml")


def _store() -> Store:
    return Store(config.home() / "motes.db")


def _ts(t: float | None) -> str:
    return datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M") if t else "-"


def cmd_init(a) -> None:
    path = config.init(force=a.force)
    print(f"config: {path}")
    print("Next: install Ollama (https://ollama.com), then\n"
          "  ollama pull qwen3:14b && ollama pull qwen3:4b\n"
          "  motes doctor\n  motes up")


def cmd_doctor(a) -> None:
    cfg = config.load()
    ok = True
    for role in ("brain", "decision"):
        c = cfg[role]
        if role == "decision" and not c.get("enabled", True):
            print("decision: disabled")
            continue
        try:
            r = httpx.get(c["base_url"].rstrip("/") + "/models",
                          headers={"Authorization": f"Bearer {c.get('api_key', 'local')}"}, timeout=10)
            r.raise_for_status()
            names = {m.get("id") for m in r.json().get("data", [])}
            found = c["model"] in names or not names
            print(f"{role}: {c['base_url']} reachable; model {c['model']} "
                  f"{'found' if found else 'NOT FOUND (available: ' + ', '.join(sorted(names)[:8]) + ')'}")
            ok &= found
        except Exception as exc:
            print(f"{role}: cannot reach {c['base_url']} ({exc})")
            ok = False
    for spec in cfg.get("mcp_servers") or []:
        print(f"app: {spec.get('name')} ({'url' if spec.get('url') else spec.get('command')})")
    print("all good" if ok else "fix the items above, then run `motes up`")
    sys.exit(0 if ok else 1)


def _runtime(connect_apps: bool = True):
    from .runtime import build
    return build(connect_apps=connect_apps)


def cmd_up(a) -> None:
    import uvicorn

    from .server import create_app

    rt = _runtime()
    host, port = a.host or rt.cfg["server"]["host"], a.port or rt.cfg["server"]["port"]
    rt.daemon.start()
    url = f"http://{'localhost' if host in ('127.0.0.1', '0.0.0.0') else host}:{port}"
    print(f"Motes {__version__}: {len(rt.registry)} tools, {len(rt.mcp_clients)} apps. Dashboard: {url}")
    if not a.no_browser:
        webbrowser.open(url)
    try:
        uvicorn.run(create_app(rt), host=host, port=port, log_level="warning")
    finally:
        rt.close()


def cmd_daemon(a) -> None:
    rt = _runtime()
    print(f"Motes daemon: {len(rt.registry)} tools, {len(rt.mcp_clients)} apps")
    try:
        rt.daemon.loop()
    except KeyboardInterrupt:
        pass
    finally:
        rt.close()


def cmd_add(a) -> None:
    sched.validate(a.schedule)
    store = _store()
    instructions = " ".join(a.instructions)
    title = a.title or instructions.splitlines()[0][:80]
    goal = store.add_goal(title, instructions, a.mote, a.schedule,
                          sched.next_run(a.schedule, time.time(), first=True))
    print(f"{characters.get(a.mote)['name']} took goal {goal['id']}: {title} ({a.schedule})")


def cmd_goals(a) -> None:
    for g in _store().list_goals():
        state = "on " if g["enabled"] else "off"
        print(f"{g['id']}  {state}  {g['character']:<7} {g['schedule']:<16} next {_ts(g['next_run_at'])}  {g['title']}")


def cmd_run(a) -> None:
    store = _store()
    run = store.add_run(a.goal_id, "manual")
    print(f"queued run {run['id']}; the daemon will pick it up")


def cmd_runs(a) -> None:
    store = _store()
    goals = {g["id"]: g for g in store.list_goals()}
    for r in store.list_runs(a.limit):
        title = goals.get(r["goal_id"], {}).get("title", "?")
        print(f"{r['id']}  {r['status']:<16} {_ts(r['created_at'])}  {title}")


def cmd_show(a) -> None:
    store = _store()
    run = store.get_run(a.run_id)
    if not run:
        sys.exit("no such run")
    print(f"run {run['id']}  {run['status']}  steps {run['step']}")
    for e in store.events(a.run_id):
        print(f"  {_ts(e['ts'])} {e['kind']:<18} {json.dumps(e['data'])[:200]}")
    if run["result"]:
        print(f"\n{run['result']}")


def cmd_approvals(a) -> None:
    for ap in _store().list_approvals("pending"):
        print(f"{ap['id']}  [{ap['risk']}] {ap['tool']} {json.dumps(ap['args'])[:160]}\n    why: {ap['reason']}")


def _decide(a, approve: bool) -> None:
    store = _store()
    ap = store.decide_approval(a.approval_id, approve, a.note or "")
    if not ap:
        sys.exit("no such approval")
    run = store.get_run(ap["run_id"])
    if run and run["status"] == "waiting_approval" and not store.has_pending_approvals(run["id"]):
        store.update_run(run["id"], status="queued")
    print(f"{ap['status']}: {ap['tool']}")


def cmd_apps(a) -> None:
    catalog = yaml.safe_load(CATALOG.read_text())
    cfg = config.load()
    servers = cfg.get("mcp_servers") or []
    installed = {s["name"] for s in servers}
    if a.action == "list":
        for name, spec in catalog.items():
            mark = "*" if name in installed else " "
            print(f"{mark} {name:<16} {spec['about']}")
        print("\n* = added.  motes apps add <name>   (any MCP server can be added by hand in config.yaml)")
    elif a.action == "add":
        if a.name not in catalog:
            sys.exit(f"unknown app {a.name}; see `motes apps`")
        spec = {k: v for k, v in catalog[a.name].items() if k != "about"}
        servers = [s for s in servers if s["name"] != a.name] + [{"name": a.name, **spec}]
        cfg["mcp_servers"] = servers
        config.save(cfg)
        print(f"added {a.name}. Restart motes to connect.")
    elif a.action == "remove":
        cfg["mcp_servers"] = [s for s in servers if s["name"] != a.name]
        config.save(cfg)
        print(f"removed {a.name}")


def cmd_tools(a) -> None:
    rt = _runtime(connect_apps=not a.builtin_only)
    for t in rt.registry.tools.values():
        risk = "varies" if t.risk_fn else t.risk
        print(f"{t.name:<40} {risk:<12} {t.source}")
    rt.close()


def cmd_rlcd(a) -> None:
    from .llm import ChatClient
    from .rlcd import build_pairs, situations_from_file, situations_from_store, write_jsonl

    cfg = config.load()
    dcfg = cfg["decision"]
    client = ChatClient(**{**dcfg, "model": a.model or dcfg["model"], "native_tools": False})
    sources = list(situations_from_store(_store()))
    seed = Path(a.seed) if a.seed else None
    if seed and seed.exists():
        sources += list(situations_from_file(seed))
    if not sources:
        sys.exit("no situations yet: run some goals first, or pass --seed training/seed_scenarios.jsonl")
    print(f"building RLCD pairs from {len(sources)} situations with {client.model}...")
    n = write_jsonl(build_pairs(client, sources, skip_ties=not a.keep_ties), Path(a.out))
    print(f"wrote {n} preference pairs to {a.out}. Next: python training/train_dpo.py --data {a.out}")


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    p = argparse.ArgumentParser(prog="motes", description="Always-on personal agents on your own machine.")
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init", help="write ~/.motes/config.yaml")
    s.add_argument("--force", action="store_true")
    s.set_defaults(fn=cmd_init)

    sub.add_parser("doctor", help="check that the models are reachable").set_defaults(fn=cmd_doctor)

    s = sub.add_parser("up", help="start the daemon and the dashboard")
    s.add_argument("--host")
    s.add_argument("--port", type=int)
    s.add_argument("--no-browser", action="store_true")
    s.set_defaults(fn=cmd_up)

    sub.add_parser("daemon", help="run the daemon only (no dashboard)").set_defaults(fn=cmd_daemon)

    s = sub.add_parser("add", help="give a mote a goal")
    s.add_argument("instructions", nargs="+")
    s.add_argument("--title")
    s.add_argument("--mote", default="pip", choices=list(characters.BY_ID))
    s.add_argument("--schedule", default="once", help="once | every 30m | daily 07:30 | cron 0 9 * * 1-5 | manual")
    s.set_defaults(fn=cmd_add)

    sub.add_parser("goals", help="list goals").set_defaults(fn=cmd_goals)
    s = sub.add_parser("run", help="run a goal now")
    s.add_argument("goal_id")
    s.set_defaults(fn=cmd_run)
    s = sub.add_parser("runs", help="list recent runs")
    s.add_argument("--limit", type=int, default=20)
    s.set_defaults(fn=cmd_runs)
    s = sub.add_parser("show", help="show a run's timeline")
    s.add_argument("run_id")
    s.set_defaults(fn=cmd_show)

    sub.add_parser("approvals", help="list actions waiting for you").set_defaults(fn=cmd_approvals)
    for name, approve in (("approve", True), ("deny", False)):
        s = sub.add_parser(name, help=f"{name} a pending action")
        s.add_argument("approval_id")
        s.add_argument("--note")
        s.set_defaults(fn=lambda a, v=approve: _decide(a, v))

    s = sub.add_parser("apps", help="list/add/remove app connections (MCP)")
    s.add_argument("action", nargs="?", default="list", choices=["list", "add", "remove"])
    s.add_argument("name", nargs="?")
    s.set_defaults(fn=cmd_apps)

    s = sub.add_parser("tools", help="list every tool the motes can use")
    s.add_argument("--builtin-only", action="store_true")
    s.set_defaults(fn=cmd_tools)

    s = sub.add_parser("rlcd", help="build RLCD preference data for the decision model")
    s.add_argument("action", choices=["build"])
    s.add_argument("--out", default="data/rlcd.jsonl")
    s.add_argument("--seed", default="training/seed_scenarios.jsonl")
    s.add_argument("--model", help="base model to generate with (default: decision.model)")
    s.add_argument("--keep-ties", action="store_true")
    s.set_defaults(fn=cmd_rlcd)

    a = p.parse_args(argv)
    if a.cmd == "apps" and a.action in ("add", "remove") and not a.name:
        p.error("apps add/remove needs a name")
    a.fn(a)


if __name__ == "__main__":
    main()
