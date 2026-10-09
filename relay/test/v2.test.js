// Tests for Relay 2: PC controls, screen, files, memory & reminders, WhatsApp and email.
// Windows itself (PowerShell, the screen, WhatsApp) is replaced by fakes, so these run anywhere.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { createPaths } = require("../src/paths");
const { createTools } = require("../src/tools");
const { createAgent, systemPrompt } = require("../src/agent");
const { createMemory, normalizePhone, parseWhen } = require("../src/memory");
const { nameMatches, textMatches } = require("../src/messaging");
const { docxText, pptxText, xlsxText } = require("../src/reader");

// ---------- helpers ----------
function zip(files) {
  // minimal .zip writer (deflate) so tests can make real .docx/.pptx/.xlsx files
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = zlib.deflateRawSync(Buffer.from(content, "utf8"));
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data); centrals.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const DOCX = (paras) => zip({ "word/document.xml": `<w:document><w:body>${paras.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>` });

function sandbox({ psReplies = {}, askReplies = [], emailAccount = null, waInstalled = true, clipboard = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay2-"));
  const known = { home };
  for (const k of ["desktop", "downloads", "documents", "pictures", "music", "videos"]) {
    known[k] = path.join(home, k[0].toUpperCase() + k.slice(1));
    fs.mkdirSync(known[k]);
  }
  const paths = createPaths(known, {});
  const log = { ps: [], asked: [], opened: [], mails: [], exec: [], clipboard: "user's clipboard" };
  const memory = createMemory({ dir: path.join(home, "data") });
  const ps = {
    run: async (script, env = {}) => {
      log.ps.push(env);
      const r = typeof psReplies === "function" ? psReplies(env) : psReplies[env.ACTION || "default"];
      return r || { status: "ok", level: env.LEVEL != null ? +env.LEVEL : 50, muted: env.MUTE === "on" };
    },
  };
  const toolkit = createTools({
    paths, ps, memory,
    platform: "win32",
    settings: { emailAccount: () => emailAccount },
    exec: (cmd, args, opts, cb) => { log.exec.push([cmd, ...args]); cb(null, "", ""); },
    apps: {
      find: async (n) => (waInstalled && /whatsapp/i.test(n) ? [{ a: { Name: "WhatsApp" }, s: 100 }] : []),
      launch: async () => ({ ok: true, name: "WhatsApp" }),
    },
    openPath: async (p) => { log.opened.push(p); return ""; },
    openExternal: async (u) => { log.opened.push(u); },
    trash: async () => {},
    captureScreen: async () => [{ png: Buffer.from("fakepng") }],
    ask: async (parts, opts) => { log.asked.push({ parts, opts }); const r = askReplies.shift(); if (r instanceof Error) throw r; return typeof r === "string" ? r : JSON.stringify(r || {}); },
    clipboard: clipboard || { read: () => log.clipboard, write: (t) => { log.clipboard = t; } },
    sendMail: async (m) => { log.mails.push(m); },
    sleep: async () => {},
    now: () => new Date(),
  });
  return { home, known, paths, memory, toolkit, t: toolkit.tools, log };
}

// ---------- memory ----------
test("phone numbers: Indian 10-digit numbers get +91, others keep their code", () => {
  assert.equal(normalizePhone("98765 43210"), "919876543210");
  assert.equal(normalizePhone("+91 98765-43210"), "919876543210");
  assert.equal(normalizePhone("098765 43210"), "919876543210");
  assert.equal(normalizePhone("+1 (415) 555-0100"), "14155550100");
  assert.equal(normalizePhone("0044 20 7946 0958"), "442079460958");
});

test("memory: facts, contacts and forgetting are saved to disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaymem-"));
  const m = createMemory({ dir });
  m.addFact("Teja's DSP lab exam is on Friday");
  m.addFact("teja's dsp lab exam is on friday"); // duplicate ignored
  m.saveContact({ name: "Amma", phone: "9876543210" });
  m.saveContact({ name: "Ravi Kumar", email: "ravi@example.com" });
  m.saveContact({ name: "amma", email: "amma@example.com" }); // updates, doesn't duplicate
  const again = createMemory({ dir });
  const data = again.list();
  assert.equal(data.facts.length, 1);
  assert.equal(data.contacts.length, 2);
  assert.deepEqual(again.findContacts("Amma").map((c) => [c.phone, c.email]), [["919876543210", "amma@example.com"]]);
  assert.equal(again.findContacts("ravi")[0].name, "Ravi Kumar");
  assert.match(again.promptBlock(), /Amma · WhatsApp \+919876543210 · amma@example\.com/);
  assert.equal(again.remove("dsp lab").length, 1);
  assert.equal(again.list().facts.length, 0);
  assert.throws(() => again.saveContact({ name: "X", phone: "12" }), /phone number/);
  assert.throws(() => again.saveContact({ name: "X", email: "not-an-email" }), /email/);
});

