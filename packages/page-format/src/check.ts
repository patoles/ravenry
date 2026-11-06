// Checking a page file: read the YAML, check the version, check it against
// the JSON Schema, then check what a schema cannot (that every field a page
// names exists, that set only uses declared values, that {field} only fills
// a button's text from its own item), and turn it into the typed model.
//
// Errors mean the file cannot be used: the app keeps the last version that
// worked. Warnings never stop a page: unknown keys are ignored, and views,
// actions and providers this Ravenry does not know are replaced by their
// fallback or a placeholder.

import schemaJson from '../schema/page-1.json' with { type: 'json' };
import {
  CORE_VIEWS, ICONS, ITEM_VIEWS, ACTION_KINDS, RAVENRY_ACTION_NAMES, RAVENRY_VIEW_NAMES, PROVIDER_IDS,
  capitalise, filesFields, folderBuiltins, providerFields,
} from './builtins.ts';
import { Validator } from './jsonschema.ts';
import type { ObjectNote, Schema, SchemaError } from './jsonschema.ts';
import type {
  Action, Column, Condition, CoreView, FieldSpec, FieldType, Filter, ItemSpec, Nav, OpenTarget, Page, Progress,
  Scalar, Section, SortKey, Source, Stat, Tab, TextPart,
} from './model.ts';
import { FORMAT_VERSION } from './model.ts';
import { closest } from './suggest.ts';
import { looksLikePlaceholder, parseTemplate, templateFields } from './text.ts';
import { parseYaml } from './yaml.ts';
import type { ParsedYaml, Path, Problem, Pos } from './yaml.ts';

export const PAGE_SCHEMA = schemaJson as unknown as Schema;
const validator = new Validator(PAGE_SCHEMA);

export interface CheckOptions {
  /** The file's name, such as playtest.page.yaml: its id must match. */
  fileName?: string;
  /** The plugins this Ravenry has, besides ravenry: built-ins. Left out, any
   * <plugin>:<name> is taken to exist (a checker that cannot know). */
  plugins?: {
    views?: string[];
    actions?: string[];
    providers?: string[];
    /** A plugin provider's fields, so references to them are checked. */
    providerFields?: Record<string, Record<string, FieldSpec>>;
  };
  /** This Ravenry's version, for requires. */
  ravenryVersion?: string;
}

export interface CheckResult {
  /** No errors. */
  ok: boolean;
  /** The typed model, when ok. */
  page: Page | null;
  /** Errors then warnings, each by line. */
  problems: Problem[];
  errors: Problem[];
  warnings: Problem[];
  /** The Ravenry version the page asks for, when this one is older. */
  needs: string | null;
}

