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
const { createIslandController } = require('./island');
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
let speechSerial = 0;

const config = new ConfigStore(USER_DATA, { allowMock: isDev });
const secrets = new SecretStore(USER_DATA);
const memory = new MemoryStore(USER_DATA, config);
const productivity = new (require('./tools/productivity').ProductivityStore)(path.join(USER_DATA, 'productivity.json'));

const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'preload.js');

const islandCtl = createIslandController({
  config,
  preloadPath: PRELOAD_PATH,
  isDev,
  getState: () => ({ state: currentState, detail: lastError, at: Date.now() }),
  onReady: () => sendToMain('island:action', { action: 'resync' }),
  onCommand: (cmd, payload) => {
    if (cmd === 'show') return showWindow();
    if (cmd === 'settings') return showWindow('settings');
    if (cmd === 'quit') { quitting = true; app.quit(); return undefined; }
    if (cmd === 'chat') {
      const text = payload && payload.text ? String(payload.text) : '';
      if (text) sendToMain('island:action', { action: 'chat', text });
      return undefined;
    }
    if (cmd === 'listen' || cmd === 'stop' || cmd === 'cancel') {
      sendToMain('island:action', { action: cmd });
    }
    return undefined;
  }
});

islandCtl.onChange(() => refreshTrayMenu());

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
  workspaceRoot: path.resolve(__dirname, '..', '..'),
  onConfirm: (request) => {
    send('tool:confirmation', request);
  }
});

