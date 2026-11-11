// New session (sidetest.mjs --screen start): the demo hub's folders, where
// notes-app's and paper-boat's sessions are working (the hub's `busy`),
// Claude Code found and signed in, Codex found and not signed in; step 2
// from the hub's own skills rows (its hooks off, the skill not installed).
// Every control is pressed with the mouse; the session's start, the setup
// routes and the onboarding mark are answered here and never sent (no
// assistant runs).

import AppKit

extension SelfTestBoard {
    func screenStart() {
        let hub = board.hub
        let st = board.start
        let asst: [[String: Any]] = [["kind": "claude", "name": "Claude Code", "found": true, "signedIn": true, "path": "/usr/local/bin/claude"],
                                     ["kind": "codex", "name": "Codex", "found": true, "signedIn": false, "path": "/usr/local/bin/codex"]]
        // The hub's own answers, with these assistants.
        func live(_ q: String) -> [String: Any]? {
            var out: [String: Any]?
            hub.get(q) { code, j in out = code == 200 ? j : [:] }
            _ = wait(8) { out != nil }
            guard var j = out, j["folders"] != nil else { return nil }
            j["assistants"] = asst
            return j
        }
        guard let a0 = live("/api/setup/start"), let fs0 = a0["folders"] as? [[String: Any]] else { check("start_hub_answer", false); return }
        let notes = fs0.first { $0["name"] as? String == "notes-app" }?["path"] as? String ?? ""
        let boat = fs0.first { $0["name"] as? String == "paper-boat" }?["path"] as? String ?? ""
        check("start_hub_busy", (fs0.first { $0["path"] as? String == notes }?["busy"] as? [String: Any])?["topic"] as? String == "Sync settings"
              && (fs0.first { $0["path"] as? String == boat }?["busy"] as? [String: Any])?["projectId"] as? String == "paper-boat"
              && fs0.contains { $0["busy"] == nil }, "\(fs0.map { "\($0["name"] ?? ""):\(($0["busy"] as? [String: Any])?["topic"] ?? "-")" })")
        hub.testAnswers["/api/setup/start"] = a0
        // A folder inside notes-app, from Choose another folder.
        let web = (notes as NSString).appendingPathComponent("web")
        try? FileManager.default.createDirectory(atPath: web, withIntermediateDirectories: true)
        let enc = { (p: String) in p.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? p }
        if let a1 = live("/api/setup/start?folder=\(enc(web))") { hub.testAnswers["/api/setup/start?folder=\(enc(web))"] = a1 }
        let started: (Int, [String: Any]) = (200, ["ok": true, "projectId": "notes-app", "surfaceId": hub.state?.project("notes-app")?.sessions.first?.surfaceId ?? "", "pane": ["id": "pnotapan"]])
        hub.testPostAnswers = ["/api/sessions/start": started, "/api/onboarding": (200, ["ok": true]),
                               "/api/setup/hooks": (200, ["ok": true]), "/api/setup/skills": (200, ["ok": true])]

        // Opened from the sidebar's +, as Electron's: the hub's first folder, Claude Code.
        board.openStart(nil)
        check("start_opens", wait(5) { self.board.front == .start && st.folder == notes && st.assistant == "claude" && st.controls["folder:\(notes)"] != nil },
              "\(board.front) \(st.folder ?? "-") \(st.assistant ?? "-")")
        check("start_words", shows(st, "Start a session") && shows(st, "Pick a folder and an assistant") && shows(st, "Found in ~/Projects.") && shows(st, "Keeping cmux, iTerm2 or Rex?"),
              texts(st).prefix(12).joined(separator: " | "))
        let picks = st.controls.keys.filter { $0.hasPrefix("folder:") }
        check("start_three_picks", picks.count == 3 && (st.controls["folder:\(notes)"] as? Row)?.selected == true, picks.sorted().joined(separator: ","))
        check("start_assistants", shows(st, "Found, signed in") && shows(st, "Found, not signed in yet") && st.go.title == "Start Claude in notes-app", st.go.title)
        check("start_own_copy_line", shows(st, "It gets its own copy of the code") && shows(st, "because Sync settings is already working in notes-app") && st.controls["inFolder"] != nil,
              texts(st).joined(separator: " | "))
        check("start_key_and_cancel", shows(st, "⌘⇧N starts another one any time") && st.controls["cancel"] != nil)
        pictures("start")

        // A folder row, by the mouse.
        if let r = st.controls["folder:\(boat)"] { click(r) }
        check("start_folder_pick", st.folder == boat && st.go.title == "Start Claude in paper-boat" && shows(st, "because Tilting the hull is already working in paper-boat"), "\(st.folder ?? "-")")
        if let r = st.controls["folder:\(notes)"] { click(r) }
        // The assistant cards.
        if let c = st.controls["assistant:codex"] { click(c) }
        check("start_assistant_pick", st.assistant == "codex" && st.go.title == "Start Codex in notes-app", st.go.title)
        if let c = st.controls["assistant:claude"] { click(c) }
        check("start_assistant_back", st.assistant == "claude")
        // Work in the folder instead, and back.
        if let l = st.controls["inFolder"] { click(l) }
        check("start_in_folder", st.inFolder && shows(st, "It works right in the folder") && shows(st, "beside Sync settings, so they share the files.") && st.controls["ownCopy"] != nil)
        pictures("start-infolder")
        if let l = st.controls["ownCopy"] { click(l) }
        check("start_own_copy_back", !st.inFolder && shows(st, "It gets its own copy of the code"))

        // Choose another folder: one inside notes-app, first, its own copy said.
        st.testChoice = web
        if let c = st.controls["choose"] { click(c) }
        check("start_choose_folder", wait(5) { st.folder == web && st.controls["folder:\(web)"] != nil && st.busyHere?["projectId"] as? String == "notes-app" } && st.go.title == "Start Claude in web",
              "\(st.folder ?? "-") \(st.go.title)")
        st.testChoice = nil
        // A folder dropped on the card: the pasteboard's folder is the one; a file is not.
        let pb = NSPasteboard(name: NSPasteboard.Name("ravenry-selftest-drop"))
        pb.clearContents(); pb.writeObjects([URL(fileURLWithPath: boat) as NSURL])
        let filePB = NSPasteboard(name: NSPasteboard.Name("ravenry-selftest-drop-file"))
        filePB.clearContents(); filePB.writeObjects([URL(fileURLWithPath: (notes as NSString).appendingPathComponent("README.md")) as NSURL])
        check("start_drop_folder", st.folder(in: pb) == boat && st.folder(in: filePB) == nil)
        if let r = st.controls["folder:\(notes)"] { click(r) }
        _ = wait(3) { st.folder == notes }

        // Cancel: back to the tab.
        if let c = st.controls["cancel"] { click(c) }
        check("start_cancel", board.front == .tab && board.root.middle == nil, "\(board.front)")

        // Start: step 2 first, from the hub's skills rows.
        board.openStart(nil)
        _ = wait(5) { st.controls["go"] != nil && st.folder == notes }
        var n = hub.sentBodies.count
        click(st.go)
        check("start_setup_step", wait(8) { st.setup != nil } && shows(st, "Let Claude work with Ravenry") && shows(st, "One step before Claude opens in notes-app")
              && shows(st, "Know when Claude waits for you") && shows(st, "Install the Ravenry skill") && shows(st, "Adds ~/.claude/skills/ravenry") && shows(st, "Step 2 of 2"),
              texts(st).joined(separator: " | "))
        check("start_setup_ticked", st.setup?.hooks == true && st.setup?.skill == true && !hub.sentBodies.dropFirst(n).contains { $0.path == "/api/sessions/start" }, "\(String(describing: st.setup))")
        pictures("setup")
        if let tk = st.controls["tick:skill"] { click(tk) }
        check("start_setup_untick", st.setup?.skill == false && st.setup?.hooks == true)
        if let tk = st.controls["tick:skill"] { click(tk) }
        check("start_setup_tick_again", st.setup?.skill == true)
        // Set them up: the hooks, then the skill, the mark, then the session in its own copy.
        n = hub.sentBodies.count
        if let b = st.controls["setUp"] { click(b) }
        let sent = { Array(hub.sentBodies.dropFirst(n)) }
        check("start_set_up_posts", wait(8) { sent().contains { $0.path == "/api/sessions/start" } }
              && sent().map(\.path).filter { $0 != "/api/sessions/start" } == ["/api/setup/hooks", "/api/setup/skills", "/api/onboarding"]
              && sent()[0].body["only"] as? String == "claude" && sent()[1].body["kind"] as? String == "claude" && sent()[1].body["on"] as? Bool == true
              && (sent()[2].body["setup"] as? [String: Any])?["claude"] as? Bool == true, sent().map(\.path).joined(separator: ","))
        let body = sent().last { $0.path == "/api/sessions/start" }?.body ?? [:]
        check("start_own_copy_posted", body["worktree"] as? Bool == true && body["projectId"] as? String == "notes-app" && body["assistant"] as? String == "claude" && body["folder"] as? String == notes, "\(body)")
        check("start_opens_session", wait(5) { if case .session = self.board.front { return true }; return false }, "\(board.front)")

        // Not now: no setup route, the mark, then the session right in the folder.
        board.openStart(nil)
        _ = wait(5) { st.controls["go"] != nil && st.folder == notes }
        if let l = st.controls["inFolder"] { click(l) }
        click(st.go)
        _ = wait(8) { st.setup != nil }
        n = hub.sentBodies.count
        if let b = st.controls["notNow"] { click(b) }
        check("start_not_now", wait(8) { sent().contains { $0.path == "/api/sessions/start" } } && sent().map(\.path) == ["/api/onboarding", "/api/sessions/start"], sent().map(\.path).joined(separator: ","))
        let b2 = sent().last?.body ?? [:]
        check("start_in_folder_posted", b2["worktree"] == nil && b2["projectId"] == nil && b2["folder"] as? String == notes, "\(b2)")

        // The board says no: the reason under the card.
        hub.testPostAnswers["/api/sessions/start"] = (409, ["error": "Worktree sessions run on this computer only for now."])
        hub.testAnswers["/api/onboarding"] = ["ok": true, "setup": ["claude": true]]
        board.openStart(nil)
        _ = wait(5) { st.controls["go"] != nil }
        click(st.go)
        check("start_error_line", wait(8) { st.error != nil } && shows(st, "Could not start it: Worktree sessions run on this computer only for now.") && st.setup == nil, texts(st).suffix(4).joined(separator: " | "))

        // No assistant here: the words, and a shell in the folder.
        var none = a0
        none["assistants"] = asst.map { var x = $0; x["found"] = false; x["signedIn"] = false; return x }
        hub.testAnswers["/api/setup/start"] = none
        board.openStart(nil)
        check("start_no_assistant", wait(5) { self.shows(st, "Neither Claude Code nor Codex is installed here yet") && st.go.title == "Open a shell in notes-app" }, st.go.title)
        let tabs = board.ws.tabs.count
        n = hub.sentBodies.count
        click(st.go)
        check("start_shell_tab", wait(5) { self.board.ws.tabs.count == tabs + 1 && self.board.front == .tab } && !sent().contains { $0.path == "/api/sessions/start" }, "\(board.ws.tabs.count) \(board.front)")

        hub.testAnswers = [:]
        hub.testPostAnswers = [:]
    }
}
