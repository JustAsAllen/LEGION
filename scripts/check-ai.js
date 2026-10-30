/**
 * AI pipeline checks.
 *
 * Two layers:
 *
 *   offline  the provider contract is exercised against a stubbed transport, so
 *            Gemini streaming, tool-call assembly, malformed bodies, timeouts
 *            and cancellation are verified on every machine, with no API key.
 *            This is the layer that catches regressions.
 *   live     LEGION_LIVE_AI=1 additionally drives the real Gemini endpoint.
 */

import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const { createProvider, mergeAlternating, ssePayload } = require('../src/main/ai/providers.js');
const { AIEngine } = require('../src/main/ai/engine.js');

let failures = 0;
let checks = 0;
const pass = (n, d) => { checks++; console.log(`  PASS ${n}${d ? ' -> ' + d : ''}`); };
const fail = (n, d) => { checks++; failures++; console.log(`  FAIL ${n} -> ${d}`); };
const check = (n, ok, d) => (ok ? pass(n, d) : fail(n, d));
const checkEq = (n, a, b) => check(n, a === b, a === b ? String(a) : `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

/* ------------------------------------------------------------------ */
/* Transport stub                                                       */
/* ------------------------------------------------------------------ */

const realFetch = globalThis.fetch;

/** Turn an array of strings into a chunked body reader. */
function streamOf(chunks, { delayMs = 0, never = false } = {}) {
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (never) return new Promise(() => {});
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          if (i >= chunks.length) return { done: true, value: undefined };
          const value = new TextEncoder().encode(chunks[i++]);
          return { done: false, value };
        },
        async cancel() {},
        releaseLock() {}
      };
    }
  };
}

function jsonResponse(obj, init = {}) {
  const text = JSON.stringify(obj);
  return {
    ok: init.ok !== false,
    status: init.status || 200,
    async text() { return text; },
    async json() { return JSON.parse(text); },
    body: init.body
  };
}

function sse(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

/** One streamed Gemini turn: optional text, optional function calls, then usage. */
function geminiTurn({ content = '', toolCalls = [], usage = { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } } = {}) {
  const parts = [];
  if (content) parts.push({ text: content });
  for (const c of toolCalls) parts.push(c);
  const events = [
    { candidates: [{ content: { parts: parts.length ? parts : [{ text: '' }] }, finishReason: 'STOP' }] }
  ];
  if (usage) events.push({ usageMetadata: usage });
  return streamOf([sse(events)]);
}

const call = (name, args = {}) => ({ functionCall: { name, args } });

/** Install a fetch stub for the duration of one call. */
async function withFetch(impl, fn) {
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

const chat = (extra = {}) => Object.assign({
  system: 'be brief',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  temperature: 0,
  maxTokens: 64
}, extra);

/* ------------------------------------------------------------------ */
/* Streaming across every provider                                      */
/* ------------------------------------------------------------------ */

async function streamingChecks() {
  console.log('\nprovider streaming (stubbed transport)');

  // Gemini: server-sent events with a usage frame after the candidate.
  {
    const body = sse([
      { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'lo' }] } }] },
      { candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } }
    ]);
    let seen = null;
    const deltas = [];
    const res = await withFetch(
      async (url, init) => { seen = { url, init }; return jsonResponse({}, { body: streamOf([body]) }); },
      () => createProvider('gemini', {}, 'g-key').chat(chat({ onDelta: (d) => deltas.push(d) }))
    );
    checkEq('gemini streams every chunk', deltas.join(''), 'Hello');
    checkEq('gemini reassembles the answer', res.text, 'Hello');
    check('gemini reports total usage', res.usage && res.usage.totalTokenCount === 5, JSON.stringify(res.usage));
    check('gemini uses the stream endpoint', /:streamGenerateContent\?alt=sse$/.test(seen.url), seen.url);
    check('gemini sends the key header', seen.init.headers['x-goog-api-key'] === 'g-key');
  }

  // Gemini function calls carry complete argument objects, not JSON fragments.
  {
    const body = sse([
      { candidates: [{ content: { parts: [call('get_time', { tz: 'UTC' })] }, finishReason: 'STOP' }] }
    ]);
    const res = await withFetch(
      async () => jsonResponse({}, { body: streamOf([body]) }),
      () => createProvider('gemini', {}, 'g-key').chat(chat({ onDelta: () => {} }))
    );
    const tc = res.toolCalls[0] || {};
    checkEq('gemini streamed tool name', tc.name, 'get_time');
    checkEq('gemini streamed tool args', tc.arguments && tc.arguments.tz, 'UTC');
    checkEq('gemini gives the call a stable id', tc.id, 'call_0');
  }

  // OpenAI: server-sent events, text plus fragmented JSON tool arguments.
  {
    const body = sse([
      { choices: [{ delta: { content: 'Hi ' } }] },
      { choices: [{ delta: { content: 'there' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] },
      { choices: [{ delta: {} }], usage: { total_tokens: 9 } }
    ]);
    const deltas = [];
    const res = await withFetch(
      async () => jsonResponse({}, { body: streamOf([body]) }),
      () => createProvider('openai', { model: 'gpt-4o-mini' }, 'sk-test').chat(chat({ onDelta: (d) => deltas.push(d) }))
    );
    checkEq('openai streams text', deltas.join(''), 'Hi there');
    checkEq('openai streams text again', res.text, 'Hi there');
    const call = res.toolCalls[0] || {};
    checkEq('openai assembles tool name', call.name, 'read_file');
    checkEq('openai reassembles split tool JSON', call.arguments && call.arguments.path, 'a.txt');
    check('openai keeps usage from the stream', res.usage && res.usage.total_tokens === 9, JSON.stringify(res.usage));
  }

  // Anthropic: typed SSE events, tool JSON delivered as partial_json deltas.
  {
    const body = sse([
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sure' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' thing' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'open_app', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"target"' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':"calc"}' } },
      { type: 'message_stop' }
    ]);
    const deltas = [];
    const res = await withFetch(
      async () => jsonResponse({}, { body: streamOf([body]) }),
      () => createProvider('anthropic', { model: 'claude-sonnet-4-5' }, 'sk-ant-test').chat(chat({ onDelta: (d) => deltas.push(d) }))
    );
    checkEq('anthropic streams text', deltas.join(''), 'Sure thing');
    const call = res.toolCalls[0] || {};
    checkEq('anthropic streams tool name', call.name, 'open_app');
    checkEq('anthropic reassembles partial_json', call.arguments && call.arguments.target, 'calc');
  }

  // A chunk boundary mid-frame must not lose data.
  {
    const frame = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'split' }] } }] })}\n\n`;
    const res = await withFetch(
      async () => jsonResponse({}, { body: streamOf([frame.slice(0, 20), frame.slice(20)]) }),
      () => createProvider('gemini', {}, 'g-key').chat(chat({ onDelta: () => {} }))
    );
    checkEq('a frame split across chunks is not dropped', res.text, 'split');
  }

  // The Gemini request must carry the documented shape: system instruction,
  // alternating model/user roles, generation config and uppercase tool schema.
  {
    let sent = null;
    await withFetch(
      async (_url, init) => { sent = JSON.parse(init.body); return jsonResponse({}, { body: geminiTurn({ content: 'ok' }) }); },
      () => createProvider('gemini', {}, 'g-key').chat(chat({
        system: 'be terse',
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
          { role: 'user', content: 'c' }
        ],
        tools: [{
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path' } }, required: ['path'] }
        }],
        onDelta: () => {}
      }))
    );
    checkEq('gemini sends a system instruction', sent.systemInstruction.parts[0].text, 'be terse');
    checkEq('gemini maps assistant turns to model', sent.contents.map((c) => c.role).join(','), 'user,model,user');
    checkEq('gemini sends the token budget', sent.generationConfig.maxOutputTokens, 64);
    const schema = sent.tools[0].functionDeclarations[0].parameters;
    checkEq('gemini uppercases the schema type', schema.type, 'OBJECT');
    checkEq('gemini uppercases property types', schema.properties.path.type, 'STRING');
    check('gemini keeps required fields', Array.isArray(schema.required) && schema.required[0] === 'path', JSON.stringify(schema.required));
  }
}

