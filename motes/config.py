"""Loading and saving ~/.motes/config.yaml."""

from __future__ import annotations

import copy
import logging
import os
import secrets
from pathlib import Path
from typing import Any

import yaml

RISK_LEVELS = ["read", "write", "external", "destructive"]

_DEFAULT_PATH = Path(__file__).with_name("default_config.yaml")
log = logging.getLogger("motes.config")

STARTER = """\
# Motes settings. Only what you change goes here; everything else uses the defaults.
# See every setting, with what it does, by running:  motes defaults
#
# Examples:
#   autonomy:
#     unattended: true        # let the decision model approve external actions while you sleep
#   decision:
#     model: qwen3:4b         # a smaller, quicker model for decisions
"""


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


def load_user(path: Path | None = None) -> dict[str, Any]:
    """Just what the user set, without defaults."""
    path = path or config_path()
    return (yaml.safe_load(path.read_text()) if path.exists() else None) or {}


def _migrate(user: dict) -> dict:
    """Carry settings from older releases over to their current names."""
    dec = user.get("decision") or {}
    old = dec.get("llm") if isinstance(dec.get("llm"), dict) else None
    if old or "engine" in dec or "laya" in dec:
        dec = dict(dec)
        for key in ("model", "base_url", "api_key"):
            if old and old.get(key) and not dec.get(key):
                dec[key] = old[key]
        for key in ("llm", "engine", "laya", "system2"):
            dec.pop(key, None)
        log.info("config: moved old decision settings to decision.model/base_url (Laya was removed)")
        user = {**user, "decision": dec}
    return user


def load(path: Path | None = None) -> dict[str, Any]:
    """Defaults merged with the user's file, so new keys always have a value."""
    return _merge(defaults(), _migrate(load_user(path)))


def init(force: bool = False) -> Path:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if force or not path.exists():
        path.write_text(STARTER)
    return path


def update(changes: dict[str, Any], path: Path | None = None) -> None:
    """Merge `changes` into the user's file, keeping its header comments and leaving defaults out."""
    path = path or config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    text = path.read_text() if path.exists() else STARTER
    header = "".join(line for line in text.splitlines(keepends=True)[:40] if line.startswith("#"))
    merged = _merge(load_user(path), changes)
    path.write_text(header + ("\n" if header else "") + yaml.safe_dump(merged, sort_keys=False))


def save(cfg: dict[str, Any], path: Path | None = None) -> None:
    """Replace the user's file entirely (prefer `update`)."""
    path = path or config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(cfg, sort_keys=False))


def access_token(create: bool = False) -> str:
    """server.token from the config, else the private token file (made on demand)."""
    if token := load()["server"].get("token"):
        return token
    path = home() / "token"
    if path.exists():
        return path.read_text().strip()
    if not create:
        return ""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(secrets.token_urlsafe(18))
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return path.read_text().strip()


def risk_rank(risk: str) -> int:
    return RISK_LEVELS.index(risk) if risk in RISK_LEVELS else len(RISK_LEVELS) - 1