const ai = new AIEngine({
  settings: config,
  secrets,
  toolManager,
  memory,
  isDev,
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

function sendToMain(channel, payload) {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function send(channel, payload) {
  sendToMain(channel, payload);
  const iw = islandCtl.window();
  if (iw && !iw.isDestroyed() && iw.webContents && !iw.webContents.isDestroyed()) {
    iw.webContents.send(channel, payload);
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
      preload: PRELOAD_PATH,
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

  win.on('closed', () => { win = null; if (islandCtl) islandCtl.destroy(); });

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
    refreshTrayMenu();
    tray.on('click', () => showWindow());
  } catch (_) { tray = null; }
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show LEGION', click: () => showWindow() },
    { label: 'Settings', click: () => showWindow('settings') },
    { type: 'separator' },
    {
      label: 'Dynamic Island',
      type: 'checkbox',
      checked: islandCtl.status().enabled,
      click: () => islandCtl.toggle()
    },
    { type: 'separator' },
    { label: 'Quit LEGION', click: () => { quitting = true; app.quit(); } }
  ]));
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
    const iw = islandCtl.window();
    const fromMain = !!win && event.sender === win.webContents;
    const fromIsland = !!iw && !iw.isDestroyed() && event.sender === iw.webContents;
    if (!fromMain && !fromIsland) throw new Error('Rejected: unknown sender.');
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
    if (!isDev && patch && patch.ai && patch.ai.provider === 'mock') {
      throw new Error('The development mock provider is not available in this build.');
    }
    if (!isDev && patch && patch.voice && patch.voice.mockTts === true) {
      throw new Error('Mock speech output is not available in this build.');
    }
    config.patch(patch || {});
    toolManager.syncSandbox();
    applyStartupSetting();
    syncWakeListener();
    islandCtl.applyConfig();
    return { settings: config.get(), sandboxRoots: toolManager.sandbox.describe() };
  });

  handle('config:reset', async () => {
    config.reset();
    toolManager.syncSandbox();
    syncWakeListener();
    islandCtl.applyConfig();
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
    try {
      return await ai.probe();
    }
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
      // A user-initiated stop is not a failure. Reporting it as one would
      // overwrite the IDLE the renderer already moved to and leave every
      // mirror (the island included) showing an error for a normal cancel.
      const cancelled = !!err && (
        err.name === 'AbortError' || err.code === 'E_ABORTED' || err.code === 'ABORT_ERR'
      );
      if (!cancelled) setError(err);
      return {
        ok: false,
        cancelled,
        error: { message: err.message, code: err.code || (cancelled ? 'E_ABORTED' : 'E_AI') }
      };
    } finally {
      // A typed turn that produced no audio leaves main in PROCESSING. Only
      // settle it here if speech did not take authority in the meantime.
      if (currentState === 'PROCESSING') setState('IDLE');
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
  handle('tools:audit', async (limit) => {
    const n = Math.max(1, Math.min(Number(limit) || 50, 200));
    return { entries: toolManager.auditLog().slice(-n) };
  });
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
  handle('voice:pack', async () => tts.voicepack.describe());
  handle('voice:capabilities', async () => stt.capabilities());
  handle('voice:pipeline', async () => tts.describePipeline(config.get().voice));
  handle('voice:listenStop', async () => ({ stopped: stt.stopActive() }));
  handle('voice:wakeStatus', async () => wake.status());
  handle('voice:wakeStop', async () => wake.stop());
  handle('voice:wakeStart', async () => syncWakeListener());

  /* ---------------- renderer-fed capture ---------------- */

  /**
   * The capture pipeline, end to end.
   *
   * The renderer owns the microphone because only the browser can be given a
   * chosen device and real echo cancellation. Main owns the rest, because only
   * main can reach a recogniser, so the audio is tapped in the renderer and
   * segmented here.
   *
   * Two details are load bearing:
   *
   * The completion event is pushed rather than returned. Audio arrives on a
   * fire-and-forget channel, so the call that finally recognises a completed
   * utterance has nobody waiting on it; whoever opened the capture has to be
   * told from the outside.
   *
   * The wake listener stands down for the whole session, not per chunk. It
   * holds the same default input device and System.Speech allows one recogniser
   * per device, so two of them at once makes the capture unrecognisable rather
   * than merely noisy.
   */
  let captureSession = null;

  function endCaptureSession(id, res) {
    const prev = captureSession;
    if (!prev || prev.id !== id) return;
    captureSession = null;
    if (win && !win.isDestroyed()) {
      win.webContents.send('voice:captureEnd', Object.assign({ id: prev.id }, res || {}));
    }
    if (res && res.ok) setState('IDLE');
    else if (res && res.stopped) setState('IDLE');
    else setState('ERROR', { message: (res && res.error && res.error.message) || 'Voice recognition failed.', code: (res && res.error && res.error.code) || 'E_STT', at: Date.now() });
    if (prev.holdsWake) wake.resume();
  }

  handle('voice:captureStart', async (opts) => {
    const o = opts || {};
    // A second start without a stop would orphan the first session and its
    // microphone frames, so the previous one is closed out deliberately.
    if (captureSession) {
      stt.stopCapture(captureSession.id);
      captureSession = null;
      wake.resume();
    }
    // Synthesis from a previous turn is still audible here; give the VAD a
    // moment of grace so LEGION does not transcribe its own tail.
    wake.suspend();
    let session;
    try {
      const v = config.get().voice || {};
      session = stt.startCapture({
        maxSeconds: o.maxSeconds || v.speechMaxSeconds || 14,
        engine: o.engine || v.sttEngine || 'auto',
        // Only passed through when the settings left them at their defaults, so
        // a caller that genuinely wants different numbers is not overruled by
        // the user's configuration.
        vad: {
          ...(Number(v.speechSilenceMs) ? { endSilenceMs: Number(v.speechSilenceMs) } : {}),
          ...(o.vad || {})
        },
        whisperPath: v.whisperPath,
        whisperModel: v.whisperModel,
        whisperLanguage: v.whisperLanguage
      });
    } catch (err) {
      wake.resume();
      throw err;
    }
    captureSession = { id: session.id, holdsWake: true };
    setState('LISTENING');
    session.promise
      .then((res) => { endCaptureSession(session.id, res); })
      .catch((err) => { endCaptureSession(session.id, { ok: false, error: { code: 'E_STT', message: err.message } }); });
    return {
      ok: true,
      id: session.id,
      sampleRate: session.sampleRate,
      maxSeconds: session.maxSeconds,
      // The renderer needs to know whether its own capture DSP is in effect; a
      // device that refused echo cancellation should not be presented as though
      // it had one.
      constraints: (o.constraints || null)
    };
  });

  ipcMain.on('voice:captureChunk', (event, id, samples, sampleRate) => {
    if (!win || event.sender !== win.webContents) return;
    // Nothing is awaited here on purpose: this fires fifty times a second and
    // must not queue work behind the transcription that closes the session.
    stt.pushCapture(String(id || ''), samples, { sampleRate: Number(sampleRate) || 0 }).catch(() => {});
  });

  handle('voice:captureStop', async (id) => {
    const target = id ? String(id) : (captureSession && captureSession.id);
    if (captureSession && target && captureSession.id !== target) return { ok: false, stopped: false, stale: true };
    const stopped = stt.stopCapture(target || undefined);
    return { ok: true, stopped };
  });

  handle('voice:captureAbort', async (id) => {
    const target = id ? String(id) : (captureSession && captureSession.id);
    if (captureSession && target && captureSession.id !== target) return { ok: false, stale: true };
    const was = !!captureSession && (!target || captureSession.id === target);
    stt.stopCapture(target || undefined);
    if (was) {
      captureSession = null;
      wake.resume();
    }
    setState('IDLE');
    return { ok: was };
  });
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
    if (o.mock === true && !isDev) {
      return { ok: false, error: { message: 'Mock speech output is not available in this build.', code: 'E_DEV_ONLY' } };
    }
    const v = config.get().voice;
    const requestSerial = ++speechSerial;
    setState('SPEAKING');
    // Synthesis is captured from the same input device, so the wake listener
    // must not be running or LEGION answers its own voice. The capture guard is
    // the same idea for an open renderer capture: it keeps the VAD closed for
    // the length of the utterance plus its tail.
    wake.suspend();
    try { stt.guardCapture(1600); } catch (_) { /* no capture open */ }
    try {
      const res = await tts.synthesize(text, {
        voice: o.voice || v.voiceName || null,
        rate: o.rate !== undefined ? o.rate : v.rate,
        volume: o.volume !== undefined ? o.volume : v.volume,
        // The pipeline policy and the online voice come from settings, so the
        // tier the user picked is the tier that runs.
        ttsMode: o.ttsMode || v.ttsMode,
        onlineVoice: o.onlineVoice || v.onlineVoice,
        piperPath: v.piperPath,
        piperModel: v.piperModel,
        // Only the dev build can request the silent test tier, and the check
        // above is what makes that true even if the renderer asks directly.
        mock: o.mock === true
      });
      if (requestSerial !== speechSerial) {
        // A newer request owns the state and the wake listener now. Calling
        // resume here could reopen the microphone in the middle of its speech.
        return { ok: false, cancelled: true, error: { message: 'Speech cancelled.', code: 'E_TTS_CANCELLED' } };
      }
      if (res.empty) {
        // Pack-only produced silence. There is nothing to play, so release the
        // device now instead of waiting for a renderer speechEnd that may not
        // come.
        wake.resume();
        setState('IDLE');
      }
      return {
        ok: true,
        format: res.format,
        sampleRate: res.sampleRate,
        durationMs: res.durationMs || 0,
        source: res.source || 'sapi',
        tier: res.tier || null,
        mode: res.mode || null,
        mock: !!res.mock,
        pack: res.pack || null,
        phrase: res.phrase || null,
        empty: !!res.empty,
        reason: res.reason || null,
        audioBase64: res.audio ? res.audio.toString('base64') : null
      };
    } catch (err) {
      // TTS is not an application failure: the reply is already on screen and
      // the user can still read it. Release the device and settle to IDLE so a
      // missing voice runtime cannot leave the state machine or the wake
      // listener stuck. A stale request must not touch either.
      if (requestSerial === speechSerial) {
        wake.resume();
        setState('IDLE');
      }
      return { ok: false, error: { message: err.message, code: err.code || 'E_TTS' } };
    }
  });

  handle('voice:speechCancel', async () => {
    speechSerial++;
    wake.resume();
    return { ok: true, cancelled: true };
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

  // shell.openPath hands the path to the OS handler, and for an .exe that means
  // *launching* it. Accepting an arbitrary renderer-supplied string here turned
  // the renderer into a process launcher: anything that could inject script into
  // the page could run a binary. Only paths LEGION owns or the user has already
  // granted are allowed, and they are checked after symlink resolution.
  const openableRoots = () => [USER_DATA, path.resolve(__dirname, '..', '..')].concat(toolManager.sandbox.describe());

  const assertOpenable = (p) => {
    const raw = String(p || '').trim();
    if (!raw) throw new Error('A path is required.');
    if (raw.indexOf('\0') !== -1) throw new Error('Illegal path.');
    const abs = path.resolve(raw);
    const roots = openableRoots();
    const inside = (c) => roots.some((r) => {
      const rel = path.relative(r, c);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!inside(abs)) throw new Error('That location is not one LEGION can open.');
    // Resolve links before deciding, or a link inside an allowed root would pass.
    let real = abs;
    try { real = fs.realpathSync(abs); } catch (_) { /* may not exist yet */ }
    if (!inside(real)) throw new Error('That location resolves outside what LEGION can open.');
    return abs;
  };

  handle('shell:showItem', async (p) => { shell.showItemInFolder(assertOpenable(p)); return { ok: true }; });
  handle('shell:openPath', async (p) => ({ error: await shell.openPath(assertOpenable(p)) }));

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

  handle('island:status', async () => islandCtl.status());
  handle('island:displays', async () => islandCtl.displays());
  handle('island:show', async () => islandCtl.show());
  handle('island:hide', async () => islandCtl.hide());
  handle('island:toggle', async () => islandCtl.toggle());
  handle('island:expand', async (v) => islandCtl.setExpanded(v));
  handle('island:pin', async (v) => islandCtl.setPinned(v));
  handle('island:focusInput', async () => islandCtl.focusInput());
  handle('island:command', async (name, payload) => islandCtl.command(name, payload));

  /* The main renderer owns the conversation turn, so it pushes the live caption
     and streaming text here. Fire-and-forget: a token delta is far too frequent
     to allocate a promise for, and the island may not even be open. */
  ipcMain.on('island:push', (event, payload) => {
    if (!win || event.sender !== win.webContents) return;
    if (!payload || typeof payload !== 'object') return;
    const iw = islandCtl.window();
    if (!iw || iw.isDestroyed() || !iw.webContents || iw.webContents.isDestroyed()) return;
    iw.webContents.send('island:relay', payload);
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
  tryReg('CommandOrControl+Alt+I', () => islandCtl.toggle());
  tryReg('CommandOrControl+Alt+Space', () => islandCtl.focusInput());
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
    if (config.get().ui.island.enabled) islandCtl.show();
    registerGlobalShortcuts();
    applyStartupSetting();
    startMetrics();
    tts.listVoices();
    // Honour a saved wake word setting on launch, not only after the user
    // toggles it in Settings.
    syncWakeListener();
    // Find out about whisper.cpp in the background. Deliberately not awaited:
    // a missing binary is the common case and must never delay the window, and
    // the probe costs a process launch the first time it runs.
    stt.scheduleWhisperProbe(config.get().voice);

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
    speechSerial++;
    stopMetrics();
    config.saveNow();
    // The wake recogniser is a real child process holding the microphone; it
    // has to die with the app or it outlives LEGION and keeps the device busy.
    wake.stop();
    stt.stopCapture();
    stt.stopActive();
    try { globalShortcut.unregisterAll(); } catch (_) { /* ignore */ }
    toolManager.rejectAll('shutdown');
  });
}

process.on('uncaughtException', (err) => {
  console.error('[fatal]', err);
  try { setError(err); } catch (_) { /* ignore */ }
});
