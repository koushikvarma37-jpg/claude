// What Relay remembers for Teja, stored only on this PC (memory.json in Relay's app-data folder):
//   facts      – "my lab exam is on Friday", "I prefer Chrome"
//   contacts   – names with a WhatsApp number and/or email address
//   reminders  – one-off or repeating, shown as Windows notifications when due
const fs = require("fs");
const path = require("path");

const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Phone numbers as WhatsApp wants them: digits only with the country code. 10-digit numbers are taken as Indian (+91). */
function normalizePhone(raw) {
  let d = String(raw || "").replace(/[^\d+]/g, "");
  if (!d) return "";
  if (d.startsWith("+")) return d.slice(1).replace(/\D/g, "");
  d = d.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = "91" + d.slice(1);
  else if (d.length === 10) d = "91" + d;
  return d;
}
/** Why a phone number can't be right, or null if it looks fine. Catches a missing or extra digit before anything is sent. */
function phoneProblem(raw) {
  const s = String(raw || "").trim();
  const d = s.replace(/\D/g, "");
  if (s.startsWith("+") || d.startsWith("00")) {
    const full = d.replace(/^00/, "");
    if (full.startsWith("91") && full.length !== 12) return `"${s}" has ${full.length - 2} digits after +91. Indian mobile numbers have 10.`;
    return full.length >= 8 && full.length <= 15 ? null : `"${s}" doesn't look like a phone number.`;
  }
  if (d.length === 10 || (d.length === 11 && d.startsWith("0")) || (d.length === 12 && d.startsWith("91"))) return null;
  return `"${s}" has ${d.length} digits. Indian mobile numbers have 10 (for other countries, start with + and the country code).`;
}
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());

