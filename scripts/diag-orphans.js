const fs = require('fs');
const path = require('path');

const ROOT = 'C:/Users/roven/Desktop/sonolink-mobile';
const SRC = path.join(ROOT, 'src');

// Gather all .ts/.tsx files
const files = [];
(function walk(dir) {
  fs.readdirSync(dir).forEach(f => {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.mjs')) files.push(p);
  });
})(SRC);

// Build import set from a root entry
const used = new Set();
function resolveImport(fromFile, importPath) {
  const fromDir = path.dirname(fromFile);
  // If importPath starts without './' or '../' (bare specifier), skip
  if (!importPath.startsWith('./') && !importPath.startsWith('../')) {
    // Could be absolute path from project root like 'src/theme'
    // Resolve relative to project root
    const rootResolved = path.normalize(path.join(ROOT, importPath));
    if (fs.existsSync(rootResolved)) return rootResolved;
    if (fs.existsSync(rootResolved + '.ts')) return rootResolved + '.ts';
    if (fs.existsSync(rootResolved + '.tsx')) return rootResolved + '.tsx';
    return null;
  }
  const dir = path.dirname(fromFile);
  const resolved = path.normalize(path.join(dir, importPath));
  if (fs.existsSync(resolved)) return resolved;
  if (fs.existsSync(resolved + '.ts')) return resolved + '.ts';
  if (fs.existsSync(resolved + '.tsx')) return resolved + '.tsx';
  return null;
}

function markFile(file) {
  if (used.has(file)) return;
  used.add(file);
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  // Match: import ... from '...' and export ... from '...'
  const re = /(?:import|export)\s+(?:.*\s+)?from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content))) {
    const imp = m[1];
    if (imp.startsWith('./') || imp.startsWith('../') || !imp.startsWith('node_modules/') && !imp.startsWith('@')) {
      const resolved = resolveImport(file, imp);
      if (resolved) markFile(resolved);
    }
  }
  // Also match require() for CommonJS contexts
  const re2 = /require\(['"]([^'"]+)['"]\)/g;
  while ((m = re2.exec(content))) {
    const imp = m[1];
    if (imp.startsWith('./') || imp.startsWith('../') || !imp.startsWith('node_modules/') && !imp.startsWith('@')) {
      const resolved = resolveImport(file, imp);
      if (resolved) markFile(resolved);
    }
  }
}

function markFile(file) {
  if (used.has(file)) return;
  used.add(file);
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  // Match: import ... from '...' and export ... from '...'
  const re = /(?:import|export)\s+(?:.*\s+)?from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content))) {
    const imp = m[1];
    if (imp.startsWith('./') || imp.startsWith('../') || !imp.startsWith('node_modules/') && !imp.startsWith('@')) {
      const resolved = resolveImport(file, imp);
      if (resolved) markFile(resolved);
    }
  }
  // Also match require() for CommonJS contexts
  const re2 = /require\(['"]([^'"]+)['"]\)/g;
  while ((m = re2.exec(content))) {
    const imp = m[1];
    if (imp.startsWith('./') || imp.startsWith('../') || !imp.startsWith('node_modules/') && !imp.startsWith('@')) {
      const resolved = resolveImport(file, imp);
      if (resolved) markFile(resolved);
    }
  }
}

// Build import set from a root entry
const used = new Set();

// Mark from App.tsx and package.json main
const appFile = path.join(SRC, 'App.tsx');
if (fs.existsSync(appFile)) markFile(appFile);

// Also mark any file referenced by metro/babel if present — but skip node_modules
const metro = path.join(ROOT, 'metro.config.js');
if (fs.existsSync(metro)) {
  const content = fs.readFileSync(metro, 'utf8');
  const re = /require\(['"]([^'"]+)['"]\)/g;
  let m;
  while ((m = re.exec(content))) {
    if (m[1].startsWith('.')) {
      const resolved = resolveImport(metro, m[1]);
      if (resolved) markFile(resolved);
    }
  }
}

// Also scan for any file that has <script> tag pointing to js files
function scanHtmlForJs(rootDir) {
  function walk(dir) {
    fs.readdirSync(dir).forEach(f => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (f.endsWith('.html')) {
        const content = fs.readFileSync(p, 'utf8');
        const re = /src\s*=\s*['"]([^'"]+)['"]/g;
        let m;
        while ((m = re.exec(content))) {
          const imp = m[1];
          if (imp.startsWith('./') || imp.startsWith('../')) {
            const resolved = resolveImport(p, imp);
            if (resolved) markFile(resolved);
          }
        }
      }
    });
  }
  walk(rootDir);
}

// Scan android assets
const androidAssets = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets');
if (fs.existsSync(androidAssets)) {
  scanHtmlForJs(androidAssets);
}

// Also mark the drita subfolder if it has entry points
const dritaDir = path.join(SRC, 'services', 'drita');
if (fs.existsSync(dritaDir)) {
  fs.readdirSync(dritaDir).forEach(f => {
    const p = path.join(dritaDir, f);
    if (fs.statSync(p).isFile() && (f.endsWith('.ts') || f.endsWith('.tsx'))) {
      markFile(p);
    }
  });
}

const orphanFiles = files.filter(f => !used.has(f) && !f.endsWith('App.tsx'));
console.log('=== ORPHAN FILES ===');
orphanFiles.forEach(f => console.log(f.replace(ROOT + '/', '')));
console.log('=== TOTAL ORPHANS:', orphanFiles.length, '===')

// Also list all files for context
console.log('=== ALL SRC FILES ===');
files.forEach(f => {
  const rel = f.replace(ROOT + '/', '');
  const u = used.has(f) ? 'USED' : 'ORPHAN';
  console.log(u + ': ' + rel);
});