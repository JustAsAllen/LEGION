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
# Microphone choice is honoured on the analyser path (getUserMedia deviceId);
# dictation uses the system default input and reports so instead of pretending.
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
  const scriptFile = path.join(os.tmpdir(), `legion-stt-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);

  const promise = new Promise((resolve) => {
    // The script is written to a file and run with -File, passing the sentinel
    // and the time limit as real arguments. The previous code passed the script
    // inline as `-Command -Command SCRIPT -- sentinel seconds`, which does not
    // work: PowerShell concatenates the trailing tokens onto the end of the
    // script text, so the whole invocation died with "Missing expression after
    // unary operator '--'" and wrote nothing to stdout. Every push-to-talk
    // attempt therefore reported "Voice recognition heard nothing" and no
    // recogniser ever ran. tts.js hit the same class of problem with stdin.
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
        const out = String(stdout || '').trim();
        // Surface a broken invocation instead of letting it masquerade as a
        // quiet room. A PowerShell parse or runtime error is a real fault.
        if (err && !out && String(stderr || '').trim()) {
          const firstLine = String(stderr).split(/\r?\n/).find((l) => /\S/.test(l)) || 'unknown error';
          resolve({ ok: false, error: { code: 'E_STT_SCRIPT', message: `The speech recogniser failed to start: ${firstLine.trim()}` } });
          return;
        }
        if (err && /killed|SIGKILL|timed out/i.test(String(err.message)) && !out) {
          // A kill we asked for is a release, not a failure. Report it as an
          // empty capture so the caller clears the listening state quietly
          // instead of showing "timed out" for a deliberate push-to-talk.
          if (wasStopped) {
            resolve({ ok: false, stopped: true, error: { code: 'E_STT_STOPPED', message: 'Capture stopped before anything was recognised.' } });
            return;
          }
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
          // The recogniser can also exit cleanly with nothing recognised: it saw
          // the sentinel and stopped before any speech. That is the user's own
          // release, so it must not read as "could not hear you".
          if (wasStopped) {
            resolve({ ok: false, stopped: true, error: { code: 'E_STT_STOPPED', message: 'Capture stopped before anything was recognised.' } });
            return;
          }
          resolve({ ok: false, error: { code: 'E_STT_EMPTY', message: 'Voice recognition heard nothing. Try speaking closer to the microphone.' } });
          return;
        }
        resolve({ ok: true, transcript: out.replace(/\s+/g, ' ').trim() });
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

/** Report which recogniser is actually in use, and what it can and cannot do. */
function capabilities() {
  return {
    platform: process.platform,
    sapi: process.platform === 'win32',
    // Stated plainly so the UI can explain it rather than offering a selector
    // that the dictation engine would ignore.
    dictationDevice: 'system-default',
    selectableCaptureDevice: false,
    note: process.platform === 'win32'
      ? 'Local dictation uses the Windows speech recogniser with the system default input device. Microphone choice applies to the level meter only, because System.Speech exposes no capture-device API.'
      : 'Local dictation requires Windows.'
  };
}

module.exports = { listen, stopActive, isListening, capabilities };
