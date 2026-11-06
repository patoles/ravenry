// Which page file is used, and in what order the sidebar shows them.
//
// Lookup by id: a project's .ravenry/pages/<id>.page.yaml, else the global
// ~/.ravenry/pages/<id>.page.yaml, else the default Ravenry ships. The id
// is the file name's stem (a page's id must match its file name), so a file
// that cannot be read still takes its place and shows its error, with the
// last version that worked, rather than letting another file stand in.
//
// Order: the shipped pages first, in their order; a copy of one keeps its
// place. Pages you or an agent add come after them, in the order the files
// were made.

import { checkPage } from './check.ts';
import type { CheckOptions, CheckResult } from './check.ts';
import type { Page } from './model.ts';
import { parseYaml } from './yaml.ts';

export type Origin = 'project' | 'global' | 'default';

const RANK: Record<Origin, number> = { project: 0, global: 1, default: 2 };

export interface PageFile {
  origin: Origin;
  /** The file's path, as the host knows it. */
  path: string;
  text: string;
  /** When the file was made (ISO), for the order of added pages. */
  created?: string;
}

export interface ResolvedPage {
  id: string;
  origin: Origin;
  path: string;
  text: string;
  result: CheckResult;
  /** The files with the same id this one replaces, nearest first. */
  replaces: { origin: Origin; path: string }[];
  /** Its place among the shipped pages, when it is one or a copy of one. */
  slot: number | null;
  /** A project page: its buttons stay off until the person trusts it (trust.ts). */
  needsTrust: boolean;
  /** A copy whose default has a newer revision than the one it came from. */
  defaultChanged: boolean;
}

export function idOfPath(path: string): string | null {
  const base = path.split(/[\\/]/).pop() ?? '';
  return base.endsWith('.page.yaml') ? base.slice(0, -'.page.yaml'.length) : null;
}

/** The revision of a default page's text, read without a full check. */
function revisionOf(text: string): number | null {
  const y = parseYaml(text);
  const v = y.value as Record<string, unknown> | undefined;
  return v && typeof v.revision === 'number' ? v.revision : null;
}

/** Resolves every page file the host found into the sidebar's pages. */
export function resolvePages(files: PageFile[], opts: Omit<CheckOptions, 'fileName'> = {}): ResolvedPage[] {
  const byId = new Map<string, PageFile[]>();
  for (const f of files) {
    const id = idOfPath(f.path);
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)!.push(f);
  }
  const defaults = files.filter((f) => f.origin === 'default').map((f) => idOfPath(f.path)).filter((x): x is string => !!x);
  const out: ResolvedPage[] = [];
  for (const [id, list] of byId) {
    const sorted = [...list].sort((a, b) => RANK[a.origin] - RANK[b.origin]);
    const win = sorted[0];
    const result = checkPage(win.text, { ...opts, fileName: win.path.split(/[\\/]/).pop() });
    const def = list.find((f) => f.origin === 'default');
    let changed = false;
    if (def && win !== def && result.page?.from) {
      const rev = revisionOf(def.text);
      changed = rev !== null && result.page.from.revision < rev;
    }
    const slot = defaults.indexOf(id);
    out.push({
      id, origin: win.origin, path: win.path, text: win.text, result,
      replaces: sorted.slice(1).map((f) => ({ origin: f.origin, path: f.path })),
      slot: slot >= 0 ? slot : null, needsTrust: win.origin === 'project', defaultChanged: changed,
    });
  }
  const made = (r: ResolvedPage) => files.find((f) => f.path === r.path)?.created ?? '';
  return out.sort((a, b) => {
    if (a.slot !== null || b.slot !== null) return (a.slot ?? Infinity) - (b.slot ?? Infinity);
    return made(a).localeCompare(made(b)) || a.path.localeCompare(b.path);
  });
}

/** Customize: the default's text as the person's own copy, stamped with
 * where it came from (from: ravenry/<id>@<revision>) and without the
 * default's revision line. Everything else, comments too, stays as written. */
export function customize(defaultText: string, owner = 'ravenry'): string {
  const lines = defaultText.split('\n');
  let id: string | null = null;
  let revision: number | null = null;
  const kept: string[] = [];
  for (const l of lines) {
    const r = l.match(/^revision:\s*(\d+)\s*(#.*)?$/);
    if (r) { revision = Number(r[1]); continue; }
    if (/^from:/.test(l)) continue;
    kept.push(l);
  }
  const at = kept.findIndex((l) => /^id:\s*\S/.test(l));
  if (at >= 0) id = kept[at].replace(/^id:\s*/, '').replace(/\s*#.*$/, '').replace(/^["']|["']$/g, '');
  if (!id || revision === null) throw new Error('A shipped page needs id and revision lines at the top level.');
  kept.splice(at + 1, 0, `from: ${owner}/${id}@${revision}`);
  return kept.join('\n');
}

/** Has the default changed since this copy was made from it? */
export function defaultChanged(copy: Page, def: Page): boolean {
  return !!copy.from && def.revision !== null && copy.from.id === def.id && copy.from.revision < def.revision;
}
