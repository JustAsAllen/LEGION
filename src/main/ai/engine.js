'use strict';

const { createProvider } = require('./providers');
const { buildSystemPrompt } = require('./personality');
const { ToolError } = require('../tools/registry');

const MAX_TOOL_ROUNDS = 6;
const TOOL_RESULT_CHAR_LIMIT = 6000;
const SPEECH_CHUNK_MIN = 48;

function completeSpeechChunks(buffer, flush) {
  const chunks = [];
  let rest = buffer;
  const boundary = /[.!?](?:["')\]]?)(?=\s|$)/g;
  let match;
  while ((match = boundary.exec(rest))) {
    const end = match.index + match[0].length;
    if (end < SPEECH_CHUNK_MIN && !flush) continue;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trimStart();
    boundary.lastIndex = 0;
  }
  if (flush && rest.trim()) chunks.push(rest.trim());
  return { chunks, rest };
}

class AIEngine {
  constructor(deps) {
    this.deps = deps;                 // { settings, secrets, toolManager, memory, onEvent, isDev }
    this.abort = null;
    this.profileId = 'legion';
    this.isDev = deps.isDev === true;
  }

  get config() {
    const ai = this.deps.settings.get().ai;
    // Defence in depth: even if a dev settings file reaches a production
    // process, the mock provider is never selected here.
    if (ai.provider === 'mock' && !this.isDev) return Object.assign({}, ai, { provider: 'none' });
    return ai;
  }

  provider() {
    return createProvider(this.config.provider, this.config, this.deps.secrets.get(this.config.provider));
  }

  status() {
    const p = this.config.provider;
    if (p === 'none') return { provider: 'none', ready: false, reason: 'No provider configured.', secret: this.deps.secrets.status(p) };
    const secret = this.deps.secrets.status(p);
    if (p === 'mock' && this.isDev) return { provider: 'mock', ready: true, mock: true, reason: null, secret, model: 'legion-mock' };
    if (!secret.configured) return { provider: p, ready: false, reason: 'No API key configured.', secret };
    return { provider: p, ready: true, secret, model: this.config.model || null };
  }

  async probe() {
    const st = this.status();
    if (st.provider === 'none') return { provider: 'none', online: false, reason: 'No provider configured.' };
    if (st.provider === 'mock') return { provider: 'mock', online: true, mock: true, keyConfigured: false, keySource: 'none' };
    return { provider: st.provider, online: st.ready, keyConfigured: st.secret.configured, keySource: st.secret.source };
  }

  cancel() {
    if (this.abort) { try { this.abort.abort(); } catch (_) { /* ignore */ } this.abort = null; return true; }
    return false;
  }

  /**
   * Pick the provider for this turn.
   *
   * A configured provider is the only path. There is no hidden local fallback:
   * an unset provider is refused with E_NO_PROVIDER so the interface can send
   * the user to Settings instead of guessing at a backend.
   */
  async resolveProvider(st) {
    if (st.provider === 'none') {
      throw new ToolError('No AI provider is configured. Choose one in Settings.', 'E_NO_PROVIDER');
    }
    return this.provider();
  }

  /**
   * Run one tool call and normalise the outcome.
   *
   * A failing tool is data, not a crash: the model is told what happened so it
   * can adapt or explain. Only registry errors carry a code outward.
   */
  async runTool(name, args, options) {
    this.emit('tool', { name, phase: 'start', arguments: args || {} });
    let outcome;
    try {
      const executed = await this.deps.toolManager.execute(name, args || {}, options || {});
      outcome = {
        ok: true, tool: executed.tool, risk: executed.risk,
        auditId: executed.auditId, durationMs: executed.durationMs,
        arguments: executed.arguments, result: executed.result
      };
    } catch (err) {
      outcome = { ok: false, error: { code: err.code || 'E_TOOL', message: err.message, declined: !!err.declined } };
    }
    this.emit('tool', { name, phase: 'end', ok: outcome.ok, detail: outcome });
    return outcome;
  }

  /** The transcript handed to the model: bounded history plus the live prompt. */
  buildWire(userText) {
    const cfg = this.config;
    const wire = this.deps.memory.context(cfg.contextTurns)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.text }));

    // Inference must not depend on conversation persistence. When memory is
    // disabled, appendMessage() is intentionally a no-op, so ensure the
    // current prompt is still the final user turn sent to the provider.
    const latest = wire[wire.length - 1];
    if (!latest || latest.role !== 'user' || latest.content !== userText) {
      wire.push({ role: 'user', content: userText });
    }
    return wire;
  }

  /**
   * Run one conversational turn.
   * Emits: 'state' (processing), 'tool' (name/phase/result), 'delta' (partial text)
   */
  async respond(userText) {
    const cfg = this.config;
    const st = this.status();
    if (!st.ready && st.provider !== 'none') {
      throw new ToolError(st.reason || 'AI connection unavailable.', 'E_NO_KEY');
    }

    this.deps.memory.appendMessage('user', userText);
    this.abort = new AbortController();
    const signal = this.abort.signal;

    const provider = await this.resolveProvider(st);
    const tools = this.deps.toolManager.catalogue();
    const system = buildSystemPrompt(this.profileId, cfg, {
      longTermEnabled: this.deps.memory.config.longTermEnabled,
      longTerm: this.deps.memory.list()
    });

    // Working transcript: model turns only (tool traffic handled separately)
    const wire = this.buildWire(userText);
    const toolLog = [];
    const toolSummaries = [];
    let finalText = '';
    let usage = null;
    let model = null;
    let speechChunkSeq = 0;

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        let speechBuffer = '';
        const res = await provider.chat({
          system, messages: wire, tools,
          temperature: cfg.temperature, maxTokens: cfg.maxTokens, signal,
          onDelta: (delta) => {
            if (!delta) return;
            this.emit('delta', { text: delta });
            speechBuffer += delta;
            const ready = completeSpeechChunks(speechBuffer, false);
            speechBuffer = ready.rest;
            for (const text of ready.chunks) this.emit('response-chunk', { text, sequence: speechChunkSeq++ });
          }
        });
        usage = res.usage;
        model = res.model;
        if (res.text) finalText = res.text;

        // A turn that carried only tool calls leaves nothing to show yet; the
        // summary at the end covers it if the round budget runs out.
        if (!res.toolCalls || !res.toolCalls.length) {
          const ready = completeSpeechChunks(speechBuffer, true);
          for (const text of ready.chunks) this.emit('response-chunk', { text, sequence: speechChunkSeq++ });
          break;
        }

        for (const call of res.toolCalls) {
          const outcome = await this.runTool(call.name, call.arguments || {}, { signal });
          toolSummaries.push(outcome.ok
            ? `${call.name}: ok`
            : `${call.name}: failed (${outcome.error.code}) — ${outcome.error.message}`);

          toolLog.push({ name: call.name, ok: outcome.ok });
          wire.push({ role: 'assistant', content: res.text || `(calling ${call.name})` });
          wire.push({
            role: 'user',
            content: `Tool result for ${call.name}:\n${JSON.stringify(outcome).slice(0, TOOL_RESULT_CHAR_LIMIT)}`
          });
        }

        if (round === MAX_TOOL_ROUNDS - 1) {
          wire.push({ role: 'user', content: 'Summarise the results for the user now. Do not call more tools.' });
        }
      }
    } catch (err) {
      if (signal.aborted) {
        const abortErr = new ToolError('Request cancelled.', 'E_ABORTED');
        abortErr.aborted = true;
        throw abortErr;
      }
      throw err;
    } finally {
      this.abort = null;
    }

    if (!finalText && toolSummaries.length) {
      finalText = `Completed ${toolSummaries.length} action${toolSummaries.length === 1 ? '' : 's'}: ${toolSummaries.join('; ')}.`;
    }
    if (!finalText) finalText = 'I had nothing to add.';

    this.deps.memory.appendMessage('assistant', finalText, {
      tools: toolLog.map((t) => ({ name: t.name, ok: t.ok }))
    });

    return { text: finalText, model, usage, tools: toolLog };
  }

  emit(type, payload) {
    try { this.deps.onEvent(type, payload); } catch (_) { /* ignore */ }
  }
}

module.exports = { AIEngine, MAX_TOOL_ROUNDS };