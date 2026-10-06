// Run with: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createPaths } = require("../src/paths");
const { createTools } = require("../src/tools");
const { createAgent } = require("../src/agent");
const { createApps } = require("../src/apps");

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-"));
  const known = { home };
  for (const k of ["desktop", "downloads", "documents", "pictures", "music", "videos"]) {
    known[k] = path.join(home, k[0].toUpperCase() + k.slice(1));
    fs.mkdirSync(known[k]);
  }
  const trashed = [], opened = [];
  const paths = createPaths(known, {});
  const toolkit = createTools({
    paths,
    trash: async (p) => { trashed.push(p); fs.rmSync(p, { recursive: true }); },
    openPath: async (p) => { opened.push(p); return ""; },
    openExternal: async (u) => { opened.push(u); },
    apps: { launch: async (n) => (n === "WhatsApp" ? { ok: true, name: "WhatsApp" } : { ok: false, suggestions: ["Whatsapp Beta"] }) },
  });
  const touch = (...p) => { const f = path.join(...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "x"); return f; };
  return { home, known, paths, toolkit, t: toolkit.tools, trashed, opened, touch };
}

test("paths: aliases, full paths and blocked locations", () => {
  const { paths, known } = sandbox();
  assert.equal(paths.resolve("Desktop/DSP notes"), path.join(known.desktop, "DSP notes"));
  assert.equal(paths.resolve("downloads"), known.downloads);
  assert.equal(paths.resolve("My Documents/College"), path.join(known.documents, "College"));
  assert.equal(paths.resolve("/tmp/x"), "/tmp/x");
  assert.throws(() => paths.resolve("College"), /not a full path/);
  assert.equal(paths.isAllowed("/"), false);
  assert.equal(paths.isAllowed("/etc/passwd"), false);
  assert.equal(paths.isAllowed(path.join(known.home, "AppData", "x")), false);
  assert.equal(paths.pretty(path.join(known.desktop, "a")), path.join("Desktop", "a"));
});