// ------------------------------------------------------------ words

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const an = (w: string) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const low = (s: string) => (/^(The|Section|Tab|Field|Entry)\b/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** a, b or c */
export function orList(xs: string[]): string {
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;
}
/** a, b and c */
export function andList(xs: string[]): string {
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

const TYPE_WORDS: Record<string, string> = {
  string: 'text', number: 'a number', integer: 'a whole number', boolean: 'true or false', array: 'a list', object: 'a mapping (key: value lines)', null: 'nothing',
};

function at(data: unknown, path: Path): unknown {
  let cur = data;
  for (const seg of path) {
    if (Array.isArray(cur) && typeof seg === 'number') cur = cur[seg];
    else if (isObj(cur) && typeof seg === 'string') cur = cur[seg];
    else return undefined;
  }
  return cur;
}

/** What a path is, in words: "the page", "section 2", 'the "Fixed" button'. */
export function describe(path: Path, data: unknown, withView = true): string {
  if (path.length === 0) return 'The page';
  const last = path[path.length - 1];
  const parent = path[path.length - 2];
  if (typeof last === 'number' && parent === 'sections') {
    const tabAt = path.length >= 4 && path[path.length - 4] === 'tabs' ? path[path.length - 3] : null;
    const view = at(data, [...path, 'view']);
    let s = `Section ${last + 1}`;
    if (tabAt !== null) {
      const label = at(data, ['tabs', tabAt as number, 'label']);
      s += typeof label === 'string' ? ` of tab "${label}"` : ` of tab ${(tabAt as number) + 1}`;
    }
    if (typeof view === 'string' && withView) s += ` (${view})`;
    return s;
  }
  if (typeof last === 'number' && parent === 'tabs') {
    const label = at(data, [...path, 'label']);
    return typeof label === 'string' ? `Tab "${label}"` : `Tab ${last + 1}`;
  }
  if (typeof last === 'number' && parent === 'actions') {
    const label = at(data, [...path, 'label']);
    return typeof label === 'string' ? `The "${label}" button` : `Button ${last + 1}`;
  }
  if (last === 'fallback' && isObj(at(data, path)) && 'label' in (at(data, path) as object)) return `The fallback of ${low(describe(path.slice(0, -1), data))}`;
  if (last === 'fallback') return `The fallback of ${low(describe(path.slice(0, -1), data))}`;
  if (parent === 'fields' && typeof last === 'string') return `Field ${last}`;
  if (last === 'item') return `The item of ${low(describe(path.slice(0, -1), data))}`;
  if (typeof last === 'number') return `Entry ${last + 1} of ${typeof parent === 'string' ? parent : 'the list'}`;
  return String(last);
}

/** The schema's enum values, through $refs and alternatives, for "Did you mean". */
function enumValues(s: Schema, seen = new Set<Schema>()): string[] {
  if (seen.has(s)) return [];
  seen.add(s);
  const out: string[] = [];
  if (Array.isArray(s.enum)) out.push(...(s.enum as unknown[]).filter((x): x is string => typeof x === 'string'));
  if (typeof s.const === 'string') out.push(s.const);
  if (typeof s.$ref === 'string') out.push(...enumValues(validator.resolve(s), seen));
  for (const k of ['anyOf', 'oneOf']) if (Array.isArray(s[k])) for (const b of s[k] as Schema[]) out.push(...enumValues(b, seen));
  return out;
}

function expected(s: Schema): string {
  const t = validator.titleOf(s);
  if (t) return t;
  const r = typeof s.$ref === 'string' ? validator.resolve(s) : s;
  if (Array.isArray(r.enum)) return `one of ${orList((r.enum as unknown[]).map(String))}`;
  if (r.const !== undefined) return JSON.stringify(r.const);
  if (r.type) return orList((Array.isArray(r.type) ? r.type : [r.type]).map((x) => TYPE_WORDS[x as string] ?? String(x)));
  return 'something else';
}

// ------------------------------------------------------------ checking

class Ctx {
  problems: Problem[] = [];
  readonly y: ParsedYaml;
  readonly data: Record<string, unknown>;
  readonly opts: CheckOptions;
  constructor(y: ParsedYaml, data: Record<string, unknown>, opts: CheckOptions) { this.y = y; this.data = data; this.opts = opts; }

  add(severity: 'error' | 'warning', code: string, message: string, path: Path, where: 'key' | 'value' = 'value', suggestion?: string | null) {
    const pos: Pos = this.y.locate(path, where);
    this.problems.push({
      severity, code, message, path, line: pos.line, column: pos.column,
      ...(suggestion ? { hint: `Did you mean ${suggestion}?`, suggestion } : {}),
    });
  }
  error(code: string, message: string, path: Path, where: 'key' | 'value' = 'value', suggestion?: string | null) { this.add('error', code, message, path, where, suggestion); }
  warn(code: string, message: string, path: Path, where: 'key' | 'value' = 'key', suggestion?: string | null) { this.add('warning', code, message, path, where, suggestion); }
  get errorCount() { return this.problems.filter((p) => p.severity === 'error').length; }
}

function schemaProblem(c: Ctx, e: SchemaError) {
  const d = c.data;
  const name = e.path.length && typeof e.path[e.path.length - 1] === 'string' ? String(e.path[e.path.length - 1]) : describe(e.path, d);
  const value = at(d, e.path);
  switch (e.kind) {
    case 'required': {
      const k = e.keys![0];
      c.error('required', `${describe(e.path, d)} needs ${an(k)} ${k} line.`, e.path, 'key');
      return;
    }
    case 'one-of': {
      const what = e.path.length === 0 ? 'The page' : describe(e.path, d);
      c.error('one-of', `${what} needs ${e.keys!.length === 2 ? e.keys!.join(' or ') : `one of ${orList(e.keys!)}`}.`, e.path, 'key');
      return;
    }
    case 'both': {
      const what = e.path.length === 0 ? 'The page' : describe(e.path, d);
      if (e.keys && e.keys.length > 1) c.error('both', `${what} has both ${andList(e.keys)}. Use one.`, [...e.path, e.keys[1]], 'key');
      else c.error('both', `${what} matches more than one form. Write it one way.`, e.path, 'key');
      return;
    }
    case 'property-name': {
      const k = e.keys![0];
      const fixed = k.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
      const pat = validator.resolve(e.schema).pattern;
      const ok = typeof pat === 'string' && new RegExp(pat, 'u').test(fixed) ? fixed : null;
      c.error('property-name', `'${k}' is not ${expected(e.schema)}.`, e.path, 'key', ok !== k ? ok : null);
      return;
    }
    default: {
      const want = expected(e.schema);
      let sugg = typeof value === 'string' ? closest(value, enumValues(e.schema)) : null;
      // A name in the wrong case or with spaces: the same name written right.
      const pat = validator.resolve(e.schema).pattern;
      if (!sugg && typeof value === 'string' && typeof pat === 'string') {
        const re = new RegExp(pat, 'u');
        const low = value.trim().toLowerCase();
        sugg = [low, low.replace(/[\s_]+/g, '-'), low.replace(/[\s-]+/g, '_')].find((x) => x !== value && re.test(x)) ?? null;
      }
      const code = e.kind === 'invalid' || e.kind === 'enum' || e.kind === 'const' || e.kind === 'pattern' || e.kind === 'length' || e.kind === 'range' || e.kind === 'min-items' || e.kind === 'min-properties' ? 'invalid' : 'type';
      c.error(code, `${name} must be ${want}.`, e.path, 'value', sugg);
    }
  }
}

function unknownKeys(c: Ctx, notes: ObjectNote[], skip: Set<string>) {
  const by = new Map<string, { path: Path; known: Set<string>; record: boolean; map: boolean }>();
  for (const n of notes) {
    const k = JSON.stringify(n.path);
    const cur = by.get(k);
    if (!cur) by.set(k, { path: n.path, known: new Set(n.known), record: n.record, map: n.map });
    else { for (const x of n.known) cur.known.add(x); cur.record ||= n.record; cur.map ||= n.map; }
  }
  for (const [k, n] of by) {
    if (!n.record || n.map || skip.has(k)) continue;
    const obj = at(c.data, n.path);
    if (!isObj(obj)) continue;
    for (const key of Object.keys(obj)) {
      if (n.known.has(key) || key.startsWith('x-')) continue;
      c.warn('unknown-key', `Unknown key '${key}' in ${low(describe(n.path, c.data))}. It is ignored.`, [...n.path, key], 'key', closest(key, n.known));
    }
  }
}

/** Checks a page file's text. */
export function checkPage(text: string, opts: CheckOptions = {}): CheckResult {
  const y = parseYaml(text, { what: 'The page file' });
  const done = (problems: Problem[], page: Page | null = null, needs: string | null = null): CheckResult => {
    const errors = problems.filter((p) => p.severity === 'error').sort((a, b) => a.line - b.line || a.column - b.column);
    const warnings = problems.filter((p) => p.severity === 'warning').sort((a, b) => a.line - b.line || a.column - b.column);
    return { ok: errors.length === 0, page: errors.length ? null : page, problems: [...errors, ...warnings], errors, warnings, needs };
  };
  if (y.value === undefined) return done(y.problems);
  if (!isObj(y.value)) {
    const pos = y.locate([]);
    return done([{ severity: 'error', code: 'not-mapping', message: 'A page file is a mapping of keys such as version, id and title.', path: [], line: pos.line, column: pos.column }]);
  }
  const c = new Ctx(y, y.value, opts);
  const v = c.data.version;
  if (v === undefined) {
    c.error('version-missing', 'The page needs version: 1 as its first line.', [], 'key');
    return done(c.problems);
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    c.error('version-invalid', 'version must be the number 1.', ['version']);
    return done(c.problems);
  }
  if (v > FORMAT_VERSION) {
    c.error('version-future', `This page is written for page format version ${v}, and this Ravenry reads version ${FORMAT_VERSION}. Update Ravenry to show it.`, ['version']);
    return done(c.problems);
  }

  // A section whose view this Ravenry does not know is checked as its
  // string fallback, so a fallback: board still needs its group_by.
  const r = validator.validate(c.data);
  const extra = sectionPaths(c.data).flatMap((p) => {
    const s = at(c.data, p);
    if (!isObj(s) || typeof s.fallback !== 'string' || typeof s.view !== 'string' || (CORE_VIEWS as readonly string[]).includes(s.view)) return [];
    const copy = { ...s, view: s.fallback };
    delete (copy as Record<string, unknown>).fallback;
    const rr = validator.validate(copy, { $ref: '#/$defs/section' });
    return [{ errors: rr.errors.map((e) => ({ ...e, path: [...p, ...e.path] })), notes: rr.notes.map((n) => ({ ...n, path: [...p, ...n.path] })) }];
  });
  const errors = [...r.errors, ...extra.flatMap((x) => x.errors)];
  const notes = [...r.notes, ...extra.flatMap((x) => x.notes)];
  // One error per place: the first.
  const seen = new Set<string>();
  for (const e of errors) {
    const k = JSON.stringify(e.path) + e.kind + (e.keys ?? []).join();
    if (seen.has(k)) continue;
    seen.add(k);
    schemaProblem(c, e);
  }
  const skip = new Set<string>();
  // A section with no view: its other keys can't be known yet.
  for (const p of sectionPaths(c.data)) { const s = at(c.data, p); if (isObj(s) && typeof s.view !== 'string') skip.add(JSON.stringify(p)); }
  semantic(c, skip, c.errorCount === 0);
  unknownKeys(c, notes, skip);
  if (c.errorCount) return done(c.problems);

  const page = normalize(c);
  let needs: string | null = null;
  if (page.requires && opts.ravenryVersion) {
    const want = page.requires.replace(/^>=\s?/, '');
    if (compareVersions(opts.ravenryVersion, want) < 0) needs = want;
  }
  return done(c.problems, page, needs);
}

/** -1, 0 or 1. Missing parts count as 0; a pre-release tag is ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[-+]/)[0].split('.').map((x) => Number(x) || 0);
  const pb = b.replace(/^v/, '').split(/[-+]/)[0].split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function sectionPaths(data: Record<string, unknown>): Path[] {
  const out: Path[] = [];
  const walk = (list: unknown, base: Path) => {
    if (!Array.isArray(list)) return;
    list.forEach((s, i) => {
      out.push([...base, i]);
      if (isObj(s) && isObj(s.fallback)) out.push([...base, i, 'fallback']);
    });
  };
  walk(data.sections, ['sections']);
  if (Array.isArray(data.tabs)) data.tabs.forEach((t, i) => { if (isObj(t)) walk(t.sections, ['tabs', i, 'sections']); });
  return out;
}

// ------------------------------------------------------------ fields

export const FIELD_TYPES = ['string', 'number', 'date', 'bool', 'enum', 'list', 'image'];

function specOfField(name: string, f: Record<string, unknown>): FieldSpec {
  // A type from a newer Ravenry is read as text, and never written.
  const known = FIELD_TYPES.includes(f.type as string);
  const spec: FieldSpec = {
    name, type: known ? f.type as FieldType : 'string', label: typeof f.label === 'string' ? f.label : capitalise(name),
    required: f.required === true, builtin: false, writable: known,
  };
  if (Array.isArray(f.values)) spec.values = f.values.map(String);
  if (f.default !== undefined) spec.default = f.default;
  return spec;
}

const RESERVED = new Set(['body', 'file', 'created', 'modified', 'has', 'not', 'any']);

/** Is this value right for a field of this type? null when it is, else what it should be. */
export function valueProblem(spec: FieldSpec, v: unknown): string | null {
  switch (spec.type) {
    case 'enum': return typeof v === 'string' && spec.values!.includes(v) ? null : `one of ${orList(spec.values!)}`;
    case 'bool': return typeof v === 'boolean' ? null : 'true or false';
    case 'number': return typeof v === 'number' ? null : 'a number';
    case 'date': return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) ? null : 'a date such as 2026-11-06';
    case 'list': return Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number') ? null : 'a list of short texts';
    case 'string': case 'image': return typeof v === 'string' ? null : 'text';
    default: return null;
  }
}

function unsafePath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p) || p.split('/').some((s) => s === '..') || p.includes('\\');
}

