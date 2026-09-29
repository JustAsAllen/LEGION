'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const voicepack = require('./voicepack');
const edge = require('./edge');
const piper = require('./piper');

const pExecFile = promisify(execFile);

/**
 * The voice pipeline.
 *
 * Four tiers, cheapest and most reliable first. Each one is allowed to decline,
 * and the first that produces audio wins:
 *
 *   1. voicepack  a prerecorded clip. Instant, offline, byte-identical every
 *                 time. A file read, so it also works on macOS and Linux.
 *   2. edge       a neural voice over the network. Best quality for anything the
 *                 pack does not cover, but it needs a route to Microsoft's
 *                 servers and it costs a round trip.
 *   3. piper      a local neural voice, if the user installed it. Offline, but
 *                 it is a separate download so it is usually absent.
 *   4. sapi       the Windows built-in. Always present on Windows, robotic, but
 *                 it can never fail for want of a network or an install.
 *
 * The point of the ordering is that the good-enough tier is tried first and the
 * fragile ones are only reached when the cheap ones declined. Nothing above
 * tier 1 is allowed to throw: an offline machine must still speak.
 */

/**
 * Text to speech via the Windows SAPI engine (System.Speech).
 *
 * Synthesis writes a real WAV file. We return the audio bytes to the renderer,
 * which plays them through Web Audio and runs the same analyser used for the
 * microphone. That means the SPEAKING state is driven by genuine voice
 * amplitude rather than a guess.
 */

/**
 * SAPI (System.Speech) -- tier 4, the last resort on Windows.
 *
 * Synthesis writes a real WAV file. We return the audio bytes to the renderer,
 * which plays them through Web Audio and runs the same analyser used for the
 * microphone. That means the SPEAKING state is driven by genuine voice
 * amplitude rather than a guess.
 *
 * This block is only reached once the cheaper tiers declined, so the PowerShell
 * spawn below is the rare path, not the common one.
 */
const PS_LIST_VOICES = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
  [pscustomobject]@{
    name = $_.VoiceInfo.Name
    culture = $_.VoiceInfo.Culture.Name
    gender = $_.VoiceInfo.Gender.ToString()
    age = $_.VoiceInfo.Age.ToString()
    description = $_.VoiceInfo.Description
  }
} | ConvertTo-Json -Compress
`;

const PS_SYNTH = (outFile, voice, rate, volume) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
${voice ? `$v = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -eq ${JSON.stringify(voice)} } | Select-Object -First 1
if ($v) { $synth.SelectVoice($v.VoiceInfo.Name) }` : ''}
$synth.Rate = ${Number(rate) || 0}
$synth.Volume = ${Math.max(0, Math.min(100, Number(volume) || 100))}
# The format is built with the explicit three-argument constructor; the
# parameterless New-Object call has no matching overload and throws.
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile(${JSON.stringify(outFile)}, $format)
$text = [Console]::In.ReadToEnd()
$synth.Speak($text)
$synth.Dispose()
[Console]::Out.Write("OK")
`;

let available = null;

async function listVoices(force) {
  if (available && !force) return available;
  if (process.platform !== 'win32') {
    available = { voices: [], platform: process.platform, ttsAvailable: false, reason: 'SAPI is only available on Windows.' };
    return available;
  }
  try {
    const { stdout } = await pExecFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST_VOICES], {
      timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024
    });
    let parsed = JSON.parse(String(stdout).trim() || '[]');
    if (!Array.isArray(parsed)) parsed = [parsed];
    available = {
      ttsAvailable: true,
      platform: 'win32',
      voices: parsed.filter((v) => v && v.name).map((v) => ({ name: v.name, culture: v.culture, gender: v.gender, description: v.description }))
    };
  } catch (err) {
    available = { ttsAvailable: false, platform: 'win32', voices: [], reason: err.message };
  }
  return available;
}

/* ------------------------------------------------------------------ */
/* The pipeline                                                        */
/* ------------------------------------------------------------------ */

const MODES = Object.freeze({
  AUTO: 'auto',                 // pack -> online -> piper -> sapi
  OFFLINE: 'offline',           // pack -> piper -> sapi, never touches the net
  PACK_ONLY: 'pack-only'        // pack only; silence if there is no clip
});

function normaliseMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  // Compare against the values, not the keys: the settings file stores
  // "pack-only", while the constant's key is PACK_ONLY.
  return Object.values(MODES).includes(m) ? m : MODES.AUTO;
}

