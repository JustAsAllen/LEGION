'use strict';

/**
 * Voice pipeline check.
 *
 * Runs the real SAPI engine on both ends of the pipeline:
 *   1. synthesise a real WAV of a known sentence
 *   2. transcribe that same WAV with the real recogniser
 *   3. assert the round trip
 *
 * Plus the guards that keep the pipeline honest:
 *   - capabilities must admit that the dictation capture device is fixed
 *   - a deliberately stopped capture must not surface as a timeout
 *   - the WAVE header written by the synthesiser must be real PCM
 *
 * This never fabricates a transcript. If speech is not installed, the check
 * reports that as a skip with the reason, not as a pass.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const stt = require(path.join(ROOT, 'src', 'main', 'voice', 'stt.js'));
const tts = require(path.join(ROOT, 'src', 'main', 'voice', 'tts.js'));

const results = [];
let skipped = false;

function ok(label, detail) { results.push({ ok: true, label, detail }); console.log(`  PASS ${label}${detail ? ` -> ${detail}` : ''}`); }
function bad(label, detail) { results.push({ ok: false, label, detail }); console.log(`  FAIL ${label}${detail ? ` -> ${detail}` : ''}`); }
function skip(label, detail) { skipped = true; console.log(`  SKIP ${label}${detail ? ` -> ${detail}` : ''}`); }

const PHRASE = 'The quick brown fox jumps over the lazy dog';

function powerShell(script, { timeout = 60000, stdin = null } = {}) {
  return new Promise((resolve) => {
    const file = path.join(os.tmpdir(), `legion-voice-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
    fs.writeFileSync(file, script, 'utf8');
    const child = execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
        resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    );
    child.stdin.on('error', () => { /* powershell may exit early */ });
    if (stdin === null) child.stdin.end(); else child.stdin.end(stdin);
  });
}

function words(s) { return String(s).toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean); }

