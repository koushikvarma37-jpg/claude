// The agent loop.
// 1. Send the user's command + the list of tools to Gemini.
// 2. Gemini replies with tool calls (e.g. find_files, then move_files).
// 3. Relay runs them (asking the user first for anything that changes files),
//    sends the results back, and repeats until Gemini gives a final answer.
const MAX_STEPS = 10;
const HISTORY_LIMIT = 40; // contents kept for follow-ups like "open it" or "undo that"

function systemPrompt(paths, now) {
  const k = paths.known;
  return `You are Relay, an AI agent that controls a Windows laptop for its owner, Teja.
Today is ${now.toDateString()}, ${now.toLocaleTimeString()}.

Known folders on this computer:
- Desktop: ${k.desktop}
- Downloads: ${k.downloads}
- Documents: ${k.documents}
- Pictures: ${k.pictures}
- Music: ${k.music}
- Videos: ${k.videos}
- Home: ${k.home}

How to work:
- Use tools to do things. Never claim you did something unless a tool result says it happened.
- Paths must start with a known folder (e.g. "Desktop/DSP notes", "Downloads") or be full paths (e.g. "D:\\College").
- If the user names a file or folder without its location ("my resume", "the College folder"), call find_files first. If there are several good matches, ask which one. If there are none, say so; don't guess.
- When the user says "a folder called X" with no location, create it on the Desktop.
- For several steps ("make a folder, move my PDFs into it and open it"), call the tools one after another.
- Moving, organizing, renaming and deleting ask the user for approval automatically. Don't ask "are you sure?" yourself; just call the tool. If a result says the user declined, stop and say it was cancelled.
- To open an app use open_app. If it isn't installed, say so and suggest the closest match or the web version (e.g. https://web.whatsapp.com for WhatsApp).
- For general questions (definitions, explanations, quick facts), answer directly without tools.

How to reply:
- After actions: one short sentence saying what happened, e.g. "Done. Moved 12 PDFs to Documents\\College."
- For questions: clear and concise; use short paragraphs or bullet points. No long essays.
- Use plain text with simple **bold** or bullet points only. Use friendly folder names like "Desktop\\DSP notes", not full C:\\Users paths.
- If a command is unclear or the transcript looks garbled, ask a short clarifying question instead of guessing.`;
}

function createAgent({ getClient, getModel, toolkit, paths, onEvent, askConfirm }) {
  let history = [];
  let stopRequested = false;

  function trimHistory() {
    if (history.length <= HISTORY_LIMIT) return;
    // cut at a plain user text message so tool calls and their results stay paired
    let cut = history.length - HISTORY_LIMIT;
    while (cut < history.length && !(history[cut].role === "user" && history[cut].parts.some((p) => p.text))) cut++;
    history = history.slice(cut);
  }

  async function execute(call, turnId, stepId) {
    const tool = toolkit.tools[call.name];
    if (!tool) return { error: `Unknown tool ${call.name}` };
    const args = call.args || {};
    if (tool.confirm) {
      const plan = await tool.plan(args);
      if (plan.empty) return { summary: plan.title, nothing_to_do: true };
      onEvent({ type: "step-update", turnId, stepId, state: "waiting", detail: "Waiting for your approval" });
      const ok = await askConfirm({ turnId, stepId, ...plan });
      if (!ok) return { summary: "Cancelled by the user", declined: true };
      onEvent({ type: "step-update", turnId, stepId, state: "running", detail: "Working…" });
    }
    return tool.run(args);
  }

  async function run(text, { turnId }) {
    stopRequested = false;
    const ai = getClient();
    const model = getModel();
    trimHistory();
    const startLen = history.length;
    history.push({ role: "user", parts: [{ text }] });
    try {
      return await loop(ai, model, turnId);
    } catch (err) {
      history = history.slice(0, startLen); // drop the half-finished turn so the next command starts clean
      throw err;
    }
  }

  async function loop(ai, model, turnId) {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (stopRequested) return { text: "Stopped." };
      onEvent({ type: "thinking", turnId });
      const res = await ai.models.generateContent({
        model,
        contents: history,
        config: {
          systemInstruction: systemPrompt(paths, new Date()),
          tools: [{ functionDeclarations: toolkit.declarations }],
          temperature: 0.2,
        },
      });
      const content = res.candidates && res.candidates[0] && res.candidates[0].content;
      if (!content || !content.parts) {
        const reason = res.candidates?.[0]?.finishReason || res.promptFeedback?.blockReason;
        throw new Error(reason ? `Gemini stopped (${reason}). Try rephrasing.` : "Gemini returned an empty reply. Try again.");
      }
      history.push(content); // keep the model's turn as-is (includes thought signatures)

      const calls = res.functionCalls || [];
      if (!calls.length) return { text: (res.text || "").trim() || "Done." };

      const responses = [];
      for (const call of calls) {
        const stepId = `${turnId}-${step}-${responses.length}`;
        onEvent({ type: "step", turnId, stepId, tool: call.name, args: call.args || {}, state: "running" });
        let result;
        try {
          result = await execute(call, turnId, stepId);
          onEvent({ type: "step-update", turnId, stepId, state: result.declined ? "cancelled" : result.error ? "failed" : "done", detail: result.summary || result.error, undoable: !!result.undoable });
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
    const ai = getClient();
    const res = await ai.models.generateContent({
      model: getModel(),
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
    });
    const t = (res.text || "").trim().replace(/^["']|["']$/g, "");
    return t === "[no speech]" ? "" : t;
  }

  return {
    run,
    transcribe,
    stop: () => { stopRequested = true; },
    reset: () => { history = []; },
  };
}

/** Turn API errors into messages a person can act on. */
function friendlyError(err) {
  const msg = String((err && err.message) || err);
  const status = err && (err.status || err.code);
  if (status === 429 || /RESOURCE_EXHAUSTED|429|quota/i.test(msg)) return "Gemini's free-tier limit was reached. Wait a minute and try again.";
  if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(msg)) return "Your Gemini API key was rejected. Check it in Settings.";
  if (status === 404 || /not found for API version|is not found|NOT_FOUND/i.test(msg)) return "That Gemini model isn't available to your key. Pick another model in Settings.";
  if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|network/i.test(msg)) return "Can't reach Gemini. Check your internet connection.";
  if (status === 503 || /UNAVAILABLE|overloaded/i.test(msg)) return "Gemini is busy right now. Try again in a few seconds.";
  return msg;
}

module.exports = { createAgent, friendlyError, systemPrompt };
