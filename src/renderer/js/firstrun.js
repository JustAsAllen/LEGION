/**
 * First-run setup.
 *
 * Five short steps: provider, credentials, voice, behaviour, visuals. Every
 * step is skippable and nothing is written until the user confirms. The
 * microphone and the speech engine are both tested with real audio - if a test
 * fails, the failure is shown as-is rather than papered over.
 */

import { esc } from './format.js';

const PAGES = 5;

export class FirstRun {
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('firstrun');
    this.step = 0;
    this._saving = false;
    this._skipProviderCheck = false;
    this.draft = {
      provider: 'none',
      model: '',
      baseUrl: '',
      key: '',
      voiceName: '',
      storeHistory: true,
      longTerm: false,
      autoListen: false,
      quality: 'high',
      reducedMotion: false
    };
    this.meterRaf = 0;
    this.#bind();
    this.paint();
  }

  /* -- wiring -------------------------------------------------- */

  #bind() {
    const r = this.root;

    r.querySelector('#fr-providers').addEventListener('click', (e) => {
      const b = e.target.closest('[data-provider]');
      if (!b) return;
      this.draft.provider = b.dataset.provider;
      if (this.draft.provider === 'ollama') { this.draft.baseUrl = 'http://127.0.0.1:11434/v1'; this.draft.model = this.draft.model || 'llama3.1'; }
      if (this.draft.provider === 'anthropic') { this.draft.baseUrl = 'https://api.anthropic.com'; this.draft.model = this.draft.model || 'claude-sonnet-4-5'; }
      if (this.draft.provider === 'openai') { this.draft.baseUrl = 'https://api.openai.com/v1'; this.draft.model = this.draft.model || 'gpt-4o'; }
      for (const x of r.querySelectorAll('[data-provider]')) x.classList.toggle('is-selected', x === b);
      r.querySelector('#fr-url-field').hidden = this.draft.provider === 'none';
      r.querySelector('#fr-url').value = this.draft.baseUrl;
      this.#refreshKeyStatus();
    });

    r.querySelector('#fr-key').addEventListener('input', (e) => { this.draft.key = e.target.value; this.#refreshKeyStatus(); });
    r.querySelector('#fr-url').addEventListener('input', (e) => { this.draft.baseUrl = e.target.value; });

    r.querySelector('#fr-quality').addEventListener('click', (e) => {
      const b = e.target.closest('[data-quality]');
      if (!b) return;
      this.draft.quality = b.dataset.quality;
      for (const x of r.querySelectorAll('[data-quality]')) x.classList.toggle('is-selected', x === b);
    });

    r.querySelector('#fr-memory').addEventListener('change', (e) => { this.draft.storeHistory = e.target.checked; });
    r.querySelector('#fr-longterm').addEventListener('change', (e) => { this.draft.longTerm = e.target.checked; });
    r.querySelector('#fr-mic-listen').addEventListener('change', (e) => { this.draft.autoListen = e.target.checked; });
    r.querySelector('#fr-reduced').addEventListener('change', (e) => { this.draft.reducedMotion = e.target.checked; });

    r.querySelector('#fr-test-mic').addEventListener('click', () => this.testMic());
    r.querySelector('#fr-test-voice').addEventListener('click', () => this.testVoice());
    r.querySelector('#fr-next').addEventListener('click', () => this.#clickNext());
    r.querySelector('#fr-back').addEventListener('click', () => this.go(this.step - 1));

    // The voice list arrives asynchronously; populate as soon as it exists.
    this.app.loadVoices().then((voices) => {
      const sel = r.querySelector('#fr-voice');
      if (!voices.length) {
        sel.innerHTML = '<option>No voices installed</option>';
        sel.disabled = true;
        const hint = r.querySelector('#fr-voice-state');
        hint.textContent = 'No Windows voices found. Speech output will be unavailable.';
        hint.className = 'fr-hint bad';
        return;
      }
      sel.disabled = false;
      sel.innerHTML = voices.map((v) => `<option value="${esc(v.name)}">${esc(v.name)}${v.gender ? ' - ' + esc(v.gender) : ''}</option>`).join('');
      this.draft.voiceName = sel.value;
      sel.addEventListener('change', () => { this.draft.voiceName = sel.value; });
    });
  }

  #refreshKeyStatus() {
    const el = this.root.querySelector('#fr-key-status');
    const needsKey = this.draft.provider === 'anthropic' || this.draft.provider === 'openai';
    if (!needsKey) { el.textContent = 'This provider does not use an API key.'; el.className = 'fr-key-status'; return; }
    if (this.draft.key) { el.textContent = `Key entered (${this.draft.key.length} characters).`; el.className = 'fr-key-status ok'; return; }
    const stored = this.app.secrets?.[this.draft.provider];
    if (stored && stored.configured) { el.textContent = 'A key is already stored. Leave blank to use it.'; el.className = 'fr-key-status ok'; return; }
    el.textContent = 'No key entered.';
    el.className = 'fr-key-status';
  }

  /* -- real audio tests ---------------------------------------- */

  async testMic() {
    const hint = this.root.querySelector('#fr-mic-state');
    const fill = this.root.querySelector('#fr-meter-fill');
    hint.className = 'fr-hint';
    hint.textContent = 'Requesting microphone...';
    try {
      await this.app.audio.startMic(this.app.micDeviceId);
      hint.textContent = 'Listening - say something.';
      this.#runMeter(fill, () => this.app.audio.micLevel.energy);
    } catch (err) {
      cancelAnimationFrame(this.meterRaf);
      hint.className = 'fr-hint bad';
      hint.textContent = err.message;
    }
  }

  #runMeter(fill, read) {
    cancelAnimationFrame(this.meterRaf);
    const tick = () => {
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, read())) * 100)}%`;
      this.meterRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  async testVoice() {
    const hint = this.root.querySelector('#fr-voice-state');
    hint.className = 'fr-hint';
    hint.textContent = 'Synthesising...';
    const res = await this.app.speak('Voice output is working. This is LEGION.', { voice: this.draft.voiceName });
    if (res.ok) { hint.className = 'fr-hint ok'; hint.textContent = 'Spoke successfully - check your speakers.'; }
    else { hint.className = 'fr-hint bad'; hint.textContent = res.error || 'Speech failed.'; }
  }

  /* -- navigation --------------------------------------------- */

  go(step) {
    this.step = Math.max(0, Math.min(PAGES - 1, step));
    this.paint();
  }

  next() {
    if (this.step === PAGES - 1) { this.finish(); return; }
    this.go(this.step + 1);
  }

  paint() {
    const r = this.root;
    for (const p of r.querySelectorAll('.fr-page')) p.classList.toggle('is-active', Number(p.dataset.page) === this.step);
    for (const s of r.querySelectorAll('.fr-step')) {
      const i = Number(s.dataset.step);
      s.classList.toggle('is-active', i === this.step);
      s.classList.toggle('is-done', i < this.step);
    }
    r.querySelector('#fr-step-hint').textContent = `Step ${this.step + 1} of ${PAGES}`;
    r.querySelector('#fr-back').disabled = this.step === 0;
    r.querySelector('#fr-next').textContent =
      this.step === PAGES - 1
        ? (this._skipProviderCheck ? 'Finish anyway' : 'Finish and launch')
        : 'Continue';
    this.#refreshKeyStatus();
  }

  /* -- persist ------------------------------------------------- */

  /**
   * The only handler behind the primary button.
   *
   * Everything routes through here so a click can never be processed twice:
   * mixing an `onclick` property with the addEventListener wiring above would
   * fire two independent saves on one click.
   */
  #clickNext() {
    if (this._saving) return;
    if (this.step === PAGES - 1) {
      // A provider probe that already failed is not retried: the user has been
      // shown the failure and has chosen to continue past it.
      this.finish({ skipProbe: this._skipProviderCheck });
      return;
    }
    this.next();
  }

  async finish(opts) {
    const { skipProbe = false } = opts || {};
    const app = this.app;
    const d = this.draft;
    const btn = this.root.querySelector('#fr-next');

    if (this._saving) return;
    this._saving = true;
    btn.disabled = true;
    btn.textContent = 'Saving...';

    const fail = (message) => {
      this._saving = false;
      btn.disabled = false;
      btn.textContent = this._skipProviderCheck ? 'Finish anyway' : 'Finish and launch';
      app.toast('error', 'Setup not finished', message);
    };

    const provider = d.provider;
    // `onboarded` is deliberately NOT part of this patch. It is committed only
    // at handover, so an interrupted or abandoned setup never leaves a profile
    // that is marked onboarded while still unconfigured.
    const patch = {
      ai: { provider, model: d.model, baseUrl: d.baseUrl },
      voice: { voiceName: d.voiceName, pushToTalk: true, enabled: true },
      memory: { enabled: true, longTermEnabled: d.longTerm, maxSessionMessages: 200 },
      privacy: { storeConversations: d.storeHistory, telemetry: false, redactSecrets: true },
      visual: { quality: d.quality, reducedMotion: d.reducedMotion, adaptiveQuality: true, showScanlines: true, showWaveform: true },
      app: { autoListenOnLaunch: d.autoListen, closeToTray: true, playBootAnimation: true }
    };

    const cfgRes = await app.setConfig(patch);
    if (!cfgRes.ok) return fail(cfgRes.error);

    if (d.key && (provider === 'anthropic' || provider === 'openai')) {
      const kr = await app.setKey(provider, d.key);
      if (!kr.ok) app.toast('warn', 'Key not stored', kr.error);
    }

    // Prove the provider answers before handing over, so a bad key shows up
    // now rather than on the first real question. Skipped only when the user
    // has explicitly asked to continue regardless.
    if (provider !== 'none' && !skipProbe) {
      const probe = this.root.querySelector('#fr-probe');
      if (probe) { probe.textContent = 'Checking the provider...'; probe.className = 'fr-probe'; }
      const res = await app.testProvider();
      if (probe) {
        probe.textContent = res.ok ? (res.detail || 'Provider reachable.') : (res.error || 'Provider unreachable.');
        probe.className = res.ok ? 'fr-probe ok' : 'fr-probe bad';
      }
      if (!res.ok) {
        // Arm the bypass once, and say plainly that it is being offered.
        this._skipProviderCheck = true;
        this._saving = false;
        btn.disabled = false;
        btn.textContent = 'Finish anyway';
        app.toast('warn', 'Provider not reachable', 'Setup can still be finished. Change the provider later in Settings.');
        return;
      }
    }

    cancelAnimationFrame(this.meterRaf);
    this._saving = false;
    this.#close(app, provider, skipProbe);
  }

  /**
   * Close the wizard and hand over to the main shell.
   *
   * The persisted visual settings are applied to the live stage before the
   * boot animation runs, so the quality chosen in step 5 is what the user
   * actually sees rather than the tier the stage happened to start on.
   */
  #close(app, provider, skippedProbe) {
    this.root.hidden = true;
    app.onboardingDone({ provider, skippedProbe });
  }
}
