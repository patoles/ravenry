// The terminal settings: the store on disk (src/main/settingsstore.ts), its
// checks and migrations, and what they make of a terminal
// (src/shared/settings.ts). Each test has its own throwaway folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingsStore } from '../src/main/settingsstore.ts';
import { checkPatch, DEFAULTS, fontStack, macOptionIsMetaFor, migrate, normalize, SETTINGS_VERSION, terminalSettings } from '../src/shared/settings.ts';
import type { Settings } from '../src/shared/settings.ts';
import { appearanceOf, BUILT_IN_THEMES, isThemeFile } from '../src/shared/themes.ts';

const FIX = path.join(import.meta.dirname, 'fixtures', 'themes');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rv-settings-'));
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('the built-in themes: eight, each a whole ITheme, dark ones first, appearance true to the background', () => {
  assert.deepEqual(BUILT_IN_THEMES.map((t) => t.id), ['ravenry-dark', 'solarized-dark', 'dracula', 'nord', 'ravenry-light', 'solarized-light', 'github-light', 'paper']);
  for (const t of BUILT_IN_THEMES) {
    assert.ok(isThemeFile(t), t.id);
    assert.equal(appearanceOf(t.theme.background), t.appearance, t.id);
  }
  // Ravenry Dark is the terminal's colours from before settings (src/renderer/terminal.ts).
  const rd = BUILT_IN_THEMES[0].theme;
  assert.equal(rd.background, '#0B0B0C');
  assert.equal(rd.foreground, '#D1D1D6');
  assert.equal(rd.blue, '#409CFF');
  // Ravenry Light is F6's.
  const rl = BUILT_IN_THEMES.find((t) => t.id === 'ravenry-light')!.theme;
  assert.deepEqual([rl.background, rl.foreground, rl.blue, rl.green, rl.red], ['#FBFAF8', '#2C2C30', '#2F6FEB', '#1F8A44', '#C8352B']);
  // The third-party palettes carry their credit.
  for (const id of ['solarized-dark', 'solarized-light', 'dracula', 'nord', 'github-light']) assert.match(BUILT_IN_THEMES.find((t) => t.id === id)!.credit || '', /MIT License/);
});

test('a first launch: the defaults, and no file until something changes', () => {
  const dir = tmp();
  const s = new SettingsStore(dir);
  assert.deepEqual(s.get(), DEFAULTS);
  assert.deepEqual(s.problems, []);
  assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false);
  assert.equal(s.get().optionAsMeta, 'off');
  assert.equal(s.get().scrollback, 10000);
});

test('set: saved at once, read back by a new store, and listeners hear it', () => {
  const dir = tmp();
  const s = new SettingsStore(dir);
  const heard: Settings[] = [];
  s.onChange((v) => heard.push(v));
  const r = s.set({ fontSize: 15, themeDark: 'dracula', optionAsMeta: 'left', bell: 'sound' });
  assert.equal(r.ok, true);
  assert.equal(heard.length, 1);
  assert.equal(heard[0].themeDark, 'dracula');
  const file = readJson(path.join(dir, 'settings.json'));
  assert.equal(file.version, SETTINGS_VERSION);
  assert.equal(file.fontSize, 15);
  const again = new SettingsStore(dir);
  assert.equal(again.get().optionAsMeta, 'left');
  assert.equal(again.get().bell, 'sound');
  // The same values again change nothing and tell no one.
  s.set({ fontSize: 15 });
  assert.equal(heard.length, 1);
});

test('set: a wrong value changes nothing, and says what is wrong', () => {
  const dir = tmp();
  const s = new SettingsStore(dir);
  for (const [patch, why] of [
    [{ fontSize: 99 }, /fontSize.*from 8 to 32/],
    [{ fontSize: 12.5 }, /whole number/],
    [{ scrollback: 50 }, /scrollback/],
    [{ cursorStyle: 'beam' }, /block, bar or underline/],
    [{ optionAsMeta: true }, /off, left, right or both/],
    [{ themeLight: 'no-such-theme' }, /no theme "no-such-theme"/],
    [{ fontFamily: 'Menlo", serif' }, /font family/],
    [{ colour: 'red' }, /colour is not a setting/],
    [{ fontSize: 14, bell: 'loud' }, /bell/],
    [null, /object/],
  ] as [unknown, RegExp][]) {
    const r = s.set(patch);
    assert.equal(r.ok, false, JSON.stringify(patch));
    if (!r.ok) assert.match(r.error, why);
  }
  // All or nothing: fontSize 14 above did not land.
  assert.deepEqual(s.get(), DEFAULTS);
  assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false);
});

