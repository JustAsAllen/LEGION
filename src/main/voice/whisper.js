'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

/**
 * Offline STT tier: whisper.cpp, used when the user has installed it.
 *
 * FEASIBILITY, answered honestly
 * ------------------------------
 * The hardware is not the constraint. This machine reports an NVIDIA GeForce
 * RTX 5060 Laptop GPU with 8GB and driver 617.14; whisper.cpp transcribes a
 * ten-second utterance on hardware like that well inside a second, and even
 * CPU-only a `base.en` model stays interactive. So "can the RTX 5060 do local
 * Whisper" is yes.
 *
 * What is *not* practical is shipping it:
 *
 *   - whisper.cpp is a compiled C++ program, not an npm package. Adding it
 *     means a platform-specific binary plus a 75MB-1.5GB model file.
 *   - The npm alternatives are heavier, not lighter. `onnxruntime-node` pulls
 *     ~200MB of native binaries and needs a separate CUDA build to use the
 *     GPU on Windows; `@xenova/transformers` is CPU-only under Node and loads
 *     the model eagerly, which would block startup; `nodejs-whisper` requires a
 *     Python virtualenv, i.e. a second toolchain to install and keep working.
 *   - Downloading a model at runtime puts a network dependency on the input
 *     path, which this application has never had.
 *
 * So this tier follows exactly the rule the Piper tier already established: it
 * is an *optional* external engine, probed for, and absent means "fall through
 * to System.Speech", never a failure. Nothing is installed, downloaded, or
 * bundled, and startup is not blocked waiting to find out.
 *
 * A note specific to this GPU: the RTX 5060 is Blackwell, compute capability
 * sm_120. whisper.cpp release builds compiled before Blackwell shipped do not
 * contain kernels for it, and a CUDA build will silently fall back to CPU on
 * such a binary. That is why the probe actually *runs* the binary once and
 * reads back which device it chose, rather than assuming GPU support from the
 * presence of a driver. `--device` is only requested when the binary reports a
 * CUDA device, so a stale build produces correct results, just slower ones.
 */

const PROBE_DIRS = [
  // Same layout Piper uses: a development checkout path plus the packaged and
  // user-installed locations.
  path.resolve(__dirname, '..', '..', '..', 'assets', 'whisper'),
  process.resourcesPath ? path.join(process.resourcesPath, 'whisper') : '',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'whisper'),
  path.join(process.env.USERPROFILE || '', 'whisper'),
  'C:\\Program Files\\whisper.cpp',
  'C:\\whisper.cpp'
];

// whisper.cpp renamed its entry point from main.exe to whisper-cli.exe; both
// are in the wild and a stale folder usually still has the old one.
const BIN_NAMES = ['whisper-cli.exe', 'main.exe', 'whisper.exe'];

let cache = null;
let cacheKey = '';

function candidateBins() {
  const out = [];
  for (const dir of PROBE_DIRS) {
    if (!dir) continue;
    for (const name of BIN_NAMES) out.push(path.join(dir, name));
  }
  return out;
}

/** A directory is only interesting if it also holds a GGML model. */
function findModel(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_) { return null; }
  const model = entries.find((f) => f.endsWith('.bin') && /^ggml-.*\.bin$/i.test(f));
  return model ? path.join(dir, model) : null;
}

/**
 * Find a whisper.cpp executable and model, or null.
 * Explicit configuration wins over probing, as it does for Piper.
 */
function locate(opts) {
  const options = opts || {};
  const configuredBin = String(options.whisperPath || '').trim();
  const configuredModel = String(options.whisperModel || '').trim();

  if (configuredBin) {
    if (!fs.existsSync(configuredBin)) return null;
    const model = configuredModel && fs.existsSync(configuredModel)
      ? configuredModel
      : findModel(path.dirname(configuredBin));
    return model ? { bin: configuredBin, model } : null;
  }

  for (const bin of candidateBins()) {
    if (!fs.existsSync(bin)) continue;
    const model = findModel(path.dirname(bin));
    if (model) return { bin, model };
  }
  return null;
}

/**
 * Run `whisper-cli -h` once and read which devices it compiled in.
 *
 * This is the only way to learn the truth about an external binary: the file
 * existing says nothing about whether it has CUDA kernels for this GPU, or
 * even whether it runs at all on this CPU. The result is cached, so the probe
 * costs one process launch per configuration, not one per utterance.
 */
