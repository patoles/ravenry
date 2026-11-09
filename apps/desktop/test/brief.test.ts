// The brief in the window (src/renderer/briefdoc.ts): the Markdown it draws
// as text. Its Next step is split by the hub (hub/server/briefnext.mjs,
// tested in hub/tools/briefnext-test.mjs) and drawn as it comes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plain } from '../src/renderer/briefdoc.ts';

test('plain drops the marks a person does not read', () => {
  assert.equal(plain('[x] **Done** with `code` and [a link](x.md)'), 'Done with code and a link');
});
