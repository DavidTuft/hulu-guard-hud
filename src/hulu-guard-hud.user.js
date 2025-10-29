// ==UserScript==
// @name         Hulu Guard HUD
// @namespace    https://github.com/yourname/hulu-guard-hud
// @version      6.8.2
// @description  Floating playback HUD for Hulu: draggable overlay, PiP mini panel, theming, snap-grid docking, session stats, and accidental ad re-entry guard. Does NOT skip or block ads.
// @match        *://*.hulu.com/*
// @run-at       document-end
// @grant        none
// @license      MIT
//
// LEGAL / POLICY NOTE:
// This tool does not skip, mute, remove, hide, fast-forward past, or block Hulu advertisements.
// Hulu still chooses when, how long, and how often ads play.
// The HUD only tries to prevent the player from jumping BACKWARD into an ad segment
// that has ALREADY finished, so you don't get forced to re-watch something you already saw.
// This is a usability overlay, not an ad blocker.
// This project is unaffiliated with Hulu.
//
// Full disclaimer: see /DISCLAIMER.md in the repository.
// ==/UserScript==

/* eslint-disable no-var, prefer-const */
(function () {
  "use strict";

  /**************************************************************************
   * CONFIG & STATE
   **************************************************************************/
  const KEY_SETTINGS = "HGv682_Settings";
  const KEY_POS      = "HGv682_Pos";

  const DEFAULTS = {
    HUD_ON_LAUNCH: true,
    HUD_OPACITY: 1.0,
    HUD_IDLE_FADE_SEC: 10,
    HUD_IDLE_OPACITY: 0.35,
    REWIND_TOLERANCE_SEC: 3,
    POST_AD_LOCK: 10,
    MICRO_SKIP_SEC: 2,

    // THEME CORE
    RGB: { r: 41, g: 211, b: 41 },
    HSL: { h: 120, s: 80, l: 49 },
    BTN_OPACITY: 0.3,
    PANEL_OPACITY: 0.72,

    KEYS: {
      toggleHUD: "Ctrl+Alt+KeyH",
      stats: "Ctrl+Alt+KeyS",
      microBack: "Alt+ArrowLeft",
      microFwd: "Alt+ArrowRight",
      openSettings: "Alt+KeyS",
    },
  };

  // ─────────────────────────────────────────────────────────────
  // Global motion/timing — single source of truth
  // ─────────────────────────────────────────────────────────────
  const TIMING = {
    fast: 120,
    med:  180,
    slow: 300,
    ease: "cubic-bezier(0.22, 0.61, 0.36, 1)",
  };

  (function injectTimingVars(){
    const t = document.createElement("style");
    t.textContent = `
      :root{
        --hg-fast: ${TIMING.fast}ms;
        --hg-med:  ${TIMING.med}ms;
        --hg-slow: ${TIMING.slow}ms;
        --hg-ease: ${TIMING.ease};
      }
    `;
    document.head.appendChild(t);
  })();

  const fadeOut = (e, ms = TIMING.med) => {
    e.style.opacity = "1";
    requestAnimationFrame(() => {
      e.style.transition = `opacity ${ms} var(--hg-ease)`;
      e.style.opacity = "0";
      setTimeout(() => {
        e.style.display = "none";
        e.style.transition = "";
        e.style.opacity = "";
      }, ms);
    });
  };

  const safeParse = (s, f) => { try { return JSON.parse(s); } catch { return f; } };

  let settings = { ...DEFAULTS, ...safeParse(localStorage.getItem(KEY_SETTINGS), {}) };
  settings.KEYS = { ...DEFAULTS.KEYS, ...(settings.KEYS || {}) };
  settings.RGB  = { ...DEFAULTS.RGB,  ...(settings.RGB  || {}) };
  settings.HSL  = { ...DEFAULTS.HSL,  ...(settings.HSL  || {}) };
  if (typeof settings.BTN_OPACITY   !== "number") settings.BTN_OPACITY   = DEFAULTS.BTN_OPACITY;
  if (typeof settings.PANEL_OPACITY !== "number") settings.PANEL_OPACITY = DEFAULTS.PANEL_OPACITY;
  const save = () => localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings));

  // runtime
  let video = null, inAd = false, adStart = 0, lastAdEnd = 0, ignoreSeek = false;
  let HUD_VISIBLE = !!settings.HUD_ON_LAUNCH, idleTimer = null, isCapturing = false;
  let seqProg = {}, analytics = [], pipMiniHUD = null, statsAnimHandle = null;

  /**************************************************************************
   * UTILITIES
   **************************************************************************/
  const clampNum = (v, lo, hi) => {
    v = Number(v); if (!Number.isFinite(v)) return lo;
    return Math.max(lo, Math.min(hi, v));
  };
  const el = (t, css, txt) => {
    const e = document.createElement(t);
    if (css) e.style.cssText = css;
    if (txt != null) e.textContent = txt;
    return e;
  };

  const showBrief = (e, txt) => {
    e.textContent = txt;
    e.style.display = "block";
    e.style.opacity = "1";
    clearTimeout(e._t);
    e._t = setTimeout(() => fadeOut(e, 180), 1200);
  };

  const isModKeyCode = (c) => [
    "ShiftLeft","ShiftRight","ControlLeft","ControlRight","AltLeft","AltRight","MetaLeft","MetaRight"
  ].includes(c);

  const fmtChord = (e) => {
    const p = [];
    if (e.ctrlKey) p.push("Ctrl");
    if (e.altKey) p.push("Alt");
    if (e.shiftKey) p.push("Shift");
    p.push(e.code);
    return p.join("+");
  };

  const parseSeq = (s) => (s || "").split(">").map(v => v.trim()).filter(Boolean);
  const resetSeq = (k) => {
    if (!seqProg[k]) seqProg[k] = { i: 0, t: null };
    clearTimeout(seqProg[k].t);
    seqProg[k].i = 0; seqProg[k].t = null;
  };
  const stepSeq = (e, str, k, cb) => {
    const st = parseSeq(str);
    if (!st.length) return false;
    if (!seqProg[k]) seqProg[k] = { i: 0, t: null };
    const ch = fmtChord(e), i = seqProg[k].i;
    if (ch === st[i]) {
      if (i + 1 === st.length) { cb(); resetSeq(k); return true; }
      seqProg[k].i++;
      clearTimeout(seqProg[k].t);
      seqProg[k].t = setTimeout(() => resetSeq(k), 1200);
      return true;
    }
    if (ch === st[0]) {
      seqProg[k].i = 1;
      clearTimeout(seqProg[k].t);
      seqProg[k].t = setTimeout(() => resetSeq(k), 1200);
      return true;
    }
    resetSeq(k); return false;
  };

  /**************************************************************************
   * COLOR MATH (RGB <-> HSL) + helpers
   **************************************************************************/
  function rgbToHsl(r, g, b) {
    r/=255; g/=255; b/=255;
    const max=Math.max(r,g,b), min=Math.min(r,g,b);
    let h, s, l=(max+min)/2;
    if (max===min) { h=s=0; }
    else {
      const d=max-min;
      s = l>0.5 ? d/(2-max-min) : d/(max+min);
      switch(max){
        case r: h=(g-b)/d+(g<b?6:0); break;
        case g: h=(b-r)/d+2; break;
        case b: h=(r-g)/d+4; break;
      }
      h/=6;
    }
    return { h:Math.round(h*360), s:Math.round(s*100), l:Math.round(l*100) };
  }
  function hslToRgb(h, s, l) {
    h = clampNum(h,0,360)/360; s = clampNum(s,0,100)/100; l = clampNum(l,0,100)/100;
    if (s===0){ const v=Math.round(l*255); return {r:v,g:v,b:v}; }
    const hue2rgb=(p,q,t)=>{ if(t<0)t+=1; if(t>1)t-=1;
      if(t<1/6) return p+(q-p)*6*t;
      if(t<1/2) return q;
      if(t<2/3) return p+(q-p)*(2/3-t)*6;
      return p;
    };
    const q=l<0.5?l*(1+s):l+s-l*s, p=2*l-q;
    return {
      r:Math.round(hue2rgb(p,q,h+1/3)*255),
      g:Math.round(hue2rgb(p,q,h)*255),
      b:Math.round(hue2rgb(p,q,h-1/3)*255),
    };
  }
  const syncFromRGB = () => { settings.HSL = rgbToHsl(settings.RGB.r, settings.RGB.g, settings.RGB.b); };
  const syncFromHSL = () => { settings.RGB = hslToRgb(settings.HSL.h, settings.HSL.s, settings.HSL.l); };
  const rgbToHex = (rgb) => {
    const toHex = (n)=>clampNum(n,0,255).toString(16).padStart(2,"0");
    return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
  };
  const rgbaStr = (rgb, a) => `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`;
  const adjustRGB = (rgb, d) => ({ r:clampNum(rgb.r+d,0,255), g:clampNum(rgb.g+d,0,255), b:clampNum(rgb.b+d,0,255) });

  /**************************************************************************
   * THEME ENGINE (one stylesheet)
   **************************************************************************/
  const styleTag = document.createElement("style");
  document.head.appendChild(styleTag);

    function rebuildTheme() {
        syncFromRGB();

        const baseRGB = settings.RGB;
        const baseHex = rgbToHex(baseRGB);
        const txtRGB  = adjustRGB(baseRGB, 60);
        const dimRGB  = adjustRGB(baseRGB, -40);

        // Use raw sliders — NO hard minimums
        const btnAlpha   = clampNum(settings.BTN_OPACITY,   0, 1);
        const panelAlpha = clampNum(settings.PANEL_OPACITY, 0, 1);
        const hudAlpha   = clampNum(settings.HUD_OPACITY,   0, 1);

        // Fills driven purely by panelAlpha
        const btnBgFill    = rgbaStr(dimRGB, btnAlpha);
        const btnHoverFill = rgbaStr(baseRGB, Math.min(btnAlpha + 0.1, 1));
        const panelFill    = `rgba(0,0,0,${panelAlpha})`;

        styleTag.textContent = `
    /* ───────────────── Buttons / Inputs ───────────────── */
    .hg-btn{
      background:${btnBgFill}!important; border:1px solid ${baseHex}!important;
      color:${rgbToHex(txtRGB)}!important; font-size:12px; padding:2px 7px; border-radius:6px;
      cursor:pointer; font-family:monospace;
      transition: background var(--hg-med) var(--hg-ease), border-color var(--hg-med) var(--hg-ease), color var(--hg-med) var(--hg-ease), transform var(--hg-fast) var(--hg-ease);
    }
    .hg-btn:hover{ background:${btnHoverFill}!important; color:#000!important; }
    .hg-btn:active{ transform:translateY(1px); }

    .hg-input,
    .hg-input[type="number"],
    .hg-input[type="text"],
    .hg-input[type="range"]{
      background:${btnBgFill}!important; color:${rgbToHex(txtRGB)}!important; border:1px solid ${baseHex}!important;
      border-radius:6px!important; padding:4px 6px!important; outline:none!important; font-size:12px; font-family:monospace;
      transition: background var(--hg-med) var(--hg-ease), border-color var(--hg-med) var(--hg-ease), color var(--hg-med) var(--hg-ease);
    }
    .hg-input:focus{ border:2px solid ${baseHex}!important; box-shadow:0 0 8px ${baseHex}40!important; }
    .hg-input[type=number]::-webkit-inner-spin-button,
    .hg-input[type=number]::-webkit-outer-spin-button{ -webkit-appearance:none; appearance:none; margin:0; }
    .hg-input[type=number]{ -moz-appearance:textfield; }

    .hg-checkbox{ accent-color:${baseHex}!important; width:16px; height:16px; }

    /* Sliders */
    .hg-rowwrap{ display:flex; align-items:center; gap:6px; margin:4px 0; font-family:monospace; font-size:12px; color:${rgbToHex(txtRGB)}; }
    .hg-row-left{ display:flex; align-items:center; min-width:70px; color:${rgbToHex(txtRGB)}; }
    .hg-row-mid{ flex:1; display:flex; align-items:center; gap:6px; }
    .hg-row-mid .hg-slider{
      -webkit-appearance:none; width:120px; height:4px; border-radius:3px; background:${btnBgFill}; border:1px solid ${baseHex}; cursor:pointer;
      transition: background var(--hg-med) var(--hg-ease), border-color var(--hg-med) var(--hg-ease);
    }
    .hg-row-mid .hg-slider::-webkit-slider-thumb{
      -webkit-appearance:none; appearance:none; width:14px; height:14px; border-radius:4px; background:${btnHoverFill}; border:1px solid ${baseHex}; cursor:pointer;
    }
    .hg-row-mid .hg-slider::-moz-range-track{ width:120px; height:4px; border-radius:3px; background:${btnBgFill}; border:1px solid ${baseHex}; }
    .hg-row-mid .hg-slider::-moz-range-thumb{ width:14px; height:14px; border-radius:4px; background:${btnHoverFill}; border:1px solid ${baseHex}; cursor:pointer; }
    .hg-row-val{ display:flex; flex-direction:column; min-width:50px; text-align:right; font-family:monospace; font-size:12px; color:${rgbToHex(txtRGB)}; }

    .hg-color-preview{ width:40px; height:28px; border-radius:6px; border:2px solid ${baseHex}; background: rgb(${baseRGB.r},${baseRGB.g},${baseRGB.b}); box-shadow:0 0 8px ${baseHex}40; }

    /* ───────────────── Panels / HUD — all tied to panelAlpha ───────────────── */
    .hg-hud,
    .hg-panel,
    .hg-stats,
    .hg-keyhelp,
    .hg-mini,
    .hg-section,
    .hg-sec-body,
    .hg-dropdown-container{
      background:${panelFill}!important;
      border:1px solid ${baseHex}!important;
      border-radius:10px;
      color:${rgbToHex(txtRGB)}!important;
      transition: background var(--hg-med) var(--hg-ease), border-color var(--hg-med) var(--hg-ease), color var(--hg-med) var(--hg-ease), opacity var(--hg-med) var(--hg-ease);
    }
    .hg-keyhelp{ border-radius:8px; padding:10px 14px; }
    .hg-mini{ border-radius:8px; padding:4px 8px; }

    /* Main HUD's element opacity uses HUD_OPACITY (set live in applyThemeLive) */
    .hg-hud{ box-shadow:0 8px 24px rgba(0,0,0,0.35); }

    .hg-banner{ background:rgba(0,0,0,0.78); color:#fff; border-radius:8px; font-family:monospace; font-size:14px; }
    .hg-text-themed{ color:${rgbToHex(txtRGB)}!important; font-family:monospace; }
    .hg-hr{ border-color:${rgbaStr(dimRGB, btnAlpha)}!important; }
    .hg-canvas{ border:1px solid ${baseHex}!important; background:${panelFill}!important; border-radius:6px; }

    .hg-backdrop{ position:fixed; inset:0; background:rgba(0,0,0,0.4); z-index:2147483646; display:none; }

    /* ───────────────── Dropdowns (select + custom) follow Panel α ───────────────── */
    select.hg-input, .hg-select, .hg-dropdown, option {
      background:${panelFill}!important; color:${rgbToHex(txtRGB)}!important; border:1px solid ${baseHex}!important;
      border-radius:6px!important; font-family:monospace!important; font-size:12px!important;
      transition: background var(--hg-med) var(--hg-ease), border-color var(--hg-med) var(--hg-ease), color var(--hg-med) var(--hg-ease);
    }
    select.hg-input:focus, .hg-select:focus { border:2px solid ${baseHex}!important; box-shadow:0 0 8px ${baseHex}40!important; }
  `;

        // also expose the live vars so JS can tweak instantly
        document.documentElement.style.setProperty("--panel-opacity", String(panelAlpha));
        document.documentElement.style.setProperty("--hud-opacity",   String(hudAlpha));
        document.documentElement.style.setProperty("--btn-opacity",   String(btnAlpha));
    }
    rebuildTheme();



    // Enforce identical fade rates across HUD, panels, dropdowns
    (function unifyFadeRates(){
        const fadeStyle = document.createElement("style");
        fadeStyle.textContent = `
    .hg-hud,
    .hg-panel,
    .hg-stats,
    .hg-mini,
    .hg-keyhelp,
    .hg-dropdown,
    .hg-select,
    .hg-dropdown-container,
    .hg-section,
    .hg-sec-body {
      transition:
        background var(--hg-med) var(--hg-ease),
        border-color var(--hg-med) var(--hg-ease),
        color var(--hg-med) var(--hg-ease),
        opacity var(--hg-med) var(--hg-ease) !important;
    }
  `;
        document.head.appendChild(fadeStyle);
    })();

