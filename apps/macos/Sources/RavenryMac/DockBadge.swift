// The Dock icon's badge (ALERT-018): how many sessions need you, the
// standard red badge with the number, cleared when none do.
//
// - The number is the hub's own Needs you count (state.sidebar.counts.you,
//   hub/server/sidebar.mjs), as the sidebar's section shows it; the app
//   never counts it again.
// - One badge for the app: each window has its own hub stream (Windows.swift)
//   and reports its count here; the badge shows the newest of the windows
//   still connected. A window that closes, or whose stream loses the hub,
//   takes its count out; with none left the badge is cleared, never a
//   number that may be stale.
// - With the Electron app running too, each app badges its own icon from
//   the same count (Mac notifications still reach one app only, ALERT-011).
// - Ravenry's alert switches (the Alerts page) do not hide it: it is a
//   count of what the board shows, like the sidebar's bell (ALERT-001), not
//   an alert sent. The app asks macOS for badges with its notifications
//   (Notifier.swift), so macOS's own settings for Ravenry decide the rest.

import AppKit

enum DockBadge {
    /// Each window's last count, by its hub client, with the order it came in.
    private static var counts: [ObjectIdentifier: (n: Int, seq: Int)] = [:]
    private static var seq = 0

    /// What the badge says for a count: the number, nothing for none.
    static func label(_ n: Int) -> String? { n > 0 ? String(n) : nil }

    /// A window's stream sent a state: the hub's Needs you count, nil when the state has none.
    static func set(_ n: Int?, from hub: HubClient) {
        guard let n else { drop(hub); return }
        seq += 1
        counts[ObjectIdentifier(hub)] = (n, seq)
        apply()
    }

    /// A window closed, or its stream lost the hub: its count goes.
    static func drop(_ hub: HubClient) {
        guard counts.removeValue(forKey: ObjectIdentifier(hub)) != nil else { return }
        apply()
    }

    private static func apply() {
        let n = counts.values.max { $0.seq < $1.seq }?.n ?? 0
        let l = label(n)
        if NSApp.dockTile.badgeLabel != l { NSApp.dockTile.badgeLabel = l }
    }
}
