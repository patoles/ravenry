// Theme import (src/main/themeimport.ts), on samples in the exact shape
// iTerm2 and Ghostty save (test/fixtures/themes, written for these tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fromGhostty, fromItermcolors, importTheme, nameFromFile, parsePlist } from '../src/main/themeimport.ts';
import { isThemeFile, parseHex } from '../src/shared/themes.ts';

const FIX = path.join(import.meta.dirname, 'fixtures', 'themes');
const read = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8');

test('.itermcolors (iTerm2 3.5, sRGB): every colour, named from the file, dark', () => {
  const r = importTheme(read('Harbour Night.itermcolors'), 'Harbour Night.itermcolors');
  assert.ok(r.ok, !r.ok ? r.error : '');
  if (!r.ok) return;
  assert.equal(r.theme.name, 'Harbour Night');
  assert.equal(r.theme.appearance, 'dark');
  const t = r.theme.theme;
  assert.deepEqual([t.background, t.foreground, t.cursor, t.cursorAccent, t.selectionBackground, t.selectionForeground], ['#14161E', '#C8CCD4', '#F2C14E', '#14161E', '#2F3B54', '#FFFFFF']);
  assert.deepEqual([t.black, t.red, t.blue, t.brightWhite], ['#1B1E28', '#E06C75', '#61AFEF', '#E6E9EF']);
  assert.ok(isThemeFile(r.theme));
});

test('.itermcolors (iTerm2 3.4, Display P3, (Dark)/(Light) variants only, no cursor): converted to sRGB, light', () => {
  const r = fromItermcolors(read('Dune Paper.itermcolors'), 'Dune Paper');
  assert.ok(r.ok, !r.ok ? r.error : '');
  if (!r.ok) return;
  assert.equal(r.theme.appearance, 'light');
  const t = r.theme.theme;
  // P3 values come out more saturated in sRGB: the red is redder than the raw numbers.
  const raw = parseHex('#B5462F')!;
  const out = parseHex(t.red)!;
  assert.notDeepEqual(out, raw);
  assert.ok(out[0] >= raw[0] && out[1] <= raw[1], `${t.red} from P3 #B5462F`);
  // A grey stays a grey.
  const fg = parseHex(t.foreground)!;
  assert.ok(Math.abs(fg[0] - 0x3A) <= 2 && Math.abs(fg[2] - 0x31) <= 3, t.foreground);
  // No cursor colours: the foreground and background.
  assert.equal(t.cursor, t.foreground);
  assert.equal(t.cursorAccent, t.background);
});

test('.itermcolors that is cut short: a plain reason, no theme', () => {
  const r = importTheme(read('Broken.itermcolors'), 'Broken.itermcolors');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /not a readable \.itermcolors file/);
  const empty = fromItermcolors('<?xml version="1.0"?><plist version="1.0"><dict/></plist>', 'x');
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.error, /no Ansi 0 Color/);
});

test('parsePlist: the value types, entities and comments', () => {
  const v = parsePlist(`<?xml version="1.0"?><!-- c --><plist version="1.0"><dict>
    <key>a &amp; b</key><string>x &lt;y&gt;</string><key>n</key><integer>-3</integer><key>r</key><real>0.5</real>
    <key>t</key><true/><key>f</key><false/><key>arr</key><array><string>1</string><dict/></array><key>e</key><string/></dict></plist>`);
  assert.deepEqual(v, { 'a & b': 'x <y>', n: -3, r: 0.5, t: true, f: false, arr: ['1', {}], e: '' });
});

test('Ghostty theme (as Ghostty bundles them): palette lines, colours without #, comments; palette 16+ ignored', () => {
  const r = importTheme(read('Kelp Forest'), 'Kelp Forest');
  assert.ok(r.ok, !r.ok ? r.error : '');
  if (!r.ok) return;
  assert.equal(r.theme.name, 'Kelp Forest');
  assert.equal(r.theme.appearance, 'dark');
  const t = r.theme.theme;
  assert.deepEqual([t.background, t.foreground, t.cursor, t.cursorAccent, t.selectionBackground, t.selectionForeground], ['#141B17', '#C9D1CB', '#E3C07A', '#141B17', '#2C3A33', '#EEF3EF']);
  assert.deepEqual([t.black, t.green, t.brightWhite], ['#1D2521', '#8FC887', '#EEF3EF']);
});

test('Ghostty theme with CRLF, spaces around palette\'s =, a named colour and cursor-color = cell-foreground: light', () => {
  const r = fromGhostty(read('Snow Field'), 'Snow Field');
  assert.ok(r.ok, !r.ok ? r.error : '');
  if (!r.ok) return;
  assert.equal(r.theme.appearance, 'light');
  assert.equal(r.theme.theme.brightWhite, '#FFFFFF');
  assert.equal(r.theme.theme.blue, '#4271AE');
  // Ghostty's own cursor value: the foreground stands in.
  assert.equal(r.theme.theme.cursor, '#333333');
});

test('Ghostty theme missing palette colours, or not one at all: a plain reason', () => {
  const half = importTheme(read('Half Ghost'), 'Half Ghost');
  assert.equal(half.ok, false);
  if (!half.ok) assert.match(half.error, /no palette = 2/);
  const prose = importTheme('This is a note about colours.\n', 'notes.txt');
  assert.equal(prose.ok, false);
  if (!prose.ok) assert.match(prose.error, /not a Ghostty theme file/);
  const empty = importTheme('# only a comment\n', 'x');
  assert.equal(empty.ok, false);
  const nobg = importTheme('foreground = #fff\n', 'x');
  assert.equal(nobg.ok, false);
  if (!nobg.ok) assert.match(nobg.error, /no background/);
});

test('nameFromFile', () => {
  assert.equal(nameFromFile('/Users/x/Downloads/Tokyo Night.itermcolors'), 'Tokyo Night');
  assert.equal(nameFromFile('catppuccin_mocha'), 'catppuccin mocha');
  assert.equal(nameFromFile(''), 'Imported theme');
});
