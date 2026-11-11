// The panel's round of the finish (scripts/sidetest.mjs --screen panel), on
// the demo hub and the test's own ravenryd:
//
// - New project (SESS-023) from the sidebar's last row: its fields as the
//   browser board has them, Start refused without a name and a goal, then a
//   new folder made with its BRIEF.md, the project on the board and its page
//   in front. Existing: a folder the board knows (its own BRIEF-<id>.md
//   beside the other project's brief) and one chosen in Finder's dialog.
// - From a folder (SESS-022): a shell whose folder no project uses offers
//   New project from this folder, and the project starts there; the Not in
//   a project card offers it too, with Create project.
// - The project page's main button (gap 16): Show it when the last
//   conversation is open in a pane of this window, Move here when it is open
//   outside, else Continue; a Continue refused because it is open elsewhere
//   asks again and offers Move here, another refusal says why.
// - Checkpoints only a daemon holds (A22, PANEL-015): `ravenryd ask` in a
//   second shell (the demo hub does not follow this daemon) dots its tab,
//   says so in a toast, shows its card worded by the hub's own code when the
//   tab is in front, and is answered through the daemon. One asked from no
//   pane opens on its own over what is in front. Then the board goes down
//   (arrival 1): a refusal as not the person and one that closed already
//   say so (the daemon's answer replaced), the loose one is answered through
//   the daemon, and a new question in the shell in front shows and is
//   answered, all with the hub down.

import AppKit

extension SelfTestBoard {
    private func patchState(_ f: (([String: Any]) -> [String: Any])?) {
        board.hub.testPatch = f
        board.hub.testCheckpoints = board.hub.state?.checkpoints
        settle(0.4)
        board.render(force: true)
        settle(0.3)
    }

    private func frontPage() -> String? { if case .page(let k, _) = board.front { return k }; return nil }

    private func sendLine(_ pane: String, _ text: String) {
        board.ws.conn(of: pane).request("pane.send", ["pane": pane, "input": [["text": text, "mode": "paste"], ["key": "Enter"]]])
    }

