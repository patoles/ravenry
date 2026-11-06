// The conformance cases (fixtures/conformance.json), which the Go checker
// and the apps will run too: every page fixture's exact errors and
// warnings, values in its model, and the item file operations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPage, checklist, parseItem, patchItem, readItem, toggle } from '../src/index.ts';
import type { CheckOptions } from '../src/index.ts';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'conformance.json'), 'utf8'));
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8');

function at(o: unknown, dotted: string): unknown {
  let cur = o;
  for (const seg of dotted.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const shape = (p: { code: string; line: number; column: number; message: string; hint?: string }) => ({ code: p.code, line: p.line, column: p.column, message: p.message, ...(p.hint ? { hint: p.hint } : {}) });

for (const c of manifest.pages) {
  test(`page ${c.file}`, () => {
    const r = checkPage(read(c.file), { ...(c.options as CheckOptions), fileName: path.basename(c.file) });
    assert.deepEqual(r.errors.map(shape), c.errors, 'errors');
    assert.deepEqual(r.warnings.map(shape), c.warnings, 'warnings');
    assert.equal(r.ok, c.ok);
    assert.equal(r.needs, c.needs ?? null);
    if (c.ok) assert.ok(r.page, 'a page that checks has a model');
    for (const [k, v] of Object.entries(c.model ?? {})) assert.deepEqual(at(r.page, k), v, `model ${k}`);
  });
}

for (const c of manifest.items) {
  test(`item: ${c.name}`, () => {
    const text = read(c.file);
    if (c.op === 'read') {
      const r = readItem(text, { file: path.basename(c.file) });
      for (const [k, v] of Object.entries(c.expect)) assert.deepEqual(r.item[k], v, k);
      assert.deepEqual(r.problems, []);
    } else if (c.op === 'checklist') {
      assert.deepEqual(checklist(text), c.expect);
    } else if (c.op === 'patch') {
      const base = parseItem(read(c.base));
      const r = patchItem(text, c.patch, { hash: base.hash, ...(c.baseFields ? { fields: base.fields } : {}) });
      assert.equal(r.ok, c.expect.ok);
      if (r.ok) {
        assert.equal(r.text, read(c.expect.text));
        assert.equal(r.rebased, c.expect.rebased);
        assert.equal(r.hash, parseItem(r.text).hash);
      } else {
        assert.ok('conflict' in r);
        assert.deepEqual(r.conflict.map((x) => ({ ...x, base: x.base ?? null })), c.expect.conflict);
      }
    } else if (c.op === 'toggle') {
      const r = toggle(text, c.box);
      assert.equal(r.ok, c.expect.ok);
      if (r.ok) {
        assert.equal(r.text, read(c.expect.text));
        assert.equal(r.line, c.expect.line);
        assert.equal(r.done, c.expect.done);
        assert.equal(r.moved, c.expect.moved);
      } else assert.equal(r.reason, c.expect.reason);
    } else assert.fail(`unknown op ${c.op}`);
  });
}

test('every fixture file is in the manifest', () => {
  const listed = new Set(manifest.pages.map((c: { file: string }) => c.file));
  for (const d of ['valid', 'invalid', 'unknown', 'future', 'playtest']) {
    for (const f of fs.readdirSync(path.join(DIR, d)).filter((x) => x.endsWith('.page.yaml'))) assert.ok(listed.has(`${d}/${f}`), `${d}/${f} has no case`);
  }
  const used = new Set(manifest.items.flatMap((c: { file: string; base?: string; expect: { text?: string } }) => [c.file, c.base, c.expect.text].filter(Boolean)));
  for (const f of fs.readdirSync(path.join(DIR, 'items'))) assert.ok(used.has(`items/${f}`), `items/${f} is in no case`);
});

test('every invalid fixture has exactly the errors it was written for, and no page in invalid/ checks', () => {
  for (const c of manifest.pages.filter((x: { file: string }) => x.file.startsWith('invalid/'))) {
    assert.equal(c.ok, false, c.file);
    assert.ok(c.errors.length >= 1 && c.errors.length <= 2, `${c.file} should show one mistake`);
  }
  for (const c of manifest.pages.filter((x: { file: string }) => x.file.startsWith('unknown/'))) assert.equal(c.ok, true, `${c.file}: unknown things only warn`);
});
