'use strict';

const { ToolError } = require('../tools/registry');

/**
 * Provider adapter contract
 * -------------------------
 *   id            string
 *   needsKey      boolean
 *   defaultModel  string
 *   chat({ system, messages, tools, temperature, maxTokens, signal, onDelta })
 *        -> { text, toolCalls: [{id, name, arguments}], usage, model }
 *
 * Every provider speaks the same shape, so the engine, memory and tool router
 * never learn provider-specific details. Every provider must also honour
 * `signal` (cancellation) and must stream when `onDelta` is supplied, so the
 * renderer never has to know which backend answered.
 *
 * Two timeout layers apply, and they are deliberately different:
 *
 *   ttfb   time to first response byte, which covers connect plus queueing.
 *          A provider that never answers headers fails here.
 *   idle   the gap between two stream chunks. A long generation with steady
 *          tokens is healthy and must not be killed, but a stalled stream must
 *          not hang the turn forever.
 *
 * `idle` alone also keeps a cancelled request from hanging: the abort stays
 * wired to the socket for the whole stream, not just until the headers land.
 */

const TIMEOUTS = {
  gemini: { ttfb: 30000, idle: 45000 },
  anthropic: { ttfb: 30000, idle: 45000 },
  openai: { ttfb: 30000, idle: 45000 },
  none: { ttfb: 1000, idle: 1000 }
};

/* ------------------------------------------------------------------ */
/* Errors. Every provider failure stays a ToolError so main.js can      */
/* report err.code. HTTP auth failures and rate limits get their own     */
/* codes so the interface can explain them without parsing a message.    */
/* ------------------------------------------------------------------ */

class ProviderError extends ToolError {
  constructor(message, code, provider) {
    super(message, code);
    this.name = 'ProviderError';
    this.provider = provider || 'unknown';
  }
}

function timeoutError(provider, label, ms) {
  return new ProviderError(`${label} did not respond within ${Math.round(ms / 1000)} seconds.`, 'E_AI_TIMEOUT', provider);
}

function streamError(provider, message, code) {
  return new ProviderError(message, code || 'E_AI_STREAM', provider);
}

function malformedError(provider, message, cause) {
  const err = new ProviderError(`${provider} returned a response LEGION could not read. ${message}`.trim(), 'E_AI_MALFORMED', provider);
  if (cause) err.cause = cause;
  return err;
}

function connectionError(provider, err, label) {
  const offline = new ProviderError(`${label} could not be reached. Check the connection and your API key.`, 'E_AI_CONN', provider);
  offline.cause = err;
  console.warn(`[ai] ${provider} request failed: ${err && err.message}`);
  return offline;
}

async function asHttpError(res, provider) {
  let detail = '';
  try { detail = (await res.text()).slice(0, 600); } catch (_) { detail = '(response body unreadable)'; }

  let message = detail;
  try {
    const parsed = JSON.parse(detail);
    if (parsed && parsed.error && parsed.error.message) message = parsed.error.message;
  } catch (_) { /* not JSON: keep the raw body */ }

  if (res.status === 401 || res.status === 403) {
    const err = new ProviderError(`${provider} rejected the API key (HTTP ${res.status}). ${message}`.trim(), 'E_AI_AUTH', provider);
    err.status = res.status;
    return err;
  }
  if (res.status === 429) {
    const err = new ProviderError(`${provider} rate limit reached (HTTP 429). ${message}`.trim(), 'E_AI_RATE_LIMIT', provider);
    err.status = res.status;
    const retryAfter = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
    if (retryAfter) err.retryAfter = retryAfter;
    return err;
  }

  const err = new ProviderError(`${provider} request failed (HTTP ${res.status}). ${message}`.trim(), 'E_AI_HTTP', provider);
  err.status = res.status;
  return err;
}

