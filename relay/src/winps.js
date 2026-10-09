// Runs PowerShell scripts on Windows and reads back the JSON each one prints last.
// Inputs always go in through environment variables (RELAY_*), never pasted into the script,
// so names and messages can't break or inject into the script.
//
// Speed: starting PowerShell and compiling the C# helpers takes 1-2 s, so Relay keeps ONE PowerShell
// running in the background (the "host") and sends it scripts over stdin. The helpers compile once.
// Scripts end with Reply/Done (a JSON line, then throw 'RELAY_DONE'), never `exit`, which would end the host.
const { execFile, spawn: nodeSpawn } = require("child_process");

const encode = (script) => Buffer.from(script, "utf16le").toString("base64");

/** Shared C# helpers: window focus, key presses and the default speaker's volume (Core Audio). */
const NATIVE = String.raw`
if (-not ('RelayWin' -as [type])) {
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class RelayWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public static uint PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  // Bring a window to the front even when Windows' focus rules resist (borrow the current front window's input queue)
  public static bool ForceFocus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    IntPtr fg = GetForegroundWindow(); uint ignore;
    uint fgThread = GetWindowThreadProcessId(fg, out ignore), me = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
    Key(0x12); BringWindowToTop(h); SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fgThread, false);
    System.Threading.Thread.Sleep(200);
    return GetForegroundWindow() == h;
  }
  // Every visible WhatsApp window: titled "WhatsApp" or "(3) WhatsApp" (unread count), never a browser tab.
  // The new app has two: the outer frame (WhatsApp.Root) and the page inside it (msedgewebview2); the page comes first.
  public static IntPtr[] FindWhatsApp() {
    var page = new System.Collections.Generic.List<IntPtr>(); var frame = new System.Collections.Generic.List<IntPtr>();
    var re = new System.Text.RegularExpressions.Regex(@"^(\(\d+\)\s*)?WhatsApp( Beta)?$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new System.Text.StringBuilder(256); GetWindowText(h, sb, 256);
      if (!re.IsMatch(sb.ToString().Trim())) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      string name = "";
      try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName.ToLower(); } catch (Exception) { }
      if (name.Contains("webview")) page.Add(h); else frame.Add(h);
      return true;
    }, IntPtr.Zero);
    page.AddRange(frame);
    return page.ToArray();
  }
  public static void Click(int x, int y) { SetCursorPos(x, y); System.Threading.Thread.Sleep(60); mouse_event(2, 0, 0, 0, UIntPtr.Zero); mouse_event(4, 0, 0, 0, UIntPtr.Zero); }
  public static void Key(byte k) { keybd_event(k, 0, 0, UIntPtr.Zero); keybd_event(k, 0, 2, UIntPtr.Zero); }
  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    Key(0x12); // a tap of Alt lets Windows hand focus to another app
    SetForegroundWindow(h);
    System.Threading.Thread.Sleep(150);
    return GetForegroundWindow() == h;
  }
}
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int j();
  int GetMasterVolumeLevelScalar(out float level);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx);
  int GetMute(out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, int p, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }
public static class RelayAudio {
  static IAudioEndpointVolume Vol() {
    var en = new MMDeviceEnumeratorCom() as IMMDeviceEnumerator;
    IMMDevice dev; Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume v; var id = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref id, 23, 0, out v));
    return v;
  }
  public static float Get() { float x; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out x)); return x; }
  public static void Set(float x) { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(x, Guid.Empty)); }
  public static bool Muted() { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
  public static void Mute(bool m) { Marshal.ThrowExceptionForHR(Vol().SetMute(m, Guid.Empty)); }
}
"@
}
`;

