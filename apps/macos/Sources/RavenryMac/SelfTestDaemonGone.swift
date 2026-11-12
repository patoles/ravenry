// A daemon gone for good (sidetest.mjs --screen daemongone, TERM-070): the
// window on two daemons of this tree, the app's own ravenryd (A) and this
// tree's built as the desktop app's version (B), each with a busy shell and
// a shell as tabs, the app started with no --socket. With a tab of A in
// front and another behind, the driver kills A (SIGKILL, at arrival 1): both
// its tabs go with one toast, "That shell is gone: the Ravenry that ran it
// stopped", and a drawn tab of B is in front, never a blank pane. Then a
// tab whose pane its daemon no longer has (a finished run opened again,
// closed in its daemon from elsewhere) goes when shown, with "That shell is
// gone: ...", and the tab in front stays drawn.

import AppKit

extension SelfTestBoard {
    func screenDaemonGone() {
        let ws = board.ws
        let byName: (String) -> String? = { n in ws.tabs.map(\.host).first { ws.label($0).name == n } }
        let listing = { ws.tabs.map { "\(ws.label($0.host).name)@\(ws.daemon(of: $0.host)?.version ?? "?")" }.joined(separator: ", ") }
        check("gone_two_daemons", wait(15) { ws.daemons.all.count == 2 }, ws.daemons.all.map(\.version).joined(separator: ", "))
        let names = ["a-busy", "a-shell", "b-busy", "b-shell"]
        check("gone_tabs_of_both", wait(10) { names.allSatisfy { byName($0) != nil } }, listing())
        guard let aShell = byName("a-shell"), let aBusy = byName("a-busy"), let bShell = byName("b-shell"),
              let aV = ws.daemon(of: aShell)?.version, let bV = ws.daemon(of: bShell)?.version, aV != bV,
              let ta = ws.tab(showing: aShell) else { check("gone_setup", false, listing()); return }
        // A's shell in front and drawn, A's busy one behind.
        ws.show(ta)
        board.toTerminal()
        check("gone_a_tab_drawn", wait(8) { (ws.boxes[aShell]?.term.screen.frames ?? 0) > 0 && ws.boxes[aShell]?.term.live == true })
        let tabsBefore = ws.tabs.count, L = board.log.count
        // A is killed for good.
        check("gone_arrival", arrival(1))
        check("gone_daemon_left", wait(10) { ws.daemons.all.count == 1 && ws.daemons.all.first?.version == bV }, ws.daemons.all.map(\.version).joined(separator: ", "))
        check("gone_its_tabs_closed", wait(5) { byName("a-shell") == nil && byName("a-busy") == nil && ws.tabs.count == tabsBefore - 2 }
              && !ws.tabs.contains { $0.host == aShell || $0.host == aBusy }, "\(tabsBefore) tabs, now \(listing())")
        let said = toasts(since: L).filter { $0.hasPrefix(t("term.shellGone", ["why": ""])) }
        check("gone_one_toast", said == [t("term.shellGone", ["why": t("term.daemonStopped")])], said.joined(separator: " | "))
        let front = ws.focusedView
        check("gone_never_blank", board.front == .tab && board.root.middle == nil && front.map { ws.daemon(of: $0.pane)?.version == bV } == true
              && wait(8) { (front?.screen.frames ?? 0) > 0 && front?.live == true && !(front?.screen.text().trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) },
              "front \(board.front), pane \(front?.pane ?? "none") on \(front.flatMap { ws.daemon(of: $0.pane)?.version } ?? "?"), frames \(front?.screen.frames ?? 0)")
        settle(0.4)
        picture("native-daemon-gone-1280.png")

        // A finished run's pane opened again (as Show in the terminal does), then closed in its
        // daemon from elsewhere while its tab is behind: showing it says it is gone, and it goes.
        let opts: [String: Any] = ["cols": 80, "rows": 24, "name": "finished run", "labels": ["ravenry.checkpoint": "cpgone1"], "cwd": ws.home, "command": ["/bin/sh", "-c", "echo the run printed this"]]
        guard let run = ((try? ws.conn(of: bShell).call("pane.new", opts, timeout: 5))?["pane"] as? [String: Any])?["id"] as? String else { check("gone_run_pane", false); return }
        _ = wait(5) { ((try? ws.conn(of: bShell).call("pane.list", ["hidden": true]))?["panes"] as? [[String: Any]] ?? []).contains { $0["id"] as? String == run && ($0["state"] as? String ?? "running") != "running" } }
        settle(0.5)
        guard let rt = ws.tab(showing: run, exited: true) else { check("gone_run_tab", false, "the ended pane was not opened again"); return }
        ws.show(rt)
        _ = wait(5) { (ws.boxes[run]?.term.screen.frames ?? 0) > 0 }
        if let bt = ws.tab(showing: bShell) { ws.show(bt) }
        settle(0.3)
        _ = try? ws.conn(of: bShell).call("pane.close", ["pane": run], timeout: 5)
        settle(0.8)
        check("gone_closed_elsewhere_tab_kept", ws.tabs.contains { $0.host == run }, listing())
        let L2 = board.log.count
        if let rt2 = ws.tabs.first(where: { $0.host == run }) { ws.show(rt2) }
        check("gone_shown_pane_goes", wait(6) { !ws.tabs.contains { $0.host == run } }, listing())
        let said2 = toasts(since: L2).filter { $0.hasPrefix(t("term.shellGone", ["why": ""])) }
        check("gone_shown_pane_said", said2.count == 1, toasts(since: L2).joined(separator: " | "))
        check("gone_shown_pane_never_blank", wait(6) { ws.active != nil && (ws.focusedView?.screen.frames ?? 0) > 0 && ws.focusedView?.live == true },
              "active \(ws.active?.host ?? "none"), frames \(ws.focusedView?.screen.frames ?? 0)")
    }
}
