'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { RISK, ToolError } = require('./registry');

/**
 * Developer tools. Disabled by default (settings.tools.allowDev).
 *
 * Commands are matched against a hard allowlist of argv shapes. The model can
 * never supply a free-form command string, a shell, redirection, chaining or
 * an interpreter inline flag. Each invocation is confirmed by the user.
 */

const ALLOWED = [
  { id: 'git_status',  cmd: 'git',        args: ['status'],                     desc: 'Show working tree status' },
  { id: 'git_log',     cmd: 'git',        args: ['log', '--oneline', '-n', '20'], desc: 'Show the last 20 commits' },
  { id: 'git_diff',    cmd: 'git',        args: ['diff', '--stat'],             desc: 'Summarise unstaged changes' },
  { id: 'git_branch',  cmd: 'git',        args: ['branch', '--show-current'],   desc: 'Show the current branch' },
  { id: 'npm_ls',      cmd: 'npm',        args: ['ls', '--depth=0'],            desc: 'List top-level dependencies' },
  { id: 'npm_test',    cmd: 'npm',        args: ['test'],                      desc: 'Run the project test suite' }
];

const ALLOWED_IDS = new Set(ALLOWED.map((a) => a.id));

module.exports = function registerDevTools(registry) {
  registry.register({
    name: 'dev_commands',
    category: 'dev',
    risk: RISK.READ,
    description: 'List the development commands LEGION is permitted to run.',
    parameters: { type: 'object', properties: {} },
    async handler() { return { commands: ALLOWED.map((a) => ({ id: a.id, description: a.desc, program: a.cmd, args: a.args })) }; }
  });

  registry.register({
    name: 'dev_run',
    category: 'dev',
    risk: RISK.DESTRUCTIVE,
    description: 'Run one allowlisted development command inside a project directory. Requires confirmation.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ALLOWED.map((a) => a.id), description: 'The allowlisted command id.' },
        cwd: { type: 'string', description: 'Project directory.' }
      },
      required: ['command', 'cwd']
    },
    confirm(args) {
      const spec = ALLOWED.find((a) => a.id === args.command);
      if (!spec) throw new ToolError('Unknown command.', 'E_INPUT');
      return {
        message: `This will run \`${spec.cmd} ${spec.args.join(' ')}\` inside "${args.cwd}".`,
        impact: 'Executing a development command'
      };
    },
    async handler({ command, cwd }, ctx) {
      if (!ALLOWED_IDS.has(command)) throw new ToolError('That command is not on the allowlist.', 'E_NOT_ALLOWED');
      const spec = ALLOWED.find((a) => a.id === command);
      const dir = ctx.sandbox.resolve(cwd);
      const st = await fsp.stat(dir).catch(() => null);
      if (!st || !st.isDirectory()) throw new ToolError(`"${cwd}" is not a directory.`, 'E_NOT_DIR');

      const result = await ctx.run(spec.cmd, spec.args, { cwd: dir, timeout: 120000, system: true });
      return {
        command: spec.id, program: spec.cmd, argv: spec.args, cwd: dir,
        exitCode: result.code, ok: result.code === 0,
        stdout: String(result.stdout || '').slice(-8000),
        stderr: String(result.stderr || '').slice(-4000)
      };
    }
  });

  registry.register({
    name: 'dev_project_info',
    category: 'dev',
    risk: RISK.READ,
    description: 'Inspect a project folder: detect its type, read its manifest scripts and summarise the entry points.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    },
    async handler({ path: p }, ctx) {
      const dir = ctx.sandbox.resolve(p);
      const st = await fsp.stat(dir).catch(() => null);
      if (!st || !st.isDirectory()) throw new ToolError(`"${p}" is not a directory.`, 'E_NOT_DIR');

      const detect = async (name) => { try { await fsp.access(path.join(dir, name)); return true; } catch (_) { return false; } };
      const isNode = await detect('package.json');
      const isPy = await detect('pyproject.toml') || await detect('requirements.txt') || await detect('setup.py');
      const isRust = await detect('Cargo.toml');
      const isGit = await detect('.git');

      let manifest = null;
      if (isNode) {
        try {
          const raw = await fsp.readFile(path.join(dir, 'package.json'), 'utf8');
          const pkg = JSON.parse(raw);
          manifest = {
            type: 'node', name: pkg.name || null, version: pkg.version || null,
            scripts: pkg.scripts ? Object.keys(pkg.scripts) : [],
            dependencies: pkg.dependencies ? Object.keys(pkg.dependencies).length : 0,
            devDependencies: pkg.devDependencies ? Object.keys(pkg.devDependencies).length : 0
          };
        } catch (_) { manifest = { type: 'node', error: 'package.json could not be parsed' }; }
      }

      let entries = [];
      try { entries = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith('.')).slice(0, 40).map((e) => (e.isDirectory() ? e.name + '/' : e.name)); }
      catch (_) { /* unreadable */ }

      return {
        path: dir, git: isGit, ecosystem: isNode ? 'node' : isPy ? 'python' : isRust ? 'rust' : 'unknown',
        manifest, entries
      };
    }
  });
};

module.exports.ALLOWED = ALLOWED;
