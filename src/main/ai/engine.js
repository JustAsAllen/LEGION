'use strict';

const { createProvider } = require('./providers');
const { buildSystemPrompt } = require('./personality');
const { ToolError } = require('../tools/registry');

const MAX_TOOL_ROUNDS = 6;
const TOOL_RESULT_CHAR_LIMIT = 6000;
const SPEECH_CHUNK_MIN = 48;
const MAX_PROVIDER_ATTEMPTS = 3;
const RETRYABLE = new Set(['E_AI_RATE_LIMIT', 'E_AI_CONN', 'E_AI_HTTP', 'E_AI_TIMEOUT', 'E_AI_STREAM']);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    }
  });
}

function retryDelayMs(err, attempt) {
  const header = Number(err && err.retryAfter);
  if (Number.isFinite(header) && header > 0) return Math.min(15000, header * 1000);
  return Math.min(8000, 600 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 250);
}

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
    if (!st.ready) {
      return {
        provider: st.provider,
        online: false,
        keyConfigured: st.secret.configured,
        keySource: st.secret.source,
        reason: st.reason
      };
    }

    // Validate the configured endpoint and credentials with a minimal request.
    // This stays in the main process, never enters conversation memory, and
    // uses the provider adapter so custom base URLs and provider auth remain
    // covered by the same HTTP/error handling as a real turn.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const provider = this.provider();
      const result = await provider.chat({
        system: 'Reply with a single word.',
        messages: [{ role: 'user', content: 'ping' }],
        tools: [],
        temperature: 0,
        maxTokens: 1,
        signal: controller.signal
      });
      return {
        provider: st.provider,
        online: true,
        keyConfigured: st.secret.configured,
        keySource: st.secret.source,
        model: result.model || this.config.model || null
      };
    } catch (err) {
      const cancelled = controller.signal.aborted;
      return {
        provider: st.provider,
        online: false,
        keyConfigured: st.secret.configured,
        keySource: st.secret.source,
        code: cancelled ? 'E_AI_TIMEOUT' : (err.code || 'E_AI_CONN'),
        reason: cancelled ? 'Provider validation timed out.' : (err.message || 'Provider validation failed.')
      };
    } finally {
      clearTimeout(timer);
    }
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
        let emitted = false;
        let res = null;

        // A transient failure before the first delta is safe to retry. Once any
        // text has reached the renderer, replaying the request would duplicate
        // it, so the error is surfaced instead.
        for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt++) {
          try {
            res = await provider.chat({
              system, messages: wire, tools,
              temperature: cfg.temperature, maxTokens: cfg.maxTokens, signal,
              onDelta: (delta) => {
                if (!delta) return;
                emitted = true;
                this.emit('delta', { text: delta });
                speechBuffer += delta;
                const ready = completeSpeechChunks(speechBuffer, false);
                speechBuffer = ready.rest;
                for (const text of ready.chunks) this.emit('response-chunk', { text, sequence: speechChunkSeq++ });
              }
            });
            break;
          } catch (err) {
            if (signal.aborted) throw err;
            const canRetry = !emitted && RETRYABLE.has(err.code) && attempt < MAX_PROVIDER_ATTEMPTS;
            if (!canRetry) throw err;
            const delay = retryDelayMs(err, attempt);
            this.emit('retry', { attempt, delayMs: delay, code: err.code, provider: provider.id });
            await sleep(delay, signal);
          }
        }

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

        // One assistant message carries every call from this round, and each
        // result is a native tool message. Providers translate that shape to
        // their own wire format instead of receiving tool output as user text.
        const calls = res.toolCalls.map((call, index) => ({
          id: `${round + 1}-${call.id || index}`,
          name: call.name,
          arguments: call.arguments || {}
        }));
        wire.push({ role: 'assistant', content: res.text || '', toolCalls: calls });

        for (const call of calls) {
          const outcome = await this.runTool(call.name, call.arguments || {}, { signal });
          toolSummaries.push(outcome.ok
            ? `${call.name}: ok`
            : `${call.name}: failed (${outcome.error.code}) — ${outcome.error.message}`);

          toolLog.push({ name: call.name, ok: outcome.ok });

          const payload = outcome.ok ? { ok: true, result: outcome.result } : { ok: false, error: outcome.error };
          let content;
          if (outcome.ok && typeof outcome.result === 'string') content = outcome.result;
          else {
            try { content = JSON.stringify(payload); } catch (_) { content = String(payload); }
          }
          wire.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            ok: outcome.ok,
            content: content.slice(0, TOOL_RESULT_CHAR_LIMIT)
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