/* ------------------------------------------------------------------ */
/* Non-streaming tool calls must not regress                             */
/* ------------------------------------------------------------------ */

async function nonStreamingChecks() {
  console.log('\nprovider without streaming');

  {
    const res = await withFetch(
      async () => jsonResponse({
        content: [
          { type: 'text', text: 'reading' },
          { type: 'tool_use', id: 'toolu_9', name: 'read_file', input: { path: 'b.txt' } }
        ],
        usage: { input_tokens: 3 },
        model: 'claude-sonnet-4-5'
      }),
      () => createProvider('anthropic', {}, 'sk-ant-test').chat(chat())
    );
    checkEq('anthropic non-stream text', res.text, 'reading');
    checkEq('anthropic non-stream tool name', res.toolCalls[0].name, 'read_file');
    checkEq('anthropic non-stream tool args', res.toolCalls[0].arguments.path, 'b.txt');
  }

  {
    const res = await withFetch(
      async () => jsonResponse({
        choices: [{ message: { content: 'ok', tool_calls: [{ id: 'c', function: { name: 'list_dir', arguments: '{"path":"."}' } }] } }],
        model: 'gpt-4o-mini'
      }),
      () => createProvider('openai', {}, 'sk-test').chat(chat())
    );
    checkEq('openai non-stream tool name', res.toolCalls[0].name, 'list_dir');
    checkEq('openai non-stream parses tool JSON', res.toolCalls[0].arguments.path, '.');
  }

  {
    const res = await withFetch(
      async () => jsonResponse({
        candidates: [{ content: { parts: [{ text: 'reading' }, call('read_file', { path: 'b.txt' })] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 4 },
        modelVersion: 'gemini-3.8-flash'
      }),
      () => createProvider('gemini', {}, 'g-key').chat(chat())
    );
    checkEq('gemini non-stream text', res.text, 'reading');
    checkEq('gemini non-stream tool name', res.toolCalls[0].name, 'read_file');
    checkEq('gemini non-stream tool args', res.toolCalls[0].arguments.path, 'b.txt');
    checkEq('gemini reports its resolved model', res.model, 'gemini-3.8-flash');
  }
}

/* ------------------------------------------------------------------ */
/* Failure modes                                                        */
/* ------------------------------------------------------------------ */

async function failureChecks() {
  console.log('\nfailure handling');

  {
    const err = await withFetch(
      async () => jsonResponse({ error: { message: 'bad key' } }, { ok: false, status: 401 }),
      () => createProvider('openai', {}, 'sk-test').chat(chat()).then(() => null, (e) => e)
    );
    checkEq('an authentication failure is its own code', err && err.code, 'E_AI_AUTH');
    check('an HTTP failure keeps the detail', /401/.test(err.message), err && err.message.slice(0, 60));
  }

  {
    const err = await withFetch(
      async () => ({
        ok: false, status: 429,
        headers: { get: (name) => (name === 'retry-after' ? '12' : null) },
        async text() { return '{"error":{"message":"slow down"}}'; }
      }),
      () => createProvider('gemini', {}, 'g-key').chat(chat()).then(() => null, (e) => e)
    );
    checkEq('a rate limit is its own code', err && err.code, 'E_AI_RATE_LIMIT');
    checkEq('a rate limit keeps retry-after', err && err.retryAfter, '12');
  }

  for (const id of ['gemini', 'openai', 'anthropic']) {
    const err = await withFetch(
      async () => ({ ok: true, status: 200, async text() { return '{not json'; }, body: null }),
      () => createProvider(id, {}, 'k').chat(chat()).then(() => null, (e) => e)
    );
    checkEq(`${id} rejects an unreadable body`, err && err.code, 'E_AI_MALFORMED');
  }

  {
    const err = await withFetch(
      async () => jsonResponse({ choices: [] }),
      () => createProvider('openai', {}, 'k').chat(chat()).then(() => null, (e) => e)
    );
    checkEq('openai rejects a body with no completion', err && err.code, 'E_AI_MALFORMED');
  }

  {
    const err = await withFetch(
      async () => jsonResponse({ hello: 'there' }),
      () => createProvider('anthropic', {}, 'k').chat(chat()).then(() => null, (e) => e)
    );
    checkEq('anthropic rejects a body with no content block', err && err.code, 'E_AI_MALFORMED');
  }

  {
    const err = await withFetch(
      async () => jsonResponse({ candidates: [] }),
      () => createProvider('gemini', {}, 'k').chat(chat()).then(() => null, (e) => e)
    );
    checkEq('gemini rejects a body with no candidate', err && err.code, 'E_AI_MALFORMED');
  }

  {
    const err = await withFetch(
      async () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'blocked prompt' } }),
      () => createProvider('gemini', {}, 'k').chat(chat()).then(() => null, (e) => e)
    );
    checkEq('gemini reports a blocked prompt', err && err.code, 'E_AI_BLOCKED');
  }

  // Never answering the request at all.
  {
    const err = await withFetch(
      () => new Promise(() => {}),
      () => createProvider('gemini', { timeouts: { ttfb: 120 } }, 'g-key').chat(chat()).then(() => null, (e) => e)
    );
    checkEq('a silent provider times out', err && err.code, 'E_AI_TIMEOUT');
    check('the timeout message names the deadline', /1 second|0 seconds/.test(err.message) || /respond within/.test(err.message), err && err.message);
  }

  // Headers arrive, then the stream stalls.
  {
    const err = await withFetch(
      async () => jsonResponse({}, { body: streamOf([], { never: true }) }),
      () => createProvider('gemini', { timeouts: { ttfb: 500, idle: 120 } }, 'g-key')
        .chat(chat({ onDelta: () => {} })).then(() => null, (e) => e)
    );
    checkEq('a stalled stream times out', err && err.code, 'E_AI_TIMEOUT');
  }

  // The socket dies mid-stream.
  {
    const err = await withFetch(
      async () => jsonResponse({}, {
        body: { getReader() { return { async read() { throw new Error('socket hang up'); }, async cancel() {}, releaseLock() {} }; } }
      }),
      () => createProvider('openai', {}, 'k').chat(chat({ onDelta: () => {} })).then(() => null, (e) => e)
    );
    check('a dropped stream reports a connection failure', !!err, err && err.message);
  }

  // A refused connection must not masquerade as a provider-specific code.
  {
    const err = await withFetch(async () => { throw new Error('connect ECONNREFUSED'); },
      () => createProvider('gemini', {}, 'g-key').chat(chat()).then(() => null, (e) => e));
    checkEq('a refused connection is E_AI_CONN', err && err.code, 'E_AI_CONN');
  }

  {
    const err = await createProvider('none', {}, null).chat(chat()).then(() => null, (e) => e);
    checkEq('no provider configured is its own code', err && err.code, 'E_NO_PROVIDER');
  }

  {
    check('a missing key falls back to the null provider', createProvider('gemini', {}, null).id === 'none');
    check('a missing key falls back for openai too', createProvider('openai', {}, null).id === 'none');
    check('a missing key falls back for anthropic too', createProvider('anthropic', {}, null).id === 'none');
    check('an unknown provider falls back safely', createProvider('skynet', {}, 'k').id === 'none');
  }
}

