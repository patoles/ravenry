// The brief's Next step for the panel's card (src/renderer/briefdoc.ts):
// at most three short items, from the newest dated entry of an older brief.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datedEntries, nextItems, plain } from '../src/renderer/briefdoc.ts';

// The picture's brief (scratchpad ravenry-brief.html): one paragraph that
// grew an entry per session.
const WALL = '2026-11-06: Released 0.3.0. Ran release.sh, uploaded 14 files to the CDN and purged it, checked https://lumen.app on the iPhone and the Pixel. The hero image was 2.1 MB so I converted it to AVIF (412 KB) and re-ran Lighthouse: 94 performance, 100 accessibility. Next: the header wraps at 390 px (issue #41), then the pricing section from the picked sketch, then ship 0.3.1. 2026-11-05: Picked sketch B for pricing after the pick round, the owner wants Reader in the middle and no annual toggle for now. Moved the old FAQ to /help. 2026-11-04: Set up Vite 6, moved from CRA, all 10 tests pass, bundle 148 KB gzip, removed moment.js.';

test('an older Next step is split at each date, newest first', () => {
  const es = datedEntries(WALL);
  assert.deepEqual(es.map((e) => e.date), ['2026-11-06', '2026-11-05', '2026-11-04']);
  assert.match(es[0].text, /^Released 0\.3\.0\./);
  assert.match(es[2].text, /removed moment\.js\.$/);
});

test('the card takes its items from the newest entry\'s "Next:", and counts the older ones', () => {
  const n = nextItems(WALL);
  assert.deepEqual(n.items, ['The header wraps at 390 px (issue #41)', 'The pricing section from the picked sketch', 'Ship 0.3.1']);
  assert.equal(n.older, 2);
});

test('a Next step of bullets: the first three, plain', () => {
  const n = nextItems('- Fix the **header** at 390 px\n- Add [pricing](docs/p.md)\n- Ship `0.3.1`\n- Then the blog');
  assert.deepEqual(n.items, ['Fix the header at 390 px', 'Add pricing', 'Ship 0.3.1']);
  assert.equal(n.older, 0);
});

test('a sentence or a short paragraph: its sentences, at most three', () => {
  assert.deepEqual(nextItems('Make the tail flutter.').items, ['Make the tail flutter']);
  assert.deepEqual(nextItems('One. Two. Three. Four.').items, ['One', 'Two', 'Three']);
  assert.deepEqual(nextItems(null), { items: [], older: 0 });
});

test('a single date is not a split', () => {
  assert.deepEqual(datedEntries('2026-11-06: Released 0.3.0. Next: ship it.'), []);
  assert.deepEqual(nextItems('2026-11-06: Released 0.3.0. Next: ship it.').items, ['Ship it']);
});

test('plain drops the marks a person does not read', () => {
  assert.equal(plain('[x] **Done** with `code` and [a link](x.md)'), 'Done with code and a link');
});
