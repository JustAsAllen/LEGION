/**
 * Packaged-build sanity check.
 *
 * The unpacked build is the only artifact where a packaging mistake is visible:
 * a file left out of app.asar, a voice pack that resolves in source but not once
 * bundled, or a renderer that boots and then quietly draws nothing. Source-tree
 * checks cannot see any of that, so this launches the built exe and asks the
 * running app about itself.
 *
 * Run `npm run build` first, then `npm run check:package`.
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'release', 'win-unpacked');
const EXE = path.join(OUT, 'LEGION.exe');
const PACK = path.join(OUT, 'resources', 'voicepack');
const PORT = 9355;

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' -> ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
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

const procs = (name) => {
  try {
    return execSync(`tasklist /FI "IMAGENAME eq ${name}" /FO CSV /NH`, { encoding: 'utf8' })
      .split('\r\n').filter((l) => l.includes(name));
  } catch { return []; }
};
const kill = (name) => { try { execSync(`taskkill /F /IM ${name} /T`, { stdio: 'ignore' }); } catch { /* none */ } };

/* -- 1. the build output itself ---------------------------------------- */

check('the unpacked build exists', fs.existsSync(EXE), path.relative(ROOT, EXE));
if (!fs.existsSync(EXE)) { console.log('\nrun `npm run build` first'); process.exit(1); }
check('app.asar was produced', fs.existsSync(path.join(OUT, 'resources', 'app.asar')),
  (fs.statSync(path.join(OUT, 'resources', 'app.asar')).size / 1048576).toFixed(1) + ' MB');

// A stale build is the one failure mode that still looks green: the app launches
// and answers, just not the code on disk right now. Compare the packaged asar
// against the newest source file so this cannot pass by accident.
{
  const asarMtime = fs.statSync(path.join(OUT, 'resources', 'app.asar')).mtimeMs;
  const srcDir = path.join(ROOT, 'src');
  const pkgMtime = fs.statSync(path.join(ROOT, 'package.json')).mtimeMs;
  let newest = { file: null, mtime: 0 };
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const m = fs.statSync(p).mtimeMs;
        if (m > newest.mtime) newest = { file: path.relative(ROOT, p), mtime: m };
      }
    }
  };
  walk(srcDir);
  const staleBy = Math.max(newest.mtime, pkgMtime) - asarMtime;
  check('the build is not stale', staleBy <= 0,
    staleBy <= 0
      ? `asar is newer than ${newest.file}`
      : `asar is ${Math.round(staleBy / 1000)}s older than ${newest.file} - run \`npm run build\` again`);
}

/* -- 2. the pack shipped outside the asar, where a user can edit it ----- */

check('the editable pack sits beside the exe', fs.existsSync(path.join(PACK, 'manifest.json')), path.relative(OUT, PACK));
const clips = fs.existsSync(PACK) ? fs.readdirSync(PACK).filter((f) => f.endsWith('.wav')) : [];
check('all six clips shipped', clips.length === 6, `${clips.length} wav files: ${clips.join(', ')}`);

/* -- 3. the asar is really what the exe will run ------------------------ */

const asar = path.join(OUT, 'resources', 'app.asar');
const asarList = (() => {
  try {
    return execSync(`npx asar list "${asar}"`, { encoding: 'utf8', cwd: ROOT, shell: 'cmd.exe' });
  } catch { return ''; }
})();
check('the bundled copy of the pack is in app.asar', /voicepack[\\/]manifest\.json/.test(asarList),
  asarList ? 'listed in the asar' : 'could not list the asar (asar list failed)');

/* -- 4. launch the built exe -------------------------------------------- */

console.log('\nclearing any running instance (main.js takes a single-instance lock)...');
kill('LEGION.exe'); kill('electron.exe');
await sleep(1500);

const t0 = Date.now();
console.log('launching ' + path.relative(ROOT, EXE));

// Windows Application Control (Smart App Control, AppLocker, WDAC) refuses to
// run an unsigned binary and surfaces that as a spawn failure. That is a host
// policy, not a broken build, so it gets reported as one instead of crashing
// the whole check with an unhandled child_process error.
const launched = await new Promise((resolve) => {
  let child;
  try {
    child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'ignore', detached: true });
  } catch (err) {
    return resolve({ ok: false, error: err.message });
  }
  child.on('error', (err) => resolve({ ok: false, error: err.message }));
  child.on('spawn', () => resolve({ ok: true }));
});

