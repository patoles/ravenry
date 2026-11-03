#!/usr/bin/env node
// Each project's latest picture (server/pictures.mjs): only what the
// project's current session's MAIN transcript showed the user (its own Read of
// an image, or a path in its own text; never a subagent's transcript, a
// path in a tool call's input or a path in tool output), the root guard, the
// size and age limits, the brief's own Pictures coming first, the pick following a
// session change, and the picture route serving only the current pick. Unit
// checks on the module, then a test board on :4641 with a throwaway RAVENRY_HOME,
// fake transcripts, fake scratchpads and tools/fake-cmux.mjs (each project's
// tab shows a "claude --resume <id>" line, which names its current session).
// Never touches the board on :4600.
// Usage: node tools/pictures-test.mjs
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = path.join(ROOT, '.tmp', 'pictures-test');
fs.rmSync(T, { recursive: true, force: true });
const SCRATCH = path.join(T, 'scratch');
process.env.MC_SCRATCH_ROOT = SCRATCH;
const P = await import('../server/pictures.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const DAY = 24 * 3600 * 1000;
function img(p, { ageDays = 0, bytes = null } = {}) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (bytes == null) fs.writeFileSync(p, PNG);
  else { fs.writeFileSync(p, PNG); fs.truncateSync(p, bytes); } // sparse: cheap on disk
  const t = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(p, t, t);
  return p;
}
const slug = (cwd) => cwd.replace(/[^A-Za-z0-9-]/g, '-');

// ------------------------------------------------------------ unit: root guard
const proj = path.join(T, 'root', 'alpha');
const outside = path.join(T, 'outside');
fs.mkdirSync(proj, { recursive: true });
const inFile = img(path.join(proj, 'shots', 'in.png'));
const secret = img(path.join(outside, 'secret.png'));
fs.symlinkSync(secret, path.join(proj, 'shots', 'link.png'));
fs.symlinkSync(outside, path.join(proj, 'linkdir'));
const SID = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';
const ownScratch = img(path.join(SCRATCH, slug(proj), SID, 'scratchpad', 'shot.png'));
const otherScratch = img(path.join(SCRATCH, slug(proj), OTHER, 'scratchpad', 'shot.png'));
const looseScratch = img(path.join(SCRATCH, 'loose.png'));
const roots = P.rootsFor(proj, [SID]);

check('guard: an image inside the project folder is allowed', P.allowedPath(inFile, roots) === fs.realpathSync(inFile));
check('guard: a symlink inside the folder that points outside is refused', P.allowedPath(path.join(proj, 'shots', 'link.png'), roots) === null);
check('guard: a file reached through a symlinked folder is refused', P.allowedPath(path.join(proj, 'linkdir', 'secret.png'), roots) === null);
check('guard: ../ out of the folder is refused', P.allowedPath(path.join(proj, '..', '..', 'outside', 'secret.png'), roots) === null);
check('guard: a plain path outside every root is refused', P.allowedPath(secret, roots) === null);
check('guard: ~/Downloads is refused', P.allowedPath(path.join(os.homedir(), 'Downloads', 'fw8ben.png'), roots) === null
  && P.allowedPath(path.join(proj, '..', '..', '..', '..', '..', 'Downloads', 'x.png'), roots) === null);
check('guard: a project whose folder is the home folder gets no folder root', P.rootsFor(os.homedir(), []).folder === null && P.allowedPath(inFile, P.rootsFor(os.homedir(), [])) === null);
check('guard: a project whose folder is ~/Downloads or ~/Documents gets no folder root', P.rootsFor(path.join(os.homedir(), 'Documents'), []).folder === null && P.rootsFor(path.join(os.homedir(), 'Downloads'), []).folder === null);
check('guard: the scratchpad of one of the project\'s own sessions is allowed', P.allowedPath(ownScratch, roots) === fs.realpathSync(ownScratch));
check('guard: another session\'s scratchpad is refused', P.allowedPath(otherScratch, roots) === null);
check('guard: a loose file at the scratch root is refused', P.allowedPath(looseScratch, roots) === null);
check('guard: a non-image file is refused', (() => { const f = path.join(proj, 'notes.txt'); fs.writeFileSync(f, 'x'); return P.allowedPath(f, roots) === null; })());

