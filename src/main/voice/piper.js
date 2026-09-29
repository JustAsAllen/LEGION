'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

/**
 * Offline local tier: Piper.
 *
 * Piper is an optional dependency, not a bundled one -- it is a separate
 * download plus a voice model. So this tier probes for a usable install and
 * returns null when there isn't one, which lets the pipeline fall through to
 * SAPI. It must never hard-fail: on a machine without Piper this is a no-op.
 *
 * Verified behaviour on this machine: the probe correctly reports "not found"
 * and the pipeline proceeds to SAPI. The synthesis path itself is only
 * reachable once a user installs Piper and a model, so it is unverified here.
 */

const PROBE_DIRS = [
  // Development checkout: keep the runtime assets outside src/ so they can
  // be replaced without touching application code.
  path.resolve(__dirname, '..', '..', '..', 'assets', 'piper'),
  // Production: electron-builder copies this directory as an extra resource.
  process.resourcesPath ? path.join(process.resourcesPath, 'piper') : '',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'piper'),
  path.join(process.env.USERPROFILE || '', 'piper'),
  'C:\\Program Files\\Piper',
  'C:\\piper'
];

let cache = null;
let cacheKey = '';

function candidateBins() {
  const out = [];
  for (const d of PROBE_DIRS) {
    if (!d) continue;
    out.push(path.join(d, 'piper.exe'));
  }
  return out;
}

/** Find a piper executable and a .onnx model, or null. */
async function locate(opts) {
  const options = opts || {};
  const configured = String(options.piperPath || '').trim();
  const model = String(options.piperModel || '').trim();

  if (configured) {
    const bin = configured;
    if (!fs.existsSync(bin)) return null;
    if (!model || !fs.existsSync(model)) return null;
    const config = model + '.json';
    if (!fs.existsSync(config)) return null;
    return { bin, model, config };
  }

  for (const bin of candidateBins()) {
    if (!fs.existsSync(bin)) continue;
    // Prefer a model sitting next to the binary, the usual layout.
    const sibling = fs.readdirSync(path.dirname(bin)).find((f) => f.endsWith('.onnx') && fs.existsSync(path.join(path.dirname(bin), f + '.json')));
    const modelPath = sibling ? path.join(path.dirname(bin), sibling) : '';
    if (modelPath) return { bin, model: modelPath, config: modelPath + '.json' };
  }
  return null;
}

async function probe(opts) {
  const options = opts || {};
  const key = `${options.piperPath || ''}|${options.piperModel || ''}`;
  if (cache && cacheKey === key) return cache;
  const found = await locate(options);
  cacheKey = key;
  cache = {
    available: !!found,
    bin: found ? found.bin : null,
    model: found ? path.basename(found.model) : null,
    reason: found ? null : 'Piper is not installed.'
  };
  return cache;
}

/**
 * @returns {Promise<null|{audio:Buffer,format:string,sampleRate:number,source:string,tier:string}>}
 *          null means "no local Piper; use the next tier".
 */
async function synthesize(text, opts) {
  const options = opts || {};
  const clean = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;

  const found = await locate(options);
  if (!found) return null;

  const work = path.join(os.tmpdir(), 'legion-piper', `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.mkdir(work, { recursive: true }).catch(() => {});
  const outFile = path.join(work, 'out.wav');

  try {
    await new Promise((resolve, reject) => {
      const child = execFile(found.bin, ['--model', found.model, '--config', found.config, '--output_file', outFile], {
        timeout: Math.max(15000, clean.length * 200), windowsHide: true, maxBuffer: 1024 * 1024
      }, (err) => (err ? reject(new Error(`Piper failed: ${err.message}`)) : resolve()));
      child.stdin.on('error', () => { /* piper may exit before we finish writing */ });
      child.stdin.end(clean);
    });
    const stat = await fsp.stat(outFile).catch(() => null);
    if (!stat || !stat.size) return null;
    const buf = await fsp.readFile(outFile);
    return {
      audio: buf,
      format: 'wav',
      sampleRate: readWavSampleRate(buf),
      bytes: buf.length,
      source: 'piper',
      tier: 'offline',
      durationMs: 0
    };
  } catch (_) {
    return null;
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

function readWavSampleRate(buf) {
  try { return buf.length >= 28 && buf.toString('ascii', 0, 4) === 'RIFF' ? buf.readUInt32LE(24) : 0; }
  catch (_) { return 0; }
}

function describe() {
  return {
    tier: 'offline',
    available: !!(cache && cache.available),
    reason: cache ? cache.reason : 'not probed yet',
    model: cache ? cache.model : null
  };
}

module.exports = { synthesize, probe, describe, locate };
