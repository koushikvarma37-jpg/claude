// Relay's window: the command bar, the live step list, approvals, voice and settings.
(function () {
  const $ = (s) => document.querySelector(s);
  const app = $("#app"), feed = $("#feed"), input = $("#input"), bar = $("#bar"), hint = $("#hint");
  const statusEl = $("#status"), statusText = $("#statusText");
  const recorder = new window.RelayRecorder($("#wave"));
  const HINT = hint.innerHTML;
  const EMPTY_TEMPLATE = document.getElementById("empty").cloneNode(true); // fresh start screen for new conversations

  let busy = false, listening = false, transcribing = false;
  let pendingSpoken = false;          // the text in the box came from the mic
  let currentTurn = null;             // { el, steps: Map, thinkingEl }
  let activeConfirm = null;           // { id, el, resolve }
  let settings = { hasKey: false, speakReplies: true, autoRunVoice: false, model: "gemini-flash-latest" };
  let turnCounter = 0;
  let convo = { id: null, turns: [] }; // the conversation on screen, as plain data that can be saved and restored

  const ICON = {
    type: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    done: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    failed: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>',
    cancelled: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
    waiting: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2.5"/></svg>',
  };

  const TOOL_TITLES = {
    list_folder: "Looking inside a folder", find_files: "Searching your files", create_folder: "Creating a folder",
    move_files: "Moving files", organize_folder: "Organizing a folder", rename_item: "Renaming",
    delete_items: "Sending to the Recycle Bin", open_path: "Opening", open_app: "Opening an app",
    open_url: "Opening a website", web_search: "Searching the web", undo_last: "Undoing the last change",
  };
  const firstArg = (a) => a.path || a.name || a.query || a.url || a.destination || (a.paths && a.paths.join(", ")) || a.from_folder || "";

  // ---------- Status ----------
  function setStatus(state, text) {
    statusEl.dataset.state = state;
    statusText.textContent = text;
  }
  function setBusy(b) {
    busy = b;
    app.classList.toggle("busy", b);
    $("#sendBtn").title = b ? "Stop" : "Run (Enter)";
    $("#sendBtn").setAttribute("aria-label", b ? "Stop" : "Run");
    if (!b) setStatus("ready", "Ready");
  }

  // ---------- Safe mini-markdown for replies ----------
  function esc(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="#" data-link="$2">$1</a>');
  }
  function markdown(text) {
    const lines = text.replace(/\r/g, "").split("\n");
    let html = "", list = null, para = [];
    const flushPara = () => { if (para.length) { html += `<p>${para.map(inline).join("<br>")}</p>`; para = []; } };
    const flushList = () => { if (list) { html += `<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`; list = null; } };
    for (const line of lines) {
      const ul = line.match(/^\s*[-*•]\s+(.*)/), ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      if (ul || ol) {
        flushPara();
        const tag = ul ? "ul" : "ol";
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push((ul || ol)[1]);
      } else if (!line.trim()) { flushPara(); flushList(); }
      else { flushList(); para.push(line); }
    }
    flushPara(); flushList();
    return html;
  }
  const plain = (t) => t.replace(/\*\*|`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^\s*[-*•]\s+/gm, "");

  // ---------- Feed ----------
  function clearEmpty() { const e = $("#empty"); if (e) e.remove(); }
  function scrollDown() { feed.scrollTop = feed.scrollHeight; }

  function newTurn(text, spoken) {
    clearEmpty();
    const el = document.createElement("article");
    el.className = "turn";
    el.innerHTML = `<div class="cmd"><span class="cmd-ic">${spoken ? ICON.mic : ICON.type}</span><span class="cmd-text"></span></div><ol class="steps"></ol>`;
    el.querySelector(".cmd-text").textContent = text;
    feed.appendChild(el);
    const data = { text, spoken: !!spoken, at: Date.now(), steps: [], reply: null, error: false };
    convo.turns.push(data);
    currentTurn = { el, steps: new Map(), stepData: new Map(), data, thinkingEl: null, id: `t${++turnCounter}` };
    scrollDown();
    return currentTurn;
  }

  function showThinking(turn, on) {
    if (on && !turn.thinkingEl) {
      turn.thinkingEl = document.createElement("div");
      turn.thinkingEl.className = "thinking";
      turn.thinkingEl.innerHTML = '<span class="dots"><i></i><i></i><i></i></span><span>Thinking</span>';
      turn.el.appendChild(turn.thinkingEl);
      scrollDown();
    } else if (!on && turn.thinkingEl) { turn.thinkingEl.remove(); turn.thinkingEl = null; }
  }

  function addStep(turn, ev) {
    showThinking(turn, false);
    const li = document.createElement("li");
    li.className = "step running";
    li.innerHTML = `<span class="st-ic"><span class="spin"></span></span><div><div class="st-title"></div><div class="st-detail"></div></div><span class="st-act"></span>`;
    li.querySelector(".st-title").textContent = TOOL_TITLES[ev.tool] || ev.tool;
    li.querySelector(".st-detail").textContent = firstArg(ev.args || {});
    turn.el.querySelector(".steps").appendChild(li);
    turn.steps.set(ev.stepId, li);
    const sd = { title: li.querySelector(".st-title").textContent, detail: li.querySelector(".st-detail").textContent, state: "running" };
    turn.data.steps.push(sd); turn.stepData.set(ev.stepId, sd);
    scrollDown();
  }

  function updateStep(turn, ev) {
    const li = turn.steps.get(ev.stepId);
    if (!li) return;
    li.className = `step ${ev.state}`;
    li.querySelector(".st-ic").innerHTML = ev.state === "running" ? '<span class="spin"></span>' : ICON[ev.state] || "";
    if (ev.detail) li.querySelector(".st-detail").textContent = ev.detail;
    const sd = turn.stepData.get(ev.stepId);
    if (sd) { sd.state = ev.state; if (ev.detail) sd.detail = ev.detail; }
    if (ev.state === "waiting") setStatus("waiting", "Needs your OK");
    if (ev.state === "running") setStatus("working", "Working");
    if (ev.state === "done" && ev.undoable) {
      const act = li.querySelector(".st-act");
      act.innerHTML = '<button class="undo-btn" type="button">Undo</button>';
      act.firstChild.addEventListener("click", async (e) => {
        const btn = e.currentTarget; btn.disabled = true; btn.textContent = "Undoing…";
        const r = await window.relay.undo();
        btn.textContent = r.ok ? "Undone" : "Couldn't undo";
        const reply = r.ok && li.closest(".turn").querySelector(".reply");
        if (reply && !reply.classList.contains("undone")) { reply.classList.add("undone"); reply.insertAdjacentHTML("beforeend", '<span class="undone-tag">Undone</span>'); }
        li.querySelector(".st-detail").textContent = r.ok ? r.summary : r.error;
        if (r.ok) { turn.data.undone = true; if (sd) sd.detail = r.summary; persist(); }
      });
    }
    scrollDown();
  }

  function showConfirm(turn, ev) {
    showThinking(turn, false);
    const li = turn.steps.get(ev.stepId);
    const card = document.createElement("div");
    card.className = `confirm${ev.danger ? " danger" : ""}`;
    card.innerHTML = `<h3></h3><ul></ul><div class="actions"><button class="btn${ev.danger ? " danger" : ""}" type="button" data-ok="1">${ev.danger ? "Move to Recycle Bin" : "Do it"}</button><button class="btn ghost" type="button" data-ok="0">Cancel</button><small>Enter to approve · Esc to cancel</small></div>`;
    card.querySelector("h3").textContent = ev.title;
    const ul = card.querySelector("ul");
    for (const line of ev.lines || []) { const l = document.createElement("li"); l.textContent = line; ul.appendChild(l); }
    if (!(ev.lines || []).length) ul.remove();
    (li || turn.el).appendChild(card);
    activeConfirm = { id: ev.id, el: card };
    card.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => answerConfirm(b.dataset.ok === "1")));
    card.querySelector("[data-ok='1']").focus();
    scrollDown();
  }

  function answerConfirm(ok) {
    if (!activeConfirm) return;
    window.relay.confirm(activeConfirm.id, ok);
    const card = activeConfirm.el;
    card.classList.add("resolved");
    setTimeout(() => card.remove(), 250); // the step line already says what happened
    activeConfirm = null;
    input.focus();
  }

  function addReply(turn, text, { error = false, needsKey = false } = {}) {
    showThinking(turn, false);
    if (turn.data) { turn.data.reply = text || ""; turn.data.error = !!error; }
    const div = document.createElement("div");
    div.className = `reply${error ? " error" : ""}`;
    div.innerHTML = markdown(text || "");
    if (needsKey) {
      const b = document.createElement("div");
      b.className = "err-action";
      b.innerHTML = '<button class="btn" type="button">Open Settings</button>';
      b.firstChild.addEventListener("click", openSettings);
      div.appendChild(b);
    }
    turn.el.appendChild(div);
    scrollDown();
  }

  // ---------- Running commands ----------
  async function run(text, spoken) {
    text = text.trim();
    if (!text || busy) return;
    input.value = ""; input.classList.remove("heard");
    pendingSpoken = false;
    resetHint();
    const turn = newTurn(text, spoken);
    setBusy(true);
    setStatus("thinking", "Thinking");
    showThinking(turn, true);
    const res = await window.relay.run(text, turn.id);
    if (currentTurn !== turn) { setBusy(false); return; } // a new conversation was started meanwhile
    if (res.ok) {
      addReply(turn, res.text);
      if (spoken) speak(res.text);
      persist();
    } else {
      addReply(turn, res.error, { error: true, needsKey: res.needsKey });
      persist();
      setBusy(false);
      setStatus("error", "Error");
      setTimeout(() => !busy && setStatus("ready", "Ready"), 4000);
      return;
    }
    setBusy(false);
  }

  window.relay.onEvent((ev) => {
    if (ev.type === "focus-input") { input.focus(); return; }
    if (ev.type === "window-state") { setMaximized(ev.maximized); return; }
    if (ev.type === "start-voice") { if (!listening) toggleMic(); return; }
    if (ev.type === "retry" && transcribing) { setHint(esc(ev.message), true); return; }
    const turn = currentTurn;
    if (!turn || (ev.turnId && ev.turnId !== turn.id)) return;
    if (ev.type === "thinking") { showThinking(turn, true); turn.thinkingEl.lastElementChild.textContent = "Thinking"; setStatus("thinking", "Thinking"); }
    if (ev.type === "retry") { showThinking(turn, true); turn.thinkingEl.lastElementChild.textContent = ev.message; setStatus("thinking", "Retrying"); }
    if (ev.type === "step") { addStep(turn, ev); setStatus("working", "Working"); }
    if (ev.type === "step-update") updateStep(turn, ev);
    if (ev.type === "step-remove") {
      const li = turn.steps.get(ev.stepId); if (li) li.remove(); turn.steps.delete(ev.stepId);
      const sd = turn.stepData.get(ev.stepId); if (sd) turn.data.steps.splice(turn.data.steps.indexOf(sd), 1);
    }
    if (ev.type === "confirm") showConfirm(turn, ev);
  });

  bar.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) { window.relay.stop(); if (activeConfirm) answerConfirm(false); return; }
    run(input.value, pendingSpoken);
  });
  input.addEventListener("input", () => { input.classList.remove("heard"); });
  input.addEventListener("keydown", (e) => {
    // While Relay is working, Enter approves a pending step instead of stopping everything
    if (e.key === "Enter" && busy) { e.preventDefault(); if (activeConfirm) answerConfirm(true); }
  });
  // Suggestion chips (delegated, so it keeps working after a new conversation rebuilds the start screen)
  feed.addEventListener("click", (e) => { const b = e.target.closest("#chips button"); if (b) run(b.textContent, false); });

  // ---------- Voice ----------
  function setHint(html, live) { hint.innerHTML = html; hint.classList.toggle("live", !!live); }
  function resetHint() { setHint(HINT, false); }

  async function toggleMic() {
    if (transcribing || busy) return;
    if (listening) return finishListening();
    try {
      await recorder.start({ onAutoStop: (why) => finishListening(why) });
    } catch (err) {
      setHint("Microphone blocked. Allow it in Windows Settings → Privacy &amp; security → Microphone → Let desktop apps access your microphone.", true);
      return;
    }
    listening = true;
    app.classList.add("listening");
    input.hidden = true; $("#wave").hidden = false;
    setStatus("listening", "Listening");
    setHint("Listening… speak your command, then pause. Press <kbd>Esc</kbd> to cancel.", true);
  }

  function stopListeningUI() {
    listening = false;
    app.classList.remove("listening");
    input.hidden = false; $("#wave").hidden = true;
  }

  async function finishListening(why) {
    if (!listening) return;
    const rec = await recorder.stop();
    stopListeningUI();
    if (!rec || !rec.heardSpeech || why === "no-speech") {
      setStatus("ready", "Ready");
      setHint("Didn't catch anything. Press the mic and try again.", true);
      setTimeout(resetHint, 3500);
      return;
    }
    transcribing = true;
    input.value = ""; input.placeholder = "Transcribing…"; input.disabled = true;
    setStatus("thinking", "Transcribing");
    const res = await window.relay.transcribe(rec.base64);
    transcribing = false;
    input.disabled = false; input.placeholder = "Tell Relay what to do…";
    setStatus("ready", "Ready");
    if (!res.ok) { setHint(esc(res.error), true); if (res.needsKey) openSettings(); return; }
    if (!res.text) { setHint("Couldn't make out the words. Try again, a little closer to the mic.", true); setTimeout(resetHint, 3500); return; }
    if (settings.autoRunVoice) return run(res.text, true);
    input.value = res.text;
    input.classList.add("heard");
    pendingSpoken = true;
    input.focus();
    input.setSelectionRange(res.text.length, res.text.length);
    setHint("Is this right? Press <kbd>Enter</kbd> to run it, or edit it first.", true);
  }

  function cancelListening() {
    recorder.cancel();
    stopListeningUI();
    setStatus("ready", "Ready");
    resetHint();
  }

  $("#micBtn").addEventListener("click", toggleMic);

  // ---------- Speaking replies ----------
  let voice = null;
  function pickVoice() {
    const voices = speechSynthesis.getVoices();
    voice = voices.find((v) => /en-IN/i.test(v.lang) && /natural|online/i.test(v.name))
      || voices.find((v) => /en-IN/i.test(v.lang))
      || voices.find((v) => /^en/i.test(v.lang) && /natural|online/i.test(v.name))
      || voices.find((v) => /^en/i.test(v.lang)) || null;
  }
  speechSynthesis.onvoiceschanged = pickVoice; pickVoice();
  function speak(text) {
    if (!settings.speakReplies || !text) return;
    const t = plain(text).trim();
    if (t.length > 240) return; // long answers stay on screen only
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t);
    if (voice) u.voice = voice;
    u.rate = 1.05;
    speechSynthesis.speak(u);
  }

  // ---------- Settings ----------
  const sheet = $("#sheet"), scrim = $("#scrim");
  function openSettings() { sheet.hidden = false; scrim.hidden = false; refreshSettingsUI(); setTimeout(() => $("#keyInput").focus(), 50); }
  function closeSettings() { sheet.hidden = true; scrim.hidden = true; input.focus(); }
  $("#settingsBtn").addEventListener("click", openSettings);
  $("#sheetClose").addEventListener("click", closeSettings);
  scrim.addEventListener("click", closeSettings);

  function fillModels(list) {
    const sel = $("#modelSelect");
    const all = Array.from(new Set(["gemini-flash-latest", settings.model, ...(list || [])].filter(Boolean)));
    sel.innerHTML = "";
    for (const m of all) { const o = document.createElement("option"); o.value = m; o.textContent = m; sel.appendChild(o); }
    sel.value = settings.model;
  }
  function refreshSettingsUI() {
    $("#keyInput").value = "";
    $("#keyInput").placeholder = settings.hasKey ? `Saved ${settings.keyHint} · paste to replace` : "Paste your key";
    $("#speakToggle").checked = !!settings.speakReplies;
    $("#autoRunToggle").checked = !!settings.autoRunVoice;
    $("#startToggle").checked = !!settings.startWithWindows;
    if (!$("#modelSelect").options.length) fillModels([]);
  }

  async function saveKey(value, helpEl) {
    const key = value.trim();
    if (!key) return;
    settings = await window.relay.settings.set({ apiKey: key });
    helpEl.className = "help"; helpEl.textContent = "Checking the key…";
    const r = await window.relay.settings.models();
    if (r.ok) { helpEl.className = "help ok"; helpEl.textContent = "Key saved and working."; fillModels(r.models); renderEmpty(); }
    else { helpEl.className = "help bad"; helpEl.textContent = r.error; }
    refreshSettingsUI();
  }
  $("#keySave").addEventListener("click", () => saveKey($("#keyInput").value, $("#keyHelp")));
  $("#keyInput").addEventListener("keydown", (e) => { if (e.key === "Enter") saveKey(e.target.value, $("#keyHelp")); });
  $("#modelSelect").addEventListener("change", async (e) => { settings = await window.relay.settings.set({ model: e.target.value }); });
  $("#modelRefresh").addEventListener("click", async () => {
    const help = $("#modelHelp"); help.className = "help"; help.textContent = "Loading models…";
    const r = await window.relay.settings.models();
    if (r.ok) { fillModels(r.models); help.textContent = `${r.models.length} models available to your key.`; }
    else { help.className = "help bad"; help.textContent = r.error; }
  });
  $("#speakToggle").addEventListener("change", async (e) => { settings = await window.relay.settings.set({ speakReplies: e.target.checked }); });
  $("#autoRunToggle").addEventListener("change", async (e) => { settings = await window.relay.settings.set({ autoRunVoice: e.target.checked }); });
  $("#startToggle").addEventListener("change", async (e) => { settings = await window.relay.settings.set({ startWithWindows: e.target.checked }); });
  $("#quitBtn").addEventListener("click", () => window.relay.window.quit());

  // Links anywhere in the window open in the browser
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-link]");
    if (a) { e.preventDefault(); window.relay.openLink(a.dataset.link); }
  });

  // ---------- First run: ask for a key right in the window ----------
  function renderEmpty() {
    const empty = $("#empty");
    if (!empty) return;
    const chips = $("#chips");
    const existing = $("#onboard");
    if (settings.hasKey) { if (existing) existing.remove(); chips.hidden = false; empty.querySelector(".sub").textContent = "Type a command or press the mic and say it."; return; }
    chips.hidden = true;
    empty.querySelector(".sub").textContent = "One quick step before Relay can work.";
    if (existing) return;
    const card = document.createElement("div");
    card.className = "onboard"; card.id = "onboard";
    card.innerHTML = `<h2>Connect Gemini</h2>
      <ol><li>Open <a href="#" data-link="https://aistudio.google.com/apikey">aistudio.google.com/apikey</a> and sign in with Google.</li>
      <li>Click <b>Create API key</b> and copy it.</li><li>Paste it below. It's stored encrypted on this PC.</li></ol>
      <div class="row"><input id="obKey" type="password" placeholder="Paste your Gemini API key" spellcheck="false" /><button class="btn" id="obSave" type="button">Connect</button></div>
      <p class="help" id="obHelp"></p>`;
    empty.appendChild(card);
    $("#obSave").addEventListener("click", () => saveKey($("#obKey").value, $("#obHelp")));
    $("#obKey").addEventListener("keydown", (e) => { if (e.key === "Enter") saveKey(e.target.value, $("#obHelp")); });
  }

  // ---------- Window controls & keys ----------
  $("#minBtn").addEventListener("click", () => window.relay.window.minimize());
  const maxBtn = $("#maxBtn");
  const setMaximized = (m) => { app.classList.toggle("maximized", m); maxBtn.title = m ? "Restore down" : "Maximize"; maxBtn.setAttribute("aria-label", maxBtn.title); };
  maxBtn.addEventListener("click", () => window.relay.window.toggleMaximize());
  if (window.relay.window.isMaximized) window.relay.window.isMaximized().then(setMaximized);
  $("#closeBtn").addEventListener("click", () => window.relay.window.close());
  $("#newBtn").addEventListener("click", newConversation);
  function newConversation() {
    if (listening) cancelListening();
    if (activeConfirm) answerConfirm(false);
    if (busy) window.relay.stop();          // stop the running command; its late events are ignored below
    window.relay.reset();
    speechSynthesis.cancel();
    currentTurn = null;
    convo = { id: null, turns: [] };
    feed.innerHTML = "";
    feed.appendChild(EMPTY_TEMPLATE.cloneNode(true));
    renderEmpty();
    markActive();
    if (isNarrow()) setSidebar(false);
    input.value = ""; input.classList.remove("heard"); pendingSpoken = false;
    resetHint();
    if (!busy) setStatus("ready", "Ready");
    input.focus();
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!sheet.hidden) return closeSettings();
      if (isNarrow() && !app.classList.contains("side-closed")) return setSidebar(false);
      if (activeConfirm) return answerConfirm(false);
      if (listening) return cancelListening();
      if (busy) return window.relay.stop();
      return window.relay.window.hide();
    }
    if (e.key === "Enter" && activeConfirm && document.activeElement !== input) { e.preventDefault(); return answerConfirm(true); }
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "m") { e.preventDefault(); return toggleMic(); }
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); return newConversation(); }
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "b") { e.preventDefault(); return setSidebar(app.classList.contains("side-closed")); }
  });


  // ---------- Past conversations ----------
  const sideList = $("#sideList"), sideSearch = $("#sideSearch"), sideScrim = $("#sideScrim");
  let historyItems = [];
  let saving = Promise.resolve();

  /** Save the conversation on screen (after each finished command). Saves run one at a time, in order. */
  function persist() {
    if (!convo.turns.length || !window.relay.history) return;
    const snapshot = convo, turns = convo.turns.map((t) => ({ ...t, steps: t.steps.map((x) => ({ ...x })) }));
    saving = saving.then(async () => {
      const r = await window.relay.history.save(snapshot.id, turns);
      if (r.ok) { snapshot.id = r.meta.id; await refreshSidebar(); }
    }).catch(() => {});
  }

  const isNarrow = () => window.innerWidth <= 760;
  function setSidebar(open) {
    app.classList.toggle("side-closed", !open);
    $("#sideBtn").setAttribute("aria-expanded", String(open));
    sideScrim.hidden = !(open && isNarrow());
    if (!isNarrow()) { try { localStorage.setItem("relay.sidebar", open ? "1" : "0"); } catch {} }
    if (open && !isNarrow()) return;
    if (!open) input.focus();
  }

  function dayLabel(ts) {
    const d = new Date(ts), today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.floor((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    if (diff <= 0) return "Today";
    if (diff === 1) return "Yesterday";
    if (diff < 7) return "Previous 7 days";
    if (diff < 30) return "Previous 30 days";
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  function timeLabel(ts) {
    const d = new Date(ts), diff = Date.now() - ts;
    if (diff < 60000) return "now";
    if (dayLabel(ts) === "Today") return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (diff < 7 * 86400000) return d.toLocaleDateString(undefined, { weekday: "short" });
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  function renderSidebar() {
    const q = sideSearch.value.trim().toLowerCase();
    const items = q ? historyItems.filter((m) => (m.title || "").toLowerCase().includes(q) || (m.search || "").includes(q)) : historyItems;
    sideList.innerHTML = "";
    if (!items.length) {
      const p = document.createElement("p");
      p.className = "side-empty";
      p.textContent = q ? `No chats match "${sideSearch.value.trim()}".` : "Your conversations will appear here.";
      sideList.appendChild(p);
      return;
    }
    let group = null;
    for (const m of items) {
      const g = dayLabel(m.updatedAt);
      if (g !== group) { group = g; const h = document.createElement("div"); h.className = "side-group"; h.textContent = g; sideList.appendChild(h); }
      const b = document.createElement("button");
      b.type = "button"; b.className = "side-item"; b.dataset.id = m.id; b.title = m.title;
      b.innerHTML = `<span class="si-title"></span><span class="si-time"></span><span class="si-del" role="button" aria-label="Delete chat" title="Delete chat"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 11v6M14 11v6M6.5 7l1 12h9l1-12M9.5 7V4.5h5V7"/></svg></span>`;
      b.querySelector(".si-title").textContent = m.title;
      b.querySelector(".si-time").textContent = timeLabel(m.updatedAt);
      sideList.appendChild(b);
    }
    markActive();
  }

  async function refreshSidebar() {
    const r = await window.relay.history.list();
    historyItems = r.ok ? r.items : [];
    renderSidebar();
  }

  function markActive() {
    sideList.querySelectorAll(".side-item").forEach((el) => el.classList.toggle("active", el.dataset.id === convo.id));
  }

  /** Draw a saved turn (read-only: its steps already happened) */
  function renderSavedTurn(t) {
    const el = document.createElement("article");
    el.className = "turn";
    el.innerHTML = `<div class="cmd"><span class="cmd-ic">${t.spoken ? ICON.mic : ICON.type}</span><span class="cmd-text"></span></div><ol class="steps"></ol>`;
    el.querySelector(".cmd-text").textContent = t.text;
    const ol = el.querySelector(".steps");
    for (const st of t.steps || []) {
      const state = st.state === "running" || st.state === "waiting" ? "cancelled" : st.state; // interrupted steps
      const li = document.createElement("li");
      li.className = `step ${state}`;
      li.innerHTML = `<span class="st-ic">${ICON[state] || ""}</span><div><div class="st-title"></div><div class="st-detail"></div></div><span class="st-act"></span>`;
      li.querySelector(".st-title").textContent = st.title;
      li.querySelector(".st-detail").textContent = st.detail || "";
      ol.appendChild(li);
    }
    if (t.reply != null) {
      const div = document.createElement("div");
      div.className = `reply${t.error ? " error" : ""}${t.undone ? " undone" : ""}`;
      div.innerHTML = markdown(t.reply) + (t.undone ? '<span class="undone-tag">Undone</span>' : "");
      el.appendChild(div);
    }
    feed.appendChild(el);
  }

  async function openConversation(id) {
    if (id === convo.id) { if (isNarrow()) setSidebar(false); return; }
    if (listening) cancelListening();
    if (activeConfirm) answerConfirm(false);
    if (busy) window.relay.stop();
    const r = await window.relay.history.open(id);
    if (!r.ok) { setHint(`Couldn't open that chat: ${esc(r.error)}`, true); await refreshSidebar(); return; }
    speechSynthesis.cancel();
    currentTurn = null;
    convo = { id: r.conversation.id, turns: r.conversation.turns };
    feed.innerHTML = "";
    convo.turns.forEach(renderSavedTurn);
    const note = document.createElement("p");
    note.className = "saved-note";
    note.textContent = "Earlier conversation. Relay remembers it, so you can carry on below.";
    feed.appendChild(note);
    feed.scrollTop = feed.scrollHeight;
    markActive();
    resetHint();
    if (!busy) setStatus("ready", "Ready");
    if (isNarrow()) setSidebar(false);
    input.focus();
  }

  async function deleteConversation(id) {
    await window.relay.history.remove(id);
    if (id === convo.id) newConversation();
    await refreshSidebar();
  }

  function initSidebar() {
    if (!window.relay.history) { app.classList.add("side-closed"); $("#sideBtn").hidden = true; return; }
    let open = true;
    try { open = localStorage.getItem("relay.sidebar") !== "0"; } catch {}
    setSidebar(open && !isNarrow());
    $("#sideBtn").addEventListener("click", () => setSidebar(app.classList.contains("side-closed")));
    $("#sideNew").addEventListener("click", newConversation);
    sideScrim.addEventListener("click", () => setSidebar(false));
    sideSearch.addEventListener("input", renderSidebar);
    sideSearch.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); if (sideSearch.value) { sideSearch.value = ""; renderSidebar(); } else input.focus(); }
      if (e.key === "Enter") { const first = sideList.querySelector(".side-item"); if (first) openConversation(first.dataset.id); }
    });
    sideList.addEventListener("click", (e) => {
      const item = e.target.closest(".side-item");
      if (!item) return;
      const del = e.target.closest(".si-del");
      if (del) {
        e.stopPropagation();
        if (del.classList.contains("armed")) return deleteConversation(item.dataset.id);
        del.classList.add("armed"); del.textContent = "Delete?";         // second click confirms
        setTimeout(() => { if (del.isConnected) renderSidebar(); }, 3000);
        return;
      }
      openConversation(item.dataset.id);
    });
    window.addEventListener("resize", () => { sideScrim.hidden = !(isNarrow() && !app.classList.contains("side-closed")); });

    const clearBtn = $("#clearHistoryBtn");
    let armed = false;
    clearBtn.addEventListener("click", async () => {
      if (!armed) { armed = true; clearBtn.textContent = "Click again to delete every conversation"; clearBtn.classList.add("danger"); setTimeout(() => { armed = false; clearBtn.textContent = "Delete all conversations"; clearBtn.classList.remove("danger"); }, 4000); return; }
      armed = false;
      await window.relay.history.clear();
      clearBtn.textContent = "All conversations deleted"; clearBtn.classList.remove("danger");
      newConversation(); closeSettings();
      await refreshSidebar();
    });
    refreshSidebar();
  }

  // ---------- Start ----------
  window.relay.settings.get().then((s) => {
    settings = s;
    fillModels([]);
    renderEmpty();
    input.focus();
  });
  initSidebar();
})();
