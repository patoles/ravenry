// The typed model of a page file, version 1, after checking. A renderer
// (the desktop app, the phone, the hub) draws this and never the raw YAML:
// defaults are filled in, unknown views and actions are already replaced by
// their fallback or a placeholder, and every field a slot names exists.

export const FORMAT_VERSION = 1;

export type FieldType = 'string' | 'number' | 'date' | 'bool' | 'enum' | 'list' | 'image' | 'object';

export interface FieldSpec {
  name: string;
  type: FieldType;
  /** The name shown in forms and table headers. */
  label: string;
  /** enum: its values, in order. */
  values?: string[];
  default?: unknown;
  required: boolean;
  /** title, body, file, created, modified: every folder item has them. */
  builtin: boolean;
  /** An app write can change it (a folder's declared fields, and title). */
  writable: boolean;
  /** object, or a list of objects: the entries' fields. */
  fields?: Record<string, FieldSpec>;
  description?: string;
}

export type Source =
  | { kind: 'folder'; folder: string; fields: Record<string, FieldSpec> }
  | { kind: 'files'; files: string; fields: Record<string, FieldSpec> }
  /** known: a built-in provider, or a plugin's this Ravenry has. */
  | { kind: 'provider'; provider: string; plugin: boolean; known: boolean; fields: Record<string, FieldSpec> | null };

export type Scalar = string | number | boolean;

export type Condition =
  | { op: 'eq'; field: string; value: Scalar }
  | { op: 'in'; field: string; values: Scalar[] }
  | { op: 'gt' | 'gte' | 'lt' | 'lte'; field: string; value: Scalar }
  | { op: 'ne'; field: string; values: Scalar[] }
  | { op: 'has'; field: string }
  | { op: 'not'; filter: Filter }
  | { op: 'any'; filters: Filter[] };

/** Every condition must hold. */
export interface Filter { all: Condition[] }

export interface SortKey { field: string; desc: boolean }

export type Progress =
  | { kind: 'number'; field: string; style: 'bar' | 'dots' | 'count' }
  | { kind: 'ratio'; done: string; total: string; style: 'bar' | 'dots' | 'count' }
  | { kind: 'list'; list: string; style: 'bar' | 'dots' | 'count' };

export interface ItemSpec {
  title: string;
  subtitle: string | null;
  badges: string[];
  progress: Progress | null;
  image: string | null;
  time: string | null;
  checklist: string | null;
  excerpt: string | null;
  place: string | null;
  detail: string | null;
  actions: Action[];
}

/** A piece of action text: plain, or a field's value going in as data. */
export type TextPart = { text: string } | { field: string };

export interface ActionBase {
  label: string;
  icon: string | null;
  confirm: TextPart[] | null;
  when: Filter | null;
}

export type OpenTarget =
  | { kind: 'item' } | { kind: 'file' } | { kind: 'folder' }
  | { kind: 'page'; page: string }
  | { kind: 'link'; field: string }
  | { kind: 'project'; text: TextPart[] }
  | { kind: 'session'; text: TextPart[] };

export type Action = ActionBase & (
  | { kind: 'open'; open: OpenTarget }
  | { kind: 'set'; set: Record<string, Scalar> }
  | { kind: 'create'; create: Record<string, unknown> }
  | { kind: 'toggle'; toggle: 'body' }
  | { kind: 'copy'; copy: TextPart[] }
  | { kind: 'archive' }
  | { kind: 'ask'; session: TextPart[] | null; text: TextPart[]; background: boolean }
  | { kind: 'run'; argv: string[]; env: Record<string, string>; cwd: string | null }
  | { kind: 'plugin'; plugin: string; with: Record<string, unknown> }
  /** Not something this Ravenry can do (an unknown kind, or a plugin it does
   * not have) and no fallback: drawn as a button that is off. */
  | { kind: 'off'; reason: string }
);

export type CoreView = 'list' | 'cards' | 'board' | 'table' | 'stats' | 'document';

export interface Column { field: string; label: string; align: 'start' | 'end' }

export type Stat = { label: string; note: string | null } & (
  | { kind: 'count'; where: Filter | null }
  | { kind: 'sum' | 'min' | 'max'; field: string }
);

export interface SectionBase {
  title: string | null;
  /** The section's own source, else the page's; null only for a plugin
   * view that needs none. */
  source: Source | null;
  where: Filter | null;
  sort: SortKey[];
  limit: number | null;
  empty: string | null;
  actions: Action[];
}

export type Section = SectionBase & (
  | { kind: 'core'; view: CoreView; item: ItemSpec; groupBy: string | null; columns: Column[] | null; stats: Stat[] | null }
  | { kind: 'plugin'; view: string; with: Record<string, unknown> }
  /** A view this Ravenry cannot draw, with no usable fallback. */
  | { kind: 'placeholder'; view: string; reason: string }
);

export interface Tab {
  label: string | null;
  count: Filter | true | null;
  sections: Section[];
}

export interface Nav {
  label: string;
  icon: string;
  count: Filter | true | null;
  /** Instead of count: a number field added up over the items. */
  sum: string | null;
  countLabel: string | null;
  route: string;
}

export interface Page {
  version: 1;
  id: string;
  title: string;
  revision: number | null;
  from: { owner: string; id: string; revision: number } | null;
  requires: string | null;
  nav: Nav;
  source: Source | null;
  /** true when the file has tabs; otherwise one tab with label null. */
  tabbed: boolean;
  tabs: Tab[];
  actions: Action[];
  /** The file's x- keys, as written. */
  extra: Record<string, unknown>;
}
