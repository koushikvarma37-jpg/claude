# Teja Varma · TV-26 Datasheet

Personal portfolio of **Teja Varma**, a 3rd-year ECE student at Vishnu Institute of Technology exploring AI and building **Orbit**, an AI-powered desktop agent.

The site is a single `index.html` with no build step. It loads fonts from Google Fonts and GSAP from cdnjs.

## ✨ Features

- Designed as an electronics datasheet for part **TV-26**, with numbered datasheet sections
- **Paper / Scope modes**: a printed spec sheet or a dark oscilloscope screen, switched with a circular wipe
- Live oscilloscope hero: a square wave built from Fourier harmonics (hover to control the harmonics)
- **Orbit console**: a simulated app where commands flow through Command → Understand → Plan → Execute
- Skills as a 14-pin IC pinout (pin 7 GND, pin 14 VCC, like 74-series logic)
- Scroll-driven transitions with GSAP; everything stays visible if scripts fail to load
- Responsive; with reduced motion on, animations slow down and become fades instead of switching off

## ▶️ View locally

Open `index.html` in any browser.

## 🌐 Publish free with GitHub Pages

1. Push this repo to GitHub.
2. Go to **Settings → Pages**.
3. Under **Source**, choose **Deploy from a branch**, then pick your branch and `/ (root)`.
4. Your site goes live at `https://<username>.github.io/<repo>/`.

## ✏️ Updating content

Everything lives in `index.html`:

| What to change | Where to look |
| --- | --- |
| Orbit terminal demo replies | `const scripts = {...}` in the script |
| Skills (chip pins) | `const pins = [...]` in the script |
| New hackathons and achievements | Add a `.run` block in `<section id="log">` |
| Colours | CSS variables in `:root` (paper) and `[data-theme="dark"]` (scope) |

Once Orbit has its own GitHub repo, update the "Follow on GitHub" link in `<section id="orbit">` to point to it.