function fixMainHUDAlpha() {
  const baseRGB    = settings.RGB;
  const txtRGB     = adjustRGB(baseRGB, 60);
  const panelAlpha = clampNum(settings.PANEL_OPACITY, 0.1, 1);
  const hudAlpha   = clampNum(settings.HUD_OPACITY, 0.1, 1);
  const btnA       = clampNum(settings.BTN_OPACITY, 0.05, 1);

  // nonlinear brightness curve — matches dropdown highlight curve
  const btnLumScale = Math.pow(btnA, 1.35);
  const mixA = btnA * panelAlpha;

  // minimum visible outline brightness even when btnA → 0.05
  const floorAlpha = 0.25; // ensures faint green glow remains
  const borderAlpha = Math.max(mixA * 0.6, floorAlpha * 0.6);
  const bgAlpha = Math.max(mixA, floorAlpha * 0.75);

  let css = `
    /* ── Main HUD Panel ───────────────────────────────────────────── */
    .hg-hud {
      background: rgba(0,0,0,${panelAlpha}) !important;
      border-color: rgba(${baseRGB.r},${baseRGB.g},${baseRGB.b},${panelAlpha * 0.6}) !important;
      opacity: ${hudAlpha} !important;
      transition: background 0.25s ease, border-color 0.25s ease, opacity 0.25s ease;
    }

    .hg-hud .hg-text-themed,
    .hg-hud #hg-info {
      color: rgba(${txtRGB.r}, ${txtRGB.g}, ${txtRGB.b}, ${Math.min(1, panelAlpha * 1.2)}) !important;
      transition: color 0.25s ease;
    }

    .hg-hud * {
      border-color: rgba(${baseRGB.r}, ${baseRGB.g}, ${baseRGB.b}, ${panelAlpha * 0.6}) !important;
    }

    /* ── Buttons: retain outline + soft tint even at low alpha ───────────── */
    .hg-btn, .hg-btn svg, .hg-btn span,
    .hg-hud button, .hg-topbar button {
      background: rgba(
        ${Math.round(baseRGB.r * btnLumScale)},
        ${Math.round(baseRGB.g * btnLumScale)},
        ${Math.round(baseRGB.b * btnLumScale)},
        ${bgAlpha}
      ) !important;
      color: ${btnA > 0.45 ? "rgba(0,0,0,1)" : "rgba(255,255,255,0.95)"} !important;
      border: 1px solid rgba(
        ${baseRGB.r},
        ${baseRGB.g},
        ${baseRGB.b},
        ${borderAlpha}
      ) !important;
      box-shadow: 0 0 6px rgba(${baseRGB.r},${baseRGB.g},${baseRGB.b},${borderAlpha * 0.6});
      opacity: ${Math.max(btnA, floorAlpha)} !important;
      transition: background 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease, color 0.25s ease, opacity 0.25s ease;
    }

    .hg-btn:hover,
    .hg-hud .hg-btn:hover,
    .hg-topbar .hg-btn:hover {
      background: rgba(
        ${Math.round(baseRGB.r * btnLumScale * 1.15)},
        ${Math.round(baseRGB.g * btnLumScale * 1.15)},
        ${Math.round(baseRGB.b * btnLumScale * 1.15)},
        ${Math.min(1, bgAlpha * 1.2)}
      ) !important;
      box-shadow: 0 0 8px rgba(${baseRGB.r},${baseRGB.g},${baseRGB.b},${borderAlpha});
      filter: brightness(${1 + (1 - btnA) * 0.15});
    }
  `;
  styleTag.textContent += css;

  /* ── Force-synchronize the topbar buttons (Keys / Settings / Hide) ───── */
  const topBtns = document.querySelectorAll('.hg-btn, .hg-topbar button, .hg-hud button');
  topBtns.forEach(b => {
    if (!b.offsetParent) return;
    const textColor = btnA > 0.45 ? 'rgba(0,0,0,1)' : 'rgba(255,255,255,0.95)';
    b.style.background = `rgba(${Math.round(baseRGB.r * btnLumScale)},${Math.round(baseRGB.g * btnLumScale)},${Math.round(baseRGB.b * btnLumScale)},${bgAlpha})`;
    b.style.borderColor = `rgba(${baseRGB.r},${baseRGB.g},${baseRGB.b},${borderAlpha})`;
    b.style.boxShadow = `0 0 6px rgba(${baseRGB.r},${baseRGB.g},${baseRGB.b},${borderAlpha * 0.6})`;
    b.style.opacity = Math.max(btnA, floorAlpha);
    b.style.color = textColor;
    b.querySelectorAll('svg, path').forEach(p => (p.style.fill = textColor));
  });
}

  /**************************************************************************
   * HUD + BANNER
   **************************************************************************/
  const hud = el("div", `position:fixed;z-index:2147483647;padding:8px 10px;min-width:190px;transition:opacity .2s;`);
  hud.classList.add("hg-hud");
  hud.innerHTML = `
    <div id="hg-head" style="display:flex;align-items:center;gap:6px;cursor:move;">
      <div style="font-weight:bold" class="hg-text-themed">HuluGuard</div>
      <div style="flex:1"></div>
      <button id="bKeys" class="hg-btn" title="Show keybinds">Keys</button>
      <button id="bGear" class="hg-btn" title="Settings">⚙</button>
      <button id="bHide" class="hg-btn" title="Hide HUD">Hide</button>
    </div>
    <pre id="hg-info" style="margin:6px 0 0 0;white-space:pre;" class="hg-text-themed"></pre>
  `;
  document.body.appendChild(hud);
  const info  = hud.querySelector("#hg-info");
  const head  = hud.querySelector("#hg-head");
  const bKeys = hud.querySelector("#bKeys");
  const bGear = hud.querySelector("#bGear");
  const bHide = hud.querySelector("#bHide");

  const banner = el("div", `position:fixed;bottom:8%;left:50%;transform:translateX(-50%);padding:6px 14px;z-index:2147483647;display:none;`);
  banner.classList.add("hg-banner");
  document.body.appendChild(banner);

  // HUD position restore
  (function () {
    const pos = safeParse(localStorage.getItem(KEY_POS), null);
    if (pos && typeof pos.x === "number") { hud.style.left = pos.x + "px"; hud.style.top = pos.y + "px"; }
    else { hud.style.right = "12px"; hud.style.top = "12px"; }
  })();

  function setHudVisible(v) {
    HUD_VISIBLE = !!v;
    hud.style.display = v ? "block" : "none";
    if (v) hud.style.opacity = settings.HUD_OPACITY;
  }
  function updateHUD() {
    if (!HUD_VISIBLE) return;
    const t    = video ? (video.currentTime || 0).toFixed(1) : "0.0";
    const ads  = analytics.length;
    const total= analytics.reduce((a, b) => a + b.dur, 0);
    const avg  = ads ? (total / ads).toFixed(1) : "0.0";
    info.textContent = `t:${t}s\ninAd:${inAd}\nlastAd:${lastAdEnd.toFixed(1)}\nAds:${ads} Σ${total.toFixed(1)} μ${avg}`;
  }
  function wakeHUD() {
    if (!HUD_VISIBLE) return;
    hud.style.opacity = settings.HUD_OPACITY;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => (hud.style.opacity = settings.HUD_IDLE_OPACITY),
      (settings.HUD_IDLE_FADE_SEC || 10) * 1000);
  }
  window.addEventListener("mousemove", () => !isCapturing && wakeHUD(), { passive: true });
  window.addEventListener("keydown",   () => !isCapturing && wakeHUD(), true);

  // HUD dragging (simple; advanced group drag lives later)
  (function () {
    let dragging=false, sx=0, sy=0, ox=0, oy=0;
    head.onmousedown = (e) => {
      dragging = true;
      const r = hud.getBoundingClientRect();
      sx = r.left; sy = r.top; ox = e.clientX; oy = e.clientY;
      e.preventDefault();
    };
    window.onmousemove = (e) => {
      if (!dragging) return;
      hud.style.left = Math.max(0, Math.min(window.innerWidth - 40, sx + (e.clientX - ox))) + "px";
      hud.style.top  = Math.max(0, Math.min(window.innerHeight - 40, sy + (e.clientY - oy))) + "px";
      hud.style.right = "";
    };
    window.onmouseup = () => {
      if (!dragging) return;
      dragging = false;
      const r = hud.getBoundingClientRect();
      localStorage.setItem(KEY_POS, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
    };
  })();

  /**************************************************************************
   * SHARED BACKDROP + ESC
   **************************************************************************/
  const backdrop = el("div", "");
  backdrop.classList.add("hg-backdrop");
  document.body.appendChild(backdrop);

  function withBackdrop(open) { backdrop.style.display = open ? "block" : "none"; }
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Escape") return;
    if (isSettingsOpen()) { e.preventDefault(); e.stopImmediatePropagation(); closeSettings(); return; }
    if (isStatsOpen())    { e.preventDefault(); e.stopImmediatePropagation(); closeStats();    return; }
  }, true);

  /**************************************************************************
   * PICTURE-IN-PICTURE MINI HUD
   **************************************************************************/
  function attachPIP(v) {
    if (!v) return;
    v.onenterpictureinpicture = () => {
      hud.style.display = "none";
      pipMiniHUD = el("div", `position:fixed;bottom:20px;right:20px;z-index:2147483647;`, "PiP Active — HuluGuard");
      pipMiniHUD.classList.add("hg-mini");
      document.body.appendChild(pipMiniHUD);
    };
    v.onleavepictureinpicture = () => {
      if (pipMiniHUD) pipMiniHUD.remove();
      pipMiniHUD = null;
      hud.style.display = HUD_VISIBLE ? "block" : "none";
    };
  }

  /**************************************************************************
   * VIDEO / AD DETECTION + CLAMP
   **************************************************************************/
  function attach() {
    const vids = Array.from(document.querySelectorAll("video")).filter(v => v.readyState >= 1);
    if (!vids.length) return;
    vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    const v = vids[0];
    if (v !== video) {
      if (video) {
        video.removeEventListener("timeupdate", tick);
        video.removeEventListener("seeking",    clampSeek);
      }
      video = v;
      video.addEventListener("timeupdate", tick);
      video.addEventListener("seeking",    clampSeek);
      attachPIP(video);
    }
  }
  const likelyAdBox = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 30 && r.height > 15 && r.top < window.innerHeight * 0.5 && r.left < window.innerWidth * 0.5;
  };
  function detectAd() {
    if (!video) return false;
    const cur = video.currentTime || 0;
    if (cur < 0.5 && !inAd) return false;
    const els = Array.from(document.querySelectorAll("body *")).filter(e => e.offsetParent && e.innerText);
    for (const e of els) {
      const t = e.innerText.trim().toLowerCase();
      if ((t === "ad" || t.startsWith("ad ") || /^ad\s*[0-9:]/.test(t) || t.includes("visit advertiser")) && likelyAdBox(e))
        return true;
    }
    return false;
  }
  function updateAd() {
    if (!video) return;
    const now = video.currentTime || 0, adNow = detectAd();
    if (adNow && !inAd) { inAd = true; adStart = now; }
    if (!adNow && inAd) {
      const dur = now - adStart;
      if (dur > 1) analytics.push({ start: adStart, end: now, dur });
      lastAdEnd = now; inAd = false;
    }
  }
  function clampSeek() {
    if (!video || ignoreSeek || lastAdEnd <= 0) return;
    const before = lastAdEnd - settings.REWIND_TOLERANCE_SEC;
    if (video.currentTime < before) {
      ignoreSeek = true;
      try { video.currentTime = lastAdEnd + 0.1; } catch {}
      showBrief(banner, "⏮️ Ad boundary");
      setTimeout(() => (ignoreSeek = false), 200);
    }
  }
  function smoothSeek(v, t) {
    const start=v.currentTime, dist=t-start, frames=8;
    for (let i=1;i<=frames;i++) setTimeout(()=>{ try{ v.currentTime = start + (dist*i)/frames; }catch{}; }, i*15);
  }
  function microSkip(delta) {
    if (!video) return;
    const target = Math.max(0, Math.min(video.duration || 9e9, video.currentTime + delta));
    if (delta < 0 && target < lastAdEnd + 0.1) {
      video.currentTime = lastAdEnd + 0.1;
      showBrief(banner, "⏮️ Ad boundary");
      return;
    }
    smoothSeek(video, target);
  }
  function tick(){ updateAd(); clampSeek(); updateHUD(); }

  /**************************************************************************
   * SETTINGS PANEL (build once, then reparent controls into sections)
   **************************************************************************/
  const panel = el("div", `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483648;font-size:13px;padding:14px 18px;min-width:360px;display:none;`);
  panel.classList.add("hg-panel");
  panel.innerHTML = `
    <div id="hg-panel-head" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <div style="font-weight:bold" class="hg-text-themed">Settings</div>
      <div style="flex:1"></div>
      <button id="sReset" class="hg-btn">Reset</button>
      <button id="sClose" class="hg-btn">Close</button>
    </div>

    <!-- Basic HUD behavior (raw controls; we'll move them into "HUD" section) -->
    <label style="display:flex;justify-content:space-between;align-items:center;margin:6px 0;">
      <span class="hg-text-themed">Show HUD on launch</span>
      <input id="sHud" type="checkbox" class="hg-checkbox">
    </label>
    <label style="display:flex;justify-content:space-between;align-items:center;margin:6px 0;">
      <span class="hg-text-themed">HUD opacity</span>
      <input id="sOp" type="number" step="0.05" min="0.3" max="1.0" class="hg-input" style="width:70px">
    </label>
    <label style="display:flex;justify-content:space-between;align-items:center;margin:6px 0;">
      <span class="hg-text-themed">Idle fade (sec)</span>
      <input id="sIdle" type="number" min="0" max="120" step="1" class="hg-input" style="width:70px">
    </label>
    <label style="display:flex;justify-content:space-between;align-items:center;margin:6px 0;">
      <span class="hg-text-themed">Idle opacity</span>
      <input id="sIop" type="number" step="0.05" min="0.1" max="1.0" class="hg-input" style="width:70px">
    </label>


    <!-- HSL -->
    <div class="hg-rowwrap">
      <div class="hg-row-left">Hue°</div>
      <div class="hg-row-mid"><input id="hHue" class="hg-slider" type="range" min="0" max="360" step="1"></div>
      <div class="hg-row-val"><input id="hHueVal" class="hg-input" type="number" min="0" max="360" step="1" style="width:50px;"></div>
    </div>
    <div class="hg-rowwrap">
      <div class="hg-row-left">Sat%</div>
      <div class="hg-row-mid"><input id="hSat" class="hg-slider" type="range" min="0" max="100" step="1"></div>
      <div class="hg-row-val"><input id="hSatVal" class="hg-input" type="number" min="0" max="100" step="1" style="width:50px;"></div>
    </div>
    <div class="hg-rowwrap">
      <div class="hg-row-left">Lum%</div>
      <div class="hg-row-mid"><input id="hLum" class="hg-slider" type="range" min="0" max="100" step="1"></div>
      <div class="hg-row-val"><input id="hLumVal" class="hg-input" type="number" min="0" max="100" step="1" style="width:50px;"></div>
    </div>

    <!-- RGB -->
    <div class="hg-rowwrap">
      <div class="hg-row-left">R</div>
      <div class="hg-row-mid"><input id="rgbR" class="hg-slider" type="range" min="0" max="255" step="1"></div>
      <div class="hg-row-val"><input id="rgbRval" class="hg-input" type="number" min="0" max="255" step="1" style="width:50px;"></div>
    </div>
    <div class="hg-rowwrap">
      <div class="hg-row-left">G</div>
      <div class="hg-row-mid"><input id="rgbG" class="hg-slider" type="range" min="0" max="255" step="1"></div>
      <div class="hg-row-val"><input id="rgbGval" class="hg-input" type="number" min="0" max="255" step="1" style="width:50px;"></div>
    </div>
    <div class="hg-rowwrap">
      <div class="hg-row-left">B</div>
      <div class="hg-row-mid"><input id="rgbB" class="hg-slider" type="range" min="0" max="255" step="1"></div>
      <div class="hg-row-val"><input id="rgbBval" class="hg-input" type="number" min="0" max="255" step="1" style="width:50px;"></div>
    </div>

<div style="display:none;">
  <div id="colorPreview" class="hg-color-preview"></div>
</div>

    <!-- Opacities -->
    <div class="hg-rowwrap">
      <div class="hg-row-left">Btns α</div>
      <div class="hg-row-mid"><input id="btnAlpha" class="hg-slider" type="range" min="0.1" max="1" step="0.01"></div>
      <div class="hg-row-val"><input id="btnAlphaVal" class="hg-input" type="number" min="0.1" max="1" step="0.01" style="width:50px;"></div>
    </div>
    <div class="hg-rowwrap">
      <div class="hg-row-left">Panel α</div>
      <div class="hg-row-mid"><input id="panelAlpha" class="hg-slider" type="range" min="0.1" max="1" step="0.01"></div>
      <div class="hg-row-val"><input id="panelAlphaVal" class="hg-input" type="number" min="0.1" max="1" step="0.01" style="width:50px;"></div>
    </div>


    <!-- Ad protection -->
    <label style="display:flex;justify-content:space-between;align-items:center;margin:6px 0;">
      <span class="hg-text-themed">Rewind tolerance (s)</span>
      <input id="sTol" type="number" min="0" max="10" step="0.5" class="hg-input" style="width:70px">
    </label>
    <label style="display:flex;justify-content:space-between;align-items:center;margin:6px 0;">
      <span class="hg-text-themed">Post-ad lock (s)</span>
      <input id="sLock" type="number" min="0" max="60" step="1" class="hg-input" style="width:70px">
    </label>
    <label style="display:flex;justify-content:space-between;align-items:center;margin:6px 0;">
      <span class="hg-text-themed">Micro skip (s)</span>
      <input id="sSkip" type="number" min="0.5" max="10" step="0.5" class="hg-input" style="width:70px">
    </label>

    <div id="keyHelpText" class="hg-text-themed" style="font-size:11px;margin:10px 0 6px 0;display:none;">
      Click to rebind. Tab=next step, Enter=save, Esc=clear.
    </div>
    <div id="keybinds" style="display:none;"></div>
  `;
  document.body.appendChild(panel);

  const sClose = panel.querySelector("#sClose");
  const sReset = panel.querySelector("#sReset");
  const sHud   = panel.querySelector("#sHud");
  const sOp    = panel.querySelector("#sOp");
  const sIdle  = panel.querySelector("#sIdle");
  const sIop   = panel.querySelector("#sIop");
  // placeholder declarations only (do not overwrite!)
  let hHue, hHueVal, hSat, hSatVal, hLum, hLumVal,
        rgbR, rgbRval, rgbG, rgbGval, rgbB, rgbBval,
        btnAlpha, btnAlphaVal, panelAlpha, panelAlphaVal,
        sTol, sLock, sSkip;
  // grab again properly (above line only for bundlers that insist on decl)
  const refs = {
    hHue: panel.querySelector("#hHue"), hHueVal: panel.querySelector("#hHueVal"),
    hSat: panel.querySelector("#hSat"), hSatVal: panel.querySelector("#hSatVal"),
    hLum: panel.querySelector("#hLum"), hLumVal: panel.querySelector("#hLumVal"),
    rgbR: panel.querySelector("#rgbR"), rgbRval: panel.querySelector("#rgbRval"),
    rgbG: panel.querySelector("#rgbG"), rgbGval: panel.querySelector("#rgbGval"),
    rgbB: panel.querySelector("#rgbB"), rgbBval: panel.querySelector("#rgbBval"),
    colorPreview: panel.querySelector("#colorPreview"),
    btnAlpha: panel.querySelector("#btnAlpha"), btnAlphaVal: panel.querySelector("#btnAlphaVal"),
    panelAlpha: panel.querySelector("#panelAlpha"), panelAlphaVal: panel.querySelector("#panelAlphaVal"),
    sTol: panel.querySelector("#sTol"), sLock: panel.querySelector("#sLock"), sSkip: panel.querySelector("#sSkip"),
    keybinds: panel.querySelector("#keybinds"), keyHelpText: panel.querySelector("#keyHelpText"),
  };

  // Keybinds
  const keyDefs = [
    ["toggleHUD", "Toggle HUD"],
    ["stats",     "Stats panel (Ctrl+Alt+S)"],
    ["microBack", "Micro skip ←"],
    ["microFwd",  "Micro skip →"],
    ["openSettings", "Settings (Alt+S)"],
  ];
  function renderKeybinds() {
    const ctr = refs.keybinds;
    ctr.innerHTML = "";
    keyDefs.forEach(([key, label]) => {
      const row = el("div","display:flex;align-items:center;justify-content:space-between;margin:6px 0;");
      const left = el("div","font-family:monospace;font-size:12px;",label); left.classList.add("hg-text-themed");
      const btn = document.createElement("button"); btn.className="hg-btn"; btn.textContent=settings.KEYS[key] || "Unbound"; btn.title="Click to rebind";
      btn.onclick = () => captureBinding(key, btn);
      row.append(left, btn); ctr.appendChild(row);
    });
  }
  function captureBinding(bindKey, btnNode) {
    if (isCapturing) return;
    isCapturing = true; btnNode.textContent = "Press keys…";
    const seq = [];
    const finish = (label) => { save(); btnNode.textContent = label; window.removeEventListener("keydown", downHandler, true); isCapturing = false; };
    const downHandler = (e) => {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.code === "Escape") { settings.KEYS[bindKey] = ""; finish("Unbound"); return; }
      if (e.code === "Enter")  { const final = seq.join(" > "); settings.KEYS[bindKey] = final; finish(final || "Unbound"); return; }
      if (e.code === "Tab")    { if (seq.length===0 || seq[seq.length-1]==="") return; seq.push(""); btnNode.textContent = (seq.filter(Boolean).join(" > ") || "(sequence)") + " …"; return; }
      if (isModKeyCode(e.code)) return;
      const chord = fmtChord(e);
      if (seq.length === 0 || seq[seq.length-1] === "") seq[seq.length===0?0:seq.length-1] = chord;
      else seq[seq.length-1] = chord;
      btnNode.textContent = seq.join(" > ");
    };
    window.addEventListener("keydown", downHandler, true);
  }

  const keyHelp = el("div", `position:fixed;bottom:15%;left:50%;transform:translateX(-50%);z-index:2147483649;display:none;`);
  keyHelp.classList.add("hg-keyhelp");
  document.body.appendChild(keyHelp);
  const showKeyHelp = () => {
    const lines = keyDefs.map(([key, label]) => `${label}: ${settings.KEYS[key] || "Unbound"}`);
    keyHelp.innerHTML = lines.join("<br>");
    keyHelp.style.display = "block";
    clearTimeout(keyHelp._t);
    keyHelp._t = setTimeout(() => fadeOut(keyHelp, 200), 2500);
  };

  let toggleSettings = () => {}, toggleKeys = () => {}, toggleStats = () => {};
  bGear.onclick = () => toggleSettings();
  bKeys.onclick = () => toggleKeys();
  bHide.onclick = () => setHudVisible(false);

  /**************************************************************************
   * STATS PANEL
   **************************************************************************/
  const statsPanel = el("div", `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483648;padding:12px 14px;min-width:360px;display:none;`);
  statsPanel.classList.add("hg-stats");
  statsPanel.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
      <div style="font-weight:bold;" class="hg-text-themed">Stats / Oscilloscope</div>
      <div style="flex:1"></div>
      <button id="stCopy" class="hg-btn">Copy</button>
      <button id="stClose" class="hg-btn">Close</button>
    </div>
    <div id="stSummary" style="margin-bottom:8px;" class="hg-text-themed"></div>
    <canvas id="stCan" width="360" height="140" class="hg-canvas" style="display:block;"></canvas>
    <div id="stHelp" style="font-size:11px;margin-top:6px;line-height:1.4em;" class="hg-text-themed">
      Bars = ad pod durations (seconds).<br>Grid = timing reference.<br>Copy JSON to debug your session.
    </div>
  `;
  document.body.appendChild(statsPanel);
  const stSummary = statsPanel.querySelector("#stSummary");
  const stCanvas  = statsPanel.querySelector("#stCan");
  const stCtx     = stCanvas.getContext("2d");
  const stClose   = statsPanel.querySelector("#stClose");
  const stCopy    = statsPanel.querySelector("#stCopy");

  function drawStats() {
    const w=stCanvas.width, h=stCanvas.height, stroke=rgbToHex(settings.RGB);
    stCtx.clearRect(0,0,w,h);
    // grid
    stCtx.lineWidth=1; stCtx.strokeStyle=stroke; stCtx.globalAlpha=0.18; stCtx.beginPath();
    for (let gx=30;gx<w;gx+=30){ stCtx.moveTo(gx,0); stCtx.lineTo(gx,h); }
    for (let gy=20;gy<h;gy+=20){ stCtx.moveTo(0,gy); stCtx.lineTo(w,gy); }
    stCtx.stroke();
    // bars
    const bars = analytics.map(a=>a.dur);
    if (bars.length){
      const maxDur = Math.max(...bars, 10);
      const barAreaW = w-40, barSlotW = barAreaW / bars.length;
      for (let i=0;i<bars.length;i++){
        const dur=bars[i], norm=dur/maxDur, barH=Math.max(4, norm*(h-30));
        const x=20+i*barSlotW+barSlotW*0.15, bw=barSlotW*0.7, y=h-barH-10;
        stCtx.globalAlpha=0.9; stCtx.fillStyle=stroke; stCtx.fillRect(x,y,bw,barH);
        stCtx.globalAlpha=1; stCtx.beginPath(); stCtx.moveTo(x,y); stCtx.lineTo(x+bw,y); stCtx.strokeStyle=stroke; stCtx.lineWidth=2; stCtx.stroke();
      }
    }
    // axes
    stCtx.globalAlpha=0.8; stCtx.lineWidth=1.5; stCtx.strokeStyle=stroke;
    stCtx.beginPath(); stCtx.moveTo(10,10); stCtx.lineTo(10,h-10); stCtx.lineTo(w-10,h-10); stCtx.stroke();
    stCtx.globalAlpha=1;
  }
  function refreshSummary() {
    const total = analytics.reduce((a,b)=>a+b.dur,0);
    const avg   = analytics.length ? total/analytics.length : 0;
    stSummary.textContent = `Ads: ${analytics.length}  Total: ${total.toFixed(1)}s  Avg: ${avg.toFixed(1)}s`;
  }
  function statsAnimLoop(){ drawStats(); statsAnimHandle = requestAnimationFrame(statsAnimLoop); }
  function startStatsAnim(){ stopStatsAnim(); statsAnimLoop(); }
  function stopStatsAnim(){ if (statsAnimHandle) cancelAnimationFrame(statsAnimHandle); statsAnimHandle=null; }

/**************************************************************************
 * OPEN/CLOSE HELPERS — FIXED + RESTORED MOVABILITY
 **************************************************************************/

    // Quick status helpers
    const isSettingsOpen = () => panel.style.display === "block";
    const isStatsOpen    = () => statsPanel.style.display === "block";
    const isOverlayOpen  = () => isSettingsOpen() || isStatsOpen() || isCapturing;

/**************************************************************************
 * SETTINGS OPEN/CLOSE — FINAL SYNCED + MOVABLE FIX
 **************************************************************************/

    let HG_ready = false;
    setTimeout(() => { HG_ready = true; }, 500);

    function openSettings(force = false) {
        if (!HG_ready && !force) {
            return setTimeout(() => openSettings(true), 120);
        }

        // Make visible first
        panel.style.display = "block";
        panel.style.visibility = "hidden";
        panel.style.pointerEvents = "none";
        panel.style.opacity = "1";
        panel.style.zIndex = "2147483648";

        withBackdrop(true);

        // 1️⃣ Build sections (only once)
        try {
            if (!panel.classList.contains("hg-built")) {
                buildSectionsOnce();
                panel.classList.add("hg-built");
            }
        } catch (err) {
            console.error("HG buildSectionsOnce error:", err);
        }

        // 2️⃣ Re-attach draggable
        try {
            if (!panel.dataset.draggableAttached) {
                makeDraggable(panel, panel.firstElementChild, "HGv682_Pos_Settings", defSettings);
                panel.dataset.draggableAttached = "1";
            }
        } catch (e) {
            console.warn("HG draggable restore failed", e);
        }

        // 3️⃣ Wait 1 frame to ensure DOM sections exist before syncing fields
        requestAnimationFrame(() => {
            try {
                if (typeof syncFieldsFromSettings === "function") syncFieldsFromSettings();
                if (typeof renderKeybinds === "function") renderKeybinds();
                syncLayoutFields();
            } catch (err) {
                console.error("HG syncFieldsFromSettings error:", err);
            }

            // 4️⃣ Finally reveal it
            panel.style.visibility = "visible";
            panel.style.pointerEvents = "auto";
            try { panel.focus(); } catch {}
        });
    }

    function closeSettings() {
        withBackdrop(false);
        fadeOut(panel);
    }


    /**************************************************************************
 * STATS PANEL
 **************************************************************************/

    function openStats() {
        refreshSummary();
        withBackdrop(true);
        statsPanel.style.display = "block";
        startStatsAnim();
    }

    function closeStats() {
        fadeOut(statsPanel);
        withBackdrop(false);
        stopStatsAnim();
    }

    /**************************************************************************
 * BUTTON HANDLERS
 **************************************************************************/

    sClose.onclick = () => closeSettings();

    sReset.onclick = () => {
        // restore defaults in memory
        settings = JSON.parse(JSON.stringify(DEFAULTS));
        save();

        // update all form fields in Settings UI to match defaults
        syncFieldsFromSettings();
        renderKeybinds();

        // push the opacity + theme into every live panel NOW
        applyGlobalOpacityNow();

        // make sure HUD visibility/idle behavior matches defaults, too
        HUD_VISIBLE = !!settings.HUD_ON_LAUNCH;
        setHudVisible(HUD_VISIBLE);
        wakeHUD();
    };

    stClose.onclick = () => closeStats();

    stCopy.onclick = () => {
        const payload = JSON.stringify(analytics, null, 2);
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(payload);
        showBrief(banner, "📋 Stats copied");
    };

    /**************************************************************************
 * TOGGLE HELPERS
 **************************************************************************/

    toggleKeys     = () => showKeyHelp();
    toggleSettings = () => isSettingsOpen() ? closeSettings() : openSettings();
    toggleStats    = () => isStatsOpen() ? closeStats() : openStats();

/**************************************************************************
 * INPUT LINKER: typed + slider sync (universal)
 **************************************************************************/

    function linkSliderAndBox(slider, box, onChange) {
        if (!slider || !box) return;
        slider.removeAttribute("readonly");
        box.removeAttribute("readonly");
        if (box.id === "sOp") {
            slider.addEventListener("input", () => syncAllHUDOpacity(slider.value));
            box.addEventListener("input", () => syncAllHUDOpacity(box.value));
        }
        slider.removeAttribute("disabled");
        box.removeAttribute("disabled");
        slider.style.pointerEvents = "auto";
        box.style.pointerEvents = "auto";
        box.style.userSelect = "text";

        // Keep them in sync both ways
        const syncFromSlider = () => {
            box.value = slider.value;
            onChange?.();
        };
        const syncFromBox = () => {
            const val = parseFloat(box.value);
            if (!isNaN(val)) {
                slider.value = val;
                onChange?.();
            }
        };

        slider.addEventListener("input", syncFromSlider);
        box.addEventListener("change", syncFromBox);
        box.addEventListener("input", (e) => e.stopPropagation()); // prevent weird bubbling
    }

    /**************************************************************************
 * APPLY LINKING TO ALL NUMBER FIELDS
 **************************************************************************/




    // You can call this right after syncFieldsFromSettings() during panel build
    function enableEditableInputs() {
        // HSL
        linkSliderAndBox(refs.hHue, refs.hHueVal, updateFromHSLControls);
        linkSliderAndBox(refs.hSat, refs.hSatVal, updateFromHSLControls);
        linkSliderAndBox(refs.hLum, refs.hLumVal, updateFromHSLControls);

        // RGB
        linkSliderAndBox(refs.rgbR, refs.rgbRval, updateFromRGBSliders);
        linkSliderAndBox(refs.rgbG, refs.rgbGval, updateFromRGBSliders);
        linkSliderAndBox(refs.rgbB, refs.rgbBval, updateFromRGBSliders);

        // Opacities
        linkSliderAndBox(refs.btnAlpha, refs.btnAlphaVal, updateBtnOpacity);
        linkSliderAndBox(refs.panelAlpha, refs.panelAlphaVal, updatePanelOpacity);

        // HUD + General numeric fields
        [sOp, sIdle, sIop, refs.sTol, refs.sLock, refs.sSkip].forEach((inp) => {
            inp.removeAttribute("readonly");
            inp.removeAttribute("disabled");
            inp.style.pointerEvents = "auto";
            inp.style.userSelect = "text";
        });
    }

// --- Ensure all numeric inputs are fully editable and deletable ---
    function enforceEditableInputs() {
        const allInputs = panel.querySelectorAll('input[type="number"], input[type="text"], input[type="range"]');
        allInputs.forEach(inp => {
            inp.removeAttribute("readonly");
            inp.removeAttribute("disabled");
            inp.style.pointerEvents = "auto";
            inp.style.userSelect = "text";
            inp.addEventListener("focus", e => e.stopPropagation(), true);
            inp.addEventListener("mousedown", e => e.stopPropagation(), true);
            inp.addEventListener("keydown", e => e.stopPropagation(), true);
        });
    }
    // --- Global override: allow manual typing in settings fields ---
    function unlockInputsGlobal() {
        document.querySelectorAll('input[type="number"], input[type="text"]').forEach(inp => {
            inp.removeAttribute("readonly");
            inp.removeAttribute("disabled");
            inp.style.pointerEvents = "auto";
            inp.style.userSelect = "text";
            inp.addEventListener("mousedown", e => e.stopPropagation(), true);
            inp.addEventListener("focus", e => e.stopPropagation(), true);
            inp.addEventListener("keydown", e => e.stopPropagation(), true);
        });
        console.log("HG: All numeric/text inputs unlocked.");
    }



/**************************************************************************
 * THEME-COMPAT SLIDERS FOR ALL NUMERIC FIELDS (robust + idempotent)
 * - Rebuilds rows to match Theme structure so existing CSS applies
 * - Covers HUD, Layout & Design, General
 * - Watches for later DOM changes (Reset, reopen) and re-applies safely
 **************************************************************************/

    (function installHGSliders() {
        if (!panel) return;

        // Map known ids → nice labels (fallback to label text if not found)
        const LABELS = {
            // HUD
            sOp:   "HUD opacity",
            sIdle: "Idle fade (sec)",
            sIop:  "Idle opacity",
            // Layout & Design
            sGridSize:    "Grid size (px)",
            sGridDensity: "Grid density (cells / 100px)",
            sDockPx:      "Dock strength (px)",
            sAlignPx:     "Align threshold (px)",
            // General
            sTol:  "Rewind tolerance (s)",
            sLock: "Post-ad lock (s)",
            sSkip: "Micro skip (s)",
        };

        // Detect if a number input is already inside a Theme-style row with a slider
        function alreadyThemed(num) {
            const row = num.closest('.hg-rowwrap');
            if (!row) return false;
            const mid = row.querySelector('.hg-row-mid');
            const val = row.querySelector('.hg-row-val');
            return !!(mid && val && mid.querySelector('.hg-slider'));
        }

        function labelFor(num) {
            // Preferred: map by id
            if (num.id && LABELS[num.id]) return LABELS[num.id];
            // Otherwise: try the existing <label><span>Text</span>...</label>
            const span = num.closest('label')?.querySelector('span');
            if (span && span.textContent.trim()) return span.textContent.trim();
            // Last resort: id
            return num.id || "Value";
        }

        function makeRow(labelText, num) {
            // Build Theme structure
            const row = document.createElement('div'); row.className = 'hg-rowwrap';
            const left = document.createElement('div'); left.className = 'hg-row-left'; left.textContent = labelText;
            const mid  = document.createElement('div'); mid.className  = 'hg-row-mid';
            const val  = document.createElement('div'); val.className  = 'hg-row-val';

            // Slider with same class the Theme CSS targets
            const slider = document.createElement('input');
            slider.type = 'range';
            slider.className = 'hg-slider';
            slider.min  = num.getAttribute('min')  ?? "0";
            slider.max  = num.getAttribute('max')  ?? "100";
            slider.step = num.getAttribute('step') ?? "1";
            slider.value= num.value || slider.min;

            // Ensure numeric box width matches Theme value column
            num.style.width = "50px";

            // Bidirectional sync (preserves existing change handlers on num)
            const syncFromSlider = () => {
                num.value = slider.value;
                num.dispatchEvent(new Event('change', { bubbles: true }));
            };
            const syncFromNumber = () => { slider.value = num.value; };
            slider.addEventListener('input', syncFromSlider);
            num.addEventListener('input', syncFromNumber);

            mid.appendChild(slider);
            val.appendChild(num);

            row.append(left, mid, val);
            return row;
        }

        // Convert one numeric input to a Theme row (if not already themed)
        function convert(num) {
            if (alreadyThemed(num)) return;

            // Exclude existing Theme controls’ number boxes (they already have sliders)
            // Heuristic: if ancestor row already contains an .hg-slider in .hg-row-mid, skip.
            if (num.closest('.hg-rowwrap')?.querySelector('.hg-row-mid .hg-slider')) return;

            // Find the old “row” to replace (prefer the <label> wrapper)
            const oldRow = num.closest('label') || num.parentElement;
            if (!oldRow || !oldRow.parentElement) return;

            const row = makeRow(labelFor(num), num);
            oldRow.parentElement.replaceChild(row, oldRow);
        }

        function applyOnce() {
            // Target ONLY numeric inputs in our settings panel
            const nums = panel.querySelectorAll('input[type="number"]');
            nums.forEach(n => {
                // Don’t touch hidden/fake fields
                if (!n.offsetParent) return;
                // Skip Theme’s existing number boxes (they already live in themed rows)
                if (alreadyThemed(n)) return;
                // Convert HUD/Layout/General numeric fields
                convert(n);
            });
        }

        // Run now (covers current DOM), then after next paint (covers first open),
        // then whenever the panel mutates (reset, rebuild, collapse/expand).
        applyOnce();
        requestAnimationFrame(applyOnce);
        requestAnimationFrame(() => requestAnimationFrame(applyOnce)); // ultra-safe 2nd frame

        // Mutation observer: keep rows themed on any structural changes
        const mo = new MutationObserver(() => applyOnce());
        mo.observe(panel, { childList: true, subtree: true });

        // Also wrap openSettings to apply after sections are built & synced
        if (typeof openSettings === 'function' && !openSettings.__hgSlidersPatched) {
            const orig = openSettings;
            openSettings = function(force=false) {
                orig(force);
                // after buildSectionsOnce + syncFieldsFromSettings
                requestAnimationFrame(() => requestAnimationFrame(applyOnce));
            };
            openSettings.__hgSlidersPatched = true;
        }
    })();




    /**************************************************************************
 * CALL IT AFTER BUILDING SECTIONS
 **************************************************************************/
    requestAnimationFrame(() => {
        if (typeof enableEditableInputs === "function") enableEditableInputs();
        if (typeof enforceEditableInputs === "function") enforceEditableInputs();
    });

  /**************************************************************************
   * SETTINGS FIELD SYNC / THEME LIVE UPDATE
   **************************************************************************/
  function syncPreviewBox(){ refs.colorPreview.style.background = `rgb(${settings.RGB.r},${settings.RGB.g},${settings.RGB.b})`; }
  function syncFieldsFromSettings() {
    sHud.checked = !!settings.HUD_ON_LAUNCH;
    sOp.value    = settings.HUD_OPACITY;
    sIdle.value  = settings.HUD_IDLE_FADE_SEC;
    sIop.value   = settings.HUD_IDLE_OPACITY;

    syncFromRGB();
    refs.hHue.value = refs.hHueVal.value = settings.HSL.h;
    refs.hSat.value = refs.hSatVal.value = settings.HSL.s;
    refs.hLum.value = refs.hLumVal.value = settings.HSL.l;

    refs.rgbR.value = refs.rgbRval.value = settings.RGB.r;
    refs.rgbG.value = refs.rgbGval.value = settings.RGB.g;
    refs.rgbB.value = refs.rgbBval.value = settings.RGB.b;

    refs.btnAlpha.value     = settings.BTN_OPACITY;
    refs.btnAlphaVal.value  = settings.BTN_OPACITY.toFixed(2);
    refs.panelAlpha.value   = settings.PANEL_OPACITY;
    refs.panelAlphaVal.value= settings.PANEL_OPACITY.toFixed(2);

    refs.sTol.value  = settings.REWIND_TOLERANCE_SEC;
    refs.sLock.value = settings.POST_AD_LOCK;
    refs.sSkip.value = settings.MICRO_SKIP_SEC;

    syncPreviewBox();
  }

    /**************************************************************************
 * LAYOUT & DESIGN FIELD SYNC (Grid / Dock / Group)
 **************************************************************************/
    function syncLayoutFields() {
        const sGrid       = panel.querySelector("#sGrid");
        const sGridSize   = panel.querySelector("#sGridSize");
        const sGridDensity= panel.querySelector("#sGridDensity");
        const sDockPx     = panel.querySelector("#sDockPx");
        const sAlignPx    = panel.querySelector("#sAlignPx");
        const sGroup      = panel.querySelector("#sGroup");
        if (!sGrid) return; // not yet built

        sGrid.checked          = localStorage.getItem("HGv682_SnapGrid") === "true";
        sGridSize.value        = clampNum(parseInt(localStorage.getItem("HGv682_GridSize")||"",10) || 7, 2, 64);
        sGridDensity.value     = Math.max(1, Math.round(100 / sGridSize.value));
        sDockPx.value          = clampNum(parseInt(localStorage.getItem("HGv682_DockStrength")||"",10) || 30, 6, 48);
        sAlignPx.value         = clampNum(parseInt(localStorage.getItem("HGv682_AlignThreshold")||"",10) || 32, 4, 64);
        sGroup.checked         = localStorage.getItem("HGv682_GroupDrag") === "true";
    }





/**************************************************************************
 * applyThemeLive()
 * Global transparency fix — Panel α now affects:
 *   • main HuluGuard HUD background
 *   • internal wrapper and border
 *   • stats/settings/mini/keyhelp panels
 * while keeping text brightness balanced.
 **************************************************************************/
    function applyThemeLive() {
        rebuildTheme();

        const panelA = clampNum(settings.PANEL_OPACITY ?? 0.7, 0, 1);
        const hudA   = clampNum(settings.HUD_OPACITY   ?? 1.0, 0, 1);
        const btnA   = clampNum(settings.BTN_OPACITY   ?? 0.4, 0, 1);

        const base = settings.RGB;
        const txt  = adjustRGB(base, 60);
        const borderA = Math.max(0.2, panelA * 0.85);
        const textA   = Math.max(0.25, Math.min(1, panelA * 1.15));

        const bg     = `rgba(0,0,0,${panelA})`;
        const bColor = `rgba(${base.r},${base.g},${base.b},${borderA})`;
        const tColor = `rgba(${txt.r},${txt.g},${txt.b},${textA})`;

        // Make sure class reflows don’t strip theme classes
        [hud, panel, keyHelp, statsPanel, pipMiniHUD].forEach(elem => {
            if (!elem) return;
            const classes = [...elem.classList];
            elem.className = ""; classes.forEach(c => elem.classList.add(c));
        });

        // All panel-like surfaces + dropdowns obey Panel α
        document.querySelectorAll(`
    .hg-hud,
    .hg-panel,
    .hg-stats,
    .hg-mini,
    .hg-keyhelp,
    .hg-section,
    .hg-sec-body,
    .hg-dropdown-container,
    select.hg-input,
    .hg-select,
    .hg-dropdown,
    .hg-canvas
  `).forEach(el => {
            el.style.background  = bg;
            el.style.borderColor = bColor;
            el.style.transition  = "background var(--hg-med) var(--hg-ease), border-color var(--hg-med) var(--hg-ease), opacity var(--hg-med) var(--hg-ease)";
        });

        // HUD element opacity (global dimmer) + its info text tint
        const hudMain = document.querySelector(".hg-hud");
        if (hudMain) {
            hudMain.style.opacity = String(hudA);
            hudMain.querySelectorAll("#hg-info, .hg-text-themed").forEach(n => { n.style.color = tColor; });
            // also fade the border/text of anything inside
            hudMain.querySelectorAll("*").forEach(n => { n.style.borderColor = bColor; });
        }

        // Settings / Stats / Mini / KeyHelp text tint
        document.querySelectorAll(".hg-panel .hg-text-themed, .hg-stats .hg-text-themed, .hg-mini .hg-text-themed, .hg-keyhelp .hg-text-themed")
            .forEach(n => { n.style.color = tColor; });

        // Buttons keep BTN α but inherit the same accent border
        document.querySelectorAll(".hg-btn").forEach(b => {
            b.style.borderColor = bColor;
            b.style.transition  = "background var(--hg-med) var(--hg-ease), color var(--hg-med) var(--hg-ease), border-color var(--hg-med) var(--hg-ease)";
        });

        // Keep CSS vars in sync for any CSS that reads them
        document.documentElement.style.setProperty("--panel-opacity", String(panelA));
        document.documentElement.style.setProperty("--hud-opacity",   String(hudA));
        document.documentElement.style.setProperty("--btn-opacity",   String(btnA));

        if (typeof isStatsOpen === "function" && isStatsOpen()) drawStats?.();

        // Smooth alpha interpolation (fade at same rate as other panels)
        const fadeElems = document.querySelectorAll(`
  .hg-hud,
  .hg-panel,
  .hg-stats,
  .hg-mini,
  .hg-keyhelp,
  .hg-dropdown,
  .hg-select,
  .hg-dropdown-container,
  .hg-section,
  .hg-sec-body
