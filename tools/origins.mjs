#!/usr/bin/env node
// The origins check: Ravenry's sources say what Ravenry does and why, never
// which other product it follows. "as Ghostty does", "Rex's header",
// "Ghostty-style", "taken from cmux" are not allowed; the integrations
// Ravenry has (it follows sessions in cmux, iTerm2, Rex and other
// terminals), the theme files it imports, the protocols it implements (the
// Kitty keyboard protocol) and the libraries it ships with their licences
// are named for what they are. tools/audit.mjs runs it, so `audit: CLEAN`
// needs it too.
//
//   node tools/origins.mjs [<dir>]
//
// Two kinds of pattern, each matched on one line, for the products below:
// - always:   "as <P> does/has/draws/...", "<P>-style/-like/-format",
//             "copied/borrowed/taken/ported from <P>", "inspired by <P>".
//             Never integration wording, so they are checked in every file.
// - mentions: "as/like (in) <P>", "<P>'s <thing>". Integration code and
//             its docs say these all the time ("cmux's socket", "as in
//             iTerm2"), so the files listed as integration in
//             tools/origins-allow.txt skip them; anywhere else each one
//             needs its own line there.
// tools/origins-allow.txt: `<file> | <the matched text, exactly> | why`
// allows one phrase in one file; `<file or dir/> | * | why` marks a file
// (or every file under a folder) as integration code, skipping the
// mentions patterns there (never the always ones).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ALLOW_FILE = 'tools/origins-allow.txt';
// Third-party code shipped as it is: never Ravenry's words.
const SKIP = /^(?:apps\/macos\/vendor\/|daemon\/\.deps\/|hub\/server\/vendor\/)|(?:^|\/)node_modules\/|^tools\/origins(?:\.mjs|-allow\.txt)$/;
const TEXT = /\.(m?js|cjs|ts|tsx|json|md|html?|css|svg|txt|py|sh|zsh|bash|fish|ya?ml|plist|xml|go|swift|kt|kts|gradle|toml|patch|metal|c|h|zig)$|(^|\/)(LICENSE|NOTICE|README|CHANGELOG|Makefile)$/i;

// Names that are only ever products match in any case; names that are
// also plain words (a wave, warp speed) match only capitalised.
const ANY = '(?:[Rr]ex|REX|cmux|[Ii][Tt]erm2?|[Gg]hostty|[Kk]itty|[Ww]ez[Tt]erm|[Aa]lacritty|tmux|[Zz]ellij)';
const CAP = '(?:Warp|Wave|Tabby|Hyper|Conductor)';
const P = `(?:${ANY}|${CAP})`;
const APOS = "(?:'|’)s";
const ALWAYS = [
  ['as <P> does', new RegExp(`\\b(?:as|the way|just as|like)\\s+(?:the\\s+)?${P}(?:\\s+(?:and|or)\\s+${P})?\\s+(?:does|did|do|has|had|have|draws|drew|computes|computed|sends|sent|debounces|keeps|shows|puts|uses|handles|renders|bundles them)\\b`, 'g')],
  ['<P>-style', new RegExp(`\\b${P}-(?:style|like|ish|esque|inspired|format)\\b`, 'g')],
  ['taken from <P>', new RegExp(`\\b(?:copied|borrowed|taken|ported|lifted|cribbed|adapted)\\s+from\\s+(?:the\\s+)?${P}\\b|\\b(?:inspired|modell?ed)\\s+(?:by|on|after)\\s+(?:the\\s+)?${P}\\b`, 'g')],
];
const MENTIONS = [
  ['as <P>', new RegExp(`\\b(?:as|like|beside|than|after)\\s+(?:in\\s+|on\\s+|with\\s+)?(?:the\\s+)?${P}\\b(?!-)`, 'g')],
  ["<P>'s <thing>", new RegExp(`\\b${P}${APOS}\\s+\\S+`, 'g')],
];

export function readAllow(dir = ROOT) {
  const p = path.join(dir, ALLOW_FILE);
  const files = [], phrases = [];
  if (!fs.existsSync(p)) return { files, phrases };
  fs.readFileSync(p, 'utf8').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split(' | ');
    if (parts.length < 3 || !parts[2].trim()) throw new Error(`${ALLOW_FILE}:${i + 1}: want "<file> | <text or *> | why"`);
    const [file, text] = parts;
    if (text === '*') files.push({ file, line: i + 1, used: 0 });
    else phrases.push({ file, text, line: i + 1, used: 0 });
  });
  return { files, phrases };
}

function listFiles(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return [...new Set(out.split('\0').filter(Boolean))].filter((f) => fs.existsSync(path.join(dir, f)) && fs.lstatSync(path.join(dir, f)).isFile()).sort();
  } catch { return []; }
}

// { hits: ["file:line: kind: excerpt"], allowed: n, stale: ["allow line"] }
export function origins(dir = ROOT) {
  const allow = readAllow(dir);
  const hits = [];
  let allowed = 0;
  for (const rel of listFiles(dir)) {
    if (SKIP.test(rel) || !TEXT.test(rel)) continue;
    const buf = fs.readFileSync(path.join(dir, rel));
    if (buf.includes(0)) continue;
    const integ = allow.files.find((a) => (a.file.endsWith('/') ? rel.startsWith(a.file) : rel === a.file));
    if (integ) integ.used++;
    buf.toString('utf8').split('\n').forEach((line, i) => {
      for (const [kind, re, mention] of [...ALWAYS.map((r) => [...r, false]), ...MENTIONS.map((r) => [...r, true])]) {
        if (mention && integ) continue;
        re.lastIndex = 0;
        for (const m of line.matchAll(re)) {
          const ok = allow.phrases.find((a) => a.file === rel && m[0] === a.text);
          if (ok) { ok.used++; allowed++; continue; }
          hits.push(`${rel}:${i + 1}: ${kind}: ${m[0]}`);
        }
      }
    });
  }
  const stale = [...allow.files, ...allow.phrases].filter((a) => !a.used).map((a) => `${ALLOW_FILE}:${a.line}: ${a.file} | ${a.text || '*'}`);
  return { hits, allowed, stale };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] || ROOT);
  const r = origins(dir);
  for (const h of r.hits) console.log('HIT  ' + h);
  for (const s of r.stale) console.log('STALE  ' + s + ' (matches nothing now: remove it)');
  console.log(`origins: ${r.hits.length} hit(s), ${r.allowed} allowed phrase(s), ${r.stale.length} stale allow line(s)`);
  console.log(r.hits.length ? 'origins: FAILED (say what Ravenry does, not which product it follows; an integration mention goes in tools/origins-allow.txt)' : 'origins: CLEAN');
  process.exit(r.hits.length ? 1 : 0);
}
