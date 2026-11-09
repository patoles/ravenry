// The decision ledger the Decisions page is checked and pictured on
// (sidetest.mjs --screen decisions, and the Electron app's reference shots
// of the same page): the demo hub's projects and sessions, with a decision
// replaced by a newer one, one for every project the person added, an
// agent's that was edited, one said in a session, one read many times,
// over today, yesterday and earlier days. The one inside its undo minute is
// recorded live (recordLive), as an agent would, while the page shows.
import fs from 'node:fs';
import path from 'node:path';

const GARDEN = 'a1a1a1a1-0000-4000-8000-000000000001';
const BOAT = 'b2b2b2b2-0000-4000-8000-000000000002';

/** The ledger's entries, with times counted back from `now`. */
export function ledger(now = new Date()) {
  const at = (days, h, m) => { const d = new Date(now); d.setDate(d.getDate() - days); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const ago = (min) => new Date(now.getTime() - min * 60000).toISOString();
  const day = (n) => new Date(now.getTime() - n * 86400000).toISOString().slice(0, 10);
  return [
    { id: 'dold2345', quote: 'Planting reminders go out a week before sowing.', at: at(3, 9, 12), project: 'garden-planner', scope: 'reminders', overrides: [], by: 'person', overridden_by: 'dnew2345', reads: { [day(3)]: 2 } },
    { id: 'dnew2345', quote: 'Send the reminder on the first warm day instead, not a week before sowing. A week is too early in a cold spring.', at: at(1, 16, 40), project: 'garden-planner', scope: 'reminders', overrides: ['dold2345'], by: 'agent', recorded_by: { pane: 'pgarden2', session: GARDEN, assistant: 'claude' }, reads: { [day(0)]: 7, [day(1)]: 5 }, last_read_at: ago(12) },
    { id: 'drecipe2', quote: 'Keep the old import format working until March.', at: at(2, 11, 5), project: 'recipe-box', overrides: [], by: 'agent', recorded_by: { pane: 'precipe2', assistant: 'claude' }, edited_at: at(2, 11, 30), reads: { [day(2)]: 2 } },
    { id: 'dnotes23', quote: 'Every test shot is at the phone width, 390 points.', at: at(1, 10, 20), project: 'notes-app', scope: 'tests', overrides: [], by: 'agent', recorded_by: { pane: 'pnotes23', assistant: 'codex' }, reads: { [day(0)]: 23, [day(1)]: 25 }, last_read_at: ago(3) },
    { id: 'dhull234', quote: 'The hull tilts with the slope as well as the waves.', at: ago(95), project: 'paper-boat', scope: 'hull', overrides: [], by: 'agent', recorded_by: { pane: 'pboat234', session: BOAT, assistant: 'claude' }, reads: { [day(0)]: 1 } },
    { id: 'devery23', quote: 'No em dashes anywhere: not in code, comments or copy.', at: ago(40), project: null, overrides: [], by: 'person' },
  ];
}

/** Writes the ledger into a hub's data folder (RAVENRY_HOME). */
export function writeLedger(mc, now = new Date()) {
  fs.mkdirSync(mc, { recursive: true });
  fs.writeFileSync(path.join(mc, 'decisions.json'), JSON.stringify({ version: 1, decisions: ledger(now) }, null, 2), { mode: 0o600 });
}

/** An agent saves one now, as `ravenry decide` does (POST /api/decisions/record). */
export async function recordLive(url, n) {
  const body = n === 1
    ? { quote: 'The sail stays white, whatever the theme.', project: 'paper-boat', scope: 'sail' }
    : { quote: 'Reminders go out at 8 in the morning.', project: 'garden-planner', replaces: 'dnew2345' };
  const r = await fetch(url + '/api/decisions/record', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ravenry': '1' }, body: JSON.stringify(body) });
  return r.status;
}
