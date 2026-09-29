/**
 * Static checks that do not need Electron running.
 *
 * 1. Parse every source file as a module (catches syntax errors early).
 * 2. Check that every relative import in the renderer resolves to a real file.
 * 3. Check that every element id referenced by the renderer exists in index.html.
 * 4. Check that no source file reads an undeclared global (scope-aware).
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { analyze } = require('./scope-analyzer.js');

const root = process.argv[2] || '.';
const problems = [];
const warnings = [];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(path.join(root, 'src'));
/* -- 1. parse ---------------------------------------------------- */
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  if (src.charCodeAt(0) === 0xFEFF) {
    problems.push(`${path.relative(root, f)}: starts with a UTF-8 BOM`);
  }
  if (src.includes('â€') || src.includes('Ã©') || src.includes('Ã¼')) {
    problems.push(`${path.relative(root, f)}: contains mojibake`);
  }
  try {
    new vm.SourceTextModule(src, { identifier: f });
  } catch (err) {
    // Electron main/preload are CommonJS; try that before giving up.
    try {
      new vm.Script(src, { filename: f });
    } catch (err2) {
      problems.push(`${path.relative(root, f)}: ${err2.message}`);
    }
  }
}

/* -- 2. relative imports ----------------------------------------- */
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(f), m[1]);
    if (!fs.existsSync(target)) {
      problems.push(`${path.relative(root, f)}: import not found -> ${m[1]}`);
    }
  }
}

/* -- 3. renderer element ids ------------------------------------- */
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));

const rendererFiles = files.filter(f => f.includes(path.join('src', 'renderer')) && !f.includes('vendor'));
for (const f of rendererFiles) {
  const src = fs.readFileSync(f, 'utf8');
  // Ids the file injects into its own markup, e.g. host.innerHTML = `... id="x" ...`
  const selfIds = new Set([...src.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  for (const m of src.matchAll(/querySelector\(\s*['"]#([A-Za-z0-9_-]+)['"]/g)) {
    if (!htmlIds.has(m[1]) && !selfIds.has(m[1])) {
      problems.push(`${path.relative(root, f)}: #${m[1]} not in index.html and not created by this file`);
    }
  }
  // Selector-list forms like querySelector('#a, #b')
  for (const m of src.matchAll(/querySelectorAll\(\s*['"]([^'"]+)['"]/g)) {
    for (const id of m[1].matchAll(/#([A-Za-z0-9_-]+)/g)) {
      if (!htmlIds.has(id[1]) && !selfIds.has(id[1])) {
        problems.push(`${path.relative(root, f)}: #${id[1]} not in index.html and not created by this file`);
      }
    }
  }
}

/* -- 4. undeclared globals (scope aware) ------------------------- */
// The vendored three.js build is third-party; only our own code is checked.
const ownFiles = files.filter(f => !f.includes(path.join('src', 'renderer', 'vendor')));
let scopeReads = 0;
for (const f of ownFiles) {
  const src = fs.readFileSync(f, 'utf8');
  try {
    const found = analyze(src, path.relative(root, f));
    for (const r of found) {
      scopeReads++;
      problems.push(`${r.file}:${r.line}: undeclared global "${r.name}"`);
    }
  } catch (err) {
    problems.push(`${path.relative(root, f)}: scope analysis failed -> ${err.message}`);
  }
}

/* -- report ------------------------------------------------------ */
console.log(`parsed ${files.length} file(s)`);
console.log(`index.html defines ${htmlIds.size} id(s)`);
console.log(`scope analysis clean on ${ownFiles.length} own file(s), ${scopeReads} undeclared read(s)`);
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log('  - ' + w);
}
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('\nno problems found');
