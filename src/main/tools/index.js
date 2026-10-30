'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const pExecFile = promisify(execFile);
const { randomUUID } = require('crypto');

const { ToolRegistry, ToolError, ValidationError, PermissionDenied, RISK } = require('./registry');
const { PathSandbox } = require('./sandbox');

const CATEGORY_CONFIG_KEY = {
  system: 'allowSystem',
  apps: 'allowApps',
  files: 'allowFiles',
  web: 'allowWeb',
  dev: 'allowDev',
  productivity: 'allowProductivity'
};
const DEFAULT_TOOL_TIMEOUT_MS = 30000;

class ToolManager {
  constructor(deps) {
    this.deps = deps;                 // { settings, secrets, shell, memory, productivity, onConfirm, si }
    this.registry = new ToolRegistry();
    this.sandbox = new PathSandbox(deps.settings.get().tools.fileRoots, deps.workspaceRoot);
    this.pending = new Map();         // token -> { resolve, reject, tool, args, createdAt }
    this.audit = [];

    const ctx = {
      sandbox: this.sandbox,
      shell: deps.shell,
      memory: deps.memory,
      run: (program, args, opts) => this.safeRun(program, args, opts),
      si: deps.si
    };

    require('./system')(this.registry);
    require('./apps')(this.registry);
    require('./desktop')(this.registry);
    require('./files')(this.registry);
    require('./web')(this.registry);
    require('./dev')(this.registry);
    require('./productivity')(this.registry, { productivity: deps.productivity, memory: deps.memory });
  }

  syncSandbox() { this.sandbox.setRoots(this.deps.settings.get().tools.fileRoots); }

  enabledCategories() {
    const t = this.deps.settings.get().tools;
    if (!t.enabled) return [];
    return Object.keys(CATEGORY_CONFIG_KEY).filter((cat) => t[CATEGORY_CONFIG_KEY[cat]]);
  }

  catalogue() { return this.registry.catalogue(this.enabledCategories()); }

  list() {
    const enabled = new Set(this.enabledCategories());
    return this.registry.list().map((t) => ({
      name: t.name, category: t.category, risk: t.risk,
      description: t.description, enabled: enabled.has(t.category),
      requiresConfirmation: typeof t.confirm === 'function'
    }));
  }

  /**
   * Execute a tool. Destructive tools require a user decision, which is routed
   * through onConfirm and matched back to this call by token.
   */
  async execute(name, rawArgs, options) {
    const started = Date.now();
    const auditId = randomUUID();
    const opts = options || {};
    let tool = null;
    let args = null;
    try {
      tool = this.registry.get(name);
      if (!tool) throw new ToolError(`No tool named "${name}".`, 'E_NOT_FOUND');
      if (!this.enabledCategories().includes(tool.category)) {
        throw new PermissionDenied(`The "${tool.category}" tool group is disabled in Settings.`);
      }

      args = this.registry.validateArgs(tool, rawArgs || {});
      const ctx = this._ctx(opts.signal);
      if (this.deps.settings.get().tools.requireConfirmation && typeof tool.confirm === 'function') {
        const plan = await tool.confirm(args, ctx);
        if (plan) {
          const approved = await this._requestConfirmation(tool, plan, args);
          if (!approved) {
            const err = new ToolError('The user declined this action.', 'E_DECLINED');
            err.declined = true;
            throw err;
          }
        }
      }

      const timeoutMs = Number(tool.timeoutMs) || DEFAULT_TOOL_TIMEOUT_MS;
      const result = await this._runWithControls(tool.handler(args, ctx), timeoutMs, opts.signal, name);
      const envelope = {
        auditId, tool: name, ok: true, risk: tool.risk,
        startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
        arguments: this._redactArgs(args), result
      };
      this._recordAudit(envelope);
      return envelope;
    } catch (err) {
      const failure = err instanceof ToolError ? err : new ToolError(err.message || String(err), 'E_TOOL');
      this._recordAudit({
        auditId, tool: name, ok: false, risk: tool ? tool.risk : null,
        startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
        arguments: args ? this._redactArgs(args) : null,
        error: { code: failure.code, message: failure.message, declined: !!failure.declined }
      });
      throw failure;
    }
  }


