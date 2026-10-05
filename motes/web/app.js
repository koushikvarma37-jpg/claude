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
const rendered = {};
// Redraw a region only when its content changed, so focus and half-typed notes survive the refresh.
function setHTML(el, html) {
  if (rendered[el.id] === html) return false;
  rendered[el.id] = html; el.innerHTML = html; return true;
}
function announce(text) { const a = $("#announcer"); a.textContent = ""; setTimeout(() => (a.textContent = text), 50); }

async function loadCast() {
  chars = await api("/api/characters");
  $("#g-char").innerHTML = chars.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} · ${esc(c.knack)}</option>`).join("");
}

const STATE_LABEL = { running: "working", waiting_approval: "needs you", queued: "about to start", done: "resting", failed: "stuck", cancelled: "resting" };

function renderCast(status) {
  setHTML($("#cast"), chars.map((c) => {
    const st = status.characters[c.id];
    const cls = st === "running" || st === "queued" ? "running" : st ? "" : "idle";
    const label = STATE_LABEL[st] || "sleeping";
    return `<button type="button" class="mote ${cls}" data-id="${esc(c.id)}" aria-pressed="${c.id === selected}"
      aria-label="${esc(c.name)}, ${esc(c.knack)}, ${esc(label)}" title="${esc(c.voice)}">
      <img src="${avatar(c.id)}" alt=""><b>${esc(c.name)}</b><small>${esc(c.knack)}</small>
      <span class="st s-${esc(st || "")}">${esc(label)}</span></button>`;
  }).join(""));
  document.querySelectorAll(".mote").forEach((el) => el.onclick = () => {
    selected = el.dataset.id; $("#g-char").value = selected;
    document.querySelectorAll(".mote").forEach((m) => m.setAttribute("aria-pressed", m === el));
    $("#g-text").focus();
  });
}

let lastPending = null;
function renderStatus(s) {
  setHTML($("#status"), `<span>brain <b>${esc(s.brain)}</b></span>
    <span>decides with <b>${esc(s.decision || "you")}</b></span>
    <span>${s.tools} hands · ${s.apps.length} apps</span>
    <span class="pill ${s.unattended ? "on" : ""}">${s.unattended ? "unattended mode" : "asks before acting"}</span>`);
  $("#badge").textContent = s.pending_approvals || "";
  $("#t-approvals").setAttribute("aria-label", s.pending_approvals ? `Needs you, ${s.pending_approvals} waiting` : "Needs you");
  document.title = s.pending_approvals ? `(${s.pending_approvals}) Motes` : "Motes";
  if (lastPending !== null && s.pending_approvals > lastPending) announce(`${s.pending_approvals} action${s.pending_approvals > 1 ? "s" : ""} waiting for your approval.`);
  lastPending = s.pending_approvals;
}

const empty = (img, text) => `<div class="empty"><img src="${avatar(img)}" alt="">${esc(text)}</div>`;

async function renderApprovals() {
  const items = await api("/api/approvals");
  const changed = setHTML($("#tab-approvals"), items.length ? items.map((a) => `
    <article class="card" aria-labelledby="ap-${esc(a.id)}"><img src="${avatar(a.character)}" alt="">
      <div class="body">
        <h3 class="title" id="ap-${esc(a.id)}">${esc(a.tool)} <span class="risk ${esc(a.risk)}">${esc(a.risk)}</span></h3>
        <div class="meta">for “${esc(a.goal)}” · ${ago(a.created_at)}</div>
        <pre>${esc(JSON.stringify(a.args, null, 2))}</pre>
        ${a.reason ? `<div class="meta">Decision model: ${esc(a.reason)}</div>` : ""}
        <div class="actions"><label class="sr-only" for="note-${esc(a.id)}">Note for the mote</label>
          <input id="note-${esc(a.id)}" placeholder="note for the mote (optional)" data-note="${esc(a.id)}">
          <button class="ok" data-approve="${esc(a.id)}">Approve</button>
          <button data-trust="${esc(a.id)}" title="Approve this and every later ${esc(a.tool)} call in this run">Approve all ${esc(a.tool.split("__").pop())} this run</button>
          <button class="bad" data-deny="${esc(a.id)}">Deny</button></div>
      </div></article>`).join("") : empty("luna", "Nothing needs you. The motes are on it."));
  if (!changed) return;
  const decide = async (id, approve, trust_tool = false) => {
    const note = document.querySelector(`[data-note="${CSS.escape(id)}"]`).value;
    await api(`/api/approvals/${id}`, { method: "POST", body: JSON.stringify({ approve, note, trust_tool }) });
    announce(approve ? "Approved." : "Denied.");
    await refresh(); $("#t-approvals").focus();
  };
  document.querySelectorAll("[data-approve]").forEach((b) => b.onclick = () => decide(b.dataset.approve, true));
  document.querySelectorAll("[data-deny]").forEach((b) => b.onclick = () => decide(b.dataset.deny, false));
  document.querySelectorAll("[data-trust]").forEach((b) => b.onclick = () => decide(b.dataset.trust, true, true));
}

async function renderActivity() {
  const [runs, goals] = await Promise.all([api("/api/runs?limit=40"), api("/api/goals")]);
  const g = Object.fromEntries(goals.map((x) => [x.id, x]));
  const changed = setHTML($("#tab-activity"), runs.length ? runs.map((r) => `
    <article class="card"><img src="${avatar(g[r.goal_id]?.character)}" alt="">
      <div class="body"><h3 class="title"><button class="card-open" data-run="${esc(r.id)}">${esc(g[r.goal_id]?.title || "deleted goal")}</button></h3>
        <div class="meta"><span class="s-${esc(r.status)}">${esc(r.status.replace("_", " "))}</span> · ${esc(r.trigger)} · ${ago(r.updated_at)} · ${r.step} steps</div>
        ${r.result ? `<pre>${esc(r.result)}</pre>` : ""}</div></article>`).join("") : empty("pip", "No activity yet. Give a mote a goal above."));
  if (changed) document.querySelectorAll("[data-run]").forEach((el) => el.onclick = () => showRun(el.dataset.run));
}

async function showRun(id) {
  const r = await api(`/api/runs/${id}`);
  const body = (e) => {
    const d = e.data;
    if (e.kind === "thought") return `<pre>${esc(d.text)}</pre>`;
    if (e.kind === "tool_call") return `<pre>${esc(d.tool)} ${esc(JSON.stringify(d.args, null, 1))}</pre>`;
    if (e.kind === "tool_result") return `<pre>${d.ok ? "" : "Failed: "}${esc(d.result)}</pre>`;
    if (e.kind === "decision") return `<div>${esc(d.verdict)} (${Math.round((d.confidence || 0) * 100)}%): ${esc(d.reason)}</div>`;
    return `<pre>${esc(JSON.stringify(d, null, 1))}</pre>`;
  };
  $("#run-body").innerHTML = `<h2 id="run-title">Run ${esc(r.id)} · <span class="s-${esc(r.status)}">${esc(r.status.replace("_", " "))}</span></h2><ol class="timeline">` +
    r.events.map((e) => `<li class="ev"><div class="k">${esc(e.kind.replace("_", " "))} · ${new Date(e.ts * 1000).toLocaleTimeString()}</div>${body(e)}</li>`).join("") + "</ol>" +
    (["running", "waiting_approval", "queued"].includes(r.status) ? `<button class="bad" id="cancel-run">Cancel run</button>` : "");
  const c = $("#cancel-run");
  if (c) c.onclick = async () => { await api(`/api/runs/${id}/cancel`, { method: "POST" }); $("#run-dialog").close(); announce("Run cancelled."); refresh(); };
  $("#run-dialog").showModal();
}

async function renderGoals() {
  const goals = await api("/api/goals");
  const changed = setHTML($("#tab-goals"), goals.length ? goals.map((g) => `
    <article class="card" aria-labelledby="g-${esc(g.id)}"><img src="${avatar(g.character)}" alt="">
      <div class="body"><h3 class="title" id="g-${esc(g.id)}">${esc(g.title)}</h3>
        <div class="meta">${esc(g.schedule)} · next ${g.enabled ? when(g.next_run_at) : "paused"}${g.parent_id ? " · follow-up a mote scheduled" : ""}</div>
        <pre>${esc(g.instructions)}</pre>
        <div class="actions"><button data-run-now="${esc(g.id)}">Run now</button>
          <button data-toggle="${esc(g.id)}" data-on="${g.enabled}">${g.enabled ? "Pause" : "Resume"}</button>
          <button class="bad" data-del="${esc(g.id)}" aria-label="Delete goal ${esc(g.title)}">Delete</button></div>
        <div class="meta">Webhook: POST /api/hooks/${esc(g.id)}</div></div></article>`).join("") : empty("mochi", "No goals yet."));
  if (!changed) return;
  document.querySelectorAll("[data-run-now]").forEach((b) => b.onclick = async () => { await api(`/api/goals/${b.dataset.runNow}/run`, { method: "POST" }); announce("Started."); refresh(); });
  document.querySelectorAll("[data-toggle]").forEach((b) => b.onclick = async () => {
    await api(`/api/goals/${b.dataset.toggle}`, { method: "PATCH", body: JSON.stringify({ enabled: b.dataset.on !== "1" }) });
    announce(b.dataset.on === "1" ? "Paused." : "Resumed."); refresh(); });
  document.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
    if (confirm("Delete this goal?")) { await api(`/api/goals/${b.dataset.del}`, { method: "DELETE" }); announce("Goal deleted."); refresh(); } });
}

async function renderTools() {
  const tools = await api("/api/tools");
  setHTML($("#tab-tools"), `<div class="panel"><p class="meta">Add apps with <code>motes apps add &lt;name&gt;</code>. Hubs like Zapier, Composio and Pipedream each connect hundreds to thousands of apps; any MCP server works.</p>
    <div style="overflow-x:auto"><table><caption class="sr-only">Tools the motes can use, with their risk level</caption>
    <thead class="sr-only"><tr><th scope="col">Tool</th><th scope="col">Risk</th><th scope="col">What it does</th></tr></thead><tbody>
    ${tools.map((t) => `<tr><td>${esc(t.name)}</td><td><span class="risk ${esc(t.risk)}">${esc(t.dynamic_risk ? "varies" : t.risk)}</span></td><td>${esc(t.description)}</td></tr>`).join("")}</tbody></table></div></div>`);
}

let lastMessage = null;
async function renderMessages() {
  const items = await api("/api/notifications?limit=5");
  $("#inbox").hidden = !items.length;
  setHTML($("#messages"), items.map((n) => `
    <div class="msg"><img src="${avatar(n.character)}" alt="">
      <div><b>${esc(n.title)}</b> ${esc(n.message)}<div class="meta">${esc(n.goal || "")} · ${ago(n.ts)}</div></div></div>`).join(""));
  if (items[0] && lastMessage !== null && items[0].id !== lastMessage) announce(`New message: ${items[0].title}. ${items[0].message}`);
  lastMessage = items[0] ? items[0].id : 0;
}

const renderers = { approvals: renderApprovals, activity: renderActivity, goals: renderGoals, tools: renderTools };

async function refresh() {
  try {
    const s = await api("/api/status");
    renderStatus(s); renderCast(s); await renderMessages();
    if (tab !== "tools") await renderers[tab]();
  } catch (e) {
    $("#status").textContent = e.message === "missing or wrong token"
      ? "This dashboard needs its access link. Open the link `motes up` printed (it ends in ?token=...)." : `Can't reach Motes: ${e.message}`;
  }
}