/* ------------------------------------------------------------------ */
/* Cancellation                                                         */
/* ------------------------------------------------------------------ */

async function cancelChecks() {
  console.log('\ncancellation');

  for (const id of ['gemini', 'openai', 'anthropic']) {
    const controller = new AbortController();
    let abortedAt = 0;
    const started = Date.now();

    const promise = withFetch(
      async (_url, init) => {
        init.signal.addEventListener('abort', () => { abortedAt = Date.now(); });
        return jsonResponse({}, {
          body: { getReader() { return { async read() { return new Promise(() => {}); }, async cancel() {}, releaseLock() {} }; } }
        });
      },
      () => createProvider(id, { timeouts: { ttfb: 5000, idle: 5000 } }, 'k').chat(chat({ onDelta: () => {}, signal: controller.signal }))
    ).then(() => 'resolved', (e) => (e && e.name === 'AbortError' ? 'aborted' : 'other'));

    setTimeout(() => controller.abort(), 60);
    const outcome = await promise;
    const elapsed = Date.now() - started;

    checkEq(`${id} stops when cancelled`, outcome, 'aborted');
    check(`${id} cancel is immediate, not an idle timeout`, elapsed < 2000, `${elapsed}ms`);
    check(`${id} aborts the live socket`, abortedAt > 0, abortedAt ? `${abortedAt - started}ms` : 'socket never saw the abort');
  }

  {
    const controller = new AbortController();
    controller.abort();
    const err = await withFetch(async () => jsonResponse({}),
      () => createProvider('openai', {}, 'k').chat(chat({ signal: controller.signal })).then(() => null, (e) => e));
    check('an already cancelled request never reaches the network', !!err, err && err.name);
  }
}

