// Instant commands: simple, unambiguous requests run straight away on this PC,
// without a round-trip to Gemini (so they also work offline or without a key).
// Anything with more than one step, or that we're not sure about, goes to Gemini.

const SITES = {
  youtube: "https://www.youtube.com", gmail: "https://mail.google.com", google: "https://www.google.com",
  "google drive": "https://drive.google.com", drive: "https://drive.google.com", github: "https://github.com",
  instagram: "https://www.instagram.com", linkedin: "https://www.linkedin.com", chatgpt: "https://chatgpt.com",
  "whatsapp web": "https://web.whatsapp.com", netflix: "https://www.netflix.com", amazon: "https://www.amazon.in",
  flipkart: "https://www.flipkart.com", twitter: "https://x.com", x: "https://x.com", facebook: "https://www.facebook.com",
  "gemini": "https://gemini.google.com", "ai studio": "https://aistudio.google.com", cricbuzz: "https://www.cricbuzz.com",
};
const FOLDERS = ["desktop", "downloads", "documents", "pictures", "music", "videos"];

// Signs that a request has more than one part or needs real understanding
const COMPLEX = /\b(and|then|after|also|but|if|with|into|from|to|all|every|my\s+\w+\s+(?:file|folder|pdf)s?)\b|,|;/i;

// "send my resume / this file / the photo to …" means a file, which needs Gemini, not a text message
const REFERS_TO_FILE = /^(?:my |the |this |that |a |an )?(?:file|pdf|photo|pic|picture|image|document|doc|resume|cv|screenshot|video|it|this|that|these|those)s?$/i;

// "send a message to Amma" says who, not what: Gemini asks what to say
const NO_MESSAGE = /^(?:a|an|the|whats ?app|(?:a |an |the )?(?:whats ?app )?(?:message|msg|text))$/i;

