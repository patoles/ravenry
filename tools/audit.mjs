#!/usr/bin/env node
// The personal-data audit. This repository goes public at launch with its
// whole history, so no commit may ever carry personal data. CI runs this on
// every push and pull request, and so should you before a commit.
//
//   node tools/audit.mjs [<dir>] [--terms <file>] [--require-terms]
//
// What it reads: every file git would commit (tracked files plus untracked
// ones that are not ignored), or, outside a git checkout, every file under
// <dir> except .git, node_modules and .tmp. It fails (exit 1) on any hit,
// printed as file:line. It looks for:
// personal terms (one per line, a word or /regex/flags, # starts a comment),
// email addresses, phone numbers, dates of birth, IBAN and card numbers, API
// keys and tokens (Telegram, Slack, Discord, ntfy, OpenAI/Anthropic, GitHub,
// npm, AWS, Google, JWT), private keys, absolute home paths and Claude Code's
// slugs of them, long hex strings (keys, ids), real-looking UUIDs, and text
// in PNG metadata. An embedded PNG, JPEG, GIF or WebP data URI is always a
// hit (decoded and named for a look by eye); an SVG data URI is decoded and
// audited as text. It also runs tools/origins.mjs: no other product named
// as the model of what Ravenry does.
//
// The personal term list is never committed. It comes from, in order:
// 1. --terms <file>
// 2. the AUDIT_TERMS environment variable, one term per line (CI sets it
//    from the repository secret of the same name)
// 3. the AUDIT_TERMS_FILE environment variable, a path
// 4. ../ravenry/tools/private/audit-terms.txt beside this repository (the
//    maintainer's private folder), when it exists
// With none of them it audits the generic shapes only and says so.
// --require-terms makes a missing or empty term list a failure (CI uses it).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { origins } from './origins.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PRIVATE_TERMS = path.resolve(ROOT, '..', 'ravenry', 'tools', 'private', 'audit-terms.txt');