/* ------------------------------------------------------------------ */
/* Wire-format helpers                                                  */
/* ------------------------------------------------------------------ */

function helperChecks() {
  console.log('\nhelpers');
  const merged = mergeAlternating([
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: 'c' }
  ]);
  checkEq('adjacent user turns merge', merged.length, 2);
  check('the merged turn keeps both parts', /a/.test(merged[0].content) && /b/.test(merged[0].content), merged[0].content);

  check('event names are not payloads', ssePayload('event: message_start') === null);
  check('a done sentinel is not a payload', ssePayload('data: [DONE]') === null);
  check('a data line is a payload', ssePayload('data: {"a":1}') === '{"a":1}');
}

/* ------------------------------------------------------------------ */
/* Engine: tool loop, context, cancel                                   */
/* ------------------------------------------------------------------ */

function stubDeps(overrides = {}) {
  const state = { appended: [], executed: [] };
  const deps = Object.assign({
    settings: { get: () => ({ ai: { provider: 'gemini', model: 'gemini-3.8-flash', temperature: 0, maxTokens: 64, contextTurns: 4 }, memory: { enabled: true, longTermEnabled: false }, privacy: { redactSecrets: true } }) },
    secrets: { get: () => 'test-key', status: () => ({ configured: true, source: 'test' }) },
    memory: {
      appended: state.appended,
      config: { longTermEnabled: false },
      list: () => [],
      context: () => state.appended.map((m) => ({ role: m.role, text: m.text })),
      appendMessage(role, text, extra) { state.appended.push({ role, text, ...(extra || {}) }); }
    },
    toolManager: {
      catalogue: () => [{ name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} } }],
      async execute(name, args) {
        state.executed.push({ name, args });
        if (name === 'boom') { const e = new Error('tool exploded'); e.code = 'E_TOOL'; throw e; }
        return { result: { pong: name } };
      }
    },
    onEvent: () => {}
  }, overrides);
  return { deps, state };
}

