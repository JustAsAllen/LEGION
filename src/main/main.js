'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, globalShortcut, Tray, Menu, nativeImage, session, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

/* A custom scheme gives the renderer a real origin. ES module imports and
   Web Workers are blocked over file:// by Chromium, so the interface is served
   from app://legion instead. Registered before the app becomes ready. */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
]);

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

const { ConfigStore } = require('./config');
const { SecretStore } = require('./secrets');
const { MemoryStore } = require('./memory');
const { ToolManager } = require('./tools');
const { AIEngine } = require('./ai/engine');
const tts = require('./voice/tts');
const stt = require('./voice/stt');
const wake = require('./voice/wake');
const metrics = require('./system/metrics');
const si = require('systeminformation');

const isDev = process.argv.includes('--dev');
const START_HIDDEN = process.argv.includes('--hidden');
// Redirect before any store is constructed, so dev data is genuinely separate
// from an installed copy's data.
if (isDev) app.setPath('userData', path.join(app.getPath('userData'), 'dev'));
const USER_DATA = app.getPath('userData');

let win = null;
let tray = null;
let quitting = false;

const config = new ConfigStore(USER_DATA);
const secrets = new SecretStore(USER_DATA);
const memory = new MemoryStore(USER_DATA, config);
const productivity = new (require('./tools/productivity').ProductivityStore)(path.join(USER_DATA, 'productivity.json'));

/* ------------------------------------------------------------------ */
/* Tool + AI wiring                                                    */
/* ------------------------------------------------------------------ */

const toolManager = new ToolManager({
  settings: config,
  secrets,
  shell,
  memory,
  productivity,
  si,
  onConfirm: (request) => {
    send('tool:confirmation', request);
  }
});

const ai = new AIEngine({
  settings: config,
  secrets,
  toolManager,
  memory,
  onEvent: (type, payload) => {
    send('ai:event', { type, payload });
    if (type === 'tool' && payload.phase === 'start') setState('PROCESSING');
  }
});

productivity.onTimer((t) => {
  send('timer:fired', { id: t.id, label: t.label, at: new Date().toISOString() });
});

/* ------------------------------------------------------------------ */
/* State machine (authoritative in main; mirrored in renderer)         */
/* ------------------------------------------------------------------ */

const STATES = ['OFFLINE', 'BOOTING', 'IDLE', 'LISTENING', 'PROCESSING', 'SPEAKING', 'ALERT', 'ERROR'];
let currentState = 'OFFLINE';
let lastError = null;

function setState(next, detail) {
  if (!STATES.includes(next)) return;
  if (currentState === next && !detail) return;
  currentState = next;
  if (next !== 'ERROR') lastError = null;
  send('state', { state: next, detail: detail || null, at: Date.now() });
}

function setError(err) {
  lastError = { message: err && err.message ? err.message : String(err), code: (err && err.code) || 'E_UNKNOWN', at: Date.now() };
  setState('ERROR', lastError);
}

function send(channel, payload) {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

function createWindow() {
  const bounds = config.get().window || {};
  win = new BrowserWindow({
    width: bounds.width || 1440,
    height: bounds.height || 900,
    minWidth: 900,
    minHeight: 620,
    x: bounds.x, y: bounds.y,
    show: false,
    backgroundColor: '#05070c',
    frame: false,
    titleBarStyle: 'hidden',
    transparent: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // LEGION is an always-on companion with a live mark. Chromium's default
      // freezes requestAnimationFrame and CSS transitions in an unfocused window,
      // so the ring stopped breathing and fades stalled half-done whenever the
      // user clicked away. The mark has to keep running when it is not in front.
      backgroundThrottling: false,
      devTools: isDev,
      additionalArguments: [
        `--legion-provider=${config.get().ai.provider || 'none'}`,
        `--legion-version=${app.getVersion()}`
      ]
    }
  });

  win.loadURL('app://legion/index.html');

  win.once('ready-to-show', () => {
    const startHidden = START_HIDDEN || !!config.get().app.startMinimized;
    if (!startHidden) win.show();
    if (startHidden && config.get().app.closeToTray) ensureTray();
  });

  const persistBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const b = win.getBounds();
    config.patch({ window: { width: b.width, height: b.height, x: b.x, y: b.y } });
  };
  win.on('resized', persistBounds);
  win.on('moved', persistBounds);

  win.on('close', (e) => {
    if (!quitting && config.get().app.closeToTray) {
      e.preventDefault();
      minimizeToTray();
    }
  });

  win.on('closed', () => { win = null; });

  // External links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://legion/')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });

  win.on('focus', () => { if (win && !win.isDestroyed()) win.webContents.send('window:focus', true); });
  win.on('blur', () => { if (win && !win.isDestroyed()) win.webContents.send('window:focus', false); });

  hardenSession();
}

