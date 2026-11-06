// Using a page's filters, sorts, groups, counts and numbers on items, so
// the hub, the desktop app and the phone all show the same thing. Items are
// plain objects of field values (see item.ts for folder items).

import type { FieldSpec, Filter, Condition, Scalar, SortKey, Stat } from './model.ts';
import { getField } from './text.ts';

export type Item = Record<string, unknown>;

const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

function asTime(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function same(a: unknown, b: Scalar): boolean {
  if (Array.isArray(a)) return a.some((x) => same(x, b));
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b;
  return a === b;
}

function compare(a: unknown, b: Scalar): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const ta = asTime(a), tb = asTime(b);
  if (ta !== null && tb !== null) return ta - tb;
  return null;
}

function holds(c: Condition, item: Item): boolean {
  switch (c.op) {
    case 'eq': return same(getField(item, c.field), c.value);
    case 'in': return c.values.some((x) => same(getField(item, c.field), x));
    case 'ne': return !c.values.some((x) => same(getField(item, c.field), x));
    case 'has': return !empty(getField(item, c.field));
    case 'not': return !matches(c.filter, item);
    case 'any': return c.filters.some((f) => matches(f, item));
    default: {
      const d = compare(getField(item, c.field), c.value);
      if (d === null) return false;
      return c.op === 'gt' ? d > 0 : c.op === 'gte' ? d >= 0 : c.op === 'lt' ? d < 0 : d <= 0;
    }
  }
}

export function matches(f: Filter | null, item: Item): boolean {
  return !f || f.all.every((c) => holds(c, item));
}

/** Sorts a copy. Dates go newest first and everything else A to Z or
 * smallest first; desc reverses. An enum sorts in the order of its values.
 * Items with no value go last. Ties keep their order. */
export function sortItems<T extends Item>(items: T[], keys: SortKey[], fields: Record<string, FieldSpec> | null = null): T[] {
  if (!keys.length) return [...items];
  const spec = (k: string) => (fields ? fields[k.split('.')[0]] : undefined);
  return items.map((it, i) => ({ it, i })).sort((A, B) => {
    for (const k of keys) {
      const a = getField(A.it, k.field), b = getField(B.it, k.field);
      if (empty(a) || empty(b)) { if (empty(a) !== empty(b)) return empty(a) ? 1 : -1; continue; }
      const s = spec(k.field);
      let d = 0;
      if (s?.type === 'enum' && s.values) d = s.values.indexOf(String(a)) - s.values.indexOf(String(b));
      else if (typeof a === 'number' && typeof b === 'number') d = a - b;
      else if (s?.type === 'date' || (asTime(a) !== null && asTime(b) !== null && /^\d{4}-\d{2}-\d{2}/.test(String(a)))) d = (asTime(b) ?? 0) - (asTime(a) ?? 0);
      else if (typeof a === 'boolean' && typeof b === 'boolean') d = Number(b) - Number(a);
      else d = String(a).localeCompare(String(b));
      if (d) return k.desc ? -d : d;
    }
    return A.i - B.i;
  }).map((x) => x.it);
}

export interface Group<T> { value: string | null; items: T[] }

/** Groups by a field. An enum gives one group per value, in order, even
 * empty ones (a board's lanes); other fields give a group per value seen.
 * Items with no value are in a last group with value null, when any. */
export function groupItems<T extends Item>(items: T[], field: string, spec: FieldSpec | null = null): Group<T>[] {
  const groups = new Map<string | null, T[]>();
  if (spec?.type === 'enum' && spec.values) for (const v of spec.values) groups.set(v, []);
  const rest: T[] = [];
  for (const it of items) {
    const v = getField(it, field);
    if (empty(v)) { rest.push(it); continue; }
    const k = String(v);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(it);
  }
  const out = [...groups.entries()].map(([value, list]) => ({ value, items: list }));
  if (rest.length) out.push({ value: null, items: rest });
  return out;
}

/** A nav or tab count: true counts every item. */
export function countItems(items: Item[], count: Filter | true | null): number | null {
  if (count === null) return null;
  return count === true ? items.length : items.filter((it) => matches(count, it)).length;
}

/** The number after a page's label in the sidebar, or null for none. */
export function navNumber(items: Item[], nav: { count: Filter | true | null; sum: string | null }): number | null {
  if (nav.sum) return items.reduce((n: number, it) => { const v = getField(it, nav.sum!); return n + (typeof v === 'number' ? v : 0); }, 0);
  return countItems(items, nav.count);
}

/** One number of a stats view. min and max of dates give a date. */
export function statValue(items: Item[], s: Stat): number | string | null {
  if (s.kind === 'count') return items.filter((it) => matches(s.where, it)).length;
  const vals = items.map((it) => getField(it, s.field)).filter((v) => !empty(v));
  if (s.kind === 'sum') return vals.reduce((n: number, v) => n + (typeof v === 'number' ? v : 0), 0);
  if (!vals.length) return null;
  if (vals.every((v) => typeof v === 'number')) return (s.kind === 'min' ? Math.min : Math.max)(...(vals as number[]));
  const times = vals.map((v) => ({ v, t: asTime(v) })).filter((x) => x.t !== null);
  if (!times.length) return null;
  times.sort((a, b) => a.t! - b.t!);
  return String((s.kind === 'min' ? times[0] : times[times.length - 1]).v);
}
