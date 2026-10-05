# 🪐 Teja Varma · Mission Control

Personal portfolio of **Teja Varma**, a 3rd-year ECE student at Vishnu Institute of Technology exploring AI and building **Orbit**, an AI-powered desktop agent.

The site is a single self-contained `index.html` with no build step and no dependencies.

## ✨ Features

- 🚀 Boot-sequence intro and an interactive starfield (parallax + shooting stars)
- 🛰️ **Orbit mission console**: a simulated terminal where visitors can "command" Orbit
- 🪐 Skills shown as a solar system that orbits around you (hover to pause)
- 🗺️ Missions timeline: SIH, Hacker House Goa 2026, Mitra Club, Orbit
- 🏏 Off-duty section with a cricket scoreboard ("Hit a six!") and a movie reel
- 📱 Fully responsive, and respects reduced-motion settings

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
| Typing roles in the hero | `const roles = [...]` in the script |
| Orbit terminal demo replies | `const scripts = {...}` in the script |
| Skills and their stages | `<section id="skills">` |
| New hackathons and achievements | Add a `.t-item` block in `<section id="missions">` |
| Colours | CSS variables in `:root` at the top |

Once Orbit has its own GitHub repo, update the "Follow the build on GitHub" link in `<section id="orbit">` to point to it.
