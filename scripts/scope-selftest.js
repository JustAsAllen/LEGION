'use strict';
/**
 * Self-test for the scope analyzer: prove it CATCHES the typo class it is
 * meant to catch, so a clean run on the codebase means something.
 */

const { analyze } = require('./scope-analyzer.js');

const cases = [
  {
    name: 'typo in a member expression',
    src: `const progress = 0.5; export function step() { return progres * 2; }`,
    expect: ['progres'],
  },
  {
    name: 'typo in a nested arrow body',
    src: `export const run = (a) => { return a.map((x) => x * scaler); };`,
    expect: ['scaler'],
  },
  {
    name: 'unqualified read of a never-declared identifier',
    src: `export function go() { if (!started) return; return 1; }`,
    expect: ['started'],
  },
  {
    name: 'typo inside a class method (free variable)',
    src: `export class A { step() { return baseValue * 2; } }`,
    expect: ['baseValue'],
  },
];

let failed = 0;
for (const c of cases) {
  const found = analyze(c.src, 'selftest.js').map(r => r.name);
  const missing = c.expect.filter(n => !found.includes(n));
  const extra = found.filter(n => !c.expect.includes(n));
  const ok = missing.length === 0;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}${extra.length ? ' (extra: ' + extra.join(',') + ')' : ''}`);
  if (!ok) { failed++; console.log('        expected: ' + c.expect.join(',') + '  found: ' + found.join(',') + ''); }
}

// Cases that must NOT be flagged.
const clean = [
  { name: 'hoisted function used before definition', src: `function later() { return 1; } export function early() { return later(); }` },
  { name: 'var used before assignment', src: `export function f() { return x; var x = 1; }` },
  { name: 'block-scoped binding', src: `export function f() { { const inner = 1; return inner; } }` },
  { name: 'imported name', src: `import { helper } from './h.js'; export function f() { return helper(); }` },
  { name: 'object shorthand property', src: `const a = 1; export const o = { a };` },
  { name: 'object key is not a read', src: `export const o = { someKey: 1 };` },
  { name: 'param shadows outer name', src: `const x = 1; export function f(x) { return x; }` },
  { name: 'catch param', src: `export function f() { try { g(); } catch (err) { return err; } }` },
  { name: 'destructured params', src: `export function f({ a, b = 2 }, [c]) { return a + b + c; }` },
  { name: 'member property is not a read', src: `export function f(o) { return o.missing.isFine; }` },
  { name: 'typed array global', src: `export const buf = new Uint8Array(8);` },
  { name: 'window global', src: `export const w = window.innerWidth;` },
  { name: 'loop variable', src: `export function f() { for (let i = 0; i < 3; i++) { return i; } }` },
  { name: 'for-of binding', src: `export function f(list) { for (const item of list) { return item; } }` },
  { name: 'nested arrow param', src: `export const f = (a) => (b) => a + b;` },
  { name: 'class method param', src: `export class A { m(v) { return v * 2; } }` },
  { name: 'switch case body', src: `export function f(x) { switch (x) { case 1: return 1; default: return 0; } }` },
  { name: 'ternary branches', src: `export function f(x) { return x ? yes : no; } const yes = 1, no = 0;` },
  { name: 'labeled block', src: `export function f() { outer: { break outer; } return 1; }` },
  { name: 'optional chaining', src: `export function f(o) { return o?.a?.b?.c; }` },
];

for (const c of clean) {
  const found = analyze(c.src, 'selftest.js').map(r => r.name);
  const ok = found.length === 0;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}${ok ? '' : ' -> ' + found.join(',')}`);
  if (!ok) failed++;
}

if (failed) {
  console.log(`\nscope analyzer self-test: ${failed} failing case(s)`);
  process.exit(1);
}
console.log('\nscope analyzer self-test: all cases pass');
