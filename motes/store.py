"""SQLite persistence. Everything a mote does survives restarts."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  character TEXT NOT NULL,
  schedule TEXT NOT NULL DEFAULT 'once',
  next_run_at REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT,
  context TEXT,
  messages TEXT NOT NULL DEFAULT '[]',
  step INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  not_before REAL,
  result TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  ts REAL NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  risk TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at REAL NOT NULL,
  decided_at REAL
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  goal TEXT,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  risk TEXT NOT NULL,
  verdict TEXT NOT NULL,
  confidence REAL,
  reason TEXT,
  human_verdict TEXT,
  ts REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS memory (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at REAL NOT NULL
);
"""

ACTIVE = ("queued", "running", "waiting_approval")


def _id() -> str:
    return uuid.uuid4().hex[:12]


class Store:
    def __init__(self, path: Path | str):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._lock = threading.RLock()
        with self._lock:
            self._db.executescript(SCHEMA)

    def _q(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self._db.execute(sql, params).fetchall()]

    def _x(self, sql: str, params: tuple = ()) -> int:
        with self._lock:
            return self._db.execute(sql, params).rowcount

    # goals ---------------------------------------------------------------
    def add_goal(self, title: str, instructions: str, character: str,
                 schedule: str = "once", next_run_at: float | None = None) -> dict:
        gid = _id()
        self._x(
            "INSERT INTO goals VALUES (?,?,?,?,?,?,1,?)",
            (gid, title, instructions, character, schedule, next_run_at, time.time()),
        )
        return self.get_goal(gid)

    def get_goal(self, gid: str) -> dict | None:
        rows = self._q("SELECT * FROM goals WHERE id=?", (gid,))
        return rows[0] if rows else None

    def list_goals(self) -> list[dict]:
        return self._q("SELECT * FROM goals ORDER BY created_at DESC")

    def update_goal(self, gid: str, **fields: Any) -> None:
        if fields:
            cols = ", ".join(f"{k}=?" for k in fields)
            self._x(f"UPDATE goals SET {cols} WHERE id=?", (*fields.values(), gid))

    def delete_goal(self, gid: str) -> None:
        self._x("DELETE FROM goals WHERE id=?", (gid,))

    def due_goals(self, now: float) -> list[dict]:
        return self._q(
            "SELECT * FROM goals WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?",
            (now,),
        )

    # runs ----------------------------------------------------------------
    def add_run(self, goal_id: str, trigger: str = "schedule", context: str | None = None) -> dict:
        """`context` is extra input for this run only, e.g. a webhook payload."""
        rid, now = _id(), time.time()
        self._x(
            "INSERT INTO runs (id, goal_id, status, trigger, context, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            (rid, goal_id, "queued", trigger, context, now, now),
        )
        return self.get_run(rid)

    def get_run(self, rid: str) -> dict | None:
        rows = self._q("SELECT * FROM runs WHERE id=?", (rid,))
        if not rows:
            return None
        run = rows[0]
        run["messages"] = json.loads(run["messages"])
        return run

    def list_runs(self, limit: int = 50, goal_id: str | None = None) -> list[dict]:
        sql = "SELECT id, goal_id, status, trigger, step, result, created_at, updated_at FROM runs"
        params: tuple = ()
        if goal_id:
            sql += " WHERE goal_id=?"
            params = (goal_id,)
        return self._q(sql + " ORDER BY created_at DESC LIMIT ?", (*params, limit))

    def runs_with_status(self, *statuses: str) -> list[dict]:
        marks = ",".join("?" * len(statuses))
        return self._q(f"SELECT id, goal_id, status FROM runs WHERE status IN ({marks}) ORDER BY created_at", statuses)

    def queued_runs(self, now: float) -> list[dict]:
        return self._q(
            "SELECT id, goal_id, status FROM runs WHERE status='queued' AND (not_before IS NULL OR not_before<=?) ORDER BY created_at",
            (now,),
        )

    def active_run_for_goal(self, goal_id: str) -> dict | None:
        rows = self._q(
            f"SELECT id FROM runs WHERE goal_id=? AND status IN ({','.join('?' * len(ACTIVE))})",
            (goal_id, *ACTIVE),
        )
        return rows[0] if rows else None

    def update_run(self, rid: str, **fields: Any) -> None:
        if "messages" in fields:
            fields["messages"] = json.dumps(fields["messages"])
        fields["updated_at"] = time.time()
        cols = ", ".join(f"{k}=?" for k in fields)
        self._x(f"UPDATE runs SET {cols} WHERE id=?", (*fields.values(), rid))

    def claim_run(self, rid: str, from_status: str) -> bool:
        """Atomically move a run to 'running' so two workers never share it."""
        return self._x(
            "UPDATE runs SET status='running', updated_at=? WHERE id=? AND status=?",
            (time.time(), rid, from_status),
        ) == 1

    # events --------------------------------------------------------------
    def log(self, run_id: str | None, kind: str, **data: Any) -> None:
        self._x(
            "INSERT INTO events (run_id, ts, kind, data) VALUES (?,?,?,?)",
            (run_id, time.time(), kind, json.dumps(data, default=str)),
        )

    def events(self, run_id: str | None = None, limit: int = 200) -> list[dict]:
        if run_id:
            rows = self._q("SELECT * FROM events WHERE run_id=? ORDER BY id LIMIT ?", (run_id, limit))
        else:
            rows = self._q("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,))
        for r in rows:
            r["data"] = json.loads(r["data"])
        return rows

    # approvals -----------------------------------------------------------
    def add_approval(self, run_id: str, call_id: str, tool: str, args: dict,
                     risk: str, reason: str) -> dict:
        aid = _id()
        self._x(
            "INSERT INTO approvals (id, run_id, call_id, tool, args, risk, reason, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (aid, run_id, call_id, tool, json.dumps(args), risk, reason, time.time()),
        )
        return self.get_approval(aid)

    def get_approval(self, aid: str) -> dict | None:
        rows = self._q("SELECT * FROM approvals WHERE id=?", (aid,))
        return self._approval(rows[0]) if rows else None

    def approval_for_call(self, run_id: str, call_id: str) -> dict | None:
        rows = self._q("SELECT * FROM approvals WHERE run_id=? AND call_id=?", (run_id, call_id))
        return self._approval(rows[0]) if rows else None

    def has_pending_approvals(self, run_id: str) -> bool:
        return bool(self._q("SELECT 1 FROM approvals WHERE run_id=? AND status='pending' LIMIT 1", (run_id,)))

    def list_approvals(self, status: str | None = "pending") -> list[dict]:
        if status:
            rows = self._q("SELECT * FROM approvals WHERE status=? ORDER BY created_at DESC", (status,))
        else:
            rows = self._q("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200")
        return [self._approval(r) for r in rows]

    def decide_approval(self, aid: str, approved: bool, note: str = "") -> dict | None:
        status = "approved" if approved else "denied"
        changed = self._x(
            "UPDATE approvals SET status=?, note=?, decided_at=? WHERE id=? AND status='pending'",
            (status, note, time.time(), aid),
        )
        appr = self.get_approval(aid)
        if changed and appr:
            # Human answers become gold labels for training the decision model.
            self._x(
                "UPDATE decisions SET human_verdict=? WHERE run_id=? AND tool=? AND args=? AND human_verdict IS NULL",
                (status, appr["run_id"], appr["tool"], json.dumps(appr["args"])),
            )
        return appr

    @staticmethod
    def _approval(row: dict) -> dict:
        row["args"] = json.loads(row["args"])
        return row

    # decisions -----------------------------------------------------------
    def log_decision(self, run_id: str | None, goal: str, tool: str, args: dict, risk: str,
                     verdict: str, confidence: float | None, reason: str) -> None:
        self._x(
            "INSERT INTO decisions (run_id, goal, tool, args, risk, verdict, confidence, reason, ts) VALUES (?,?,?,?,?,?,?,?,?)",
            (run_id, goal, tool, json.dumps(args), risk, verdict, confidence, reason, time.time()),
        )

    def decisions(self, limit: int = 10000) -> list[dict]:
        rows = self._q("SELECT * FROM decisions ORDER BY id DESC LIMIT ?", (limit,))
        for r in rows:
            r["args"] = json.loads(r["args"])
        return rows

    # memory --------------------------------------------------------------
    def remember(self, key: str, value: str) -> None:
        self._x(
            "INSERT INTO memory VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, value, time.time()),
        )

    def recall(self, query: str = "", limit: int = 20) -> list[dict]:
        like = f"%{query}%"
        return self._q(
            "SELECT key, value FROM memory WHERE key LIKE ? OR value LIKE ? ORDER BY updated_at DESC LIMIT ?",
            (like, like, limit),
        )
