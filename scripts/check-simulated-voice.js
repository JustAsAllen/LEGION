/**
 * End-to-end check of the development-only simulated voice path.
 *
 * Launches the real renderer on an isolated --dev profile, starts a simulated
 * utterance without a microphone, and proves it enters the same post-STT path:
 * LISTENING -> user transcript -> mock provider -> assistant reply -> mock TTS
 * -> SPEAKING -> IDLE. It also proves a typed turn speaks, and that a speech
 * failure leaves the reply and the state machine intact.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9338;
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'legion-sim-voice-'));
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DEV_PROFILE = path.join(APPDATA, 'LEGION', 'dev');
const BACKED_UP = [];
const MISSING = [];

fs.mkdirSync(DEV_PROFILE, { recursive: true });
for (const name of ['settings.json', 'secrets.json', 'transcript.jsonl']) {
  const src = path.join(DEV_PROFILE, name);
  if (!fs.existsSync(src)) { MISSING.push(src); continue; }
  const dst = path.join(TMP, name);
  fs.copyFileSync(src, dst);
  BACKED_UP.push({ name, src, dst });
}

fs.writeFileSync(path.join(DEV_PROFILE, 'settings.json'), JSON.stringify({
  version: 1,
  onboarded: true,
  ai: { provider: 'mock', model: '', baseUrl: '' },
  voice: { continuous: false, pushToTalk: true, wakeWordEnabled: false, ttsMode: 'auto', mockTts: true },
  visual: { quality: 'low', showWaveform: false, bloom: false, showScanlines: false }
}, null, 2));

let failures = 0;
const pass = (name, detail) => console.log(`  PASS ${name}${detail ? ' -> ' + detail : ''}`);
const fail = (name, detail) => { failures++; console.log(`  FAIL ${name} -> ${detail}`); };
const check = (name, ok, detail) => (ok ? pass(name, detail) : fail(name, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        this.logs.push(`[${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.logs.push('[exception] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }
}

async function connect() {
  const target = await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = await res.json();
    return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  }, 40000, 'devtools target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('cdp socket failed')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  return cdp;
}

const readUi = `(() => {
  const a = window.legionApp;
  const lastUser = a ? [...a.memory.session].reverse().find((m) => m.role === 'user') : null;
  const lastReply = a ? [...a.memory.session].reverse().find((m) => m.role === 'assistant') : null;
  return {
    dev: a?.info?.isDev === true,
    provider: a?.config?.ai?.provider || null,
    mockTts: a?.config?.voice?.mockTts === true,
    state: a ? a.store.state : null,
    busy: a ? a.busy : null,
    mic: a ? a.audio.micActive : null,
    speaking: a ? a.audio.ttsPlaying === true : null,
    assistantCount: a ? a.memory.session.filter((m) => m.role === 'assistant').length : 0,
    speechStates: Array.isArray(window.__speechStates) ? [...window.__speechStates] : [],
    warned: !!document.querySelector('.toast.warn'),
    user: lastUser ? lastUser.text : null,
    reply: lastReply ? lastReply.text : null
  };
})()`;

async function main() {
  console.log('simulated voice check\n');
  const child = spawn(EXE, ['.', '--dev', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  });

  let cdp;
  try {
    cdp = await connect();
    await waitFor(() => cdp.eval(`!!(window.legionApp && window.legionApp.info && window.legionApp.config)`), 60000, 'the app shell');
    await waitFor(() => cdp.eval(`(() => {
      const b = document.getElementById('boot');
      return document.body.classList.contains('is-ready') && !!b && b.classList.contains('is-gone') && window.legionApp.store.state === 'IDLE';
    })()`), 60000, 'the boot sequence');

    const ready = await cdp.eval(readUi);
    check('the test profile opens in development mode', ready.dev === true, `isDev=${ready.dev}`);
    check('the mock provider is selected', ready.provider === 'mock', String(ready.provider));
    check('the microphone starts closed', ready.mic === false, String(ready.mic));

    check('the mock voice is enabled in the dev profile', ready.mockTts === true, String(ready.mockTts));
    await cdp.eval(`(() => {
      const a = window.legionApp;
      window.__speechStates = [];
      a.store.addEventListener('state', (e) => window.__speechStates.push(e.detail.next));
      return true;
    })()`);

    await cdp.eval(`(() => {
      const a = window.legionApp;
      window.__simResult = null;
      window.__simPromise = a.simulateVoice('Hello LEGION', { delayMs: 1200 }).then((r) => {
        window.__simResult = r;
        return r;
      });
      return true;
    })()`);

    await sleep(250);
    const listening = await cdp.eval(readUi);
    check('simulated voice enters LISTENING', listening.state === 'LISTENING', String(listening.state));
    check('simulated voice does not open the microphone', listening.mic === false, String(listening.mic));

    const started = await cdp.eval(`window.__simPromise`);
    const accepted = await cdp.eval(readUi);
    check('the simulated transcript is accepted', started?.ok === true && started?.transcript === 'Hello LEGION',
      JSON.stringify(started));
    check('the transcript enters the normal conversation memory', accepted.user === 'Hello LEGION', String(accepted.user));

    const finished = await waitFor(async () => {
      const ui = await cdp.eval(readUi);
      return ui.busy === false && ui.reply ? ui : null;
    }, 25000, 'the mock reply').catch(() => null);
    check('the simulated voice turn produces an assistant reply', !!finished, finished?.reply || 'no reply');
    check('the simulated reply actually speaks', finished?.speechStates.includes('SPEAKING') === true,
      finished?.speechStates.join(' -> ') || 'no state log');
    check('the turn returns to IDLE', finished?.state === 'IDLE', String(finished?.state));
    check('mock playback has stopped after the turn', finished?.speaking === false, String(finished?.speaking));
    check('speech does not put the app in ERROR', finished?.speechStates.includes('ERROR') === false,
      finished?.speechStates.join(' -> ') || 'no state log');
    check('the microphone is still closed after the turn', finished?.mic === false, String(finished?.mic));

    const beforeTyped = await cdp.eval(`(() => {
      const a = window.legionApp;
      window.__speechStates = [];
      return { assistant: a.memory.session.filter((m) => m.role === 'assistant').length };
    })()`);
    const typedStarted = await cdp.eval(`window.legionApp.sendText('Hello LEGION')`);
    const typed = await waitFor(async () => {
      const ui = await cdp.eval(readUi);
      return ui.busy === false && ui.assistantCount > beforeTyped.assistant && ui.state === 'IDLE' ? ui : null;
    }, 25000, 'the typed reply and speech').catch(() => null);
    check('a typed Hello LEGION is accepted', typedStarted === true, String(typedStarted));
    check('the typed turn produces a reply', !!typed, typed?.reply || 'no reply');
    check('the typed reply leaves the transcript visible', typed?.user === 'Hello LEGION' && !!typed?.reply,
      `${typed?.user || 'no user'} / ${typed?.reply || 'no reply'}`);
    check('the typed reply reaches SPEAKING', typed?.speechStates.includes('SPEAKING') === true,
      typed?.speechStates.join(' -> ') || 'no state log');
    check('the typed turn returns to IDLE', typed?.state === 'IDLE', String(typed?.state));
    check('the typed reply does not put the app in ERROR', typed?.speechStates.includes('ERROR') === false,
      typed?.speechStates.join(' -> ') || 'no state log');

    const beforeFailure = await cdp.eval(`(() => {
      const a = window.legionApp;
      window.__voiceApi = a.apiVoice;
      a.apiVoice = {
        speak: async () => ({ ok: false, error: { code: 'E_TTS_TEST', message: 'Synthetic speech failure.' } }),
        speechEnd: async () => ({ ok: true }),
        speechCancel: async () => ({ ok: true })
      };
      window.__speechStates = [];
      return { assistant: a.memory.session.filter((m) => m.role === 'assistant').length };
    })()`);
    await cdp.eval(`window.legionApp.sendText('Hello LEGION')`);
    const failedSpeech = await waitFor(async () => {
      const ui = await cdp.eval(readUi);
      return ui.busy === false && ui.assistantCount > beforeFailure.assistant && ui.state === 'IDLE' ? ui : null;
    }, 25000, 'the reply after a speech failure').catch(() => null);
    check('a speech failure still produces the reply', !!failedSpeech, failedSpeech?.reply || 'no reply');
    check('a speech failure does not enter ERROR', failedSpeech?.state === 'IDLE' && failedSpeech?.speechStates.includes('ERROR') === false,
      `${failedSpeech?.state || 'none'} / ${(failedSpeech?.speechStates || []).join(' -> ') || 'no state log'}`);
    check('a speech failure shows a warning, not an error', failedSpeech?.warned === true, String(failedSpeech?.warned));
    await cdp.eval(`(() => { window.legionApp.apiVoice = window.__voiceApi; return true; })()`);

    const bad = cdp.logs.filter((l) => l.startsWith('[exception]') || l.startsWith('[error]'));
    check('no renderer exceptions or errors', bad.length === 0, bad.join(' | ') || 'clean');

    console.log(failures ? `\n${failures} check(s) failed` : '\nall simulated voice checks passed');
  } catch (err) {
    fail('harness', err.message);
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    await sleep(1200);
    for (const f of BACKED_UP) {
      try { fs.copyFileSync(f.dst, f.src); } catch { /* restore best effort */ }
    }
    for (const f of MISSING) {
      try { fs.rmSync(f, { force: true }); } catch { /* restore best effort */ }
    }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp cleanup */ }
  }
  process.exit(failures ? 1 : 0);
}

main();
