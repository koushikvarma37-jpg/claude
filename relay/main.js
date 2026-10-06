// Electron main process: creates the window, registers shortcuts,
// and connects the UI to the agent, tools and settings.
const { app, BrowserWindow, ipcMain, globalShortcut, shell, session, safeStorage } = require("electron");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");
const { createPaths } = require("./src/paths");
const { createTools } = require("./src/tools");
const { createApps } = require("./src/apps");
const { createAgent, friendlyError } = require("./src/agent");
const { createSettings } = require("./src/settings");

const SHOW_SHORTCUT = "Control+Shift+Space";
const VOICE_SHORTCUT = "Control+Shift+M";

let win = null;
let settings, agent, toolkit;
let client = null, clientKey = "";
const pendingConfirms = new Map();

if (!app.requestSingleInstanceLock()) app.quit();

function send(ev) { if (win && !win.isDestroyed()) win.webContents.send("relay:event", ev); }

function getClient() {
  const key = settings.getApiKey();
  if (!key) throw Object.assign(new Error("Add your Gemini API key in Settings first."), { code: "NO_KEY" });
  if (!client || clientKey !== key) { client = new GoogleGenAI({ apiKey: key }); clientKey = key; }
  return client;
}

// Backup models for when the chosen one is busy: fast "flash" models this key can use, best first.
let fallbackCache = null;
async function getFallbackModels() {
  if (fallbackCache) return fallbackCache;
  const preferred = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"];
  let available = [];
  try {
    const pager = await getClient().models.list({ config: { pageSize: 100 } });
    for await (const m of pager) {
      const name = String(m.name || "").replace(/^models\//, "");
      const actions = m.supportedActions || [];
      if (/^gemini.*flash/.test(name) && !/tts|image|live|audio|embedding|preview/i.test(name) && (!actions.length || actions.includes("generateContent"))) available.push(name);
    }
  } catch { available = []; }
  const ordered = [...preferred.filter((n) => available.includes(n)), ...available.filter((n) => !preferred.includes(n)).sort().reverse()];
  fallbackCache = (ordered.length ? ordered : preferred).filter((n) => n !== settings.get("model"));
  return fallbackCache;
}

function createWindow() {
  win = new BrowserWindow({
    width: 760, height: 620, minWidth: 520, minHeight: 440,
    frame: false, show: false, backgroundColor: "#111315",
    title: "Relay",
    icon: path.join(__dirname, "renderer", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());
  // Links clicked in replies open in the real browser, never inside Relay
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

app.whenReady().then(() => {
  settings = createSettings({ dir: app.getPath("userData"), safeStorage });
  const paths = createPaths({
    home: app.getPath("home"), desktop: app.getPath("desktop"), downloads: app.getPath("downloads"),
    documents: app.getPath("documents"), pictures: app.getPath("pictures"), music: app.getPath("music"), videos: app.getPath("videos"),
  });
  const apps = createApps();
  apps.load(); // warm the app list in the background
  toolkit = createTools({ paths, apps, openPath: (p) => shell.openPath(p), openExternal: (u) => shell.openExternal(u), trash: (p) => shell.trashItem(p) });

  agent = createAgent({
    getClient, toolkit, paths,
    getModel: () => settings.get("model") || "gemini-flash-latest",
    getFallbackModels,
    onEvent: send,
    askConfirm: (plan) => new Promise((resolve) => {
      const id = `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
      pendingConfirms.set(id, resolve);
      send({ type: "confirm", id, ...plan });
    }),
  });

  // Allow the microphone (and nothing else) for Relay's own window
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => cb(permission === "media" && (!details.mediaTypes || details.mediaTypes.every((t) => t === "audio"))));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === "media");

  createWindow();

  globalShortcut.register(SHOW_SHORTCUT, () => {
    if (win.isVisible() && win.isFocused()) win.hide(); else { showWindow(); send({ type: "focus-input" }); }
  });
  globalShortcut.register(VOICE_SHORTCUT, () => { showWindow(); send({ type: "start-voice" }); });
});

app.on("second-instance", showWindow);
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());

// ---------- IPC ----------
ipcMain.handle("relay:run", async (_e, { text, turnId }) => {
  try { return { ok: true, ...(await agent.run(String(text).slice(0, 2000), { turnId })) }; }
  catch (err) { return { ok: false, error: err.code === "NO_KEY" ? err.message : friendlyError(err), needsKey: err.code === "NO_KEY" }; }
});

ipcMain.handle("relay:transcribe", async (_e, base64) => {
  try { return { ok: true, text: await agent.transcribe(base64) }; }
  catch (err) { return { ok: false, error: err.code === "NO_KEY" ? err.message : friendlyError(err), needsKey: err.code === "NO_KEY" }; }
});

ipcMain.on("relay:confirm", (_e, { id, ok }) => {
  const resolve = pendingConfirms.get(id);
  if (resolve) { pendingConfirms.delete(id); resolve(!!ok); }
});

ipcMain.handle("relay:undo", async () => {
  try { return { ok: true, ...(await toolkit.undoLast()) }; } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.on("relay:stop", () => { agent.stop(); for (const [id, r] of pendingConfirms) { pendingConfirms.delete(id); r(false); } });
ipcMain.on("relay:reset", () => agent.reset());

ipcMain.handle("settings:get", () => ({ ...settings.publicView(), shortcuts: { show: SHOW_SHORTCUT, voice: VOICE_SHORTCUT } }));
ipcMain.handle("settings:set", (_e, patch) => { fallbackCache = null; return settings.update(patch || {}); });
ipcMain.handle("settings:models", async () => {
  try {
    const ai = getClient();
    const pager = await ai.models.list({ config: { pageSize: 100 } });
    const names = [];
    for await (const m of pager) {
      const name = String(m.name || "").replace(/^models\//, "");
      const actions = m.supportedActions || [];
      if (!/^gemini/.test(name) || (actions.length && !actions.includes("generateContent"))) continue;
      if (/tts|image|embedding|live|robotics|audio|computer-use/i.test(name)) continue;
      names.push(name);
    }
    return { ok: true, models: names.sort() };
  } catch (err) { return { ok: false, error: friendlyError(err) }; }
});

ipcMain.on("window:minimize", () => win && win.minimize());
ipcMain.on("window:hide", () => win && win.hide());
ipcMain.on("window:close", () => app.quit());
ipcMain.on("open:link", (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
