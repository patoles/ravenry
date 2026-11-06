// Item files: one markdown file per item, its fields in YAML frontmatter
// and its text in the body (the shape of SKILL.md). The app writes to them
// only field by field: a patch changes the lines of the fields it names and
// leaves every other byte as it was, and it is made against the hash the
// screen was drawn from, so a change made meanwhile (by an agent, an editor,
// a pull) is never overwritten. Pure functions: the host reads the file,
// calls these, then writes to a temp file and renames.

import { isMap, isPair, isScalar, parseDocument } from 'yaml';
import type { FieldSpec } from './model.ts';
import type { Item } from './eval.ts';
import { sha256 } from './sha256.ts';
import { parseYaml } from './yaml.ts';
import type { Problem } from './yaml.ts';
import { valueProblem } from './check.ts';

export interface ItemFile {
  /** The frontmatter's fields, as written. */
  fields: Record<string, unknown>;
  body: string;
  /** The SHA-256 of the whole text: what a patch is made against. */
  hash: string;
  /** The 1-based line the body starts on. */
  bodyLine: number;
  hasFrontmatter: boolean;
  /** The frontmatter could not be read (fields is then empty). */
  problems: Problem[];
}

interface Split { fm: string | null; fmStart: number; fmEnd: number; bodyStart: number; bodyLine: number; unclosed: boolean }

function split(text: string): Split {
  const bom = text.startsWith('﻿') ? 1 : 0;
  const open = text.slice(bom).match(/^---[ \t]*\r?\n/);
  if (!open) return { fm: null, fmStart: 0, fmEnd: 0, bodyStart: 0, bodyLine: 1, unclosed: false };
  const fmStart = bom + open[0].length;
  const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
  close.lastIndex = fmStart;
  let m: RegExpExecArray | null;
  while ((m = close.exec(text))) {
    if (m.index >= fmStart && (m.index === fmStart || text[m.index - 1] === '\n')) break;
  }
  if (!m) return { fm: null, fmStart, fmEnd: text.length, bodyStart: 0, bodyLine: 1, unclosed: true };
  const fmEnd = m.index;
  const bodyStart = m.index + m[0].length;
  const bodyLine = text.slice(0, bodyStart).split('\n').length;
  return { fm: text.slice(fmStart, fmEnd), fmStart, fmEnd, bodyStart, bodyLine, unclosed: false };
}

export function parseItem(text: string): ItemFile {
  const hash = sha256(text);
  const s = split(text);
  if (s.unclosed) {
    return { fields: {}, body: text, hash, bodyLine: 1, hasFrontmatter: false, problems: [{ severity: 'error', code: 'frontmatter-unclosed', message: 'The frontmatter starts with --- on line 1 but has no closing --- line.', path: [], line: 1, column: 1 }] };
  }
  if (s.fm === null) return { fields: {}, body: text, hash, bodyLine: 1, hasFrontmatter: false, problems: [] };
  const body = text.slice(s.bodyStart);
  if (!s.fm.trim()) return { fields: {}, body, hash, bodyLine: s.bodyLine, hasFrontmatter: true, problems: [] };
  const y = parseYaml(s.fm, { what: 'The frontmatter', lineOffset: 1 });
  if (y.value === undefined) return { fields: {}, body, hash, bodyLine: s.bodyLine, hasFrontmatter: true, problems: y.problems };
  if (typeof y.value !== 'object' || y.value === null || Array.isArray(y.value)) {
    return { fields: {}, body, hash, bodyLine: s.bodyLine, hasFrontmatter: true, problems: [{ severity: 'error', code: 'not-mapping', message: 'The frontmatter must be key: value lines.', path: [], line: 2, column: 1 }] };
  }
  return { fields: y.value as Record<string, unknown>, body, hash, bodyLine: s.bodyLine, hasFrontmatter: true, problems: [] };
}

/** The first # heading of a markdown text, without the #. */
export function firstHeading(md: string): string | null {
  let fenced = false;
  for (const l of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(l)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = l.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) return m[1].trim();
  }
  return null;
}

export interface ReadItem {
  item: Item;
  hash: string;
  /** Unreadable frontmatter (an error), and values that don't fit their field (warnings). */
  problems: Problem[];
}

/** An item as a page sees it: its frontmatter fields plus title, body,
 * file, created and modified. `file` is its path inside the folder. */
