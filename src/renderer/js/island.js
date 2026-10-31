'use strict';

/**
 * Dynamic Island renderer.
 *
 * The main shell owns the assistant turn. This surface mirrors it and forwards
 * intents (chat, listen, stop, settings, open) back through the island bridge,
 * so there is never a second AI loop or a second voice pipeline. It has no
 * Node access and no provider configuration.
 *
 * The GLY mark is the same stage, sampler and shaders the shell uses. A
 * BrowserWindow necessarily owns its own WebGL context, so the rule is one
 * stage per island window: created once on first paint, paused whenever the
 * window is hidden, and disposed with the page.
 */

import { LogoStage } from '../visuals/stage.js';
import { LogoLoader } from '../visuals/logo-loader.js';

const api = window.legion;
const root = document.getElementById('island');
const markEl = document.getElementById('island-mark');
const stateEl = document.getElementById('island-state');
const inlineEl = document.getElementById('island-inline');
const captionEl = document.getElementById('island-caption');
const liveLabelEl = document.getElementById('island-live-label');
const threadEl = document.getElementById('island-thread');
const chevron = document.getElementById('island-chevron');
const stopBtn = document.getElementById('island-stop');
const micBtn = document.getElementById('island-mic');
const openBtn = document.getElementById('island-open');
const settingsBtn = document.getElementById('island-settings');
const pinBtn = document.getElementById('island-pin');
const closeBtn = document.getElementById('island-close');
const compose = document.getElementById('island-compose');
const input = document.getElementById('island-input');
const sendBtn = document.getElementById('island-send');

const THEMES = {
  'legion-dark': { accent: '#35c8ff', glow: 1.0, scan: 0.5 },
  abyss:         { accent: '#35c8ff', glow: 1.0, scan: 0.5 },
  ember:         { accent: '#ff7a45', glow: 1.1, scan: 0.42 },
  mint:          { accent: '#3ee2a4', glow: 0.95, scan: 0.4 },
  mono:          { accent: '#c8d2e0', glow: 0.8, scan: 0.3 }
};

/**
 * The island's surface is a fraction of the shell's area, so the tier whose
 * density matches it is LOW. The sampler, shaders and quality system are the
 * same; only the instance budget is sized for the box it fills. The field's
 * own floor (600) keeps the ring dense at 30 px.
 */
const ISLAND_CLOUD = 6000;
const ISLAND_QUALITY = 'low';
const ISLAND_PARTICLE_SCALE = 0.35;
const IDLE_FRAME_MS = 1000 / 30;

const CAPTIONS = {
  OFFLINE: 'Offline. Open LEGION to reconnect.',
  BOOTING: 'Starting up…',
  IDLE: 'Ready when you are.',
  LISTENING: 'Listening…',
  PROCESSING: 'Thinking…',
  SPEAKING: 'Responding…',
  ALERT: 'Needs your attention.',
  ERROR: 'Something went wrong.'
};

const LABELS = {
  OFFLINE: 'Offline',
  BOOTING: 'Starting',
  IDLE: 'Ready',
  LISTENING: 'Listening',
  PROCESSING: 'Thinking',
  SPEAKING: 'Responding',
  ALERT: 'Attention',
  ERROR: 'Error'
};

const MODES = {
  LISTENING: 'LISTENING',
  PROCESSING: 'THINKING',
  SPEAKING: 'RESPONDING'
};

const BUSY_STATES = ['PROCESSING', 'SPEAKING'];
const ACTIVITY_STATES = ['LISTENING', 'PROCESSING', 'SPEAKING', 'ALERT', 'ERROR'];
const MAX_MESSAGES = 10;

let expanded = false;
let pinned = false;
let currentState = 'IDLE';
let liveCaption = '';
let liveInterim = false;
let streamingText = '';
let streamEl = null;
let awaitingReply = false;
let lastError = '';
let stateSynced = false;