// The background PowerShell: reads one JSON request per line ({ script: base64 UTF-8, env }), runs it,
// streams its output, then prints the end marker.
const END = "<<RELAY_END>>";
const HOST_PS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding = [Text.Encoding]::UTF8
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  try {
    $req = $line | ConvertFrom-Json
    Get-ChildItem env: | Where-Object { $_.Name -like 'RELAY_*' } | ForEach-Object { Remove-Item -LiteralPath ('env:' + $_.Name) }
    if ($req.env) { foreach ($p in $req.env.PSObject.Properties) { Set-Item -LiteralPath ('env:RELAY_' + $p.Name) -Value ([string]$p.Value) } }
    $code = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($req.script))
    & ([scriptblock]::Create($code)) | ForEach-Object { [Console]::Out.WriteLine([string]$_) }
  } catch {
    if ("$_" -ne 'RELAY_DONE') { [Console]::Out.WriteLine((@{ status = 'error'; error = "$_" } | ConvertTo-Json -Compress)) }
  }
  [Console]::Out.WriteLine('` + END + String.raw`')
  [Console]::Out.Flush()
}
`;

function lastJson(text) {
  const lines = String(text || "").trim().split(/\r?\n/).reverse();
  for (const l of lines) { try { const j = JSON.parse(l); if (j && typeof j === "object") return j; } catch {} }
  return null;
}

function createPs({ platform = process.platform, exec = execFile, spawn = nodeSpawn, exe = "powershell.exe", keepAlive = true } = {}) {
  let host = null;            // { proc, buf, current }
  const queue = [];
  let busy = false;
  let hostFailures = 0;       // background PowerShell died before ever answering: after 2, just use one-shot

  /** One-shot: start PowerShell just for this script (used if the background one can't start). */
  function runOnce(script, env, timeout) {
    const fullEnv = { ...process.env };
    for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== null) fullEnv[`RELAY_${k}`] = String(v);
    const prelude = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8\n";
    return new Promise((resolve) => {
      exec(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encode(prelude + script)],
        { windowsHide: true, timeout, env: fullEnv, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          const j = lastJson(stdout);
          if (j) return resolve(j);
          const msg = String(stderr || "").split(/\r?\n/).find((l) => l.trim() && !/RELAY_DONE/.test(l)) || (err && err.message) || "PowerShell didn't answer.";
          resolve({ status: "error", error: msg.trim() });
        });
    });
  }

  function startHost() {
    let proc;
    try { proc = spawn(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encode(HOST_PS)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { return null; }
    const h = { proc, buf: "", current: null, dead: false, answered: false };
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      h.buf += chunk;
      let i;
      while ((i = h.buf.indexOf(END)) >= 0) {
        const out = h.buf.slice(0, i);
        h.buf = h.buf.slice(i + END.length).replace(/^\r?\n/, "");
        const cur = h.current; h.current = null;
        h.answered = true;
        if (cur) cur.done(lastJson(out) || { status: "error", error: "PowerShell gave no answer." });
      }
    });
    proc.stderr.on("data", () => {});
    const die = () => {
      if (h.dead) return;
      h.dead = true;
      if (!h.answered) hostFailures++;
      if (host === h) host = null;
      if (h.current) { const cur = h.current; h.current = null; cur.done(null); } // null → retry one-shot
    };
    proc.on("exit", die); proc.on("error", die);
    proc.stdin.on("error", die);
    return h;
  }

  function viaHost(script, env, timeout) {
    if (hostFailures >= 2) return Promise.resolve(null);
    if (!host || host.dead) host = startHost();
    const h = host;
    if (!h) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { // a stuck script: end this PowerShell; the next call starts a fresh one
        if (h.current) { h.current = null; resolve({ status: "error", error: "PowerShell took too long." }); }
        try { h.proc.kill(); } catch {}
      }, timeout);
      h.current = { done: (r) => { clearTimeout(timer); resolve(r); } };
      const clean = {};
      for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== null) clean[k] = String(v);
      try { h.proc.stdin.write(JSON.stringify({ script: Buffer.from(script, "utf8").toString("base64"), env: clean }) + "\n"); }
      catch { h.current = null; clearTimeout(timer); resolve(null); }
    });
  }

  /** Runs `script` with `env` (keys without the RELAY_ prefix). Resolves to the parsed JSON, or { status: "error", error }. */
  function run(script, env = {}, { timeout = 30000 } = {}) {
    if (platform !== "win32" && exe === "powershell.exe") return Promise.resolve({ status: "error", error: "This only works on Windows." });
    return new Promise((resolve) => {
      queue.push(async () => {
        let r = keepAlive ? await viaHost(script, env, timeout) : null;
        if (r === null) r = await runOnce(script, env, timeout);
        resolve(r);
      });
      pump();
    });
  }
  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) { try { await queue.shift()(); } catch {} }
    busy = false;
  }

  /** Start the background PowerShell and compile the helpers now, so the first real command is fast. */
  function warm() { return run(NATIVE + "\n@{ status = 'ok' } | ConvertTo-Json -Compress", {}, { timeout: 60000 }); }
  function stop() { if (host) { try { host.proc.kill(); } catch {} host = null; } }

  return { run, warm, stop, platform };
}

module.exports = { createPs, NATIVE, HOST_PS };
