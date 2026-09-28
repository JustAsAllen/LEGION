'use strict';

const { createProvider } = require('./providers');
const { buildSystemPrompt } = require('./personality');
const { ToolError } = require('../tools/registry');

const MAX_TOOL_ROUNDS = 6;

class AIEngine {
  constructor(deps) {
    this.deps = deps;
    this.abort = null;
    this.profileId = 'legion';
    this.busy = false;
  }

  get config() { return this.deps.settings.get().ai; }

  provider() {
    return createProvider(this.config.provider, this.config, this.deps.secrets.get(this.config.provider));
  }

  status() {
    const p = this.config.provider;
    if (p === 'none') return { provider: 'none', ready: false, reason: 'No provider configured.', secret: this.deps.secrets.status(p), busy: this.busy };
    if (p === 'ollama') return { provider: p, ready: true, secret: this.deps.secrets.status(p), baseUrl: this.config.baseUrl || 'http://127.0.0.1:11434', busy: this.busy };
    const secret = this.deps.secrets.status(p);
    if (!secret.configured) return { provider: p, ready: false, reason: 'No API key configured.', secret, busy: this.busy };
    return { provider: p, ready: true, secret, model: this.config.model || null, busy: this.busy };
  }

  async probe() {
    const st = this.status();
    if (st.provider === 'ollama') {
      const prov = this.provider();
      const res = await prov.available();
      return { provider: 'ollama', online: res.online, models: res.models, baseUrl: st.baseUrl };
    }
    if (st.provider === 'none') return { provider: 'none', online: false, reason: 'No provider configured.' };
    return { provider: st.provider, online: st.ready, keyConfigured: st.secret.configured, keySource: st.secret.source };
  }

  cancel() {
    if (this.abort) {
      try { this.abort.abort(); } catch (_) { /* ignore */ }
      this.abort = null;
      return true;
    }
    return false;
  }

  async respond(userText) {
    if (this.busy) throw new ToolError('LEGION is already processing a request.', 'E_BUSY');

    const cfg = this.config;
    const st = this.status();
    if (!st.ready) {
      throw new ToolError(st.reason || 'AI connection unavailable.', st.provider === 'none' ? 'E_NO_PROVIDER' : 'E_NO_KEY');
    }

    this.busy = true;
    this.deps.memory.appendMessage('user', userText);
    this.abort = new AbortController();
    const signal = this.abort.signal;

    const provider = this.provider();
    const tools = this.deps.toolManager.catalogue();
    const system = buildSystemPrompt(this.profileId, cfg, {
      longTermEnabled: this.deps.memory.config.longTermEnabled,
      longTerm: this.deps.memory.list()
    });

    const wire = this.deps.memory.context(cfg.contextTurns)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.text }));

    const toolLog = [];
    let finalText = '';
    let usage = null;
    let model = null;
    const toolSummaries = [];

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const res = await provider.chat({
          system, messages: wire, tools,
          temperature: cfg.temperature, maxTokens: cfg.maxTokens, signal
        });
        usage = res.usage; model = res.model;
        if (res.text) finalText = res.text;

        if (!res.toolCalls || !res.toolCalls.length) break;

        // Preserve the provider's structured tool-call message. This is
        // essential for the next round on OpenAI/Anthropic-compatible APIs.
        wire.push({
          role: 'assistant',
          content: res.text || '',
          toolCalls: res.toolCalls.map((call) => ({
            id: call.id, name: call.name, arguments: call.arguments || {}
          }))
        });

        for (const call of res.toolCalls) {
          this.emit('tool', { name: call.name, phase: 'start', arguments: call.arguments || {} });
          let outcome;
          try {
            const executed = await this.deps.toolManager.execute(call.name, call.arguments || {});
            outcome = { ok: true, result: executed.result };
            toolSummaries.push(`${call.name}: ok`);
          } catch (err) {
            outcome = { ok: false, error: { code: err.code || 'E_TOOL', message: err.message } };
            toolSummaries.push(`${call.name}: failed (${err.code || 'error'}) — ${err.message}`);
          }
          this.emit('tool', { name: call.name, phase: 'end', ok: outcome.ok, detail: outcome.ok ? null : outcome.error.message });

          toolLog.push({ call, outcome });
          wire.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify(outcome).slice(0, 6000)
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
      this.busy = false;
    }

    if (!finalText && toolSummaries.length) {
      finalText = `Completed ${toolSummaries.length} action${toolSummaries.length === 1 ? '' : 's'}: ${toolSummaries.join('; ')}.`;
    }
    if (!finalText) finalText = 'I had nothing to add.';

    this.deps.memory.appendMessage('assistant', finalText, {
      tools: toolLog.map((t) => ({ name: t.call.name, ok: t.outcome.ok }))
    });

    return { text: finalText, model, usage, tools: toolLog.map((t) => ({ name: t.call.name, ok: t.outcome.ok })) };
  }

  emit(type, payload) {
    try { this.deps.onEvent(type, payload); } catch (_) { /* ignore */ }
  }
}

module.exports = { AIEngine };
