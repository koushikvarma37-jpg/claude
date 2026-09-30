"""Built-in hands: shell, files, web, HTTP, email, memory, notifications, follow-ups."""

from __future__ import annotations

import email
import email.header
import html
import imaplib
import os
import re
import shlex
import smtplib
import subprocess
import time
from email.message import EmailMessage
from pathlib import Path

import httpx

from .. import schedule as sched
from . import Registry, Tool, ToolContext, params

MAX_OUT = 12000
UA = {"User-Agent": "Mozilla/5.0 (compatible; Motes/0.1; +https://github.com/motes-ai/motes)"}


def _clip(text: str, limit: int = MAX_OUT) -> str:
    return text if len(text) <= limit else text[:limit] + f"\n...[truncated {len(text) - limit} chars]"


# --- shell ------------------------------------------------------------------

READ_CMDS = {
    "ls", "cat", "head", "tail", "pwd", "echo", "grep", "rg", "wc", "df", "du", "date",
    "whoami", "uname", "ps", "which", "stat", "file", "tree", "less", "sort", "uniq",
    "cut", "jq", "hostname", "uptime", "free", "top", "env", "printenv", "diff", "true",
}
READ_GIT = {"status", "log", "diff", "show", "branch", "remote", "rev-parse", "blame", "ls-files"}
NET_CMDS = {"curl", "wget", "ssh", "scp", "rsync", "sftp", "ftp", "nc", "telnet", "mail", "sendmail"}
DESTRUCTIVE = re.compile(
    r"(^|\s)(rm|rmdir|shred|mkfs\S*|dd|shutdown|reboot|halt|poweroff|kill|killall|pkill|format)(\s|$)"
    r"|git\s+(push\s+.*(-f|--force)|reset\s+--hard|clean\s+-\S*f)"
    r"|drop\s+(table|database)|truncate\s+table|>\s*/dev/sd",
    re.I,
)


def shell_risk(args: dict, goal: dict | None = None) -> str:
    cmd = args.get("command", "")
    if DESTRUCTIVE.search(cmd):
        return "destructive"
    worst = "read"
    for segment in re.split(r"\|\||&&|[|;]", cmd):
        if re.search(r"(^|[^2])>", segment):  # output redirection (not 2>&1)
            worst = max(worst, "write", key=_rank)
        try:
            words = shlex.split(segment)
        except ValueError:
            return "external"
        if not words:
            continue
        prog = os.path.basename(words[0])
        if prog in NET_CMDS:
            return "external"
        if prog == "git" and len(words) > 1 and words[1] in READ_GIT:
            continue
        if prog == "find" and not {"-delete", "-exec", "-execdir"} & set(words):
            continue
        if prog in READ_CMDS:
            continue
        # Unknown programs could do anything, so they need a judgement call.
        return "external"
    return worst


def _rank(risk: str) -> int:
    return ["read", "write", "external", "destructive"].index(risk)


def shell_run(args: dict, ctx: ToolContext) -> str:
    cwd = Path(args.get("cwd") or Path.home()).expanduser()
    proc = subprocess.run(
        args["command"], shell=True, cwd=cwd, capture_output=True, text=True,
        timeout=int(args.get("timeout", 120)),
    )
    out = proc.stdout + (f"\n[stderr]\n{proc.stderr}" if proc.stderr else "")
    return _clip(f"exit code {proc.returncode}\n{out}")


# --- files ------------------------------------------------------------------

def _path(p: str) -> Path:
    return Path(p).expanduser().resolve()


def read_file(args: dict, ctx: ToolContext) -> str:
    return _clip(_path(args["path"]).read_text(errors="replace"))


