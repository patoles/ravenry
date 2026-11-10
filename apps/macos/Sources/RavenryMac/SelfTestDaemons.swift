// The self-test of a window on two daemons (sidetest.mjs --screen daemons):
// an update never makes a running session worse. The driver starts an
// older daemon (the 0.1.23 release's ravenryd) with two shells, one busy,
// and the app on it with no --socket; then, at arrival 1, a newer one
// (this tree's, as the next version) beside it with two shells of its own,
// which drains the older. Every pane of both is a live tab: drawn from its
// own daemon's render stream, typed into as the person (no drive question),
// resized (each grid goes to the pane's own daemon), a session of the older
// one opens as its tab, a session moved from it and one continued are tabs
// on the newer (sidetest.mjs starts the app again and checks they come back
// as tabs, in their places), and a new tab goes to the newer. The draws a resize
// step takes on two daemons are resizebench.mjs --daemons's.

import AppKit

extension SelfTestBoard {
    func screenDaemons() {
        let ws = board.ws
        let names = ["old-busy", "old-shell"]
        // The start: the older daemon alone, its shells as tabs.
        check("daemons_one_at_start", ws.daemons.all.count == 1, ws.daemons.all.map { "\($0.version) \($0.socket)" }.joined(separator: ", "))
        let oldV = ws.daemons.all.first?.version ?? ""
        let byName: (String) -> String? = { n in ws.tabs.map(\.host).first { ws.label($0).name == n } }
        check("daemons_old_tabs", wait(5) { names.allSatisfy { byName($0) != nil } }, ws.tabs.map { "\(ws.label($0.host).name)@\(ws.daemon(of: $0.host)?.version ?? "?")" }.joined(separator: ", "))
        for n in names {
            guard let p = byName(n), let t = ws.tab(showing: p) else { continue }
            ws.show(t)
            check("daemons_live_\(n)", wait(8) { (ws.boxes[p]?.term.screen.frames ?? 0) > 0 && ws.boxes[p]?.term.live == true },
                  "frames \(ws.boxes[p]?.term.screen.frames ?? 0)")
        }

        // A newer daemon starts beside it (an update): its shells join as tabs, the older drains.
        check("daemons_arrival", arrival(1))
        check("daemons_two", wait(15) { ws.daemons.all.count == 2 }, ws.daemons.all.map(\.version).joined(separator: ", "))
        let newV = ws.daemons.newest?.version ?? ""
        check("daemons_newest_is_newer", compareVersions(newV, oldV) > 0, "\(newV) over \(oldV)")
        let all = names + ["new-busy", "new-shell"]
        check("daemons_all_tabs", wait(10) { all.allSatisfy { byName($0) != nil } }, ws.tabs.map { "\(ws.label($0.host).name)@\(ws.daemon(of: $0.host)?.version ?? "?")" }.joined(separator: ", "))
        check("daemons_old_drains", wait(20) { ws.daemons.all.contains { $0.version == oldV && !$0.draining.isEmpty } },
              ws.daemons.all.map { "\($0.version) draining '\($0.draining)'" }.joined(separator: ", "))
        for n in all {
            guard let p = byName(n), let t = ws.tab(showing: p) else { check("daemons_live_after_\(n)", false); continue }
            let want = n.hasPrefix("old") ? oldV : newV
            ws.show(t)
            let ok = wait(8) { (ws.boxes[p]?.term.screen.frames ?? 0) > 0 && ws.boxes[p]?.term.live == true }
            check("daemons_live_after_\(n)", ok && ws.daemon(of: p)?.version == want && ws.boxes[p]?.term.conn === ws.daemon(of: p)?.conn,
                  "daemon \(ws.daemon(of: p)?.version ?? "?") want \(want), frames \(ws.boxes[p]?.term.screen.frames ?? 0)")
        }
        // The busy ones keep drawing what their program prints.
        for n in ["old-busy", "new-busy"] {
            guard let p = byName(n), let t = ws.tab(showing: p), let v = ws.boxes[p]?.term else { continue }
            ws.show(t)
            settle(0.3)
            let f0 = v.screen.frames
            check("daemons_streams_\(n)", wait(3) { v.screen.frames > f0 + 10 }, "frames \(f0) then \(v.screen.frames)")
        }

        // Typing, as the person: each shell gets its own line, the other none.
        let marks = ["old-shell": "typedold", "new-shell": "typednew"]
        for (n, mark) in marks.sorted(by: { $0.key < $1.key }) {
            guard let p = byName(n), let t = ws.tab(showing: p) else { continue }
            ws.show(t)
            // Its stream open (keys go over it) and its prompt drawn.
            _ = wait(8) { ws.boxes[p].map { $0.term.live && $0.term.channel != 0 && $0.term.screen.text().contains("~ >") } ?? false }
            settle(0.3)
            guard let v = ws.focusedView, v.pane == p else { check("daemons_keyboard_\(n)", false, "focused \(ws.focusedView?.pane ?? "none")"); continue }
            typeKeys(v, "echo \(mark)")
            typeKeys(v, "\r")
            check("daemons_typed_\(n)", wait(5) { v.screen.text().components(separatedBy: "\n").contains { $0.trimmingCharacters(in: .whitespaces) == mark } },
                  v.screen.text().components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.suffix(3).joined(separator: " / "))
            // In its own daemon's input log, by the person.
            let rec = ((try? ws.conn(of: p).call("pane.inputs", ["pane": p, "limit": 20]))?["inputs"] as? [[String: Any]] ?? [])
                .last { ($0["text"] as? String ?? "").contains(mark) }
            let src = rec?["source"] as? [String: Any]
            check("daemons_typed_as_person_\(n)", src?["kind"] as? String == "person", "\(src ?? [:])")
        }
        for (n, mark) in marks {
            let other = n == "old-shell" ? "new-shell" : "old-shell"
            guard let q = byName(other), let v = ws.boxes[q]?.term else { continue }
            check("daemons_not_typed_into_\(other)", !v.screen.text().contains(mark))
        }
        // No drive question on either daemon.
        for d in ws.daemons.all {
            let cps = ((try? d.conn.call("checkpoint.list", [:]))?["checkpoints"] as? [[String: Any]] ?? []).filter { $0["state"] as? String == "open" }
            check("daemons_no_question_\(d.version)", cps.isEmpty, cps.map { "\($0["kind"] ?? "?") \($0["id"] ?? "")" }.joined(separator: ", "))
        }

        // The edge dragged with each busy pane in front: each step's grid goes
        // to the pane's own daemon, and the last is drawn at its size. (The
        // draws a step are resizebench.mjs --daemons's: the drag from
        // another thread, as the person's.)
        for n in ["old-busy", "new-busy"] {
            guard let p = byName(n), let t = ws.tab(showing: p) else { continue }
            ws.show(t)
            settle(0.5)
            guard let v = ws.boxes[p]?.term else { continue }
            size(1280, 820)
            (window as? TerminalWindow)?.simulatedLiveResize = true
            var w: CGFloat = 1272
            while w >= 900 {
                var f = window.frame
                f.size.width = w
                window.setFrame(f, display: true)
                RunLoop.main.run(until: Date().addingTimeInterval(1.0 / 120))
                w -= 8
            }
            (window as? TerminalWindow)?.endSimulatedLiveResize()
            let g = v.gridSize
            var said = ""
            check("daemons_resize_reached_\(n)", wait(3) {
                let l = ((try? ws.conn(of: p).call("pane.list", ["hidden": true]))?["panes"] as? [[String: Any]] ?? []).first { $0["id"] as? String == p }
                said = "\((l?["cols"] as? NSNumber)?.intValue ?? 0)x\((l?["rows"] as? NSNumber)?.intValue ?? 0)"
                return said == "\(g.cols)x\(g.rows)"
            }, "view \(g.cols)x\(g.rows), \(ws.daemon(of: p)?.version ?? "?") says \(said)")
            let s = v.renderer.fonts.scale
            check("daemons_resize_drawn_\(n)", wait(2) { v.drawnPixels == CGSize(width: max(1, round(v.bounds.width * s)), height: max(1, round(v.bounds.height * s))) },
                  "drew \(v.drawnPixels) for \(v.bounds.size) at \(s)")
        }
        size(1280, 820)

        // A session whose pane is in the older daemon opens as its live tab, not read only.
        if let oldShell = byName("old-shell") {
            let hub = board.hub
            hub.testPatch = { st in
                var st = st
                var ps = st["projects"] as? [[String: Any]] ?? []
                for i in ps.indices where ps[i]["id"] as? String == "notes-app" {
                    var ss = ps[i]["sessions"] as? [[String: Any]] ?? []
                    if !ss.isEmpty { ss[0]["pane"] = oldShell }
                    ps[i]["sessions"] = ss
                }
                st["projects"] = ps
                return st
            }
            hub.testCheckpoints = []
            if let s0 = hub.state?.project("notes-app")?.sessions.first {
                if let first = ws.tabs.first, first.host != oldShell { ws.show(first) }
                board.pickSession("notes-app/\(s0.surfaceId)", why: "test")
                check("daemons_old_session_is_tab", board.front == .tab && ws.active?.focusedPane == oldShell && board.root.middle == nil,
                      "front \(board.front), active \(ws.active?.host ?? ""), middle \(board.root.middle.map { String(describing: type(of: $0)) } ?? "none")")
            } else { check("daemons_old_session_is_tab", false, "no session") }
            hub.testPatch = nil
            hub.testCheckpoints = nil
        }

        olderMove(oldV: oldV, newV: newV)
        continueHere(newV: newV)

        // A new tab goes to the newer daemon, and draws.
        let before = Set(ws.tabs.map(\.host))
        ws.newTab(nil)
        let fresh = ws.tabs.map(\.host).first { !before.contains($0) }
        check("daemons_new_tab_newest", fresh.map { ws.daemon(of: $0)?.version == newV } ?? false, "\(fresh ?? "none") in \(fresh.flatMap { ws.daemon(of: $0)?.version } ?? "?")")
        if let f = fresh { check("daemons_new_tab_live", wait(8) { (ws.boxes[f]?.term.screen.frames ?? 0) > 0 }) }

        // Closing an older daemon's pane ends it there.
        if let p = byName("old-shell") {
            ws.closePane(p)
            check("daemons_close_old", wait(5) {
                let l = ((try? ws.daemons.all.first { $0.version == oldV }?.conn.call("pane.list", ["hidden": true]))?["panes"] as? [[String: Any]] ?? [])
                return !l.contains { $0["id"] as? String == p && ($0["state"] as? String ?? "running") == "running" }
            } && !ws.tabs.contains { $0.host == p || $0.guest == p })
        }
        ws.save()
        ws.flush()
        size(1280, 820)
        settle(0.5)
        picture("native-daemons-1280.png")
    }

