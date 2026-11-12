// Group A's self-test (scripts/sidetest.mjs --screen sessions): the
// sidebar's rows, the session panel and project page, and the Sessions page
// with its batch close, on the demo hub with its sessions in cmux tabs (the
// fake cmux closes a tab when asked, and the Claude in it ends) and an idle
// line of 36 s, so weather-widget is idle and garden-planner and recipe-box
// are left for you (each ends on a question).
//
// - A session's name 80 characters long: its assistant chip keeps its whole
//   width at every sidebar width and window size (the maintainer's 15.51.40.png: an
//   empty chip), and every row's percent ends on the same x.
// - A pinned row keeps its percent beside the pin.
// - The foot's memory line opens Sessions; the ticks follow the hub's
//   groups; ticking garden-planner too and pressing Close posts exactly the
//   two ids, and the hub closes both tabs (Recently closed has them, the
//   processes are gone) while recipe-box keeps running; Reopen posts its id.
// - A row's right-click menu: Close on a session that can go (it closes
//   through the hub), a disabled Close with the reason on one at work.
// - The panel's context line links to Settings' Hand-off tab; its tick goes
//   when hand-off is off. A project's panel has its state, last
//   conversation and folder; a project that leaves the board says so.

import AppKit

extension SelfTestBoard {
    private func keyOf(_ project: String) -> String? {
        guard let p = board.hub.state?.project(project), let s = p.sessions.first else { return nil }
        return "\(project)/\(s.surfaceId)"
    }

    /// Applies the state patch now (testCheckpoints set again applies testPatch to the state held).
    private func repatch(_ f: (([String: Any]) -> [String: Any])?) {
        board.hub.testPatch = f
        board.hub.testCheckpoints = board.hub.state?.checkpoints
        settle(0.4)
        board.render(force: true)
        settle(0.3)
    }

    /// The chip of a row: its whole word drawn (its label as wide as it needs, the box around it).
    private func chipWhole(_ key: String) -> (Bool, String) {
        guard let c = board.sidebar.tags[key] ?? nil, let l = c.subviews.first as? NSTextField else { return (false, "no chip for \(key)") }
        let need = ceil(l.intrinsicContentSize.width)
        return (l.frame.width >= need - 0.5 && c.frame.width >= need + 13.5 && !c.isHidden, "chip \(Int(c.frame.width)) pt, its word \(Int(l.frame.width)) of \(Int(need)) pt")
    }

    /// The right edge of every row's percent, in the sidebar.
    private func pctEdges() -> [CGFloat] {
        board.sidebar.pcs.values.filter { !$0.isHidden && $0.window != nil && !$0.stringValue.isEmpty }.map { $0.convert($0.bounds, to: board.sidebar).maxX.rounded() }
    }