// ------------------------------------------------------------ unit: limits
const big = img(path.join(proj, 'big.png'), { bytes: 15 * 1024 * 1024 + 1 });
const edge = img(path.join(proj, 'edge.png'), { bytes: 15 * 1024 * 1024 });
const old = img(path.join(proj, 'old.png'), { ageDays: 31 });
const fine = img(path.join(proj, 'fine.png'), { ageDays: 29 });
const empty = path.join(proj, 'empty.png'); fs.writeFileSync(empty, '');
check('limit: an image over 15 MB is skipped', P.checkFile(big, roots) === null);
check('limit: an image of exactly 15 MB is kept', !!P.checkFile(edge, roots));
check('limit: an image older than 30 days is skipped', P.checkFile(old, roots) === null);
check('limit: an image 29 days old is kept', !!P.checkFile(fine, roots));
check('limit: an empty file is skipped', P.checkFile(empty, roots) === null);
// ------------------------------------------------------------ unit: transcript mentions
{
  const rec = (o) => JSON.stringify({ timestamp: new Date().toISOString(), cwd: proj, ...o });
  const tp = path.join(T, 'unit.jsonl');
  fs.writeFileSync(tp, [
    rec({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: inFile } }] } }),
    rec({ type: 'user', message: { content: [{ type: 'tool_result', content: `Saved screenshot to ${ownScratch}\n` }] } }),
    rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'Here they are:\n- [Screenshot](shots/rel one.png)\n- [Screenshot](shots/rel.png)' }] } }),
    rec({ type: 'assistant', message: { content: [{ type: 'text', text: `The new one: "${path.join(proj, 'with space.png')}"` }] } }),
    rec({ type: 'user', message: { content: `look at ${path.join(os.homedir(), 'Desktop', 'mine.png')}` } }),
    rec({ type: 'assistant', message: { content: [{ type: 'text', text: `An older one is at ${path.join(proj, 'said.png')}` }] } }),
    rec({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: `maybe ${path.join(proj, 'thought.png')}` }] } }),
    rec({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `node tools/fixture.mjs --out ${path.join(proj, 'fixture.png')}` } }] } }),
    rec({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(proj, 'written.png'), content: 'x' } }] } }),
    rec({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { prompt: `compare with ${path.join(proj, 'before.png')}` } }] } }),
    rec({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: `Done. House: \`${path.join(proj, 'handback.png')}\`` } }] } }),
    rec({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: `my own check: ${path.join(proj, 'sidechain.png')}` }] } }),
  ].join('\n') + '\n');
  const got = P.transcriptImages(tp);
  check('transcript: the main session\'s Read of an image counts', got.includes(inFile));
  check('transcript: a path the main session wrote in its text to the user counts', got.includes(path.join(proj, 'said.png')));
  check('transcript: a relative markdown link in its text resolves against the cwd', got.includes(path.join(proj, 'shots', 'rel.png')));
  check('transcript: a quoted path with a space in its text is read whole', got.includes(path.join(proj, 'with space.png')));
  check('transcript: a path only in tool output does not count', !got.includes(ownScratch));
  check('transcript: a path only in a Bash command does not count', !got.includes(path.join(proj, 'fixture.png')));
  check('transcript: a Write target does not count', !got.includes(path.join(proj, 'written.png')));
  check('transcript: a path in a subagent\'s brief or hand-back (tool input) does not count', !got.includes(path.join(proj, 'before.png')) && !got.includes(path.join(proj, 'handback.png')));
  check('transcript: the session\'s thinking does not count', !got.includes(path.join(proj, 'thought.png')));
  check('transcript: a sidechain (subagent) record does not count', !got.includes(path.join(proj, 'sidechain.png')));
  check('transcript: the user\'s own prompt text is not a source', !got.some((p) => p.includes('Desktop')));
}

