'use strict';

/**
 * Regenerate the example voice pack clips.
 *
 * The examples are synthesised with the same SAPI engine the app falls back to,
 * at the same 24 kHz mono format, so a pack clip and a synthesised reply are
 * byte-for-byte the same kind of audio. Regenerate them with:
 *
 *   npm run voicepack:sample
 *
 * A real pack replaces these files with recordings of a person; the format does
 * not change and nothing here needs to be edited.
 */

const fsp = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

const OUT_DIR = path.resolve(__dirname, '..', 'voicepack');

// Phrase -> the file name it should take in the pack.
const SAMPLES = [
  ['Yes.', 'yes.wav'],
  ['No.', 'no.wav'],
  ['On it.', 'on-it.wav'],
  ['All done.', 'all-done.wav'],
  ["I'm listening.", 'im-listening.wav'],
  ["I didn't understand that.", 'i-didnt-understand.wav']
];

const PS = (outFile) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile(${JSON.stringify(outFile)}, $format)
$synth.Speak([Console]::In.ReadToEnd())
$synth.Dispose()
`;

function synth(phrase, outFile) {
  return new Promise((resolve, reject) => {
    const scriptFile = outFile.replace(/\.wav$/, '.ps1');
    fsp.writeFile(scriptFile, PS(outFile), 'utf8').then(() => {
      const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], { windowsHide: true });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', (code) => {
        fsp.unlink(scriptFile).catch(() => {});
        if (code === 0) resolve();
        else reject(new Error(`powershell exited ${code}: ${err.trim()}`));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(phrase);
    }, reject);
  });
}

(async () => {
  if (process.platform !== 'win32') {
    console.error('The sample generator uses the Windows SAPI engine; it cannot run here.');
    process.exit(1);
  }
  await fsp.mkdir(OUT_DIR, { recursive: true });
  let bytes = 0;
  for (const [phrase, name] of SAMPLES) {
    const out = path.join(OUT_DIR, name);
    await synth(phrase, out);
    const stat = await fsp.stat(out);
    bytes += stat.size;
    console.log(`  wrote ${name.padEnd(24)} ${String(stat.size).padStart(7)} bytes  "${phrase}"`);
  }
  console.log(`\n${SAMPLES.length} clips, ${(bytes / 1024).toFixed(0)} KB total`);
})().catch((err) => {
  console.error('sample generation failed: ' + err.message);
  process.exit(1);
});
