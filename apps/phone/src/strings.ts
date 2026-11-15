// The phone board's words from the shared file (shared/strings/en.json), as
// the desktop and the hub read it (shared/README.md: one key per string,
// {name} placeholders). A key the file does not have shows as the key.
import en from '../../../shared/strings/en.json' with { type: 'json' };

export type StringKey = Exclude<keyof typeof en, '$comment'>;

export function t(key: StringKey, vars?: Record<string, string | number>): string {
  const s = (en as Record<string, string>)[key];
  if (s === undefined) return key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** The phone's own check before Run (shared/strings phone.bio.*): "a fingerprint" on Android, "Face ID" on an iPhone. */
export const bioWord = (platform: string): string => t(platform === 'ios' ? 'phone.bio.ios' : 'phone.bio.android');
