// Sending WhatsApp messages and emails for the user.
//
// WhatsApp (Desktop app):
//   • If Relay knows the person's number, it opens the chat with the message already typed
//     (whatsapp://send?phone=…&text=…), checks the screen, and presses Enter.
//   • If it only knows a name, it finds WhatsApp's search box on screen, clicks it, searches for the name,
//     opens the chat and pastes the message.
//   Before pressing Enter, Relay takes a screenshot and asks Gemini which chat is open and what's in the message box.
//   It only sends if both are right. It never types into a window that isn't WhatsApp.
//
// Email:
//   • With a Gmail address + app password saved in Settings, Relay sends the email itself (SMTP).
//   • Otherwise it opens the email, fully written, in Gmail in the browser; the user presses Send.
const { NATIVE } = require("./winps");
const { normalizePhone, isEmail } = require("./memory");
const { ACTIVE_WINDOW_PS } = require("./system");

// One script, several small actions (RELAY_ACTION). Each action first finds WhatsApp's window and brings it to
// the front, and refuses to press any key unless WhatsApp really is the window in front.
const WA_PS = NATIVE + String.raw`
[RelayWin]::SetProcessDPIAware() | Out-Null   # real pixels, so clicks land where the screenshot shows things
Add-Type -AssemblyName System.Windows.Forms
function Find-WA { Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like '*WhatsApp*' -or $_.MainWindowTitle -like '*WhatsApp*') } | Select-Object -First 1 }
function Reply($o) { $o | ConvertTo-Json -Compress; exit }
$action = $env:RELAY_ACTION
if ($action -eq 'open_uri') {
  Start-Process $env:RELAY_URI
  $deadline = (Get-Date).AddSeconds(15); $p = $null
  while ((Get-Date) -lt $deadline) { $p = Find-WA; if ($p) { break }; Start-Sleep -Milliseconds 400 }
  if (-not $p) { Reply @{ status = 'not_running' } }
  Start-Sleep -Milliseconds ([int]$env:RELAY_WAIT)
}
$p = Find-WA
if (-not $p) { Reply @{ status = 'not_running' } }
$h = $p.MainWindowHandle
if (-not [RelayWin]::Focus($h)) { Start-Sleep -Milliseconds 300; if (-not [RelayWin]::Focus($h)) { Reply @{ status = 'not_focused' } } }
function Front { if ([RelayWin]::GetForegroundWindow() -ne $h) { Reply @{ status = 'not_focused' } } }
function Keys($k) { Front; [System.Windows.Forms.SendKeys]::SendWait($k) }
switch ($action) {
  'escape' { Keys '{ESC}'; Start-Sleep -Milliseconds 300; Keys '{ESC}'; Start-Sleep -Milliseconds 300 }
  'click' {
    # X, Y: 0-1000 across the main screen (as Gemini reads the screenshot). Only clicks inside WhatsApp's window.
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $x = $b.X + [int]($b.Width * [double]$env:RELAY_X / 1000); $y = $b.Y + [int]($b.Height * [double]$env:RELAY_Y / 1000)
    $r = New-Object RelayWin+RECT; [RelayWin]::GetWindowRect($h, [ref]$r) | Out-Null
    if ($x -lt $r.Left -or $x -gt $r.Right -or $y -lt $r.Top -or $y -gt $r.Bottom) { Reply @{ status = 'outside' } }
    Front; [RelayWin]::Click($x, $y); Start-Sleep -Milliseconds 400
  }
  'type' { Set-Clipboard -Value $env:RELAY_TEXT; Keys '^a'; Keys '^v'; Start-Sleep -Milliseconds 1500 }
  'open' { if ($env:RELAY_MODE -eq 'down') { Keys '{DOWN}'; Start-Sleep -Milliseconds 300 }; Keys '{ENTER}'; Start-Sleep -Milliseconds 1500 }
  'paste' { Set-Clipboard -Value $env:RELAY_TEXT; Keys '^v'; Start-Sleep -Milliseconds 500 }
  'clear' { Keys '^a'; Keys '{DELETE}'; Start-Sleep -Milliseconds 200 }
  'send' { Keys '{ENTER}'; Start-Sleep -Milliseconds 700 }
}
Reply @{ status = 'ok'; title = $p.MainWindowTitle }
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Does the chat name WhatsApp shows match who the user meant? Contact names in WhatsApp can be longer ("Ravi Kumar CSE"). */
function nameMatches(wanted, shown) {
  const w = norm(wanted), s = norm(shown);
  if (!w || !s) return false;
  if (w === s) return true;
  const ww = w.split(" "), sw = s.split(" ");
  return ww.every((x) => sw.includes(x)) || sw.every((x) => ww.includes(x));
}

/** Is (the start of) the message in the message box? Gemini's reading of the screen may differ slightly. */
function textMatches(wanted, shown) {
  const w = norm(wanted), s = norm(shown);
  if (!w || !s) return false;
  const head = w.slice(0, 40);
  return s.includes(head) || w.includes(s.slice(0, 40)) || (s.length > 20 && head.includes(s.slice(0, 20)));
}

function createMessaging(ctx) {
  // ctx: { ps, apps, openExternal, captureScreen, ask, clipboard, memory, settings, sendMail, sleep }
  const wait = ctx.sleep || sleep;

  async function wa(action, env = {}) {
    const r = await ctx.ps.run(WA_PS, { ACTION: action, ...env }, { timeout: 40000 });
    if (r.status === "not_running") throw new Error("WhatsApp didn't open. Open it once and make sure you're logged in, then ask again.");
    if (r.status === "not_focused") throw new Error("Windows didn't let Relay bring WhatsApp to the front, so nothing was sent. Click on WhatsApp once and try again.");
    if (r.status !== "ok" && r.status !== "outside") throw new Error(`WhatsApp automation failed: ${r.error || r.status}`);
    return r;
  }

  /** Ask Gemini what WhatsApp is showing right now (on the main screen, so click positions line up). */
  async function readWhatsApp() {
    const shots = await ctx.captureScreen({ hideRelay: false, primary: true, maxWidth: 1920 });
    if (!shots.length) throw new Error("Couldn't capture the screen to check WhatsApp.");
    const parts = [{ inlineData: { mimeType: "image/png", data: shots[0].png.toString("base64") } }];
    parts.push({ text: 'Look at the WhatsApp window in this screenshot. Reply with JSON only:\n' +
      '{"whatsapp_visible": boolean,\n' +
      ' "search_box": {"x": number, "y": number} or null  (centre of the chat-list search field, e.g. "Search or start a new chat", as 0-1000 fractions of the screenshot width and height),\n' +
      ' "search_text": string or null  (text typed in that search field),\n' +
      ' "open_chat_name": string or null  (name or number in the header of the chat that is open on the right; null if no chat is open),\n' +
      ' "message_box_text": string or null  (text typed in the message box at the bottom of the open chat, not yet sent),\n' +
      ' "popup": string or null  (any dialog or error shown)}' });
    const raw = await ctx.ask(parts, { json: true });
    try { return JSON.parse(String(raw).replace(/^```(?:json)?|```$/g, "").trim()); } catch { return { whatsapp_visible: false }; }
  }

  /** Works out who to message: a number, or a saved contact, or (if WhatsApp is installed) a name to search for. */
  function resolveRecipient(to) {
    const raw = String(to || "").trim();
    if (!raw) throw new Error("Who should I send it to?");
    const digits = raw.replace(/[\s\-()]/g, "");
    if (/^\+?\d{8,15}$/.test(digits)) return { label: raw, phone: normalizePhone(raw) };
    const found = ctx.memory.findContacts(raw);
    if (found.length > 1) return { ambiguous: found.slice(0, 5).map((c) => c.name) };
    if (found.length === 1) return { label: found[0].name, phone: found[0].phone || null, searchName: found[0].name };
    return { label: raw, phone: null, searchName: raw };
  }

  async function sendWhatsApp({ to, message }) {
    const text = String(message || "").trim();
    if (!text) throw new Error("What should the message say?");
    const who = resolveRecipient(to);
    if (who.ambiguous) return { summary: `More than one contact matches "${to}"`, error: "ambiguous", matches: who.ambiguous };
    const installed = ctx.platform === "win32" ? (await ctx.apps.find("WhatsApp"))[0]?.s >= 85 : false;

    if (!installed) {
      if (!who.phone) return { summary: `WhatsApp Desktop isn't installed and I don't have ${who.label}'s number`, error: "need_number", tip: "Install WhatsApp from the Microsoft Store, or tell me their number." };
      await ctx.openExternal(`https://web.whatsapp.com/send?phone=${who.phone}&text=${encodeURIComponent(text)}`);
      return { summary: `Opened the message to ${who.label} in WhatsApp Web. Press Enter there to send it`, sent: false };
    }

    let saved = null; // the message goes through the clipboard; put the user's back afterwards
    try { saved = ctx.clipboard ? ctx.clipboard.read() : null; } catch {}
    try {
      if (who.phone) {
        await wa("open_uri", { URI: `whatsapp://send?phone=${who.phone}&text=${encodeURIComponent(text)}`, WAIT: 2500 });
        let seen = null;
        for (let attempt = 0; attempt < 3; attempt++) {           // the chat can take a moment to load
          try { seen = await readWhatsApp(); } catch (e) { seen = { error: e.message }; break; }
          if (seen.popup && /invalid|not on whatsapp/i.test(seen.popup)) return { summary: `+${who.phone} isn't on WhatsApp`, error: "not_on_whatsapp" };
          if (seen.message_box_text && textMatches(text, seen.message_box_text)) break;
          await wait(1500);
        }
        if (seen && seen.error) {
          // Couldn't check the screen (e.g. Gemini's limit). The link itself opened the right number, so send.
          await wa("send");
          return { summary: `Sent to ${who.label} on WhatsApp`, sent: true, note: "Couldn't double-check the screen, so have a quick look in WhatsApp." };
        }
        if (!seen || !textMatches(text, seen.message_box_text)) return { summary: "WhatsApp opened the chat, but the message didn't appear in the box, so I didn't send anything", error: "not_verified", sent: false };
        await wa("send");
        return { summary: `Sent to ${who.label} on WhatsApp`, sent: true };
      }

      // Only a name: find WhatsApp's search box on screen, click it, type the name and check it's really there,
      // open the chat ("Enter" opens the top result in most versions; others need "Down" first), paste the message,
      // and send only if the right chat is open with the right text. Keyboard shortcuts differ between WhatsApp
      // versions, so Relay doesn't rely on them.
      const opened = await ctx.apps.launch("WhatsApp");
      if (!opened.ok || opened.warning) throw new Error("WhatsApp didn't open. Open it once and make sure you're logged in, then ask again.");
      await wait(1200);
      for (const mode of ["enter", "down"]) {
        await wa("escape");                                      // close any open chat so nothing gets typed into it
        let seen = await readWhatsApp();
        if (!seen.whatsapp_visible) return { summary: "I couldn't see WhatsApp on the main screen, so nothing was sent", error: "not_visible", tip: "Keep WhatsApp on your main screen and make sure it's logged in." };
        const box = seen.search_box;
        if (!box || !Number.isFinite(+box.x) || !Number.isFinite(+box.y)) return { summary: "I couldn't find WhatsApp's search box, so nothing was sent", error: "no_search_box", tip: "Tell me their number and I'll save it; sending by number is more reliable." };
        const clicked = await wa("click", { X: Math.round(+box.x), Y: Math.round(+box.y) });
        if (clicked.status === "outside") return { summary: "WhatsApp's search box wasn't where I expected, so nothing was sent", error: "no_search_box" };
        await wa("type", { TEXT: who.searchName });
        seen = await readWhatsApp();
        if (!nameMatches(who.searchName, seen.search_text) && !norm(seen.search_text).includes(norm(who.searchName))) {
          if (seen.open_chat_name && seen.message_box_text) await wa("clear");   // the name landed in a message box: remove it
          return { summary: "I couldn't type into WhatsApp's search box, so nothing was sent", error: "search_failed", tip: "Tell me their number and I'll save it; sending by number is more reliable." };
        }
        await wa("open", { MODE: mode });
        await wa("paste", { TEXT: text });
        seen = await readWhatsApp();
        const rightChat = nameMatches(who.searchName, seen.open_chat_name), rightText = textMatches(text, seen.message_box_text);
        if (rightChat && rightText) {
          await wa("send");
          return { summary: `Sent to ${seen.open_chat_name} on WhatsApp`, sent: true };
        }
        await wa("clear");                                       // remove what we pasted, wherever it went
        if (rightChat) return { summary: "Something didn't look right in WhatsApp, so I didn't send the message", error: "not_verified", sent: false };
        if (mode === "down") return { summary: `Couldn't find a chat called "${who.searchName}" in WhatsApp, so nothing was sent`, error: "chat_not_found", opened_chat: seen.open_chat_name || null, tip: "Tell me their number and I'll save it for next time." };
      }
      return { summary: "Couldn't open the chat, so nothing was sent", error: "chat_not_found" };
    } finally {
      if (ctx.clipboard && typeof saved === "string") setTimeout(() => { try { ctx.clipboard.write(saved); } catch {} }, 300);
    }
  }

  function resolveEmail(to) {
    const raw = String(to || "").trim();
    if (isEmail(raw)) return { label: raw, email: raw };
    const found = ctx.memory.findContacts(raw);
    if (found.length > 1) return { ambiguous: found.slice(0, 5).map((c) => c.name) };
    if (found.length === 1 && found[0].email) return { label: found[0].name, email: found[0].email };
    return { missing: true, label: raw };
  }

  /**
   * Which of the user's own addresses the email goes from, and how:
   *   direct – Relay sends it itself (an app password is saved for that address)
   *   gmail  – Relay opens it in Gmail, signed in as that address when one is named
   */
  function emailRoute(from) {
    const account = ctx.settings.emailAccount();
    const wanted = isEmail(from) ? String(from).trim() : "";
    if (account && (!wanted || wanted.toLowerCase() === account.user.toLowerCase())) return { mode: "direct", from: account.user, account };
    return { mode: "gmail", from: wanted || (ctx.settings.get && ctx.settings.get("emailAddress")) || "" };
  }

  /** The account in the Gmail window that just opened, read from its title; null if it can't be seen. */
  async function gmailAccountShown() {
    for (let i = 0; i < 8; i++) {
      await wait(1000);
      const r = await ctx.ps.run(ACTIVE_WINDOW_PS, {}, { timeout: 8000 }).catch(() => null);
      const title = (r && r.title) || "";
      const m = /gmail/i.test(title) && title.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
      if (m) return m[0];
    }
    return null;
  }

  async function sendEmail({ to, subject, body, cc, from }) {
    const who = resolveEmail(to);
    if (who.ambiguous) return { summary: `More than one contact matches "${to}"`, error: "ambiguous", matches: who.ambiguous };
    if (who.missing) return { summary: `I don't have an email address for ${who.label}`, error: "need_email", tip: "Ask the user for it, then call save_contact and try again." };
    const ccList = (Array.isArray(cc) ? cc : cc ? [cc] : []).map(String).filter(isEmail);
    const route = emailRoute(from);
    const account = route.mode === "direct" ? route.account : null;
    if (account) {
      try {
        await ctx.sendMail({ from: account, to: who.email, cc: ccList, subject: String(subject || ""), text: String(body || "") });
      } catch (err) {
        const msg = String(err && err.message || err);
        if (/535|Username and Password not accepted|Invalid login|EAUTH/i.test(msg)) throw new Error("Gmail rejected the app password. Check the email settings in Relay's Settings.");
        if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNECTION/i.test(msg)) throw new Error("Couldn't reach Gmail. Check your internet connection.");
        throw new Error(`The email wasn't sent: ${msg}`);
      }
      return { summary: `Emailed ${who.label}`, sent: true, subject };
    }
    // authuser opens Gmail as that account (when it's signed in to this browser), so it goes from the right address
    const params = new URLSearchParams({ ...(route.from ? { authuser: route.from } : {}), view: "cm", fs: "1", to: who.email, su: String(subject || ""), body: String(body || "") });
    if (ccList.length) params.set("cc", ccList.join(","));
    await ctx.openExternal(`https://mail.google.com/mail/?${params.toString()}`);
    // Gmail quietly falls back to another account when the one asked for isn't signed in to this browser.
    // Its tab title shows the account ("Compose Mail - x@gmail.com - Gmail"), so check it before the user presses Send.
    if (route.from && ctx.ps) {
      const shown = await gmailAccountShown();
      if (shown && shown.toLowerCase() !== route.from.toLowerCase()) {
        return {
          summary: `Gmail opened as ${shown}, not ${route.from}. Don't press Send there`,
          error: "wrong_account", sent: false, opened_as: shown,
          tip: `In Gmail, click the profile picture (top right) → Add another account, and sign in with ${route.from} in this same Chrome window. Then ask again.`,
        };
      }
    }
    return {
      summary: `Opened the email to ${who.label} in Gmail${route.from ? ` as ${route.from}` : ""}. Press Send there; Gmail shows "Message sent" when it's gone`,
      sent: false, from: route.from || "the Google account open in your browser",
      tip: route.from ? `If Gmail opens a different account, sign in to ${route.from} in your browser first.` : "To let Relay send emails by itself, add a Gmail app password in Settings.",
    };
  }

  return { sendWhatsApp, sendEmail, resolveRecipient, resolveEmail, emailRoute };
}

