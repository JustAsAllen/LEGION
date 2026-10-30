'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Wake word.
 *
 * A dedicated long-lived recogniser, separate from push to talk. It runs the
 * same Windows dictation engine, but instead of ending after a phrase it keeps
 * polling and writes every phrase it hears to stdout as a line. This process
 * watches those lines for the configured wake phrase and reports a match.
 *
 * Two properties make this honest rather than decorative:
 *   1. A phrase is only ever reported because the real recogniser produced it.
 *      There is no keyword spotting, no energy threshold and no fabricated hit.
 *   2. The wake phrase is removed from the matched text and the remainder is
 *      returned as the command, so "Hey Legion what is the weather" is one
 *      utterance rather than a wake followed by a second capture.
 *
 * The recogniser binds the system default input device, the same one push to
 * talk uses. System.Speech allows only one engine on a device, so main.js
 * suspends this listener for the duration of a capture and while speaking.
 */

const READY = '__LEGION_READY__';
const HEARD = '__LEGION_HEARD__';
const ERR_PREFIX = '__LEGION_ERR__';

const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 4000;
// A listener that has stayed up this long counts as healthy, which forgives the
// restart budget. Without this, continuous mode resets the counter on every
// resume and a crash-looping listener restarts forever.
const HEALTHY_AFTER_MS = 60000;
// After a hit, ignore further phrases briefly. The recogniser polls every 600ms,
// so the tail of one utterance can produce a second match for a wake the app is
// still acting on.
const HIT_COOLDOWN_MS = 1500;
// A listener that has not reported ready by now is hung; System.Speech can
// block forever inside Recognize() and never write a line.
const READY_TIMEOUT_MS = 20000;

const PS_WAKE = `
$ErrorActionPreference = 'Stop'
$stopFile = $args[0]

Add-Type -AssemblyName System.Speech

$engine = $null
try {
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
} catch {
  [Console]::Out.WriteLine('${ERR_PREFIX}NO_ENGINE')
  exit 0
}

$recognizerInfo = $null
try { $recognizerInfo = $engine.RecognizerInfo } catch { $recognizerInfo = $null }
if (-not $recognizerInfo) {
  $engine.Dispose()
  [Console]::Out.WriteLine('${ERR_PREFIX}NO_LANGUAGE')
  exit 0
}

# Same limitation as push to talk: System.Speech exposes no capture-device
# API, only SetInputToDefaultAudioDevice.
try { $engine.SetInputToDefaultAudioDevice() } catch {
  $engine.Dispose()
  [Console]::Out.WriteLine('${ERR_PREFIX}NO_DEVICE')
  exit 0
}

try { $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar)) } catch { }

[Console]::Out.WriteLine('${READY}')

try {
  while ($true) {
    if (Test-Path -LiteralPath $stopFile) { break }
    $res = $null
    try { $res = $engine.Recognize([TimeSpan]::FromSeconds(0.6)) } catch { break }
    if ($res -and $res.Text) {
      $t = $res.Text.Trim()
      if ($t) { [Console]::Out.WriteLine('${HEARD}' + $t) }
    }
  }
} catch { }

$engine.Dispose()
`;

const ERRORS = {
  NO_ENGINE: { code: 'E_WAKE_NO_ENGINE', message: 'The Windows speech recogniser is unavailable on this machine.' },
  NO_LANGUAGE: { code: 'E_WAKE_NO_LANGUAGE', message: 'No speech recognition language is installed. Settings -> Time & language -> Speech -> Install a speech language.' },
  NO_DEVICE: { code: 'E_WAKE_NO_DEVICE', message: 'Microphone unavailable. Check that an input device is connected and enabled.' }
};

let session = null;
let desired = null;      // { phrase, onWake, onError } while the listener should run
let suspended = 0;       // capture/speech holds, so a suspend nests correctly
let restarts = 0;
let restartTimer = null;
let lastHitAt = 0;

function unlink(file) { try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch (_) { /* ignore */ } }

function clearRestart() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
}

/**
 * Locate the wake phrase in what was actually heard.
 *
 * Matching is token-based, not a regex over the raw string. A bare pattern
 * would fire on "they legion" because the letters "hey legion" are a substring
 * of it, and a `\s+` between words would be defeated by a double space. Both
 * are things a real recogniser emits. So the phrase and the utterance are split
 * into words, compared word by word, and the command is taken from the original
 * words that followed the match so the user's own wording survives.
 */