    /// A Claude session on the older daemon (sidetest's stand-in in
    /// recipe-box, mid-turn, which reports through that daemon's `ravenryd
    /// hook`): its panel says so with Move here, a shell of that daemon and
    /// a session on the newer one get none. The click goes to the hub's own
    /// move: the old pane's process ends, the conversation continues in a
    /// new pane of the newer daemon (sidetest's stand-in launch command),
    /// in the old tab's place in the strip, in front; the old pane closes.
    func olderMove(oldV: String, newV: String) {
        let ws = board.ws
        let hub = board.hub
        var key = "", old = ""
        let found = wait(30) {
            guard let p = hub.state?.project("recipe-box"), let s = p.sessions.first(where: { $0.pane != nil && $0.assistant == "claude" }), let pane = s.pane else { return false }
            key = "recipe-box/\(s.surfaceId)"; old = pane
            return s.group == "work"
        }
        check("older_session_working_on_old", found, "\(key) pane \(old) group \(hub.state?.project("recipe-box")?.sessions.first?.group ?? "-")")
        guard found else { return }
        board.pickSession(key, why: "test")
        _ = wait(5) { board.front == .tab && ws.active?.focusedPane == old }
        // Its tab second in the strip, so its place shows.
        if let t = ws.active, t.host == old { ws.move(id: t.id, to: 1) }
        board.render(force: true)
        check("older_session_tab", board.front == .tab && ws.active?.host == old && ws.tabs.firstIndex { $0.host == old } == 1 && ws.daemon(of: old)?.version == oldV,
              "front \(board.front), active \(ws.active?.host ?? "-"), at \(ws.tabs.firstIndex { $0.host == old } ?? -1), on \(ws.daemon(of: old)?.version ?? "?")")
        let busyLine = t("panel.olderRavenryBusy", ["version": oldV, "who": "Claude"])
        let idleLine = t("panel.olderRavenry", ["version": oldV])
        let mb = { self.board.panel.buttons["moveNewer"] }
        check("older_section_working", wait(8) { self.panelTexts().contains(busyLine) && mb()?.isEnabled == true && mb()?.title == t("move.here") },
              "shows \(board.panel.shows); \(panelTexts().prefix(4).joined(separator: " | "))")
        size(1280, 820)
        settle(0.5)
        picture("native-older-move-working-1280.png")
        panelPicture("native-older-move-working-panel.png")
        // Idle: the line without the clause.
        hub.testPatch = { st in
            var st = st
            var ps = st["projects"] as? [[String: Any]] ?? []
            for i in ps.indices where ps[i]["id"] as? String == "recipe-box" {
                var ss = ps[i]["sessions"] as? [[String: Any]] ?? []
                for j in ss.indices where ss[j]["surfaceId"] as? String == "ravenry:\(old)" { ss[j]["group"] = "idle"; ss[j]["state"] = "idle" }
                ps[i]["sessions"] = ss
            }
            st["projects"] = ps
            return st
        }
        board.render(force: true)
        check("older_section_idle", wait(5) { self.board.render(force: true); return self.panelTexts().contains(idleLine) && !self.panelTexts().contains(busyLine) && mb() != nil },
              panelTexts().prefix(4).joined(separator: " | "))
        settle(0.3)
        panelPicture("native-older-move-idle-panel.png")
        hub.testPatch = nil
        board.render(force: true)
        // A shell of the older daemon: no Move here (its state cannot move).
        if let sh = ws.tabs.map(\.host).first(where: { ws.label($0).name == "old-busy" }), let t = ws.tab(showing: sh) {
            ws.show(t); board.render(force: true)
            check("older_shell_no_move", wait(5) { self.board.panel.shows == "shell" } && mb() == nil && ws.daemon(of: sh)?.version == oldV,
                  "shows \(board.panel.shows), button \(mb() != nil)")
        } else { check("older_shell_no_move", false, "no old-busy tab") }
        // Back to the session, and Move here.
        board.pickSession(key, why: "test")
        _ = wait(5) { mb()?.isEnabled == true }
        let tabsBefore = ws.tabs.count
        mb()?.performClick(nil)
        check("older_move_busy_while_moving", mb()?.isEnabled == false && mb()?.title == t("move.moving"), mb()?.title ?? "no button")
        var fresh = ""
        let moved = wait(40) {
            guard self.board.front == .tab, let a = ws.active, a.host != old else { return false }
            fresh = a.host
            return ws.daemon(of: a.host)?.version == newV
        }
        check("older_move_new_pane_on_newer", moved, "active \(ws.active?.host ?? "-") on \(ws.active.flatMap { ws.daemon(of: $0.host)?.version } ?? "?"); \(board.log.suffix(3).joined(separator: " | "))")
        check("older_move_same_place_in_front", moved && ws.tabs.firstIndex { $0.host == fresh } == 1 && ws.tabs.count == tabsBefore && !ws.tabs.contains { $0.host == old || $0.guest == old } && board.root.middle == nil,
              "at \(ws.tabs.firstIndex { $0.host == fresh } ?? -1), tabs \(tabsBefore) then \(ws.tabs.count): \(ws.tabs.map { "\(ws.label($0.host).name)@\(ws.daemon(of: $0.host)?.version ?? "?")" }.joined(separator: ", "))")
        check("older_move_new_pane_draws", wait(8) { (ws.boxes[fresh]?.term.screen.frames ?? 0) > 0 && ws.boxes[fresh]?.term.live == true })
        // The old pane ended and closed on the older daemon.
        let oldLink = ws.daemons.all.first { $0.version == oldV }
        check("older_move_old_pane_closed", wait(15) {
            let l = ((try? oldLink?.conn.call("pane.list", ["hidden": true]))?["panes"] as? [[String: Any]] ?? [])
            return !l.contains { $0["id"] as? String == old && ($0["state"] as? String ?? "running") == "running" }
        }, oldLink == nil ? "the older daemon went away" : "")
        // The board names the session in its new pane: no Move here there.
        let named = wait(20) { hub.state?.project("recipe-box")?.sessions.contains { $0.pane == fresh } ?? false }
        board.render(force: true)
        check("older_moved_session_no_move", named && wait(5) { self.board.panel.shows == "session" } && mb() == nil,
              "named \(named), shows \(board.panel.shows), button \(mb() != nil)")
        settle(1.5)
        picture("native-older-moved-1280.png")
        panelPicture("native-older-moved-panel.png")
        // Its tab stays: the launch after brings it back where it is (sidetest.mjs).
    }