export function readItem(text: string, at: { file: string; created?: string; modified?: string; fields?: Record<string, FieldSpec> }): ReadItem {
  const f = parseItem(text);
  const stem = at.file.split('/').pop()!.replace(/\.md$/i, '');
  const title = typeof f.fields.title === 'string' && f.fields.title.trim() ? f.fields.title : firstHeading(f.body) ?? stem;
  const item: Item = { ...f.fields, title, body: f.body, file: at.file };
  if (at.created) item.created = at.created;
  if (at.modified) item.modified = at.modified;
  const problems = [...f.problems];
  if (at.fields) {
    for (const [k, spec] of Object.entries(at.fields)) {
      if (spec.builtin || f.fields[k] === undefined || f.fields[k] === null) continue;
      const want = valueProblem(spec, f.fields[k]);
      if (want) problems.push({ severity: 'warning', code: 'item-value', message: `${k} should be ${want}.`, path: [k], line: 2, column: 1 });
    }
  }
  return { item, hash: f.hash, problems };
}

// ------------------------------------------------------------ writing

const YAML11_WORDS = /^(y|n|yes|no|on|off|true|false|null|~)$/i;

/** One value as YAML on one line: plain when that reads back the same, else quoted. */
export function yamlValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map(yamlValue).join(', ')}]`;
  const s = String(v);
  // A date stays plain, as people write it.
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s) && !s.includes(' ')) return s;
  const plain = /^[A-Za-z0-9_./(][^\n]*$/.test(s) && !/[:#]\s|\s#|[:#]$|^\s|\s$|[[\]{},"'`|>&*!%@]/.test(s)
    && !YAML11_WORDS.test(s) && !/^[-+]?(\d|\.\d|0x|0o|\.inf|\.nan)/i.test(s);
  return plain ? s : JSON.stringify(s);
}

export type Patch = Record<string, unknown>;

export type PatchResult =
  | { ok: true; text: string; hash: string; rebased: boolean }
  | { ok: false; conflict: { field: string; base: unknown; current: unknown; wanted: unknown }[]; hash: string }
  | { ok: false; problems: Problem[]; hash: string };

const eq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Applies a field patch (a value of null or undefined removes the field)
 * to an item file. `base` is what the screen was drawn from: its hash and,
 * when known, the values it showed. When the file changed since, the patch
 * is made again on the new text if none of its fields changed; otherwise
 * it is a conflict, and nothing is written. */
export function patchItem(text: string, patch: Patch, base: { hash: string; fields?: Record<string, unknown> }): PatchResult {
  const cur = parseItem(text);
  if (cur.problems.length) return { ok: false, problems: cur.problems, hash: cur.hash };
  let rebased = false;
  if (cur.hash !== base.hash) {
    const changed = Object.keys(patch).filter((k) => !base.fields || !eq(cur.fields[k], base.fields[k]));
    if (changed.length) return { ok: false, conflict: changed.map((k) => ({ field: k, base: base.fields?.[k], current: cur.fields[k], wanted: patch[k] })), hash: cur.hash };
    rebased = true;
  }
  const out = applyPatch(text, patch);
  return { ok: true, text: out, hash: sha256(out), rebased };
}

function applyPatch(text: string, patch: Patch): string {
  const s = split(text);
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const line = (k: string, v: unknown) => `${k}: ${yamlValue(v)}`;
  if (s.fm === null) {
    const adds = Object.entries(patch).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => line(k, v) + nl).join('');
    return adds ? `---${nl}${adds}---${nl}${text}` : text;
  }
  const doc = parseDocument(s.fm, { version: '1.2', schema: 'core' });
  const pairs = isMap(doc.contents) ? doc.contents.items.filter(isPair) : [];
  // Edits as [start, end, replacement] in frontmatter offsets, applied from the end.
  const edits: [number, number, string][] = [];
  const adds: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const pair = pairs.find((p) => isScalar(p.key) && String(p.key.value) === k);
    if (!pair) { if (v !== null && v !== undefined) adds.push(line(k, v) + nl); continue; }
    const keyNode = pair.key as { range: [number, number, number] };
    const valNode = pair.value as { range?: [number, number, number] } | null;
    const colon = s.fm.indexOf(':', keyNode.range[1]);
    let valueEnd = valNode?.range ? valNode.range[1] : colon + 1;
    // A block value's range takes in the line break after it; that stays.
    while (valueEnd > colon + 1 && /\s/.test(s.fm[valueEnd - 1])) valueEnd--;
    if (v === null || v === undefined) {
      const start = s.fm.lastIndexOf('\n', keyNode.range[0] - 1) + 1;
      let end = s.fm.indexOf('\n', Math.max(valueEnd - 1, colon));
      end = end < 0 ? s.fm.length : end + 1;
      edits.push([start, end, '']);
    } else {
      edits.push([colon + 1, valueEnd, ' ' + yamlValue(v)]);
    }
  }
  let fm = s.fm;
  for (const [a, b, r] of edits.sort((x, y) => y[0] - x[0])) fm = fm.slice(0, a) + r + fm.slice(b);
  if (adds.length) fm = (fm === '' || fm.endsWith('\n') ? fm : fm + nl) + adds.join('');
  return text.slice(0, s.fmStart) + fm + text.slice(s.fmEnd);
}

