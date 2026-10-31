/**
 * LEGION renderer entry point.
 *
 * Owns the boot sequence, the render loop, the state mirror, the panels and
 * every user gesture. The operating system is reached exclusively through the
 * preload bridge — this file never touches Node, never reads a file and never
 * holds a secret.
 */

import { LogoStage, QUALITY_TIERS } from '../visuals/stage.js';
import { LogoLoader } from '../visuals/logo-loader.js';
import { AudioEngine } from './audio.js';
import { StateStore } from './state.js';
import { Waveform } from './waveform.js';
import { Shortcuts } from './shortcuts.js';
import { FirstRun } from './firstrun.js';
import { conversationPanel, toolsPanel, memoryPanel, settingsPanel } from './panels.js';
import { fmtBytes, fmtPct, fmtDuration, fmtClock, parseRgb } from './format.js';

const api = window.legion;

/* Cloud size generated once; lower tiers draw a prefix of it. */
const CLOUD_TARGET = 14000;
const WAKE_GREETING_NAME = 'Allen';

const TOOL_CATEGORY_KEY = {
  system: 'allowSystem', apps: 'allowApps', files: 'allowFiles',
  web: 'allowWeb', dev: 'allowDev', productivity: 'allowProductivity'
};

const PANELS = ['conversation', 'tools', 'memory', 'settings'];

/**
 * One source of truth for the accent each theme publishes. The shell, the
 * waveform and the island's particle stage all read from here, so a theme can
 * never drift between surfaces.
 */
const THEME_VISUALS = {
  'legion-dark': { accent: '#35c8ff', glow: 1.0, scan: .5 },
  abyss:         { accent: '#35c8ff', glow: 1.0, scan: .5 },
  ember:         { accent: '#ff7a45', glow: 1.1, scan: .42 },
  mint:          { accent: '#3ee2a4', glow: 0.95, scan: .4 },
  mono:          { accent: '#c8d2e0', glow: 0.8, scan: .3 }
};

// Synthesis crosses the process boundary. A provider that hangs must not leave
// the UI in PROCESSING or hold the microphone suspended forever, so every call
// is bounded independently of the playback watchdog inside AudioEngine.
const TTS_TIMEOUT_MS = 60000;

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

function wakePeriod(hour = new Date().getHours()) {
  return hour < 5 || hour >= 21 ? 'night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
}

function wakeGreeting(hour = new Date().getHours(), name = WAKE_GREETING_NAME) {
  return `Hey ${name}, good ${wakePeriod(hour)}`;
}

class Legion {
  constructor() {
    this.store = new StateStore();
    this.audio = new AudioEngine();
    this.wave = new Waveform(document.getElementById('waveform'), this.audio);
    this.mark = new LogoLoader();

    this.info = null;
    this.config = null;
    this.secrets = {};
    this.tools = [];
    this.toolLog = [];
    this.memory = { session: [], longTerm: [] };
    this.metrics = { cpu: 0, mem: 0, memUsed: 0, memTotal: 0, network: { online: null } };

    this.stage = null;
    this.cloud = null;
    this.pttActive = false;
    this.micDeviceId = 'default';
    this.pttPromise = null;
    this._captureGen = 0;
    this._openCaptureId = null;
    this._pttOwnsMic = false;
    // The voice surface is held on the instance so a check can substitute it.
    // contextBridge freezes the object on window, so it cannot be patched there.
    this.apiVoice = api.voice;
    this.apiEvents = api.on;
    this.currentPanel = null;
    this.panelApi = null;
    this.theme = 'legion-dark';
    this.busy = false;
    this._runtimeProvider = null;
    this._last = performance.now();
    this._events = new Map();
    this._confirmResolve = null;
    this._panelButtons = [...document.querySelectorAll('.rail-btn')];
    this._confirmEl = document.getElementById('confirm');
    this._toastHost = document.getElementById('toasts');
    this._firstRun = null;
    this._responseSpeech = null;
    this._activeTurn = null;
    this._turnSeq = 0;
    this._speechGen = 0;
    this._lastWakeGreetingPeriod = null;
    this._raf = 0;
    this._statusTimer = null;
    this._metricsTimer = null;
    this._dispose = this.dispose.bind(this);
  }

  /* ── tiny event bus for panels ───────────────────────────── */

  on(name, fn) {
    if (!this._events.has(name)) this._events.set(name, new Set());
    this._events.get(name).add(fn);
    return () => this._events.get(name).delete(fn);
  }
  emit(name, detail) {
    const set = this._events.get(name);
    if (!set) return;
    for (const fn of set) { try { fn(detail); } catch (err) { console.error(err); } }
  }

  /* ══════════════════════════════════════════════════════════
     BOOT
     ══════════════════════════════════════════════════════════ */

  log(text, cls) {
    const el = document.getElementById('boot-log');
    if (!el) return;
    const line = document.createElement('span');
    if (cls) line.className = cls;
    line.textContent = text + '\n';
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  bootProgress(p) {
    const bar = document.getElementById('boot-bar-fill');
    if (bar) bar.style.width = `${Math.round(p * 100)}%`;
  }

  async boot() {
    this.#wireEvents();
    this.#wireChrome();

    try {
      this.log('LEGION personal AI command system', 'b');
      this.log('initialising runtime', 'dim');
      this.info = await api.app.info();
      this.log(`electron ${this.info.electron} · chromium ${this.info.chrome} · node ${this.info.node}`, 'dim');
      this.bootProgress(0.08);

      this.log('loading configuration', 'dim');
      const cfgRes = await api.config.get();
      this.config = cfgRes.settings;
      this.secrets = cfgRes.secret || {};
      this.micDeviceId = this.config.voice?.micDeviceId || 'default';
    // Continuous mode is mutually exclusive with push to talk; the settings UI
    // always writes the pair together, so trust pushToTalk when it disagrees.
    this.continuous = this.config.voice?.continuous === true && this.config.voice?.pushToTalk === false;
      this.audio.setSpeakingGain(this.config.voice?.volume ?? 100);
      this.theme = this.config.ui?.theme || 'legion-dark';
      this.applyTheme(this.theme, true);
      document.body.classList.toggle('reduced-motion', !!this.config.visual?.reducedMotion);
      this.bootProgress(0.16);

      this.log('starting render surface', 'dim');
      this.stage = new LogoStage(document.getElementById('stage'), {
        quality: this.config.visual?.quality || 'high',
        particleScale: this.config.visual?.particleScale ?? 1,
        themeIntensity: this.config.visual?.themeIntensity ?? 1,
        reducedMotion: !!this.config.visual?.reducedMotion,
        bloom: this.config.visual?.bloom !== false,
        adaptive: this.config.visual?.adaptiveQuality !== false,
        scanlines: this.config.visual?.showScanlines !== false
      });
      // The theme was applied above while this.stage was still undefined, so
      // the mark needs the accent, glow and scanline strength handed to it
      // again now that it exists. Without this the saved theme only took effect
      // after the user changed it in Settings.
      this.applyTheme(this.theme, true);
      this.bootProgress(0.24);

      this.log('reading audio devices', 'dim');
      const voices = await api.voice.voices();
      this.log(voices.ttsAvailable
        ? `speech engine ready · ${voices.voices.length} voice(s) installed`
        : `speech output unavailable · ${voices.reason || 'no voices'}`, voices.ttsAvailable ? 'ok' : 'err');
      const caps = await api.voice.capabilities();
      this.log(caps.sapi ? 'local dictation engine available' : `dictation unavailable · ${caps.note}`, caps.sapi ? 'ok' : 'err');
      this.bootProgress(0.34);

      this.log('compiling procedural mark', 'dim');
      const cloud = await this.mark.generate(CLOUD_TARGET, (p) => this.bootProgress(0.34 + p * 0.5));
      this.cloud = cloud;
      this.stage.setCloud(cloud);
      this.log(`mark compiled · ${cloud.count.toLocaleString()} data elements`, 'ok');
      this.bootProgress(0.9);

      // The returning-user boot branch never re-applied the visual policy, so
      // a persisted scanline or adaptive-quality choice was lost on every
      // restart. Now that the cloud exists, the instance count clamps against a
      // real total instead of the constructor's pre-cloud guess.
      this.#applyConfigSideEffects();

      this.log('registering tools', 'dim');
      const toolsRes = await api.tools.list();
      this.tools = toolsRes.tools || [];
      const onCount = this.tools.filter((t) => t.enabled).length;
      this.log(`${onCount} of ${this.tools.length} tools enabled`, 'dim');
      this.bootProgress(0.95);

      await this.refreshMemory();

      this.log('ready', 'ok');
      this.bootProgress(1);

      const onboarded = !!this.config.onboarded;
      if (!onboarded) {
        document.getElementById('boot').classList.add('is-gone');
        document.body.classList.add('is-ready');
        this.#openFirstRun();
      } else if (this.config.app?.playBootAnimation) {
        this.store.setState('BOOTING');
        this.stage.runBootSequence();
        this.store.setState('IDLE');
        await sleep(260);
        this.#hideBoot();
        this.#idleHint();
      } else {
        this.store.setState('IDLE');
        this.#hideBoot();
        this.#idleHint();
      }

      // Main broadcasts state and is the authority the island mirrors. Its
      // boot path only knows it entered BOOTING, so the renderer reports when
      // the shell actually settles instead of leaving main stuck on BOOTING.
      if (this.store.state === 'IDLE') api.app.setState('IDLE').catch(() => {});

      this.shortcuts = new Shortcuts(this);
      this.#loop();
    } catch (err) {
      console.error(err);
      this.log('startup failed: ' + err.message, 'err');
      this.store.setState('ERROR', err.message);
      document.getElementById('boot').classList.add('is-gone');
      document.body.classList.add('is-ready');
      this.toast('error', 'LEGION could not start', err.message);
    }
  }

  #hideBoot() {
    const b = document.getElementById('boot');
    b.classList.add('is-gone');
    document.body.classList.add('is-ready');
  }