async function mockChecks() {
  console.log('\ndev mock provider');

  {
    const provider = createProvider('mock', { chunkDelayMs: 0 }, null);
    checkEq('the mock needs no key', provider.id, 'mock');
    let fetched = 0;
    const deltas = [];
    const res = await withFetch(
      async () => { fetched++; throw new Error('the mock must not use the network'); },
      () => provider.chat(chat({ onDelta: (t) => deltas.push(t) }))
    );
    checkEq('the mock never touches fetch', fetched, 0);
    check('the mock streams more than one chunk', deltas.length > 1, String(deltas.length));
    checkEq('the mock joins its deltas into the reply', deltas.join(''), res.text);
    check('the mock returns a reply', /Mock link online/.test(res.text), res.text.slice(0, 40));
    checkEq('the mock reports its model', res.model, 'legion-mock');
    checkEq('the mock makes no tool calls', res.toolCalls.length, 0);
  }

  {
    const provider = createProvider('mock', { chunkDelayMs: 40 }, null);
    const controller = new AbortController();
    const pending = provider.chat(chat({ signal: controller.signal, onDelta: () => {} }))
      .then(() => null, (e) => e);
    setTimeout(() => controller.abort(), 30);
    const err = await pending;
    checkEq('the mock honours cancellation', err && err.name, 'AbortError');
  }

  {
    const events = [];
    const { deps, state } = stubDeps({
      isDev: true,
      settings: { get: () => ({ ai: { provider: 'mock', model: '', temperature: 0, maxTokens: 64, contextTurns: 4 }, memory: { enabled: true, longTermEnabled: false }, privacy: { redactSecrets: true } }) },
      secrets: { get: () => null, status: () => ({ configured: false, source: 'none' }) },
      onEvent: (type, payload) => events.push({ type, payload })
    });
    const engine = new AIEngine(deps);
    check('dev mock status is ready', engine.status().ready === true, JSON.stringify(engine.status()));
    let fetched = 0;
    const res = await withFetch(
      async () => { fetched++; throw new Error('the engine mock must not use the network'); },
      () => engine.respond('Hello LEGION')
    );
    checkEq('the engine never touches fetch for the mock', fetched, 0);
    check('the mock reaches the engine reply', /Mock link online/.test(res.text), res.text.slice(0, 40));
    check('the mock reaches engine deltas', events.filter((e) => e.type === 'delta').length > 1);
    check('the mock reaches response chunks', events.filter((e) => e.type === 'response-chunk').length > 0);
    checkEq('the mock turn is remembered', state.appended.length, 2);
  }

  {
    const { deps } = stubDeps({
      isDev: false,
      settings: { get: () => ({ ai: { provider: 'mock', model: '', temperature: 0, maxTokens: 64, contextTurns: 4 }, memory: { enabled: true, longTermEnabled: false }, privacy: { redactSecrets: true } }) },
      secrets: { get: () => null, status: () => ({ configured: false, source: 'none' }) }
    });
    const engine = new AIEngine(deps);
    checkEq('production refuses the mock in status', engine.status().provider, 'none');
    const err = await engine.respond('Hello LEGION').then(() => null, (e) => e);
    checkEq('production refuses the mock at call time', err && err.code, 'E_NO_PROVIDER');
  }
}

