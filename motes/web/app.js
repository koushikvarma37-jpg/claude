// Motes dashboard. Everything shown here may contain text from the web or email, so it is always escaped.
const qs = new URLSearchParams(location.search);
let token = qs.get("token") || "";
try { if (token) localStorage.setItem("motes-token", token); else token = localStorage.getItem("motes-token") || ""; } catch (e) {}

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ago = (t) => { const s = Date.now() / 1000 - t; return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(t * 1000).toLocaleString(); };
const when = (t) => (t ? new Date(t * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
const avatar = (id) => `/static/avatars/${encodeURIComponent(id || "pip")}.svg`;

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { "content-type": "application/json", "x-motes-token": token, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}

let chars = [], selected = "pip", tab = "approvals";

async function loadCast() {
  chars = await api("/api/characters");
  $("#g-char").innerHTML = chars.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} · ${esc(c.knack)}</option>`).join("");
}

function renderCast(status) {
  const labels = { running: "working", waiting_approval: "needs you", queued: "about to start", done: "resting", failed: "stuck", cancelled: "resting" };
  $("#cast").innerHTML = chars.map((c) => {
    const st = status.characters[c.id];
    const cls = st === "running" || st === "queued" ? "running" : st ? "" : "idle";
    return `<div class="mote ${cls} ${c.id === selected ? "sel" : ""}" data-id="${esc(c.id)}" title="${esc(c.voice)}">
      <img src="${avatar(c.id)}" alt=""><b>${esc(c.name)}</b><small>${esc(c.knack)}</small>
      <div class="st s-${esc(st || "")}">${esc(labels[st] || "sleeping")}</div></div>`;
  }).join("");
  document.querySelectorAll(".mote").forEach((el) => el.onclick = () => { selected = el.dataset.id; $("#g-char").value = selected; renderCast(status); $("#g-text").focus(); });
}

function renderStatus(s) {
  $("#status").innerHTML = `<span>brain <b>${esc(s.brain)}</b></span>
    <span>decider <b>${esc(s.decision || "off")}</b></span>
    <span>${s.tools} hands · ${s.apps.length} apps</span>
    <span class="pill ${s.unattended ? "on" : ""}">${s.unattended ? "unattended mode" : "asks before acting"}</span>`;
  $("#badge").textContent = s.pending_approvals || "";
  document.title = s.pending_approvals ? `(${s.pending_approvals}) Motes` : "Motes";
}

const empty = (img, text) => `<div class="empty"><img src="${avatar(img)}" alt="">${esc(text)}</div>`;

async function renderApprovals() {
  const items = await api("/api/approvals");
  $("#tab-approvals").innerHTML = items.length ? items.map((a) => `
    <div class="card"><img src="${avatar(a.character)}" alt="">
      <div class="body">
        <div class="title">${esc(a.tool)} <span class="risk ${esc(a.risk)}">${esc(a.risk)}</span></div>
        <div class="meta">for “${esc(a.goal)}” · ${ago(a.created_at)}</div>
        <pre>${esc(JSON.stringify(a.args, null, 2))}</pre>
        ${a.reason ? `<div class="meta">Decision model: ${esc(a.reason)}</div>` : ""}
        <div class="actions"><input placeholder="note for the mote (optional)" data-note="${esc(a.id)}">
          <button class="ok" data-approve="${esc(a.id)}">Approve</button>
          <button data-trust="${esc(a.id)}" title="Approve this and every later ${esc(a.tool)} call in this run">Approve all ${esc(a.tool.split("__").pop())} this run</button>
          <button class="bad" data-deny="${esc(a.id)}">Deny</button></div>
      </div></div>`).join("") : empty("luna", "Nothing needs you. The motes are on it.");
  const decide = async (id, approve, trust_tool = false) => {
    const note = document.querySelector(`[data-note="${CSS.escape(id)}"]`).value;
    await api(`/api/approvals/${id}`, { method: "POST", body: JSON.stringify({ approve, note, trust_tool }) });
    refresh();
  };
  document.querySelectorAll("[data-approve]").forEach((b) => b.onclick = () => decide(b.dataset.approve, true));
  document.querySelectorAll("[data-deny]").forEach((b) => b.onclick = () => decide(b.dataset.deny, false));
  document.querySelectorAll("[data-trust]").forEach((b) => b.onclick = () => decide(b.dataset.trust, true, true));
}

async function renderActivity() {
  const [runs, goals] = await Promise.all([api("/api/runs?limit=40"), api("/api/goals")]);
  const g = Object.fromEntries(goals.map((x) => [x.id, x]));
  $("#tab-activity").innerHTML = runs.length ? runs.map((r) => `
    <div class="card" data-run="${esc(r.id)}" style="cursor:pointer"><img src="${avatar(g[r.goal_id]?.character)}" alt="">
      <div class="body"><div class="title">${esc(g[r.goal_id]?.title || "deleted goal")}</div>
        <div class="meta"><span class="s-${esc(r.status)}">${esc(r.status.replace("_", " "))}</span> · ${esc(r.trigger)} · ${ago(r.updated_at)} · ${r.step} steps</div>
        ${r.result ? `<pre>${esc(r.result)}</pre>` : ""}</div></div>`).join("") : empty("pip", "No activity yet. Give a mote a goal above.");
  document.querySelectorAll("[data-run]").forEach((el) => el.onclick = () => showRun(el.dataset.run));
}

async function showRun(id) {
  const r = await api(`/api/runs/${id}`);
  const body = (e) => {
    const d = e.data;
    if (e.kind === "thought") return `<pre>${esc(d.text)}</pre>`;
    if (e.kind === "tool_call") return `<pre>${esc(d.tool)} ${esc(JSON.stringify(d.args, null, 1))}</pre>`;
    if (e.kind === "tool_result") return `<pre>${d.ok ? "" : "⚠ "}${esc(d.result)}</pre>`;
    if (e.kind === "decision") return `<div>${esc(d.verdict)} (${Math.round((d.confidence || 0) * 100)}%): ${esc(d.reason)}</div>`;
    return `<pre>${esc(JSON.stringify(d, null, 1))}</pre>`;
  };
  $("#run-body").innerHTML = `<h2>Run ${esc(r.id)} · <span class="s-${esc(r.status)}">${esc(r.status)}</span></h2>` +
    r.events.map((e) => `<div class="ev"><div class="k">${esc(e.kind.replace("_", " "))} · ${new Date(e.ts * 1000).toLocaleTimeString()}</div>${body(e)}</div>`).join("") +
    (r.status === "running" || r.status === "waiting_approval" || r.status === "queued" ? `<button class="bad" id="cancel-run">Cancel run</button>` : "");
  const c = $("#cancel-run");
  if (c) c.onclick = async () => { await api(`/api/runs/${id}/cancel`, { method: "POST" }); $("#run-dialog").close(); refresh(); };
  $("#run-dialog").showModal();
}

async function renderGoals() {
  const goals = await api("/api/goals");
  $("#tab-goals").innerHTML = goals.length ? goals.map((g) => `
    <div class="card"><img src="${avatar(g.character)}" alt="">
      <div class="body"><div class="title">${esc(g.title)}</div>
        <div class="meta">${esc(g.schedule)} · next ${g.enabled ? when(g.next_run_at) : "paused"}${g.parent_id ? " · follow-up a mote scheduled" : ""} · id ${esc(g.id)}</div>
        <pre>${esc(g.instructions)}</pre>
        <div class="actions"><button data-run-now="${esc(g.id)}">Run now</button>
          <button data-toggle="${esc(g.id)}" data-on="${g.enabled}">${g.enabled ? "Pause" : "Resume"}</button>
          <button class="bad" data-del="${esc(g.id)}">Delete</button></div>
        <div class="meta">Webhook: POST /api/hooks/${esc(g.id)}</div></div></div>`).join("") : empty("mochi", "No goals yet.");
  document.querySelectorAll("[data-run-now]").forEach((b) => b.onclick = async () => { await api(`/api/goals/${b.dataset.runNow}/run`, { method: "POST" }); refresh(); });
  document.querySelectorAll("[data-toggle]").forEach((b) => b.onclick = async () => {
    await api(`/api/goals/${b.dataset.toggle}`, { method: "PATCH", body: JSON.stringify({ enabled: b.dataset.on !== "1" }) }); refresh(); });
  document.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
    if (confirm("Delete this goal?")) { await api(`/api/goals/${b.dataset.del}`, { method: "DELETE" }); refresh(); } });
}

async function renderTools() {
  const tools = await api("/api/tools");
  $("#tab-tools").innerHTML = `<div class="panel"><p class="meta">Add apps with <code>motes apps add &lt;name&gt;</code>. Hubs like Zapier, Composio and Pipedream each connect hundreds to thousands of apps; any MCP server works.</p>
    <table>${tools.map((t) => `<tr><td>${esc(t.name)}</td><td><span class="risk ${esc(t.risk)}">${esc(t.dynamic_risk ? "varies" : t.risk)}</span></td><td>${esc(t.description)}</td></tr>`).join("")}</table></div>`;
}

async function renderMessages() {
  const items = (await api("/api/notifications?limit=5"));
  $("#inbox").hidden = !items.length;
  $("#messages").innerHTML = items.map((n) => `
    <div class="msg"><img src="${avatar(n.character)}" alt="">
      <div><b>${esc(n.title)}</b> ${esc(n.message)}<div class="meta">${esc(n.goal || "")} · ${ago(n.ts)}</div></div></div>`).join("");
}

const renderers = { approvals: renderApprovals, activity: renderActivity, goals: renderGoals, tools: renderTools };

async function refresh() {
  try {
    const s = await api("/api/status");
    renderStatus(s); renderCast(s); await renderMessages();
    if (tab !== "tools") await renderers[tab]();
  } catch (e) {
    $("#status").textContent = e.message === "missing or wrong token" ? "Open this page with ?token=YOUR_TOKEN" : `offline: ${e.message}`;
  }
}

document.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => {
  tab = b.dataset.tab;
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x.id === `tab-${tab}`));
  renderers[tab]().catch(() => {});
});

$("#g-char").onchange = (e) => { selected = e.target.value; refresh(); };
$("#goal-form").onsubmit = async (e) => {
  e.preventDefault();
  $("#g-err").textContent = "";
  try {
    await api("/api/goals", { method: "POST", body: JSON.stringify({ title: "", instructions: $("#g-text").value, character: $("#g-char").value, schedule: $("#g-sched").value }) });
    $("#g-text").value = "";
    document.querySelector('[data-tab="activity"]').click();
    refresh();
  } catch (err) { $("#g-err").textContent = err.message; }
};

loadCast().then(refresh);
setInterval(() => { if (!document.hidden && !$("#run-dialog").open) refresh(); }, 3000);