/** Parse a JSON body, converting a syntax failure into a typed error. */
async function readJson(res, provider) {
  let raw;
  try { raw = await res.text(); } catch (err) { throw malformedError(provider, 'The body could not be read.', err); }
  if (!raw || !raw.trim()) throw malformedError(provider, 'The response body was empty.');
  try { return JSON.parse(raw); } catch (err) { throw malformedError(provider, 'The response was not valid JSON.', err); }
}

/* ------------------------------------------------------------------ */
/* Shared HTTP + streaming plumbing                                      */
/* ------------------------------------------------------------------ */

const TIMEOUT_SENTINEL = { timeout: true };

/**
 * A deadline that does not depend on the transport cooperating.
 *
 * Aborting the controller is what stops a real request in flight, but a
 * transport that ignores its signal would hang the turn forever. The race
 * below guarantees the deadline is reported either way; `onTimeout` returns the
 * exact error instance so the caller can recognise its own deadline winning.
 */
function deadline(ms, onTimeout) {
  const err = onTimeout();
  err.deadline = true;
  let timer;
  const promise = new Promise((_, reject) => { timer = setTimeout(() => reject(err), ms); });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Wire an external signal to a fresh controller for the whole life of the
 * call, headers and body alike, so cancelling mid-stream really stops the
 * socket instead of only stopping the wait.
 */
function abortScope(signal) {
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forward, { once: true });
  }
  return {
    controller,
    signal: controller.signal,
    release() { if (signal) signal.removeEventListener('abort', forward); }
  };
}

/**
 * POST, bounded for the response headers.
 *
 * The returned `close()` must be called when the body has been consumed. The
 * abort stays wired until then: releasing it as soon as the headers arrive
 * would make cancellation a no-op for the rest of the stream, leaving the turn
 * to wait out the idle timeout instead of stopping at once.
 */
async function open({ url, body, headers, provider, label, timeouts, signal }) {
  const scope = abortScope(signal);
  const guard = deadline(timeouts.ttfb, () => timeoutError(provider, label, timeouts.ttfb));
  // Tear the socket down at the same instant, for a transport that honours it.
  const abortTimer = setTimeout(() => scope.controller.abort(), timeouts.ttfb);

  try {
    const res = await Promise.race([
      fetch(url, { method: 'POST', signal: scope.signal, headers, body: JSON.stringify(body) }),
      guard.promise
    ]);
    return { res, close: () => scope.release() };
  } catch (err) {
    // Nothing will consume the body, so nothing will call close(). Release the
    // abort listener here instead of leaving it attached to the turn's signal.
    scope.release();
    if (signal && signal.aborted) throw err;
    if (err && err.deadline) throw err;
    if (err && err.name === 'AbortError') throw timeoutError(provider, label, timeouts.ttfb);
    throw connectionError(provider, err, label);
  } finally {
    clearTimeout(abortTimer);
    guard.cancel();
  }
}

/**
 * A single read, bounded by an idle deadline and by cancellation.
 *
 * Racing the abort matters: a pending read is only released when the transport
 * honours the signal, so a slow one would otherwise keep a cancelled turn
 * alive until the deadline.
 */
function readWithTimeout(reader, ms, provider, aborter) {
  const guard = deadline(ms, () => timeoutError(provider, 'The provider', ms));
  const race = [reader.read(), guard.promise];
  if (aborter) race.push(aborter.promise);
  return Promise.race(race).finally(() => guard.cancel());
}

function abortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/** A promise that rejects the moment the signal aborts. */
function abortGuard(signal) {
  if (!signal) return null;
  if (signal.aborted) {
    const p = Promise.reject(abortError());
    p.catch(() => {});
    return { promise: p, release() {} };
  }
  let detach = () => {};
  const promise = new Promise((_, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    detach = () => signal.removeEventListener('abort', onAbort);
  });
  return { promise, release: detach };
}

/**
 * Yield complete lines from a chunked body.
 *
 * Anthropic, OpenAI and Gemini all send server-sent events whose payload lives
 * on `data:` lines. Keeping the reader generic means a chunk boundary in the
 * middle of a frame is just a partial line, never lost data.
 */
