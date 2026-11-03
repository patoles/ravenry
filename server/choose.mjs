// Picking an option of a menu Claude Code draws in the terminal (a
// permission prompt, an AskUserQuestion question, the folder-trust prompt)
// from the board's choice buttons.
//
// The option's number is NOT typed: some menus ignore digit keys (the
// folder-trust prompt does, measured on Claude Code 2.1.317: "2" left
// "❯ No, exit" selected). Every menu measured moves with the arrow keys and
// takes the selected option on Enter, so choosing is:
//   1. read the menu and which option the ❯ marks;
//   2. press Up or Down that many times, then read again until the ❯ is on
//      the wanted option (nothing is pressed further if it never gets there);
//   3. press Enter, then read again until the menu has gone or a different
//      one is open. A menu still open after Enter is reported, not assumed.
// Pure of I/O: the caller passes read() and key() (server/index.mjs gives
// the terminal interface's readScreen and pressKey for one tab, and `where`,
// the terminal's name for the messages).

import { parseScreen } from './screen.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The open menu on a screen, or null: its question, its options (n, label,
// selected) and the index of the selected one (-1 when no ❯ is seen).
export function readMenu(text) {
  const ps = parseScreen(text);
  if (!ps.claudeLive || !ps.dialog || !ps.dialog.options.length) return null;
  let options = ps.dialog.options;
  // Numbers that start again at 1 mean an older numbered list (a prompt in
  // the scrollback) sits above the menu: keep the last run only.
  let from = 0;
  for (let i = 1; i < options.length; i++) if (options[i].n <= options[i - 1].n) from = i;
  options = options.slice(from);
  let at = -1;
  options.forEach((o, i) => { if (o.selected) at = i; });
  const sig = [ps.dialog.question || '', ...options.map((o) => o.label)].join('\n');
  return { question: ps.dialog.question, options, at, sig };
}

// What to press to move from the selected option to option number `want`.
export function keysFor(menu, want) {
  const to = menu.options.findIndex((o) => o.n === Number(want));
  if (to < 0 || menu.at < 0) return null;
  const d = to - menu.at;
  return [...Array(Math.abs(d)).fill(d > 0 ? 'down' : 'up'), 'enter'];
}

const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });

// Choose option number `want` on the menu read() shows. Returns
// { ok, sent: label, keys, after: 'closed' | 'next' } or { ok: false, status, error, keys }.
export async function chooseOption({ read, key, want, where = 'cmux', settleMs = 1500, afterMs = 4000, pollMs = 120 }) {
  const keys = [];
  const press = async (k) => {
    keys.push(k);
    const r = await key(k);
    if (!r || !r.ok) throw Object.assign(new Error((r && r.err) || `${where} refused the ${k} key.`), { refused: true });
  };
  const t0text = await read();
  if (t0text == null) return fail(502, 'Could not read the tab, so nothing was pressed.', { keys });
  const menu0 = readMenu(t0text);
  if (!menu0) return fail(409, 'No choice is open on screen any more.', { keys });
  const opt = menu0.options.find((o) => o.n === Number(want));
  if (!opt) return fail(409, 'That option is no longer on screen.', { keys });
  if (menu0.at < 0) return fail(409, `Could not see which option is selected, so nothing was pressed. Answer it in ${where}.`, { keys });
  const to = menu0.options.indexOf(opt);
  try {
    // Move, then wait for the ❯ to land on the option. One more nudge if a
    // key was lost or two were taken.
    let menu = menu0;
    for (let round = 0; round < 2 && menu.at !== to; round++) {
      const d = to - menu.at;
      for (let k = 0; k < Math.abs(d); k++) await press(d > 0 ? 'down' : 'up');
      const t0 = Date.now();
      let m = null;
      do {
        await sleep(pollMs);
        const t = await read();
        if (t == null) { m = menu; continue; } // a read that failed proves nothing
        m = readMenu(t);
        if (!m || m.sig !== menu0.sig) {
          return fail(409, `The menu changed while moving to "${opt.label}", so Enter was not pressed. Check it in ${where}.`, { keys });
        }
      } while (m.at !== to && Date.now() - t0 < settleMs);
      menu = m;
    }
    if (menu.at !== to) {
      const on = menu.at >= 0 ? `"${menu.options[menu.at].label}"` : 'no option';
      return fail(502, `The menu did not move to "${opt.label}" (it shows ${on}), so Enter was not pressed. Answer it in ${where}.`, { keys });
    }
    await press('enter');
    const t0 = Date.now();
    do {
      await sleep(pollMs);
      const t = await read();
      if (t == null) continue; // a read that failed proves nothing
      const m = readMenu(t);
      if (!m) return { ok: true, sent: opt.label, keys, after: 'closed' };
      if (m.sig !== menu0.sig) return { ok: true, sent: opt.label, keys, after: 'next' };
    } while (Date.now() - t0 < afterMs);
    return fail(502, `Pressed Enter on "${opt.label}" but the menu is still open. Answer it in ${where}.`, { keys });
  } catch (e) {
    if (e.refused) return fail(500, e.message, { keys });
    throw e;
  }
}