function probeDevices(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['-h'], { timeout: 12000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = `${stdout || ''}\n${stderr || ''}`;
      if (err && !text.trim()) { resolve({ ok: false, reason: 'the whisper binary did not run' }); return; }
      const cuda = /device\s*:\s*(cuda|gpu)/i.test(text) || /use_gpu|using gpu/i.test(text);
      resolve({
        ok: true,
        // whisper.cpp accepts --device CUDA / --device CPU. Absent a confirmed
        // CUDA device we ask for CPU explicitly rather than letting it guess.
        device: cuda ? 'cuda' : 'cpu',
        // The help text names the compiled device list; kept for diagnostics so
        // a Blackwell mismatch is visible instead of mysterious.
        devices: (text.match(/device\s*:\s*([^\n]+)/i) || [, ''])[1].trim().slice(0, 120) || null,
        version: (text.match(/whisper[_ -]?(?:cpp|cli)?[^\n]*?v?(\d+\.\d+\.\d+)/i) || [, null])[1]
      });
    });
  });
}

/**
 * Cached availability probe. Never throws, never blocks app startup, and
 * returns a plain reason when Whisper is absent so callers can fall through.
 */
async function probe(opts) {
  const options = opts || {};
  const key = `${options.whisperPath || ''}|${options.whisperModel || ''}`;
  if (cache && cacheKey === key) return cache;

  const found = locate(options);
  if (!found) {
    cacheKey = key;
    cache = {
      available: false,
      bin: null,
      model: null,
      device: null,
      reason: 'whisper.cpp is not installed.'
    };
    return cache;
  }

  const info = await probeDevices(found.bin);
  cacheKey = key;
  cache = {
    available: !!info.ok,
    bin: found.bin,
    model: path.basename(found.model),
    modelPath: found.model,
    device: info.ok ? info.device : null,
    devices: info.ok ? info.devices : null,
    version: info.ok ? info.version : null,
    reason: info.ok ? null : `whisper.cpp was found but could not run: ${info.reason}`
  };
  return cache;
}

/**
 * Transcribe a 16kHz mono WAV buffer.
 * Returns null when there is no local Whisper, so the caller falls through.
 */
async function transcribe(wavPath, opts) {
  const options = opts || {};
  const found = locate(options);
  if (!found) return null;

  const info = await probe(options);
  if (!info.available) return null;

  const args = [
    '-m', found.model,
    '-f', wavPath,
    '-nt',                 // no timestamps: we only need the words
    '-np',                 // no progress printing
    '-l', String(options.language || 'auto'),
    '-t', String(Math.max(2, Number(options.threads) || 4))
  ];
  // Only ask for CUDA when the binary said it has it. Passing --device CUDA to a
  // CPU-only build makes it abort, which would turn a working fallback into an
  // error, so the flag is conditional rather than optimistic.
  if (info.device === 'cuda') args.push('--device', 'CUDA');

  const started = Date.now();
  const text = await new Promise((resolve) => {
    execFile(found.bin, args, {
      timeout: Math.max(20000, Number(options.timeoutMs) || 60000),
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    }, (err, stdout, stderr) => {
      if (err && !String(stdout || '').trim()) {
        resolve({ error: String(stderr || err.message).split(/\r?\n/).find((l) => /\S/.test(l)) || 'whisper.cpp failed' });
        return;
      }
      resolve({ text: String(stdout || '') });
    });
  });

  if (text.error) {
    return { ok: false, error: { code: 'E_STT_WHISPER', message: `whisper.cpp: ${text.error}` }, device: info.device };
  }

  // whisper.cpp prefixes the utterance with timestamps even with -nt in some
  // builds, and may emit bracketed segments. Strip what is not words rather
  // than handing the recogniser's formatting to the language model.
  const clean = String(text.text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/^\s*[\d:.>-]+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) return { ok: false, empty: true, device: info.device };

  return {
    ok: true,
    transcript: clean,
    engine: 'whisper',
    model: path.basename(found.model),
    device: info.device,
    durationMs: Date.now() - started
  };
}

/** Drop the cached probe, e.g. after the user installs or repoints Whisper. */
function invalidate() {
  cache = null;
  cacheKey = '';
}

function describe(cacheValue) {
  const c = cacheValue || cache;
  return {
    tier: 'stt-local',
    available: !!(c && c.available),
    bin: c ? c.bin : null,
    model: c ? c.model : null,
    device: c ? c.device : null,
    reason: c ? c.reason : 'not probed yet'
  };
}

module.exports = { probe, transcribe, locate, describe, invalidate, os: os.tmpdir };