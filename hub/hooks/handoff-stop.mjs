#!/usr/bin/env node
// Claude Code Stop hook: the clean context hand-off. See docs/HANDOFF.md and
// server/handoffstop.mjs, which decides.
//
// Claude Code's Stop hook, or Codex's (`--assistant=codex` in the command
// Codex's hooks.json names): Codex's Stop hook blocks a stop the same way,
// {"decision":"block","reason":...}, and Codex carries on with the reason
// as its next prompt (measured on 0.166.0, docs/ASSISTANTS.md).
//
// In a ravenryd pane whose hooks also run `ravenryd hook` (this command
// carries --ravenryd), the hub decides through the daemon instead, so this
// copy stands down and the stop is never held twice.
//
// It never fails a stop: any error means exit 0, silently.

import { decideStop } from '../server/handoffstop.mjs';
import { assistantOf, codexDaemon } from '../server/assistanthook.mjs';

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

function done(out) {
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}

async function main() {
  if (process.argv.includes('--ravenryd') && process.env.RAVENRY_PANE && process.env.RAVENRY_SOCKET) return done();
  let input;
  try { input = JSON.parse(await readStdin()); } catch { return done(); }
  return done(await decideStop(input, { assistant: assistantOf(), codexDaemon }));
}

main().catch(() => done());
