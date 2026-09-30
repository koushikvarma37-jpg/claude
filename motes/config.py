"""Loading and saving ~/.motes/config.yaml."""

from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any

import yaml

RISK_LEVELS = ["read", "write", "external", "destructive"]

_DEFAULT_PATH = Path(__file__).with_name("default_config.yaml")


def home() -> Path:
    return Path(os.environ.get("MOTES_HOME", Path.home() / ".motes")).expanduser()


def config_path() -> Path:
    return home() / "config.yaml"


def defaults() -> dict[str, Any]:
    return yaml.safe_load(_DEFAULT_PATH.read_text())


def _merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = value
    return out


def load(path: Path | None = None) -> dict[str, Any]:
    """Defaults merged with the user's file, so new keys always have a value."""
    path = path or config_path()
    user = yaml.safe_load(path.read_text()) if path.exists() else {}
    return _merge(defaults(), user or {})


def init(force: bool = False) -> Path:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if force or not path.exists():
        path.write_text(_DEFAULT_PATH.read_text())
    return path


def save(cfg: dict[str, Any], path: Path | None = None) -> None:
    path = path or config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(cfg, sort_keys=False))


def risk_rank(risk: str) -> int:
    return RISK_LEVELS.index(risk) if risk in RISK_LEVELS else len(RISK_LEVELS) - 1