/* GLY mark lifecycle. One stage, one canvas, one sampler. */
let stage = null;
let markLoader = null;
let markRaf = 0;
let markReady = false;
let markFailed = false;
let markLastFrame = 0;
let markVisible = false;
let audioFrames = 0;
const visual = { accent: THEMES.abyss.accent, glow: THEMES.abyss.glow, themeIntensity: 1, reducedMotion: false, bloom: true };

function hexToRgba(hex, alpha) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return `rgba(53, 200, 255, ${alpha})`;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Accept either a theme key (what config stores) or a resolved hex colour
 * (what the main renderer relays when the theme changes).
 */
function setAccent(themeOrHex, glow) {
  const direct = typeof themeOrHex === 'string' && themeOrHex.startsWith('#');
  const t = THEMES[themeOrHex] || (direct
    ? { accent: themeOrHex, glow: glow === undefined ? 1 : glow }
    : THEMES.abyss);
  document.documentElement.style.setProperty('--accent', t.accent);
  document.documentElement.style.setProperty('--accent-dim', hexToRgba(t.accent, 0.18));
  visual.accent = t.accent;
  visual.glow = t.glow;
  if (stage) stage.setAccent(t.accent, t.glow);
}

/* ── GLY mark ───────────────────────────────────────────────── */

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
}

function markShouldRun() {
  return !!stage && markVisible && !document.hidden;
}

function stopMarkLoop() {
  if (markRaf) cancelAnimationFrame(markRaf);
  markRaf = 0;
}

function startMarkLoop() {
  if (markRaf || !markShouldRun()) return;
  markLastFrame = performance.now();
  markRaf = requestAnimationFrame(tickMark);
}

/**
 * The island runs its own loop instead of `stage.start()` so it can own the
 * frame policy: full rate while a turn is live, half rate while idle, and no
 * frames at all while the window is hidden. `stage.frame(dt)` advances the
 * same easing and uniforms the shell uses.
 */
function tickMark(now) {
  markRaf = 0;
  if (!stage || !markVisible || document.hidden) return;
  const dt = Math.min(0.05, Math.max(0, (now - markLastFrame) / 1000));
  const active = currentState !== 'IDLE' && currentState !== 'OFFLINE';
  const minStep = active ? 0 : IDLE_FRAME_MS / 1000;
  if (dt >= minStep) {
    markLastFrame = now;
    stage.frame(dt);
  }
  markRaf = requestAnimationFrame(tickMark);
}

async function ensureMark() {
  if (stage || markFailed || !markEl) return;
  markLoader = new LogoLoader();
  try {
    stage = new LogoStage(markEl, {
      quality: ISLAND_QUALITY,
      particleScale: ISLAND_PARTICLE_SCALE,
      themeIntensity: visual.themeIntensity,
      reducedMotion: visual.reducedMotion || prefersReducedMotion(),
      bloom: visual.bloom,
      adaptive: false,
      parallax: false,
      scanlines: false
    });
  } catch (_) {
    markFailed = true;
    markLoader.cancel();
    markLoader = null;
    root.dataset.gly = 'fallback';
    return;
  }

  stage.setAccent(visual.accent, visual.glow);
  stage.setThemeIntensity(visual.themeIntensity);
  stage.setState(currentState);

  let cloud;
  try {
    cloud = await markLoader.generate(ISLAND_CLOUD);
  } catch (_) {
    markFailed = true;
    markLoader = null;
    try { stage.dispose(); } catch (_) { /* already gone */ }
    stage = null;
    root.dataset.gly = 'fallback';
    return;
  }

  // The page may have been torn down while the worker was sampling.
  if (!stage) return;
  markLoader = null;
  stage.setCloud(cloud);
  markReady = true;
  root.dataset.gly = 'ready';
  stage.frame(0.016);
  startMarkLoop();
}

function disposeMark() {
  stopMarkLoop();
  markVisible = false;
  if (markLoader) { try { markLoader.cancel(); } catch (_) { /* ignore */ } }
  markLoader = null;
  const s = stage;
  stage = null;
  markReady = false;
  if (s) { try { s.dispose(); } catch (_) { /* ignore */ } }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopMarkLoop();
  else startMarkLoop();
});

window.addEventListener('pagehide', disposeMark, { once: true });

