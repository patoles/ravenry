// A '...' or "..." string that holds ${name} was meant to be a template: the
// person sees the literal text. Scans the board, the hub, the phone and the
// desktop sources and fails on any. Shell snippets (${VAR}, ${2}) are left alone.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dirs = ['hub/public', 'hub/server', 'apps/phone/src', 'apps/desktop/src', 'shared'];
const files = [];
const walk = (d) => {
  let names = [];
  try { names = readdirSync(d); } catch { return; }
  for (const n of names) {
    if (n === 'node_modules' || n === 'dist' || n.startsWith('.')) continue;
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(m?js|ts)$/.test(n) && !/\.min\.js$/.test(n)) files.push(p);
  }
};
for (const d of dirs) walk(join(root, d));

const bad = [];
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  let i = 0, line = 1, prev = '';
  const stack = [];
  const tplBody = () => {
    while (i < s.length) {
      const d = s[i];
      if (d === '\\') { i += 2; continue; }
      if (d === '\n') line++;
      if (d === '`') { stack.pop(); i++; return; }
      if (d === '$' && s[i + 1] === '{') { stack.push('{'); i += 2; return; }
      i++;
    }
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); line += (s.slice(i, e).match(/\n/g) || []).length; i = e + 2; continue; }
    if (c === "'" || c === '"') {
      const at = line; let j = i + 1, t = '';
      while (j < s.length && s[j] !== c && s[j] !== '\n') { if (s[j] === '\\') { t += s[j] + s[j + 1]; j += 2; continue; } t += s[j++]; }
      if (/\$\{[a-z_][\w.]*[(}]/.test(t)) bad.push(`${f.slice(root.length + 1)}:${at}: ${c}${t.slice(0, 100)}`);
      i = j + 1; prev = 'a'; continue;
    }
    if (c === '`') { stack.push('t'); i++; tplBody(); prev = 'a'; continue; }
    if (c === '{') { stack.push('b'); i++; prev = '{'; continue; }
    if (c === '}') { const top = stack.pop(); i++; if (top === '{') { tplBody(); prev = 'a'; } else prev = '}'; continue; }
    if (c === '/' && !/[\w$)\]]/.test(prev)) {
      let j = i + 1, cls = false;
      while (j < s.length && s[j] !== '\n') { if (s[j] === '\\') { j += 2; continue; } if (s[j] === '[') cls = true; else if (s[j] === ']') cls = false; else if (s[j] === '/' && !cls) break; j++; }
      i = j + 1; prev = 'a'; continue;
    }
    if (!/\s/.test(c)) {
      const m = /^(return|typeof|case|in|of|void|throw|new|delete)\b/.exec(s.slice(i, i + 8));
      if (m && !/[\w$]/.test(s[i - 1] || '')) { i += m[0].length; prev = ''; continue; }
      prev = /[\w$)\]]/.test(c) ? 'a' : c;
    }
    i++;
  }
}
if (bad.length) { console.log(`${bad.length} quoted string(s) hold \${...}; make them templates:\n${bad.join('\n')}`); process.exit(1); }
console.log(`quoted-template-test: ${files.length} files, none`);