function createMemory({ dir, now = () => Date.now() }) {
  const file = path.join(dir, "memory.json");
  let data = { facts: [], contacts: [], reminders: [] };
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch {}
  let seq = Date.now();
  const id = (p) => `${p}${(++seq).toString(36)}`;
  const save = () => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); };

  // ---------- facts ----------
  function addFact(text) {
    const t = String(text || "").trim().slice(0, 500);
    if (!t) throw new Error("Nothing to remember.");
    const dup = data.facts.find((f) => norm(f.text) === norm(t));
    if (dup) return dup;
    const f = { id: id("f"), text: t, at: now() };
    data.facts.push(f);
    if (data.facts.length > 200) data.facts.shift();
    save();
    return f;
  }

  // ---------- contacts ----------
  /** Best matches for a spoken name: exact, then starts-with, then all words present. */
  function findContacts(name) {
    const q = norm(name);
    if (!q) return [];
    const qw = q.split(" ");
    const scored = data.contacts.map((c) => {
      const n = norm(c.name), aliases = (c.aliases || []).map(norm);
      let s = 0;
      if (n === q || aliases.includes(q)) s = 100;
      else if (n.startsWith(q + " ") || aliases.some((a) => a.startsWith(q))) s = 80;
      else if (qw.every((w) => n.split(" ").includes(w))) s = 70;
      else if (qw.every((w) => n.includes(w))) s = 50;
      return { c, s };
    }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    if (scored.length && scored[0].s === 100) return [scored[0].c];
    return scored.map((x) => x.c);
  }

  function saveContact({ name, phone, email, aliases }) {
    const n = String(name || "").trim();
    if (!n) throw new Error("A contact needs a name.");
    const problem = phone ? phoneProblem(phone) : null;
    if (problem) throw new Error(problem);
    const p = phone ? normalizePhone(phone) : "";
    if (email && !isEmail(email)) throw new Error(`"${email}" doesn't look like an email address.`);
    let c = data.contacts.find((x) => norm(x.name) === norm(n));
    const created = !c;
    if (!c) { c = { id: id("c"), name: n }; data.contacts.push(c); }
    if (p) c.phone = p;
    if (email) c.email = String(email).trim();
    if (aliases && aliases.length) c.aliases = Array.from(new Set([...(c.aliases || []), ...aliases.map(String)]));
    save();
    return { contact: c, created };
  }

  // ---------- reminders ----------
  function addReminder({ text, at, repeat }) {
    const t = String(text || "").trim().slice(0, 300);
    if (!t) throw new Error("What should I remind you about?");
    if (!Number.isFinite(at)) throw new Error("I couldn't work out when to remind you.");
    if (at < now() - 60000) throw new Error("That time has already passed.");
    const r = { id: id("r"), text: t, at, repeat: ["daily", "weekly", "weekdays"].includes(repeat) ? repeat : null };
    data.reminders.push(r);
    data.reminders.sort((a, b) => a.at - b.at);
    save();
    return r;
  }

  function nextOccurrence(r) {
    const d = new Date(r.at);
    do {
      d.setDate(d.getDate() + (r.repeat === "weekly" ? 7 : 1));
      while (r.repeat === "weekdays" && (d.getDay() === 0 || d.getDay() === 6)) d.setDate(d.getDate() + 1);
    } while (d.getTime() <= now());
    return d.getTime();
  }

  /** Reminders that are due now. One-off ones are removed; repeating ones move to their next time. */
  function takeDue() {
    const t = now();
    const due = data.reminders.filter((r) => r.at <= t);
    if (!due.length) return [];
    const fired = due.map((r) => ({ ...r, late: t - r.at > 5 * 60000 ? r.at : null })); // before repeating ones move on
    for (const r of due) {
      if (r.repeat) r.at = nextOccurrence(r);
      else data.reminders = data.reminders.filter((x) => x !== r);
    }
    data.reminders.sort((a, b) => a.at - b.at);
    save();
    return fired;
  }

  // ---------- removal ----------
  /** Forget facts, contacts or reminders by id, or by text that matches them. */
  function remove(query, { kinds = ["facts", "contacts", "reminders"] } = {}) {
    const q = norm(query);
    const removed = [];
    for (const kind of kinds) {
      const keep = [];
      for (const item of data[kind]) {
        const label = kind === "contacts" ? item.name : item.text;
        if (item.id === query || (q && (norm(label).includes(q) || (q.length > 3 && q.includes(norm(label)))))) removed.push({ kind, label });
        else keep.push(item);
      }
      data[kind] = keep;
    }
    if (removed.length) save();
    return removed;
  }

  /** The part of Relay's instructions that tells Gemini what it remembers. */
  function promptBlock() {
    const fmt = (ms) => new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    const out = [];
    if (data.facts.length) out.push("Things Teja asked you to remember:\n" + data.facts.slice(-60).map((f) => `- ${f.text}`).join("\n"));
    if (data.contacts.length) out.push("Saved contacts:\n" + data.contacts.slice(0, 150).map((c) => `- ${c.name}${c.phone ? ` · WhatsApp +${c.phone}` : ""}${c.email ? ` · ${c.email}` : ""}`).join("\n"));
    if (data.reminders.length) out.push("Upcoming reminders:\n" + data.reminders.slice(0, 30).map((r) => `- [${r.id}] ${fmt(r.at)}${r.repeat ? ` (${r.repeat})` : ""}: ${r.text}`).join("\n"));
    return out.join("\n\n");
  }

  return {
    addFact, saveContact, findContacts, addReminder, takeDue, remove, promptBlock,
    list: () => JSON.parse(JSON.stringify(data)),
    removeById: (itemId) => remove(itemId).length > 0,
    nextReminderAt: () => (data.reminders[0] ? data.reminders[0].at : null),
  };
}

/** Turn Gemini's time (local ISO like "2026-10-07T17:30", or minutes from now) into a timestamp. */
function parseWhen({ at, in_minutes }, nowMs = Date.now()) {
  if (in_minutes != null && Number(in_minutes) > 0) return nowMs + Math.round(Number(in_minutes) * 60000);
  if (!at) return NaN;
  const s = String(at).trim();
  // a bare time like "17:30" means the next time the clock shows it
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date(nowMs); d.setHours(+hm[1], +hm[2], 0, 0);
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const ms = new Date(s.replace(" ", "T")).getTime();
  return ms;
}

