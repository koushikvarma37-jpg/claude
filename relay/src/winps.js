// Runs a PowerShell script on Windows and reads back the JSON it prints last.
// Inputs always go in through environment variables (RELAY_*), never pasted into the script,
// so names and messages can't break or inject into the script.
const { execFile } = require("child_process");

const encode = (script) => Buffer.from(script, "utf16le").toString("base64");

/** Shared C# helpers: window focus, key presses and the default speaker's volume (Core Audio). */
const NATIVE = String.raw`
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
  // A visible top-level window whose title is exactly this (e.g. "WhatsApp"); works for Store apps hosted by other processes
  public static IntPtr FindTitled(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new System.Text.StringBuilder(256); GetWindowText(h, sb, 256);
      if (string.Equals(sb.ToString().Trim(), title, StringComparison.OrdinalIgnoreCase)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
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
`;

function createPs({ platform = process.platform, exec = execFile } = {}) {
  /** Runs `script` with `env` (keys without the RELAY_ prefix). Resolves to the parsed JSON, or { status: "error", error }. */
  function run(script, env = {}, { timeout = 30000 } = {}) {
    if (platform !== "win32") return Promise.resolve({ status: "error", error: "This only works on Windows." });
    const fullEnv = { ...process.env };
    for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== null) fullEnv[`RELAY_${k}`] = String(v);
    const prelude = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8\n";
    return new Promise((resolve) => {
      exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encode(prelude + script)],
        { windowsHide: true, timeout, env: fullEnv, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          const last = String(stdout || "").trim().split(/\r?\n/).pop();
          try { return resolve(JSON.parse(last)); } catch {}
          const msg = String(stderr || "").split(/\r?\n/).find((l) => l.trim()) || (err && err.message) || "PowerShell didn't answer.";
          resolve({ status: "error", error: msg.trim() });
        });
    });
  }
  return { run, platform };
}

module.exports = { createPs, NATIVE };
