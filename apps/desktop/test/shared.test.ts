// The shared design tokens and words (shared/README.md): the CSS the builds
// generate from shared/tokens/tokens.json says exactly what the file says,
// no client stylesheet types a token again, and every key the desktop and
// the phone ask shared/strings/en.json for is there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readTokens, sharedVars, themeVars, tokensCss } from '../../../shared/tokens/css.mjs';
import { format, t } from '../src/shared/strings.ts';

const REPO = path.join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
const tokens = readTokens();

/** The custom properties declared in a block of CSS. */
function decls(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

test('the generated CSS holds every token with its value, dark by default and light under the media query', () => {
  const css = tokensCss(tokens);
  const at = css.indexOf('@media (prefers-color-scheme: light)');
  assert.ok(at > 0);
  const dark = decls(css.slice(0, at));
  const light = decls(css.slice(at));
  assert.match(css.slice(0, at), /color-scheme: dark;/);
  assert.match(css.slice(at), /color-scheme: light;/);
  const wantDark = new Map([...themeVars(tokens, 'dark'), ...sharedVars(tokens)]);
  const wantLight = new Map(themeVars(tokens, 'light'));
  assert.deepEqual(dark, wantDark);
  assert.deepEqual(light, wantLight);
  for (const [k, v] of Object.entries(tokens.color.dark)) assert.equal(dark.get(`--${k}`), v, k);
  for (const [k, v] of Object.entries(tokens.color.light)) assert.equal(light.get(`--${k}`), v, k);
  for (const [k, v] of Object.entries(tokens.size)) assert.equal(dark.get(`--fs-${k}`), `${v}px`, k);
  for (const [k, v] of Object.entries(tokens.radius)) assert.equal(dark.get(`--radius-${k}`), `${v}px`, k);
  for (const [k, v] of Object.entries(tokens.space)) assert.equal(dark.get(`--space-${k}`), `${v}px`, k);
  assert.equal(dark.get('--font-ui')!.split(', ')[2], "'SF Pro Text'");
});

test('tokens.json: both themes name the same colours and shadows, in the documented formats', () => {
  assert.deepEqual(Object.keys(tokens.color.light), Object.keys(tokens.color.dark));
  assert.deepEqual(Object.keys(tokens.shadow.light), Object.keys(tokens.shadow.dark));
  const colour = /^(#[0-9A-F]{6}|rgba\(\d{1,3},\d{1,3},\d{1,3},(0|1|0?\.\d+)\))$/;
  for (const th of ['dark', 'light'] as const) {
    for (const [k, v] of Object.entries(tokens.color[th])) assert.match(v as string, colour, `${th} ${k}`);
    for (const k of ['you', 'work', 'wait', 'idle', 'win', 'sheet', 'tx', 'tx2', 'tx3']) assert.ok(k in tokens.color[th], `${th} ${k}`);
  }
  // The phone's drift is gone: the desktop's values.
  assert.equal(tokens.color.dark.tx3, '#8E8E93');
  assert.equal(tokens.color.light.tx3, '#6B6B70');
  for (const group of ['size', 'radius', 'space', 'lineHeight']) {
    for (const [k, v] of Object.entries(tokens[group] as Record<string, number>)) assert.ok(typeof v === 'number' && v > 0, `${group} ${k}`);
  }
});

test('no client stylesheet types a token again; the desktop ones import them', () => {
  const names = new Set([...themeVars(tokens, 'dark'), ...sharedVars(tokens)].map(([n]) => n));
  for (const f of ['apps/desktop/src/renderer/app.css', 'apps/desktop/src/renderer/phase2.css', 'apps/desktop/src/renderer/machines.css', 'apps/desktop/src/settings/settings.css', 'apps/phone/src/phone.css']) {
    const typed = [...decls(read(f)).keys()].filter((n) => names.has(n));
    assert.deepEqual(typed, [], f);
  }
  for (const f of ['apps/desktop/src/renderer/app.css', 'apps/desktop/src/settings/settings.css']) {
    assert.match(read(f), /^(\/\*[\s\S]*?\*\/\s*)?@import "ravenry-tokens\.css";/, f);
  }
});

test('t() reads shared/strings/en.json: the section titles, placeholders, an unknown key', () => {
  assert.equal(t('group.you'), 'Needs you');
  assert.equal(t('group.wait'), 'Waiting on others');
  assert.equal(format('Waiting on {name}', { name: 'Ada' }), 'Waiting on Ada');
  assert.equal(format('Waiting on {name}', {}), 'Waiting on {name}');
  assert.equal(t('no.such' as never), 'no.such');
});

test('every key the desktop and the phone ask for is in en.json', () => {
  const en = JSON.parse(read('shared/strings/en.json')) as Record<string, string>;
  const dirs = ['apps/desktop/src/renderer', 'apps/desktop/src/settings', 'apps/desktop/src/shared', 'apps/phone/src'];
  const asked = new Set<string>();
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(REPO, d)).filter((n) => n.endsWith('.ts'))) {
      const src = read(path.join(d, f));
      // The reader is imported as t, or under another name where t is taken.
      const names = ['t', ...[...src.matchAll(/import \{ t as (\w+) \} from '[./]+(?:shared\/)?strings\.ts'/g)].map((m) => m[1])];
      if (!/strings\.ts'/.test(src)) continue;
      for (const n of names) for (const m of src.matchAll(new RegExp(`\\b${n}\\('([\\w.]+)'`, 'g'))) asked.add(m[1]);
    }
  }
  assert.ok(asked.size >= 15, `found ${asked.size} keys`);
  for (const k of asked) assert.ok(k in en, k);
});
