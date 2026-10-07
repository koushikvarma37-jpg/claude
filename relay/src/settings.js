// Saves Relay's settings in the user's app-data folder.
// The API key is encrypted with Windows' own protection (DPAPI via Electron safeStorage).
const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  model: "gemini-flash-latest",
  speakReplies: true,
  autoRunVoice: false,
};

function createSettings({ dir, safeStorage }) {
  const file = path.join(dir, "settings.json");
  let data = { ...DEFAULTS };
  try { data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch {}

  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  };
  const canEncrypt = () => { try { return safeStorage && safeStorage.isEncryptionAvailable(); } catch { return false; } };

  function getApiKey() {
    if (data.apiKeyEnc && canEncrypt()) {
      try { return safeStorage.decryptString(Buffer.from(data.apiKeyEnc, "base64")); } catch { return ""; }
    }
    return data.apiKey || "";
  }

  function setApiKey(key) {
    const k = String(key || "").trim();
    delete data.apiKey; delete data.apiKeyEnc;
    if (k) {
      if (canEncrypt()) data.apiKeyEnc = safeStorage.encryptString(k).toString("base64");
      else data.apiKey = k;
    }
    save();
  }

  /** What the settings screen sees: never the key itself, only whether one is saved. */
  function publicView() {
    const key = getApiKey();
    return {
      hasKey: !!key,
      keyHint: key ? `••••${key.slice(-4)}` : "",
      model: data.model,
      speakReplies: data.speakReplies,
      autoRunVoice: data.autoRunVoice,
      startWithWindows: !!data.startWithWindows,
    };
  }

  function update(patch) {
    if (typeof patch.apiKey === "string" && patch.apiKey.trim()) setApiKey(patch.apiKey);
    for (const k of ["model", "speakReplies", "autoRunVoice", "startWithWindows", "trayHintShown", "windowBounds", "windowMaximized"]) if (k in patch) data[k] = patch[k];
    save();
    return publicView();
  }

  return { getApiKey, setApiKey, publicView, update, get: (k) => data[k] };
}

module.exports = { createSettings };
