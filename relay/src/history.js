// Saves past conversations on this PC only (in Relay's app-data folder).
// Each conversation is one JSON file; index.json keeps the list for the sidebar.
const fs = require("fs");
const path = require("path");

const MAX_CONVERSATIONS = 300;
const ID_RE = /^[a-z0-9]{6,32}$/;

function createHistory({ dir, now = () => Date.now() }) {
  const indexFile = path.join(dir, "index.json");
  const fileFor = (id) => {
    if (!ID_RE.test(String(id))) throw new Error("Invalid conversation id.");
    return path.join(dir, `${id}.json`);
  };

  function readIndex() {
    try { const j = JSON.parse(fs.readFileSync(indexFile, "utf8")); return Array.isArray(j) ? j : []; } catch { return []; }
  }
  function writeIndex(list) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = indexFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(list));
    fs.renameSync(tmp, indexFile); // write-then-rename, so a crash never leaves a half-written index
  }

  const titleFrom = (turns) => {
    const first = (turns.find((t) => t && t.text) || {}).text || "New conversation";
    const clean = first.replace(/\s+/g, " ").trim();
    const t = clean.length > 60 ? clean.slice(0, 57).trimEnd() + "…" : clean;
    return t.charAt(0).toUpperCase() + t.slice(1);
  };

  /** Newest first: [{ id, title, createdAt, updatedAt, count, search }] */
  function list() {
    return readIndex().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Creates or updates a conversation. `contents` is Gemini's memory so the chat can be continued later. */
  function save({ id, turns, contents }) {
    if (!Array.isArray(turns) || !turns.length) throw new Error("Nothing to save.");
    const t = now();
    const index = readIndex();
    let meta = id && index.find((m) => m.id === id);
    if (!meta) {
      meta = { id: t.toString(36) + Math.random().toString(36).slice(2, 8), createdAt: t };
      index.push(meta);
    }
    meta.title = titleFrom(turns);
    meta.updatedAt = t;
    meta.count = turns.length;
    meta.search = turns.map((x) => x.text || "").join(" \n ").slice(0, 2000).toLowerCase();

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fileFor(meta.id), JSON.stringify({ id: meta.id, title: meta.title, createdAt: meta.createdAt, updatedAt: t, turns, contents: contents || [] }));

    // keep the newest MAX_CONVERSATIONS
    index.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const old of index.splice(MAX_CONVERSATIONS)) { try { fs.unlinkSync(fileFor(old.id)); } catch {} }
    writeIndex(index);
    return { ...meta };
  }

  function load(id) {
    const data = JSON.parse(fs.readFileSync(fileFor(id), "utf8"));
    return { id: data.id, title: data.title, turns: data.turns || [], contents: data.contents || [] };
  }

  function remove(id) {
    try { fs.unlinkSync(fileFor(id)); } catch {}
    writeIndex(readIndex().filter((m) => m.id !== id));
  }

  function clear() {
    for (const m of readIndex()) { try { fs.unlinkSync(fileFor(m.id)); } catch {} }
    writeIndex([]);
  }

  return { list, save, load, remove, clear };
}

module.exports = { createHistory };