function matchWake(phrase, heard) {
  const want = String(phrase == null ? '' : phrase).trim().split(/\s+/).filter(Boolean);
  if (!want.length) return null;
  const tokens = String(heard == null ? '' : heard).trim().split(/\s+/).filter(Boolean);
  if (tokens.length < want.length) return null;

  for (let start = 0; start + want.length <= tokens.length; start++) {
    let hit = true;
    for (let i = 0; i < want.length; i++) {
      if (tokens[start + i].toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') !== want[i].toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;
    return {
      matched: tokens.slice(start, start + want.length).join(' '),
      command: tokens.slice(start + want.length).join(' ') || null
    };
  }
  return null;
}

function handleLine(line) {
  if (!session) return;
  if (line.startsWith(READY)) {
    session.ready = true;
    if (session.readyTimer) { clearTimeout(session.readyTimer); session.readyTimer = null; }
    return;
  }
  if (line.startsWith(HEARD)) {
    const heard = line.slice(HEARD.length).trim();
    if (!heard) return;
    // A suspended listener is being torn down; ignore the tail end of its audio.
    if (session.suspend) return;
    // The app is still acting on the previous hit. Firing again now would open a
    // second capture on top of the first.
    if (Date.now() - lastHitAt < HIT_COOLDOWN_MS) return;
    const hit = matchWake(desired && desired.phrase, heard);
    if (!hit) return;
    lastHitAt = Date.now();
    if (desired && typeof desired.onWake === 'function') {
      try { desired.onWake({ ...hit, heard }); } catch (err) { console.error('[wake] handler failed:', err); }
    }
    return;
  }
  if (line.startsWith(ERR_PREFIX)) {
    const key = line.slice(ERR_PREFIX.length).trim();
    const info = ERRORS[key] || { code: 'E_WAKE', message: 'The wake word listener could not start.' };
    if (desired && typeof desired.onError === 'function') {
      try { desired.onError(info); } catch (_) { /* ignore */ }
    }
    desired = null;
    teardown();
  }
}

function teardown() {
  const s = session;
  session = null;
  if (!s) return;
  if (s.readyTimer) { clearTimeout(s.readyTimer); s.readyTimer = null; }
  unlink(s.stopFile);
  unlink(s.scriptFile);
  try { s.child.stdout.removeAllListeners('data'); } catch (_) { /* ignore */ }
  try { s.child.kill('SIGKILL'); } catch (_) { /* already gone */ }
}

function spawnListener() {
  if (process.platform !== 'win32') {
    if (desired && typeof desired.onError === 'function') {
      desired.onError({ code: 'E_WAKE_PLATFORM', message: 'The wake word listener requires Windows.' });
    }
    desired = null;
    return false;
  }
  if (session) return true;
  // A pending restart must never bring the listener up while something else owns
  // the input device. System.Speech allows one engine per device, so this would
  // break the capture it collided with and neither would work.
  if (suspended > 0) return false;

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const stopFile = path.join(os.tmpdir(), `legion-wake-${stamp}.flag`);
  const scriptFile = path.join(os.tmpdir(), `legion-wake-${stamp}.ps1`);
  try {
    fs.writeFileSync(scriptFile, PS_WAKE, 'utf8');
  } catch (err) {
    unlink(stopFile);
    if (desired && typeof desired.onError === 'function') {
      desired.onError({ code: 'E_WAKE_SCRIPT', message: `Could not prepare the wake word listener: ${err.message}` });
    }
    desired = null;
    return false;
  }

  const child = spawn(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, stopFile],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  session = { child, stopFile, scriptFile, ready: false, suspend: false, buffer: '', readyTimer: null, bornAt: Date.now() };

  // A recogniser that starts the process but never becomes ready is stuck, not
  // slow, and nothing else would ever notice. Held in a local because teardown
  // clears the session out from under the timer.
  const pending = session;
  pending.readyTimer = setTimeout(() => {
    if (!pending.ready || session !== pending) return;
    if (desired && typeof desired.onError === 'function') {
      try { desired.onError({ code: 'E_WAKE_TIMEOUT', message: 'The wake word listener did not start in time.' }); } catch (_) { /* ignore */ }
    }
    teardown();
  }, READY_TIMEOUT_MS);
  if (pending.readyTimer.unref) pending.readyTimer.unref();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    const s = session;
    if (!s) return;
    s.buffer += chunk;
    // PowerShell line endings can arrive split across chunks.
    const parts = s.buffer.split(/\r?\n/);
    s.buffer = parts.pop() || '';
    for (const line of parts) handleLine(line.trim());
  });
  child.stderr.resume();

  const own = session;
  child.on('error', (err) => {
    if (desired && typeof desired.onError === 'function') {
      try { desired.onError({ code: 'E_WAKE_SPAWN', message: `Could not start the wake word listener: ${err.message}` }); } catch (_) { /* ignore */ }
    }
    desired = null;
    teardown();
  });

  child.on('exit', () => {
    // Read the flags from the child that is exiting, not from the module
    // variable: teardown() has already cleared `session`, so asking it here
    // would always answer "not suspended" and turn every intentional suspend
    // into an unexpected exit.
    const wasSuspended = own.suspend;
    const livedLongEnough = Date.now() - own.bornAt >= HEALTHY_AFTER_MS;
    teardown();
    if (!desired || wasSuspended) return;
    // The recogniser died on its own. Retry a bounded number of times, then
    // give up and say so rather than respawning forever in a tight loop.
    if (livedLongEnough) restarts = 0;
    if (restarts >= MAX_RESTARTS) {
      restarts = 0;
      if (typeof desired.onError === 'function') {
        try { desired.onError({ code: 'E_WAKE_EXIT', message: 'The wake word listener stopped unexpectedly.' }); } catch (_) { /* ignore */ }
      }
      desired = null;
      return;
    }
    restarts++;
    clearRestart();
    restartTimer = setTimeout(() => { restartTimer = null; spawnListener(); }, RESTART_DELAY_MS);
    if (restartTimer.unref) restartTimer.unref();
  });

  return true;
}

