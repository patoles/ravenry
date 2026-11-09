// Ravenry's words for what the hub sends (a section's title, a checkpoint's
// words): read from the shared file every client reads too,
// shared/strings/en.json at the repository's root (shared/README.md: one
// key per string, {name} placeholders).
//
//   import { t } from './strings.mjs';
//   t('group.you')                    // "Needs you"
//   t('some.key', { name: 'Ada' })    // {name} filled in
//
// Where the file is: hub/shared/strings/en.json when the hub is shipped
// inside the app (apps/desktop/scripts/pack.mjs copies shared/ there), else
// ../../shared/strings/en.json from this folder (the repository). It is read
// once, on the first t(). A key the file does not have comes back as the
// key itself, and a placeholder without a value stays as it is.
import fs from 'node:fs';

const CANDIDATES = [
  new URL('../shared/strings/en.json', import.meta.url),
  new URL('../../shared/strings/en.json', import.meta.url),
];

let table = null;

/** The words, key to text. */
export function strings() {
  if (table) return table;
  for (const u of CANDIDATES) {
    if (!fs.existsSync(u)) continue;
    table = JSON.parse(fs.readFileSync(u, 'utf8'));
    return table;
  }
  throw new Error('shared/strings/en.json was not found beside the hub');
}

/** Fills {name} with vars.name. */
export function format(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
}

/** The text of a key, its placeholders filled. */
export function t(key, vars) {
  const s = strings()[key];
  return typeof s === 'string' && key !== '$comment' ? format(s, vars) : key;
}
