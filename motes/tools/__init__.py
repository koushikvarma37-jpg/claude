"""Tool registry: every hand a mote has, each tagged with a risk level."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from ..config import RISK_LEVELS


@dataclass
class ToolContext:
    """What a tool can see about the run it is serving."""
    store: Any
    cfg: dict
    run_id: str | None = None
    goal: dict | None = None
    notifier: Any = None


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    func: Callable[[dict, ToolContext], str]
    risk: str = "read"
    # Optional per-call risk, e.g. `ls` is read but `rm` is destructive.
    risk_fn: Callable[[dict], str] | None = None
    source: str = "builtin"

    def risk_for(self, args: dict) -> str:
        risk = self.risk_fn(args) if self.risk_fn else self.risk
        return risk if risk in RISK_LEVELS else "destructive"

    def spec(self) -> dict:
        return {"type": "function",
                "function": {"name": self.name, "description": self.description,
                             "parameters": self.parameters}}


def params(required: list[str] | None = None, **props: dict) -> dict:
    return {"type": "object", "properties": props, "required": required or []}


@dataclass
class Registry:
    tools: dict[str, Tool] = field(default_factory=dict)

    def add(self, tool: Tool) -> None:
        self.tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self.tools.get(name)

    def specs(self) -> list[dict]:
        return [t.spec() for t in self.tools.values()]

    def __len__(self) -> int:
        return len(self.tools)
