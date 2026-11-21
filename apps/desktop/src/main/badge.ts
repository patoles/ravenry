// The Dock icon's badge (ALERT-018): how many sessions need you, the
// system's own badge with the number (macOS's Dock; on Linux, the launchers
// that show Electron's badge count), cleared when none do.
//
// - The number is the hub's own Needs you count (state.sidebar.counts.you,
//   hub/server/sidebar.mjs), as the sidebar's section shows it; the app
//   never counts it again.
// - One badge for the app, from the main process's one hub stream (hub.ts
//   HubFeed), whatever windows are open. The hub out of reach clears it:
//   no number that may be stale.
// - With the native Mac app running too, each app badges its own icon from
//   the same count (Mac notifications still reach one app only, ALERT-011).
// - Ravenry's alert switches (the Alerts page) do not hide it: it is a count
//   of what the board shows, like the sidebar's bell (ALERT-001), not an
//   alert sent. macOS shows an app's badge only where its notifications are
//   allowed (Electron's app.setBadgeCount).

/** The part of Electron's app the badge uses. */
export interface BadgeApp { setBadgeCount(n: number): boolean }

/** The hub's Needs you count in a state, else null (a state with no sidebar). */
export function needsYou(state: unknown): number | null {
  const n = (state as { sidebar?: { counts?: { you?: unknown } } } | null)?.sidebar?.counts?.you;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
}

export class DockBadge {
  /** The number on the icon now (0: none). */
  shown = 0;
  private app: BadgeApp;
  private on: boolean;

  constructor(app: BadgeApp, platform: NodeJS.Platform = process.platform) {
    this.app = app;
    // No Windows build (UPD-008); macOS and Linux have a badge.
    this.on = platform === 'darwin' || platform === 'linux';
  }

  /** A state from the hub: its count, or none when it has no sidebar. */
  state(s: unknown): void { this.set(needsYou(s) ?? 0); }

  /** The hub's stream: out of reach, the count is not known any more. */
  status(st: { reachable: boolean }): void { if (!st.reachable) this.set(0); }

  private set(n: number): void {
    if (!this.on || n === this.shown) return;
    this.shown = n;
    try { this.app.setBadgeCount(n); } catch { /* a launcher with no badge */ }
  }
}
