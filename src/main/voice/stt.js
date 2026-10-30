'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pcm = require('./pcm.js');
const { createVad } = require('./vad.js');
const whisper = require('./whisper.js');

/**
 * Speech to text.
 *
 * There are three engines behind one interface, and the choice is reported
 * rather than hidden:
 *
 *   sapi-device  System.Speech opens the Windows default input itself. The
 *                engine this project has always used, and the only one that
 *                works without the renderer. It cannot be given a different
 *                microphone and it cannot be given audio we already have.
 *   sapi-file    The renderer captures through getUserMedia -- so echo
 *                cancellation, noise suppression, automatic gain and a chosen
 *                device all apply -- hands us PCM, we segment it with the VAD
 *                and write a 16kHz WAVE that System.Speech reads with
 *                SetInputToWaveFile. Same recogniser, better audio.
 *   whisper      Local whisper.cpp, when the user has installed it. Runs on the
 *                GPU when the binary reports a CUDA device it can use, on the
 *                CPU otherwise.
 *
 * The engine that used to be the only option is untouched and still the
 * fallback: on a machine with no renderer capture, or no installed speech
 * language, everything behaves exactly as it did before.
 *
 * Nothing here fabricates a transcript. Each engine returns what it actually
 * recognised or a real failure.
 */

const TARGET_RATE = pcm.TARGET_RATE;

let active = null;        // sapi-device session
let capture = null;       // renderer-fed PCM session
let captureSeq = 0;

// Sentinel paths we deliberately stopped. When the kill races the recogniser's
// own exit, Node reports SIGKILL with no output, which is indistinguishable
// from a real timeout unless we remember the request.
const stoppedFiles = new Set();

const PS_RECOGNIZE = `
$ErrorActionPreference = 'Stop'
$stopFile = $args[0]
$maxSec  = [double]$args[1]

Add-Type -AssemblyName System.Speech

$engine = $null
try {
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
} catch {
  [Console]::Out.Write('__LEGION_ERR__NO_ENGINE')
  exit 0
}

$recognizerInfo = $null
try { $recognizerInfo = $engine.RecognizerInfo } catch { $recognizerInfo = $null }
if (-not $recognizerInfo) {
  $engine.Dispose()
  [Console]::Out.Write('__LEGION_ERR__NO_LANGUAGE')
  exit 0
}

# System.Speech on .NET Framework exposes no API for choosing a capture device:
# SpeechRecognitionEngine has only SetInputToDefaultAudioDevice, and
# AudioDeviceManager is not in the public surface. The old code indexed
# GetInstalledVoices() - a list of TTS output voices - and passed a VoiceInfo
# to SetInputToAudioDevice, which does not exist; it always threw and fell
# through to the default device, so a chosen microphone was silently ignored.
# Microphone choice is honoured on the analyser path (getUserMedia deviceId)
# and on the sapi-file engine, which transcribes audio we captured ourselves;
# this engine uses the system default input and reports so instead of pretending.
$usingDefaultDevice = $true

try { $engine.SetInputToDefaultAudioDevice() } catch {
  $engine.Dispose()
  [Console]::Out.Write('__LEGION_ERR__NO_DEVICE')
  exit 0
}

try { $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar)) } catch { }

$sb = New-Object System.Text.StringBuilder
$deadline = (Get-Date).AddSeconds($maxSec)
$silenceRuns = 0

try {
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $stopFile) { break }
    $res = $null
    try { $res = $engine.Recognize([TimeSpan]::FromSeconds(0.65)) } catch { break }
    if ($res -and $res.Text) {
      [void]$sb.Append($res.Text.Trim())
      [void]$sb.Append(' ')
      $silenceRuns = 0
    } else {
      $silenceRuns++
      if ($silenceRuns -ge 4 -and $sb.Length -gt 0) { break }
    }
  }
} catch { }

$engine.Dispose()
[Console]::Out.Write($sb.ToString().Trim())
`;

/**
 * Transcribe a WAVE file with the same System.Speech engine.
 *
 * The audio format is stated explicitly because the VAD guarantees 16kHz mono
 * 16-bit; passing it lets the recogniser skip its own format guessing. Some
 * System.Speech builds reject the explicit overload, so the inferred form stays
 * as a fallback rather than the code assuming one call always works.
 */