  _runWithControls(work, timeoutMs, signal, name) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () => finish(reject, new ToolError(`Tool "${name}" was cancelled.`, 'E_ABORTED'));
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      timer = setTimeout(() => finish(reject, new ToolError(`Tool "${name}" timed out after ${timeoutMs}ms.`, 'E_TIMEOUT')), timeoutMs);
      Promise.resolve(work).then((value) => finish(resolve, value), (err) => finish(reject, err));
    });
  }

  _recordAudit(entry) {
    this.audit.push(Object.assign({}, entry));
    if (this.audit.length > 200) this.audit.splice(0, this.audit.length - 200);
    try { if (typeof this.deps.onAudit === 'function') this.deps.onAudit(entry); } catch (_) { /* audit must not break a tool */ }
  }

  auditLog() { return this.audit.slice(); }
  _redactArgs(args) {
    const out = {};
    for (const k of Object.keys(args)) {
      if (/key|token|secret|password/i.test(k)) out[k] = '[redacted]';
      else if (typeof args[k] === 'string' && args[k].length > 400) out[k] = args[k].slice(0, 400) + '…';
      else out[k] = args[k];
    }
    return out;
  }

  _ctx(signal) {
    return {
      sandbox: this.sandbox,
      shell: this.deps.shell,
      memory: this.deps.memory,
      run: (p, a, o) => this.safeRun(p, a, Object.assign({}, o, { signal })),
      signal,
      si: this.deps.si
    };
  }

  _requestConfirmation(tool, plan, args) {
    const token = require('crypto').randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(token)) { this.pending.delete(token); resolve(false); }
      }, 120000);
      if (timer.unref) timer.unref();

      this.pending.set(token, {
        resolve: (v) => { clearTimeout(timer); this.pending.delete(token); resolve(!!v); },
        tool: tool.name, args, createdAt: Date.now()
      });

      this.deps.onConfirm({
        token,
        tool: tool.name,
        title: `Confirm: ${tool.name}`,
        message: plan.message,
        impact: plan.impact,
        destructive: !!plan.destructive,
        arguments: this._redactArgs(args)
      });
    });
  }

  resolveConfirmation(token, approved) {
    const entry = this.pending.get(token);
    if (!entry) return { resolved: false };
    entry.resolve(approved);
    return { resolved: true, tool: entry.tool, approved: !!approved };
  }

  rejectAll(reason) {
    for (const [, entry] of this.pending) entry.resolve(false);
    this.pending.clear();
    return { cleared: true, reason: reason || null };
  }

  /** Guarded child process. No shell, no user-controlled program names. */
  safeRun(program, args, opts) {
    const options = opts || {};
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; if (options.signal) options.signal.removeEventListener('abort', onAbort); fn(value); };
      const onAbort = () => {
        try { child && child.kill(); } catch (_) { /* already exited */ }
        finish(reject, new ToolError(`"${program}" was cancelled.`, 'E_ABORTED'));
      };
      const child = execFile(
        program,
        Array.isArray(args) ? args : [],
        {
          cwd: options.cwd,
          timeout: options.timeout || 20000,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          env: options.system ? process.env : Object.assign({}, process.env)
        },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          if (err && options.signal && options.signal.aborted) {
            return finish(reject, new ToolError(`"${program}" was cancelled.`, 'E_ABORTED'));
          }
          if (err && (err.killed || err.signal) && code === 1 && !stdout && !stderr) {
            return finish(reject, new ToolError(`"${program}" timed out after ${options.timeout || 20000}ms.`, 'E_TIMEOUT'));
          }
          finish(resolve, { code, stdout: stdout || '', stderr: stderr || '' });
        }
      );
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}

module.exports = { ToolManager, RISK };