try {
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
    if (stage) stage.setReducedMotion(!!e.matches || visual.reducedMotion);
  });
} catch (_) { /* older Chromium: the media query is still read at boot */ }

/* ── layout ─────────────────────────────────────────────────── */

function renderExpanded() {
  root.dataset.expanded = String(expanded);
  chevron.title = expanded ? 'Collapse' : 'Expand';
  chevron.setAttribute('aria-label', expanded ? 'Collapse island' : 'Expand island');
  pinBtn.setAttribute('aria-pressed', String(pinned));
}

function modeFor(state) {
  if (expanded) return 'EXPANDED';
  return MODES[state] || 'COMPACT';
}

function renderMode() {
  root.dataset.mode = modeFor(currentState);
  root.dataset.activity = ACTIVITY_STATES.includes(currentState) ? 'active' : 'idle';
}

function renderLive() {
  const text = streamingText || liveCaption || CAPTIONS[currentState] || CAPTIONS.IDLE;
  captionEl.textContent = text;
  captionEl.classList.toggle('interim', liveInterim && !streamingText);
  inlineEl.textContent = text;
  inlineEl.title = text;
  const label = LABELS[currentState] || currentState;
  liveLabelEl.textContent = streamingText ? `${label} · live` : label;

  const busy = BUSY_STATES.includes(currentState);
  sendBtn.disabled = busy;
  stopBtn.hidden = !(currentState === 'LISTENING' || busy);
  stopBtn.title = currentState === 'LISTENING' ? 'Stop listening' : 'Stop generating';
  stopBtn.setAttribute('aria-label', stopBtn.title);
  micBtn.title = currentState === 'LISTENING' ? 'Stop listening' : busy ? 'Stop generating' : 'Talk';
  micBtn.setAttribute('aria-label', micBtn.title);
}

function setState(next, detail) {
  const state = String(next || 'IDLE');
  currentState = state;
  root.dataset.state = state;
  stateEl.textContent = state;

  if (state === 'LISTENING') {
    liveCaption = CAPTIONS.LISTENING;
    liveInterim = true;
  } else if (state === 'PROCESSING') {
    if (!streamingText) liveCaption = CAPTIONS.PROCESSING;
  } else if (state === 'ERROR') {
    const message = (detail && (detail.message || detail.code)) || CAPTIONS.ERROR;
    liveCaption = message;
    liveInterim = false;
    awaitingReply = false;
    appendError(message);
  } else if (state === 'IDLE') {
    if (!liveCaption) liveCaption = CAPTIONS.IDLE;
    liveInterim = false;
  } else if (state === 'ALERT' || state === 'OFFLINE' || state === 'BOOTING') {
    liveCaption = CAPTIONS[state];
    liveInterim = false;
  }

  renderMode();
  renderLive();

  // Only real transitions retarget the mark; re-applying the same state would
  // restart the boot timing and pin every easing target to the current instant.
  if (stage && stage.state !== state) stage.setState(state);
}

/* ── transcript ─────────────────────────────────────────────── */

function clearEmptyHint() {
  const hint = threadEl.querySelector('.island-empty');
  if (hint) hint.remove();
}

function trimThread() {
  const messages = [...threadEl.querySelectorAll('.island-msg')];
  for (let i = 0; i < messages.length - MAX_MESSAGES; i++) messages[i].remove();
}

function scrollThread() {
  threadEl.scrollTop = threadEl.scrollHeight;
}

function appendMessage(kind, text) {
  const value = String(text || '').trim();
  if (!value) return null;
  clearEmptyHint();
  const el = document.createElement('div');
  el.className = `island-msg is-${kind}`;
  el.textContent = value;
  threadEl.appendChild(el);
  trimThread();
  scrollThread();
  return el;
}

function appendError(message) {
  const value = String(message || '').trim();
  if (!value || value === lastError) return;
  lastError = value;
  appendMessage('error', value);
}

function resetStream() {
  if (streamEl) streamEl.classList.remove('is-streaming');
  streamEl = null;
  streamingText = '';
}

