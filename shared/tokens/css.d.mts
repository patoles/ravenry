// Types of css.mjs, for the TypeScript that imports it (the desktop's tests).
export interface Tokens {
  version: number;
  color: { dark: Record<string, string>; light: Record<string, string> };
  shadow: { dark: Record<string, string>; light: Record<string, string> };
  font: Record<string, string[]>;
  size: Record<string, number>;
  lineHeight: Record<string, number>;
  radius: Record<string, number>;
  space: Record<string, number>;
  [group: string]: unknown;
}
export const TOKENS_PATH: URL;
export function readTokens(): Tokens;
export function themeVars(tokens: Tokens, theme: 'dark' | 'light'): [string, string][];
export function sharedVars(tokens: Tokens): [string, string][];
export function tokensCss(tokens?: Tokens): string;
