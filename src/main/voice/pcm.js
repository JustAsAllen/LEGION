'use strict';

/**
 * PCM helpers shared by the capture and recognition paths.
 *
 * The renderer hands us mono float samples at whatever rate the AudioContext
 * happens to be running at -- 44.1k, 48k, occasionally 96k. Every recogniser
 * we can talk to wants 16kHz 16-bit mono, so the conversion lives here rather
 * than being re-implemented by each tier.
 *
 * Two details are load bearing and easy to get wrong:
 *
 *   1. Resampling 48k -> 16k without a low-pass filter drops a signal onto
 *      itself. Every 3rd sample is taken, so content at 16-24kHz folds straight
 *      down into the 0-8kHz speech band as a phantom tone. That is audible as
 *      robotic speech and it costs Whisper real accuracy, so the decimation is
 *      preceded by a windowed-sinc FIR rather than naive sample picking.
 *
 *   2. The WAVE header is written by hand rather than by a library. It is 44
 *      bytes, the format is fixed, and pulling in a dependency for it would be
 *      a heavier trade than the code it replaces.
 */

/** Sample rate every recogniser in this pipeline agrees on. */
const TARGET_RATE = 16000;

const TAPS = 31; // odd, so the filter is symmetric and has no fractional delay

/**
 * Hamming-windowed sinc low-pass, cutoff at the new Nyquist.
 *
 * Coefficients are computed once per conversion ratio and cached: the ratio
 * only changes when the AudioContext rate does, which in practice is never
 * after startup.
 */
const filterCache = new Map();

function lowpassFor(ratio) {
  const key = Math.round(ratio * 1000);
  const hit = filterCache.get(key);
  if (hit) return hit;

  // Cutoff in cycles/sample: half the *output* Nyquist expressed against the
  // input rate, i.e. 0.5 / ratio. Slightly under 0.5 so the stopband edge does
  // not land exactly on a bin.
  const fc = 0.5 / ratio;
  const mid = (TAPS - 1) / 2;
  const h = new Float64Array(TAPS);
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (TAPS - 1));
    h[i] = sinc * window;
    sum += h[i];
  }
  // Normalise to unity DC gain, otherwise the low-pass also attenuates volume.
  for (let i = 0; i < TAPS; i++) h[i] /= sum;

  const taps = { h, mid, ratio };
  filterCache.set(key, taps);
  return taps;
}

/** Band-limited resample of mono float samples to `rate`. */
function resample(input, from, to) {
  const src = input instanceof Float32Array ? input : Float32Array.from(input || []);
  if (!src.length) return new Float32Array(0);
  const fromRate = Number(from) || TARGET_RATE;
  const toRate = Number(to) || TARGET_RATE;
  if (fromRate === toRate) return Float32Array.from(src);
  if (fromRate <= 0 || toRate <= 0) return new Float32Array(0);

  const ratio = fromRate / toRate;
  const { h, mid } = lowpassFor(ratio);

  // Filter, keeping enough head and tail that the convolution edges do not
  // introduce a click into the middle of a word.
  const n = src.length + TAPS;
  const filtered = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < TAPS; k++) {
      const j = i + k - mid;
      // Out-of-range reads are treated as silence rather than wrapped, so the
      // filter does not smear the last sample across the whole signal.
      if (j >= 0 && j < src.length) acc += h[k] * src[j];
    }
    filtered[i] = acc;
  }

  const outLen = Math.max(1, Math.floor(src.length / ratio));
  const out = new Float32Array(outLen);
  // Decimation is only valid when the ratio is a whole number. Rounding 1.5 to
  // a step of 2 would emit audio at 24k/2 = 12kHz while the header still claimed
  // 16kHz: a 25% pitch shift that turned "jumps over the lazy dog" into
  // "Feinstein southern got". Anything else interpolates, which is exact for the
  // 44.1k and 24k rates that are not multiples of 16k.
  const exact = Math.abs(ratio - Math.round(ratio)) < 1e-9;
  if (ratio >= 1 && exact) {
    // Whole-number downsampling: the filter above already removed the aliasing
    // bands, so a plain decimation is correct and keeps timing exact.
    const step = Math.round(ratio);
    for (let i = 0; i < outLen; i++) {
      const idx = Math.min(n - 1, i * step + mid);
      out[i] = filtered[idx];
    }
  } else {
    // Interpolate between filtered samples. This covers upsampling and every
    // non-integer ratio.
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = filtered[Math.min(n - 1, idx)];
      const b = filtered[Math.min(n - 1, idx + 1)];
      out[i] = a + (b - a) * frac;
    }
  }
  return out;
}

/** Clamp to [-1, 1] and convert to signed 16-bit. */
function toInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let v = float32[i];
    if (!(v === v)) v = 0; // NaN would become an audible click
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    out[i] = Math.round(v * 32767);
  }
  return out;
}

/** int16 -> normalised float, the inverse of toInt16. */
function fromInt16(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768;
  return out;
}

/** Root-mean-square level of a frame. Cheap, and enough to gate on. */
function rms(frame) {
  if (!frame || !frame.length) return 0;
  let acc = 0;
  for (let i = 0; i < frame.length; i++) acc += frame[i] * frame[i];
  return Math.sqrt(acc / frame.length);
}

/** Highest absolute sample, used for reporting rather than for gating. */
function peak(frame) {
  let m = 0;
  for (let i = 0; i < frame.length; i++) {
    const a = Math.abs(frame[i]);
    if (a > m) m = a;
  }
  return m;
}

/**
 * Wrap PCM in a canonical 44-byte RIFF/WAVE header.
 *
 * Both Windows System.Speech (SetInputToWaveFile) and whisper.cpp read this
 * exact layout, which is why the capture path normalises to it once instead of
 * letting each tier parse whatever it was handed.
 */
function encodeWav(float32, sampleRate) {
  const pcm = toInt16(float32);
  const rate = Math.max(1, Math.round(Number(sampleRate) || TARGET_RATE));
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + pcm.length * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);        // PCM fmt chunk size
  buf.writeUInt16LE(1, 20);         // format 1 = PCM integer
  buf.writeUInt16LE(1, 22);         // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);  // byte rate = rate * channels * 2
  buf.writeUInt16LE(2, 32);         // block align
  buf.writeUInt16LE(16, 34);        // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

/** Duration in milliseconds, for reporting. */
function durationMs(float32, sampleRate) {
  const rate = Number(sampleRate) || TARGET_RATE;
  if (!rate || !float32 || !float32.length) return 0;
  return Math.round((float32.length / rate) * 1000);
}

module.exports = {
  TARGET_RATE,
  resample,
  toInt16,
  fromInt16,
  encodeWav,
  rms,
  peak,
  durationMs
};