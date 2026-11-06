// The page file format (packages/page-format), as the window uses it: the
// same filters, sorts, groups and numbers as the hub and the phone.

export {
  matches, sortItems, groupItems, countItems, navNumber, statValue, fillText, getField, valueText,
} from '../../../../packages/page-format/src/index.ts';
export type {
  Action, FieldSpec, Item, ItemSpec, Page, Progress, Section, Source, Stat, Tab,
} from '../../../../packages/page-format/src/index.ts';

/** A value as a lane's or an option's name: "fixing" is "Fixing". */
export function capitaliseField(s: string): string {
  const t = String(s).replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