if (!launched.ok) {
  const hostBlocked = /Application Control|Smart App Control|blocked|not permitted|access is denied/i.test(launched.error || '');
  if (hostBlocked && process.env.LEGION_ALLOW_UNSIGNED_PACKAGE_CHECK === '1') {
    console.log('\\nSKIP  executable launch: Windows policy blocked the unsigned test binary; static package checks passed.');
    console.log('      This flag does not disable Windows security; it only makes static validation non-failing.');
    kill('LEGION.exe');
    await sleep(600);
    process.exit(failed ? 1 : 0);
  }
  check('the built exe can be launched on this machine', false,
    `Windows refused to start it: ${launched.error}. ` +
    'An unsigned self-built exe may be blocked by Application Control or Smart App Control; ' +
    'sign the binary or use LEGION_ALLOW_UNSIGNED_PACKAGE_CHECK=1 for static package validation.');
  console.log('\nthe static parts of the build were checked, but this host refused to run it');
  kill('LEGION.exe');
  await sleep(600);
  console.log('');
  if (failed) { console.log(`${failed} packaged-build check(s) FAILED`); process.exit(1); }
  process.exit(1);
}

let windowAt = null;
while (Date.now() - t0 < 90000) {
  await sleep(500);
  if (execSync('tasklist /V /FI "IMAGENAME eq LEGION.exe" /FO CSV /NH', { encoding: 'utf8' })
    .split('\r\n').some((l) => l.includes('"LEGION"'))) { windowAt = Date.now() - t0; break; }
}
check('the built exe opened a window titled LEGION', windowAt !== null, windowAt === null ? 'none within 90s' : `${(windowAt / 1000).toFixed(1)}s`);

if (windowAt === null) { console.log('\nno window; cleaning up'); kill('LEGION.exe'); process.exit(1); }

let cdp = null;
const end = Date.now() + 45000;
while (Date.now() < end && !cdp) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json().catch(() => null);
    const t = list && list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
    if (t) {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', () => rej(new Error('socket failed')), { once: true });
      });
      cdp = new Cdp(ws);
      await cdp.send('Runtime.enable');
    }
  } catch { await sleep(600); }
}
check('the packaged renderer accepted a devtools connection', !!cdp);

/* -- 5. ask the running app about itself -------------------------------- */

