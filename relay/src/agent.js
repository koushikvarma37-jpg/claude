// The agent loop.
// 1. Send the user's command + the list of tools to Gemini.
// 2. Gemini replies with tool calls (e.g. find_files, then move_files).
// 3. Relay runs them (asking the user first for anything that changes files),
//    sends the results back, and repeats until Gemini gives a final answer.
const MAX_STEPS = 10;
const HISTORY_LIMIT = 40; // contents kept for follow-ups like "open it" or "undo that"

function localIso(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function systemPrompt(paths, now, memory = "") {
  const k = paths.known;
  return `You are Relay, an AI agent that controls a Windows laptop for its owner, Teja.
Now: ${now.toDateString()}, ${now.toLocaleTimeString()} (local time ${localIso(now)}).

Known folders on this computer:
- Desktop: ${k.desktop}
- Downloads: ${k.downloads}
- Documents: ${k.documents}
- Pictures: ${k.pictures}
- Music: ${k.music}
- Videos: ${k.videos}
- Home: ${k.home}

How to work:
- Use tools to do things. Never claim you did something unless a tool result says it happened. If a result says sent: false or has an error, say exactly that.
- Paths must start with a known folder (e.g. "Desktop/DSP notes", "Downloads") or be full paths (e.g. "D:\\College").
- If the user names a file or folder without its location ("my resume", "the College folder"), call find_files first. If there are several good matches, ask which one. If there are none, say so; don't guess.
- When the user says "a folder called X" with no location, create it on the Desktop.
- For several steps ("make a folder, move my PDFs into it and open it"), call the tools one after another.
- Moving, organizing, renaming, deleting, sending messages/emails and shutting down ask the user for approval automatically. Don't ask "are you sure?" yourself; just call the tool. If a result says the user declined, stop and say it was cancelled.
- To open an app use open_app. If it isn't installed, say so and suggest the closest match or the web version (e.g. https://web.whatsapp.com for WhatsApp).
- For general questions (definitions, explanations, quick facts), answer directly without tools.

Messages and email:
- "Message/text/WhatsApp Amma that I'll be late" → send_whatsapp with to "Amma" and the message in Teja's voice ("I'll be late"), not "Teja says…". Keep the language they used (Telugu, Hindi or English, or a mix).
- For emails, write a proper subject and a complete, polite body, signed "Teja". Keep it short unless asked for more.
- If a tool says it needs a number or an email address, ask Teja for it. Once Teja gives it, save it with save_contact, then send.
- If the user gives a number or email for someone ("Ravi's number is 98…"), save it with save_contact.

PC, screen, files, memory:
- Volume, music, brightness, Wi-Fi/Bluetooth, lock/sleep/shutdown/restart, battery and screenshots each have a tool.
- "What's on my screen", "explain this error", "read this" → look_at_screen.
- Questions about what's inside a document → find it (find_files or search_in_files), then read_file with the question.
- "Remember…" → remember. "Remind me…" → set_reminder ("in 20 minutes" → in_minutes; "at 5" → the next 5 o'clock that makes sense, as local time YYYY-MM-DDTHH:MM). "What do you remember / what are my reminders" → answer from the lists below.

How to reply:
- After actions: one short sentence saying what happened, e.g. "Done. Moved 12 PDFs to Documents\\College." or "Sent to Amma on WhatsApp."
- For questions: clear and concise; use short paragraphs or bullet points. No long essays.
- Use plain text with simple **bold** or bullet points only. Use friendly folder names like "Desktop\\DSP notes", not full C:\\Users paths.
- If a command is unclear or the transcript looks garbled, ask a short clarifying question instead of guessing.${memory ? `\n\n${memory}` : ""}`;
}

function createAgent({ getClient, getModel, getFallbackModels = async () => [], quick = null, toolkit, paths, onEvent, askConfirm, getMemory = () => "", sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let history = [];
  let stopRequested = false;
  let generation = 0; // bumps on reset(), so a command still running from an old conversation can't leak into the new one
  let preferredFallback = null; // a model that worked when the main one was busy; reused for a while
  let fallbackUntil = 0;

  function trimHistory() {
    if (history.length <= HISTORY_LIMIT) return;
    // cut at a plain user text message so tool calls and their results stay paired
    let cut = history.length - HISTORY_LIMIT;
    while (cut < history.length && !(history[cut].role === "user" && history[cut].parts.some((p) => p.text))) cut++;
    history = history.slice(cut);
  }

  /**
   * Calls Gemini and survives busy servers:
   * retries the same model with a short backoff, then (if allowed) tries other fast models.
   */
  async function callModel(ai, request, { turnId, allowSwitch }) {
    const primary = Date.now() < fallbackUntil && preferredFallback ? preferredFallback : getModel();
    const models = [primary];
    let lastErr;
    for (let m = 0; m < models.length; m++) {
      const model = models[m];
      for (let attempt = 0; attempt < 3; attempt++) {
        if (stopRequested) throw Object.assign(new Error("Stopped."), { code: "STOPPED" });
        try {
          const res = await ai.models.generateContent({ ...request, model });
          if (model !== getModel()) { preferredFallback = model; fallbackUntil = Date.now() + 10 * 60 * 1000; }
          else { preferredFallback = null; fallbackUntil = 0; }
          return { res, model };
        } catch (err) {
          lastErr = err;
          const kind = errorKind(err);
          if (kind === "missing") break;            // model not available to this key: try the next one
          if (kind === "quota") {                   // this model's free limit is used up; other models have their own
            if (allowSwitch) onEvent({ type: "retry", turnId, message: "Free limit reached for this model, switching to a backup…" });
            break;
          }
          if (kind !== "busy") throw err;           // key/network problems: retrying won't help
          if (attempt < 2) {
            onEvent({ type: "retry", turnId, message: "Gemini is busy, retrying…" });
            await sleep(attempt === 0 ? 800 : 2000);
          }
        }
      }
      if (allowSwitch && m === models.length - 1 && models.length === 1) {
        const extra = (await getFallbackModels().catch(() => [])).filter((x) => !models.includes(x));
        models.push(...extra.slice(0, 3));
      }
      if (allowSwitch && models[m + 1]) onEvent({ type: "retry", turnId, message: "Gemini is busy, switching to a backup model…" });
      if (!allowSwitch) break;
    }
    throw lastErr;
  }

  async function execute(call, turnId, stepId) {
    const tool = toolkit.tools[call.name];
    if (!tool) return { error: `Unknown tool ${call.name}` };
    const args = call.args || {};
    if (typeof tool.confirm === "function" ? tool.confirm(args) : tool.confirm) {
      const plan = await tool.plan(args);
      if (plan.empty) return { summary: plan.title, nothing_to_do: true };
      onEvent({ type: "step-update", turnId, stepId, state: "waiting", detail: "Waiting for your approval" });
      const ok = await askConfirm({ turnId, stepId, ...plan });
      if (!ok) return { summary: "Cancelled by the user", declined: true };
      onEvent({ type: "step-update", turnId, stepId, state: "running", detail: "Working…" });
    }
    return tool.run(args);
  }

  /** Runs a simple command directly (see quick.js). Returns null if it should go to Gemini after all. */
  async function runQuick(q, text, turnId) {
    const stepId = `${turnId}-q`;
    onEvent({ type: "step", turnId, stepId, tool: q.tool, args: q.args, state: "running" });
    let result;
    try { result = await execute({ name: q.tool, args: q.args }, turnId, stepId); } // execute() shows the approval card when needed
    catch (err) { onEvent({ type: "step-update", turnId, stepId, state: "failed", detail: err.message }); return { text: err.message, failed: true }; }
    if (result.error === "not_installed") { onEvent({ type: "step-remove", turnId, stepId }); return null; }
    onEvent({ type: "step-update", turnId, stepId, state: result.declined ? "cancelled" : result.error ? "failed" : "done", detail: result.summary, undoable: !!result.undoable });
    if (result.declined) { trimHistory(); history.push({ role: "user", parts: [{ text }] }, { role: "model", parts: [{ text: "Cancelled." }] }); return { text: "Cancelled. Nothing was changed.", quick: true }; }
    const reply = /[.!?]$/.test(result.summary) ? result.summary : result.summary + ".";
    trimHistory();
    history.push({ role: "user", parts: [{ text }] }, { role: "model", parts: [{ text: reply }] }); // so "close it" / "undo that" have context
    return { text: reply, quick: true };
  }

  async function run(text, opts) {
    const gen = generation;
    const out = await runInner(text, opts);
    if (gen !== generation) { history = []; return { text: "Stopped.", abandoned: true }; }
    return out;
  }

  async function runInner(text, { turnId }) {
    stopRequested = false;
    if (quick) {
      const q = await quick.match(text).catch(() => null);
      if (q) { const out = await runQuick(q, text, turnId); if (out) return out; }
    }
    const ai = getClient();
    trimHistory();
    const startLen = history.length;
    history.push({ role: "user", parts: [{ text }] });
    const done = []; // summaries of steps that really happened in this turn
    try {
      return await loop(ai, turnId, done);
    } catch (err) {
      if (done.length) {
        // The actions already happened; only Gemini's closing sentence failed.
        // Report what was done instead of an error, and close the turn cleanly.
        const summary = done.join(". ") + ".";
        history.push({ role: "model", parts: [{ text: summary }] });
        return { text: err.code === "STOPPED" ? `Stopped. ${summary}` : summary, partial: true };
      }
      history = history.slice(0, startLen); // nothing happened: drop the turn so the next command starts clean
      if (err.code === "STOPPED") return { text: "Stopped." };
      throw err;
    }
  }

  async function loop(ai, turnId, done) {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (stopRequested) throw Object.assign(new Error("Stopped."), { code: "STOPPED" });
      onEvent({ type: "thinking", turnId });
      const { res } = await callModel(ai, {
        contents: history,
        config: {
          systemInstruction: systemPrompt(paths, new Date(), getMemory()),
          tools: [{ functionDeclarations: toolkit.declarations }],
          temperature: 0.2,
        },
      }, { turnId, allowSwitch: step === 0 }); // switching models mid-task would break Gemini's step signatures
      const content = res.candidates && res.candidates[0] && res.candidates[0].content;
      if (!content || !content.parts) {
        const reason = res.candidates?.[0]?.finishReason || res.promptFeedback?.blockReason;
        throw new Error(reason ? `Gemini stopped (${reason}). Try rephrasing.` : "Gemini returned an empty reply. Try again.");
      }
      history.push(content); // keep the model's turn as-is (includes thought signatures)

      const calls = res.functionCalls || [];
      if (!calls.length) return { text: (res.text || "").trim() || (done.length ? done.join(". ") + "." : "Done.") };

      const responses = [];
      for (const call of calls) {
        const stepId = `${turnId}-${step}-${responses.length}`;
        onEvent({ type: "step", turnId, stepId, tool: call.name, args: call.args || {}, state: "running" });
        let result;
        try {
          result = await execute(call, turnId, stepId);
          const state = result.declined ? "cancelled" : result.error ? "failed" : "done";
          if (state === "done" && result.summary && !/^(Found|Nothing found|No documents|Read |Looked at|Checked|Battery|.*: \d+ folders)/.test(result.summary)) done.push(result.summary);
          onEvent({ type: "step-update", turnId, stepId, state, detail: result.summary || result.error, undoable: !!result.undoable });
        } catch (err) {
          result = { error: err.message };
          onEvent({ type: "step-update", turnId, stepId, state: "failed", detail: err.message });
        }
        responses.push({ functionResponse: { id: call.id, name: call.name, response: result } });
      }
      history.push({ role: "user", parts: responses });
    }
    return { text: "That took too many steps, so I stopped. Try breaking it into smaller commands." };
  }

  async function transcribe(base64Wav) {
    stopRequested = false;
    const ai = getClient();
    const { res } = await callModel(ai, {
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: "audio/wav", data: base64Wav } },
          { text: "Transcribe this voice command for a Windows desktop assistant exactly as spoken, in English. " +
                  "The speaker has an Indian English accent and may mention app names (WhatsApp, VS Code, Chrome), " +
                  "folder names (Desktop, Downloads, Documents) and file types (PDF, PPT). " +
                  "Output only the transcript, with no quotes or commentary. If there is no clear speech, output exactly: [no speech]" },
        ],
      }],
      config: { temperature: 0 },
    }, { turnId: null, allowSwitch: true });
    const t = (res.text || "").trim().replace(/^["']|["']$/g, "");
    return t === "[no speech]" ? "" : t;
  }

  /** A one-off question to Gemini about an image, screenshot or file (used by look_at_screen, read_file and WhatsApp checks). */
  async function ask(parts, { json = false } = {}) {
    const { res } = await callModel(getClient(), {
      contents: [{ role: "user", parts }],
      config: { temperature: 0.2, ...(json ? { responseMimeType: "application/json" } : {}) },
    }, { turnId: null, allowSwitch: true });
    const text = (res.text || "").trim();
    if (!text) throw new Error("Gemini didn't answer. Try again.");
    return text;
  }

  return {
    run,
    transcribe,
    ask,
    stop: () => { stopRequested = true; },
    reset: () => { history = []; generation++; stopRequested = true; },
    /** Gemini's memory of this conversation, saved with the chat so it can be continued later */
    getHistory: () => history.slice(),
    /** Continue an old conversation: restore its memory */
    load: (contents) => { generation++; stopRequested = true; history = Array.isArray(contents) ? contents.slice() : []; },
  };
}