/** A new item file: the given fields in order (title first), then the body. */
export function makeItem(fields: Record<string, unknown>, body = '', order: string[] = []): string {
  const keys = [...new Set(['title', ...order, ...Object.keys(fields)])].filter((k) => fields[k] !== undefined && fields[k] !== null && fields[k] !== '');
  const fm = keys.map((k) => `${k}: ${yamlValue(fields[k])}\n`).join('');
  return `---\n${fm}---\n${body}${body && !body.endsWith('\n') ? '\n' : ''}`;
}

/** A file name for a new item: its title in lower case words, at most 60
 * characters, with -2, -3 when the name is taken. */
export function fileNameFor(title: string, taken: Iterable<string> = []): string {
  const have = new Set([...taken].map((x) => x.toLowerCase()));
  const stem = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'item';
  let name = `${stem}.md`;
  for (let n = 2; have.has(name); n++) name = `${stem}-${n}.md`;
  return name;
}

/** Where archive moves an item inside its folder, and where undo brings it back from. */
export function archivePath(file: string): string {
  return `.archive/${file}`;
}

// ------------------------------------------------------------ checkboxes

const BOX = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s+)(.*)$/;
const FENCE = /^\s*(```|~~~)/;

export interface Box { line: number; text: string; done: boolean; indent: number }

/** The checkboxes of an item file's body, with their 1-based lines in the
 * whole file. Boxes inside fenced code are not boxes. */
export function checklist(text: string): Box[] {
  const s = split(text);
  const start = s.fm === null ? 0 : s.bodyLine - 1;
  const lines = text.split('\n');
  const out: Box[] = [];
  let fenced = false;
  for (let i = start; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, '');
    if (FENCE.test(l)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = l.match(BOX);
    if (m) out.push({ line: i + 1, text: m[4].trim(), done: m[2] !== ' ', indent: m[1].length - m[1].trimStart().length });
  }
  return out;
}

export type ToggleResult =
  | { ok: true; text: string; hash: string; line: number; done: boolean; moved: boolean }
  | { ok: false; reason: 'changed'; boxes: Box[]; hash: string };

/** Ticks or unticks one box. The box is the one on `line` if that line
 * still says `text`; else the only box anywhere that says it (moved). If
 * there is no such box, or more than one, nothing changes. `done` sets the
 * state; left out, the box flips. */
export function toggle(fileText: string, box: { line: number; text: string; done?: boolean }): ToggleResult {
  const boxes = checklist(fileText);
  const want = box.text.trim();
  let target = boxes.find((b) => b.line === box.line && b.text === want);
  let moved = false;
  if (!target) {
    const same = boxes.filter((b) => b.text === want);
    if (same.length !== 1) return { ok: false, reason: 'changed', boxes, hash: sha256(fileText) };
    target = same[0];
    moved = true;
  }
  const done = box.done ?? !target.done;
  const lines = fileText.split('\n');
  const raw = lines[target.line - 1];
  const cr = raw.endsWith('\r') ? '\r' : '';
  lines[target.line - 1] = raw.slice(0, raw.length - cr.length).replace(BOX, (_m, a: string, _x: string, b: string, rest: string) => `${a}${done ? 'x' : ' '}${b}${rest}`) + cr;
  const text = lines.join('\n');
  return { ok: true, text, hash: sha256(text), line: target.line, done, moved };
}

/** Boxes ticked and in all, as a files source counts them. */
export function boxCounts(text: string): { done: number; total: number } {
  const b = checklist(text);
  return { done: b.filter((x) => x.done).length, total: b.length };
}
