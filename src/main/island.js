'use strict';

/**
 * Dynamic Island.
 *
 * A second, optional window. It is deliberately independent of the main shell:
 * it owns no application state, runs no tools, and only mirrors the state the
 * main process already broadcasts. Turning it off leaves the original window
 * byte-for-byte unchanged.
 *
 * Everything the island can do is forwarded to the existing services:
 * voice and conversation actions go back to the main renderer (which owns the
 * turn), settings opens the real Settings panel, and the AI stream is the same
 * `ai:event` broadcast the shell already consumes.
 */

const { BrowserWindow, screen } = require('electron');

const COLLAPSED = { width: 380, height: 64 };
const EXPANDED = { width: 380, height: 480 };
const MARGIN = 16;
const TOP_MARGIN = 14;
const POSITIONS = Object.freeze([
  'top-center', 'top-left', 'top-right',
  'bottom-center', 'bottom-left', 'bottom-right'
]);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function createIslandController({ config, preloadPath, isDev, onCommand, onReady, getState }) {
  let win = null;
  let expanded = false;
  let pinned = false;
  let autoTimer = null;
  let watchingDisplays = false;
  const watchers = new Set();

  function islandConfig() {
    const ui = config.get().ui || {};
    return ui.island || {};
  }

  function enabled() {
    return !!islandConfig().enabled;
  }

  function resolvedDisplay() {
    const all = screen.getAllDisplays();
    const wanted = islandConfig().display;
    if (wanted === 'cursor') return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const index = Number(wanted);
    if (Number.isInteger(index) && index >= 0 && index < all.length) return all[index];
    return screen.getPrimaryDisplay();
  }

  function bounds(height) {
    const cfg = islandConfig();
    const display = resolvedDisplay();
    const area = display.workArea;
    const width = COLLAPSED.width;
    const position = POSITIONS.includes(cfg.position) ? cfg.position : 'top-center';
    const top = position.startsWith('top');
    const left = position.endsWith('left');
    const right = position.endsWith('right');

    const wantedHeight = Math.min(height, area.height);
    let x = left
      ? area.x + MARGIN
      : right
        ? area.x + area.width - width - MARGIN
        : area.x + Math.round((area.width - width) / 2);
    let y = top
      ? area.y + TOP_MARGIN
      : area.y + area.height - wantedHeight - MARGIN;

    x = clamp(x, area.x, area.x + Math.max(0, area.width - width));
    y = clamp(y, area.y, area.y + Math.max(0, area.height - wantedHeight));
    return { width, height: wantedHeight, x: Math.round(x), y: Math.round(y) };
  }

  function currentHeight() {
    return expanded ? EXPANDED.height : COLLAPSED.height;
  }

  function reposition() {
    if (!win || win.isDestroyed()) return;
    try { win.setBounds(bounds(currentHeight()), false); } catch (_) { /* display may be going away */ }
  }

  function onDisplaysChanged() {
    reposition();
    notify();
  }

  function watchDisplays() {
    if (watchingDisplays) return;
    watchingDisplays = true;
    try {
      screen.on('display-metrics-changed', onDisplaysChanged);
      screen.on('display-added', onDisplaysChanged);
      screen.on('display-removed', onDisplaysChanged);
    } catch (_) { watchingDisplays = false; }
  }

  function unwatchDisplays() {
    if (!watchingDisplays) return;
    watchingDisplays = false;
    try {
      screen.removeListener('display-metrics-changed', onDisplaysChanged);
      screen.removeListener('display-added', onDisplaysChanged);
      screen.removeListener('display-removed', onDisplaysChanged);
    } catch (_) { /* already gone */ }
  }

  function status() {
    const cfg = islandConfig();
    const s = {
      enabled: !!cfg.enabled,
      visible: !!(win && !win.isDestroyed() && win.isVisible()),
      expanded,
      pinned,
      position: POSITIONS.includes(cfg.position) ? cfg.position : 'top-center',
      display: cfg.display === undefined ? 'primary' : cfg.display,
      autoCollapse: !!cfg.autoCollapse,
      autoCollapseMs: Number(cfg.autoCollapseMs) || 9000
    };

    try {
      const display = resolvedDisplay();
      const all = screen.getAllDisplays();
      s.displayId = display.id;
      s.displayIndex = all.findIndex((d) => d.id === display.id);
      s.scaleFactor = display.scaleFactor;
      s.workArea = display.workArea;
    } catch (_) { /* screen is unavailable before app ready */ }

    if (win && !win.isDestroyed()) {
      try {
        s.windowBounds = win.getBounds();
        s.alwaysOnTop = win.isAlwaysOnTop();
      } catch (_) { /* closing */ }
    }
    return s;
  }

  function notify() {
    const s = status();
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('island:state', s);
    }
    for (const fn of watchers) {
      try { fn(s); } catch (_) { /* a watcher must not break the window */ }
    }
  }

  function clearAutoCollapse() {
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  }

  function scheduleAutoCollapse() {
    clearAutoCollapse();
    const cfg = islandConfig();
    if (!expanded || pinned || !cfg.autoCollapse) return;
    const ms = clamp(Number(cfg.autoCollapseMs) || 9000, 1500, 120000);
    autoTimer = setTimeout(() => {
      autoTimer = null;
      if (!islandConfig().autoCollapse || pinned) return;
      setExpanded(false);
    }, ms);
    if (autoTimer.unref) autoTimer.unref();
  }

  function sendToIsland(channel, payload) {
    if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return;
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send(channel, payload);
        }
      });
      return;
    }
    win.webContents.send(channel, payload);
  }

  function applyTopmost() {
    if (!win || win.isDestroyed()) return;
    // Electron 33 on Windows only applies WS_EX_TOPMOST reliably when an
    // explicit level is supplied after the window is visible; the plain flag
    // is silently ignored for a window that was created hidden.
    const level = process.platform === 'win32' ? 'screen-saver' : 'floating';
    try { win.setAlwaysOnTop(true, level); } catch (_) {
      try { win.setAlwaysOnTop(true); } catch (_) { /* unsupported */ }
    }
  }

  function create() {
    if (win && !win.isDestroyed()) return win;
    watchDisplays();

    win = new BrowserWindow(Object.assign(bounds(currentHeight()), {
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      title: 'LEGION Island',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        devTools: isDev,
        backgroundThrottling: false
      }
    }));

    // Constructor bounds pick up a one-pixel DPI rounding artefact at 125%
    // scaling. Setting them again before the window is shown keeps the
    // collapsed surface exactly 380 wide.
    try { win.setBounds(bounds(currentHeight()), false); } catch (_) { /* optional */ }
    if (process.platform !== 'win32') {
      try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) { /* optional */ }
    }

    win.loadURL('app://legion/island.html');

    // State transitions are broadcast while the window is still loading, so a
    // freshly created island can miss the current one entirely. Replay it once
    // the document is ready instead of leaving the pill on its boot default.
    win.webContents.once('did-finish-load', () => {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      if (typeof getState === 'function') {
        try { win.webContents.send('state', getState()); } catch (_) { /* closing */ }
      }
      // State alone is not enough mid-turn: the streaming caption lives in the
      // main renderer. Ask it to replay its live state instead of duplicating
      // any of that logic in the island.
      if (typeof onReady === 'function') {
        try { onReady(); } catch (_) { /* a listener must not break the window */ }
      }
    });

    win.once('ready-to-show', () => {
      if (enabled()) {
        win.showInactive();
        applyTopmost();
      }
      notify();
    });

    win.on('blur', () => {
      // A pinned island stays put; otherwise losing focus collapses it back to
      // the pill instead of leaving a large panel floating over other apps.
      if (expanded && !pinned) setExpanded(false);
    });

    win.on('closed', () => {
      win = null;
      expanded = false;
      clearAutoCollapse();
      notify();
    });

    return win;
  }

  function show() {
    config.patch({ ui: { island: { enabled: true } } });
    const w = create();
    if (!w.isVisible()) w.showInactive();
    applyTopmost();
    reposition();
    notify();
    return status();
  }

  function hide() {
    config.patch({ ui: { island: { enabled: false } } });
    clearAutoCollapse();
    if (win && !win.isDestroyed()) win.hide();
    notify();
    return status();
  }

  function toggle() {
    const s = status();
    return s.visible ? hide() : show();
  }

  /** Re-apply config after Settings writes position, display, or visibility. */
  function applyConfig() {
    if (enabled()) {
      const w = create();
      removeAutoCollapseIfNeeded();
      reposition();
      if (!w.isVisible()) w.showInactive();
      applyTopmost();
    } else if (win && !win.isDestroyed() && win.isVisible()) {
      win.hide();
    }
    notify();
    return status();
  }

  function removeAutoCollapseIfNeeded() {
    const cfg = islandConfig();
    if (!cfg.autoCollapse || !expanded || pinned) clearAutoCollapse();
    else scheduleAutoCollapse();
  }

  function setExpanded(next) {
    const value = !!next;
    expanded = value;
    if (win && !win.isDestroyed()) {
      try { win.setBounds(bounds(currentHeight()), false); } catch (_) { /* closing */ }
    }
    if (value) scheduleAutoCollapse();
    else clearAutoCollapse();
    notify();
    return status();
  }

  function setPinned(next) {
    pinned = !!next;
    if (pinned) clearAutoCollapse();
    else scheduleAutoCollapse();
    notify();
    return status();
  }

  function focusInput() {
    const s = show();
    setExpanded(true);
    const w = win;
    if (w && !w.isDestroyed()) {
      try { w.show(); w.focus(); } catch (_) { /* optional */ }
      applyTopmost();
      sendToIsland('island:action', { action: 'focus-input' });
    }
    notify();
    return Object.assign({}, s, status());
  }

  function command(name, payload) {
    const cmd = String(name || '').trim();
    if (!cmd) return { ok: false, error: 'A command is required.' };

    // Any command is user activity, so the inactivity timer starts again.
    if (expanded) scheduleAutoCollapse();

    if (cmd === 'expand') return { ok: true, status: setExpanded(true) };
    if (cmd === 'collapse') return { ok: true, status: setExpanded(false) };
    if (cmd === 'show' || cmd === 'open') {
      if (typeof onCommand === 'function') onCommand('show', payload);
      return { ok: true, status: show() };
    }
    if (cmd === 'hide' || cmd === 'close') return { ok: true, status: hide() };
    if (cmd === 'pin') {
      const value = payload && typeof payload === 'object' && 'value' in payload ? payload.value : !pinned;
      return { ok: true, status: setPinned(value) };
    }
    if (cmd === 'settings') {
      if (typeof onCommand === 'function') onCommand('settings', payload);
      return { ok: true };
    }
    if (cmd === 'chat' || cmd === 'send') {
      const text = String((payload && (payload.text || payload.message)) || payload || '').trim();
      if (!text) return { ok: false, error: 'Nothing to send.' };
      if (text.length > 8000) return { ok: false, error: 'That message is too long.' };
      if (typeof onCommand === 'function') onCommand('chat', { text });
      return { ok: true };
    }
    if (cmd === 'listen' || cmd === 'stop' || cmd === 'cancel' || cmd === 'quit') {
      if (typeof onCommand === 'function') onCommand(cmd, payload);
      return { ok: true };
    }
    return { ok: false, error: `Unknown command: ${cmd}` };
  }

  function displays() {
    try {
      const primary = screen.getPrimaryDisplay();
      return {
        primaryId: primary.id,
        displays: screen.getAllDisplays().map((d, index) => ({
          id: d.id,
          index,
          label: d.label || `Display ${index + 1}`,
          primary: d.id === primary.id,
          bounds: d.bounds,
          workArea: d.workArea,
          scaleFactor: d.scaleFactor
        }))
      };
    } catch (_) {
      return { primaryId: null, displays: [] };
    }
  }

  function onChange(fn) {
    if (typeof fn === 'function') watchers.add(fn);
    return () => watchers.delete(fn);
  }

  function destroy() {
    clearAutoCollapse();
    unwatchDisplays();
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }

  return {
    window: () => win,
    status,
    show,
    hide,
    toggle,
    applyConfig,
    setExpanded,
    setPinned,
    focusInput,
    command,
    displays,
    onChange,
    destroy
  };
}

module.exports = { createIslandController, COLLAPSED, EXPANDED, POSITIONS };
