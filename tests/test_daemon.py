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
