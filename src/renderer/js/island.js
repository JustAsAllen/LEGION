'use strict';

/**
 * Dynamic Island renderer.
 *
 * Read-only mirror of the main shell's state. It never touches memory, tools,
 * or provider settings; the only actions it can take are the three the bridge
 * exposes: expand, pin, and ask the main window to listen/cancel/show.
 */

const api = window.legion;
const root = document.getElementById('island');
const stateEl = document.getElementById('island-state');
const captionEl = document.getElementById('island-caption');
const chevron = document.getElementById('island-chevron');
const micBtn = document.getElementById('island-mic');
const openBtn = document.getElementById('island-open');
const pinBtn = document.getElementById('island-pin');

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
  SPEAKING: 'Speaking…',
  ALERT: 'Needs your attention.',
  ERROR: 'Something went wrong.'
};

let expanded = false;
let pinned = false;
let currentState = 'IDLE';
let stream = '';
let lastReply = '';

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

function renderExpanded() {
  root.dataset.expanded = String(expanded);
  chevron.title = expanded ? 'Collapse' : 'Expand';
  chevron.setAttribute('aria-label', expanded ? 'Collapse island' : 'Expand island');
  pinBtn.setAttribute('aria-pressed', String(pinned));
}

function renderCaption(text) {
  const value = String(text || '').trim();
  captionEl.textContent = value || CAPTIONS[currentState] || CAPTIONS.IDLE;
}

function setState(next, detail) {
  const state = String(next || 'IDLE');
  const changed = state !== currentState;
  currentState = state;
  root.dataset.state = state;
  stateEl.textContent = state;

  if (changed && state === 'PROCESSING') { stream = ''; renderCaption(CAPTIONS.PROCESSING); }
  if (state === 'LISTENING') renderCaption(CAPTIONS.LISTENING);
  else if (state === 'IDLE') renderCaption(lastReply || CAPTIONS.IDLE);
  else if (state === 'ERROR') {
    const message = detail && (detail.message || detail.code);
    renderCaption(message || CAPTIONS.ERROR);
  } else if (state === 'ALERT') renderCaption(CAPTIONS.ALERT);
  else if (state === 'OFFLINE') renderCaption(CAPTIONS.OFFLINE);
  else if (state === 'BOOTING') renderCaption(CAPTIONS.BOOTING);
  else if (state === 'SPEAKING') renderCaption(lastReply || CAPTIONS.SPEAKING);
}

function applyStatus(s) {
  if (!s) return;
  expanded = !!s.expanded;
  pinned = !!s.pinned;
  renderExpanded();
}

async function toggleExpand() {
  const next = !expanded;
  applyStatus({ expanded: next, pinned });
  try { await api.island.expand(next); } catch (_) { /* window may be closing */ }
}

chevron.addEventListener('click', toggleExpand);

document.getElementById('island-head').addEventListener('dblclick', (e) => {
  if (e.target.closest('button')) return;
  api.island.command('show').catch(() => {});
});

openBtn.addEventListener('click', () => { api.island.command('show').catch(() => {}); });

micBtn.addEventListener('click', async () => {
  if (currentState === 'SPEAKING' || currentState === 'PROCESSING') {
    await api.island.command('cancel').catch(() => {});
  }
  await api.island.command('listen').catch(() => {});
});

pinBtn.addEventListener('click', async () => {
  pinned = !pinned;
  renderExpanded();
  try { await api.island.pin(pinned); } catch (_) { /* noop */ }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (expanded) toggleExpand();
    else api.island.hide().catch(() => {});
  }
});

api.on('state', (p) => { if (p) setState(p.state, p.detail); });

api.on('ai:event', (ev) => {
  if (!ev || !ev.type) return;
  const p = ev.payload || {};
  if (ev.type === 'delta' || ev.type === 'text-delta' || ev.type === 'text') {
    stream += p.text || p.delta || '';
    if (stream.length > 600) stream = stream.slice(-600);
    lastReply = stream.trim();
    renderCaption(lastReply);
  } else if (ev.type === 'error') {
    renderCaption(p.message || CAPTIONS.ERROR);
  }
});

api.on('island:state', applyStatus);

api.config.get()
  .then((c) => { if (c && c.ui) setAccent(c.ui.theme); })
  .catch(() => setAccent('abyss'));

api.island.status().then((s) => { applyStatus(s); setState(currentState); }).catch(() => setState(currentState));

renderExpanded();