interface Scope {
  /** The fields an item of this source has; null when they cannot be known. */
  fields: Record<string, FieldSpec> | null;
  kind: 'folder' | 'files' | 'provider' | 'none';
  /** A path to the source, for messages. */
  path: Path;
}

function sourceScope(c: Ctx, src: unknown, path: Path): Scope {
  if (!isObj(src)) return { fields: null, kind: 'none', path };
  if (typeof src.folder === 'string') {
    const fields: Record<string, FieldSpec> = { ...folderBuiltins() };
    if (isObj(src.fields)) for (const [k, f] of Object.entries(src.fields)) if (isObj(f) && typeof f.type === 'string') fields[k] = { ...specOfField(k, f), ...(k === 'title' ? { builtin: true } : {}) };
    return { fields, kind: 'folder', path };
  }
  if (typeof src.files === 'string') return { fields: filesFields(), kind: 'files', path };
  if (typeof src.provider === 'string') {
    const id = src.provider;
    if (id.includes(':')) return { fields: c.opts.plugins?.providerFields?.[id] ?? null, kind: 'provider', path };
    return { fields: providerFields(id), kind: 'provider', path };
  }
  return { fields: null, kind: 'none', path };
}

function checkSource(c: Ctx, src: Record<string, unknown>, path: Path) {
  if (typeof src.folder === 'string' && unsafePath(src.folder)) c.error('path-outside', "folder must stay inside the page's folder: no .., no / or ~ at the start.", [...path, 'folder']);
  if (typeof src.files === 'string' && unsafePath(src.files)) c.error('path-outside', "files must stay inside the page's folder: no .., no / or ~ at the start.", [...path, 'files']);
  if (src.fields !== undefined && typeof src.folder !== 'string') c.error('fields-without-folder', "fields only goes with folder: a provider's and a glob's fields are fixed.", [...path, 'fields'], 'key');
  if (typeof src.provider === 'string') {
    const id = src.provider;
    if (!id.includes(':') && !PROVIDER_IDS.includes(id)) {
      c.warn('unknown-provider', `'${id}' is not a provider this Ravenry knows, so this part shows a placeholder.`, [...path, 'provider'], 'value', closest(id, PROVIDER_IDS));
    } else if (id.includes(':') && c.opts.plugins?.providers && !c.opts.plugins.providers.includes(id)) {
      c.warn('unknown-plugin', `The provider ${id} is not installed, so this part shows a placeholder.`, [...path, 'provider'], 'value');
    }
  }
  if (isObj(src.fields)) {
    for (const [k, f] of Object.entries(src.fields)) {
      if (!isObj(f)) continue;
      const fp = [...path, 'fields', k];
      if (RESERVED.has(k)) {
        c.error('reserved-field', ['has', 'not', 'any'].includes(k) ? `'${k}' can't be a field name, because filters use it.` : `'${k}' is a field every item already has; pick another name.`, fp, 'key');
        continue;
      }
      if (typeof f.type === 'string' && !FIELD_TYPES.includes(f.type)) c.warn('unknown-type', `'${f.type}' is not a field type this Ravenry knows, so ${k} is read as text.`, [...fp, 'type'], 'value', closest(f.type, FIELD_TYPES));
      if (f.values !== undefined && f.type !== 'enum') c.error('values-not-enum', `values only goes with type: enum, and ${k} is ${an(String(f.type))} ${f.type}.`, [...fp, 'values'], 'key');
      if (Array.isArray(f.values) && new Set(f.values).size !== f.values.length) c.error('duplicate-value', `Field ${k} lists a value twice.`, [...fp, 'values']);
      if (f.default !== undefined && typeof f.type === 'string') {
        const want = valueProblem(specOfField(k, f), f.default);
        if (want) c.error('field-default', `The default of ${k} must be ${want}.`, [...fp, 'default'], 'value', typeof f.default === 'string' && f.type === 'enum' && Array.isArray(f.values) ? closest(f.default, f.values.map(String)) : null);
      }
    }
  }
}

/** The field a path names, or a reason it names none. */
function resolveField(fields: Record<string, FieldSpec>, path: string): FieldSpec | 'list' | null {
  const segs = path.split('.');
  let cur: Record<string, FieldSpec> | undefined = fields;
  let spec: FieldSpec | null = null;
  for (let i = 0; i < segs.length; i++) {
    if (!cur) return null;
    spec = cur[segs[i]] ?? null;
    if (!spec) return null;
    if (i < segs.length - 1) {
      if (spec.type === 'list') return 'list';
      cur = spec.type === 'object' ? spec.fields : undefined;
    }
  }
  return spec;
}

