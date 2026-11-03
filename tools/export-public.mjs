#!/usr/bin/env node
// Builds the public snapshot of this repo into a target folder, then audits
// it, because the repo's own history and some of its files (design mockups
// with real board data, captured screens, screenshots) must never be public.
//
//   node tools/export-public.mjs <target> [--terms <file>] [--commit "<msg>"]
//   node tools/export-public.mjs --audit <dir> [--terms <file>]
//
// The snapshot is the tracked files (git ls-files) that match ALLOW and none
// of DENY, copied as they are. The audit then reads every file in the target
// and fails (exit 1) on any hit, printed as file:line. It looks for:
// personal terms (one per line in the terms file, a word or /regex/flags;
// the default is tools/private/audit-terms.txt, which never ships), email
// addresses, phone numbers, dates of birth, IBAN and card numbers, API keys
// and tokens (Telegram, Slack, Discord, ntfy, OpenAI/Anthropic, GitHub, npm,
// AWS, Google, JWT), private keys, absolute home paths and Claude Code's
// slugs of them, long hex strings (keys, ids), real-looking UUIDs, and text
// in PNG metadata. An embedded PNG, JPEG, GIF or WebP data URI is always a
// hit (decoded and named for a look by eye); an SVG data URI is decoded and
// audited as text.
//
// --commit runs `git init` and one commit in the target, only when the audit
// is clean. The target must not exist, or be empty.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ------------------------------------------------------------ what ships
// Globs: `**` any depth, `*` within one path part.
const ALLOW = [
  'bin/**', 'server/**', 'hooks/**', 'public/**',
  'tools/**',
  'brand/ravenry/**',
  'README.md', 'LICENSE', 'NOTICE', 'TRADEMARK.md', 'CHANGELOG.md', 'CONTRIBUTING.md',
  'package.json', 'package-lock.json', '.gitignore',
  'docs/DEVELOPING.md', 'docs/TERMINALS.md', 'docs/HANDOFF.md',
  'docs/STATE-RULES.md', 'docs/BRIEF-FORMAT.md', 'docs/BRIEF.example.md',
  'docs/SESSIONS.md', 'docs/PUBLISHING.md',
  'docs/screenshot.png', 'docs/screenshot-phone.png', // drawn from a made-up demo board (docs/PUBLISHING.md)
];
const DENY = [
  'docs/design/**',          // mockups drawn from real board data
  'docs/shots/**',           // screenshots of real boards
  'tools/fixtures/live/**',  // captured terminal screens of real sessions
  'tools/fixtures/repeats-seed.json', // real typed corrections
  'tools/private/**',        // the audit's personal term list, and anything else private
  'brand/candidates/**',     // the logo rounds: the design record, not needed to run
  'tools/phase-d-e2e.mjs',   // needs a real cmux and real Claude memory folders
  '.tmp/**', 'node_modules/**', '**/.inbox/**', '**/*.log',
];

