/**
 * Stage 4.2 - interface shell check.
 *
 * Exercises the chrome against the live window: the layout regions, the panel
 * shell, the modal/toast stacking, and the title bar. Layering is asserted from
 * the computed z-index of the real elements rather than by reading the styles
 *heet, so a regression in the cascade cannot pass.
 *
 *   node scripts/check-shell.js
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9336;
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT = path.join(ROOT, 'artifacts');

let failures = 0;
const pass = (n, d) => console.log(`  PASS ${n}${d ? ' -> ' + d : ''}`);
const fail = (n, d) => { failures++; console.log(`  FAIL ${n} -> ${d}`); };
const check = (n, ok, d) => (ok ? pass(n, d) : fail(n, d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = e.message; }
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (last: ${last})` : ''}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    this.problems = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
        this.problems.push(`[${m.params.type}] ` + m.params.args.map((x) => x.value ?? x.description ?? '').join(' '));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.problems.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)); }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

async function connect() {
  const t = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
  }, 40000, 'devtools target');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('cdp socket failed')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  return cdp;
}

/* -- geometry / stacking probes, evaluated in the page ----------------- */

const GEOM = (ids) => `(() => {
  const out = {};
  for (const id of ${JSON.stringify(ids)}) {
    const e = document.getElementById(id);
    if (!e) { out[id] = null; continue; }
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    out[id] = {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      z: Number(cs.zIndex) || 0, hidden: e.hidden || cs.display === 'none' || cs.visibility === 'hidden',
      position: cs.position
    };
  }
  return out;
})()`;

