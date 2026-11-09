// Ravenry's words from the shared file (shared/strings/en.json), the same
// the phone board and the hub read (shared/README.md: one key per string,
// {name} placeholders). t('page.empty'), t('some.key', { name: 'Ada' }).
// A key the file does not have shows as the key itself; the desktop's
// tests check that every key a client asks for is there.
import en from '../../../../shared/strings/en.json' with { type: 'json' };

export type StringKey = Exclude<keyof typeof en, '$comment'>;

/** Fills {name} with vars.name; a placeholder without a value stays as it is. */
export function format(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function t(key: StringKey, vars?: Record<string, string | number>): string {
  const s = (en as Record<string, string>)[key];
  return s === undefined ? key : format(s, vars);
}
