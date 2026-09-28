'use strict';

const fsp = require('fs').promises;
const path = require('path');
const { EventEmitter } = require('events');
const { RISK, ToolError } = require('./registry');

/** Notes, reminders and timers. Persisted as plain JSON in userData. */

class ProductivityStore {
  constructor(file) {
    this.file = file;
    this.data = { notes: [], reminders: [], timers: [] };
    this.load();
    this.emitter = new EventEmitter();
    this.tick();
    this.interval = setInterval(() => this.tick(), 1000);
    if (this.interval.unref) this.interval.unref();
  }

  load() {
    try { this.data = JSON.parse(require('fs').readFileSync(this.file, 'utf8')); }
    catch (_) { this.data = { notes: [], reminders: [], timers: [] }; }
  }

  save() {
    try {
      require('fs').mkdirSync(path.dirname(this.file), { recursive: true });
      require('fs').writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) { console.error('[productivity] save failed:', err.message); }
  }

  tick() {
    const now = Date.now();
    for (const t of this.data.timers) {
      if (t.status === 'running' && t.endsAt <= now) {
        t.status = 'fired';
        t.firedAt = now;
        this.emitter.emit('timer-fired', t);
        this.save();
      }
    }
  }

  onTimer(cb) { this.emitter.on('timer-fired', cb); }
}

module.exports = function registerProductivityTools(registry, ctxRef) {
  const store = ctxRef.productivity;

  registry.register({
    name: 'notes_add',
    category: 'productivity',
    risk: RISK.WRITE,
    description: 'Save a note.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 20000 }, tags: { type: 'array', items: { type: 'string' } } },
      required: ['text']
    },
    async handler({ text, tags }) {
      const note = { id: `n_${Date.now().toString(36)}`, text: String(text), tags: tags || [], createdAt: new Date().toISOString() };
      store.data.notes.unshift(note);
      store.save();
      return { saved: true, id: note.id, totalNotes: store.data.notes.length };
    }
  });

  registry.register({
    name: 'notes_search',
    category: 'productivity',
    risk: RISK.READ,
    description: 'Search saved notes.',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    async handler({ query }) {
      const q = String(query || '').toLowerCase();
      const list = q ? store.data.notes.filter((n) => n.text.toLowerCase().includes(q) || (n.tags || []).some((t) => t.toLowerCase().includes(q))) : store.data.notes;
      return { count: list.length, notes: list.slice(0, 50) };
    }
  });

  registry.register({
    name: 'notes_delete',
    category: 'productivity',
    risk: RISK.DESTRUCTIVE,
    description: 'Delete a note by id.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    confirm(args) { return { message: `This will permanently delete note ${args.id}.`, impact: 'Deleting a note' }; },
    async handler({ id }) {
      const before = store.data.notes.length;
      store.data.notes = store.data.notes.filter((n) => n.id !== id);
      store.save();
      return { deleted: before - store.data.notes.length, id, remaining: store.data.notes.length };
    }
  });

  registry.register({
    name: 'reminder_create',
    category: 'productivity',
    risk: RISK.WRITE,
    description: 'Create a reminder that fires at a given time. Accepts an ISO timestamp or a relative delay like "in 10 minutes".',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        when: { type: 'string', description: 'ISO 8601 timestamp, or "in 5 minutes" / "in 2 hours" / "in 3 days".' }
      },
      required: ['text', 'when']
    },
    async handler({ text, when }) {
      const at = parseWhen(when);
      if (!at) throw new ToolError(`I could not understand the time "${when}". Try an ISO timestamp or "in 10 minutes".`, 'E_TIME');
      const r = { id: `r_${Date.now().toString(36)}`, text: String(text), dueAt: new Date(at).toISOString(), createdAt: new Date().toISOString(), fired: false };
      store.data.reminders.unshift(r);
      store.save();
      return { created: true, id: r.id, dueAt: r.dueAt, human: new Date(at).toLocaleString() };
    }
  });

  registry.register({
    name: 'reminder_list',
    category: 'productivity',
    risk: RISK.READ,
    description: 'List reminders.',
    parameters: { type: 'object', properties: { includeFired: { type: 'boolean' } } },
    async handler({ includeFired }) {
      const list = includeFired ? store.data.reminders : store.data.reminders.filter((r) => !r.fired);
      return { count: list.length, reminders: list.slice(0, 50) };
    }
  });

  registry.register({
    name: 'timer_start',
    category: 'productivity',
    risk: RISK.WRITE,
    description: 'Start a countdown timer that notifies when it reaches zero.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'integer', minimum: 1, maximum: 86400 },
        label: { type: 'string' }
      },
      required: ['seconds']
    },
    async handler({ seconds, label }) {
      const t = { id: `t_${Date.now().toString(36)}`, label: label || 'Timer', durationSeconds: seconds, startedAt: new Date().toISOString(), endsAt: Date.now() + seconds * 1000, status: 'running' };
      store.data.timers.unshift(t);
      store.save();
      return { started: true, id: t.id, label: t.label, endsAt: new Date(t.endsAt).toISOString(), secondsRemaining: seconds };
    }
  });

  registry.register({
    name: 'timer_list',
    category: 'productivity',
    risk: RISK.READ,
    description: 'List timers with their remaining time.',
    parameters: { type: 'object', properties: {} },
    async handler() {
      const now = Date.now();
      return {
        timers: store.data.timers.slice(0, 20).map((t) => ({
          id: t.id, label: t.label, status: t.status,
          secondsRemaining: t.status === 'running' ? Math.max(0, Math.round((t.endsAt - now) / 1000)) : 0
        }))
      };
    }
  });

  registry.register({
    name: 'timer_cancel',
    category: 'productivity',
    risk: RISK.WRITE,
    description: 'Cancel a running timer.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async handler({ id }) {
      const t = store.data.timers.find((x) => x.id === id);
      if (!t) return { cancelled: false, reason: 'not_found' };
      t.status = 'cancelled';
      store.save();
      return { cancelled: true, id };
    }
  });

  registry.register({
    name: 'memory_list',
    category: 'productivity',
    risk: RISK.READ,
    description: 'List long-term memories LEGION has been explicitly permitted to keep.',
    parameters: { type: 'object', properties: {} },
    async handler() { return { memories: ctxRef.memory.list() }; }
  });
};

function parseWhen(input) {
  const s = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return t;
  }
  const rel = s.match(/^in\s+(\d+(?:\.\d+)?)\s*(second|sec|minute|min|hour|hr|day|week)s?$/i);
  if (rel) {
    const n = parseFloat(rel[1]);
    const unit = rel[2].toLowerCase();
    const mult = { second: 1e3, sec: 1e3, minute: 6e4, min: 6e4, hour: 36e5, hr: 36e5, day: 864e5, week: 6048e5 }[unit];
    if (mult) return Date.now() + n * mult;
  }
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

module.exports.ProductivityStore = ProductivityStore;