// Tabs: click, or arrow keys / Home / End when a tab has focus (WAI-ARIA tabs pattern).
const tabButtons = [...document.querySelectorAll('[role="tab"]')];
function selectTab(b, focus = true) {
  tab = b.dataset.tab;
  tabButtons.forEach((x) => { const on = x === b; x.setAttribute("aria-selected", on); x.tabIndex = on ? 0 : -1; });
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x.id === `tab-${tab}`));
  if (focus) b.focus();
  renderers[tab]().catch(() => {});
}
tabButtons.forEach((b, i) => {
  b.onclick = () => selectTab(b);
  b.onkeydown = (e) => {
    const n = tabButtons.length;
    const next = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
    if (next !== undefined) { e.preventDefault(); selectTab(tabButtons[next]); }
  };
});

$("#g-char").onchange = (e) => { selected = e.target.value; refresh(); };
$("#goal-form").onsubmit = async (e) => {
  e.preventDefault();
  $("#g-err").textContent = "";
  try {
    await api("/api/goals", { method: "POST", body: JSON.stringify({ title: "", instructions: $("#g-text").value, character: $("#g-char").value, schedule: $("#g-sched").value }) });
    $("#g-text").value = "";
    announce(`${$("#g-char").selectedOptions[0].text.split(" · ")[0]} took the goal.`);
    selectTab($("#t-activity"), false);
    refresh();
  } catch (err) { $("#g-err").textContent = err.message; }
};

loadCast().then(refresh);
setInterval(() => { if (!document.hidden && !$("#run-dialog").open) refresh(); }, 3000);