// ------------------------------------------------------------ unit: what was shown, against what was only made
{
  const W = path.join(T, 'root', 'unit-shown');
  const WD = path.join(T, 'unit-shown-claude');
  const S = 'dddddddd-0000-0000-0000-000000000001';
  fs.mkdirSync(path.join(WD, S, 'subagents'), { recursive: true });
  const at = (min) => new Date(Date.now() - min * 60000).toISOString();
  const rec = (o, min) => JSON.stringify({ timestamp: at(min), cwd: W, sessionId: S, ...o });
  const asst = (content, min) => rec({ type: 'assistant', message: { content } }, min);
  const res = (id, text, min) => rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } }, min);
  // Seven pictures the main session showed: four Reads, three in its text.
  const shown = [];
  for (let i = 0; i < 7; i++) shown.push(img(path.join(W, 'shots', `shown-${i}.png`), { ageDays: (70 - i * 10) / 1440 }));
  // Newer files it never showed: each would have been the pick before.
  const subShot = img(path.join(W, 'shots', 'sub-verify.png'), { ageDays: 1 / 1440 });
  const bashFile = img(path.join(W, 'tests', 'fixture.png'), { ageDays: 1.5 / 1440 });
  const outOnly = img(path.join(SCRATCH, slug(W), S, 'scratchpad', 'before.png'), { ageDays: 2 / 1440 });
  const inOnly = img(path.join(W, 'shots', 'compare-in.png'), { ageDays: 2.5 / 1440 });
  const lines = [];
  shown.forEach((p, i) => {
    if (i % 2 === 0) lines.push(asst([{ type: 'tool_use', id: 'r' + i, name: 'Read', input: { file_path: p } }], 70 - i * 10));
    else lines.push(asst([{ type: 'text', text: `Here is the new screen: ${p}` }], 70 - i * 10));
  });
  lines.push(asst([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'node tests/draw-fixture.mjs' } }], 1.5));
  lines.push(res('b1', `wrote ${bashFile}`, 1.5));
  lines.push(asst([{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'node tools/shoot.mjs --before' } }], 2));
  lines.push(res('b2', `saved ${outOnly}`, 2));
  lines.push(asst([{ type: 'tool_use', id: 'b3', name: 'Bash', input: { command: `cp shots/a.png ${inOnly}` } }], 2.5));
  // The main session made one of its shown pictures with a script, then read it.
  lines.push(asst([{ type: 'tool_use', id: 'b4', name: 'Bash', input: { command: 'node tools/shoot.mjs --wave 3' } }], 70));
  lines.push(res('b4', `wrote ${shown[0]}`, 70));
  const tp = path.join(WD, S + '.jsonl');
  fs.writeFileSync(tp, lines.join('\n') + '\n');
  // A subagent's own verification screenshot, newer than everything.
  fs.writeFileSync(path.join(WD, S, 'subagents', 'agent-v.jsonl'), [
    JSON.stringify({ type: 'assistant', timestamp: at(1), cwd: W, message: { content: [{ type: 'tool_use', id: 's1', name: 'Bash', input: { command: 'node tools/shoot.mjs --verify' } }] } }),
    JSON.stringify({ type: 'user', timestamp: at(1), cwd: W, message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: `saved ${subShot}` }] } }),
    JSON.stringify({ type: 'assistant', timestamp: at(1), cwd: W, message: { content: [{ type: 'tool_use', id: 's2', name: 'Read', input: { file_path: subShot } }] } }),
    JSON.stringify({ type: 'assistant', timestamp: at(1), cwd: W, message: { content: [{ type: 'text', text: `Verified: ${subShot}` }] } }),
  ].join('\n') + '\n');
  const r = P.refresh({ id: 'shown', folder: W }, { sessionId: S, path: tp });
  const names = r.list.map((x) => path.basename(x.abs));
  check('shown: a subagent\'s own screenshot (made, read and named in its transcript) does not count', !names.includes('sub-verify.png'), names.join(' '));
  check('shown: a file a Bash command wrote (path in its output) does not count', !names.includes('fixture.png'));
  check('shown: a path only in tool output does not count', !names.includes('before.png'));
  check('shown: a path only in a tool call\'s input does not count', !names.includes('compare-in.png'));
  check('shown: the main session\'s Reads and paths in its text count, 6 kept, oldest first, the 7th dropped', names.join(' ') === 'shown-1.png shown-2.png shown-3.png shown-4.png shown-5.png shown-6.png', names.join(' '));
  check('shown: the pick is the newest shown picture', r.pick && path.basename(r.pick.abs) === 'shown-6.png');
  const byName = Object.fromEntries(r.list.map((x) => [path.basename(x.abs), x]));
  check('shown: a Read-only picture says "Read" (not made)', byName['shown-2.png'].by === 'Read' && byName['shown-2.png'].made === false, JSON.stringify(byName['shown-2.png'].by));
  check('shown: a picture only named in text says nothing about who made it', byName['shown-1.png'].by === null && byName['shown-1.png'].made === false);
  const all = P.listFromTranscripts([tp], P.rootsFor(W, [S]), Date.now(), 7);
  const zero = all.find((x) => path.basename(x.abs) === 'shown-0.png');
  check('shown: the caption still names the script that wrote a shown picture', zero && zero.by === 'tools/shoot.mjs' && zero.made, zero && JSON.stringify(zero.by));
}

