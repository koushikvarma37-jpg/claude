// Relay's tools. Gemini decides which tool to call and with which arguments;
// this file does the real work on the computer, safely.
//
// Each tool has:
//   decl     – the description Gemini sees (name, what it does, parameters)
//   confirm  – true if the user must approve before it runs
//   plan()   – (confirm tools only) works out exactly what will happen, without changing anything
//   run()    – does it and returns a result object for Gemini (always with a short `summary`)
const fs = require("fs/promises");
const fssync = require("fs");

const CATEGORIES = {
  Images: ["jpg", "jpeg", "png", "gif", "bmp", "webp", "heic", "svg", "tif", "tiff", "ico", "raw"],
  PDFs: ["pdf"],
  Documents: ["doc", "docx", "txt", "rtf", "odt", "ppt", "pptx", "xls", "xlsx", "csv", "md", "odp", "ods"],
  Videos: ["mp4", "mkv", "avi", "mov", "wmv", "webm", "flv", "m4v", "3gp"],
  Audio: ["mp3", "wav", "aac", "flac", "ogg", "m4a", "wma", "opus"],
  Archives: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso"],
  Installers: ["exe", "msi", "msix", "appx", "apk"],
  Code: ["py", "js", "ts", "html", "css", "java", "c", "cpp", "h", "json", "ipynb", "m", "v", "sv", "vhd", "ino", "sh", "bat"],
};
const SKIP_DIRS = new Set(["node_modules", ".git", "appdata", "$recycle.bin", "__pycache__", ".venv", "venv", "windows", "program files", "program files (x86)", "programdata"]);