const PS_TRANSCRIBE_FILE = `
$ErrorActionPreference = 'Stop'
$wav     = $args[0]
$maxSec  = [double]$args[1]

Add-Type -AssemblyName System.Speech

$engine = $null
try {
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
} catch {
  [Console]::Out.Write('__LEGION_ERR__NO_ENGINE')
  exit 0
}

$recognizerInfo = $null
try { $recognizerInfo = $engine.RecognizerInfo } catch { $recognizerInfo = $null }
if (-not $recognizerInfo) {
  $engine.Dispose()
  [Console]::Out.Write('__LEGION_ERR__NO_LANGUAGE')
  exit 0
}

$bound = $false
try {
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    ${TARGET_RATE},
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono)
  $engine.SetInputToWaveFile($wav, $fmt)
  $bound = $true
} catch { }

if (-not $bound) {
  try { $engine.SetInputToWaveFile($wav); $bound = $true } catch { }
}

if (-not $bound) {
  $engine.Dispose()
  [Console]::Out.Write('__LEGION_ERR__NO_DEVICE')
  exit 0
}

try { $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar)) } catch { }

$sb = New-Object System.Text.StringBuilder
$deadline = (Get-Date).AddSeconds($maxSec)

try {
  while ((Get-Date) -lt $deadline) {
    $res = $null
    try { $res = $engine.Recognize([TimeSpan]::FromSeconds(0.6)) } catch { break }
    if ($res -and $res.Text) {
      [void]$sb.Append($res.Text.Trim())
      [void]$sb.Append(' ')
    }
  }
} catch { }

$engine.Dispose()
[Console]::Out.Write($sb.ToString().Trim())
`;