async function* streamLines(res, { provider, idleMs, signal }) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) throw streamError(provider, 'The provider returned no streaming body.');
  const decoder = new TextDecoder();
  const aborter = abortGuard(signal);
  let buffer = '';
  let drained = false;

  try {
    for (;;) {
      if (signal && signal.aborted) throw abortError();
      let part;
      try {
        part = await readWithTimeout(reader, idleMs, provider, aborter);
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        if (signal && signal.aborted) throw abortError();
        // Only the deadline is relabelled. A socket that genuinely failed is a
        // different fault and must not be reported to the user as a timeout.
        if (err && err.deadline) throw timeoutError(provider, 'The provider', idleMs);
        throw err;
      }
      if (part.done) { drained = true; break; }

      buffer += decoder.decode(part.value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer;
  } finally {
    if (aborter) aborter.release();
    if (!drained) { try { await reader.cancel(); } catch (_) { /* already closed */ } }
    try { reader.releaseLock(); } catch (_) { /* ignore */ }
  }
}

/** Server-sent events: keep `data:` payloads, ignore comments and event names. */
function ssePayload(line) {
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return null;
  return data;
}

function safeParse(s) {
  try { return typeof s === 'string' ? JSON.parse(s) : (s || {}); } catch (_) { return {}; }
}

/** Accumulator for streamed tool calls keyed by provider index. */
class ToolCallBuffer {
  constructor() { this.slots = []; }
  slot(index) {
    if (!this.slots[index]) this.slots[index] = { id: `call_${index}`, name: '', json: '', args: null };
    return this.slots[index];
  }
  mergeObject(index, fn, args) {
    const s = this.slot(index);
    if (fn && fn.name) s.name = fn.name;
    if (args && typeof args === 'object') {
      s.args = Object.assign(s.args || {}, args);
    }
  }
  mergeJson(index, fragment) {
    if (typeof fragment === 'string') this.slot(index).json += fragment;
  }
  list() {
    return this.slots.filter(Boolean).map((s, i) => ({
      id: s.id || `call_${i}`,
      name: s.name,
      arguments: s.args || safeParse(s.json)
    }));
  }
}

/**
 * Anthropic rejects two turns with the same role in a row. The engine
 * legitimately produces those shapes when a tool round yields no assistant
 * text, so adjacent user turns are merged rather than sent and rejected.
 */
function mergeAlternating(messages) {
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

/**
 * Native tool transcript helpers.
 *
 * The engine emits one assistant turn with a `toolCalls` array followed by
 * `role: 'tool'` messages. Each provider wants a different shape, and sending
 * tool output as ordinary user text (the previous behaviour) wasted tokens and
 * made the model re-read its own narration on every round.
 */
function anthropicMessages(messages) {
  const out = [];
  const pushBlocks = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const m of messages) {
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: String(m.content == null ? '' : m.content)
      };
      if (m.ok === false) block.is_error = true;
      pushBlocks('user', [block]);
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: String(m.content) });
      for (const tc of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments || {} });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    pushBlocks(m.role === 'assistant' ? 'assistant' : 'user', [{
      type: 'text',
      text: String(m.content == null ? '' : m.content)
    }]);
  }
  return out;
}

function openaiMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: String(m.content == null ? '' : m.content) };
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) }
        }))
      };
    }
    return { role: m.role, content: String(m.content == null ? '' : m.content) };
  });
}

