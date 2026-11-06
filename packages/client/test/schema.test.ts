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
