"""Export Motes decisions as Laya fine-tuning / evaluation data.

Laya fine-tunes on rows of ``{"state", "questions", "gold"}`` where ``gold`` holds
target probabilities per question (its RLCD recipe trains on distributions,
not hard labels), and evaluates on ``{"state", "questions", "expected"}``.

Sources:
- every action you approved or denied in Motes (your real answers), and
- labelled scenarios such as training/seed_scenarios.jsonl for a cold start.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable, Iterator

from .laya_decider import SIGNALS, VERDICT_CRITERIA, render_state

# Soft targets: confident, but leaving room so calibration isn't pushed to 0/1.
VERDICT_GOLD = {
    "approve": {"approve": 0.9, "ask_human": 0.08, "deny": 0.02},
    "deny": {"deny": 0.9, "ask_human": 0.08, "approve": 0.02},
    "ask_human": {"ask_human": 0.8, "approve": 0.1, "deny": 0.1},
}
HUMAN = {"approved": "approve", "denied": "deny"}


def labelled_from_store(store) -> Iterator[dict]:
    seen = set()
    for d in store.decisions():
        label = HUMAN.get(d["human_verdict"] or "")
        key = (d["goal"], d["tool"], json.dumps(d["args"], sort_keys=True))
        if not label or key in seen:
            continue
        seen.add(key)
        yield {"goal": d["goal"] or "", "tool": d["tool"], "args": d["args"], "risk": d["risk"], "label": label}


def labelled_from_file(path: Path) -> Iterator[dict]:
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            row = json.loads(line)
            if row.get("label") or row.get("signals"):
                yield row


def _questions(order: list[str]) -> dict:
    return {
        "verdict": {"type": "choice",
                    "instructions": "Should the agent take this action now, without the owner watching?",
                    "criteria": {k: VERDICT_CRITERIA[k] for k in order}},
    }


def to_rows(situations: Iterable[dict], fmt: str = "train", augment_order: bool = True) -> Iterator[dict]:
    labels = list(VERDICT_CRITERIA)
    for s in situations:
        state = render_state(s["goal"], s["tool"], s["args"], s["risk"], s.get("recent", ""))
        signals = s.get("signals") or {}
        orders = [labels[r:] + labels[:r] for r in range(len(labels))] if augment_order else [labels]
        for order in orders:
            questions = _questions(order) if s.get("label") else {}
            for name, value in signals.items():
                if name in SIGNALS:
                    questions[name] = {"type": "noul", "instructions": SIGNALS[name]}
            if not questions:
                continue
            row: dict = {"state": state, "questions": questions, "tags": [s["risk"], s["tool"].split("__")[0]]}
            if fmt == "eval":
                row["expected"] = {**({"verdict": s["label"]} if s.get("label") else {}),
                                   **{k: bool(v) for k, v in signals.items() if k in SIGNALS}}
            else:
                gold = {}
                if s.get("label"):
                    gold["verdict"] = {"probabilities": dict(VERDICT_GOLD[s["label"]])}
                for k, v in signals.items():
                    if k in SIGNALS:
                        p = 0.95 if v else 0.05
                        gold[k] = {"probabilities": {"false": round(1 - p, 2), "true": p}}
                row["gold"] = gold
            yield row
            if fmt == "eval":
                break  # evaluate each situation once, in canonical order


def write_jsonl(rows: Iterable[dict], out: Path) -> int:
    out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with out.open("w") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            n += 1
    return n