const reGlob = (g) => new RegExp('^' + g.split('/').map((p) => (p === '**' ? '(?:.*)' : p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))).join('/').replace(/\(\?:\.\*\)\//g, '(?:.*/)?') + '$');
const ALLOW_RE = ALLOW.map(reGlob);
const DENY_RE = DENY.map(reGlob);
export const ships = (f) => ALLOW_RE.some((r) => r.test(f)) && !DENY_RE.some((r) => r.test(f));

// ------------------------------------------------------------ the audit
// Allowed hits: each is one exact file and the SHA-256 of the exact text a
// rule matched there, with why, so this file holds neither the name nor the
// token it allows. Nothing else is ever let through.
// The rule table between the two "audit:" lines below is the only text this
// audit skips, and only in this file: it is the patterns themselves.
// audit: begin rule table
const ALLOWED = [
  { file: 'LICENSE', sha256: '7c6e1bf16286b2bcb2790eee9d42a406f0de86615436d85baf86efa3b7d9eb20', why: 'the copyright holder (docs/PUBLISHING.md, Decided for 0.1.0)' },
  { file: 'NOTICE', sha256: '7c6e1bf16286b2bcb2790eee9d42a406f0de86615436d85baf86efa3b7d9eb20', why: 'the copyright holder and trademark owner' },
  { file: 'TRADEMARK.md', sha256: '7c6e1bf16286b2bcb2790eee9d42a406f0de86615436d85baf86efa3b7d9eb20', why: 'the trademark owner' },
  { file: 'README.md', sha256: '7c6e1bf16286b2bcb2790eee9d42a406f0de86615436d85baf86efa3b7d9eb20', why: 'the author line and the trademark owner' },
  { file: 'docs/PUBLISHING.md', sha256: '7c6e1bf16286b2bcb2790eee9d42a406f0de86615436d85baf86efa3b7d9eb20', why: 'the author, as decided for 0.1.0' },
  { file: 'package.json', sha256: '7c6e1bf16286b2bcb2790eee9d42a406f0de86615436d85baf86efa3b7d9eb20', why: 'the npm author' },
  { file: 'package.json', sha256: '5d246c0b6cd8060850866060c70bd0eb123768ca056fd500276dcac7b81a256e', why: 'the GitHub owner in repository, homepage and bugs' },
  { file: 'README.md', sha256: '5d246c0b6cd8060850866060c70bd0eb123768ca056fd500276dcac7b81a256e', why: 'the GitHub owner: repo, screenshot URLs, the Agent Flow link, the author link' },
  { file: 'docs/PUBLISHING.md', sha256: '5d246c0b6cd8060850866060c70bd0eb123768ca056fd500276dcac7b81a256e', why: 'the GitHub owner of the public repo' },
  { file: 'README.md', sha256: '944d505d25fdffb4c35c0b92ed6d3f44002b1eecc2ee5c737ded82a9fbb87849', why: 'Antics, named in Why Ravenry? and the author line' },
  { file: 'README.md', sha256: '36fce319303169bc1c218558c60a4442da8bb593fedbe2c8e18f6dc5d6a71e18', why: 'antics in the antics.gg link' },
  { file: 'README.md', sha256: '884b09ca3c191228347b7445a53794e215563e2aa6a80f0ca98050c38ff04947', why: 'the antics.gg link' },
  { file: 'tools/alerts-test.mjs', sha256: '07f2acdfa4eb9856ce2e436ca3e83f4e8d8975970ad8a9a304ed64b2f9e65fb7', why: 'a made-up bot token (a keyboard row) for the local Telegram stub' },
  { file: 'tools/alerts-test.mjs', sha256: 'd51e3533335f313c09a8360aa228b4ec182ad4493438c191c387430119fc7fb5', why: 'a made-up wrong bot token for the local Telegram stub' },
];

const SHAPES = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, (m) => !/@(example\.(com|org|net)|[a-z0-9.-]*\.(test|invalid|example|local))$/i.test(m) && !/@\d+\.\d+/.test(m) && !/@\d+x\.(png|jpe?g|webp|gif|svg)$/i.test(m)],
  ['phone number', /(?<![\w.:/-])\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}(?![\w.:/-])/g],
  ['phone number', /(?<![\w.:/-])0[1-9](?:[ .]\d{2}){4}(?![\w.:/-])/g],
  ['date of birth', /\b(date of birth|d\.?o\.?b\.?|birthday|born on|born in \d{4}|n[ée]e? le)\b/gi],
  ['IBAN', /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b/g, (m) => /\d{4}/.test(m.replace(/^[A-Z]{2}\d{2}/, '')) && m.replace(/ /g, '').length >= 15],
  ['account number', /\b(account (number|no\.?)|acct\.? ?(no|#)|routing number|sort code|BIC|SWIFT)\b/g],
  ['card number', /(?<![\w.-])\d{4}(?:[ -]?\d{4}){2,3}(?:[ -]?\d{1,3})?(?![\w.-])/g, (m) => luhn(m.replace(/\D/g, '')) && !/^(\d)\1+$/.test(m.replace(/\D/g, ''))],
  ['Telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g],
  ['Slack webhook', /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{12,}/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['Discord webhook', /discord(?:app)?\.com\/api\/webhooks\/\d{15,}\/[A-Za-z0-9_-]{30,}/g],
  ['ntfy topic', /ntfy\.sh\/(?!<)[A-Za-z0-9_-]{6,}/g, (m) => !/ntfy\.sh\/(ravenry-(stub|test|x\b|abcdef)|app\b|docs\b)/.test(m) && m !== 'ntfy.sh/ravenry-'],
  ['ntfy topic', /\bravenry-[A-Za-z0-9]{20}\b/g, (m) => !/stub|test|0000|abcdef|0123456789/.test(m)],
  ['API key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}/g],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Google key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['secret assignment', /\b(?:token|secret|password|passwd|api[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-+/=]{16,}['"]/gi, (m) => !/(stub|fake|test|example|leak|dummy|sample|x{6,}|0{6,})/i.test(m)],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['home path', /(?:\/Users|\/home)\/(?!(?:x|old|you|me|example|someone|Shared|runner)\b)[A-Za-z0-9._-]+/g],
  ['home path', /\b[A-Z]:\\Users\\[A-Za-z0-9._-]+/g],
  ['home path slug', /-Users-(?!(?:x|old|you|me|example|someone)-)[A-Za-z0-9._]+-/g],
  ['long hex (a key or id)', /\b[0-9a-f]{32,}\b/gi, (m) => !/^(.)\1+$/.test(m) && !/^(?:0123456789abcdef)+/i.test(m) && !/^89504e470d0a1a0a/i.test(m)], // a PNG written as hex is a picture, not a key
  ['UUID', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (m) => !fakeUuid(m)],
];
// audit: end rule table
const SELF = 'tools/export-public.mjs';
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function luhn(d) {
  if (d.length < 13 || d.length > 19) return false;
  let s = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    s += n;
  }
  return s % 10 === 0;
}
// A UUID a test made up: a run of one repeated hex digit or zeros in it.
function fakeUuid(u) {
  const g = u.toLowerCase().split('-');
  return g.some((x) => /^(.)\1+$/.test(x)) || /0000/.test(u) || /^([0-9a-f]{2})\1{3}/.test(g[0]);
}

function loadTerms(file) {
  if (!file || !fs.existsSync(file)) return null;
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^\/(.+)\/([a-z]*)$/);
    out.push([`personal term ${t}`, m ? new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g') : new RegExp(`(?<![A-Za-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'gi')]);
  }
  return out;
}

const TEXT_EXT = /\.(m?js|cjs|json|md|html?|css|svg|txt|py|sh|ya?ml|plist|xml)$|(^|\/)(LICENSE|\.gitignore|\.npmignore)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp|ico|icns)$/i;

function scanText(rel, text, rules, hits, base = '') {
  const lines = text.split('\n');
  let inTable = false;
  lines.forEach((line, i) => {
    const where = `${rel}:${i + 1}${base}`;
    if (rel === SELF && !base) {
      if (line.trim() === '// audit: begin rule table') inTable = true;
      if (line.trim() === '// audit: end rule table') inTable = false;
      if (inTable) return;
    }
    if (rel.endsWith('package-lock.json') && /"(integrity|resolved)":/.test(line)) return;
    for (const [name, re, keep] of rules) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        const t = m[0];
        if (keep && !keep(t)) continue;
        const al = ALLOWED.find((a) => rel === a.file && a.sha256 === sha(t));
        if (al) { hits.allowed.push(`${where}: ${name}: ${t} (allowed: ${al.why})`); continue; }
        hits.list.push(`${where}: ${name}: ${excerpt(line, m.index, t.length)}`);
      }
    }
    // Images embedded as data URIs.
    for (const m of line.matchAll(/data:image\/(png|jpe?g|gif|webp|svg\+xml)(;base64)?,([A-Za-z0-9+/=%._-]+)/g)) {
      const kind = m[1];
      let buf;
      try { buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])); } catch { buf = null; }
      if (kind === 'svg+xml') { if (buf) scanText(rel, buf.toString('utf8'), rules, hits, ` (in an SVG data URI at ${rel}:${i + 1})`); }
      else hits.list.push(`${where}: embedded ${kind} image, ${buf ? buf.length : '?'} bytes: look at it by eye`);
    }
  });
}