/** busy = worth retrying; missing = model not available to this key; other = stop */
function errorKind(err) {
  const msg = String((err && err.message) || err);
  const status = err && (err.status || err.code);
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) return "quota";
  if (status === 503 || status === 500 || status === 504 || /UNAVAILABLE|overloaded|INTERNAL|DEADLINE_EXCEEDED|try again later/i.test(msg)) return "busy";
  if (status === 404 || /is not found|NOT_FOUND|not supported for generateContent/i.test(msg)) return "missing";
  return "other";
}

/** Turn API errors into messages a person can act on. */
function friendlyError(err) {
  const msg = String((err && err.message) || err);
  const status = err && (err.status || err.code);
  if (status === 429 || /RESOURCE_EXHAUSTED|429|quota/i.test(msg)) {
    if (/PerDay/i.test(msg)) return "Today's free Gemini limit is used up on every model your key can use. It resets in about a day; until then, simple commands like \"open WhatsApp\" or \"sort my downloads\" still work.";
    const wait = msg.match(/retry in ([\d.]+)\s*s|"retryDelay":\s*"(\d+)s"/i);
    const secs = wait ? Math.ceil(parseFloat(wait[1] || wait[2])) : null;
    return `Gemini's free per-minute limit was reached. Try again in ${secs ? secs + " seconds" : "a minute"}.`;
  }
  if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(msg)) return "Your Gemini API key was rejected. Check it in Settings.";
  if (status === 404 || /not found for API version|is not found|NOT_FOUND/i.test(msg)) return "That Gemini model isn't available to your key. Pick another model in Settings.";
  if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|network/i.test(msg)) return "Can't reach Gemini. Check your internet connection.";
  if (status === 503 || /UNAVAILABLE|overloaded/i.test(msg)) return "Gemini is busy right now. Try again in a few seconds.";
  return msg;
}

module.exports = { createAgent, friendlyError, systemPrompt, errorKind };
