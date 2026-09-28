/**
 * End-to-end check of the first-run handover, driven through the real DOM.
 *
 * Launches Electron on the isolated --dev profile (so the wizard is shown and
 * the user's own settings are untouched), then drives the wizard over CDP:
 * advance to the last step, request a finish against an unreachable provider,
 * assert the button arms a bypass, click it, and assert the handover happens
 * exactly once.
 *
 *   node --experimental-vm-modules scripts/check-firstrun.js
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9333;
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

// The wizard only appears on a profile that has never been onboarded, and the
// provider probe depends on whether a key is on file. Both live in the dev
// profile, so a stale secrets.json from an earlier run would silently make the
// probe pass and hide the bug under test.
const DEV_PROFILE = path.join(os.homedir(), 'AppData', 'Roaming', 'LEGION', 'dev');
for (const f of ['settings.json', 'secrets.json']) {
  try { fs.rmSync(path.join(DEV_PROFILE, f), { force: true }); } catch { /* nothing to clear */ }
}

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
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/* -- minimal CDP client over the built-in WebSocket --------------------- */

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
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }
}

async function connect() {
  const targets = await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = await res.json();
    return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  }, 40000, 'devtools target');

  const ws = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('cdp socket failed')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  return cdp;
}

/* -- the wizard flow --------------------------------------------------- */

const readState = `(() => {
  const root = document.getElementById('firstrun');
  const btn = document.getElementById('fr-next');
  return {
    wizardHidden: root ? root.hidden : null,
    stepHint: (document.getElementById('fr-step-hint') || {}).textContent || '',
    label: btn ? btn.textContent : '',
    disabled: btn ? btn.disabled : null,
    appState: (window.legionApp && window.legionApp.store) ? window.legionApp.store.state : null,
    quality: (window.legionApp && window.legionApp.config) ? (window.legionApp.config.visual || {}).quality : null,
    onboarded: (window.legionApp && window.legionApp.config) ? !!window.legionApp.config.onboarded : null,
    handoverCount: window.__handoverCount || 0
  };
})()`;

async function main() {
  console.log('first-run handover check\n');
  const child = spawn(EXE, ['.', '--dev', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  });

  let cdp;
  try {
    cdp = await connect();

    // Wait for the wizard to appear.
    await waitFor(() => cdp.eval(`(() => {
      const r = document.getElementById('firstrun');
      return !!(r && !r.hidden);
    })()`), 60000, 'first-run wizard');

    check('wizard shown on a fresh profile', true);
    const hint0 = (await cdp.eval(readState)).stepHint;
    check('wizard starts at step 1', /Step 1 of 5/.test(hint0), hint0);

    // Count handovers so a double-fire is detectable.
    await cdp.eval(`(() => {
      window.__handoverCount = 0;
      const app = window.legionApp;
      if (!app) return;
      const orig = app.onboardingDone.bind(app);
      app.onboardingDone = (info) => { window.__handoverCount++; return orig(info); };
    })()`);

    // Reproduce the reported case: a provider chosen with no key, so the
    // readiness probe genuinely fails and the bypass is offered.
    await cdp.eval(`(() => {
      const d = window.legionApp._firstRun.draft;
      d.provider = 'anthropic';
      d.model = 'claude-sonnet-4-5';
      d.key = '';
      d.quality = 'medium';
      d.voiceName = 'test';
      return true;
    })()`);

    // Advance to the last step.
    for (let i = 0; i < 6; i++) {
      const s = await cdp.eval(readState);
      if (/Step 5 of 5/.test(s.stepHint)) break;
      await cdp.eval(`document.getElementById('fr-next').click(), true`);
      await sleep(350);
    }
    const s5 = await cdp.eval(readState);
    check('reached step 5 of 5', /Step 5 of 5/.test(s5.stepHint), s5.stepHint);
    check('primary button offers completion', /Finish/.test(s5.label), s5.label);

    // First click: probe fails, so the bypass must arm.
    await cdp.eval(`document.getElementById('fr-next').click(), true`);
    const armed = await waitFor(async () => {
      const s = await cdp.eval(readState);
      return s.label === 'Finish anyway' && s.disabled === false ? s : null;
    }, 25000, 'the bypass button to arm').catch(() => null);
    check('failed provider probe arms a bypass', !!armed, armed ? `label "${armed.label}"` : 'never armed');
    check('no handover while the wizard is still open', armed && armed.handoverCount === 0, `handoverCount=${armed?.handoverCount}`);

    // Second click: the bypass must complete the handover.
    await cdp.eval(`document.getElementById('fr-next').click(), true`);
    const done = await waitFor(async () => {
      const s = await cdp.eval(readState);
      return s.wizardHidden === true ? s : null;
    }, 25000, 'the wizard to close').catch(() => null);
    check('bypass closes the wizard and launches the shell', !!done, done ? `appState=${done.appState}` : 'wizard never closed');

    // Exactly once - the old onclick/addEventListener collision ran it twice.
    await sleep(1500);
    const fin = await cdp.eval(readState);
    check('handover ran exactly once', fin.handoverCount === 1, `handoverCount=${fin.handoverCount}`);
    check('state machine reached IDLE', fin.appState === 'IDLE', String(fin.appState));
    check('onboarded flag committed', fin.onboarded === true, String(fin.onboarded));
    check('step 5 visual quality applied', fin.quality === 'medium', String(fin.quality));

    // A third click must not re-enter the handover.
    await cdp.eval(`document.getElementById('fr-next').click(), true`);
    await sleep(700);
    const again = await cdp.eval(readState);
    check('repeat clicks cannot re-fire the handover', again.handoverCount === 1, `handoverCount=${again.handoverCount}`);

    const bad = cdp.logs.filter((l) => l.startsWith('[exception]') || l.startsWith('[error]'));
    check('no renderer exceptions or errors', bad.length === 0, bad.join(' | ') || 'clean');

    console.log(failures ? `\n${failures} check(s) failed` : '\nall first-run checks passed');
  } catch (err) {
    fail('harness', err.message);
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    await sleep(1500);
  }
  process.exit(failures ? 1 : 0);
}

main();
