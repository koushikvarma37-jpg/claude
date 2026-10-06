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

## Setup (Windows)

You need **Node.js** (LTS) and a free **Gemini API key**.

1. Download this folder and open it in **Command Prompt** (or the VS Code terminal).
2. Install the dependencies (one time, takes a minute or two):
   ```
   npm install
   ```
3. Start Relay:
   ```
   npm start
   ```
4. On first launch, Relay asks for your key. Get one at **https://aistudio.google.com/apikey** → **Create API key**, paste it, and click **Connect**.

That's it. Press **Ctrl+Shift+Space** anywhere in Windows to show or hide Relay, or **Ctrl+Shift+M** to open it and start listening.

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
├── main.js            Electron main process: window, shortcuts, connects UI ↔ agent
├── preload.js         The safe bridge the UI uses to talk to main.js
├── src/
│   ├── agent.js       Gemini loop: tool calling, approvals, voice transcription
│   ├── tools.js       File, app and web tools (with plan + undo)
│   ├── apps.js        Finds installed apps via Windows' Start menu list
│   ├── paths.js       Turns "Desktop/DSP notes" into real paths, blocks system folders
│   └── settings.js    Saves settings; encrypts the API key
├── renderer/
│   ├── index.html     The window
│   ├── styles.css     The design
│   ├── app.js         UI logic: steps, approvals, mic, settings
│   └── recorder.js    Mic recording, live waveform, auto-stop on pause
└── test/              Tests for tools, agent loop and app matching (npm test)
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
