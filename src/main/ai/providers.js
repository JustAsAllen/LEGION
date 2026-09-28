'use strict';

const { ToolError } = require('../tools/registry');

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

function anthropicMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]
      };
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments || {} });
      }
      return { role: 'assistant', content };
    }
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content };
  });
}

function openAiMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) }
        }))
      };
    }
    return { role: m.role, content: m.content };
  });
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
      messages: anthropicMessages(messages)
    };
    if (tools && tools.length) {
      body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
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
    return { text: textParts.join('\n').trim(), toolCalls, usage: data.usage || null, model: data.model || model };
  }
}

class OpenAIProvider extends Provider {
  constructor(cfg, key) { super(cfg); this.key = key; }
  get id() { return 'openai'; }
  get needsKey() { return true; }
  get defaultModel() { return 'gpt-4o-mini'; }
  get base() { return (this.cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''); }

  async chat({ system, messages, tools, temperature, maxTokens, signal }) {
    const model = this.cfg.model || this.defaultModel;
    const wire = [{ role: 'system', content: system }].concat(openAiMessages(messages));
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
      method: 'POST', signal,
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

  async chat({ system, messages, tools, temperature, maxTokens, signal }) {
    const model = this.cfg.model || this.defaultModel;
    const wire = [{ role: 'system', content: system }].concat(openAiMessages(messages));
    const body = {
      model, messages: wire, stream: false,
      options: { temperature: temperature === undefined ? 0.3 : temperature, num_predict: maxTokens || 900 }
    };
    if (tools && tools.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }

    const res = await fetch(`${this.base}/api/chat`, {
      method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!res.ok) throw await asHttpError(res, 'Ollama');
    const data = await res.json();
    const msg = data.message || {};
    const toolCalls = (msg.tool_calls || []).map((tc, i) => ({
      id: tc.id || `call_${i}`,
      name: tc.function && tc.function.name,
      arguments: tc.function && (tc.function.arguments || {})
    }));
    return { text: (msg.content || '').trim(), toolCalls, usage: { evalCount: data.eval_count }, model };
  }
}

class NullProvider extends Provider {
  get id() { return 'none'; }
  get needsKey() { return false; }
  get unavailable() { return true; }
  async chat() { throw new ToolError('AI connection unavailable. Choose a provider in Settings.', 'E_NO_PROVIDER'); }
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
