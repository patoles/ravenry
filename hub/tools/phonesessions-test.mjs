#!/usr/bin/env node
// What the phone shows to start, continue and move a session
// (server/phonesessions.mjs): which choice a session or a project offers and
// its words, in the shared strings, said for a device away from the Mac.
// Pure; reads only the repository's shared/strings/en.json. The routes that
// carry it, driven by a phone: apps/phone/tools/sessions-web-check.mjs.
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import { moveView, lastView, startWords, startedSay, resumedSay, computerWord } from '../server/phonesessions.mjs';

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const mac = { platform: 'darwin' };
const s = (x) => ({ sessionId: 'c3c3c3c3-0000-4000-8000-000000000003', assistant: 'claude', surfaceId: 'X', ...x });

check('the computer: your Mac, else your computer', computerWord('darwin') === 'your Mac' && computerWord('linux') === 'your computer');

// 06a: in cmux, open there.
let v = moveView(s({ outside: { name: 'cmux', open: true }, working: true }), mac);
check('in cmux mid-turn: Move to Ravenry, after this turn', v && v.kind === 'move' && v.head === 'Runs in cmux on your Mac' && v.text === 'Move to Ravenry ends it in cmux and picks up this conversation in a Ravenry pane on your Mac. Claude is working, so it moves when this turn ends.' && v.move === 'Move to Ravenry', JSON.stringify(v));
v = moveView(s({ outside: { name: 'iTerm2', open: true }, working: false, assistant: 'codex' }), mac);
check('in iTerm2 at rest: no turn sentence', v && v.kind === 'move' && v.text === 'Move to Ravenry ends it in iTerm2 and picks up this conversation in a Ravenry pane on your Mac.', JSON.stringify(v));
check('ended there: nothing to move', moveView(s({ outside: { name: 'cmux', open: false, resumable: true } }), mac) === null);
// 06b: a move waits for its turn.
v = moveView(s({ outside: { name: 'cmux', open: true }, working: true, moving: { waiting: true, keep: 'ravenry', name: 'cmux' } }), mac);
check('waiting: moves when Claude finishes its turn', v && v.kind === 'waiting' && v.text === 'Moves to Ravenry when Claude finishes its turn in cmux.', JSON.stringify(v));
v = moveView(s({ alsoOpen: { name: 'cmux' }, assistant: 'codex', moving: { waiting: true, keep: 'outside', name: 'Ravenry' } }), mac);
check('waiting to keep it there', v && v.kind === 'waiting' && v.keep === 'outside' && v.text === 'Keeps it in cmux when Codex finishes its turn.', JSON.stringify(v));
// 07: open in two places.
v = moveView(s({ surfaceId: 'ravenry:p1', alsoOpen: { name: 'cmux', term: 'cmux' } }), mac);
check('also open: keep one', v && v.kind === 'also' && v.head === 'Also open in cmux' && v.text === 'This conversation runs in Ravenry and in cmux on your Mac. Both write to it, so keep one.' && v.keep === 'Keep it in Ravenry' && v.keepOther === 'Keep it in cmux', JSON.stringify(v));
v = moveView(s({ surfaceId: 'ravenry:p1', movedOn: { name: 'cmux' } }), mac);
check('went on elsewhere: Move to Ravenry picks up the latest', v && v.kind === 'wentOn' && v.head === 'Went on in cmux' && /picks up the latest in a new Ravenry pane/.test(v.text), JSON.stringify(v));
check('on another machine, or with no session id: nothing', moveView(s({ machine: 'devbox', outside: { name: 'cmux', open: true } }), mac) === null && moveView(s({ sessionId: null, outside: { name: 'cmux', open: true } }), mac) === null);
check('another assistant: nothing', moveView(s({ assistant: 'gemini', outside: { name: 'cmux', open: true } }), mac) === null);
check('a Linux hub says your computer', moveView(s({ outside: { name: 'cmux', open: true } }), { platform: 'linux' }).head === 'Runs in cmux on your computer');

// 04, 05: an idle project's last conversation.
const last = { sessionId: 'f6f6f6f6-0000-4000-8000-000000000006', assistant: 'claude', title: 'Dark theme for the gallery', openIn: null };
v = lastView(last, mac);
check('Continue this conversation', v && v.action === 'continue' && v.words.head === 'Last conversation' && v.words.chip === 'Claude Code' && v.words.you === 'You' && v.words.who === 'Claude' && v.words.continue === 'Continue this conversation' && v.words.note === 'Picks it up in a Ravenry pane on your Mac. You watch and type from here.' && v.words.newHere === 'New session here' && v.words.stopped === 'Stopped {when}', JSON.stringify(v));
v = lastView({ ...last, openIn: { ravenry: false, name: 'iTerm2' } }, mac);
check('still open in iTerm2: Move to Ravenry, never Continue', v && v.action === 'move' && !v.words.continue && v.words.stillOpen === 'Still open in iTerm2 on your Mac' && v.words.moveText === 'Move to Ravenry ends it in iTerm2 and picks it up in a Ravenry pane on your Mac, so it never runs twice.' && v.words.move === 'Move to Ravenry', JSON.stringify(v));
check('open in a Ravenry pane already, or none: no card', lastView({ ...last, openIn: { ravenry: true, pane: 'p1' } }, mac) === null && lastView(null, mac) === null);
check('Codex: its chip and name', lastView({ ...last, assistant: 'codex' }, mac).words.chip === 'Codex' && lastView({ ...last, assistant: 'codex' }, mac).words.who === 'Codex');

// 02: New session's words, none left as a key.
const w = startWords(mac);
const keys = (o) => Object.values(o).flatMap((x) => (typeof x === 'string' ? [x] : keys(x)));
check('every word is a word, not a key', keys(w).every((x) => !/^(start|pstart|psess|project)\.[a-zA-Z.]+$/.test(x)), keys(w).filter((x) => /^(start|pstart|psess)\./.test(x)).join(', '));
check('the page\'s words', w.title === 'New session' && w.runsOn === 'Runs on' && w.thisMac === 'This Mac' && w.project === 'Project' && w.allProjects === 'All projects' && w.signedIn === 'Signed in' && w.notFound === 'Not on your Mac' && w.firstMessagePh === 'What should it do? Left empty, it reads the brief first.' && w.go === 'Start {assistant} in {folder}' && w.goOn === 'Start {assistant} on {machine}', JSON.stringify(w));

// 03: the toast.
check('started: in the project, on its own branch, on a machine', startedSay({ assistant: 'claude', folder: 'paper-boat' }) === 'Started Claude Code in paper-boat.' && startedSay({ assistant: 'claude', folder: 'paper-boat', worktree: true }) === 'Started Claude Code in paper-boat, on its own branch.' && startedSay({ assistant: 'codex', folder: 'x', machine: 'devbox' }) === 'Started Codex on devbox.');
check('continued, moved, kept there', resumedSay(mac) === 'Continued it in a Ravenry pane on your Mac.' && resumedSay({ moved: true, ...mac }) === 'Moved it to a Ravenry pane on your Mac.' && resumedSay({ moved: true, keep: 'outside', where: 'cmux' }) === 'Kept it in cmux. The Ravenry copy ended.');

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