// ------------------------------------------------------------ unit: current session only (main transcript)
{
  const U = path.join(T, 'root', 'unit-session');
  const UD = path.join(T, 'unit-claude');
  fs.mkdirSync(UD, { recursive: true });
  img(path.join(U, 'fresh-in-folder.png'));                  // the old folder fallback would take this
  const oldShot = img(path.join(U, 'old-session.png'), { ageDays: 0.2 });
  const subShot = img(path.join(U, 'sub.png'), { ageDays: 0.1 });
  const mainShot = img(path.join(U, 'main.png'), { ageDays: 0.3 });
  const S1 = 'cccccccc-0000-0000-0000-000000000001';
  const S2 = 'cccccccc-0000-0000-0000-000000000002';
  const S0 = 'cccccccc-0000-0000-0000-000000000000';
  const line = (p) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), cwd: U, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: p } }] } }) + '\n';
  const t0p = path.join(UD, S0 + '.jsonl'); fs.writeFileSync(t0p, line(oldShot));
  const t1p = path.join(UD, S1 + '.jsonl'); fs.writeFileSync(t1p, line(mainShot));
  fs.mkdirSync(path.join(UD, S1, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(UD, S1, 'subagents', 'agent-x.jsonl'), line(subShot));
  const t2p = path.join(UD, S2 + '.jsonl'); fs.writeFileSync(t2p, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), cwd: U, message: { content: 'hello' } }) + '\n');
  const pr = { id: 'unit', folder: U };
  const s1 = { sessionId: S1, path: t1p };
  const s2 = { sessionId: S2, path: t2p };

  let r = P.refresh(pr, null);
  check('session: no current session, no picture (a fresh image in the folder is not a fallback)', r.pick === null && P.current('unit', null) === null);
  r = P.refresh(pr, s2);
  check('session: a current session that touched no image gives no picture, even with an older session and folder images around', r.pick === null);
  r = P.refresh(pr, s1);
  check('session: the pick is the newest image the current session\'s main transcript showed, not an older session\'s nor its subagent\'s newer one', r.pick && r.pick.abs === fs.realpathSync(mainShot), r.pick ? r.pick.abs : 'none');
  check('session: the cached pick is shown for that session', P.current('unit', s1) === r.pick);
  check('session: due again at once when the current session changes', P.due('unit', s2) === true && P.due('unit', s1) === false);
  check('session: a switch drops the old pick before any refresh (current and the route)', P.current('unit', s2) === null && P.serveable('unit', 'main.png') === null);
  r = P.refresh(pr, s2);
  check('session: the new session shows nothing until it touches an image', r.pick === null);
  const newShot = img(path.join(U, 'new.png'));
  fs.appendFileSync(t2p, line(newShot));
  r = P.refresh(pr, s2);
  check('session: then its first image is the pick', r.pick && r.pick.abs === fs.realpathSync(newShot), r.pick ? r.pick.abs : 'none');
  check('session: the scratchpad of the project\'s other sessions is refused', P.allowedPath(otherScratch, P.rootsFor(proj, [S1])) === null);
}