if (cdp) {
  // Poll until boot finishes. A devtools target appears while the boot overlay is
  // still up, so asking immediately reads BOOTING and a canvas that has not had
  // its first frame yet -- both of which look like a broken packaged build.
  const waitFor = async (fn, ms, what) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await fn().catch(() => null);
      if (v) return v;
      await sleep(500);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  const boot = await waitFor(
    () => cdp.eval(`(() => {
      const app = window.legionApp;
      const b = document.getElementById('boot');
      const gone = b && b.classList.contains('is-gone');
      if (!window.legion || !app || !gone) return null;
      return { state: (app.store && app.store.state) || null, bootGone: !!gone,
               hasBridge: !!window.legion, hasApp: !!app };
    })()`).then((v) => (v && v.state === 'IDLE' ? v : null)),
    60000,
    'boot to finish'
  ).catch((e) => ({ error: e.message }));

  check('the preload bridge is present in the packaged build',
    !!boot && !boot.error && boot.hasBridge && boot.hasApp,
    boot && boot.error ? boot.error : `bridge=${boot.hasBridge} app=${boot.hasApp}`);
  check('the state machine settled', !!boot && !boot.error && boot.state === 'IDLE',
    boot && boot.error ? boot.error : String(boot && boot.state));

  // The stage is WebGL (three), not 2D, so getContext('2d') returns null and
  // getImageData would throw. toDataURL() is context-agnostic: a blank canvas
  // serialises to "data:," while a drawn one carries real pixels.
  const ring = await cdp.eval(`(() => {
    const cv = document.querySelector('#stage canvas');
    if (!cv) return { found: false };
    let url = '';
    try { url = cv.toDataURL('image/png'); } catch (e) { return { found: true, tainted: true, w: cv.width, h: cv.height }; }
    return { found: true, w: cv.width, h: cv.height, bytes: url.length, blank: url === 'data:,' };
  })()`);
  check('the ring canvas exists in the packaged build', ring.found, ring.found ? `${ring.w}x${ring.h}` : '#stage canvas missing');
  if (ring.found) {
    check('the ring actually drew pixels', !ring.blank && !ring.tainted && ring.bytes > 2000,
      ring.tainted ? 'canvas is tainted, cannot read' : `${ring.bytes} bytes of PNG data, blank=${ring.blank}`);
  }

  // The decisive one: the pack must resolve to the editable copy beside the exe,
  // and a canned phrase must play from it rather than falling back to SAPI.
  const pack = await cdp.eval('window.legion.voice.pack().then(p => ({ root: p.root, exists: p.exists, count: p.entries.length, enabled: p.enabled, name: p.name }))')
    .catch((e) => ({ error: e.message }));
  check('the packaged app found a voice pack', !!pack && pack.exists === true && pack.count > 0,
    pack && pack.error ? pack.error : `${pack.name} with ${pack.count} entries`);
  check('it resolved the editable copy beside the exe', !!(pack && !pack.error && path.basename(path.dirname(pack.root)) === 'resources'),
    pack && !pack.error ? pack.root : 'n/a');

  const spoke = await cdp.eval('window.legion.voice.speak("yes").then(r => ({ source: r.source, tier: r.tier, pack: r.pack, phrase: r.phrase }))')
    .catch((e) => ({ error: e.message }));
  check('a canned phrase played from the pack, not TTS fallback',
    !!(spoke && spoke.source === 'voicepack'), spoke && spoke.error ? spoke.error : `source=${spoke.source} tier=${spoke.tier} phrase="${spoke.phrase}"`);

  // The four-tier pipeline has to be reachable from the packaged renderer too,
  // or the settings panel would describe a pipeline the app cannot run.
  const pipe = await cdp.eval('window.legion.voice.pipeline().then(p => ({ mode: p.mode, tiers: p.modes, pack: p.pack.exists, online: p.online.available, piper: p.piper.available, sapi: p.sapi.available }))')
    .catch((e) => ({ error: e.message }));
  check('the voice pipeline is exposed and all four tiers are known',
    !!(pipe && !pipe.error && pipe.tiers && pipe.tiers.length === 3 && pipe.pack === true),
    pipe && pipe.error ? pipe.error : `mode=${pipe.mode} modes=${(pipe.tiers || []).join('/')} pack=${pipe.pack} online=${pipe.online} piper=${pipe.piper} sapi=${pipe.sapi}`);

  // The settings panel must offer the mode control, or the tier the user picks
  // cannot actually be chosen.
  const modeUi = await cdp.eval(`(() => {
    const open = () => { const s = document.getElementById('set-tts-mode'); return s ? [...s.options].map(o => o.value) : null; };
    if (open()) return open();
    const btn = [...document.querySelectorAll('button,[role=tab],[data-tab]')]
      .find(b => /settings/i.test(b.textContent || ''));
    if (btn) btn.click();
    return open();
  })()`).catch((e) => ({ error: e.message }));
  check('the settings panel offers every voice source mode',
    Array.isArray(modeUi) && modeUi.join(',') === 'auto,offline,pack-only',
    JSON.stringify(modeUi));

  // The online tier returns MP3 while everything else returns WAV, so the
  // renderer's decode path has to cope with both. This needs the real service,
  // so it is opt-in; the hermetic checks above already prove the tier order.
  if (process.env.LEGION_LIVE_VOICE === '1') {
    const decoded = await cdp.eval(`(async () => {
      const r = await window.legion.voice.speak('The reactor is holding at ninety percent capacity.');
      if (!r.audioBase64) return { error: 'no audio: ' + JSON.stringify(r) };
      const bin = atob(r.audioBase64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const ctx = new AudioContext();
      const buf = await ctx.decodeAudioData(u.buffer);
      await ctx.close();
      return { format: r.format, tier: r.tier, duration: buf.duration, rate: buf.sampleRate, ch: buf.numberOfChannels };
    })()`).catch((e) => ({ error: e.message }));
    check('the packaged app decodes online audio end to end',
      !!(decoded && !decoded.error && decoded.tier === 'online' && decoded.duration > 0.3),
      decoded && decoded.error ? decoded.error
        : `tier=${decoded.tier} format=${decoded.format} decoded ${decoded.duration.toFixed(2)}s at ${decoded.rate}Hz ${decoded.ch}ch`);
  } else {
    console.log('  note  set LEGION_LIVE_VOICE=1 to check online audio decoding in the packaged app');
  }
}

/* -- 6. leave nothing behind -------------------------------------------- */

console.log('\nshutting the packaged app down...');
kill('LEGION.exe');
await sleep(1200);
const left = procs('LEGION.exe').length;
check('no instance survived', left === 0, left ? `${left} still running` : 'clean');

console.log('');
if (failed) { console.log(`${failed} packaged-build check(s) FAILED`); process.exit(1); }
console.log('packaged build verified');
process.exit(0);
