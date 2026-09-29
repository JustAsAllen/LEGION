'use strict';

const { ToolError } = require('../tools/registry');

/**
 * Provider adapter contract
 * -------------------------
 *   id            string
 *   needsKey      boolean
 *   chat({ system, messages, tools, temperature, maxTokens, signal })
 *        -> { text, toolCalls: [{id, name, arguments}], usage, raw }
 *
 * Every provider speaks the same shape, so the engine, memory and tool router
 * never learn provider-specific details.
 */

class Provider {
  constructor(cfg) { this.cfg = cfg; }
  get id() { throw new Error('not implemented'); }
  get needsKey() { return false; }
  async chat() { throw new Error('not implemented'); }
}

async function asHttpError(res, provider) {
  let detail = '';
  try { detail = (await res.text()).slice(0, 600); } catch (_) { /* ignore */ }
  const err = new ToolError(`${provider} request failed (HTTP ${res.status}). ${detail}`, 'E_AI_HTTP');
  err.status = res.status;
  return err;
}

class AnthropicProvider extends Provider {
  constructor(cfg, key) { super(cfg); this.key = key; }
  get id() { return 'anthropic'; }
  get needsKey() { return true; }

  get defaultModel() { return 'claude-sonnet-4-5'; }

  async chat({ system, messages, tools, temperature, maxTokens, signal }) {
    const model = this.cfg.model || this.defaultModel;
    const body = {
      model,
      max_tokens: maxTokens || 900,
      temperature: temperature === undefined ? 0.3 : temperature,
      system,
      messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    };
    if (tools && tools.length) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters
      }));
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw await asHttpError(res, 'Anthropic');

    const data = await res.json();
    const textParts = [];
    const toolCalls = [];
    for (const block of (data.content || [])) {
      if (block.type === 'text') textParts.push(block.text);
      else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, arguments: block.input || {} });
    }
    return {
      text: textParts.join('\n').trim(),
      toolCalls,
      usage: data.usage || null,
      model: data.model || model
    };
  }
}

class OpenAIProvider extends Provider {
  constructor(cfg, key) { super(cfg); this.key = key; }
  get id() { return 'openai'; }
  get needsKey() { return true; }

  get defaultModel() { return 'gpt-4o-mini'; }
  get base() { return (this.cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''); }

  async chat({ system, messages, tools, temperature, maxTokens, signal, onDelta }) {
    const model = this.cfg.model || this.defaultModel;
    const wire = [{ role: 'system', content: system }].concat(
      messages.map((m) => ({ role: m.role, content: m.content }))
    );
    const body = {
      model,
      messages: wire,
      temperature: temperature === undefined ? 0.3 : temperature,
      max_tokens: maxTokens || 900
    };
    if (tools && tools.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }

    const res = await fetch(`${this.base}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw await asHttpError(res, 'OpenAI');

    const data = await res.json();
    const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
    const toolCalls = (msg.tool_calls || []).map((tc) => ({
      id: tc.id,
      name: tc.function && tc.function.name,
      arguments: safeParse((tc.function && tc.function.arguments) || '{}')
    }));
    return { text: (msg.content || '').trim(), toolCalls, usage: data.usage || null, model: data.model || model };
  }
}

class OllamaProvider extends Provider {
  constructor(cfg) { super(cfg); }
  get id() { return 'ollama'; }
  get needsKey() { return false; }
  get defaultModel() { return 'llama3.1'; }
  get base() { return (this.cfg.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, ''); }

  async available(signal) {
    try {
      const res = await fetch(`${this.base}/api/tags`, { signal });
      if (!res.ok) return { online: false, models: [] };
      const data = await res.json();
      return { online: true, models: (data.models || []).map((m) => m.name) };
    } catch (_) { return { online: false, models: [] }; }
  }

  async chat({ system, messages, tools, temperature, maxTokens, signal, onDelta }) {
    const model = this.cfg.model || this.defaultModel;
    const wire = [{ role: 'system', content: system }].concat(
      messages.map((m) => ({ role: m.role, content: m.content }))
    );
    const body = {
      model,
      messages: wire,
      stream: !!onDelta,
      options: { temperature: temperature === undefined ? 0.3 : temperature, num_predict: maxTokens || 900 }
    };
    if (tools && tools.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }

    const res = await fetch(`${this.base}/api/chat`, {
      method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!res.ok) throw await asHttpError(res, 'Ollama');
    if (!onDelta) {
      const data = await res.json();
      const msg = data.message || {};
      const toolCalls = (msg.tool_calls || []).map((tc, i) => ({
        id: tc.id || `call_${i}`,
        name: tc.function && tc.function.name,
        arguments: tc.function && (tc.function.arguments || {})
      }));
      return { text: (msg.content || '').trim(), toolCalls, usage: { evalCount: data.eval_count }, model };
    }

    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) throw new ToolError('Ollama returned no streaming body.', 'E_AI_STREAM');
    const decoder = new TextDecoder();
    let buffer = '', text = '', usage = null;
    const calls = [];
    const consume = (data) => {
      const msg = data && data.message ? data.message : {};
      if (msg.content) { text += msg.content; onDelta(msg.content); }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function || {};
          const index = tc.index === undefined ? calls.length : tc.index;
          calls[index] = calls[index] || { id: tc.id || `call_${index}`, name: fn.name || '', arguments: {} };
          if (fn.name) calls[index].name = fn.name;
          if (fn.arguments && typeof fn.arguments === 'object') Object.assign(calls[index].arguments, fn.arguments);
        }
      }
      if (data.done) usage = { evalCount: data.eval_count, promptEvalCount: data.prompt_eval_count };
    };
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { consume(JSON.parse(trimmed)); } catch (_) { /* incomplete line */ }
      }
    }
    if (buffer.trim()) { try { consume(JSON.parse(buffer)); } catch (_) {} }
    return { text: text.trim(), toolCalls: calls.filter(Boolean), usage, model };
  }
}

class NullProvider extends Provider {
  get id() { return 'none'; }
  get needsKey() { return false; }
  get unavailable() { return true; }
  async chat() {
    throw new ToolError('AI connection unavailable. Choose a provider in Settings.', 'E_NO_PROVIDER');
  }
}

function safeParse(s) {
  try { return typeof s === 'string' ? JSON.parse(s) : (s || {}); } catch (_) { return {}; }
}

const REGISTRY = { anthropic: AnthropicProvider, openai: OpenAIProvider, ollama: OllamaProvider, none: NullProvider };

function createProvider(id, cfg, secret) {
  const Ctor = REGISTRY[id];
  if (!Ctor) return new NullProvider();
  if (Ctor === AnthropicProvider || Ctor === OpenAIProvider) {
    if (!secret) return new NullProvider();
    return new Ctor(cfg, secret);
  }
  return new Ctor(cfg);
}

module.exports = { createProvider, REGISTRY, Provider };