async function synthesize(text, opts) {
  const options = opts || {};
  const clean = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return { audio: null, empty: true };

  const mode = normaliseMode(options.ttsMode);
  const trace = [];

  // 1. the pack. A plain file read, so it is tried before any platform or
  //    network concern -- it is the only tier that works everywhere.
  const pack = await voicepack.resolve(clean).catch((err) => { trace.push(`voicepack error: ${err.message}`); return null; });
  if (pack) return Object.assign({}, pack, { tier: 'voicepack', mode });

  if (mode === MODES.PACK_ONLY) {
    return { audio: null, empty: true, tier: null, mode, reason: 'No clip for that phrase and the pipeline is set to pack only.' };
  }

  // 2. the online neural voice. Fails soft by design.
  if (mode === MODES.AUTO) {
    const online = await edge.synthesize(clean, { voice: options.onlineVoice || edge.DEFAULT_VOICE }).catch(() => null);
    if (online) return Object.assign({}, online, { mode });
    trace.push('online tier unavailable');
  }

  // 3. a local neural voice, when the user has installed one.
  const local = await piper.synthesize(clean, { piperPath: options.piperPath, piperModel: options.piperModel }).catch(() => null);
  if (local) return Object.assign({}, local, { mode });
  trace.push('piper unavailable');

  // 4. the Windows built-in.
  return sapi(clean, options, mode, trace);
}

/**
 * The SAPI tier, split out so synthesize() reads as a list of tiers rather than
 * a wall of PowerShell. Only reached when nothing better was available.
 */
async function sapi(clean, options, mode, trace) {
  if (process.platform !== 'win32') {
    const err = new Error('No voice tier is available on this platform: the pack has no clip for that phrase, the online tier needs a network, and Piper is not installed.');
    err.code = 'E_TTS_PLATFORM';
    throw err;
  }

  const dir = path.join(os.tmpdir(), 'legion-tts');
  await fsp.mkdir(dir, { recursive: true });
  const outFile = path.join(dir, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);

  const script = PS_SYNTH(outFile, options.voice || null, options.rate || 0, options.volume === undefined ? 100 : options.volume);

  // The script lives in a file and the text arrives on stdin. Running it with
  // `-Command -` would make PowerShell read the whole of stdin as the script,
  // leaving nothing for the script's ReadToEnd(), and the trailing text would
  // then be parsed as a fresh command.
  const scriptFile = path.join(dir, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  await fsp.writeFile(scriptFile, script, 'utf8');

  try {
    await new Promise((resolve, reject) => {
      const child = execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
        timeout: Math.max(15000, clean.length * 220), windowsHide: true, maxBuffer: 1024 * 1024
      }, (err) => {
        if (err) {
          const msg = /timed out|ETIMEDOUT|killed/i.test(String(err.message)) ? 'Speech synthesis timed out.' : `Speech synthesis failed: ${err.message}`;
          const e = new Error(msg); e.code = 'E_TTS'; reject(e);
        } else resolve();
      });
      child.stdin.on('error', () => { /* powershell may exit before we finish writing */ });
      child.stdin.end(clean);
    });
  } finally {
    await fsp.unlink(scriptFile).catch(() => {});
  }

  const stat = await fsp.stat(outFile).catch(() => null);
  if (!stat || !stat.size) {
    await fsp.unlink(outFile).catch(() => {});
    const e = new Error('Voice output unavailable — the speech engine returned no audio.');
    e.code = 'E_TTS_EMPTY';
    throw e;
  }

  const buf = await fsp.readFile(outFile);
  await fsp.unlink(outFile).catch(() => {});

  return {
    audio: buf,
    format: 'wav',
    sampleRate: 24000,
    bytes: buf.length,
    durationMs: estimateWavDurationMs(buf),
    voice: options.voice || null,
    source: 'sapi',
    tier: 'sapi',
    mode,
    trace
  };
}

/** Everything the settings panel needs to describe the pipeline honestly. */
async function describePipeline(opts) {
  const options = opts || {};
  const mode = normaliseMode(options.ttsMode);
  return {
    mode,
    modes: Object.values(MODES),
    pack: await voicepack.describe().catch((e) => ({ error: e.message })),
    online: mode === MODES.PACK_ONLY ? { available: false, reason: 'pack-only mode' } : edge.describe(),
    piper: await piper.probe(options).catch((e) => ({ available: false, reason: e.message })),
    sapi: { available: process.platform === 'win32', platform: process.platform }
  };
}

function estimateWavDurationMs(buf) {
  try {
    if (buf.length < 44) return 0;
    const byteRate = buf.readUInt32LE(28);
    const dataSize = buf.length - 44;
    if (!byteRate) return 0;
    return Math.round((dataSize / byteRate) * 1000);
  } catch (_) { return 0; }
}

module.exports = { listVoices, synthesize, describePipeline, voicepack, edge, piper, MODES };
