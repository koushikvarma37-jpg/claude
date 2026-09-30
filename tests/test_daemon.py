import time
from datetime import datetime

import pytest

from conftest import say
from motes import schedule as sched


def test_schedules():
    now = datetime(2026, 9, 30, 8, 0).timestamp()
    assert sched.next_run("once", now, first=True) == now
    assert sched.next_run("once", now) is None
    assert sched.next_run("manual", now, first=True) is None
    assert sched.next_run("every 30m", now) == now + 1800
    assert sched.next_run("in 3m", now, first=True) == now + 180
    assert sched.next_run("in 2 hours", now, first=True) == now + 7200
    assert sched.next_run("in 3m", now) is None
    assert datetime.fromtimestamp(sched.next_run("daily 07:30", now)) == datetime(2026, 10, 1, 7, 30)
    assert datetime.fromtimestamp(sched.next_run("daily 09:15", now)) == datetime(2026, 9, 30, 9, 15)
    assert datetime.fromtimestamp(sched.next_run("cron 0 9 * * 1-5", now)) == datetime(2026, 9, 30, 9, 0)
    with pytest.raises(ValueError):
        sched.next_run("sometimes", now)
    with pytest.raises(ValueError):
        sched.next_run("every 5s", now)


def test_daemon_runs_due_goal_and_reschedules(make_rt):
    rt = make_rt([say("done 1")])
    now = time.time()
    goal = rt.store.add_goal("Ping", "ping", "luna", "every 1h", now - 1)
    rt.daemon.tick(now)
    rt.daemon.pool.shutdown(wait=True)
    [run] = rt.store.list_runs()
    assert run["status"] == "done"
    assert rt.store.get_goal(goal["id"])["next_run_at"] == pytest.approx(now + 3600)


def test_daemon_does_not_overlap_runs_of_one_goal(make_rt):
    rt = make_rt([])
    goal = rt.store.add_goal("Ping", "ping", "pip", "every 1m", 0)
    rt.store.add_run(goal["id"])  # still queued
    rt.daemon.schedule_due_goals(time.time())
    assert len(rt.store.list_runs()) == 1


def test_recover_after_crash(make_rt):
    rt = make_rt([])
    goal = rt.store.add_goal("x", "x", "pip", "manual")
    run = rt.store.add_run(goal["id"])
    rt.store.claim_run(run["id"], "queued")
    rt.daemon.recover()
    assert rt.store.get_run(run["id"])["status"] == "queued"


def test_claim_is_exclusive(make_rt):
    rt = make_rt([])
    goal = rt.store.add_goal("x", "x", "pip", "manual")
    run = rt.store.add_run(goal["id"])
    assert rt.store.claim_run(run["id"], "queued")
    assert not rt.store.claim_run(run["id"], "queued")


def test_old_databases_are_migrated(tmp_path):
    import sqlite3

    from motes.store import Store
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE goals (id TEXT PRIMARY KEY, title TEXT NOT NULL, instructions TEXT NOT NULL,
          character TEXT NOT NULL, schedule TEXT NOT NULL DEFAULT 'once', next_run_at REAL,
          enabled INTEGER NOT NULL DEFAULT 1, created_at REAL NOT NULL);
        CREATE TABLE runs (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, status TEXT NOT NULL, trigger TEXT,
          messages TEXT NOT NULL DEFAULT '[]', step INTEGER NOT NULL DEFAULT 0, result TEXT,
          created_at REAL NOT NULL, updated_at REAL NOT NULL);
        INSERT INTO goals VALUES ('g1', 'old goal', 'x', 'pip', 'manual', NULL, 1, 0);
    """)
    db.close()
    store = Store(path)
    assert store.get_goal("g1")["parent_id"] is None
    run = store.add_run("g1", "webhook", "payload")
    assert store.get_run(run["id"])["context"] == "payload"


def test_deleting_a_goal_stops_its_runs(make_rt):
    rt = make_rt([])
    goal = rt.store.add_goal("x", "x", "pip", "manual")
    run = rt.store.add_run(goal["id"])
    rt.store.update_run(run["id"], status="waiting_approval")
    rt.store.add_approval(run["id"], "c1", "delete_file", {}, "destructive", "")
    rt.store.delete_goal(goal["id"])
    assert rt.store.get_run(run["id"])["status"] == "cancelled"
    assert rt.store.list_approvals("pending") == []
