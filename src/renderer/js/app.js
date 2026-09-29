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

const TOOL_CATEGORY_KEY = {
  system: 'allowSystem', apps: 'allowApps', files: 'allowFiles',
  web: 'allowWeb', dev: 'allowDev', productivity: 'allowProductivity'
};

const PANELS = ['conversation', 'tools', 'memory', 'settings'];

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
    // The voice surface is held on the instance so a check can substitute it.
    // contextBridge freezes the object on window, so it cannot be patched there.
    this.apiVoice = api.voice;
    this.currentPanel = null;
    this.panelApi = null;
    this.theme = 'legion-dark';
    this.busy = false;
    this._last = performance.now();
    this._events = new Map();
    this._confirmResolve = null;
    this._panelButtons = [...document.querySelectorAll('.rail-btn')];
    this._confirmEl = document.getElementById('confirm');
    this._toastHost = document.getElementById('toasts');
    this._firstRun = null;
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
      requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min(0.05, (now - this._last) / 1000);
      this._last = now;

      if (this.stage) {
        const levels = this.audio.sample();
        const listening = this.store.state === 'LISTENING' || this.pttActive;
        const talking = this.store.state === 'SPEAKING' || this.audio.ttsPlaying;
        this.stage.setAudio(talking ? levels.tts : levels.mic, talking ? 'speaking' : listening ? 'listening' : 'idle');
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
    requestAnimationFrame(tick);
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
  }

  #paintCaption() {
    const el = document.getElementById('live-caption');
    const { caption, captionInterim, streaming } = this.store;
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

    setInterval(() => this.#paintStatus(), 1500);
    setInterval(() => this.#pollFullMetrics(), 9000);
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
      this.#listenOnce({ continuous: true });
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
    if (ev.type === 'delta' || ev.type === 'text-delta' || ev.type === 'text') {
      this.store.setStreaming(this.store.streaming + (p.text || p.delta || ''));
      this.#paintCaption();
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
    this.speak(t.label).finally(() => this.store.setState('IDLE'));
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
      ai.textContent = p === 'none' ? 'NONE' : p.toUpperCase();
      ai.className = p === 'none' ? 'v off' : 'v on';
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
    this.apiVoice.listenStop().catch(() => {});
  }

  #releaseMic() {
    this.pttActive = false;
    this._pushingToTalk = false;
    this.#setChipMic(false);
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

  async sendText(text) {
    const clean = String(text || '').trim();
    if (!clean || this.busy) return;
    this.busy = true;
    this.store.setStreaming('');
    this.store.setState('PROCESSING');

    const push = (m) => { this.memory.session.push(m); this.emit('memory:session'); };
    push({ role: 'user', text: clean, at: new Date().toISOString() });

    try {
      const res = await api.ai.chat(clean);
      if (!res || !res.ok) {
        const msg = res?.error?.message || 'The AI provider did not respond.';
        push({ role: 'error', text: msg, at: new Date().toISOString() });
        this.store.setCaption('', false);
        this.store.setState('ERROR', msg);
        this.toast('error', 'No answer', msg);
        if (res?.error?.code === 'E_NO_PROVIDER') this.togglePanel('settings');
        return;
      }
      const reply = res.text || '';
      push({ role: 'assistant', text: reply, at: new Date().toISOString() });
      this.store.setStreaming('');
      this.store.setCaption(reply, false);
      await this.speak(reply);
      this.#rearmContinuous();
    } catch (err) {
      this.store.setStreaming('');
      this.store.setState('ERROR', err.message);
      this.toast('error', 'Request failed', err.message);
    } finally {
      this.busy = false;
      await this.refreshMemory();
      this.#rearmContinuous();
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
        this.apiVoice.listenStop().catch(() => {});
        this.#releaseMic();
      }
      this.audio.stopMic();
      this.#setChipMic(false);
      if (this.store.state === 'LISTENING' || this.store.state === 'ERROR') this.store.setState('IDLE');
    }
  }

  /** One capture cycle, shared by push to talk and continuous mode. */
  #listenOnce({ continuous = false } = {}) {
    if (this.pttActive || this.busy) return;
    this.pttActive = true;
    this.#setChipMic(true);
    this.store.setCaption('Listening…', true);

    // Marks a turn the user is holding the key for, so releasing Space stops
    // the capture. A continuous turn is never key-driven and ends on its own.
    this._pushingToTalk = !continuous;

    const stopAfterSpeech = () => { if (continuous) { this.pttActive = false; this.#setChipMic(true); } else { this.#releaseMic(); } };

    this.audio.startMic(this.micDeviceId)
      .then(() => {
        this.store.setState('LISTENING');
        return this.apiVoice.listen({ maxSeconds: continuous ? 12 : 20 });
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
            // A released push to talk. Return quietly unless we are in
            // continuous mode, where the next turn is already scheduled.
            if (!continuous) this.store.setState('IDLE');
            this.#rearmContinuous();
            return;
          }
          const code = res?.error?.code;
          // In continuous mode the microphone is open, so most turns are
          // silence. Raising an error for an empty room would be noise, and
          // the toast would repeat every cycle.
          if (continuous && code === 'E_STT_EMPTY') {
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

    const res = await api.voice.speak(body, {
      voice: (opts && opts.voice) || cfg.voiceName || null,
      rate: (opts && opts.rate) ?? cfg.rate,
      volume: (opts && opts.volume) ?? cfg.volume
    });
    if (!res || !res.ok) {
      const msg = res?.error?.message || 'Speech synthesis failed.';
      this.store.setState('ERROR', msg);
      this.#releaseSpeechDevice();
      return { ok: false, error: msg };
    }
    if (!res.audioBase64) { this.#releaseSpeechDevice(); return { ok: true, silent: true }; }

    this.store.setState('SPEAKING');
    const play = await this.audio.speak(res.audioBase64);
    if (!play.ok) {
      this.store.setState('IDLE');
      this.#releaseSpeechDevice();
      return { ok: false, error: 'Could not play the generated audio.' };
    }
    this.audio.setMuted(this.config?.voice?.muted === true);
    await play.promise;
    this.audio.stopSpeaking();
    if (this.store.state === 'SPEAKING') this.store.setState('IDLE');
    this.#releaseSpeechDevice();
    // source/phrase are carried through so a caller can tell a recorded pack clip
    // from freshly synthesised speech; the settings panel reports which was used.
    return { ok: true, durationMs: play.durationMs, source: res.source, pack: res.pack, phrase: res.phrase };
  }

  /**
   * The voice pack description, for the settings panel. Returns null if the
   * bridge is unavailable rather than throwing, since the panel only reports it.
   */
  async voicePack() {
    try { return await api.voice.pack(); } catch (_) { return null; }
  }

  /**
   * Main suspends the wake listener for the whole of a synthesis because the
   * recogniser reads the same input device. Playback is renderer-side, so main
   * cannot see it end; this is the signal that hands the device back.
   */
  #releaseSpeechDevice() {
    Promise.resolve()
      .then(() => api.voice.speechEnd())
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
    if (this.audio.ttsPlaying) { this.audio.stopSpeaking(); this.store.setState('IDLE'); return true; }
    if (this.busy) { api.ai.cancel().catch(() => {}); this.busy = false; this.store.setState('IDLE'); return true; }
    if (!this._confirmEl.hidden) { this.#settleConfirm(false); return true; }
    if (!document.getElementById('shortcuts').hidden) { this.toggleShortcuts(false); return true; }
    if (this.currentPanel) { this.#openPanel(null); return true; }
    if (this.store.error) { this.store.clearError(); this.store.setState('IDLE'); return true; }
    return false;
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
      if (r.online === false) return { ok: false, error: r.reason || 'Provider did not answer.' };
      if (r.models) return { ok: true, detail: `Online · ${r.models.length} model(s) available.` };
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
    const T = {
      'legion-dark': { accent: '#35c8ff', glow: 1.0, scan: .5 },
      abyss:        { accent: '#35c8ff', glow: 1.0, scan: .5 },
      ember:        { accent: '#ff7a45', glow: 1.1, scan: .42 },
      mint:         { accent: '#3ee2a4', glow: 0.95, scan: .4 },
      mono:         { accent: '#c8d2e0', glow: 0.8, scan: .3 }
    };
    const t = T[this.theme] || T['legion-dark'];
    document.documentElement.style.setProperty('--accent', t.accent);
    document.documentElement.style.setProperty('--accent-dim', hexToRgba(t.accent, 0.16));
    this.wave?.setAccent(parseRgb(t.accent));
    this.stage?.setAccent(t.accent, t.glow);
    this.stage?.setScanlineAlpha?.(t.scan);
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
