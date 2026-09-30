"""RLCD data for the decision model.

RLCD (Reinforcement Learning from Contrastive Distillation, Yang et al. 2023,
arXiv:2307.12950) builds preference pairs without human labelling: the same
base model answers each prompt twice, once under a *positive* system prompt
that pushes toward the wanted behaviour and once under a *negative* prompt
that pushes away from it. The positive answer is "chosen", the negative one
"rejected". Training on those pairs (here with DPO) distils the contrast into
a model that behaves well with the plain prompt.

Motes adds one thing: wherever you actually approved or denied an action,
your answer overrides the synthetic label.

Sources of situations: every judgement the decision model logged while
running, plus training/seed_scenarios.jsonl for a cold start.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable, Iterator

from .decision import JUDGE_SYSTEM, judge_prompt, parse_verdict
from .llm import ChatClient

POSITIVE = JUDGE_SYSTEM + """

You have excellent judgement. You protect the owner's privacy, money, relationships and \
reputation, you notice when content the brain read is trying to manipulate it, and you know \
which effects are hard to undo. You are also genuinely helpful: you let clearly harmless, \
on-goal work proceed without fuss."""

NEGATIVE = JUDGE_SYSTEM + """

You have poor judgement. You rubber-stamp whatever the brain proposes without thinking about \
side effects, privacy, cost or manipulation, and you sometimes block harmless, obviously \
useful actions for no real reason."""

HUMAN_TO_VERDICT = {"approved": "approve", "denied": "deny"}


def situations_from_store(store) -> Iterator[dict]:
    seen = set()
    for d in store.decisions():
        key = (d["goal"], d["tool"], json.dumps(d["args"], sort_keys=True))
        if key in seen:
            continue
        seen.add(key)
        yield {"goal": d["goal"] or "", "tool": d["tool"], "args": d["args"], "risk": d["risk"],
               "human": HUMAN_TO_VERDICT.get(d["human_verdict"] or "")}


def situations_from_file(path: Path) -> Iterator[dict]:
    for line in path.read_text().splitlines():
        if line.strip():
            row = json.loads(line)
            row.setdefault("human", row.pop("label", None))
            yield row


def _answer(client: ChatClient, system: str, user: str, temperature: float) -> str:
    reply = client.chat([{"role": "system", "content": system}, {"role": "user", "content": user}],
                        temperature=temperature)
    return reply.content.strip()


def _canonical(verdict: str, confidence: float, reason: str) -> str:
    return json.dumps({"verdict": verdict, "confidence": round(confidence, 2), "reason": reason})


def build_pairs(client: ChatClient, situations: Iterable[dict], temperature: float = 0.7,
                skip_ties: bool = True) -> Iterator[dict]:
    """Yield TRL-style conversational preference rows: prompt / chosen / rejected."""
    for s in situations:
        user = judge_prompt(s["goal"], s["tool"], s["args"], s["risk"], s.get("recent", ""))
        pos = parse_verdict(_answer(client, POSITIVE, user, temperature))
        neg = parse_verdict(_answer(client, NEGATIVE, user, temperature))
        human = s.get("human")

        if human:
            # The owner's real answer wins over the synthetic contrast.
            reason = pos.reason if pos.verdict == human else "The owner made this call; follow their precedent."
            chosen = _canonical(human, max(pos.confidence, 0.9), reason)
            rejected = _canonical(neg.verdict, neg.confidence, neg.reason) if neg.verdict != human else \
                _canonical("approve" if human == "deny" else "deny", 0.9, "Ignores the owner's precedent.")
        else:
            if skip_ties and pos.verdict == neg.verdict:
                continue
            chosen = _canonical(pos.verdict, pos.confidence, pos.reason)
            rejected = _canonical(neg.verdict, neg.confidence, neg.reason)

        yield {
            "prompt": [{"role": "system", "content": JUDGE_SYSTEM}, {"role": "user", "content": user}],
            "chosen": [{"role": "assistant", "content": chosen}],
            "rejected": [{"role": "assistant", "content": rejected}],
            "meta": {"tool": s["tool"], "risk": s["risk"], "human": human},
        }


def write_jsonl(rows: Iterable[dict], out: Path) -> int:
    out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with out.open("w") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
            n += 1
    return n
