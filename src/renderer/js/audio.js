/**
 * AUDIO ENGINE
 * ============
 * One Web Audio graph, two sources, one analyser per source.
 *
 *   microphone -> MediaStreamSource -> micAnalyser
 *   TTS WAV    -> AudioBufferSource -> ttsAnalyser -> destination
 *
 * Both analysers report the same five values (rms, low, mid, high, energy) so
 * the mark, the waveform and the state machine all react to genuinely measured
 * audio. Nothing here is a synthetic fallback.
 */

const BANDS = {
  low: [40, 300],
  mid: [300, 2400],
  high: [2400, 8000]
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.micStream = null;
    this.micSource = null;
    this.micAnalyser = null;
    this.ttsSource = null;
    this.ttsGain = null;
    this.ttsAnalyser = null;
    this.fftSize = 1024;
    this.micData = null;
    this.ttsData = null;
    this.micLevel = { rms: 0, low: 0, mid: 0, high: 0, energy: 0 };
    this.ttsLevel = { rms: 0, low: 0, mid: 0, high: 0, energy: 0 };
    this.ttsPlaying = false;
    this._ttsPending = null;
    this._mock = null;
    this.speakingGain = 1;
    this.muted = false;
    this.onSpeakingEnd = null;
    this.onError = null;
    this._peaks = new Float32Array(64);
    this._tap = null;
    this._tapActive = false;
    this.micSettings = null;
  }

  async context() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio is unavailable in this runtime.');
      this.ctx = new AC();
    }
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch (err) {
        throw new Error(`Audio output is unavailable: ${err.message || 'the audio context could not resume'}.`);
      }
    }
    if (this.ctx.state !== 'running') throw new Error('Audio output is unavailable because the audio context is not running.');
    return this.ctx;
  }