def write_file(args: dict, ctx: ToolContext) -> str:
    path = _path(args["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = "a" if args.get("append") else "w"
    with path.open(mode) as f:
        f.write(args["content"])
    return f"wrote {len(args['content'])} chars to {path}"


def list_dir(args: dict, ctx: ToolContext) -> str:
    path = _path(args.get("path") or "~")
    entries = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    lines = [f"{'d' if e.is_dir() else '-'} {e.name}" for e in entries[:500]]
    return "\n".join(lines) or "(empty)"


def delete_file(args: dict, ctx: ToolContext) -> str:
    path = _path(args["path"])
    path.unlink()
    return f"deleted {path}"


# --- web --------------------------------------------------------------------

def html_to_text(page: str) -> str:
    page = re.sub(r"(?is)<(script|style|noscript|svg).*?</\1>", " ", page)
    page = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h\d|tr)>", "\n", page)
    page = re.sub(r"<[^>]+>", " ", page)
    page = html.unescape(page)
    lines = (re.sub(r"[ \t\xa0]+", " ", line).strip() for line in page.splitlines())
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def web_fetch(args: dict, ctx: ToolContext) -> str:
    resp = httpx.get(args["url"], headers=UA, follow_redirects=True, timeout=30)
    resp.raise_for_status()
    kind = resp.headers.get("content-type", "")
    text = html_to_text(resp.text) if "html" in kind else resp.text
    return _clip(f"[{resp.status_code} {resp.url}]\n{text}")


def web_search(args: dict, ctx: ToolContext) -> str:
    query = args["query"]
    searx = ctx.cfg.get("tools", {}).get("searxng_url")
    if searx:
        resp = httpx.get(f"{searx.rstrip('/')}/search", params={"q": query, "format": "json"}, timeout=30)
        resp.raise_for_status()
        results = [(r["title"], r["url"], r.get("content", "")) for r in resp.json().get("results", [])[:8]]
    else:
        resp = httpx.post("https://html.duckduckgo.com/html/", data={"q": query}, headers=UA, timeout=30)
        resp.raise_for_status()
        links = re.findall(r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', resp.text, re.S)
        snippets = re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', resp.text, re.S)
        results = []
        for i, (url, title) in enumerate(links[:8]):
            if "uddg=" in url:
                url = httpx.URL(url if url.startswith("http") else "https:" + url).params.get("uddg", url)
            snippet = html_to_text(snippets[i]) if i < len(snippets) else ""
            results.append((html_to_text(title), url, snippet))
    if not results:
        return "no results"
    return "\n\n".join(f"{t}\n{u}\n{s}" for t, u, s in results)


def http_risk(args: dict, goal: dict | None = None) -> str:
    return "read" if args.get("method", "GET").upper() in ("GET", "HEAD") else "external"


def http_request(args: dict, ctx: ToolContext) -> str:
    body = args.get("body")
    resp = httpx.request(
        args.get("method", "GET").upper(), args["url"], headers=args.get("headers") or {},
        content=body if isinstance(body, str) else None,
        json=body if isinstance(body, (dict, list)) else None,
        timeout=60, follow_redirects=True,
    )
    return _clip(f"HTTP {resp.status_code}\n{resp.text}")


# --- email ------------------------------------------------------------------

def _email_cfg(ctx: ToolContext) -> tuple[dict, str]:
    ecfg = ctx.cfg.get("email", {})
    password = os.environ.get(ecfg.get("password_env", "MOTES_EMAIL_PASSWORD"), "")
    if not ecfg.get("username") or not password:
        raise RuntimeError("email is not configured (see email: in config.yaml)")
    return ecfg, password


def send_email(args: dict, ctx: ToolContext) -> str:
    ecfg, password = _email_cfg(ctx)
    msg = EmailMessage()
    msg["From"] = ecfg.get("from_address") or ecfg["username"]
    msg["To"] = args["to"]
    msg["Subject"] = args["subject"]
    msg.set_content(args["body"])
    with smtplib.SMTP(ecfg["smtp_host"], int(ecfg.get("smtp_port", 587)), timeout=30) as smtp:
        smtp.starttls()
        smtp.login(ecfg["username"], password)
        smtp.send_message(msg)
    return f"sent email to {args['to']}"


def _decode(value: str | None) -> str:
    return str(email.header.make_header(email.header.decode_header(value or "")))


def read_inbox(args: dict, ctx: ToolContext) -> str:
    ecfg, password = _email_cfg(ctx)
    limit = int(args.get("limit", 10))
    with imaplib.IMAP4_SSL(ecfg["imap_host"]) as imap:
        imap.login(ecfg["username"], password)
        imap.select("INBOX", readonly=True)
        _, data = imap.search(None, "UNSEEN" if args.get("unread_only", True) else "ALL")
        ids = data[0].split()[-limit:]
        out = []
        for mid in reversed(ids):
            _, parts = imap.fetch(mid, "(BODY.PEEK[])")
            msg = email.message_from_bytes(parts[0][1])
            body = ""
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    body = part.get_payload(decode=True).decode(errors="replace")
                    break
            out.append(f"From: {_decode(msg['From'])}\nSubject: {_decode(msg['Subject'])}\n"
                       f"Date: {msg['Date']}\n{body[:1500]}")
    return _clip("\n\n---\n\n".join(out) or "inbox empty")


# --- memory, notifications, follow-ups -------------------------------------

def remember(args: dict, ctx: ToolContext) -> str:
    ctx.store.remember(args["key"], args["value"])
    return f"remembered {args['key']}"


def recall(args: dict, ctx: ToolContext) -> str:
    rows = ctx.store.recall(args.get("query", ""))
    return "\n".join(f"{r['key']}: {r['value']}" for r in rows) or "nothing remembered yet"


def notify_owner(args: dict, ctx: ToolContext) -> str:
    title = args.get("title") or "Motes"
    ctx.store.log(ctx.run_id, "notify", title=title, message=args["message"])
    sent = ctx.notifier.send(title, args["message"]) if ctx.notifier else []
    return f"owner notified via {', '.join(sent) or 'dashboard'}"


def schedule_risk(args: dict, goal: dict | None = None) -> str:
    """One-off follow-ups are routine. A standing (recurring) job, or a follow-up that schedules
    more follow-ups, changes what runs on the owner's machine from now on, so it needs a say."""
    recurring = (args.get("schedule") or "once").strip().lower().split(" ")[0] in ("every", "daily", "cron")
    return "external" if recurring or (goal or {}).get("parent_id") else "write"


def schedule_task(args: dict, ctx: ToolContext) -> str:
    schedule = args.get("schedule") or "once"
    first = sched.next_run(schedule, time.time(), first=True)
    parent = ctx.goal or {}
    goal = ctx.store.add_goal(args["title"], args["instructions"], parent.get("character", "pip"),
                              schedule, first, parent_id=parent.get("id"))
    when = "only when triggered" if first is None else \
        "right away" if first <= time.time() + 1 else time.strftime("%Y-%m-%d %H:%M", time.localtime(first))
    return f"scheduled task {goal['id']} ({schedule}); it will first run {when}"


def register(reg: Registry, cfg: dict) -> None:
    tcfg = cfg.get("tools", {})
    string = {"type": "string"}

    if tcfg.get("shell", True):
        reg.add(Tool(
            "shell_run",
            "Run a shell command on the owner's computer. Returns exit code, stdout and stderr.",
            params(["command"], command=string, cwd={"type": "string", "description": "working directory"},
                   timeout={"type": "integer", "description": "seconds, default 120"}),
            shell_run, risk_fn=shell_risk,
        ))
    if tcfg.get("files", True):
        reg.add(Tool("read_file", "Read a text file.", params(["path"], path=string), read_file))
        reg.add(Tool("list_dir", "List a directory.", params([], path=string), list_dir))
        reg.add(Tool("write_file", "Write (or append to) a text file, creating folders as needed.",
                     params(["path", "content"], path=string, content=string, append={"type": "boolean"}),
                     write_file, risk="write"))
        reg.add(Tool("delete_file", "Delete a file.", params(["path"], path=string),
                     delete_file, risk="destructive"))
    if tcfg.get("web", True):
        reg.add(Tool("web_search", "Search the web. Returns titles, URLs and snippets.",
                     params(["query"], query=string), web_search))
        reg.add(Tool("web_fetch", "Fetch a URL and return its readable text.",
                     params(["url"], url=string), web_fetch))
        reg.add(Tool("http_request", "Make an HTTP request to an API. GET/HEAD are read-only; other methods act externally.",
                     params(["url"], url=string, method=string, headers={"type": "object"},
                            body={"anyOf": [{"type": "string"}, {"type": "object"}],
                                  "description": "string or JSON body"}),
                     http_request, risk_fn=http_risk))
    if tcfg.get("email", False):
        reg.add(Tool("read_inbox", "Read recent emails from the owner's inbox.",
                     params([], limit={"type": "integer"}, unread_only={"type": "boolean"}), read_inbox))
        reg.add(Tool("send_email", "Send an email from the owner's account.",
                     params(["to", "subject", "body"], to=string, subject=string, body=string),
                     send_email, risk="external"))

    reg.add(Tool("remember", "Save a fact to long-term memory, shared by all motes.",
                 params(["key", "value"], key=string, value=string), remember, untrusted=False))
    reg.add(Tool("recall", "Search long-term memory.", params([], query=string), recall, untrusted=False))
    reg.add(Tool("notify_owner", "Send the owner a short notification (phone/desktop).",
                 params(["message"], message=string, title=string), notify_owner, untrusted=False))
    reg.add(Tool(
        "schedule_task",
        "Create a follow-up task that runs later on its own. schedule examples: 'in 10m', 'in 2h', "
        "'in 1d' (one time, that long from now), 'every 30m', 'daily 08:00', 'cron 0 9 * * 1-5', "
        "'at YYYY-MM-DD HH:MM', or 'once' (right away).",
        params(["title", "instructions"], title=string, instructions=string, schedule=string),
        schedule_task, risk_fn=schedule_risk, untrusted=False,
    ))


__all__ = ["register", "shell_risk", "html_to_text"]
