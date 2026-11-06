// {field} in a button's text. It is filled only from the item's own fields,
// and a value always goes in as data: it is never read as more template, a
// shell word or markup. {{ and }} write a brace.

import type { TextPart } from './model.ts';

const NAME = /^[a-z][a-z0-9_]{0,39}(\.[a-z][a-z0-9_]{0,39}){0,3}$/;

export interface Template {
  parts: TextPart[];
  /** Placeholders that are not a field name: {Title}, {}, an unclosed {. */
  bad: string[];
}

export function parseTemplate(s: string): Template {
  const parts: TextPart[] = [];
  const bad: string[] = [];
  let buf = '';
  const flush = () => { if (buf) { parts.push({ text: buf }); buf = ''; } };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{' && s[i + 1] === '{') { buf += '{'; i++; continue; }
    if (c === '}' && s[i + 1] === '}') { buf += '}'; i++; continue; }
    if (c === '{') {
      const end = s.indexOf('}', i + 1);
      if (end < 0) { bad.push(s.slice(i, i + 20)); buf += s.slice(i); break; }
      const name = s.slice(i + 1, end);
      if (NAME.test(name)) { flush(); parts.push({ field: name }); } else { bad.push(s.slice(i, end + 1)); buf += s.slice(i, end + 1); }
      i = end;
      continue;
    }
    buf += c;
  }
  flush();
  return { parts, bad };
}

/** Does this text hold something that looks like a placeholder? For text
 * that is shown as written (labels, titles), where {field} does nothing. */
export function looksLikePlaceholder(s: string): string | null {
  const m = s.match(/\{[a-z][a-z0-9_.]*\}/);
  return m && !s.includes('{{') ? m[0] : null;
}

export function templateFields(parts: TextPart[]): string[] {
  return parts.flatMap((p) => ('field' in p ? [p.field] : []));
}

/** A field's value as text: a list joined with commas, nothing for no value. */
export function valueText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(valueText).filter(Boolean).join(', ');
  if (typeof v === 'object') return '';
  return String(v);
}

/** Reads a field by name or dotted path. */
export function getField(item: Record<string, unknown>, path: string): unknown {
  let cur: unknown = item;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** The text with each {field} replaced by that item's value. */
export function fillText(parts: TextPart[], item: Record<string, unknown>): string {
  return parts.map((p) => ('field' in p ? valueText(getField(item, p.field)) : p.text)).join('');
}
