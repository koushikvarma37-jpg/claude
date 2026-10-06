// Finds and opens installed Windows apps.
// Uses PowerShell's Get-StartApps, which lists every app in the Start menu,
// including Microsoft Store apps like WhatsApp that normal shortcuts miss.
const { execFile } = require("child_process");

// Common ways people say app names → words that appear in the real name
const ALIASES = {
  "vs code": "visual studio code", vscode: "visual studio code", code: "visual studio code",
  chrome: "google chrome", "google chrome": "google chrome",
  edge: "microsoft edge", browser: "microsoft edge",
  word: "word", "ms word": "word", excel: "excel", powerpoint: "powerpoint", ppt: "powerpoint",
  explorer: "file explorer", "file manager": "file explorer", files: "file explorer", "my computer": "file explorer", "this pc": "file explorer",
  calc: "calculator", cmd: "command prompt", terminal: "terminal",
  settings: "settings", "control panel": "control panel", camera: "camera", notepad: "notepad",
  whatsapp: "whatsapp", spotify: "spotify", telegram: "telegram", discord: "discord", zoom: "zoom", teams: "teams",
};

// Apps that are always present and launch fine by command
const BUILTIN = [
  { Name: "File Explorer", run: ["explorer.exe", []] },
  { Name: "Settings", run: ["explorer.exe", ["ms-settings:"]] },
  { Name: "Notepad", run: ["notepad.exe", []] },
  { Name: "Calculator", run: ["explorer.exe", ["calculator:"]] },
  { Name: "Command Prompt", run: ["cmd.exe", ["/c", "start", "cmd.exe"]] },
  { Name: "Task Manager", run: ["taskmgr.exe", []] },
];

function createApps({ platform = process.platform, exec = execFile } = {}) {
  let cache = null;
  let loading = null;

  function load() {
    if (platform !== "win32") return Promise.resolve(BUILTIN);
    if (cache) return Promise.resolve(cache);
    if (loading) return loading;
    loading = new Promise((resolve) => {
      exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress"],
        { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
          let list = [];
          if (!err) { try { const j = JSON.parse(stdout); list = Array.isArray(j) ? j : [j]; } catch {} }
          cache = [...BUILTIN, ...list.filter((a) => a && a.Name && a.AppID)];
          loading = null;
          resolve(cache);
        });
    });
    return loading;
  }

  const clean = (s) => String(s).toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim();

  function score(query, name) {
    const q = clean(query), n = clean(name);
    if (!q || !n) return 0;
    if (n === q) return 100;
    if (n.startsWith(q + " ") || n.startsWith(q)) return 85;
    if (n.split(" ").includes(q)) return 75;
    if (n.includes(q)) return 60;
    const qw = q.split(" "), nw = n.split(" ");
    const hit = qw.filter((w) => nw.some((x) => x.startsWith(w))).length;
    return hit ? Math.round((hit / qw.length) * 50) : 0;
  }

  async function find(name) {
    const apps = await load();
    const q = ALIASES[clean(name)] || name;
    const ranked = apps
      .map((a) => ({ a, s: Math.max(score(q, a.Name), score(name, a.Name)) }))
      .filter((x) => x.s > 0)
      // prefer real apps over uninstallers/help links
      .map((x) => ({ ...x, s: x.s - (/uninstall|readme|help|documentation|release notes/i.test(x.a.Name) ? 40 : 0) }))
      .sort((x, y) => y.s - x.s);
    return ranked;
  }

  async function launch(name) {
    const ranked = await find(name);
    const best = ranked[0];
    if (!best || best.s < 45) return { ok: false, suggestions: ranked.slice(0, 5).map((x) => x.a.Name) };
    const app = best.a;
    const [cmd, args] = app.run || ["explorer.exe", [`shell:AppsFolder\\${app.AppID}`]];
    await new Promise((resolve, reject) => {
      const child = exec(cmd, args, { windowsHide: true }, () => resolve()); // explorer.exe returns exit code 1 even on success
      if (child && child.on) child.on("error", reject);
      setTimeout(resolve, 1500);
    });
    return { ok: true, name: app.Name };
  }

  return { load, find, launch };
}

module.exports = { createApps };