// Text chunks in a PNG (tEXt, zTXt, iTXt) can hold a path, a name or a comment.
function pngText(buf) {
  const out = [];
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return out;
  let o = 8;
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    try {
      if (type === 'tEXt') out.push(data.toString('latin1').replace('\0', ': '));
      if (type === 'zTXt') { const z = data.indexOf(0); out.push(data.toString('latin1', 0, z) + ': ' + zlib.inflateSync(data.subarray(z + 2)).toString('latin1')); }
      if (type === 'iTXt') { const z = data.indexOf(0); const comp = data[z + 1]; let p = z + 3; p = data.indexOf(0, p) + 1; p = data.indexOf(0, p) + 1; const body = data.subarray(p); out.push(data.toString('latin1', 0, z) + ': ' + (comp ? zlib.inflateSync(body) : body).toString('utf8')); }
    } catch { /* a broken chunk says nothing */ }
    if (type === 'IEND') break;
    o += 12 + len;
  }
  return out;
}

function excerpt(line, at, len) {
  const s = Math.max(0, at - 40), e = Math.min(line.length, at + len + 40);
  return (s ? '...' : '') + line.slice(s, e).trim() + (e < line.length ? '...' : '');
}

function walk(dir, rel = '') {
  const out = [];
  for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (d.name === '.git' || d.name === 'node_modules' || d.name === '.tmp') continue;
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...walk(dir, r)); else if (d.isFile()) out.push(r);
  }
  return out.sort();
}