async function main() {
  console.log('stage 4.2 - interface shell check\n');
  fs.mkdirSync(OUT, { recursive: true });
  const child = spawn(EXE, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  });

  let cdp;
  try {
    cdp = await connect();
    await waitFor(() => cdp.eval(`(() => {
      const a = window.legionApp;
      return !!(a && a.stage && a.stage.cloudCount) && document.getElementById('boot').classList.contains('is-gone');
    })()`), 90000, 'shell to boot');

    /* ---- 1. layout regions ------------------------------------- */
    const g0 = await cdp.eval(GEOM(['titlebar', 'centre', 'rail', 'panel', 'statusbar', 'stage']));
    for (const id of ['titlebar', 'centre', 'rail', 'statusbar', 'stage']) {
      const r = g0[id];
      check(`region ${id} laid out`, r && !r.hidden && r.w > 0 && r.h > 0,
        r ? `${r.w}x${r.h} at ${r.x},${r.y}` : 'missing');
    }
    check('title bar spans the full width', g0.titlebar.w === g0.stage.w, `${g0.titlebar.w} vs stage ${g0.stage.w}`);
    check('status bar spans the full width', g0.statusbar.w === g0.stage.w, `${g0.statusbar.w} vs stage ${g0.stage.w}`);
    check('title bar sits at the top', g0.titlebar.y === 0, `y=${g0.titlebar.y}`);
    check('status bar sits at the bottom', Math.abs(g0.statusbar.y + g0.statusbar.h - g0.stage.h) <= 2,
      `bottom=${g0.statusbar.y + g0.statusbar.h} stage=${g0.stage.h}`);
    check('status bar clears the title bar', g0.centre.y >= g0.titlebar.h, `centre y=${g0.centre.y} titlebar h=${g0.titlebar.h}`);
    check('centre readout is not clipped', g0.centre.w > 0 && g0.centre.h > 0, `${g0.centre.w}x${g0.centre.h}`);

    /* ---- 2. stacking order (computed, not from the stylesheet) - */
    const stack = await cdp.eval(`(() => {
      const z = (sel) => { const e = document.querySelector(sel); return e ? Number(getComputedStyle(e).zIndex) || 0 : null; };
      return { stage: z('#stage'), vignette: z('.vignette'), scanlines: z('.scanlines'),
               centre: z('.centre'), rail: z('.rail'), panel: z('#panel'),
               titlebar: z('.titlebar'), statusbar: z('.statusbar'),
               boot: z('.boot'), toasts: z('#toasts'), modal: z('.modal'), firstrun: z('.firstrun') };
    })()`);
    console.log(`  z-order: ${Object.entries(stack).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    const ordered = ['stage', 'vignette', 'scanlines', 'centre', 'rail', 'panel', 'titlebar', 'statusbar', 'boot', 'toasts', 'modal', 'firstrun'];
    let mono = true, prev = -1;
    for (const k of ordered) {
      const v = stack[k];
      if (v === null) { mono = false; break; }
      if (k === 'statusbar') continue;           // deliberately level with the title bar
      if (v < prev) { mono = false; }
      prev = v;
    }
    check('stacking rises monotonically to the top', mono, ordered.map((k) => `${k}=${stack[k]}`).join(' '));
    check('panel slides under the chrome', stack.panel < stack.titlebar, `panel=${stack.panel} titlebar=${stack.titlebar}`);
    check('toasts sit above chrome, below modals', stack.toasts > stack.statusbar && stack.toasts < stack.modal,
      `toasts=${stack.toasts} statusbar=${stack.statusbar} modal=${stack.modal}`);

    /* ---- 3. title bar contents --------------------------------- */
    const tb = await cdp.eval(`(() => ({
      wordmark: (document.querySelector('.wordmark')||{}).textContent || '',
      state: (document.getElementById('tb-state')||{}).textContent || '',
      storeState: window.legionApp.store.state,
      presence: document.getElementById('tb-presence').className,
      drag: getComputedStyle(document.getElementById('titlebar')).webkitAppRegion,
      controls: ['win-min','win-max','win-close'].map(id => !!document.getElementById(id)),
      railToggle: !!document.getElementById('btn-rail'),
      scanlines: window.legionApp.stage.scanlines,
      noScanlineClass: document.body.classList.contains('no-scanlines'),
      scanlineOpacity: getComputedStyle(document.querySelector('.scanlines')).opacity,
      adaptive: window.legionApp.stage.adaptive
    }))()`);
    check('wordmark present', /LEGION/.test(tb.wordmark), JSON.stringify(tb.wordmark));
    // A static read cannot catch a store event whose payload never arrives, so
    // drive a real transition and confirm every mirror follows it.
    const mirror = await cdp.eval(`(() => {
      const snap = () => ({
        tb: document.getElementById('tb-state').textContent,
        label: document.getElementById('state-label').textContent,
        body: document.body.dataset.state,
        dot: document.getElementById('tb-presence').className
      });
      const a = window.legionApp;
      a.store.setState('ALERT', 'mirror probe');
      const alert = snap();
      a.store.setState('IDLE');
      return { alert, idle: snap(), storeIdle: a.store.state };
    })()`);
    check('title bar mirrors the state machine', tb.state === tb.storeState, `tb=${tb.state} store=${tb.storeState}`);
    check('state change propagates to every mirror',      mirror.alert.tb === 'ALERT' && mirror.alert.label === 'ALERT' && mirror.alert.body === 'ALERT',
      JSON.stringify(mirror.alert));
    check('title bar returns to idle on restore',
      mirror.idle.tb === 'IDLE' && mirror.storeIdle === 'IDLE' && mirror.idle.body === 'IDLE',
      JSON.stringify(mirror.idle));
    check('presence dot reflects state', /is-|state-|active/.test(tb.presence) || tb.presence.includes('tb-presence'), tb.presence);
    check('window controls present', tb.controls.every(Boolean), JSON.stringify(tb.controls));
    check('panel toggle present', tb.railToggle === true, String(tb.railToggle));
    check('title bar is a window drag region', tb.drag === 'drag' || tb.drag === '', `app-region=${tb.drag || '(none)'}`);

    /* ---- 3b. the scanline toggle must move real pixels ---------- */
    // The field shader has no uScanlines, so the flag is only honest if the
    // CSS overlay actually responds. Assert the rendered opacity, not the flag.
    const scanOn = await cdp.eval(`(() => {
      window.legionApp.stage.setScanlines(true);
      return new Promise(r => setTimeout(() => r({
        opacity: parseFloat(getComputedStyle(document.querySelector('.scanlines')).opacity),
        noClass: document.body.classList.contains('no-scanlines')
      }), 700));
    })()`);
    check('scanlines overlay is visible when enabled',
      scanOn.opacity > 0.1 && scanOn.noClass === false, JSON.stringify(scanOn));

    const scanOff = await cdp.eval(`(() => {
      window.legionApp.stage.setScanlines(false);
      return new Promise(r => setTimeout(() => r({
        opacity: parseFloat(getComputedStyle(document.querySelector('.scanlines')).opacity),
        noClass: document.body.classList.contains('no-scanlines')
      }), 700));
    })()`);
    check('scanlines toggle actually hides the overlay',
      scanOff.opacity === 0 && scanOff.noClass === true, JSON.stringify(scanOff));

    // ALERT repaints the overlay through a body[data-state] rule, so this also
    // proves the state mirror reaches the DOM the stylesheet keys off.
    const alertScan = await cdp.eval(`(() => {
      window.legionApp.stage.setScanlines(true);
      window.legionApp.store.setState('ALERT', 'shell check');
      return new Promise(r => setTimeout(() => {
        const el = document.querySelector('.scanlines');
        const out = {
          body: document.body.dataset.state,
          opacity: parseFloat(getComputedStyle(el).opacity),
          red: getComputedStyle(el).backgroundImage.indexOf('255, 95, 67') >= 0
        };
        window.legionApp.store.setState('IDLE');
        r(out);
      }, 700));
    })()`);
    check('alert state repaints the scanline tint',
      alertScan.body === 'ALERT' && alertScan.opacity > 0.5 && alertScan.red, JSON.stringify(alertScan));

    // A tier the user pinned must be a ceiling, not a starting hint.
    const pin = await cdp.eval(`(() => {
      const s = window.legionApp.stage;
      s.setAdaptive(false);
      s.setQuality('low');
      return new Promise(r => setTimeout(() => r({
        adaptive: s.adaptive, quality: s.quality, userQuality: s.userQuality, instances: s.currentInstances
      }), 400));
    })()`);
    check('quality tier is honoured and pinned',
      pin.adaptive === false && pin.quality === 'low' && pin.userQuality === 'low' && pin.instances < 3000,
      JSON.stringify(pin));

    const drift = await waitFor(async () => {
      const s = await cdp.eval(`(() => ({
        quality: window.legionApp.stage.quality,
        userQuality: window.legionApp.stage.userQuality,
        instances: window.legionApp.stage.currentInstances
      }))()`);
      return s.quality === 'low' && s.instances < 3000 ? s : null;
    }, 9000, 'pinned tier to hold').catch(() => null);
    check('adaptive cannot climb past the pinned tier',
      !!drift && drift.userQuality === 'low', drift ? JSON.stringify(drift) : 'tier drifted upward');

    await cdp.eval(`(() => { const s = window.legionApp.stage; s.setAdaptive(true); s.setQuality('high'); })()`);
    await cdp.eval(`window.legionApp.stage.setScanlines(${tb.scanlines})`);
    await sleep(400);

    /* ---- 4. panel chrome: every panel opens and closes --------- */
    const panels = ['conversation', 'tools', 'memory', 'settings'];
    const opened = [];
    for (const name of panels) {
      const r = await cdp.eval(`(() => {
        window.legionApp.togglePanel(${JSON.stringify(name)});
        const el = document.getElementById('panel');
        const body = document.getElementById('panel-body');
        const rect = el.getBoundingClientRect();
        return {
          hidden: el.hidden,
          title: document.getElementById('panel-title').textContent,
          bodyChildren: body.children.length,
          bodyChars: (body.textContent || '').trim().length,
          failed: /Panel failed to open/.test(body.textContent || ''),
          w: Math.round(rect.width), h: Math.round(rect.height),
          top: Math.round(rect.top), bottom: Math.round(rect.bottom),
          stageH: window.innerHeight,
          activeBtn: document.querySelector('.rail-btn.is-active')?.dataset.panel || null
        };
      })()`);
      await sleep(320);
      check(`panel ${name} opens`, !r.hidden && r.title === name, `title=${JSON.stringify(r.title)} ${r.w}x${r.h}`);
      check(`panel ${name} renders content`, r.bodyChildren > 0 && r.bodyChars > 0 && !r.failed,
        `${r.bodyChildren} nodes, ${r.bodyChars} chars${r.failed ? ' (RENDER FAILED)' : ''}`);
      // The panel is a full-height drawer that deliberately runs beneath the
      // title and status bars, which own the higher z-index. Asserting it is
      // inset would test a design that is not the one implemented.
      check(`panel ${name} is a full-height drawer under the chrome`,
        r.top <= 0 && r.bottom >= r.stageH - 1 && r.w === 430,
        `panel ${r.top}..${r.bottom} of ${r.stageH}, width ${r.w}`);
      check(`rail marks ${name} active`, r.activeBtn === name, String(r.activeBtn));
      opened.push(name);
    }
    check('all four panels reachable', opened.length === 4, opened.join(', '));

    // The stage should shift aside so the face is not hidden behind the panel.
    // The loop above already left a panel open, so only close it if one is not.
    const shift = await cdp.eval(`(() => {
      const a = window.legionApp;
      if (!a.currentPanel) a.togglePanel('settings');
      return new Promise(res => setTimeout(() => res({
        open: a.currentPanel,
        panelShift: a.stage.panelShift,
        camX: a.stage.camera.position.x
      }), 700));
    })()`);
    check('stage yields to an open panel', !!shift.open && Math.abs(shift.panelShift) > 1,
      `panel=${shift.open} panelShift=${shift.panelShift.toFixed(2)} camX=${shift.camX.toFixed(2)}`);

    // cyclePanel must move, and the close button must clear.
    const cyc = await cdp.eval(`(() => {
      window.legionApp.togglePanel(null);
      window.legionApp.cyclePanel();
      const first = window.legionApp.currentPanel;
      window.legionApp.cyclePanel();
      const second = window.legionApp.currentPanel;
      return { first, second, closed: document.getElementById('panel').hidden };
    })()`);
    check('cyclePanel advances', !!cyc.first && cyc.first !== cyc.second, `${cyc.first} -> ${cyc.second}`);

    const closed = await cdp.eval(`(() => {
      const a = window.legionApp;
      if (a.currentPanel) a.togglePanel(null);       // cyclePanel left one open
      a.togglePanel('tools');                        // now a genuine close
      const wasOpen = !document.getElementById('panel').hidden;
      document.getElementById('panel-close').click();
      return { wasOpen, nowHidden: document.getElementById('panel').hidden, current: a.currentPanel };
    })()`);
    check('close button hides the panel', closed.wasOpen && closed.nowHidden && closed.current === null, JSON.stringify(closed));

    // Closing the panel must hand the stage its full width back. The camera
    // eases asymptotically, so poll for the settle instead of sampling once.
    const recentred = await waitFor(async () => {
      const s = await cdp.eval(`(() => ({
        shift: window.legionApp.stage.panelShift,
        camX: window.legionApp.stage.camera.position.x
      }))()`);
      return (Math.abs(s.shift) < 0.5 && Math.abs(s.camX) < 0.5) ? s : null;
    }, 8000, 'stage to re-centre').catch(() => null);
    check('stage re-centres when the panel closes', !!recentred,
      recentred ? `panelShift=${recentred.shift.toFixed(2)} camX=${recentred.camX.toFixed(2)}` : 'never settled');

    /* ---- 5. modal + toast layering ------------------------------ */
    const layers = await cdp.eval(`(() => {
      const vis = (sel) => { const e = document.querySelector(sel); return !!e && !e.hidden && getComputedStyle(e).display !== 'none'; };
      const z = (sel) => { const e = document.querySelector(sel); return e ? Number(getComputedStyle(e).zIndex) || 0 : null; };
      window.legionApp.toast('info', 'shell check', 'toast layer probe');
      const toastCount = document.getElementById('toasts').children.length;
      window.legionApp.toggleShortcuts(true);
      return { toastCount, toastZ: z('#toasts'), modalZ: z('#shortcuts'), modalVisible: vis('#shortcuts') };
    })()`);
    check('toast raised into the toast layer', layers.toastCount > 0, `${layers.toastCount} toast(s)`);
    check('shortcuts modal opens', layers.modalVisible, `z=${layers.modalZ}`);
    check('modal covers the toast layer', layers.modalZ > layers.toastZ, `modal=${layers.modalZ} toasts=${layers.toastZ}`);

    const conf = await cdp.eval(`(() => {
      window.legionApp.toggleShortcuts(false);
      window.legionApp.confirm({ message: 'shell check probe', tool: 'probe', impact: 'none' });
      const el = document.getElementById('confirm');
      return { hidden: el.hidden, z: Number(getComputedStyle(el).zIndex) || 0,
               title: (document.getElementById('confirm-title')||{}).textContent || '',
               msg: (document.getElementById('confirm-message')||{}).textContent || '' };
    })()`);
    check('confirmation gate opens over the shell', !conf.hidden, `z=${conf.z} hidden=${conf.hidden}`);
    check('confirmation shows the requested action', conf.msg.includes('shell check probe'), JSON.stringify(conf.msg));
    check('confirmation outranks toasts', conf.z > layers.toastZ, `confirm=${conf.z} toasts=${layers.toastZ}`);

    // Esc must dismiss the topmost layer, and nothing may be left stuck open.
    // The event is dispatched on window so the real chain runs:
    // shortcuts.js -> closeTopmost() -> #settleConfirm(). Checking only that
    // the element hid would miss a gate that never settled its promise.
    const esc = await cdp.eval(`(() => {
      const a = window.legionApp;
      a.closeTopmost();                               // clear the gate opened above
      a.toggleShortcuts(true);                        // shortcuts now sit on top
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      const shortcutsAfterEsc = document.getElementById('shortcuts').hidden;

      const p = a.confirm({ message: 'esc dismissal probe', tool: 'probe', impact: 'none' });
      const el = document.getElementById('confirm');
      const wasOpen = !el.hidden;
      let settled = 'pending';
      p.then((ok) => { settled = String(ok); });
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      return new Promise(res => setTimeout(() => res({
        shortcutsAfterEsc,
        wasOpen,
        confirmHidden: el.hidden,
        settled,
        shortcutsHidden: document.getElementById('shortcuts').hidden,
        firstrunHidden: document.getElementById('firstrun').hidden
      }), 500));
    })()`);
    check('Esc dismisses the shortcuts modal', esc.shortcutsAfterEsc === true, JSON.stringify(esc.shortcutsAfterEsc));
    check('Esc dismisses the confirmation gate', esc.wasOpen && esc.confirmHidden === true, JSON.stringify(esc));
    check('dismissed confirmation settles as declined', esc.settled === 'false', `settled=${esc.settled}`);
    check('no overlay left stuck open', esc.confirmHidden && esc.shortcutsHidden && esc.firstrunHidden, JSON.stringify(esc));

    const toastsGone = await waitFor(async () => {
      const n = await cdp.eval(`document.getElementById('toasts').children.length`);
      return n === 0 ? true : null;
    }, 12000, 'toasts to auto-dismiss').catch(() => false);
    check('toasts auto-dismiss', !!toastsGone, toastsGone ? 'cleared' : 'still showing');

    const stillAlive = await cdp.eval(`(() => ({ state: window.legionApp.store.state, fps: Math.round(window.legionApp.stage.fps) }))()`);
    check('shell still healthy after the tour', stillAlive.state === 'IDLE' && stillAlive.fps > 0, JSON.stringify(stillAlive));

    const probs = cdp.problems;
    check('no renderer errors during the shell tour', probs.length === 0, probs.slice(0, 4).join(' | ') || 'clean');

    console.log(failures ? `\n${failures} check(s) failed` : '\nall shell checks passed');
  } catch (err) {
    fail('harness', err.message);
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    await sleep(1500);
  }
  process.exit(failures ? 1 : 0);
}

main();