test("windows paths resolve with win32 rules", () => {
  const known = { home: "C:\\Users\\teja", desktop: "C:\\Users\\teja\\OneDrive\\Desktop", downloads: "C:\\Users\\teja\\Downloads" };
  const p = createPaths(known, { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" });
  assert.equal(p.resolve("Desktop/DSP notes"), "C:\\Users\\teja\\OneDrive\\Desktop\\DSP notes");
  assert.equal(p.resolve("D:\\College\\sem5"), "D:\\College\\sem5");
  assert.equal(p.isAllowed("C:\\Windows\\System32"), false);
  assert.equal(p.isAllowed("c:\\program files\\x"), false);
  assert.equal(p.isAllowed("D:\\"), false);
  assert.equal(p.isAllowed("D:\\College"), true);
  assert.equal(p.pretty("C:\\Users\\teja\\OneDrive\\Desktop\\DSP notes"), "Desktop\\DSP notes");
});

test("create_folder, then undo removes it", async () => {
  const { t, toolkit, known } = sandbox();
  const r = await t.create_folder.run({ path: "Desktop/DSP notes" });
  assert.ok(fs.existsSync(path.join(known.desktop, "DSP notes")));
  assert.equal(r.undoable, true);
  await toolkit.undoLast();
  assert.ok(!fs.existsSync(path.join(known.desktop, "DSP notes")));
});

test("move_files by type: plan, run, undo", async () => {
  const { t, toolkit, known, touch } = sandbox();
  touch(known.downloads, "a.pdf"); touch(known.downloads, "b.PDF"); touch(known.downloads, "c.png");
  const plan = await t.move_files.plan({ from_folder: "Downloads", extensions: ["pdf"], destination: "Documents/College" });
  assert.equal(plan.count, 2);
  const r = await t.move_files.run({ from_folder: "Downloads", extensions: [".pdf"], destination: "Documents/College" });
  assert.equal(r.moved, 2);
  assert.deepEqual(fs.readdirSync(path.join(known.documents, "College")).sort(), ["a.pdf", "b.PDF"]);
  assert.deepEqual(fs.readdirSync(known.downloads), ["c.png"]);
  await toolkit.undoLast();
  assert.deepEqual(fs.readdirSync(known.downloads).sort(), ["a.pdf", "b.PDF", "c.png"]);
  assert.ok(!fs.existsSync(path.join(known.documents, "College")), "created folder removed on undo");
});

test("move keeps both files when names clash", async () => {
  const { t, known, touch } = sandbox();
  touch(known.downloads, "notes.pdf"); touch(known.documents, "notes.pdf");
  await t.move_files.run({ paths: ["Downloads/notes.pdf"], destination: "Documents" });
  assert.deepEqual(fs.readdirSync(known.documents).sort(), ["notes (1).pdf", "notes.pdf"]);
});

test("organize_folder sorts by type and undo restores", async () => {
  const { t, toolkit, known, touch } = sandbox();
  for (const f of ["x.jpg", "y.pdf", "z.mp4", "w.zip", "setup.exe", "notes.docx", "odd.qqq"]) touch(known.downloads, f);
  fs.mkdirSync(path.join(known.downloads, "Existing folder"));
  const plan = await t.organize_folder.plan({ path: "Downloads" });
  assert.equal(plan.count, 7);
  await t.organize_folder.run({ path: "Downloads" });
  const top = fs.readdirSync(known.downloads).sort();
  assert.deepEqual(top, ["Archives", "Documents", "Existing folder", "Images", "Installers", "Others", "PDFs", "Videos"]);
  assert.ok(fs.existsSync(path.join(known.downloads, "PDFs", "y.pdf")));
  await toolkit.undoLast();
  assert.deepEqual(fs.readdirSync(known.downloads).sort(), ["Existing folder", "notes.docx", "odd.qqq", "setup.exe", "w.zip", "x.jpg", "y.pdf", "z.mp4"]);
});

test("rename keeps the extension, rejects bad names, undo works", async () => {
  const { t, toolkit, known, touch } = sandbox();
  touch(known.documents, "report.pdf");
  const r = await t.rename_item.run({ path: "Documents/report.pdf", new_name: "final report" });
  assert.equal(path.basename(r.path), "final report.pdf");
  await assert.rejects(t.rename_item.plan({ path: "Documents/final report.pdf", new_name: "a/b" }), /valid name/);
  await toolkit.undoLast();
  assert.ok(fs.existsSync(path.join(known.documents, "report.pdf")));
});

test("find_files searches nested folders by all words", async () => {
  const { t, known, touch } = sandbox();
  touch(known.documents, "Career", "Teja_Resume_2026.pdf");
  touch(known.desktop, "resume old.docx");
  touch(known.documents, "node_modules", "resume.js");
  const r = await t.find_files.run({ query: "resume" });
  const names = r.results.map((x) => path.basename(x.path)).sort();
  assert.deepEqual(names, ["Teja_Resume_2026.pdf", "resume old.docx"]);
  const pdf = await t.find_files.run({ query: "resume", extensions: ["pdf"] });
  assert.equal(pdf.results.length, 1);
});

test("delete goes to the trash function and refuses blocked paths", async () => {
  const { t, trashed, known, touch } = sandbox();
  const f = touch(known.desktop, "junk.txt");
  const plan = await t.delete_items.plan({ paths: [f] });
  assert.equal(plan.danger, true);
  await t.delete_items.run({ paths: [f] });
  assert.deepEqual(trashed, [f]);
  await assert.rejects(t.delete_items.plan({ paths: ["/etc/hosts"] }), /safety/);
});

test("open_url only opens web links", async () => {
  const { t, opened } = sandbox();
  await t.open_url.run({ url: "youtube.com" });
  assert.equal(opened.pop(), "https://youtube.com/");
  await assert.rejects(t.open_url.run({ url: "javascript:alert(1)" }));
});

test("agent: runs a multi-step plan with approval", async () => {
  const sb = sandbox();
  sb.touch(sb.known.downloads, "pitch.pdf");
  const replies = [
    { functionCalls: [{ id: "1", name: "create_folder", args: { path: "Desktop/Hackathon" } }] },
    { functionCalls: [{ id: "2", name: "move_files", args: { from_folder: "Downloads", extensions: ["pdf"], destination: "Desktop/Hackathon" } }] },
    { functionCalls: [], text: "Done. Moved 1 PDF to Desktop\\Hackathon." },
  ];
  const seen = [];
  const fakeClient = { models: { generateContent: async (req) => {
    seen.push({ contents: req.contents.slice() });
    const r = replies.shift();
    const parts = r.functionCalls.length ? r.functionCalls.map((c) => ({ functionCall: c })) : [{ text: r.text }];
    return { candidates: [{ content: { role: "model", parts } }], functionCalls: r.functionCalls, text: r.text };
  } } };
  const events = [];
  let asked = 0;
  const agent = createAgent({
    getClient: () => fakeClient, getModel: () => "test", toolkit: sb.toolkit, paths: sb.paths,
    onEvent: (e) => events.push(e), askConfirm: async () => { asked++; return true; },
  });
  const out = await agent.run("make a folder called Hackathon and move my pdfs into it", { turnId: "t1" });
  assert.equal(out.text, "Done. Moved 1 PDF to Desktop\\Hackathon.");
  assert.equal(asked, 1, "only the move needed approval");
  assert.ok(fs.existsSync(path.join(sb.known.desktop, "Hackathon", "pitch.pdf")));
  const last = seen[2].contents.at(-1);
  assert.equal(last.parts[0].functionResponse.name, "move_files");
  assert.equal(last.parts[0].functionResponse.id, "2");
  assert.ok(events.some((e) => e.type === "step-update" && e.state === "done"));
});

test("agent: declined approval changes nothing", async () => {
  const sb = sandbox();
  sb.touch(sb.known.downloads, "a.pdf");
  const replies = [
    { functionCalls: [{ id: "1", name: "organize_folder", args: { path: "Downloads" } }] },
    { functionCalls: [], text: "Cancelled." },
  ];
  const fakeClient = { models: { generateContent: async () => {
    const r = replies.shift();
    return { candidates: [{ content: { role: "model", parts: r.functionCalls.length ? r.functionCalls.map((c) => ({ functionCall: c })) : [{ text: r.text }] } }], functionCalls: r.functionCalls, text: r.text };
  } } };
  const agent = createAgent({ getClient: () => fakeClient, getModel: () => "t", toolkit: sb.toolkit, paths: sb.paths, onEvent: () => {}, askConfirm: async () => false });
  await agent.run("sort downloads", { turnId: "t" });
  assert.deepEqual(fs.readdirSync(sb.known.downloads), ["a.pdf"]);
});

test("agent: an API error leaves history clean for the next command", async () => {
  const sb = sandbox();
  let call = 0;
  const fakeClient = { models: { generateContent: async (req) => {
    call++;
    if (call === 1) throw Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 });
    assert.equal(req.contents.length, 1, "failed turn was dropped");
    return { candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] } }], functionCalls: [], text: "Hi" };
  } } };
  const agent = createAgent({ getClient: () => fakeClient, getModel: () => "t", toolkit: sb.toolkit, paths: sb.paths, onEvent: () => {}, askConfirm: async () => true });
  await assert.rejects(agent.run("one", { turnId: "a" }));
  assert.equal((await agent.run("two", { turnId: "b" })).text, "Hi");
});