export function audit(dir, termsFile) {
  const terms = loadTerms(termsFile);
  const rules = [...(terms || []), ...SHAPES];
  const hits = { list: [], allowed: [], images: [], other: [] };
  const files = walk(dir);
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(dir, rel));
    if (IMG_EXT.test(rel)) {
      hits.images.push(rel);
      for (const t of pngText(buf)) scanText(rel, t, rules, hits, ' (PNG text chunk)');
      if (rel.endsWith('.png') && pngText(buf).length) hits.list.push(`${rel}:0: PNG carries text chunks: ${pngText(buf).map((t) => t.slice(0, 60)).join(' | ')}`);
      continue;
    }
    if (!TEXT_EXT.test(rel) && buf.includes(0)) { hits.other.push(rel); continue; }
    scanText(rel, buf.toString('utf8'), rules, hits);
  }
  return { files, terms: terms ? terms.length : 0, termsFile, ...hits };
}

function report(r) {
  for (const h of r.list) console.log('HIT  ' + h);
  for (const h of r.allowed) console.log('ALLOWED  ' + h);
  if (r.other.length) for (const f of r.other) console.log('HIT  ' + f + ':0: a binary file the audit cannot read');
  const bad = r.list.length + r.other.length;
  console.log('');
  console.log(`audit: ${r.files.length} files, ${r.terms} personal terms (${r.terms ? r.termsFile : 'NO TERMS FILE: generic shapes only'}), ${SHAPES.length} shapes`);
  console.log(`audit: ${bad} hit(s), ${r.allowed.length} allowed, ${r.images.length} image file(s) checked for text chunks: ${r.images.join(', ')}`);
  console.log(bad ? 'audit: FAILED' : 'audit: CLEAN');
  return bad;
}

// ------------------------------------------------------------ main
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const termsFile = path.resolve(opt('--terms') || path.join(ROOT, 'tools', 'private', 'audit-terms.txt'));
  const auditDir = opt('--audit');
  if (auditDir) process.exit(report(audit(path.resolve(auditDir), termsFile)) ? 1 : 0);

  const target = args.find((a, i) => !a.startsWith('--') && !['--terms', '--commit', '--audit'].includes(args[i - 1]));
  if (!target) { console.error('usage: node tools/export-public.mjs <target> [--terms <file>] [--commit "<msg>"] | --audit <dir>'); process.exit(2); }
  const T = path.resolve(target);
  if (T === ROOT || T.startsWith(ROOT + path.sep)) { console.error('export: the target must be outside this repo'); process.exit(2); }
  if (fs.existsSync(T) && fs.readdirSync(T).length) { console.error(`export: ${T} is not empty; give a new folder`); process.exit(2); }

  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const take = tracked.filter(ships).filter((f) => fs.existsSync(path.join(ROOT, f)));
  const left = tracked.filter((f) => !take.includes(f));
  for (const f of take) {
    fs.mkdirSync(path.dirname(path.join(T, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(T, f));
    fs.chmodSync(path.join(T, f), fs.statSync(path.join(ROOT, f)).mode & 0o777);
  }
  const groups = {};
  for (const f of left) { const g = f.split('/').slice(0, f.startsWith('docs/') || f.startsWith('tools/') || f.startsWith('brand/') ? 2 : 1).join('/'); groups[g] = (groups[g] || 0) + 1; }
  console.log(`export: ${take.length} files to ${T}`);
  console.log(`export: left out ${left.length}: ${Object.entries(groups).map(([g, n]) => `${g} (${n})`).join(', ')}`);
  const r = audit(T, termsFile);
  const bad = report(r);
  if (bad) { console.log(`export: FAILED, nothing committed. Fix the hits in this repo and export again to a new folder (${T} is left for a look).`); process.exit(1); }
  if (!r.terms) console.log('export: WARNING: no personal term list was used');
  const msg = opt('--commit');
  if (msg) {
    execFileSync('git', ['init', '-q', '-b', 'main', T]);
    execFileSync('git', ['-C', T, 'add', '-A']);
    // The public commit carries the package's author name (the same as on the
    // LICENSE), not the local git identity's short name; the email stays git's.
    const pkgAuthor = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).author;
    const name = typeof pkgAuthor === 'string' ? pkgAuthor : pkgAuthor && pkgAuthor.name;
    const who = name ? { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name } : {};
    execFileSync('git', ['-C', T, 'commit', '-q', '-m', msg], { env: { ...process.env, ...who } });
    console.log('export: committed ' + execFileSync('git', ['-C', T, 'log', '--format=%h %an <%ae> %s', '-1'], { encoding: 'utf8' }).trim());
  }
}