    func screenSessions() {
        let hub = board.hub
        let sb = board.sidebar
        check("sess_state_read", wait(40) { (hub.state?.sessionsView?["at"] as? String) != nil && (hub.state?.sessionProcs.count ?? 0) >= 5 },
              "\(hub.state?.sessionsView?["count"] ?? "none") rows")
        let procs = hub.state?.sessionProcs ?? []
        check("sess_groups", procs.contains { $0.label == "weather-widget" && $0.group == "idle" && $0.canClose } && procs.contains { $0.label == "garden-planner" && $0.group == "left" && $0.canClose },
              procs.map { "\($0.label):\($0.group):\($0.closable)\($0.blocked.map { " (\($0))" } ?? "")" }.joined(separator: ", "))

        // MARK: the one-time needs-you hint under the first row that waits on the person (C23)
        func hintBox(_ v: NSView) -> NSView? {
            if v.identifier?.rawValue == "hint-needs-you", !v.isHidden { return v }
            for x in v.subviews { if let f = hintBox(x) { return f } }
            return nil
        }
        _ = wait(6) { Hints.shared.loaded }
        board.render(force: true)
        settle(0.3)
        let hb = hintBox(sb)
        check("sess_hint_needs_you_shown", hb != nil && shows(hb ?? NSView(), "This session waits on you.") && shows(hb ?? NSView(), "Learn more"), "loaded \(Hints.shared.loaded) done \(Hints.shared.done.sorted())")
        pictures("sessions-hint")
        let s4 = hub.sentBodies.count
        if let x = (hb.map { v -> NSButton? in
            func find(_ v: NSView) -> NSButton? { if let b = v as? PlainButton, b.image != nil { return b }; for c in v.subviews { if let f = find(c) { return f } }; return nil }
            return find(v) } ?? nil) { x.performClick(nil) }
        check("sess_hint_dismissed_once", wait(4) { hintBox(sb) == nil } && hub.sentBodies.dropFirst(s4).contains { $0.path == "/api/onboarding" && ($0.body["hints"] as? [String: Any])?["needs-you"] as? Bool == true })

        // MARK: the chip (A1, A2, A27)
        let long = "Session crash after screen resize while the window was in full screen mode, again"
        guard let k1 = keyOf("garden-planner"), let kp = keyOf("paper-boat") else { check("sess_keys", false); return }
        repatch { st in
            var st = st
            var sb = st["sidebar"] as? [String: Any] ?? [:]
            var secs = sb["sections"] as? [[String: Any]] ?? []
            for i in secs.indices {
                var ps = secs[i]["projects"] as? [[String: Any]] ?? []
                for j in ps.indices {
                    var rs = ps[j]["rows"] as? [[String: Any]] ?? []
                    for r in rs.indices where rs[r]["key"] as? String == k1 { rs[r]["name"] = long }
                    ps[j]["rows"] = rs
                }
                secs[i]["projects"] = ps
            }
            sb["sections"] = secs
            st["sidebar"] = sb
            return st
        }
        check("sess_long_name_drawn", wait(4) { self.board.sidebar.names[k1]?.stringValue == long }, sb.names[k1]?.stringValue ?? "none")
        for (w, h, side) in [(CGFloat(1280), CGFloat(820), CGFloat(284)), (900, 760, 284), (1280, 820, 220), (1280, 820, SidebarView.maxWidth)] {
            size(w, h)
            sb.onResize?(side)
            settle(0.4)
            board.render(force: true)
            settle(0.3)
            window.contentView?.layoutSubtreeIfNeeded()
            let (ok, d) = chipWhole(k1)
            let name = sb.names[k1]
            let cut = (name?.frame.width ?? 0) < ceil(name?.intrinsicContentSize.width ?? 0)
            check("sess_chip_whole_\(Int(w))_side\(Int(side))", ok && cut, "\(d); the name \(Int(name?.frame.width ?? 0)) pt, cut \(cut)")
            let edges = Set(pctEdges())
            check("sess_percent_column_\(Int(w))_side\(Int(side))", edges.count == 1, "percent right edges \(edges.sorted())")
            // The foot's memory line says what it is ("Claude 2.8 GB") and is never cut, at every width.
            if let m = sb.footButtons["sessions"] {
                let whole = m.frame.width >= ceil(m.attributedTitle.size().width) - 0.5 && m.window != nil && !m.isHiddenOrHasHiddenAncestor
                let inside = sb.convert(m.bounds, from: m).maxX <= sb.bounds.maxX
                check("sess_memory_line_whole_\(Int(w))_side\(Int(side))", whole && inside && m.title.hasPrefix("Claude "), "\"\(m.title)\" \(Int(m.frame.width)) of \(Int(ceil(m.attributedTitle.size().width))) pt")
            } else { check("sess_memory_line_whole_\(Int(w))_side\(Int(side))", false, "no memory line") }
            if side != 284 { picture("native-sessions-chip-\(Int(w))-side\(Int(side))-dark.png") }
        }
        sb.onResize?(SidebarView.defaultWidth)
        size(1280, 820)
        // Every chip in the panel head stays whole too (a long project name in 296 pt).
        board.pickSession(k1, why: "test")
        settle(0.5)
        pictures("sessions-chip")

        // MARK: a pinned row keeps its percent (A3)
        if !board.pinned.contains(kp) { board.togglePin(kp) }
        settle(0.3)
        check("sess_pinned_keeps_percent", sb.pcs[kp]?.isHidden == false && sb.pins[kp]?.isHidden == false && !(sb.pcs[kp]?.stringValue.isEmpty ?? true),
              "percent \(sb.pcs[kp]?.stringValue ?? "none") hidden \(sb.pcs[kp]?.isHidden ?? true), pin hidden \(sb.pins[kp]?.isHidden ?? true)")
        board.togglePin(kp)
        repatch(nil)

        // MARK: the panel's context line (A13, A28, C2)
        board.pickSession(kp, why: "test")
        _ = wait(4) { self.board.panel.buttons["handoffSettings"] != nil }
        check("sess_panel_handoff_link", board.panel.buttons["handoffSettings"] != nil && shows(board.panel, "Hands off at") && board.panel.handOffTick != nil, texts(board.panel).prefix(14).joined(separator: " | "))
        let n0 = board.log.count
        board.panel.buttons["handoffSettings"]?.performClick(nil)
        settle(0.5)
        check("sess_panel_handoff_opens_settings", board.log.dropFirst(n0).contains { $0.hasPrefix("settings") }, board.log.dropFirst(n0).joined(separator: " | "))
        var sentOff = false
        hub.post("/api/settings/handoff", ["handoffEnabled": false]) { code, _ in sentOff = code == 200 }
        check("sess_handoff_off_no_tick", wait(10) { sentOff && hub.state?.handoffEnabled == false } && wait(4) { self.board.render(force: true); return self.board.panel.handOffTick == nil && self.shows(self.board.panel, "Hand-off is off") },
              texts(board.panel).prefix(14).joined(separator: " | "))
        pictures("sessions-panel-handoff-off")
        hub.post("/api/settings/handoff", ["handoffEnabled": true]) { _, _ in }
        _ = wait(8) { hub.state?.handoffEnabled == true }

        // MARK: a drive card says what the pane is, who opened it and where (A25)
        if let tb = board.ws.tabs.first, let f = hub.state?.find(kp) {
            let pane = tb.host
            var cp: [String: Any] = ["id": "cp-drive-test", "kind": "drive", "state": "open", "projectId": "paper-boat", "surfaceId": f.session.surfaceId, "assistant": "claude",
                                     "created_at": ISO8601DateFormatter().string(from: Date()), "title": "Let Claude type in zsh",
                                     "drive": ["action": "type", "pane": pane, "name": board.ws.label(pane).name, "input": "npm run dev<Enter>", "reason": "The tests need the dev server.",
                                               "agent": ["kind": "agent", "pane": "pagentxx"]]]
            var words: [String: Any]?
            hub.post("/api/checkpoints/words", ["checkpoints": [cp]]) { code, j in words = (j["words"] as? [String: Any])?["cp-drive-test"] as? [String: Any] ?? [:] }
            _ = wait(5) { words != nil }
            cp["words"] = words ?? [:]
            hub.testCheckpoints = [cp]
            board.pickSession(kp, why: "test")
            let ok = wait(5) { self.board.panel.shownCard != nil }
            let c: NSView = board.panel.shownCard ?? NSView()
            check("sess_drive_card_facts", ok && shows(c, ", a shell") && shows(c, "Opened") && shows(c, "By you, at") && shows(c, "Folder") && shows(c, "npm run dev"), texts(c).joined(separator: " | "))
            pictures("sessions-drive")
            // A page's run button shows its card over the page, even on a wide window (B18).
            board.openPage("plans", "Plans")
            settle(0.4)
            board.showCheckpoint("cp-drive-test")
            settle(0.4)
            check("sess_loose_card_over_page", board.panel.shows == "loose" && board.root.panelMode == .overlay && board.panel.shownCard != nil && shows(board.panel, "Needs you since"),
                  "\(board.panel.shows) \(board.root.panelMode)")
            // One picture as it is (a resize closes an overlay).
            picture("native-sessions-loose-1280-dark.png")
            board.pickSession(kp, why: "test")
            settle(0.3)
            check("sess_loose_goes_with_front", board.panel.loose == nil && board.panel.shows != "loose", "\(board.panel.shows)")
            hub.testCheckpoints = nil
            repatch(nil)
        }

        // MARK: the read-only view's head (V7, D20)
        board.pickSession(k1, why: "test")
        settle(0.6)
        if let mv = board.outside.buttons["move"] {
            let r = mv.convert(mv.bounds, to: board.outside)
            check("sess_readonly_buttons_right", r.maxX >= board.outside.bounds.width - 40 && board.outside.noteText != nil, "Move here ends at \(Int(r.maxX)) of \(Int(board.outside.bounds.width)); note \(board.outside.noteText ?? "none")")
        } else { check("sess_readonly_buttons_right", false, "no Move here") }

        // MARK: a project's panel and page (A17, A19), and one that leaves the board (A18)
        board.pickProject("lighthouse")
        check("sess_project_panel", wait(6) { self.shows(self.board.panel, "Last conversation") && self.shows(self.board.panel, "Lamp rotation speed") } && shows(board.panel, "Idle"),
              texts(board.panel).joined(separator: " | "))
        check("sess_project_page_state", shows(board.projectPage, "Idle"), texts(board.projectPage).prefix(8).joined(separator: " | "))
        pictures("sessions-project")
        board.pickProject("old-notes")
        repatch { st in
            var st = st
            st["projects"] = (st["projects"] as? [[String: Any]] ?? []).filter { $0["id"] as? String != "old-notes" }
            return st
        }
        check("sess_project_gone", wait(4) { self.board.render(force: true); return self.shows(self.board.projectPage, "no longer on the board") && self.board.panel.shows == "gone" },
              texts(board.projectPage).joined(separator: " | ") + " / panel \(board.panel.shows)")
        repatch(nil)

        // MARK: a shell's panel says where it runs (A23)
        if let tb = board.ws.tabs.first { board.ws.bar.onSelect?(tb.id) }
        settle(0.5)
        check("sess_shell_folder_runs", board.panel.shows == "shell" && shows(board.panel, "Folder") && shows(board.panel, "Runs"), "\(board.panel.shows): " + texts(board.panel).prefix(10).joined(separator: " | "))

        // MARK: a pane started as a session before the board lists it (A21); a session that leaves the board keeps its panel (A20)
        if let tb = board.ws.tabs.first {
            let was = board.panel.host?.paneLabels
            board.panel.host?.paneLabels = { _ in ["ravenry.session": "claude"] }
            board.ws.bar.onSelect?(tb.id)
            board.render(force: true)
            settle(0.3)
            check("sess_new_session_panel", board.panel.shows == "new" && shows(board.panel, "Ready for your first message") && shows(board.panel, "Claude Code"),
                  "\(board.panel.shows): " + texts(board.panel).prefix(10).joined(separator: " | "))
            if let w = was { board.panel.host?.paneLabels = w }
        }

        if let tb = board.ws.tabs.first, let kn = keyOf("notes-app") {
            let pane = tb.host
            repatch { st in
                var st = st
                var ps = st["projects"] as? [[String: Any]] ?? []
                for i in ps.indices where ps[i]["id"] as? String == "notes-app" {
                    var ss = ps[i]["sessions"] as? [[String: Any]] ?? []
                    if !ss.isEmpty { ss[0]["pane"] = pane }
                    ps[i]["sessions"] = ss
                }
                st["projects"] = ps
                return st
            }
            board.ws.bar.onSelect?(tb.id)
            check("sess_pane_session_panel", wait(4) { self.board.render(force: true); return self.board.panel.shows == "session" && self.board.panel.key == kn }, "\(board.panel.shows) \(board.panel.key)")
            repatch { st in
                var st = st
                var ps = st["projects"] as? [[String: Any]] ?? []
                for i in ps.indices where ps[i]["id"] as? String == "notes-app" { ps[i]["sessions"] = [] }
                st["projects"] = ps
                return st
            }
            check("sess_offboard_panel", wait(4) { self.board.render(force: true); return self.board.panel.shows == "offboard" } && shows(board.panel, "Not running now") && shows(board.panel, "Sync settings"),
                  "\(board.panel.shows): " + texts(board.panel).prefix(10).joined(separator: " | "))
            pictures("sessions-offboard")
            repatch(nil)
        }
        // MARK: a session in no project: Add to a project (A15)
        // A real one (the driver's): a cmux workspace in a folder no project holds, a session at work in it.
        let un = ask(["do": "unowned"])
        let uid = un?["project"] as? String ?? "", usf = un?["surface"] as? String ?? ""
        let ku = "\(uid)/\(usf)"
        if !wait(30, { hub.state?.project(uid)?.raw["unowned"] as? Bool == true && hub.state?.find(ku) != nil }) { check("sess_not_in_project_card", false, "no session in a workspace of no project: \(SelfTestBoard.lastAnswer)") }
        else {
            board.pickSession(ku, why: "test")
            settle(0.4)
            check("sess_not_in_project_card", board.panel.buttons["addToProject"]?.isEnabled == true && shows(board.panel, "Not in a project"), texts(board.panel).prefix(12).joined(separator: " | "))
            // Pinned as a tab first: its key changes when it joins a project, its session id stays (SESS-048).
            if !board.pinned.contains(ku) { board.togglePin(ku) }
            let s3 = hub.sentBodies.count
            if let from = hub.state?.project(uid), let to = hub.state?.project("lighthouse") { board.panel.addToProject(from, to) }
            check("sess_add_to_project_posts", wait(4) { hub.sentBodies.dropFirst(s3).contains { $0.path == "/api/project/add-workspace" && $0.body["from"] as? String == uid && $0.body["projectId"] as? String == "lighthouse" } })
            check("sess_add_to_project_lands", wait(15) { hub.state?.project("lighthouse")?.sessions.contains { $0.surfaceId == usf } == true && hub.state?.project(uid) == nil },
                  "lighthouse: \(hub.state?.project("lighthouse")?.sessions.map(\.surfaceId) ?? [])")
            // One tab for it, under its new key: the pin and the view in front followed it.
            let kn = "lighthouse/\(usf)"
            let tabs = { self.board.sessionTabs.filter { $0.hasSuffix("/\(usf)") } }
            check("sess_key_change_one_tab", wait(8) { self.board.pinned.contains(kn) && !self.board.pinned.contains(ku) && tabs() == [kn] && self.board.front == .session(kn) },
                  "pinned \(board.pinned); its tabs \(tabs()); front \(board.front)")
            if board.pinned.contains(kn) { board.togglePin(kn) }
            // It ends there (its process and its SessionEnd): lighthouse has no session at work again.
            _ = ask(["do": "end", "sid": un?["sid"] as? String ?? ""])
            _ = wait(15) { hub.state?.project("lighthouse")?.sessions.contains { $0.surfaceId == usf && !$0.handed } != true }
        }

        // MARK: the sidebar: the lease line (A4), the access note (A5), a row by the keyboard (A7), New session lit (A8)
        let oldUse = sb.useLine
        sb.useLine = { k in k == kp ? (true, "Using dev server") : nil }
        repatch { st in var st = st; st["access"] = ["waiting": NSNull(), "denied": [["folder": "~/Documents", "name": "Documents"]]]; return st }
        check("sess_use_line", shows(sb.rows[kp] ?? NSView(), "Using dev server"), texts(sb.rows[kp] ?? NSView()).joined(separator: " | "))
        check("sess_access_note", sb.noteShown?.contains("did not let Ravenry read ~/Documents") == true, sb.noteShown ?? "none")
        pictures("sessions-sidebar-note")
        // macOS asking (the hub's 503 names the folder): app.ts deniedNote's words, the question first, and Open Files & Folders.
        sb.testWaiting = (folder: "~/Documents", name: "Documents")
        board.render(force: true)
        settle(0.3)
        check("sess_access_asking_note", sb.noteShown == "macOS is asking whether Ravenry may read ~/Documents. Click Allow in the dialog. Closed it? System Settings > Privacy & Security > Files & Folders > Ravenry, turn on Documents."
              && sb.noteButton?.title == "Open Files & Folders", sb.noteShown ?? "none")
        let o = Outside.record?.count ?? 0
        if let b = sb.noteButton { click(b) }
        check("sess_access_open_privacy", Outside.record?.dropFirst(o).contains("open \(SidebarView.privacyPane)") ?? false, Outside.record?.suffix(1).joined() ?? "none")
        pictures("sessions-sidebar-asking")
        sb.testWaiting = nil
        board.render(force: true)
        settle(0.3)
        check("sess_access_note_back_to_refused", sb.noteShown?.hasPrefix("macOS did not let Ravenry read ~/Documents.") == true, sb.noteShown ?? "none")
        sb.useLine = oldUse
        repatch(nil)
        if let row = sb.rows[kp], let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36) {
            let n2 = board.log.count
            row.keyDown(with: e)
            settle(0.3)
            check("sess_row_return_opens", row.canBecomeKeyView && board.log.dropFirst(n2).contains { $0.contains(kp) }, board.log.dropFirst(n2).joined(separator: " | "))
        }
        board.openStart(nil)
        settle(0.3)
        check("sess_new_lit_on_start", sb.newButton.on)
        if let tb = board.ws.tabs.first { board.ws.bar.onSelect?(tb.id) }
        settle(0.3)
        check("sess_new_unlit_after", !sb.newButton.on)

