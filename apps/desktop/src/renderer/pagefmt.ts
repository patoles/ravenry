// The page file format's types (packages/page-format), and how a value is
// read and said as text to draw it. The filters, sorts, groups and numbers
// run in the hub (hub/server/pagedraw.mjs): the window draws its answer.

export { fillText, getField, valueText } from '../../../../packages/page-format/src/index.ts';
export type {
  Action, FieldSpec, Item, ItemSpec, Page, Progress, Section, Source, Stat, Tab,
} from '../../../../packages/page-format/src/index.ts';

/** A value as a lane's or an option's name: "fixing" is "Fixing". */
export function capitaliseField(s: string): string {
  const t = String(s).replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