  #openFirstRun() {
    this._firstRun = new FirstRun(this);
    document.getElementById('firstrun').hidden = false;
    this.store.setState('BOOTING', 'First-time setup');
  }

  /**
   * Publish the idle hint into the caption region.
   *
   * The caption surface is the one place that survives every panel, so it is
   * where a returning user is told how to start talking. Previously this only
   * ran on the first-run path, which left the region blank on every later
   * launch. Any interaction clears the caption as before.
   */
  #idleHint() {
    this.store.setCaption('Hold Space to talk. Press ? for shortcuts.', false);
  }

  /**
   * Hand over from the first-run wizard to the main shell.
   *
   * The settings saved in step 5 are applied to the live stage before the boot
   * animation starts, so the mark appears at the quality that was chosen
   * rather than the tier the stage was constructed with. The cloud is already
   * sampled at full size, so changing the tier is a single instanceCount write.
   *
   * Sequencing matches the post-onboarding path in start(): runBootSequence()
   * only records the timing window, the loop animates it, so this must not
   * block waiting on it.
   */
  async onboardingDone(info) {
    const { provider, skippedProbe } = info || {};
    const visual = this.config?.visual || {};

    // Commit the onboarded flag only now that setup actually completed, so an
    // interrupted or abandoned wizard never leaves a profile marked onboarded
    // while still unconfigured. A skipped provider check still completes setup:
    // the user asked to continue and can correct the key in Settings.
    const done = await this.setConfig({ onboarded: true });
    if (!done.ok) {
      this.toast('error', 'Setup not finished', done.error);
      this.store.setState('ERROR', done.error);
      return;
    }

    // The settings saved in step 5 are applied to the live stage before the
    // boot animation starts, so the mark appears at the quality that was
    // chosen rather than the tier the stage was constructed with. The cloud is
    // already sampled at full size, so a new tier is one instanceCount write.
    const v = this.config?.visual || visual;
    this.stage?.setQuality(v.quality || 'high');
    this.stage?.setAdaptive(v.adaptiveQuality !== false);
    this.stage?.setReducedMotion(!!v.reducedMotion);
    this.stage?.setScanlines(v.showScanlines !== false);
    this.wave.setVisible(v.showWaveform !== false);
    document.body.classList.toggle('reduced-motion', !!v.reducedMotion);

    document.getElementById('firstrun').hidden = true;
    this.#hideBoot();

    this.store.setState('BOOTING', 'Bringing the mark online');
    this.stage?.runBootSequence();
    this.store.setState('IDLE');
    api.app.setState('IDLE').catch(() => {});

    // Tell the main process the wizard closed, so its onboarded flag, tray menu
    // and window state agree with the renderer.
    try {
      await api.app.markOnboarded();
    } catch (err) {
      console.warn('[legion] main process did not acknowledge onboarding:', err.message);
    }

    await sleep(260);

    const detail = provider === 'none'
      ? 'No AI provider set. Add one in Settings when you want answers.'
      : (skippedProbe
        ? `Provider "${provider}" was not reachable during setup. Check the key in Settings.`
        : `Talking to ${provider}. Hold Space to talk.`);
    this.#idleHint();
    this.toast('ok', 'Setup complete', detail);
  }

  /* ══════════════════════════════════════════════════════════
     RENDER LOOP
     ══════════════════════════════════════════════════════════ */

  #loop() {
    const tick = () => {
      if (this._disposed) return;
      this._raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min(0.05, (now - this._last) / 1000);
      this._last = now;

      if (this.stage) {
        const levels = this.audio.sample();
        const listening = this.store.state === 'LISTENING' || this.pttActive;
        const talking = this.store.state === 'SPEAKING' || this.audio.ttsPlaying;
        const audioMode = talking ? 'speaking' : listening ? 'listening' : 'idle';
        const audioLevels = talking ? levels.tts : levels.mic;
        this.stage.setAudio(audioLevels, audioMode);
        this.#relayAudio(audioLevels, audioMode);
        // setState reseeds per-state animation timers, so it belongs on a real
        // transition. Calling it every frame restarts the boot sequence and
        // pins every easing target to the current instant.
        if (this._lastStageState !== this.store.state) {
          this._lastStageState = this.store.state;
          this.stage.setState(this.store.state);
        }
        this.stage.frame(dt);
        this.#updateRenderChip(this.stage.fps);
      }
      this.wave.draw(this.store.state, dt);
    };
    this._raf = requestAnimationFrame(tick);
  }

  #updateRenderChip(fps) {
    if (this._lastFps === fps) return;
    this._lastFps = fps;
    const el = document.getElementById('m-fps');
    if (!el) return;
    el.textContent = `${Math.round(fps)} fps`;
    const chip = document.getElementById('chip-fps');
    if (chip) chip.classList.toggle('crit', fps < 24);
  }

  /* ══════════════════════════════════════════════════════════
     CHROME
     ══════════════════════════════════════════════════════════ */

  #wireChrome() {
    document.getElementById('win-min').addEventListener('click', () => api.window.action('minimize'));
    document.getElementById('win-max').addEventListener('click', () => api.window.action('maximize'));
    document.getElementById('win-close').addEventListener('click', () => api.window.action('close'));
    document.getElementById('btn-rail').addEventListener('click', () => this.togglePanel('tools'));
    document.getElementById('panel-close').addEventListener('click', () => this.togglePanel(null));

    for (const b of this._panelButtons) {
      b.addEventListener('click', () => this.togglePanel(b.dataset.panel));
    }
    for (const c of document.querySelectorAll('.status-chip[data-panel]')) {
      c.addEventListener('click', () => this.togglePanel(c.dataset.panel));
    }

    document.getElementById('confirm-no').addEventListener('click', () => this.#settleConfirm(false));
    document.getElementById('confirm-yes').addEventListener('click', () => this.#settleConfirm(true));
    this._confirmEl.addEventListener('click', (e) => { if (e.target === this._confirmEl) this.#settleConfirm(false); });

    document.getElementById('shortcuts-close').addEventListener('click', () => this.toggleShortcuts(false));

    this.store.addEventListener('state', (e) => this.#onState(e.detail));
    this.store.addEventListener('caption', () => this.#paintCaption());
  }

  #onState({ prev, next, note }) {
    document.body.dataset.state = next;
    document.getElementById('tb-state').textContent = next;
    const label = document.getElementById('state-label');
    const detail = document.getElementById('state-detail');
    label.textContent = next;
    detail.classList.toggle('err', next === 'ERROR');
    detail.textContent = note || '';

    const labelFor = {
      BOOTING: 'Initialising', IDLE: 'Hold Space to talk', LISTENING: 'Listening',
      PROCESSING: 'Thinking', SPEAKING: 'Speaking', ALERT: 'Attention', ERROR: 'Error', OFFLINE: 'Offline'
    };
    if (next === 'IDLE' && !note) detail.textContent = labelFor.IDLE;
    else if (next === 'LISTENING' && !note) detail.textContent = 'Speak now';
    else if (next === 'PROCESSING' && !note) detail.textContent = labelFor.PROCESSING;

    if (next === 'IDLE' || next === 'OFFLINE') this.store.clearError();

    // When the main process reports the turn is over, the mark relaxes.
    if (next === 'IDLE' && (prev === 'PROCESSING' || prev === 'SPEAKING')) {
      this.store.setCaption('', false);
      this.store.setStreaming('');
    }
    this.emit('state', { prev, next, note });
    this.#relay({ kind: 'state', state: next, detail: note || '' });
  }

  /**
   * Push the live turn to the Dynamic Island.
   *
   * The shell owns the conversation, so the island must never run its own AI
   * turn just to show one. This is a one-way, fire-and-forget mirror: caption
   * changes, streamed text, the current state, and the user's message. Main
   * forwards it only to the island window, so the shell never receives its own
   * relay back.
   */
  #relay(payload) {
    try {
      if (api.island && typeof api.island.relay === 'function') api.island.relay(payload);
    } catch (_) { /* the island is optional */ }
  }

  /**
   * Mirror the visual policy (theme accent, glow, reduced motion, bloom) so the
   * island's stage matches the shell without copying config logic. This is sent
   * on boot and whenever Settings writes a change.
   */
  #relayVisual() {
    const t = THEME_VISUALS[this.theme] || THEME_VISUALS['legion-dark'];
    const v = this.config?.visual || {};
    this.#relay({
      kind: 'visual',
      accent: t.accent,
      glow: t.glow,
      scan: t.scan,
      themeIntensity: v.themeIntensity ?? 1,
      reducedMotion: !!v.reducedMotion,
      bloom: v.bloom !== false
    });
  }

  /**
   * Forward measured microphone or playback levels to the island.
   *
   * Sampled at ~11 Hz: the mark eases toward each value, so a higher rate would
   * only add IPC traffic. Nothing is sent while nothing is being captured or
   * played, and one explicit zero frame follows the end of a turn so the mark
   * relaxes instead of freezing on its last level.
   */
  #relayAudio(levels, mode) {
    const active = mode !== 'idle';
    const now = performance.now();
    if (active) {
      if (now - (this._audioRelayAt || 0) < 90) return;
      this._audioRelayAt = now;
    } else if (!this._audioRelayActive) {
      return;
    }
    this._audioRelayActive = active;
    const src = active && levels ? levels : {};
    const n = (x) => Math.round(Math.max(0, Math.min(1, Number(x) || 0)) * 1000) / 1000;
    this.#relay({
      kind: 'audio',
      mode,
      low: n(src.low), mid: n(src.mid), high: n(src.high), energy: n(src.energy)
    });
  }

  #paintCaption() {
    const el = document.getElementById('live-caption');
    const { caption, captionInterim, streaming } = this.store;
    this.#relay({ kind: 'caption', caption, interim: captionInterim, streaming });
    if (streaming) { el.textContent = streaming; el.className = 'live-caption'; return; }
    el.textContent = caption || '';
    el.className = captionInterim ? 'live-caption interim' : 'live-caption';
  }

  /* ══════════════════════════════════════════════════════════
     EVENTS FROM MAIN
     ══════════════════════════════════════════════════════════ */

  #wireEvents() {
    api.on('state', (p) => {
      if (!p || !p.state) return;
      const note = p.detail && typeof p.detail === 'object' ? p.detail.message : p.detail;
      this.store.setState(p.state, note);
    });

    api.on('metrics', (m) => {
      this.metrics = { ...this.metrics, ...m };
      this.#paintMetrics();
      this.emit('metrics', this.metrics);
    });

    api.on('ai:event', (ev) => this.#onAiEvent(ev));

    api.on('tool:confirmation', (req) => this.#onToolConfirmation(req));

    api.on('app:ready', (p) => { this.launchPayload = p; });

    api.on('ui:open-panel', (name) => this.togglePanel(name));

    api.on('shortcut:activate', () => { this.pushToTalkStart(); });

    api.on('timer:fired', (t) => this.#onTimer(t));

    api.on('voice:wake', (p) => this.#onWake(p));

    api.on('island:action', (p) => {
      const action = p && p.action;
      if (action === 'listen') this.pushToTalkStart();
      else if (action === 'stop') { this.pushToTalkEnd(); this.#releaseMic(); }
      else if (action === 'chat') this.sendText(p.text);
      else if (action === 'cancel') this.closeTopmost();
      else if (action === 'resync') {
        // A newly created island window may have missed broadcasts that fired
        // while it was loading. Replay the renderer-owned state and caption
        // instead of giving the island a second copy of the turn logic.
        this.#relay({ kind: 'state', state: this.store.state, detail: this.store.detail || '' });
        this.#paintCaption();
      }
    });

    this._statusTimer = setInterval(() => this.#paintStatus(), 3000);
    // Main already broadcasts CPU/RAM/network every 1.4s. This slower poll only
    // refreshes the static snapshot and disk totals, which do not change every
    // few seconds, so it runs once on boot and then every minute instead of
    // asking the system layer for the same full snapshot every 12s.
    this._metricsTimer = setInterval(() => this.#pollFullMetrics(), 60000);
    this.#pollFullMetrics();
    window.addEventListener('beforeunload', this._dispose, { once: true });
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._statusTimer) clearInterval(this._statusTimer);
    if (this._metricsTimer) clearInterval(this._metricsTimer);
    clearTimeout(this._continuousTimer);
    this.audio.stopSpeaking();
    this.audio.stopMic();
    this.wave.dispose();
    this.stage?.dispose();
  }

  /**
   * The wake recogniser heard the phrase. Whatever followed it in the same
   * utterance is the command, so no second capture is needed; an empty
   * remainder means the user only said the wake phrase and is now expected to
   * continue, which is the behaviour the spec describes.
   */
  #onWake(p) {
    if (!p) return;
    if (p.error) {
      this.toast('error', 'Wake word unavailable', p.error.message);
      return;
    }
    const command = String(p.command || '').trim();
    this.store.setCaption(command ? command : 'Listening…', true);
    this.#setChipMic(true);
    if (command) {
      this.store.setCaption(command, false);
      this.sendText(command);
    } else {
      if (this._wakeGreetingActive) return;
      const period = wakePeriod();
      if (this._lastWakeGreetingPeriod === period) {
        this.#listenOnce({ wakeTurn: true });
        return;
      }
      this._wakeGreetingActive = true;
      this._lastWakeGreetingPeriod = period;
      const greeting = wakeGreeting();
      this.store.setCaption(greeting, false);
      this.store.setState('SPEAKING', greeting);
      this.#setChipMic(false);
      this.speak(greeting).then((r) => {
        this._wakeGreetingActive = false;
        if (r?.cancelled) return;
        if (r && !r.ok) this.toast('warn', 'Greeting audio unavailable', r.error || 'Could not play the wake greeting.');
        this.#listenOnce({ wakeTurn: true });
      }).catch((err) => {
        this._wakeGreetingActive = false;
        this.toast('warn', 'Greeting audio unavailable', err.message || 'Could not play the wake greeting.');
        this.#listenOnce({ wakeTurn: true });
      });
    }
  }

  async #pollFullMetrics() {
    try {
      const full = await api.system.full();
      const s = full.static || {};
      const l = full.load || {};
      this.metrics = {
        ...this.metrics,
        ...l,
        static: s,
        disk: full.disk,
        network: { ...(full.network || {}), ...(this.metrics.network || {}) },
        gpuModel: s.gpuModel,
        gpuTemp: l.gpuTemp,
        osName: s.osName,
        uptime: s.uptime,
        cpuCores: s.cpuCores,
        cpuLoad1: s.cpuLoad1
      };
      this.emit('metrics', this.metrics);
    } catch (_) { /* best effort */ }
  }

  #onAiEvent(ev) {
    if (!ev || !ev.type) return;
    const p = ev.payload || {};
    if (ev.type === 'provider') {
      this._runtimeProvider = p.provider || null;
      this.#paintStatus();
      return;
    }
    const turnEvent = ['delta', 'text-delta', 'text', 'response-chunk', 'tool', 'error'].includes(ev.type);
    if (turnEvent && !this._activeTurn) return;
    if (ev.type === 'delta' || ev.type === 'text-delta' || ev.type === 'text') {
      this.store.setStreaming(this.store.streaming + (p.text || p.delta || ''));
      this.#paintCaption();
    } else if (ev.type === 'response-chunk') {
      this.#queueResponseSpeech(p.text);
    } else if (ev.type === 'tool') {
      if (p.phase === 'start') {
        this.toolLog.unshift({ name: p.name, ok: true, summary: 'running…', at: new Date().toISOString(), ms: 0, risk: p.risk });
        this.emit('toollog');
      } else if (p.phase === 'end') {
        const e = this.toolLog.find((x) => x.name === p.name && x.summary === 'running…');
        if (e) { e.ok = p.ok !== false; e.summary = p.summary || (p.ok === false ? p.error : 'done'); e.ms = p.ms || 0; }
        this.emit('toollog');
      }
    } else if (ev.type === 'error') {
      this.toast('error', 'AI error', p.message || String(p));
    }
  }

  #onToolConfirmation(req) {
    if (!req || !req.token) return;
    document.getElementById('confirm-tool').textContent = req.tool || '—';
    document.getElementById('confirm-impact').textContent = req.impact || '—';
    document.getElementById('confirm-message').textContent = req.message || 'This action needs your approval.';
    this._confirmEl.hidden = false;
    this._confirmResolve = (ok) => {
      api.tools.confirm(req.token, ok);
    };
  }

  /**
   * Dismiss the confirmation gate.
   *
   * Hiding lives here rather than in each caller's resolver: the renderer-side
   * confirm() helper resolves a promise without touching the element, so
   * without this the modal stayed on screen and Escape appeared to do nothing.
   */
  #settleConfirm(ok) {
    const fn = this._confirmResolve;
    this._confirmResolve = null;
    this._confirmEl.hidden = true;
    if (fn) fn(ok);
  }

  #onTimer(t) {
    this.store.setState('ALERT', t.label);
    this.speak(t.label)
      .then((r) => { if (r && !r.ok && !r.cancelled) this.toast('warn', 'Reminder audio unavailable', r.error || 'Could not play the reminder.'); })
      .catch(() => {})
      .finally(() => {
        if (this.store.state === 'ALERT') this.store.setState('IDLE');
        this.#rearmContinuous();
      });
    this.toast('info', 'Reminder', t.label);
  }

  /* ══════════════════════════════════════════════════════════
     STATUS PAINTING
     ══════════════════════════════════════════════════════════ */

  #paintMetrics() {
    const m = this.metrics;
    setBar('m-cpu', 'm-cpu-bar', m.cpu, (v) => fmtPct(v));
    setBar('m-mem', 'm-mem-bar', m.mem, (v) => fmtPct(v));
    const gpu = document.getElementById('m-gpu');
    if (gpu) gpu.textContent = (m.static?.gpuModel || m.gpuModel || '—').replace(/\s*\(.*?\)\s*/g, '').slice(0, 16) || '—';
    this.#paintStatus();
  }

  #paintStatus() {
    const m = this.metrics;
    const bat = document.getElementById('m-bat');
    if (bat) {
      if (m.battery === null || m.battery === undefined) { bat.textContent = 'AC'; bat.className = 'v'; }
      else { bat.textContent = `${Math.round(m.battery)}%${m.charging ? '⚡' : ''}`; bat.className = m.battery <= 20 && !m.charging ? 'v bad' : 'v'; }
    }
    const net = document.getElementById('m-net');
    if (net) {
      if (m.network?.online === false) { net.textContent = 'OFF'; net.className = 'v bad'; }
      else if (m.network?.online === true) { net.textContent = m.network.latencyMs ? `${m.network.latencyMs}ms` : 'ON'; net.className = 'v ok'; }
      else { net.textContent = '—'; net.className = 'v'; }
    }
    const ai = document.getElementById('m-ai');
    if (ai) {
      const p = this.config?.ai?.provider || 'none';
      const runtime = this._runtimeProvider || p;
      ai.textContent = runtime === 'none' ? 'NONE' : runtime.toUpperCase();
      ai.className = runtime === 'none' ? 'v off' : 'v on';
    }
  }

  /* ══════════════════════════════════════════════════════════
     TALK + SEND
     ══════════════════════════════════════════════════════════ */

  pushToTalkStart() {
    if (this.pttActive || this.busy) return;
    // In continuous mode the mic is already open and a turn is already
    // scheduled, so holding the key has nothing to add.
    if (this.continuous) return;
    this.#listenOnce({ continuous: false });
  }

  pushToTalkEnd() {
    if (!this.pttActive) return;
    // A continuous turn is self-terminating; releasing the key must not abort
    // the next listen, or the mode would stall whenever the user touched Space.
    if (this.continuous && !this._pushingToTalk) return;
    // The tap is torn down here as well as in main: leaving it attached would
    // keep shipping frames for a session that no longer exists, and main drops
    // those silently, so the symptom would be a mute microphone with no error.
    this.#closeCapture();
  }

  #releaseMic() {
    const closeMic = this._pttOwnsMic;
    this._pttOwnsMic = false;
    this.pttActive = false;
    this._pushingToTalk = false;
    this.#setChipMic(false);
    if (closeMic && !this.continuous) this.audio.stopMic();
  }

  #setChipMic(on) {
    const chip = document.getElementById('chip-mic');
    const v = document.getElementById('m-mic');
    if (v) v.textContent = on ? 'LIVE' : 'OFF';
    if (chip) chip.classList.toggle('is-hot', on);
    document.body.classList.toggle('mic-live', on);
  }

  toggleMic() {
    if (this.pttActive) { this.pushToTalkEnd(); this.#releaseMic(); return; }
    if (this.audio.micActive) { this.audio.stopMic(); this.#setChipMic(false); this.toast('info', 'Microphone closed', null); return; }
    this.audio.startMic(this.micDeviceId)
      .then(() => { this.#setChipMic(true); this.toast('ok', 'Microphone open', 'Hold Space to talk.'); })
      .catch((err) => this.toast('error', 'Microphone unavailable', err.message));
  }

  async simulateVoice(text = 'Hello LEGION', { delayMs = 450 } = {}) {
    if (this.info?.isDev !== true) {
      return { ok: false, error: { code: 'E_DEV_ONLY', message: 'Simulated voice is available in development builds only.' } };
    }
    const transcript = String(text || '').trim();
    if (!transcript) {
      return { ok: false, error: { code: 'E_EMPTY', message: 'A transcript is required.' } };
    }
    if (this.busy || this.pttActive || this.continuous) {
      return { ok: false, error: { code: 'E_BUSY', message: 'Finish the current turn before simulating voice.' } };
    }

    const micWasActive = this.audio.micActive;
    this.pttActive = true;
    this._pushingToTalk = false;
    this.#setChipMic(true);
    this.store.setCaption('Listening...', true);
    this.store.setState('LISTENING');

    try {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(delayMs) || 0)));
      this.store.setCaption(transcript, false);
      const started = this.sendText(transcript);
      if (!started) {
        return { ok: false, error: { code: 'E_BUSY', message: 'A turn is already running.' } };
      }
      return { ok: true, transcript, simulated: true };
    } finally {
      this.pttActive = false;
      this._pushingToTalk = false;
      this.#setChipMic(micWasActive);
    }
  }

  sendText(text) {
    const clean = String(text || '').trim();
    if (!clean || this.busy) return false;
    const turn = ++this._turnSeq;
    this._activeTurn = turn;
    this.busy = true;
    this.emit('busy', true);
    this._responseSpeech = { chain: Promise.resolve(), count: 0, speechError: null };
    this.store.setStreaming('');
    this.store.setState('PROCESSING');
    this.#relay({ kind: 'user', text: clean });
    this.#runTextTurn(clean, turn);
    return true;
  }

  #isCurrentTurn(turn) {
    return this._activeTurn === turn;
  }

  async #runTextTurn(clean, turn) {
    let failed = false;
    const speech = this._responseSpeech;
    const push = (m) => { this.memory.session.push(m); this.emit('memory:session'); };
    push({ role: 'user', text: clean, at: new Date().toISOString() });

    try {
      const res = await api.ai.chat(clean);
      if (!this.#isCurrentTurn(turn)) return;
      if (!res || !res.ok) {
        if (res?.error?.code === 'E_ABORTED') {
          failed = true;
          this.store.setStreaming('');
          return;
        }
        const msg = res?.error?.message || 'The AI provider did not respond.';
        failed = true;
        push({ role: 'error', text: msg, at: new Date().toISOString() });
        this.store.setStreaming('');
        this.store.setCaption(msg, false);
        this.store.setState('ERROR', msg);
        this.toast('error', 'No answer', msg);
        if (['E_NO_PROVIDER', 'E_NO_KEY'].includes(res?.error?.code)) this.togglePanel('settings');
        return;
      }
      const reply = res.text || '';
      push({ role: 'assistant', text: reply, at: new Date().toISOString() });
      this.store.setStreaming('');
      this.store.setCaption(reply, false);
      // The reply is already on screen. Speech is an enhancement from here on,
      // so its failure is reported as a warning and never erases the answer.
      try {
        if (speech?.count) {
          await speech.chain;
        } else if (!speech?.cancelled) {
          const spoken = await this.speak(reply);
          if (speech && !spoken.ok && !spoken.cancelled && !speech.speechError) {
            speech.speechError = spoken.error || 'Speech is unavailable.';
          }
        }
      } catch (err) {
        if (speech && !speech.cancelled && !speech.speechError) {
          speech.speechError = err.message || 'Speech is unavailable.';
        }
      }
      if (speech?.speechError && !speech.cancelled) {
        this.toast('warn', 'Voice unavailable', speech.speechError);
      }
      if (this.store.state === 'ERROR') failed = true;
    } catch (err) {
      if (!this.#isCurrentTurn(turn)) return;
      failed = true;
      this.store.setStreaming('');
      this.store.setState('ERROR', err.message);
      this.toast('error', 'Request failed', err.message);
    } finally {
      if (!this.#isCurrentTurn(turn)) return;
      this.busy = false;
      this._activeTurn = null;
      this._responseSpeech = null;
      this.emit('busy', false);
      this.store.setStreaming('');
      if (!failed) this.#rearmContinuous();
      // speak() owns the SPEAKING -> IDLE edge and only settles when it still
      // owns the latest utterance. A reminder or greeting that started during
      // this turn must not be knocked out of SPEAKING here.
      if (this.store.state === 'PROCESSING') {
        this.store.setState('IDLE');
      }
      this.refreshMemory().catch(() => {});
    }
  }

  /**
   * Continuous conversation: once the reply has finished speaking, wait for the
   * room to go quiet, then listen again. The guard delay exists because a mic
   * left open hears the TTS output as well; without it the assistant would
   * transcribe its own voice. The end-of-speech silence break in the recogniser
   * supplies the pause, and a real user pause is longer than this.
   */
  #rearmContinuous() {
    if (!this.continuous || this.busy || this.pttActive) return;
    if (this.audio.ttsPlaying || this.store.state === 'SPEAKING') return;
    clearTimeout(this._continuousTimer);
    this._continuousTimer = setTimeout(() => {
      if (this.continuous && !this.busy && !this.pttActive) this.#listenOnce({ continuous: true });
    }, 900);
  }

  setContinuousMode(on) {
    this.continuous = !!on;
    if (this.continuous) {
      // Keeping the microphone open is the whole point, and it is only reachable
      // once the user has explicitly chosen this mode.
      this.audio.startMic(this.micDeviceId).catch((err) => {
        this.continuous = false;
        this.store.setState('ERROR', err.message);
        this.toast('error', 'Microphone unavailable', err.message);
      });
      this.#setChipMic(true);
      this.#rearmContinuous();
    } else {
      clearTimeout(this._continuousTimer);
      // A capture may be in flight right now. Stop the recogniser, otherwise
      // the microphone stays open and the state machine stays in LISTENING
      // with nothing left to drive it back to idle.
      if (this.pttActive) {
        this._pushingToTalk = true;
        this.#closeCapture();
        this.#releaseMic();
      }
      this.audio.stopMic();
      this.#setChipMic(false);
      if (this.store.state === 'LISTENING' || this.store.state === 'ERROR') this.store.setState('IDLE');
    }
  }

  /**
   * One capture, resolved when the recogniser has an answer.
   *
   * This replaces the old `voice:listen` call for the microphone path. The
   * reason is that `voice:listen` opened the Windows default input itself, so
   * the device the user picked in Settings, and the echo cancellation and noise
   * suppression asked for alongside it, were both bypassed: the level meter used
   * the good audio and the recogniser heard the raw one. Tapping the graph the
   * browser already opened and shipping the samples to main means the audio that
   * gets transcribed is the audio that was conditioned.
   *
   * Main replies out of band on `voice:captureEnd` rather than returning from
   * this call, because the frame that completes a sentence arrives on a
   * fire-and-forget channel with nobody left holding a promise.
   */
  #openCapture({ maxSeconds = 20, generation = this._captureGen } = {}) {
    return new Promise((resolve) => {
      let session = null;
      let settled = false;
      let watchdog = null;
      const cancelled = () => generation !== this._captureGen;
      const off = this.apiEvents('voice:captureEnd', (payload) => {
        if (!session || !payload || payload.id !== session.id) return;
        finish(payload);
      });
      const finish = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        this.audio.stopTap();
        if (session && this._openCaptureId === session.id) this._openCaptureId = null;
        off();
        resolve(res);
      };
      const fail = (message, code) => finish({ ok: false, error: { message, code: code || 'E_STT' } });
      const abort = (id) => { if (id) this.apiVoice.captureAbort(id).catch(() => {}); };

      (async () => {
        try {
          session = await this.apiVoice.captureStart({ maxSeconds });
        } catch (err) {
          fail(err.message || 'Capture could not start.');
          return;
        }
        if (!session || !session.ok) {
          // Keep whatever main said. Replacing a specific code with a generic
          // one turns a silent room in continuous mode into a red error, which
          // is exactly the case the code exists to handle quietly.
          const e = session && session.error;
          finish({ ok: false, error: { message: (e && e.message) || 'Voice capture could not start.', code: (e && e.code) || 'E_STT' } });
          return;
        }
        this._openCaptureId = session.id;
        if (cancelled() || !this.pttActive) {
          abort(session.id);
          finish({ ok: false, stopped: true, error: { code: 'E_STT_STOPPED', message: 'Capture cancelled.' } });
          return;
        }
        watchdog = setTimeout(() => {
          abort(session.id);
          finish({ ok: false, error: { code: 'E_STT_TIMEOUT', message: 'Voice capture stopped before the recogniser answered.' } });
        }, (maxSeconds + 20) * 1000);
        try {
          if (!this.audio.micActive) await this.audio.startMic(this.micDeviceId);
          if (cancelled() || !this.pttActive) {
            abort(session.id);
            finish({ ok: false, stopped: true, error: { code: 'E_STT_STOPPED', message: 'Capture cancelled.' } });
            return;
          }
          const tap = this.audio.startTap((samples, sampleRate) => {
            this.apiVoice.captureChunk(session.id, samples, sampleRate);
          }, { frameMs: 20 });
          if (!tap.ok) {
            abort(session.id);
            fail('The microphone could not be attached to the recogniser.');
          }
        } catch (err) {
          abort(session.id);
          fail(err.message || 'Voice capture failed.');
        }
      })();
    });
  }

  /** Close an open capture. Safe to call when nothing is running. */
  #closeCapture() {
    this._captureGen++;
    this.audio.stopTap();
    const id = this._openCaptureId;
    this._openCaptureId = null;
    if (id) this.apiVoice.captureStop(id).catch(() => {});
  }

  /** One capture cycle, shared by push to talk, wake, and continuous mode. */
  #listenOnce({ continuous = false, wakeTurn = false } = {}) {
    if (this.pttActive || this.busy) return;
    const generation = ++this._captureGen;
    const ownsMic = !this.audio.micActive;
    const persistent = continuous || wakeTurn;
    this._pttOwnsMic = ownsMic && !continuous;
    this.pttActive = true;
    this.#setChipMic(true);
    this.store.setCaption('Listening…', true);

    // Marks a turn the user is holding the key for, so releasing Space stops
    // the capture. Continuous and wake turns are not key-driven.
    this._pushingToTalk = !persistent;

    const stopAfterSpeech = () => {
      if (continuous) {
        this.pttActive = false;
        this.#setChipMic(true);
      } else {
        this.#releaseMic();
      }
    };

    this.audio.startMic(this.micDeviceId)
      .then(() => {
        if (generation !== this._captureGen || !this.pttActive) {
          if (ownsMic && !continuous) this.audio.stopMic();
          return { ok: false, stopped: true, error: { code: 'E_STT_STOPPED', message: 'Capture cancelled.' } };
        }
        this.store.setState('LISTENING');
        return this.#openCapture({ maxSeconds: continuous ? 12 : 20, generation });
      })
      .then((res) => {
        // Continuous mode may have been switched off while this capture was in
        // flight. The user asked to stop, so discard the result rather than
        // sending a stale transcript to the provider behind their back.
        if (continuous && !this.continuous) { this.store.setCaption('', false); return; }
        stopAfterSpeech();
        if (!res || !res.ok) {
          this.store.setCaption('', false);
          if (res?.stopped) {
            // A released push to talk or wake turn that was stopped. Return
            // quietly unless continuous mode has another turn scheduled.
            if (!continuous) this.store.setState('IDLE');
            this.#rearmContinuous();
            return;
          }
          const code = res?.error?.code;
          // In continuous or wake turns the microphone is open, so most turns
          // are silence. Raising an error for an empty room would be noise.
          if (persistent && code === 'E_STT_EMPTY') {
            if (this.store.state === 'LISTENING') this.store.setState('IDLE');
            this.#rearmContinuous();
            return;
          }
          const msg = res?.error?.message || 'Voice recognition failed.';
          this.store.setState('ERROR', msg);
          this.toast('error', 'Could not hear you', msg);
          return;
        }
        this.store.setCaption(res.transcript, false);
        this.sendText(res.transcript);
      })
      .catch((err) => {
        if (continuous && !this.continuous) { this.store.setCaption('', false); return; }
        stopAfterSpeech();
        this.store.setCaption('', false);
        this.store.setState('ERROR', err.message);
        this.toast('error', 'Voice input failed', err.message);
      });
  }

  /**
   * Synthesise, play, and analyse the real output. The mark keeps reacting
   * because the TTS signal drives the same analyser the microphone uses.
   */
  async speak(text, opts) {
    const cfg = this.config?.voice || {};
    if (cfg.enabled === false) return { ok: false, error: 'Voice output is disabled.' };
    const body = String(text || '').trim();
    if (!body) return { ok: false, error: 'Nothing to say.' };

    const options = opts || {};
    const gen = ++this._speechGen;
    this.audio.stopSpeaking();
    // The previous request may still own main's suspended wake listener. Release
    // it before this one starts; release is generation-guarded so a late return
    // from an older utterance cannot open the microphone during this one.
    this.#releaseSpeechDevice(gen);

    const wantMock = options.mock === true || cfg.mockTts === true;
    const fail = (message, extra = {}) => {
      if (gen !== this._speechGen) return { ok: false, cancelled: true, ...extra };
      if (this.store.state === 'SPEAKING') this.store.setState('IDLE');
      this.#releaseSpeechDevice(gen);
      return { ok: false, error: message, ...extra };
    };

    let res;
    try {
      res = await withTimeout(this.apiVoice.speak(body, {
        voice: options.voice || cfg.voiceName || null,
        rate: options.rate ?? cfg.rate,
        volume: options.volume ?? cfg.volume,
        mock: wantMock
      }), TTS_TIMEOUT_MS, 'Speech synthesis timed out.');
    } catch (err) {
      if (gen === this._speechGen) {
        this.audio.stopSpeaking();
        // Cancel main's in-flight request too. It suspended wake and set
        // SPEAKING before synthesis; dropping only the renderer promise would
        // leave both in that state until it eventually finished.
        try { await this.apiVoice.speechCancel(); } catch (_) { /* already gone */ }
      }
      return fail(err.message || 'Speech synthesis failed.');
    }
    if (gen !== this._speechGen) return { ok: false, cancelled: true };
    if (!res || !res.ok) {
      const msg = res?.error?.message || 'Speech synthesis failed.';
      return fail(msg, {
        cancelled: !!res?.cancelled,
        tier: res?.tier || null,
        source: res?.source || null
      });
    }
    if (!res.mock && !res.audioBase64) {
      // A pack-only miss is normal silence, not a failure. Main released the
      // device at synthesis time; settle the mirror as well.
      if (this.store.state === 'SPEAKING') this.store.setState('IDLE');
      this.#releaseSpeechDevice(gen);
      return { ok: true, silent: true, tier: res.tier || null, source: res.source || null, mode: res.mode || null };
    }

    this.store.setState('SPEAKING');
    let play;
    try {
      play = res.mock ? await this.audio.speakMock(res.durationMs) : await this.audio.speak(res.audioBase64);
    } catch (err) {
      return fail(err.message || 'Could not start speech playback.');
    }
    if (gen !== this._speechGen) {
      try { play?.stop?.(); } catch (_) { /* newer speech owns playback */ }
      return { ok: false, cancelled: true };
    }
    if (!play || !play.ok) {
      return fail('Could not play the generated audio.', { tier: res.tier || null, source: res.source || null });
    }

    this.audio.setMuted(this.config?.voice?.muted === true);
    const done = await play.promise;
    if (gen !== this._speechGen) return { ok: false, cancelled: true };
    if (!done || !done.ok) {
      return fail(
        done?.timedOut ? 'Speech playback timed out.' : 'Speech playback did not finish.',
        { cancelled: !!done?.cancelled, tier: res.tier || null, source: res.source || null }
      );
    }

    this.audio.stopSpeaking();
    if (this.store.state === 'SPEAKING') this.store.setState('IDLE');
    this.#releaseSpeechDevice(gen);
    // source/phrase are carried through so a caller can tell a recorded pack clip
    // from freshly synthesised speech; the settings panel reports which was used.
    return {
      ok: true,
      durationMs: done.durationMs || play.durationMs,
      source: res.source || null,
      tier: res.tier || null,
      mode: res.mode || null,
      mock: !!res.mock,
      pack: res.pack || null,
      phrase: res.phrase || null
    };
  }

  #queueResponseSpeech(text) {
    const chunk = String(text || '').trim();
    const response = this._responseSpeech;
    if (!chunk || !response) return;
    response.count++;
    response.chain = response.chain.then(async () => {
      if (response.cancelled) return { ok: false, cancelled: true };
      try {
        const r = await this.speak(chunk);
        if (!r.ok && !r.cancelled && !response.speechError) response.speechError = r.error || 'Speech is unavailable.';
        return r;
      } catch (err) {
        if (!response.speechError) response.speechError = err.message || 'Speech is unavailable.';
        return { ok: false, error: err.message };
      }
    });
  }

  /**
   * The voice pack description, for the settings panel. Returns null if the
   * bridge is unavailable rather than throwing, since the panel only reports it.
   */
  async voicePack() {
    try { return await api.voice.pack(); } catch (_) { return null; }
  }

  /** Display list for the island position control. */
  async islandDisplays() {
    try { return await api.island.displays(); } catch (_) { return null; }
  }

  /**
   * Main suspends the wake listener for the whole of a synthesis because the
   * recogniser reads the same input device. Playback is renderer-side, so main
   * cannot see it end; this is the signal that hands the device back.
   */
  #releaseSpeechDevice(gen) {
    if (gen !== undefined && gen !== this._speechGen) return;
    Promise.resolve()
      .then(() => this.apiVoice.speechEnd())
      .catch(() => {});
  }

  /* ══════════════════════════════════════════════════════════
     PANELS
     ══════════════════════════════════════════════════════════ */

  togglePanel(name) {
    const target = this.currentPanel === name ? null : name;
    this.#openPanel(target);
  }

  cyclePanel() {
    const i = PANELS.indexOf(this.currentPanel);
    this.#openPanel(i < 0 || i === PANELS.length - 1 ? PANELS[0] : PANELS[i + 1]);
  }

  #openPanel(name) {
    if (!PANELS.includes(name)) name = null;
    const host = document.getElementById('panel-body');
    const el = document.getElementById('panel');

    for (const b of this._panelButtons) b.classList.toggle('is-active', b.dataset.panel === name);

    if (!name) {
      el.hidden = true;
      this.currentPanel = null;
      this.panelApi = null;
      this.store.setPanel(null);
      this.#applyPanelShift();
      return;
    }

    this.currentPanel = name;
    this.store.setPanel(name);
    el.hidden = false;
    document.getElementById('panel-title').textContent = name;
    // The memory panel is the one surface that reads disk totals; refresh them
    // when it opens instead of running a global timer for a rarely opened view.
    if (name === 'memory') this.#pollFullMetrics();

    try {
      if (name === 'conversation') this.panelApi = conversationPanel(host, this);
      else if (name === 'tools') this.panelApi = toolsPanel(host, this);
      else if (name === 'memory') this.panelApi = memoryPanel(host, this);
      else this.panelApi = settingsPanel(host, this);
    } catch (err) {
      host.innerHTML = `<div class="empty"><strong>Panel failed to open</strong>${escapeHtml(err.message)}</div>`;
      console.error(err);
    }

    this.#applyPanelShift();
  }

  /**
   * Slide the mark out from under an open panel.
   *
   * The panel is docked to one edge and sits above the stage in z, so the
   * camera is panned by half the panel width towards the free side. That
   * re-centres the mark in the visible area instead of leaving it half
   * covered, and the stage's own lookTarget term turns the gaze after it.
   */
  #applyPanelShift() {
    if (!this.stage) return;
    const el = document.getElementById('panel');
    if (!el || el.hidden) { this.stage.setPanelShift(0); return; }
    const w = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--panel-w')) || 430;
    const dockedLeft = document.body.classList.contains('panel-left');
    this.stage.setPanelShift((dockedLeft ? -1 : 1) * (w / 2));
  }

  setPanelPosition(pos) {
    document.documentElement.style.setProperty('--panel-w', pos === 'left' ? '430px' : '430px');
    document.body.classList.toggle('panel-left', pos === 'left');
    this.#applyPanelShift();
  }

  closeTopmost() {
    if (this.pttActive) { this.pushToTalkEnd(); this.#releaseMic(); return true; }
    if (this.audio.ttsPlaying || this._responseSpeech) {
      this.#cancelSpeech();
      if (this.busy) api.ai.cancel().catch(() => {});
      this.#cancelActiveTurn();
      this.store.setState('IDLE');
      return true;
    }
    if (this.busy) {
      api.ai.cancel().catch(() => {});
      this.#cancelActiveTurn();
      this.store.setState('IDLE');
      return true;
    }
    if (!this._confirmEl.hidden) { this.#settleConfirm(false); return true; }
    if (!document.getElementById('shortcuts').hidden) { this.toggleShortcuts(false); return true; }
    if (this.currentPanel) { this.#openPanel(null); return true; }
    if (this.store.error) { this.store.clearError(); this.store.setState('IDLE'); return true; }
    return false;
  }

  #cancelSpeech() {
    this._speechGen++;
    if (this._responseSpeech) this._responseSpeech.cancelled = true;
    this._responseSpeech = null;
    this.audio.stopSpeaking();
    this.apiVoice.speechCancel().catch(() => {});
  }

  #cancelActiveTurn() {
    this._turnSeq++;
    this._activeTurn = null;
    this.busy = false;
    this._responseSpeech = null;
    this.store.setStreaming('');
    this.emit('busy', false);
  }

  toggleShortcuts(force) {
    const el = document.getElementById('shortcuts');
    el.hidden = force === undefined ? !el.hidden : !force;
  }

  bringToFront() { api.window.action('minimizeToTray').then(() => api.window.action('maximize')).catch(() => {}); }

  /* ══════════════════════════════════════════════════════════
     DATA ACCESS
     ══════════════════════════════════════════════════════════ */

  async refreshConfig() {
    const res = await api.config.get();
    this.config = res.settings;
    this.secrets = res.secret || {};
    this.emit('config', this.config);
    this.#paintStatus();
    return this.config;
  }

  async setConfig(patch) {
    try {
      const res = await api.config.set(patch);
      this.config = res.settings;
      this.emit('config', this.config);
      this.#applyConfigSideEffects();
      this.#paintStatus();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  #applyConfigSideEffects() {
    const c = this.config;
    document.body.classList.toggle('reduced-motion', !!c?.visual?.reducedMotion);
    if (c?.ui?.theme && c.ui.theme !== this.theme) { this.theme = c.ui.theme; this.applyTheme(this.theme); }
    if (c?.voice?.micDeviceId) this.micDeviceId = c.voice.micDeviceId;
    this.audio.setSpeakingGain(c?.voice?.volume ?? 100);
    this.stage?.setAdaptive(c?.visual?.adaptiveQuality !== false);
    this.stage?.setReducedMotion(!!c?.visual?.reducedMotion);
    this.stage?.setScanlines(c?.visual?.showScanlines !== false);
    this.wave.setVisible(c?.visual?.showWaveform !== false);
    this.audio.setMuted(!!c?.voice?.muted);
    // Settings can change reduced motion, intensity or bloom without touching
    // the theme, so the island needs the policy even when the accent is stable.
    this.#relayVisual();
  }

  async refreshMemory() {
    const [s, l] = await Promise.all([api.memory.session(), api.memory.list()]);
    this.memory.session = s.messages || [];
    this.memory.longTerm = l.memories || [];
    this.emit('memory:session');
    this.emit('memory:longterm');
  }

  async refreshTools() {
    const res = await api.tools.list();
    this.tools = res.tools || [];
    this.emit('tools', this.tools);
    return this.tools;
  }

  async setToolEnabled(name, on) {
    const t = this.tools.find((x) => x.name === name);
    if (!t) return { ok: false, error: 'Unknown tool.' };
    const key = TOOL_CATEGORY_KEY[t.category];
    if (!key) return { ok: false, error: 'That tool group cannot be toggled.' };
    const res = await this.setConfig({ tools: { [key]: on } });
    if (res.ok) await this.refreshTools();
    return res;
  }

  async setKey(provider, value) {
    try {
      if (value) await api.secrets.set(provider, value);
      else await api.secrets.clear(provider);
      const st = await api.secrets.status(provider);
      this.secrets[provider] = st.secret || st;
      this.emit('config', this.config);
      return { ok: true, secret: this.secrets[provider] };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async testProvider() {
    try {
      const r = await api.ai.probe();
      if (r.provider === 'none') return { ok: false, error: 'No provider selected.' };
      if (r.online === false) return { ok: false, error: r.reason || 'Provider is not ready.' };
      if (r.mock) return { ok: true, detail: 'Development mock. No network request.' };
      return { ok: true, detail: r.keyConfigured ? 'Key present. Ready to answer.' : 'Reachable.' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async loadVoices() {
    try {
      const r = await api.voice.voices();
      return r.ttsAvailable ? (r.voices || []) : [];
    } catch (_) { return []; }
  }

  async listMicDevices() { return this.audio.listInputs(); }

  /**
   * The voice bridge, held on the instance so a check can substitute it.
   * contextBridge freezes the object on window, so it cannot be patched there.
   */
  get voice() { return this.apiVoice; }

  /** What the recogniser can actually do, for honest UI copy. */
  async voiceCaps() {
    if (this._voiceCaps) return this._voiceCaps;
    try {
      this._voiceCaps = await api.voice.capabilities();
    } catch (_) {
      this._voiceCaps = null;
    }
    return this._voiceCaps;
  }

  /**
   * Which synthesis tiers are usable right now. Deliberately not cached: Piper
   * can be installed and the online tier can come back, so this is re-read
   * whenever the settings panel opens.
   */
  async voicePipeline() {
    try {
      return await api.voice.pipeline();
    } catch (_) {
      return null;
    }
  }

  async setVoiceConfig(patch) {
    this.config = { ...(this.config || {}), voice: { ...(this.config?.voice || {}), ...patch } };
    await api.config.set({ voice: patch });
  }

  async forget(id) {
    try { await api.memory.forget(id); await this.refreshMemory(); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  }

  async forgetAll() {
    try { await api.memory.clearAll(); await this.refreshMemory(); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  }

  async exportSession() {
    try {
      const r = await api.memory.export();
      if (!r || !r.ok) return { ok: false, error: r?.error || 'Export failed.' };
      this.toast('ok', 'Conversation exported', r.path);
      return { ok: true, path: r.path };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async openDataFolder() {
    const r = await api.system.openPath(this.info.dataDir);
    if (r && r.error) this.toast('error', 'Could not open folder', r.error);
  }

  async resetAll() {
    try {
      await api.memory.clearAll();
      await api.secrets.clear('gemini');
      await api.secrets.clear('anthropic');
      await api.secrets.clear('openai');
      await api.config.reset();
      this.applyTheme('legion-dark');
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  }

  async rebuildMark(quality) {
    if (!QUALITY_TIERS[quality]) return;
    this.toast('info', 'Regenerating mark', quality);
    try {
      const cloud = await this.mark.generate(CLOUD_TARGET);
      this.cloud = cloud;
      this.stage.setQuality(quality);
      this.stage.setCloud(cloud);
      this.toast('ok', 'Mark rebuilt', `${cloud.count.toLocaleString()} elements`);
    } catch (err) {
      this.toast('error', 'Could not rebuild the mark', err.message);
    }
  }

  /* ══════════════════════════════════════════════════════════
     CONFIRM + TOASTS
     ══════════════════════════════════════════════════════════ */

  confirm({ message, tool, impact }) {
    document.getElementById('confirm-tool').textContent = tool || '—';
    document.getElementById('confirm-impact').textContent = impact || '—';
    document.getElementById('confirm-message').textContent = message || 'This action needs your approval.';
    this._confirmEl.hidden = false;
    return new Promise((resolve) => { this._confirmResolve = resolve; });
  }

  toast(kind, title, body) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `<div style="flex:1"><div class="t-title">${escapeHtml(title)}</div>${body ? `<div class="t-body">${escapeHtml(body)}</div>` : ''}</div>`;
    this._toastHost.appendChild(el);
    const kill = () => { el.classList.add('is-going'); setTimeout(() => el.remove(), 300); };
    const timer = setTimeout(kill, kind === 'error' ? 8000 : 4200);
    el.addEventListener('click', () => { clearTimeout(timer); kill(); });
    while (this._toastHost.children.length > 5) this._toastHost.firstChild.remove();
  }

  /* ══════════════════════════════════════════════════════════
     THEME
     ══════════════════════════════════════════════════════════ */

  applyTheme(theme, initial) {
    this.theme = theme || 'legion-dark';
    const t = THEME_VISUALS[this.theme] || THEME_VISUALS['legion-dark'];
    document.documentElement.style.setProperty('--accent', t.accent);
    document.documentElement.style.setProperty('--accent-dim', hexToRgba(t.accent, 0.16));
    this.wave?.setAccent(parseRgb(t.accent));
    this.stage?.setAccent(t.accent, t.glow);
    this.stage?.setScanlineAlpha?.(t.scan);
    // The island runs in its own window, so it cannot observe this DOM. Relay
    // the resolved colours rather than making it duplicate the theme table.
    this.#relayVisual();
    if (!initial) this.emit('config', this.config);
  }
}

/* ── helpers ─────────────────────────────────────────────────── */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function setBar(textId, barId, value, fmt) {
  const t = document.getElementById(textId);
  const bar = document.getElementById(barId);
  if (t) t.textContent = fmt(value);
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`;
  const chip = bar?.closest('.status-chip');
  if (chip) {
    chip.classList.toggle('hot', value > 62 && value <= 85);
    chip.classList.toggle('crit', value > 85);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hexToRgba(hex, a) {
  const h = String(hex).replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const app = new Legion();
window.legionApp = app;
app.boot();
