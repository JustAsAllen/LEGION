'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * Custom voice packs.
 *
 * A voice pack is a folder of prerecorded clips plus a manifest that maps a
 * phrase to a file. Before falling back to the system SAPI engine, synthesize()
 * asks this module whether the exact phrase has a clip; if it does, the recorded
 * audio is returned instead of freshly synthesised speech.
 *
 * Matching is exact on a normalised phrase. There is deliberately no catch-all
 * or wildcard entry: playing one clip for text it does not match would show the
 * user one sentence while the app claims another, which is worse than not
 * having a pack at all. Anything unmatched goes to SAPI.
 */

const AUDIO_EXT = new Set(['.wav', '.mp3']);
const MANIFEST = 'manifest.json';
const MANIFEST_MAX_BYTES = 512 * 1024;

const state = {
  root: null,
  loaded: false,
  manifest: null,
  mtimeMs: 0,
  entries: new Map(), // normalised phrase -> { file, format }
  problems: []
};

/**
 * Where the pack lives.
 *
 * Two layouts have to work. Running from source, the pack sits beside the repo
 * root, one level above src/. Installed, the identical copy is bundled inside
 * the asar at the same relative spot -- but a user who wants their own voice
 * drops a folder beside the exe, which is where they can actually edit it
 * without repackaging. So packaged builds prefer that external folder and fall
 * back to the read-only one inside the asar.
 */
function root() {
  if (state.root) return state.root;
  const bundled = path.resolve(__dirname, '..', '..', '..', 'voicepack');
  if (process.resourcesPath) {
    const external = path.join(process.resourcesPath, 'voicepack');
    if (fs.existsSync(path.join(external, MANIFEST))) {
      state.root = external;
      return state.root;
    }
  }
  state.root = bundled;
  return state.root;
}

/**
 * Fold a phrase to its lookup key: lowercase, punctuation removed, whitespace
 * collapsed. "Yes!" and " yes " both become "yes".
 */
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The filename a phrase would use if it had no manifest entry. */
function slug(text) {
  return normalise(text).replace(/'/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');
}

/**
 * Keep the resolved path inside the pack. A manifest is user-supplied data, so
 * "../secrets.wav" or an absolute path must not escape the folder.
 */
function safeJoin(dir, relative) {
  const target = path.resolve(dir, String(relative || ''));
  const base = path.resolve(dir);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

/** Cheap sanity check so a stray text file is not handed to decodeAudioData. */
function looksLikeAudio(buf, ext) {
  if (!buf || buf.length < 12) return false;
  if (ext === '.wav') return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
  // ID3 tag, or the first MPEG frame sync.
  if (buf.toString('ascii', 0, 3) === 'ID3') return true;
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
}

/** Exact WAV metadata. Returns null for anything else rather than guessing. */
function wavInfo(buf) {
  if (!looksLikeAudio(buf, '.wav') || buf.length < 44) return null;
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const byteRate = buf.readUInt32LE(28);
  if (!sampleRate || !byteRate) return null;
  return {
    format: 'wav',
    sampleRate,
    channels,
    durationMs: Math.round(((buf.length - 44) / byteRate) * 1000)
  };
}

async function readManifest(dir) {
  const file = path.join(dir, MANIFEST);
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) {
    state.mtimeMs = 0;
    state.entries = new Map();
    state.manifest = { name: null, enabled: false, entries: [] };
    state.problems = stat ? ['manifest.json is not a file'] : ['no manifest.json'];
    return;
  }
  if (stat.size > MANIFEST_MAX_BYTES) {
    state.problems = ['manifest.json is too large to be a voice pack'];
    state.entries = new Map();
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    state.problems = [`manifest.json is not valid JSON: ${err.message}`];
    state.entries = new Map();
    return;
  }
  const problems = [];
  const entries = new Map();
  const list = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') { problems.push('ignored a manifest entry that is not an object'); continue; }
    const phrase = normalise(raw.phrase);
    const file = String(raw.file || '');
    if (!phrase) { problems.push('ignored an entry with no phrase'); continue; }
    if (!file) { problems.push(`"${phrase}" has no file`); continue; }
    const ext = path.extname(file).toLowerCase();
    if (!AUDIO_EXT.has(ext)) { problems.push(`"${phrase}" points at ${file}, which is not .wav or .mp3`); continue; }
    if (entries.has(phrase)) problems.push(`"${phrase}" is listed more than once; the last one wins`);
    entries.set(phrase, { file, format: ext.slice(1) });
  }

  state.mtimeMs = stat.mtimeMs;
  state.entries = entries;
  state.problems = problems;
  state.manifest = {
    name: typeof parsed.name === 'string' ? parsed.name : null,
    version: typeof parsed.version === 'string' ? parsed.version : null,
    enabled: parsed.enabled !== false,
    description: typeof parsed.description === 'string' ? parsed.description : null,
    entries: [...entries.entries()].map(([phrase, e]) => ({ phrase, file: e.file, format: e.format }))
  };
}

