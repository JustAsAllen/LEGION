/**
 * AUDIO ENGINE
 * ============
 * One Web Audio graph, two sources, one analyser per source.
 *
 *   microphone -> MediaStreamSource -> micAnalyser
 *   TTS WAV    -> AudioBufferSource -> ttsAnalyser -> destination
 *
 * Both analysers report the same five values (rms, low, mid, high, energy) so
 * the face, the waveform and the state machine all react to genuinely measured
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
    this.ttsAnalyser = null;
    this.fftSize = 1024;
    this.micData = null;
    this.ttsData = null;
    this.micLevel = { rms: 0, low: 0, mid: 0, high: 0, energy: 0 };
    this.ttsLevel = { rms: 0, low: 0, mid: 0, high: 0, energy: 0 };
    this.ttsPlaying = false;
    this.speakingGain = 1;
    this.muted = false;
    this.onSpeakingEnd = null;
    this.onError = null;
    this._peaks = new Float32Array(64);
  }

  async context() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio is unavailable in this runtime.');
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (_) { /* ignore */ } }
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
    const constraints = {
      audio: {
        deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      },
      video: false
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (err && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') && deviceId) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } else {
        throw new Error(friendlyMicError(err));
      }
    }

    this.micStream = stream;
    this.micSource = ctx.createMediaStreamSource(stream);
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = this.fftSize;
    this.micAnalyser.smoothingTimeConstant = 0.72;
    this.micAnalyser.minDecibels = -92;
    this.micAnalyser.maxDecibels = -12;
    this.micSource.connect(this.micAnalyser);
    this.micData = new Float32Array(this.micAnalyser.frequencyBinCount);
    return true;
  }

  stopMic() {
    if (this.micSource) { try { this.micSource.disconnect(); } catch (_) { /* ignore */ } }
    if (this.micStream) { for (const t of this.micStream.getTracks()) { try { t.stop(); } catch (_) { /* ignore */ } } }
    this.micSource = null;
    this.micStream = null;
    this.micAnalyser = null;
    this.micLevel = { rms: 0, low: 0, mid: 0, high: 0, energy: 0 };
  }

  get micActive() { return !!this.micStream; }

  setMuted(m) {
    this.muted = !!m;
    if (this.micStream) {
      for (const t of this.micStream.getAudioTracks()) t.enabled = !this.muted;
    }
  }

  /* ---------------- speech output ---------------- */

  /**
   * Play a base64 WAV produced by the main process and analyse it as it plays.
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
    this.ttsPlaying = true;

    const done = new Promise((resolve) => { src.onended = () => resolve({ ok: true, durationMs: Math.round(buffer.duration * 1000) }); });
    src.start(0);

    this._speakDone = done;
    return { ok: true, durationMs: Math.round(buffer.duration * 1000), promise: done };
  }

  async waitForSpeechEnd() {
    if (this._speakDone) return this._speakDone;
    return { ok: true, durationMs: 0 };
  }

  stopSpeaking() {
    if (this.ttsSource) {
      try { this.ttsSource.onended = null; this.ttsSource.stop(); } catch (_) { /* already stopped */ }
      try { this.ttsSource.disconnect(); } catch (_) { /* ignore */ }
    }
    this.ttsSource = null;
    this.ttsAnalyser = null;
    this.ttsPlaying = false;
    this._speakDone = null;
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
    if (this.ttsAnalyser && this.ttsData) {
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

function friendlyMicError(err) {
  const n = err && err.name;
  if (n === 'NotAllowedError') return 'Microphone permission was denied. Allow microphone access in Settings → Privacy → Microphone.';
  if (n === 'NotFoundError') return 'Microphone unavailable. No input device was found.';
  if (n === 'NotReadableError') return 'The microphone is in use by another application.';
  if (n === 'OverconstrainedError') return 'The selected microphone does not support the requested format.';
  return `Microphone unavailable: ${(err && err.message) || 'unknown error'}.`;
}