function updateStream(text) {
  const value = String(text || '');
  if (!value) {
    if (streamEl) streamEl.classList.remove('is-streaming');
    streamEl = null;
    return;
  }
  if (!streamEl) streamEl = appendMessage('assistant', value);
  else streamEl.textContent = value;
  if (streamEl) {
    streamEl.classList.add('is-streaming');
    scrollThread();
  }
}

function finalizeStream() {
  if (streamEl) streamEl.classList.remove('is-streaming');
  streamEl = null;
}

/* ── actions ────────────────────────────────────────────────── */

async function toggleExpand() {
  const next = !expanded;
  applyStatus({ expanded: next, pinned });
  try { await api.island.expand(next); } catch (_) { /* window may be closing */ }
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text || BUSY_STATES.includes(currentState)) return;
  try {
    const res = await api.island.command('chat', { text });
    if (res && res.ok === false) {
      appendError(res.error || 'Could not send that message.');
      return;
    }
    input.value = '';
    awaitingReply = true;
  } catch (err) {
    appendError(err && err.message ? err.message : 'Could not send that message.');
  }
}

async function primaryAction() {
  if (currentState === 'LISTENING') {
    await api.island.command('stop').catch(() => {});
    return;
  }
  if (BUSY_STATES.includes(currentState)) {
    await api.island.command('cancel').catch(() => {});
    return;
  }
  await api.island.command('listen').catch(() => {});
}

function applyStatus(s) {
  if (!s) return;
  expanded = !!s.expanded;
  pinned = !!s.pinned;
  if (typeof s.visible === 'boolean') {
    markVisible = s.visible;
    if (markVisible) startMarkLoop();
    else stopMarkLoop();
  }
  renderExpanded();
  renderMode();
  renderLive();
}

/** Apply the mark-relevant half of the shell's visual policy. */
function applyVisual(v) {
  if (!v) return;
  if (v.accent) setAccent(v.accent, v.glow);
  if (v.themeIntensity !== undefined) {
    visual.themeIntensity = Math.max(0.15, Math.min(1.6, Number(v.themeIntensity) || 1));
  }
  if (typeof v.reducedMotion === 'boolean') visual.reducedMotion = v.reducedMotion;
  if (typeof v.bloom === 'boolean') visual.bloom = v.bloom;
  if (!stage) return;
  stage.setThemeIntensity(visual.themeIntensity);
  stage.setReducedMotion(visual.reducedMotion || prefersReducedMotion());
  stage.opts.bloom = visual.bloom;
}

/**
 * Measured microphone or playback levels only. A relayed payload is already
 * 0..1 from the shell's analysers; anything out of range is clamped rather
 * than trusted, and nothing here synthesises activity of its own.
 */
function applyAudio(p) {
  if (!stage) return;
  const n = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  audioFrames++;
  const mode = p.mode === 'speaking' ? 'speaking' : p.mode === 'listening' ? 'listening' : 'idle';
  stage.setAudio({ low: n(p.low), mid: n(p.mid), high: n(p.high), energy: n(p.energy) }, mode);
}

/* ── wiring ─────────────────────────────────────────────────── */

chevron.addEventListener('click', toggleExpand);
pinBtn.addEventListener('click', async () => {
  pinned = !pinned;
  renderExpanded();
  try { await api.island.pin(pinned); } catch (_) { /* noop */ }
});

openBtn.addEventListener('click', () => { api.island.command('open').catch(() => {}); });
settingsBtn.addEventListener('click', () => { api.island.command('settings').catch(() => {}); });
closeBtn.addEventListener('click', () => { api.island.hide().catch(() => {}); });

micBtn.addEventListener('click', primaryAction);
stopBtn.addEventListener('click', () => {
  const command = currentState === 'LISTENING' ? 'stop' : 'cancel';
  api.island.command(command).catch(() => {});
});

compose.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

document.getElementById('island-head').addEventListener('dblclick', (e) => {
  if (e.target.closest('button')) return;
  api.island.command('open').catch(() => {});
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (expanded) { toggleExpand(); return; }
    api.island.hide().catch(() => {});
  }
});