    func screenPanel() {
        let hub = board.hub, ws = board.ws, np = board.newProject
        check("panel_state_read", wait(40) { (hub.state?.projects.count ?? 0) >= 5 && hub.state?.project("lighthouse") != nil })
        guard let lh = hub.state?.project("lighthouse"), let lhFolder = lh.folder else { check("panel_lighthouse", false); return }
        // The demo board's HOME: a project folder of its must be inside it.
        let hubHome = ((lhFolder as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent
        board.render(force: true)
        settle(0.4)

        // MARK: New project from the sidebar
        guard let nb = board.sidebar.newProjectButton else { check("np_sidebar_row", false); return }
        check("np_sidebar_row", nb.window != nil && nb.title == "New project")
        nb.scrollToVisible(nb.bounds)
        settle(0.3)
        picture("native-side-new-project-1280-dark.png")
        click(nb)
        check("np_page_open", wait(3) { self.frontPage() == "newproject" }, "\(board.front)")
        check("np_folders_read", wait(8) { np.known != nil })
        board.render(force: true)
        settle(0.3)
        let missing = ["Name", "Folder", "Assistant", "Kind", "Goal", "Done means", "First milestones", "Rules", "Start in cmux"].filter { !shows(np, $0) }
        check("np_fields", missing.isEmpty && np.segFolder?.label(forSegment: 0) == "New folder" && np.segFolder?.label(forSegment: 1) == "Existing"
              && np.segAssistant?.label(forSegment: 0) == "Claude" && np.segAssistant?.label(forSegment: 1) == "Codex", "missing \(missing)")
        np.buttons["go"]?.performClick(nil)
        settle(0.3)
        check("np_needs_name", np.error == "Give it a name first.", np.error ?? "no error")
        np.field("name", "").text = "Kite Tracker"
        np.redraw()
        np.buttons["go"]?.performClick(nil)
        settle(0.3)
        check("np_needs_goal", np.error == "Write the goal: one or two sentences.", np.error ?? "no error")
        check("np_folder_follows_name", shows(np, "kite-tracker") && shows(np, "Makes kite-tracker, writes BRIEF.md, then opens a cmux workspace with Claude reading it"), texts(np).filter { $0.contains("kite") }.joined(separator: " | "))
        np.field("goal", "").text = "Track the kites over the bay on a map."
        np.field("doneMeans", "").text = "Each kite shows on the map within a minute."
        np.field("milestones", "").text = "Read the feed\nDraw the map"
        if let k = np.buttons["kind:Tool or CLI"] { k.performClick(nil) }
        np.redraw()
        settle(0.3)
        check("np_kind_picked", np.kind == "Tool or CLI")
        pictures("np-new")
        let s0 = hub.sentBodies.count
        np.buttons["go"]?.performClick(nil)
        check("np_made", wait(15) { np.made != nil }, np.error ?? "no answer")
        let body = hub.sentBodies.dropFirst(s0).first { $0.path == "/api/project/new" }?.body ?? [:]
        check("np_posts_form", body["name"] as? String == "Kite Tracker" && body["kind"] as? String == "Tool or CLI" && body["goal"] as? String == "Track the kites over the bay on a map."
              && body["milestones"] as? String == "Read the feed\nDraw the map" && body["existingFolder"] == nil && body["assistant"] == nil, "\(body)")
        let kid = np.made?["id"] as? String ?? "kite-tracker"
        check("np_listed_and_shown", wait(10) { hub.state?.project(kid) != nil && self.board.front == .project(kid) }, "\(board.front)")
        let kf = hub.state?.project(kid)?.folder ?? ""
        let brief = (try? String(contentsOfFile: (kf as NSString).appendingPathComponent("BRIEF.md"), encoding: .utf8)) ?? ""
        check("np_folder_and_brief", !kf.isEmpty && brief.contains("Track the kites over the bay"), kf)
        check("np_toast_says", board.log.contains { $0.hasPrefix("toast ") && $0.contains("Folder and brief are ready") }, board.log.suffix(6).joined(separator: " | "))

        // MARK: Existing: a folder the board knows, one chosen in Finder's dialog
        board.openNewProject(nil)
        _ = wait(8) { np.known != nil }
        np.segFolder?.selectedSegment = 1
        np.segFolder?.sendAction(np.segFolder?.action, to: np.segFolder?.target)
        settle(0.3)
        // Six folders show, the rest behind "N more folders".
        let moreShown = np.buttons["moreFolders"]?.title.hasSuffix("more folders") ?? false
        np.buttons["moreFolders"]?.performClick(nil)
        settle(0.3)
        let lhRow = np.folderRows[lhFolder]
        check("np_existing_rows", np.folderMode == "existing" && moreShown && lhRow != nil && np.folderRows.count >= 7, np.folderRows.keys.map { ($0 as NSString).lastPathComponent }.sorted().joined(separator: ", "))
        if let r = lhRow { click(r) }
        np.field("name", "").text = "Lamp tools"
        np.redraw()
        settle(0.3)
        check("np_existing_shared", np.pick == lhFolder && shows(np, "lighthouse uses this folder too. This project gets its own brief and hand-off file.")
              && shows(np, "Writes BRIEF-lamp-tools.md in lighthouse"), texts(np).filter { $0.contains("Writes") || $0.contains("uses") }.joined(separator: " | "))
        // Finder's dialog, answered by the test: a folder of the board's HOME.
        let stamps = (hubHome as NSString).appendingPathComponent("Work/stamps")
        try? FileManager.default.createDirectory(atPath: stamps, withIntermediateDirectories: true)
        try? "notes\n".write(toFile: (stamps as NSString).appendingPathComponent("notes.txt"), atomically: true, encoding: .utf8)
        let oldChoose = np.chooseFolder
        np.chooseFolder = { _, done in done(stamps) }
        np.buttons["choose"]?.performClick(nil)
        settle(0.3)
        check("np_finder_folder", np.pick == stamps && np.folderRows[stamps] != nil && shows(np, "From Finder") && shows(np, "No project on the board uses this folder yet."), np.pick ?? "none")
        if let r = np.folderRows[lhFolder] { click(r) }
        pictures("np-existing")
        np.field("goal", "").text = "Tools to time the lamp."
        let s1 = hub.sentBodies.count
        np.buttons["go"]?.performClick(nil)
        check("np_existing_made", wait(15) { np.made != nil }, np.error ?? "no answer")
        let b1 = hub.sentBodies.dropFirst(s1).first { $0.path == "/api/project/new" }?.body ?? [:]
        check("np_existing_posts_folder", b1["existingFolder"] as? String == lhFolder, "\(b1)")
        check("np_existing_own_brief", FileManager.default.fileExists(atPath: (lhFolder as NSString).appendingPathComponent("BRIEF-lamp-tools.md")) && FileManager.default.fileExists(atPath: (lhFolder as NSString).appendingPathComponent("BRIEF.md")))
        np.chooseFolder = oldChoose

        // MARK: New project from a shell's folder (SESS-022, SESS-023)
        let shop = (hubHome as NSString).appendingPathComponent("Work/kite-shop")
        try? FileManager.default.createDirectory(atPath: shop, withIntermediateDirectories: true)
        try? "# kite shop\n".write(toFile: (shop as NSString).appendingPathComponent("README.md"), atomically: true, encoding: .utf8)
        board.toTerminal()
        ws.newTab(in: shop)
        check("np_shell_tab", wait(8) { ws.active.flatMap { ws.paneInfo($0.focusedPane)?.cwd } == shop }, ws.active.flatMap { ws.paneInfo($0.focusedPane)?.cwd } ?? "none")
        board.render(force: true)
        _ = wait(4) { self.board.panel.buttons["newProject"] != nil }
        check("np_shell_offers", board.panel.shows == "shell" && shows(board.panel, "No project uses this folder.") && board.panel.buttons["newProject"] != nil, texts(board.panel).prefix(12).joined(separator: " | "))
        pictures("np-shell-panel")
        board.panel.buttons["newProject"]?.performClick(nil)
        check("np_shell_form", wait(3) { self.frontPage() == "newproject" } && np.from?.folder == shop && np.folderMode == "existing" && np.fields["name"]?.text == "Kite Shop"
              && shows(np, "The folder this shell is in.") && shows(np, "Writes BRIEF.md in kite-shop, then opens a cmux workspace with Claude reading it"), texts(np).prefix(14).joined(separator: " | "))
        pictures("np-from-shell")
        np.field("goal", "").text = "Sell kites."
        let s2 = hub.sentBodies.count
        np.buttons["go"]?.performClick(nil)
        check("np_shell_made", wait(15) { np.made != nil }, np.error ?? "no answer")
        let b2 = hub.sentBodies.dropFirst(s2).first { $0.path == "/api/project/new" }?.body ?? [:]
        check("np_shell_posts", b2["existingFolder"] as? String == shop && b2["workspaceId"] == nil && b2["assistant"] as? String == "claude", "\(b2)")
        check("np_shell_brief", FileManager.default.fileExists(atPath: (shop as NSString).appendingPathComponent("BRIEF.md")))
        // Now in a project: the shell no longer offers it.
        _ = wait(6) { hub.state?.projects.contains { $0.folder == shop } ?? false }
        board.toTerminal()
        board.render(force: true)
        settle(0.4)
        check("np_shell_offer_goes", board.panel.shows == "shell" && board.panel.buttons["newProject"] == nil, texts(board.panel).prefix(8).joined(separator: " | "))

        // MARK: the Not in a project card (SESS-022)
        if let p = hub.state?.projects.first(where: { $0.id == "notes-app" }), let s = p.sessions.first {
            patchState { st in
                var st = st
                var ps = st["projects"] as? [[String: Any]] ?? []
                for i in ps.indices where ps[i]["id"] as? String == "notes-app" { ps[i]["unowned"] = true; ps[i]["workspaces"] = ["ws-notes"] }
                st["projects"] = ps
                return st
            }
            board.pickSession("\(p.id)/\(s.surfaceId)", why: "test")
            settle(0.4)
            check("np_unowned_offers", board.panel.buttons["newProject"]?.isEnabled == true && board.panel.buttons["addToProject"] != nil, texts(board.panel).prefix(10).joined(separator: " | "))
            board.panel.buttons["newProject"]?.performClick(nil)
            check("np_unowned_form", wait(3) { self.frontPage() == "newproject" } && np.from?.workspaceId == "ws-notes" && np.fields["name"]?.text == "Notes App"
                  && np.buttons["go"]?.title == "Create project" && shows(np, "Nothing new is opened: the session already there joins the project"), texts(np).prefix(14).joined(separator: " | "))
            pictures("np-from-unowned")
            patchState(nil)
        } else { check("np_unowned_offers", false, "notes-app has no session") }

        // MARK: the project page's main button (gap 16)
        let lastPath = "/api/project/last?projectId=lighthouse"
        let tab0 = ws.tabs.first
        func last(_ openIn: [String: Any]?) -> [String: Any] {
            var l: [String: Any] = ["sessionId": "1a9b0001-0000-4000-8000-0000000000aa", "title": "Lamp rotation speed", "assistant": "claude", "stoppedAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(-600)),
                                    "lastPrompt": "How fast should the lamp turn?", "lastText": "One turn every ten seconds.", "command": "claude --resume 1a9b0001", "folderShort": "~/Projects/lighthouse"]
            if let o = openIn { l["openIn"] = o }
            return ["last": l]
        }
        func mainTitle() -> String { board.projectPage.buttons["continue"]?.title ?? "none" }
        if let t0 = tab0 {
            hub.testAnswers[lastPath] = last(["ravenry": true, "pane": t0.host, "name": "Ravenry"])
            board.pickProject("lighthouse")
            if let p = hub.state?.project("lighthouse") { board.projectPage.reload(p) }
            check("pp_show_it", wait(4) { mainTitle() == "Show it" }, mainTitle())
            picture("native-pp-show-it-1280-dark.png")
            board.projectPage.buttons["continue"]?.performClick(nil)
            check("pp_show_it_shows_tab", wait(3) { self.board.front == .tab && ws.active === t0 }, "\(board.front) \(ws.active?.host ?? "")")
        }
        hub.testAnswers[lastPath] = last(["ravenry": false, "name": "cmux"])
        board.pickProject("lighthouse")
        if let p = hub.state?.project("lighthouse") { board.projectPage.reload(p) }
        check("pp_move_here", wait(4) { mainTitle() == "Move here" } && shows(board.projectPage, "Still open in cmux."), mainTitle())
        picture("native-pp-move-here-1280-dark.png")
        hub.testAnswers[lastPath] = last(nil)
        if let p = hub.state?.project("lighthouse") { board.projectPage.reload(p) }
        check("pp_continue", wait(4) { mainTitle() == "Continue this conversation" }, mainTitle())
        picture("native-pp-continue-1280-dark.png")
        // Refused: still open in another terminal. The page asks again and says where, with Move here.
        hub.testPostAnswers["/api/sessions/resume"] = (409, ["error": "It is still open in cmux. Close it there first, then continue it here.", "open": true])
        hub.testAnswers[lastPath] = last(["ravenry": false, "name": "cmux"])
        let s3 = hub.sentBodies.count
        board.projectPage.buttons["continue"]?.performClick(nil)
        check("pp_refused_open_moves", wait(4) { mainTitle() == "Move here" } && board.projectPage.error == nil && hub.sentBodies.dropFirst(s3).contains { $0.path == "/api/sessions/resume" }, "\(mainTitle()) \(board.projectPage.error ?? "")")
        // Refused for another reason: said under the buttons.
        hub.testPostAnswers["/api/sessions/resume"] = (500, ["error": "The transcript is not readable."])
        hub.testAnswers[lastPath] = last(nil)
        if let p = hub.state?.project("lighthouse") { board.projectPage.reload(p) }
        _ = wait(4) { mainTitle() == "Continue this conversation" }
        board.projectPage.buttons["continue"]?.performClick(nil)
        check("pp_refused_says", wait(4) { self.shows(self.board.projectPage, "The transcript is not readable.") }, texts(board.projectPage).suffix(4).joined(separator: " | "))
        hub.testPostAnswers["/api/sessions/resume"] = nil
        hub.testAnswers[lastPath] = nil

        // MARK: checkpoints only a daemon holds (A22), the board up
        board.toTerminal()
        guard let first = ws.tabs.first else { check("cp_tabs", false); return }
        ws.newTab(nil)
        guard wait(5, { ws.tabs.count >= 2 && ws.active !== first }), let second = ws.active else { check("cp_second_tab", false); return }
        settle(1.0)
        ws.show(first)
        board.render(force: true)
        settle(0.5)
        let bin = Bundle.main.bundlePath + "/Contents/MacOS/ravenryd"
        let n0 = board.log.count
        sendLine(second.host, "'\(bin)' ask 'Ship the tiles to the testers?' --option 'Ship them' --option 'Not yet'")
        check("cp_daemon_held", wait(10) { hub.daemonCps.items.values.contains { $0.cp["pane"] as? String == second.host && DaemonCheckpoints.isOpen($0.cp) } }, "\(hub.daemonCps.items.count) held")
        let tabCp = hub.daemonCps.items.values.first { $0.cp["pane"] as? String == second.host }?.cp["id"] as? String ?? ""
        // Worded here by the hub's own code (the demo board does not follow this daemon).
        let w0 = hub.checkpoint(pane: second.host)?["words"] as? [String: Any]
        check("cp_worded_here", hub.checkpoint(pane: second.host)?["id"] as? String == tabCp && w0?["kind"] as? String == "ask" && w0?["head"] as? String == "Ship the tiles to the testers?", "\(w0 ?? [:])")
        check("cp_tab_dot", wait(4) { self.board.ws.bar.items.first { $0.model.id == second.id }?.model.dot == "you" })
        check("cp_tab_toast", board.log.dropFirst(n0).contains { $0 == "arrived tab:\(second.id): a toast" } && toasts(since: n0).contains { $0.contains("needs you: Ship the tiles to the testers?") }, toasts(since: n0).joined(separator: " | "))
        ws.show(second)
        board.render(force: true)
        settle(0.4)
        let pn = board.panel
        check("cp_tab_card", wait(4) { pn.shownCard?.kind == "ask" && self.shows(pn, "Ship the tiles to the testers?") && self.shows(pn, "Ship them") }, texts(pn).prefix(10).joined(separator: " | "))
        pictures("cp-tab-hub-up")
        let a0 = hub.sentBodies.count
        if let o = pn.shownCard?.opts["1"] { o.run?() }
        check("cp_tab_answered_on_daemon", wait(6) { hub.daemonCps.items[tabCp].map { !DaemonCheckpoints.isOpen($0.cp) } ?? false }
              && hub.sentBodies.dropFirst(a0).contains { $0.path == "ravenryd checkpoint.answer" && $0.body["checkpoint"] as? String == tabCp && ($0.body["choice"] as? NSNumber)?.intValue == 0 }
              && !hub.sentBodies.dropFirst(a0).contains { $0.path == "/api/checkpoints/answer" }, hub.sentBodies.dropFirst(a0).map(\.path).joined(separator: ", "))
        check("cp_tab_dot_goes", wait(4) { self.board.ws.bar.items.first { $0.model.id == second.id }?.model.dot != "you" })

        // One asked from no pane: on its own, over what is in front.
        var looseId = ""
        ws.conn.request("checkpoint.new", ["kind": "ask", "title": "Rotate the signing keys tonight?", "options": ["Rotate them", "Later"]]) { r in
            if case .success(let j) = r { DispatchQueue.main.async { looseId = (j["checkpoint"] as? [String: Any])?["id"] as? String ?? "" } }
        }
        check("cp_loose_opens", wait(6) { !looseId.isEmpty && pn.loose == looseId && pn.shows == "loose" && self.board.root.panelMode == .overlay }, "loose \(pn.loose ?? "nil") shows \(pn.shows)")
        check("cp_loose_card", shows(pn, "Rotate the signing keys tonight?") && shows(pn, "Needs you since") && pn.shownCard?.kind == "ask", texts(pn).prefix(8).joined(separator: " | "))
        pictures("cp-loose")
        _ = wait(1) { pn.loose != nil }
        if pn.loose == nil { board.showCheckpoint(looseId) }

        // MARK: the board goes down
        check("cp_board_down", arrival(1) && wait(10) { !hub.reachable }, "reachable \(hub.reachable)")
        board.render(force: true)
        settle(0.3)
        if pn.loose == nil { board.showCheckpoint(looseId) }
        hub.testDaemonError = "forbidden"
        if let o = pn.shownCard?.opts["1"] { o.run?() }
        check("cp_not_person_line", wait(4) { self.shows(pn, "Answers only work from the Ravenry app when it is opened normally.") }, texts(pn).prefix(10).joined(separator: " | "))
        picture("native-cp-not-person-1280-dark.png")
        hub.testDaemonError = "not_found"
        if let o = pn.shownCard?.opts["1"] { o.run?() }
        check("cp_closed_already_line", wait(4) { self.shows(pn, "It closed already: answered somewhere else, withdrawn, or out of time.") }, texts(pn).prefix(10).joined(separator: " | "))
        hub.testDaemonError = nil
        let a1 = hub.sentBodies.count
        if let o = pn.shownCard?.opts["1"] { o.run?() }
        check("cp_loose_answered_board_down", wait(6) { hub.daemonCps.items[looseId].map { !DaemonCheckpoints.isOpen($0.cp) } ?? false }
              && hub.sentBodies.dropFirst(a1).contains { $0.path == "ravenryd checkpoint.answer" && $0.body["checkpoint"] as? String == looseId }
              && !hub.sentBodies.dropFirst(a1).contains { $0.path == "/api/checkpoints/answer" }, hub.sentBodies.dropFirst(a1).map(\.path).joined(separator: ", "))
        // Answered, it says so (PANEL-024) until something else comes to the front.
        check("cp_loose_says_answered", wait(4) { self.board.render(force: true); return pn.loose == looseId && self.shows(pn, "Answered") && !self.shows(pn, "Needs you since") }, texts(pn).prefix(6).joined(separator: " | "))
        ws.show(first)
        check("cp_loose_goes", wait(4) { self.board.render(force: true); return pn.loose == nil && pn.shows != "loose" }, pn.shows)
        // A new question in the shell in front, the board down: its card, answered through the daemon.
        ws.show(second)
        board.render(force: true)
        sendLine(second.host, "'\(bin)' ask 'Deploy the docs now?' --option 'Deploy' --option 'Wait'")
        check("cp_board_down_card", wait(10) { self.board.render(force: true); return pn.shownCard?.kind == "ask" && self.shows(pn, "Deploy the docs now?") }, texts(pn).prefix(10).joined(separator: " | "))
        pictures("cp-tab-board-down")
        let downCp = hub.checkpoint(pane: second.host)?["id"] as? String ?? ""
        if let o = pn.shownCard?.opts["2"] { o.run?() }
        check("cp_board_down_answered", wait(6) { hub.daemonCps.items[downCp].map { !DaemonCheckpoints.isOpen($0.cp) && (($0.cp["answer"] as? [String: Any])?["choice"] as? NSNumber)?.intValue == 1 } ?? false },
              hub.daemonCps.items[downCp].map { "\($0.cp["state"] ?? "")" } ?? "none")
    }
}
