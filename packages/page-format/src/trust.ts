// Trust for project pages. A page that came with a repository (a project's
// .ravenry/pages/) shows straight away so it can be read, but someone else
// wrote its buttons, so they stay off until the person trusts it. Trust is
// pinned to the file's path and exact content, the way direnv does it: when
// the file changes (a pull, an edit, an agent), the page is read-only again
// and Ravenry asks again. Global pages and the shipped defaults are the
// person's own and need no trust. Even a trusted page's run buttons go
// through approve-and-run every time.

import type { Action, Page, TextPart } from './model.ts';
import { sha256 } from './sha256.ts';

export interface TrustRecord {
  /** The page file's path, as the host knows it. */
  path: string;
  /** trustHash(path, content). */
  hash: string;
  /** When the person trusted it (ISO). */
  at: string;
}

export type TrustState = 'trusted' | 'changed' | 'untrusted';

/** The SHA-256 of the path and the content together, so the same file
 * moved elsewhere, or another file at the same place, is not trusted. */
export function trustHash(path: string, content: string): string {
  return sha256(`ravenry-page-trust\n${path}\n${content}`);
}

export function trustRecord(path: string, content: string, at: string = new Date().toISOString()): TrustRecord {
  return { path, hash: trustHash(path, content), at };
}

/** trusted: this exact file was trusted. changed: this path was trusted,
 * but the file is different now. untrusted: never trusted. */
export function trustState(path: string, content: string, records: TrustRecord[]): TrustState {
  const mine = records.filter((r) => r.path === path);
  if (!mine.length) return 'untrusted';
  const h = trustHash(path, content);
  return mine.some((r) => r.hash === h) ? 'trusted' : 'changed';
}

/** Records with this path's old entries replaced by the new one. */
export function addTrust(records: TrustRecord[], rec: TrustRecord): TrustRecord[] {
  return [...records.filter((r) => r.path !== rec.path), rec];
}

const shown = (parts: TextPart[]) => parts.map((p) => ('field' in p ? `the item's ${p.field.replace(/\./g, ' ').replace(/_/g, ' ')}` : p.text)).join('');
const word = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : JSON.stringify(w));
/** A project or session a button names: its name as written, or, when the
 * name comes from the item's fields, "named by the item's X" (never "a the
 * item's project session"). */
const named = (noun: string, parts: TextPart[]) => (parts.some((p) => 'field' in p) ? `the ${noun} named by ${shown(parts)}` : `the ${noun} ${shown(parts)}`);

/** What one button would do, in a sentence, for the trust prompt. `root`
 * is the folder its commands run in and its files live in. */
export function explainAction(a: Action, root: string, folder: string | null = null): string {
  switch (a.kind) {
    case 'open':
      switch (a.open.kind) {
        case 'item': return 'Opens the item.';
        case 'file': return "Opens the item's file in your editor.";
        case 'folder': return "Opens the item's folder.";
        case 'page': return `Opens the page ${a.open.page}.`;
        case 'link': return `Opens the address in the item's ${a.open.field}, after showing it to you in full.`;
        case 'project': return `Opens ${named('project', a.open.text)}.`;
        default: return `Opens ${named('session', a.open.text)}.`;
      }
    case 'set': return `Sets ${Object.entries(a.set).map(([k, v]) => `${k} to ${v}`).join(' and ')} in the item's file.`;
    case 'create': return `Makes a new file in ${folder ?? 'the page\'s folder'}, from a form you fill in.`;
    case 'toggle': return "Ticks and unticks boxes in the item's file.";
    case 'copy': return `Copies "${shown(a.copy)}" to the clipboard.`;
    case 'archive': return "Moves the item's file into .archive/. Undo moves it back.";
    case 'ask': {
      const where = !a.session ? "the item's project's session" : a.session.some((p) => 'field' in p) ? named('session', a.session) : `a ${shown(a.session)} session`;
      return a.background
        ? `Asks an agent in ${where} to work on its own: "${shown(a.text)}". You approve it the first time, and again whenever the page changes.`
        : `Types a message into the box of ${where}: "${shown(a.text)}". You choose whether to send it.`;
    }
    case 'run': {
      const env = Object.entries(a.env);
      const vars = env.length ? `, with ${env.map(([k, f]) => `${k} set to the item's ${f.replace(/_/g, ' ')}`).join(' and ')}` : '';
      return `Runs ${a.argv.map(word).join(' ')} in ${a.cwd ? `${root}/${a.cwd.replace(/\/$/, '')}` : root}${vars}. You approve each run first.`;
    }
    case 'plugin': return `Runs ${a.plugin} from its plugin.`;
    default: return a.reason;
  }
}

/** Every button of a page once, with what it would do: the list the trust
 * prompt shows. */
export function explainActions(page: Page, root: string): { label: string; does: string }[] {
  const out: { label: string; does: string }[] = [];
  const seen = new Set<string>();
  const add = (a: Action, folder: string | null) => {
    const does = explainAction(a, root, folder);
    const k = `${a.label}\n${does}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ label: a.label, does });
  };
  const folderOf = (s: { source: Page['source'] }) => (s.source?.kind === 'folder' ? s.source.folder : null);
  for (const a of page.actions) add(a, page.source?.kind === 'folder' ? page.source.folder : null);
  for (const t of page.tabs) for (const s of t.sections) {
    for (const a of s.actions) add(a, folderOf(s));
    if (s.kind === 'core') for (const a of s.item.actions) add(a, folderOf(s));
  }
  return out;
}