/**
 * Serve the renderer from app://legion. Only files inside the renderer
 * directory are reachable, and only by exact resolved path, so a crafted URL
 * cannot walk out of the bundle.
 */
function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const target = path.join(RENDERER_DIR, rel);
      const resolved = path.resolve(target);
      if (resolved !== path.resolve(RENDERER_DIR) && !resolved.startsWith(path.resolve(RENDERER_DIR) + path.sep)) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return new Response('Not found', { status: 404 });
      }
      return await net.fetch(pathToFileURL(resolved).toString());
    } catch (err) {
      return new Response('Bad request', { status: 400 });
    }
  });
}

function hardenSession() {  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const allow = permission === 'media' || permission === 'audioCapture';
    callback(allow);
  });
  ses.setPermissionCheckHandler((wc, permission) => permission === 'media' || permission === 'audioCapture');
  ses.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: Object.assign({}, details.responseHeaders, {
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self' https://api.anthropic.com https://api.openai.com http://127.0.0.1:11434 https://html.duckduckgo.com; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        ]
      })
    });
  });
}

function minimizeToTray() {
  if (!win || win.isDestroyed()) return;
  win.hide();
  if (config.get().app.closeToTray) ensureTray();
}

function ensureTray() {
  if (tray) return;
  try {
    const icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAT0lEQVR42mNgGAWjYBSMglEwCkYBFPz//59BSkoqKUWDhWEo9Hc5AhUKRSaP6ATpE5A4UEjUAVSqhWAxJKp0A0cYhy9QC7wm2+2GwY6Zw8y1lZ4GR8WVjY8PGDRsYmgD8BTnU3MDrhWVkowAAAABJRU5ErkJggg=='
    );
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    tray.setToolTip('LEGION');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show LEGION', click: () => showWindow() },
      { label: 'Settings', click: () => showWindow('settings') },
      { type: 'separator' },
      { label: 'Quit LEGION', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', () => showWindow());
  } catch (_) { tray = null; }
}

function showWindow(panel) {
  if (!win || win.isDestroyed()) { createWindow(); }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (panel) win.webContents.send('ui:open-panel', panel);
}

/* ------------------------------------------------------------------ */
/* Metrics polling — throttled, paused when hidden                     */
/* ------------------------------------------------------------------ */

let metricsTimer = null;
let metricsBusy = false;
const METRICS_INTERVAL_MS = 1400;

async function pushMetrics() {
  if (metricsBusy) return;
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
  metricsBusy = true;
  try {
    const [load, net] = await Promise.all([metrics.currentLoad(), metrics.networkInfo(false)]);
    const aiStatus = ai.status();
    send('metrics', {
      cpu: load.cpuPct, mem: load.memPct,
      memUsed: load.memUsedBytes, memTotal: load.memTotalBytes,
      battery: load.batteryPct, charging: load.batteryCharging,
      temp: load.cpuTempC, legionMemMB: +(load.processMemBytes / 1048576).toFixed(1),
      network: { online: net.online, latencyMs: net.latencyMs, iface: net.activeInterface, type: net.type },
      ai: { provider: aiStatus.provider, ready: aiStatus.ready },
      state: currentState,
      at: Date.now()
    });
  } catch (_) { /* metrics are best-effort */ }
  finally { metricsBusy = false; }
}

function startMetrics() {
  if (metricsTimer) return;
  metricsTimer = setInterval(pushMetrics, METRICS_INTERVAL_MS);
  if (metricsTimer.unref) metricsTimer.unref();
  pushMetrics();
}

function stopMetrics() {
  if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
}

