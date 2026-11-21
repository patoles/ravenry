// The Dock icon's badge (ALERT-018, DockBadge.swift), in the alerts screen
// (scripts/sidetest.mjs --screen alerts): the number is the hub's own Needs
// you count as GET /api/sidebar gives it, one badge for two windows, and a
// state with none clears it. The app runs as an accessory off every screen,
// so its Dock tile is set and read back but never drawn.

import AppKit

extension SelfTestBoard {
    func dockBadge() {
        let hub = board.hub
        // The hub's own count, asked of it apart from the stream.
        var you: Int?
        hub.get("/api/sidebar") { _, j in you = ((j["counts"] as? [String: Any])?["you"] as? NSNumber)?.intValue ?? -1 }
        _ = wait(5) { you != nil }
        let n = you ?? -1
        check("dock_badge_hub_count", wait(5) { NSApp.dockTile.badgeLabel == String(n) } && n > 0,
              "hub \(n), state \(hub.state?.counts["you"] ?? -1), badge \(NSApp.dockTile.badgeLabel ?? "none")")
        // A second window on its own stream: still one badge, the same number; closing it keeps the first's.
        if let app = NSApp.delegate as? AppDelegate, let nw = app.makeWindow(.shell(nil)) {
            let got = wait(8) { nw.hub.state != nil }
            check("dock_badge_two_windows", got && NSApp.dockTile.badgeLabel == String(n), "badge \(NSApp.dockTile.badgeLabel ?? "none")")
            nw.window.performClose(nil)
            settle(0.3)
            check("dock_badge_window_closed_keeps", NSApp.dockTile.badgeLabel == String(n), "badge \(NSApp.dockTile.badgeLabel ?? "none")")
        } else {
            check("dock_badge_two_windows", false, "no second window")
        }
        // The hub's next state with nobody in Needs you: the badge goes.
        hub.testPatch = { st in
            var st = st
            var sb = st["sidebar"] as? [String: Any] ?? [:]
            var c = sb["counts"] as? [String: Any] ?? [:]
            c["you"] = 0
            sb["counts"] = c
            sb["sections"] = (sb["sections"] as? [[String: Any]] ?? []).filter { $0["group"] as? String != "you" }
            st["sidebar"] = sb
            return st
        }
        check("dock_badge_clears_at_zero", wait(8) { hub.state?.counts["you"] == 0 && (NSApp.dockTile.badgeLabel ?? "").isEmpty }, "badge \(NSApp.dockTile.badgeLabel ?? "none")")
        // And back with the hub's own count on its next state.
        hub.testPatch = nil
        check("dock_badge_back", wait(8) { NSApp.dockTile.badgeLabel == String(n) }, "badge \(NSApp.dockTile.badgeLabel ?? "none")")
        check("dock_badge_label_words", DockBadge.label(0) == nil && DockBadge.label(3) == "3" && DockBadge.label(12) == "12")
    }
}
