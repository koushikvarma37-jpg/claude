# Relay

**Relay** is an AI desktop agent for Windows by **Teja Varma**. Type or speak a command in plain English, and Relay carries it out on your computer.

> "Make a folder called Hackathon, move my pitch PDFs into it, and open it."

Relay is named after the electronic relay, where a small signal switches a bigger circuit. Your words are the small signal and the actions on your PC are the big circuit.

## What it can do (v1)

| Area | Examples |
| --- | --- |
| Folders | "make a folder called DSP notes on the desktop" |
| Organize | "sort my Downloads folder" → Images, PDFs, Documents, Videos, Audio, Archives, Installers, Code, Others |
| Move | "move all PDFs from Downloads to Documents/College" |
| Find | "find my resume", "where is the DSP lab report?" |
| Rename | "rename report.pdf to final report" |
| Delete | "delete junk.txt from the desktop" (Recycle Bin only, always asks first) |
| Apps | "open WhatsApp", "open VS Code", "open Spotify" (works for Microsoft Store apps too) |
| Web | "open YouTube", "search YouTube for Arduino projects" |
| Multi-step | several actions from one sentence |
| Questions | "what is a Fourier transform?" |
| Undo | "undo that", or the **Undo** button next to any file change |

**Voice:** press the mic (or `Ctrl+M`), speak, and pause. Relay shows what it heard so you can fix it before it runs. Spoken commands get a short spoken reply.

## How it works

```
You (voice or text)
   │
   ├─ voice → Gemini transcribes it → you check the text
   ▼
Gemini + tool definitions  ──►  decides which tools to call, with what arguments
   ▼
Relay runs each tool         ◄─ asks your approval before moving, organizing, renaming or deleting
   ▼
Results go back to Gemini ──►  next step, or a short final reply
```

The old Orbit matched fixed phrases ("if the command says open WhatsApp…"), so it broke on anything new. Relay uses **tool calling**: Gemini reads your sentence and picks from general tools (`find_files`, `move_files`, `organize_folder`, `open_app`, …) with the right arguments, so new phrasings work without new code.

## Install (Windows)

**Easiest:** run **`Relay-Setup-1.4.0.exe`**. It installs in a few seconds, adds a desktop and Start menu shortcut, and opens Relay.

> Windows may show **"Windows protected your PC"** because the installer isn't code-signed (signing certificates are paid). Click **More info → Run anyway**.

On first launch, paste a free Gemini key from **https://aistudio.google.com/apikey** and click **Connect**.

### Everyday use
- **Ctrl+Shift+Space**: show or hide Relay from anywhere.
- **Ctrl+Shift+M**: open Relay and start listening.
- Closing the window keeps Relay running in the **system tray** (the ^ arrow near the clock). Right-click the tray icon for **Start listening**, **Start with Windows** and **Quit Relay**.
- Relay **starts with Windows** by default and waits quietly in the tray. Turn this off in Settings or the tray menu.
- **Instant commands** run immediately without asking Gemini (and work offline or when the free limit is used up): `open whatsapp`, `open downloads`, `open youtube`, `search youtube for …`, `google …`, `sort my downloads`, `make a folder called …`, `undo`.

### Past conversations
Every chat is saved **only on this PC** and listed in the sidebar (**Ctrl+B** to show or hide), grouped by Today, Yesterday and so on. Click a chat to see it again and **carry on**, since Relay restores what it remembered. Search past commands, hover a chat and click the bin twice to delete it, or delete everything in Settings.

### Run from source (for development)
```
npm install
npm start          # run Relay
npm test           # run the tests
npm run dist       # build dist/Relay-Setup-<version>.exe
```

### If the mic doesn't work
Open Windows **Settings → Privacy & security → Microphone**, then turn on **Microphone access** and **Let desktop apps access your microphone**.

### If Relay says the free-tier limit was reached
Gemini's free tier allows a limited number of requests per minute. Wait a minute and try again.

## Safety

- Anything that **moves, organizes, renames or deletes** shows exactly what will change and waits for your **Do it**.
- Deleting only sends files to the **Recycle Bin**.
- Relay refuses to touch `C:\Windows`, `Program Files`, `ProgramData`, `AppData` and whole drives.
- File changes can be undone with the **Undo** button.
- Your API key is stored **encrypted** with Windows' built-in protection.
- Privacy: commands and file *names* are sent to Gemini to decide what to do. File contents are never uploaded. On Gemini's free tier, Google may use requests to improve its models.

## Project structure

```
relay/
├── main.js            Electron main process: window, tray, startup, shortcuts, connects UI ↔ agent
├── preload.js         The safe bridge the UI uses to talk to main.js
├── src/
│   ├── agent.js       Gemini loop: tool calling, approvals, retries, voice transcription
│   ├── quick.js       Instant commands that skip Gemini (open app/site/folder, search, sort, new folder, undo)
│   ├── history.js     Saves past conversations on this PC
│   ├── tools.js       File, app and web tools (with plan + undo)
│   ├── apps.js        Finds installed apps via Windows' Start menu list
│   ├── paths.js       Turns "Desktop/DSP notes" into real paths, blocks system folders
│   └── settings.js    Saves settings; encrypts the API key
├── renderer/
│   ├── index.html     The window
│   ├── styles.css     The design
│   ├── app.js         UI logic: steps, approvals, mic, settings
│   └── recorder.js    Mic recording, live waveform, auto-stop on pause
├── build/icon.png     App icon used by the installer
└── test/              Tests for tools, agent loop, instant commands and app matching (npm test)
```

## Adding a new ability

1. Add a tool to `src/tools.js` with a clear `description`. Gemini reads it to decide when to use the tool.
2. If it changes files, set `confirm: true` and write a `plan()`.
3. Add a friendly title for it in `TOOL_TITLES` in `renderer/app.js`.

Planned for v2: volume and brightness, shutdown and restart, screenshots, and memory ("remember my deadline is Friday").

## Tests

```
npm test
```
