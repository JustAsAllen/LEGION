/**
 * Dynamic Island smoke check.
 *
 * Launches LEGION in development mode, enables the island through the real
 * bridge, then connects a second CDP session to the island page and verifies
 * that it mirrors state, expands, pins, and collapses without touching the
 * main shell.
 *
 *   node scripts/check-island.js
 */
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9337;
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

let failures = 0;
const pass = (n, d) => console.log(`  PASS ${n}${d ? ' -> ' + d : ''}`);
const fail = (n, d) => { failures++; console.log(`  FAIL ${n} -> ${d}`); };
const check = (n, ok, d) => (ok ? pass(n, d) : fail(n, d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    this.console = []; this.exceptions = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
        this.console.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)); }, 40000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

async function targets() {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
    .filter((x) => x.type === 'page' && x.webSocketDebuggerUrl);
}

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = e.message; }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (last: ${last})` : ''}`);
}

async function connect(match) {
  const t = await waitFor(async () => (await targets()).find(match), 40000, 'devtools target');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('cdp socket failed')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  return cdp;
}

async function main() {
  console.log('dynamic island smoke check\n');

  const child = spawn(EXE, ['.', '--dev', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  });

  let mainCdp;
  let islandCdp;
  try {
    mainCdp = await connect((t) => /\/index\.html$/.test(t.url));
    await waitFor(() => mainCdp.eval(`!!(window.legion && window.legion.island)`), 60000, 'bridge');

    const before = await mainCdp.eval(`window.legion.island.status()`);
    check('island starts disabled', before && before.enabled === false && before.visible === false,
      JSON.stringify(before));

    const shown = await mainCdp.eval(`window.legion.island.show()`);
    check('island can be enabled from the bridge', shown && shown.enabled === true, JSON.stringify(shown));

    islandCdp = await connect((t) => /\/island\.html$/.test(t.url));
    await waitFor(() => islandCdp.eval(`!!(window.legion && document.getElementById('island'))`), 20000, 'island renderer');

    const snap = await islandCdp.eval(`(() => {
      const el = document.getElementById('island');
      const body = document.querySelector('.island-body');
      const r = el.getBoundingClientRect();
      return {
        state: el.dataset.state,
        expanded: el.dataset.expanded,
        brand: document.querySelector('.island-brand').textContent,
        label: document.getElementById('island-state').textContent,
        caption: document.getElementById('island-caption').textContent,
        bodyDisplay: getComputedStyle(body).display,
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        box: { w: Math.round(r.width), h: Math.round(r.height) },
        overflow: { x: document.documentElement.scrollWidth > innerWidth, y: document.documentElement.scrollHeight > innerHeight }
      };
    })()`);

    check('island renders the LEGION mark', snap.brand === 'LEGION', snap.brand);
    check('island starts collapsed', snap.expanded === 'false' && snap.bodyDisplay === 'none',
      `expanded=${snap.expanded} body=${snap.bodyDisplay}`);
    check('island mirrors the current state', snap.state === 'IDLE' && snap.label === 'IDLE',
      `${snap.state}/${snap.label}`);
    check('island has no overflow', !snap.overflow.x && !snap.overflow.y, JSON.stringify(snap.overflow));
    check('island uses a themed accent', /^#|rgb/.test(snap.accent), snap.accent);
    check('island fits its collapsed window', snap.box.h <= 60 && snap.box.w <= 360, JSON.stringify(snap.box));

    const expanded = await islandCdp.eval(`(async () => {
      await window.legion.island.expand(true);
      const el = document.getElementById('island');
      return {
        expanded: el.dataset.expanded,
        body: getComputedStyle(document.querySelector('.island-body')).display,
        status: await window.legion.island.status()
      };
    })()`);
    check('island expands from the bridge', expanded.expanded === 'true' && expanded.body === 'flex',
      `expanded=${expanded.expanded} body=${expanded.body}`);
    check('island status agrees it is expanded', expanded.status && expanded.status.expanded === true,
      JSON.stringify(expanded.status));

    /* state mirroring through the real main process */
    for (const state of ['LISTENING', 'PROCESSING', 'SPEAKING', 'IDLE']) {
      await mainCdp.eval(`window.legion.app.setState('${state}')`);
      const seen = await waitFor(
        () => islandCdp.eval(`document.getElementById('island').dataset.state === '${state}' ? '${state}' : null`),
        3000, `island state ${state}`
      ).catch(() => null);
      check(`island mirrors ${state}`, seen === state, String(seen));
    }

    const pinned = await islandCdp.eval(`(async () => {
      document.getElementById('island-pin').click();
      await new Promise((r) => setTimeout(r, 80));
      return window.legion.island.status();
    })()`);
    check('island can be pinned', pinned && pinned.pinned === true, JSON.stringify(pinned));

    const collapsed = await islandCdp.eval(`(async () => {
      await window.legion.island.expand(false);
      return {
        expanded: document.getElementById('island').dataset.expanded,
        status: await window.legion.island.status()
      };
    })()`);
    check('island collapses again', collapsed.expanded === 'false' && collapsed.status.expanded === false,
      `expanded=${collapsed.expanded}`);

    const hidden = await mainCdp.eval(`window.legion.island.hide()`);
    check('island can be disabled without closing LEGION', hidden && hidden.enabled === false,
      JSON.stringify(hidden));

    const bad = [...islandCdp.exceptions, ...islandCdp.console];
    check('island renders without errors', bad.length === 0, bad.slice(0, 3).join(' | ') || 'clean');

    console.log(failures ? `\n${failures} check(s) failed` : '\nall island checks passed');
  } catch (err) {
    fail('harness', err.message);
  } finally {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
    await sleep(1200);
  }
  process.exit(failures ? 1 : 0);
}

main();
