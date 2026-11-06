// "Did you mean" for a typo: the closest known word, when it is close enough
// to be the likely intent.

/** Edits between two words: insert, delete, change, or swap two neighbours
 * (so stauts is 1 from status). */
export function distance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

/** The known word closest to `word`, or null when none is close: at most 1
 * edit for words up to 4 letters, 2 up to 8, 3 beyond; a difference of case
 * alone always matches. Ties go to the first in `known`. */
export function closest(word: string, known: Iterable<string>): string | null {
  const w = word.toLowerCase();
  const limit = w.length <= 4 ? 1 : w.length <= 8 ? 2 : 3;
  let best: string | null = null;
  let bestD = Infinity;
  for (const k of known) {
    if (k === word) continue;
    const d = k.toLowerCase() === w ? 0 : distance(w, k.toLowerCase());
    if (d < bestD) { best = k; bestD = d; }
  }
  if (best !== null && bestD <= limit) return best;
  // A word cut short (stat for status): the one known word it starts.
  if (w.length >= 3) {
    const starts = [...known].filter((k) => k.toLowerCase().startsWith(w) && k !== word);
    if (starts.length === 1) return starts[0];
  }
  return null;
}