function allPaths(fields: Record<string, FieldSpec>, base = ''): string[] {
  const out: string[] = [];
  for (const [k, f] of Object.entries(fields)) {
    out.push(base + k);
    if (f.type === 'object' && f.fields) out.push(...allPaths(f.fields, `${base}${k}.`));
  }
  return out;
}

/** Checks one field reference. Returns its spec when it can be known. */
function ref(c: Ctx, scope: Scope, name: unknown, path: Path, types?: FieldType[], role?: string): FieldSpec | null {
  if (typeof name !== 'string' || !scope.fields) return null;
  const spec = resolveField(scope.fields, name);
  if (spec === 'list') {
    c.error('unknown-field', `'${name}' goes into a list; a dot only reaches into a single object's fields.`, path);
    return null;
  }
  if (!spec) {
    c.error('unknown-field', `'${name}' is not a field.`, path, 'value', closest(name, allPaths(scope.fields)));
    return null;
  }
  if (types && !types.includes(spec.type)) {
    c.error('field-type', `${role ?? 'This'} needs ${orList(types.map((t) => an(t) + ' ' + t))} field, and ${name} is ${an(spec.type)} ${spec.type}.`, path);
  }
  return spec;
}

function checkFilter(c: Ctx, scope: Scope, f: unknown, path: Path) {
  if (!isObj(f)) return;
  for (const [k, v] of Object.entries(f)) {
    const p = [...path, k];
    if (k === 'has') {
      const list = Array.isArray(v) ? v : [v];
      list.forEach((x, i) => ref(c, scope, x, Array.isArray(v) ? [...p, i] : p));
    } else if (k === 'not') checkFilter(c, scope, v, p);
    else if (k === 'any' && Array.isArray(v)) v.forEach((x, i) => checkFilter(c, scope, x, [...p, i]));
    else {
      if (!scope.fields) continue;
      const spec = resolveField(scope.fields, k);
      if (spec === 'list') { c.error('unknown-field', `'${k}' goes into a list; a dot only reaches into a single object's fields.`, p, 'key'); continue; }
      if (!spec) { c.error('unknown-field', `'${k}' is not a field.`, p, 'key', closest(k, allPaths(scope.fields))); continue; }
      const values: [unknown, Path][] = [];
      if (isObj(v)) {
        for (const [op, x] of Object.entries(v)) {
          if (op === 'not') (Array.isArray(x) ? x : [x]).forEach((y, i) => values.push([y, Array.isArray(x) ? [...p, op, i] : [...p, op]]));
          else if (spec.type !== 'number' && spec.type !== 'date') c.error('filter-compare', `${op} compares numbers and dates, and ${k} is ${an(spec.type)} ${spec.type}.`, [...p, op], 'key');
        }
      } else (Array.isArray(v) ? v : [v]).forEach((y, i) => values.push([y, Array.isArray(v) ? [...p, i] : p]));
      if (spec.type === 'enum' && spec.values) {
        for (const [x, xp] of values) {
          if (typeof x === 'string' && !spec.values.includes(x)) c.error('filter-value', `${k} is never '${x}': its values are ${andList(spec.values)}.`, xp, 'value', closest(x, spec.values));
        }
      }
    }
  }
}

function checkPlainText(c: Ctx, v: unknown, path: Path) {
  if (typeof v !== 'string') return;
  const ph = looksLikePlaceholder(v);
  if (ph) c.error('placeholder-not-allowed', `${path[path.length - 1]} is shown as written, so ${ph} would stay as it is. {field} only fills a button's confirm, copy, ask and open text.`, path);
}

function checkTemplate(c: Ctx, scope: Scope | null, v: unknown, path: Path) {
  if (typeof v !== 'string') return;
  const t = parseTemplate(v);
  for (const b of t.bad) c.error('placeholder-syntax', `${b} is not a placeholder. A placeholder is a field name in braces, such as {title}; write {{ for a brace.`, path);
  const names = templateFields(t.parts);
  if (!names.length) return;
  if (!scope) {
    c.error('placeholder-no-item', `This button has no item, so {${names[0]}} has nothing to fill it. Move the button into item.actions, or write the text out.`, path);
    return;
  }
  if (!scope.fields) return;
  for (const n of names) {
    const spec = resolveField(scope.fields, n);
    if (!spec || spec === 'list') c.error('unknown-field', `'{${n}}' is not a field of this item.`, path, 'value', spec ? null : closest(n, allPaths(scope.fields)));
  }
}

const VERB_SET = new Set<string>(ACTION_KINDS);

