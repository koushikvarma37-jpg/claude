// Electron main process: creates the window, registers shortcuts,
// and connects the UI to the agent, tools and settings.
const { app, BrowserWindow, ipcMain, globalShortcut, shell, session, safeStorage, Tray, Menu, nativeImage, screen, desktopCapturer, clipboard, Notification } = require("electron");
const path = require("path");
const { execFile } = require("child_process");
const { GoogleGenAI } = require("@google/genai");
const { createPaths } = require("./src/paths");
const { createTools } = require("./src/tools");
const { createApps } = require("./src/apps");
const { createAgent, friendlyError } = require("./src/agent");
const { createSettings } = require("./src/settings");
const { createQuick } = require("./src/quick");
const { createHistory } = require("./src/history");
const { createPs } = require("./src/winps");
const { createMemory } = require("./src/memory");

const SHOW_SHORTCUT = "Control+Shift+Space";
const VOICE_SHORTCUT = "Control+Shift+M";

let win = null, tray = null;
let quitting = false;
let settings, agent, toolkit, history, memory;
const startHidden = process.argv.includes("--hidden"); // launched by Windows at sign-in
let client = null, clientKey = "";
const pendingConfirms = new Map();

if (!app.requestSingleInstanceLock()) app.quit();

// A slip in a background task (a timer, a reminder) must never pop up a crash dialog or take Relay down.
process.on("uncaughtException", (err) => console.error("Relay background error:", err));
process.on("unhandledRejection", (err) => console.error("Relay background error:", err));

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

/** The size and place Relay was last left at, if that spot is still on a connected screen. */
function savedBounds() {
  const b = settings.get("windowBounds");
  if (!b || !b.width || !b.height) return { width: 760, height: 620 };
  const area = screen.getDisplayMatching(b).workArea;
  const visible = b.x < area.x + area.width - 80 && b.x + b.width > area.x + 80 && b.y >= area.y - 10 && b.y < area.y + area.height - 80;
  return visible ? b : { width: Math.min(b.width, area.width), height: Math.min(b.height, area.height) };
}

function createWindow() {
  win = new BrowserWindow({
    ...savedBounds(), minWidth: 520, minHeight: 440,
    frame: false, show: false, backgroundColor: "#111315", maximizable: true, resizable: true,
    title: "Relay",
    icon: path.join(__dirname, "renderer", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => {
    if (settings.get("windowMaximized")) win.maximize();
    if (!startHidden) win.show();
  });
  // Remember size, position and maximized state
  let saveTimer = null;
  const rememberBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const maximized = win.isMaximized();
      settings.update(maximized ? { windowMaximized: true } : { windowMaximized: false, windowBounds: win.getBounds() });
    }, 400);
  };
  win.on("resize", rememberBounds);
  win.on("move", rememberBounds);
  win.on("maximize", () => { rememberBounds(); send({ type: "window-state", maximized: true }); });
  win.on("unmaximize", () => { rememberBounds(); send({ type: "window-state", maximized: false }); });
  // Closing the window keeps Relay running in the tray, so the shortcut always works
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!settings.get("trayHintShown") && tray) {
      tray.displayBalloon({ title: "Relay is still running", content: "It's in the system tray. Press Ctrl+Shift+Space to bring it back.", iconType: "info" });
      settings.update({ trayHintShown: true });
    }
  });
  // Links clicked in replies open in the real browser, never inside Relay
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

// ---------- Tray & start with Windows ----------
function loginItemOptions(enabled) {
  // Packaged app: Relay.exe --hidden. During development: electron.exe <app folder> --hidden
  return app.isPackaged
    ? { openAtLogin: enabled, args: ["--hidden"] }
    : { openAtLogin: enabled, path: process.execPath, args: [app.getAppPath(), "--hidden"] };
}
function setStartWithWindows(enabled) {
  if (process.platform === "win32" || process.platform === "darwin") app.setLoginItemSettings(loginItemOptions(enabled));
  settings.update({ startWithWindows: enabled });
  refreshTrayMenu();
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, "renderer", "icon.png")).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip("Relay: Ctrl+Shift+Space");
  tray.on("click", () => (win.isVisible() && win.isFocused() ? win.hide() : showWindow()));
  refreshTrayMenu();
}
function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Relay", accelerator: SHOW_SHORTCUT, click: () => { showWindow(); send({ type: "focus-input" }); } },
    { label: "Start listening", accelerator: VOICE_SHORTCUT, click: () => { showWindow(); send({ type: "start-voice" }); } },
    { type: "separator" },
    { label: "Start with Windows", type: "checkbox", checked: !!settings.get("startWithWindows"), click: (item) => setStartWithWindows(item.checked) },
    { type: "separator" },
    { label: "Quit Relay", click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------- Screen capture (screenshots, "what's on my screen", checking WhatsApp before sending) ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function captureScreen({ hideRelay = false, maxWidth = 0, primary = false } = {}) {
  const hide = hideRelay && win && win.isVisible() && !win.isMinimized();
  if (hide) { win.hide(); await wait(350); } // let the window fade out first
  try {
    const displays = screen.getAllDisplays();
    const main = screen.getPrimaryDisplay();
    const biggest = primary ? main : displays.reduce((a, d) => (d.size.width * d.scaleFactor > a.size.width * a.scaleFactor ? d : a), displays[0]);
    let w = Math.round(biggest.size.width * biggest.scaleFactor), h = Math.round(biggest.size.height * biggest.scaleFactor);
    if (maxWidth && w > maxWidth) { h = Math.round((h * maxWidth) / w); w = maxWidth; }
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: w, height: h } });
    let list = sources.filter((s) => !s.thumbnail.isEmpty());
    if (primary) list = list.filter((s) => s.display_id === String(main.id)).concat(list).slice(0, 1); // only the main screen (falls back to the first)
    return list.map((s) => ({ png: s.thumbnail.toPNG() }));
  } finally {
    if (hide) win.show();
  }
}