// ------------------------------------------------------------ the rules
// Allowed hits: each is one exact file and the SHA-256 of the exact text a
// rule matched there, with why, so this file holds neither the name nor the
// token it allows. Nothing else is ever let through.
// The rule table between the two "audit:" lines below is the only text this
// audit skips, and only in this file: it is the patterns themselves.
// audit: begin rule table
const NAME = '7c6e1bf16286b2bcb2790eee9d42a406f0de86615436d85baf86efa3b7d9eb20';
const OWNER = '5d246c0b6cd8060850866060c70bd0eb123768ca056fd500276dcac7b81a256e';
// The npm board 0.4.0's login label, detected so the app
// can switch from it: one constant in each file, never an id of the app's.
const NPM_LABEL = 'bb402da3886b17563fe4bfff8d4f5a26c37cc4b0121f08af37550a2414f451bf';
const ALLOWED = [
  { file: 'hub/server/npmswitch.mjs', sha256: NPM_LABEL, why: "the npm 0.4.0 board's login label, detected so the app can switch from it (LOGIN_LABELS)" },
  { file: 'apps/desktop/tools/npm-board-fixture.mjs', sha256: NPM_LABEL, why: "the npm 0.4.0 board's login label, which the switch test's npm board starts with (NPM_LOGIN_LABEL)" },
  { file: 'NOTICE', sha256: NAME, why: 'the copyright holder and trademark owner' },
  { file: 'TRADEMARK.md', sha256: NAME, why: 'the trademark owner' },
  { file: 'CLA.md', sha256: NAME, why: 'the project owner the agreement names' },
  { file: 'package.json', sha256: NAME, why: 'the package author' },
  { file: 'package.json', sha256: OWNER, why: 'the GitHub owner in repository' },
  { file: 'README.md', sha256: OWNER, why: 'the GitHub owner in the repository URL' },
  { file: 'packages/protocol/package.json', sha256: OWNER, why: 'the GitHub owner in repository' },
  { file: 'packages/protocol/package.json', sha256: NAME, why: 'the package author' },
  { file: '.github/workflows/cla.yml', sha256: OWNER, why: 'the GitHub owner in the CLA document URL' },
  { file: 'docs/PUBLISHING.md', sha256: OWNER, why: 'the public repository and page the testers download from' },
  { file: 'site/index.html', sha256: OWNER, why: "the GitHub owner in the launch page's download and issue links" },
  { file: 'hub/NOTICE', sha256: NAME, why: 'the copyright holder and trademark owner' },
  { file: 'hub/README.md', sha256: NAME, why: 'the author line and the trademark owner' },
  { file: 'hub/docs/PUBLISHING.md', sha256: NAME, why: 'the author, as decided for 0.1.0' },
  { file: 'hub/package.json', sha256: NAME, why: 'the npm author' },
  { file: 'hub/package.json', sha256: OWNER, why: 'the GitHub owner in repository, homepage and bugs' },
  { file: 'hub/README.md', sha256: OWNER, why: 'the GitHub owner: repo, screenshot URLs, the Agent Flow link, the author link' },
  { file: 'hub/docs/PUBLISHING.md', sha256: OWNER, why: 'the GitHub owner of the public repo' },
  { file: 'hub/README.md', sha256: '944d505d25fdffb4c35c0b92ed6d3f44002b1eecc2ee5c737ded82a9fbb87849', why: 'Antics, named in Why Ravenry? and the author line' },
  { file: 'hub/README.md', sha256: '36fce319303169bc1c218558c60a4442da8bb593fedbe2c8e18f6dc5d6a71e18', why: 'antics in the antics.gg link' },
  { file: 'hub/README.md', sha256: '884b09ca3c191228347b7445a53794e215563e2aa6a80f0ca98050c38ff04947', why: 'the antics.gg link' },
  { file: 'hub/tools/alerts-test.mjs', sha256: '07f2acdfa4eb9856ce2e436ca3e83f4e8d8975970ad8a9a304ed64b2f9e65fb7', why: 'a made-up bot token (a keyboard row) for the local Telegram stub' },
  { file: 'hub/tools/alerts-test.mjs', sha256: 'd51e3533335f313c09a8360aa228b4ec182ad4493438c191c387430119fc7fb5', why: 'a made-up wrong bot token for the local Telegram stub' },  { file: '.github/workflows/code.yml', sha256: 'bd466793be1df9176166915c2a8252449f71dd6fb6b7c748b66fd0d2c5eb4e60', why: 'the SHA-256 of the Zig 0.17.1 release tarball, from ziglang.org/download/index.json' },
  { file: '.github/workflows/desktop.yml', sha256: 'bd466793be1df9176166915c2a8252449f71dd6fb6b7c748b66fd0d2c5eb4e60', why: 'the SHA-256 of the Zig 0.17.1 release tarball for x86_64 Linux, from ziglang.org/download/index.json' },
  { file: '.github/workflows/release.yml', sha256: 'bd466793be1df9176166915c2a8252449f71dd6fb6b7c748b66fd0d2c5eb4e60', why: 'the SHA-256 of the Zig 0.17.1 release tarball for x86_64 Linux, from ziglang.org/download/index.json' },
  { file: '.github/workflows/android.yml', sha256: '4fa16058c4497c738aeceeba03f7297c0f695121dd8c18f7bafd4ece56bf3a21', why: 'the SHA-256 of the testers\' Android release key\'s certificate, which is public inside every signed APK' },
  { file: 'tools/publish-testers.mjs', sha256: '4fa16058c4497c738aeceeba03f7297c0f695121dd8c18f7bafd4ece56bf3a21', why: 'the SHA-256 of the testers\' Android release key\'s certificate, which is public inside every signed APK' },
  { file: '.github/workflows/release.yml', sha256: '52f2744c17405e14538da64eba088af99dd323085fa1efda963928444df360e5', why: 'the SHA-256 of the Zig 0.17.1 release tarball for aarch64 Linux, from ziglang.org/download/index.json' },
  { file: '.github/workflows/release.yml', sha256: 'c09cf4327d049fad910131bcf71e10038e6996b1ed48825909f2734084240a98', why: 'the SHA-256 of the Zig 0.17.1 release tarball for x86_64 macOS, from ziglang.org/download/index.json' },
  { file: '.github/workflows/release.yml', sha256: '415a1245e3d8a53a6ba70584e5fe62cb28eb18f158d905d332763799c5c3f8ef', why: 'the SHA-256 of the Zig 0.17.1 release tarball for aarch64 macOS, from ziglang.org/download/index.json' },
  { file: 'apps/desktop/scripts/local-identity.mjs', sha256: 'f09f5904afd2914d5b53de847ab7f9446ed04903a903264c07a87e4abfdb26f4', why: 'the SHA-1 of the maintainer\'s Apple Development certificate, which is public inside every app it signs' },
  { file: 'hub/tools/push-ntfy-e2e.mjs', sha256: 'ae853f363bb54466f466fa3f38e23d3ead890ea3e5d0fca829d44ddd28ace17b', why: 'the SHA-256 the ntfy-android v1.25.2 GitHub release lists for its F-Droid APK' },
  { file: 'hub/tools/push-ntfy-e2e.mjs', sha256: 'ec8608164ee70c779a381f593e666b0b0c2c8042e397aa4a9db14f34c0a38015', why: 'the SHA-256 of the certificate that signs the ntfy-android releases (apksigner)' },
  { file: 'hub/server/vendor/page-format.mjs', sha256: '77ae22ae1f20b65edb73b3fbbfac406010c0991c5bf5745754b42eeb37fd4483', why: "the yaml package's copyright line in its ISC licence, which every copy must carry" },
  { file: 'hub/tools/vendor-page-format.mjs', sha256: '77ae22ae1f20b65edb73b3fbbfac406010c0991c5bf5745754b42eeb37fd4483', why: "the yaml package's copyright line in its ISC licence, which the bundle it writes carries" },
  { file: 'package-lock.json', sha256: 'b0373516d594ddd199b25c3655332b354837e065c5cc232f5043189897900ca7', why: "the public address in glob 7's npm deprecation notice (glob comes with electron-builder's @electron/asar)" },
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
  // Ravenry owns no domain: every reverse-domain id is dev.ravenry (the app dev.ravenry.app, the services dev.ravenry.hub and dev.ravenry.board).
  ['a domain Ravenry does not own (ids are dev.ravenry.*)', /\bgg\\?\.ravenry\b|\bravenry\\?\.gg\b/gi],
  ['UUID', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (m) => !fakeUuid(m)],
];
// audit: end rule table
const SELF = 'tools/audit.mjs';
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

