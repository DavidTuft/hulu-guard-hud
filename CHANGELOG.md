# Changelog

All notable changes to HuluGuard HUD will be documented here.

This project is versioned by script header `@version` in `src/hulu-guard-hud.user.js`.

We use this format:
- `Added` for new user-facing features
- `Changed` for behavior / UI changes
- `Fixed` for bug fixes
- `Security` for security-impacting fixes

---

## [6.8.2] - Initial public release
### Added
- Floating HUD with draggable head bar and snap-to-grid docking.
- PiP mini-HUD that shows basic status when the video element enters Picture-in-Picture.
- Centralized timing/easing constants via `TIMING`, exposed to CSS via vars like `--hg-med`, etc.
- Live theme engine with synced RGB/HSL sliders and alpha sliders:
  - Button alpha
  - Panel alpha
  - Global HUD opacity dimmer
- Keybind capture UI (multi-step chords like `Ctrl+Alt+KeyS > KeyK`, etc.).
- Stats panel:
  - Session ad pod durations
  - Little “oscilloscope”-style canvas bars
  - Copy-to-clipboard of session analytics
- Boundary protection:
  - Tracks last completed ad pod
  - Blocks scrubbing *before* that boundary so you don’t get thrown back into ads you already watched by accident
- Layout & Design panel:
  - Snap-to-grid toggle and grid density
  - Dock strength / align threshold
  - Group-drag (drag one window, other HUD panels move as a cluster)

### Changed
- HUD opacity, panel opacity, and button opacity now animate with consistent easing and are tied to the same timing constants.
- Backdrop + ESC key now clean-close Settings / Stats.
- Panels remember position in `localStorage` and re-clamp to viewport on resize.

### Fixed
- Inputs in Settings are now fully editable (no more “readonly” weirdness).
- Opacity sliders and number boxes stay in sync both directions.
- Rebinding hotkeys no longer accidentally leaks to the page video player while capturing.

### Security / Safety
- Explicitly does **not** skip or fast-forward ads.
- Explicitly does **not** try to hide/mute ad elements.
- Explicit language around ToS risk added to DISCLAIMER.md.
