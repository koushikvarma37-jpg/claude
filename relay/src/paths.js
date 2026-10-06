// Turns what the user (or Gemini) says, like "Desktop/DSP notes" or "downloads",
// into a real absolute path, and blocks places Relay must never touch.
const path = require("path");

const ALIASES = {
  desktop: "desktop",
  downloads: "downloads", download: "downloads",
  documents: "documents", document: "documents", docs: "documents", "my documents": "documents",
  pictures: "pictures", photos: "pictures", images: "pictures",
  music: "music", songs: "music",
  videos: "videos", video: "videos",
  home: "home", "user folder": "home",
};

function createPaths(known, env = process.env) {
  const isWin = (p) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
  const p = isWinStyle(known.home) ? path.win32 : path.posix;

  const blocked = [
    env.SystemRoot || env.windir,
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.ProgramData,
    known.home && p.join(known.home, "AppData"),
    // POSIX system folders (used when testing on Linux/macOS)
    "/etc", "/usr", "/bin", "/sbin", "/var", "/System", "/Library",
  ].filter(Boolean).map((b) => norm(b));

  function norm(x) {
    const n = p.normalize(x);
    return p === path.win32 ? n.toLowerCase() : n;
  }

  /** Resolve a user-facing path to an absolute path. Throws with a helpful message if it can't. */
  function resolve(input) {
    if (!input || typeof input !== "string") throw new Error("No path given.");
    let s = input.trim().replace(/^["']|["']$/g, "");
    s = s.replace(/%([^%]+)%/g, (m, v) => env[v] || env[v.toUpperCase()] || m);
    if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = known.home + s.slice(1);
    if (p.isAbsolute(s) || isWin(s)) return p.resolve(s);

    const parts = s.split(/[\\/]+/).filter(Boolean);
    const first = (parts[0] || "").toLowerCase();
    const twoWords = parts[0] && parts[1] ? `${first} ${parts[1].toLowerCase()}` : null;
    let key = ALIASES[first];
    let rest = parts.slice(1);
    if (!key && twoWords && ALIASES[twoWords]) { key = ALIASES[twoWords]; rest = parts.slice(2); }
    if (key && known[key]) return p.join(known[key], ...rest);

    throw new Error(
      `"${input}" is not a full path. Start it with a known folder (Desktop, Downloads, Documents, Pictures, Music, Videos) ` +
      `or a full path like D:\\College, or use find_files to locate it first.`
    );
  }

  /** True if Relay is allowed to change things at this path. */
  function isAllowed(abs) {
    const n = norm(abs);
    const root = norm(p.parse(abs).root);
    if (n === root) return false; // never act on a whole drive
    return !blocked.some((b) => n === b || n.startsWith(b + p.sep));
  }

  function assertAllowed(abs) {
    if (!isAllowed(abs)) throw new Error(`For safety, Relay can't change ${abs}.`);
    return abs;
  }

  /** Short, friendly version of a path for the UI: "Desktop\DSP notes" instead of C:\Users\... */
  function pretty(abs) {
    const order = ["desktop", "downloads", "documents", "pictures", "music", "videos", "home"];
    for (const k of order) {
      const base = known[k];
      if (!base) continue;
      const rel = p.relative(base, abs);
      if (rel === "") return label(k);
      if (!rel.startsWith("..") && !p.isAbsolute(rel)) return k === "home" ? `~${p.sep}${rel}` : `${label(k)}${p.sep}${rel}`;
    }
    return abs;
  }
  const label = (k) => (k === "home" ? "~" : k[0].toUpperCase() + k.slice(1));

  return { resolve, isAllowed, assertAllowed, pretty, path: p, known };
}

function isWinStyle(x) {
  return typeof x === "string" && (/^[a-zA-Z]:[\\/]/.test(x) || x.startsWith("\\\\"));
}

module.exports = { createPaths };