// ------------------------------------------------------------ the board
const MC = path.join(T, 'mc');
const CLAUDE = path.join(T, 'claude');
const FAKE = path.join(T, 'fake-cmux.json');
const PORT = 4641;
fs.mkdirSync(path.join(MC, 'briefs', 'pics'), { recursive: true });
const A = path.join(T, 'root', 'board-a');
const B = path.join(T, 'root', 'board-b');
const C = path.join(T, 'root', 'board-c');
for (const d of [A, B, C]) { fs.mkdirSync(d, { recursive: true }); execFileSync('git', ['init', '-q', d]); }
img(path.join(MC, 'briefs', 'pics', 'listed.png'));
fs.writeFileSync(path.join(MC, 'briefs', 'a.md'), '# A\n\n## Goal\nTest A.\n\n## Pictures\n- pics/listed.png | The listed picture\n');
fs.writeFileSync(path.join(MC, 'briefs', 'b.md'), '# B\n\n## Goal\nTest B.\n');
fs.writeFileSync(path.join(MC, 'briefs', 'c.md'), '# C\n\n## Goal\nTest C.\n');
const SA = 'aaaaaaaa-0000-0000-0000-000000000001';
const SA2 = 'aaaaaaaa-0000-0000-0000-000000000003';
const SB = 'bbbbbbbb-0000-0000-0000-000000000002';
const SB0 = 'bbbbbbbb-0000-0000-0000-000000000000';
const SC = 'cccccccc-0000-0000-0000-00000000000c';
const SC0 = 'cccccccc-0000-0000-0000-0000000000c0';
const aAuto = img(path.join(A, 'shots', 'a-auto.png'), { ageDays: 1 });
const aSub = img(path.join(A, 'shots', 'a-sub.png'), { ageDays: 0.5 });
const bOldSession = img(path.join(B, 'shots', 'old-session.png'), { ageDays: 0.01 });
img(path.join(C, 'shots', 'fresh.png'));                                  // the old folder fallback's pick
const cOldSession = img(path.join(C, 'shots', 'old-session.png'), { ageDays: 0.2 });
const bInFolder = img(path.join(B, 'shots', 'older.png'), { ageDays: 3 });
const bScratch = img(path.join(SCRATCH, slug(B), SB, 'scratchpad', 'b-pick.png'), { ageDays: 0.5 });
const bOther = img(path.join(SCRATCH, slug(B), OTHER, 'scratchpad', 'other-session.png'), { ageDays: 0.1 });
const bSecret = img(path.join(outside, 'b-secret.png'), { ageDays: 0.05 });
const tx = (cwd, sid, paths) => {
  const d = path.join(CLAUDE, slug(cwd));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, sid + '.jsonl'), paths.map((p, i) => JSON.stringify({
    type: 'assistant', timestamp: new Date(Date.now() - (10 - i) * 1000).toISOString(), cwd, sessionId: sid,
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: p } }] },
  })).join('\n') + '\n');
};
tx(B, SB0, [bOldSession]);   // an older session of B: not the current one
tx(C, SC0, [cOldSession]);   // an older session of C: not the current one
tx(A, SA, [aAuto]);
tx(B, SB, [bInFolder, bScratch, bOther, bSecret]);
tx(C, SC, []);               // C's current session touched no image
{ // A's session's subagent made and read a newer image: not shown to the user.
  const d = path.join(CLAUDE, slug(A), SA, 'subagents');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'agent-1.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), cwd: A, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: aSub } }] } }) + '\n');
}
tx(A, SA2, []);              // the fresh session A switches to later
// Each project's tab names its current session with a resume line.
const resume = (sid) => `Resume this session with:\nclaude --resume ${sid}\n~/x $ `;
const fake = (a) => fs.writeFileSync(FAKE, JSON.stringify({
  workspaces: [['a', A], ['b', B], ['c', C]].map(([k, cwd]) => ({ id: 'ws-' + k, ref: 'workspace:' + k, title: k, cwd, surfaces: [{ id: 'sf-' + k, ref: 'surface:' + k, title: k }] })),
  screens: { 'sf-a': resume(a), 'sf-b': resume(SB), 'sf-c': resume(SC) },
}));
fake(SA);
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1,
  settings: { autoImport: false, ruleSources: [], globalClaudeMd: path.join(T, 'CLAUDE.md'), backupDir: path.join(T, 'backups'), projectsRoot: path.join(T, 'root') },
  projects: [
    { id: 'a', name: 'A', folder: A, brief: path.join(MC, 'briefs', 'a.md'), workspaces: ['ws-a'] },
    { id: 'b', name: 'B', folder: B, brief: path.join(MC, 'briefs', 'b.md'), workspaces: ['ws-b'] },
    { id: 'c', name: 'C', folder: C, brief: path.join(MC, 'briefs', 'c.md'), workspaces: ['ws-c'] },
  ],
}, null, 2));