/** Load the pack if the manifest changed. Cheap and only stat()s one file. */
async function load(force) {
  const dir = root();
  if (state.loaded && !force) {
    const stat = await fsp.stat(path.join(dir, MANIFEST)).catch(() => null);
    if (stat && stat.mtimeMs === state.mtimeMs) return;
  }
  state.loaded = true;
  state.root = dir;
  await readManifest(dir);
}

/**
 * Find a clip for this phrase. Tries the manifest, then a conventionally named
 * file, then gives up so the caller can use SAPI.
 */
async function resolve(text) {
  const dir = root();
  await load();
  if (!state.manifest || state.manifest.enabled === false) return null;

  const phrase = normalise(text);
  if (!phrase) return null;

  const entry = state.entries.get(phrase);
  const candidates = [];
  if (entry) candidates.push(entry.file);
  // A pack can ship clips with no manifest entry at all, named after the phrase.
  const conventional = slug(phrase);
  if (conventional) for (const ext of ['.wav', '.mp3']) candidates.push(conventional + ext);

  for (const relative of candidates) {
    const abs = safeJoin(dir, relative);
    if (!abs) continue;
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat || !stat.isFile() || !stat.size) continue;
    const buf = await fsp.readFile(abs).catch(() => null);
    if (!buf) continue;
    const ext = path.extname(abs).toLowerCase();
    if (!looksLikeAudio(buf, ext)) continue;
    const info = wavInfo(buf) || { format: ext.slice(1), sampleRate: null, channels: null, durationMs: null };
    return {
      audio: buf,
      format: info.format,
      sampleRate: info.sampleRate,
      channels: info.channels,
      bytes: buf.length,
      durationMs: info.durationMs,
      voice: null,
      source: 'voicepack',
      pack: state.manifest.name,
      phrase
    };
  }
  return null;
}

/** Describe the pack, for the settings view and for check-voicepack. */
async function describe() {
  const dir = root();
  await load(true);
  const used = new Set([...state.entries.values()].map((e) => e.file));
  const loose = [];
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    const ext = path.extname(name).toLowerCase();
    if (AUDIO_EXT.has(ext) && !used.has(name)) loose.push(name);
  }
  return {
    root: dir,
    exists: await fsp.stat(dir).then((s) => s.isDirectory()).catch(() => false),
    enabled: state.manifest ? state.manifest.enabled !== false : false,
    name: state.manifest ? state.manifest.name : null,
    version: state.manifest ? state.manifest.version : null,
    description: state.manifest ? state.manifest.description : null,
    entries: state.manifest ? state.manifest.entries : [],
    looseFiles: loose.sort(),
    problems: state.problems.slice()
  };
}

module.exports = { resolve, describe, normalise, slug, root, looksLikeAudio, wavInfo, safeJoin };
