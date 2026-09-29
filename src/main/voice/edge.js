'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

/**
 * Online voice tier: Microsoft's Edge neural voices.
 *
 * This is the middle tier of the voice pipeline. A prerecorded pack is checked
 * first, because it is instant, free and works offline; this tier exists for
 * everything the pack cannot answer, where a real neural voice is worth a round
 * trip to Microsoft's servers.
 *
 * Two properties matter more than the synthesis itself:
 *
 *  - It fails soft. Being offline, firewalled or throttled must never surface as
 *    a voice error, so every failure returns null and the caller falls through to
 *    a local engine. A tier that can break the app is worse than no tier.
 *
 *  - It is opt-out. `ttsMode: 'offline'` must not touch the network at all, so
 *    the module is only required once a caller has actually chosen to use it.
 */

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const DEFAULT_VOICE = 'en-US-AriaNeural';
const DEFAULT_TIMEOUT_MS = 12000;

let lib = null;
let loadError = null;
const state = {
  lastOkAt: null,
  lastError: null,
  lastLatencyMs: null,
  calls: 0,
  failures: 0
};

/**
 * msedge-tts is required lazily. If the dependency is missing or broken the app
 * must still start and still speak, so the failure is recorded and reported
 * rather than thrown at import time.
 */
function load() {
  if (lib || loadError) return lib;
  try {
    const m = require('msedge-tts');
    if (!m || !m.MsEdgeTTS) throw new Error('msedge-tts did not export MsEdgeTTS');
    lib = m;
  } catch (err) {
    loadError = err.message;
  }
  return lib;
}

/** Fetch a webvoices list, for the settings picker. Never throws. */
async function listVoices() {
  const m = load();
  if (!m) return { ok: false, voices: [], reason: loadError };
  try {
    const t = new m.MsEdgeTTS();
    const raw = await Promise.race([
      t.getVoices(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), DEFAULT_TIMEOUT_MS))
    ]);
    t.close();
    // The endpoint returns a nested list; flatten to the fields a picker needs.
    const flat = [];
    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.VoiceTag && n.VoiceList) walk(n.VoiceList);
        else if (n.ShortName) {
          flat.push({ id: n.ShortName, name: n.VoiceTag && n.VoiceTag.VoiceName, locale: (n.Locale || '').split('-')[0], gender: n.Gender });
        }
      }
    };
    walk(raw);
    return { ok: true, voices: flat };
  } catch (err) {
    return { ok: false, voices: [], reason: err.message };
  }
}

/**
 * Synthesise with an online voice.
 *
 * @returns {Promise<null|{audio:Buffer,format:string,sampleRate:number,bytes:number,source:string,voice:string,tier:string}>}
 *          null means "this tier could not do it, try the next one".
 */
async function synthesize(text, opts) {
  const options = opts || {};
  const clean = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  if (!load()) { state.failures++; return null; }

  const voice = options.voice || DEFAULT_VOICE;
  const work = path.join(os.tmpdir(), 'legion-edge', `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.mkdir(work, { recursive: true }).catch(() => {});

  const started = Date.now();
  let client = null;
  state.calls++;
  try {
    const t = new lib.MsEdgeTTS();
    client = t;
    // Sentence boundaries stay on deliberately. toFile() resolves on
    // Promise.all(audio, metadata), and with boundaries off the service returns
    // no metadata, so the metadata promise rejects with "No metadata received"
    // and the whole call fails even though the audio is fine. Boundaries travel
    // on their own stream, so this costs a small JSON sidecar and leaves the
    // MP3 untouched.
    await t.setMetadata(voice, lib.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
      sentenceBoundaryEnabled: 'true',
      wordBoundaryEnabled: 'false'
    });
    // toFile(dir, text) writes <dir>/audio.mp3.
    await t.toFile(work, clean);
    const out = path.join(work, 'audio.mp3');
    const buf = await fsp.readFile(out);
    if (!buf || !buf.length) { state.failures++; return null; }
    state.lastOkAt = new Date().toISOString();
    state.lastError = null;
    state.lastLatencyMs = Date.now() - started;
    return {
      audio: buf,
      format: 'mp3',
      sampleRate: 24000,
      bytes: buf.length,
      voice,
      source: 'edge',
      tier: 'online',
      durationMs: estimateMp3DurationMs(buf)
    };
  } catch (err) {
    state.failures++;
    state.lastError = err && err.message ? err.message : String(err);
    return null;
  } finally {
    try { if (client && typeof client.close === 'function') client.close(); } catch (_) { /* ignore */ }
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * MP3 duration without a decoder: each frame at 24 kHz / 48 kbps is
 * 24k/1152 * (48/8) bytes ~= 417 bytes, and we only need a sane number for the
 * progress bar, not sample-accurate playback.
 */
function estimateMp3DurationMs(buf) {
  try {
    if (!buf || buf.length < 4) return 0;
    if (buf[0] !== 0xff || (buf[1] & 0xe0) !== 0xe0) return 0; // not a frame sync
    return Math.round((buf.length / 417) * 26.12);
  } catch (_) { return 0; }
}

/** Diagnostics for the settings panel and for check-voice. */
function describe() {
  const m = load();
  return {
    tier: 'online',
    available: !!m,
    provider: 'Microsoft Edge neural voices',
    defaultVoice: DEFAULT_VOICE,
    reason: m ? null : (loadError || 'not loaded'),
    calls: state.calls,
    failures: state.failures,
    lastOkAt: state.lastOkAt,
    lastLatencyMs: state.lastLatencyMs,
    lastError: state.lastError,
    trustedTokenConfigured: !!TRUSTED_TOKEN
  };
}

module.exports = { synthesize, listVoices, describe, DEFAULT_VOICE, TRUSTED_TOKEN };
