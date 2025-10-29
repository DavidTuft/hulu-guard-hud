# Contributing to HuluGuard HUD

First: thank you for even being here.

This project exists to give the user:
- A floating, themeable HUD (color sliders, opacity sliders, PiP mini-HUD).
- Snap-to-grid / docking / group-drag UI ergonomics on top of Hulu’s player.
- A rewind guard preventing jumps *back into* ad pods that already ran.

It is **not** an ad blocker and will not become one.

---

## Ways to help
- Bug reports (UI broken, panel can’t drag, opacity sync off, etc.)
- Cross-browser testing (Chrome, Firefox, etc.)
- Code cleanup / modularization
- Accessibility improvements (contrast, keyboard nav, reduced motion)
- Docs/readme improvements

Security research is welcome (see SECURITY.md).

---

## Coding style / goals
- No frameworks. Just plain JS, DOM, CSS-in-JS.
- Keep everything self-contained in one userscript file under `src/`.
- Avoid external network calls, bundlers, or CDNs. The script should be auditable.
- Keep variable names descriptive enough that a normal user can read it.
- Minimize random console spam in final builds.

Animations / timing:
- We centralize durations/easings in a `TIMING` object and expose them.
- Try to reuse those instead of hardcoding new `transition: ...ms`.

Storage:
- User settings are saved in `localStorage` under explicit keys.
- If you add new settings, give them safe defaults and include them in README.

Keyboard:
- All hotkeys must be user-rebindable through the in-script settings panel.
- Don’t hardwire global keydowns that can’t be turned off.

---

## What we will not merge
To keep everyone (including you) out of trouble, PRs will be closed if they:
- Skip, mute, or auto-fast-forward ads.
- Auto-seek past ads.
- Attempt to hide or suppress ad elements in the DOM.
- Interfere with Hulu account/plan enforcement.
- Break Hulu’s revenue model.

Please do **not** submit that. We can’t accept it.

---

## Submitting a pull request
1. Fork the repo.
2. Create a branch:  
   `feat/dock-tweaks`, `bugfix/firefox-drag`, etc.
3. Make your changes.
4. Update CHANGELOG.md under an `[Unreleased]` heading describing what changed.
5. Open a PR with:
   - What you changed and why.
   - Manual test notes (browser, OS, steps).
   - Screenshot/GIF if it's visual.

We’ll review mostly for:
- Safety / ToS line
- UX consistency
- Doesn’t explode on normal Hulu pages

If you’re not sure if something is “too spicy,” open an issue first and ask.

---

## License on contributions
By submitting code, you agree your contribution is released under the MIT License that this repo uses.
