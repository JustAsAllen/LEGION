'use strict';
/**
 * Scope-aware undeclared-global detection for the LEGION codebase.
 *
 * Parses every source file with acorn (full ES2022 grammar, module +
 * script), walks the AST tracking lexical scopes, and reports identifier
 * reads that resolve to no local/imported binding and no known global.
 *
 * Catches the real typo class: reading a variable that was never declared
 * anywhere it could live (e.g. `progres.x` instead of `progress.x`), which
 * would throw ReferenceError at runtime — often only on a side-branch.
 *
 * Reads are resolved AFTER the whole file is walked, so hoisted `function`
 * and `var` declarations are correctly visible before their textual position.
 */

const acorn = require('acorn');
const { GLOBALS } = require('./scope-globals.js');

class Scope {
  constructor(kind, parent, fnNode) {
    this.kind = kind;            // 'module' | 'function' | 'class' | 'block' | 'catch' | 'for' | 'loop'
    this.parent = parent;
    this.fnNode = fnNode || null;
    this.names = new Map();      // name -> binding kind ('var' | 'let' | 'fn' | 'param' | 'import' | 'class' | 'catch')
  }
  // A name is visible here if declared in this scope OR any ancestor.
  // var/fn bindings hoist to the nearest function (or module) scope.
  resolve(name) {
    for (let s = this; s; s = s.parent) {
      const kind = s.names.get(name);
      if (kind) {
        if (kind === 'var' || kind === 'fn') {
          // hoisted: valid everywhere within the function/file, even earlier
          return s.fnNode || s.kind === 'function' || s.kind === 'module' ? true : true;
        }
        return true;
      }
    }
    return false;
  }
  hasVarOrFnKind(name) { return this.names.get(name) === 'var' || this.names.get(name) === 'fn'; }
}

