// The repeats detector and its writes, on crafted transcripts, against a
// throwaway RAVENRY_HOME and temp CLAUDE.md and memory files under .tmp/. The
// model is tools/stub-repeats-claude.mjs, so it spends no quota. Proves:
// incremental offsets (including a truncated file and one replaced under a
// new inode), dedupe, citation keeping, the line-replace guard, Add rule,
// a memory-only rule, Not now and an accepted row coming back.
//
//   node tools/rules-repeats-test.mjs

import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'repeats-test');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
process.env.RAVENRY_HOME = path.join(T, 'mc');
process.env.MC_REPEATS_COMMAND = JSON.stringify([process.execPath, path.join(ROOT, 'tools/stub-repeats-claude.mjs')]);

const { config } = await import('../server/config.mjs');
const repeats = await import('../server/repeats.mjs');
const rules = await import('../server/rules.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const mk = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };
const read = (f) => fs.readFileSync(f, 'utf8');

// ---------------------------------------------------------------- setup
const ALPHA = mk(path.join(T, 'alpha'));
const BETA = mk(path.join(T, 'beta'));
const TR_A = mk(path.join(T, 'tr-alpha'));
const TR_B = mk(path.join(T, 'tr-beta'));
const MEM_A = mk(path.join(T, 'mem-alpha'));
const MEM_B = mk(path.join(T, 'mem-beta'));
const BACKUPS = path.join(T, 'backups');
const GLOBAL = path.join(T, 'global-CLAUDE.md');
const GLOBAL_MD = `# Global rules

## Doing
- Keep fixes small: one check, one screenshot, then deliver. (fix-small,
  one-check)
- Second rule stays as it is. (second-rule)

## Writing
- Never use em dashes. (no-em-dashes)
`;
fs.writeFileSync(GLOBAL, GLOBAL_MD);
fs.writeFileSync(path.join(ALPHA, 'CLAUDE.md'), '# Alpha\n\n- Alpha project rule.\n');
const MEMFILE = path.join(MEM_A, 'store-names.md');
const MEM_MD = '---\nname: store-names\ndescription: "Names only need to be free inside our store"\nmetadata:\n  type: feedback\n---\nBody.\n';
fs.writeFileSync(MEMFILE, MEM_MD);
// The note is older than every crafted message (the scope test uses its age).
const OLD = (Date.now() - 30 * 86400e3) / 1000;
fs.utimesSync(MEMFILE, OLD, OLD);
const cfg = config({
  globalClaudeMd: GLOBAL,
  backupDir: BACKUPS,
  ruleSources: [
    { label: 'Alpha', folder: ALPHA, transcripts: TR_A, memory: MEM_A, claudeMd: path.join(ALPHA, 'CLAUDE.md') },
    { label: 'Beta', folder: BETA, transcripts: TR_B, memory: MEM_B, claudeMd: path.join(BETA, 'CLAUDE.md') },
  ],
});

// After the seed's cutoff (older messages are the data pass's backlog) and
// before now (so a decision made now is newer than them).
let clock = Date.parse('2026-11-03T00:10:00.000Z');
const ts = () => new Date(clock += 60000).toISOString();
let uid = 0;
const typed = (session, text, extra = {}) => JSON.stringify({ type: 'user', uuid: `u${++uid}`, sessionId: session, timestamp: ts(), isSidechain: false, message: { role: 'user', content: text }, ...extra }) + '\n';
const noise = (session) => [
  JSON.stringify({ type: 'assistant', sessionId: session, message: { content: [{ type: 'text', text: '"type":"user" inside an answer' }] } }),
  JSON.stringify({ type: 'user', uuid: `t${++uid}`, sessionId: session, timestamp: ts(), toolUseResult: {}, message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
  JSON.stringify({ type: 'user', uuid: `s${++uid}`, sessionId: session, timestamp: ts(), isSidechain: true, message: { content: 'STUB:new:from-a-subagent' } }),
  JSON.stringify({ type: 'user', uuid: `m${++uid}`, sessionId: session, timestamp: ts(), isMeta: true, message: { content: 'meta' } }),
  JSON.stringify({ type: 'user', uuid: `h${++uid}`, sessionId: session, timestamp: ts(), message: { content: '[ravenry hand-off] read the brief' } }),
  JSON.stringify({ type: 'user', uuid: `h${++uid}`, sessionId: session, timestamp: ts(), message: { content: '[mission-control hand-off] read the brief (asked before the rename)' } }),
  JSON.stringify({ type: 'user', uuid: `n${++uid}`, sessionId: session, timestamp: ts(), origin: { kind: 'task-notification' }, message: { content: 'a task finished' } }),
  JSON.stringify({ type: 'user', uuid: `p${++uid}`, sessionId: session, timestamp: ts(), message: { content: 'Look <system-reminder>hidden</system-reminder> at this <pasted_content id="1">long paste</pasted_content id="1">' } }),
].join('\n') + '\n';

// ---------------------------------------------------------------- 1. prefilter and incremental offsets
{
  const f = path.join(TR_A, 'sess-1.jsonl');
  const half = typed('sess-1', 'Second message, still being written');
  fs.writeFileSync(f, typed('sess-1', 'First message') + noise('sess-1') + half.slice(0, 20));
  const got = [];
  const r1 = await repeats.scanFile(f, null, (x) => got.push(x.text));
  const whole = Buffer.byteLength(read(f)) - 20;
  check('prefilter keeps only typed text (no tool result, sidechain, meta, hand-off, task notification; reminder and paste stripped)', got.length === 2 && got[0] === 'First message' && got[1] === 'Look  at this [pasted]', JSON.stringify(got));
  check('offset stops at the last complete line, not inside a half-written one', r1.next.offset === whole, `${r1.next.offset} vs ${whole}`);
  fs.appendFileSync(f, half.slice(20) + typed('sess-1', 'Third message'));
  const got2 = [];
  const r2 = await repeats.scanFile(f, r1.next, (x) => got2.push(x.text));
  check('next read takes only the new bytes', got2.join('|') === 'Second message, still being written|Third message' && r2.bytes === Buffer.byteLength(read(f)) - r1.next.offset && !r2.reset, JSON.stringify(got2));
  const got3 = [];
  const r3 = await repeats.scanFile(f, r2.next, (x) => got3.push(x));
  check('nothing new: nothing read', got3.length === 0 && r3.bytes === 0);
  // Truncated in place (same inode, now shorter): read again from 0.
  const ino = fs.statSync(f).ino;
  fs.writeFileSync(f, typed('sess-1', 'After truncation'));
  const got4 = [];
  const r4 = await repeats.scanFile(f, r2.next, (x) => got4.push(x.text));
  check('a truncated file (same inode, shorter) is read again from 0', fs.statSync(f).ino === ino && r4.reset && got4.join('|') === 'After truncation', JSON.stringify(got4));
  // Replaced under a new inode, even when it is longer: read again from 0.
  const tmp = f + '.new';
  fs.writeFileSync(tmp, read(f) + typed('sess-1', 'In the replacement') + typed('sess-1', 'And one more'));
  fs.renameSync(tmp, f);
  const got5 = [];
  const r5 = await repeats.scanFile(f, r4.next, (x) => got5.push(x.text));
  check('a file replaced under a new inode is read again from 0', fs.statSync(f).ino !== ino && r5.reset && got5.length === 3, JSON.stringify(got5));
  fs.rmSync(f);
}

// ---------------------------------------------------------------- 2. dedupe
{
  const m = (session, text, k) => ({ session, text, ts: `2026-10-0${k}T10:00:00.000Z` });
  const kept = repeats.dedupe([
    m('s1', 'Stop asking me about alpha', 1),
    m('s1', 'Stop asking me about alpha. I told you 10 times I want prod', 2),
    m('s1', 'stop  asking me about alpha', 3),
    m('s2', 'Stop asking me about alpha', 4),
    m('s1', 'No', 5),
    m('s1', 'No emdashes', 6),
  ]);
  check('dedupe: a message re-sent with an addition counts once, the same text twice counts once, another session counts', kept.length === 4 && kept.filter((x) => x.session === 's1').length === 3, kept.map((x) => x.text).join(' / '));
}

// ---------------------------------------------------------------- 3. citations
{
  check('mergeCite keeps the old citation and merges new names after it', repeats.mergeCite('- New wording here (x-y, a-b)', 'a-b, c-d', ['e-f', 'c-d']) === 'New wording here (a-b, c-d, x-y, e-f)');
  check('mergeCite keeps a citation that is not a plain name list verbatim', repeats.mergeCite('New wording', 'Sam 2026-11-02; extends warn-at-half-context', ['new-name']) === 'New wording (Sam 2026-11-02; extends warn-at-half-context, new-name)');
  check('splitCite hides only a trailing name citation', repeats.splitCite('Do it (his phone shares the cable) now. (adb-target, verify-install)').body === 'Do it (his phone shares the cable) now.' && repeats.splitCite('Ask (why not?)').cite === '');
  const blocks = repeats.parseBlocks(GLOBAL_MD);
  check('a wrapped rule is one line block with its exact text', blocks.length === 3 && blocks[0].raw === '- Keep fixes small: one check, one screenshot, then deliver. (fix-small,\n  one-check)' && blocks[0].heading === 'Doing');
  const mine = repeats.mine(cfg);
  check('Your rules: grouped by heading, citations hidden', mine.count === 3 && mine.groups.map((g) => g.heading).join(',') === 'Doing,Writing' && mine.groups[0].rules[0] === 'Keep fixes small: one check, one screenshot, then deliver.');
}

// ---------------------------------------------------------------- 4. a run: seed, classify, draft
fs.writeFileSync(path.join(TR_A, 'a1.jsonl'), typed('a1', 'Please reword this. STUB:new:reword-me') + typed('a1', 'Add a rule. STUB:new:add-this') + typed('a1', 'Later. STUB:new:later-please') + typed('a1', 'Own store only. STUB:new:memory-here') + typed('a1', 'Cross project. STUB:new:memory-every') + typed('a1', 'Just a question about the build?'));
fs.writeFileSync(path.join(TR_B, 'b1.jsonl'), typed('b1', 'Again: STUB:reword-me Keep it short.') + typed('b1', 'Again: STUB:add-this') + typed('b1', 'Again: STUB:later-please') + typed('b1', 'Elsewhere too: STUB:memory-every'));
fs.writeFileSync(path.join(TR_A, 'a2.jsonl'), typed('a2', 'Again in alpha. STUB:memory-here Only our store.'));
await repeats.ensureSeed(cfg);
const seedState = repeats.load().state.seeded;
check('seed: reads every transcript, no model call, later messages wait for a run', seedState && seedState.pending === repeats.load().messages.size && seedState.files === 3, JSON.stringify(seedState));
const rec = await repeats.run(cfg, { log: () => {} });
check('run: classifies only messages without a verdict', rec.read === 0 && rec.classified === 11 && rec.corrections === 10, JSON.stringify({ read: rec.read, classified: rec.classified, corrections: rec.corrections }));
check('run: clusters reaching 2 sessions are drafted, with tokens logged', ['add-this', 'later-please', 'memory-every', 'memory-here', 'reword-me'].every((id) => rec.drafted.includes(id)) && rec.calls === 2 && rec.tokensIn === 2000, JSON.stringify(rec.drafted));
const runs = read(path.join(process.env.RAVENRY_HOME, 'repeats', 'runs.jsonl')).trim().split('\n');
check('run: one line per run in runs.jsonl', runs.length === 1 && JSON.parse(runs[0]).calls === 2);
const rec2 = await repeats.run(cfg, { log: () => {} });
check('second run with nothing new: no model call', rec2.calls === 0 && rec2.read === 0);

let v = repeats.view(cfg);
const row = (id) => v.rows.find((r) => r.id === id);
check('view: reword, add, memory reword and every project rows', row('reword-me') && row('reword-me').kind === 'reword' && row('add-this').kind === 'add' && row('memory-here').kind === 'reword' && row('memory-every').kind === 'every', v.rows.map((r) => `${r.id}:${r.kind}`).join(' '));
const stored = [...repeats.load().messages.values()].find((x) => x.text.startsWith('Please reword this.'));
const qt = row('reword-me').quote.text;
check('quote is cut from the stored text (message 0, sentence 1), not from model output', stored && qt === '... ' + stored.text.slice('Please reword this. '.length) && row('reword-me').quote.project === 'Alpha', JSON.stringify(row('reword-me').quote));
check('evidence and tails come from plain code', row('reword-me').messages === 2 && row('reword-me').sessions === 2 && row('add-this').tail === 'No rule says this yet.' && row('memory-here').tail === 'Alpha has it in memory and you still said it.' && row('memory-every').tail === 'Only Alpha knows this one.');
check('Rules tab count is the number of rows', repeats.visibleCount(cfg) === v.rows.length);

// ---------------------------------------------------------------- 5. the line-replace guard and citation keeping
{
  const nBackups = () => (fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).length : 0);
  const changed = GLOBAL_MD.replace('then deliver.', 'then deliver it.');
  fs.writeFileSync(GLOBAL, changed);
  const b0 = nBackups();
  let err = null;
  try { repeats.decide('reword-me', 'reword', cfg); } catch (e) { err = e; }
  check('Reword refuses when the line changed since the suggestion, and says so', err && err.status === 409 && /changed since this was suggested/.test(err.message), err && err.message);
  check('a refused reword writes nothing and makes no backup', read(GLOBAL) === changed && nBackups() === b0);
  fs.writeFileSync(GLOBAL, GLOBAL_MD);
  const r = repeats.decide('reword-me', 'reword', cfg);
  const after = read(GLOBAL);
  const expectLine = repeats.wrapRule('Stub line for reword-me (fix-small, one-check)');
  check('Reword replaces exactly that one line, nothing else', after === GLOBAL_MD.replace('- Keep fixes small: one check, one screenshot, then deliver. (fix-small,\n  one-check)', expectLine), JSON.stringify(after.split('\n').slice(3, 6)));
  check('the written line keeps its citations; an invented name from the model is not added', /\(fix-small, one-check\)$/m.test(after) && !after.includes('stub-name'));
  check('Reword takes a timestamped backup first', r.backup[0] && /global-CLAUDE-before-board-rule-\d{8}-\d{6}/.test(path.basename(r.backup[0])) && read(r.backup[0]) === GLOBAL_MD);
  repeats.reset();
  v = repeats.view(cfg);
  check('after an accept the row leaves Suggested', !row('reword-me'));
}

// ---------------------------------------------------------------- 6. Add rule, memory reword, every project
{
  const before = read(GLOBAL);
  repeats.decide('add-this', 'add', cfg);
  check('Add rule appends under "## Added from the board"', read(GLOBAL) === before + '\n## Added from the board\n- Stub line for add-this\n', JSON.stringify(read(GLOBAL).slice(before.length)));
  const g2 = read(GLOBAL);
  repeats.decide('memory-every', 'every', cfg);
  check('Add to every project appends to the global CLAUDE.md with the memory name', read(GLOBAL) === g2 + '- Stub line for memory-every (store-names)\n');
  const aBefore = read(path.join(ALPHA, 'CLAUDE.md'));
  repeats.decide('memory-here', 'reword', cfg);
  check('a memory-only rule: the memory file is untouched', read(MEMFILE) === MEM_MD);
  check('a memory-only rule: the reworded line goes to that project\'s CLAUDE.md under the section', read(path.join(ALPHA, 'CLAUDE.md')) === aBefore + '\n## Added from the board\n- Stub line for memory-here (store-names)\n');
  let err = null;
  try { repeats.decide('later-please', 'reword', cfg); } catch (e) { err = e; }
  check('an action that does not match the row is refused', err && err.status === 400);
}

// ---------------------------------------------------------------- 7. Not now, and rows coming back
{
  repeats.decide('later-please', 'notnow', cfg);
  const rj = JSON.parse(read(path.join(process.env.RAVENRY_HOME, 'rules.json')));
  check('Not now is recorded with a timestamp in rules.json', rj.repeats['later-please'].action === 'notnow' && !Number.isNaN(Date.parse(rj.repeats['later-please'].at)));
  repeats.reset();
  v = repeats.view(cfg);
  check('Not now hides the row', !row('later-please') && !row('add-this'));
  clock = Date.now() + 3600e3;
  fs.writeFileSync(path.join(TR_B, 'b2.jsonl'), typed('b2', 'Said again: STUB:later-please') + typed('b2', 'And again: STUB:add-this'));
  const rec3 = await repeats.run(cfg, { log: () => {} });
  v = repeats.view(cfg);
  check('a newer repeat brings a Not now row back', !!row('later-please'), rec3.read + ' read');
  check('a newer repeat brings an accepted row back, and it is drafted again', !!row('add-this') && rec3.drafted.includes('add-this') && !rec3.drafted.includes('later-please'), JSON.stringify(rec3.drafted));
  check('the board keeps counting after an accept', row('add-this').messages === 3 && row('add-this').sessions === 3);
}

// ---------------------------------------------------------------- 8. the store outlives the transcripts
{
  for (const f of fs.readdirSync(TR_A)) fs.rmSync(path.join(TR_A, f));
  repeats.reset();
  const n = repeats.load().messages.size;
  check('messages stay in the store after their transcripts are gone', n >= 13 && repeats.view(cfg).rows.length > 0, `${n} stored`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