function createMessagingTools(ctx) {
  const m = createMessaging(ctx);
  const preview = (s) => String(s || "").trim();
  return {
    send_whatsapp: {
      confirm: true,
      decl: {
        name: "send_whatsapp",
        description: "Send a WhatsApp message. `to` is a saved contact's name, a name as it appears in WhatsApp, or a phone number. Write the message as the user wants it sent (fix obvious speech-to-text mistakes, keep their language and tone, no extra greetings or sign-off unless asked). The user sees and approves it first automatically.",
        parameters: { type: "OBJECT", properties: {
          to: { type: "STRING", description: "Contact name or phone number." },
          message: { type: "STRING", description: "The exact message to send." },
        }, required: ["to", "message"] },
      },
      async plan({ to, message }) {
        const who = m.resolveRecipient(to);
        if (who.ambiguous) throw new Error(`More than one contact matches "${to}": ${who.ambiguous.join(", ")}. Say which one.`);
        return { title: `Send on WhatsApp to ${who.label}${who.phone ? ` (+${who.phone})` : ""}?`, message: preview(message), lines: [], okLabel: "Send" };
      },
      run: (args) => m.sendWhatsApp(args),
    },
    send_email: {
      confirm: true,
      decl: {
        name: "send_email",
        description: "Write and send an email. `to` is an email address or a saved contact's name. Write a clear subject and a complete, well-written body from what the user said (polite, natural, signed 'Teja' unless told otherwise). If the user says which of their own addresses to send from, pass it as `from`. If no recipient address is known, ask the user for it. The user sees and approves it first automatically.",
        parameters: { type: "OBJECT", properties: {
          to: { type: "STRING", description: "Email address or contact name." },
          subject: { type: "STRING", description: "Subject line." },
          body: { type: "STRING", description: "Full email text, with greeting and sign-off." },
          cc: { type: "ARRAY", items: { type: "STRING" }, description: "Optional CC addresses." },
          from: { type: "STRING", description: "Optional: the user's own email address to send from." },
        }, required: ["to", "subject", "body"] },
      },
      async plan({ to, subject, body, cc, from }) {
        const who = m.resolveEmail(to);
        if (who.ambiguous) throw new Error(`More than one contact matches "${to}": ${who.ambiguous.join(", ")}. Say which one.`);
        if (who.missing) throw new Error(`I don't have an email address for ${who.label}. Tell me their address and I'll save it.`);
        if (from && !isEmail(from)) throw new Error(`"${from}" doesn't look like an email address to send from.`);
        const route = m.emailRoute(from);
        const direct = route.mode === "direct";
        return {
          title: direct ? `Send this email to ${who.label}?` : `Open this email to ${who.label} in Gmail?`,
          lines: [`From: ${route.from || "the Google account open in your browser"}`, `To: ${who.email}`, ...(cc && cc.length ? [`Cc: ${[].concat(cc).join(", ")}`] : []), `Subject: ${subject}`],
          message: preview(body), okLabel: direct ? "Send" : "Open in Gmail",
        };
      },
      run: (args) => m.sendEmail(args),
    },
  };
}

module.exports = { createMessaging, createMessagingTools, nameMatches, textMatches, WA_PS };
