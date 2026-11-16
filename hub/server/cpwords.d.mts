// Types of cpwords.mjs, for the desktop app, which words a checkpoint
// itself when no board answers (apps/desktop/src/renderer/app.ts askWords).
// The words' shape is the desktop's CheckpointWords (checkpoints.ts).
export function wordsOf(
  cp: object,
  ctx?: { platform?: string; hubName?: string | null; paneName?: (pane: string) => string | null },
): { v: 1; state: string } & Record<string, unknown>;