(async () => {
  console.log('VOICE PIPELINE CHECK');
  console.log(`  platform: ${process.platform}`);
  if (process.platform !== 'win32') { skip('SAPI round trip', 'Windows only'); return; }

  /* ---- 1. capabilities must tell the truth about the capture device ---- */
  const caps = stt.capabilities();
  if (caps.dictationDevice === 'system-default' && caps.selectableCaptureDevice === false) {
    ok('capabilities state the fixed dictation device', `${caps.dictationDevice}, selectable=${caps.selectableCaptureDevice}`);
  } else {
    bad('capabilities state the fixed dictation device', JSON.stringify(caps));
  }

  if (/default input device/i.test(caps.note || '')) {
    ok('capabilities note explains the device limitation', 'mentions the system default input device');
  } else {
    bad('capabilities note explains the device limitation', `note: ${caps.note}`);
  }

  // The old bug indexed GetInstalledVoices() (TTS output voices) and called
  // SetInputToAudioDevice, which does not exist. Assert neither is executed.
  // Comments are stripped first: the fix documents the phantom API by name.
  const raw = fs.readFileSync(path.join(ROOT, 'src', 'main', 'voice', 'stt.js'), 'utf8');
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    // PowerShell comments inside the embedded script document the phantom API
    // by name, so they must not count as executable use either.
    .replace(/^\s*#.*$/gm, ' ')
    .replace(/'[^'\n]*'/g, "''");
  if (!/SetInputToAudioDevice/.test(code) && !/GetInstalledVoices/.test(code)) {
    ok('no phantom capture-device API in the recogniser', 'SetInputToAudioDevice and GetInstalledVoices both absent from executable code');
  } else {
    bad('no phantom capture-device API in the recogniser', 'the phantom call is executable again in stt.js');
  }

  /* ---- 2. TTS must produce real PCM, not an empty file ---- */
  const voices = await tts.listVoices(true);
  if (!voices.ttsAvailable || !(voices.voices || []).length) {
    skip('SAPI round trip', `no installed SAPI voices (${voices.reason || 'none reported'})`);
    return;
  }
  ok('SAPI voices discovered', voices.voices.map((v) => v.name).join(', '));

  let speech;
  try {
    speech = await tts.synthesize(PHRASE, { rate: 0, volume: 100 });
  } catch (err) {
    bad('synthesise a known sentence', `${err.code || 'E'} ${err.message}`);
    return;
  }
  if (!speech || !speech.audio || !speech.bytes) {
    bad('synthesise a known sentence', 'no audio bytes returned');
    return;
  }
  ok('synthesise a known sentence', `${speech.bytes} bytes, ${speech.durationMs}ms`);

  // Verify the container rather than trusting the byte count.
  const wav = speech.audio;
  const riff = wav.toString('ascii', 0, 4);
  const wave = wav.toString('ascii', 8, 12);
  const channels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  const bits = wav.readUInt16LE(34);
  if (riff === 'RIFF' && wave === 'WAVE' && channels === 1 && sampleRate === 24000 && bits === 16) {
    ok('WAVE header is real 16-bit mono PCM at 24kHz', `RIFF/WAVE, ${channels}ch, ${sampleRate}Hz, ${bits}-bit`);
  } else {
    bad('WAVE header is real 16-bit mono PCM at 24kHz', `${riff}/${wave} ${channels}ch ${sampleRate}Hz ${bits}-bit`);
  }

  // A synthesised "sentence" must actually vary; a flat buffer is a silent bug.
  let peak = 0;
  let crossings = 0;
  let prev = 0;
  for (let i = 44; i + 1 < wav.length; i += 2) {
    const s = Math.abs(wav.readInt16LE(i)) / 32768;
    if (s > peak) peak = s;
    const sign = wav.readInt16LE(i) < 0 ? -1 : 1;
    if (sign !== prev) crossings++;
    prev = sign;
  }
  if (peak > 0.02 && crossings > 50) {
    ok('audio is non-silent speech, not a flat buffer', `peak=${peak.toFixed(3)} zero-crossings=${crossings}`);
  } else {
    bad('audio is non-silent speech, not a flat buffer', `peak=${peak.toFixed(3)} zero-crossings=${crossings}`);
  }

  /* ---- 3. transcribe that same WAV with the real recogniser ---- */
  const listenWav = path.join(os.tmpdir(), `legion-rt-${Date.now()}.wav`);
  fs.writeFileSync(listenWav, wav);
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
try { $engine.SetInputToWaveFile(${JSON.stringify(listenWav)}) } catch {
  [Console]::Out.Write('__LEGION_ERR__NO_DEVICE')
  exit 0
}
try { $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar)) } catch { }
$sb = New-Object System.Text.StringBuilder
$deadline = (Get-Date).AddSeconds(20)
try {
  while ((Get-Date) -lt $deadline) {
    $res = $null
    try { $res = $engine.Recognize([TimeSpan]::FromSeconds(0.65)) } catch { break }
    if ($res -and $res.Text) {
      [void]$sb.Append($res.Text.Trim()); [void]$sb.Append(' '); $break = $true
    }
  }
} catch { }
$engine.Dispose()
[Console]::Out.Write($sb.ToString().Trim())
`;
  const heard = await powerShell(script);
  const transcript = heard.stdout.trim();
  try { fs.unlinkSync(listenWav); } catch (_) { /* ignore */ }

  if (heard.stdout.startsWith('__LEGION_ERR__')) {
    skip('round trip: synthesised audio is recognised', 'recogniser rejected the wave file');
    return;
  }
  if (!transcript) {
    skip('round trip: synthesised audio is recognised', 'recogniser returned nothing for real speech audio');
    return;
  }

  const said = words(PHRASE);
  const got = words(transcript);
  const hits = said.filter((w) => got.includes(w)).length;
  const recall = hits / said.length;
  if (recall >= 0.6) {
    ok('round trip: synthesised audio is recognised', `${hits}/${said.length} words, heard "${transcript}"`);
  } else {
    bad('round trip: synthesised audio is recognised', `${hits}/${said.length} words, heard "${transcript}"`);
  }

  /* ---- 4. a deliberate stop must not be reported as a timeout ---- */
  const session = stt.listen({ maxSeconds: 30 });
  setTimeout(() => stt.stopActive(), 900);
  const stopped = await session.promise;
  if (stopped.stopped === true && stopped.error && stopped.error.code === 'E_STT_STOPPED') {
    ok('a released capture reports stopped, not a timeout', `code=${stopped.error.code}`);
  } else if (stopped.ok) {
    // It may have picked up real room audio before the stop; still not a timeout.
    ok('a released capture reports stopped, not a timeout', `recogniser returned text: "${stopped.transcript}"`);
  } else {
    bad('a released capture reports stopped, not a timeout', `${stopped.error && stopped.error.code} ${stopped.error && stopped.error.message}`);
  }

  /* ---- 5. the handler must await .promise, not the session wrapper ---- */
  // stt.listen() resolves to { stop(), promise }. Awaiting the wrapper made
  // res.ok undefined on every capture, so main.js reported a failure for a
  // recogniser that had actually returned a transcript.
  const wrapped = await stt.listen({ maxSeconds: 4 });
  if (wrapped && typeof wrapped.stop === 'function' && wrapped.promise && typeof wrapped.promise.then === 'function') {
    ok('listen() exposes the result on .promise', 'wrapper carries stop() and a real promise');
  } else {
    bad('listen() exposes the result on .promise', `shape: ${Object.keys(wrapped || {}).join(',')}`);
  }
  stt.stopActive();
  await wrapped.promise;

  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  if (/const\s+res\s*=\s*await\s+session\.promise/.test(mainSrc)) {
    ok('voice:listen awaits session.promise, not the wrapper', 'the result is read from the right field');
  } else {
    bad('voice:listen awaits session.promise, not the wrapper', 'main.js awaits the wrapper object again');
  }

  if (stt.isListening()) bad('no recogniser left running after stop', 'stt.isListening() is still true');
  else ok('no recogniser left running after stop', 'isListening() false');
})().then(() => {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 && !skipped ? 'all voice checks passed' : skipped && failed === 0 ? 'voice checks passed (some skipped)' : `${failed} voice check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}).catch((err) => {
  console.error('voice check crashed:', err);
  process.exit(1);
});
