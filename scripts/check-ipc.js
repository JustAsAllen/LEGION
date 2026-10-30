'use strict';

/**
 * IPC contract check.
 *
 * Verifies the three places a channel has to exist, instead of only checking
 * that a channel string appears somewhere in main.js:
 *
 *   1. the allowlist in preload (INVOKE_CHANNELS / SEND_CHANNELS / EVENT_CHANNELS)
 *   2. the object handed to contextBridge.exposeInMainWorld
 *   3. the ipcMain handler / listener in main
 *
 * The old version could not catch a channel that was allowlisted and handled
 * but never exposed on the bridge, which is exactly how voice:speechCancel
 * broke. It also could not catch a channel listed as both invoke and send.
 */

const fs = require('fs');
const path = require('path');

const root = process.argv[2] || '.';
const prePath = path.join(root, 'src/preload/preload.js');
const mainPath = path.join(root, 'src/main/main.js');
const islandPath = path.join(root, 'src/main/island.js');

const pre = fs.readFileSync(prePath, 'utf8');
const main = [
  fs.readFileSync(mainPath, 'utf8'),
  fs.existsSync(islandPath) ? fs.readFileSync(islandPath, 'utf8') : ''
].join('\n');

const errors = [];
const warnings = [];

function array(name) {
  const m = pre.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  if (!m) {
    errors.push(`could not find ${name} in preload.js`);
    return [];
  }
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function unique(list) {
  return [...new Set(list)];
}

const invokeChannels = unique(array('INVOKE_CHANNELS'));
const eventChannels = unique(array('EVENT_CHANNELS'));
const sendChannels = unique(array('SEND_CHANNELS'));

const exposeAt = pre.indexOf('exposeInMainWorld');
if (exposeAt === -1) {
  errors.push('preload.js does not call contextBridge.exposeInMainWorld');
}
const bridge = exposeAt === -1 ? '' : pre.slice(exposeAt);

const bridgeInvoke = new Set([...bridge.matchAll(/invoke\['([^']+)'\]/g)].map((m) => m[1]));
const bridgeSend = new Set([...bridge.matchAll(/send\['([^']+)'\]/g)].map((m) => m[1]));

const mainHandled = new Set([
  ...[...main.matchAll(/^[ \t]*handle\('([^']+)'/gm)].map((m) => m[1]),
  ...[...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1])
]);
const mainListened = new Set([...main.matchAll(/ipcMain\.on\('([^']+)'/g)].map((m) => m[1]));
const mainSent = new Set([...main.matchAll(/\b(?:send|sendToMain)\('([^']+)'/g)].map((m) => m[1]));

/* ── duplicates ─────────────────────────────────────────────── */

for (const ch of invokeChannels) {
  if (sendChannels.includes(ch)) errors.push(`channel listed as both invoke and send: ${ch}`);
  if (eventChannels.includes(ch)) errors.push(`channel listed as both invoke and event: ${ch}`);
}
for (const ch of sendChannels) {
  if (eventChannels.includes(ch)) errors.push(`channel listed as both send and event: ${ch}`);
}

/* ── allowlist -> bridge ────────────────────────────────────── */

for (const ch of invokeChannels) {
  if (!bridgeInvoke.has(ch)) errors.push(`allowlisted invoke channel is not exposed on window.legion: ${ch}`);
}
for (const ch of sendChannels) {
  if (!bridgeSend.has(ch)) errors.push(`allowlisted send channel is not exposed on window.legion: ${ch}`);
}

/* ── bridge -> allowlist (stale references) ─────────────────── */

for (const ch of bridgeInvoke) {
  if (!invokeChannels.includes(ch)) errors.push(`bridge exposes invoke channel missing from INVOKE_CHANNELS: ${ch}`);
}
for (const ch of bridgeSend) {
  if (!sendChannels.includes(ch)) errors.push(`bridge exposes send channel missing from SEND_CHANNELS: ${ch}`);
}

/* ── allowlist -> main ──────────────────────────────────────── */

for (const ch of invokeChannels) {
  if (!mainHandled.has(ch)) errors.push(`allowlisted invoke channel has no ipcMain.handle in main.js: ${ch}`);
}
for (const ch of sendChannels) {
  if (!mainListened.has(ch)) errors.push(`allowlisted send channel has no ipcMain.on in main.js: ${ch}`);
}
for (const ch of eventChannels) {
  if (!mainSent.has(ch)) errors.push(`event channel is never sent by main.js: ${ch}`);
}

/* ── main -> allowlist (unreachable handlers) ───────────────── */

for (const ch of mainHandled) {
  if (!invokeChannels.includes(ch)) warnings.push(`main handles a channel the preload does not allowlist: ${ch}`);
}
for (const ch of mainListened) {
  if (!sendChannels.includes(ch)) warnings.push(`main listens on a channel the preload does not allowlist: ${ch}`);
}

/* ── report ─────────────────────────────────────────────────── */

console.log('IPC contract check');
console.log(`  invoke channels: ${invokeChannels.length}`);
console.log(`  send channels:   ${sendChannels.length}`);
console.log(`  event channels:  ${eventChannels.length}`);
console.log(`  bridge exposes:  ${bridgeInvoke.size} invoke, ${bridgeSend.size} send`);
console.log(`  main handlers:   ${mainHandled.size} invoke, ${mainListened.size} send`);

for (const w of warnings) console.log(`  warning: ${w}`);

if (errors.length) {
  console.error(`\nFAIL: ${errors.length} IPC contract error(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exitCode = 1;
} else {
  console.log('\nPASS: preload allowlists, bridge exposure and main handlers agree.');
}
