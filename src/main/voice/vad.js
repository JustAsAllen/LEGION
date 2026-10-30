'use strict';

/**
 * Voice activity detection.
 *
 * The previous pipeline had no voice activity detection at all. "End of speech"
 * was a counter inside the PowerShell recogniser that gave up after four
 * consecutive empty 0.65s polls, and continuous mode was gated by a fixed 900ms
 * timer in the renderer. Neither could react to what the microphone was actually
 * doing, and neither could see that the "speech" it had just decided to
 * transcribe was LEGION's own voice coming back out of the speakers.
 *
 * This is a small energy-gated state machine. It runs in main, on the PCM the
 * renderer captured, for two reasons: it can then be tested against synthetic
 * signals instead of a live microphone, and it sits directly upstream of every
 * recogniser, so Whisper and System.Speech both benefit from the same
 * segmentation without either of them knowing.
 *
 * Each stated failure mode maps to a specific mechanism:
 *
 *   ignore short noise    startFrames hangover -- a burst must be sustained
 *   detect speech start    frame energy over an adaptive noise floor
 *   tolerate pauses       endSilenceMs of *sustained* quiet, and the quiet run
 *                          resets the instant energy returns, so a 400ms pause
 *                          between words does not split one sentence in two
 *   avoid cutting early    pre-roll keeps the audio from before the trigger, so
 *                          the leading consonant is not clipped, and the off
 *                          threshold sits below the on threshold (hysteresis)
 *   avoid waiting too long the same endSilenceMs bounds the trailing wait, and
 *                          maxSpeechMs force-cuts an utterance that never ends
 *   ignore our own TTS    setGuard() freezes detection while the assistant is
 *                          speaking, and -- importantly -- freezes the noise
 *                          floor too, so a long answer cannot raise the floor
 *                          and make the user's next words inaudible
 */

const { rms, peak, durationMs } = require('./pcm.js');

const DEFAULTS = {
  sampleRate: 16000,
  frameMs: 20,

  // Adaptive floor. `floorInit` starts deliberately high so the very first
  // frame of a word cannot trigger on a cold estimate; it decays down within a
  // few hundred milliseconds of real input.
  floorInit: 0.02,
  floorMin: 0.0015,
  floorMax: 0.05,
  floorFall: 0.85,   // how fast the floor tracks quieter audio
  floorRise: 1.0005, // ...and how reluctantly it climbs toward a noisy room

  // Speech start: energy must clear this against the floor.
  onRatio: 3.0,
  onMargin: 0.004,
  onAbsolute: 0.0075,

  // Speech end: deliberately lower than the start threshold, so a syllable
  // dipping in energy does not end the utterance.
  offRatio: 1.6,
  offMargin: 0.002,
  offAbsolute: 0.0045,

  // A burst this short is a door slam, not a word.
  startFrames: 3,       // 60ms
  minSpeechMs: 200,
  endSilenceMs: 700,    // tolerates a natural pause, bounds the wait
  maxSpeechMs: 15000,
  prerollMs: 300
};

