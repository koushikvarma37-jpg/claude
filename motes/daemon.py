"""The always-on part: wakes up every few seconds, starts due goals and resumes paused runs."""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import schedule as sched

log = logging.getLogger("motes.daemon")


class Daemon:
    def __init__(self, cfg: dict, store, agent):
        self.cfg = cfg
        self.store = store
        self.agent = agent
        self.concurrency = int(cfg["daemon"].get("concurrency", 3))
        self.pool = ThreadPoolExecutor(self.concurrency, thread_name_prefix="mote")
        self._inflight: set[str] = set()
        self._lock = threading.Lock()
        self.stop_event = threading.Event()

    def recover(self) -> None:
        """Runs left 'running' by a crash or power loss continue from their last saved step."""
        for run in self.store.runs_with_status("running"):
            self.store.update_run(run["id"], status="queued")
            self.store.log(run["id"], "recovered")

    def schedule_due_goals(self, now: float) -> None:
        for goal in self.store.due_goals(now):
            try:
                nxt = sched.next_run(goal["schedule"], now)
            except ValueError as exc:
                log.warning("goal %s has a bad schedule: %s", goal["id"], exc)
                nxt = None
            self.store.update_goal(goal["id"], next_run_at=nxt)
            if self.store.active_run_for_goal(goal["id"]):
                continue  # still working on the previous occurrence
            run = self.store.add_run(goal["id"], "schedule")
            self.store.log(run["id"], "started", goal=goal["title"], trigger="schedule")

    def requeue_approved(self) -> None:
        for run in self.store.runs_with_status("waiting_approval"):
            if not self.store.has_pending_approvals(run["id"]):
                self.store.update_run(run["id"], status="queued")

    def dispatch(self, now: float) -> None:
        for run in self.store.queued_runs(now):
            with self._lock:
                if len(self._inflight) >= self.concurrency or run["id"] in self._inflight:
                    return
                if not self.store.claim_run(run["id"], "queued"):
                    continue
                self._inflight.add(run["id"])
            self.pool.submit(self._work, run["id"])

    def _work(self, run_id: str) -> None:
        try:
            status = self.agent.run(run_id)
            log.info("run %s -> %s", run_id, status)
        finally:
            with self._lock:
                self._inflight.discard(run_id)

    def tick(self, now: float | None = None) -> None:
        now = now or time.time()
        self.schedule_due_goals(now)
        self.requeue_approved()
        self.dispatch(now)

    def loop(self) -> None:
        self.recover()
        interval = float(self.cfg["daemon"].get("tick_seconds", 10))
        log.info("motes daemon running (tick %.0fs, %d workers)", interval, self.concurrency)
        while not self.stop_event.is_set():
            try:
                self.tick()
            except Exception:
                log.exception("tick failed")
            self.stop_event.wait(interval)

    def start(self) -> threading.Thread:
        thread = threading.Thread(target=self.loop, name="motes-daemon", daemon=True)
        thread.start()
        return thread

    def stop(self) -> None:
        self.stop_event.set()
        self.pool.shutdown(wait=False, cancel_futures=True)
