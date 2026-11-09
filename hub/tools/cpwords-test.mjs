#!/usr/bin/env node
// What a checkpoint says (server/cpwords.mjs): the words the hub attaches
// to every checkpoint, open and after, with the tokens each client fills
// by its fixed rule. Pure functions on crafted checkpoints; no hub. Moved
// from the desktop's and the phone's unit tests when the words moved here.
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import {
  afterOf, checksOf, driveVerb, duration, guessRules, heading, markLabel, markOf, paneInTitle, riskOf, shortCommand, splitTitle, topLabel, variantsOf, wantsLine, warningsOf, withWords, wordsOf,
} from '../server/cpwords.mjs';

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const is = (name, got, want) => check(name, eq(got, want), eq(got, want) ? '' : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const NOW = new Date(2026, 10, 6, 17, 36, 0).getTime();
const at = (min) => new Date(NOW - min * 60000).toISOString();
const hm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// A client's rule for the tokens (cpwords.mjs header): `me` is the `by` its
// answers carry, `onHub` whether it runs on the hub's computer.
const fill = (s, w, { me = 'desktop', onHub = true, pane = null } = {}) => String(s)
  .replace(/\{machine\}/g, onHub ? w.machine.here : w.machine.away)
  .replace(/\{where\}/g, w.after ? (w.after.where.by === me ? w.after.where.mine : w.after.where.other) : '')
  .replace(/\{time\}/g, w.after && w.after.at ? hm(w.after.at) : '')
  .replace(/\{pane\}/g, pane || (w.drive ? w.drive.pane : ''));
const said = (cp, ctx = {}, how = {}) => { const w = wordsOf(cp, { platform: 'darwin', hubName: 'Studio', ...ctx }); return { w, a: w.after ? { ...w.after, head: fill(w.after.head, w, how), text: fill(w.after.text, w, how) } : null }; };

const ask = {
  id: 'cask0001', kind: 'ask', state: 'open', title: 'Ship the beta to the testers?\nThe settings screen is done and all 64 tests pass.',
  pane: 'paaaaaaa', assistant: 'claude', options: ['Ship it', 'Not yet'], free_text: true, created_at: at(2), expires_at: new Date(2026, 10, 6, 18, 4).toISOString(),
};
const approve = {
  id: 'capp0001', kind: 'approve', state: 'open', title: 'git push origin main && npm publish', command: 'git push origin main && npm publish', cwd: '/home/you/code/recipe-box',
  why: 'The import tests pass.', pane: 'pbbbbbbb', assistant: 'codex', created_at: at(3), expires_at: new Date(2026, 10, 6, 18, 3).toISOString(), machine: 'devbox',
};
const secret = {
  id: 'csec0001', kind: 'secret', state: 'open', title: 'Mail service API key', command: 'npx wrangler secret put MAIL_API_KEY', cwd: '/home/you/Projects/garden-planner',
  secret: { to: 'run', enter: true }, pane: 'pccccccc', assistant: 'claude', created_at: at(1), expires_at: new Date(2026, 10, 6, 18, 1).toISOString(),
};
const drive = (over = {}) => ({
  id: 'cdrive01', kind: 'drive', title: 'Let the agent in pane pa type into "dev server" (pane pb)?', state: 'open', created_at: '2026-11-07T10:00:00.000Z', expires_at: '2026-11-07T11:00:00.000Z', assistant: 'claude', ...over,
});

// ------------------------------------------------ open
is('heading: ask', heading(ask), 'Claude asks');
is('heading: approve', heading(approve), 'Codex wants to run');
is('heading: secret', heading(secret), 'Claude needs a secret');
is('heading: no assistant', heading({ ...ask, assistant: undefined }), 'The agent asks');
is('heading: unknown kind', heading({ ...ask, kind: 'poll' }), 'Claude is waiting');
is('heading: a page run', heading({ ...approve, page: { title: 'Map tiles', label: 'Rebuild' } }), 'Map tiles: Rebuild');
is('title split', splitTitle(ask.title), { head: 'Ship the beta to the testers?', body: 'The settings screen is done and all 64 tests pass.' });
is('title one line', splitTitle('One line'), { head: 'One line', body: null });

{
  const w = wordsOf(approve, { platform: 'darwin', hubName: 'Studio' });
  is('remote machine: its name everywhere', [w.machine.remote, w.machine.here, w.machine.away, fill(w.runLabel, w)], [true, 'devbox', 'devbox', 'Run on devbox']);
  const l = wordsOf({ ...approve, machine: null }, { platform: 'darwin', hubName: 'Studio' });
  is('this Mac here, its name on the phone', [fill(l.runLabel, l), fill(l.runLabel, l, { onHub: false }), l.machine.line], ['Run on this Mac', 'Run on Studio', 'This Mac']);
  is('this computer off a Mac', fill(wordsOf({ ...approve, machine: 'local' }, { platform: 'linux' }).runLabel, wordsOf({ ...approve, machine: 'local' }, { platform: 'linux' })), 'Run on this computer');
  is('every word of an open checkpoint has a state and no after', [w.v, w.state, w.kind, w.who, w.whoMid, w.after], [1, 'open', 'approve', 'Codex', 'Codex', null]);
  is('the agent\'s words mid-sentence', wordsOf({ ...ask, assistant: null }).whoMid, 'the agent');
}

is('risk: npm', riskOf('git push origin main && npm publish'), 'Publishing to npm can\'t be undone');
is('risk: npm workspace', riskOf('npm --workspace x publish --tag beta'), 'Publishing to npm can\'t be undone');
is('risk: force push', riskOf('git push --force origin main'), 'A force push can\'t be undone');
is('risk: rm -rf', riskOf('rm -rf build'), 'Deleting with rm -rf can\'t be undone');
is('risk: plain push', riskOf('git push origin main'), null);
is('risk: npm test', riskOf('npm test'), null);
is('risk: drop table', riskOf('psql -c "DROP TABLE users"'), 'Dropping data can\'t be undone');

is('only Ravenry\'s guess, labelled as Ravenry\'s', warningsOf(approve), [{ from: 'ravenry', label: 'Ravenry\'s guess:', text: 'Publishing to npm can\'t be undone' }]);
is('the agent\'s warning never hides the guess', warningsOf({ ...approve, warning: 'Nothing here can go wrong' }).map((w) => `${w.from}|${w.label} ${w.text}`), ['agent|Codex warns: Nothing here can go wrong', 'ravenry|Ravenry\'s guess: Publishing to npm can\'t be undone']);
is('the agent\'s warning alone', warningsOf({ ...approve, command: 'make deploy', warning: 'This restarts the production server' }).map((w) => w.from), ['agent']);
is('a blank warning is none', warningsOf({ ...approve, warning: '  ' }, 'npm test'), []);
{
  // The rules as data say the same guess as the hub, for any edited command.
  const rules = guessRules().map((r) => ({ re: new RegExp(r.pattern, r.flags), text: r.text }));
  const guess = (c) => (rules.find((r) => r.re.test(c)) || { text: null }).text;
  const cmds = ['git push origin main && npm publish', 'git push origin main', 'cargo publish', 'git push -f', 'git clean -fdx', 'DROP DATABASE x', 'kubectl delete pod a', 'gh release create v1', 'npm test'];
  is('the guess rules sent as data guess as the hub does', cmds.map(guess), cmds.map(riskOf));
  is('an approve carries the rules, others none', [wordsOf(approve).guess.label, wordsOf(approve).guess.rules.length > 10, wordsOf(ask).guess], ['Ravenry\'s guess:', true, null]);
}

// ------------------------------------------------ marks
is('mark: ask', markOf(ask), { kind: 'ask', text: 'Ship the beta to the testers?', code: false, label: 'Checkpoint:' });
is('mark: approve', markOf(approve), { kind: 'approve', text: 'git push origin main && npm publish', code: true, label: 'Wants to run:' });
is('mark: secret', markOf(secret), { kind: 'secret', text: 'Wants the mail service API key', code: false, label: 'Needs a secret:' });
is('wants: a name keeps its case', wantsLine('GitHub token'), 'Wants the GitHub token');
is('wants: an acronym keeps its case', wantsLine('AWS secret key'), 'Wants the AWS secret key');
is('mark labels', ['ask', 'approve', 'secret', 'pick', 'drive', 'review'].map(markLabel), ['Checkpoint:', 'Wants to run:', 'Needs a secret:', 'Pick one:', 'Asks first:', 'Checkpoint:']);

// ------------------------------------------------ after
{
  const ed = { ...approve, state: 'answered', answer: { approved: true, command: 'npm publish --tag beta', by: 'desktop', at: at(1) }, closed_at: at(0), run: { pane: 'pd', exit: { code: 0 } } };
  const { a } = said(ed);
  is('an edited run: the command that ran', [a.command, a.edited], ['npm publish --tag beta', true]);
  check('an edited run says so', /You edited it and approved it here; Codex has the output and knows you changed it\./.test(a.text), a.text);
  const running = said({ ...ed, state: 'running', run: { pane: 'pd' } }).a;
  check('an edited run running', /You edited it and approved it here\. Codex gets the output when it ends, and is told you changed it\./.test(running.text), running.text);
  const plain = said({ ...ed, answer: { approved: true, by: 'desktop', at: at(1) } }).a;
  is('a plain run', [plain.command, plain.edited], [approve.command, false]);
  is('refused with a reason, here', said({ ...approve, state: 'declined', closed_at: at(0), answer: { declined: true, reason: 'Run the tests first', by: 'desktop', at: at(0) } }).a.text, 'You said no here: "Run the tests first". Codex was told.');
  is('refused on the phone, seen on the desktop', said({ ...approve, state: 'declined', closed_at: at(0), answer: { declined: true, by: 'phone', at: at(0) } }).a.text, 'You said no on your phone. Codex was told.');
  is('refused on the phone, seen on the phone', said({ ...approve, state: 'declined', closed_at: at(0), answer: { declined: true, by: 'phone', at: at(0) } }, {}, { me: 'phone', onHub: false }).a.text, 'You said no here. Codex was told.');
  is('refused on the desktop, seen on the phone', said({ ...approve, state: 'declined', closed_at: at(0), answer: { declined: true, by: 'desktop', at: at(0) } }, {}, { me: 'phone', onHub: false }).a.text, 'You said no from desktop. Codex was told.');

  const asked = said({ ...ask, state: 'answered', closed_at: at(0), answer: { choice: 0, option: 'Ship it', by: 'phone', at: at(0) } }).a;
  is('answered on the phone', [asked.ok, asked.head, asked.small, asked.big, asked.text, hm(asked.at)], [true, 'Answered', 'Ship the beta to the testers?', 'Ship it', 'You answered on your phone.', '17:36']);
  const typed = said({ ...ask, state: 'answered', closed_at: at(0), answer: { text: 'Not yet, after the fix', by: 'desktop', at: at(0) } }).a;
  is('answered in words, here', [typed.big, typed.text], ['Not yet, after the fix', 'You answered here.']);
  const ran = said({ ...approve, state: 'answered', answer: { approved: true, by: 'desktop', at: at(0.1) }, closed_at: new Date(NOW).toISOString(), run: { pane: 'pdddddddd', exit: { code: 0 } } }).a;
  is('ran on a machine', [ran.head, ran.text, ran.runPane], ['Ran on devbox', 'Finished in 6 s with no errors. You approved it here; Codex has the output.', 'pdddddddd']);
  const failedRun = said({ ...approve, machine: null, state: 'answered', answer: { approved: true, by: 'desktop', at: at(1) }, closed_at: at(0), run: { pane: 'pd', exit: { code: 2 } } }).a;
  is('a failed run here', [failedRun.ok, failedRun.head], [false, 'Ran on this Mac']);
  check('a failed run says its exit code', /^Ended with exit code 2 after 1 min\./.test(failedRun.text), failedRun.text);
  is('a run here, said on the phone', said({ ...approve, machine: null, state: 'answered', answer: { approved: true, by: 'desktop', at: at(1) }, closed_at: at(0), run: { exit: { code: 0 } } }, {}, { me: 'phone', onHub: false }).a.head, 'Ran on Studio');
  const runningNow = said({ ...approve, state: 'running', answer: { approved: true, by: 'desktop', at: at(0) }, run: { pane: 'pd' } }).a;
  is('running on a machine, since its approval', [runningNow.head, runningNow.at], ['Running on devbox', at(0)]);
  const sent = said({ ...secret, state: 'answered', closed_at: at(0), answer: { delivered: true, by: 'desktop', at: at(0) } }).a;
  is('a secret sent', [sent.head, sent.big, sent.text], ['Secret sent', 'Mail service API key', 'Sent to wrangler secret put. Ravenry didn\'t keep a copy, so it can\'t be shown again. To change it, Claude has to ask again.']);
  is('refused', said({ ...approve, state: 'declined', closed_at: at(0), answer: { declined: true, by: 'desktop', at: at(0) } }).a.head, 'Refused');
  const expired = said({ ...ask, state: 'expired', closed_at: at(0) }).a;
  is('nobody answered', [expired.head, expired.text], ['Nobody answered', 'Claude gave up waiting at 17:36.']);
  is('nobody answered, no close time: its end', said({ ...ask, state: 'expired' }).a.text, 'Claude gave up waiting at 18:04.');
  check('withdrawn says why', /withdrew it: done another way/.test(said({ ...ask, state: 'cancelled', reason: 'done another way', closed_at: at(0) }).a.text));
  is('short command', [shortCommand('npx wrangler secret put MAIL_API_KEY'), shortCommand('gh secret set TOKEN')], ['wrangler secret put', 'gh secret set']);
  is('durations', [duration(6000), duration(80000)], ['6 s', '1 min 20 s']);
}

// ------------------------------------------------ drives and picks
{
  const type = drive({ drive: { pane: 'pb', agent: { kind: 'agent', pane: 'pa' }, input: '<Ctrl+C>npm run dev<Enter>' } });
  is('a drive says its action in its heading', heading(type), 'Claude wants to type');
  is('its buttons and its row', [driveVerb(type).once, driveVerb(type).session, driveVerb(type).row], ['Let it type this', 'Let it use this pane', 'Wants to type in']);
  const close = drive({ drive: { pane: 'pb', agent: { kind: 'agent', pane: 'pa' }, action: 'close' } });
  is('a close', [heading(close), driveVerb(close).once, driveVerb(close).session], ['Claude wants to close', 'Let it close', null]);
  is('a restart', driveVerb(drive({ drive: { pane: 'pb', action: 'restart' } })).once, 'Let it restart');
  const answered = { ...type, state: 'answered', closed_at: '2026-11-07T10:01:00.000Z', answer: { approved: true, allow: 'session', by: 'desktop', at: '2026-11-07T10:01:00.000Z' } };
  check('a drive let for its session says so', /until its session ends/.test(said(answered).a.text));

  // The pane named as the sidebar does, else as the daemon's title does, never by id.
  const w = wordsOf(type, { paneName: (p) => (p === 'pb' ? 'Dev server' : null) });
  is('a drive names its pane as the sidebar does', [w.drive.pane, w.mark.text, w.drive.title, w.drive.sessionSub], ['Dev server', 'Wants to type in Dev server', 'Let it type in {pane}?', 'Until its session ends or you take it back']);
  is('the hub\'s own name for the pane wins', wordsOf({ ...type, drive: { ...type.drive, name: 'tests' } }).drive.pane, 'tests');
  is('else the name in its title', wordsOf(type).drive.pane, 'dev server');
  is('else another tab', wordsOf({ ...type, title: 'Let it type?' }).drive.pane, 'another tab');
  is('the mark names a pane it cannot name', wordsOf({ ...type, title: 'Let it type?' }).mark.text, 'Wants to type in a pane');
  const ph = (cp) => { const x = wordsOf(cp); return { title: fill(x.drive.phone.title, x, { pane: x.drive.pane }), what: x.drive.phone.what, yes: x.drive.phone.yes.map((y) => [y.allow, y.label]) }; };
  is('the phone: typing', ph(type), { title: 'Claude wants to type in dev server', what: null, yes: [['once', 'Allow once'], ['session', 'This session']] });
  is('the phone: a close', ph(close), { title: 'Claude wants to close dev server', what: 'Whatever runs there stops.', yes: [['once', 'Let it close']] });
  is('the phone: a restart', ph(drive({ assistant: 'codex', title: 'x "tests" (pane p1)', drive: { pane: 'p1', action: 'restart' } })).title, 'Codex wants to restart tests');
  is('the phone: an override', ph(drive({ assistant: 'codex', title: 'x "tui" (pane p1)', drive: { pane: 'p1', action: 'override' } })).title, 'Codex wants to change how tui runs');
  is('a pane in a daemon\'s title', [paneInTitle('Let Claude close "dev server" (pane pk3m9q2x)?'), paneInTitle('Let Claude close pane pk3m9q2x?')], ['dev server', null]);

  const pick = drive({ kind: 'pick', title: 'Which tilt reads best?\nRendered at frame 412.', drive: undefined, variants: [{ label: 'Level' }, { label: 'Tilt with the slope', description: 'The hull follows the wave\'s angle at the bow.' }, { label: 'Half. The slope' }] });
  is('a pick asks you to pick', [heading(pick), markOf(pick).text], ['Claude asks you to pick', 'Pick one of 3: Which tilt reads best?']);
  is('a pick names each variant by letter and label, with the agent\'s words', variantsOf(pick), [
    { letter: 'A', name: 'Level', says: null },
    { letter: 'B', name: 'Tilt with the slope', says: 'Claude: The hull follows the wave\'s angle at the bow.' },
    { letter: 'C', name: 'Half. The slope', says: null },
  ]);
  is('picked, with a note', said({ ...pick, state: 'answered', closed_at: at(0), answer: { pick: { label: 'B', note: 'less' }, by: 'phone', at: at(0) } }).a.big, 'B, with a note: "less"');
}

// ------------------------------------------------ the phone's top label and checks
const cp = (x) => ({ id: 'c1', kind: 'ask', state: 'open', title: 'Ship it?', created_at: at(2), ...x });
is('top: ask', topLabel(cp({ assistant: 'claude' })), 'Claude is waiting for you');
is('top: approve', topLabel(cp({ kind: 'approve', assistant: 'codex' })), 'Codex wants to run a command');
is('top: secret', topLabel(cp({ kind: 'secret', assistant: 'claude' })), 'Claude needs a secret');
is('top: a page run', topLabel(cp({ kind: 'approve', assistant: 'claude', page: { title: 'Map tiles', label: 'Rebuild' } })), 'Map tiles wants to run a command');
is('top: pick and drive', [topLabel(cp({ kind: 'pick', assistant: 'claude' })), topLabel(cp({ kind: 'drive', assistant: 'claude' }))], ['Claude wants you to pick', 'Claude is asking first']);
{
  const c = checksOf('Build 0.9.4 is on the tablet.\n1. The lobby loads in under 10 seconds\n2. Both hands show');
  is('a numbered list becomes checks', [c.text, c.checks], ['Build 0.9.4 is on the tablet.', ['The lobby loads in under 10 seconds', 'Both hands show']]);
  is('one line has none', checksOf('One line only').checks, []);
  is('no body', checksOf(null).text, null);
  is('the words carry them', wordsOf(cp({ title: 'Check it\nOn the tablet.\n1. a\n2. b' })).checks, { text: 'On the tablet.', checks: ['a', 'b'] });
}

// ------------------------------------------------ withWords
{
  const stale = { ...ask, state: 'answered', closed_at: at(0), answer: { option: 'Ship it', by: 'desktop', at: at(0) }, words: { state: 'open', heading: 'old' } };
  const w = withWords(stale, {}).words;
  is('words are made again for the copy\'s state', [w.state, w.after.head], ['answered', 'Answered']);
  is('a secret checkpoint names its field', wordsOf(secret).secret, { noun: 'key', to: 'run' });
  is('a token, a password', [wordsOf({ ...secret, title: 'GitHub token' }).secret.noun, wordsOf({ ...secret, title: 'DB password' }).secret.noun, wordsOf({ ...secret, title: 'Thing' }).secret.noun], ['token', 'password', 'secret']);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