function checkAction(c: Ctx, a: unknown, path: Path, scope: Scope, item: boolean, skip: Set<string>) {
  if (!isObj(a)) return;
  checkPlainText(c, a.label, [...path, 'label']);
  if (typeof a.icon === 'string' && !ICONS.includes(a.icon)) c.warn('unknown-icon', `'${a.icon}' is not one of Ravenry's icons, so the button shows none.`, [...path, 'icon'], 'value', closest(a.icon, ICONS));
  const ts: Scope | null = item ? scope : null;
  checkTemplate(c, ts, a.confirm, [...path, 'confirm']);
  if (a.when !== undefined) {
    if (!item) c.error('needs-item', 'when picks the items a button shows on, so it belongs to a button in item.actions.', [...path, 'when'], 'key');
    else checkFilter(c, scope, a.when, [...path, 'when']);
  }
  const verbs = Object.keys(a).filter((k) => VERB_SET.has(k));
  const desc = describe(path, c.data);
  if (verbs.length > 1) {
    c.error('both', `${desc} has both ${andList(verbs)}. A button does one thing; make one button for each.`, [...path, verbs[1]], 'key');
    return;
  }
  if (a.with !== undefined && a.plugin === undefined) c.error('with-without-plugin', 'with only goes with plugin.', [...path, 'with'], 'key');
  if (isObj(a.fallback)) checkAction(c, a.fallback, [...path, 'fallback'], scope, item, skip);
  if (verbs.length === 0) {
    const others = Object.keys(a).filter((k) => !['label', 'icon', 'confirm', 'when', 'fallback', 'with'].includes(k) && !k.startsWith('x-'));
    if (!others.length) {
      c.error('no-action', `${desc} does nothing: give it one of ${orList([...ACTION_KINDS])}.`, path, 'key');
      return;
    }
    skip.add(JSON.stringify(path));
    const guess = closest(others[0], ACTION_KINDS);
    c.warn('unknown-action', `${desc} uses ${others[0]}, which this Ravenry doesn't know. ${a.fallback ? 'It shows its fallback.' : 'It is drawn turned off.'}`, [...path, others[0]], 'key', guess);
    return;
  }
  const verb = verbs[0];
  const vp = [...path, verb];
  const v = a[verb];
  const needItem = (what: string) => c.error('needs-item', `${what}, so it belongs in item.actions.`, vp, 'key');
  const needFolder = (what: string) => {
    if (scope.kind === 'provider') c.error('read-only-source', `${what}, and a provider's items are read-only. It needs a folder source.`, vp, 'key');
    else if (scope.kind === 'files' && verb !== 'toggle') c.error('read-only-source', `${what}, and a files source's items can only have their boxes ticked. It needs a folder source.`, vp, 'key');
  };
  switch (verb) {
    case 'open':
      if (typeof v === 'string' && !['item', 'file', 'folder'].includes(v)) { c.warn('unknown-value', `open: ${v} is not something this Ravenry can open, so the button is drawn turned off.`, vp, 'value', closest(v, ['item', 'file', 'folder'])); break; }
      if (typeof v === 'string' && !item) c.error('needs-item', `open: ${v} opens an item, so it belongs in item.actions.`, vp);
      if (isObj(v)) {
        if (v.link !== undefined) { if (!item) needItem('open: { link } opens an item\'s address'); else ref(c, scope, v.link, [...vp, 'link'], ['string'], 'link'); }
        checkTemplate(c, ts, v.project, [...vp, 'project']);
        checkTemplate(c, ts, v.session, [...vp, 'session']);
      }
      break;
    case 'set': {
      if (!item) { needItem('set changes an item'); break; }
      needFolder('set writes to an item\'s file');
      if (!isObj(v) || !scope.fields || scope.kind !== 'folder') break;
      for (const [k, x] of Object.entries(v)) {
        const spec = scope.fields[k];
        if (!spec) { c.error('unknown-field', `'${k}' is not a field.`, [...vp, k], 'key', closest(k, Object.keys(scope.fields))); continue; }
        if (spec.type !== 'enum' && spec.type !== 'bool') { c.error('set-type', `set can only change enum and bool fields, to one of their values; ${k} is ${an(spec.type)} ${spec.type}.`, [...vp, k], 'key'); continue; }
        const want = valueProblem(spec, x);
        if (want) c.error('set-value', typeof x === 'string' && spec.type === 'enum' ? `'${x}' is not a value of ${k}: ${andList(spec.values!)}.` : `${k} can only be set to ${want}.`, [...vp, k], 'value', typeof x === 'string' && spec.values ? closest(x, spec.values) : null);
      }
      break;
    }
    case 'create': {
      if (item) { c.error('create-in-item', "create makes a new item, so it belongs in the page's or a section's actions, not an item's.", vp, 'key'); break; }
      needFolder('create writes a new file');
      if (!isObj(v) || !scope.fields || scope.kind !== 'folder') break;
      for (const [k, x] of Object.entries(v)) {
        const spec = scope.fields[k];
        if (!spec || (spec.builtin && k !== 'title')) { c.error('unknown-field', `'${k}' is not a field a new item can start with.`, [...vp, k], 'key', closest(k, Object.keys(scope.fields).filter((n) => n === 'title' || !scope.fields![n].builtin))); continue; }
        const want = valueProblem(spec, x);
        if (want) c.error('create-value', `${k} must start as ${want}.`, [...vp, k], 'value', typeof x === 'string' && spec.values ? closest(x, spec.values) : null);
      }
      break;
    }
    case 'toggle':
      if (v !== 'body') { c.warn('unknown-value', `toggle: ${v} is not something this Ravenry can tick, so the button is drawn turned off.`, vp, 'value', closest(String(v), ['body'])); break; }
      if (!item) { needItem('toggle ticks an item\'s boxes'); break; }
      if (scope.kind === 'provider') c.error('read-only-source', "toggle ticks boxes in an item's file, and a provider's items are read-only.", vp, 'key');
      break;
    case 'copy':
      checkTemplate(c, ts, v, vp);
      break;
    case 'archive':
      if (!item) { needItem('archive moves an item\'s file'); break; }
      needFolder('archive moves the item\'s file');
      break;
    case 'ask':
      if (isObj(v)) for (const k of ['session', 'prefill', 'background']) checkTemplate(c, ts, v[k], [...vp, k]);
      break;
    case 'run':
      if (!isObj(v)) break;
      if (Array.isArray(v.argv)) v.argv.forEach((w, i) => {
        if (typeof w === 'string' && /\{[a-z][a-z0-9_.]*\}/.test(w)) c.error('run-placeholder', "run never puts item data in argv. Pass it as an environment variable: env: { NAME: field }.", [...vp, 'argv', i]);
      });
      if (isObj(v.env)) {
        if (!item && Object.keys(v.env).length) c.error('needs-item', 'env fills variables from an item\'s fields, so this button belongs in item.actions.', [...vp, 'env'], 'key');
        else for (const [k, f] of Object.entries(v.env)) ref(c, scope, f, [...vp, 'env', k]);
      }
      if (typeof v.cwd === 'string' && unsafePath(v.cwd)) c.error('path-outside', "cwd must stay inside the page's folder: no .., no / or ~ at the start.", [...vp, 'cwd']);
      break;
    case 'plugin':
      if (typeof v === 'string') pluginCheck(c, v, vp, 'action', !!a.fallback);
      break;
  }
}

function pluginCheck(c: Ctx, name: string, path: Path, kind: 'view' | 'action', hasFallback: boolean): boolean {
  const known = kind === 'view' ? RAVENRY_VIEW_NAMES : RAVENRY_ACTION_NAMES;
  const then = hasFallback ? 'It shows its fallback.' : kind === 'view' ? 'It shows a placeholder.' : 'It is drawn turned off.';
  if (name.startsWith('ravenry:')) {
    if (!known.has(name)) { c.warn('unknown-plugin', `${name} is not one of Ravenry's built-in ${kind}s. ${then}`, path, 'value', closest(name, known)); return false; }
    return true;
  }
  const have = kind === 'view' ? c.opts.plugins?.views : c.opts.plugins?.actions;
  if (have && !have.includes(name)) { c.warn('unknown-plugin', `The ${kind} ${name} needs a plugin that is not installed. ${then}`, path, 'value'); return false; }
  return true;
}

function checkItem(c: Ctx, it: unknown, path: Path, scope: Scope, skip: Set<string>) {
  if (!isObj(it)) return;
  ref(c, scope, it.title, [...path, 'title']);
  ref(c, scope, it.subtitle, [...path, 'subtitle']);
  if (Array.isArray(it.badges)) it.badges.forEach((b, i) => ref(c, scope, b, [...path, 'badges', i]));
  if (typeof it.progress === 'string') ref(c, scope, it.progress, [...path, 'progress'], ['number'], 'progress');
  else if (isObj(it.progress)) {
    if (it.progress.list !== undefined) ref(c, scope, it.progress.list, [...path, 'progress', 'list'], ['list'], 'progress.list');
    else {
      ref(c, scope, it.progress.done, [...path, 'progress', 'done'], ['number'], 'progress.done');
      ref(c, scope, it.progress.total, [...path, 'progress', 'total'], ['number'], 'progress.total');
    }
  }
  if (isObj(it.progress) && typeof it.progress.style === 'string' && !['bar', 'dots', 'count'].includes(it.progress.style)) c.warn('unknown-value', `'${it.progress.style}' is not a progress style this Ravenry knows, so it draws ${it.progress.list !== undefined ? 'dots' : 'a bar'}.`, [...path, 'progress', 'style'], 'value', closest(it.progress.style, ['bar', 'dots', 'count']));
  ref(c, scope, it.image, [...path, 'image'], ['image'], 'image');
  ref(c, scope, it.time, [...path, 'time'], ['date'], 'time');
  ref(c, scope, it.checklist, [...path, 'checklist'], ['string'], 'checklist');
  ref(c, scope, it.excerpt, [...path, 'excerpt'], ['string'], 'excerpt');
  if (typeof it.place === 'string') pluginCheck(c, it.place, [...path, 'place'], 'view', false);
  if (typeof it.detail === 'string') pluginCheck(c, it.detail, [...path, 'detail'], 'view', false);
  if (Array.isArray(it.actions)) it.actions.forEach((a, i) => checkAction(c, a, [...path, 'actions', i], scope, true, skip));
}

