'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Filesystem sandbox.
 *
 * Every file tool path is resolved and checked against the allowlist before
 * any syscall touches the disk. No allowlist entry may sit outside the user
 * profile unless the user explicitly added it, and every resolved path must
 * remain inside an allowed root after symlink + traversal resolution.
 */

const HOME = os.homedir();

class SandboxError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SandboxError';
    this.code = code || 'E_SANDBOX';
  }
}

function isInside(child, root) {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

class PathSandbox {
  constructor(extraRoots) {
    this.setRoots(extraRoots);
  }

  setRoots(extraRoots) {
    const roots = [HOME];
    if (Array.isArray(extraRoots)) {
      for (const r of extraRoots) {
        if (typeof r === 'string' && r.trim()) {
          try { roots.push(path.resolve(r.trim())); } catch (_) { /* skip */ }
        }
      }
    }
    this.roots = Array.from(new Set(roots));
    return this.roots;
  }

  describe() { return this.roots.slice(); }

  /**
   * @param {string} input user- or model-supplied path
   * @param {object} opts  { mustExist:boolean, allowRoot:boolean }
   * @returns {string} absolute, verified path
   */
  resolve(input, opts) {
    const options = opts || {};
    if (typeof input !== 'string' || !input.trim()) {
      throw new SandboxError('A path is required.', 'E_PATH_EMPTY');
    }
    const raw = input.trim();
    if (raw.indexOf('\0') !== -1) throw new SandboxError('Illegal path.', 'E_PATH_NUL');

    const expanded = this._expand(raw);
    const abs = path.resolve(expanded);

    if (options.allowRoot === false && (abs === HOME || /^[A-Za-z]:\\?$/.test(abs))) {
      throw new SandboxError('Operating on a filesystem root is not permitted.', 'E_PATH_ROOT');
    }

    if (!this.roots.some((root) => isInside(abs, root))) {
      throw new SandboxError(
        'Path is outside the allowed locations. Add it under Settings → Tools → File access if you need it.',
        'E_PATH_OUTSIDE'
      );
    }

    // Resolve symlinks on the deepest existing ancestor so we cannot escape via a link.
    let probe = abs;
    const tail = [];
    for (;;) {
      if (fs.existsSync(probe)) break;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      tail.unshift(path.basename(probe));
      probe = parent;
    }
    let real = probe;
    try { real = fs.realpathSync(probe); } catch (_) { /* keep lexical */ }
    const realAbs = tail.length ? path.join(real, ...tail) : real;

    if (!this.roots.some((root) => isInside(realAbs, root))) {
      throw new SandboxError('Path resolves outside the allowed locations.', 'E_PATH_SYMLINK');
    }
    if (!this.roots.some((root) => isInside(abs, root))) {
      throw new SandboxError('Path is outside the allowed locations.', 'E_PATH_OUTSIDE');
    }
    return abs;
  }

  _expand(p) {
    let out = p;
    if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
      out = path.join(HOME, out.slice(1));
    }
    if (/%USERPROFILE%/i.test(out)) out = out.replace(/%USERPROFILE%/gi, HOME);
    if (/%APPDATA%/i.test(out)) out = out.replace(/%APPDATA%/gi, process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'));
    if (/%TEMP%/i.test(out)) out = out.replace(/%TEMP%/gi, os.tmpdir());
    return out;
  }
}

module.exports = { PathSandbox, SandboxError, isInside, HOME };