    /// Continue this conversation (lighthouse's page, a conversation of its
    /// folder no process holds): the hub resumes it in a new pane of the
    /// newer daemon, a tab of its own at the end, in front, drawing. It stays
    /// for the launch after (sidetest.mjs: back as a tab, in its place).
    func continueHere(newV: String) {
        let ws = board.ws
        guard let p = board.hub.state?.project("lighthouse") else { check("continue_new_tab_on_newer", false, "no lighthouse"); return }
        let before = Set(ws.tabs.map(\.host))
        board.projectPage.onContinue?(p, ["sessionId": "1a9b0001-0000-4000-8000-0000000000aa"])
        var pane = ""
        let ok = wait(30) {
            guard self.board.front == .tab, let a = ws.active, !before.contains(a.host) else { return false }
            pane = a.host
            return true
        }
        check("continue_new_tab_on_newer", ok && ws.daemon(of: pane)?.version == newV && ws.tabs.last?.host == pane && board.root.middle == nil,
              "active \(ws.active?.host ?? "-") on \(ws.active.flatMap { ws.daemon(of: $0.host)?.version } ?? "?"), last tab \(ws.tabs.last?.host ?? "-"); \(board.log.suffix(2).joined(separator: " | "))")
        check("continue_draws", ok && wait(8) { (ws.boxes[pane]?.term.screen.frames ?? 0) > 0 && ws.boxes[pane]?.term.live == true })
    }

