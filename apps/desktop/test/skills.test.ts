// The Ravenry skill (src/main/skills.ts): installed for an assistant, then
// removed, the folder is exactly as it was: a skill of the person's stays,
// a ravenry skill that was there comes back, and folders the install made
// go. Only folders under the system's temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installSkill, removeSkill, skillDir, skillStatus } from '../src/main/skills.ts';

function tree(d: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (x: string) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const f = path.join(x, e.name); if (e.isDirectory()) { out[path.relative(d, f) + '/'] = ''; walk(f); } else out[path.relative(d, f)] = fs.readFileSync(f, 'utf8'); } };
  if (fs.existsSync(d)) walk(d);
  return out;
}

test('install then remove: the skills folder as it was, a skill of the person\'s kept', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rvsk-'));
  const env = {};
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'rex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'rex', 'SKILL.md'), 'theirs\n');
  const before = tree(home);
  const undo = path.join(home, 'data', 'skills-undo.json');
  const st = installSkill('claude', '/Apps/Ravenry/bin/ravenry', '0.1.21', undo, env, home);
  assert.ok(st.installed && st.ours && st.version === '0.1.21');
  const text = fs.readFileSync(path.join(skillDir('claude', env, home), 'SKILL.md'), 'utf8');
  assert.match(text, /^---\nname: ravenry\n/);
  assert.match(text, /Run `"\/Apps\/Ravenry\/bin\/ravenry" skill`/);
  removeSkill('claude', undo, env, home);
  fs.rmSync(path.join(home, 'data'), { recursive: true, force: true });
  assert.deepEqual(tree(home), before);
});

test('a ravenry skill that was there comes back; folders the install made go', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rvsk-'));
  const env = {};
  const undo = path.join(home, 'u.json');
  // Codex's folder did not exist: made, then gone.
  installSkill('codex', '/bin/ravenry', '0.1.21', undo, env, home);
  assert.ok(fs.existsSync(path.join(home, '.codex', 'skills', 'ravenry', 'SKILL.md')));
  removeSkill('codex', undo, env, home);
  assert.ok(!fs.existsSync(path.join(home, '.codex')));
  // Someone's own ravenry skill: Ravenry writes over it only when asked, and Remove puts it back.
  const dir = skillDir('claude', env, home);
  fs.mkdirSync(path.join(dir, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'mine\n');
  fs.writeFileSync(path.join(dir, 'refs', 'a.md'), 'a\n');
  const before = tree(path.join(home, '.claude'));
  assert.equal(skillStatus('claude', env, home).ours, false);
  installSkill('claude', '/bin/ravenry', '0.1.21', undo, env, home);
  removeSkill('claude', undo, env, home);
  assert.deepEqual(tree(path.join(home, '.claude')), before);
  // Not ours: Remove leaves it alone.
  removeSkill('claude', undo, env, home);
  assert.deepEqual(tree(path.join(home, '.claude')), before);
});
