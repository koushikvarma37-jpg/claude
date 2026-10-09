# Relay

**Relay** is an AI desktop agent for Windows by **Teja Varma**. Type or speak a command in plain English, and Relay carries it out on your computer.

> "Make a folder called Hackathon, move my pitch PDFs into it, and open it."

Relay is named after the electronic relay, where a small signal switches a bigger circuit. Your words are the small signal and the actions on your PC are the big circuit.

## What it can do

| Area | Examples |
| --- | --- |
| **WhatsApp** | "message Amma that I'll be late", "WhatsApp Ravi: bring the DSP record tomorrow" |
| **Email** | "email Ravi sir asking for leave on Friday", "mail hr@company.com about the internship" |
| **PC controls** | "volume 30", "mute", "next song", "brightness up", "turn off Bluetooth", "lock my PC", "shut down in 10 minutes", "cancel the shutdown" |
| **Screen** | "what's on my screen?", "explain this error", "take a screenshot" |
| **Read files** | "summarise my DSP notes PDF", "what's the deadline in the assignment doc?", "find the file that talks about Fourier" |
| **Memory** | "remember my lab exam is on Friday", "Amma's number is 98765 43210", "what do you remember?" |
| **Reminders** | "remind me in 20 minutes to drink water", "remind me at 5 to call home", "remind me every day at 9 to check mail" |
| Folders | "make a folder called DSP notes on the desktop" |
| Organize | "sort my Downloads folder" → Images, PDFs, Documents, Videos, Audio, Archives, Installers, Code, Others |
| Move / rename / delete | "move all PDFs from Downloads to Documents/College", "rename report.pdf to final report" (Recycle Bin only) |
| Find | "find my resume", "where is the DSP lab report?" |
| Apps & web | "open WhatsApp", "open VS Code", "search YouTube for Arduino projects" |
| Questions | "what is a Fourier transform?" |
| Undo | "undo that", or the **Undo** button next to any file change |

**Voice:** press the mic (or `Ctrl+M`), speak, and pause. Relay shows what it heard so you can fix it before it runs. Spoken commands get a short spoken reply.

### How sending works
- **Nothing is ever sent without you seeing it first.** Relay shows the exact message or email with **Send** and **Cancel**.
- **WhatsApp** uses the WhatsApp Desktop app (install it from the Microsoft Store and log in once).
  - If Relay knows the person's number, it opens their chat with the message typed in.
  - If it only knows a name, it finds WhatsApp's search box on screen, clicks it and searches your chats. It checks that the name really went into the search box before going on.
  - Before pressing Enter, Relay takes a screenshot and checks two things: that the right chat is open and that the message is in the box. If anything looks wrong, it stops and sends nothing.
  - Saving people's numbers ("Amma's number is …") makes sending faster and more reliable.
- **Email:**
  - **Without setup**, Relay writes the email and opens it in Gmail for you to press Send.
  - **To let Relay send emails itself:** open **Settings → Sending email**, then add your Gmail (or college Google) address and an *app password*. Turn on 2-Step Verification first, then create the password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords). It's stored encrypted, like the API key.

### Reminders
Reminders pop up as Windows notifications, even when Relay is hidden in the tray. If the PC was off at the time, they show up when Relay next starts. You can see and delete everything Relay remembers (contacts, facts and reminders) in **Settings → What Relay remembers**.

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

**Easiest:** run **`Relay-Setup-2.0.2.exe`**. It installs in a few seconds, adds a desktop and Start menu shortcut, and opens Relay.

> Windows may show **"Windows protected your PC"** because the installer isn't code-signed (signing certificates are paid). Click **More info → Run anyway**.

On first launch, paste a free Gemini key from **https://aistudio.google.com/apikey** and click **Connect**.

