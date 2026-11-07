// Types of keys.mjs, for the apps (TypeScript).
export interface KeyPart { kind: 'text' | 'key'; text: string }
export function keyLabel(token: string): string;
export function keyParts(text: string | null | undefined): KeyPart[];
export function keyLine(text: string | null | undefined): string;