test('a file with wrong values: each becomes its default, named in problems; the right ones stay', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 1, fontSize: 'big', cursorBlink: true, bell: 'loud', extra: 1 }));
  const s = new SettingsStore(dir);
  assert.equal(s.get().fontSize, 13);
  assert.equal(s.get().cursorBlink, true);
  assert.equal(s.get().bell, 'visual');
  assert.equal(s.problems.length, 3);
  assert.match(s.problems.join('\n'), /fontSize: "big"/);
  assert.match(s.problems.join('\n'), /extra: not a setting/);
});

test('a file that is not JSON: kept as settings.json.broken, the defaults used', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ "fontSize": 14, ');
  const s = new SettingsStore(dir);
  assert.deepEqual(s.get(), DEFAULTS);
  assert.match(s.problems[0], /not JSON/);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json.broken'), 'utf8'), '{ "fontSize": 14, ');
});

test('migration from version 0 (no version, xterm.js names): renamed, saved as version 1, the old file kept', () => {
  const dir = tmp();
  const v0 = { fontFamily: '"JetBrains Mono", Menlo, monospace', fontSize: 14, macOptionIsMeta: true, bellStyle: 'none', theme: 'nord', cursorStyle: 'bar' };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(v0));
  const s = new SettingsStore(dir);
  assert.deepEqual(s.problems, []);
  const g = s.get();
  assert.equal(g.version, 1);
  assert.equal(g.fontFamily, 'JetBrains Mono');
  assert.equal(g.optionAsMeta, 'both');
  assert.equal(g.bell, 'off');
  assert.equal(g.themeFollowsSystem, false);
  assert.equal(g.themeAlways, 'nord');
  assert.equal(g.cursorStyle, 'bar');
  assert.equal(readJson(path.join(dir, 'settings.json')).version, 1);
  assert.deepEqual(readJson(path.join(dir, 'settings.v0.json')), v0);
  // Pure: each step and the chain.
  assert.deepEqual(migrate({ macOptionIsMeta: false }).data, { optionAsMeta: 'off', version: 1 });
  assert.deepEqual(migrate({ bellStyle: 'sound', bell: 'visual' }).data, { bell: 'visual', version: 1 });
  assert.equal(migrate({ version: 1, fontSize: 12 }).from, 1);
});

test('a file from a newer Ravenry: read for what this version knows, kept as settings.v<N>.json before any write', () => {
  const dir = tmp();
  const v9 = { version: 9, fontSize: 16, ligatures: true };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(v9));
  const s = new SettingsStore(dir);
  assert.equal(s.get().fontSize, 16);
  assert.match(s.problems[0], /newer Ravenry \(version 9\)/);
  assert.deepEqual(readJson(path.join(dir, 'settings.v9.json')), v9);
  // Not written over until the person changes something.
  assert.deepEqual(readJson(path.join(dir, 'settings.json')), v9);
  s.set({ fontSize: 17 });
  assert.equal(readJson(path.join(dir, 'settings.json')).version, 1);
  assert.deepEqual(readJson(path.join(dir, 'settings.v9.json')), v9);
});

test('normalize and checkPatch: the pure checks', () => {
  assert.deepEqual(normalize({}).settings, DEFAULTS);
  assert.match(normalize([1, 2]).problems[0], /not an object/);
  const ok = checkPatch({ fontFamily: '  Fira Code ', themeAlways: 'paper' }, BUILT_IN_THEMES);
  assert.deepEqual(ok, { ok: true, patch: { fontFamily: 'Fira Code', themeAlways: 'paper' } });
  assert.equal(checkPatch({ version: 2 }, BUILT_IN_THEMES).ok, false);
});