function geminiContents(messages) {
  const out = [];
  const push = (role, parts) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  };

  const responseValue = (content) => {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      return { result: parsed };
    } catch (_) {
      return { result: String(content == null ? '' : content) };
    }
  };

  for (const m of messages) {
    if (m.role === 'tool') {
      push('user', [{
        functionResponse: { name: m.name, response: responseValue(m.content) }
      }]);
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      const parts = [];
      if (m.content) parts.push({ text: String(m.content) });
      for (const tc of m.toolCalls) parts.push({ functionCall: { name: tc.name, args: tc.arguments || {} } });
      out.push({ role: 'model', parts });
      continue;
    }
    push(m.role === 'assistant' ? 'model' : 'user', [{
      text: String(m.content == null ? '' : m.content)
    }]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Providers                                                            */
/* ------------------------------------------------------------------ */

class Provider {
  constructor(cfg) { this.cfg = cfg || {}; }
  get id() { throw new Error('not implemented'); }
  get needsKey() { return false; }
  get defaultModel() { return ''; }
  /** ttfb/idle deadlines, overridable per instance for tests and proxies. */
  get timeouts() {
    const base = TIMEOUTS[this.id] || { ttfb: 30000, idle: 45000 };
    const o = this.cfg.timeouts;
    if (!o) return base;
    return {
      ttfb: Number.isFinite(o.ttfb) ? o.ttfb : base.ttfb,
      idle: Number.isFinite(o.idle) ? o.idle : base.idle
    };
  }
  /** Resolved model, honouring an explicit override from settings. */
  get model() { return this.cfg.model || this.defaultModel; }
  async chat() { throw new Error('not implemented'); }
}

class AnthropicProvider extends Provider {
  constructor(cfg, key) { super(cfg); this.key = key; }
  get id() { return 'anthropic'; }
  get needsKey() { return true; }
  get defaultModel() { return 'claude-sonnet-4-5'; }
  get label() { return 'Anthropic'; }

  buildBody({ system, messages, tools, temperature, maxTokens, stream }) {
    const body = {
      model: this.model,
      max_tokens: maxTokens || 900,
      temperature: temperature === undefined ? 0.3 : temperature,
      system,
      messages: anthropicMessages(messages)
    };
    if (tools && tools.length) {
      body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }
    if (stream) body.stream = true;
    return body;
  }

  headers() {
    return {
      'content-type': 'application/json',
      'x-api-key': this.key,
      'anthropic-version': '2023-06-01'
    };
  }

  async chat({ system, messages, tools, temperature, maxTokens, signal, onDelta }) {
    const label = this.label;
    const body = this.buildBody({ system, messages, tools, temperature, maxTokens, stream: !!onDelta });

    const req = await open({
      url: 'https://api.anthropic.com/v1/messages',
      body, headers: this.headers(), provider: this.id, label, timeouts: this.timeouts, signal
    });

    try {
      if (!req.res.ok) throw await asHttpError(req.res, label);

      if (!onDelta) {
        const data = await readJson(req.res, label);
        if (!data || !Array.isArray(data.content)) throw malformedError(label, 'No content block was returned.');
        const textParts = [];
        const toolCalls = [];
        for (const block of data.content) {
          if (block.type === 'text') textParts.push(block.text);
          else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, arguments: block.input || {} });
        }
        return { text: textParts.join('\n').trim(), toolCalls, usage: data.usage || null, model: data.model || this.model };
      }

      const calls = new ToolCallBuffer();
      let text = '';
      let usage = null;

      for await (const line of streamLines(req.res, { provider: this.id, idleMs: this.timeouts.idle, signal })) {
        const payload = ssePayload(line);
        if (!payload) continue;
        let evt;
        try { evt = JSON.parse(payload); } catch (_) { continue; /* a split frame, not fatal */ }

        if (evt.type === 'error') {
          throw streamError(label, (evt.error && evt.error.message) || 'The provider reported an error mid-stream.');
        }
        if (evt.type === 'message_start' && evt.message) usage = evt.message.usage || usage;
        if (evt.type === 'content_block_start' && evt.content_block && evt.content_block.type === 'tool_use') {
          const s = calls.slot(evt.index || 0);
          s.id = evt.content_block.id || s.id;
          s.name = evt.content_block.name || '';
        }
        if (evt.type === 'content_block_delta' && evt.delta) {
          if (evt.delta.type === 'text_delta' && evt.delta.text) { text += evt.delta.text; onDelta(evt.delta.text); }
          else if (evt.delta.type === 'input_json_delta') calls.mergeJson(evt.index || 0, evt.delta.partial_json || '');
        }
        if (evt.type === 'message_delta' && evt.usage) usage = Object.assign({}, usage, evt.usage);
      }

      return { text: text.trim(), toolCalls: calls.list(), usage, model: this.model };
    } finally {
      req.close();
    }
  }
}

