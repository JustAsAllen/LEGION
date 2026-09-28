'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { RISK, ToolError } = require('./registry');

/**
 * Application control. LEGION only launches programs from a curated registry
 * or explicit user-approved paths. It never runs free-form shell strings.
 */

const APPS = [
  { id: 'explorer',    name: 'File Explorer',      targets: [path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')] },
  { id: 'notepad',     name: 'Notepad',            targets: [path.join(process.env.SystemRoot || 'C:\\Windows', 'notepad.exe')] },
  { id: 'calc',        name: 'Calculator',         targets: [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'calc.exe')] },
  { id: 'cmd',         name: 'Command Prompt',     targets: [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')] },
  { id: 'powershell',  name: 'PowerShell',         targets: [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')] },
  { id: 'terminal',    name: 'Windows Terminal',   targets: [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WT.exe'), path.join(process.env.SystemRoot || 'C:\\Windows', 'WT.exe')] },
  { id: 'settings',    name: 'Windows Settings',   targets: ['ms-settings:'] },
  { id: 'taskmgr',     name: 'Task Manager',       targets: [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'Taskmgr.exe')] },
  { id: 'control',     name: 'Control Panel',      targets: ['control.exe'] },
  { id: 'regedit',     name: 'Registry Editor',    targets: ['regedit.exe'] },
  { id: 'snip',        name: 'Snip & Sketch',      targets: ['ms-screenclip:'] },
  { id: 'code',        name: 'Visual Studio Code', targets: [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe')] },
  { id: 'discord',     name: 'Discord',            targets: [path.join(process.env.APPDATA || '', 'discord', 'Update.exe'), path.join(process.env.LOCALAPPDATA || '', 'Discord', 'app-*/Discord.exe')] },
  { id: 'chrome',      name: 'Google Chrome',      targets: [path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe')] },
  { id: 'edge',        name: 'Microsoft Edge',     targets: [path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')] },
  { id: 'steam',       name: 'Steam',              targets: [path.join(process.env['ProgramFiles(x86)'] || '', 'Steam', 'steam.exe'), path.join(process.env.ProgramFiles || '', 'Steam', 'steam.exe')] },
  { id: 'spotify',     name: 'Spotify',            targets: [path.join(process.env.APPDATA || '', 'Spotify', 'Spotify.exe')] },
  { id: 'obs',         name: 'OBS Studio',         targets: [path.join(process.env.ProgramFiles || '', 'obs-studio', 'bin', '64bit', 'obs64.exe')] }
];

function firstExisting(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    if (c.includes('*')) {
      const dir = c.slice(0, c.indexOf('*'));
      try {
        const found = fs.readdirSync(dir).map((f) => path.join(dir, f));
        for (const f of found) if (fs.existsSync(f)) return f;
      } catch (_) { /* not installed */ }
      continue;
    }
    if (/\.[a-z]+$/i.test(c) && fs.existsSync(c)) return c;
    if (!/\.[a-z]+$/i.test(c)) return c; // protocol / bare command
  }
  return null;
}

function launch(target, args) {
  return new Promise((resolve, reject) => {
    execFile(target, args || [], { windowsHide: false, timeout: 15000 }, (err) => {
      if (err && err.killed) return reject(new ToolError(`"${path.basename(target)}" did not respond.`, 'E_LAUNCH_TIMEOUT'));
      if (err && err.code === 'ENOENT') return reject(new ToolError(`"${path.basename(target)}" could not be found.`, 'E_NOT_FOUND'));
      resolve({ launched: target });
    });
  });
}

module.exports = function registerAppTools(registry) {
  registry.register({
    name: 'apps_list',
    category: 'apps',
    risk: RISK.READ,
    description: 'List the applications LEGION knows how to launch and whether they are installed.',
    parameters: { type: 'object', properties: {} },
    async handler() {
      return {
        applications: APPS.map((a) => {
          const resolved = firstExisting(a.targets);
          return { id: a.id, name: a.name, available: !!resolved, path: resolved };
        })
      };
    }
  });

  registry.register({
    name: 'apps_open',
    category: 'apps',
    risk: RISK.SYSTEM,
    description: 'Launch a known application by id, optionally opening a file or folder with it.',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Application id from apps_list, or its display name.' },
        target: { type: 'string', description: 'Optional file or folder to open with the application.' }
      },
      required: ['app']
    },
    async handler({ app, target }) {
      const q = String(app).trim().toLowerCase();
      const found = APPS.find((a) => a.id === q) || APPS.find((a) => a.name.toLowerCase() === q);
      if (!found) {
        return { launched: false, reason: 'unknown_app', availableApps: APPS.map((a) => a.id) };
      }
      const bin = firstExisting(found.targets);
      if (!bin) return { launched: false, reason: 'not_installed', app: found.name };
      const args = target ? [String(target)] : [];
      await launch(bin, args);
      return { launched: true, app: found.name, executable: bin, openedWith: target || null };
    }
  });

  registry.register({
    name: 'apps_open_path',
    category: 'apps',
    risk: RISK.SYSTEM,
    description: 'Open a folder or file with the operating system default handler.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async handler({ path: p }, ctx) {
      const resolved = ctx.sandbox.resolve(p);
      if (!fs.existsSync(resolved)) throw new ToolError(`"${p}" does not exist.`, 'E_NOT_FOUND');
      const err = await ctx.shell.openPath(resolved);
      if (err) throw new ToolError(`Windows could not open "${p}": ${err}`, 'E_OPEN');
      return { opened: true, path: resolved };
    }
  });

  registry.register({
    name: 'apps_open_url',
    category: 'apps',
    risk: RISK.SYSTEM,
    description: 'Open a URL in the default browser.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Must start with http:// or https://' } },
      required: ['url']
    },
    async handler({ url }, ctx) {
      let parsed;
      try { parsed = new URL(url); } catch (_) { throw new ToolError('That is not a valid URL.', 'E_URL'); }
      if (!/^https?:$/.test(parsed.protocol)) throw new ToolError('Only http and https URLs are permitted.', 'E_URL_SCHEME');
      await ctx.shell.openExternal(parsed.toString());
      return { opened: true, url: parsed.toString() };
    }
  });

  registry.register({
    name: 'apps_list_windows',
    category: 'apps',
    risk: RISK.READ,
    description: 'List currently visible top-level windows and their owning process.',
    parameters: { type: 'object', properties: {} },
    async handler() {
      const script = [
        "Add-Type @'",
        "using System;using System.Text;using System.Runtime.InteropServices;",
        "public class W{",
        " [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumProc f, IntPtr l);",
        " [DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);",
        " [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h);",
        " [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);",
        " public delegate bool EnumProc(IntPtr h, IntPtr l);}",
        "'@",
        "$res=@(); [W]::EnumWindows({param($h,$l) if([W]::IsWindowVisible($h)){ $sb=New-Object Text.StringBuilder 512; [void][W]::GetWindowText($h,$sb,512); $t=$sb.ToString(); if($t){ $p=0; [void][W]::GetWindowThreadProcessId($h,[ref]$p); $pn=''; try{$pn=(Get-Process -Id $p -ErrorAction Stop).ProcessName}catch{}; $script:res+=[pscustomobject]@{title=$t;process=$pn;pid=$p} } }; return $true},[IntPtr]::Zero) | Out-Null;",
        "$res | ConvertTo-Json -Compress"
      ].join('\n');
      const out = await ctx.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 12000, system: true });
      let parsed = [];
      try { parsed = JSON.parse(String(out).trim() || '[]'); } catch (_) { parsed = []; }
      if (!Array.isArray(parsed)) parsed = [parsed];
      return { count: parsed.length, windows: parsed.filter((w) => w && w.title).slice(0, 40) };
    }
  });

  registry.register({
    name: 'apps_close',
    category: 'apps',
    risk: RISK.DESTRUCTIVE,
    description: 'Close a running application. Unsaved work may be lost, so confirmation is required.',
    parameters: {
      type: 'object',
      properties: { process: { type: 'string', description: 'Process name, e.g. notepad.' } },
      required: ['process']
    },
    confirm(args) {
      return {
        message: `This will terminate "${args.process}". Any unsaved work in that application will be lost.`,
        impact: 'Terminating a running application'
      };
    },
    async handler({ process }, ctx) {
      const name = String(process).replace(/\.exe$/i, '').trim();
      if (!/^[A-Za-z0-9_.\- ]+$/.test(name)) throw new ToolError('Invalid process name.', 'E_INPUT');
      const list = await ctx.si.processes().catch(() => []);
      const matches = list.filter((p) => String(p.name).toLowerCase() === name.toLowerCase());
      if (!matches.length) return { closed: [], count: 0, note: `No running process named "${name}".` };
      const script = `Get-Process -Name '${name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | ForEach-Object { $_.Kill(); $_.WaitForExit(3000) }; 'done'`;
      await ctx.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 12000, system: true });
      return { closed: matches.map((m) => ({ name: m.name, pid: m.pid })), count: matches.length };
    }
  });
};

module.exports.APPS = APPS;
