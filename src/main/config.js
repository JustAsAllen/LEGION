'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_VERSION = 1;

const DEFAULTS = Object.freeze({
  version: CONFIG_VERSION,
  onboarded: false,

  ai: {
    provider: 'none',            // none | anthropic | openai | ollama
    model: '',
    baseUrl: '',
    temperature: 0.3,
    maxTokens: 900,
    systemPrompt: '',
    contextTurns: 12
  },

  voice: {
    enabled: true,
    voiceName: '',                 // SAPI voice name, e.g. "Microsoft David Desktop"
    pushToTalk: true,
    continuous: false,
    wakeWordEnabled: false,
    wakeWord: 'hey legion',
    micDeviceId: 'default',
    speakerDeviceId: 'default',
    rate: 0,                     // -10 .. 10
    volume: 100,                 // 0 .. 100
    pitch: 0,                    // -10 .. 10
    muted: false,                // microphone muted; analyser stays live so the
                                 // level meter still shows the true input level
    sttEngine: 'sapi',           // the only implemented engine is Windows SAPI
    whisperModelPath: ''
  },

  visual: {
    quality: 'high',             // low | medium | high | ultra
    adaptiveQuality: true,
    particleScale: 1.0,
    themeIntensity: 1.0,
    reducedMotion: false,
    bloom: true,
    showScanlines: true,
    showWaveform: true
  },

  memory: {
    enabled: true,
    longTermEnabled: false,      // opt-in, off by default
    maxSessionMessages: 200
  },

  tools: {
    enabled: true,
    allowSystem: true,
    allowApps: true,
    allowFiles: true,
    allowWeb: true,
    allowDev: false,              // opt-in — runs allowlisted dev commands
    allowProductivity: true,
    requireConfirmation: true,
    fileRoots: []                 // empty = user profile root only
  },

  app: {
    launchAtStartup: false,
    playBootAnimation: true,
    startMinimized: false,
    autoListenOnLaunch: false,   // mic is never opened without explicit opt-in
    closeToTray: true
  },

  ui: {
    panel: 'none',               // none | conversation | tools | memory | settings
    panelPosition: 'right',      // right | left
    theme: 'legion-dark'
  },

  window: {
    width: 1440,
    height: 900,
    x: null,
    y: null
  },

  privacy: {
    storeConversations: true,
    telemetry: false,
    redactSecrets: true
  }
});

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch === undefined ? base : patch;
  }
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const key of Object.keys(patch)) {
    const b = base ? base[key] : undefined;
    const p = patch[key];
    if (b && typeof b === 'object' && !Array.isArray(b) && p && typeof p === 'object' && !Array.isArray(p)) {
      out[key] = deepMerge(b, p);
    } else {
      out[key] = p;
    }
  }
  return out;
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

class ConfigStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'settings.json');
    this.data = clone(DEFAULTS);
    this._writeTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = deepMerge(clone(DEFAULTS), parsed);
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        try {
          const bak = this.file + '.corrupt-' + Date.now();
          fs.renameSync(this.file, bak);
        } catch (_) { /* ignore */ }
      }
      this.data = clone(DEFAULTS);
      this.saveNow();
    }
    return this.data;
  }

  get() { return this.data; }

  patch(partial) {
    if (!partial || typeof partial !== 'object') return this.data;
    const allowed = new Set(Object.keys(DEFAULTS));
    const safe = {};
    for (const key of Object.keys(partial)) {
      if (!allowed.has(key)) continue;
      safe[key] = partial[key];
    }
    this.data = deepMerge(this.data, safe);
    this.scheduleSave();
    return this.data;
  }

  reset() {
    this.data = clone(DEFAULTS);
    this.saveNow();
    return this.data;
  }

  scheduleSave() {
    if (this._writeTimer) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      this.saveNow();
    }, 250);
    if (this._writeTimer.unref) this._writeTimer.unref();
  }

  saveNow() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err) {
      console.error('[config] save failed:', err.message);
      return false;
    }
  }
}

module.exports = { ConfigStore, DEFAULTS, deepMerge, clone };
