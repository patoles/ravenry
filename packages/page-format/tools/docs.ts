#!/usr/bin/env node
// Writes, checks or prints the agent docs for page files.
//
//   node tools/docs.ts --write          docs/pages.md from the schema
//   node tools/docs.ts --check          fails when docs/pages.md is not current
//   node tools/docs.ts [topic]          prints the docs, or one topic, as
//                                       `ravenry page docs [topic]` will
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docsTopic, pageDocs } from '../src/docs.ts';

const FILE = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'docs', 'pages.md');
const args = process.argv.slice(2);
const text = pageDocs();

if (args[0] === '--write') {
  fs.writeFileSync(FILE, text);
  console.log(`wrote ${path.relative(process.cwd(), FILE)} (${text.split('\n').length} lines)`);
} else if (args[0] === '--check') {
  const now = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
  if (now !== text) {
    console.error('docs/pages.md is not current: run `npm run docs` in packages/page-format and commit it.');
    process.exit(1);
  }
  console.log('docs/pages.md is current');
} else {
  const out = docsTopic(text, args[0]);
  if (out === null) { console.error(`No topic "${args[0]}". Try board, actions, filter, providers or item.`); process.exit(1); }
  process.stdout.write(out);
}
