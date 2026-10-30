'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between the renderer and the operating system.
 *
 * Rules:
 *  - No Node primitives are exposed.
 *  - Only the listed channels are reachable; there is no generic `invoke`.
 *  - No secret ever crosses this boundary in the value direction.
 *  - Event subscriptions return an unsubscribe function.
 */

const INVOKE_CHANNELS = [
  'app:info', 'app:state', 'app:setState', 'config:onboarded',
  'window:action', 'window:setAlwaysOnTop',
  'config:get', 'config:set', 'config:reset',
  'secret:set', 'secret:clear', 'secret:status',
  'ai:status', 'ai:probe', 'ai:chat', 'ai:cancel', 'ai:profile',
  'memory:summary', 'memory:session', 'memory:list', 'memory:remember',
  'memory:forget', 'memory:clearSession', 'memory:clearAll', 'memory:export',
  'tools:list', 'tools:audit', 'tools:invoke', 'tools:confirm',
  'voice:voices', 'voice:speak', 'voice:speechEnd', 'voice:speechCancel', 'voice:listen', 'voice:listenStop', 'voice:capabilities', 'voice:pipeline', 'voice:pack',
  'voice:wakeStart', 'voice:wakeStop', 'voice:wakeStatus',
  'voice:captureStart', 'voice:captureStop', 'voice:captureAbort',
  'system:full', 'shell:showItem', 'shell:openPath',
  'dialog:confirm', 'app:openExternal'
];

const EVENT_CHANNELS = [
  'state', 'metrics', 'ai:event', 'tool:confirmation',
  'timer:fired', 'app:ready', 'window:focus', 'ui:open-panel', 'shortcut:activate',
  'voice:wake', 'voice:captureEnd'
];

/**
 * Fire-and-forget channels, kept separate from `invoke` because they have no
 * reply and fire far too often to want one.
 *
 * Audio is the only high-rate channel in the app: a 20ms frame is 50 messages a
 * second for the whole time someone is speaking. Going through `invoke` would
 * allocate a promise per frame and resolve fifty of them a second for no
 * benefit. The payload is a Float32Array, which crosses the bridge as a typed
 * array by structured clone, so the samples are not base64-expanded and do not
 * show up as garbage strings in a log.
 */
const SEND_CHANNELS = [
  'voice:captureChunk'
];

const send = {};
for (const ch of SEND_CHANNELS) {
  send[ch] = (...args) => ipcRenderer.send(ch, ...args);
}

const invoke = {};
for (const ch of INVOKE_CHANNELS) {
  invoke[ch] = (...args) => ipcRenderer.invoke(ch, ...args);
}

const listeners = new Map();
for (const ch of EVENT_CHANNELS) {
  listeners.set(ch, new Set());
  ipcRenderer.on(ch, (_e, payload) => {
    const set = listeners.get(ch);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch (err) { console.error(`[bridge] listener error on ${ch}`, err); }
    }
  });
}

function on(channel, handler) {
  const set = listeners.get(channel);
  if (!set || typeof handler !== 'function') return () => {};
  set.add(handler);
  return () => set.delete(handler);
}

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--legion-${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};

contextBridge.exposeInMainWorld('legion', {
  app: {
    info: invoke['app:info'],
    state: invoke['app:state'],
    setState: invoke['app:setState'],
    markOnboarded: invoke['config:onboarded'],
    openExternal: invoke['app:openExternal'],
    launchProvider: arg('provider'),
    launchVersion: arg('version')
  },
  window: {
    action: invoke['window:action'],
    setAlwaysOnTop: invoke['window:setAlwaysOnTop']
  },
  config: {
    get: invoke['config:get'],
    set: invoke['config:set'],
    reset: invoke['config:reset']
  },
  secrets: {
    set: invoke['secret:set'],
    clear: invoke['secret:clear'],
    status: invoke['secret:status']
  },
  ai: {
    status: invoke['ai:status'],
    probe: invoke['ai:probe'],
    chat: invoke['ai:chat'],
    cancel: invoke['ai:cancel'],
    profile: invoke['ai:profile']
  },
  memory: {
    summary: invoke['memory:summary'],
    session: invoke['memory:session'],
    list: invoke['memory:list'],
    remember: invoke['memory:remember'],
    forget: invoke['memory:forget'],
    clearSession: invoke['memory:clearSession'],
    clearAll: invoke['memory:clearAll'],
    export: invoke['memory:export']
  },
  tools: {
    list: invoke['tools:list'],
    audit: invoke['tools:audit'],
    invoke: invoke['tools:invoke'],
    confirm: invoke['tools:confirm']
  },
  voice: {
    voices: invoke['voice:voices'],
    pack: invoke['voice:pack'],
    speak: invoke['voice:speak'],
    speechEnd: invoke['voice:speechEnd'],
    speechCancel: invoke['voice:speechCancel'],
    listen: invoke['voice:listen'],
    listenStop: invoke['voice:listenStop'],
    capabilities: invoke['voice:capabilities'],
    pipeline: invoke['voice:pipeline'],
    wakeStart: invoke['voice:wakeStart'],
    wakeStop: invoke['voice:wakeStop'],
    wakeStatus: invoke['voice:wakeStatus'],
    captureStart: invoke['voice:captureStart'],
    captureChunk: send['voice:captureChunk'],
    captureStop: invoke['voice:captureStop'],
    captureAbort: invoke['voice:captureAbort']
  },
  system: {
    full: invoke['system:full'],
    showItem: invoke['shell:showItem'],
    openPath: invoke['shell:openPath']
  },
  dialog: {
    confirm: invoke['dialog:confirm']
  },
  on
});
