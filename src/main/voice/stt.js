'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Speech to text.
 *
 * Primary engine is the Windows SAPI dictation recogniser (System.Speech).
 * It runs entirely on-device, needs no API key, and is always available on
 * Windows 10/11 with an installed speech language. The renderer can also use
 * the Chromium Web Speech API; both report their real result or their real
 * failure. Nothing here fabricates a transcript.
 *
 * Push-to-talk works by spawning a recogniser that polls a stop-sentinel file,
 * so releasing the key ends capture without discarding what was already heard.
 */

let active = null;

const PS_RECOGNIZE = `
$ErrorActionPreference = 'Stop'
$stopFile = $args[0]
$maxSec  = [double]$args[1]
$deviceIndex = -1
if ($args.Length -ge 3 -and $args[2] -ne '') { $deviceIndex = [int]$args[2] }

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

if ($deviceIndex -ge 0) {
  try {
    $tts = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $engine.SetInputToAudioDevice($tts.GetInstalledVoices()[$deviceIndex].VoiceInfo)
  } catch {
    try { $engine.SetInputToDefaultAudioDevice() } catch {
      $engine.Dispose()
      [Console]::Out.Write('__LEGION_ERR__NO_DEVICE')
      exit 0
    }
  }
} else {
  try { $engine.SetInputToDefaultAudioDevice() } catch {
    $engine.Dispose()
    [Console]::Out.Write('__LEGION_ERR__NO_DEVICE')
    exit 0
  }
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

function stopSentinel() {
  return path.join(os.tmpdir(), `legion-stt-stop-${Date.now()}-${Math.random().toString(36).slice(2)}.flag`);
}

function cleanup(file) { try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch (_) { /* ignore */ } }

/**
 * Begin capture. Returns immediately; the promise settles when recognition
 * ends (silence, sentinel, or the time limit).
 */
function listen(options) {
  const opts = options || {};
  if (process.platform !== 'win32') {
    return { stop() {}, promise: Promise.resolve({ ok: false, error: { code: 'E_STT_PLATFORM', message: 'Local speech recognition is only available on Windows.' } }) };
  }
  stopActive();

  const stopFile = stopSentinel();
  const maxSeconds = Math.max(1.5, Math.min(60, Number(opts.maxSeconds) || 14));
  const deviceIndex = Number.isInteger(opts.deviceIndex) && opts.deviceIndex >= 0 ? opts.deviceIndex : -1;

  const promise = new Promise((resolve) => {
    const child = execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-Command', PS_RECOGNIZE, '--', stopFile, String(maxSeconds), String(deviceIndex)],
      { timeout: (maxSeconds + 25) * 1000, windowsHide: true, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' },
      (err, stdout) => {
        cleanup(stopFile);
        if (active && active.stopFile === stopFile) active = null;
        const out = String(stdout || '').trim();
        if (err && /killed|SIGKILL|timed out/i.test(String(err.message)) && !out) {
          resolve({ ok: false, error: { code: 'E_STT_TIMEOUT', message: 'Voice recognition timed out.' } });
          return;
        }
        if (out.startsWith('__LEGION_ERR__NO_LANGUAGE')) {
          resolve({ ok: false, error: { code: 'E_STT_NO_LANGUAGE', message: 'No speech recognition language is installed. Settings → Time & language → Speech → Install a speech language.' } });
          return;
        }
        if (out.startsWith('__LEGION_ERR__NO_ENGINE')) {
          resolve({ ok: false, error: { code: 'E_STT_NO_ENGINE', message: 'The Windows speech recogniser is unavailable on this machine.' } });
          return;
        }
        if (out.startsWith('__LEGION_ERR__NO_DEVICE')) {
          resolve({ ok: false, error: { code: 'E_STT_NO_DEVICE', message: 'Microphone unavailable. Check that an input device is connected and enabled.' } });
          return;
        }
        if (!out) {
          resolve({ ok: false, error: { code: 'E_STT_EMPTY', message: 'Voice recognition heard nothing. Try speaking closer to the microphone.' } });
          return;
        }
        resolve({ ok: true, transcript: out.replace(/\s+/g, ' ').trim() });
      }
    );
    active = { child, stopFile, startedAt: Date.now() };
  });

  return {
    stop() { stopActive(); },
    promise
  };
}

function stopActive() {
  if (!active) return false;
  const { stopFile } = active;
  try { fs.writeFileSync(stopFile, 'stop'); } catch (_) { /* ignore */ }
  // Give the recogniser a moment to flush, then make sure it dies.
  setTimeout(() => {
    if (active && active.stopFile === stopFile) {
      try { active.child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      active = null;
    }
  }, 1200).unref?.();
  return true;
}

function isListening() { return !!active; }

/** Report which recognisers Windows actually has installed. */
function capabilities() {
  return {
    platform: process.platform,
    sapi: process.platform === 'win32',
    note: process.platform === 'win32'
      ? 'Local dictation uses the Windows speech recogniser and the system default input device.'
      : 'Local dictation requires Windows.'
  };
}

module.exports = { listen, stopActive, isListening, capabilities };