function createQuick({ apps }) {
  async function match(raw) {
    const t = String(raw || "").trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
    if (!t || t.length > 600) return null;
    let m;

    if (/^(?:undo|undo (?:that|it|the last (?:change|action))|revert (?:that|it))$/i.test(t)) return { tool: "undo_last", args: {} };

    // WhatsApp: "send how are you to 98765 43210 on WhatsApp", "send a hi message to Amma on WhatsApp",
    // "WhatsApp Amma: I'll be late". Still shows the message for approval; the person is resolved by the tool.
    const wa = "(?:on|via|in|through|using)\\s+whats\\s?app";
    if ((m = raw.trim().match(new RegExp(`^(?:please\\s+)?send\\s+(?:a\\s+|an\\s+)?(?:whats\\s?app\\s+)?message\\s+(?:saying\\s+|that\\s+)?["“']?(.+?)["”']?\\s+to\\s+(.+?)\\s+${wa}[.!]?$`, "i"))) ||
        (m = raw.trim().match(new RegExp(`^(?:please\\s+)?send\\s+(?:a\\s+|an\\s+)?["“']?(.+?)["”']?\\s+message\\s+to\\s+(.+?)\\s+${wa}[.!]?$`, "i"))) ||
        (m = raw.trim().match(new RegExp(`^(?:please\\s+)?(?:send|text|message)\\s+["“']?(.+?)["”']?\\s+to\\s+(.+?)\\s+${wa}[.!]?$`, "i")))) {
      if (!REFERS_TO_FILE.test(m[1].trim()) && !NO_MESSAGE.test(m[1].trim()) && m[2].trim().split(/\s+/).length <= 4) return { tool: "send_whatsapp", args: { to: m[2].trim(), message: m[1].trim() } };
      return null; // "send my resume to Ravi": a file, not a text; Gemini explains
    }
    if ((m = raw.trim().match(/^whats\s?app\s+([^:]{1,40}?)\s*:\s*(.+)$/i))) return { tool: "send_whatsapp", args: { to: m[1].trim(), message: m[2].trim() } };
    if (t.length > 80) return null; // everything below is a short command

    // PC controls
    const pls = "(?:please\\s+)?";
    if ((m = t.match(new RegExp(`^${pls}(?:turn |increase |raise )?(?:the )?volume (up|down)$|^${pls}(increase|decrease|raise|lower|reduce) (?:the )?volume$|^${pls}turn (?:it |the volume )?(up|down)$`, "i")))) {
      const dir = (m[1] || m[2] || m[3]).toLowerCase();
      return { tool: "set_volume", args: { change: /up|increase|raise/.test(dir) ? 10 : -10 } };
    }
    if ((m = t.match(new RegExp(`^${pls}(?:set |change |put )?(?:the )?volume (?:to |at )?(\\d{1,3})\\s*(?:%|percent)?$`, "i")))) return { tool: "set_volume", args: { level: +m[1] } };
    if (new RegExp(`^${pls}(?:mute|mute (?:the )?(?:sound|volume|audio|pc|laptop))$`, "i").test(t)) return { tool: "set_volume", args: { mute: "on" } };
    if (new RegExp(`^${pls}(?:unmute|unmute (?:the )?(?:sound|volume|audio|pc|laptop))$`, "i").test(t)) return { tool: "set_volume", args: { mute: "off" } };
    if (new RegExp(`^${pls}(?:pause|play|resume)(?: (?:the )?(?:music|song|video|it))?$`, "i").test(t)) return { tool: "media_control", args: { action: "play_pause" } };
    if (new RegExp(`^${pls}(?:next|skip)(?: (?:the )?(?:song|track|video|this))?$|^${pls}(?:play )?(?:the )?next (?:song|track|video)$`, "i").test(t)) return { tool: "media_control", args: { action: "next" } };
    if (new RegExp(`^${pls}(?:previous|play (?:the )?previous)(?: song| track| video)?$|^${pls}go back a (?:song|track)$`, "i").test(t)) return { tool: "media_control", args: { action: "previous" } };
    if ((m = t.match(new RegExp(`^${pls}(?:set |change )?(?:the )?brightness (?:to |at )?(\\d{1,3})\\s*(?:%|percent)?$`, "i")))) return { tool: "set_brightness", args: { level: +m[1] } };
    if ((m = t.match(new RegExp(`^${pls}(?:turn |increase |decrease )?(?:the )?brightness (up|down)$|^${pls}(increase|decrease|reduce|lower|raise) (?:the )?brightness$`, "i")))) {
      return { tool: "set_brightness", args: { change: /up|increase|raise/i.test(m[1] || m[2]) ? 20 : -20 } };
    }
    if (new RegExp(`^${pls}lock(?: (?:my |the |this )?(?:pc|computer|laptop|screen|system))?$`, "i").test(t)) return { tool: "power_action", args: { action: "lock" } };
    if (new RegExp(`^${pls}(?:take|grab|capture) (?:a )?screenshot$|^screenshot$`, "i").test(t)) return { tool: "take_screenshot", args: {} };
    if (/^(?:what(?:'s| is) (?:my |the )?battery(?: level| percentage)?|battery(?: level| status| percentage)?|how much battery(?: is left| do i have)?)\??$/i.test(t)) return { tool: "system_status", args: {} };

    // "sort my downloads", "organize the desktop folder", "clean up downloads" (still asks for approval)
    if ((m = t.match(/^(?:please\s+)?(?:sort|organi[sz]e|tidy(?: up)?|clean(?: up)?|arrange)\s+(?:my\s+|the\s+)?(desktop|downloads|documents|pictures|music|videos)(?:\s+folder)?(?:\s+by\s+(?:file\s+)?type)?$/i))) {
      return { tool: "organize_folder", args: { path: m[1] } };
    }
    // "make a folder called DSP notes", "create a new folder named X on the desktop / in documents"
    if ((m = t.match(/^(?:please\s+)?(?:make|create)\s+(?:a\s+)?(?:new\s+)?folder\s+(?:called|named)\s+["']?(.+?)["']?(?:\s+(?:on|in)\s+(?:my\s+|the\s+)?(desktop|downloads|documents|pictures|music|videos))?(?:\s+folder)?$/i))) {
      const name = m[1].trim();
      if (!/[\\/:*?"<>|]/.test(name) && !COMPLEX.test(name) && name.length <= 60) return { tool: "create_folder", args: { path: `${m[2] || "Desktop"}/${name}` } };
    }

    if ((m = t.match(/^(?:search|look up|find)\s+(youtube|google)\s+for\s+(.+)$/i)) ||
        (m = t.match(/^(youtube|google)\s+(.+)$/i))) {
      return { tool: "web_search", args: { site: m[1].toLowerCase(), query: m[2] } };
    }
    if ((m = t.match(/^(?:search|look up)\s+(.+?)\s+on\s+(youtube|google)$/i))) {
      return { tool: "web_search", args: { site: m[2].toLowerCase(), query: m[1] } };
    }

    if ((m = t.match(/^(?:please\s+)?(?:open|launch|start|run|show)\s+(?:the\s+|my\s+)?(.+?)(?:\s+(?:app|application|folder|website|site))?$/i))) {
      const target = m[1].trim();
      const lower = target.toLowerCase();
      if (/^[\w-]+(\.[\w-]+)*\.(com|in|org|net|io|ai|dev|co|app|edu)(\/\S*)?$/i.test(target)) return { tool: "open_url", args: { url: target } };
      if (COMPLEX.test(target) || /[\\/]|\.(pdf|docx?|txt|pptx?|xlsx?|png|jpe?g|mp4)$/i.test(target)) return null;
      if (FOLDERS.includes(lower)) return { tool: "open_path", args: { path: target } };
      const ranked = await apps.find(target);
      const best = ranked[0] ? ranked[0].s : 0;
      if (best >= 100) return { tool: "open_app", args: { name: target } };          // exact app name wins (e.g. a YouTube app)
      if (SITES[lower]) return { tool: "open_url", args: { url: SITES[lower] } };      // "open google" → google.com, not Chrome
      if (best >= 85) return { tool: "open_app", args: { name: target } };
    }
    return null;
  }
  return { match };
}

module.exports = { createQuick, SITES };
