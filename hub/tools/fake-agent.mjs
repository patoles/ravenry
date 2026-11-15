// A stand-in for a Claude Code or Codex session in a Ravenry pane, for the
// card-answer test: it draws the prompt the screen parsers look for
// (Claude Code's "────\n❯ \n────" box, or Codex's "› Ask Codex to do
// anything" with its footer), and for every line typed into it:
//   - appends { at, line } to FAKE_AGENT_LOG, so the test reads exactly
//     what arrived;
//   - writes it to FAKE_AGENT_TRANSCRIPT as the real one records a prompt
//     (a Claude Code `user` record, or a Codex rollout's user message), so
//     the hub reads it as it would read the real session's.
// FAKE_AGENT=codex draws Codex; anything else Claude Code. Never a real
// assistant: nothing here calls a model.
import crypto from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';

const CODEX = process.env.FAKE_AGENT === 'codex';
const LOG = process.env.FAKE_AGENT_LOG || '';
const TRANSCRIPT = process.env.FAKE_AGENT_TRANSCRIPT || '';
const SID = process.env.FAKE_AGENT_SESSION || '';
const CWD = process.env.FAKE_AGENT_CWD || process.cwd();
const W = Math.max(40, Math.min(process.stdout.columns || 100, 140));
const RULE = '─'.repeat(W);
const got = [];

function draw() {
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(`stand-in ${CODEX ? 'codex' : 'claude'} for ravenry tests\n\n`);
  for (const l of got.slice(-12)) process.stdout.write(`${CODEX ? '•' : '⏺'} received: ${l}\n`);
  if (CODEX) process.stdout.write('\n› Ask Codex to do anything\n\n  ? for shortcuts · 100% context left\x1b[3A\x1b[3G');
  else process.stdout.write(`\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ stand-in prompt (ravenry test)\x1b[2A\x1b[3G`);
}

function record(line) {
  const at = new Date().toISOString();
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ at, line }) + '\n');
  if (!TRANSCRIPT) return;
  const rec = CODEX
    ? { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: line }] } }
    : { type: 'user', sessionId: SID, cwd: CWD, timestamp: at, uuid: crypto.randomUUID(), message: { role: 'user', content: line } };
  fs.appendFileSync(TRANSCRIPT, JSON.stringify(rec) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => { line = line.replace(/\x1b\[20[01]~/g, '').replace(/\r$/, ''); if (!line) return; got.push(line); record(line); draw(); });
draw();