// ---------- Email (Gmail or a college Google Workspace account, with an app password) ----------
let mailer = null, mailerUser = "";
async function sendMail({ from, to, cc, subject, text }) {
  const nodemailer = require("nodemailer");
  if (!mailer || mailerUser !== from.user + from.pass) {
    mailer = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: from.user, pass: from.pass } });
    mailerUser = from.user + from.pass;
  }
  await mailer.sendMail({ from: from.user, to, cc: cc && cc.length ? cc : undefined, subject, text });
}

// ---------- Reminders: checked every 20 seconds, shown as Windows notifications ----------
function checkReminders() {
  for (const r of memory.takeDue()) {
    const late = r.late ? ` (was due ${new Date(r.late).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })})` : "";
    if (Notification.isSupported()) {
      const n = new Notification({ title: "Relay reminder", body: r.text + late, icon: path.join(__dirname, "renderer", "icon.png"), timeoutType: "never" });
      n.on("click", showWindow);
      n.show();
    } else if (tray) tray.displayBalloon({ title: "Relay reminder", content: r.text + late, iconType: "info" });
    send({ type: "reminder", text: r.text, late: !!r.late });
  }
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

app.whenReady().then(() => {
  if (process.platform === "win32") app.setAppUserModelId("com.tejavarma.relay"); // needed for Windows notifications
  settings = createSettings({ dir: app.getPath("userData"), safeStorage });
  memory = createMemory({ dir: app.getPath("userData") });
  history = createHistory({ dir: path.join(app.getPath("userData"), "conversations") });
  const paths = createPaths({
    home: app.getPath("home"), desktop: app.getPath("desktop"), downloads: app.getPath("downloads"),
    documents: app.getPath("documents"), pictures: app.getPath("pictures"), music: app.getPath("music"), videos: app.getPath("videos"),
  });
  const apps = createApps();
  apps.load(); // warm the app list in the background
  const ps = createPs();
  toolkit = createTools({
    paths, apps, ps, memory, settings,
    platform: process.platform,
    exec: execFile,
    openPath: (p) => shell.openPath(p), openExternal: (u) => shell.openExternal(u), trash: (p) => shell.trashItem(p),
    captureScreen,
    ask: (parts, opts) => agent.ask(parts, opts),
    clipboard: { read: () => clipboard.readText(), write: (t) => clipboard.writeText(t) },
    sendMail,
  });

  // First run of the installed app: start with Windows by default (can be turned off in Settings or the tray)
  if (settings.get("startWithWindows") === undefined) {
    if (app.isPackaged) setStartWithWindows(true); else settings.update({ startWithWindows: false });
  }

  agent = createAgent({
    getClient, toolkit, paths,
    getModel: () => settings.get("model") || "gemini-flash-latest",
    getFallbackModels,
    quick: createQuick({ apps }),
    getMemory: () => memory.promptBlock(),
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
  createTray();
  setTimeout(checkReminders, 4000); // reminders missed while the PC was off show up shortly after start
  setInterval(checkReminders, 20000);

  globalShortcut.register(SHOW_SHORTCUT, () => {
    if (win.isVisible() && win.isFocused()) win.hide(); else { showWindow(); send({ type: "focus-input" }); }
  });
  globalShortcut.register(VOICE_SHORTCUT, () => { showWindow(); send({ type: "start-voice" }); });
});

app.on("second-instance", showWindow);
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { if (quitting) app.quit(); });

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

// ---------- Past conversations (stored only on this PC) ----------
const safely = (fn) => async (_e, arg) => { try { return { ok: true, ...(await fn(arg)) }; } catch (err) { return { ok: false, error: err.message }; } };
ipcMain.handle("history:list", safely(() => ({ items: history.list() })));
ipcMain.handle("history:save", safely(({ id, turns }) => ({ meta: history.save({ id, turns, contents: agent.getHistory() }) })));
ipcMain.handle("history:open", safely((id) => { const c = history.load(id); agent.load(c.contents); return { conversation: { id: c.id, title: c.title, turns: c.turns } }; }));
ipcMain.handle("history:delete", safely((id) => { history.remove(id); return {}; }));
ipcMain.handle("history:clear", safely(() => { history.clear(); return {}; }));

// ---------- What Relay remembers (shown in Settings) ----------
ipcMain.handle("memory:list", safely(() => ({ memory: memory.list() })));
ipcMain.handle("memory:remove", safely((id) => ({ removed: memory.removeById(id) })));

ipcMain.handle("settings:get", () => ({ ...settings.publicView(), shortcuts: { show: SHOW_SHORTCUT, voice: VOICE_SHORTCUT } }));
ipcMain.handle("settings:set", (_e, patch) => {
  fallbackCache = null;
  if (patch && typeof patch.startWithWindows === "boolean") setStartWithWindows(patch.startWithWindows);
  return settings.update(patch || {});
});
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
ipcMain.on("window:toggle-maximize", () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.handle("window:is-maximized", () => !!(win && win.isMaximized()));
ipcMain.on("window:hide", () => win && win.hide());
ipcMain.on("window:close", () => win && win.close()); // hides to the tray (see the "close" handler)
ipcMain.on("app:quit", () => { quitting = true; app.quit(); });
ipcMain.on("open:link", (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