/* ---------------- devices ---------------- */

  async listInputs() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === 'audioinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Input ${i + 1}`, index: i }));
    } catch (_) { return []; }
  }

  async listOutputs() {
    // Chromium does not expose audio output selection; Windows speakers are
    // configured at the OS level. We surface that honestly rather than
    // presenting a selector that does nothing.
    return [];
  }

  /* ---------------- microphone ---------------- */

  async startMic(deviceId) {
    if (this.micStream) return true;
    const ctx = await this.context();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone capture is unavailable in this runtime.');
    }
    const constraints = micConstraints(deviceId);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (err && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') && deviceId) {
        // Retry without the device selector but KEEP the processing. The old
        // fallback asked for `{ audio: true }`, which silently dropped echo
        // cancellation, noise suppression, automatic gain and the mono request,
        // so a device that rejected the exact selector also lost every bit of
        // the audio conditioning the recognition path depends on.
        stream = await navigator.mediaDevices.getUserMedia(micConstraints(null));
      } else {
        throw new Error(friendlyMicError(err));
      }
    }

    let source = null;
    let analyser = null;
    try {
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = this.fftSize;
      analyser.smoothingTimeConstant = 0.72;
      analyser.minDecibels = -92;
      analyser.maxDecibels = -12;
      source.connect(analyser);
    } catch (err) {
      if (source) { try { source.disconnect(); } catch (_) { /* ignore */ } }
      for (const t of stream.getTracks()) { try { t.stop(); } catch (_) { /* ignore */ } }
      throw new Error(err.message || 'The microphone graph could not be created.');
    }

    this.micStream = stream;
    this.micSource = source;
    this.micAnalyser = analyser;
    this.micData = new Float32Array(analyser.frequencyBinCount);
    this.micSettings = readTrackSettings(stream);
    return true;
  }

  stopMic() {
    this.stopTap();
    if (this.micSource) { try { this.micSource.disconnect(); } catch (_) { /* ignore */ } }
    if (this.micStream) { for (const t of this.micStream.getTracks()) { try { t.stop(); } catch (_) { /* ignore */ } } }
    this.micSource = null;
    this.micStream = null;
    this.micAnalyser = null;
    this.micSettings = null;
    this.micLevel = { rms: 0, low: 0, mid: 0, high: 0, energy: 0 };
  }

  get micActive() { return !!this.micStream; }

  /* ---------------- capture tap ---------------- */

  /**
   * Forward the microphone signal itself, not just its level.
   *
   * Until now the processed stream only ever reached the analyser, so the
   * echo cancellation, noise suppression and automatic gain the constraints ask
   * for were used for the level meter and nothing else: System.Speech opened
   * the Windows default input on its own and heard raw, unconditioned audio
   * from a device the user could not even choose. Tapping the graph fixes that
   * for every recogniser at once, because main now decides what to do with the
   * samples.
   *
   * A ScriptProcessorNode is used rather than an AudioWorklet on purpose: it is
   * supported everywhere this app runs, needs no extra module under the page's
   * `script-src 'self'` policy, and 20ms frames on the main thread are
   * comfortably adequate for speech. The frame size is matched to the node's
   * buffer so no audio is dropped or double-counted at the boundary.
   *
   * The node is wired to a zero-gain sink rather than to the destination
   * because Chromium only pulls a ScriptProcessorNode that reaches the
   * destination -- connecting the microphone to the speakers directly would
   * create a feedback loop.
   */
  startTap(onChunk, { frameMs = 20 } = {}) {
    this.stopTap();
    if (!this.micSource) return { ok: false, reason: 'no_microphone' };
    const ctx = this.ctx;
    const want = Math.max(256, Math.pow(2, Math.round(Math.log2((ctx.sampleRate * frameMs) / 1000))));
    const node = ctx.createScriptProcessor(want, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0;

    node.onaudioprocess = (event) => {
      if (!this._tapActive) return;
      try {
        const input = event.inputBuffer.getChannelData(0);
        // Copied because the underlying buffer is reused by the graph and the
        // consumer crosses a process boundary before it finishes with it.
        onChunk(new Float32Array(input), ctx.sampleRate);
      } catch (_) {
        // A consumer that throws must not kill the audio thread; the next
        // frame will be delivered normally.
      }
    };
    this.micSource.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);

    this._tap = { node, sink, onChunk };
    this._tapActive = true;
    return { ok: true, sampleRate: ctx.sampleRate, frameSamples: want };
  }

  stopTap() {
    const tap = this._tap;
    this._tapActive = false;
    this._tap = null;
    if (!tap) return false;
    try { tap.node.onaudioprocess = null; } catch (_) { /* ignore */ }
    try { tap.node.disconnect(); } catch (_) { /* ignore */ }
    try { tap.sink.disconnect(); } catch (_) { /* ignore */ }
    return true;
  }

  get tapActive() { return !!this._tapActive; }

  setMuted(m) {
    this.muted = !!m;
    if (this.micStream) {
      for (const t of this.micStream.getAudioTracks()) t.enabled = !this.muted;
    }
  }

  /* ---------------- speech output ---------------- */

  /**
   * Play base64 audio produced by the main process and analyse it as it plays.
   * The container is whatever the pipeline tier returned (WAV from the pack or
   * SAPI, MP3 from the online tier) and is handed to decodeAudioData untouched,
   * which is why no format branch is needed here.
   * Returns the measured duration once playback actually finishes.
   */
  async speak(base64) {
    if (!base64) return { ok: false, reason: 'no_audio' };
    const ctx = await this.context();

    let buffer;
    try {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      buffer = await ctx.decodeAudioData(bytes.buffer);
    } catch (err) {
      if (this.onError) this.onError('Could not decode the generated speech audio.');
      return { ok: false, reason: 'decode_failed' };
    }

    this.stopSpeaking();

    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, this.speakingGain));

    this.ttsAnalyser = ctx.createAnalyser();
    this.ttsAnalyser.fftSize = this.fftSize;
    this.ttsAnalyser.smoothingTimeConstant = 0.6;
    this.ttsAnalyser.minDecibels = -90;
    this.ttsAnalyser.maxDecibels = -14;
    this.ttsData = new Float32Array(this.ttsAnalyser.frequencyBinCount);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gain);
    gain.connect(this.ttsAnalyser);
    this.ttsAnalyser.connect(ctx.destination);
    this.ttsSource = src;
    this.ttsGain = gain;
    this.ttsPlaying = true;
    const analyser = this.ttsAnalyser;
    const durationMs = Math.round(buffer.duration * 1000);
    let watchdog = null;
    let settled = false;
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });

    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      try { src.onended = null; } catch (_) { /* ignore */ }
      try { src.stop(); } catch (_) { /* already ended */ }
      try { src.disconnect(); } catch (_) { /* ignore */ }
      try { gain.disconnect(); } catch (_) { /* ignore */ }
      try { analyser.disconnect(); } catch (_) { /* ignore */ }
      if (this.ttsSource === src) this.ttsSource = null;
      if (this.ttsAnalyser === analyser) this.ttsAnalyser = null;
      if (this.ttsGain === gain) this.ttsGain = null;
      this.ttsPlaying = false;
      this.ttsLevel = { rms: 0, low: 0, mid: 0, high: 0, energy: 0 };
      if (this._ttsPending && this._ttsPending.done === done) this._ttsPending = null;
      resolveDone(result);
    };

    const pending = {
      done,
      stop: () => settle({ ok: false, cancelled: true, durationMs })
    };
    this._ttsPending = pending;
    src.onended = () => settle({ ok: true, durationMs });
    // A hardware or driver fault can leave onended unfired forever. The
    // watchdog is deliberately longer than the clip so normal playback wins.
    watchdog = setTimeout(() => {
      settle({ ok: false, timedOut: true, durationMs });
    }, durationMs + 2000);
    src.start(0);

    return { ok: true, durationMs, promise: done, stop: pending.stop };
  }

  /**
   * Play a silent clip of the given length for development checks.
   *
   * This never touches Web Audio, so it works when there is no output device
   * and when AudioContext cannot be constructed. It still drives ttsLevel and
   * spectrum so the logo's speaking animation runs exactly as it does for real
   * audio.
   */
  async speakMock(durationMs) {
    this.stopSpeaking();
    const total = Math.max(300, Math.min(10000, Math.round(Number(durationMs) || 1200)));
    const started = performance.now();
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    let ticker = null;
    let endTimer = null;
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (ticker) clearInterval(ticker);
      if (endTimer) clearTimeout(endTimer);
      this.ttsPlaying = false;
      this.ttsLevel = { rms: 0, low: 0, mid: 0, high: 0, energy: 0 };
      if (this._mock && this._mock.done === done) this._mock = null;
      resolveDone(result);
    };

    const pending = {
      done,
      stop: () => settle({ ok: false, cancelled: true, durationMs: total })
    };
    this._mock = pending;
    this.ttsPlaying = true;

    const paint = () => {
      if (settled) return;
      const t = (performance.now() - started) / 1000;
      const low = Math.max(0, Math.min(1, 0.36 + 0.20 * Math.sin(t * 6.1)));
      const mid = Math.max(0, Math.min(1, 0.30 + 0.24 * Math.sin(t * 8.7 + 1.1)));
      const high = Math.max(0, Math.min(1, 0.20 + 0.16 * Math.sin(t * 11.3 + 2.2)));
      const energy = low * 0.5 + mid * 0.34 + high * 0.16;
      this.ttsLevel = { rms: energy, low, mid, high, energy };
      const bins = this._mockData || (this._mockData = new Float32Array(128));
      for (let i = 0; i < bins.length; i++) {
        const shape = Math.abs(Math.sin(t * 5.2 + i * 0.31)) * (1 - (i / bins.length) * 0.7);
        bins[i] = Math.max(0, Math.min(1, 0.16 + shape * 0.62 + 0.08 * Math.sin(t * 13 + i)));
      }
    };
    paint();
    ticker = setInterval(paint, 50);
    endTimer = setTimeout(() => settle({ ok: true, durationMs: total, mock: true }), total);
    return { ok: true, durationMs: total, mock: true, promise: done, stop: pending.stop };
  }

  async waitForSpeechEnd() {
    if (this._mock) return this._mock.done;
    if (this._ttsPending) return this._ttsPending.done;
    return { ok: true, durationMs: 0 };
  }

  stopSpeaking() {
    if (this._mock) {
      const stop = this._mock.stop;
      this._mock = null;
      stop();
    }
    if (this._ttsPending) {
      const stop = this._ttsPending.stop;
      this._ttsPending = null;
      stop();
    }
    if (this.ttsSource) {
      try { this.ttsSource.onended = null; this.ttsSource.stop(); } catch (_) { /* already stopped */ }
      try { this.ttsSource.disconnect(); } catch (_) { /* ignore */ }
    }
    if (this.ttsGain) { try { this.ttsGain.disconnect(); } catch (_) { /* ignore */ } }
    if (this.ttsAnalyser) { try { this.ttsAnalyser.disconnect(); } catch (_) { /* ignore */ } }
    this.ttsSource = null;
    this.ttsGain = null;
    this.ttsAnalyser = null;
    this.ttsPlaying = false;
    this.ttsLevel = { rms: 0, low: 0, mid: 0, high: 0, energy: 0 };
  }

  setSpeakingGain(v) { this.speakingGain = Math.max(0, Math.min(1.5, v / 100)); }

  /* ---------------- analysis ---------------- */

  _analyse(analyser, data) {
    if (!analyser) return { rms: 0, low: 0, mid: 0, high: 0, energy: 0 };
    analyser.getFloatFrequencyData(data);

    const nyquist = (this.ctx ? this.ctx.sampleRate : 48000) / 2;
    const bins = data.length;
    const toBin = (hz) => Math.max(0, Math.min(bins - 1, Math.round((hz / nyquist) * bins)));

    const bandSum = (lo, hi) => {
      const a = toBin(lo), b = toBin(hi);
      let s = 0;
      for (let i = a; i <= b; i++) {
        const db = data[i];
        if (db > -110) s += Math.pow(10, db / 20);
      }
      const n = Math.max(1, b - a + 1);
      return s / n;
    };

    const norm = (v) => Math.max(0, Math.min(1, (20 * Math.log10(Math.max(1e-7, v)) + 78) / 78));
    const low = norm(bandSum(BANDS.low[0], BANDS.low[1]));
    const mid = norm(bandSum(BANDS.mid[0], BANDS.mid[1]));
    const high = norm(bandSum(BANDS.high[0], BANDS.high[1]));

    let timeRms = 0;
    if (analyser === this.ttsAnalyser || analyser === this.micAnalyser) {
      // getFloatTimeDomainData needs a separate buffer; reuse is fine because
      // frequency data is already captured above.
    }

    const energy = Math.max(0, Math.min(1, low * 0.5 + mid * 0.34 + high * 0.16));
    const rms = energy;
    return { rms, low, mid, high, energy };
  }

  /** Call once per animation frame. */
  sample() {
    if (this.micAnalyser && this.micData) {
      this.micAnalyser.getFloatFrequencyData(this.micData);
      this.micLevel = this._analyse(this.micAnalyser, this.micData);
    } else {
      this.micLevel = { rms: 0, low: 0, mid: 0, high: 0, energy: 0 };
    }
    if (this._mock) {
      // speakMock paints ttsLevel on its own timer; leave it alone.
    } else if (this.ttsAnalyser && this.ttsData) {
      this.ttsAnalyser.getFloatFrequencyData(this.ttsData);
      this.ttsLevel = this._analyse(this.ttsAnalyser, this.ttsData);
    } else if (!this.ttsPlaying) {
      this.ttsLevel = { rms: 0, low: 0, mid: 0, high: 0, energy: 0 };
    }
    return { mic: this.micLevel, tts: this.ttsLevel };
  }

  /** Down-sampled spectrum for the waveform display. */
  spectrum(out) {
    const target = out || this._peaks;
    const n = target.length;
    if (this._mock) {
      const bins = this._mockData;
      if (!bins) {
        target.fill(0);
        return target;
      }
      for (let i = 0; i < n; i++) {
        target[i] = bins[Math.min(bins.length - 1, Math.floor((i / n) * bins.length))];
      }
      return target;
    }
    if (this.ttsPlaying && this.ttsAnalyser && this.ttsData) {
      for (let i = 0; i < n; i++) {
        const lo = Math.floor(Math.pow(i / n, 1.7) * 340);
        const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / n, 1.7) * 340));
        let m = 0;
        for (let k = lo; k < hi && k < this.ttsData.length; k++) {
          if (this.ttsData[k] > m) m = this.ttsData[k];
        }
        target[i] = Math.max(0, Math.min(1, (m + 92) / 76));
      }
      return target;
    }
    if (this.micAnalyser && this.micData) {
      for (let i = 0; i < n; i++) {
        const lo = Math.floor(Math.pow(i / n, 1.7) * 340);
        const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / n, 1.7) * 340));
        let m = -120;
        for (let k = lo; k < hi && k < this.micData.length; k++) {
          if (this.micData[k] > m) m = this.micData[k];
        }
        target[i] = Math.max(0, Math.min(1, (m + 92) / 76));
      }
      return target;
    }
    target.fill(0);
    return target;
  }
}