/* events ────────────────────────────────────────────────────── */

api.on('state', (p) => { if (p) { stateSynced = true; setState(p.state, p.detail); } });

api.on('island:relay', (p) => {
  if (!p || !p.kind) return;

  if (p.kind === 'audio') {
    applyAudio(p);
    return;
  }

  if (p.kind === 'visual') {
    applyVisual(p);
    return;
  }

  if (p.kind === 'state') {
    if (p.state) { stateSynced = true; setState(p.state, p.detail); }
    return;
  }

  if (p.kind === 'caption') {
    liveCaption = p.caption || '';
    liveInterim = !!p.interim;
    streamingText = p.streaming || '';
    if (streamingText) updateStream(streamingText);
    else {
      if (!liveCaption && !BUSY_STATES.includes(currentState)) finalizeStream();
      else if (!streamingText) finalizeStream();
    }
    renderLive();

    // A provider that does not stream still needs the final reply in the
    // thread. Only add it once, and never while a stream bubble is live.
    if (!streamingText && !liveInterim && liveCaption && awaitingReply && !streamEl) {
      const isReplyState = currentState === 'SPEAKING' || currentState === 'PROCESSING';
      if (isReplyState) {
        appendMessage('assistant', liveCaption);
        awaitingReply = false;
      }
    }
    return;
  }

  if (p.kind === 'user') {
    resetStream();
    awaitingReply = true;
    lastError = '';
    appendMessage('user', p.text);
    liveCaption = '';
    liveInterim = true;
    renderLive();
  }
});

api.on('island:action', (p) => {
  if (!p || p.action !== 'focus-input') return;
  input.focus();
});

api.on('ai:event', (ev) => {
  if (!ev || ev.type !== 'error') return;
  const p = ev.payload || {};
  appendError(p.message || CAPTIONS.ERROR);
});

api.on('island:state', applyStatus);

/* boot ──────────────────────────────────────────────────────── */

api.config.get()
  .then((c) => {
    // `config:get` returns { settings, secret, ... }; reading `c.ui` here hid
    // the user's theme and left the island on the default accent.
    const s = (c && c.settings) || {};
    setAccent(s.ui?.theme || 'abyss');
    applyVisual({
      themeIntensity: s.visual?.themeIntensity ?? 1,
      reducedMotion: !!s.visual?.reducedMotion,
      bloom: s.visual?.bloom !== false
    });
  })
  .catch(() => setAccent('abyss'))
  .finally(() => ensureMark());

api.app.state()
  .then((r) => {
    // The window load already replays main's current state; only use this
    // request as a fallback for the case where that push did not arrive.
    if (stateSynced) return;
    setState(r && r.state ? r.state : 'IDLE', r && r.error);
  })
  .catch(() => { if (!stateSynced) setState('IDLE'); });

api.island.status()
  .then((s) => { applyStatus(s); renderLive(); })
  .catch(() => { renderLive(); });

renderExpanded();
renderMode();
renderLive();

/**
 * Read-only mark diagnostics, mirroring `window.legionApp` in the shell. It
 * lets the live harness prove the context is alive, the loop is paused while
 * the window is hidden, and the particle budget matches this surface.
 */
window.legionIsland = {
  mark() {
    const canvas = markEl ? markEl.querySelector('canvas') : null;
    let glError = null;
    if (canvas) {
      try {
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (gl) glError = gl.getError();
      } catch (_) { glError = 'unavailable'; }
    }
    return {
      ready: markReady,
      failed: markFailed,
      state: stage ? stage.state : null,
      running: markRaf !== 0,
      canvases: document.querySelectorAll('canvas').length,
      instances: stage ? stage.currentInstances || 0 : 0,
      fps: stage ? Math.round(stage.fps) : 0,
      audioFrames,
      audio: stage ? { ...stage.audio } : null,
      display: {
        width: canvas ? canvas.width : 0,
        height: canvas ? canvas.height : 0,
        cssWidth: canvas ? canvas.clientWidth : 0,
        cssHeight: canvas ? canvas.clientHeight : 0
      },
      glError
    };
  }
};