// ------------------------------------------------------------ the terms
// A plain term matches as a whole word, case-insensitive. A source escape
// such as \n right before it counts as a word boundary, so "\nname" in a
// string literal is caught.
function parseTerms(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^\/(.+)\/([a-z]*)$/);
    out.push([`personal term ${t}`, m ? new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g') : new RegExp(`(?:(?<![A-Za-z0-9])|(?<=\\\\[nrtfv]))${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'gi')]);
  }
  return out;
}

// Returns { terms, source }; terms is null when no list was found.
export function loadTerms(termsFile) {
  if (termsFile) {
    if (!fs.existsSync(termsFile)) return { terms: null, source: `--terms ${termsFile} (not found)` };
    return { terms: parseTerms(fs.readFileSync(termsFile, 'utf8')), source: termsFile };
  }
  if (process.env.AUDIT_TERMS && process.env.AUDIT_TERMS.trim()) return { terms: parseTerms(process.env.AUDIT_TERMS), source: 'the AUDIT_TERMS environment variable' };
  const envFile = process.env.AUDIT_TERMS_FILE;
  if (envFile && fs.existsSync(envFile)) return { terms: parseTerms(fs.readFileSync(envFile, 'utf8')), source: envFile };
  if (fs.existsSync(PRIVATE_TERMS)) return { terms: parseTerms(fs.readFileSync(PRIVATE_TERMS, 'utf8')), source: '../ravenry/tools/private/audit-terms.txt' };
  return { terms: null, source: null };
}

