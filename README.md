# HuluGuard HUD

A draggable, themeable HUD overlay for Hulu’s web player with:
- Rewind boundary guard so you don’t get thrown back into an ad break you already watched
- Snap-to-grid docking
- Group-drag of panels
- PiP mini HUD
- Live RGB/HSL theming + alpha sliders
- Session stats / ad pod timeline


**This script does NOT skip, block, mute, or fast-forward ads.**  
It only prevents accidental scrubbing *backward into* an ad pod you already fully watched.

---

## 🔒 What this is (and is not)

**Is:**
- A floating control panel you can drag anywhere.
- A visual theme lab (custom color, brightness, opacity).
- A “please don’t dump me back into that ad block I already saw” safety catch.
- A little analytics canvas that plots how long each ad pod was.
- QoL for PiP (mini HUD appears while Hulu is Picture-in-Picture).

**Is NOT:**
- An ad blocker.
- DRM bypass.
- A tool to steal paid features from Hulu tiers you don’t pay for.

See `DISCLAIMER.md` for the full legal / ethics note.

---

## ✨ Features

### 1. HUD Overlay
- Toggleable HUD with live session info (current timestamp, whether you’re in an ad pod, last ad boundary, etc).
- Opacity fades when idle, wakes on interaction.
- Position is remembered in `localStorage`.

### 2. Theme Engine
- Sliders for Hue / Saturation / Luminosity and direct RGB control.
- Separate alpha sliders:
  - Button α
  - Panel α
  - Global HUD opacity (acts like a master dimmer)
- All transitions share the same easing curve and timing constants.

### 3. Snap / Dock / Group Drag
- Windows (HUD, Settings, Stats) snap to a grid you control.
- They “dock” to edges or to each other with magnetic behavior.
- You can drag one window and have the others follow as a cluster.
- Thresholds and grid density are tunable in Settings → “Layout & Design”.

### 4. PiP mini HUD
- When Hulu’s `<video>` enters Picture-in-Picture, a compact HUD shows status.
- When PiP exits, it goes away.

### 5. Stats Panel
- Shows total number of ad pods the session has encountered and average pod length.
- Renders a small “bar chart” canvas of ad durations.
- Has a “Copy” button to copy structured JSON so you can share debugging info.

### 6. Keybind Capture UI
- Every hotkey (toggle HUD, open settings, micro-skip left/right, etc.) can be rebound from inside the panel.
- Supports multi-step sequences like `Ctrl+Alt+KeyH > KeyX`.
- Capture mode explains itself and doesn’t leak your keystrokes to Hulu while you’re rebinding.

---

## ⏮ Ad Boundary Guard (Important)

Hulu sometimes forces you to rewatch an ad pod if you scrub behind it.

This script:
- Tracks the timestamp right after the last fully watched ad pod.
- If you try to scrub/jump behind that point, it bumps you forward to just after the ad.
- Shows a small banner (“⏮️ Ad boundary”) so you know what happened.

It **does not** fast-forward past ads you haven’t already watched.
It **does not** auto-skip ads.
It **does not** try to mute or hide ads.

---

## 🧪 How to install

You’ll need a userscript manager extension like Tampermonkey or Violentmonkey.

1. Install a userscript manager (Chrome/Edge/Firefox all support this).
2. In this repo, open:  
   `src/hulu-guard-hud.user.js`
3. Click the “Raw” button.
4. Your userscript manager should offer to install it.

If it doesn’t auto-offer:
- Copy the entire file.
- In Tampermonkey: Create new script → paste → save.

That’s it. Reload Hulu.

---

## 🔧 Settings Panel

Open the panel (default is `Alt+S`, but keybinds are user-editable).

Tabs/sections in the Settings panel:
- **HUD** – visibility on launch, idle fade timing, global opacity.
- **Theme** – RGB/HSL/alpha sliders, live preview.
- **Layout & Design** – grid snapping, dock strength, align threshold, group drag behavior.
- **Keybinds** – click any binding to redefine it.
- **General** – “rewind tolerance,” “post-ad lock,” and micro-skip size.

All values are saved in `localStorage`. No server, no telemetry.

---

## 🛡 Disclaimer / Terms

- This project is not affiliated with Hulu.
- Using custom scripts on streaming services can violate Terms of Service.
- You are responsible for your own account and your own risk.
- See `DISCLAIMER.md` for the full statement.
- See `SECURITY.md` for how to privately contact about ToS concerns or report a security issue.

If you represent Hulu and there’s something here you don’t like, reach out. We’ll act in good faith.

---

## 🤝 Contributing

We happily take:
- UI/UX polish
- Cross-browser fixes
- Accessibility improvements
- Bug reports

We will not merge:
- Ad skipping
- Ad removal / hiding
- Anything that interferes with Hulu’s monetization

Please read `CONTRIBUTING.md` before opening PRs.

---

## 📜 License

MIT. See `LICENSE` for details.
