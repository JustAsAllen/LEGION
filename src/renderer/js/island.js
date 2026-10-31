'use strict';

/**
 * Dynamic Island renderer.
 *
 * The main shell owns the assistant turn. This surface mirrors it and forwards
 * intents (chat, listen, stop, settings, open) back through the island bridge,
 * so there is never a second AI loop or a second voice pipeline. It has no
 * Node access and no provider configuration.
 */

const api = window.legion;
const root = document.getElementById('island');
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
  'legion-dark': '#35c8ff',
  abyss: '#35c8ff',
  ember: '#ff7a45',
  mint: '#3ee2a4',
  mono: '#c8d2e0'
};

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

function hexToRgba(hex, alpha) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return `rgba(53, 200, 255, ${alpha})`;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function setAccent(hex) {
  const accent = THEMES[hex] || THEMES.abyss;
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-dim', hexToRgba(accent, 0.18));
}

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
  renderExpanded();
  renderMode();
  renderLive();
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
  .then((c) => { if (c && c.ui) setAccent(c.ui.theme); })
  .catch(() => setAccent('abyss'));

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