// ------------------------------------------------------------ the scan
const TEXT_EXT = /\.(m?js|cjs|json|md|html?|css|svg|txt|py|sh|ya?ml|plist|xml|go|mod|sum|kt|kts|gradle|toml|ts|tsx)$|(^|\/)(LICENSE|NOTICE|\.gitignore|\.npmignore)$/i;
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
    if (rel.endsWith('go.sum')) return; // module hashes, nothing personal
    // A GitHub Action pinned to its commit: `uses: owner/repo@<40 hex>`.
    const pin = rel.startsWith('.github/workflows/') && /^\s*-?\s*uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}(\s+#.*)?$/.test(line) ? line.match(/@([0-9a-f]{40})/)[1] : null;
    for (const [name, re, keep] of rules) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        const t = m[0];
        if (keep && !keep(t)) continue;
        if (pin && t === pin && name.startsWith('long hex')) continue;
        const al = ALLOWED.find((a) => rel === a.file && a.sha256 === sha(t));
        if (al) { hits.allowed.push(`${where}: ${name} (allowed: ${al.why})`); continue; }
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

// The text a TrueType or OpenType font carries: its name table (family,
// copyright, designer, URLs, licence), where a name or a path could hide.
// null when it is not a font this can read.
export function fontText(buf) {
  if (buf.length < 12) return null;
  const tag = buf.readUInt32BE(0);
  if (tag !== 0x00010000 && tag !== 0x4f54544f) return null; // TrueType, OTTO
  const n = buf.readUInt16BE(4);
  let name = null;
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    if (o + 16 > buf.length) return null;
    if (buf.toString('latin1', o, o + 4) === 'name') name = { off: buf.readUInt32BE(o + 8), len: buf.readUInt32BE(o + 12) };
  }
  if (!name || name.off + 6 > buf.length) return [];
  const t = buf.subarray(name.off, name.off + name.len);
  const count = t.readUInt16BE(2), strings = t.readUInt16BE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (r + 12 > t.length) break;
    const platform = t.readUInt16BE(r), len = t.readUInt16BE(r + 8), off = t.readUInt16BE(r + 10);
    const raw = t.subarray(strings + off, strings + off + len);
    if (platform === 0 || platform === 3) { const b = Buffer.from(raw); b.swap16(); out.push(b.toString('utf16le')); } else out.push(raw.toString('latin1'));
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
  return out;
}

// What git would commit: tracked files and untracked ones it does not ignore.
function listFiles(dir) {
  try {
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (fs.realpathSync(top) === fs.realpathSync(dir)) {
      const out = execFileSync('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      return [...new Set(out.split('\0').filter(Boolean))].filter((f) => fs.existsSync(path.join(dir, f)) && fs.lstatSync(path.join(dir, f)).isFile()).sort();
    }
  } catch { /* not a git checkout: walk it */ }
  return walk(dir).sort();
}

// The bytes of an MP4/QuickTime file outside its picture data: every top
// level box but mdat, as text. null when the boxes do not add up.
function videoText(buf) {
  let at = 0, out = '';
  while (at + 8 <= buf.length) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let head = 8;
    if (size === 1) { if (at + 16 > buf.length) return null; size = Number(buf.readBigUInt64BE(at + 8)); head = 16; }
    else if (size === 0) size = buf.length - at;
    if (size < head || at + size > buf.length || !/^[\x20-\x7e]{4}$/.test(type)) return null;
    if (type !== 'mdat') out += buf.toString('latin1', at + head, at + size) + '\n';
    at += size;
  }
  return at === buf.length ? out : null;
}