    /// Every text the panel shows.
    func panelTexts() -> [String] {
        func walk(_ v: NSView) -> [String] { ((v as? NSTextField).map { [$0.stringValue] } ?? []) + v.subviews.flatMap(walk) }
        return walk(board.panel)
    }

    /// The panel alone, as it draws, at 2x.
    func panelPicture(_ name: String) {
        let v = board.panel
        guard v.window != nil, let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
        v.cacheDisplay(in: v.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent(name))
    }

    /// Keys as the keyboard sends them, through the view's own keyDown and keyUp.
    func typeKeys(_ v: TerminalView, _ s: String) {
        var codes: [String: UInt16] = [:]
        for (k, name) in KeyCodes.table {
            if name.hasPrefix("Key") { codes[name.dropFirst(3).lowercased()] = k }
            if name.hasPrefix("Digit") { codes[String(name.dropFirst(5))] = k }
        }
        codes[" "] = 0x31
        codes["\r"] = 0x24
        for ch in s {
            let c = String(ch)
            guard let code = codes[c] else { continue }
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                if let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                            windowNumber: window.windowNumber, context: nil, characters: c, charactersIgnoringModifiers: c,
                                            isARepeat: false, keyCode: code) {
                    if type == .keyDown { v.keyDown(with: e) } else { v.keyUp(with: e) }
                }
            }
        }
        settle(0.1)
    }

}
