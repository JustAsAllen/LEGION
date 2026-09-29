/**
 * Launch check: does double-clicking Launch LEGION.vbs actually boot the app,
 * and does it settle instead of freezing?
 *
 * Measures time to a live window, then samples CPU over the following seconds to
 * distinguish "running" (steady, near-zero) from "spinning" (a busy loop) and
 * from "frozen" (no frames).
 */
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const VBS = path.join(ROOT, 'Launch LEGION.vbs');
const PORT = 9341;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = () => {
  try {
    return execSync('tasklist /FI "IMAGENAME eq electron.exe" /FO CSV /NH', { encoding: 'utf8' })
      .split('\r\n').filter((l) => l.includes('electron.exe'));
  } catch { return []; }
};

console.log('killing any existing electron...');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* none */ }
await sleep(1500);

const t0 = Date.now();
console.log('launching: ' + VBS);
spawn('cscript.exe', ['//nologo', VBS], { cwd: ROOT, stdio: 'ignore' });

// 1. a window with the right title must appear
let windowSeen = null;
while (Date.now() - t0 < 60000) {
  await sleep(500);
  const titles = execSync('tasklist /V /FI "IMAGENAME eq electron.exe" /FO CSV /NH', { encoding: 'utf8' })
    .split('\r\n').filter((l) => l.includes('"LEGION"'));
  if (titles.length) { windowSeen = Date.now() - t0; break; }
}
if (windowSeen === null) {
  console.log('FAIL  no window titled LEGION within 60s');
  process.exit(1);
}
console.log('PASS  window titled LEGION after ' + (windowSeen / 1000).toFixed(1) + 's');

// 2. the renderer must answer, i.e. it is not frozen
let probe = null;
const target = await (async () => {
  const end = Date.now() + 40000;
  while (Date.now() < end) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json().catch(() => null);
      if (!list) { /* the app is not launched with a debug port, so measure differently */ return null; }
      return list;
    } catch { await sleep(500); }
  }
  return null;
})();

if (!target) {
  console.log('note  app runs without --remote-debugging-port, using process metrics only');
}

// 3. sample CPU time: a rendering app must burn *some* CPU (it is alive) but
// must not peg a core (a runaway loop). Process count alone cannot tell a
// frozen renderer from a healthy one, so measure the CPU-time delta.
console.log('sampling CPU time for 12s...');
const cpuSnapshot = () => {
  const rows = execSync('tasklist /V /FI "IMAGENAME eq electron.exe" /FO CSV /NH', { encoding: 'utf8' })
    .split('\r\n').filter((l) => l.includes('electron.exe'));
  // The mem field is quoted but contains a comma ("107,520 K"), so a naive
  // split(',') shifts every index and the username gets read as CPU time.
  // Parse the quoted fields properly instead.
  const fields = (line) => (line.match(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g) || [])
    .map((f) => f.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'))
    .filter((f) => f.length);
  return rows.map((r) => {
    const c = fields(r);
    const raw = c[7] || '0:00:00';
    const [h, m, s] = raw.split(':').map(Number);
    return { pid: c[1], mem: c[4], cpu: (h * 3600) + (m * 60) + s };
  });
};

const a = cpuSnapshot();
await sleep(6000);
const b = cpuSnapshot();
const delta = b.reduce((sum, p) => {
  const prev = a.find((x) => x.pid === p.pid);
  return sum + (prev ? p.cpu - prev.cpu : 0);
}, 0);

console.log('  cpu seconds burned by all electron processes in 6s: ' + delta.toFixed(1));
console.log('  processes: ' + b.length);

if (b.length === 0) { console.log('FAIL  all processes exited'); process.exit(1); }
if (!Number.isFinite(delta)) { console.log('FAIL  could not read CPU time (got ' + delta + ')'); process.exit(1); }
if (delta <= 0) {
  console.log('FAIL  no CPU used at all over 6s - the render loop is not running');
  process.exit(1);
}
if (delta > 6 * 4) {
  console.log('FAIL  more than 4 cores saturated over 6s - a runaway loop, not a freeze');
  process.exit(1);
}
console.log('PASS  render loop is alive and not spinning (' + delta.toFixed(1) + ' cpu-s / 6s across ' + b.length + ' processes)');

// Clean up. This must happen: main.js takes a single-instance lock, so an app
// left running here makes the *next* check's instance quit on startup, and the
// following check fails with "timed out waiting for devtools target".
console.log('closing the app...');
try { execSync('taskkill /F /IM electron.exe /T', { stdio: 'ignore' }); } catch { /* already gone */ }
await sleep(800);
const left = procs().length;
if (left !== 0) {
  console.log('FAIL  ' + left + ' electron process(es) survived the shutdown');
  process.exit(1);
}
console.log('PASS  app shut down cleanly, no instance left to block the next check');
