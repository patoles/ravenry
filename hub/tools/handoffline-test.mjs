#!/usr/bin/env node
// The hand-off card's line (server/handoffline.mjs): the first useful
// sentence of a brief's Hand-off entry, cut at a word, as every client's card
// draws it at most two lines; the whole entry stays in the timeline's `full`.
// Pure functions, then the hub's state on a brief (a hub in a test home).
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import { handoffLine, sentencesOf, onlyNamesASession, cutAtWord, MAX } from '../server/handoffline.mjs';

let failed = 0, passed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (ok) passed++; else failed++; };
const is = (name, got, want) => check(name, got === want, got === want ? '' : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// The entry a session wrote on 2026-11-12 (the mockup's card A, names swapped), about 1730 characters.
export const LONG = "Session 25204b9f (ravenry-1d) is main. Native 0.1.37+00eedd8 INSTALLED 00:39 (integration: 5d1bfe4 schema/types, b6bd411 SIGTERM with a dialog up, 5b80f8c bump, 00eedd8 three flakes; selftest 185/185, sidetest 36 runs 2021 checks 0 failed, scripts pass, installcheck 20/23 = 3 update steps need a same-version Electron build). Launched clean, app.log 'launch: native app 0.1.37', board 200, doctor all good, 0.1.36 daemon had no panes. Rollback: session 25204b9f scratchpad rollback-native-0.1.36-4807fd8.zip. build4 running (rules session 25204b9f scratchpad/build4/RULES.md): scope 1 A11Y-003 remaining screens + TERM-070, WIN-007, PANEL-027, HUB-009, PAGE-018 Electron, UPD-017; scope 2 the five hub phone tests via a loopback test-only switch the release refuses (decided: never reopen Wi-Fi). Then main integrates 0.1.38. 01:00 the user agreed: native panel's Reply box only for sessions that cannot be typed into (outside terminal or read only), hidden for Ravenry panes; board and phone unchanged; added to scope 1. 01:10 scope 2 DONE (7cbb0d2..fff9e89): MC_TEST_PHONE_PORT gives a test board a 127.0.0.1 listener whose callers count as a phone; hub exits 2 on non-test data, release Gate exits 2 (gatecheck 20/20); alerts 96, phone-access 60, projects-root 55, open-folder 9, new-project-folder 46, all pass. For the 0.1.38 integration: tools/audit.mjs has 12 findings from earlier work ('the user' in comments in app.ts, macos README, Ink.swift, Cursors.swift, SelfTest*.swift; 'Kite' in SelfTestRemotePanel.swift; a UUID in SelfTestBoard.swift): fix before public. Decided: release keeps passing the hub's other MC_* variables (MC_HOME, MC_OPEN_COMMAND...), the person's own service env, not a gap worth a gate change.";

// 1. The long entry: its id-only first sentence skipped, the next one cut at a word.
const a = handoffLine(LONG);
check('long entry: the line is short', LONG.length > 1700 && a.length <= MAX, `${LONG.length} -> ${a.length}`);
check('long entry: "Session <id> (<name>) is main." skipped', a.startsWith('Native 0.1.37+00eedd8 INSTALLED 00:39') && !/25204b9f|ravenry-1d/.test(a), a);
check('long entry: cut at a word, with "…"', a.endsWith('…') && LONG.includes(a.slice(0, -1)) && /[\s,;:)]/.test(LONG[LONG.indexOf(a.slice(0, -1)) + a.length - 1]), a);

// 2. A first sentence that only names a session, in its usual shapes.
is('id and name only: skipped', handoffLine('Session 25204b9f (ravenry-1d) is main. Fixed the header at 390 px. Then pricing.'), 'Fixed the header at 390 px.');
is('a continued session: skipped', handoffLine('Continued from ravenry-19. Shipped the pricing page.'), 'Shipped the pricing page.');
is('a name with dashes: skipped', handoffLine('This is garden-planner-8e, the main session. The boat no longer clips the dock.'), 'The boat no longer clips the dock.');
check('an id in a sentence that says more: kept', handoffLine('Merged 5d1bfe4 into main. Then more.') === 'Merged 5d1bfe4 into main.');
check('onlyNamesASession: plain words are not a session', !onlyNamesASession('This is main.') && !onlyNamesASession('Released 0.3.0.') && onlyNamesASession('Session 25204b9f is main.'));
check('onlyNamesASession: a name the board knows', onlyNamesASession('Took over from garden.', new Set(['garden'])));
is('every sentence only names a session: no line', handoffLine('Session 25204b9f is main. Continued from ravenry-19.'), '');

// 3. No sentence end at all (the mockup's card B2): the entry, cut the same way.
const noEnd = LONG.replace(/\. (?=[A-Z0-9])/g, '; ').replace(/^Session 25204b9f \(ravenry-1d\) is main; /, '');
const b2 = handoffLine(noEnd);
check('no sentence end: one sentence', sentencesOf(noEnd).length === 1);
check('no sentence end: still at most the cap, cut at a word', b2.length <= MAX && b2.endsWith('…') && b2.startsWith('Native 0.1.37+00eedd8 INSTALLED') && noEnd.startsWith(b2.slice(0, -1)) && noEnd[b2.length - 1] === ' ', b2);
const word = 'x'.repeat(300);
check('one long word: cut hard, with "…"', handoffLine(word).length === MAX && handoffLine(word).endsWith('…'));

// 4. A short well-formed line: whole, as written.
is('short line: whole', handoffLine('0.1.37 installed; build4 round running toward 0.1.38'), '0.1.37 installed; build4 round running toward 0.1.38');
is('short sentence: whole', handoffLine('The pricing page is live.'), 'The pricing page is live.');

// 5. Dots inside brackets are not ends.
is('brackets: dots inside are not an end', handoffLine('Ran the suite (see a.md. Then b.md) and it passed. Next is pricing.'), 'Ran the suite (see a.md. Then b.md) and it passed.');
is('square brackets too', handoffLine('Moved the notes [kept in old.md. See new.md] to the brief. Done.'), 'Moved the notes [kept in old.md. See new.md] to the brief.');
is('an unclosed bracket: no end after it, cut at the cap', handoffLine('Fixed (the header. And more.'), 'Fixed (the header. And more.');

// 6. Versions and abbreviations are not ends.
is('a version inside a sentence', handoffLine('Installed 0.1.37 on the Mac and 0.1.38 is next. Then pricing.'), 'Installed 0.1.37 on the Mac and 0.1.38 is next.');
is('a version ending a sentence', handoffLine('Released 0.3.0. Next the header.'), 'Released 0.3.0.');
is('e.g. is not an end', handoffLine('Kept the old shapes, e.g. Round and Square. Then more.'), 'Kept the old shapes, e.g. Round and Square.');
is('a file name is not an end', handoffLine('Wrote app.log and BRIEF.md for the next one'), 'Wrote app.log and BRIEF.md for the next one');

// 7. Nothing, and the cut itself.
is('nothing', handoffLine(''), '');
is('cutAtWord: under the cap untouched', cutAtWord('a b c', 10), 'a b c');
is('cutAtWord: at a word, trailing comma dropped', cutAtWord('alpha beta, gamma delta', 15), 'alpha beta…');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
