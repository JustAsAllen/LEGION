'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const voicepack = require('./voicepack');

const pExecFile = promisify(execFile);

/**
 * Text to speech via the Windows SAPI engine (System.Speech).
 *
 * Synthesis writes a real WAV file. We return the audio bytes to the renderer,
 * which plays them through Web Audio and runs the same analyser used for the
 * microphone. That means the SPEAKING state is driven by genuine voice
 * amplitude rather than a guess.
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

async function synthesize(text, opts) {
  const options = opts || {};
  const clean = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return { audio: null, empty: true };

  // A pack hit comes before the platform check on purpose: a voice pack is
  // just a file read, so it works on macOS and Linux too, where SAPI cannot run.
  const pack = await voicepack.resolve(clean).catch(() => null);
  if (pack) return pack;

  if (process.platform !== 'win32') {
    const err = new Error('Text-to-speech is only implemented for the Windows SAPI engine on this platform.');
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
    source: 'sapi'
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

module.exports = { listVoices, synthesize, voicepack };
