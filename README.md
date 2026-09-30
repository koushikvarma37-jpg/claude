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
- **Two minds.** A *brain* model plans and acts. A separate *decision model* judges every risky action before it runs. You can fine-tune the decision model on your own approvals with RLCD.
- **Always on.** Goals run on schedules (`daily 07:00`, `every 15m`, cron) or from webhooks. Runs save after every step, so they survive restarts, sleep and reboots, and pick up where they left off.
- **Hands for everything.** Shell, files, web search/fetch, HTTP APIs, email, long-term memory, notifications and follow-up tasks are built in. **Apps come through the Model Context Protocol**: add any MCP server, or a hub like Zapier, Composio or Pipedream to reach thousands of apps through one connection.
- **You stay in charge.** Every action has a risk level. Reads just happen. Anything that talks to the outside world waits in your *Needs you* inbox, and you get a desktop or phone ping. Turn on *unattended mode* to let the decision model approve on your behalf while you sleep. Destructive actions always wait for you.
- **A cast of eight.** Pip, Ember, Tide, Nimbus, Byte, Mochi, Pebble and Luna each have a knack and a voice. Any of them can take any goal.

<p align="center"><img src="docs/dashboard.png" alt="The Motes dashboard with an action waiting for approval" width="820"></p>

## Quick start

```bash
# 1. Models (https://ollama.com)
ollama pull qwen3:14b     # the brain
ollama pull qwen3:4b      # the decision model

# 2. Motes
pip install git+https://github.com/<you>/motes    # or: git clone ... && pip install -e .
motes init            # writes ~/.motes/config.yaml
motes doctor          # checks the models are reachable
motes up              # daemon + dashboard at http://localhost:7777
```

Or with Docker (Ollama included): `docker compose up -d`, then pull the models (see `docker-compose.yml`).

Give a mote a goal in the dashboard, or from the terminal:

```bash
motes add "Read my unread email and leave me a summary of what needs a reply" --mote tide --schedule "daily 07:00"
motes add "Check https://mysite.example.com/health and restart the service if it's down" --mote luna --schedule "every 15m"
motes approvals                 # what's waiting for you
motes approve <id> --note "ok, but cc me next time"
```

More ideas: [examples/goals.md](examples/goals.md).

## Keep it running while you sleep

`motes up` runs until you stop it. To start it at boot and restart it if it crashes:

| OS | How |
|----|-----|
| Linux | `deploy/systemd/motes.service` (instructions inside; `loginctl enable-linger` keeps it running when logged out) |
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
   write ──────┤ decision model may veto       │
   external ───┤ ask you  (or, in unattended   │
               │ mode, the decision model may  │
               │ approve if it's confident)    │
   destructive ┤ always ask you                │
               └───────────────────────────────┘
```

All of this is configurable under `autonomy:` in the config. Every judgement the
decision model makes is logged, and every approve or deny you press is saved as a
label.

### Train your own decision model (RLCD)

`motes rlcd build` turns those logs into preference pairs with
[RLCD](https://arxiv.org/abs/2307.12950) (Reinforcement Learning from Contrastive
Distillation). The same model judges each situation under a *careful* prompt and a
*careless* prompt; the careful answer is preferred. Wherever you gave a real
answer, yours wins. `training/train_dpo.py` then fine-tunes a small open model on
the pairs with DPO + LoRA, and you serve it through Ollama. Details:
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
  decision.py    the decision model (judge prompt + verdict parsing)
  daemon.py      always-on scheduler, crash recovery, worker pool
  llm.py         OpenAI-compatible client + text protocol for models without tool calling
  tools/         built-in tools and the MCP client (stdio + Streamable HTTP)
  rlcd.py        RLCD preference-pair builder
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

The tests use scripted fake models and a fake MCP server, so they need no GPU or network.

## License

MIT. The characters in `motes/web/avatars/` are original artwork released under the same license.

Motes is an independent open-source project and is not affiliated with any AI company.