test('terminalSettings: the theme follows the system, or one theme always; options for xterm.js', () => {
  const s: Settings = { ...DEFAULTS, themeDark: 'nord', themeLight: 'github-light', fontFamily: 'Fira Code', fontSize: 14, cursorStyle: 'underline', cursorBlink: true, scrollback: 5000 };
  const dark = terminalSettings(s, BUILT_IN_THEMES, 'dark');
  assert.equal(dark.themeId, 'nord');
  assert.equal(dark.xterm.theme.background, '#2E3440');
  assert.equal(terminalSettings(s, BUILT_IN_THEMES, 'light').themeId, 'github-light');
  assert.equal(terminalSettings({ ...s, themeFollowsSystem: false, themeAlways: 'paper' }, BUILT_IN_THEMES, 'dark').themeId, 'paper');
  assert.deepEqual({ ...dark.xterm, theme: undefined }, {
    fontFamily: '"Fira Code", "Menlo", "SF Mono", "DejaVu Sans Mono", "Liberation Mono", monospace',
    fontSize: 14, cursorStyle: 'underline', cursorBlink: true, scrollback: 5000, macOptionIsMeta: false, theme: undefined,
  });
  // A theme that is gone (an imported file removed): Ravenry's own for that appearance.
  assert.equal(terminalSettings({ ...s, themeLight: 'user:gone' }, BUILT_IN_THEMES, 'light').themeId, 'ravenry-light');
  assert.equal(fontStack('Menlo'), '"Menlo", "SF Mono", "DejaVu Sans Mono", "Liberation Mono", monospace');
  assert.equal(terminalSettings({ ...s, optionAsMeta: 'both' }, BUILT_IN_THEMES, 'dark').xterm.macOptionIsMeta, true);
});

test('macOptionIsMetaFor: per Option key', () => {
  assert.equal(macOptionIsMetaFor('off', 'AltLeft'), false);
  assert.equal(macOptionIsMetaFor('both', 'AltRight'), true);
  assert.equal(macOptionIsMetaFor('left', 'AltLeft'), true);
  assert.equal(macOptionIsMetaFor('left', 'AltRight'), false);
  assert.equal(macOptionIsMetaFor('right', 'AltRight'), true);
  assert.equal(macOptionIsMetaFor('right', 'AltLeft'), false);
});

test('importTheme: saved in themes/, listed after the built-ins, usable in set, read back by a new store; the same file twice is one theme', () => {
  const dir = tmp();
  const s = new SettingsStore(dir);
  let heard = 0;
  s.onChange(() => heard++);
  const r = s.importTheme(fs.readFileSync(path.join(FIX, 'Harbour Night.itermcolors'), 'utf8'), 'Harbour Night.itermcolors');
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.theme.id, 'user:harbour-night');
  assert.equal(heard, 1);
  assert.ok(fs.existsSync(path.join(dir, 'themes', 'harbour-night.json')));
  assert.equal(s.themes().at(-1)!.id, 'user:harbour-night');
  assert.equal(s.set({ themeDark: 'user:harbour-night' }).ok, true);
  const again = new SettingsStore(dir);
  assert.equal(again.themes().length, BUILT_IN_THEMES.length + 1);
  assert.equal(terminalSettings(again.get(), again.themes(), 'dark').xterm.theme.background, '#14161E');
  const twice = again.importTheme(fs.readFileSync(path.join(FIX, 'Harbour Night.itermcolors'), 'utf8'), 'Harbour Night.itermcolors');
  assert.ok(twice.ok && twice.theme.id === 'user:harbour-night');
  assert.equal(again.themes().length, BUILT_IN_THEMES.length + 1);
  // Another theme with the same name gets its own id.
  const other = again.importTheme('background = #000000\nforeground = #ffffff\n' + Array.from({ length: 16 }, (_, i) => `palette = ${i}=#11111${i.toString(16)}`).join('\n'), 'Harbour Night');
  assert.ok(other.ok && other.theme.id === 'user:harbour-night-2');
  // A file that is not a theme changes nothing.
  const bad = again.importTheme('hello', 'notes.txt');
  assert.equal(bad.ok, false);
  assert.equal(again.themes().length, BUILT_IN_THEMES.length + 2);
  // A damaged theme file in the folder is left out and named.
  fs.writeFileSync(path.join(dir, 'themes', 'damaged.json'), '{"name":"x"}');
  const third = new SettingsStore(dir);
  assert.equal(third.themes().length, BUILT_IN_THEMES.length + 2);
  assert.match(third.problems.join('\n'), /themes\/damaged.json: not a theme file/);
});