test("reminders: due ones fire once; repeating ones move to the next day", () => {
  let now = new Date(2026, 9, 7, 9, 0).getTime();
  const m = createMemory({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "relayrem-")), now: () => now });
  m.addReminder({ text: "Call home", at: now + 20 * 60000 });
  m.addReminder({ text: "Drink water", at: now + 60 * 60000, repeat: "daily" });
  assert.throws(() => m.addReminder({ text: "late", at: now - 3600000 }), /already passed/);
  assert.deepEqual(m.takeDue(), []);
  now += 21 * 60000;
  assert.deepEqual(m.takeDue().map((r) => r.text), ["Call home"]);
  assert.deepEqual(m.takeDue(), [], "fires only once");
  now += 3 * 3600000; // PC was asleep: the daily one is late
  const late = m.takeDue();
  assert.equal(late[0].text, "Drink water");
  assert.ok(late[0].late, "marked as late");
  assert.equal(new Date(m.list().reminders[0].at).getDate(), 8, "rescheduled for tomorrow");
});

test("reminder times: minutes from now, local ISO, and a bare clock time", () => {
  const now = new Date(2026, 9, 7, 18, 0).getTime();
  assert.equal(parseWhen({ in_minutes: 20 }, now), now + 20 * 60000);
  assert.equal(parseWhen({ at: "2026-10-07T19:30" }, now), new Date(2026, 9, 7, 19, 30).getTime());
  assert.equal(parseWhen({ at: "17:00" }, now), new Date(2026, 9, 8, 17, 0).getTime(), "5 pm already passed today → tomorrow");
  assert.ok(Number.isNaN(parseWhen({}, now)));
});

