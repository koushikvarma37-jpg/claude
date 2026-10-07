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
