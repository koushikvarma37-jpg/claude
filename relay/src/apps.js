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

// Apps that are always present: opened by URI or exe name, no window check needed
const BUILTIN = [
  { Name: "File Explorer", uri: "explorer.exe" },
  { Name: "Settings", uri: "ms-settings:" },
  { Name: "Notepad", uri: "notepad.exe" },
  { Name: "Calculator", uri: "calculator:" },
  { Name: "Command Prompt", uri: "cmd.exe" },
  { Name: "Task Manager", uri: "taskmgr.exe" },
];

// Starts the app, then waits up to 8 s for its window, restores it if minimized and brings it to the front.
// Inputs come in through environment variables so no app name is ever pasted into the script itself.
const LAUNCH_PS = String.raw`
$ErrorActionPreference = 'Stop'
try {
  if ($env:RELAY_URI) { Start-Process $env:RELAY_URI } else { Start-Process ('shell:AppsFolder\' + $env:RELAY_APPID) }
} catch { @{ status = 'launch_failed'; error = $_.Exception.Message } | ConvertTo-Json -Compress; exit }
if ($env:RELAY_NOVERIFY) { @{ status = 'window' } | ConvertTo-Json -Compress; exit }
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class RelayWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
}
"@
$patterns = $env:RELAY_MATCH.Split('|') | Where-Object { $_ }
function Test-Match($p) { foreach ($m in $patterns) { if ($p.ProcessName -like "*$m*" -or $p.MainWindowTitle -like "*$m*") { return $true } }; return $false }
$deadline = (Get-Date).AddSeconds(8)
$proc = $null
while ((Get-Date) -lt $deadline) {
  $proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Id -ne $PID -and (Test-Match $_) } | Select-Object -First 1
  if ($proc) { break }
  Start-Sleep -Milliseconds 350
}
if ($proc) {
  $h = $proc.MainWindowHandle
  if ([RelayWin]::IsIconic($h)) { [RelayWin]::ShowWindow($h, 9) | Out-Null }
  [RelayWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [RelayWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [RelayWin]::SetForegroundWindow($h) | Out-Null
  @{ status = 'window'; title = $proc.MainWindowTitle } | ConvertTo-Json -Compress
} elseif (@(Get-Process | Where-Object { Test-Match $_ }).Count) {
  @{ status = 'no_window' } | ConvertTo-Json -Compress
} else {
  @{ status = 'not_running' } | ConvertTo-Json -Compress
}
`;
const LAUNCH_PS_B64 = Buffer.from(LAUNCH_PS, "utf16le").toString("base64");

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

  /** Words to recognise the app's process or window title by, e.g. "Visual Studio Code" → visual studio code|visual */
  function matchPatterns(app) {
    const words = clean(app.Name).split(" ").filter((w) => w.length >= 3 && !["the", "app", "for", "microsoft", "desktop"].includes(w));
    const set = new Set([app.Name, ...words.slice(0, 2)]);
    if (/visual studio code/i.test(app.Name)) set.add("Code");
    return [...set].join("|");
  }

  async function launch(name) {
    const ranked = await find(name);
    const best = ranked[0];
    if (!best || best.s < 45) return { ok: false, reason: "not_found", suggestions: ranked.slice(0, 5).map((x) => x.a.Name) };
    const app = best.a;
    const env = { ...process.env, RELAY_MATCH: matchPatterns(app) };
    if (app.uri) { env.RELAY_URI = app.uri; env.RELAY_NOVERIFY = "1"; } else env.RELAY_APPID = app.AppID;

    const out = await new Promise((resolve) => {
      exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", LAUNCH_PS_B64],
        { windowsHide: true, timeout: 20000, env }, (err, stdout) => {
          try { resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).pop())); }
          catch { resolve({ status: "unknown", error: err ? err.message : "" }); }
        });
    });

    if (out.status === "window") return { ok: true, name: app.Name };
    if (out.status === "no_window") return { ok: true, name: app.Name, warning: `${app.Name} is running, but its window didn't appear. It may be in the system tray (the ^ arrow near the clock).` };
    if (out.status === "launch_failed") return { ok: false, reason: "failed", error: `Windows couldn't start ${app.Name}: ${out.error}` };
    if (out.status === "not_running") return { ok: false, reason: "failed", error: `Windows didn't start ${app.Name}. Try opening it once from the Start menu, then ask again.` };
    return { ok: false, reason: "failed", error: `Couldn't confirm that ${app.Name} opened.` };
  }

  return { load, find, launch };
}

module.exports = { createApps };
