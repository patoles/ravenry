// A small JSON Schema (draft 2020-12) interpreter for the keywords the page
// schema uses, and no others (test/schema.test.ts checks that). It needs no
// code generation, so it runs under a strict Content-Security-Policy in a
// WebView, and it reports what a person can act on: the failing branch of
// an anyOf, "needs one of" for a oneOf of required keys, and which keys of
// each mapping the schema knows, for the unknown-key warnings.

import type { Path } from './yaml.ts';

export type Schema = { [k: string]: unknown };

export const SUPPORTED_KEYWORDS = new Set([
  // structure and assertions
  '$ref', 'type', 'enum', 'const', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'minProperties',
  'items', 'properties', 'patternProperties', 'additionalProperties', 'propertyNames', 'required',
  'allOf', 'anyOf', 'oneOf', 'if', 'then', 'else',
  // annotations
  '$schema', '$id', '$defs', 'title', 'description', 'examples', 'default',
]);

export interface SchemaError {
  path: Path;
  /** required, type, invalid, enum, const, pattern, length, range, min-items, min-properties, property-name, unknown, one-of, both */
  kind: string;
  /** The schema that failed, for its title. */
  schema: Schema;
  /** required: the missing key. one-of/both: the keys. property-name: the key. */
  keys?: string[];
}

/** What the schema says about one mapping in the data. */
export interface ObjectNote {
  path: Path;
  /** Keys some applied schema names in properties. */
  known: Set<string>;
  /** Some applied schema has properties (a record, whose other keys are unknown). */
  record: boolean;
  /** Some applied schema has additionalProperties or propertyNames (a map, whose keys are data). */
  map: boolean;
}

interface Result { errors: SchemaError[]; notes: ObjectNote[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(v: unknown, t: string): boolean {
  const a = typeOf(v);
  if (t === 'number') return a === 'number' || a === 'integer';
  if (t === 'object') return a === 'object';
  return a === t;
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const reCache = new Map<string, RegExp>();
function re(p: string): RegExp {
  let r = reCache.get(p);
  if (!r) { r = new RegExp(p, 'u'); reCache.set(p, r); }
  return r;
}

export class Validator {
  readonly root: Schema;
  constructor(root: Schema) { this.root = root; }

  resolve(s: Schema): Schema {
    let cur = s;
    for (let i = 0; i < 20 && typeof cur.$ref === 'string'; i++) {
      const ref = cur.$ref as string;
      if (!ref.startsWith('#/')) throw new Error(`Only local $refs are supported: ${ref}`);
      let t: unknown = this.root;
      for (const seg of ref.slice(2).split('/')) t = (t as Record<string, unknown>)[seg];
      if (!isObj(t)) throw new Error(`Unresolved $ref ${ref}`);
      // Keywords beside a $ref (a description, examples) are annotations here.
      cur = t as Schema;
    }
    return cur;
  }

  /** The schema's title, following $refs. */
  titleOf(s: Schema): string | undefined {
    if (typeof s.title === 'string') return s.title;
    if (typeof s.$ref === 'string') return this.titleOf(this.resolve(s));
    return undefined;
  }

  validate(value: unknown, schema: Schema = this.root): Result {
    return this.run(value, schema, []);
  }

  private run(v: unknown, s0: Schema, path: Path): Result {
    const errors: SchemaError[] = [];
    const notes: ObjectNote[] = [];
    // Siblings of a $ref apply too (2020-12), so the ref target and the
    // local keywords are both checked.
    if (typeof s0.$ref === 'string') {
      const r = this.run(v, this.resolve(s0), path);
      errors.push(...r.errors);
      notes.push(...r.notes);
    }
    const s = s0;
    const fail = (kind: string, extra: Partial<SchemaError> = {}) => errors.push({ path, kind, schema: s, ...extra });

    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!types.some((t) => typeMatches(v, t))) { fail('type'); return { errors, notes }; }
    }
    if (s.const !== undefined && !equal(v, s.const)) fail('const');
    if (Array.isArray(s.enum) && !s.enum.some((e) => equal(e, v))) fail('enum');
    if (typeof v === 'string') {
      const len = [...v].length;
      if (typeof s.minLength === 'number' && len < s.minLength) fail('length');
      else if (typeof s.maxLength === 'number' && len > s.maxLength) fail('length');
      if (typeof s.pattern === 'string' && !re(s.pattern).test(v)) fail('pattern');
    }
    if (typeof v === 'number') {
      if (typeof s.minimum === 'number' && v < s.minimum) fail('range');
      if (typeof s.maximum === 'number' && v > s.maximum) fail('range');
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === 'number' && v.length < s.minItems) fail('min-items');
      if (isObj(s.items)) {
        v.forEach((x, i) => {
          const r = this.run(x, s.items as Schema, [...path, i]);
          errors.push(...r.errors);
          notes.push(...r.notes);
        });
      }
    }
    if (isObj(v)) {
      const props = isObj(s.properties) ? (s.properties as Record<string, Schema>) : null;
      const pats = isObj(s.patternProperties) ? (s.patternProperties as Record<string, Schema>) : null;
      const isMap = s.additionalProperties !== undefined || s.propertyNames !== undefined;
      if (props || isMap) notes.push({ path, known: new Set(props ? Object.keys(props) : []), record: !!props, map: isMap });
      if (Array.isArray(s.required)) {
        for (const k of s.required as string[]) if (!(k in v)) fail('required', { keys: [k] });
      }
      if (typeof s.minProperties === 'number' && Object.keys(v).length < s.minProperties) fail('min-properties');
      for (const [k, x] of Object.entries(v)) {
        let matched = false;
        if (props && k in props) {
          matched = true;
          const r = this.run(x, props[k], [...path, k]);
          errors.push(...r.errors);
          notes.push(...r.notes);
        }
        if (pats) {
          for (const [p, ps] of Object.entries(pats)) {
            if (!re(p).test(k)) continue;
            matched = true;
            const r = this.run(x, ps, [...path, k]);
            errors.push(...r.errors);
            notes.push(...r.notes);
          }
        }
        if (isObj(s.propertyNames) && !matched) {
          const r = this.run(k, s.propertyNames as Schema, [...path, k]);
          if (r.errors.length) errors.push({ path: [...path, k], kind: 'property-name', schema: s.propertyNames as Schema, keys: [k] });
        }
        if (!matched) {
          if (s.additionalProperties === false) fail('unknown', { keys: [k] });
          else if (isObj(s.additionalProperties)) {
            const r = this.run(x, s.additionalProperties as Schema, [...path, k]);
            errors.push(...r.errors);
            notes.push(...r.notes);
          }
        }
      }
    }
    if (Array.isArray(s.allOf)) {
      for (const sub of s.allOf as Schema[]) {
        const r = this.run(v, sub, path);
        errors.push(...r.errors);
        notes.push(...r.notes);
      }
    }
    if (isObj(s.if)) {
      const c = this.run(v, s.if as Schema, path);
      const branch = c.errors.length === 0 ? s.then : s.else;
      if (c.errors.length === 0) notes.push(...c.notes);
      if (isObj(branch)) {
        const r = this.run(v, branch as Schema, path);
        errors.push(...r.errors);
        notes.push(...r.notes);
      }
    }
    if (Array.isArray(s.anyOf)) this.alternatives(v, s, s.anyOf as Schema[], path, false, errors, notes);
    if (Array.isArray(s.oneOf)) this.alternatives(v, s, s.oneOf as Schema[], path, true, errors, notes);
    return { errors, notes };
  }

