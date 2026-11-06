// The schema itself: only keywords the interpreter supports, patterns any
// RE2 engine (Go) can run, a description for every key (the docs come from
// them), and the provider contract's shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_KEYWORDS } from '../src/jsonschema.ts';
import { ICONS, PAGE_SCHEMA, PROVIDERS_FILE, CORE_VIEWS, ACTION_KINDS } from '../src/index.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(s: unknown, at: string, fn: (s: Record<string, unknown>, at: string) => void) {
  if (typeof s !== 'object' || s === null || Array.isArray(s)) return;
  const o = s as Record<string, unknown>;
  fn(o, at);
  for (const k of ['properties', 'patternProperties', '$defs']) {
    if (o[k]) for (const [n, v] of Object.entries(o[k] as Record<string, unknown>)) walk(v, `${at}/${k}/${n}`, fn);
  }
  for (const k of ['items', 'additionalProperties', 'propertyNames', 'if', 'then', 'else']) walk(o[k], `${at}/${k}`, fn);
  for (const k of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(o[k])) (o[k] as unknown[]).forEach((v, i) => walk(v, `${at}/${k}/${i}`, fn));
}

test('the schema uses only supported keywords', () => {
  walk(PAGE_SCHEMA, '#', (o, at) => {
    for (const k of Object.keys(o)) assert.ok(SUPPORTED_KEYWORDS.has(k), `${at}: ${k}`);
  });
});

test('every pattern is RE2-compatible (no lookaround, no backreference)', () => {
  walk(PAGE_SCHEMA, '#', (o, at) => {
    if (typeof o.pattern === 'string') {
      assert.ok(!/\(\?[=!<]|\\[1-9]/.test(o.pattern), `${at}: ${o.pattern}`);
      new RegExp(o.pattern, 'u');
    }
  });
});

test('every key of the schema says what it is', () => {
  walk(PAGE_SCHEMA, '#', (o, at) => {
    if (!/\/properties\/[^/]+$/.test(at) || at.includes('/if/')) return;
    const ref = typeof o.$ref === 'string' ? (PAGE_SCHEMA.$defs as Record<string, Record<string, unknown>>)[(o.$ref as string).split('/').pop()!] : {};
    assert.ok(o.title || ref.title, `${at} has no title`);
  });
  const top = PAGE_SCHEMA.properties as Record<string, Record<string, unknown>>;
  for (const [k, v] of Object.entries(top)) assert.ok(v.description || v.$ref, `${k} has no description`);
});

test('the schema file is the one the package exports, and parses as JSON', () => {
  const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'page-1.json'), 'utf8'));
  assert.deepEqual(onDisk, PAGE_SCHEMA);
  assert.equal(onDisk.$id, 'urn:ravenry:page:1');
  assert.equal(onDisk.$schema, 'https://json-schema.org/draft/2020-12/schema');
});

test('icons, views and actions in the schema match the code', () => {
  const defs = PAGE_SCHEMA.$defs as Record<string, Record<string, unknown>>;
  assert.ok(String(defs.icon.description).includes(ICONS.join(', ')));
  assert.deepEqual(defs.coreView.enum, [...CORE_VIEWS]);
  const actionProps = Object.keys(defs.action.properties as object);
  for (const k of ACTION_KINDS) assert.ok(actionProps.includes(k), k);
});

test('the provider contract: every field typed, described and named in snake_case', () => {
  const types = new Set(['string', 'number', 'date', 'bool', 'enum', 'list', 'image', 'object']);
  const check = (fields: Record<string, { type: string; description: string; values?: string[]; fields?: Record<string, never> }>, at: string) => {
    for (const [k, f] of Object.entries(fields)) {
      assert.match(k, /^[a-z][a-z0-9_]*$/, `${at}.${k}`);
      assert.ok(types.has(f.type), `${at}.${k}: ${f.type}`);
      assert.ok(f.description && /\.$/.test(f.description), `${at}.${k} needs a sentence`);
      if (f.type === 'enum') assert.ok(f.values && f.values.length, `${at}.${k} needs values`);
      if (f.type === 'object') assert.ok(f.fields, `${at}.${k} needs fields`);
      if (f.fields) check(f.fields, `${at}.${k}`);
    }
  };
  assert.deepEqual(Object.keys(PROVIDERS_FILE.providers), ['projects', 'brief', 'plans', 'plan-files', 'git', 'rule-files', 'repeats', 'sessions']);
  for (const [id, p] of Object.entries(PROVIDERS_FILE.providers)) {
    assert.match(id, /^[a-z][a-z0-9-]*$/);
    assert.ok(p.fields[p.key], `${id}'s key ${p.key} is a field`);
    check(p.fields as never, id);
  }
});

test('the library uses no Node-only API, so it runs in a browser and the phone WebView', () => {
  const dir = path.join(ROOT, 'src');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/from ['"]node:|require\(|\bprocess\.|\bBuffer\b|\b__dirname\b/.test(src), f);
    for (const m of src.matchAll(/from '([^']+)'/g)) assert.ok(m[1].startsWith('.') || m[1] === 'yaml', `${f} imports ${m[1]}`);
  }
});
