#!/usr/bin/env node
// The hub's words from the shared file (server/strings.mjs, shared/README.md):
// the sidebar's section titles under group.you, group.work, group.wait and
// group.idle, placeholders, an unknown key, and the file's format (one
// string per key, keys as dotted lowerCamel words). Pure; reads only the
// repository's shared/strings/en.json.
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import { t, format, strings } from '../server/strings.mjs';

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

check('section titles', t('group.you') === 'Needs you' && t('group.work') === 'Working' && t('group.wait') === 'Waiting on others' && t('group.idle') === 'Idle');
check('placeholders filled', format('Waiting on {name} since {time}', { name: 'Ada', time: '9:41' }) === 'Waiting on Ada since 9:41');
check('a placeholder without a value stays', format('Hello {name}', {}) === 'Hello {name}');
check('no vars: the text as it is', format('{x} as is') === '{x} as is');
check('an unknown key comes back as the key', t('no.such.key') === 'no.such.key');
check('$comment is not a string', t('$comment') === '$comment');

const raw = JSON.parse(fs.readFileSync(new URL('../../shared/strings/en.json', import.meta.url), 'utf8'));
check('the hub reads the repository file', JSON.stringify(strings()) === JSON.stringify(raw));
const bad = Object.entries(raw).filter(([k, v]) => k !== '$comment' && (!/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(k) || typeof v !== 'string' || !v));
check('every key is dotted lowerCamel with a string', bad.length === 0, bad.map(([k]) => k).join(', '));
const dashes = Object.entries(raw).filter(([, v]) => /\u2014/.test(v));
check('no em dash in the words', dashes.length === 0, dashes.map(([k]) => k).join(', '));
// The phone's connection words never say "home": the phone may be on any Wi-Fi the Mac is on (Simon, 2026-11-13).
const homes = Object.entries(raw).filter(([k, v]) => k.startsWith('phone.') && /\bhome\b/i.test(v));
check('no "home" in the phone card\'s connection words', homes.length === 0, homes.map(([k]) => k).join(', '));

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
