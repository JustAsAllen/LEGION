'use strict';

/**
 * Dynamic Island.
 *
 * A second, optional window. It is deliberately independent of the main shell:
 * it owns no application state, runs no tools, and only mirrors the state the
 * main process already broadcasts. Turning it off leaves the original window
 * byte-for-byte unchanged.
 */

const { BrowserWindow, screen } = require('electron');

const COLLAPSED = { width: 360, height: 60 };
const EXPANDED = { width: 360, height: 232 };
const MARGIN = 24;

function createIslandController({ config, preloadPath, isDev, onCommand }) {
  let win = null;
  let expanded = false;
  let pinned = false;
  const watchers = new Set();

  function status() {
    return {
      enabled: !!(config.get().ui && config.get().ui.island && config.get().ui.island.enabled),
      visible: !!(win && !win.isDestroyed() && win.isVisible()),
      expanded,
      pinned
    };
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

  function bounds(height) {
    const area = screen.getPrimaryDisplay().workArea;
    return {
      width: COLLAPSED.width,
      height,
      x: Math.round(area.x + area.width - COLLAPSED.width - MARGIN),
      y: Math.round(area.y + area.height - height - MARGIN)
    };
  }

  function create() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow(Object.assign(bounds(expanded ? EXPANDED.height : COLLAPSED.height), {
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

    try { win.setAlwaysOnTop(true, 'floating'); } catch (_) { /* older Windows */ }
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) { /* optional */ }

    win.loadURL('app://legion/island.html');

    win.once('ready-to-show', () => {
      if (status().enabled) win.showInactive();
      notify();
    });

    win.on('blur', () => {
      if (expanded && !pinned) setExpanded(false);
    });

    win.on('closed', () => {
      win = null;
      expanded = false;
      notify();
    });

    return win;
  }

  function show() {
    config.patch({ ui: { island: { enabled: true } } });
    const w = create();
    if (w.isVisible()) w.showInactive();
    notify();
    return status();
  }

  function hide() {
    config.patch({ ui: { island: { enabled: false } } });
    if (win && !win.isDestroyed()) win.hide();
    notify();
    return status();
  }

  function toggle() {
    const s = status();
    return s.visible ? hide() : show();
  }

  function setExpanded(next) {
    const value = !!next;
    if (!win || win.isDestroyed()) { expanded = value; return status(); }
    if (expanded === value) return status();
    expanded = value;
    win.setBounds(bounds(expanded ? EXPANDED.height : COLLAPSED.height));
    notify();
    return status();
  }

  function setPinned(next) {
    pinned = !!next;
    notify();
    return status();
  }

  function command(name) {
    const cmd = String(name || '').trim();
    if (!cmd) return { ok: false, error: 'A command is required.' };
    if (cmd === 'expand') return { ok: true, status: setExpanded(true) };
    if (cmd === 'collapse') return { ok: true, status: setExpanded(false) };
    if (typeof onCommand === 'function') onCommand(cmd);
    return { ok: true };
  }

  function onChange(fn) {
    if (typeof fn === 'function') watchers.add(fn);
    return () => watchers.delete(fn);
  }

  function destroy() {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }

  return {
    window: () => win,
    status,
    show,
    hide,
    toggle,
    setExpanded,
    setPinned,
    command,
    onChange,
    destroy
  };
}

module.exports = { createIslandController, COLLAPSED, EXPANDED };
