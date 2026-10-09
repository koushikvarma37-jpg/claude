// Controlling the PC itself: volume, music, brightness, Wi-Fi/Bluetooth, power, screenshots,
// battery and system info, and looking at the screen.
const fs = require("fs/promises");
const os = require("os");
const { NATIVE } = require("./winps");

const VOLUME_PS = NATIVE + String.raw`
$before = [math]::Round([RelayAudio]::Get() * 100)
if ($env:RELAY_LEVEL) { [RelayAudio]::Set([float]([math]::Max(0, [math]::Min(100, [int]$env:RELAY_LEVEL))) / 100); [RelayAudio]::Mute($false) }
elseif ($env:RELAY_CHANGE) { [RelayAudio]::Set([float]([math]::Max(0, [math]::Min(100, $before + [int]$env:RELAY_CHANGE))) / 100); [RelayAudio]::Mute($false) }
if ($env:RELAY_MUTE -eq 'on') { [RelayAudio]::Mute($true) } elseif ($env:RELAY_MUTE -eq 'off') { [RelayAudio]::Mute($false) } elseif ($env:RELAY_MUTE -eq 'toggle') { [RelayAudio]::Mute(-not [RelayAudio]::Muted()) }
@{ status = 'ok'; before = $before; level = [math]::Round([RelayAudio]::Get() * 100); muted = [RelayAudio]::Muted() } | ConvertTo-Json -Compress
`;

const MEDIA_PS = NATIVE + String.raw`
[RelayWin]::Key([byte][int]$env:RELAY_KEY)
@{ status = 'ok' } | ConvertTo-Json -Compress
`;

const BRIGHTNESS_PS = String.raw`
try { $cur = (Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness | Select-Object -First 1).CurrentBrightness }
catch { @{ status = 'unsupported' } | ConvertTo-Json -Compress; throw 'RELAY_DONE' }
if ($null -eq $cur) { @{ status = 'unsupported' } | ConvertTo-Json -Compress; throw 'RELAY_DONE' }
$target = $cur
if ($env:RELAY_LEVEL) { $target = [int]$env:RELAY_LEVEL } elseif ($env:RELAY_CHANGE) { $target = $cur + [int]$env:RELAY_CHANGE }
$target = [math]::Max(0, [math]::Min(100, $target))
Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = [byte]$target } | Out-Null
@{ status = 'ok'; before = $cur; level = $target } | ConvertTo-Json -Compress
`;

// Wi-Fi / Bluetooth on or off through Windows' radio API (the same switches as the quick settings panel)
const RADIO_PS = String.raw`
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + String.raw`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
[Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Radios.RadioAccessStatus,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Radios.RadioState,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus]) | Out-Null
$radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
$r = $radios | Where-Object { $_.Kind -eq $env:RELAY_KIND } | Select-Object -First 1
if (-not $r) { @{ status = 'missing' } | ConvertTo-Json -Compress; throw 'RELAY_DONE' }
$res = Await ($r.SetStateAsync($env:RELAY_STATE)) ([Windows.Devices.Radios.RadioAccessStatus])
@{ status = $(if ("$res" -eq 'Allowed') { 'ok' } else { 'denied' }); state = "$($r.State)" } | ConvertTo-Json -Compress
`;

const STATUS_PS = String.raw`
$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
$wifi = $null
try { $line = (netsh wlan show interfaces) | Where-Object { $_ -match '^\s+SSID\s+:' } | Select-Object -First 1; if ($line) { $wifi = ($line -split ':', 2)[1].Trim() } } catch {}
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { @{ drive = $_.DeviceID; free_gb = [math]::Round($_.FreeSpace / 1GB, 1); total_gb = [math]::Round($_.Size / 1GB, 1) } })
@{ status = 'ok'
   battery = $(if ($b) { @{ percent = $b.EstimatedChargeRemaining; charging = ($b.BatteryStatus -eq 2 -or $b.BatteryStatus -ge 6); minutes_left = $(if ($b.EstimatedRunTime -and $b.EstimatedRunTime -lt 71582) { $b.EstimatedRunTime } else { $null }) } } else { $null })
   wifi = $wifi; disks = $disks } | ConvertTo-Json -Compress -Depth 4
