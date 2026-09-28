'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { RISK, ToolError } = require('./registry');

const MAX_READ_BYTES = 512 * 1024;
const MAX_LIST = 800;

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'AppData', '$Recycle.Bin', 'System Volume Information', '.cache', 'venv', '__pycache__']);

async function statSafe(p) { try { return await fsp.stat(p); } catch (_) { return null; } }

module.exports = function registerFileTools(registry) {
  registry.register({
    name: 'files_read',
    category: 'files',
    risk: RISK.READ,
    description: 'Read the contents of a text file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        maxBytes: { type: 'integer', minimum: 1, maximum: 200000, description: 'Bytes to read. Default 20000.' }
      },
      required: ['path']
    },
    async handler({ path: p, maxBytes }, ctx) {
      const abs = ctx.sandbox.resolve(p);
      const st = await statSafe(abs);
      if (!st) throw new ToolError(`"${p}" does not exist.`, 'E_NOT_FOUND');
      if (st.isDirectory()) throw new ToolError(`"${p}" is a directory. Use files_list.`, 'E_IS_DIR');
      const limit = Math.min(maxBytes || 20000, MAX_READ_BYTES);
      const fh = await fsp.open(abs, 'r');
      try {
        const size = Math.min(st.size, limit);
        const buf = Buffer.alloc(size);
        await fh.read(buf, 0, size, 0);
        return {
          path: abs, sizeBytes: st.size, truncated: st.size > size, encoding: 'utf8',
          content: buf.toString('utf8')
        };
      } finally { await fh.close(); }
    }
  });

  registry.register({
    name: 'files_list',
    category: 'files',
    risk: RISK.READ,
    description: 'List the contents of a directory.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean', description: 'Walk subdirectories. Default false.' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Max entries. Default 200.' }
      },
      required: ['path']
    },
    async handler({ path: p, recursive, limit }, ctx) {
      const abs = ctx.sandbox.resolve(p);
      const st = await statSafe(abs);
      if (!st) throw new ToolError(`"${p}" does not exist.`, 'E_NOT_FOUND');
      if (!st.isDirectory()) return { path: abs, isFile: true, entries: [await describe(abs, st)] };

      const cap = Math.min(limit || 200, MAX_LIST);
      const entries = [];
      const walk = async (dir, depth) => {
        if (entries.length >= cap || (recursive && depth > 6)) return;
        let items;
        try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const it of items) {
          if (entries.length >= cap) return;
          if (SKIP_DIRS.has(it.name)) continue;
          const full = path.join(dir, it.name);
          if (it.isDirectory()) {
            entries.push({ name: it.name, path: full, type: 'dir' });
            if (recursive) await walk(full, depth + 1);
          } else if (it.isFile()) {
            const s = await statSafe(full);
            entries.push({ name: it.name, path: full, type: 'file', sizeBytes: s ? s.size : null, modified: s ? s.mtime.toISOString() : null });
          }
        }
      };
      await walk(abs, 0);
      return { path: abs, isFile: false, count: entries.length, truncated: entries.length >= cap, entries };
    }
  });

  registry.register({
    name: 'files_write',
    category: 'files',
    risk: RISK.WRITE,
    description: 'Create a new text file, or overwrite an existing one with confirmation.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        append: { type: 'boolean', description: 'Append instead of overwrite. Default false.' }
      },
      required: ['path', 'content']
    },
    confirm(args, ctx) {
      const abs = ctx.sandbox.resolve(args.path);
      if (args.append) return null;
      let exists = false; let size = 0;
      try { const s = fs.statSync(abs); exists = true; size = s.size; } catch (_) { /* new file */ }
      if (!exists) return null;
      return {
        message: `This will overwrite the existing file "${path.basename(abs)}" (${size} bytes). Existing content will be lost.`,
        impact: `Overwriting ${abs}`
      };
    },
    async handler({ path: p, content, append }, ctx) {
      const abs = ctx.sandbox.resolve(p);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const existed = fs.existsSync(abs);
      if (append) await fsp.appendFile(abs, String(content), 'utf8');
      else await fsp.writeFile(abs, String(content), 'utf8');
      const st = await statSafe(abs);
      return { path: abs, created: !existed, overwritten: existed, sizeBytes: st ? st.size : null, verified: fs.existsSync(abs) };
    }
  });

  registry.register({
    name: 'files_append',
    category: 'files',
    risk: RISK.WRITE,
    description: 'Append text to an existing file, creating it if needed.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    async handler(args, ctx) { return registry.get('files_write').handler({ path: args.path, content: args.content, append: true }, ctx); }
  });

  registry.register({
    name: 'files_search',
    category: 'files',
    risk: RISK.READ,
    description: 'Search a directory tree for files matching a name pattern or containing a text string.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to search. Default: home.' },
        namePattern: { type: 'string', description: 'Wildcard pattern on the file name, e.g. *.log' },
        content: { type: 'string', description: 'Text to search for inside files.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 100.' }
      },
      required: ['path']
    },
    async handler({ path: p, namePattern, content, maxResults }, ctx) {
      const abs = ctx.sandbox.resolve(p);
      const cap = Math.min(maxResults || 100, 500);
      const re = namePattern ? new RegExp('^' + namePattern.split('*').map(escapeRe).join('.*') + '$', 'i') : null;
      const needle = content ? String(content).toLowerCase() : null;
      const results = [];
      let scanned = 0;

      const walk = async (dir, depth) => {
        if (results.length >= cap || depth > 8) return;
        let items;
        try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const it of items) {
          if (results.length >= cap) return;
          if (it.name.startsWith('.') && it.name !== '.env') continue;
          if (SKIP_DIRS.has(it.name)) continue;
          const full = path.join(dir, it.name);
          if (it.isDirectory()) { await walk(full, depth + 1); continue; }
          if (!it.isFile()) continue;
          scanned++;
          if (re && !re.test(it.name)) continue;
          let line = null;
          if (needle) {
            const st = await statSafe(full);
            if (!st || st.size > 4 * 1024 * 1024) continue;
            try {
              const text = (await fsp.readFile(full, 'utf8')).toLowerCase();
              const idx = text.indexOf(needle);
              if (idx === -1) continue;
              const start = Math.max(0, text.lastIndexOf('\n', idx) + 1);
              const end = text.indexOf('\n', idx);
              line = text.slice(start, end === -1 ? start + 200 : end).trim().slice(0, 240);
            } catch (_) { continue; }
          }
          const st = await statSafe(full);
          results.push({ path: full, name: it.name, sizeBytes: st ? st.size : null, modified: st ? st.mtime.toISOString() : null, match: line });
        }
      };

      await walk(abs, 0);
      return { root: abs, scannedFiles: scanned, count: results.length, truncated: results.length >= cap, results };
    }
  });

  registry.register({
    name: 'files_organize',
    category: 'files',
    risk: RISK.WRITE,
    description: 'Group files in a folder by extension into subfolders. Requires confirmation.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        dryRun: { type: 'boolean', description: 'Report what would move without moving anything. Default true.' }
      },
      required: ['path']
    },
    confirm(args) {
      return {
        message: `This will move files in "${args.path}" into per-type subfolders. Files will be relocated, not deleted.`,
        impact: 'Relocating files inside a folder'
      };
    },
    async handler({ path: p, dryRun }, ctx) {
      const abs = ctx.sandbox.resolve(p);
      const st = await statSafe(abs);
      if (!st || !st.isDirectory()) throw new ToolError(`"${p}" is not a directory.`, 'E_NOT_DIR');
      const items = (await fsp.readdir(abs, { withFileTypes: true })).filter((i) => i.isFile());
      const plan = [];
      for (const it of items) {
        const ext = (path.extname(it.name).replace('.', '') || 'no-extension').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'no-extension';
        const from = path.join(abs, it.name);
        const to = path.join(abs, ext, it.name);
        plan.push({ from, to, extension: ext });
      }
      if (dryRun === false) {
        for (const mv of plan) {
          await fsp.mkdir(path.dirname(mv.to), { recursive: true });
          try { await fsp.rename(mv.from, mv.to); } catch (_) { /* cross-device or locked */ }
        }
      }
      return { root: abs, dryRun: dryRun !== false, moved: dryRun === false ? plan.length : 0, plan };
    }
  });

  registry.register({
    name: 'files_delete',
    category: 'files',
    risk: RISK.DESTRUCTIVE,
    description: 'Permanently delete a file or folder. Always requires explicit confirmation.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    },
    async confirm(args, ctx) {
      const abs = ctx.sandbox.resolve(args.path);
      const st = await statSafe(abs);
      if (!st) return { message: `"${args.path}" no longer exists.`, impact: 'No-op' };
      if (st.isDirectory()) {
        const n = await countFiles(abs);
        return {
          message: `This will permanently delete the folder "${path.basename(abs)}" and ${n} file${n === 1 ? '' : 's'} inside it. This cannot be undone.`,
          impact: `Recursive delete of ${abs}`,
          destructive: true,
          count: n
        };
      }
      return {
        message: `This will permanently delete "${path.basename(abs)}" (${st.size} bytes). This cannot be undone.`,
        impact: `Permanent delete of ${abs}`,
        destructive: true
      };
    },
    async handler({ path: p }, ctx) {
      const abs = ctx.sandbox.resolve(p);
      const st = await statSafe(abs);
      if (!st) return { deleted: false, reason: 'not_found', path: abs };
      await fsp.rm(abs, { recursive: st.isDirectory(), force: true });
      return { deleted: true, path: abs, stillExists: fs.existsSync(abs), verified: !fs.existsSync(abs) };
    }
  });
};

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function countFiles(dir, depth) {
  const d = depth || 0;
  if (d > 10) return 0;
  let items;
  try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return 0; }
  let n = 0;
  for (const it of items) {
    if (it.isDirectory()) n += await countFiles(path.join(dir, it.name), d + 1);
    else n++;
  }
  return n;
}

async function describe(full, st) {
  return { name: path.basename(full), path: full, type: 'file', sizeBytes: st.size, modified: st.mtime.toISOString() };
}