function analyze(src, filename) {
  const ast = acorn.parse(src, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowHashBang: true,
    locations: true,
    sourceFile: filename,
  });

  const reads = [];      // { name, node, scope }
  const scopes = [];
  let scope = null;

  function enter(kind, fnNode) {
    scope = new Scope(kind, scope, fnNode);
    scopes.push(scope);
    return scope;
  }
  function exit() { scope = scope.parent; }
  function bind(pattern, kind) {
    if (!pattern) return;
    switch (pattern.type) {
      case 'Identifier': scope.names.set(pattern.name, kind); break;
      case 'ObjectPattern':
        for (const p of pattern.properties) {
          if (p.type === 'RestElement') bind(p.argument, kind);
          else if (p.type === 'Property') bind(p.value, kind);
          else bind(p, kind);
        }
        break;
      case 'ArrayPattern':
        for (const el of pattern.elements) if (el) bind(el, kind);
        break;
      case 'AssignmentPattern': bind(pattern.left, kind); break;
      case 'RestElement': bind(pattern.argument, kind); break;
      default: break;
    }
  }
  function read(name, node) {
    if (name === 'arguments' || name === 'undefined' || name === 'this') return;
    // `this` and `arguments` handled above; skip globals here too
    reads.push({ name, node, scope });
  }

  function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {

      case 'Identifier':
        read(node.name, node);
        break;

      /* ---- bindings ---- */
      case 'VariableDeclaration': {
        const kind = node.kind === 'var' ? 'var' : 'let';
        for (const d of node.declarations) {
          bind(d.id, kind);
          visit(d.init);
        }
        break;
      }
      case 'FunctionDeclaration': {
        scope.names.set(node.id.name, 'fn');
        visitFunction(node);
        break;
      }
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        visitFunction(node);
        break;
      }
      case 'ClassDeclaration': {
        scope.names.set(node.id.name, 'class');
        visit(node.superClass);
        enter('class', node); for (const el of node.body.body) visit(el); exit();
        break;
      }
      case 'ClassExpression': {
        enter('class', node); for (const el of node.body.body) visit(el); exit();
        break;
      }
      case 'MethodDefinition': {
        visitCompute(node);
        if (node.value) visit(node.value);
        break;
      }
      case 'PropertyDefinition': {
        visitCompute(node);
        visit(node.value);
        break;
      }
      case 'ImportDeclaration': {
        for (const s of node.specifiers) scope.names.set(s.local.name, 'import');
        break;
      }
      case 'CatchClause': {
        enter('catch', null);
        if (node.param) bind(node.param, 'catch');
        visit(node.body);
        exit();
        break;
      }

      /* ---- scope transitions ---- */
      case 'BlockStatement':
        enter('block', null); for (const s of node.body) visit(s); exit(); break;
      case 'ForStatement':
        enter('for', null);
        visit(node.init);
        visit(node.test);
        visit(node.update);
        visit(node.body);
        exit();
        break;
      case 'ForInStatement':
      case 'ForOfStatement':
        enter('for', null);
        if (node.left.type === 'VariableDeclaration') {
          const kind = node.left.kind === 'var' ? 'var' : 'let';
          for (const d of node.left.declarations) bind(d.id, kind);
        } else {
          visit(node.left);
        }
        visit(node.right);
        visit(node.body);
        exit();
        break;
      case 'SwitchStatement':
        visit(node.discriminant);
        enter('block', null);
        for (const c of node.cases) { visit(c.test); for (const s of c.consequent) visit(s); }
        exit();
        break;
      case 'StaticBlock':
        enter('block', null); for (const s of node.body) visit(s); exit(); break;

      /* ---- reads that flow through ---- */
      case 'Program':
        for (const s of node.body) visit(s);
        break;
      case 'ExpressionStatement': case 'ReturnStatement': case 'ThrowStatement':
      case 'AwaitExpression': case 'YieldExpression': case 'SpreadElement': case 'RestElement':
      case 'ParenthesizedExpression':
        visit(node.argument);
        break;
      case 'IfStatement': visit(node.test); visit(node.consequent); visit(node.alternate); break;
      case 'WhileStatement': visit(node.test); visit(node.body); break;
      case 'DoWhileStatement': visit(node.test); visit(node.body); break;
      case 'TryStatement':
        visit(node.block);
        if (node.handler) visit(node.handler);
        if (node.finalizer) visit(node.finalizer);
        break;
      case 'BreakStatement': case 'ContinueStatement': case 'EmptyStatement':
      case 'DebuggerStatement': case 'MetaProperty': case 'Literal':
        break;
      case 'LabeledStatement': visit(node.body); break;
      case 'SwitchCase': visit(node.test); for (const s of node.consequent) visit(s); break;
      case 'UnaryExpression': case 'UpdateExpression': visit(node.argument); break;
      case 'BinaryExpression': case 'LogicalExpression': visit(node.left); visit(node.right); break;
      case 'AssignmentExpression':
        visit(node.left);
        visit(node.right);
        break;
      case 'ConditionalExpression': visit(node.test); visit(node.consequent); visit(node.alternate); break;
      case 'SequenceExpression': for (const e of node.expressions) visit(e); break;
      case 'CallExpression': case 'NewExpression':
        if (node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments[0] && node.arguments[0].type === 'Literal') {
          // bare require('x') — the callee is global but the read is intentional
          break;
        }
        visit(node.callee);
        for (const a of node.arguments) visit(a);
        break;
      case 'MemberExpression':
        visit(node.object);
        if (node.computed) visit(node.property);
        break;
      case 'OptionalMemberExpression':
        visit(node.object);
        if (node.computed) visit(node.property);
        break;
      case 'OptionalCallExpression':
        visit(node.callee);
        for (const a of node.arguments) visit(a);
        break;
      case 'ArrayExpression': for (const el of node.elements) visit(el); break;
      case 'ObjectExpression':
        for (const p of node.properties) {
          if (p.type === 'SpreadElement') { visit(p.argument); continue; }
          visitCompute(p);
          if (p.kind === 'init' && p.shorthand) visit(p.key);  // {a} reads a
          visit(p.value);
        }
        break;
      case 'Property':
        visitCompute(node);
        visit(node.value);
        break;
      case 'TemplateLiteral':
        for (const e of node.expressions) visit(e);
        break;
      case 'TaggedTemplateExpression':
        visit(node.tag);
        for (const e of node.quasi.expressions) visit(e);
        break;
      case 'ExportNamedDeclaration':
        if (node.declaration) visit(node.declaration);
        break;
      case 'ExportDefaultDeclaration':
        if (node.declaration) visit(node.declaration);
        break;
      case 'ExportAllDeclaration':
        break;

      default:
        // safety net: descend generically for any node type we did not list
        for (const k of Object.keys(node)) {
          if (k === 'loc' || k === 'start' || k === 'end' || k === 'range' || k === 'sourceFile') continue;
          const v = node[k];
          if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') visit(c); }
          else if (v && typeof v.type === 'string') visit(v);
        }
    }
  }

  function visitCompute(node) {
    if (node.computed && node.key) visit(node.key);
  }

  function visitFunction(node) {
    enter('function', node);
    for (const p of node.params) bind(p, 'param');
    if (node.body.type === 'BlockStatement') for (const s of node.body.body) visit(s);
    else visit(node.body);
    exit();
  }

  enter('module', null);
  visit(ast);
  exit(); // module scope

  // resolve reads after the whole file is walked so hoisted fn/var bindings
  // that appear later in the file are still visible
  const undeclared = [];
  const seen = new Set();
  for (const r of reads) {
    if (GLOBALS.has(r.name)) continue;
    const key = r.file || '';
    if (seen.has(r.name + ':' + r.node.loc.start.line + ':' + filename)) continue;
    if (resolveIn(r.scope, r.name)) continue;
    seen.add(r.name + ':' + r.node.loc.start.line + ':' + filename);
    undeclared.push({ name: r.name, line: r.node.loc.start.line, file: filename });
  }
  // dedupe on (file:line:name)
  const out = [];
  const kset = new Set();
  for (const u of undeclared) {
    const k = u.file + ':' + u.line + ':' + u.name;
    if (!kset.has(k)) { kset.add(k); out.push(u); }
  }
  return out;
}

function resolveIn(start, name) {
  for (let s = start; s; s = s.parent) {
    if (s.names.has(name)) return true;
  }
  return false;
}

module.exports = { analyze };