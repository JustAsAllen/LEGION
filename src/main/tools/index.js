'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const pExecFile = promisify(execFile);

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

class ToolManager {
  constructor(deps) {
    this.deps = deps;                 // { settings, secrets, shell, memory, productivity, onConfirm, si }
    this.registry = new ToolRegistry();
    this.sandbox = new PathSandbox(deps.settings.get().tools.fileRoots);
    this.pending = new Map();         // token -> { resolve, reject, tool, args, createdAt }

    const ctx = {
      sandbox: this.sandbox,
      shell: deps.shell,
      memory: deps.memory,
      run: (program, args, opts) => this.safeRun(program, args, opts),
      si: deps.si
    };

    require('./system')(this.registry);
    require('./apps')(this.registry);
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
      requiresConfirmation: typeof t.confirm === 'function' && (t.risk === RISK.WRITE || t.risk === RISK.DESTRUCTIVE)
    }));
  }

  /**
   * Execute a tool. Destructive tools require a user decision, which is routed
   * through onConfirm and matched back to this call by token.
   */
  async execute(name, rawArgs) {
    const tool = this.registry.get(name);
    if (!tool) throw new ToolError(`No tool named "${name}".`, 'E_NOT_FOUND');

    if (!this.enabledCategories().includes(tool.category)) {
      throw new PermissionDenied(`The "${tool.category}" tool group is disabled in Settings.`);
    }

    const args = this.registry.validateArgs(tool, rawArgs || {});

    if ((tool.risk === RISK.WRITE || tool.risk === RISK.DESTRUCTIVE) && this.deps.settings.get().tools.requireConfirmation) {
      let plan = null;
      if (typeof tool.confirm === 'function') {
        plan = await tool.confirm(args, this._ctx());
      }
      if (plan) {
        const approved = await this._requestConfirmation(tool, plan, args);
        if (!approved) {
          const err = new ToolError('The user declined this action.', 'E_DECLINED');
          err.declined = true;
          throw err;
        }
      }
    }

    const started = Date.now();
    const result = await tool.handler(args, this._ctx());
    return {
      tool: name, ok: true, durationMs: Date.now() - started,
      arguments: this._redactArgs(args), result
    };
  }

  _redactArgs(args) {
    const out = {};
    for (const k of Object.keys(args)) {
      if (/key|token|secret|password/i.test(k)) out[k] = '[redacted]';
      else if (typeof args[k] === 'string' && args[k].length > 400) out[k] = args[k].slice(0, 400) + '…';
      else out[k] = args[k];
    }
    return out;
  }

  _ctx() {
    return {
      sandbox: this.sandbox,
      shell: this.deps.shell,
      memory: this.deps.memory,
      run: (p, a, o) => this.safeRun(p, a, o),
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
      execFile(
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
          if (err && (err.killed || err.signal) && code === 1 && !stdout && !stderr) {
            return reject(new ToolError(`"${program}" timed out after ${options.timeout || 20000}ms.`, 'E_TIMEOUT'));
          }
          resolve({ code, stdout: stdout || '', stderr: stderr || '' });
        }
      );
    });
  }
}

module.exports = { ToolManager, RISK };
