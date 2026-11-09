// What the person has seen of the onboarding (hints dismissed, Learn ticks,
// step 2 answered) is the hub's: GET and POST /api/onboarding
// (hub/server/onboarding.mjs), so a second client does not show it again.
// The app's store keeps only what is not on the board yet: what it kept
// before the hub did (the same keys), and what was marked while the board
// was not up. Both go to the board when it answers, which keeps the union.

export type Marks = Record<string, boolean>;
export interface Onboarding { hints: Marks; learn: Marks; setup: Marks }
export type Group = keyof Onboarding;
export const GROUPS: Group[] = ['hints', 'learn', 'setup'];

/** The store's key for each group (window.json), as before 0.1.23. */
export const STORE_KEY: Record<Group, string> = { hints: 'hintsDone', learn: 'learnUsed', setup: 'setupAsked' };

const marks = (v: unknown): Marks => {
  const out: Marks = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) if (x === true) out[k] = true;
  return out;
};

/** What the store holds (window.json), the marks not on the board yet. */
export function fromStore(saved: Record<string, unknown>): Onboarding {
  return { hints: marks(saved[STORE_KEY.hints]), learn: marks(saved[STORE_KEY.learn]), setup: marks(saved[STORE_KEY.setup]) };
}

/** Both sets of marks: a mark is never taken back. */
export function union(a: Onboarding, b: Partial<Record<Group, unknown>> | null | undefined): Onboarding {
  return { hints: { ...a.hints, ...marks(b?.hints) }, learn: { ...a.learn, ...marks(b?.learn) }, setup: { ...a.setup, ...marks(b?.setup) } };
}

/** The marks in `mine` that `board` lacks, or null when it has them all. */
export function missing(mine: Onboarding, board: Partial<Record<Group, unknown>> | null | undefined): Partial<Onboarding> | null {
  const out: Partial<Onboarding> = {};
  for (const g of GROUPS) {
    const have = marks(board?.[g]);
    const add = Object.keys(mine[g]).filter((k) => mine[g][k] && !have[k]);
    if (add.length) out[g] = Object.fromEntries(add.map((k) => [k, true]));
  }
  return Object.keys(out).length ? out : null;
}

/** The store's patch that empties the groups once the board has them. */
export const cleared = (): Record<string, null> => Object.fromEntries(GROUPS.map((g) => [STORE_KEY[g], null]));