function createTools(ctx) {
  // ctx: { paths, openPath, openExternal, trash, apps, now }
  const { paths } = ctx;
  const P = paths.path;
  const undoStack = [];

  const ext = (name) => { const e = P.extname(name).slice(1).toLowerCase(); return e; };
  const categoryOf = (name) => {
    const e = ext(name);
    for (const [cat, list] of Object.entries(CATEGORIES)) if (list.includes(e)) return cat;
    return "Others";
  };
  const exists = (p) => fs.access(p).then(() => true, () => false);
  const normExts = (list) => (list || []).map((e) => String(e).toLowerCase().replace(/^\*?\./, "")).filter(Boolean);
  const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;

  async function uniqueTarget(dir, name) {
    let target = P.join(dir, name);
    if (!(await exists(target))) return target;
    const e = P.extname(name), base = P.basename(name, e);
    for (let i = 1; i < 1000; i++) {
      target = P.join(dir, `${base} (${i})${e}`);
      if (!(await exists(target))) return target;
    }
    throw new Error(`Too many files named ${name} in ${paths.pretty(dir)}.`);
  }

  async function moveOne(from, toDir) {
    const to = await uniqueTarget(toDir, P.basename(from));
    try {
      await fs.rename(from, to);
    } catch (err) {
      if (err.code !== "EXDEV") throw err; // different drive: copy, then remove
      await fs.cp(from, to, { recursive: true, errorOnExist: true });
      await fs.rm(from, { recursive: true });
    }
    return to;
  }

  async function ensureDir(dir) {
    if (await exists(dir)) {
      const st = await fs.stat(dir);
      if (!st.isDirectory()) throw new Error(`${paths.pretty(dir)} is a file, not a folder.`);
      return false;
    }
    await fs.mkdir(dir, { recursive: true });
    return true;
  }

  async function filesIn(folder, { extensions, nameContains } = {}) {
    const exts = normExts(extensions);
    const needle = (nameContains || "").toLowerCase();
    const entries = await fs.readdir(folder, { withFileTypes: true });
    return entries
      .filter((d) => d.isFile() && !d.name.startsWith("~$") && d.name.toLowerCase() !== "desktop.ini")
      .filter((d) => !exts.length || exts.includes(ext(d.name)))
      .filter((d) => !needle || d.name.toLowerCase().includes(needle))
      .map((d) => P.join(folder, d.name));
  }

  const preview = (list, max = 8) => {
    const names = list.map((x) => (typeof x === "string" ? P.basename(x) : x));
    return names.length > max ? [...names.slice(0, max), `…and ${names.length - max} more`] : names;
  };

  // ---------- Move planning shared by move_files ----------
  async function planMove(args) {
    const dest = paths.assertAllowed(paths.resolve(args.destination));
    let sources = [];
    if (args.paths && args.paths.length) {
      sources = args.paths.map((s) => paths.resolve(s));
    } else if (args.from_folder) {
      const folder = paths.resolve(args.from_folder);
      if (!(await exists(folder))) throw new Error(`Folder not found: ${paths.pretty(folder)}`);
      sources = await filesIn(folder, { extensions: args.extensions, nameContains: args.name_contains });
    } else {
      throw new Error("Give either `paths` or `from_folder`.");
    }
    sources.forEach((s) => paths.assertAllowed(s));
    for (const s of sources) if (!(await exists(s))) throw new Error(`Not found: ${paths.pretty(s)}`);
    sources = sources.filter((s) => P.dirname(s) !== dest && s !== dest && !dest.startsWith(s + P.sep));
    return { dest, sources };
  }

  // ---------- Tools ----------
  const tools = {
    list_folder: {
      decl: {
        name: "list_folder",
        description: "List the files and folders inside a folder. Use it to see what's there before acting.",
        parameters: { type: "OBJECT", properties: {
          path: { type: "STRING", description: "Folder path, e.g. 'Downloads', 'Desktop/College' or 'D:\\Projects'." },
        }, required: ["path"] },
      },
      async run({ path }) {
        const dir = paths.resolve(path);
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const items = [];
        for (const d of entries.slice(0, 400)) {
          if (d.name.toLowerCase() === "desktop.ini") continue;
          const full = P.join(dir, d.name);
          let size = null, modified = null;
          try { const st = await fs.stat(full); size = d.isFile() ? fmtSize(st.size) : null; modified = st.mtime.toISOString().slice(0, 10); } catch {}
          items.push({ name: d.name, type: d.isDirectory() ? "folder" : "file", size, modified });
        }
        items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1));
        const files = items.filter((i) => i.type === "file").length;
        return { summary: `${paths.pretty(dir)}: ${items.length - files} folders, ${files} files`, folder: paths.pretty(dir), items: items.slice(0, 120), truncated: items.length > 120 };
      },
    },

    find_files: {
      decl: {
        name: "find_files",
        description: "Search for files or folders by name (all words must appear in the name). Searches Desktop, Documents, Downloads, Pictures, Videos and Music unless a folder is given. Use this whenever the user refers to a file or folder without giving its exact location.",
        parameters: { type: "OBJECT", properties: {
          query: { type: "STRING", description: "Words from the name, e.g. 'resume' or 'dsp notes'. Can be empty if extensions are given." },
          folder: { type: "STRING", description: "Optional folder to search in." },
          extensions: { type: "ARRAY", items: { type: "STRING" }, description: "Optional file types, e.g. ['pdf','docx']." },
          folders_only: { type: "BOOLEAN", description: "Only return folders." },
        }, required: ["query"] },
      },
      async run({ query, folder, extensions, folders_only }) {
        const k = paths.known;
        const roots = folder ? [paths.resolve(folder)] : [k.desktop, k.documents, k.downloads, k.pictures, k.videos, k.music].filter(Boolean);
        const words = String(query || "").toLowerCase().split(/[\s_\-.]+/).filter(Boolean);
        const exts = normExts(extensions);
        const results = [];
        const seen = new Set();
        let scanned = 0;
        const deadline = Date.now() + 5000;
        const queue = roots.filter((r) => fssync.existsSync(r)).map((r) => [r, 0]);
        while (queue.length && results.length < 40 && scanned < 30000 && Date.now() < deadline) {
          const [dir, depth] = queue.shift();
          if (seen.has(dir)) continue;
          seen.add(dir);
          let entries;
          try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
          for (const d of entries) {
            scanned++;
            const full = P.join(dir, d.name);
            const lower = d.name.toLowerCase();
            const isDir = d.isDirectory();
            const match = words.every((w) => lower.includes(w)) && (!exts.length || exts.includes(ext(d.name))) && (!folders_only || isDir);
            if (match && (words.length || exts.length)) results.push(full);
            if (isDir && depth < 6 && !lower.startsWith(".") && !SKIP_DIRS.has(lower)) queue.push([full, depth + 1]);
          }
        }
        const detailed = [];
        for (const r of results.slice(0, 25)) {
          try {
            const st = await fs.stat(r);
            detailed.push({ path: r, shown_as: paths.pretty(r), type: st.isDirectory() ? "folder" : "file", modified: st.mtime.toISOString().slice(0, 10), size: st.isDirectory() ? null : fmtSize(st.size) });
          } catch {}
        }
        detailed.sort((a, b) => b.modified.localeCompare(a.modified));
        return { summary: detailed.length ? `Found ${detailed.length} match${detailed.length > 1 ? "es" : ""} for "${query || exts.join(", ")}"` : `Nothing found for "${query}"`, results: detailed };
      },
    },

    create_folder: {
      decl: {
        name: "create_folder",
        description: "Create a new folder (and any missing parent folders).",
        parameters: { type: "OBJECT", properties: {
          path: { type: "STRING", description: "Full path of the new folder, e.g. 'Desktop/DSP notes'." },
        }, required: ["path"] },
      },
      async run({ path }) {
        const dir = paths.assertAllowed(paths.resolve(path));
        const created = await ensureDir(dir);
        if (created) undoStack.push({ kind: "create", path: dir, label: `Created ${paths.pretty(dir)}` });
        return { summary: created ? `Created ${paths.pretty(dir)}` : `${paths.pretty(dir)} already exists`, path: dir, undoable: created };
      },
    },

    move_files: {
      confirm: true,
      decl: {
        name: "move_files",
        description: "Move files or folders into a destination folder (created if missing). Either give exact `paths`, or give `from_folder` with optional filters to move matching files from that folder (top level only).",
        parameters: { type: "OBJECT", properties: {
          paths: { type: "ARRAY", items: { type: "STRING" }, description: "Exact paths of files/folders to move." },
          from_folder: { type: "STRING", description: "Folder to take files from, e.g. 'Downloads'." },
          extensions: { type: "ARRAY", items: { type: "STRING" }, description: "Only files of these types, e.g. ['pdf']." },
          name_contains: { type: "STRING", description: "Only files whose name contains this text." },
          destination: { type: "STRING", description: "Destination folder, e.g. 'Documents/College'." },
        }, required: ["destination"] },
      },
      async plan(args) {
        const { dest, sources } = await planMove(args);
        if (!sources.length) return { empty: true, title: "No matching files to move", lines: [] };
        return { title: `Move ${sources.length} item${sources.length > 1 ? "s" : ""} to ${paths.pretty(dest)}?`, lines: preview(sources), count: sources.length };
      },
      async run(args) {
        const { dest, sources } = await planMove(args);
        if (!sources.length) return { summary: "No matching files to move", moved: 0 };
        const createdDir = await ensureDir(paths.assertAllowed(dest));
        const moves = [], failed = [];
        for (const s of sources) {
          try { moves.push({ from: s, to: await moveOne(s, dest) }); }
          catch (e) { failed.push({ file: P.basename(s), error: e.code === "EBUSY" || e.code === "EPERM" ? "file is open or locked" : e.message }); }
        }
        if (moves.length) undoStack.push({ kind: "moves", moves, createdDirs: createdDir ? [dest] : [], label: `Moved ${moves.length} to ${paths.pretty(dest)}` });
        return { summary: `Moved ${moves.length} item${moves.length === 1 ? "" : "s"} to ${paths.pretty(dest)}${failed.length ? `, ${failed.length} failed` : ""}`, moved: moves.length, destination: dest, failed, undoable: moves.length > 0 };
      },
    },

    organize_folder: {
      confirm: true,
      decl: {
        name: "organize_folder",
        description: "Tidy a folder by sorting its loose files into sub-folders by type: Images, PDFs, Documents, Videos, Audio, Archives, Installers, Code, Others.",
        parameters: { type: "OBJECT", properties: {
          path: { type: "STRING", description: "Folder to organize, e.g. 'Downloads'." },
        }, required: ["path"] },
      },
      async plan({ path }) {
        const dir = paths.assertAllowed(paths.resolve(path));
        const files = await filesIn(dir);
        const groups = {};
        for (const f of files) (groups[categoryOf(P.basename(f))] ||= []).push(f);
        const lines = Object.entries(groups).sort((a, b) => b[1].length - a[1].length).map(([c, l]) => `${c}  ·  ${l.length} file${l.length > 1 ? "s" : ""}`);
        if (!files.length) return { empty: true, title: `${paths.pretty(dir)} has no loose files to organize`, lines: [] };
        return { title: `Sort ${files.length} files in ${paths.pretty(dir)} into folders?`, lines, count: files.length };
      },
      async run({ path }) {
        const dir = paths.assertAllowed(paths.resolve(path));
        const files = await filesIn(dir);
        const moves = [], createdDirs = [], failed = [], counts = {};
        for (const f of files) {
          const cat = categoryOf(P.basename(f));
          const sub = P.join(dir, cat);
          if (await ensureDir(sub)) createdDirs.push(sub);
          try { moves.push({ from: f, to: await moveOne(f, sub) }); counts[cat] = (counts[cat] || 0) + 1; }
          catch (e) { failed.push({ file: P.basename(f), error: e.code === "EBUSY" || e.code === "EPERM" ? "file is open or locked" : e.message }); }
        }
        if (moves.length) undoStack.push({ kind: "moves", moves, createdDirs, label: `Organized ${paths.pretty(dir)}` });
        return { summary: `Sorted ${moves.length} files in ${paths.pretty(dir)}${failed.length ? `, ${failed.length} skipped` : ""}`, counts, failed, undoable: moves.length > 0 };
      },
    },

    rename_item: {
      confirm: true,
      decl: {
        name: "rename_item",
        description: "Rename a file or folder. If the new name has no extension, the original extension is kept.",
        parameters: { type: "OBJECT", properties: {
          path: { type: "STRING", description: "Current full path of the file or folder." },
          new_name: { type: "STRING", description: "New name only (not a path), e.g. 'final report.pdf'." },
        }, required: ["path", "new_name"] },
      },
      async plan({ path, new_name }) {
        const { from, to } = await planRename(path, new_name);
        return { title: `Rename ${P.basename(from)} to ${P.basename(to)}?`, lines: [`in ${paths.pretty(P.dirname(from))}`], count: 1 };
      },
      async run({ path, new_name }) {
        const { from, to } = await planRename(path, new_name);
        await fs.rename(from, to);
        undoStack.push({ kind: "rename", from, to, label: `Renamed to ${P.basename(to)}` });
        return { summary: `Renamed to ${P.basename(to)}`, path: to, undoable: true };
      },
    },

    delete_items: {
      confirm: true,
      decl: {
        name: "delete_items",
        description: "Move files or folders to the Recycle Bin (never deletes permanently). Always confirm the exact paths with find_files or list_folder first.",
        parameters: { type: "OBJECT", properties: {
          paths: { type: "ARRAY", items: { type: "STRING" }, description: "Exact paths to send to the Recycle Bin." },
        }, required: ["paths"] },
      },
      async plan({ paths: list }) {
        const abs = await checkExisting(list);
        return { title: `Send ${abs.length} item${abs.length > 1 ? "s" : ""} to the Recycle Bin?`, lines: preview(abs), count: abs.length, danger: true };
      },
      async run({ paths: list }) {
        const abs = await checkExisting(list);
        for (const a of abs) await ctx.trash(a);
        return { summary: `Moved ${abs.length} item${abs.length > 1 ? "s" : ""} to the Recycle Bin`, note: "Can be restored from the Recycle Bin." };
      },
    },

    open_path: {
      decl: {
        name: "open_path",
        description: "Open a file with its default app, or open a folder in File Explorer.",
        parameters: { type: "OBJECT", properties: { path: { type: "STRING", description: "Full path to open." } }, required: ["path"] },
      },
      async run({ path }) {
        const abs = paths.resolve(path);
        if (!(await exists(abs))) throw new Error(`Not found: ${paths.pretty(abs)}`);
        const err = await ctx.openPath(abs);
        if (err) throw new Error(err);
        return { summary: `Opened ${paths.pretty(abs)}` };
      },
    },

    open_app: {
      decl: {
        name: "open_app",
        description: "Open an installed Windows app by name, e.g. 'WhatsApp', 'Chrome', 'VS Code', 'Spotify', 'Calculator', 'Settings'. If the app isn't installed, the result lists close matches.",
        parameters: { type: "OBJECT", properties: { name: { type: "STRING", description: "App name." } }, required: ["name"] },
      },
      async run({ name }) {
        const r = await ctx.apps.launch(name);
        if (!r.ok && r.reason === "not_found") return { summary: `Couldn't find an app called "${name}"`, error: "not_installed", close_matches: r.suggestions || [] };
        if (!r.ok) throw new Error(r.error);
        if (r.warning) return { summary: r.warning, opened: false, likely_in_system_tray: true };
        return { summary: `Opened ${r.name}`, window_verified: true };
      },
    },

    open_url: {
      decl: {
        name: "open_url",
        description: "Open a website in the default browser, e.g. 'https://youtube.com' or 'https://web.whatsapp.com'.",
        parameters: { type: "OBJECT", properties: { url: { type: "STRING", description: "Full web address." } }, required: ["url"] },
      },
      async run({ url }) {
        let u = String(url).trim();
        if (!/^https?:\/\//i.test(u)) u = "https://" + u;
        const parsed = new URL(u);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only web links can be opened.");
        await ctx.openExternal(parsed.href);
        return { summary: `Opened ${parsed.hostname.replace(/^www\./, "")}` };
      },
    },

    web_search: {
      decl: {
        name: "web_search",
        description: "Search the web in the browser. Use site='youtube' to search YouTube.",
        parameters: { type: "OBJECT", properties: {
          query: { type: "STRING", description: "What to search for." },
          site: { type: "STRING", description: "Optional: 'google' (default) or 'youtube'." },
        }, required: ["query"] },
      },
      async run({ query, site }) {
        const q = encodeURIComponent(query);
        const yt = String(site || "").toLowerCase().includes("youtube");
        await ctx.openExternal(yt ? `https://www.youtube.com/results?search_query=${q}` : `https://www.google.com/search?q=${q}`);
        return { summary: `Searched ${yt ? "YouTube" : "Google"} for "${query}"` };
      },
    },

    undo_last: {
      decl: {
        name: "undo_last",
        description: "Undo the most recent file change Relay made (create folder, move, organize, rename). Deletions can't be undone here; they can be restored from the Recycle Bin.",
        parameters: { type: "OBJECT", properties: {} },
      },
      async run() { return undoLast(); },
    },
  };

  async function planRename(path, newName) {
    const from = paths.assertAllowed(paths.resolve(path));
    if (!(await exists(from))) throw new Error(`Not found: ${paths.pretty(from)}`);
    let name = String(newName || "").trim();
    if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error(`"${newName}" isn't a valid name. Names can't contain \\ / : * ? " < > |`);
    const st = await fs.stat(from);
    if (st.isFile() && !P.extname(name) && P.extname(from)) name += P.extname(from);
    const to = P.join(P.dirname(from), name);
    if (to !== from && (await exists(to))) throw new Error(`${name} already exists there.`);
    return { from, to };
  }

  async function checkExisting(list) {
    if (!list || !list.length) throw new Error("No paths given.");
    const abs = list.map((x) => paths.assertAllowed(paths.resolve(x)));
    for (const a of abs) if (!(await exists(a))) throw new Error(`Not found: ${paths.pretty(a)}`);
    return abs;
  }

  async function undoLast() {
    const last = undoStack.pop();
    if (!last) return { summary: "Nothing to undo" };
    if (last.kind === "create") {
      try { await fs.rmdir(last.path); } catch { return { summary: `Kept ${paths.pretty(last.path)} because it's no longer empty` }; }
      return { summary: `Removed ${paths.pretty(last.path)}` };
    }
    if (last.kind === "rename") {
      await fs.rename(last.to, last.from);
      return { summary: `Renamed back to ${P.basename(last.from)}` };
    }
    if (last.kind === "moves") {
      let back = 0;
      for (const m of [...last.moves].reverse()) {
        try { await moveOne(m.to, P.dirname(m.from)); back++; } catch {}
      }
      for (const d of last.createdDirs) { try { await fs.rmdir(d); } catch {} }
      return { summary: `Undid "${last.label}": moved ${back} item${back === 1 ? "" : "s"} back` };
    }
    return { summary: "Nothing to undo" };
  }

  return {
    tools,
    declarations: Object.values(tools).map((t) => t.decl),
    undoLast,
    canUndo: () => undoStack.length > 0,
    categoryOf,
  };
}

module.exports = { createTools, CATEGORIES };