function tempPath(kind, ext) {
  return path.join(os.tmpdir(), `legion-${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}

function cleanup(file) { try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch (_) { /* ignore */ } }

function runPowerShell(args, { timeout = 90000 } = {}) {
  return new Promise((resolve) => {
    const file = tempPath('stt', 'ps1');
    try {
      fs.writeFileSync(file, PS_TRANSCRIBE_FILE, 'utf8');
    } catch (err) {
      resolve({ error: { code: 'E_STT_SCRIPT', message: `Could not prepare the speech recogniser script: ${err.message}` } });
      return;
    }
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
      { timeout, windowsHide: true, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        cleanup(file);
        resolve({ err, stdout: String(stdout || '').trim(), stderr: String(stderr || '') });
      }
    );
  });
}

/** Translate a raw recogniser outcome into the shared result shape. */
function interpret(run, { stopped = false } = {}) {
  if (run.error) return run;
  const out = run.stdout;
  if (run.err && !out && run.stderr) {
    const first = run.stderr.split(/\r?\n/).find((l) => /\S/.test(l)) || 'unknown error';
    return { ok: false, error: { code: 'E_STT_SCRIPT', message: `The speech recogniser failed to start: ${first.trim()}` } };
  }
  if (out.startsWith('__LEGION_ERR__NO_LANGUAGE')) {
    return { ok: false, error: { code: 'E_STT_NO_LANGUAGE', message: 'No speech recognition language is installed. Settings → Time & language → Speech → Install a speech language.' } };
  }
  if (out.startsWith('__LEGION_ERR__NO_ENGINE')) {
    return { ok: false, error: { code: 'E_STT_NO_ENGINE', message: 'The Windows speech recogniser is unavailable on this machine.' } };
  }
  if (out.startsWith('__LEGION_ERR__NO_DEVICE')) {
    return { ok: false, error: { code: 'E_STT_NO_DEVICE', message: 'Microphone unavailable. Check that an input device is connected and enabled.' } };
  }
  if (run.err && /killed|SIGKILL|timed out/i.test(String(run.err.message)) && !out) {
    if (stopped) return { ok: false, stopped: true, error: { code: 'E_STT_STOPPED', message: 'Capture stopped before anything was recognised.' } };
    return { ok: false, error: { code: 'E_STT_TIMEOUT', message: 'Voice recognition timed out.' } };
  }
  if (!out) {
    if (stopped) return { ok: false, stopped: true, error: { code: 'E_STT_STOPPED', message: 'Capture stopped before anything was recognised.' } };
    return { ok: false, error: { code: 'E_STT_EMPTY', message: 'Voice recognition heard nothing. Try speaking closer to the microphone.' } };
  }
  return { ok: true, transcript: out.replace(/\s+/g, ' ').trim() };
}

/**
 * Remove recogniser scripts and sentinels left behind by an earlier run.
 * A hard kill skips the callback that would normally unlink them, and these
 * files contain a script path and a limit, so they should not pile up in temp.
 */
function sweepOrphans(maxAgeMs = 60 * 60 * 1000) {
  let removed = 0;
  try {
    const dir = os.tmpdir();
    const cutoff = Date.now() - maxAgeMs;
    for (const name of fs.readdirSync(dir)) {
      if (!/^legion-(stt|wake)-\d+-[a-z0-9]+\.(ps1|flag|wav)$/.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) { fs.unlinkSync(full); removed++; }
      } catch (_) { /* raced with another run; fine */ }
    }
  } catch (_) { /* temp not listable; nothing to sweep */ }
  return removed;
}

/* ------------------------------------------------------------------ */
/* engine: sapi-device                                                  */
/* ------------------------------------------------------------------ */

/**
 * Begin live capture from the Windows default input.
 * Returns immediately; the promise settles when recognition ends.
 */
function listen(options) {
  const opts = options || {};
  if (process.platform !== 'win32') {
    return { stop() {}, promise: Promise.resolve({ ok: false, error: { code: 'E_STT_PLATFORM', message: 'Local speech recognition is only available on Windows.' } }) };
  }
  stopActive();
  // Cheap, and only reaps debris from an earlier hard kill.
  sweepOrphans();

  const stopFile = tempPath('stt', 'flag');
  const maxSeconds = Math.max(1.5, Math.min(60, Number(opts.maxSeconds) || 14));
  const scriptFile = tempPath('stt', 'ps1');

  const promise = new Promise((resolve) => {
    // The script is written to a file and run with -File, passing the sentinel
    // and the time limit as real arguments. Passing the script inline as
    // `-Command -Command SCRIPT -- sentinel seconds` does not work: PowerShell
    // concatenates the trailing tokens onto the end of the script text, so the
    // whole invocation dies with "Missing expression after unary operator '--'"
    // and writes nothing to stdout. Every push-to-talk attempt therefore
    // reported "Voice recognition heard nothing" and no recogniser ever ran.
    try {
      fs.writeFileSync(scriptFile, PS_RECOGNIZE, 'utf8');
    } catch (err) {
      cleanup(stopFile);
      resolve({ ok: false, error: { code: 'E_STT_SCRIPT', message: `Could not prepare the speech recogniser script: ${err.message}` } });
      return;
    }

    const child = execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, stopFile, String(maxSeconds)],
      { timeout: (maxSeconds + 25) * 1000, windowsHide: true, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        cleanup(stopFile);
        cleanup(scriptFile);
        const wasStopped = stoppedFiles.has(stopFile);
        stoppedFiles.delete(stopFile);
        if (active && active.stopFile === stopFile) active = null;
        resolve(interpret({ err, stdout: String(stdout || '').trim(), stderr: String(stderr || '') }, { stopped: wasStopped }));
      }
    );
    active = { child, stopFile, scriptFile, startedAt: Date.now() };
  });

  return {
    stop() { stopActive(); },
    promise
  };
}

function stopActive() {
  if (!active) return false;
  const { stopFile } = active;
  stoppedFiles.add(stopFile);
  try { fs.writeFileSync(stopFile, 'stop'); } catch (_) { /* ignore */ }
  // Give the recogniser a moment to flush, then make sure it dies.
  setTimeout(() => {
    if (active && active.stopFile === stopFile) {
      try { active.child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      cleanup(active.scriptFile);
      active = null;
    }
  }, 1200).unref?.();
  return true;
}

function isListening() { return !!active; }

/* ------------------------------------------------------------------ */
/* engine: sapi-file and whisper                                        */
/* ------------------------------------------------------------------ */

/** Transcribe an existing 16kHz mono WAVE with System.Speech. */
async function transcribeWav(wavPath, options) {
  const opts = options || {};
  // Rounded because a fractional budget reaches child_process as an invalid
  // `timeout` and throws before a recogniser is ever started.
  const seconds = Math.round(Math.max(2, Math.min(60, (opts.maxSeconds || (10 + (opts.durationMs || 0) / 250)) || 20)));
  const run = await runPowerShell([wavPath, String(seconds)], { timeout: (seconds + 25) * 1000 });
  const res = interpret(run);
  if (res.ok) res.engine = 'sapi-file';
  return res;
}

/**
 * Pick an engine and transcribe mono float samples.
 *
 * `auto` prefers local Whisper when it is installed and working, because it is
 * both faster and more accurate than the Windows dictation grammar, and falls
 * through to System.Speech otherwise. A Whisper failure does not end the turn:
 * the same audio is retried on SAPI, so a broken external binary degrades
 * quality instead of breaking input.
 */
async function transcribePcm(samples, options) {
  const opts = options || {};
  const inputRate = Number(opts.sampleRate) || TARGET_RATE;
  const requested = String(opts.engine || 'auto');
  const mono = pcm.resample(samples, inputRate, TARGET_RATE);
  if (!mono.length) {
    return { ok: false, error: { code: 'E_STT_EMPTY', message: 'No audio was captured.' } };
  }

  const attempts = [];
  if (requested === 'whisper') attempts.push('whisper');
  else if (requested !== 'sapi') attempts.push('whisper');
  if (requested !== 'whisper') attempts.push('sapi-file');

  let last = null;
  for (const engine of attempts) {
    if (engine === 'whisper') {
      const wav = tempPath('stt', 'wav');
      try {
        fs.writeFileSync(wav, pcm.encodeWav(mono, TARGET_RATE));
        const res = await whisper.transcribe(wav, {
          whisperPath: opts.whisperPath,
          whisperModel: opts.whisperModel,
          language: opts.whisperLanguage,
          timeoutMs: Math.round(Math.max(20000, (mono.length / TARGET_RATE) * 4000))
        });
        if (res && res.ok) {
          return { ...res, durationMs: pcm.durationMs(mono, TARGET_RATE), engine: 'whisper' };
        }
        // null means locate() found nothing, i.e. whisper.cpp is simply not
        // installed. Saying so beats a generic failure when the user explicitly
        // selected it.
        if (res === null) {
          last = { ok: false, error: { code: 'E_STT_NO_ENGINE', message: 'whisper.cpp is not installed. Install it and set the path in Settings, or choose the Windows engine.' } };
        } else if (res.error) {
          last = { ok: false, error: res.error };
        }
      } catch (err) {
        last = { ok: false, error: { code: 'E_STT_WHISPER', message: `whisper.cpp: ${err.message}` } };
      } finally {
        cleanup(wav);
      }
      continue;
    }

    const wav = tempPath('stt', 'wav');
    try {
      fs.writeFileSync(wav, pcm.encodeWav(mono, TARGET_RATE));
      const res = await transcribeWav(wav, {
        maxSeconds: Math.round(Math.min(60, Math.max(4, mono.length / TARGET_RATE + 6))),
        durationMs: pcm.durationMs(mono, TARGET_RATE)
      });
      if (res.ok) return { ...res, durationMs: pcm.durationMs(mono, TARGET_RATE), engine: 'sapi-file' };
      last = res;
      // A missing language pack will not fix itself on the next engine.
      if (res.error && (res.error.code === 'E_STT_NO_LANGUAGE' || res.error.code === 'E_STT_PLATFORM')) return res;
    } finally {
      cleanup(wav);
    }
  }

  return last || { ok: false, error: { code: 'E_STT', message: 'Voice recognition failed.' } };
}

/* ------------------------------------------------------------------ */
/* renderer-fed capture                                                 */
/* ------------------------------------------------------------------ */

/**
 * Decode one chunk from the renderer.
 *
 * The renderer ships the samples as a Float32Array over a fire-and-forget
 * channel, and Electron's structured clone preserves the typed array, so the
 * common path costs no conversion at all. The Array and base64 branches accept
 * the same audio from a plain array or an encoded string; the buffer is copied
 * rather than wrapped in the base64 case because a byteOffset that is not a
 * multiple of four would make Float32Array reinterpret the bytes at the wrong
 * alignment.
 */
function decodeChunk(payload) {
  if (payload instanceof Float32Array) return payload;
  if (Array.isArray(payload)) return Float32Array.from(payload);
  if (payload && typeof payload.pcm === 'string') {
    const raw = Buffer.from(payload.pcm, 'base64');
    const copy = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    return new Float32Array(copy);
  }
  if (payload && Array.isArray(payload.pcm)) return Float32Array.from(payload.pcm);
  return new Float32Array(0);
}

/**
 * Open a capture session fed by renderer PCM.
 *
 * The session ends on the first completed utterance, on the time limit, or when
 * stopped. Audio is segmented by the VAD as it arrives, so nothing has to be
 * buffered twice and the recogniser only ever sees speech.
 */
function startCapture(options) {
  const opts = options || {};
  stopCapture();

  const id = `cap-${Date.now()}-${++captureSeq}`;
  const maxSeconds = Math.max(2, Math.min(60, Number(opts.maxSeconds) || 14));
  const vad = createVad({
    sampleRate: TARGET_RATE,
    // A capture started while LEGION is still speaking must not transcribe it.
    frameMs: 20,
    ...(opts.vad || {})
  });

  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });

  const rec = { id, vad, promise, settle, startedAt: Date.now(), maxSeconds, finished: false, finalizing: false, reason: null, sampleRate: 0, options: opts };

  rec.timer = setTimeout(() => {
    finish(rec, { ok: false, error: { code: 'E_STT_TIMEOUT', message: 'Voice recognition timed out.' } }, 'timeout');
  }, (maxSeconds + 10) * 1000);
  if (rec.timer.unref) rec.timer.unref();

  // A room with nobody speaking produces no speech-start and therefore no
  // speech-end, so the ceiling above is the only thing that would ever end the
  // capture. In continuous mode that leaves the microphone open for the whole
  // ceiling on every silent turn, and the mode looks stuck rather than idle.
  // Closing the turn early is what lets the renderer re-arm.
  rec.emptyTimer = setTimeout(() => {
    if (rec.vad.status().state !== 'idle') return;
    finish(rec, { ok: false, error: { code: 'E_STT_EMPTY', message: 'No speech was detected.' } }, 'empty');
  }, Math.max(1500, Number(opts.firstSpeechMs) || 6000));
  if (rec.emptyTimer.unref) rec.emptyTimer.unref();

  capture = rec;
  return { ok: true, id, sampleRate: TARGET_RATE, maxSeconds, promise };
}

function finish(rec, result, reason) {
  if (!rec || rec.finished) return;
  rec.finished = true;
  rec.reason = reason || null;
  clearTimeout(rec.timer);
  if (rec.emptyTimer) clearTimeout(rec.emptyTimer);
  if (capture && capture.id === rec.id) capture = null;
  rec.settle(result);
}

/**
 * Feed audio into the open capture.
 * Returns any state change worth telling the renderer about.
 */
async function pushCapture(id, payload, options) {
  const rec = capture;
  if (!rec || rec.id !== id || rec.finished) return { ok: false, active: false };
  if (rec.finalizing) return { ok: true, active: false, finalizing: true };
  const samples = decodeChunk(payload);
  if (!samples.length) return { ok: true, active: true };

  const opts = Object.assign({}, rec.options || {}, options || {});
  // The frame itself carries no sample rate, so it arrives alongside it. This
  // has to be read from the options first: an AudioContext commonly runs at
  // 48kHz, and mistaking that for 16kHz would resample the speech to a third of
  // its length and shift every pitch, which reads to a recogniser as noise.
  rec.sampleRate = Number(opts.sampleRate) || Number(payload && payload.sampleRate) || rec.sampleRate || TARGET_RATE;

  // Resample once here so the VAD, the recogniser and any future engine all see
  // the same clock regardless of what the AudioContext was running at.
  const mono = pcm.resample(samples, rec.sampleRate, TARGET_RATE);
  const events = rec.vad.push(mono);
  for (const ev of events) {
    if (ev.type !== 'speech-end') continue;
    rec.finalizing = true;
    let res;
    try {
      res = await transcribePcm(ev.pcm, {
        ...opts,
        engine: opts.engine || 'auto',
        sampleRate: TARGET_RATE,
        durationMs: ev.durationMs
      });
    } catch (err) {
      if (capture === rec && !rec.finished) {
        finish(rec, { ok: false, error: { code: 'E_STT', message: err.message || 'Voice recognition failed.' } }, 'error');
      }
      return { ok: false, active: false, error: { code: 'E_STT', message: err.message || 'Voice recognition failed.' } };
    }
    if (capture !== rec || rec.finished) return { ok: false, active: false, stale: true, result: res };
    finish(rec, res, 'speech');
    return { ok: true, active: false, result: res, vad: rec.vad.status() };
  }
  return { ok: true, active: true, vad: rec.vad.status() };
}

/** Suppress detection while LEGION speaks, so it cannot transcribe itself. */
function guardCapture(ms) {
  if (!capture) return 0;
  return capture.vad.setGuard(ms);
}

function stopCapture(id) {
  const rec = capture;
  if (!rec) return false;
  if (id && rec.id !== String(id)) return false;
  finish(rec, { ok: false, stopped: true, error: { code: 'E_STT_STOPPED', message: 'Capture stopped before anything was recognised.' } }, 'stopped');
  return true;
}

function captureStatus() {
  if (!capture) return { active: false };
  return { active: !capture.finished, id: capture.id, elapsedMs: Date.now() - capture.startedAt, vad: capture.vad.status() };
}

/* ------------------------------------------------------------------ */

function sweepTemp(maxAgeMs) { return sweepOrphans(maxAgeMs); }

/** Cached Whisper description, refreshed in the background rather than awaited. */
let whisperCache = null;

/**
 * Start a background Whisper probe.
 *
 * Deliberately not awaited by capabilities(): finding out whether an external
 * binary exists must never be on the path to answering a question about what
 * the app supports, and the first probe costs a process launch.
 */
function scheduleWhisperProbe(options) {
  const opts = options || {};
  whisper.probe(opts)
    .then((res) => { whisperCache = res; })
    .catch(() => { whisperCache = null; });
}

/** Report which recognisers are actually in use, and what they can and cannot do. */
function capabilities() {
  const sapi = process.platform === 'win32';
  const whisperReady = !!(whisperCache && whisperCache.available);
  return {
    platform: process.platform,
    sapi,
    // Stated plainly so the UI can explain it rather than offering a selector
    // that this particular engine would ignore.
    dictationDevice: 'system-default',
    selectableCaptureDevice: false,
    // The file engines are the opposite: they transcribe audio we captured
    // ourselves, so the browser's chosen device and its DSP do apply.
    fileCaptureDevice: 'renderer-selected',
    selectableFileCaptureDevice: true,
    engines: [
      { id: 'whisper', label: 'whisper.cpp (local)', available: whisperReady, device: whisperCache ? whisperCache.device : null, model: whisperCache ? whisperCache.model : null },
      { id: 'sapi-file', label: 'System.Speech (captured audio)', available: sapi },
      { id: 'sapi-device', label: 'System.Speech (default input)', available: sapi }
    ],
    whisper: whisper.describe(whisperCache),
    vad: createVad({ sampleRate: TARGET_RATE }).status().settings,
    note: sapi
      ? 'Whisper.cpp is used when it is installed, otherwise speech is recognised by the Windows recogniser from a 16kHz capture taken from the microphone selected in Settings, so that capture keeps its echo cancellation, noise suppression and automatic gain. The System.Speech engine that listens to the system default input device directly cannot be given a different device, because System.Speech exposes no capture-device API.'
      : 'Local dictation requires Windows.'
  };
}

module.exports = {
  listen,
  stopActive,
  isListening,
  capabilities,
  sweepTemp,
  // engine-agnostic transcription
  transcribePcm,
  transcribeWav,
  // renderer-fed capture
  startCapture,
  pushCapture,
  stopCapture,
  guardCapture,
  captureStatus,
  // lifecycle helpers
  scheduleWhisperProbe,
  TARGET_RATE,
  resetWhisperCache: () => { whisper.invalidate(); whisperCache = null; }
};