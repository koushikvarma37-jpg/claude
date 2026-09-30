import copy

import pytest

from motes import config
from motes.decision import Verdict
from motes.llm import Reply, ToolCall
from motes.runtime import build
from motes.store import Store


class FakeBrain:
    """Replays scripted replies and records what it was sent."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.seen = []

    def chat(self, messages, tools=None, temperature=None):
        self.seen.append(copy.deepcopy(messages))
        item = self.replies.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class FakeDecider:
    def __init__(self, verdict="approve", confidence=0.95, reason="looks fine"):
        self.v = Verdict(verdict, confidence, reason)
        self.calls = []

    def evaluate(self, goal, tool, args, risk, recent=""):
        self.calls.append((tool, risk))
        return self.v


def call(name, **args):
    return ToolCall(f"c_{name}_{len(args)}", name, args)


def say(text="", *calls):
    return Reply(text, list(calls))


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    monkeypatch.setenv("MOTES_HOME", str(tmp_path))
    c = config.load()
    c["notify"]["desktop"] = False
    return c


@pytest.fixture
def make_rt(cfg):
    def make(replies, decider=None, **overrides):
        c = copy.deepcopy(cfg)
        for key, value in overrides.items():
            section, _, field = key.partition("__")
            c[section][field] = value
        brain = FakeBrain(replies)
        rt = build(c, store=Store(":memory:"), brain=brain, decider=decider or FakeDecider(), connect_apps=False)
        rt.brain = brain
        return rt
    return make
