// Reading files so Relay can summarise them or answer questions about them.
// Text, Word, PowerPoint and Excel files are read here on the PC; PDFs and images go to Gemini as they are
// (Gemini reads them natively). Nothing is read unless the user asks about that file.
const fs = require("fs/promises");
const fssync = require("fs");
const zlib = require("zlib");

const TEXT_EXTS = ["txt", "md", "csv", "tsv", "json", "log", "xml", "html", "htm", "css", "js", "ts", "py", "java", "c", "cpp", "h", "m", "v", "sv", "vhd", "ino", "sh", "bat", "ps1", "ini", "yaml", "yml", "tex", "srt", "rtf"];
const OFFICE_EXTS = ["docx", "pptx", "xlsx"];
const NATIVE_TYPES = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", heic: "image/heic", gif: "image/gif" };
const MAX_CHARS = 120000;
const MAX_INLINE = 18 * 1024 * 1024;

// ---------- a tiny .zip reader (Office files are zip archives of XML) ----------
function unzip(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("This file is damaged or isn't really an Office document.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out[name] = data.toString("utf8");
    else if (method === 8) out[name] = zlib.inflateRawSync(data).toString("utf8");
  }
  return out;
}

const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");
const tidy = (s) => s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const byNumber = (re) => (a, b) => +a.match(re)[1] - +b.match(re)[1];

function docxText(buf) {
  const xml = unzip(buf, (n) => n === "word/document.xml")["word/document.xml"] || "";
  return tidy(decode(xml.replace(/<w:tab\/>/g, "\t").replace(/<w:br[^>]*\/>/g, "\n").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "")));
}

function pptxText(buf) {
  const re = /^ppt\/slides\/slide(\d+)\.xml$/;
  const files = unzip(buf, (n) => re.test(n));
  return Object.keys(files).sort(byNumber(re)).map((name, i) => {
    const text = decode(files[name].replace(/<\/a:p>/g, "\n").replace(/<a:br\/>/g, "\n").replace(/<(?!\/?a:t[ >])[^>]+>/g, "").replace(/<\/?a:t[^>]*>/g, ""));
    return `--- Slide ${i + 1} ---\n${tidy(text)}`;
  }).join("\n\n");
}

function xlsxText(buf) {
  const re = /^xl\/worksheets\/sheet(\d+)\.xml$/;
  const files = unzip(buf, (n) => re.test(n) || n === "xl/sharedStrings.xml");
  const shared = [];
  for (const si of (files["xl/sharedStrings.xml"] || "").match(/<si>[\s\S]*?<\/si>/g) || []) {
    shared.push(decode((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, "")).join("")));
  }
  const sheets = Object.keys(files).filter((n) => re.test(n)).sort(byNumber(re));
  return sheets.slice(0, 5).map((name, i) => {
    const rows = (files[name].match(/<row[\s\S]*?<\/row>/g) || []).slice(0, 1000).map((row) =>
      (row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []).map((c) => {
        const type = (c.match(/ t="(\w+)"/) || [])[1];
        if (type === "inlineStr") return decode(((c.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1]) || "");
        const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (v == null) return "";
        return type === "s" ? shared[+v] || "" : decode(v);
      }).join("\t"));
    return `--- Sheet ${i + 1} ---\n${rows.join("\n")}`;
  }).join("\n\n");
}

/** Text of a file we can read locally, or null if it's a type Gemini should read itself (PDF, image). */
async function extractText(file, ext) {
  if (TEXT_EXTS.includes(ext)) {
    const buf = await fs.readFile(file);
    let text = buf.toString("utf8");
    if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString("utf16le");
    if (ext === "rtf") text = text.replace(/\\par[d]?/g, "\n").replace(/\{\\\*[^}]*\}|\\[a-z]+-?\d* ?|[{}]/g, "");
    return text;
  }
  const buf = await fs.readFile(file);
  if (ext === "docx") return docxText(buf);
  if (ext === "pptx") return pptxText(buf);
  if (ext === "xlsx") return xlsxText(buf);
  return null;
}

