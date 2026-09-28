'use strict';

/**
 * Secret resolution.
 *
 * Rules (enforced here, not by convention):
 *  1. API keys are read ONLY in the main process.
 *  2. Values are never sent over IPC to the renderer.
 *  3. The renderer can only learn *whether* a key is present, never its value.
 *  4. A key may be supplied via env var OR a 0600 file in userData/secrets.json,
 *     so users without env config can still run LEGION.
 */

const fs = require('fs');
const path = require('path');

const ENV_MAP = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  ollama: null
});

const SECRETS_FILE = 'secrets.json';

class SecretStore {
  constructor(dir) {
    this.file = path.join(dir, SECRETS_FILE);
    this.values = {};
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') this.values = parsed;
    } catch (_) { /* first run */ }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2), { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(this.file, 0o600); } catch (_) { /* best effort on Windows */ }
    } catch (err) {
      console.error('[secrets] save failed:', err.message);
    }
  }

  set(provider, value) {
    if (!value) { delete this.values[provider]; }
    else { this.values[provider] = String(value); }
    this.save();
    return this.status(provider);
  }

  clear(provider) { return this.set(provider, null); }

  /** Returns the real key. Main process only. */
  get(provider) {
    if (!provider) return null;
    const envName = ENV_MAP[provider];
    if (envName && process.env[envName]) return process.env[envName];
    const v = this.values[provider];
    return v && String(v).trim() ? String(v).trim() : null;
  }

  /** Safe to send to the renderer: presence only, plus the source name. */
  status(provider) {
    const envName = ENV_MAP[provider];
    const viaEnv = !!(envName && process.env[envName]);
    const viaFile = !!(this.values[provider] && String(this.values[provider]).trim());
    return {
      provider: provider || null,
      configured: viaEnv || viaFile,
      source: viaEnv ? 'environment' : (viaFile ? 'local-store' : 'none'),
      envVar: envName || null
    };
  }
}

module.exports = { SecretStore, ENV_MAP };
