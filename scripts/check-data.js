/**
 * Exercises the main-process data layer without a window, so metrics and IPC
 * handlers can be verified before the renderer is involved.
 */

const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Use a scratch userData so the run never touches real settings or history.
const USER_DATA = path.join(os.tmpdir(), 'legion-selftest-' + process.pid);

const metrics = require(path.join(ROOT, 'src/main/system/metrics.js'));
const { ConfigStore } = require(path.join(ROOT, 'src/main/config.js'));
const { MemoryStore } = require(path.join(ROOT, 'src/main/memory.js'));
const { ToolManager } = require(path.join(ROOT, 'src/main/tools/index.js'));
const tts = require(path.join(ROOT, 'src/main/voice/tts.js'));

let failures = 0;
const ok = (label, v) => console.log('  PASS  ' + label + ' -> ' + v);
const bad = (label, e) => { console.log('  FAIL  ' + label + ' -> ' + e.message); failures++; };
const check = async (label, fn) => {
  try { ok(label, await fn()); } catch (e) { bad(label, e); }
};

(async () => {
  console.log('scratch userData: ' + USER_DATA + '\n');

  console.log('metrics.staticInfo()');
  const stat = await metrics.staticInfo().catch((e) => { bad('staticInfo', e); return null; });
  if (stat) {
    ok('cpu.brand', stat.cpu.brand);
    ok('cpu.cores', stat.cpu.cores);
    ok('memory.totalBytes', stat.memory.totalBytes);
    ok('gpu.model', stat.gpu ? stat.gpu.model : 'null');
    ok('battery.hasBattery', stat.battery.hasBattery);
    ok('os.distro', stat.os ? stat.os.distro : 'null');
    ok('host.electronVersion', stat.host.electronVersion);
    ok('time.timezone', stat.time ? stat.time.timezone : 'null');
    ok('time.timezoneName', stat.time ? stat.time.timezoneName : 'null');
    if (!stat.time || typeof stat.time.current !== 'number') bad('time.current', new Error('missing'));
  }

  console.log('\nmetrics.currentLoad()');
  const load = await metrics.currentLoad().catch((e) => { bad('currentLoad', e); return null; });
  if (load) { ok('cpuPct', load.cpuPct); ok('memPct', load.memPct); ok('processMemBytes', load.processMemBytes); }

  console.log('\nmetrics.networkInfo(true)');
  const net = await metrics.networkInfo(true).catch((e) => { bad('networkInfo', e); return null; });
  if (net) { ok('online', String(net.online)); ok('latencyMs', String(net.latencyMs)); ok('activeInterface', String(net.activeInterface)); ok('ip4', String(net.ip4)); }

  console.log('\nmetrics.diskInfo()');
  const disk = await metrics.diskInfo().catch((e) => { bad('diskInfo', e); return null; });
  if (disk) { ok('root.mount', disk.root ? disk.root.mount : 'null'); ok('root.sizeBytes', disk.root ? disk.root.sizeBytes : 'null'); }

  console.log('\nConfigStore');
  try {
    const config = new ConfigStore(USER_DATA);
    const c = config.get();
    ok('defaults loaded', Object.keys(c).length + ' top-level keys');
    if (typeof c.onboarded !== 'boolean') throw new Error('onboarded not boolean');
    if (typeof c.visual.quality !== 'string') throw new Error('visual.quality missing');
    if (typeof c.voice.voiceName !== 'string') throw new Error('voice.voiceName missing');
    if (typeof c.memory.longTermEnabled !== 'boolean') throw new Error('memory.longTermEnabled missing');
    if (typeof c.tools.allowDev !== 'boolean') throw new Error('tools.allowDev missing');
    if (typeof c.app.autoListenOnLaunch !== 'boolean') throw new Error('app.autoListenOnLaunch missing');
    ok('schema keys verified', 'onboarded, visual.quality, voice.voiceName, memory.longTermEnabled, tools.allowDev, app.autoListenOnLaunch');
    config.patch({ visual: { quality: 'medium' } });
    if (config.get().visual.quality !== 'medium') throw new Error('patch did not persist in memory');
    ok('patch visual.quality', config.get().visual.quality);
  } catch (e) { bad('ConfigStore', e); }

  console.log('\nMemoryStore');
  try {
    const config = new ConfigStore(USER_DATA);
    const memory = new MemoryStore(USER_DATA, config);
    memory.appendMessage('user', 'hello there');
    memory.appendMessage('assistant', 'general kenobi');
    const s = memory.summary();
    ok('summary.messages', String(s.messages));
    const view = memory.sessionView();
    ok('sessionView length', String(view.length));
    if (view.length !== 2) throw new Error('expected 2 session messages');
    // remember() is gated on the config, which is the intended behaviour, so
    // the gate is exercised explicitly rather than worked around.
    const gated = memory.remember('should not be stored while disabled');
    if (gated.stored) throw new Error('remember stored data while long-term was off');
    ok('remember gated while off', gated.reason);

    config.patch({ memory: { longTermEnabled: true } });
    const stored = memory.remember('user prefers dark themes');
    if (!stored.stored) throw new Error('remember failed: ' + stored.reason);
    const listed = memory.list();
    if (listed.length !== 1) throw new Error('long-term remember failed, got ' + listed.length);
    ok('long-term entries', String(listed.length));
    ok('long-term text', listed[0].text);
    if (!('createdAt' in listed[0])) throw new Error('createdAt missing');
    const ctx = await memory.context('what do I like?');
    ok('context injected', String(ctx).slice(0, 70).replace(/\n/g, ' '));
    memory.forget(listed[0].id);
    ok('after forget', String(memory.list().length));
  } catch (e) { bad('MemoryStore', e); }

  console.log('\nToolManager');
  try {
    const shell = require('electron').shell;
    const config = new ConfigStore(USER_DATA);
    const { SecretStore } = require(path.join(ROOT, 'src/main/secrets.js'));
    const secretStore = new SecretStore(USER_DATA);
    const memory = new MemoryStore(USER_DATA, config);
    const { ProductivityStore } = require(path.join(ROOT, 'src/main/tools/productivity.js'));
    const productivity = new ProductivityStore(path.join(USER_DATA, 'productivity.json'));
    const si = require(path.join(ROOT, 'src/main/system/metrics.js'));
    const tm = new ToolManager({ settings: config, secrets: secretStore, shell, memory, productivity, si, onConfirm: () => {} });

    // The registry is the real catalogue; list() only reports enablement.
    const reg = tm.registry.list();
    ok('registry tools', String(reg.length));
    const byCat = reg.reduce((a, t) => { a[t.category] = (a[t.category] || 0) + 1; return a; }, {});
    ok('by category', JSON.stringify(byCat));
    for (const t of reg) {
      if (!t.description) throw new Error('missing description on ' + t.name);
      if (!t.parameters || typeof t.parameters !== 'object') throw new Error('missing parameter schema on ' + t.name);
    }
    ok('every tool has description + schema', 'ok');

    const listed = tm.list();
    ok('tools total', String(listed.length));
    ok('list() enabled', String(listed.filter((t) => t.enabled).length));
    if (listed.length !== reg.length) throw new Error('list() and registry disagree on tool count');
    for (const t of listed) {
      if (typeof t.requiresConfirmation !== 'boolean') throw new Error('missing requiresConfirmation on ' + t.name);
    }
    ok('list() requiresConfirmation present', 'ok');

    // A read-only tool must actually run.
    const fullStatus = await tm.execute('system_full_status', {});
    ok('system_full_status ran', JSON.stringify(fullStatus).slice(0, 90));

    // Dev tools must stay locked while tools.allowDev is false.
    try {
      await tm.execute('dev_commands', {});
      bad('dev gate', new Error('dev tool ran with tools.allowDev off'));
    } catch (e) {
      if (/allowDev|disabled|not enabled|forbidden|off/i.test(e.message)) ok('dev tool blocked while allowDev is off', e.message.slice(0, 70));
      else bad('dev gate', new Error('unexpected error: ' + e.message));
    }
    ok('list() requiresConfirmation present', 'ok');
  } catch (e) { bad('ToolManager', e); }

  console.log('\nvoice/tts');
  const vs = await tts.listVoices().catch((e) => { bad('tts.listVoices', e); return null; });
  if (vs) { ok('tts.available', String(vs.ttsAvailable)); ok('tts.voices', String(vs.voices.length)); }

  console.log('\nvoice synthesis');
  try {
    const out = await tts.synthesize('Testing speech output from LEGION.');
    if (out.empty || !out.audio) throw new Error('no audio payload: ' + JSON.stringify(Object.keys(out)));
    const buf = Buffer.isBuffer(out.audio) ? out.audio : Buffer.from(out.audio);
    const riff = buf.toString('ascii', 0, 4);
    const wave = buf.toString('ascii', 8, 12);
    if (riff !== 'RIFF' || wave !== 'WAVE') throw new Error('not a RIFF/WAVE payload');
    ok('wav header', riff + '/' + wave);
    ok('wav bytes', String(buf.length));
    ok('wav durationMs', String(out.durationMs));
  } catch (e) { bad('tts.synthesize', e); }

  require('fs').rmSync(USER_DATA, { recursive: true, force: true });

  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nall data-layer checks passed');
  process.exit(failures ? 1 : 0);
})();