function createVad(options) {
  const o = { ...DEFAULTS, ...(options || {}) };
  const sampleRate = Number(o.sampleRate) || DEFAULTS.sampleRate;
  const frameSamples = Math.max(1, Math.round((sampleRate * o.frameMs) / 1000));

  let floor = o.floorInit;
  let guardUntil = 0;
  let pending = new Float32Array(0);
  let state = 'idle';

  let voicedRun = 0;      // consecutive loud frames, while idle
  let silentRun = 0;      // consecutive quiet frames, while speaking
  let speechStartAt = 0;
  // Two clocks, because they answer different questions. `totalMs` is wall
  // clock since the trigger and bounds how long a turn may run. `activeMs` only
  // accumulates frames that were actually above the release threshold, and is
  // what decides whether this was speech or a bang on the desk.
  let totalMs = 0;
  let activeMs = 0;
  let lastPeak = 0;
  let heldSamples = 0;

  let pre = new Float32Array(0);   // pre-roll ring, input rate
  const preTarget = Math.max(0, Math.round((sampleRate * o.prerollMs) / 1000));
  let held = [];                   // committed speech samples
  let heldLen = 0;

  function now() { return Date.now(); }

  function guardRemaining() {
    return Math.max(0, guardUntil - now());
  }

  /** Suppress detection for `ms`. Aborts any utterance in progress. */
  function setGuard(ms) {
    const span = Math.max(0, Number(ms) || 0);
    if (span <= 0) return 0;
    guardUntil = Math.max(guardUntil, now() + span);
    if (state === 'speech') {
      // Discard rather than emit: this audio is LEGION's own voice, and handing
      // it to a recogniser is exactly the failure this guard exists to stop.
      held = [];
      heldLen = 0;
      heldSamples = 0;
      state = 'idle';
      voicedRun = 0;
      silentRun = 0;
      totalMs = 0;
      activeMs = 0;
      return span;
    }
    return span;
  }

  function pushPre(frame) {
    if (preTarget <= 0) return;
    const combined = new Float32Array(pre.length + frame.length);
    combined.set(pre, 0);
    combined.set(frame, pre.length);
    if (combined.length > preTarget) {
      const trimmed = combined.subarray(combined.length - preTarget);
      pre = new Float32Array(trimmed);
    } else {
      pre = combined;
    }
  }

  function appendHeld(frame) {
    held.push(frame);
    heldLen += frame.length;
    heldSamples += frame.length;
  }

  function takeHeld() {
    if (!heldLen) return new Float32Array(0);
    const out = new Float32Array(heldLen);
    let at = 0;
    for (const chunk of held) {
      out.set(chunk, at);
      at += chunk.length;
    }
    held = [];
    heldLen = 0;
    return out;
  }

  /** Feed the noise floor, but only while idle and not guarded. */
  function adaptFloor(level) {
    if (level < floor) floor = floor * o.floorFall + level * (1 - o.floorFall);
    else floor *= o.floorRise;
    if (floor < o.floorMin) floor = o.floorMin;
    if (floor > o.floorMax) floor = o.floorMax;
  }

  function thresholds() {
    const on = Math.max(o.onAbsolute, floor * o.onRatio + o.onMargin);
    const off = Math.max(o.offAbsolute, floor * o.offRatio + o.offMargin);
    // Never let the two cross, or the hysteresis that protects mid-syllable
    // energy dips would silently invert.
    return { on, off: Math.min(off, on * 0.9) };
  }

  function endUtterance(reason) {
    const pcm = takeHeld();
    const ms = heldSamples > 0 ? Math.round((heldSamples / sampleRate) * 1000) : 0;
    const voiced = activeMs;
    heldSamples = 0;
    state = 'idle';
    voicedRun = 0;
    silentRun = 0;
    totalMs = 0;
    activeMs = 0;
    lastPeak = 0;
    pre = new Float32Array(0);

    // The gate is on *voiced* time, not on how much audio is in the buffer.
    // The buffer always carries pre-roll, so a 90ms bang would otherwise be
    // padded out to 300ms by audio captured before it even started and would
    // sail past a duration test that it should fail.
    if (voiced < o.minSpeechMs) {
      // This is the "ignore short noise" guarantee, enforced at the end as well
      // as the start: a burst can clear the start threshold and still turn out
      // to be a door.
      return { type: 'rejected', reason: 'too-short', durationMs: ms, voicedMs: voiced, pcm };
    }
    return {
      type: 'speech-end',
      reason,
      durationMs: ms,
      voicedMs: voiced,
      peak: lastPeak,
      floor: Math.round(floor * 10000) / 10000,
      pcm
    };
  }

  function frame(frameBuf) {
    const events = [];
    const level = rms(frameBuf);

    if (guardRemaining() > 0) {
      // Consume the audio, decide nothing, and leave the floor alone.
      if (state === 'speech') {
        held = [];
        heldLen = 0;
        heldSamples = 0;
        state = 'idle';
        silentRun = 0;
        totalMs = 0;
        activeMs = 0;
      }
      voicedRun = 0;
      return events;
    }

    const { on, off } = thresholds();

    if (state === 'idle') {
      adaptFloor(level);
      pushPre(frameBuf);
      if (level >= on) {
        voicedRun++;
        if (voicedRun >= o.startFrames) {
          state = 'speech';
          speechStartAt = now();
          silentRun = 0;
          totalMs = 0;
          activeMs = 0;
          // The pre-roll is the part that stops the leading phoneme being lost:
          // by the third loud frame the first consonant is already gone.
          if (pre.length) appendHeld(pre);
          pre = new Float32Array(0);
          events.push({ type: 'speech-start', at: speechStartAt, floor, threshold: on });
        }
      } else {
        voicedRun = 0;
      }
      return events;
    }

    // state === 'speech'
    const p = peak(frameBuf);
    if (p > lastPeak) lastPeak = p;
    appendHeld(frameBuf);
    totalMs += o.frameMs;

    if (level >= off) {
      activeMs += o.frameMs;
      silentRun = 0;   // energy returned: any pause just ended
      if (totalMs >= o.maxSpeechMs) {
        const done = endUtterance('max-duration');
        if (done) events.push(done);
      }
      return events;
    }

    silentRun++;
    if (silentRun * o.frameMs >= o.endSilenceMs) {
      // The silence that closed the segment stays in the buffer on purpose.
      // Trimming it used to cost more than it saved: the quiet frames around a
      // word boundary dip under the release threshold, so `silentRun` reaches
      // its limit while the last word is still going, and both trimming from
      // the front and trimming from the back dropped speech. Handing a
      // recogniser a little room tone costs nothing; handing it half a word
      // costs the whole word.
      const done = endUtterance('silence');
      if (done) events.push(done);
    } else if (totalMs >= o.maxSpeechMs) {
      const done = endUtterance('max-duration');
      if (done) events.push(done);
    }
    return events;
  }

  /**
   * Feed mono float samples of any length. Splits on frame boundaries itself so
   * callers can forward browser buffers as they arrive without re-chunking.
   */
  function push(chunk) {
    const input = chunk instanceof Float32Array ? chunk : Float32Array.from(chunk || []);
    if (!input.length) return [];

    if (pending.length) {
      const merged = new Float32Array(pending.length + input.length);
      merged.set(pending, 0);
      merged.set(input, pending.length);
      pending = merged;
    } else {
      pending = input;
    }

    const events = [];
    let offset = 0;
    while (pending.length - offset >= frameSamples) {
      const slice = pending.subarray(offset, offset + frameSamples);
      // subarray aliases pending, and endUtterance can swap held/pending, so the
      // frame is copied rather than retained across the state change.
      for (const ev of frame(new Float32Array(slice))) events.push(ev);
      offset += frameSamples;
    }
    pending = offset ? pending.slice(offset) : pending;
    return events;
  }

  /** Abandon any in-progress utterance and forget the floor. */
  function reset() {
    pending = new Float32Array(0);
    pre = new Float32Array(0);
    held = [];
    heldLen = 0;
    heldSamples = 0;
    state = 'idle';
    voicedRun = 0;
    silentRun = 0;
    totalMs = 0;
    activeMs = 0;
    floor = o.floorInit;
    lastPeak = 0;
  }

  /** Diagnostics, surfaced over IPC so the UI can explain what it is waiting for. */
  function status() {
    const { on, off } = thresholds();
    return {
      state,
      floor: Math.round(floor * 100000) / 100000,
      speechThreshold: Math.round(on * 100000) / 100000,
      releaseThreshold: Math.round(off * 100000) / 100000,
      guardMs: guardRemaining(),
      settings: {
        startFrames: o.startFrames,
        minSpeechMs: o.minSpeechMs,
        endSilenceMs: o.endSilenceMs,
        maxSpeechMs: o.maxSpeechMs,
        prerollMs: o.prerollMs,
        frameMs: o.frameMs
      }
    };
  }

  /**
   * Segment a complete recording in one pass.
   *
   * Used for audio that already exists when the detector is built -- a pushed
   * wave file, or the SAPI device path -- so the same thresholds govern both
   * live capture and offline analysis.
   */
  function absorb(samples) {
    const out = [];
    for (const ev of push(samples)) if (ev.type === 'speech-end') out.push(ev);
    return out;
  }

  return {
    push,
    absorb,
    reset,
    setGuard,
    guardRemaining,
    status,
    durationMs,
    settings: { ...o, sampleRate, frameSamples },
    // exposed for the checks: lets a test assert on the exact level arithmetic
    _floor: () => floor,
    _setFloor: (v) => { floor = v; }
  };
}

module.exports = { createVad, DEFAULTS };