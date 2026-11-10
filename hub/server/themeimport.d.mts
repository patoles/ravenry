// Types of themeimport.mjs, for the desktop app (its src/main/themeimport.ts re-exports it).
export interface ThemeFileShape { name: string; appearance: 'dark' | 'light'; credit?: string; theme: Record<string, string> }
export type ImportResultShape = { ok: true; theme: ThemeFileShape } | { ok: false; error: string };
export type PlistValue = string | number | boolean | PlistValue[] | { [k: string]: PlistValue };
export const ANSI_KEYS: readonly string[];
export function parseHex(c: string): [number, number, number] | null;
export function toHex(rgb: readonly number[]): string;
export function appearanceOf(background: string): 'dark' | 'light';
export function isThemeFile(v: unknown): v is ThemeFileShape;
export function slug(name: string): string;
export function nameFromFile(file: string): string;
export function importTheme(text: string, fileName: string): ImportResultShape;
export function parsePlist(xml: string): PlistValue;
export function fromItermcolors(xml: string, name: string): ImportResultShape;
export function fromGhostty(text: string, name: string): ImportResultShape;