class OpenAIProvider extends Provider {
  constructor(cfg, key) { super(cfg); this.key = key; }
  get id() { return 'openai'; }
  get needsKey() { return true; }
  get defaultModel() { return 'gpt-4o-mini'; }
  get label() { return 'OpenAI'; }
  get base() { return (this.cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''); }

  buildBody({ system, messages, tools, temperature, maxTokens, stream }) {
    const wire = [{ role: 'system', content: system }].concat(openaiMessages(messages));
    const body = {
      model: this.model,
      messages: wire,
      temperature: temperature === undefined ? 0.3 : temperature,
      max_tokens: maxTokens || 900
    };
    if (tools && tools.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }
    if (stream) body.stream = true;
    return body;
  }

  headers() {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.key}` };
  }

  async chat({ system, messages, tools, temperature, maxTokens, signal, onDelta }) {
    const label = this.label;
    const body = this.buildBody({ system, messages, tools, temperature, maxTokens, stream: !!onDelta });

    const req = await open({
      url: `${this.base}/chat/completions`,
      body, headers: this.headers(), provider: this.id, label, timeouts: this.timeouts, signal
    });

    try {
      if (!req.res.ok) throw await asHttpError(req.res, label);

      if (!onDelta) {
        const data = await readJson(req.res, label);
        const choice = data && data.choices && data.choices[0];
        if (!choice || !choice.message) throw malformedError(label, 'No completion was returned.');
        const msg = choice.message;
        const toolCalls = (msg.tool_calls || []).map((tc, i) => ({
          id: tc.id || `call_${i}`,
          name: tc.function && tc.function.name,
          arguments: safeParse((tc.function && tc.function.arguments) || '{}')
        }));
        return {
          text: (msg.content || '').trim(),
          toolCalls,
          usage: data.usage || null,
          model: data.model || this.model
        };
      }

      const calls = new ToolCallBuffer();
      let text = '';
      let usage = null;

      for await (const line of streamLines(req.res, { provider: this.id, idleMs: this.timeouts.idle, signal })) {
        const payload = ssePayload(line);
        if (!payload) continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch (_) { continue; }

        if (chunk.error) throw streamError(label, (chunk.error.message || 'The provider reported an error mid-stream.'));
        if (chunk.usage) usage = chunk.usage;

        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) { text += delta.content; onDelta(delta.content); }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const index = tc.index === undefined ? calls.slots.length : tc.index;
            if (tc.id) calls.slot(index).id = tc.id;
            calls.mergeObject(index, tc.function, null);
            calls.mergeJson(index, tc.function && tc.function.arguments);
          }
        }
      }

      return { text: text.trim(), toolCalls: calls.list(), usage, model: this.model };
    } finally {
      req.close();
    }
  }
}

/* Gemini accepts an OpenAPI subset, not arbitrary JSON Schema. Convert the
 * registry's lowercase types and keep only the keywords it understands. */
function geminiSchema(schema) {
  const src = schema && typeof schema === 'object' ? schema : {};
  const type = String(src.type || 'object').toUpperCase();
  const out = { type };
  if (src.description) out.description = src.description;
  if (Array.isArray(src.enum) && src.enum.length) out.enum = src.enum.map(String);

  if (type === 'OBJECT') {
    out.properties = {};
    for (const key of Object.keys(src.properties || {})) {
      out.properties[key] = geminiSchema(src.properties[key]);
    }
    if (Array.isArray(src.required) && src.required.length) out.required = src.required.slice();
  } else if (type === 'ARRAY') {
    out.items = geminiSchema(src.items || {});
  } else if (type === 'NUMBER' || type === 'INTEGER') {
    if (Number.isFinite(src.minimum)) out.minimum = src.minimum;
    if (Number.isFinite(src.maximum)) out.maximum = src.maximum;
  } else if (type === 'STRING') {
    if (Number.isFinite(src.minLength)) out.minLength = src.minLength;
    if (Number.isFinite(src.maxLength)) out.maxLength = src.maxLength;
  }
  return out;
}

function geminiBlockReason(data) {
  const feedback = data && data.promptFeedback;
  if (feedback && feedback.blockReason) {
    return feedback.blockReasonMessage || feedback.blockReason;
  }
  const candidate = data && data.candidates && data.candidates[0];
  const reason = candidate && candidate.finishReason;
  if (reason === 'SAFETY' || reason === 'RECITATION' || reason === 'PROHIBITED_CONTENT' || reason === 'BLOCKLIST') {
    return reason;
  }
  return null;
}

class GeminiProvider extends Provider {
  constructor(cfg, key) { super(cfg); this.key = key; }
  get id() { return 'gemini'; }
  get needsKey() { return true; }
  get defaultModel() { return 'gemini-3.8-flash'; }
  get label() { return 'Gemini'; }
  get model() {
    return this.cfg.model || process.env.GEMINI_MODEL || this.defaultModel;
  }
  get modelId() { return String(this.model || '').trim().replace(/^models\//, ''); }
  get base() {
    return (this.cfg.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  }

  buildBody({ system, messages, tools, temperature, maxTokens }) {
    const body = {
      contents: geminiContents(messages),
      generationConfig: {
        temperature: temperature === undefined ? 0.3 : temperature,
        maxOutputTokens: maxTokens || 900
      }
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools && tools.length) {
      body.tools = [{
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description || '',
          parameters: geminiSchema(t.parameters)
        }))
      }];
    }
    return body;
  }

  headers() {
    return { 'content-type': 'application/json', 'x-goog-api-key': this.key };
  }

  /** Read text, tool calls and usage out of one Gemini response object. */
  readResponse(data) {
    const blocked = geminiBlockReason(data);
    if (blocked) throw new ProviderError(`Gemini blocked the request (${blocked}).`, 'E_AI_BLOCKED', this.id);

    const candidate = data && data.candidates && data.candidates[0];
    if (!candidate) throw malformedError(this.label, 'No candidate was returned.');
    const parts = candidate.content && candidate.content.parts;
    if (!Array.isArray(parts)) throw malformedError(this.label, 'No content parts were returned.');

    const calls = new ToolCallBuffer();
    let text = '';
    for (const part of parts) {
      if (part && typeof part.text === 'string') text += part.text;
      if (part && part.functionCall && part.functionCall.name) {
        calls.mergeObject(calls.slots.filter(Boolean).length, part.functionCall, part.functionCall.args || {});
      }
    }
    return { text, toolCalls: calls.list(), usage: data.usageMetadata || null, model: data.modelVersion || this.model };
  }

  async chat({ system, messages, tools, temperature, maxTokens, signal, onDelta }) {
    const label = this.label;
    const body = this.buildBody({ system, messages, tools, temperature, maxTokens });
    const stream = !!onDelta;
    const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';

    const req = await open({
      url: `${this.base}/models/${encodeURIComponent(this.modelId)}:${method}`,
      body, headers: this.headers(), provider: this.id, label, timeouts: this.timeouts, signal
    });

    try {
      if (!req.res.ok) throw await asHttpError(req.res, label);

      if (!stream) return this.readResponse(await readJson(req.res, label));

      const calls = new ToolCallBuffer();
      let text = '';
      let usage = null;

      for await (const line of streamLines(req.res, { provider: this.id, idleMs: this.timeouts.idle, signal })) {
        const payload = ssePayload(line);
        if (!payload) continue;
        let evt;
        try { evt = JSON.parse(payload); } catch (_) { continue; /* a split frame, not fatal */ }

        if (evt.error) {
          const code = evt.error.code === 429 ? 'E_AI_RATE_LIMIT' : 'E_AI_STREAM';
          throw streamError(label, evt.error.message || 'Gemini reported an error mid-stream.', code);
        }

        const blocked = geminiBlockReason(evt);
        if (blocked) throw new ProviderError(`Gemini blocked the request (${blocked}).`, 'E_AI_BLOCKED', this.id);

        const candidate = evt.candidates && evt.candidates[0];
        const parts = candidate && candidate.content && candidate.content.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part && typeof part.text === 'string' && part.text) {
              text += part.text;
              onDelta(part.text);
            }
            if (part && part.functionCall && part.functionCall.name) {
              calls.mergeObject(calls.slots.filter(Boolean).length, part.functionCall, part.functionCall.args || {});
            }
          }
        }
        if (evt.usageMetadata) usage = evt.usageMetadata;
      }

      return { text: text.trim(), toolCalls: calls.list(), usage, model: this.model };
    } finally {
      req.close();
    }
  }
}

class NullProvider extends Provider {
  get id() { return 'none'; }
  get needsKey() { return false; }
  get unavailable() { return true; }
  async chat() {
    throw new ProviderError('AI connection unavailable. Choose a provider in Settings.', 'E_NO_PROVIDER', 'none');
  }
}

function mockWait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Local provider for exercising the real renderer/main pipeline without a key.
 * Main only constructs it when --dev is active; ConfigStore and AIEngine both
 * refuse it in a production process.
 */
class MockProvider extends Provider {
  constructor(cfg) { super(cfg); this.calls = 0; }
  get id() { return 'mock'; }
  get needsKey() { return false; }
  get defaultModel() { return 'legion-mock'; }
  get label() { return 'Development mock'; }

  reply(prompt) {
    const heard = String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return `Mock link online. I received ${heard ? `"${heard}"` : 'your message'} and streamed this reply locally. No network request was made. You can now test typed messages, captions, speech, and state changes without a provider key.`;
  }

  async chat({ messages, signal, onDelta } = {}) {
    this.calls++;
    const lastUser = [...(messages || [])].reverse().find((m) => m && m.role === 'user');
    const prompt = lastUser ? lastUser.content : '';
    const text = this.reply(prompt);
    const chunks = text.match(/\S+\s*/g) || [text];
    const delay = Number.isFinite(this.cfg.chunkDelayMs) ? Math.max(0, this.cfg.chunkDelayMs) : 28;

    for (const chunk of chunks) {
      if (signal && signal.aborted) throw abortError();
      if (delay) await mockWait(delay, signal);
      if (onDelta) onDelta(chunk);
    }

    return {
      text,
      toolCalls: [],
      usage: {
        prompt_tokens: Math.max(1, Math.ceil(String(prompt || '').length / 4)),
        completion_tokens: Math.ceil(text.length / 4),
        total_tokens: Math.ceil((String(prompt || '').length + text.length) / 4)
      },
      model: this.model
    };
  }
}

const REGISTRY = {
  gemini: GeminiProvider,
  anthropic: AnthropicProvider,
  openai: OpenAIProvider,
  mock: MockProvider,
  none: NullProvider
};

function createProvider(id, cfg, secret) {
  const Ctor = REGISTRY[id];
  if (!Ctor) return new NullProvider();
  if (Ctor === GeminiProvider || Ctor === AnthropicProvider || Ctor === OpenAIProvider) {
    if (!secret) return new NullProvider();
    return new Ctor(cfg, secret);
  }
  return new Ctor(cfg);
}

module.exports = {
  createProvider,
  REGISTRY,
  Provider,
  MockProvider,
  ProviderError,
  mergeAlternating,
  anthropicMessages,
  openaiMessages,
  geminiContents,
  ssePayload,
  TIMEOUTS
};