### Everyday use
- **Ctrl+Shift+Space**: show or hide Relay from anywhere.
- **Ctrl+Shift+M**: open Relay and start listening.
- Closing the window keeps Relay running in the **system tray** (the ^ arrow near the clock). Right-click the tray icon for **Start listening**, **Start with Windows** and **Quit Relay**.
- Relay **starts with Windows** by default and waits quietly in the tray. Turn this off in Settings or the tray menu.
- **Instant commands** run immediately without asking Gemini (and work offline or when the free limit is used up): `open whatsapp`, `open downloads`, `open youtube`, `search youtube for …`, `google …`, `sort my downloads`, `make a folder called …`, `undo`, `volume up`, `volume 40`, `mute`, `pause`, `next song`, `brightness 70`, `lock`, `take a screenshot`, `battery`.

### Past conversations
Every chat is saved **only on this PC** and listed in the sidebar (**Ctrl+B** to show or hide), grouped by Today, Yesterday and so on. Click a chat to see it again and **carry on**, since Relay restores what it remembered. Search past commands, hover a chat and click the bin twice to delete it, or delete everything in Settings.

### Run from source (for development)
```
npm install        # also after updating, to get new dependencies
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
- **Messages and emails** show the exact text and wait for **Send**. Shut down, restart, sleep and sign out also ask first.
- Relay only presses keys in WhatsApp when WhatsApp is the window in front, and it puts your clipboard back afterwards.
- Deleting only sends files to the **Recycle Bin**.
- Relay refuses to touch `C:\Windows`, `Program Files`, `ProgramData`, `AppData` and whole drives.
- File changes can be undone with the **Undo** button.
- Your API key is stored **encrypted** with Windows' built-in protection.
- Privacy: commands and file *names* are sent to Gemini to decide what to do. Some things are sent to Gemini **only when you ask for them**:
  - a **file's contents**, when you ask about that file;
  - a **screenshot**, when you ask about your screen;
  - a **screenshot of WhatsApp**, when Relay checks a message before sending it.

  Your memory, contacts and reminders are stored only on this PC. Relay includes them in its instructions to Gemini so it can use them. On Gemini's free tier, Google may use requests to improve its models.

## Project structure

```
relay/
├── main.js            Electron main process: window, tray, startup, shortcuts, connects UI ↔ agent
├── preload.js         The safe bridge the UI uses to talk to main.js
├── src/
│   ├── agent.js       Gemini loop: tool calling, approvals, retries, voice transcription
│   ├── quick.js       Instant commands that skip Gemini (open app/site/folder, search, sort, new folder, undo)
│   ├── history.js     Saves past conversations on this PC
│   ├── tools.js       File, app and web tools (with plan + undo); adds the tools below
│   ├── system.js      Volume, music, brightness, Wi-Fi/Bluetooth, power, screenshots, battery, looking at the screen
│   ├── messaging.js   WhatsApp (with a screen check before sending) and email
│   ├── memory.js      Facts, contacts and reminders (memory.json, only on this PC)
│   ├── reader.js      Reads PDF, Word, PowerPoint, Excel and text files; searches inside documents
│   ├── winps.js       Runs PowerShell safely (inputs as environment variables) + shared Windows helpers
│   ├── apps.js        Finds installed apps via Windows' Start menu list
│   ├── paths.js       Turns "Desktop/DSP notes" into real paths, blocks system folders
│   └── settings.js    Saves settings; encrypts the API key and email app password
├── renderer/
│   ├── index.html     The window
│   ├── styles.css     The design
│   ├── app.js         UI logic: steps, approvals, mic, settings
│   └── recorder.js    Mic recording, live waveform, auto-stop on pause
├── build/icon.png     App icon used by the installer
└── test/              Tests for tools, agent loop, instant commands, app matching, and the v2 abilities (npm test)
```

## Adding a new ability

1. Add a tool to `src/tools.js` with a clear `description`. Gemini reads it to decide when to use the tool.
2. If it changes files, set `confirm: true` and write a `plan()`.
3. Add a friendly title for it in `TOOL_TITLES` in `renderer/app.js`.

Ideas for later: a wake word ("Hey Relay"), Telegram and Instagram messages, Google Calendar, and reading replies aloud.

## Tests

```
npm test
```
