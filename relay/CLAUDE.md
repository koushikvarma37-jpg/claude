# Relay: product standard

Relay is Teja Varma's AI desktop agent for Windows (Electron + Gemini). Read this before changing anything.

## The bar
Relay must feel so good that the user wants to use it for **every task on their computer**. Every change is judged against that.

- **It understands.** Any natural phrasing works, including messy speech with an Indian English accent. Never hard-code phrases; add general tools and clear tool descriptions instead. When unsure, ask one short question instead of guessing.
- **It does the job, every time.** A command either completes correctly or says clearly what went wrong and how to fix it. Never claim success a tool didn't report.
- **It's fast.** Instant feedback on every keypress and click; show progress within ~100 ms; keep round-trips to Gemini to a minimum.
- **It's comfortable.** Calm, polished UI with smooth motion, clear states (listening, thinking, working, needs approval, done), and no clutter. Keyboard-first, with voice that just works.
- **It's trustworthy.** Anything that moves, renames or deletes shows exactly what will change, waits for approval, and can be undone. System folders stay blocked. File contents are never uploaded unless asked.
- **It's always there.** One shortcut away from anywhere in Windows.

## Before shipping any change
- `npm test` passes; add tests for new tools and edge cases.
- Check the UI in every state (empty, onboarding, running, approval, error, settings, listening) at small and large window sizes.
- Error messages say what happened and what to do, in plain words.
- Write copy from the user's side: "Moved 12 PDFs to College", not tool or API jargon.
