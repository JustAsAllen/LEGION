'use strict';

/**
 * Security audit checks.
 *
 * These assert the properties the security model depends on, so a later change
 * that quietly breaks one of them fails the suite instead of shipping:
 *
 *  1. the window is hardened and the preload exposes no generic bridge
 *  2. no secret value can reach the renderer through any channel
 *  3. filesystem access from the renderer is confined to LEGION's own locations
 *  4. the tool sandbox refuses traversal, NUL bytes, drive roots and symlinks
 *
 * The secret checks run against the real SecretStore with a real key, and then
 * assert the key is absent from everything the store will hand back.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { SecretStore, ENV_MAP } = require('../src/main/secrets');
const { PathSandbox, SandboxError, HOME } = require('../src/main/tools/sandbox');

const ROOT = path.resolve(__dirname, '..');

let failed = 0;
const results = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail: detail || '' });
  } catch (err) {
    failed++;
    results.push({ ok: false, name, detail: err.message });
  }
}

(async () => {
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');

  /* ---- 1. window hardening and the bridge surface ------------------- */

  await check('the window is hardened', () => {
    for (const [flag, want] of [['contextIsolation', 'true'], ['nodeIntegration', 'false'], ['sandbox', 'true']]) {
      const re = new RegExp(`${flag}\\s*:\\s*${want}`);
      assert(re.test(main), `webPreferences is missing ${flag}: ${want}`);
    }
    assert(/webSecurity\s*:\s*true/.test(main), 'webSecurity is not explicitly true');
    return 'contextIsolation, sandbox and webSecurity on, nodeIntegration off';
  });

  await check('the preload exposes no generic bridge', () => {
    // A shared invoke(ch, ...) or a raw ipcRenderer hand-off would let the
    // renderer call any channel, including ones with no allowlist entry.
    assert(!/exposeInMainWorld[\s\S]*?invoke\s*:\s*\(/.test(preload), 'a generic invoke is exposed');
    assert(!/contextBridge\.exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/.test(preload), 'ipcRenderer is exposed directly');
    assert(!/exposeInMainWorld[\s\S]*?\b(require|process|Buffer)\s*[:,]/.test(preload), 'a Node primitive is exposed');
    const allow = preload.match(/INVOKE_CHANNELS\s*=\s*\[([\s\S]*?)\]/);
    assert(allow, 'no invoke allowlist found');
    const channels = [...allow[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert(channels.length > 30, `only ${channels.length} channels in the allowlist`);
    assert(new Set(channels).size === channels.length, 'the allowlist has duplicate channels');
    return `${channels.length} channels, all named`;
  });

  /* ---- 2. secrets stay in main -------------------------------------- */

  const CANARY = 'sk-test-canary-do-not-leak-0123456789abcdef';
  const store = new SecretStore(fs.mkdtempSync(path.join(os.tmpdir(), 'legion-sec-')));

  await check('a secret is stored and reported as present', () => {
    store.set('openai', CANARY);
    const st = store.status('openai');
    assert(st.configured === true, 'the store did not report the key as configured');
    assert(store.get('openai') === CANARY, 'main could not read the key back');
    return `stored, source ${st.source}`;
  });

  await check('status() never contains the key', () => {
    const serialised = JSON.stringify(store.status('openai'));
    assert(!serialised.includes(CANARY), 'the key leaked into status()');
    const allowed = new Set(['provider', 'configured', 'source', 'envVar']);
    for (const k of Object.keys(store.status('openai'))) {
      assert(allowed.has(k), `status() exposes an unexpected field "${k}"`);
    }
    return `fields: ${[...allowed].join(', ')}`;
  });

  await check('set() and clear() return status, not the value', () => {
    assert(!JSON.stringify(store.set('openai', CANARY)).includes(CANARY), 'set() echoed the key back');
    assert(!JSON.stringify(store.clear('openai')).includes(CANARY), 'clear() echoed the key back');
    return 'both return presence only';
  });

  await check('the whole store object never serialises the key', () => {
    assert(!JSON.stringify(store.values).includes(CANARY), 'JSON.stringify(store) leaked the key');
    assert(!JSON.stringify({ ...store, values: store.values }).includes(CANARY), 'a spread of the store leaked the key');
    return 'the raw map is the only place it lives';
  });

  await check('no handler returns secrets.get()', () => {
    const bad = [...main.matchAll(/handle\('([^']+)'[\s\S]{0,400}?secrets\.get\(/g)];
    assert(bad.length === 0, `handler(s) return the real key: ${bad.map((b) => b[1]).join(', ')}`);
    return 'no handler calls secrets.get()';
  });

  await check('config:get sends secret status, not a value', () => {
    const m = main.match(/handle\('config:get'[\s\S]{0,300}?\n  \}\);/);
    assert(m, 'config:get not found');
    assert(/secrets\.status\(/.test(m[0]), 'config:get does not use secrets.status()');
    assert(!/secrets\.get\(/.test(m[0]), 'config:get calls secrets.get()');
    return 'presence only';
  });

  await check('an env-supplied key is readable in main but not in status', () => {
    // The real path for most users: the key arrives as an env var, never touching
    // disk. status() publishes the variable *name* so the UI can explain where a
    // key came from, but never its value.
    const name = ENV_MAP.openai;
    const prev = process.env[name];
    process.env[name] = CANARY + '-env';
    try {
      const st = store.status('openai');
      assert(st.source === 'environment', `source was "${st.source}", expected "environment"`);
      assert(st.envVar === name, `envVar was "${st.envVar}", expected "${name}"`);
      assert(JSON.stringify(st).includes(name), 'status() should name the variable');
      assert(!JSON.stringify(st).includes(CANARY), 'the env value leaked into status()');
      assert(store.get('openai') === CANARY + '-env', 'main could not read the env key');
      return `status() names ${name} and withholds its value`;
    } finally {
      if (prev === undefined) delete process.env[name]; else process.env[name] = prev;
    }
  });

  await check('the temporary store is destroyed', () => {
    const dir = store.file.replace(/secrets\.json$/, '');
    store.clear('openai');
    fs.rmSync(dir, { recursive: true, force: true });
    assert(!fs.existsSync(dir), `the test key file survived at ${dir}`);
    return 'canary key removed from disk';
  });

  /* ---- 3. shell paths from the renderer ----------------------------- */

  await check('openPath is confined to LEGION locations', () => {
    assert(/handle\('shell:openPath'[\s\S]{0,80}?assertOpenable\(/.test(main),
      'shell:openPath does not validate its argument');
    const guard = main.match(/const assertOpenable = [\s\S]*?\n  \};/);
    assert(guard, 'assertOpenable not found');
    assert(/realpathSync/.test(guard[0]), 'the guard does not resolve symlinks');
    assert(/path\.relative/.test(guard[0]), 'the guard does not use containment');
    return 'validated, then re-checked after symlink resolution';
  });

  await check('openExternal only allows http and https', () => {
    assert(/app:openExternal[\s\S]{0,300}?https\?:/.test(main), 'openExternal does not restrict the protocol');
    return 'file:, javascript: and custom schemes are refused';
  });

  /* ---- 4. the tool sandbox ------------------------------------------ */

  const sandbox = new PathSandbox([]);

  await check('the sandbox confines paths to the user profile', () => {
    const inside = sandbox.resolve(path.join(HOME, 'notes.txt'), { mustExist: false });
    assert(inside.startsWith(HOME), 'a path inside home was rewritten');
    for (const outside of ['C:\\Windows\\System32\\drivers\\etc\\hosts', path.join(os.tmpdir(), 'x')]) {
      if (outside.startsWith(HOME)) continue;
      let threw = false;
      try { sandbox.resolve(outside); } catch (e) { threw = e instanceof SandboxError; }
      assert(threw, `the sandbox allowed ${outside}`);
    }
    return 'outside the profile is refused';
  });

  await check('the sandbox refuses traversal, NUL bytes and drive roots', () => {
    // Containment is decided by where a path finally lands, not by the string:
    // a relative path that stays inside the profile is legitimately allowed, so
    // these cases are built from HOME to actually escape, independent of cwd.
    const escape = path.join(HOME, '..', '..', 'Windows', 'System32');
    const backIn = path.join(HOME, 'Desktop', 'legion', '..', 'legion', 'notes.txt');
    const cases = [
      [escape, 'traversal out of the profile'],
      ['C:\\', 'drive root'],
      ['C:\\Users', 'a directory outside the profile'],
      ['ok.txt\0.exe', 'NUL byte'],
      ['', 'empty path'],
      [null, 'non-string']
    ];
    for (const [input, label] of cases) {
      let threw = null;
      try { sandbox.resolve(input); } catch (e) { threw = e; }
      assert(threw instanceof SandboxError, `accepted ${label}`);
    }
    // And the inverse, so the check cannot pass by refusing everything.
    assert(sandbox.resolve(backIn).startsWith(HOME), 'a legitimate path inside the profile was refused');
    return `${cases.length} hostile inputs refused, a legitimate one allowed`;
  });

  await check('a symlink cannot escape an allowed root', () => {
    const root = fs.mkdtempSync(path.join(HOME, 'legion-sandbox-'));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'legion-outside-'));
    const link = path.join(root, 'escape');
    let made = false;
    try {
      fs.symlinkSync(target, link, 'junction');
      made = true;
      let threw = null;
      try { sandbox.resolve(path.join(link, 'loot.txt')); } catch (e) { threw = e; }
      assert(threw instanceof SandboxError, 'the sandbox followed a symlink out of its root');
    } catch (err) {
      if (err.code === 'EPERM') return 'skipped: creating a junction needs elevation here';
      throw err;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
    return made ? 'junction escape refused' : '';
  });

  await check('every file tool resolves its path through the sandbox', () => {
    const files = fs.readFileSync(path.join(ROOT, 'src', 'main', 'tools', 'files.js'), 'utf8');
    const takes = (files.match(/path\s*:\s*\{/g) || []).length;
    const resolves = (files.match(/sandbox\.resolve\(/g) || []).length;
    assert(takes > 0, 'files.js declares no path parameters, so this check proves nothing');
    assert(resolves >= takes, `only ${resolves} sandbox.resolve calls for ${takes} path parameters`);
    return `${takes} path parameters, ${resolves} sandboxed resolutions`;
  });

  console.log('');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ' -> ' + r.detail : ''}`);
  }
  console.log('');
  if (failed) {
    console.log(`${failed} of ${results.length} security checks FAILED`);
    process.exit(1);
  }
  console.log(`all ${results.length} security checks passed`);
})().catch((err) => {
  console.error('security check crashed: ' + (err && err.stack || err));
  process.exit(1);
});