async function engineChecks() {
  console.log('\nengine');

  // A plain answer with no tools.
  {
    const { deps, state } = stubDeps();
    await withFetch(
      async () => jsonResponse({}, { body: geminiTurn({ content: 'hello there' }) }),
      () => new AIEngine(deps).respond('hi')
    );
    checkEq('a plain turn is answered', state.appended.length, 2);
    checkEq('the reply is remembered', state.appended[1].text, 'hello there');
    checkEq('no tool ran on a plain turn', state.executed.length, 0);
  }

  // A tool call must be executed and fed back, then summarised.
  {
    const { deps, state } = stubDeps();
    let round = 0;
    const res = await withFetch(
      async () => (++round === 1
        ? jsonResponse({}, { body: geminiTurn({ toolCalls: [call('ping', { n: 1 })] }) })
        : jsonResponse({}, { body: geminiTurn({ content: 'all done' }) })),
      () => new AIEngine(deps).respond('ping please')
    );
    checkEq('the tool ran once', state.executed.length, 1);
    checkEq('the tool arguments reached the registry', state.executed[0].args.n, 1);
    checkEq('the tool name reached the registry', state.executed[0].name, 'ping');
    checkEq('the turn finished with the summary', res.text, 'all done');
    checkEq('the result lists the tool', res.tools.length, 1);
    check('the tool result is marked successful', res.tools[0].ok === true, JSON.stringify(res.tools[0]));
  }

  // A failing tool must be reported to the model, not thrown away.
  {
    const { deps, state } = stubDeps();
    let round = 0;
    const res = await withFetch(
      async () => (++round === 1
        ? jsonResponse({}, { body: geminiTurn({ toolCalls: [call('boom')] }) })
        : jsonResponse({}, { body: geminiTurn({ content: 'that failed' }) })),
      () => new AIEngine(deps).respond('break it')
    );
    check('a failing tool does not kill the turn', res.text === 'that failed', res.text);
    check('the failure is marked in the result', res.tools[0] && res.tools[0].ok === false, JSON.stringify(res.tools[0]));
  }

  // Tool events must be emitted for the renderer.
  {
    const events = [];
    const { deps } = stubDeps({ onEvent: (type, payload) => events.push({ type, payload }) });
    let round = 0;
    await withFetch(
      async () => (++round === 1
        ? jsonResponse({}, { body: geminiTurn({ toolCalls: [call('ping')] }) })
        : jsonResponse({}, { body: geminiTurn({ content: 'done' }) })),
      () => new AIEngine(deps).respond('go')
    );
    check('a tool start event is emitted', events.some((e) => e.type === 'tool' && e.payload.phase === 'start'));
    check('a tool end event is emitted', events.some((e) => e.type === 'tool' && e.payload.phase === 'end'));
  }

  // Deltas must reach the renderer.
  {
    const deltas = [];
    const chunks = [];
    const { deps } = stubDeps({ onEvent: (type, payload) => {
      if (type === 'delta') deltas.push(payload.text);
      if (type === 'response-chunk') chunks.push(payload.text);
    } });
    await withFetch(
      async () => jsonResponse({}, { body: streamOf([sse([
        { candidates: [{ content: { parts: [{ text: 'str' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'eam' }] } }] }
      ])]) }),
      () => new AIEngine(deps).respond('go')
    );
    checkEq('deltas are emitted in order', deltas.join(''), 'stream');
    checkEq('a completed response chunk is emitted', chunks.join(''), 'stream');
  }

  // The newest user message must always be the last turn sent.
  {
    let sent = null;
    const { deps } = stubDeps();
    await withFetch(
      async (_url, init) => {
        sent = JSON.parse(init.body);
        return jsonResponse({}, { body: geminiTurn({ content: 'ok' }) });
      },
      () => new AIEngine(deps).respond('the newest prompt')
    );
    const turns = sent.contents;
    const last = turns[turns.length - 1];
    checkEq('the newest prompt is the final user turn', last.parts[0].text, 'the newest prompt');
    checkEq('the newest prompt keeps the user role', last.role, 'user');
    check('a system prompt is always sent', !!(sent.systemInstruction && sent.systemInstruction.parts[0].text), JSON.stringify(sent.systemInstruction && sent.systemInstruction.parts[0]));
  }

  // Cancelling a live turn must surface as E_ABORTED.
  {
    const { deps } = stubDeps();
    const engine = new AIEngine(deps);
    const pending = withFetch(
      async () => jsonResponse({}, { body: streamOf([], { never: true }) }),
      () => engine.respond('stop me').then(() => null, (e) => e)
    );
    setTimeout(() => engine.cancel(), 50);
    const err = await pending;
    checkEq('a cancelled turn reports E_ABORTED', err && err.code, 'E_ABORTED');
    check('a cancelled turn is flagged as aborted', !!(err && err.aborted), JSON.stringify(err && err.code));
  }

  // An unconfigured provider with no local fallback must say so.
  {
    const { deps } = stubDeps({
      settings: { get: () => ({ ai: { provider: 'none', model: '', temperature: 0, maxTokens: 64, contextTurns: 4 }, memory: { enabled: true, longTermEnabled: false } }) }
    });
    const err = await withFetch(async () => { throw new Error('refused'); },
      () => new AIEngine(deps).respond('hi').then(() => null, (e) => e));
    checkEq('no provider reports E_NO_PROVIDER', err && err.code, 'E_NO_PROVIDER');
  }

  // A provider missing its key must be refused before any request.
  {
    const { deps } = stubDeps({
      settings: { get: () => ({ ai: { provider: 'openai', model: 'gpt-4o-mini', temperature: 0, maxTokens: 64, contextTurns: 4 }, memory: { enabled: true, longTermEnabled: false } }) },
      secrets: { get: () => null, status: () => ({ configured: false, source: 'none' }) }
    });
    const err = await new AIEngine(deps).respond('hi').then(() => null, (e) => e);
    checkEq('a missing key is refused', err && err.code, 'E_NO_KEY');
  }
}

