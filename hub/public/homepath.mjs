// How Ravenry says a folder, everywhere it shows one (the hub, its alerts,
// the web board, the desktop app and the phone): the home folder of the
// machine the folder is on as "~". A folder on devbox is said against
// devbox's home, never this computer's, and a folder outside its home (or
// on a machine whose home is unknown) is said in full.
//
// Plain JavaScript with no import, so the hub (Node), the web board (served
// from public/) and the apps (bundled) all load this one file.

/**
 * A folder as people read it: "~/code/app" for "/srv/dev/code/app" when
 * the machine's home is "/srv/dev".
 * @param {string | null | undefined} p
 * @param {string | null | undefined} home
 * @returns {string}
 */
export function sayPath(p, home) {
  const s = String(p ?? '');
  const h = String(home || '').replace(/\/+$/, '');
  if (!s || !h) return s;
  if (s === h) return '~';
  if (s.startsWith(h + '/')) return '~' + s.slice(h.length);
  return s;
}

/**
 * The home folder of a machine: `homes` maps a machine's name to its home,
 * and "" to this computer's (the hub's state carries it as `homes`).
 * @param {Record<string, string> | null | undefined} homes
 * @param {string | null | undefined} machine
 * @returns {string | null}
 */
export function homeOf(homes, machine) {
  if (!homes) return null;
  const m = machine && machine !== 'local' ? machine : '';
  return homes[m] || null;
}

/**
 * A folder on a machine, said against that machine's home.
 * @param {string | null | undefined} p
 * @param {string | null | undefined} machine
 * @param {Record<string, string> | null | undefined} homes
 * @returns {string}
 */
export function sayPathOn(p, machine, homes) {
  return sayPath(p, homeOf(homes, machine));
}