        // MARK: a row's right-click menu (A12)
        if let row = sb.rows[kp], let m = row.menuItems?() {
            let close = m.items.first { $0.title.hasPrefix("Close") }
            check("sess_menu_in_use", close != nil && close?.isEnabled == false && m.items.contains { $0.title == "It is in use." } && m.items.contains { $0.title == t("sess.manage") },
                  m.items.map { "\($0.title)\($0.isEnabled ? "" : " (off)")" }.joined(separator: " | "))
        } else { check("sess_menu_in_use", false, "no menu") }

        // MARK: Sessions, from the foot's memory line (A11)
        guard let mem = sb.footButtons["sessions"] else { check("sess_foot_line", false, sb.footButtons.keys.sorted().joined(separator: ",")); return }
        mem.performClick(nil)
        let sp = board.sessionsPage
        check("sess_page_opens", wait(3) { self.board.root.middle === sp } && board.front == .page("sessions", "Sessions") && shows(sp, "of memory"), "\(board.front)")
        let ww = procs.first { $0.label == "weather-widget" }?.sessionId ?? ""
        let gp = procs.first { $0.label == "garden-planner" }?.sessionId ?? ""
        let rb = procs.first { $0.label == "recipe-box" }
        check("sess_page_ticks", sp.boxes[ww]?.state == .on && sp.boxes[gp]?.state == .off && shows(sp, "No activity for") && shows(sp, "Left for you") && shows(sp, "In use") && shows(sp, "Recently closed"),
              "weather \(sp.boxes[ww]?.state.rawValue ?? -1), garden \(sp.boxes[gp]?.state.rawValue ?? -1): " + texts(sp).prefix(20).joined(separator: " | "))
        pictures("sessions")
        sp.boxes[gp]?.performClick(nil)
        settle(0.3)
        check("sess_close_counts", sp.tickedIds.sorted() == [ww, gp].sorted() && (sp.buttons["closeSessions"]?.title.hasPrefix("Close 2 sessions") ?? false), sp.buttons["closeSessions"]?.title ?? "none")
        let s0 = hub.sentBodies.count
        sp.buttons["closeSessions"]?.performClick(nil)
        let closeSent = wait(5) { hub.sentBodies.dropFirst(s0).contains { $0.path == "/api/sessions/close" } }
        let body = hub.sentBodies.dropFirst(s0).first { $0.path == "/api/sessions/close" }?.body["ids"] as? [String] ?? []
        check("sess_close_posts_chosen", closeSent && body.sorted() == [ww, gp].sorted(), body.joined(separator: ","))
        check("sess_close_hub_closed_both", wait(30) { (sp.result?["closed"] as? NSNumber)?.intValue == 2 }, stableText(sp.result ?? [:]))
        let gone = wait(20) {
            let st = hub.state
            let ids = Set(st?.sessionProcs.compactMap { $0.sessionId } ?? [])
            let closed = Set((st?.sessionsView?["closed"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String })
            return !ids.contains(ww) && !ids.contains(gp) && closed.isSuperset(of: [ww, gp]) && ids.contains(rb?.sessionId ?? "-")
        }
        check("sess_closed_gone_others_kept", gone, (hub.state?.sessionProcs ?? []).map { "\($0.label):\($0.group)" }.joined(separator: ", "))
        check("sess_page_says_closed", wait(4) { self.shows(sp, "Closed 2 sessions") && !self.shows(sp, "Closing...") && sp.buttons["reopen:\(ww)"] != nil }, texts(sp).prefix(12).joined(separator: " | "))
        pictures("sessions-closed")
        // The toast's place in the log before the press (the *_posts check waits for the answer, which says it).
        let s1 = hub.sentBodies.count, n3 = board.log.count
        sp.buttons["reopen:\(ww)"]?.performClick(nil)
        check("sess_reopen_posts", wait(5) { hub.sentBodies.dropFirst(s1).contains { $0.path == "/api/sessions/reopen" && $0.body["id"] as? String == ww } })
        check("sess_reopen_done", wait(20) { !sp.reopening.contains(ww) && self.toasts(since: n3).contains { $0.hasPrefix("Reopened") } }
              && wait(20) { !((hub.state?.sessionsView?["closed"] as? [[String: Any]] ?? []).contains { $0["id"] as? String == ww }) },
              toasts(since: n3).joined(separator: " | "))

        // MARK: Close from a row's right-click menu
        if let rid = rb?.sessionId, let kr = keyOf("recipe-box"), let row = sb.rows[kr], let m = row.menuItems?(), let close = m.items.first(where: { $0.title.hasPrefix("Close session") && $0.isEnabled }) {
            let rname = sb.names[kr]?.stringValue ?? "recipe-box"
            let s2 = hub.sentBodies.count
            let n1 = board.log.count
            if let a = close.action { NSApp.sendAction(a, to: close.target, from: close) }
            check("sess_menu_close_posts", wait(5) { hub.sentBodies.dropFirst(s2).contains { $0.path == "/api/sessions/close" && ($0.body["ids"] as? [String]) == [rid] } })
            check("sess_menu_close_closed", wait(30) { !(hub.state?.sessionProcs.contains { $0.sessionId == rid } ?? true) } && wait(5) { self.toasts(since: n1).contains { $0.hasPrefix("Closed \(rname)") } },
                  toasts(since: n1).joined(separator: " | "))
        } else { check("sess_menu_close_posts", false, "no enabled Close on recipe-box: " + ((keyOf("recipe-box").flatMap { sb.rows[$0]?.menuItems?() })?.items.map { $0.title }.joined(separator: " | ") ?? "no row")) }
        // The sidebar against the hub, Open in, a toast, a project's page, Also open in (SelfTestSessFns.swift).
        sessFunctionChecks()
        // PANEL-029: a session that left the board, its last turn and Move here (SelfTestSessC.swift).
        offBoardMoveHere()
    }
}
