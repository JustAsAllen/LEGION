/**
 * Dynamic Island smoke check.
 *
 * Launches LEGION in development mode, enables the island through the real
 * bridge, then connects a second CDP session to the island page. It verifies
 * compact and expanded layouts, state mirroring, text input through the shared
 * conversation, stop controls, settings access, configurable positioning,
 * auto-collapse, hide/restore, and that the main shell is untouched.
 *
 *   node scripts/check-island.js
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9337;
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const ISLAND_W = 380;
const ARTIFACTS = path.join(ROOT, 'artifacts');

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

const near = (a, b, tolerance = 3) => Math.abs(Number(a) - Number(b)) <= tolerance;

async function islandStatus(mainCdp) {
  return mainCdp.eval('window.legion.island.status()');
}

/**
 * Save the live island page as a PNG for inspection.
 *
 * An open image viewer can lock the file on Windows, so unused numbered names
 * are preferred instead of aborting the run or overwriting a capture mid-view.
 */
async function capture(cdp, base) {
  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    for (let i = 1; i <= 9; i++) {
      const file = path.join(ARTIFACTS, `${base}${i === 1 ? '' : `-${i}`}.png`);
      try {
        fs.writeFileSync(file, Buffer.from(data, 'base64'), { flag: 'wx' });
        return file;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  } catch (_) { /* a missing artifact must not fail the checks */ }
  return null;
}

async function main() {
  console.log('dynamic island smoke check\n');

  const child = spawn(EXE, ['.', '--dev', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  });

  let mainCdp;
  let islandCdp;
  let priorAi = null;
  let priorVoice = null;
  let priorIsland = null;
  try {
    mainCdp = await connect((t) => /\/index\.html$/.test(t.url));
    await waitFor(() => mainCdp.eval(`!!(window.legion && window.legion.island)`), 60000, 'bridge');
    // The shell reports its settled boot state to main; enabling the island
    // before that would only prove it mirrors the startup BOOTING state.
    await waitFor(
      () => mainCdp.eval(`window.legion.app.state().then((r) => r.state === 'IDLE')`),
      45000, 'main shell idle'
    );

    priorAi = (await mainCdp.eval('window.legion.config.get()')).settings.ai;
    priorVoice = (await mainCdp.eval('window.legion.config.get()')).settings.voice;
    priorIsland = (await mainCdp.eval('window.legion.config.get()')).settings.ui.island;

    // The dev profile persists settings between runs, so start from the
    // documented defaults instead of assuming a fresh profile.
    await mainCdp.eval(`window.legion.config.set({ ui: { island: { enabled: false, position: 'top-center', display: 'primary', autoCollapse: false, autoCollapseMs: 9000 } } })`);

    const before = await islandStatus(mainCdp);
    check('island is disabled until the user enables it', before && before.enabled === false && before.visible === false,
      JSON.stringify(before));
    check('island defaults to the top centre of the primary display',
      before && before.position === 'top-center' && before.display === 'primary',
      `position=${before && before.position} display=${before && before.display}`);

    const displays = await mainCdp.eval('window.legion.island.displays()');
    check('display list is available for multi-monitor placement',
      displays && Array.isArray(displays.displays) && displays.displays.length >= 1,
      `${displays && displays.displays ? displays.displays.length : 0} display(s)`);
    check('each display reports work area and DPI scale',
      displays && displays.displays.every((d) => d.workArea && d.scaleFactor >= 1),
      displays && displays.displays.map((d) => `${d.label}@${d.scaleFactor}x`).join(', '));

    const shown = await mainCdp.eval('window.legion.island.show()');
    check('island can be enabled from the bridge', shown && shown.enabled === true, JSON.stringify(shown));

    islandCdp = await connect((t) => /\/island\.html$/.test(t.url));
    await waitFor(() => islandCdp.eval(`!!(window.legion && document.getElementById('island'))`), 20000, 'island renderer');

    const snap = await islandCdp.eval(`(() => {
      const el = document.getElementById('island');
      const body = document.querySelector('.island-body');
      const r = el.getBoundingClientRect();
      return {
        state: el.dataset.state,
        mode: el.dataset.mode,
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
      `expanded=${snap.expanded} body=${snap.bodyDisplay} mode=${snap.mode}`);
    check('compact state is the pill', snap.mode === 'COMPACT', snap.mode);
    check('island mirrors the current state', snap.state === 'IDLE' && snap.label === 'IDLE',
      `${snap.state}/${snap.label}`);
    check('island has no overflow', !snap.overflow.x && !snap.overflow.y, JSON.stringify(snap.overflow));
    check('island uses a themed accent', /^#|rgb/.test(snap.accent), snap.accent);

    /* the shared GLY mark, rendered by the same stage as the shell */
    const mark = await waitFor(
      () => islandCdp.eval(`(() => {
        const m = window.legionIsland && window.legionIsland.mark();
        return m && (m.ready || m.failed) ? m : null;
      })()`),
      25000, 'island GLY mark'
    ).catch(() => null);

    check('island renders the GLY mark', mark && mark.ready === true && mark.failed === false,
      JSON.stringify(mark));
    check('island owns exactly one particle canvas', mark && mark.canvases === 1,
      mark ? `${mark.canvases} canvas(es)` : 'no diagnostics');
    check('segmented-ring mark stays circular',
      mark && mark.display.cssWidth === mark.display.cssHeight &&
      near(mark.display.width, mark.display.height, 1) &&
      mark.display.cssWidth > 0 && mark.display.cssHeight > 0,
      mark ? JSON.stringify(mark.display) : 'no diagnostics');
    check('GLY mark renders without a GL error', mark && mark.glError === 0,
      mark ? `glError=${mark.glError}` : 'no diagnostics');
    check('GLY mark uses a surface-sized particle budget',
      mark && mark.instances >= 600 && mark.instances <= 1600,
      mark ? `${mark.instances} instances` : 'no diagnostics');

    const compactShot = await capture(islandCdp, 'island-compact');
    console.log(`  capture ${compactShot || 'unavailable'}`);

    const status = await islandStatus(mainCdp);
    const display = (displays.displays || []).find((d) => d.id === status.displayId) || displays.displays[0];
    const area = display.workArea;
    const b = status.windowBounds;
    check('collapsed window is frameless-sized and rounded',
      b && near(b.width, ISLAND_W, 1) && near(b.height, 64, 1), JSON.stringify(b));
    check('island sits near the top centre of the chosen display',
      b && near(b.x, area.x + Math.round((area.width - ISLAND_W) / 2)) && near(b.y, area.y + 14),
      `window=${JSON.stringify(b)} area=${JSON.stringify(area)}`);
    check('island stays within the work area', b &&
      b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height,
      JSON.stringify({ b, area }));
    check('island is always on top', status.alwaysOnTop === true, String(status.alwaysOnTop));

    const expanded = await islandCdp.eval(`(async () => {
      await window.legion.island.expand(true);
      await new Promise((r) => setTimeout(r, 120));
      const el = document.getElementById('island');
      const thread = document.getElementById('island-thread');
      return {
        expanded: el.dataset.expanded,
        mode: el.dataset.mode,
        body: getComputedStyle(document.querySelector('.island-body')).display,
        input: !!document.getElementById('island-input'),
        send: !!document.getElementById('island-send'),
        mic: !!document.getElementById('island-mic'),
        settings: !!document.getElementById('island-settings'),
        collapse: !!document.getElementById('island-chevron'),
        close: !!document.getElementById('island-close'),
        threadScrolls: getComputedStyle(thread).overflowY,
        overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
        status: await window.legion.island.status()
      };
    })()`);
    check('island expands from the bridge', expanded.expanded === 'true' && expanded.body === 'flex',
      `expanded=${expanded.expanded} body=${expanded.body}`);
    check('expanded mode exposes the compact conversation surface',
      expanded.mode === 'EXPANDED' && expanded.input && expanded.send && expanded.mic && expanded.settings,
      `mode=${expanded.mode} input=${expanded.input} send=${expanded.send}`);
    check('expanded mode has collapse and manual exit controls',
      expanded.collapse && expanded.close, `collapse=${expanded.collapse} close=${expanded.close}`);
    check('conversation thread scrolls instead of overflowing the window',
      expanded.threadScrolls === 'auto' && !expanded.overflow, `${expanded.threadScrolls} overflow=${expanded.overflow}`);
    check('island status agrees it is expanded', expanded.status && expanded.status.expanded === true,
      JSON.stringify(expanded.status));
    check('expanded window grows downward without changing width',
      near(expanded.status.windowBounds.width, ISLAND_W, 1) && near(expanded.status.windowBounds.height, 480, 1),
      JSON.stringify(expanded.status.windowBounds));

    const expandedShot = await capture(islandCdp, 'island-expanded');
    console.log(`  capture ${expandedShot || 'unavailable'}`);

    /* state mirroring through the real main process, in the compact pill */
    await islandCdp.eval(`window.legion.island.expand(false)`);
    await sleep(150);
    for (const [state, mode] of [['LISTENING', 'LISTENING'], ['PROCESSING', 'THINKING'], ['SPEAKING', 'RESPONDING'], ['IDLE', 'COMPACT']]) {
      await mainCdp.eval(`window.legion.app.setState('${state}')`);
      const seen = await waitFor(
        () => islandCdp.eval(`(() => {
          const el = document.getElementById('island');
          if (el.dataset.state !== '${state}') return null;
          const m = window.legionIsland.mark();
          return { state: el.dataset.state, mode: el.dataset.mode, glyState: m.state, running: m.running };
        })()`),
        4000, `island state ${state}`
      ).catch(() => null);
      check(`island mirrors ${state}${state === 'IDLE' ? '' : ` as ${mode}`}`,
        seen && seen.state === state && seen.mode === mode && seen.glyState === state && seen.running === true,
        seen ? `${seen.state}/${seen.mode} gly=${seen.glyState} running=${seen.running}` : 'never arrived');
    }

    const stopped = await islandCdp.eval(`(() => {
      const button = document.getElementById('island-stop');
      return { visible: !button.hidden, state: document.getElementById('island').dataset.state };
    })()`);
    check('stop control is hidden while idle', stopped.visible === false,
      `state=${stopped.state} visible=${stopped.visible}`);

    await mainCdp.eval(`window.legion.island.expand(true)`);
    await sleep(120);

    const pinned = await islandCdp.eval(`(async () => {
      document.getElementById('island-pin').click();
      await new Promise((r) => setTimeout(r, 80));
      return window.legion.island.status();
    })()`);
    check('island can be pinned', pinned && pinned.pinned === true, JSON.stringify(pinned));
    await mainCdp.eval(`window.legion.island.pin(false)`);

    /* text turn through the shared conversation */
    await mainCdp.eval(`window.legion.config.set({ ai: { provider: 'mock', model: '', baseUrl: '' }, voice: { mockTts: true } })`);
    const chat = await islandCdp.eval(`(async () => {
      const input = document.getElementById('island-input');
      input.value = 'Island check message';
      document.getElementById('island-compose').requestSubmit();
      await new Promise((r) => setTimeout(r, 2500));
      const el = document.getElementById('island');
      return {
        value: input.value,
        state: el.dataset.state,
        caption: document.getElementById('island-caption').textContent,
        messages: [...document.querySelectorAll('.island-msg')].map((m) => ({
          kind: [...m.classList].filter((c) => c.startsWith('is-')).join(','),
          streaming: m.classList.contains('is-streaming'),
          text: m.textContent.trim()
        }))
      };
    })()`);
    check('typed text leaves the island input after sending', chat.value === '',
      `value=${JSON.stringify(chat.value)}`);
    check('the user message appears in the shared conversation',
      chat.messages.some((m) => m.kind.includes('user') && m.text.includes('Island check message')),
      chat.messages.map((m) => `${m.kind}:${m.text.slice(0, 60)}`).join(' | '));
    check('the assistant reply streams back into the island',
      chat.messages.some((m) => m.kind.includes('assistant') && m.text.length > 0),
      JSON.stringify(chat).slice(0, 500));

    /* real measured levels reach the island's mark, not a synthetic timer */
    const heard = await waitFor(
      () => islandCdp.eval(`(() => {
        const m = window.legionIsland.mark();
        return m.audioFrames > 0 ? m : null;
      })()`),
      10000, 'island audio levels'
    ).catch(() => null);
    check('island GLY reacts to measured playback levels', !!heard && heard.audioFrames > 0,
      heard ? `${heard.audioFrames} level frame(s)` : 'none arrived');

    /* stop generation while the mock is still streaming */
    const stopProbe = await islandCdp.eval(`(async () => {
      const waitFor = async (test, ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (test()) return true; await new Promise((r) => setTimeout(r, 40)); }
        return false;
      };
      // Let the previous reply finish speaking so the next turn can start.
      await waitFor(() => document.getElementById('island').dataset.state === 'IDLE', 20000);
      const input = document.getElementById('island-input');
      input.value = 'Stop this reply';
      document.getElementById('island-compose').requestSubmit();
      const visible = await waitFor(() => !document.getElementById('island-stop').hidden, 5000);
      const before = document.getElementById('island').dataset.state;
      if (visible) document.getElementById('island-stop').click();
      const idle = await waitFor(() => document.getElementById('island').dataset.state === 'IDLE', 8000);
      return { visible, before, state: document.getElementById('island').dataset.state, idle };
    })()`);
    check('stop generation is reachable while responding',
      stopProbe.visible === true && ['PROCESSING', 'SPEAKING'].includes(stopProbe.before),
      `visible=${stopProbe.visible} state=${stopProbe.before}`);
    check('stopping a turn returns the island to idle', stopProbe.idle === true, stopProbe.state);

    await mainCdp.eval(`window.legion.config.set({ ai: ${JSON.stringify(priorAi)}, voice: ${JSON.stringify(priorVoice)} })`);

    /* settings access opens the real panel, not a second one */
    await islandCdp.eval(`document.getElementById('island-settings').click()`);
    const settingsOpen = await waitFor(
      () => mainCdp.eval(`(() => {
        const panel = document.getElementById('panel');
        const title = document.getElementById('panel-title');
        return !panel.hidden && title.textContent.trim().toLowerCase() === 'settings'
          ? { open: true, title: title.textContent.trim() } : null;
      })()`),
      6000, 'settings panel'
    ).catch(() => null);
    check('island opens the existing Settings panel', !!settingsOpen && settingsOpen.open === true,
      JSON.stringify(settingsOpen));
    await mainCdp.eval(`document.getElementById('panel-close').click()`);

    /* optional auto-collapse */
    await mainCdp.eval(`window.legion.config.set({ ui: { island: { autoCollapse: true, autoCollapseMs: 1500 } } })`);
    await islandCdp.eval(`window.legion.island.expand(true)`);
    const autoCollapsed = await waitFor(
      async () => { const s = await islandStatus(mainCdp); return s.expanded === false ? 'collapsed' : null; },
      6000, 'auto-collapse'
    ).catch(() => null);
    check('optional auto-collapse returns the island to the pill', autoCollapsed === 'collapsed', String(autoCollapsed));
    await mainCdp.eval(`window.legion.config.set({ ui: { island: { autoCollapse: false } } })`);

    /* configurable position, still inside the work area */
    const positions = [
      ['top-left', (a) => a.x + 16, (a) => a.y + 14],
      ['bottom-right', (a) => a.x + a.width - ISLAND_W - 16, (a) => a.y + a.height - 64 - 16]
    ];
    for (const [position, expectedX, expectedY] of positions) {
      await mainCdp.eval(`window.legion.config.set({ ui: { island: { position: '${position}' } } })`);
      await sleep(250);
      const s = await islandStatus(mainCdp);
      check(`island honours the ${position} position`,
        s.windowBounds && near(s.windowBounds.x, expectedX(s.workArea)) && near(s.windowBounds.y, expectedY(s.workArea)),
        `${JSON.stringify(s.windowBounds)} in ${JSON.stringify(s.workArea)}`);
    }

    /* a second monitor, when this machine has one */
    if ((displays.displays || []).length > 1) {
      const secondary = displays.displays.find((d) => !d.primary);
      await mainCdp.eval(`window.legion.config.set({ ui: { island: { display: ${secondary.index} } } })`);
      await sleep(250);
      const s = await islandStatus(mainCdp);
      check('island can be moved to another display',
        s.displayId === secondary.id && s.windowBounds &&
        s.windowBounds.x >= secondary.workArea.x &&
        s.windowBounds.y >= secondary.workArea.y,
        `display=${s.displayId} window=${JSON.stringify(s.windowBounds)}`);
    } else {
      console.log('  SKIP multi-display placement (only one display attached)');
    }

    await mainCdp.eval(`window.legion.config.set({ ui: { island: { position: 'top-center', display: 'primary' } } })`);

    const collapsed = await islandCdp.eval(`(async () => {
      await window.legion.island.expand(false);
      await new Promise((r) => setTimeout(r, 120));
      return {
        expanded: document.getElementById('island').dataset.expanded,
        mode: document.getElementById('island').dataset.mode,
        status: await window.legion.island.status()
      };
    })()`);
    check('island collapses again', collapsed.expanded === 'false' && collapsed.status.expanded === false,
      `expanded=${collapsed.expanded} mode=${collapsed.mode}`);

    /* hide, then restore from the same controller without a second window */
    const hidden = await mainCdp.eval('window.legion.island.hide()');
    check('island can be disabled without closing LEGION', hidden && hidden.enabled === false,
      JSON.stringify(hidden));
    const paused = await waitFor(
      () => islandCdp.eval(`(() => {
        const m = window.legionIsland.mark();
        return m.running === false ? m : null;
      })()`),
      4000, 'island mark paused'
    ).catch(() => null);
    check('island stops its render loop while hidden', !!paused,
      paused ? JSON.stringify(paused) : 'still running');
    const restored = await mainCdp.eval('window.legion.island.show()');
    check('island restores after being hidden', restored && restored.visible === true && restored.enabled === true,
      JSON.stringify(restored));
    const resumed = await waitFor(
      () => islandCdp.eval(`(() => {
        const m = window.legionIsland.mark();
        return m.running === true ? m : null;
      })()`),
      4000, 'island mark resumed'
    ).catch(() => null);
    check('island resumes the same mark without rebuilding it',
      !!resumed && resumed.ready === true && resumed.canvases === 1,
      resumed ? `ready=${resumed.ready} canvases=${resumed.canvases}` : 'never resumed');

    const pages = await targets();
    const islandPages = pages.filter((t) => /\/island\.html$/.test(t.url));
    check('only one island window exists', islandPages.length === 1, `${islandPages.length} island page(s)`);

    const mainHealth = await mainCdp.eval(`(async () => {
      const info = await window.legion.app.info();
      const state = await window.legion.app.state();
      return {
        name: info.name,
        hasBody: !!document.getElementById('stage'),
        stageCanvases: document.querySelectorAll('#stage canvas').length,
        state: state && state.state,
        title: document.title
      };
    })()`);
    check('the existing main window still works',
      mainHealth && mainHealth.name === 'LEGION' && mainHealth.hasBody && !!mainHealth.state,
      JSON.stringify(mainHealth));
    check('the island did not add a second canvas to the main shell',
      mainHealth && mainHealth.stageCanvases === 1,
      mainHealth ? `${mainHealth.stageCanvases} main stage canvas(es)` : 'no diagnostics');

    // Leave the profile as it was found.
    if (priorIsland) {
      await mainCdp.eval(`window.legion.config.set({ ui: { island: ${JSON.stringify(priorIsland)} } })`);
    }

    const bad = [...islandCdp.exceptions, ...islandCdp.console];
    check('island renders without errors', bad.length === 0, bad.slice(0, 3).join(' | ') || 'clean');
    const mainBad = [...mainCdp.exceptions, ...mainCdp.console];
    check('main shell logs no errors while the island is open', mainBad.length === 0,
      mainBad.slice(0, 3).join(' | ') || 'clean');

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
