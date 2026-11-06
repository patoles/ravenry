#!/usr/bin/env node
// Files in planning:
// - the plan format's References (parse, write, round trip through a brief),
//   the attached-file guard, the planner call's argv (the Read tool for
//   exactly the attached files, the strict settings kept), the start prompt;
// - a test board on :4677 (fake cmux, the stub model): the composer's inbox
//   route the sheet reuses, a draft, a comment and a chat message with files,
//   the picture route for references, Start writing References into the
//   brief and into the command a Revive would run.
// No model call, no real cmux. Touches only .tmp/.
//
// Usage: node tools/plan-files-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'plan-files');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const UNIT_MC = path.join(T, 'unit-mc');
process.env.RAVENRY_HOME = UNIT_MC;

const fmt = await import('../server/planfmt.mjs');
const brief = await import('../server/brief.mjs');
const planner = await import('../server/planner.mjs');
const planrun = await import('../server/planrun.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

// ------------------------------------------------------------ the format
const PLAN_MD = `## Plan
### Cozy menu
Runs on its own. Started: 2026-11-03 14:02. Not in the plan: stop and ask.
Goal: "Make the menu feel cozy"
References:
  - .inbox/cozy.png: I like this style
  - .inbox/notes.pdf
Rules: work the steps in order

- [ ] Do: Match the look of .inbox/cozy.png
- [ ] Gate: Show me before building
  - Choices: Looks right | Change it

Log:
- 14:02 Started from your words, after you checked the steps
`;
const pb = brief.parseBrief(`# Scratch\n\n${PLAN_MD}`);
const pp = pb.plan[0];
check('format: a plan with References is still a plan, its steps unchanged', pp.plan === true && pp.steps.length === 2 && pp.tasks.length === 2, `${pp.steps.length} steps`);
check('format: References are read, path and his words', JSON.stringify(pp.refs) === JSON.stringify([{ path: '.inbox/cozy.png', note: 'I like this style' }, { path: '.inbox/notes.pdf', note: '' }]), JSON.stringify(pp.refs));
check('format: the lines after References read as before (Rules, steps, log)', /work the steps/.test(pp.rules) && pp.log.length === 1 && pp.meta.length === 0);
const blk = fmt.findPlanBlock(PLAN_MD, 'Cozy menu');
const blkText = blk.lines.slice(blk.start, blk.end).join('\n');
check('format: written back byte for byte', fmt.planMarkdown(pp) === blkText);
check('format: an edit that changes nothing leaves the brief as it was', fmt.editPlan(PLAN_MD, 'Cozy menu', () => {}) === PLAN_MD);
const dv = fmt.derive(pp);
check('format: derive carries the references, pictures marked', dv.refs.length === 2 && dv.refs[0].image === true && dv.refs[1].image === false);
const noRefs = fmt.parsePlanBlock('X', ['Runs on its own.', 'Goal: "g"', '', '- [ ] Do: a']);
check('format: a plan without References has none and writes no References line', noRefs.refs.length === 0 && !/References/.test(fmt.planMarkdown(noRefs)));

// ------------------------------------------------------------ the attached-file guard
const UP = path.join(T, 'unit-proj');
fs.mkdirSync(path.join(UP, '.inbox'), { recursive: true });
const inF = path.join(UP, '.inbox', 'cozy.png');
fs.writeFileSync(inF, PNG);
fs.writeFileSync(path.join(UP, 'BRIEF.md'), '# U\n');
const OUTSIDE = path.join(T, 'outside.png');
fs.writeFileSync(OUTSIDE, PNG);
fs.symlinkSync(OUTSIDE, path.join(UP, '.inbox', 'sneaky.png'));
const uproj = { id: 'u', name: 'U', folder: UP };
const refuse = (list) => { try { planner.inboxFiles(uproj, list); return null; } catch (e) { return e; } };
const okFiles = planner.inboxFiles(uproj, [{ path: inF }]);
check('guard: a file in the project\'s .inbox is accepted, with its path from the folder', okFiles.length === 1 && okFiles[0].rel === '.inbox/cozy.png' && okFiles[0].path === fs.realpathSync(inF));
let e = refuse([path.join(UP, 'BRIEF.md')]);
check('guard: a file of the project outside .inbox is refused (400)', e && e.status === 400, e && e.message);
e = refuse(['/etc/hosts']);
check('guard: any other path is refused (400)', e && e.status === 400);
e = refuse([path.join(UP, '.inbox', 'sneaky.png')]);
check('guard: a symlink in .inbox that leads out is refused', e && e.status === 400);
e = refuse([path.join(UP, '.inbox', 'missing.png')]);
check('guard: a file that is not there is refused', e && e.status === 400);
e = refuse(['.inbox/cozy.png']);
check('guard: a relative path is refused', e && e.status === 400);
e = refuse(Array.from({ length: 11 }, () => inF));
check('guard: more than 10 files at once is refused', e && e.status === 400 && /10/.test(e.message), e && e.message);
e = (() => { try { planner.inboxFiles({ id: 'n', name: 'N', folder: null }, [inF]); return null; } catch (x) { return x; } })();
check('guard: a project with no folder takes no files (409)', e && e.status === 409);

// ------------------------------------------------------------ the call's argv
const BASE = ['claude', '-p', '--no-session-persistence', '--model', 'sonnet', '--tools', '', '--strict-mcp-config', '--setting-sources', 'project,local', '--output-format', 'json'];
const cfgU = { planCommand: BASE };
const a0 = planner.callArgs(cfgU, []);
check('argv: with no files, exactly as before (no tools, the strict settings)', JSON.stringify(a0.args.slice(0, BASE.length - 1)) === JSON.stringify(BASE.slice(1)) && a0.args[BASE.length - 1] === '--system-prompt' && a0.cwd === planner.DIR, JSON.stringify(a0.args.slice(0, 12)));
const f2 = fs.realpathSync(inF);
const a1 = planner.callArgs(cfgU, [f2, '/x/y/other.pdf']);
const ti = a1.args.indexOf('--tools');
const ai = a1.args.indexOf('--allowedTools');
check('argv: with files, --tools is Read and nothing else', a1.args[ti + 1] === 'Read' && a1.args.filter((x) => x === '--tools').length === 1 && !a1.args.includes(''));
check('argv: one Read allow rule per file, absolute (//), nothing more', a1.args[ai + 1] === `Read(/${f2})` && a1.args[ai + 2] === 'Read(//x/y/other.pdf)' && a1.args[ai + 3] === '--permission-prompts' && a1.args.filter((x) => /^Read\(/.test(x)).length === 2, a1.args.slice(ai, ai + 5).join(' '));
check('argv: --strict-mcp-config and --setting-sources project,local kept', a1.args.includes('--strict-mcp-config') && a1.args[a1.args.indexOf('--setting-sources') + 1] === 'project,local');
check('argv: anything else that would ask is refused (--permission-prompts none)', a1.args[a1.args.indexOf('--permission-prompts') + 1] === 'none');
check('argv: a call with files runs in an empty folder of its own', a1.cwd === path.join(planner.DIR, 'empty'));

// ------------------------------------------------------------ the start prompt and the brief round trip
const draft = { mode: 'new', title: 'Cozy menu', goal: 'Make the menu feel cozy', refs: [{ path: f2, rel: '.inbox/cozy.png', note: "I like this style, it's warm" }, { path: '/p/.inbox/b.pdf', rel: '.inbox/b.pdf', note: 'The copy I want' }], steps: [{ id: 's1', kind: 'do', text: 'Match the look of .inbox/cozy.png', detail: '', arms: [], choices: [] }] };
const refs = planrun.draftRefs(draft);
const sp = planrun.startPrompt(uproj, path.join(UP, 'BRIEF.md'), 'Cozy menu', refs);
check('start prompt: tells the session to read the References first, each path with his words', /read the References listed under the Goal of the plan/.test(sp) && sp.includes('.inbox/cozy.png ("I like this style, it’s warm")') && sp.includes('.inbox/b.pdf ("The copy I want")') && sp.indexOf('References') < sp.indexOf('Rules for running a plan'), sp.slice(0, 260));
check('start prompt: no single quote, so it still travels as one shell word', !sp.includes("'"));
check('start prompt: without references it is exactly as before', planrun.startPrompt(uproj, path.join(UP, 'BRIEF.md'), 'T') === `Run the plan "T" in BRIEF.md, under ## Plan. ${planrun.runRules()}`);
check('change prompt: names the References when there are some', /References included/.test(planrun.changedPrompt(uproj, path.join(UP, 'BRIEF.md'), 'T', refs)) && !/References/.test(planrun.changedPrompt(uproj, path.join(UP, 'BRIEF.md'), 'T')));
const BF = path.join(UP, 'BRIEF.md');
fs.writeFileSync(BF, '# U\n\n## Goal\nA scratch project.\n\n## Next step\nNothing yet.\n');
planrun.writeStart(BF, draft);
const back = brief.readBrief(BF).plan.find((o) => o.plan);
check('brief round trip: Start writes References under the Goal, relative paths, his words', JSON.stringify(back.refs) === JSON.stringify([{ path: '.inbox/cozy.png', note: "I like this style, it's warm" }, { path: '.inbox/b.pdf', note: 'The copy I want' }]), JSON.stringify(back.refs));
const written = fs.readFileSync(BF, 'utf8');
check('brief round trip: the References block sits right after the Goal line', /Goal: "Make the menu feel cozy"\nReferences:\n {2}- \.inbox\/cozy\.png: I like this style, it's warm\n {2}- \.inbox\/b\.pdf: The copy I want\nRules:/.test(written), written.split('\n').slice(4, 10).join(' | '));
const ch = planner.fromPlan(uproj, back);
check('change: a draft from the running plan keeps its References', ch.refs.length === 2 && ch.refs[0].rel === '.inbox/cozy.png' && ch.refs[0].path === path.join(UP, '.inbox/cozy.png'));
const kept = planrun.planFromDraft({ ...ch, steps: ch.steps }, { old: back });
check('change: the changed plan keeps them, no duplicates', kept.refs.length === 2);
planner.discard('u');

// ------------------------------------------------------------ boards

const PROJ = path.join(T, 'projects', 'scratch');
fs.mkdirSync(PROJ, { recursive: true });
fs.writeFileSync(path.join(PROJ, 'BRIEF.md'), '# Scratch\n\n## Goal\nTry files in plans.\n\n## Next step\nNothing yet.\n');
fs.writeFileSync(path.join(PROJ, 'not-a-ref.png'), PNG);
const servers = [];
async function board(name, port, extraEnv = {}) {
  const mc = path.join(T, name, 'mc');
  fs.mkdirSync(mc, { recursive: true });
  const fake = path.join(T, name, 'fake-cmux.json');
  fs.writeFileSync(fake, JSON.stringify({ workspaces: [], screens: {} }));
  fs.writeFileSync(path.join(T, name, 'CLAUDE.md'), '# Rules\n\n## Pictures\n- Show me a picture before building anything visual.\n');
  fs.writeFileSync(path.join(mc, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, name, 'CLAUDE.md'), backupDir: path.join(T, name, 'backups'), launchCommand: 'claude' }, projects: [
    { id: 'scratch', name: 'Scratch', folder: PROJ, workspaces: [], brief: 'BRIEF.md' },
  ] }, null, 2));
  const env = {
    ...process.env, RAVENRY_HOME: mc, PORT: String(port), MC_NO_EVENTS: '1', MC_REPEATS_AUTO: '0',
    CMUX_BIN: path.join(ROOT, 'tools/fake-cmux.mjs'), FAKE_CMUX_STATE: fake, MC_CLAUDE_PROJECTS: path.join(T, name, 'claude'),
    MC_PROJECTS_ROOT: path.join(T, 'projects'), MC_GLOBAL_CLAUDE_MD: path.join(T, name, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, name, 'backups'),
    MC_PLAN_COMMAND: JSON.stringify([process.execPath, path.join(ROOT, 'tools/stub-plan-claude.mjs'), ...BASE.slice(1)]),
    STUB_PLAN_ARGV_FILE: path.join(T, name, 'plan-argv.jsonl'), ...extraEnv,
  };
  for (const [k, v] of Object.entries(env)) if (v === null) delete env[k];
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  servers.push(srv);
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* not yet */ } await sleep(250); }
  await sleep(2600); // a tick or so, so the snapshot holds the projects
  const lines = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return {
    mc, base, fake, log: () => log,
    calls: () => lines(env.STUB_PLAN_ARGV_FILE),
    launches: () => lines(fake + '.new-workspace.log'),
    state: async () => (await fetch(base + '/api/state')).json(),
    get: async (p) => { const r = await fetch(base + p); return { status: r.status, type: r.headers.get('content-type'), j: await r.json().catch(() => null) }; },
    post: async (p, body, headers = { 'X-Ravenry': '1' }) => { const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) }); return { status: res.status, j: await res.json() }; },
  };
}

