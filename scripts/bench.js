/**
 * Performance benchmark.
 *
 * Boots LEGION in a real window and measures it rather than asking it how it
 * feels: time to the first rendered frame, frame-time distribution, JS heap
 * trend, DOM size and the adaptive quality tier over a soak window.
 *
 *   node scripts/bench.js            30 s soak
 *   node scripts/bench.js 120        120 s soak
 *   node scripts/bench.js 30 --json  machine-readable output
 *
 * The frame-time sampler is installed in the page and reads its own rAF
 * timestamps, so it is independent of the app's own fps counter -- if the app
 * were lying about its frame rate, this would still catch it.
 */
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9338;
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const argv = process.argv.slice(2);
const SOAK_SECONDS = Number(argv.find((a) => /^\d+$/.test(a))) || 30;
const AS_JSON = argv.includes('--json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = e.message; }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (last: ${last})` : ''}`);
}

/* -- CDP ---------------------------------------------------------------- */

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    this.exceptions = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        return;
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
  return cdp;
}

/* -- helpers ------------------------------------------------------------ */

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

/** Least-squares slope in units per second. Positive means it is growing. */
function slope(samples) {
  const n = samples.length;
  if (n < 2) return 0;
  const xs = samples.map((_, i) => i);
  const mx = mean(xs); const my = mean(samples.map((s) => s.v));
  let num = 0; let den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (samples[i].v - my); den += (xs[i] - mx) ** 2; }
  return den === 0 ? 0 : num / den / samples[0].dt;
}

function rssKb() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq electron.exe" /FO CSV /NH', { encoding: 'utf8' });
    return out.split('\r\n').filter((l) => l.includes('electron.exe'))
      .map((l) => {
        const m = l.match(/^"electron\.exe","(\d+)","[^"]*","\d+","([\d,]+) K"/);
        return m ? { pid: m[1], kb: Number(m[2].replace(/,/g, '')) } : null;
      })
      .filter(Boolean);
  } catch { return []; }
}

/* -- the benchmark ------------------------------------------------------ */

const report = {};
let child;

