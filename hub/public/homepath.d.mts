// Types of homepath.mjs, for the desktop app and the phone board.
export function sayPath(p: string | null | undefined, home: string | null | undefined): string;
export function homeOf(homes: Record<string, string> | null | undefined, machine: string | null | undefined): string | null;
export function sayPathOn(p: string | null | undefined, machine: string | null | undefined, homes: Record<string, string> | null | undefined): string;
