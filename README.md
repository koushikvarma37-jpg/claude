<p align="center"><img src="docs/cast.png" alt="The eight motes: Pip, Ember, Tide, Nimbus, Byte, Mochi, Pebble and Luna" width="720"></p>

<h1 align="center">motes</h1>
<p align="center"><b>Always-on personal agents that live on your own computer.</b><br>
Open models. Your data stays home. They keep working while you sleep.</p>

---

Motes are small agents you hand goals to: *"every morning, summarize my inbox"*,
*"when CI fails, find the bug and open a PR"*, *"watch my server overnight"*.
They run in the background on a schedule or when something happens, use real
tools (shell, files, web, email, and hundreds of apps through MCP) and check
with you before doing anything that matters.

- **Your models.** Any OpenAI-compatible server: Ollama, LM Studio, vLLM, llama.cpp. No cloud API needed.
- **Two minds.** A *brain* (any open chat model) plans and acts. [**Laya**](https://github.com/NandhaKishorM/laya), a non-autoregressive System-1 decision engine, judges every risky action before it runs: calibrated probabilities in one forward pass, in 100+ languages. You can fine-tune it on your own approvals with Laya's RLCD training recipe.
- **Always on.** Goals run on schedules (`in 2h`, `daily 07:00`, `every 15m`, cron) or from webhooks. Motes can schedule their own one-off follow-ups ("check again in an hour"); a recurring job, or a follow-up that schedules more follow-ups, needs your OK. Runs save after every step, so they survive restarts, sleep and reboots, and pick up where they left off.
- **Hands for everything.** Shell, files, web search/fetch, HTTP APIs, email, long-term memory, notifications and follow-up tasks are built in. **Apps come through the Model Context Protocol**: add any MCP server, or a hub like Zapier, Composio or Pipedream to reach thousands of apps through one connection.
- **You stay in charge.** Every action has a risk level. Reads just happen. Anything that talks to the outside world waits in your *Needs you* inbox, and you get a desktop or phone ping. Approve once, or approve *all* calls of that tool for the rest of the run (handy when a mote is moving 50 files). Turn on *unattended mode* to let the decision model approve on your behalf while you sleep. Destructive actions always wait for you.
- **A cast of eight.** Pip, Ember, Tide, Nimbus, Byte, Mochi, Pebble and Luna each have a knack and a voice. Any of them can take any goal.

<p align="center"><img src="docs/dashboard.png" alt="The Motes dashboard with an action waiting for approval" width="820"></p>

## Quick start

```bash
# 1. The brain (https://ollama.com)
ollama pull qwen3:14b

# 2. The decision model: Laya (https://github.com/NandhaKishorM/laya)
pip install "laya[serve]"
laya-serve                # serves on :8000, downloads its checkpoints on first use

# 3. Motes
pip install git+https://github.com/<you>/motes    # or: git clone ... && pip install -e .
motes init            # writes ~/.motes/config.yaml
motes doctor          # checks the brain and Laya are reachable
motes up              # daemon + dashboard at http://localhost:7777
```

Or with Docker (Ollama and Laya included): `docker compose up -d`, then pull the brain model (see `docker-compose.yml`).

Give a mote a goal in the dashboard, or from the terminal:

```bash
motes add "Read my unread email and leave me a summary of what needs a reply" --mote tide --schedule "daily 07:00"
motes add "Check https://mysite.example.com/health and restart the service if it's down" --mote luna --schedule "every 15m"
motes approvals                 # what's waiting for you
motes approve <id> --note "ok, but cc me next time"
motes approve <id> --trust      # ...and every later call of that tool in this run
```

More ideas: [examples/goals.md](examples/goals.md).

## Hardware and speed

Each step, the brain reads the goal, its memory and the description of every tool
it can use (a few thousand tokens), then writes one tool call. Rough speeds:

| Machine | Brain | One step |
|---------|-------|----------|
| GPU with 12 GB+ (RTX 3060 and up) | `qwen3:14b` | a few seconds |
| Apple Silicon, 16 GB+ | `qwen3:8b` | a few seconds |
| CPU only, 4 cores | `qwen3:4b` (Qwen3-4B-Instruct-2507) | 1–3 minutes |

Motes was tested end to end on the last row: Qwen3-4B on a 4-core CPU with no GPU
correctly sorted a Downloads folder in 8 real tool calls, in about 40 minutes.
Slow, but that's the point of an agent that works while you sleep. To speed up a
CPU machine:

- Expose fewer tools: turn off built-ins you don't use (`tools:`), and give MCP apps an `include:` list.
- In llama.cpp, turn on flash attention (`-fa on`). Ollama does this automatically where supported.
- Run Laya as the decision model. It answers in one forward pass instead of generating text.

## Keep it running while you sleep

`motes up` runs until you stop it. To start it at boot and restart it if it crashes:

| OS | How |
|----|-----|
| Linux | `deploy/systemd/laya.service` + `deploy/systemd/motes.service` (instructions inside; `loginctl enable-linger` keeps them running when logged out) |
| macOS | `deploy/macos/com.motes.agent.plist` (wraps Motes in `caffeinate` so the Mac stays awake while it's running) |
| Windows | `deploy\windows\install-task.ps1` |
| Server / NAS | `docker compose up -d` |

The computer has to be on and awake. A spare laptop on power, a mini PC or a home server works well.

## Apps

```bash
motes apps               # list presets
motes apps add github    # copy one into your config
motes tools              # every tool the motes can use, with its risk level
```

Presets include filesystem, a real browser (Playwright), git, GitHub, Slack, Notion,
Postgres, Stripe, Google Maps, Brave Search, and three **hubs** (Zapier, Composio,
Pipedream). Each hub exposes hundreds to thousands of SaaS apps (Gmail,
Calendar, Sheets, HubSpot, Jira, Trello, Shopify...) behind one MCP URL. Any other
MCP server works too. Add it under `mcp_servers:` in `~/.motes/config.yaml`:

```yaml
mcp_servers:
  - name: home
    command: uvx
    args: ["some-mcp-server"]
    env: {API_KEY: "${HOME_API_KEY}"}   # read from the environment
    risk: external                        # default for tools without MCP annotations
    tool_risk: {get_state: read}          # per-tool overrides
    include: [get_state, set_state]       # optional: expose only these tools (or use exclude:)
  - name: my-hub
    url: https://example.com/mcp          # Streamable HTTP servers
```

Risk levels come from the MCP tool's own annotations (`readOnlyHint`,
`destructiveHint`) when it declares them.

## How decisions work

```
goal ─► brain (open LLM) ─► wants to call a tool
                               │
                     risk: read │ write │ external │ destructive
                               ▼
               ┌──────── decision gate ────────┐
   read ───────┤ run                           │
   write ──────┤ Laya may veto                 │
   external ───┤ ask you  (or, in unattended   │
               │ mode, Laya may approve if     │
               │ it's confident)               │
   destructive ┤ always ask you                │
               └───────────────────────────────┘
```

For each action, Motes sends Laya the goal, recent activity, the tool, its
arguments and the risk level. Laya answers four typed questions in one forward pass:

| question | type | used for |
|----------|------|----------|
| verdict | choice: approve / deny / ask_human | the decision and its confidence |
| on_goal | noul (probability of yes) | an approve that may not serve the goal becomes "ask me" |
| injected | noul | following instructions planted in a web page or email means **deny** |
| irreversible | noul | an approve that is hard to undo becomes "ask me" |

The verdict is asked under every option order and averaged, which cancels the
option-position bias Laya's authors measured. If Laya is unreachable, every
risky action waits for you. The dashboard shows Laya's reasoning on each
approval card (e.g. `Laya: ask_human 71% · on-goal 88% · injected 4% · irreversible 62%`).

### System 1 and System 2

Laya is **System 1**: it answers every decision instantly, in one forward pass,
with a calibrated confidence. A confident answer (at least `decision.system2.below`,
default 0.8) is final. When Laya is unsure, or unreachable, Motes escalates to
**System 2**: the chat model under `decision.llm` reasons through the same
situation step by step. System 2 can settle a doubt but can never overrule a
System 1 injection flag, and anything still unresolved comes to you. Every
decision in the dashboard is labelled `System 1 ·` or `System 2 ·`, so you can
see which mind made it.

Set `decision.system2.enabled: false` for Laya alone, or `decision.engine: llm` for a chat model alone.

### Teach Laya your taste

Laya's shipped checkpoints are a base to specialise. Its authors report
fine-tuning lifting accuracy from about 0.36 to 0.77 on their decision
benchmark. Every approve and deny you press is saved as a label, and

```bash
motes laya export --out data/laya-train.jsonl
```

writes them (plus 24 starter scenarios) in Laya's training format:
`state` + `questions` + `gold` target probabilities. Train with Laya's RLCD
recipe (proper-scoring-rule rewards, then temperature calibration), then point
`decision.laya.checkpoint` at the result. Walkthrough:
[training/README.md](training/README.md).

## Security notes

- The dashboard binds to `127.0.0.1`. If you expose it (for webhooks or from your phone), **set `server.token`** and put it behind HTTPS (e.g. Tailscale or a reverse proxy).
- Motes can run shell commands as your user. Start with the default policy, which asks before anything external, and loosen it only when you trust your setup.
- Content the motes read (web pages, emails) can contain prompt injections. The brain is told to treat it as data, and the decision model is prompted to catch manipulation, but neither is a guarantee. That is why risky actions wait for you by default.
- Secrets belong in environment variables (`~/.motes/env` for the systemd unit), not in the config.

## Project layout

```
motes/
  agent.py       the loop: think → gate → act → save, resumable
  laya_decider.py  Laya as the decision model (questions, rotation averaging, gating)
  laya_train.py  export your approvals as Laya fine-tuning / eval data
  decision.py    verdict type + the alternative chat-model judge
  daemon.py      always-on scheduler, crash recovery, worker pool
  llm.py         OpenAI-compatible client + text protocol for models without tool calling
  tools/         built-in tools and the MCP client (stdio + Streamable HTTP)
  rlcd.py        contrastive preference pairs for the chat-model judge
  server.py      dashboard API + webhooks
  web/           dashboard and the eight avatars (SVG)
training/        seed scenarios, DPO training script, guide
deploy/          systemd / launchd / Windows service files
```

## Development

```bash
pip install -e ".[dev]"
pytest
```

The tests use scripted fake models and a fake MCP server, so they need no GPU or network. With
`pip install --no-deps laya` they also check Motes' requests against Laya's real HTTP server code.

## License

MIT. The characters in `motes/web/avatars/` are original artwork released under the same license.

Laya is a separate project by its own authors under the Apache-2.0 license; Motes talks to it over its public API.
Motes is an independent open-source project and is not affiliated with any AI company.