function checkSection(c: Ctx, s: unknown, path: Path, pageSource: unknown, skip: Set<string>) {
  if (!isObj(s)) return;
  const view = typeof s.view === 'string' ? s.view : '';
  checkPlainText(c, s.title, [...path, 'title']);
  checkPlainText(c, s.empty, [...path, 'empty']);
  if (isObj(s.source)) checkSource(c, s.source, [...path, 'source']);
  const src = s.source ?? pageSource;
  const plugin = view.includes(':');
  const core = (CORE_VIEWS as readonly string[]).includes(view);
  if (!plugin && !core) {
    skip.add(JSON.stringify(path));
    c.warn('unknown-view', `${describe(path, c.data, false)} uses the view '${view}', which this Ravenry doesn't know. ${s.fallback ? 'It shows its fallback.' : 'It shows a placeholder.'}`, [...path, 'view'], 'value', closest(view, CORE_VIEWS));
  }
  if (plugin) pluginCheck(c, view, [...path, 'view'], 'view', !!s.fallback);
  if (!src && !plugin) {
    c.error('no-source', `${describe(path, c.data)} has no source, and the page has none. Add a source with a folder, files or provider.`, [...path, 'view'], 'key');
  }
  const scope: Scope = src ? sourceScope(c, src, isObj(s.source) ? [...path, 'source'] : ['source']) : { fields: null, kind: 'none', path };
  const shown = core ? view : typeof s.fallback === 'string' ? s.fallback : null;
  checkFilter(c, scope, s.where, [...path, 'where']);
  if (Array.isArray(s.sort)) s.sort.forEach((k, i) => { if (typeof k === 'string') ref(c, scope, k.replace(/^-/, ''), [...path, 'sort', i]); });
  if (Array.isArray(s.actions)) s.actions.forEach((a, i) => checkAction(c, a, [...path, 'actions', i], scope, false, skip));
  if (shown && ITEM_VIEWS.includes(shown)) {
    checkItem(c, s.item, [...path, 'item'], scope, skip);
    if (s.group_by !== undefined) {
      const spec = ref(c, scope, s.group_by, [...path, 'group_by']);
      if (spec && shown === 'board' && spec.type !== 'enum') c.error('group-by-not-enum', `A board's lanes come from an enum field, and ${s.group_by} is ${an(spec.type)} ${spec.type}. Use an enum field, or view: list.`, [...path, 'group_by']);
    }
    if (shown === 'table' && Array.isArray(s.columns)) s.columns.forEach((col, i) => {
      if (typeof col === 'string') ref(c, scope, col, [...path, 'columns', i]);
      else if (isObj(col)) {
        ref(c, scope, col.field, [...path, 'columns', i, 'field']);
        checkPlainText(c, col.label, [...path, 'columns', i, 'label']);
        if (typeof col.align === 'string' && !['start', 'end'].includes(col.align)) c.warn('unknown-value', `'${col.align}' is not an alignment this Ravenry knows, so the column keeps its usual one.`, [...path, 'columns', i, 'align'], 'value', closest(col.align, ['start', 'end']));
      }
    });
  }
  if (shown === 'stats' && Array.isArray(s.stats)) s.stats.forEach((st, i) => {
    if (!isObj(st)) return;
    const sp = [...path, 'stats', i];
    checkPlainText(c, st.label, [...sp, 'label']);
    checkPlainText(c, st.note, [...sp, 'note']);
    if (isObj(st.count)) checkFilter(c, scope, st.count, [...sp, 'count']);
    if (st.sum !== undefined) ref(c, scope, st.sum, [...sp, 'sum'], ['number'], 'sum');
    for (const k of ['min', 'max']) if (st[k] !== undefined) ref(c, scope, st[k], [...sp, k], ['number', 'date'], k);
  });
  if (isObj(s.fallback)) checkSection(c, s.fallback, [...path, 'fallback'], pageSource, skip);
}

function semantic(c: Ctx, skip: Set<string>, schemaOk: boolean) {
  const d = c.data;
  if (!schemaOk) return;
  const fileName = c.opts.fileName;
  if (fileName !== undefined) {
    const base = fileName.split(/[\\/]/).pop()!;
    if (!base.endsWith('.page.yaml')) c.error('file-name', `A page file's name ends in .page.yaml, and this one is ${base}.`, ['id']);
    else if (base.slice(0, -'.page.yaml'.length) !== d.id) c.error('id-file-name', `id is '${d.id}' but the file is ${base}. They must match: pages are matched by id even when a file can't be read.`, ['id'], 'value');
  }
  checkPlainText(c, d.title, ['title']);
  if (isObj(d.source)) checkSource(c, d.source, ['source']);
  const nav = isObj(d.nav) ? d.nav : {};
  checkPlainText(c, nav.label, ['nav', 'label']);
  if (typeof nav.icon === 'string' && !ICONS.includes(nav.icon)) c.warn('unknown-icon', `'${nav.icon}' is not one of Ravenry's icons, so the row shows the page icon.`, ['nav', 'icon'], 'value', closest(nav.icon, ICONS));
  const firstSection = (sections: unknown): Record<string, unknown> | null => (Array.isArray(sections) && isObj(sections[0]) ? sections[0] : null);
  const countScope = (sections: unknown, path: Path): Scope | null => {
    const src = d.source ?? firstSection(sections)?.source;
    if (!src) { c.error('no-source', 'A count needs the page\'s source, or one on the first section.', path, 'key'); return null; }
    return sourceScope(c, src, ['source']);
  };
  if (nav.count !== undefined && nav.sum !== undefined) c.error('both', 'nav has both count and sum. Use one.', ['nav', 'sum'], 'key');
  if (typeof nav.sum === 'string') { const sc = countScope(d.sections ?? (Array.isArray(d.tabs) && isObj(d.tabs[0]) ? d.tabs[0].sections : null), ['nav', 'sum']); if (sc) ref(c, sc, nav.sum, ['nav', 'sum'], ['number'], 'nav.sum'); }
  if (isObj(nav.count)) { const sc = countScope(d.sections ?? (Array.isArray(d.tabs) && isObj(d.tabs[0]) ? d.tabs[0].sections : null), ['nav', 'count']); if (sc) checkFilter(c, sc, nav.count, ['nav', 'count']); }
  else if (nav.count === true && !d.source && !firstSection(d.sections ?? (Array.isArray(d.tabs) && isObj(d.tabs[0]) ? d.tabs[0].sections : null))?.source) c.error('no-source', 'A count needs the page\'s source, or one on the first section.', ['nav', 'count'], 'key');
  const pageScope: Scope = d.source ? sourceScope(c, d.source, ['source']) : { fields: null, kind: 'none', path: [] };
  if (Array.isArray(d.actions)) d.actions.forEach((a, i) => checkAction(c, a, ['actions', i], pageScope, false, skip));
  if (Array.isArray(d.sections)) d.sections.forEach((s, i) => checkSection(c, s, ['sections', i], d.source, skip));
  if (Array.isArray(d.tabs)) {
    const labels = new Set<string>();
    d.tabs.forEach((t, ti) => {
      if (!isObj(t)) return;
      checkPlainText(c, t.label, ['tabs', ti, 'label']);
      if (typeof t.label === 'string') {
        if (labels.has(t.label)) c.error('duplicate-tab', `Two tabs are called "${t.label}".`, ['tabs', ti, 'label']);
        labels.add(t.label);
      }
      if (isObj(t.count)) { const sc = countScope(t.sections, ['tabs', ti, 'count']); if (sc) checkFilter(c, sc, t.count, ['tabs', ti, 'count']); }
      if (Array.isArray(t.sections)) t.sections.forEach((s, i) => checkSection(c, s, ['tabs', ti, 'sections', i], d.source, skip));
    });
  }
}

