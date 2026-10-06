"""`motes setup`: find Ollama, pick a model that fits this computer, download it, verify it."""

from __future__ import annotations

import ctypes
import json
import os
import platform
import shutil
import subprocess
import sys
import time

import httpx

from . import config

INSTALL_HINT = {
    "Darwin": "Download Ollama from https://ollama.com/download (or: brew install ollama)",
    "Linux": "curl -fsSL https://ollama.com/install.sh | sh",
    "Windows": "winget install Ollama.Ollama   (or download from https://ollama.com/download)",
}


def ollama_host(base_url: str) -> str:
    """http://localhost:11434/v1 -> http://localhost:11434"""
    return base_url.rstrip("/").removesuffix("/v1")


def total_ram_gb() -> float:
    try:
        if platform.system() == "Windows":
            class MemStatus(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            stat = MemStatus()
            stat.dwLength = ctypes.sizeof(MemStatus)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            return stat.ullTotalPhys / 2**30
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2**30
    except (OSError, ValueError, AttributeError):
        return 8.0


def nvidia_vram_gb() -> float:
    if not shutil.which("nvidia-smi"):
        return 0.0
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10).stdout
        return max((float(x) for x in out.split()), default=0.0) / 1024
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0.0


def hardware() -> dict:
    apple = platform.system() == "Darwin" and platform.machine() == "arm64"
    return {"ram_gb": round(total_ram_gb(), 1), "vram_gb": round(nvidia_vram_gb(), 1), "apple_silicon": apple}


def pick_model(hw: dict) -> tuple[str, str]:
    """The biggest Qwen3 that runs comfortably here, and why. All of them call tools well."""
    if hw["vram_gb"] >= 16 or (hw["apple_silicon"] and hw["ram_gb"] >= 32):
        return "qwen3:14b", "plenty of GPU memory"
    if hw["vram_gb"] >= 8 or (hw["apple_silicon"] and hw["ram_gb"] >= 16):
        return "qwen3:8b", "a GPU with room for an 8B model"
    if hw["vram_gb"] == 0 and not hw["apple_silicon"]:
        return "qwen3:4b", "no GPU found, so a small model keeps each step to a minute or two"
    return "qwen3:4b", "limited memory"


def ollama_version(host: str) -> str | None:
    try:
        return httpx.get(f"{host}/api/version", timeout=5).json().get("version")
    except (httpx.HTTPError, ValueError):
        return None


def start_ollama(host: str) -> str | None:
    """Start `ollama serve` in the background if the binary is installed but not running."""
    exe = shutil.which("ollama")
    if not exe:
        return None
    kwargs = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if platform.system() == "Windows":
        kwargs["creationflags"] = 0x00000008  # DETACHED_PROCESS
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen([exe, "serve"], **kwargs)
    for _ in range(30):
        time.sleep(1)
        if version := ollama_version(host):
            return version
    return None


def installed_models(host: str) -> set[str]:
    names = set()
    for m in httpx.get(f"{host}/api/tags", timeout=10).json().get("models", []):
        names.add(m["name"])
        if m["name"].endswith(":latest"):
            names.add(m["name"].removesuffix(":latest"))
    return names


def pull(host: str, model: str, out=sys.stdout) -> None:
    """Download a model, drawing a progress bar from Ollama's streamed status."""
    with httpx.stream("POST", f"{host}/api/pull", json={"model": model, "stream": True}, timeout=None) as resp:
        resp.raise_for_status()
        last = ""
        for line in resp.iter_lines():
            if not line:
                continue
            msg = json.loads(line)
            if msg.get("error"):
                raise RuntimeError(msg["error"])
            status, total, done = msg.get("status", ""), msg.get("total"), msg.get("completed")
            if total and done is not None:
                pct = done / total
                bar = "#" * int(pct * 30)
                out.write(f"\r  {bar:<30} {pct:5.1%}  {done / 2**30:.1f}/{total / 2**30:.1f} GB ")
                out.flush()
                last = "bar"
            elif status != last:
                out.write(("\n" if last == "bar" else "") + f"  {status}\n")
                last = status
    out.write("\n")


def capabilities(host: str, model: str) -> list[str]:
    try:
        return httpx.post(f"{host}/api/show", json={"model": model}, timeout=30).json().get("capabilities", [])
    except (httpx.HTTPError, ValueError):
        return []


def run(model: str | None = None, start: bool = True) -> int:
    path = config.init()
    cfg = config.load()
    host = ollama_host(cfg["brain"]["base_url"])
    print(f"Config: {path}")

    version = ollama_version(host)
    if not version and start and shutil.which("ollama"):
        print("Ollama is installed but not running; starting it...")
        version = start_ollama(host)
    if not version:
        print(f"\nOllama isn't running at {host}.")
        print(f"Install it:  {INSTALL_HINT.get(platform.system(), INSTALL_HINT['Linux'])}")
        print("Then run `motes setup` again.")
        return 1
    print(f"Ollama {version} is running at {host}")

    hw = hardware()
    gpu = f"{hw['vram_gb']} GB GPU" if hw["vram_gb"] else ("Apple Silicon" if hw["apple_silicon"] else "no GPU")
    reason = "your choice"
    if not model:
        model, reason = pick_model(hw)
    print(f"This computer: {hw['ram_gb']} GB RAM, {gpu}. Using {model} ({reason}).")

    if model in installed_models(host):
        print(f"{model} is already downloaded.")
    else:
        print(f"Downloading {model} (one time)...")
        try:
            pull(host, model)
        except (RuntimeError, httpx.HTTPError) as exc:
            print(f"Download failed: {exc}")
            return 1

    caps = capabilities(host, model)
    native = "tools" in caps or not caps
    if not native:
        print(f"Note: {model} has no native tool calling in Ollama, so Motes will use its text protocol.")

    config.update({"brain": {"model": model, "native_tools": native}})
    print(f"Saved. Brain and decision model: {model}.\nNext:  motes up")
    return 0