export function audit(dir, termsFile) {
  const { terms, source } = loadTerms(termsFile);
  const rules = [...(terms || []), ...SHAPES];
  const hits = { list: [], allowed: [], images: [], other: [] };
  const files = listFiles(dir);
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(dir, rel));
    if (IMG_EXT.test(rel)) {
      hits.images.push(rel);
      const chunks = pngText(buf);
      for (const t of chunks) scanText(rel, t, rules, hits, ' (PNG text chunk)');
      if (rel.endsWith('.png') && chunks.length) hits.list.push(`${rel}:0: PNG carries text chunks: ${chunks.map((t) => t.slice(0, 60)).join(' | ')}`);
      continue;
    }
    if (/\.(ttf|otf)$/i.test(rel)) {
      // A font: the text it carries is audited; a file that is not a font
      // this can read is a binary the audit cannot read.
      const names = fontText(buf);
      if (names === null) { hits.other.push(rel); continue; }
      for (const t of names) scanText(rel, t, rules, hits, ' (font name table)');
      continue;
    }
    if (/\.(mp4|m4v|mov)$/i.test(rel)) {
      // A video: its text (encoder and metadata tags, titles, paths) lives
      // in the boxes around the picture data; every run of 6 or more
      // printable characters there is audited. The picture data (mdat) is
      // not text. A file whose boxes do not add up cannot be read.
      const meta = videoText(buf);
      if (meta === null) { hits.other.push(rel); continue; }
      hits.images.push(rel);
      for (const m of meta.matchAll(/[\x20-\x7e]{6,}/g)) scanText(rel, m[0], rules, hits, ' (video metadata)');
      continue;
    }
    if (!TEXT_EXT.test(rel) && buf.includes(0)) { hits.other.push(rel); continue; }
    scanText(rel, buf.toString('utf8'), rules, hits);
  }
  const o = origins(dir);
  for (const h of o.hits) hits.list.push(`${h} (origins: say what Ravenry does, not which product it follows; tools/origins.mjs)`);
  return { files, terms: terms ? terms.length : 0, source, origins: o, ...hits };
}

function report(r, requireTerms) {
  for (const h of r.list) console.log('HIT  ' + h);
  for (const h of r.allowed) console.log('ALLOWED  ' + h);
  for (const f of r.other) console.log('HIT  ' + f + ':0: a binary file the audit cannot read');
  for (const s of r.origins.stale) console.log('NOTE  ' + s + ' (an origins allow line that matches nothing now: remove it)');
  let bad = r.list.length + r.other.length;
  console.log('');
  console.log(`audit: ${r.files.length} files, ${r.terms} personal terms (${r.terms ? 'from ' + r.source : 'NO TERM LIST: generic shapes only'}), ${SHAPES.length} shapes`);
  console.log(`audit: ${bad} hit(s), ${r.allowed.length} allowed, ${r.images.length} image file(s) checked for text chunks; origins: ${r.origins.hits.length} hit(s), ${r.origins.allowed} allowed`);
  if (requireTerms && !r.terms) {
    console.log('audit: the personal term list is missing or empty. In CI it comes from the repository secret AUDIT_TERMS (one term per line): add it under Settings > Secrets and variables > Actions.');
    bad++;
  }
  console.log(bad ? 'audit: FAILED' : 'audit: CLEAN');
  return bad;
}

// ------------------------------------------------------------ main
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const termsFile = opt('--terms') ? path.resolve(opt('--terms')) : null;
  const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--terms');
  process.exit(report(audit(path.resolve(dir || ROOT), termsFile), args.includes('--require-terms')) ? 1 : 0);
}