try {
  // A stray instance from an earlier run would share the CPU and the process
  // table, so every number below would be quietly wrong. Refuse to measure.
  const stray = rssKb();
  if (stray.length) {
    console.error(`bench refused to run: ${stray.length} electron process(es) already alive (pids ${stray.map((p) => p.pid).join(', ')}).`);
    console.error('Close LEGION (or run: taskkill /F /IM electron.exe /T) and try again.');
    process.exitCode = 1;
    throw new Error('__bench_abort__');
  }

  const t0 = Date.now();
  // Without these, a LEGION window that happens to sit behind another window is
  // throttled by Chromium to roughly 1 rAF per second, and the benchmark ends up
  // measuring the window manager: frames over 1s, a mean of 20fps, and the app
  // dutifully dropping to the "low" tier for no reason of its own. Disabling
  // occlusion and background throttling means the numbers describe the app.
  // The flip side is that worst-case "fully occluded" behaviour is not covered.
  child = spawn(EXE, [
    '.', `--remote-debugging-port=${PORT}`,
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling'
  ], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  });
  const cdp = await connect();

  // Time to the first frame the app actually drew, not merely to the socket.
  await cdp.eval(`(() => { window.__benchFrames = []; window.__benchOn = false;
    const tick = (t) => { if (window.__benchOn) window.__benchFrames.push(t); requestAnimationFrame(tick); };
    requestAnimationFrame(tick); return true; })()`);

  const booted = await waitFor(async () => {
    const v = await cdp.eval(`(() => { const a = window.legionApp, s = a && a.stage;
      if (!s || !s.fps || s.fps <= 0) return null;
      return { fps: s.fps, quality: s.quality, state: a.store ? a.store.state : null }; })()`);
    return v;
  }, 60000, 'the stage to render a first frame');
  const bootMs = Date.now() - t0;
  report.bootMs = bootMs;
  report.bootFps = Math.round(booted.fps);
  report.bootState = booted.state;

  console.log(`boot            ${bootMs} ms to first rendered frame (${report.bootFps} fps, state ${booted.state})`);
  console.log(`soaking         ${SOAK_SECONDS} s\n`);

  await cdp.eval('window.__benchOn = true');

  const samples = [];
  const tiers = [];
  const forMs = SOAK_SECONDS * 1000;
  const started = Date.now();
  let nextReport = 0;

  while (Date.now() - started < forMs) {
    await sleep(1000);
    const s = await cdp.eval(`(() => {
      const m = performance.memory || {};
      const st = window.legionApp && window.legionApp.stage;
      return {
        t: performance.now(),
        frames: window.__benchFrames.length,
        fps: st ? st.fps : 0,
        quality: st ? st.quality : null,
        heap: m.usedJSHeapSize || 0,
        dom: document.getElementsByTagName('*').length,
        listeners: (window.legionApp && window.legionApp.stage && window.legionApp.stage.opts) ? 1 : 0
      };
    })()`);
    const rss = rssKb();
    samples.push({ t: s.t, dt: 1, v: s.heap, fps: s.fps, dom: s.dom, rss: rss.reduce((a, p) => a + p.kb, 0), procs: rss.length, quality: s.quality });
    if (s.quality && tiers[tiers.length - 1] !== s.quality) tiers.push(s.quality);

    const done = Math.round(((Date.now() - started) / forMs) * 100);
    if (done >= nextReport) {
      console.log(`  t+${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s  fps=${String(Math.round(s.fps)).padStart(3)}  heap=${(s.heap / 1048576).toFixed(1)}MB  dom=${s.dom}  procs=${rss.length}  rss=${(rss.reduce((a, p) => a + p.kb, 0) / 1024).toFixed(0)}MB  tier=${s.quality}`);
      nextReport += 10;
    }
  }

  // Frame-time distribution, straight from the rAF timestamps.
  const frames = await cdp.eval('window.__benchFrames');
  const deltas = [];
  for (let i = 1; i < frames.length; i++) deltas.push(frames[i] - frames[i - 1]);
  // A paused tab or a GC pause can emit one huge gap; keep those out of the
  // percentiles but report the worst case separately rather than hiding it.
  const normal = deltas.filter((d) => d > 0 && d < 500);
  const worst = deltas.length ? Math.max(...deltas) : 0;
  // Count the big gaps rather than only reporting the single worst, so one
  // outlier event can be told apart from a renderer that stutters throughout.
  const longFrames = deltas.filter((d) => d >= 100).length;
  const overOneSec = deltas.filter((d) => d >= 1000).length;

  const fpsList = samples.map((s) => s.fps).filter((f) => f > 0);
  const heaps = samples.filter((s) => s.v > 0);
  const heapSlopeKb = heaps.length > 2 ? slope(heaps) / 1024 : 0;
  const third = Math.max(1, Math.ceil(heaps.length / 3));
  const firstThird = heaps.slice(0, third).map((s) => s.v);
  const lastThird = heaps.slice(-third).map((s) => s.v);
  const growthMb = heaps.length ? (mean(lastThird) - mean(firstThird)) / 1048576 : 0;
  // A healthy renderer sawtooths: the heap climbs to a ceiling, the collector
  // takes it back down, and the ceiling stays put. A leak is the ceiling itself
  // climbing. So compare peak-to-peak, not first-sample-to-last-sample -- a
  // least-squares slope over sawtooth reads as positive growth even when the
  // collector is reclaiming everything, which is what a naive check calls a leak.
  const envelopeMb = heaps.length ? (Math.max(...lastThird) - Math.max(...firstThird)) / 1048576 : 0;

  report.frames = frames.length;
  report.frameMs = {
    p50: +pct(normal, 50).toFixed(2),
    p95: +pct(normal, 95).toFixed(2),
    p99: +pct(normal, 99).toFixed(2),
    worst: +worst.toFixed(1),
    longFrames,
    overOneSec
  };
  report.fps = {
    mean: +mean(fpsList).toFixed(1),
    p5: +pct(fpsList, 5).toFixed(1),
    min: fpsList.length ? +Math.min(...fpsList).toFixed(1) : 0
  };
  report.heap = {
    startMb: +(heaps.length ? heaps[0].v : 0).toFixed(1) / 1,
    endMb: heaps.length ? +(heaps[heaps.length - 1].v / 1048576).toFixed(1) : 0,
    peakMb: heaps.length ? +(Math.max(...heaps.map((s) => s.v)) / 1048576).toFixed(1) : 0,
    growthMb: +growthMb.toFixed(2),
    envelopeMb: +envelopeMb.toFixed(2),
    slopeKbPerSec: +heapSlopeKb.toFixed(1)
  };
  report.heap.startMb = heaps.length ? +(heaps[0].v / 1048576).toFixed(1) : 0;
  report.dom = samples.length ? samples[samples.length - 1].dom : 0;
  report.rssMb = samples.length ? +(samples[samples.length - 1].rss / 1024).toFixed(0) : 0;
  report.procs = samples.length ? samples[samples.length - 1].procs : 0;
  report.maxProcs = samples.reduce((m, s) => Math.max(m, s.procs || 0), 0);
  report.tiers = tiers;
  report.exceptions = cdp.exceptions.length;

  const say = (k, v) => console.log(`\n${k.padEnd(16)}${v}`);
  console.log('\n--- results -------------------------------------------');
  say('frame time', `p50 ${report.frameMs.p50}ms  p95 ${report.frameMs.p95}ms  p99 ${report.frameMs.p99}ms  worst ${report.frameMs.worst}ms`);
  say('long frames', `${report.frameMs.longFrames} over 100ms, ${report.frameMs.overOneSec} over 1s, of ${deltas.length} (${(report.frameMs.longFrames / Math.max(1, deltas.length) * 100).toFixed(3)}%)`);
  say('fps', `mean ${report.fps.mean}  p5 ${report.fps.p5}  min ${report.fps.min}  (${report.frames} frames sampled)`);
  say('js heap', `${report.heap.startMb}MB -> ${report.heap.endMb}MB  peak ${report.heap.peakMb}MB  envelope ${report.heap.envelopeMb >= 0 ? '+' : ''}${report.heap.envelopeMb}MB  slope ${report.heap.slopeKbPerSec}KB/s`);
  say('dom nodes', String(report.dom));
  say('process rss', `${report.rssMb} MB across ${report.procs} electron processes (peak count ${report.maxProcs})`);
  say('quality tier', report.tiers.length ? report.tiers.join(' -> ') : `stayed at ${samples[samples.length - 1]?.quality}`);
  say('exceptions', String(report.exceptions));

  // Verdicts. The leak call is made on the peak envelope, because that is what
  // separates a climbing ceiling from ordinary collector sawtooth. The slope is
  // printed but not used to fail: on a 30 s window it is mostly noise.
  const leak = report.heap.envelopeMb > 15;
  const slow = report.fps.mean < 20;
  // A long-frame ratio this high with a p50 that is still fine means frames were
  // not being requested at all for long stretches, i.e. the window was not
  // presenting. Say so rather than reporting it as a slow app.
  const stalled = report.frameMs.longFrames / Math.max(1, deltas.length) > 0.02;
  const leaked = leak || slow || stalled || report.exceptions > 0;
  console.log('');
  if (stalled) {
    console.log(`FAIL  the window was not presenting: ${(report.frameMs.longFrames / deltas.length * 100).toFixed(1)}% of frames over 100ms with a p50 of only ${report.frameMs.p50}ms.`);
    console.log('      The app was throttled, not slow. Close any window covering LEGION, or run on a machine where the window can stay visible.');
  }
  console.log(leaked
    ? `FAIL  ${[leak ? `heap envelope climbed ${report.heap.envelopeMb}MB` : null, slow ? `fps ${report.fps.mean}` : null, stalled ? 'window was not presenting' : null, report.exceptions ? `${report.exceptions} page exception(s)` : null].filter(Boolean).join(', ')}`
    : `PASS  no leak over ${SOAK_SECONDS}s (envelope ${report.heap.envelopeMb >= 0 ? '+' : ''}${report.heap.envelopeMb}MB), ${report.fps.mean} fps mean, ${(report.frameMs.longFrames / deltas.length * 100).toFixed(3)}% long frames, no exceptions`);

  if (AS_JSON) console.log(JSON.stringify(report, null, 2));
  process.exitCode = leaked ? 1 : 0;
} catch (err) {
  // The pre-flight bail-out is a deliberate refusal, not a crash to report.
  if (!/__bench_abort__/.test(String(err && err.message))) {
    console.error('bench failed: ' + (err && err.stack || err));
  }
  if (process.exitCode !== 1) process.exitCode = 1;
} finally {
  if (child) { try { child.kill(); } catch { /* already gone */ } }
  await sleep(600);
  try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* already gone */ }
}
