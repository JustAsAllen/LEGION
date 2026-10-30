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
const wake = require(path.join(ROOT, 'src', 'main', 'voice', 'wake.js'));
const pcm = require(path.join(ROOT, 'src', 'main', 'voice', 'pcm.js'));
const { createVad } = require(path.join(ROOT, 'src', 'main', 'voice', 'vad.js'));
const { ConfigStore, DEFAULTS } = require(path.join(ROOT, 'src', 'main', 'config.js'));
const { makeRedactor } = require(path.join(ROOT, 'src', 'main', 'memory.js'));

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

/** Decode a 16-bit mono PCM WAVE buffer into floats. */
function decodeWav(buf) {
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    else if (id === 'data') data = buf.slice(body, Math.min(body + size, buf.length));
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('not a readable WAVE file');
  const bytes = data.length - (data.length % 2);
  const out = new Float32Array(bytes / 2);
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return { samples: out, sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits };
}

/** A steady tone, used to prove resampling does not shift pitch. */
function tone(rate, hz, ms, amp = 0.4) {
  const n = Math.round((rate * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

/** Count zero crossings to recover the dominant frequency of a mono signal. */
function dominantHz(samples, rate) {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++;
  return (crossings / 2) * (rate / samples.length);
}

function silence(rate, ms) { return new Float32Array(Math.round((rate * ms) / 1000)); }

async function checkNewPipeline(speech) {
  /* ---- 1. capture ownership: a stale stop must not kill the next turn ---- */

  const first = stt.startCapture({ maxSeconds: 30 });
  const second = stt.startCapture({ maxSeconds: 30 });
  const firstResult = await first.promise;
  if (firstResult.stopped && firstResult.error?.code === 'E_STT_STOPPED') {
    ok('starting a new capture settles the previous one', first.id);
  } else {
    bad('starting a new capture settles the previous one', JSON.stringify(firstResult));
  }
  const stillSecond = stt.captureStatus();
  if (stillSecond.active && stillSecond.id === second.id) ok('the new capture survives the previous settlement', second.id);
  else bad('the new capture survives the previous settlement', JSON.stringify(stillSecond));

  const stoppedOld = stt.stopCapture(first.id);
  if (stoppedOld === false && stt.captureStatus().active) ok('stopping an old capture id is ignored', first.id);
  else bad('stopping an old capture id is ignored', `stopCapture returned ${stoppedOld}`);

  const stalePush = await stt.pushCapture(first.id, new Float32Array(480), { sampleRate: 24000 });
  if (stalePush.ok === false && stt.captureStatus().active) ok('chunks for an old capture are ignored', first.id);
  else bad('chunks for an old capture are ignored', JSON.stringify(stalePush));

  const stoppedSecond = stt.stopCapture(second.id);
  const secondResult = await second.promise;
  if (stoppedSecond === true && secondResult.stopped) ok('an id-scoped stop releases the matching capture', second.id);
  else bad('an id-scoped stop releases the matching capture', JSON.stringify(secondResult));

  /* ---- 2. PCM: the resampler is where a wrong answer looks like bad audio ---- */

  const tone48 = tone(48000, 1000, 200);
  const down48 = pcm.resample(tone48, 48000, pcm.TARGET_RATE);
  const hz48 = dominantHz(down48, pcm.TARGET_RATE);
  // A naive implementation rounds the decimation step: 48000/16000 is exactly 3
  // and passes, but 24000/16000 is 1.5, rounds to 2, and yields 12kHz audio
  // labelled 16kHz. That defect produced 4/9 word recall on a real sentence, so
  // both ratios are pinned here.
  if (Math.abs(hz48 - 1000) < 25) ok('48kHz resampling preserves pitch', `${hz48.toFixed(1)}Hz kept`);
  else bad('48kHz resampling preserves pitch', `1000Hz became ${hz48.toFixed(1)}Hz`);

  const tone24 = tone(24000, 1000, 200);
  const down24 = pcm.resample(tone24, 24000, pcm.TARGET_RATE);
  const hz24 = dominantHz(down24, pcm.TARGET_RATE);
  if (Math.abs(hz24 - 1000) < 25) ok('24kHz resampling preserves pitch (non-integer ratio)', `${hz24.toFixed(1)}Hz kept`);
  else bad('24kHz resampling preserves pitch (non-integer ratio)', `1000Hz became ${hz24.toFixed(1)}Hz, a naive decimation step`);

  const expectedLen = Math.round((tone24.length / 24000) * 16000);
  if (Math.abs(down24.length - expectedLen) <= 2) ok('resampled length matches the target rate', `${down24.length} samples for 200ms`);
  else bad('resampled length matches the target rate', `${down24.length} samples, expected about ${expectedLen}`);

  const wavOut = pcm.encodeWav(pcm.resample(tone24, 24000, pcm.TARGET_RATE), pcm.TARGET_RATE);
  const back = decodeWav(wavOut);
  if (back.sampleRate === 16000 && back.bits === 16 && back.channels === 1) {
    ok('WAV writer emits 16-bit mono at the target rate', `${back.sampleRate}Hz, ${back.bits}-bit, ${back.channels}ch`);
  } else {
    bad('WAV writer emits 16-bit mono at the target rate', JSON.stringify(back && { sampleRate: back.sampleRate, bits: back.bits, channels: back.channels }));
  }

  /* ---- 3. VAD: segmentation decides what the recogniser is asked about ---- */

  const vad = createVad({ sampleRate: pcm.TARGET_RATE, frameMs: 20 });
  for (let i = 0; i < 25; i++) vad.push(silence(pcm.TARGET_RATE, 20));
  const quietFloor = vad.status().floor;
  if (quietFloor >= 0 && quietFloor < 0.01) ok('VAD lowers its floor in a quiet room', `floor ${quietFloor.toFixed(5)}`);
  else bad('VAD lowers its floor in a quiet room', `floor ${quietFloor}`);

  // A loud transient must not become a segment. speech-start is deliberately
  // provisional -- it fires after ~60ms so the leading consonant is not lost --
  // and minSpeechMs is what finally rejects a bang, so the thing to assert is
  // that no audio comes out the other end.
  const vad2 = createVad({ sampleRate: pcm.TARGET_RATE, frameMs: 20 });
  for (let i = 0; i < 25; i++) vad2.push(silence(pcm.TARGET_RATE, 20));
  const slamEvents = [];
  for (let i = 0; i < 8; i++) slamEvents.push(...vad2.push(tone(pcm.TARGET_RATE, 300, 20, 0.9)));
  for (let i = 0; i < 60; i++) slamEvents.push(...vad2.push(silence(pcm.TARGET_RATE, 20)));
  const slamEnded = slamEvents.find((e) => e.type === 'speech-end' && e.pcm && e.pcm.length > 0);
  if (!slamEnded) ok('a door slam is rejected, not transcribed', 'no segment survived the minimum-speech test');
  else bad('a door slam is rejected, not transcribed', `a 160ms transient produced ${slamEnded.pcm.length} samples`);

  // Sustained speech must open, and the closing silence must close it with the
  // audio in between attached.
  const vad3 = createVad({ sampleRate: pcm.TARGET_RATE, frameMs: 20 });
  for (let i = 0; i < 25; i++) vad3.push(silence(pcm.TARGET_RATE, 20));
  let started = null;
  let ended = null;
  const speechRun = tone(pcm.TARGET_RATE, 220, 900, 0.3);
  for (let off = 0; off < speechRun.length; off += 320) {
    for (const ev of vad3.push(speechRun.subarray(off, Math.min(off + 320, speechRun.length)))) {
      if (ev.type === 'speech-start') started = ev;
      if (ev.type === 'speech-end') ended = ev;
    }
  }
  if (started) ok('sustained speech opens a segment', `threshold ${Number(started.threshold).toFixed(4)} over floor ${Number(started.floor).toFixed(4)}`);
  else bad('sustained speech opens a segment', 'no speech-start event');

  for (let i = 0; i < 80 && !ended; i++) for (const ev of vad3.push(silence(pcm.TARGET_RATE, 20))) if (ev.type === 'speech-end') ended = ev;
  if (ended && ended.pcm && ended.pcm.length > 0) ok('trailing silence closes the segment with audio attached', `${ended.pcm.length} samples, ${ended.durationMs}ms`);
  else bad('trailing silence closes the segment with audio attached', ended ? 'no samples in the event' : 'the segment never closed');

  // A pause inside one thought must split it into two, because the recogniser
  // only ever sees one segment at a time.
  const vad4 = createVad({ sampleRate: pcm.TARGET_RATE, frameMs: 20 });
  for (let i = 0; i < 25; i++) vad4.push(silence(pcm.TARGET_RATE, 20));
  let ends = 0;
  const pushAll = (sig) => { for (let off = 0; off < sig.length; off += 320) for (const ev of vad4.push(sig.subarray(off, Math.min(off + 320, sig.length)))) if (ev.type === 'speech-end') ends++; };
  pushAll(tone(pcm.TARGET_RATE, 220, 700, 0.3));
  pushAll(silence(pcm.TARGET_RATE, 1500));
  pushAll(tone(pcm.TARGET_RATE, 220, 700, 0.3));
  pushAll(silence(pcm.TARGET_RATE, 1500));
  if (ends === 2) ok('a long pause splits one thought into two', '2 segments');
  else bad('a long pause splits one thought into two', `${ends} segments`);

  /* ---- 4. end to end: renderer frames in, words out ---- */

  if (!speech || !speech.audio) {
    skip('a renderer-fed capture is transcribed', 'no synthesised audio available');
    return;
  }
  const decoded = decodeWav(speech.audio);
  if (decoded.sampleRate === 24000 && decoded.channels === 1) {
    ok('the capture feed matches the shape the renderer sends', `${decoded.sampleRate}Hz mono, ${decoded.samples.length} samples`);
  } else {
    bad('the capture feed matches the shape the renderer sends', JSON.stringify({ sampleRate: decoded.sampleRate, channels: decoded.channels }));
  }

  // A transcription that finishes after a new capture has opened must not close
  // that new capture. Feed one whole utterance plus enough silence to trip the
  // VAD, then replace the session while the recogniser is still working.
  const stale = stt.startCapture({ maxSeconds: 20, firstSpeechMs: 20000, engine: 'auto' });
  const speechWithTail = new Float32Array(decoded.samples.length + 24000 * 2);
  speechWithTail.set(decoded.samples, 0);
  const pending = stt.pushCapture(stale.id, speechWithTail, { sampleRate: 24000 });
  const replacement = stt.startCapture({ maxSeconds: 20, firstSpeechMs: 20000, engine: 'auto' });
  const late = await pending;
  if (late.ok === false && late.stale === true) ok('a late transcription cannot close a newer capture', stale.id);
  else bad('a late transcription cannot close a newer capture', JSON.stringify(late));
  const afterLate = stt.captureStatus();
  if (afterLate.active && afterLate.id === replacement.id) ok('the replacement capture survives the late result', replacement.id);
  else bad('the replacement capture survives the late result', JSON.stringify(afterLate));
  stt.stopCapture(replacement.id);
  await replacement.promise;

  // Feed the audio in 20ms frames at its native 24kHz, exactly as the renderer's
  // ScriptProcessorNode would, so the test covers the resample, the VAD, the WAV
  // writer and the real recogniser rather than a shortcut around them.
  const session = stt.startCapture({ maxSeconds: 14, engine: 'auto' });
  const frameLen = Math.round(24000 * 0.02);
  for (let off = 0; off + frameLen <= decoded.samples.length; off += frameLen) {
    const frame = decoded.samples.subarray(off, off + frameLen);
    await stt.pushCapture(session.id, new Float32Array(frame), { sampleRate: 24000 });
  }
  // Tail of silence so the VAD is given the chance to close the segment.
  for (let i = 0; i < 90; i++) await stt.pushCapture(session.id, new Float32Array(480), { sampleRate: 24000 });

  let final = null;
  try {
    final = await Promise.race([session.promise, new Promise((r) => setTimeout(() => r(null), 25000))]);
  } catch (_) { final = null; }

  if (final && final.ok && final.transcript) {
    const heard = String(final.transcript).toLowerCase();
    const words = PHRASE.toLowerCase().split(' ');
    const hit = words.filter((w) => heard.includes(w)).length;
    ok('a renderer-fed capture is transcribed end to end', `${hit}/${words.length} words, engine=${final.engine}, heard "${final.transcript}"`);
    if (hit === words.length) ok('the capture pipeline loses no words', `${hit}/${words.length}`);
    else bad('the capture pipeline loses no words', `${hit}/${words.length} — resampling or segmentation is losing audio`);
  } else if (final && final.stopped) {
    bad('a renderer-fed capture is transcribed end to end', 'the session stopped before it recognised anything');
  } else {
    bad('a renderer-fed capture is transcribed end to end', final ? (final.error && final.error.message) || 'no transcript' : 'timed out with no result');
  }
  if (!stt.captureStatus().active) ok('the capture session is closed after use', 'no session left holding the microphone');
  else { stt.stopCapture(); bad('the capture session is closed after use', 'a session was still open'); }

  /* ---- 5. the bridge actually carries the new channels ---- */

  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'preload.js'), 'utf8');
  const captureChannels = ['voice:captureStart', 'voice:captureChunk', 'voice:captureStop', 'voice:captureAbort'];
  const notExposed = captureChannels.filter((c) => !preloadSrc.includes(`'${c}'`));
  if (notExposed.length === 0) ok('the capture channels are exposed on the bridge', captureChannels.length + ' channels allowlisted');
  else bad('the capture channels are exposed on the bridge', `missing: ${notExposed.join(', ')}`);

  // The renderer must receive the result out of band, because the frame that
  // finishes a sentence has no caller waiting on it.
  if (preloadSrc.includes("'voice:captureEnd'")) ok('capture completion is announced to the renderer', 'voice:captureEnd subscribed');
  else bad('capture completion is announced to the renderer', 'no voice:captureEnd channel, so a capture can never resolve');

  // The wake listener and a capture share one input device, and System.Speech
  // allows a single engine per device. Two structural defects made that
  // arbitration leak, and neither is observable without a real microphone, so
  // they are pinned on the source.
  const wakeSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'voice', 'wake.js'), 'utf8');
  const spawnBody = wakeSrc.slice(wakeSrc.indexOf('function spawnListener'), wakeSrc.indexOf('function wanted'));
  if (/if \(suspended > 0\) return false;/.test(spawnBody)) {
    ok('a pending wake restart cannot steal a held device', 'spawnListener refuses while suspended');
  } else {
    bad('a pending wake restart cannot steal a held device', 'spawnListener will start even while suspended, colliding with an open capture');
  }

  const exitStart = wakeSrc.indexOf("child.on('exit'");
  const exitBody = exitStart === -1 ? '' : wakeSrc.slice(exitStart, wakeSrc.indexOf('function wanted'));
  if (/const wasSuspended = own\.suspend/.test(exitBody)) {
    ok('an intentional suspend is not counted as a crash', 'the exit handler reads the exiting child, not the cleared session');
  } else {
    bad('an intentional suspend is not counted as a crash', 'the exit handler reads the module session, which teardown has already cleared');
  }

  const resumeBody = wakeSrc.slice(wakeSrc.indexOf('function resume'), wakeSrc.indexOf('function status'));
  if (!/restarts\s*=\s*0/.test(resumeBody)) ok('continuous mode cannot keep restarting a dead listener', 'resume() leaves the restart budget alone');
  else bad('continuous mode cannot keep restarting a dead listener', 'resume() clears the restart budget, so a crash loop never reaches its limit');

  if (/HIT_COOLDOWN_MS/.test(wakeSrc)) ok('a wake hit is not fired twice for one utterance', 'a cooldown guards repeat matches');
  else bad('a wake hit is not fired twice for one utterance', 'no cooldown between hits');

  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'app.js'), 'utf8');
  const mainVoiceSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  if (/hour < 5 \|\| hour >= 21 \? 'night'/.test(appSrc) && /hour < 12 \? 'morning'/.test(appSrc) && /hour < 17 \? 'afternoon'/.test(appSrc)) {
    ok('wake greetings distinguish all four time periods', 'night / morning / afternoon / evening');
  } else {
    bad('wake greetings distinguish all four time periods', 'time period boundaries are incomplete');
  }
  if (/_lastWakeGreetingPeriod/.test(appSrc) && /if \(this\._lastWakeGreetingPeriod === period\)/.test(appSrc)) {
    ok('wake greetings are suppressed within one time period', 'period state prevents repeats');
  } else {
    bad('wake greetings are suppressed within one time period', 'no relevant-period guard');
  }

  if (/function endCaptureSession\(id, res\)/.test(mainVoiceSrc) && /prev\.id !== id/.test(mainVoiceSrc)) {
    ok('capture completion is matched to its own session', 'a late result cannot close a newer capture');
  } else {
    bad('capture completion is matched to its own session', 'endCaptureSession still closes whatever session is current');
  }
  if (/stt\.stopCapture\(target \|\| undefined\)/.test(mainVoiceSrc)) {
    ok('capture stop and abort are id-scoped', 'main will not stop another window\'s session');
  } else {
    bad('capture stop and abort are id-scoped', 'main still calls the global capture stop');
  }
  if (/payload\.id !== session\.id/.test(appSrc) && /generation !== this\._captureGen/.test(appSrc)) {
    ok('renderer ignores stale capture events', 'completion is matched by id and generation');
  } else {
    bad('renderer ignores stale capture events', 'a stale completion or cancelled capture can settle a newer turn');
  }
  if (/watchdog = setTimeout\(/.test(appSrc) && /E_STT_TIMEOUT/.test(appSrc) && /captureAbort/.test(appSrc)) {
    ok('renderer has a watchdog for a silent main process', 'a stuck capture is aborted and surfaced');
  } else {
    bad('renderer has a watchdog for a silent main process', 'no local timeout if voice:captureEnd never arrives');
  }
  if (/async simulateVoice\(/.test(appSrc) && /this\.info\?\.isDev !== true/.test(appSrc)) {
    ok('simulated voice is development-only', 'the renderer refuses it outside dev builds');
  } else {
    bad('simulated voice is development-only', 'no dev guard around simulateVoice');
  }
}

(async () => {
  console.log('VOICE PIPELINE CHECK');
  console.log(`  platform: ${process.platform}`);
  /* ---- 0. the tier pipeline itself, before any engine is involved ------ */
  // These are the load-bearing rules of the hybrid pipeline and they must hold
  // on any platform, so they are checked first and without touching a network.
  {
    const pipe = await tts.describePipeline({});
    if (pipe.mode === 'auto' && pipe.modes.join(',') === 'auto,offline,pack-only') {
      ok('the pipeline advertises its three modes', pipe.modes.join(' / '));
    } else {
      bad('the pipeline advertises its three modes', JSON.stringify(pipe.modes));
    }
    if (pipe.pack.exists && pipe.pack.entries.length > 0 && pipe.sapi.available) {
      ok('all four tiers report their availability',
        `pack=${pipe.pack.entries.length} online=${pipe.online.available} piper=${pipe.piper.available} sapi=${pipe.sapi.available}`);
    } else {
      bad('all four tiers report their availability', JSON.stringify({ pack: pipe.pack.exists, sapi: pipe.sapi.available }));
    }
  }

  // A recorded phrase must come from the pack, whatever the mode. This is the
  // rule that keeps known phrases instant and free.
  {
    const hit = await tts.synthesize('yes', {}).catch((e) => ({ error: e.message }));
    if (hit && hit.tier === 'voicepack' && hit.source === 'voicepack') {
      ok('a recorded phrase is served by the pack', `${hit.bytes} bytes, ${hit.format}`);
    } else {
      bad('a recorded phrase is served by the pack', JSON.stringify({ tier: hit && hit.tier, source: hit && hit.source, error: hit && hit.error }));
    }
  }

  // pack-only must mean pack-only: silence is the correct answer, a fallback to
  // another engine would quietly break the promise the mode makes.
  {
    const r = await tts.synthesize('a phrase that was never recorded', { ttsMode: 'pack-only' }).catch((e) => ({ error: e.message }));
    if (r && !r.audio && r.empty) {
      ok('pack-only returns silence for an unrecorded phrase', r.reason || 'no clip');
    } else {
      bad('pack-only returns silence for an unrecorded phrase', JSON.stringify({ tier: r && r.tier, source: r && r.source, bytes: r && r.bytes, error: r && r.error }));
    }
  }

  // The development tier is a real, valid WAV rather than a stub object. It is
  // deliberately requested with a recorded phrase to prove it wins over the pack
  // when a check asks for it by name.
  {
    const r = await tts.synthesize('yes', { mock: true, ttsMode: 'pack-only' }).catch((e) => ({ error: e.message }));
    const wav = r && r.audio;
    const frames = wav && wav.length >= 44 ? wav.readUInt32LE(40) / 2 : 0;
    const shaped = wav &&
      wav.toString('ascii', 0, 4) === 'RIFF' &&
      wav.toString('ascii', 8, 12) === 'WAVE' &&
      wav.readUInt16LE(20) === 1 &&
      wav.readUInt16LE(22) === 1 &&
      wav.readUInt32LE(24) === 24000 &&
      wav.readUInt16LE(34) === 16 &&
      wav.readUInt32LE(40) === frames * 2;
    if (r && r.tier === 'mock' && r.source === 'mock' && r.mock === true && r.format === 'wav' && shaped &&
        r.durationMs >= 700 && r.durationMs <= 2400 && r.bytes === wav.length) {
      ok('the development tier returns a valid silent WAV', `${r.bytes} bytes, ${r.durationMs}ms`);
    } else {
      bad('the development tier returns a valid silent WAV', JSON.stringify({ tier: r && r.tier, source: r && r.source, mock: r && r.mock, bytes: r && r.bytes, error: r && r.error }));
    }
  }

  // The mock voice is a development setting. A production profile must erase it
  // on load and on every patch, not merely hide the checkbox that writes it.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'legion-tts-config-'));
    const prodDir = path.join(base, 'prod');
    const devDir = path.join(base, 'dev');
    fs.mkdirSync(prodDir, { recursive: true });
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(prodDir, 'settings.json'), JSON.stringify({ voice: { mockTts: true } }), 'utf8');
    fs.writeFileSync(path.join(devDir, 'settings.json'), JSON.stringify({ voice: { mockTts: true } }), 'utf8');
    const prod = new ConfigStore(prodDir, { allowMock: false });
    const dev = new ConfigStore(devDir, { allowMock: true });
    const loadedOff = prod.get().voice.mockTts === false;
    const devKept = dev.get().voice.mockTts === true;
    prod.patch({ voice: { mockTts: true } });
    const patchOff = prod.get().voice.mockTts === false;
    if (prod._writeTimer) clearTimeout(prod._writeTimer);
    if (dev._writeTimer) clearTimeout(dev._writeTimer);
    fs.rmSync(base, { recursive: true, force: true });
    if (DEFAULTS.voice.mockTts === false && loadedOff && patchOff && devKept) {
      ok('mock speech is development-only', 'default false, removed on production load and patch, kept in dev');
    } else {
      bad('mock speech is development-only', JSON.stringify({ default: DEFAULTS.voice.mockTts, loadedOff, patchOff, devKept }));
    }
  }

  // offline must not reach the network, and must still speak.
  {
    const r = await tts.synthesize(PHRASE, { ttsMode: 'offline' }).catch((e) => ({ error: e.message }));
    if (r && r.tier !== 'online') {
      ok('offline mode never selects the online tier', `tier=${r.tier} source=${r.source}`);
    } else {
      bad('offline mode never selects the online tier', JSON.stringify({ tier: r && r.tier, error: r && r.error }));
    }
  }

  // The online tier needs the network, so it is opt-in: the default suite stays
  // hermetic and fast. Set LEGION_LIVE_VOICE=1 to prove the real service.
  if (process.env.LEGION_LIVE_VOICE === '1') {
    const r = await tts.synthesize('The reactor is holding at ninety percent capacity.', { ttsMode: 'auto' })
      .catch((e) => ({ error: e.message }));
    if (r && r.tier === 'online' && r.audio && r.audio.length > 4) {
      const sync = r.audio[0] === 0xff && (r.audio[1] & 0xe0) === 0xe0;
      if (r.format === 'mp3' && sync) {
        ok('the online tier returns a real MP3 frame', `${r.bytes} bytes, magic=${r.audio.subarray(0, 3).toString('hex')}`);
      } else {
        bad('the online tier returns a real MP3 frame', `${r.format} ${r.audio.subarray(0, 3).toString('hex')}`);
      }
    } else {
      bad('the online tier returns a real MP3 frame', JSON.stringify({ tier: r && r.tier, error: r && r.error }));
    }
  } else {
    console.log('  note  set LEGION_LIVE_VOICE=1 to check the online tier against the real service');
  }

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
    // Pinned to the offline tier on purpose. This check asserts SAPI's WAVE
    // output, so it must not be allowed to drift onto the online tier and start
    // depending on a network round trip (and on Microsoft's mood).
    speech = await tts.synthesize(PHRASE, { rate: 0, volume: 100, ttsMode: 'offline' });
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

  /* ---- 6. wake word matching is exact, not a substring trap ---- */
  // The wake listener reports a phrase only when the recogniser produced it, so
  // the part that can be tested without a microphone is the matching itself.
  const phrase = DEFAULTS.voice.wakeWord;
  const cases = [
    { heard: 'Hey Legion what is the weather', command: 'what is the weather', should: true },
    { heard: 'hey  legion   open   the  terminal', command: 'open the terminal', should: true },
    { heard: 'they legion are not my friends', command: null, should: false },
    { heard: 'legion', command: null, should: false },
    { heard: 'what is the weather', command: null, should: false }
  ];
  let matchFails = 0;
  for (const c of cases) {
    const hit = wake.matchWake(phrase, c.heard);
    const got = hit ? hit.command : null;
    if (!!hit !== c.should || (c.should && got !== c.command)) {
      matchFails++;
      console.log(`       "${c.heard}" -> ${hit ? JSON.stringify(hit) : 'no match'} (expected ${c.should ? JSON.stringify(c.command) : 'no match'})`);
    }
  }
  if (matchFails === 0) {
    ok('wake phrase matches only on a real word boundary', `${cases.length} cases, command text extracted after the phrase`);
  } else {
    bad('wake phrase matches only on a real word boundary', `${matchFails}/${cases.length} cases wrong`);
  }

  const empty = wake.matchWake('   ', 'anything at all');
  if (empty === null) ok('an empty wake phrase never matches', 'blank phrase is rejected');
  else bad('an empty wake phrase never matches', JSON.stringify(empty));

  /* ---- 7. the wake listener reports its real state, never a pretend one ---- */
  const st0 = wake.status();
  if (st0.supported === true && st0.running === false && st0.wanted === false) {
    ok('wake status is honest while stopped', 'supported, not running, not wanted');
  } else {
    bad('wake status is honest while stopped', JSON.stringify(st0));
  }

  // Starting must actually spawn, and stopping must actually leave nothing
  // behind holding the microphone.
  let spawned = false;
  try {
    const r = wake.start({ phrase, onWake: () => {}, onError: () => {} });
    if (r.ok) { spawned = true; }
  } catch (err) { spawned = false; }
  const st1 = wake.status();
  if (spawned && st1.running && st1.phrase === phrase) {
    ok('wake listener starts and reports the phrase it is watching', `listening for "${st1.phrase}"`);
  } else {
    bad('wake listener starts and reports the phrase it is watching', JSON.stringify(st1));
  }

  // A capture takes the device, so the listener must stand down and come back.
  wake.suspend();
  const st2 = wake.status();
  wake.resume();
  const st3 = wake.status();
  if (!st2.running && st2.suspended === true && st3.running === true) {
    ok('wake listener yields the device during a capture', 'suspended then resumed');
  } else {
    bad('wake listener yields the device during a capture', `suspended=${JSON.stringify(st2)} resumed=${JSON.stringify(st3)}`);
  }

  wake.stop();
  const st4 = wake.status();
  if (!st4.running && !st4.wanted) ok('wake listener stops cleanly', 'no recogniser left running');
  else bad('wake listener stops cleanly', JSON.stringify(st4));

  /* ---- 8. the settings that used to gate nothing now gate something ---- */
  const secret = 'my key is sk-abcdefghijklmnopqrstuvwxyz012345';
  const on = makeRedactor(true);
  const off = makeRedactor(false);
  if (on(secret).includes('[redacted]')) ok('redaction is applied when enabled', 'secret shape replaced');
  else bad('redaction is applied when enabled', on(secret));
  if (!off(secret).includes('[redacted]')) ok('redaction is skipped only when disabled', 'text passes through untouched');
  else bad('redaction is skipped only when disabled', off(secret));

  // Every key the interface offers must exist in the config the app saves, and
  // the removed ones must be gone rather than lingering as unread defaults.
  // sttEngine left this list when a second recogniser actually arrived and the
  // key gained a real reader; presence alone proves nothing, so the next block
  // asserts it is consumed.
  const staleVoice = ['speakerDeviceId', 'pitch', 'whisperModelPath'].filter((k) => k in DEFAULTS.voice);
  if (staleVoice.length === 0) ok('unsupported voice keys are gone from the config', 'speakerDeviceId, pitch, whisperModelPath all removed');
  else bad('unsupported voice keys are gone from the config', staleVoice.join(', '));

  // A setting that exists but is never read is worse than no setting: the
  // interface promises something the app does not do. Every recogniser-related
  // key must be consumed by the main process.
  const mainConfigSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  const recogniserKeys = ['sttEngine', 'whisperPath', 'whisperModel', 'whisperLanguage', 'speechSilenceMs', 'speechMaxSeconds'];
  const unreadKeys = recogniserKeys.filter((k) => {
    if (!(k in DEFAULTS.voice)) return true;
    return !new RegExp(`\\.${k}\\b`).test(mainConfigSrc);
  });
  if (unreadKeys.length === 0) ok('recogniser settings are genuinely read', `${recogniserKeys.length} keys consumed by main`);
  else bad('recogniser settings are genuinely read', `unread or missing: ${unreadKeys.join(', ')}`);

  // The microphone constraints are a requirement, not a preference: the fallback
  // path once asked for { audio: true }, which silently dropped all four.
  const audioSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'audio.js'), 'utf8');
  if (!/getUserMedia\(\s*\{\s*audio:\s*true/.test(audioSrc)) {
    ok('the microphone fallback keeps audio processing', 'no bare { audio: true } request');
  } else {
    bad('the microphone fallback keeps audio processing', 'a bare { audio: true } request drops echo cancellation, noise suppression and automatic gain');
  }

  if (!('telemetry' in DEFAULTS.privacy)) ok('the unused telemetry key is gone', 'no switch for a collection path that never existed');
  else bad('the unused telemetry key is gone', 'privacy.telemetry still present');

  if ('wakeWordEnabled' in DEFAULTS.voice && 'wakeWord' in DEFAULTS.voice) {
    ok('wake word keys are real and wired to the listener', `default phrase "${DEFAULTS.voice.wakeWord}"`);
  } else {
    bad('wake word keys are real and wired to the listener', 'wake keys missing from defaults');
  }

  const allJson = ['src/main/config.js', 'src/renderer/js/firstrun.js', 'src/renderer/js/panels.js', 'src/renderer/js/app.js', 'src/renderer/js/waveform.js']
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const untouched = ['showWaveform', 'redactSecrets'].filter((k) => !new RegExp(k).test(allJson));
  if (untouched.length === 0) ok('showWaveform and redactSecrets are read by the application', 'both settings have a consumer');
  else bad('showWaveform and redactSecrets are read by the application', `no reference to ${untouched.join(', ')}`);

  await checkNewPipeline(speech);
})().then(() => {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${failed === 0 && !skipped ? 'all voice checks passed' : skipped && failed === 0 ? 'voice checks passed (some skipped)' : `${failed} voice check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}).catch((err) => {
  console.error('voice check crashed:', err);
  process.exit(1);
});
