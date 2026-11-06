// The daemon answers terminal queries, so xterm.js must not: with the
// handlers on, a program's queries get no reply from the window, and
// everything else still draws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { suppressTerminalQueries } from '@ravenry/client';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');

const QUERIES = [
  '\x1b[c', // DA1
  '\x1b[0c',
  '\x1b[>c', // DA2
  '\x1b[5n', // status
  '\x1b[6n', // cursor position
  '\x1b[?6n',
  '\x1b[?2004$p', // DECRQM
  '\x1b[4$p',
  '\x1bP$qm\x1b\\', // DECRQSS
  '\x1b]10;?\x07', // foreground colour
  '\x1b]11;?\x1b\\', // background colour
  '\x1b]4;1;?\x07', // palette colour
  '\x1b[>0q', // XTVERSION
  '\x1b[?u', // kitty keyboard flags
  '\x1b[14t', // window size in pixels
  '\x1b[18t', // size in cells
];

function run(suppress: boolean): Promise<{ replies: string[]; line: string }> {
  const term = new Terminal({ cols: 80, rows: 5, allowProposedApi: true });
  if (suppress) suppressTerminalQueries(term.parser);
  const replies: string[] = [];
  term.onData((d) => replies.push(d));
  return new Promise((resolve) => {
    term.write(QUERIES.join('') + 'hello \x1b[1mbold\x1b[0m\x1b]2;a title\x07', () => {
      const line = term.buffer.active.getLine(0)!.translateToString(true);
      resolve({ replies, line });
    });
  });
}

test('without the handlers, xterm.js answers queries (the test sees them)', async () => {
  const { replies } = await run(false);
  assert.ok(replies.length >= 4, `expected replies, got ${JSON.stringify(replies)}`);
});

test('with the handlers, no query is answered and text still draws', async () => {
  const { replies, line } = await run(true);
  assert.deepEqual(replies, []);
  assert.equal(line, 'hello bold');
});