test("apps: matches what people say to real Start menu names", async () => {
  const list = [
    { Name: "WhatsApp", AppID: "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App" },
    { Name: "Visual Studio Code", AppID: "Microsoft.VisualStudioCode" },
    { Name: "Uninstall Visual Studio Code", AppID: "x" },
    { Name: "Google Chrome", AppID: "Chrome" },
    { Name: "Spotify", AppID: "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify" },
  ];
  const launched = [];
  const exec = (cmd, args, opts, cb) => {
    if (cmd === "powershell.exe") { cb(null, JSON.stringify(list)); return {}; }
    launched.push([cmd, args]); cb(null); return { on() {} };
  };
  const apps = createApps({ platform: "win32", exec });
  assert.equal((await apps.launch("whatsapp")).name, "WhatsApp");
  assert.deepEqual(launched.pop(), ["explorer.exe", ["shell:AppsFolder\\5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App"]]);
  assert.equal((await apps.launch("vs code")).name, "Visual Studio Code");
  assert.equal((await apps.launch("chrome")).name, "Google Chrome");
  const miss = await apps.launch("photoshop");
  assert.equal(miss.ok, false);
});

// ---------- Busy-server handling ----------
function fakeGemini(script) {
  const calls = [];
  return { calls, client: { models: { generateContent: async (req) => {
    calls.push(req.model);
    const step = script.shift();
    if (step instanceof Error) throw step;
    const fc = step.functionCalls || [];
    const parts = fc.length ? fc.map((c) => ({ functionCall: c })) : [{ text: step.text }];
    return { candidates: [{ content: { role: "model", parts } }], functionCalls: fc, text: step.text };
  } } } };
}
const busy = () => Object.assign(new Error("The model is overloaded. Please try again later."), { status: 503 });