async function idle(b) {
  for (let i = 0; i < 100; i++) { const r = await b.get('/api/plan/draft?projectId=scratch'); if (r.j && r.j.draft && !r.j.draft.busy) return r.j.draft; await sleep(100); }
  return null;
}

try {
  const b = await board('b1', 4677);
  // ---- attachments: the composer's route, as the sheet uses it
  const up = async (name, buf, headers = { 'X-Ravenry': '1' }, pid = 'scratch') => {
    const res = await fetch(`${b.base}/api/inbox/${pid}`, { method: 'POST', headers: { 'X-Filename': encodeURIComponent(name), ...headers }, body: buf });
    return { status: res.status, j: await res.json() };
  };
  const s1 = await up('cozy look.png', PNG);
  check('inbox: a file is saved into the project\'s .inbox, a safe name, .gitignore made', s1.status === 200 && s1.j.path === path.join(PROJ, '.inbox', 'cozy-look.png') && fs.existsSync(s1.j.path) && fs.readFileSync(path.join(PROJ, '.inbox', '.gitignore'), 'utf8').includes('*'), JSON.stringify(s1.j));
  const s2 = await up('cozy look.png', PNG);
  check('inbox: the same name again does not overwrite', s2.status === 200 && s2.j.path.endsWith('cozy-look-2.png'));
  const s3 = await up('copy.txt', Buffer.from('Warm, short words.\n'));
  check('inbox: the write guard holds for files (no board header is 403)', (await up('x.png', PNG, {})).status === 403);
  check('inbox: an unknown project is 404', (await up('x.png', PNG, { 'X-Ravenry': '1' }, 'nope')).status === 404);

  // ---- a draft with a file
  let r = await b.post('/api/plan/draft', { projectId: 'scratch', goal: 'Make the menu feel cozy', files: [path.join(PROJ, 'not-a-ref.png')] });
  check('draft: a file outside .inbox is refused, no model call', r.status === 400 && b.calls().length === 0, `${r.status} ${r.j.error}`);
  r = await b.post('/api/plan/draft', { projectId: 'scratch', goal: 'Make the menu feel cozy', files: ['/etc/hosts'] });
  check('draft: any other path is refused too', r.status === 400 && b.calls().length === 0);
  r = await b.post('/api/plan/draft', { projectId: 'scratch', goal: 'Make the menu feel cozy. I like this style', files: [s1.j.path] });
  let d = await idle(b);
  const c1 = b.calls()[0];
  const real1 = fs.realpathSync(s1.j.path);
  check('draft: the planner call gets the Read tool for exactly the attached file', !!c1 && c1.argv[c1.argv.indexOf('--tools') + 1] === 'Read' && c1.argv.filter((x) => /^Read\(/.test(x)).length === 1 && c1.argv.includes(`Read(/${real1})`), c1 && c1.argv.filter((x) => /Read|tools/.test(x)).join(' '));
  check('draft: --strict-mcp-config and --setting-sources project,local kept', !!c1 && c1.argv.includes('--strict-mcp-config') && c1.argv[c1.argv.indexOf('--setting-sources') + 1] === 'project,local');
  check('draft: the call runs in the empty folder', !!c1 && c1.cwd === fs.realpathSync(path.join(b.mc, 'plans', 'empty')) && fs.readdirSync(c1.cwd).length === 0, c1 && c1.cwd);
  check('draft: the prompt gives the path and what it is for, in his words', !!c1 && c1.prompt.includes(real1) && c1.prompt.includes('with what they want done: "Make the menu feel cozy. I like this style"') && /Read each one with the Read tool/.test(c1.prompt));
  check('draft: his message in the thread carries the file, a picture with its thumbnail url', !!d && d.thread[0].files && d.thread[0].files[0].rel === '.inbox/cozy-look.png' && d.thread[0].files[0].url === '/api/pic/scratch?plan=.inbox%2Fcozy-look.png', d && JSON.stringify(d.thread[0]));
  let pic = await fetch(b.base + '/api/pic/scratch?plan=' + encodeURIComponent('.inbox/cozy-look.png'));
  check('picture route: a reference of the draft is served (an image)', pic.status === 200 && pic.headers.get('content-type') === 'image/png');
  pic = await fetch(b.base + '/api/pic/scratch?plan=' + encodeURIComponent('not-a-ref.png'));
  check('picture route: a picture in the folder that is no reference is not', pic.status === 404);
  pic = await fetch(b.base + '/api/pic/scratch?plan=' + encodeURIComponent('.inbox/cozy-look-2.png'));
  check('picture route: an .inbox file not attached to the plan is not served either', pic.status === 404);

  // ---- a comment with a file, then the chat box with one
  r = await b.post('/api/plan/revise', { projectId: 'scratch', comment: { step: d.steps[0].id, text: '', files: [s3.j.path] } });
  check('comment: a file with no words is refused (say what it is for)', r.status === 400 && /what the file is for/.test(r.j.error), r.j.error);
  r = await b.post('/api/plan/revise', { projectId: 'scratch', comment: { step: d.steps[0].id, text: 'I like this style', files: [s2.j.path] } });
  d = await idle(b);
  const c2 = b.calls()[b.calls().length - 1];
  const real2 = fs.realpathSync(s2.j.path);
  check('comment: the revision may read both files, and only those', !!c2 && c2.argv.filter((x) => /^Read\(/.test(x)).sort().join() === [`Read(/${real1})`, `Read(/${real2})`].sort().join(), c2 && c2.argv.filter((x) => /^Read\(/.test(x)).join(' '));
  check('comment: the prompt says the file came with their comment on step 1, "I like this style"', !!c2 && c2.prompt.includes(real2) && /with their comment on step 1, "[^"]+": "I like this style"/.test(c2.prompt));
  r = await b.post('/api/plan/revise', { projectId: 'scratch', message: 'Use these words on the buttons', files: [s3.j.path] });
  d = await idle(b);
  const c3 = b.calls()[b.calls().length - 1];
  check('chat: a non-picture file goes too, as a file chip (no thumbnail url)', !!c3 && c3.argv.filter((x) => /^Read\(/.test(x)).length === 3 && d.thread.some((m) => m.files && m.files.some((f) => f.rel === '.inbox/copy.txt' && !f.url)));
  // Answer the stub's two questions (the last one sends a revision).
  for (const q of d.questions.filter((x) => x.answer == null)) { await b.post('/api/plan/edit', { projectId: 'scratch', answer: { id: q.id, option: q.options[0] } }); d = await idle(b); }
  check('draft: ready to start', d && d.canStart, d && JSON.stringify({ busy: d.busy, open: d.openQuestions, err: d.error }));

  // ---- Start: References in the brief and in the start prompt
  r = await b.post('/api/plan/start', { projectId: 'scratch' });
  const md = fs.readFileSync(path.join(PROJ, 'BRIEF.md'), 'utf8');
  const bp = brief.readBrief(path.join(PROJ, 'BRIEF.md')).plan.find((o) => o.plan);
  check('start: the plan is in the brief with References, relative paths and his words', !!bp && JSON.stringify(bp.refs.map((x) => x.path)) === JSON.stringify(['.inbox/cozy-look.png', '.inbox/cozy-look-2.png', '.inbox/copy.txt']) && bp.refs[1].note === 'I like this style' && /References:\n {2}- \.inbox\/cozy-look\.png: Make the menu feel cozy\. I like this style\n/.test(md), md.split('\n').filter((l) => /References|\.inbox/.test(l)).join(' | '));
  const launch = b.launches().map((x) => x.argv.join(' ')).join('\n');
  check('start: the start prompt a new session gets names the References to read first', /read the References listed under the Goal of the plan/.test(launch) && launch.includes('.inbox/cozy-look-2.png ("I like this style")') && launch.includes('.inbox/copy.txt ("Use these words on the buttons")'), `${r.status} ${launch.slice(0, 200) || r.j.error}`);
  await sleep(2400);
  const st = await b.state();
  const sp2 = st.projects.find((x) => x.id === 'scratch');
  check('plan view: the running plan carries its References, the pictures with a url', !!sp2.plan && sp2.plan.refs.length === 3 && sp2.plan.refs[0].url === '/api/pic/scratch?plan=.inbox%2Fcozy-look.png' && !sp2.plan.refs[2].url, sp2.plan && JSON.stringify(sp2.plan.refs));
  pic = await fetch(b.base + sp2.plan.refs[0].url);
  check('picture route: a reference of the running plan is served', pic.status === 200 && pic.headers.get('content-type') === 'image/png');

} catch (err) {
  console.error(err);
  fails++;
} finally {
  for (const s of servers) s.kill();
}
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