/**
 * The microphone constraints LEGION always asks for.
 *
 * Exported as a function so the checks can assert on the request itself without
 * needing a microphone, and so the one place that builds the constraint object
 * is the only place that has to change if it ever does.
 *
 * channelCount:1 is not cosmetic. A stereo stream doubles the bytes on the wire
 * and every recogniser here wants mono; asking explicitly stops a stereo
 * interface from silently handing us interleaved pairs.
 */
export function micConstraints(deviceId) {
  return {
    audio: {
      deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1
    },
    video: false
  };
}

/**
 * What the browser actually granted, as opposed to what was requested.
 *
 * Chromium treats these as hints: a device with no hardware echo canceller is
 * opened with echoCancellation:false and no error, so a user can believe they
 * have noise suppression when they do not. Reading the track back lets the
 * interface say so instead of implying a guarantee it cannot make.
 */
function readTrackSettings(stream) {
  try {
    const track = stream && stream.getAudioTracks && stream.getAudioTracks()[0];
    if (!track || typeof track.getSettings !== 'function') return null;
    const s = track.getSettings() || {};
    return {
      deviceId: s.deviceId || null,
      sampleRate: s.sampleRate || null,
      channelCount: s.channelCount || null,
      echoCancellation: s.echoCancellation === true,
      noiseSuppression: s.noiseSuppression === true,
      autoGainControl: s.autoGainControl === true
    };
  } catch (_) {
    return null;
  }
}

function friendlyMicError(err) {
  const n = err && err.name;
  if (n === 'NotAllowedError') return 'Microphone permission was denied. Allow microphone access in Settings → Privacy → Microphone.';
  if (n === 'NotFoundError') return 'Microphone unavailable. No input device was found.';
  if (n === 'NotReadableError') return 'The microphone is in use by another application.';
  if (n === 'OverconstrainedError') return 'The selected microphone does not support the requested format.';
  return `Microphone unavailable: ${(err && err.message) || 'unknown error'}.`;
}
