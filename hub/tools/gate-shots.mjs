#!/usr/bin/env node
// Headless screenshots of a plan gate the file alone passed
// (docs/PERSON.md, "A plan's gate"), never on screen: a scratch board with
// a fake cmux and a project whose plan waits at a gate; the brief is then
// edited the way an agent would (the gate ticked, an Answer written under
// it), and the project page is shot on the desktop and the phone, light
// and dark; then the same after the gate is taken out of the file.
//
//   node tools/gate-shots.mjs <outDir>
import { withTestHome } from './test-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, '.tmp', 'gate-shots'));
fs.mkdirSync(OUT, { recursive: true });
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'gate-shots-'));
const MC = path.join(T, 'mc');
const PROJ = path.join(T, 'recipe-box');
for (const d of [MC, PROJ]) fs.mkdirSync(d, { recursive: true });
const BRIEF = path.join(PROJ, 'BRIEF.md');
fs.writeFileSync(BRIEF, [
  '# Recipe box', '', 'Goal: Import old recipes and publish 2.3.0.', 'Stage: Build', '',
  '## Plan', '### Publish 2.3.0', 'Runs on its own. Started: 2026-11-06 17:20. Not in the plan: stop and ask.', 'Goal: "Publish 2.3.0 once the import tests pass"', '',
  '- [x] Do: Run the import tests', '  - Proof: 48 passed, 0 failed (17:31)',
  '- [?] Gate: Ask me before publishing', '  - Choices: Publish it | Not yet', '  - Question: The import tests pass. Publish 2.3.0 to npm now?',
  '- [ ] Do: Publish 2.3.0',
  '- [ ] Gate: Ask me before telling the testers', '  - Choices: Tell them | Not yet',
  '- [ ] Do: Tell the testers', '',
  'Log:', '- 17:20 Started from your words, after you checked the steps', '- 17:31 Step 1: the import tests pass', '',
  '## Next step', 'Publish.', '',
].join('\n'));
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false, projectsRoot: T }, projects: [{ id: 'recipe-box', name: 'recipe-box', folder: PROJ, workspaces: [], brief: 'BRIEF.md' }] }, null, 2));
const PORT = 4797;
const env = withTestHome({
  ...process.env, RAVENRY_HOME: MC, PORT: String(PORT), MC_NO_EVENTS: '1', MC_REPEATS_AUTO: '0', MC_NO_AUTOSTART: '1', MC_PROJECTS_ROOT: T,
  CMUX_BIN: path.join(ROOT, 'tools', 'fake-cmux.mjs'), FAKE_CMUX_STATE: path.join(T, 'fake-cmux.json'), MC_CODEX: '0',
});
const board = spawn(process.execPath, [path.join(ROOT, 'server/index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
board.stdout.on('data', (d) => { log += d; });
board.stderr.on('data', (d) => { log += d; });
process.on('exit', () => board.kill('SIGTERM'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://localhost:${PORT}`;
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(150);
  }
}
const proj = async () => (await (await fetch(base + '/api/state')).json()).projects.find((p) => p.id === 'recipe-box');
if (!(await until(async () => (await proj())?.plan?.state === 'gate'))) { console.error('the board did not show the plan\n' + log); process.exit(1); }

const browser = await chromium.launch({ headless: true });
async function shoot(tag) {
  for (const s of [{ name: 'desktop-dark', w: 1440, h: 1000, theme: 'dark' }, { name: 'desktop-light', w: 1440, h: 1000, theme: 'light' }, { name: 'phone-dark', w: 390, h: 844, theme: 'dark', mobile: true }]) {
    const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 2, isMobile: !!s.mobile, hasTouch: !!s.mobile, colorScheme: s.theme });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    await page.goto(`${base}/?theme=${s.theme}#recipe-box`);
    await page.waitForSelector('.pl-fileonly', { timeout: 15000 });
    await page.waitForTimeout(500);
    if (s.mobile) { await page.evaluate(() => document.querySelector('.pl-fileonly').scrollIntoView({ block: 'center' })); await page.waitForTimeout(200); }
    const file = path.join(OUT, `gate-${tag}-${s.name}.png`);
    await page.screenshot({ path: file });
    console.log('wrote', file);
    await ctx.close();
  }
}

// The agent ticks its own gate and answers it in the file.
fs.writeFileSync(BRIEF, fs.readFileSync(BRIEF, 'utf8').replace('- [?] Gate: Ask me before publishing', '- [x] Gate: Ask me before publishing\n  - Answer: Publish it (17:33)'));
if (!(await until(async () => (await proj())?.planGate?.fileOnly === 'ticked'))) { console.error('no file-only gate\n' + log); process.exit(1); }
await shoot('ticked');
// It takes the next gate out instead.
fs.writeFileSync(BRIEF, fs.readFileSync(BRIEF, 'utf8').replace('- [x] Gate: Ask me before publishing\n  - Answer: Publish it (17:33)', '- [?] Gate: Ask me before publishing').replace(/- \[ \] Gate: Ask me before telling the testers\n {2}- Choices: Tell them \| Not yet\n/, ''));
const g2 = await until(async () => { const p = await proj(); return p?.planGate?.fileOnly === 'removed' ? p : null; });
if (!g2) { console.error('no removed gate\n' + JSON.stringify((await proj())?.plan?.gate) + log); process.exit(1); }
await shoot('removed');
await browser.close();
board.kill('SIGTERM');
fs.rmSync(T, { recursive: true, force: true });