`);
        fadeElems.forEach(el => {
            el.style.transition =
                "background var(--hg-med) var(--hg-ease), border-color var(--hg-med) var(--hg-ease), color var(--hg-med) var(--hg-ease), opacity var(--hg-med) var(--hg-ease)";
            el.style.opacity = String(clampNum(settings.HUD_OPACITY ?? 1.0, 0, 1));
        });
    }

  function wakeAndSaveHUDBasics(){
    settings.HUD_ON_LAUNCH       = sHud.checked;
    settings.HUD_OPACITY         = clampNum(parseFloat(sOp.value),   0.3, 1.0);
    settings.HUD_IDLE_FADE_SEC   = clampNum(parseInt(sIdle.value,10),0,120);
    settings.HUD_IDLE_OPACITY    = clampNum(parseFloat(sIop.value),  0.1, 1.0);
    settings.REWIND_TOLERANCE_SEC= clampNum(parseFloat(refs.sTol.value),  0,10);
    settings.POST_AD_LOCK        = clampNum(parseFloat(refs.sLock.value), 0,60);
    settings.MICRO_SKIP_SEC      = clampNum(parseFloat(refs.sSkip.value), 0.5,10);
    save();
    if (HUD_VISIBLE) hud.style.opacity = settings.HUD_OPACITY;
    wakeHUD();
  }
  [sHud, sOp, sIdle, sIop, refs.sTol, refs.sLock, refs.sSkip].forEach(inp=>{
    inp.addEventListener("change", wakeAndSaveHUDBasics);
  });
// Live opacity slider sync (like Btn α and Panel α)
    sOp.addEventListener("input", () => updateGlobalOpacity(sOp.value));
    sOp.addEventListener("change", () => updateGlobalOpacity(sOp.value));
  // Color handlers
  function updateFromHSLControls(){
    settings.HSL.h = clampNum(parseFloat(refs.hHue.value), 0,360);
    settings.HSL.s = clampNum(parseFloat(refs.hSat.value), 0,100);
    settings.HSL.l = clampNum(parseFloat(refs.hLum.value), 0,100);
    syncFromHSL();
    refs.hHueVal.value=settings.HSL.h; refs.hSatVal.value=settings.HSL.s; refs.hLumVal.value=settings.HSL.l;
    refs.rgbR.value=refs.rgbRval.value=settings.RGB.r;
    refs.rgbG.value=refs.rgbGval.value=settings.RGB.g;
    refs.rgbB.value=refs.rgbBval.value=settings.RGB.b;
    save(); syncPreviewBox(); applyThemeLive(); wakeHUD();
  }
  function updateFromHSLBoxes(){
    settings.HSL.h = clampNum(parseFloat(refs.hHueVal.value), 0,360);
    settings.HSL.s = clampNum(parseFloat(refs.hSatVal.value), 0,100);
    settings.HSL.l = clampNum(parseFloat(refs.hLumVal.value), 0,100);
    refs.hHue.value=settings.HSL.h; refs.hSat.value=settings.HSL.s; refs.hLum.value=settings.HSL.l;
    syncFromHSL();
    refs.rgbR.value=refs.rgbRval.value=settings.RGB.r;
    refs.rgbG.value=refs.rgbGval.value=settings.RGB.g;
    refs.rgbB.value=refs.rgbBval.value=settings.RGB.b;
    save(); syncPreviewBox(); applyThemeLive(); wakeHUD();
  }
  function updateFromRGBSliders(){
    settings.RGB.r = clampNum(parseInt(refs.rgbR.value,10),0,255);
    settings.RGB.g = clampNum(parseInt(refs.rgbG.value,10),0,255);
    settings.RGB.b = clampNum(parseInt(refs.rgbB.value,10),0,255);
    syncFromRGB();
    refs.rgbRval.value=settings.RGB.r; refs.rgbGval.value=settings.RGB.g; refs.rgbBval.value=settings.RGB.b;
    refs.hHue.value=refs.hHueVal.value=settings.HSL.h;
    refs.hSat.value=refs.hSatVal.value=settings.HSL.s;
    refs.hLum.value=refs.hLumVal.value=settings.HSL.l;
    save(); syncPreviewBox(); applyThemeLive(); wakeHUD();
  }
  function updateFromRGBBoxes(){
    settings.RGB.r = clampNum(parseInt(refs.rgbRval.value,10),0,255);
    settings.RGB.g = clampNum(parseInt(refs.rgbGval.value,10),0,255);
    settings.RGB.b = clampNum(parseInt(refs.rgbBval.value,10),0,255);
    syncFromRGB();
    refs.rgbR.value=settings.RGB.r; refs.rgbG.value=settings.RGB.g; refs.rgbB.value=settings.RGB.b;
    refs.hHue.value=refs.hHueVal.value=settings.HSL.h;
    refs.hSat.value=refs.hSatVal.value=settings.HSL.s;
    refs.hLum.value=refs.hLumVal.value=settings.HSL.l;
    save(); syncPreviewBox(); applyThemeLive(); wakeHUD();
  }
  [refs.hHue, refs.hSat, refs.hLum].forEach(sl => sl.addEventListener("input",  updateFromHSLControls));
  [refs.hHueVal, refs.hSatVal, refs.hLumVal].forEach(box => box.addEventListener("change", updateFromHSLBoxes));
  [refs.rgbR, refs.rgbG, refs.rgbB].forEach(sl => sl.addEventListener("input",  updateFromRGBSliders));
  [refs.rgbRval, refs.rgbGval, refs.rgbBval].forEach(box => box.addEventListener("change", updateFromRGBBoxes));

  // Opacities
  function updateBtnOpacity(){ settings.BTN_OPACITY = clampNum(parseFloat(refs.btnAlpha.value), 0.1, 1);
    refs.btnAlphaVal.value = settings.BTN_OPACITY.toFixed(2); save(); applyThemeLive(); wakeHUD(); }
  function updateBtnOpacityBox(){ settings.BTN_OPACITY = clampNum(parseFloat(refs.btnAlphaVal.value), 0.1, 1);
    refs.btnAlpha.value = settings.BTN_OPACITY; save(); applyThemeLive(); wakeHUD(); }
  function updatePanelOpacity(){ settings.PANEL_OPACITY = clampNum(parseFloat(refs.panelAlpha.value), 0.1, 1);
    refs.panelAlphaVal.value = settings.PANEL_OPACITY.toFixed(2); save(); applyThemeLive(); wakeHUD(); }
    /**************************************************************************
 * FULL HUD OPACITY LIVE UPDATE
 * Mirrors Panel/Btn α behavior — dims entire UI instantly
 **************************************************************************/

  function updatePanelOpacityBox(){ settings.PANEL_OPACITY = clampNum(parseFloat(refs.panelAlphaVal.value), 0.1, 1);
    refs.panelAlpha.value = settings.PANEL_OPACITY; save(); applyThemeLive(); wakeHUD(); }
  refs.btnAlpha.addEventListener("input", updateBtnOpacity);
  refs.btnAlphaVal.addEventListener("change", updateBtnOpacityBox);
  refs.panelAlpha.addEventListener("input", updatePanelOpacity);
  refs.panelAlphaVal.addEventListener("change", updatePanelOpacityBox);



/**************************************************************************
 * GLOBAL OPACITY SYNC (Relative Scaling)
 * HUD slider is the master dimmer; Panel α and Button α set base contrast.
 **************************************************************************/
    function updateGlobalOpacity(value) {
        const v = clampNum(parseFloat(value), 0.1, 1.0);
        settings.HUD_OPACITY = v;
        save();

        // compute relative opacities using saved base style ratios
        const basePanel = clampNum(settings.PANEL_OPACITY || 0.9, 0.1, 1.0);
        const baseBtn   = clampNum(settings.BTN_OPACITY   || 0.6, 0.1, 1.0);

        const panelAlpha = clampNum(basePanel * v, 0.05, 1.0);
        const btnAlpha   = clampNum(baseBtn   * v, 0.05, 1.0);

        const targets = [
            document.querySelector('.hg-hud'),
            document.querySelector('.hg-panel'),
            document.querySelector('.hg-stats'),
            document.querySelector('.hg-mini'),
            document.querySelector('.hg-keyhelp'),
        ].filter(Boolean);

        targets.forEach(t => {
            t.style.opacity = v;
            t.style.transition = 'opacity 0.15s linear';
        });

        // Apply relative ratios for derived UI layers
        document.documentElement.style.setProperty('--hud-opacity', v);
        document.documentElement.style.setProperty('--panel-opacity', panelAlpha);
        document.documentElement.style.setProperty('--btn-opacity', btnAlpha);

        // Pass to CSS theming so background/text contrast updates
        applyThemeLive();
        wakeHUD();
    }

    // Force-sync all panels using relative Panel α / Button α ratios
    function applyGlobalOpacityNow() {
        const v = clampNum(settings.HUD_OPACITY, 0.1, 1.0);
        const basePanel = clampNum(settings.PANEL_OPACITY || 0.9, 0.1, 1.0);
        const baseBtn   = clampNum(settings.BTN_OPACITY   || 0.6, 0.1, 1.0);

        const panelAlpha = clampNum(basePanel * v, 0.05, 1.0);
        const btnAlpha   = clampNum(baseBtn   * v, 0.05, 1.0);

        const targets = [
            document.querySelector('.hg-hud'),
            document.querySelector('.hg-panel'),
            document.querySelector('.hg-stats'),
            document.querySelector('.hg-mini'),
            document.querySelector('.hg-keyhelp'),
        ].filter(Boolean);

        targets.forEach(t => {
            t.style.opacity = v;
            t.style.transition = 'opacity 0.15s linear';
        });

        document.documentElement.style.setProperty('--hud-opacity', v);
        document.documentElement.style.setProperty('--panel-opacity', panelAlpha);
        document.documentElement.style.setProperty('--btn-opacity', btnAlpha);

        applyThemeLive();
    }

  /**************************************************************************
   * COLLAPSIBLE SECTIONS (no clones; we MOVE existing controls)
   **************************************************************************/
  const KEY_SECTION_STATE = "HGv682_PanelSections";
  const sectionDefaults = { hud:true, layout:true, theme:true, keys:false, general:true };
  const getSectionState = () => safeParse(localStorage.getItem(KEY_SECTION_STATE), sectionDefaults);
  const setSectionState = (obj) => localStorage.setItem(KEY_SECTION_STATE, JSON.stringify(obj));

  let sectionsBuilt = false;
    function makeSection(id, titleText){
        const sec = document.createElement("div"); sec.className="hg-section";

        const header = document.createElement("div"); header.className="hg-sec-head hg-text-themed";
        header.style.cssText = `
    display:flex; align-items:center; cursor:pointer; user-select:none;
    font-weight:bold; font-size:12px; line-height:1.4em; padding:6px 8px;
  `;
        const lbl = el("div","",titleText);
        const fill= el("div","flex:1;");
        const chev= el("div","font-size:10px; transition:transform var(--hg-med) var(--hg-ease); margin-left:6px;","▼");
        header.append(lbl, fill, chev);

        const body = document.createElement("div"); body.className="hg-sec-body";
        body.style.cssText = `
    overflow:hidden; max-height:0;
    transition:max-height var(--hg-med) var(--hg-ease), padding var(--hg-med) var(--hg-ease);
    padding:0 8px; font-size:12px; line-height:1.4em;
  `;
        sec.append(header, body);

        sec._open=false; sec._chev=chev; sec._body=body; sec._id=id;
        const setOpen=(v,skipPersist)=>{
            sec._open=!!v; sec._chev.style.transform = v ? "rotate(0deg)" : "rotate(-90deg)";
            if (v) {
                body.style.paddingTop="6px"; body.style.paddingBottom="6px";
                // temporarily auto-size to content height
                const fullH = body.scrollHeight;
                body.style.maxHeight = fullH + "px";
            } else {
                body.style.maxHeight="0px"; body.style.paddingTop="0px"; body.style.paddingBottom="0px";
            }
            if(!skipPersist){ const st=getSectionState(); st[id]=!!v; setSectionState(st); }
        };
        header.addEventListener("click",()=>setOpen(!sec._open,false));
        sec.setOpen=setOpen;
        return sec;
    }

  function row(labelText, controlEl){
    const r=document.createElement("div");
    r.style.cssText="display:flex;justify-content:space-between;align-items:center;margin:6px 0;";
    const lbl=el("span","font-size:12px;line-height:1.4em;",""); lbl.className="hg-text-themed"; lbl.textContent=labelText;
    r.append(lbl, controlEl); return r;
  }

    function buildSectionsOnce() {
        if (sectionsBuilt) return;
        sectionsBuilt = true;

        // Helpers to safely move existing wrappers into a section body
        const move = (selector, dest, wrapSel) => {
            const node = panel.querySelector(selector);
            if (!node) return;
            const wrap =
                  (wrapSel ? node.closest(wrapSel) : null) ||
                  node.closest("label") ||
                  node.closest(".hg-rowwrap") ||
                  node.parentElement;
            if (wrap && dest) dest.appendChild(wrap);
        };

        const headRow = panel.querySelector("#hg-panel-head");
        const after = headRow.nextSibling;

        const secHUD     = makeSection("hud",     "HUD");
        const secLayout  = makeSection("layout",  "Layout & Design");
        const secTheme   = makeSection("theme",   "Theme");
        const secKeys    = makeSection("keys",    "Keybinds");
        const secGeneral = makeSection("general", "General");

        panel.insertBefore(secHUD, after);
        panel.insertBefore(secLayout, after);
        panel.insertBefore(secTheme, after);
        panel.insertBefore(secKeys, after);
        panel.insertBefore(secGeneral, after);

        // --- HUD (move the original <label> wrappers) ---
        move("#sHud",  secHUD._body,  "label");
        move("#sOp",   secHUD._body,  "label");
        move("#sIdle", secHUD._body,  "label");
        move("#sIop",  secHUD._body,  "label");

        // --- THEME (move each .hg-rowwrap + the original Preview row) ---
        move("#hHue",       secTheme._body, ".hg-rowwrap");
        move("#hSat",       secTheme._body, ".hg-rowwrap");
        move("#hLum",       secTheme._body, ".hg-rowwrap");
        move("#rgbR",       secTheme._body, ".hg-rowwrap");
        move("#rgbG",       secTheme._body, ".hg-rowwrap");
        move("#rgbB",       secTheme._body, ".hg-rowwrap");
        move("#btnAlpha",   secTheme._body, ".hg-rowwrap");
        move("#panelAlpha", secTheme._body, ".hg-rowwrap");
        // “Preview” row: move the whole container that holds the label + swatch
        move("#colorPreview", secTheme._body, "div");

        // --- KEYBINDS ---
        refs.keyHelpText.style.display = "block";
        refs.keybinds.style.display = "block";
        secKeys._body.append(refs.keyHelpText, refs.keybinds);

        // --- GENERAL (ad protection) ---
        move("#sTol",  secGeneral._body, "label");
        move("#sLock", secGeneral._body, "label");
        move("#sSkip", secGeneral._body, "label");

        // --- LAYOUT & DESIGN ---
        buildLayoutControls(secLayout._body);

        // Remove any left-over horizontal rules from the old flat layout
        panel.querySelectorAll(".hg-hr").forEach(n => n.remove());

        // Restore open/closed state (now that the panel is visible, heights are valid)
        const st = getSectionState();
        [secHUD, secLayout, secTheme, secKeys, secGeneral].forEach(sec => {
            const want = st[sec._id] !== undefined ? !!st[sec._id] : !!sectionDefaults[sec._id];
            sec.setOpen(want, true);
        });
    }



  /**************************************************************************
   * LAYOUT: snap-to-grid / dock / group drag (concise)
   **************************************************************************/
  const KEY_ANALYTICS     = "HGv682_Analytics";
  const KEY_GRID          = "HGv682_SnapGrid";
  const KEY_GRID_SIZE     = "HGv682_GridSize";
  const KEY_GROUP_DRAG    = "HGv682_GroupDrag";
  const KEY_DOCK_STRENGTH = "HGv682_DockStrength";
  const KEY_ALIGN_THRESH  = "HGv682_AlignThreshold";

  const GRID_SIZE_DEFAULT_PX = 7;   // ~14 cells/100px
  const DOCK_DEFAULT_PX      = 30;
  const ALIGN_DEFAULT_PX     = 32;
  const GRID_ON_DEFAULT      = true;
  const GROUP_DRAG_DEFAULT   = true;
  const initIfMissing = (k,v)=>{ if(localStorage.getItem(k)===null) localStorage.setItem(k, String(v)); };
  initIfMissing(KEY_GRID,          GRID_ON_DEFAULT ? "true" : "false");
  initIfMissing(KEY_GRID_SIZE,     String(GRID_SIZE_DEFAULT_PX));
  initIfMissing(KEY_GROUP_DRAG,    GROUP_DRAG_DEFAULT ? "true" : "false");
  initIfMissing(KEY_DOCK_STRENGTH, String(DOCK_DEFAULT_PX));
  initIfMissing(KEY_ALIGN_THRESH,  String(ALIGN_DEFAULT_PX));

  const getGridOn    = () => localStorage.getItem(KEY_GRID) === "true";
  const getGridSize  = () => clampNum(parseInt(localStorage.getItem(KEY_GRID_SIZE)||"",10) || GRID_SIZE_DEFAULT_PX, 2, 64);
  const getGroupDrag = () => localStorage.getItem(KEY_GROUP_DRAG) === "true";
  const getDockPx    = () => clampNum(parseInt(localStorage.getItem(KEY_DOCK_STRENGTH)||"",10) || DOCK_DEFAULT_PX, 6, 48);
  const getAlignPx   = () => clampNum(parseInt(localStorage.getItem(KEY_ALIGN_THRESH)||"",10)  || ALIGN_DEFAULT_PX, 4, 64);

  function buildLayoutControls(container){
    const rowL = (label, id, ctrlEl) => {
        const r = document.createElement("label");
        r.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin:6px 0;";
        const lbl = document.createElement("span");
        lbl.className = "hg-text-themed";
        lbl.style.fontSize = "12px";
        lbl.textContent = label;
        ctrlEl.id = id;
        r.append(lbl, ctrlEl);
        return r;
    };

    const sGrid = document.createElement("input"); sGrid.type="checkbox"; sGrid.className="hg-checkbox";
    const sGridSize = document.createElement("input"); sGridSize.type="number"; sGridSize.min="2"; sGridSize.max="64"; sGridSize.step="1"; sGridSize.className="hg-input"; sGridSize.style.width="80px";
    const sGridDensity = document.createElement("input"); sGridDensity.type="number"; sGridDensity.min="1"; sGridDensity.max="50"; sGridDensity.step="1"; sGridDensity.className="hg-input"; sGridDensity.style.width="80px";
    const sDockPx = document.createElement("input"); sDockPx.type="number"; sDockPx.min="6"; sDockPx.max="48"; sDockPx.step="1"; sDockPx.className="hg-input"; sDockPx.style.width="80px";
    const sAlignPx = document.createElement("input"); sAlignPx.type="number"; sAlignPx.min="4"; sAlignPx.max="64"; sAlignPx.step="1"; sAlignPx.className="hg-input"; sAlignPx.style.width="80px";
    const sGroup = document.createElement("input"); sGroup.type="checkbox"; sGroup.className="hg-checkbox";

    // init
    sGrid.checked = getGridOn();
    sGridSize.value = getGridSize();
    sGridDensity.value = Math.max(1, Math.round(100 / getGridSize()));
    sDockPx.value = getDockPx();
    sAlignPx.value = getAlignPx();
    sGroup.checked = getGroupDrag();

    // handlers
    sGrid.addEventListener("change", ()=>{
      localStorage.setItem(KEY_GRID, sGrid.checked ? "true" : "false");
      showBrief(banner, sGrid.checked ? "📐 Grid on" : "📐 Grid off");
    });
    const persistGridSize = (px)=>{
      const v=clampNum(px,2,64);
      localStorage.setItem(KEY_GRID_SIZE,String(v));
      sGridSize.value=v; sGridDensity.value=Math.max(1, Math.round(100/v));
      if(getGridOn()) showBrief(banner,`📏 ${v}px grid`);
    };
    sGridSize.addEventListener("change", ()=>persistGridSize(parseInt(sGridSize.value,10)));
    sGridDensity.addEventListener("change", ()=>{
      const dens=clampNum(parseInt(sGridDensity.value,10),1,50);
      persistGridSize(Math.round(100 / dens));
    });
    sDockPx.addEventListener("change", ()=>{
      const v=clampNum(parseInt(sDockPx.value,10),6,48);
      localStorage.setItem(KEY_DOCK_STRENGTH,String(v));
      showBrief(banner,`🧲 Dock strength ${v}px`);
    });
    sAlignPx.addEventListener("change", ()=>{
      const v=clampNum(parseInt(sAlignPx.value,10),4,64);
      localStorage.setItem(KEY_ALIGN_THRESH,String(v));
      showBrief(banner,`📐 Align threshold ${v}px`);
    });
    sGroup.addEventListener("change", ()=>{
      localStorage.setItem(KEY_GROUP_DRAG, sGroup.checked ? "true":"false");
      showBrief(banner, sGroup.checked ? "👥 Group drag on" : "👤 Group drag off");
    });

    container.append(
      rowL("Snap to grid","sGrid", sGrid),
      rowL("Grid size (px)","sGridSize", sGridSize),
      rowL("Grid density (cells / 100px)","sGridDensity", sGridDensity),
      rowL("Dock strength (px)","sDockPx", sDockPx),
      rowL("Align threshold (px)","sAlignPx", sAlignPx),
      rowL("Group dragging","sGroup", sGroup),
    );
  }

  // Drag & dock core (group aware)
  const rect = (n)=>n?.getBoundingClientRect();
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  function withMeasure(el, fn){
    const cs=getComputedStyle(el), hidden=cs.display==="none";
    const prev={ d:el.style.display, v:el.style.visibility, o:el.style.opacity };
    if(hidden){ el.style.visibility="hidden"; el.style.opacity="0"; el.style.display="block"; }
    try{ return fn(); } finally {
      if(hidden){ el.style.display=prev.d; el.style.visibility=prev.v; el.style.opacity=prev.o; }
    }
  }
  const vb = el => withMeasure(el, ()=>({ maxX:Math.max(0, window.innerWidth - el.offsetWidth), maxY:Math.max(0, window.innerHeight - el.offsetHeight) }));
  const clampToViewport = (el,x,y)=>{ const {maxX,maxY}=vb(el); return { x:Math.max(0,Math.min(maxX,x)), y:Math.max(0,Math.min(maxY,y)) }; };
    function animateTo(el,x2,y2,key){
        const rr=rect(el); if(!rr) return;
        const x1=rr.left, y1=rr.top, dx=x2-x1, dy=y2-y1, t0=performance.now();
        const D = TIMING.med;
        const ease = t => 1 - Math.pow(1 - t, 3); // mirrors --hg-ease shape well

        const step = now => {
            const t = Math.min(1, (now - t0) / D);
            const k = ease(t);
            el.style.left = (x1 + dx * k) + "px";
            el.style.top  = (y1 + dy * k) + "px";
            if (t < 1) requestAnimationFrame(step);
            else try { localStorage.setItem(key, JSON.stringify({ x: Math.round(x2), y: Math.round(y2) })); } catch {}
        };
        requestAnimationFrame(step);
    }
  function computeDock(el,x,y){
    const th=getDockPx(); const me=withMeasure(el,()=>({w:el.offsetWidth,h:el.offsetHeight}));
    let best={x,y,d:Infinity,hit:false,axis:null,target:null,side:null};
    const cands=[
      {x:0, y, axis:"x", side:"edge-L", target:null},
      {x:window.innerWidth - me.w, y, axis:"x", side:"edge-R", target:null},
      {x, y:0, axis:"y", side:"edge-T", target:null},
      {x, y:window.innerHeight - me.h, axis:"y", side:"edge-B", target:null},
    ];
    const others=[hud,panel,statsPanel].filter(o=>o && o!==el && o.style.display!=="none");
    for(const o of others){
      const rr=rect(o); if(!rr) continue;
      cands.push(
        {x:rr.left - me.w, y, axis:"x", side:"win-RtoL", target:o},
        {x:rr.right,       y, axis:"x", side:"win-LtoR", target:o},
        {x, y:rr.top - me.h, axis:"y", side:"win-BtoT", target:o},
        {x, y:rr.bottom,     axis:"y", side:"win-TtoB", target:o},
      );
    }
    for(const c of cands){ const d=Math.hypot(c.x-x, c.y-y); if(d<th && d<best.d) best={...c,d,hit:true}; }
    return best;
  }
  function applyOrthogonalGrid(el, x, y, dockAxis){
    if(!getGridOn()) return {x,y};
    const g=getGridSize(); if(dockAxis==="x") y=Math.round(y/g)*g; else if(dockAxis==="y") x=Math.round(x/g)*g;
    return {x,y};
  }
  function alignAlongAxisIfClose(el, x, y, dock){
    const alignPx=getAlignPx(); if(!dock.hit) return {x,y};
    const meRect=rect(el); if(!meRect) return {x,y};
    if(!dock.target){
      if(dock.axis==="x"){ if(Math.abs(y-0)<=alignPx) y=0;
        const bottomGap=window.innerHeight-(y+meRect.height);
        if(Math.abs(bottomGap)<=alignPx) y=window.innerHeight-meRect.height;
      }else{
        if(Math.abs(x-0)<=alignPx) x=0;
        const rightGap=window.innerWidth-(x+meRect.width);
        if(Math.abs(rightGap)<=alignPx) x=window.innerWidth-meRect.width;
      }
      return {x,y};
    }
    const tRect=rect(dock.target); if(!tRect) return {x,y};
    if(dock.axis==="x"){
      if(Math.abs(y - tRect.top)<=alignPx) y=tRect.top;
      else if(Math.abs((y+meRect.height)-tRect.bottom)<=alignPx) y=tRect.bottom-meRect.height;
    }else{
      if(Math.abs(x - tRect.left)<=alignPx) x=tRect.left;
      else if(Math.abs((x+meRect.width)-tRect.right)<=alignPx) x=tRect.right-meRect.width;
    }
    return {x,y};
  }
  function overlap1D(a1,a2,b1,b2){ return Math.min(a2,b2)-Math.max(a1,b1); }
  function windowsMated(a,b){
    const A=rect(a),B=rect(b); if(!A||!B) return null;
    const th=getDockPx();
    if(Math.abs(A.right-B.left)<=th && overlap1D(A.top,A.bottom,B.top,B.bottom)>8) return "RtoL";
    if(Math.abs(B.right-A.left)<=th && overlap1D(A.top,A.bottom,B.top,B.bottom)>8) return "LtoR";
    if(Math.abs(A.bottom-B.top)<=th && overlap1D(A.left,A.right,B.left,B.right)>8) return "BtoT";
    if(Math.abs(B.bottom-A.top)<=th && overlap1D(A.left,A.right,B.left,B.right)>8) return "TtoB";
    return null;
  }
  const ALL_WINS = ()=>[hud,panel,statsPanel].filter(Boolean);
  function buildGroup(rootEl){
    const group=new Set([rootEl]); let changed=true;
    while(changed){
      changed=false;
      for(const a of Array.from(group)){
        for(const b of ALL_WINS()){
          if(group.has(b)) continue;
          if(windowsMated(a,b)){ group.add(b); changed=true; }
        }
      }
    }
    return Array.from(group);
  }
  function stripAnchors(el){ el.style.right=""; el.style.bottom=""; el.style.transform=""; el.style.position="fixed"; }
  function defHUD(el){ stripAnchors(el); return withMeasure(el, ()=>({ x: Math.max(0, window.innerWidth - el.offsetWidth - 20), y: 20 })); }
  function defStats(el){ stripAnchors(el); return { x:20, y:20 }; }
  function defSettings(el){ stripAnchors(el); return withMeasure(el, ()=>({ x:Math.max(0,(window.innerWidth - el.offsetWidth )/2), y:Math.max(0,(window.innerHeight - el.offsetHeight)/2) })); }
  function savedIsVisible(el,pos){
    if(!pos||typeof pos.x!=="number"||typeof pos.y!=="number") return false;
    return withMeasure(el, ()=>{ const {maxX,maxY}=vb(el); return pos.x>=0 && pos.y>=0 && pos.x<=maxX && pos.y<=maxY; });
  }
  function guaranteeOnScreen(el,key,defFn){
    stripAnchors(el);
    withMeasure(el, ()=>{
      const rr=rect(el); if(!rr) return;
      const off = (rr.left<-5 || rr.top<-5 || rr.right>window.innerWidth+5 || rr.bottom>window.innerHeight+5);
      let nx=rr.left, ny=rr.top;
      if(off){ const d=defFn(el); nx=d.x; ny=d.y; }
      const cl=clampToViewport(el,nx,ny);
      el.style.left=cl.x+"px"; el.style.top=cl.y+"px";
      try{ localStorage.setItem(key, JSON.stringify({x:cl.x,y:cl.y})); }catch{}
    });
  }
  function makeDraggable(el, handle, key, defFn){
    if(!el||!handle) return;
    stripAnchors(el);
    let saved = safeParse(localStorage.getItem(key), null);
    let start = savedIsVisible(el, saved) ? saved : defFn(el);
    el.style.left = start.x+"px"; el.style.top = start.y+"px"; guaranteeOnScreen(el,key,defFn);

    let down=false, sx=0, sy=0, ox=0, oy=0;
    let group=[], starts=[], groupBox=null, useGroup=false;

    const bounds=(list)=>{ const rs=list.map(w=>rect(w)).filter(Boolean);
      return { left:Math.min(...rs.map(a=>a.left)), top:Math.min(...rs.map(a=>a.top)),
               right:Math.max(...rs.map(a=>a.right)), bottom:Math.max(...rs.map(a=>a.bottom)) }; };

    handle.addEventListener("mousedown", (e)=>{
      down=true; sx=el.offsetLeft; sy=el.offsetTop; ox=e.clientX; oy=e.clientY;
      if(getGroupDrag()) group = buildGroup(el); else group=[el];
      starts = group.map(w=>({w, x:w.offsetLeft, y:w.offsetTop}));
      groupBox = bounds(group); useGroup = (group.length>1);
      e.preventDefault(); e.stopPropagation();
    }, true);

    window.addEventListener("mousemove", (e)=>{
      if(!down) return;
      const dx = e.clientX - ox, dy = e.clientY - oy;
      if(useGroup){
        let nxL = groupBox.left + dx, nyT = groupBox.top + dy;
        let nxR = groupBox.right + dx, nyB = groupBox.bottom + dy;
        if(nxL<0){ nxR-=nxL; nxL=0; } if(nyT<0){ nyB-=nyT; nyT=0; }
        if(nxR>window.innerWidth){ const over=nxR-window.innerWidth; nxL-=over; nxR-=over; }
        if(nyB>window.innerHeight){ const over=nyB-window.innerHeight; nyT-=over; nyB-=over; }
        const gdx=nxL-groupBox.left, gdy=nyT-groupBox.top;
        starts.forEach(s=>{ s.w.style.left=(s.x+gdx)+"px"; s.w.style.top=(s.y+gdy)+"px"; });
      }else{
        const c = clampToViewport(el, sx+dx, sy+dy);
        el.style.left=c.x+"px"; el.style.top=c.y+"px";
      }
    }, true);

    window.addEventListener("mouseup", ()=>{
      if(!down) return; down=false;
      const rr=rect(el); if(!rr) return;
      let tx=rr.left, ty=rr.top;
      const dock = computeDock(el, tx, ty);
      if(dock.hit){
        if(dock.axis==="x") tx=dock.x; else ty=dock.y;
        ({x:tx,y:ty} = applyOrthogonalGrid(el, tx, ty, dock.axis));
        ({x:tx,y:ty} = alignAlongAxisIfClose(el, tx, ty, dock));
      }else if(getGridOn()){
        const g=getGridSize(); tx=Math.round(tx/g)*g; ty=Math.round(ty/g)*g;
      }
      const finalPos=clampToViewport(el, tx, ty);
      const fx = finalPos.x - rr.left, fy = finalPos.y - rr.top;
      animateTo(el, finalPos.x, finalPos.y, key);
      group.forEach(w=>{ if(w===el) return; w.style.left=(w.offsetLeft+fx)+"px"; w.style.top=(w.offsetTop+fy)+"px"; });
    }, true);

    window.addEventListener("resize", ()=>guaranteeOnScreen(el,key,defFn), {passive:true});
  }

  // Attach drags with sensible defaults
  try {
    makeDraggable(hud,       document.getElementById("hg-head"),  "HGv682_Pos_HUD",      defHUD);
    makeDraggable(statsPanel,statsPanel.firstElementChild,        "HGv682_Pos_Stats",    defStats);
    makeDraggable(panel,     panel.firstElementChild,             "HGv682_Pos_Settings", defSettings);
  } catch {}

  /**************************************************************************
   * HOTKEYS
   **************************************************************************/
  document.addEventListener("keydown", (e) => {
    if (isCapturing) return;

    if (isOverlayOpen()) {
      if (["ArrowLeft","ArrowRight","Space"].includes(e.code)) {
        e.stopImmediatePropagation(); e.preventDefault();
      }
    } else {
      if (e.code === "ArrowLeft" && lastAdEnd > 0) {
        const t = video ? (video.currentTime || 0) : 0;
        if (t < lastAdEnd + settings.POST_AD_LOCK) {
          e.preventDefault(); e.stopImmediatePropagation();
          if (video) video.currentTime = lastAdEnd + 0.1;
          showBrief(banner, "⏮️ Rewind locked");
          return;
        }
      }
    }

    const trySeq = (s, k, f) => s && stepSeq(e, s, k, f);
    let used=false;

    used = trySeq(settings.KEYS.toggleHUD, "toggleHUD", ()=>{ e.preventDefault(); setHudVisible(!HUD_VISIBLE); }) || used;
    used = trySeq(settings.KEYS.stats,     "stats",     ()=>{ e.preventDefault(); isStatsOpen()?closeStats():openStats(); }) || used;
    used = trySeq(settings.KEYS.microBack, "microBack", ()=>{ e.preventDefault(); microSkip(-settings.MICRO_SKIP_SEC); }) || used;
    used = trySeq(settings.KEYS.microFwd,  "microFwd",  ()=>{ e.preventDefault(); microSkip( settings.MICRO_SKIP_SEC); }) || used;
    used = trySeq(settings.KEYS.openSettings,"openSettings", ()=>{ e.preventDefault(); isSettingsOpen()?closeSettings():openSettings(); }) || used;

    if (used){ e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  /**************************************************************************
   * ANALYTICS PERSISTENCE (compact)
   **************************************************************************/
  try{
    const prev=safeParse(localStorage.getItem(KEY_ANALYTICS)||"[]",[]);
    if(Array.isArray(prev)) analytics = prev.concat(analytics);
    setInterval(()=>{ try{ localStorage.setItem(KEY_ANALYTICS, JSON.stringify(analytics)); }catch{} }, 30000);
  }catch{}

  /**************************************************************************
   * STARTUP LOOP
   **************************************************************************/
  setHudVisible(HUD_VISIBLE); wakeHUD();
  setInterval(()=>{ attach(); updateAd(); updateHUD(); }, 500);

  // Buttons
  bGear.title="Settings"; bKeys.title="Keybinds"; bHide.title="Hide HUD";

   setInterval(() => unlockInputsGlobal(), 1000);




})();// ==UserScript==
// @name         New Userscript
// @namespace    http://tampermonkey.net/
// @version      2025-10-29
// @description  try to take over the world!
// @author       You
// @match        https://*/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Your code here...
})();