`;

// The window in front (after Relay hides): its title and app. For a browser the title is the selected tab's.
const ACTIVE_WINDOW_PS = String.raw`
if (-not ('RelayFg' -as [type])) {
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class RelayFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
"@
}
$h = [RelayFg]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[RelayFg]::GetWindowText($h, $sb, 512) | Out-Null
[uint32]$procId = 0
[RelayFg]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
$name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
@{ status = 'ok'; title = $sb.ToString(); app = $name } | ConvertTo-Json -Compress
`;

const SETTINGS_PAGES = {
  wifi: "ms-settings:network-wifi", network: "ms-settings:network-status", bluetooth: "ms-settings:bluetooth",
  display: "ms-settings:display", sound: "ms-settings:sound", battery: "ms-settings:batterysaver", power: "ms-settings:powersleep",
  updates: "ms-settings:windowsupdate", apps: "ms-settings:appsfeatures", storage: "ms-settings:storagesense",
  notifications: "ms-settings:notifications", wallpaper: "ms-settings:personalization-background", "night light": "ms-settings:nightlight",
  privacy: "ms-settings:privacy", microphone: "ms-settings:privacy-microphone", camera: "ms-settings:privacy-webcam",
  mouse: "ms-settings:mousetouchpad", keyboard: "ms-settings:keyboard", language: "ms-settings:regionlanguage", time: "ms-settings:dateandtime",
  printers: "ms-settings:printers", accounts: "ms-settings:yourinfo", vpn: "ms-settings:network-vpn", hotspot: "ms-settings:network-mobilehotspot",
  about: "ms-settings:about",
};

const MEDIA_KEYS = { play_pause: 0xb3, next: 0xb0, previous: 0xb1, stop: 0xb2 };

/** A screenshot as a Gemini image part (JPEG when captured that way, else PNG). */
const imagePart = (s) => (s.jpg ? { inlineData: { mimeType: "image/jpeg", data: s.jpg.toString("base64") } } : { inlineData: { mimeType: "image/png", data: s.png.toString("base64") } });

function stamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

function createSystemTools(ctx) {
  // ctx: { ps, exec, paths, openPath, openExternal, captureScreen, ask, now }
  const { ps, paths } = ctx;
  const P = paths.path;
  const fail = (r, what) => { throw new Error(r.error ? `Couldn't ${what}: ${r.error}` : `Couldn't ${what}.`); };
  const pct = (n) => Math.max(0, Math.min(100, Math.round(Number(n))));

  return {
    set_volume: {
      decl: {
        name: "set_volume",
        description: "Change the speaker volume or mute/unmute. Give `level` (0-100) to set it exactly, or `change` (e.g. +10 or -20) to turn it up or down. 'Volume up' means change +10.",
        parameters: { type: "OBJECT", properties: {
          level: { type: "INTEGER", description: "Exact volume 0-100." },
          change: { type: "INTEGER", description: "Relative change, e.g. 10 or -10." },
          mute: { type: "STRING", description: "'on', 'off' or 'toggle'." },
        } },
      },
      async run({ level, change, mute }) {
        if (level == null && change == null && !mute) throw new Error("Say what volume you want, e.g. 40%.");
        const r = await ps.run(VOLUME_PS, { LEVEL: level != null ? pct(level) : undefined, CHANGE: level == null && change != null ? Math.round(change) : undefined, MUTE: mute ? String(mute).toLowerCase() : undefined });
        if (r.status !== "ok") fail(r, "change the volume");
        if (r.muted) return { summary: "Muted the sound", level: r.level, muted: true };
        return { summary: mute === "off" && level == null && change == null ? `Unmuted. Volume is ${r.level}%` : `Volume set to ${r.level}%`, level: r.level, muted: false };
      },
    },

    media_control: {
      decl: {
        name: "media_control",
        description: "Control whatever music or video is playing (Spotify, YouTube in the browser, etc.): play/pause, next, previous, stop.",
        parameters: { type: "OBJECT", properties: { action: { type: "STRING", description: "'play_pause', 'next', 'previous' or 'stop'." } }, required: ["action"] },
      },
      async run({ action }) {
        const a = String(action || "").toLowerCase().replace(/[\s-]+/g, "_").replace(/^(play|pause|resume)$/, "play_pause").replace(/^(skip|next_song|next_track)$/, "next").replace(/^(prev|previous_song|back)$/, "previous");
        const key = MEDIA_KEYS[a];
        if (!key) throw new Error(`I can play/pause, skip to the next or previous track, or stop. "${action}" isn't one of those.`);
        const r = await ps.run(MEDIA_PS, { KEY: key });
        if (r.status !== "ok") fail(r, "control the music");
        return { summary: { play_pause: "Pressed play/pause", next: "Skipped to the next track", previous: "Went back to the previous track", stop: "Stopped playback" }[a] };
      },
    },

    set_brightness: {
      decl: {
        name: "set_brightness",
        description: "Change the laptop screen brightness. Give `level` (0-100) or `change` (e.g. +20 / -20). Works on built-in laptop screens, not most external monitors.",
        parameters: { type: "OBJECT", properties: {
          level: { type: "INTEGER", description: "Exact brightness 0-100." },
          change: { type: "INTEGER", description: "Relative change, e.g. 20 or -20." },
        } },
      },
      async run({ level, change }) {
        if (level == null && change == null) throw new Error("Say what brightness you want, e.g. 70%.");
        const r = await ps.run(BRIGHTNESS_PS, { LEVEL: level != null ? pct(level) : undefined, CHANGE: level == null ? Math.round(change) : undefined });
        if (r.status === "unsupported") return { summary: "This screen doesn't let apps change its brightness", error: "unsupported", tip: "External monitors usually need their own buttons." };
        if (r.status !== "ok") fail(r, "change the brightness");
        return { summary: `Brightness set to ${r.level}%`, level: r.level };
      },
    },

    set_radio: {
      decl: {
        name: "set_radio",
        description: "Turn Wi-Fi or Bluetooth on or off.",
        parameters: { type: "OBJECT", properties: {
          radio: { type: "STRING", description: "'wifi' or 'bluetooth'." },
          on: { type: "BOOLEAN", description: "true to turn on, false to turn off." },
        }, required: ["radio", "on"] },
      },
      async run({ radio, on }) {
        const isBt = /blue/i.test(radio);
        const label = isBt ? "Bluetooth" : "Wi-Fi";
        const r = await ps.run(RADIO_PS, { KIND: isBt ? "Bluetooth" : "WiFi", STATE: on ? "On" : "Off" });
        if (r.status === "ok") return { summary: `Turned ${label} ${on ? "on" : "off"}`, note: !isBt && !on ? "Relay needs the internet for most commands, so it may not be able to reply until Wi-Fi is back on." : undefined };
        await ctx.openExternal(SETTINGS_PAGES[isBt ? "bluetooth" : "wifi"]);
        return { summary: r.status === "missing" ? `This PC has no ${label} adapter` : `Windows didn't let Relay switch ${label}, so I opened ${label} settings`, error: r.status };
      },
    },

    power_action: {
      confirm: (args) => !["lock", "cancel"].includes(String(args.action || "").toLowerCase()),
      decl: {
        name: "power_action",
        description: "Lock the PC, put it to sleep, sign out, shut down or restart (now or after some minutes), or cancel a scheduled shutdown/restart. Shut down, restart, sleep and sign out ask the user first automatically.",
        parameters: { type: "OBJECT", properties: {
          action: { type: "STRING", description: "'lock', 'sleep', 'sign_out', 'shutdown', 'restart' or 'cancel'." },
          minutes: { type: "INTEGER", description: "Optional delay in minutes for shutdown or restart." },
        }, required: ["action"] },
      },
      async plan({ action, minutes }) {
        const a = String(action || "").toLowerCase();
        const later = minutes > 0 ? ` in ${minutes} minute${minutes > 1 ? "s" : ""}` : " now";
        const titles = { shutdown: `Shut down the PC${later}?`, restart: `Restart the PC${later}?`, sleep: "Put the PC to sleep?", sign_out: "Sign out of Windows?" };
        if (!titles[a]) throw new Error(`Unknown power action "${action}".`);
        const lines = a === "shutdown" || a === "restart" ? [minutes > 0 ? "You can cancel it by saying \"cancel the shutdown\"." : "Save your work first. Open apps will be closed."] : a === "sign_out" ? ["Open apps will be closed."] : [];
        return { title: titles[a], lines, danger: a !== "sleep", okLabel: { shutdown: "Shut down", restart: "Restart", sleep: "Sleep", sign_out: "Sign out" }[a] };
      },
      async run({ action, minutes }) {
        const a = String(action || "").toLowerCase();
        const secs = String(Math.max(0, Math.round((minutes || 0) * 60)));
        const sh = (args) => new Promise((resolve, reject) => ctx.exec(args[0], args.slice(1), { windowsHide: true }, (err, _o, stderr) => (err ? reject(Object.assign(new Error(String(stderr || err.message).trim()), { notScheduled: /1116/.test(String(stderr) + err.message) })) : resolve())));
        if (a === "lock") { await sh(["rundll32.exe", "user32.dll,LockWorkStation"]); return { summary: "Locked the PC" }; }
        if (a === "cancel") {
          try { await sh(["shutdown.exe", "/a"]); return { summary: "Cancelled the scheduled shutdown" }; }
          catch (e) { if (e.notScheduled) return { summary: "There was no shutdown or restart scheduled" }; throw e; }
        }
        if (a === "shutdown") { await sh(["shutdown.exe", "/s", "/t", secs]); return { summary: minutes > 0 ? `The PC will shut down in ${minutes} minute${minutes > 1 ? "s" : ""}` : "Shutting down" }; }
        if (a === "restart") { await sh(["shutdown.exe", "/r", "/t", secs]); return { summary: minutes > 0 ? `The PC will restart in ${minutes} minute${minutes > 1 ? "s" : ""}` : "Restarting" }; }
        if (a === "sign_out") { await sh(["shutdown.exe", "/l"]); return { summary: "Signing out" }; }
        if (a === "sleep") {
          setTimeout(() => ps.run("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false) | Out-Null; '{}'"), 1500); // after the reply is shown
          return { summary: "Going to sleep" };
        }
        throw new Error(`Unknown power action "${action}".`);
      },
    },

    open_settings: {
      decl: {
        name: "open_settings",
        description: `Open a Windows Settings page. Pages: ${Object.keys(SETTINGS_PAGES).join(", ")}.`,
        parameters: { type: "OBJECT", properties: { page: { type: "STRING", description: "Which page, e.g. 'bluetooth' or 'display'." } }, required: ["page"] },
      },
      async run({ page }) {
        const key = String(page || "").toLowerCase().replace(/[-_]/g, " ").replace(/\bwi ?fi\b/, "wifi").replace(/\s*settings?$/, "").trim();
        const uri = SETTINGS_PAGES[key] || "ms-settings:";
        await ctx.openExternal(uri);
        return { summary: SETTINGS_PAGES[key] ? `Opened ${key} settings` : "Opened Settings" };
      },
    },

    system_status: {
      decl: {
        name: "system_status",
        description: "Get the battery level and charging state, Wi-Fi network, free disk space, memory use and how long the PC has been on.",
        parameters: { type: "OBJECT", properties: {} },
      },
      async run() {
        const r = await ps.run(STATUS_PS);
        const total = os.totalmem(), free = os.freemem();
        const info = {
          battery: r.battery || null, wifi: r.wifi || null, disks: r.disks || [],
          memory: { used_gb: +((total - free) / 1073741824).toFixed(1), total_gb: +(total / 1073741824).toFixed(1) },
          uptime_hours: +(os.uptime() / 3600).toFixed(1),
        };
        const b = info.battery;
        return { summary: b ? `Battery ${b.percent}%${b.charging ? ", charging" : ""}` : "Checked the system", ...info };
      },
    },

    take_screenshot: {
      decl: {
        name: "take_screenshot",
        description: "Take a screenshot of the whole screen (Relay hides itself first) and save it in Pictures\\Screenshots.",
        parameters: { type: "OBJECT", properties: { open: { type: "BOOLEAN", description: "Open the screenshot afterwards." } } },
      },
      async run({ open }) {
        const shots = await ctx.captureScreen({ hideRelay: true });
        if (!shots.length) throw new Error("Couldn't capture the screen.");
        const dir = P.join(paths.known.pictures, "Screenshots");
        await fs.mkdir(dir, { recursive: true });
        const name = `Relay ${stamp(ctx.now ? ctx.now() : new Date())}`;
        const saved = [];
        for (let i = 0; i < shots.length; i++) {
          const file = P.join(dir, `${name}${shots.length > 1 ? ` (screen ${i + 1})` : ""}.png`);
          await fs.writeFile(file, shots[i].png);
          saved.push(file);
        }
        if (open) await ctx.openPath(saved[0]);
        return { summary: `Saved a screenshot to ${paths.pretty(saved[0])}`, path: saved[0] };
      },
    },

    look_at_screen: {
      decl: {
        name: "look_at_screen",
        description: "Look at what's on the user's screen right now (Relay hides itself first) and answer a question about it: explain an error, read text, describe a window, summarise a page. Only use this when the user asks about their screen.",
        parameters: { type: "OBJECT", properties: { question: { type: "STRING", description: "What to find out, e.g. 'explain the error message' or 'what is this page about'." } }, required: ["question"] },
      },
      async run({ question }) {
        const shots = await ctx.captureScreen({ hideRelay: true, maxWidth: 1600, activeWindow: true, format: "jpeg", quality: 82 });
        if (!shots.length) throw new Error("Couldn't capture the screen.");
        const active = shots.active && shots.active.title ? shots.active : null;
        const parts = shots.map(imagePart);
        parts.push({ text: `This is a screenshot of the user's Windows screen${shots.length > 1 ? "s" : ""}.` +
          (active ? `\nThe window in front is "${active.title}"${active.app ? ` (app: ${active.app})` : ""}. Words like "this", "my tab", "this page", "this error" mean that window. In a browser, only the SELECTED tab's page is what the user is looking at: describe that page's content, and don't report the titles of other tabs in the tab bar unless asked.` : "\nFocus on the window in front.") +
          `\nThe user asked: ${question}\nAnswer directly and concisely, as if you were looking over their shoulder. Quote exact text (error messages, names, numbers) when it matters.` });
        const answer = await ctx.ask(parts);
        const shortTitle = active ? active.title.replace(/\s+[-–—]\s+(Google Chrome|Microsoft\u200b? Edge|Mozilla Firefox|Brave|Opera)$/i, "").slice(0, 70) : "";
        return { summary: shortTitle ? `Looked at "${shortTitle}"` : "Looked at your screen", window: active ? active.title : null, answer };
      },
    },
  };
}

module.exports = { imagePart, createSystemTools, SETTINGS_PAGES, MEDIA_KEYS, SCRIPTS: { VOLUME_PS, MEDIA_PS, BRIGHTNESS_PS, RADIO_PS, STATUS_PS, ACTIVE_WINDOW_PS }, ACTIVE_WINDOW_PS };