/* ------------------------------------------------------------------ */
/* Config migration                                                     */
/* ------------------------------------------------------------------ */

function configMigrationChecks() {
  console.log('\nconfig migration');
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { ConfigStore } = require('../src/main/config.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legion-ai-config-'));
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({
      onboarded: true,
      ai: { provider: 'ollama', model: 'llama3.1', baseUrl: 'http://127.0.0.1:11434/v1', temperature: 0.2 }
    }));
    const store = new ConfigStore(dir);
    const settings = store.get();
    checkEq('a saved Ollama provider migrates to Gemini', settings.ai.provider, 'gemini');
    checkEq('the retired local model is cleared', settings.ai.model, '');
    checkEq('the retired local endpoint is cleared', settings.ai.baseUrl, '');
    checkEq('unrelated settings survive migration', settings.ai.temperature, 0.2);
    checkEq('the migrated file is written back', JSON.parse(fs.readFileSync(file, 'utf8')).ai.provider, 'gemini');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const devDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legion-ai-mock-config-'));
  try {
    const dev = new ConfigStore(devDir, { allowMock: true });
    dev.patch({ ai: { provider: 'mock' } });
    dev.saveNow();
    checkEq('a dev profile can select the mock', dev.get().ai.provider, 'mock');
    const prod = new ConfigStore(devDir);
    checkEq('a production load rewrites the mock to none', prod.get().ai.provider, 'none');
  } finally {
    fs.rmSync(devDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Live layer                                                           */
/* ------------------------------------------------------------------ */

async function liveChecks() {
  const enabled = process.env.LEGION_LIVE_AI === '1';
  console.log('');
  if (!enabled) {
    console.log('SKIP  live Gemini turn (set LEGION_LIVE_AI=1 and GEMINI_API_KEY to exercise the real model)');
    return;
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    fail('gemini key is present', 'set GEMINI_API_KEY to run the live layer');
    return;
  }

  const cfg = {
    model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
    temperature: 0,
    maxTokens: 80
  };

  const provider = createProvider('gemini', cfg, key);
  const deltas = [];
  try {
    const result = await provider.chat(Object.assign(chat(), { onDelta: (text) => deltas.push(text) }));
    if (!result.text || !deltas.join('')) fail('gemini streams a live turn', 'no text');
    else pass('gemini streams a live turn', `${deltas.length} delta(s) on ${result.model}`);
  } catch (err) {
    fail('gemini streams a live turn', err && err.message);
  }
}

/* ------------------------------------------------------------------ */

console.log('AI pipeline');
await helperChecks();
await streamingChecks();
await nonStreamingChecks();
await failureChecks();
await cancelChecks();
await mockChecks();
await engineChecks();
await configMigrationChecks();
await liveChecks();

console.log(`\n${checks - failures}/${checks} ai checks passed`);
process.exit(failures ? 1 : 0);