function createReaderTools(ctx) {
  // ctx: { paths, ask }
  const { paths } = ctx;
  const P = paths.path;
  const extOf = (f) => P.extname(f).slice(1).toLowerCase();

  return {
    read_file: {
      decl: {
        name: "read_file",
        description: "Read a document and answer a question about it or summarise it. Works with PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), text/code files and images. Find the exact path with find_files first. Only use when the user asks about a file's contents.",
        parameters: { type: "OBJECT", properties: {
          path: { type: "STRING", description: "Exact path of the file." },
          question: { type: "STRING", description: "What the user wants, e.g. 'summarise it in 5 points' or 'what is the submission deadline?'." },
        }, required: ["path", "question"] },
      },
      async run({ path, question }) {
        const file = paths.assertAllowed(paths.resolve(path));
        let st;
        try { st = await fs.stat(file); } catch { throw new Error(`Not found: ${paths.pretty(file)}`); }
        if (st.isDirectory()) throw new Error(`${paths.pretty(file)} is a folder. Pick a file inside it.`);
        const ext = extOf(file), name = P.basename(file);
        let parts;
        if (NATIVE_TYPES[ext]) {
          if (st.size > MAX_INLINE) throw new Error(`${name} is too big to read (${Math.round(st.size / 1048576)} MB; the limit is 18 MB).`);
          parts = [{ inlineData: { mimeType: NATIVE_TYPES[ext], data: (await fs.readFile(file)).toString("base64") } }];
        } else {
          if (!TEXT_EXTS.includes(ext) && !OFFICE_EXTS.includes(ext)) {
            throw new Error(ext === "doc" || ext === "ppt" || ext === "xls" ? `${name} is in the old Office format. Open it and save it as .${ext}x, then ask again.` : `Relay can't read .${ext || "?"} files yet.`);
          }
          let text = await extractText(file, ext);
          if (!text || !text.trim()) return { summary: `${name} has no readable text`, error: "empty", tip: "It may be a scanned document. Export it as PDF and ask again." };
          const cut = text.length > MAX_CHARS;
          if (cut) text = text.slice(0, MAX_CHARS);
          parts = [{ text: `File: ${name}${cut ? " (only the first part, the file is long)" : ""}\n\n${text}` }];
        }
        parts.push({ text: `The user asked about the file "${name}": ${question}\nAnswer from the file's contents only. Be concise and well organised (short bullet points are fine). If the file doesn't contain the answer, say so.` });
        const answer = await ctx.ask(parts);
        return { summary: `Read ${name}`, answer };
      },
    },

    search_in_files: {
      decl: {
        name: "search_in_files",
        description: "Find documents whose CONTENTS mention some words (e.g. 'the file that talks about Fourier'). Searches text, Word, PowerPoint and Excel files on this PC (not PDFs or images). Searches Desktop, Documents and Downloads unless a folder is given.",
        parameters: { type: "OBJECT", properties: {
          query: { type: "STRING", description: "Words that should appear in the file, e.g. 'fourier transform'." },
          folder: { type: "STRING", description: "Optional folder to search in." },
        }, required: ["query"] },
      },
      async run({ query, folder }) {
        const k = paths.known;
        const roots = folder ? [paths.resolve(folder)] : [k.desktop, k.documents, k.downloads].filter(Boolean);
        const words = String(query || "").toLowerCase().split(/\s+/).filter((w) => w.length > 1);
        if (!words.length) throw new Error("Give some words to look for.");
        const results = [];
        const queue = roots.filter((r) => fssync.existsSync(r)).map((r) => [r, 0]);
        const deadline = Date.now() + 10000;
        let checked = 0;
        while (queue.length && results.length < 15 && checked < 3000 && Date.now() < deadline) {
          const [dir, depth] = queue.shift();
          let entries;
          try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
          for (const d of entries) {
            const full = P.join(dir, d.name);
            if (d.isDirectory()) { if (depth < 5 && !d.name.startsWith(".") && !/^(node_modules|appdata|\$recycle\.bin|venv|\.venv|__pycache__)$/i.test(d.name)) queue.push([full, depth + 1]); continue; }
            const ext = extOf(d.name);
            if (d.name.startsWith("~$") || (!TEXT_EXTS.includes(ext) && !OFFICE_EXTS.includes(ext))) continue;
            try {
              const st = await fs.stat(full);
              if (st.size > 8 * 1024 * 1024) continue;
              checked++;
              const text = (await extractText(full, ext)) || "";
              const lower = text.toLowerCase();
              if (!words.every((w) => lower.includes(w))) continue;
              const at = lower.indexOf(words[0]);
              const snippet = text.slice(Math.max(0, at - 80), at + 120).replace(/\s+/g, " ").trim();
              results.push({ path: full, shown_as: paths.pretty(full), modified: st.mtime.toISOString().slice(0, 10), snippet });
            } catch {}
            if (results.length >= 15 || Date.now() > deadline) break;
          }
        }
        results.sort((a, b) => b.modified.localeCompare(a.modified));
        return { summary: results.length ? `Found ${results.length} file${results.length > 1 ? "s" : ""} mentioning "${query}"` : `No documents mention "${query}"`, results, note: "PDFs and images aren't searched by content." };
      },
    },
  };
}

module.exports = { createReaderTools, extractText, unzip, docxText, pptxText, xlsxText };
