// Theme import: an iTerm2 colour preset (.itermcolors) or a Ghostty theme
// file made into a Ravenry theme file. The logic is the hub's
// (hub/server/themeimport.mjs), every client's; the store saves the theme
// (src/main/settingsstore.ts).

import * as hub from '../../../../hub/server/themeimport.mjs';
import type { ThemeFile } from '../shared/themes.ts';

export type ImportResult = { ok: true; theme: ThemeFile } | { ok: false; error: string };
type Plist = string | number | boolean | Plist[] | { [k: string]: Plist };

/** A name from a file's name: "Tokyo Night.itermcolors" is "Tokyo Night". */
export const nameFromFile = (file: string): string => hub.nameFromFile(file);
/** Either format, told apart by the text: a plist is XML. */
export const importTheme = (text: string, fileName: string): ImportResult => hub.importTheme(text, fileName) as ImportResult;
/** A small plist XML reader: dict, array, key, string, real, integer, true, false, date and data. */
export const parsePlist = (xml: string): Plist => hub.parsePlist(xml) as Plist;
export const fromItermcolors = (xml: string, name: string): ImportResult => hub.fromItermcolors(xml, name) as ImportResult;
export const fromGhostty = (text: string, name: string): ImportResult => hub.fromGhostty(text, name) as ImportResult;
