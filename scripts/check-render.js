/**
 * Stage 4.1 - visible window render check.
 *
 * Launches LEGION in a real visible window (no --hidden) on the user's own
 * profile, then verifies from the live page that the shell actually came up:
 * the boot overlay is gone, the WebGL context is live, the animation loop is
 * advancing, the status bar is populated, and the captured framebuffer is not
 * a blank canvas. Finally it writes a screenshot to artifacts/.
 *
 *   node scripts/check-render.js
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9335;
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT = path.join(ROOT, 'artifacts');
const BASE = 'stage4-1-main-shell';

/**
 * Pick a screenshot name that is not already taken.
 *
 * A previous capture is often still open in an image viewer, which locks the
 * file on Windows and turns a plain overwrite into a hard failure.
 */
function pickShot() {
  for (let i = 0; i < 50; i++) {
    const p = path.join(OUT, i ? `${BASE}-${i}.png` : `${BASE}.png`);
    if (!fs.existsSync(p)) return p;
  }
  throw new Error('too many captures in artifacts/');
}

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

/* -- minimal PNG reader: 8-bit RGB/RGBA, non-interlaced ----------------- */

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8, width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
  if (interlace !== 0) throw new Error('interlaced png unsupported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Fraction of pixels that differ noticeably from the modal background. */
function analyse(png) {
  const { width, height, channels, data } = png;
  const hist = new Map();
  const total = width * height;
  for (let i = 0; i < total; i++) {
    const o = i * channels;
    const key = (data[o] >> 3 << 10) | (data[o + 1] >> 3 << 5) | (data[o + 2] >> 3);
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  let modal = 0, modalCount = 0;
  for (const [k, c] of hist) if (c > modalCount) { modalCount = c; modal = k; }
  const mr = ((modal >> 10) & 31) * 8, mg = ((modal >> 5) & 31) * 8, mb = (modal & 31) * 8;

  let lit = 0, sum = 0, maxL = 0, clipped = 0, near = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += lum; if (lum > maxL) maxL = lum;
      if (lum >= 254) clipped++;
      if (lum >= 200) near++;
      const d = Math.abs(r - mr) + Math.abs(g - mg) + Math.abs(b - mb);
      if (d > 24) { lit++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
  }
  return {
    width, height, colors: hist.size, meanLum: sum / total, maxLum: maxL,
    litFraction: lit / total,
    clippedFraction: clipped / total,
    nearFraction: near / total,
    litBox: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

/* -- CDP ---------------------------------------------------------------- */

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
  await cdp.send('Page.enable');
  return cdp;
}

/* -- the check ---------------------------------------------------------- */

const SNAPSHOT = `(() => {
  const app = window.legionApp;
  const st = app && app.stage;
  const cv = document.querySelector('#stage canvas');
  const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), vis: r.width > 0 && r.height > 0 }; };
  const gl = cv && (cv.getContext('webgl2') || null);
  return {
    hasApp: !!app,
    hasStage: !!st,
    state: app && app.store ? app.store.state : null,
    caption: app && app.store ? (app.store.caption || '') : '',
    fps: st ? Math.round(st.fps) : null,
    instances: st ? st.currentInstances : null,
    cloudCount: st ? st.cloudCount : null,
    quality: st ? st.quality : null,
    userQuality: st ? st.userQuality : null,
    hasCanvas: !!cv,
    canvasCss: cv ? { w: cv.clientWidth, h: cv.clientHeight } : null,
    drawBuffer: cv ? { w: cv.width, h: cv.height } : null,
    hasGl: !!gl,
    glLost: gl ? gl.isContextLost() : null,
    glError: gl ? gl.getError() : null,
    bootGone: document.getElementById('boot').classList.contains('is-gone'),
    bodyReady: document.body.classList.contains('is-ready'),
    firstrunHidden: document.getElementById('firstrun').hidden,
    dpr: window.devicePixelRatio,
    inner: { w: window.innerWidth, h: window.innerHeight },
    layout: { stage: box('#stage'), bar: box('#statusbar'), title: box('#titlebar') },
    chips: {
      fps: (document.getElementById('m-fps') || {}).textContent || '',
      cpu: (document.getElementById('m-cpu') || {}).textContent || '',
      mem: (document.getElementById('m-mem') || {}).textContent || '',
      gpu: (document.getElementById('m-gpu') || {}).textContent || '',
      net: (document.getElementById('m-net') || {}).textContent || ''
    },
    overflow: { x: document.documentElement.scrollWidth > window.innerWidth, y: document.documentElement.scrollHeight > window.innerHeight }
  };
})()`;

async function main() {
  console.log('stage 4.1 - visible window render check\n');
  fs.mkdirSync(OUT, { recursive: true });

  // A visible window: no --hidden, no remote headless.
  const child = spawn(EXE, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  });

  let cdp;
  try {
    cdp = await connect();

    // Wait until the shell has actually finished booting.
    const s = await waitFor(() => cdp.eval(`(() => {
      const a = window.legionApp;
      if (!a || !a.stage || !a.stage.cloudCount) return null;
      if (!document.getElementById('boot').classList.contains('is-gone')) return null;
      return a.store.state;
    })()`), 90000, 'boot to complete');

    check('window opened and boot completed', !!s, `state=${s}`);

    const a = await cdp.eval(SNAPSHOT);

    check('renderer app is live', a.hasApp && a.hasStage, `app=${a.hasApp} stage=${a.hasStage}`);
    check('boot overlay dismissed', a.bootGone && a.bodyReady, `is-gone=${a.bootGone} is-ready=${a.bodyReady}`);
    check('first-run wizard not blocking', a.firstrunHidden === true, `hidden=${a.firstrunHidden}`);
    check('state machine settled on IDLE', a.state === 'IDLE', String(a.state));
    // A returning user must be told how to start talking, and interaction must
    // still be able to take the region over.
    const cap = await cdp.eval(`(() => {
      const el = document.getElementById('live-caption');
      const before = el.textContent;
      window.legionApp.store.setCaption('render check', true);
      const during = el.textContent;
      window.legionApp.store.setCaption('', false);
      return { before, during, after: el.textContent };
    })()`);
    check('idle hint shown on a normal boot', /Hold Space to talk/.test(cap.before), JSON.stringify(cap.before));
    check('caption region still updates and clears',
      cap.during === 'render check' && cap.after === '',
      `set=${JSON.stringify(cap.during)} cleared=${JSON.stringify(cap.after)}`);

    check('WebGL canvas present', a.hasCanvas, a.canvasCss ? `css ${a.canvasCss.w}x${a.canvasCss.h} dpr=${a.dpr}` : 'missing');
    check('drawing buffer allocated', a.drawBuffer && a.drawBuffer.w > 0, a.drawBuffer ? `${a.drawBuffer.w}x${a.drawBuffer.h}` : 'none');
    check('WebGL context live', a.hasGl && a.glLost === false, `lost=${a.glLost}`);
    check('no pending GL error', a.glError === 0, `glGetError=${a.glError}`);

    check('particle cloud uploaded', a.cloudCount > 0, `${a.cloudCount?.toLocaleString()} elements`);
    check('instance count within tier', a.instances > 0 && a.instances <= (a.cloudCount || 0), `${a.instances?.toLocaleString()} instances, tier=${a.quality}`);

    // The loop must be advancing, not just have run one frame.
    const before = await cdp.eval(`window.legionApp.stage.fps`);
    await sleep(2500);
    const after = await cdp.eval(`(() => ({
      fps: Math.round(window.legionApp.stage.fps),
      chip: (document.getElementById('m-fps')||{}).textContent || '',
      instances: window.legionApp.stage.currentInstances
    }))()`);
    check('render loop is live', after.fps > 0, `fps=${after.fps} (was ${Math.round(before)})`);
    check('frame rate healthy', after.fps >= 30, `${after.fps} fps`);
    check('fps chip reflects the loop', /fps/.test(after.chip), JSON.stringify(after.chip));

    /* ---- theme -------------------------------------------------- */
    // applyTheme is the one user path that used to throw. Exercise every theme
    // and assert the accent actually reached the shader colour, not just that
    // the call did not throw.
    const theme = await cdp.eval(`(async () => {
      const app = window.legionApp, st = app.stage;
      const wait = (n) => new Promise((r) => { let i = 0; const t = setInterval(() => { if (++i >= n) { clearInterval(t); r(); } }, 60); });
      const out = [];
      for (const name of ['ember', 'mint', 'mono', 'abyss', 'legion-dark']) {
        app.applyTheme(name);
        await wait(18);
        const u = st.field.uniforms.uColorAccent.value;
        out.push({
          name,
          css: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
          shader: [u.r, u.g, u.b].map((v) => Number(v.toFixed(3))),
          glow: Number(st.themeGlow.toFixed(2)),
          scan: getComputedStyle(document.documentElement).getPropertyValue('--scan-alpha').trim(),
          state: st.state,
          accentTarget: st.accentTarget === st.themeAccent
        });
      }
      return out;
    })()`);
    const wantHex = { ember: '#ff7a45', mint: '#3ee2a4', mono: '#c8d2e0', abyss: '#35c8ff', 'legion-dark': '#35c8ff' };
    const hexToLinear = (hex) => {
      const n = parseInt(hex.slice(1), 16);
      const srgb = [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
      return srgb.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    };
    for (const t of theme) {
      const want = hexToLinear(wantHex[t.name]);
      // The accent eases, so allow a little residual distance from the target.
      const settled = want.every((c, i) => Math.abs(c - t.shader[i]) < 0.06);
      check(`theme applies without throwing: ${t.name}`,
        t.css.toLowerCase() === wantHex[t.name].toLowerCase(),
        `--accent=${t.css} scan=${t.scan} glow=${t.glow}`);
      check(`theme reaches the shader: ${t.name}`,
        settled && t.accentTarget,
        `shader=[${t.shader}] target=[${want.map((v) => v.toFixed(3))}] live-follows=${t.accentTarget}`);
    }
    check('scanline strength is published to CSS', theme.every((t) => t.scan !== ''), `scan=${theme.map((t) => t.scan).join(',')}`);
    // ALERT and ERROR must keep their own colours, or a warning in a pale
    // theme would stop reading as a warning.
    const alertAccent = await cdp.eval(`(async () => {
      const st = window.legionApp.stage;
      st.setState('ALERT'); await new Promise((r) => setTimeout(r, 30));
      const amber = st.accentTarget === st.target.accent;
      st.setState('ERROR'); await new Promise((r) => setTimeout(r, 30));
      const red = st.accentTarget === st.target.accent;
      st.setState('IDLE');
      return { amber, red };
    })()`);
    check('ALERT and ERROR keep fixed warning colours',
      alertAccent.amber && alertAccent.red, JSON.stringify(alertAccent));

    check('status bar has metrics', a.layout.bar && a.layout.bar.vis, JSON.stringify(a.layout));
    check('no page overflow', !a.overflow.x && !a.overflow.y, JSON.stringify(a.overflow));
    check('window has a sane viewport', a.inner.w > 800 && a.inner.h > 600, `${a.inner.w}x${a.inner.h}`);

    // Screenshot + real pixel analysis.
    const SHOT = pickShot();
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const buf = Buffer.from(shot.data, 'base64');
    fs.writeFileSync(SHOT, buf);
    const png = decodePng(buf);
    const an = analyse(png);
    console.log(`\n  framebuffer ${an.width}x${an.height}  ${(buf.length / 1024).toFixed(0)} KB  ${an.colors} distinct colours`);
    console.log(`  mean luminance ${an.meanLum.toFixed(2)}  peak ${an.maxLum.toFixed(1)}  lit ${(an.litFraction * 100).toFixed(2)}%`);
    console.log(`  bright >=200 ${(an.nearFraction * 100).toFixed(2)}%   clipped >=254 ${(an.clippedFraction * 100).toFixed(3)}%`);
    fs.writeFileSync(path.join(OUT, `${BASE}-luminance.json`), JSON.stringify({
      meanLum: an.meanLum, maxLum: an.maxLum, litFraction: an.litFraction,
      nearFraction: an.nearFraction, clippedFraction: an.clippedFraction, colors: an.colors,
      fps: after.fps, instances: after.instances,
    }, null, 2));
    check('screenshot written', fs.existsSync(SHOT), path.relative(ROOT, SHOT));
    check('frame is not a blank canvas', an.litFraction > 0.01, `${(an.litFraction * 100).toFixed(2)}% non-background`);
    check('frame is not a flat fill', an.colors > 50, `${an.colors} distinct colours`);
    check('frame has real luminance range', an.maxLum - an.meanLum > 40, `peak ${an.maxLum} vs mean ${an.meanLum.toFixed(1)}`);
    if (an.litBox) {
      console.log(`  content box x${an.litBox.x} y${an.litBox.y} ${an.litBox.w}x${an.litBox.h}`);
      check('content sits inside the viewport',
        an.litBox.x >= 0 && an.litBox.y >= 0 &&
        an.litBox.x + an.litBox.w <= an.width + 2 && an.litBox.y + an.litBox.h <= an.height + 2,
        JSON.stringify(an.litBox));
    }

    const bad = [...cdp.exceptions, ...cdp.console];
    check('no renderer errors or warnings', bad.length === 0, bad.slice(0, 4).join(' | ') || 'clean');

    console.log(failures ? `\n${failures} check(s) failed` : '\nall render checks passed');
  } catch (err) {
    fail('harness', err.message);
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    await sleep(1500);
  }
  process.exit(failures ? 1 : 0);
}

main();
