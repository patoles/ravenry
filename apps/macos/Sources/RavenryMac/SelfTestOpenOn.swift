// sidetest.mjs --screen openon (and openon2, the app again on the same board,
// daemon and data folder): where a window opens (NAV-009, Board.openOn,
// hub/server/openon.mjs). The demo board is shaped like the person's: weather-widget
// waits on the designer since three days and is first in the list; notes-app
// is the session typed to last; the daemon has two shells, the window's tabs.
//
// openon: the launch opens on notes-app's session (the hub's openOn, typed
// to last), not a shell tab or the waiting project; a click on
// weather-widget's row in the sidebar tells the hub (its openOn follows:
// opened, mac). Then the app quits and the driver types to garden-planner.
//
// openon2: the launch opens on garden-planner, typed to after the last pick
// here, not weather-widget, the session in front at the last quit. At
// arrival 1 the driver types to paper-boat: every window closed, the Dock's
// click opens one on paper-boat. A shell tab pressed in the strip (its Accessibility press), the
// window closed and opened again: that tab stays in front (this Mac's own
// pick is newer than the hub's). The window closed and a
// ravenry://session link to recipe-box's session: the link wins.

import AppKit

extension SelfTestBoard {
    private func openOnSaid(_ b: Board) -> String {
        let o = b.hub.state?.openOn
        return "front \(b.frontKey ?? "none"), openOn \(o.map { "\($0.key ?? $0.projectId) (\($0.why))" } ?? "none"), log \(b.log.filter { $0.hasPrefix("open on") || $0.hasPrefix("opened ") }.suffix(3))"
    }

    func screenOpenOn() {
        let b = board
        check("openon_shells_are_tabs", b.ws.tabs.count >= 2 && b.ws.restored, "tabs \(b.ws.tabs.count), restored \(b.ws.restored)")
        check("openon_waiting_listed_first", b.hub.state?.projects.first?.id == "weather-widget" && b.hub.state?.sidebar(has: "weather-widget/sf-5", in: "wait") == true,
              b.hub.state?.projects.map(\.id).joined(separator: ",") ?? "")
        check("openon_launch_opens_on_typed_last", wait(10) { b.frontKey == "notes-app/sf-4" }, openOnSaid(b))
        pictures("openon-launch")
        // The person opens the waiting project's session from the sidebar.
        if let r = b.sidebar.rows["weather-widget/sf-5"] { click(r) }
        check("openon_click_opens_it", wait(5) { b.frontKey == "weather-widget/sf-5" }, openOnSaid(b))
        check("openon_click_tells_the_hub", wait(10) { b.hub.state?.openOn?.key == "weather-widget/sf-5" && b.hub.state?.openOn?.why == "opened" }
              && b.hub.opened.last?["device"] as? String == "mac" && b.log.contains { $0.hasPrefix("opened weather-widget (click): 200") }, openOnSaid(b))
    }

    func screenOpenOn2() {
        guard let app = NSApp.delegate as? AppDelegate else { check("openon2_app", false); return }
        let b = board
        check("openon2_relaunch_opens_on_typed_since", wait(10) { b.frontKey == "garden-planner/sf-1" }, openOnSaid(b))
        check("openon2_not_the_session_in_front_at_quit", b.log.contains { $0.hasPrefix("open on garden-planner/sf-1 (typed)") } && !b.log.contains { $0.contains("session relaunch") }, b.log.prefix(12).joined(separator: " | "))
        pictures("openon2-relaunch")
        // The person types to paper-boat elsewhere; every window closed, the Dock's click.
        check("openon2_arrival", arrival(1) && wait(10) { b.hub.state?.openOn?.projectId == "paper-boat" }, openOnSaid(b))
        for w in app.windows { w.window.performClose(nil); settle(0.3) }
        _ = app.applicationShouldHandleReopen(NSApp, hasVisibleWindows: false)
        guard let w2 = app.windows.first else { check("openon2_reopen", false, "no window"); return }
        check("openon2_reopen_opens_on_typed_last", wait(10) { w2.board.frontKey == "paper-boat/sf-3" }, openOnSaid(w2.board))
        // A shell tab picked here (a click on the strip), then the window again: this Mac's pick is newer.
        settle(0.5)
        let shell = w2.ws.tabs.first { t in !(w2.hub.state?.projects.contains { $0.sessions.contains { $0.pane == t.host } } ?? false) }
        let item = shell.flatMap { sh in w2.ws.bar.items.first { $0.model.id == sh.id } }
        if let item { _ = item.accessibilityPerformPress(); settle(0.3) }
        check("openon2_shell_tab_pressed", item != nil && wait(5) { w2.ws.active === shell && w2.board.frontKey == "tab:\(shell!.id)" }, "shell \(shell?.id ?? "none"), strip \(w2.ws.bar.items.map(\.model.id)), \(openOnSaid(w2.board))")
        w2.ws.save(); w2.ws.flush()
        for w in app.windows { w.window.performClose(nil); settle(0.3) }
        _ = app.applicationShouldHandleReopen(NSApp, hasVisibleWindows: false)
        guard let w3 = app.windows.first else { check("openon2_reopen_own", false, "no window"); return }
        _ = wait(8) { w3.hub.state != nil }
        settle(1.0)
        check("openon2_own_newer_pick_stays", shell != nil && w3.ws.active?.id == shell!.id && w3.board.frontKey == "tab:\(shell!.id)"
              && w3.board.log.contains { $0.hasPrefix("open on: this Mac's own pick is newer") }, openOnSaid(w3.board) + "; w2 \(w2.board.log.suffix(6)); w3 \(w3.board.log.prefix(6))")
        // A link at open: ravenry://session/<recipe-box's session> with no window.
        for w in app.windows { w.window.performClose(nil); settle(0.3) }
        _ = SessionLinks.shared.openURL(URL(string: "ravenry://session/d4d4d4d4-0000-4000-8000-000000000004")!, app: app)
        guard let w4 = app.windows.first else { check("openon2_link", false, "no window"); return }
        check("openon2_link_wins", wait(12) { w4.board.frontKey == "recipe-box/sf-2" } && (settle(1.5), w4.board.frontKey == "recipe-box/sf-2").1, openOnSaid(w4.board))
    }
}