// ------------------------------------------------------------ the model

function toFilter(f: Record<string, unknown>): Filter {
  const all: Condition[] = [];
  for (const [k, v] of Object.entries(f)) {
    if (k === 'has') for (const x of Array.isArray(v) ? v : [v]) all.push({ op: 'has', field: String(x) });
    else if (k === 'not') all.push({ op: 'not', filter: toFilter(v as Record<string, unknown>) });
    else if (k === 'any') all.push({ op: 'any', filters: (v as Record<string, unknown>[]).map(toFilter) });
    else if (Array.isArray(v)) all.push({ op: 'in', field: k, values: v as Scalar[] });
    else if (isObj(v)) {
      for (const [op, x] of Object.entries(v)) {
        if (op === 'not') all.push({ op: 'ne', field: k, values: (Array.isArray(x) ? x : [x]) as Scalar[] });
        else all.push({ op: op as 'gt' | 'gte' | 'lt' | 'lte', field: k, value: x as Scalar });
      }
    } else all.push({ op: 'eq', field: k, value: v as Scalar });
  }
  return { all };
}

const tmpl = (v: unknown): TextPart[] => parseTemplate(String(v)).parts;

function toSource(c: Ctx, src: Record<string, unknown>): Source {
  if (typeof src.folder === 'string') {
    const fields = sourceScope(c, src, []).fields!;
    return { kind: 'folder', folder: src.folder, fields };
  }
  if (typeof src.files === 'string') return { kind: 'files', files: src.files, fields: filesFields() };
  const id = String(src.provider);
  const plugin = id.includes(':');
  const known = plugin ? !c.opts.plugins?.providers || c.opts.plugins.providers.includes(id) : PROVIDER_IDS.includes(id);
  return { kind: 'provider', provider: id, plugin, known, fields: sourceScope(c, src, []).fields };
}

function toAction(c: Ctx, a: Record<string, unknown>): Action {
  const base = {
    label: String(a.label),
    icon: typeof a.icon === 'string' && ICONS.includes(a.icon) ? a.icon : null,
    confirm: typeof a.confirm === 'string' ? tmpl(a.confirm) : null,
    when: isObj(a.when) ? toFilter(a.when) : null,
  };
  const verb = Object.keys(a).find((k) => VERB_SET.has(k));
  const fallback = () => (isObj(a.fallback) ? toAction(c, a.fallback) : null);
  if (!verb) return fallback() ?? { ...base, kind: 'off', reason: 'This button needs a newer Ravenry.' };
  const v = a[verb];
  switch (verb) {
    case 'open': {
      let open: OpenTarget;
      if (typeof v === 'string' && !['item', 'file', 'folder'].includes(v)) return fallback() ?? { ...base, kind: 'off', reason: 'This button needs a newer Ravenry.' };
      if (typeof v === 'string') open = { kind: v as 'item' | 'file' | 'folder' };
      else {
        const o = v as Record<string, unknown>;
        if (o.page !== undefined) open = { kind: 'page', page: String(o.page) };
        else if (o.link !== undefined) open = { kind: 'link', field: String(o.link) };
        else if (o.project !== undefined) open = { kind: 'project', text: tmpl(o.project) };
        else open = { kind: 'session', text: tmpl(o.session) };
      }
      return { ...base, kind: 'open', open };
    }
    case 'set': return { ...base, kind: 'set', set: v as Record<string, Scalar> };
    case 'create': return { ...base, kind: 'create', create: (v ?? {}) as Record<string, unknown> };
    case 'toggle': return v === 'body' ? { ...base, kind: 'toggle', toggle: 'body' } : fallback() ?? { ...base, kind: 'off', reason: 'This button needs a newer Ravenry.' };
    case 'copy': return { ...base, kind: 'copy', copy: tmpl(v) };
    case 'archive': return { ...base, kind: 'archive' };
    case 'ask': {
      const o = v as Record<string, unknown>;
      return { ...base, kind: 'ask', session: o.session !== undefined ? tmpl(o.session) : null, text: tmpl(o.prefill ?? o.background), background: o.background !== undefined };
    }
    case 'run': {
      const o = v as Record<string, unknown>;
      return { ...base, kind: 'run', argv: (o.argv as unknown[]).map(String), env: (o.env ?? {}) as Record<string, string>, cwd: typeof o.cwd === 'string' ? o.cwd : null };
    }
    default: {
      const name = String(v);
      const ok = name.startsWith('ravenry:') ? RAVENRY_ACTION_NAMES.has(name) : !c.opts.plugins?.actions || c.opts.plugins.actions.includes(name);
      if (!ok) return fallback() ?? { ...base, kind: 'off', reason: name.startsWith('ravenry:') ? 'This button needs a newer Ravenry.' : `This button needs the plugin ${name.split(':')[0]}.` };
      return { ...base, kind: 'plugin', plugin: name, with: isObj(a.with) ? a.with : {} };
    }
  }
}

function toItem(c: Ctx, it: Record<string, unknown> | undefined): ItemSpec {
  const i = it ?? {};
  let progress: Progress | null = null;
  if (typeof i.progress === 'string') progress = { kind: 'number', field: i.progress, style: 'bar' };
  else if (isObj(i.progress)) {
    const style = ['bar', 'dots', 'count'].includes(i.progress.style as string) ? i.progress.style as 'bar' | 'dots' | 'count' : i.progress.list !== undefined ? 'dots' : 'bar';
    progress = i.progress.list !== undefined ? { kind: 'list', list: String(i.progress.list), style } : { kind: 'ratio', done: String(i.progress.done), total: String(i.progress.total), style };
  }
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : null);
  const viewOk = (k: string) => { const n = str(k); return n && (n.startsWith('ravenry:') ? RAVENRY_VIEW_NAMES.has(n) : !c.opts.plugins?.views || c.opts.plugins.views.includes(n)) ? n : null; };
  return {
    title: str('title') ?? 'title', subtitle: str('subtitle'), badges: Array.isArray(i.badges) ? i.badges.map(String) : [],
    progress, image: str('image'), time: str('time'), checklist: str('checklist'), excerpt: str('excerpt'),
    place: viewOk('place'), detail: viewOk('detail'),
    actions: Array.isArray(i.actions) ? i.actions.filter(isObj).map((a) => toAction(c, a)) : [],
  };
}

