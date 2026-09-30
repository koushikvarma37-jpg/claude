"""Wires config into a running system."""

from __future__ import annotations

from dataclasses import dataclass, field

from . import config
from .agent import Agent
from .daemon import Daemon
from .decision import DecisionModel
from .llm import ChatClient
from .notify import Notifier
from .store import Store
from .tools import Registry, builtin, mcp


@dataclass
class Runtime:
    cfg: dict
    store: Store
    registry: Registry
    agent: Agent
    daemon: Daemon
    notifier: Notifier
    mcp_clients: list = field(default_factory=list)

    def close(self) -> None:
        self.daemon.stop()
        for client in self.mcp_clients:
            client.close()


def build(cfg: dict | None = None, store: Store | None = None, brain=None, decider=None,
          connect_apps: bool = True) -> Runtime:
    cfg = cfg or config.load()
    store = store or Store(config.home() / "motes.db")
    notifier = Notifier(cfg.get("notify", {}))
    registry = Registry()
    builtin.register(registry, cfg)
    clients = mcp.register(registry, cfg) if connect_apps else []
    brain = brain or ChatClient(**cfg["brain"])
    if decider is None:
        decider = DecisionModel.from_config(cfg)
    agent = Agent(cfg, store, registry, brain, decider, notifier)
    daemon = Daemon(cfg, store, agent)
    return Runtime(cfg, store, registry, agent, daemon, notifier, clients)