function createMemoryTools({ memory, now: clock }) {
  const now = () => +(clock ? clock() : Date.now()); // the clock may give a Date or a number
  const fmt = (ms) => new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  return {
    remember: {
      decl: {
        name: "remember",
        description: "Save a fact the user wants Relay to remember for later (deadlines, preferences, details about people). For phone numbers and email addresses of people use save_contact instead.",
        parameters: { type: "OBJECT", properties: { fact: { type: "STRING", description: "The fact, written clearly in third person, e.g. 'Teja's DSP lab exam is on Friday 10 Oct'." } }, required: ["fact"] },
      },
      async run({ fact }) { const f = memory.addFact(fact); return { summary: `Remembered: ${f.text.replace(/\.$/, "")}` }; },
    },
    save_contact: {
      decl: {
        name: "save_contact",
        description: "Save or update a contact's WhatsApp/phone number and/or email address, so the user can message them by name later. Use the name the user calls them (e.g. 'Amma', 'Ravi sir').",
        parameters: { type: "OBJECT", properties: {
          name: { type: "STRING", description: "What the user calls this person." },
          phone: { type: "STRING", description: "Phone number with or without country code." },
          email: { type: "STRING", description: "Email address." },
        }, required: ["name"] },
      },
      async run(args) {
        if (!args.phone && !args.email) throw new Error("Give a phone number or an email address to save.");
        const { contact, created } = memory.saveContact(args);
        const what = [contact.phone && args.phone ? `number +${contact.phone}` : null, args.email ? `email ${contact.email}` : null].filter(Boolean).join(" and ");
        return { summary: `${created ? "Saved" : "Updated"} ${contact.name}'s ${what}` };
      },
    },
    forget: {
      decl: {
        name: "forget",
        description: "Forget a remembered fact, a saved contact or a reminder. Give its id from the lists above, or words that match it.",
        parameters: { type: "OBJECT", properties: { what: { type: "STRING", description: "An id like 'r1abc', or words from the fact, contact name or reminder." } }, required: ["what"] },
      },
      async run({ what }) {
        const removed = memory.remove(what);
        if (!removed.length) return { summary: `Nothing matched "${what}"`, removed: 0 };
        return { summary: removed.length === 1 ? `Forgot "${removed[0].label}"` : `Forgot ${removed.length} things`, removed: removed.map((r) => r.label) };
      },
    },
    set_reminder: {
      decl: {
        name: "set_reminder",
        description: "Remind the user later with a Windows notification. Give either `in_minutes` or `at` as LOCAL time 'YYYY-MM-DDTHH:MM' (no timezone). Relay must be running (it waits in the tray). Optional repeat: 'daily', 'weekdays' or 'weekly'.",
        parameters: { type: "OBJECT", properties: {
          message: { type: "STRING", description: "What to remind about, short, e.g. 'Call home'." },
          at: { type: "STRING", description: "Local date and time, e.g. '2026-10-07T17:30'." },
          in_minutes: { type: "NUMBER", description: "Minutes from now." },
          repeat: { type: "STRING", description: "Optional: 'daily', 'weekdays' or 'weekly'." },
        }, required: ["message"] },
      },
      async run({ message, at, in_minutes, repeat }) {
        const when = parseWhen({ at, in_minutes }, now());
        const r = memory.addReminder({ text: message, at: when, repeat });
        return { summary: `I'll remind you ${r.repeat ? `${r.repeat === "weekdays" ? "every weekday" : r.repeat}, starting ` : ""}${fmt(r.at)}: ${r.text}`, id: r.id, at: new Date(r.at).toString() };
      },
    },
  };
}

module.exports = { createMemory, createMemoryTools, normalizePhone, phoneProblem, isEmail, parseWhen };