/* ------------------------------------------------------------------ */
/* IPC — explicit channel allowlist                                    */
/* ------------------------------------------------------------------ */

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents) throw new Error('Rejected: unknown sender.');
    return fn(...args);
  });
}

/**
 * Bring the wake word listener in line with the saved setting.
 *
 * The setting existed from the start but nothing read it, so a profile that had
 * "wake word" switched on was in fact doing push to talk only. The listener is
 * owned by main so it survives a renderer reload and so the input device is
 * arbitrated in one place.
 */
function syncWakeListener() {
  const v = config.get().voice || {};
  const phrase = String(v.wakeWord || '').trim();
  if (!v.wakeWordEnabled || !phrase) {
    wake.stop();
    return wake.status();
  }
  const res = wake.start({
    phrase,
    onWake: (hit) => {
      send('voice:wake', { phrase: hit.matched, command: hit.command, heard: hit.heard, at: Date.now() });
    },
    onError: (err) => {
      send('voice:wake', { error: { code: err.code, message: err.message }, at: Date.now() });
    }
  });
  return wake.status();
}

function registerIpc() {
  handle('app:info', async () => ({
    version: app.getVersion(),
    name: 'LEGION',
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    dataDir: USER_DATA,
    isDev,
    voices: (await tts.listVoices()).voices,
    ttsAvailable: (await tts.listVoices()).ttsAvailable
  }));

  handle('app:state', async () => ({ state: currentState, error: lastError }));

  handle('app:setState', async (next) => { setState(next); return { state: currentState }; });

  handle('window:action', async (action) => {
    if (!win) return { ok: false };
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); return { maximized: win.isMaximized() }; }
    else if (action === 'close') { if (config.get().app.closeToTray) minimizeToTray(); else { quitting = true; win.close(); } }
    else if (action === 'minimizeToTray') minimizeToTray();
    return { ok: true, maximized: win ? win.isMaximized() : false };
  });

  handle('window:setAlwaysOnTop', async (v) => { if (win) win.setAlwaysOnTop(!!v); return { ok: true }; });

  handle('config:get', async () => {
    const c = config.get();
    return {
      settings: c,
      secret: secrets.status(c.ai.provider),
      toolsEnabled: toolManager.enabledCategories(),
      sandboxRoots: toolManager.sandbox.describe(),
      memory: memory.summary()
    };
  });

  handle('config:set', async (patch) => {
    config.patch(patch || {});
    toolManager.syncSandbox();
    applyStartupSetting();
    syncWakeListener();
    return { settings: config.get(), sandboxRoots: toolManager.sandbox.describe() };
  });

  handle('config:reset', async () => {
    config.reset();
    toolManager.syncSandbox();
    syncWakeListener();
    return { settings: config.get() };
  });

  handle('config:onboarded', async () => {
    config.patch({ onboarded: true });
    return { ok: true };
  });

  // Secrets: the value goes main-side only. We return presence, never the key.
  handle('secret:set', async (provider, value) => {
    if (typeof provider !== 'string' || !/^[a-z]+$/i.test(provider)) throw new Error('Invalid provider.');
    if (value != null && typeof value !== 'string') throw new Error('Invalid key value.');
    return { secret: secrets.set(provider.toLowerCase(), value) };
  });
  handle('secret:clear', async (provider) => ({ secret: secrets.clear(String(provider || '').toLowerCase()) }));
  handle('secret:status', async (provider) => ({ secret: secrets.status(String(provider || '').toLowerCase()) }));

  handle('ai:status', async () => ai.status());
  handle('ai:probe', async () => {
    try { return await ai.probe(); }
    catch (err) { return { online: false, error: err.message }; }
  });
  handle('ai:profile', async (id) => {
    const { PROFILE_IDS } = require('./ai/personality');
    const valid = PROFILE_IDS.includes(id) ? id : 'legion';
    ai.profileId = valid;
    config.patch({ ui: Object.assign({}, config.get().ui, { profile: valid }) });
    return { profile: valid, available: PROFILE_IDS };
  });
  handle('ai:cancel', async () => ({ cancelled: ai.cancel() }));

  handle('ai:chat', async (text) => {
    const input = String(text || '').trim();
    if (!input) throw new Error('Nothing to send.');
    // memory.config.enabled gates what is *stored*; it deliberately does not
    // gate inference, so a request is still answered with memory switched off.
    setState('PROCESSING');
    try {
      const res = await ai.respond(input);
      return { ok: true, ...res };
    } catch (err) {
      setError(err);
      return { ok: false, error: { message: err.message, code: err.code || 'E_AI' } };
    }
  });

  handle('memory:summary', async () => memory.summary());
  handle('memory:session', async () => ({ messages: memory.sessionView() }));
  handle('memory:list', async () => ({ memories: memory.list() }));
  handle('memory:remember', async (text, meta) => {
    const res = memory.remember(text, meta);
    return res;
  });
  handle('memory:forget', async (id) => memory.forget(String(id || '')));
  handle('memory:clearSession', async () => memory.clearSession());
  handle('memory:clearAll', async () => memory.clearAll());
  handle('memory:export', async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(USER_DATA, `legion-conversation-${stamp}.json`);
    try {
      fs.writeFileSync(file, JSON.stringify({
        exportedAt: new Date().toISOString(),
        app: { version: app.getVersion() },
        messages: memory.sessionView()
      }, null, 2), 'utf8');
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  handle('tools:list', async () => ({ tools: toolManager.list(), enabled: toolManager.enabledCategories() }));
  handle('tools:invoke', async (name, args) => {
    try {
      const res = await toolManager.execute(String(name || ''), args || {});
      return { ok: true, ...res };
    } catch (err) {
      return { ok: false, error: { message: err.message, code: err.code || 'E_TOOL', declined: !!err.declined } };
    }
  });
  handle('tools:confirm', async (token, approved) => toolManager.resolveConfirmation(String(token || ''), !!approved));

  handle('voice:voices', async () => tts.listVoices(true));
  handle('voice:capabilities', async () => stt.capabilities());
  handle('voice:listenStop', async () => ({ stopped: stt.stopActive() }));
  handle('voice:wakeStatus', async () => wake.status());
  handle('voice:wakeStop', async () => wake.stop());
  handle('voice:wakeStart', async () => syncWakeListener());
  handle('voice:listen', async (opts) => {
    const o = opts || {};
    setState('LISTENING');
    // The wake listener holds the same default input device, and System.Speech
    // permits only one recogniser per device, so it stands down for the capture.
    wake.suspend();
    try {
      // stt.listen() returns { stop(), promise }; the result lives on .promise.
      // Awaiting the wrapper itself resolved to the wrapper, so res.ok was
      // always undefined and every capture reported "Voice recognition failed".
      const session = stt.listen({ maxSeconds: o.maxSeconds || 14 });
      const res = await session.promise;
      const err = res.error || { code: 'E_STT', message: 'Voice recognition failed.' };
      if (res.stopped) {
        // A released push-to-talk is not a failure. Return to idle quietly
        // rather than showing the user an error for their own action.
        setState('IDLE');
        return { ok: false, stopped: true, error: err };
      }
      if (!res.ok) {
        setState('ERROR', { message: err.message, code: err.code, at: Date.now() });
        return { ok: false, error: err };
      }
      return { ok: true, transcript: res.transcript };
    } catch (err) {
      setError(err);
      return { ok: false, error: { message: err.message, code: err.code || 'E_STT' } };
    } finally {
      wake.resume();
    }
  });

  handle('voice:speak', async (text, opts) => {
    const o = opts || {};
    const v = config.get().voice;
    setState('SPEAKING');
    // Synthesis is captured from the same input device, so the wake listener
    // must not be running or LEGION answers its own voice.
    wake.suspend();
    try {
      const res = await tts.synthesize(text, {
        voice: o.voice || v.voiceName || null,
        rate: o.rate !== undefined ? o.rate : v.rate,
        volume: o.volume !== undefined ? o.volume : v.volume
      });
      return { ok: true, format: res.format, sampleRate: res.sampleRate, durationMs: res.durationMs, audioBase64: res.audio ? res.audio.toString('base64') : null };
    } catch (err) {
      setError(err);
      return { ok: false, error: { message: err.message, code: err.code || 'E_TTS' } };
    }
  });

  // Playback happens in the renderer, so main cannot see when the audio ends.
  // The renderer reports it, which is what releases the input device again.
  handle('voice:speechEnd', async () => {
    wake.resume();
    if (currentState === 'SPEAKING') setState('IDLE');
    return { ok: true };
  });

  handle('system:full', async () => {
    const [stat, load, net, disk] = await Promise.all([metrics.staticInfo(), metrics.currentLoad(), metrics.networkInfo(true), metrics.diskInfo()]);
    return { static: stat, load, network: net, disk };
  });

  handle('shell:showItem', async (p) => { shell.showItemInFolder(String(p || '')); return { ok: true }; });
  handle('shell:openPath', async (p) => ({ error: await shell.openPath(String(p || '')) }));

  handle('dialog:confirm', async (opts) => {
    const o = opts || {};
    const r = await dialog.showMessageBox(win, {
      type: o.destructive ? 'warning' : 'question',
      buttons: ['Cancel', o.confirmLabel || 'Continue'],
      defaultId: 0, cancelId: 0,
      title: o.title || 'LEGION',
      message: o.message || 'Are you sure?',
      detail: o.detail || undefined
    });
    return { confirmed: r.response === 1 };
  });

  handle('app:openExternal', async (url) => {
    let u;
    try { u = new URL(String(url)); } catch (_) { throw new Error('Invalid URL.'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https are permitted.');
    await shell.openExternal(u.toString());
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ */
/* Startup behaviour                                                   */
/* ------------------------------------------------------------------ */

function applyStartupSetting() {
  try {
    if (process.platform === 'win32') {
      const exe = process.env.APPDATA + '\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\LEGION.lnk';
      const want = !!config.get().app.launchAtStartup;
      const has = fs.existsSync(exe);
      if (want && !has) {
        const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${JSON.stringify(exe)});$s.TargetPath=${JSON.stringify(process.execPath)};$s.Arguments='--hidden';$s.WorkingDirectory=${JSON.stringify(path.dirname(process.execPath))};$s.Save()`;
        require('child_process').execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }, () => {});
      } else if (!want && has) {
        try { fs.unlinkSync(exe); } catch (_) { /* ignore */ }
      }
    }
  } catch (err) { console.error('[startup] could not update autostart:', err.message); }
}

let shortcutReport = { failed: [], active: [] };

function registerGlobalShortcuts() {
  const ok = [];
  const failed = [];
  const tryReg = (accel, fn) => {
    try {
      if (globalShortcut.register(accel, fn)) ok.push(accel);
      else failed.push(accel);
    } catch (_) { failed.push(accel); }
  };
  tryReg('CommandOrControl+L', () => showWindow());
  tryReg('CommandOrControl+Shift+L', () => { showWindow(); send('shortcut:activate', {}); });
  // A silent registration failure leaves the user with a dead shortcut and no
  // explanation. The renderer may not have finished loading yet, so this rides
  // along on the app:ready payload instead of being pushed as a bare event.
  shortcutReport = { failed, active: ok };
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock() && !isDev) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    registerIpc();
    registerAppProtocol();
    createWindow();
    registerGlobalShortcuts();
    applyStartupSetting();
    startMetrics();
    tts.listVoices();
    // Honour a saved wake word setting on launch, not only after the user
    // toggles it in Settings.
    syncWakeListener();

    const onboarded = config.get().onboarded;
    const playBoot = config.get().app.playBootAnimation && onboarded;
    if (!onboarded) setState('BOOTING');
    else if (playBoot) setState('BOOTING');
    else setState('IDLE');

    win.webContents.once('did-finish-load', () => {
      send('app:ready', {
        onboarded,
        playBoot,
        state: currentState,
        startMinimized: config.get().app.startMinimized,
        shortcuts: shortcutReport
      });
    });
  });

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else showWindow(); });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !config.get().app.closeToTray) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopMetrics();
    config.saveNow();
    // The wake recogniser is a real child process holding the microphone; it
    // has to die with the app or it outlives LEGION and keeps the device busy.
    wake.stop();
    stt.stopActive();
    try { globalShortcut.unregisterAll(); } catch (_) { /* ignore */ }
    toolManager.rejectAll('shutdown');
  });
}

process.on('uncaughtException', (err) => {
  console.error('[fatal]', err);
  try { setError(err); } catch (_) { /* ignore */ }
});