function toSection(c: Ctx, s: Record<string, unknown>, pageSource: Source | null): Section {
  const own = isObj(s.source) ? toSource(c, s.source) : null;
  const source = own ?? pageSource;
  const base = {
    title: typeof s.title === 'string' ? s.title : null,
    source,
    where: isObj(s.where) ? toFilter(s.where) : null,
    sort: Array.isArray(s.sort) ? s.sort.map((k): SortKey => ({ field: String(k).replace(/^-/, ''), desc: String(k).startsWith('-') })) : [],
    limit: typeof s.limit === 'number' ? s.limit : null,
    empty: typeof s.empty === 'string' ? s.empty : null,
    actions: Array.isArray(s.actions) ? s.actions.filter(isObj).map((a) => toAction(c, a)) : [],
  };
  const view = String(s.view);
  const fall = (reason: string): Section => {
    if (typeof s.fallback === 'string') { const copy = { ...s, view: s.fallback }; delete (copy as Record<string, unknown>).fallback; return toSection(c, copy, pageSource); }
    if (isObj(s.fallback)) return toSection(c, s.fallback, pageSource);
    return { ...base, kind: 'placeholder', view, reason };
  };
  if (source && source.kind === 'provider' && !source.known) {
    return { ...base, kind: 'placeholder', view, reason: source.plugin ? `This part needs the plugin ${source.provider.split(':')[0]}.` : 'This part needs a newer Ravenry.' };
  }
  if (view.includes(':')) {
    const ok = view.startsWith('ravenry:') ? RAVENRY_VIEW_NAMES.has(view) : !c.opts.plugins?.views || c.opts.plugins.views.includes(view);
    if (!ok) return fall(view.startsWith('ravenry:') ? 'This part needs a newer Ravenry.' : `This part needs the plugin ${view.split(':')[0]}.`);
    return { ...base, kind: 'plugin', view, with: isObj(s.with) ? s.with : {} };
  }
  if (!(CORE_VIEWS as readonly string[]).includes(view)) return fall('This part needs a newer Ravenry.');
  const columns: Column[] | null = view === 'table'
    ? (Array.isArray(s.columns) ? s.columns : [(isObj(s.item) && typeof s.item.title === 'string') ? s.item.title : 'title']).map((col): Column => {
      const field = typeof col === 'string' ? col : String((col as Record<string, unknown>).field);
      const spec = source?.fields ? resolveField(source.fields, field) : null;
      const label = isObj(col) && typeof col.label === 'string' ? col.label : spec && spec !== 'list' ? spec.label : capitalise(field.split('.').pop()!);
      const align = isObj(col) && (col.align === 'end' || col.align === 'start') ? col.align : spec && spec !== 'list' && spec.type === 'number' ? 'end' : 'start';
      return { field, label, align };
    })
    : null;
  const stats: Stat[] | null = view === 'stats' && Array.isArray(s.stats)
    ? s.stats.filter(isObj).map((st): Stat => {
      const b = { label: String(st.label), note: typeof st.note === 'string' ? st.note : null };
      if (st.count !== undefined) return { ...b, kind: 'count', where: isObj(st.count) ? toFilter(st.count) : null };
      const k = (['sum', 'min', 'max'] as const).find((x) => st[x] !== undefined)!;
      return { ...b, kind: k, field: String(st[k]) };
    })
    : null;
  return {
    ...base, kind: 'core', view: view as CoreView, item: toItem(c, isObj(s.item) ? s.item : undefined),
    groupBy: typeof s.group_by === 'string' ? s.group_by : null, columns, stats,
  };
}

function normalize(c: Ctx): Page {
  const d = c.data;
  const source = isObj(d.source) ? toSource(c, d.source) : null;
  const nav = isObj(d.nav) ? d.nav : {};
  const count = (v: unknown): Filter | true | null => (v === true ? true : isObj(v) ? toFilter(v) : null);
  const navOut: Nav = {
    label: typeof nav.label === 'string' ? nav.label : String(d.title),
    icon: typeof nav.icon === 'string' && ICONS.includes(nav.icon) ? nav.icon : 'page',
    count: count(nav.count),
    sum: typeof nav.sum === 'string' ? nav.sum : null,
    countLabel: typeof nav.count_label === 'string' ? nav.count_label : null,
    route: typeof nav.route === 'string' ? nav.route : `pages/${d.id}`,
  };
  const sections = (list: unknown) => (Array.isArray(list) ? list.filter(isObj).map((s) => toSection(c, s, source)) : []);
  const tabs: Tab[] = Array.isArray(d.tabs)
    ? d.tabs.filter(isObj).map((t) => ({ label: String(t.label), count: count(t.count), sections: sections(t.sections) }))
    : [{ label: null, count: null, sections: sections(d.sections) }];
  let from: Page['from'] = null;
  if (typeof d.from === 'string') {
    const m = d.from.match(/^([^/]+)\/([^@]+)@(\d+)$/)!;
    from = { owner: m[1], id: m[2], revision: Number(m[3]) };
  }
  return {
    version: 1, id: String(d.id), title: String(d.title),
    revision: typeof d.revision === 'number' ? d.revision : null,
    from, requires: typeof d.requires === 'string' ? d.requires : null,
    nav: navOut, source, tabbed: Array.isArray(d.tabs), tabs,
    actions: Array.isArray(d.actions) ? d.actions.filter(isObj).map((a) => toAction(c, a)) : [],
    extra: Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith('x-'))),
  };
}

/** One problem as a line: "playtest.page.yaml line 14: 'stauts' is not a field. Did you mean status?" */
export function formatProblem(file: string, p: Problem): string {
  return `${file} line ${p.line}: ${p.message}${p.hint ? ' ' + p.hint : ''}`;
}

/** What a page shows, in a line, as `ravenry page check` says it after OK:
 * "board by status: New 4, Fixing 2, Fixed 6. 3 buttons." `groups` gives,
 * per section in order, the item count of each group when the host has
 * read the items. */
export function describePage(page: Page, groups: ({ value: string | null; count: number }[] | null)[] = []): string {
  const parts: string[] = [];
  let i = 0;
  const labels = new Set<string>();
  for (const a of page.actions) labels.add(a.label);
  for (const t of page.tabs) for (const s of t.sections) {
    let p = s.kind === 'core' ? s.view + (s.groupBy ? ` by ${s.groupBy}` : '') : s.kind === 'plugin' ? s.view : `${s.view} (placeholder)`;
    const g = groups[i++];
    if (g && g.length) p += `: ${g.map((x) => `${x.value === null ? 'None' : capitalise(x.value)} ${x.count}`).join(', ')}`;
    parts.push(p);
    for (const a of s.actions) labels.add(a.label);
    if (s.kind === 'core') for (const a of s.item.actions) labels.add(a.label);
  }
  const n = labels.size;
  return `${parts.join('; ')}. ${n} button${n === 1 ? '' : 's'}.`;
}