const child = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], {
  env: { ...process.env, RAVENRY_HOME: MC, PORT: String(PORT), MC_NO_EVENTS: '1', MC_REPEATS_AUTO: '0', MC_NO_AUTOSTART: '1',
    CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKE, MC_CLAUDE_PROJECTS: CLAUDE, MC_SCRATCH_ROOT: SCRATCH,
    MC_PROJECTS_ROOT: path.join(T, 'root'), MC_GLOBAL_CLAUDE_MD: path.join(T, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(T, 'backups') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.log = '';
child.stdout.on('data', (d) => { child.log += d; });
child.stderr.on('data', (d) => { child.log += d; });

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      const bufs = [];
      res.on('data', (d) => bufs.push(d));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(bufs) }));
    }).on('error', reject);
  });
}

try {
  let st = null;
  const proj = (id) => st && st.projects.find((p) => p.id === id);
  for (let i = 0; i < 100; i++) {
    try { const r = await get('/api/state'); if (r.status === 200) { st = JSON.parse(r.body); if (st.projects.length === 3 && proj('a').brief.pictures.length === 2 && proj('b').brief.pictures.length) break; } } catch { /* starting */ }
    await sleep(150);
  }
  await sleep(2500); // one more tick or so, so C has had its turn too
  st = JSON.parse((await get('/api/state')).body);
  const pa = proj('a');
  const pb = proj('b');
  const pc = proj('c');
  const curOf = (p) => { const s = p && p.sessions.find((x) => x.surfaceId === p.primary); return s ? s.sessionId : null; };
  check('board: each project\'s current session is the one its tab names', curOf(pa) === SA && curOf(pb) === SB && curOf(pc) === SC, `${curOf(pa)} ${curOf(pb)} ${curOf(pc)}`);
  check('board: A and B carry pictures', !!(pa && pb && pa.brief.pictures.length && pb.brief.pictures.length), child.log.slice(-400));
  check('board: the brief\'s own Pictures list comes first', pa.brief.pictures[0].path === 'pics/listed.png' && !pa.brief.pictures[0].auto, JSON.stringify(pa.brief.pictures[0]));
  check('board: the auto pick follows the brief\'s list, and a subagent\'s newer image does not count', pa.brief.pictures.length === 2 && pa.brief.pictures[1].auto && pa.brief.pictures[1].alt === 'Latest picture: a-auto.png', JSON.stringify(pa.brief.pictures[1]));
  const pick = pb.brief.pictures[0];
  check('board: B\'s pick is its current session\'s scratchpad file, not the newer other-session, older-session or outside file', pick.auto && pick.alt === 'Latest picture: b-pick.png', JSON.stringify(pick));
  check('board: C, whose current session touched no image, has no picture (no older session, no folder fallback)', pc && pc.brief && pc.brief.pictures.length === 0, pc ? JSON.stringify(pc.brief.pictures) : 'no C');

  let r = await get(pick.url);
  check('route: the current pick is served', r.status === 200 && r.type === 'image/png' && r.body.equals(PNG), `HTTP ${r.status} ${r.type}`);
  r = await get(pa.brief.pictures[0].url);
  check('route: a brief-listed picture is still served', r.status === 200 && r.type === 'image/png', `HTTP ${r.status}`);
  const refused = [
    ['another file name', '/api/pic/b?auto=other-session.png'],
    ['the outside file by name', '/api/pic/b?auto=b-secret.png'],
    ['A\'s pick asked through B', '/api/pic/b?auto=a-auto.png'],
    ['an absolute path through ?p=', `/api/pic/b?p=${encodeURIComponent(bSecret)}`],
    ['the pick\'s own path through ?p=', `/api/pic/b?p=${encodeURIComponent(bScratch)}`],
    ['../ through ?p=', `/api/pic/a?p=${encodeURIComponent('../../outside/b-secret.png')}`],
    ['a path through ?auto=', `/api/pic/b?auto=${encodeURIComponent(bSecret)}`],
    ['an unknown project', '/api/pic/nope?auto=b-pick.png'],
  ];
  for (const [what, u] of refused) { r = await get(u); check(`route: refuses ${what}`, r.status === 404, `HTTP ${r.status}`); }

  // The pick turns into a symlink to a private file: re-checked on the request.
  fs.rmSync(bScratch);
  fs.symlinkSync(bSecret, bScratch);
  r = await get(pick.url);
  check('route: re-checks the pick on every request (now a symlink out: refused)', r.status === 404, `HTTP ${r.status}`);
  fs.rmSync(bScratch);
  r = await get(pick.url);
  check('route: a pick that is gone is refused', r.status === 404, `HTTP ${r.status}`);
  for (const [what, u] of [['C\'s older session\'s image', '/api/pic/c?auto=old-session.png'], ['C\'s folder image', '/api/pic/c?auto=fresh.png'], ['B\'s older session\'s image', '/api/pic/b?auto=old-session.png']]) {
    r = await get(u); check(`route: refuses ${what}`, r.status === 404, `HTTP ${r.status}`);
  }

  // A hand-off: A's tab now names a fresh session that touched no image.
  const aPick = pa.brief.pictures[1];
  r = await get(aPick.url);
  check('switch: before it, A\'s pick is served', r.status === 200, `HTTP ${r.status}`);
  fake(SA2);
  let pa2 = null;
  for (let i = 0; i < 60; i++) {
    st = JSON.parse((await get('/api/state')).body);
    pa2 = proj('a');
    if (curOf(pa2) === SA2) break;
    await sleep(250);
  }
  check('switch: the board\'s current session for A is the fresh one', curOf(pa2) === SA2, String(curOf(pa2)));
  check('switch: the old session\'s picture is gone at once, only the brief\'s list is left', pa2.brief.pictures.length === 1 && !pa2.brief.pictures[0].auto, JSON.stringify(pa2.brief.pictures));
  r = await get(aPick.url);
  check('switch: the old session\'s picture is no longer served', r.status === 404, `HTTP ${r.status}`);
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  child.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
