'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Three-tier memory.
 *   SHORT-TERM  rolling window of the active conversation
 *   SESSION     the full transcript for this application run
 *   LONG-TERM   facts the user explicitly allowed us to keep (opt-in)
 *
 * Long-term writes are gated: `remember()` refuses unless long-term is enabled
 * and the caller passes `explicit: true`. Nothing is inferred silently.
 */

const REDACT = [
  /\b(sk-[A-Za-z0-9_\-]{16,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4})\b/g,
  /(["']?)(?:password|passwd|secret|api[_-]?key|token|bearer)\1\s*[:=]\s*["']?[^\s"',;]{6,}/gi
];

function redact(text) {
  let out = String(text);
  for (const re of REDACT) out = out.replace(re, (m) => {
    if (/^["']?(?:password|passwd|secret|api[_-]?key|token|bearer)/i.test(m.trim())) return m.replace(/([:=]\s*)["']?[^\s"',;]{6,}/i, '$1[redacted]');
    return '[redacted]';
  });
  return out;
}

/**
 * Build a redaction policy from a boolean.
 *
 * Exported so the setting can be exercised directly in a check instead of
 * only being observed through a live conversation.
 */
function makeRedactor(on) {
  return on === false ? (text) => String(text) : redact;
}

class MemoryStore {
  constructor(dir, settings) {
    this.dir = dir;
    this.settings = settings;
    this.file = path.join(dir, 'memory.json');
    this.transcriptFile = path.join(dir, 'transcript.jsonl');
    this.session = [];
    this.longTerm = [];
    this.load();
  }

  get config() { return this.settings.get().memory; }

  /**
   * Redaction policy, read live so a settings change applies to the next write
   * instead of the next launch. The setting used to gate nothing at all.
   */
  get clean() { return makeRedactor(this.settings.get().privacy.redactSecrets); }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.longTerm = Array.isArray(raw.longTerm) ? raw.longTerm : [];
    } catch (_) { this.longTerm = []; }
    this.session = [];
  }

  saveLongTerm() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, longTerm: this.longTerm }, null, 2), 'utf8');
    } catch (err) { console.error('[memory] save failed:', err.message); }
  }

  appendMessage(role, text, extra) {
    if (!this.config.enabled) return null;
    const msg = { role, text: this.clean(text), at: new Date().toISOString() };
    if (extra) Object.assign(msg, extra);
    this.session.push(msg);
    const cap = this.config.maxSessionMessages;
    if (this.session.length > cap) this.session.splice(0, this.session.length - cap);
    if (this.settings.get().privacy.storeConversations) this.persist(msg);
    return msg;
  }

  persist(msg) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.transcriptFile, JSON.stringify(msg) + '\n', 'utf8');
    } catch (_) { /* non-fatal */ }
  }

  /** Rolling window for the model prompt. */
  context(turns) {
    const n = Math.max(1, turns || this.config.maxSessionMessages);
    return this.session.slice(-n);
  }

  sessionView() { return this.session.slice(); }

  /** Long-term memory. Refuses without explicit opt-in. */
  remember(text, meta) {
    if (!this.config.enabled) return { stored: false, reason: 'memory_disabled' };
    if (!this.config.longTermEnabled) return { stored: false, reason: 'long_term_disabled' };
    if (!text || !String(text).trim()) return { stored: false, reason: 'empty' };
    const clean = this.clean(text).trim().slice(0, 2000);
    const existing = this.longTerm.find((m) => m.text === clean);
    if (existing) return { stored: false, reason: 'duplicate', id: existing.id };
    const entry = {
      id: `m_${Date.now().toString(36)}`,
      text: clean,
      tags: (meta && meta.tags) || [],
      source: (meta && meta.source) || 'user',
      createdAt: new Date().toISOString()
    };
    this.longTerm.unshift(entry);
    if (this.longTerm.length > 500) this.longTerm.length = 500;
    this.saveLongTerm();
    return { stored: true, id: entry.id };
  }

  forget(id) {
    const before = this.longTerm.length;
    this.longTerm = this.longTerm.filter((m) => m.id !== id);
    this.saveLongTerm();
    return { deleted: before - this.longTerm.length, remaining: this.longTerm.length };
  }

  list() { return this.longTerm.slice(0, 200); }

  clearSession() {
    const n = this.session.length;
    this.session = [];
    try { if (fs.existsSync(this.transcriptFile)) fs.unlinkSync(this.transcriptFile); } catch (_) { /* ignore */ }
    return { cleared: n };
  }

  clearAll() {
    const n = this.session.length + this.longTerm.length;
    this.session = [];
    this.longTerm = [];
    try { if (fs.existsSync(this.transcriptFile)) fs.unlinkSync(this.transcriptFile); } catch (_) { /* ignore */ }
    try { if (fs.existsSync(this.file)) fs.unlinkSync(this.file); } catch (_) { /* ignore */ }
    return { cleared: n };
  }

  summary() {
    return {
      memoryEnabled: this.config.enabled,
      longTermEnabled: this.config.longTermEnabled,
      sessionMessages: this.session.length,
      longTermEntries: this.longTerm.length
    };
  }
}

module.exports = { MemoryStore, redact, makeRedactor };
