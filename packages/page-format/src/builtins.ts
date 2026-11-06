// What version 1 knows by name: the icons, the fields every item has, the
// built-in providers (schema/providers-1.json, the provider contract) and
// Ravenry's own pieces under the ravenry: namespace.

import providersJson from '../schema/providers-1.json' with { type: 'json' };
import type { FieldSpec, FieldType } from './model.ts';

export const CORE_VIEWS = ['list', 'cards', 'board', 'table', 'stats', 'document'] as const;
export const ITEM_VIEWS = ['list', 'cards', 'board', 'table', 'document'];
export const ACTION_KINDS = ['open', 'set', 'create', 'toggle', 'copy', 'archive', 'ask', 'run', 'plugin'] as const;

export const ICONS = [
  'target', 'plans', 'idea', 'rules', 'ship', 'flag', 'list', 'cards', 'board', 'table', 'chart', 'doc',
  'check', 'star', 'bug', 'inbox', 'clock', 'folder', 'terminal', 'tag', 'heart', 'bolt', 'page',
];

export const capitalise = (s: string): string => {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** The fields every item of a folder has, besides its declared ones. */
export function folderBuiltins(): Record<string, FieldSpec> {
  const f = (name: string, type: FieldType, description: string, writable = false): FieldSpec => ({ name, type, label: capitalise(name), required: false, builtin: true, writable, description });
  return {
    title: f('title', 'string', 'The frontmatter title, else the first # heading, else the file name.', true),
    body: f('body', 'string', 'The text after the frontmatter.'),
    file: f('file', 'string', "The file's path inside the folder."),
    created: f('created', 'date', 'When the file was made.'),
    modified: f('modified', 'date', 'When the file last changed.'),
  };
}

/** The fields of a files source's items. */
export function filesFields(): Record<string, FieldSpec> {
  const f = (name: string, type: FieldType, description: string): FieldSpec => ({ name, type, label: capitalise(name), required: false, builtin: true, writable: false, description });
  return {
    title: f('title', 'string', "The file's first heading, else its name."),
    body: f('body', 'string', "The file's text."),
    file: f('file', 'string', "The file's path."),
    done: f('done', 'number', 'Boxes ticked.'),
    total: f('total', 'number', 'Boxes in all.'),
    modified: f('modified', 'date', 'When the file last changed.'),
  };
}

interface ProviderField { type: string; description: string; values?: string[]; fields?: Record<string, ProviderField> }
interface ProviderDef { description: string; key: string; fields: Record<string, ProviderField> }

export const PROVIDERS_FILE = providersJson as unknown as { title: string; description: string; version: number; providers: Record<string, ProviderDef> };
export const PROVIDER_IDS = Object.keys(PROVIDERS_FILE.providers);

function toSpec(name: string, p: ProviderField): FieldSpec {
  const spec: FieldSpec = { name, type: p.type as FieldType, label: capitalise(name), required: false, builtin: true, writable: false, description: p.description };
  if (p.values) spec.values = p.values;
  if (p.fields) spec.fields = Object.fromEntries(Object.entries(p.fields).map(([k, v]) => [k, toSpec(k, v)]));
  return spec;
}

/** A built-in provider's fields, or null when there is no such provider. */
export function providerFields(id: string): Record<string, FieldSpec> | null {
  const p = PROVIDERS_FILE.providers[id];
  if (!p) return null;
  return Object.fromEntries(Object.entries(p.fields).map(([k, v]) => [k, toSpec(k, v)]));
}

export interface Builtin { name: string; description: string; on?: string }

/** Ravenry's own views. They are plugins in the ravenry: namespace, placed
 * by page files like any plugin's, so the built-in pages use the plugin
 * contract before it freezes. */
export const RAVENRY_VIEWS: Builtin[] = [
  { name: 'ravenry:plan', description: "A plan's whole flow: its steps with their proofs, its gates, and the planning conversation.", on: 'a plans item, as item.detail' },
  { name: 'ravenry:plan-row', description: 'A running plan as one row: its dot strip, the step it is on and the question at a gate.', on: 'a projects item (its plan) or a plans item, as item.place' },
  { name: 'ravenry:objective-rows', description: "A project's objectives as rows, each with its dot strip, N of M and what comes next, and the running plan's row among them.", on: 'a projects item, as item.place' },
  { name: 'ravenry:session-sheet', description: "A project's sheet: its sessions, their screens and the hand-offs.", on: 'a projects item, as item.detail' },
  { name: 'ravenry:sessions', description: 'Every running session with its memory, and Close idle.', on: 'a section (view), with the sessions provider' },
  { name: 'ravenry:idea-thread', description: "An idea's conversation with an agent, and Get 3 directions.", on: 'an ideas item, as item.detail' },
  { name: 'ravenry:mockup-rounds', description: "An idea's mockup rounds, side by side.", on: 'an ideas item, as item.place' },
  { name: 'ravenry:brainstorm', description: 'The brainstorm box: a seed, Add idea and Get 3 directions.', on: 'a section (view), above the ideas' },
  { name: 'ravenry:memory-rules', description: 'Rules found in project memory that no rules file has, with Every project, This project and Not a rule.', on: 'a section (view)' },
];

/** Ravenry's own actions. */
export const RAVENRY_ACTIONS: Builtin[] = [
  { name: 'ravenry:save-rule', description: 'Shows the change a suggested rule makes to its rules files, and saves it when you say so.', on: 'a repeats item' },
  { name: 'ravenry:not-now', description: 'Hides a suggested rule until you say it again.', on: 'a repeats item' },
  { name: 'ravenry:write-brief', description: "Opens the form that writes a project's brief.", on: 'a projects item' },
];

export const RAVENRY_VIEW_NAMES = new Set(RAVENRY_VIEWS.map((b) => b.name));
export const RAVENRY_ACTION_NAMES = new Set(RAVENRY_ACTIONS.map((b) => b.name));
