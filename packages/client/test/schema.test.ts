// The types in src/protocol.ts name every method and event of the schema
// (packages/protocol/schema/v1.json), so a message added to the protocol
// cannot be missing from this client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const here = new URL('.', import.meta.url);
const schema = JSON.parse(fs.readFileSync(new URL('../../protocol/schema/v1.json', here), 'utf8')) as { $defs: Record<string, unknown> };
const types = fs.readFileSync(new URL('../src/protocol.ts', here), 'utf8');

test('every method of the schema has its params and result in Methods', () => {
  const methods = Object.keys(schema.$defs).filter((k) => k.startsWith('request.')).map((k) => k.slice(8));
  assert.ok(methods.length >= 29);
  const missing = methods.filter((m) => !new RegExp(`^\\s+(${m}|'${m.replace('.', '\\.')}'): \\{`, 'm').test(types));
  assert.deepEqual(missing, []);
});

test('every event of the schema is in DaemonEvent', () => {
  const events = Object.keys(schema.$defs).filter((k) => k.startsWith('event.')).map((k) => k.slice(6));
  const missing = events.filter((e) => !types.includes(`event: '${e}'`));
  assert.deepEqual(missing, []);
});

// The fields too, not only the names: a request field or an object field
// the schema has and the types lack (pane.list's `processes`, a pane's
// `pids`) is a client that cannot send or read it.

/** The text of `{ ... }` starting at the first brace at or after `from`. */
function braces(src: string, from: number): string {
  const start = src.indexOf('{', from);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** An exported interface's body, or an exported type's text up to its end. */
function named(name: string): string | null {
  const i = types.indexOf(`export interface ${name} {`);
  if (i >= 0) return braces(types, i);
  const t = types.indexOf(`export type ${name} =`);
  if (t >= 0) return types.slice(t, types.indexOf(';\n\n', t) + 1);
  return null;
}

/** The text a field list is read from, with the named types it mentions expanded once. */
function expand(text: string): string {
  return text + (text.match(/\b[A-Z][A-Za-z]+\b/g) || []).map((n) => named(n) || '').join('\n');
}

const hasField = (text: string, field: string): boolean => new RegExp(`(^|[\\s{;,(|&])'?${field}'?\\??:`, 'm').test(text);

type Obj = { properties?: Record<string, unknown> };

test('every field of every request is in its method\'s params', () => {
  const missing: string[] = [];
  for (const [k, def] of Object.entries(schema.$defs as Record<string, Obj>)) {
    if (!k.startsWith('request.')) continue;
    const m = k.slice(8);
    const at = types.search(new RegExp(`^\\s+'${m.replace('.', '\\.')}': \\{`, 'm'));
    if (at < 0) continue; // the method test above reports it
    const entry = braces(types, at);
    const params = entry.slice(0, entry.indexOf('result:'));
    const text = expand(params);
    for (const f of Object.keys(def.properties || {})) {
      if (['v', 'type', 'id'].includes(f)) continue;
      if (!hasField(text, f)) missing.push(`${m}.${f}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every field of every object the types name is in that type', () => {
  const missing: string[] = [];
  let checked = 0;
  for (const [k, def] of Object.entries(schema.$defs as Record<string, Obj>)) {
    if (!/^[A-Z]/.test(k) || !def.properties) continue;
    const body = named(k);
    if (!body) continue;
    checked++;
    for (const f of Object.keys(def.properties)) if (!hasField(body, f)) missing.push(`${k}.${f}`);
  }
  assert.ok(checked >= 8, `only ${checked} objects checked`);
  assert.deepEqual(missing, []);
});
