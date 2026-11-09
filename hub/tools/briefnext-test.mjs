#!/usr/bin/env node
// A brief's Next step split as the hub sends it (server/briefnext.mjs,
// `nextParts`): the panel card's at most three items from the newest dated
// entry of an older brief, and the page's dated entries, newest first.
// Pure functions; no hub. Moved from the desktop's test/brief.test.ts.
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import { datedEntries, nextItems, nextParts, plain } from '../server/briefnext.mjs';
import { parseBrief } from '../server/brief.mjs';

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const is = (name, got, want) => check(name, eq(got, want), eq(got, want) ? '' : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// The picture's brief (scratchpad ravenry-brief.html): one paragraph that
// grew an entry per session.
const WALL = '2026-11-06: Released 0.3.0. Ran release.sh, uploaded 14 files to the CDN and purged it, checked https://lumen.app on the iPhone and the Pixel. The hero image was 2.1 MB so I converted it to AVIF (412 KB) and re-ran Lighthouse: 94 performance, 100 accessibility. Next: the header wraps at 390 px (issue #41), then the pricing section from the picked sketch, then ship 0.3.1. 2026-11-05: Picked sketch B for pricing after the pick round, the owner wants Reader in the middle and no annual toggle for now. Moved the old FAQ to /help. 2026-11-04: Set up Vite 6, moved from CRA, all 10 tests pass, bundle 148 KB gzip, removed moment.js.';

const es = datedEntries(WALL);
is('an older Next step is split at each date, newest first', es.map((e) => e.date), ['2026-11-06', '2026-11-05', '2026-11-04']);
check('the newest entry starts with its first sentence', /^Released 0\.3\.0\./.test(es[0].text), es[0].text);
check('the oldest ends with its last', /removed moment\.js\.$/.test(es[2].text), es[2].text);

const n = nextItems(WALL);
is('the card takes its items from the newest entry\'s "Next:"', n.items, ['The header wraps at 390 px (issue #41)', 'The pricing section from the picked sketch', 'Ship 0.3.1']);
is('and counts the older ones', n.older, 2);

const b = nextItems('- Fix the **header** at 390 px\n- Add [pricing](docs/p.md)\n- Ship `0.3.1`\n- Then the blog');
is('a Next step of bullets: the first three, plain', [b.items, b.older], [['Fix the header at 390 px', 'Add pricing', 'Ship 0.3.1'], 0]);

is('a sentence', nextItems('Make the tail flutter.').items, ['Make the tail flutter']);
is('a short paragraph: its sentences, at most three', nextItems('One. Two. Three. Four.').items, ['One', 'Two', 'Three']);
is('nothing', nextItems(null), { items: [], older: 0 });
is('a single date is not a split', datedEntries('2026-11-06: Released 0.3.0. Next: ship it.'), []);
is('a single date still gives its Next', nextItems('2026-11-06: Released 0.3.0. Next: ship it.').items, ['Ship it']);
is('plain drops the marks a person does not read', plain('[x] **Done** with `code` and [a link](x.md)'), 'Done with code and a link');

// What the hub sends: the items, the count, and the page's entries with their sentences.
const parts = nextParts(WALL);
is('nextParts: the card\'s items and count', [parts.items.length, parts.older], [3, 2]);
is('nextParts: each entry with its sentences', parts.entries[1], { date: '2026-11-05', text: 'Picked sketch B for pricing after the pick round, the owner wants Reader in the middle and no annual toggle for now. Moved the old FAQ to /help.', sentences: ['Picked sketch B for pricing after the pick round, the owner wants Reader in the middle and no annual toggle for now.', 'Moved the old FAQ to /help.'] });
check('nextParts: a version number is not a sentence end', parts.entries[0].sentences[0] === 'Released 0.3.0.', parts.entries[0].sentences[0]);
is('nextParts: no Next step', nextParts(null), { items: [], older: 0, entries: [] });
is('nextParts: bullets have no entries', nextParts('- a\n- b').entries, []);

// From the file as the hub reads it (GET /api/brief and the state both split brief.next).
const md = `# landing-page\n\nGoal: A page.\n\n## Rules\n- One rule.\n\n## Next step\n${WALL.replace('. 2026-11-05', '.\n2026-11-05')}\n\n## Plan\n- [ ] A step\n`;
const fromFile = nextParts(parseBrief(md).next);
is('from a brief file: the same split', [fromFile.items, fromFile.older, fromFile.entries.map((e) => e.date)], [n.items, 2, ['2026-11-06', '2026-11-05', '2026-11-04']]);

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