/** True when the recogniser is expected to be running right now. */
function wanted() { return !!desired && suspended === 0; }

function start(options) {
  const o = options || {};
  const phrase = String(o.phrase == null ? '' : o.phrase).trim();
  if (!phrase) return { ok: false, error: { code: 'E_WAKE_PHRASE', message: 'Set a wake phrase first.' } };
  if (process.platform !== 'win32') {
    return { ok: false, error: { code: 'E_WAKE_PLATFORM', message: 'The wake word listener requires Windows.' } };
  }
  if (desired && desired.phrase === phrase) return { ok: true, running: wanted() };
  clearRestart();
  restarts = 0;
  desired = { phrase, onWake: o.onWake, onError: o.onError };
  suspended = 0;
  const started = spawnListener();
  return started
    ? { ok: true, running: true, phrase }
    : { ok: false, error: { code: 'E_WAKE_START', message: 'The wake word listener could not be started.' } };
}

function stop() {
  clearRestart();
  restarts = 0;
  desired = null;
  suspended = 0;
  lastHitAt = 0;
  const was = !!session;
  teardown();
  return { stopped: was };
}

/**
 * Hold the listener while another component owns the input device.
 * Nested holds are counted, so releasing a capture while speech is still
 * playing does not bring the wake listener back early.
 */
function suspend() {
  suspended++;
  if (session) { session.suspend = true; teardown(); }
  return { suspended: true };
}

function resume() {
  if (suspended > 0) suspended--;
  // The restart budget is deliberately NOT reset here. Continuous mode resumes
  // after every capture and every utterance, so clearing it on resume meant a
  // listener that crashed immediately could never reach the limit and would
  // respawn for as long as the user left the app running. Only an explicit
  // start, or a child that stayed up long enough, forgives the budget.
  if (suspended === 0 && desired) spawnListener();
  return { suspended: suspended > 0, running: !!session };
}

function status() {
  return {
    supported: process.platform === 'win32',
    running: !!session,
    wanted: wanted(),
    suspended: suspended > 0,
    phrase: (desired && desired.phrase) || null
  };
}

function sweepTemp(maxAgeMs = 60 * 60 * 1000) {
  let removed = 0;
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!/^legion-wake-\d+-[a-z0-9]+\.(ps1|flag)$/.test(name)) continue;
      const full = path.join(os.tmpdir(), name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); removed++; }
      } catch (_) { /* raced with a restart; fine */ }
    }
  } catch (_) { /* temp not listable */ }
  return removed;
}

module.exports = { start, stop, suspend, resume, status, matchWake, sweepTemp };