test("memory tools: remember and set_reminder, and memory reaches Gemini's instructions", async () => {
  const { t, memory } = sandbox();
  await t.remember.run({ fact: "Teja prefers Chrome" });
  const r = await t.set_reminder.run({ message: "Submit DSP record", in_minutes: 30 });
  assert.match(r.summary, /I'll remind you/);
  const prompt = systemPrompt({ known: { home: "H" } }, new Date(2026, 9, 7, 12, 0), memory.promptBlock());
  assert.match(prompt, /Teja prefers Chrome/);
  assert.match(prompt, /Submit DSP record/);
  assert.match(prompt, /local time 2026-10-07T12:00/);
});

// ---------- PC controls ----------
test("volume: exact level, relative change and mute go to PowerShell as numbers", async () => {
  const { t, log } = sandbox();
  assert.equal((await t.set_volume.run({ level: 140 })).summary, "Volume set to 100%");
  assert.equal(log.ps.at(-1).LEVEL, 100);
  await t.set_volume.run({ change: -10 });
  assert.equal(log.ps.at(-1).CHANGE, -10);
  assert.equal((await t.set_volume.run({ mute: "on" })).summary, "Muted the sound");
  await assert.rejects(t.set_volume.run({}), /what volume/);
});

test("brightness on an external monitor says so instead of failing silently", async () => {
  const { t } = sandbox({ psReplies: { default: { status: "unsupported" } } });
  const r = await t.set_brightness.run({ level: 50 });
  assert.equal(r.error, "unsupported");
});

test("power: lock runs straight away; shutdown and restart need approval", async () => {
  const { t, log } = sandbox();
  assert.equal(t.power_action.confirm({ action: "lock" }), false);
  assert.equal(t.power_action.confirm({ action: "shutdown" }), true);
  assert.equal(t.power_action.confirm({ action: "cancel" }), false);
  const plan = await t.power_action.plan({ action: "shutdown", minutes: 10 });
  assert.match(plan.title, /Shut down the PC in 10 minutes/);
  assert.equal(plan.okLabel, "Shut down");
  await t.power_action.run({ action: "shutdown", minutes: 10 });
  assert.deepEqual(log.exec.at(-1), ["shutdown.exe", "/s", "/t", "600"]);
  await t.power_action.run({ action: "lock" });
  assert.deepEqual(log.exec.at(-1), ["rundll32.exe", "user32.dll,LockWorkStation"]);
});

test("agent: 'lock my pc' runs without an approval card, 'shut down' asks", async () => {
  const sb = sandbox();
  const replies = [
    { functionCalls: [{ id: "1", name: "power_action", args: { action: "lock" } }] }, { functionCalls: [], text: "Locked." },
    { functionCalls: [{ id: "2", name: "power_action", args: { action: "shutdown" } }] }, { functionCalls: [], text: "Cancelled." },
  ];
  const fakeClient = { models: { generateContent: async () => {
    const r = replies.shift();
    return { candidates: [{ content: { role: "model", parts: r.functionCalls.length ? r.functionCalls.map((c) => ({ functionCall: c })) : [{ text: r.text }] } }], functionCalls: r.functionCalls, text: r.text };
  } } };
  let asked = 0;
  const agent = createAgent({ getClient: () => fakeClient, getModel: () => "t", toolkit: sb.toolkit, paths: sb.paths, onEvent: () => {}, askConfirm: async () => { asked++; return false; } });
  await agent.run("lock my pc", { turnId: "a" });
  assert.equal(asked, 0);
  await agent.run("shut down", { turnId: "b" });
  assert.equal(asked, 1);
  assert.equal(sb.log.exec.filter((c) => c[0] === "shutdown.exe").length, 0, "declined shutdown never ran");
});

test("screenshot is saved in Pictures\\Screenshots; look_at_screen sends the image to Gemini", async () => {
  const { t, known, log } = sandbox({ askReplies: ["The error says: file not found."] });
  const r = await t.take_screenshot.run({});
  assert.ok(fs.existsSync(r.path));
  assert.equal(path.dirname(r.path), path.join(known.pictures, "Screenshots"));
  const look = await t.look_at_screen.run({ question: "explain the error" });
  assert.equal(look.answer, "The error says: file not found.");
  assert.equal(log.asked[0].parts[0].inlineData.mimeType, "image/png");
});

// ---------- files ----------
test("reader: Word, PowerPoint and Excel text", () => {
  assert.equal(docxText(DOCX(["Fourier transform", "Lab &amp; record"])), "Fourier transform\nLab & record");
  const pptx = zip({
    "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide10.xml": "<p:sld><a:p><a:r><a:t>Tenth</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Title</a:t></a:r></a:p><a:p><a:r><a:t>Point</a:t></a:r></a:p></p:sld>",
  });
  assert.equal(pptxText(pptx), "--- Slide 1 ---\nTitle\nPoint\n\n--- Slide 2 ---\nSecond\n\n--- Slide 3 ---\nTenth");
  const xlsx = zip({
    "xl/sharedStrings.xml": "<sst><si><t>Name</t></si><si><t>Marks</t></si><si><t>Teja</t></si></sst>",
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>92</v></c></row></sheetData></worksheet>',
  });
  assert.equal(xlsxText(xlsx), "--- Sheet 1 ---\nName\tMarks\nTeja\t92");
});

test("read_file: Word text is read locally; PDFs go to Gemini as files", async () => {
  const { t, known, log } = sandbox({ askReplies: ["Deadline is 10 Oct.", "It's about sampling."] });
  fs.writeFileSync(path.join(known.documents, "assignment.docx"), DOCX(["Submit by 10 Oct"]));
  fs.writeFileSync(path.join(known.documents, "notes.pdf"), "%PDF-1.4 fake");
  const r = await t.read_file.run({ path: "Documents/assignment.docx", question: "what is the deadline?" });
  assert.equal(r.answer, "Deadline is 10 Oct.");
  assert.match(log.asked[0].parts[0].text, /Submit by 10 Oct/);
  await t.read_file.run({ path: "Documents/notes.pdf", question: "summarise" });
  assert.equal(log.asked[1].parts[0].inlineData.mimeType, "application/pdf");
  await assert.rejects(t.read_file.run({ path: "Documents/old.doc", question: "x" }), /Not found/);
  fs.writeFileSync(path.join(known.documents, "old.doc"), "x");
  await assert.rejects(t.read_file.run({ path: "Documents/old.doc", question: "x" }), /old Office format/);
});

test("search_in_files finds documents by what they say", async () => {
  const { t, known } = sandbox();
  fs.mkdirSync(path.join(known.documents, "Sem5"));
  fs.writeFileSync(path.join(known.documents, "Sem5", "dsp unit 2.docx"), DOCX(["The Fourier transform of a rectangular pulse is a sinc."]));
  fs.writeFileSync(path.join(known.desktop, "todo.txt"), "buy milk");
  const r = await t.search_in_files.run({ query: "fourier sinc" });
  assert.deepEqual(r.results.map((x) => path.basename(x.path)), ["dsp unit 2.docx"]);
  assert.match(r.results[0].snippet, /Fourier transform/);
});

// ---------- WhatsApp ----------
test("WhatsApp name and text checks tolerate how WhatsApp shows them", () => {
  assert.ok(nameMatches("Ravi", "Ravi Kumar CSE"));
  assert.ok(nameMatches("amma", "Amma ❤️"));
  assert.ok(!nameMatches("Ravi", "Ravindra"));
  assert.ok(!nameMatches("Amma", null));
  assert.ok(textMatches("I'll be late, start without me", "I'll be late, start without me"));
  assert.ok(!textMatches("I'll be late", ""));
});

test("WhatsApp to a saved number: opens the chat, checks the screen, then sends", async () => {
  const { t, memory, log } = sandbox({ askReplies: [{ whatsapp_visible: true, open_chat_name: "Amma", message_box_text: "I'll be late today" }] });
  memory.saveContact({ name: "Amma", phone: "9876543210" });
  const plan = await t.send_whatsapp.plan({ to: "amma", message: "I'll be late today" });
  assert.match(plan.title, /Amma \(\+919876543210\)/);
  assert.equal(plan.message, "I'll be late today");
  assert.equal(plan.okLabel, "Send");
  const r = await t.send_whatsapp.run({ to: "amma", message: "I'll be late today" });
  assert.equal(r.sent, true);
  assert.deepEqual(log.ps.map((e) => e.ACTION), ["open_uri", "send"]);
  assert.equal(log.ps[0].URI, "whatsapp://send?phone=919876543210&text=I'll%20be%20late%20today");
});

test("WhatsApp: if the message never shows up in the box, nothing is sent", async () => {
  const empty = { whatsapp_visible: true, open_chat_name: "+91 98765 43210", message_box_text: null };
  const { t, log } = sandbox({ askReplies: [empty, empty, empty] });
  const r = await t.send_whatsapp.run({ to: "9876543210", message: "hello" });
  assert.equal(r.sent, false);
  assert.ok(!log.ps.some((e) => e.ACTION === "send"));
});

const LIST = { whatsapp_visible: true, search_box: { x: 120, y: 180 }, search_text: null, open_chat_name: null, message_box_text: null };

test("WhatsApp by name: clicks the search box, checks the name, opens the chat, checks again, sends, and gives the clipboard back", async () => {
  const { t, log } = sandbox({ askReplies: [
    LIST,
    { ...LIST, search_text: "Ravi" },
    { ...LIST, search_text: "Ravi", open_chat_name: "Ravi Kumar", message_box_text: "Bring the DSP record tomorrow" },
  ] });
  const r = await t.send_whatsapp.run({ to: "Ravi", message: "Bring the DSP record tomorrow" });
  assert.equal(r.sent, true);
  assert.deepEqual(log.ps.map((e) => e.ACTION), ["escape", "click", "type", "open", "paste", "send"]);
  assert.deepEqual([log.ps[1].X, log.ps[1].Y], [120, 180]);
  await new Promise((res) => setTimeout(res, 350));
  assert.equal(log.clipboard, "user's clipboard");
});

test("WhatsApp by name: the wrong chat opening means nothing is sent", async () => {
  const wrong = { ...LIST, search_text: "Ravi", open_chat_name: "Ravindra", message_box_text: "hi" };
  const { t, log } = sandbox({ askReplies: [LIST, { ...LIST, search_text: "Ravi" }, wrong, LIST, { ...LIST, search_text: "Ravi" }, wrong] });
  const r = await t.send_whatsapp.run({ to: "Ravi", message: "hi" });
  assert.equal(r.error, "chat_not_found");
  assert.ok(!log.ps.some((e) => e.ACTION === "send"), "never sent");
  assert.deepEqual(log.ps.filter((e) => e.ACTION === "open").map((e) => e.MODE), ["enter", "down"]);
  assert.equal(log.ps.filter((e) => e.ACTION === "clear").length, 2, "removed the pasted text both times");
});

test("WhatsApp by name: if the name didn't reach the search box, Relay stops before pressing Enter", async () => {
  const { t, log } = sandbox({ askReplies: [LIST, { ...LIST, search_text: null }] });
  const r = await t.send_whatsapp.run({ to: "Teja Varma", message: "hi" });
  assert.equal(r.error, "search_failed");
  assert.deepEqual(log.ps.map((e) => e.ACTION), ["escape", "click", "type"]);
});

test("WhatsApp by name: no search box on screen, or a click outside WhatsApp, sends nothing", async () => {
  const a = sandbox({ askReplies: [{ ...LIST, search_box: null }] });
  assert.equal((await a.t.send_whatsapp.run({ to: "Ravi", message: "hi" })).error, "no_search_box");
  const b = sandbox({ askReplies: [LIST], psReplies: (env) => (env.ACTION === "click" ? { status: "outside" } : { status: "ok" }) });
  assert.equal((await b.t.send_whatsapp.run({ to: "Ravi", message: "hi" })).error, "no_search_box");
  assert.ok(!b.log.ps.some((e) => ["type", "open", "send"].includes(e.ACTION)));
});

test("WhatsApp: a clipboard that can't be read or restored never crashes Relay", async () => {
  const broken = { read: () => { throw new Error("clipboard busy"); }, write: () => { throw new TypeError("conversion failure"); } };
  const sb = sandbox({ clipboard: broken, askReplies: [{ whatsapp_visible: true, open_chat_name: "Amma", message_box_text: "hello" }] });
  const r = await sb.t.send_whatsapp.run({ to: "9876543210", message: "hello" });
  assert.equal(r.sent, true);
  const odd = sandbox({ clipboard: { read: () => undefined, write: () => { throw new TypeError("conversion failure"); } }, askReplies: [{ whatsapp_visible: true, open_chat_name: "Amma", message_box_text: "hello" }] });
  assert.equal((await odd.t.send_whatsapp.run({ to: "9876543210", message: "hello" })).sent, true);
  await new Promise((res) => setTimeout(res, 350)); // the restore timer runs without throwing
});

test("WhatsApp: Relay refuses to type when it can't bring WhatsApp to the front", async () => {
  const { t } = sandbox({ psReplies: { open_uri: { status: "not_focused" } } });
  await assert.rejects(t.send_whatsapp.run({ to: "9876543210", message: "hi" }), /nothing was sent/);
});

test("WhatsApp not installed: uses WhatsApp Web for numbers, asks for a number otherwise", async () => {
  const { t, log } = sandbox({ waInstalled: false });
  const web = await t.send_whatsapp.run({ to: "+91 98765 43210", message: "hi there" });
  assert.equal(web.sent, false);
  assert.equal(log.opened.at(-1), "https://web.whatsapp.com/send?phone=919876543210&text=hi%20there");
  const named = await t.send_whatsapp.run({ to: "Ravi", message: "hi" });
  assert.equal(named.error, "need_number");
});

test("WhatsApp: two contacts with the same first name → asks which one", async () => {
  const { t, memory } = sandbox();
  memory.saveContact({ name: "Ravi Kumar", phone: "9000000001" });
  memory.saveContact({ name: "Ravi Teja", phone: "9000000002" });
  await assert.rejects(t.send_whatsapp.plan({ to: "Ravi", message: "hi" }), /Ravi Kumar, Ravi Teja/);
});

// ---------- email ----------
test("email: sends directly when a Gmail app password is set", async () => {
  const { t, memory, log } = sandbox({ emailAccount: { user: "teja@gmail.com", pass: "abcdabcdabcdabcd" } });
  memory.saveContact({ name: "Ravi sir", email: "ravi@vishnu.edu.in" });
  const plan = await t.send_email.plan({ to: "Ravi sir", subject: "Leave request", body: "Dear Sir,\n\n…\n\nTeja" });
  assert.deepEqual(plan.lines, ["To: ravi@vishnu.edu.in", "Subject: Leave request"]);
  assert.equal(plan.okLabel, "Send");
  const r = await t.send_email.run({ to: "Ravi sir", subject: "Leave request", body: "Dear Sir" });
  assert.equal(r.sent, true);
  assert.equal(log.mails[0].to, "ravi@vishnu.edu.in");
});

test("email without an app password opens the written email in Gmail", async () => {
  const { t, log } = sandbox();
  const plan = await t.send_email.plan({ to: "hr@company.com", subject: "Internship", body: "Hello" });
  assert.equal(plan.okLabel, "Open in Gmail");
  const r = await t.send_email.run({ to: "hr@company.com", subject: "Internship", body: "Hello" });
  assert.equal(r.sent, false);
  const u = new URL(log.opened.at(-1));
  assert.equal(u.hostname, "mail.google.com");
  assert.equal(u.searchParams.get("to"), "hr@company.com");
  assert.equal(u.searchParams.get("su"), "Internship");
});

test("email to someone without a saved address asks for it", async () => {
  const { t } = sandbox();
  await assert.rejects(t.send_email.plan({ to: "Ravi", subject: "x", body: "y" }), /don't have an email address for Ravi/);
});
