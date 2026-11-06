// The daemon answers the terminal queries of the programs in its panes
// (PROTOCOL.md section 3), so a client that draws a pane must not answer
// them too, or the program reads two answers. This registers xterm.js
// parser handlers that swallow every query xterm.js would reply to, and
// leaves every other sequence to xterm.js.
//
// Typed structurally, so this package does not depend on xterm.js.

interface Disposable { dispose(): void }
interface FunctionIdentifier { prefix?: string; intermediates?: string; final: string }
type Params = (number | number[])[];

export interface XtermParserLike {
  registerCsiHandler(id: FunctionIdentifier, cb: (params: Params) => boolean | Promise<boolean>): Disposable;
  registerDcsHandler(id: FunctionIdentifier, cb: (data: string, params: Params) => boolean | Promise<boolean>): Disposable;
  registerOscHandler(ident: number, cb: (data: string) => boolean | Promise<boolean>): Disposable;
}

/** The queries swallowed, for tests and docs. */
export const SWALLOWED_CSI: FunctionIdentifier[] = [
  { final: 'c' }, // DA1, primary device attributes
  { prefix: '>', final: 'c' }, // DA2, secondary device attributes
  { prefix: '=', final: 'c' }, // DA3, tertiary device attributes
  { final: 'n' }, // DSR: status (5n) and cursor position (6n)
  { prefix: '?', final: 'n' }, // DEC DSR (?6n and friends)
  { intermediates: '$', final: 'p' }, // DECRQM, ANSI modes
  { prefix: '?', intermediates: '$', final: 'p' }, // DECRQM, DEC private modes
  { prefix: '>', final: 'q' }, // XTVERSION
  { prefix: '?', final: 'u' }, // kitty keyboard flags query
  { final: 't' }, // window reports (only the report requests, see below)
];

/**
 * Registers handlers on term.parser. Returns one disposable that removes
 * them all.
 */
export function suppressTerminalQueries(parser: XtermParserLike): Disposable {
  const ds: Disposable[] = [];
  for (const id of SWALLOWED_CSI) {
    if (id.final === 't') {
      // Only the report requests (11t, 13t to 16t, 18t to 21t). The rest,
      // such as 22t and 23t (the title stack), are left to xterm.js.
      ds.push(parser.registerCsiHandler(id, (params) => [11, 13, 14, 15, 16, 18, 19, 20, 21].includes(first(params))));
      continue;
    }
    ds.push(parser.registerCsiHandler(id, () => true));
  }
  ds.push(parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true)); // DECRQSS
  ds.push(parser.registerDcsHandler({ intermediates: '+', final: 'q' }, () => true)); // XTGETTCAP
  // Colour queries: OSC 4 ; n ; ?, OSC 10/11/12 ; ?, OSC 104 is a reset (left alone).
  ds.push(parser.registerOscHandler(4, (data) => data.split(';').some((x, i) => i % 2 === 1 && x === '?')));
  for (const n of [10, 11, 12, 13, 14, 15, 16, 17, 19]) ds.push(parser.registerOscHandler(n, (data) => data.includes('?')));
  return { dispose: () => { for (const d of ds.splice(0)) d.dispose(); } };
}

function first(params: Params): number {
  const p = params[0];
  return typeof p === 'number' ? p : Array.isArray(p) ? p[0] ?? 0 : 0;
}
