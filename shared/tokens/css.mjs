// The design tokens (tokens.json beside this file) as CSS variables, for the
// web clients: the desktop's build (apps/desktop/build.mjs, as the
// stylesheet "ravenry-tokens.css" that app.css and settings.css import) and
// the phone's (apps/phone/build.mjs, put before its stylesheet). The
// stylesheets never type these values themselves (shared/README.md).
//
//   :root { color-scheme: dark; --win: #161618; ... --fs-base: 13px; ... }
//   @media (prefers-color-scheme: light) { :root { color-scheme: light; ... } }
//
// Names: a colour or a shadow is --<key> (--win, --tx3, --you-t, --shadow);
// a font family --font-<key>, a size --fs-<key>, a line height --lh-<key>,
// a radius --radius-<key>, a spacing --space-<key>. Numbers are CSS pixels
// (line heights have no unit). Dark is the default; light only changes the
// colours and the shadows.
import fs from 'node:fs';

export const TOKENS_PATH = new URL('./tokens.json', import.meta.url);

export function readTokens() {
  return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
}

const family = (names) => names.map((n) => (/^[\w-]+$/.test(n) ? n : `'${n}'`)).join(', ');

/** Every CSS variable of one theme, as [name, value] pairs, in tokens.json's order. */
export function themeVars(tokens, theme) {
  const vars = [];
  for (const [k, v] of Object.entries(tokens.color[theme])) vars.push([`--${k}`, v]);
  for (const [k, v] of Object.entries(tokens.shadow[theme])) vars.push([`--${k}`, v]);
  return vars;
}

/** The variables that do not change with the theme. */
export function sharedVars(tokens) {
  const vars = [];
  for (const [k, v] of Object.entries(tokens.font)) vars.push([`--font-${k}`, family(v)]);
  for (const [k, v] of Object.entries(tokens.size)) vars.push([`--fs-${k}`, `${v}px`]);
  for (const [k, v] of Object.entries(tokens.lineHeight)) vars.push([`--lh-${k}`, String(v)]);
  for (const [k, v] of Object.entries(tokens.radius)) vars.push([`--radius-${k}`, `${v}px`]);
  for (const [k, v] of Object.entries(tokens.space)) vars.push([`--space-${k}`, `${v}px`]);
  return vars;
}

const block = (vars) => vars.map(([n, v]) => `  ${n}: ${v};`).join('\n');

/** The stylesheet: dark by default, light under prefers-color-scheme. */
export function tokensCss(tokens = readTokens()) {
  return [
    '/* Generated from shared/tokens/tokens.json by shared/tokens/css.mjs. Do not edit. */',
    ':root {',
    '  color-scheme: dark;',
    block([...themeVars(tokens, 'dark'), ...sharedVars(tokens)]),
    '}',
    '@media (prefers-color-scheme: light) {',
    ':root {',
    '  color-scheme: light;',
    block(themeVars(tokens, 'light')),
    '}',
    '}',
    '',
  ].join('\n');
}