  private alternatives(v: unknown, s: Schema, branches: Schema[], path: Path, one: boolean, errors: SchemaError[], notes: ObjectNote[]) {
    // "Exactly one of these keys": a oneOf whose branches each only require
    // one key. Said as "needs one of" or "has both".
    const keyOnly = branches.every((b) => Object.keys(b).length === 1 && Array.isArray(b.required) && (b.required as unknown[]).length === 1);
    if (keyOnly && isObj(v)) {
      const keys = branches.map((b) => (b.required as string[])[0]);
      const present = keys.filter((k) => k in v);
      if (present.length === 0) errors.push({ path, kind: 'one-of', schema: s, keys });
      else if (one && present.length > 1) errors.push({ path, kind: 'both', schema: s, keys: present });
      return;
    }
    const results = branches.map((b) => this.run(v, b, path));
    const passing = results.filter((r) => r.errors.length === 0);
    if (passing.length > 0) {
      notes.push(...passing[0].notes);
      if (one && passing.length > 1) errors.push({ path, kind: 'both', schema: s });
      return;
    }
    // None passed. Branches that failed only on their type at this very
    // path are the wrong shape; among the others, the one that got furthest
    // says what is wrong.
    const near = results.filter((r) => !r.errors.some((e) => e.kind === 'type' && e.path.length === path.length));
    if (near.length === 0) { errors.push({ path, kind: 'type', schema: s }); return; }
    near.sort((a, b) => Math.max(...b.errors.map((e) => e.path.length)) - Math.max(...a.errors.map((e) => e.path.length)) || a.errors.length - b.errors.length);
    // A value of the right shape but wrong in itself (a misspelt name) is
    // said with the whole choice's title: "open must be item, file, ...".
    if (near[0].errors.every((e) => e.path.length === path.length && ['enum', 'const', 'pattern', 'length', 'range'].includes(e.kind))) {
      errors.push({ path, kind: 'invalid', schema: s });
      return;
    }
    errors.push(...near[0].errors);
    notes.push(...near[0].notes);
  }
}
