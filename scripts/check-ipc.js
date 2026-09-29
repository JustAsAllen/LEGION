const fs = require('fs');
const path = require('path');
const root = process.argv[2] || '.';

const pre = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');

const chans = [...pre.matchAll(/'([a-z]+):([a-zA-Z]+)'/g)].map(m => m[1] + ':' + m[2]);
const uniq = [...new Set(chans)];

const missing = uniq.filter(c => !main.includes("'" + c + "'"));

// IPC event channels (one-way main -> renderer)
const EVENTS = ['state', 'metrics', 'ai:event', 'tool:confirmation',
  'timer:fired', 'app:ready', 'window:focus', 'ui:open-panel', 'shortcut:activate',
  'voice:wake'];
const evMissing = EVENTS.filter(c => !main.includes("'" + c + "'"));

console.log('invoke channels in preload:', uniq.length);
console.log('  missing handler in main:', missing.length ? missing.join(', ') : '(none)');
console.log('event channels:', EVENTS.length);
console.log('  missing sender in main:', evMissing.length ? evMissing.join(', ') : '(none)');
