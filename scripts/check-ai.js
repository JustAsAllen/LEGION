import { createProvider } from '../src/main/ai/providers.js';

const enabled = process.env.LEGION_LIVE_AI === '1';
if (!enabled) {
  console.log('SKIP  live AI check (set LEGION_LIVE_AI=1 to exercise local Ollama)');
  process.exit(0);
}

const cfg = {
  provider: 'ollama',
  model: process.env.LEGION_OLLAMA_MODEL || 'llama3.1',
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  temperature: 0,
  maxTokens: 80
};

const provider = createProvider('ollama', cfg, null);
const probe = await provider.available();
if (!probe.online) {
  console.error('FAIL  Ollama is not reachable at ' + cfg.baseUrl);
  process.exit(1);
}

const deltas = [];
const result = await provider.chat({
  system: 'Reply with exactly: LEGION online.',
  messages: [{ role: 'user', content: 'health check' }],
  tools: [],
  temperature: 0,
  maxTokens: 80,
  onDelta: (text) => deltas.push(text)
});

if (!result.text || !deltas.join('')) {
  console.error('FAIL  Ollama returned no streamed text');
  process.exit(1);
}

console.log('PASS  Ollama live turn streamed ' + deltas.length + ' delta(s) using ' + result.model);