test("busy: retries the same model, then succeeds", async () => {
  const sb = sandbox();
  const g = fakeGemini([busy(), { text: "Hello" }]);
  const events = [];
  const agent = createAgent({ getClient: () => g.client, getModel: () => "main", toolkit: sb.toolkit, paths: sb.paths, onEvent: (e) => events.push(e), askConfirm: async () => true, sleep: async () => {} });
  assert.equal((await agent.run("hi", { turnId: "t" })).text, "Hello");
  assert.deepEqual(g.calls, ["main", "main"]);
  assert.ok(events.some((e) => e.type === "retry"));
});

test("busy: switches to a backup model when the main one stays busy", async () => {
  const sb = sandbox();
  const g = fakeGemini([busy(), busy(), busy(), { text: "From backup" }]);
  const agent = createAgent({ getClient: () => g.client, getModel: () => "main", getFallbackModels: async () => ["backup"], toolkit: sb.toolkit, paths: sb.paths, onEvent: () => {}, askConfirm: async () => true, sleep: async () => {} });
  assert.equal((await agent.run("hi", { turnId: "t" })).text, "From backup");
  assert.deepEqual(g.calls, ["main", "main", "main", "backup"]);
});

test("busy after an action: reports what was done instead of an error", async () => {
  const sb = sandbox();
  const g = fakeGemini([{ functionCalls: [{ id: "1", name: "open_app", args: { name: "WhatsApp" } }] }, busy(), busy(), busy()]);
  const agent = createAgent({ getClient: () => g.client, getModel: () => "main", getFallbackModels: async () => ["backup"], toolkit: sb.toolkit, paths: sb.paths, onEvent: () => {}, askConfirm: async () => true, sleep: async () => {} });
  const out = await agent.run("open whatsapp", { turnId: "t" });
  assert.equal(out.text, "Opened WhatsApp.");
  assert.equal(out.partial, true);
  assert.ok(!g.calls.includes("backup"), "never switches model in the middle of a task");
  // the next command still works with a clean, well-formed history
  g.client.models.generateContent = async (req) => {
    assert.equal(req.contents.at(-2).role, "model");
    return { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }], functionCalls: [], text: "ok" };
  };
  assert.equal((await agent.run("next", { turnId: "u" })).text, "ok");
});

test("a bad key is not retried", async () => {
  const sb = sandbox();
  const g = fakeGemini([Object.assign(new Error("API key not valid"), { status: 400 })]);
  const agent = createAgent({ getClient: () => g.client, getModel: () => "main", toolkit: sb.toolkit, paths: sb.paths, onEvent: () => {}, askConfirm: async () => true, sleep: async () => {} });
  await assert.rejects(agent.run("hi", { turnId: "t" }), /API key/);
  assert.equal(g.calls.length, 1);
});
