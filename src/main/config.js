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
    rate: 0,                     // -10 .. 10
    volume: 100,                 // 0 .. 100
    muted: false,                // microphone muted; analyser stays live so the
                                 // level meter still shows the true input level
    // The voice pipeline, in tier order: pack (prerecorded) -> online (Edge
    // neural) -> piper (local neural) -> sapi. ttsMode picks how far down the
    // list it may go:
    //   auto      every tier, online included
    //   offline   never touches the network
    //   pack-only clips only, silence for anything not recorded
    ttsMode: 'auto',             // auto | offline | pack-only
    onlineVoice: 'en-US-AriaNeural',
    piperPath: '',               // optional explicit piper.exe; '' = probe
    piperModel: ''               // optional explicit .onnx model
    // speakerDeviceId, pitch, sttEngine and whisperModelPath were removed
    // because nothing ever read them. System.Speech exposes no output-device
    // selection and no Pitch property, and only the SAPI dictation engine is
    // implemented. Keeping unread keys in a config file is a setting that lies
    // about what the application can do.
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
    redactSecrets: true
    // telemetry was removed. LEGION has never sent a usage ping, and leaving a
    // switch for it implied a collection path that does not exist.
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

/**
 * Drop any key that is not in the current defaults.
 *
 * deepMerge copies everything in a saved file over the defaults, so settings
 * that have been removed from the app kept coming back on every launch: a
 * profile written before speakerDeviceId or telemetry were deleted still
 * carried them, and the interface kept reading them as if they were live.
 * Pruning on load means the file can only ever describe what the app supports.
 */
function prune(value, base) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = Array.isArray(base) ? value.slice() : {};
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(base, key)) continue;
    const b = base[key];
    const v = value[key];
    if (b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[key] = prune(v, b);
    } else {
      out[key] = v;
    }
  }
  return out;
}

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
      this.data = prune(deepMerge(clone(DEFAULTS), parsed), DEFAULTS);
      // The pruned result is written back so the retired keys leave the file
      // instead of only being ignored in memory on this run.
      this.saveNow();
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
    this.data = prune(deepMerge(this.data, safe), DEFAULTS);
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

module.exports = { ConfigStore, DEFAULTS, deepMerge, prune, clone };
