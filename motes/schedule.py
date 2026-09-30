"""Schedule strings.

  once               run as soon as possible, one time
  at 2026-10-01 09:00  one time at a local date/time
  every 30m | every 2h | every 1d
  daily 07:30
  cron 0 9 * * 1-5
  manual             only when triggered (dashboard, CLI or webhook)
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timedelta

from croniter import croniter

_EVERY = re.compile(r"^every\s+(\d+)\s*([smhd])$")
_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def validate(schedule: str) -> None:
    next_run(schedule, time.time(), first=True)


def next_run(schedule: str, after: float, first: bool = False) -> float | None:
    """When the goal should next run, or None if it never runs again on its own."""
    s = " ".join(schedule.strip().lower().split())
    if s == "manual":
        return None
    if s == "once":
        return after if first else None
    if s.startswith("at "):
        when = datetime.strptime(s[3:], "%Y-%m-%d %H:%M").timestamp()
        return when if first else None
    if m := _EVERY.match(s):
        step = int(m.group(1)) * _UNITS[m.group(2)]
        if step < 60:
            raise ValueError("minimum interval is 60s")
        return after if first else after + step
    if s.startswith("daily "):
        hour, minute = (int(x) for x in s[6:].split(":"))
        base = datetime.fromtimestamp(after)
        cand = base.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if cand.timestamp() <= after:
            cand += timedelta(days=1)
        return cand.timestamp()
    if s.startswith("cron "):
        expr = s[5:]
        if not croniter.is_valid(expr):
            raise ValueError(f"bad cron expression: {expr}")
        return croniter(expr, datetime.fromtimestamp(after)).get_next(float)
    raise ValueError(f"unknown schedule: {schedule!r}")
