// The writing self-test (scripts/sidetest.mjs --screen write, its board in
// write-fixture.mjs): what the native app writes that only the hub's
// browser board wrote before. Each check presses the real control (a mouse
// press through the window), types with key events where words go in, and
// reads the effect where it lands: the brief, the hub's ledgers and files
// on disk, the hub's state, and the hub's own answer to what the app sent
// (a status from the logging proxy, RAVENRY_MAC_WRITE's traffic), never
// only what the window posted.

import AppKit

extension SelfTestBoard {
    private struct WriteEnv { let root: String; let mc: String; let traffic: String; let picture: String }
    private var wenv: WriteEnv? {
        guard let p = ProcessInfo.processInfo.environment["RAVENRY_MAC_WRITE"], let d = FileManager.default.contents(atPath: p),
              let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: String] else { return nil }
        return WriteEnv(root: j["root"] ?? "", mc: j["mc"] ?? "", traffic: j["traffic"] ?? "", picture: j["picture"] ?? "")
    }

    /// The hub's answers to the app's POSTs so far (the proxy's log).
    private func answers(_ e: WriteEnv) -> [[String: Any]] {
        guard let s = try? String(contentsOfFile: e.traffic, encoding: .utf8) else { return [] }
        return s.split(separator: "\n").compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
    }
    /// The hub's answer to the first POST of `path` after `n` answers: its status and body, waited for.
    private func answer(_ e: WriteEnv, _ path: String, after n: Int, _ t: Double = 20) -> (status: Int, body: String)? {
        var hit: [String: Any]?
        _ = wait(t) { hit = self.answers(e).dropFirst(n).first { $0["m"] as? String == "POST" && $0["u"] as? String == path }; return hit != nil }
        return hit.map { (($0["s"] as? NSNumber)?.intValue ?? 0, $0["res"] as? String ?? "") }
    }
    private func ok2xx(_ a: (status: Int, body: String)?) -> Bool { a.map { (200..<300).contains($0.status) } ?? false }
    private func said(_ a: (status: Int, body: String)?) -> String { a.map { "\($0.status) \($0.body.prefix(160))" } ?? "no answer" }
    private func file(_ p: String) -> String { (try? String(contentsOfFile: p, encoding: .utf8)) ?? "" }
    private func brief(_ e: WriteEnv, _ id: String) -> String { file("\(e.root)/\(id)/BRIEF.md") }
    private func null(_ x: Any?) -> Bool { x == nil || x is NSNull }
    private func gate(_ id: String) -> [String: Any]? { board.hub.state?.project(id)?.raw["planGate"] as? [String: Any] }

    /// Words typed as the keyboard types them: a key event per character, through the window, into the field with the keyboard.
    private func typeKeys(_ f: NSTextField, _ s: String) {
        window.makeFirstResponder(f)
        for ch in s {
            let c = String(ch)
            if let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                        context: nil, characters: c, charactersIgnoringModifiers: c, isARepeat: false, keyCode: c == " " ? 49 : 0) { window.sendEvent(e) }
        }
        settle(0.2)
    }
    /// A view's button clicked with the mouse, once it is on and in the window.
    private func press(_ b: NSView?) -> Bool {
        guard let b, wait(8, { b.window != nil && ((b as? NSButton)?.isEnabled ?? true) }) else { return false }
        click(b)
        return true
    }
    /// The hub's GET answer, waited for on the main loop.
    private func getJSON(_ path: String) -> [String: Any]? {
        var out: [String: Any]?
        var done = false
        board.hub.get(path) { code, j in out = code == 200 ? j : nil; done = true }
        _ = wait(10) { done }
        return out
    }
    private func idea(_ id: String) -> [String: Any]? { (getJSON("/api/ideas")?["ideas"] as? [[String: Any]])?.first { $0["id"] as? String == id } }

    func screenWrite() {
        guard let e = wenv else { check("write_env", false, "RAVENRY_MAC_WRITE"); return }
        writePanelGate(e)
        writeFileOnly(e)
        writeGateWords(e)
        writeChange(e)
        writeOwn(e)
        writeBrief(e)
        writeNote(e)
        writeIdea(e)
    }

    // MARK: PANEL-008: a project with no session, waiting at a gate

    private func writePanelGate(_ e: WriteEnv) {
        _ = wait(15) { self.gate("lighthouse") != nil }
        board.pickProject("lighthouse")
        let pn = board.panel
        check("w_panel_project_plan_card", wait(8) { pn.shows == "project" && pn.buttons["plan"]?.title == t("panel.openPlan") && pn.buttons["gate1"]?.title == "Cold blue" }
              && shows(pn, "Pick the beam colour") && shows(pn, t("panel.planGate")) && shows(pn, "Fit the lamp"), texts(pn).prefix(14).joined(separator: " | "))
        pictures("write-panel-gate")
        board.pickProject("lighthouse")
        _ = wait(5) { pn.buttons["gate1"]?.window != nil }
        let n = answers(e).count
        _ = press(pn.buttons["gate1"])
        let a = answer(e, "/api/plan/answer", after: n, 30)
        check("w_panel_gate_answer_2xx", ok2xx(a), said(a))
        check("w_panel_gate_answer_in_brief", wait(10) { self.brief(e, "lighthouse").contains("Answer: Cold blue") }, brief(e, "lighthouse").components(separatedBy: "## Plan").last ?? "")
        check("w_panel_gate_passed_on_hub", wait(15) { self.gate("lighthouse") == nil }, "\(gate("lighthouse") ?? [:])")
        board.pickProject("lighthouse")
        check("w_panel_plan_card_after", wait(8) { pn.buttons["gate0"] == nil && pn.buttons["plan"] != nil && self.shows(pn, t("panel.planRunning")) }, texts(pn).prefix(10).joined(separator: " | "))
    }

    // MARK: PLAN-003: a gate the file alone passed

    private func writeFileOnly(_ e: WriteEnv) {
        let pg = board.plan
        check("w_fileonly_arrives", arrival(1) && wait(20) { self.gate("harbour")?["fileOnly"] as? String == "ticked" }, "\(gate("harbour") ?? [:])")
        board.openPlan("harbour", title: nil)
        check("w_fileonly_drawn", wait(8) { self.shows(pg, t("plan.fileTicked")) } && pg.buttons["reopen"]?.title == t("plan.reopen") && pg.buttons["confirm"]?.title == t("plan.confirmPassed")
              && !shows(pg, t("plan.yourAnswer")) && pg.fields[pg.gateField]?.window == nil && shows(pg, "Your words: \"pick the wood\""), texts(pg).prefix(16).joined(separator: " | "))
        pictures("write-plan-fileonly")
        board.openPlan("harbour", title: nil)
        var n = answers(e).count
        _ = press(pg.buttons["reopen"])
        var a = answer(e, "/api/plan/reopen", after: n, 30)
        check("w_reopen_2xx", ok2xx(a), said(a))
        check("w_reopen_in_brief", wait(10) { self.brief(e, "harbour").contains("[?] Gate: Pick the wood") }, brief(e, "harbour").components(separatedBy: "## Plan").last ?? "")
        check("w_reopen_gate_open_on_hub", wait(15) { self.gate("harbour").map { self.null($0["fileOnly"]) } ?? false }, "\(gate("harbour") ?? [:])")
        // The agent ticks it again, in the file only: Confirm this time.
        check("w_fileonly_again", arrival(2) && wait(20) { self.gate("harbour")?["fileOnly"] as? String == "ticked" }, "\(gate("harbour") ?? [:])")
        board.openPlan("harbour", title: nil)
        _ = wait(8) { pg.buttons["confirm"]?.window != nil }
        n = answers(e).count
        _ = press(pg.buttons["confirm"])
        a = answer(e, "/api/plan/confirm", after: n, 20)
        check("w_confirm_2xx", ok2xx(a) && (a?.body.contains("\"confirmed\":\"ticked\"") ?? false), said(a))
        let ledger = file("\(e.mc)/plan-gates.json")
        check("w_confirm_in_ledger", wait(5) { self.file("\(e.mc)/plan-gates.json").contains("\"how\": \"confirmed\"") }, String(ledger.suffix(400)))
        check("w_confirm_plan_goes_on", wait(15) { self.gate("harbour") == nil }, "\(gate("harbour") ?? [:])")
    }

    // MARK: the gate's own words, typed (the audit: the field kept the last answer on the next question)

    private func writeGateWords(_ e: WriteEnv) {
        let pg = board.plan
        check("w_gate_asks", wait(10) { (self.gate("quay")?["question"] as? String)?.contains("first boat") == true && (self.gate("quay")?["choices"] as? [Any])?.isEmpty == true }, "\(gate("quay") ?? [:])")
        board.openPlan("quay", title: nil)
        _ = wait(8) { pg.fields[pg.gateField]?.window != nil }
        let first = pg.gateField
        guard let f = pg.fields[first] else { check("w_gate_field_shown", false, texts(pg).prefix(12).joined(separator: " | ")); return }
        typeKeys(f.field, "Sea Breeze")
        check("w_gate_typed_with_keys", f.text == "Sea Breeze", f.text)
        let n = answers(e).count
        _ = press(pg.buttons["send"])
        let a = answer(e, "/api/plan/answer", after: n, 30)
        check("w_gate_words_2xx", ok2xx(a) && (a?.body.contains("Sea Breeze") ?? false), said(a))
        check("w_gate_words_in_brief", wait(10) { self.brief(e, "quay").contains("Answer: \"Sea Breeze\"") }, brief(e, "quay").components(separatedBy: "## Plan").last ?? "")
        // The session reaches the next gate and marks it, as it would.
        let bf = "\(e.root)/quay/BRIEF.md"
        try? brief(e, "quay").replacingOccurrences(of: "- [ ] Do: Name the first boat", with: "- [x] Do: Name the first boat")
            .replacingOccurrences(of: "- [ ] Do: Name the second boat", with: "- [?] Do: Name the second boat\n  - Question: What is the second boat called?").write(toFile: bf, atomically: true, encoding: .utf8)
        check("w_gate_next_question", wait(15) { (self.gate("quay")?["question"] as? String)?.contains("second boat") == true }, "\(gate("quay") ?? [:])")
        board.openPlan("quay", title: nil)
        check("w_gate_next_field_empty", wait(8) { pg.gateField != first && pg.fields[pg.gateField]?.window != nil && self.shows(pg, "What is the second boat called?") }
              && pg.fields[pg.gateField]?.text == "" && !texts(pg).contains("Sea Breeze"), "\(pg.gateField): \"\(pg.fields[pg.gateField]?.text ?? "-")\"")
        pictures("write-plan-gate-next")
    }

    // MARK: PLAN-006: change a running plan

    private func writeChange(_ e: WriteEnv) {
        let pg = board.plan
        board.openPlan("beacon", title: nil)
        _ = wait(8) { pg.buttons["change"]?.window != nil }
        var n = answers(e).count
        _ = press(pg.buttons["change"])
        var a = answer(e, "/api/plan/change", after: n)
        check("w_change_2xx", ok2xx(a) && (a?.body.contains("\"mode\":\"change\"") ?? false), said(a))
        check("w_change_page", wait(8) { self.board.front == .page("newplan:beacon", t("panel.newPlan")) && pg.mode == .new && pg.draft?["mode"] as? String == "change" }
              && wait(5) { self.shows(pg, t("newplan.changeTitle")) && pg.buttons["start"]?.title == t("newplan.saveChanges") && self.shows(pg, t("newplan.locked")) }, "\(board.front) " + texts(pg).prefix(12).joined(separator: " | "))
        pictures("write-plan-change")
        board.openNewPlan("beacon")
        _ = wait(5) { pg.fields["chat"]?.window != nil }
        if let f = pg.fields["chat"] { typeKeys(f.field, "Add a fog test") }
        n = answers(e).count
        _ = press(pg.buttons["chat"])
        a = answer(e, "/api/plan/revise", after: n)
        check("w_change_revise_2xx", ok2xx(a), said(a))
        check("w_change_revised", wait(30) { (pg.draft?["steps"] as? [[String: Any]] ?? []).contains { $0["text"] as? String == "Add a fog test" } && self.null(pg.draft?["busy"]) }
              && wait(5) { self.shows(pg, "Add a fog test") && self.shows(pg, t("newplan.added")) }, texts(pg).prefix(20).joined(separator: " | "))
        n = answers(e).count
        _ = press(pg.buttons["start"])
        a = answer(e, "/api/plan/start", after: n, 30)
        check("w_change_saved_2xx", ok2xx(a), said(a))
        check("w_change_in_brief", wait(10) { self.brief(e, "beacon").contains("Add a fog test") }, brief(e, "beacon").components(separatedBy: "## Plan").last ?? "")
        check("w_change_back_on_plan", wait(8) { self.board.front == .page("plan:beacon", t("panel.plan")) }, "\(board.front)")
    }

    // MARK: PLAN-005: write your own plan, and revise it with a comment

    private func writeOwn(_ e: WriteEnv) {
        let pg = board.plan
        board.openNewPlan("sandbar")
        _ = wait(8) { pg.buttons["ownMode"]?.window != nil }
        _ = press(pg.buttons["ownMode"])
        check("w_own_mode", wait(5) { pg.own && pg.fields["own"]?.window != nil && pg.buttons["own"]?.title == t("newplan.turnIntoSteps") }, texts(pg).prefix(8).joined(separator: " | "))
        pictures("write-plan-own")
        board.openNewPlan("sandbar")
        _ = wait(5) { pg.fields["own"]?.window != nil }
        if let f = pg.fields["own"] { typeKeys(f.field, "Measure the sandbar at low tide, then draw the chart.") }
        var n = answers(e).count
        _ = press(pg.buttons["own"])
        var a = answer(e, "/api/plan/own", after: n)
        check("w_own_2xx", ok2xx(a) && (a?.body.contains("\"mode\":\"own\"") ?? false), said(a))
        check("w_own_steps", wait(30) { (pg.draft?["steps"] as? [[String: Any]] ?? []).count >= 3 } && wait(5) { self.shows(pg, "Measure the sandbar at low tide") && pg.buttons["start"] != nil },
              texts(pg).prefix(14).joined(separator: " | "))
        let first = (pg.draft?["steps"] as? [[String: Any]])?.first?["id"] as? String ?? ""
        _ = press(pg.buttons["comment:\(first)"])
        check("w_comment_opens", wait(5) { pg.commentFor == first && pg.fields["comment"]?.window != nil })
        if let f = pg.fields["comment"] { typeKeys(f.field, "Cover more games") }
        pictures("write-plan-comment")
        board.openNewPlan("sandbar")
        if pg.commentFor == nil { _ = press(pg.buttons["comment:\(first)"]); if let f = pg.fields["comment"], f.text.isEmpty { typeKeys(f.field, "Cover more games") } }
        n = answers(e).count
        _ = press(pg.buttons["commentAdd"])
        a = answer(e, "/api/plan/revise", after: n)
        check("w_comment_2xx", ok2xx(a), said(a))
        check("w_comment_revised", wait(30) { ((pg.draft?["steps"] as? [[String: Any]])?.first?["text"] as? String ?? "").contains("12 rhythm games") }
              && wait(5) { self.shows(pg, t("newplan.updated")) && self.shows(pg, "12 rhythm games") }, ((pg.draft?["steps"] as? [[String: Any]])?.first?["text"] as? String) ?? "")
        n = answers(e).count
        _ = press(pg.buttons["start"])
        a = answer(e, "/api/plan/start", after: n, 30)
        check("w_own_started_2xx", ok2xx(a), said(a))
        check("w_own_in_brief", wait(10) { self.brief(e, "sandbar").contains("Research how 12 rhythm games") }, String(brief(e, "sandbar").suffix(500)))
        check("w_own_plan_shown", wait(10) { self.board.front == .page("plan:sandbar", t("panel.plan")) && self.shows(pg, "Research how 12 rhythm games") }, "\(board.front)")
    }

    // MARK: BRIEF-006: write a brief for a project that has none

    private func writeBrief(_ e: WriteEnv) {
        board.pickProject("old-notes")
        let pp = board.projectPage
        check("w_project_page_write_brief", wait(10) { pp.buttons["writeBrief"]?.window != nil }, "\(pp.buttons.keys.sorted())")
        // The page draws again when the hub's last conversation comes: the button pressed is the one on screen then.
        settle(0.8)
        _ = press(pp.buttons["writeBrief"])
        if !wait(3, { self.board.front == .page("writebrief:old-notes", t("panel.writeBrief")) }) { _ = press(pp.buttons["writeBrief"]) }
        let np = board.newProject
        check("w_brief_form", wait(5) { self.board.front == .page("writebrief:old-notes", t("panel.writeBrief")) && np.briefFor?.id == "old-notes" }
              && shows(np, t("np.briefTitle", ["name": "old-notes"])) && !shows(np, t("np.name")) && shows(np, t("np.goal")) && np.buttons["go"]?.title == t("np.writeBrief"), texts(np).prefix(10).joined(separator: " | "))
        // The panel and Objectives open the same form.
        check("w_panel_write_brief", board.panel.buttons["writeBrief"] != nil, "\(board.panel.buttons.keys.sorted())")
        pictures("write-brief-form")
        board.openWriteBrief("old-notes")
        _ = wait(5) { np.fields["goal"]?.window != nil }
        if let f = np.fields["goal"] { typeKeys(f.field, "Keep the old notes searchable.") }
        if let f = np.fields["milestones"] { typeKeys(f.field, "Index the notes") }
        let n = answers(e).count
        _ = press(np.buttons["go"])
        let a = answer(e, "/api/project/brief", after: n)
        check("w_brief_2xx", ok2xx(a), said(a))
        let text = brief(e, "old-notes")
        check("w_brief_written", text.contains("Keep the old notes searchable.") && text.contains("Index the notes"), String(text.prefix(400)))
        check("w_brief_opens", wait(10) { if case .brief("old-notes", _) = self.board.front { return true }; return false }, "\(board.front)")
        check("w_brief_on_hub", wait(15) { self.board.hub.state?.project("old-notes")?.brief != nil })
    }

    // MARK: BRIEF-005: a note in a project's brief

    private func writeNote(_ e: WriteEnv) {
        board.openBrief("beacon")
        let bp = board.brief
        _ = wait(10) { bp.buttons["addNote"]?.window != nil && bp.shownText != nil }
        _ = press(bp.buttons["addNote"])
        check("w_note_bar", wait(5) { bp.noteOpen && bp.noteField.window != nil && !bp.noteField.isHidden }, "\(bp.noteOpen)")
        typeKeys(bp.noteField.field, "Check the wick holder")
        pictures("write-brief-note")
        board.openBrief("beacon")
        if !bp.noteOpen { _ = press(bp.buttons["addNote"]) }
        if bp.noteField.text.isEmpty { typeKeys(bp.noteField.field, "Check the wick holder") }
        let n = answers(e).count
        _ = press(bp.noteButtons["noteAdd"])
        let a = answer(e, "/api/note", after: n)
        check("w_note_2xx", ok2xx(a), said(a))
        check("w_note_in_brief", brief(e, "beacon").contains("- [ ] Check the wick holder (added "), String(brief(e, "beacon").prefix(300)))
        check("w_note_shown", wait(10) { (bp.shownText ?? "").contains("Check the wick holder") && !bp.noteOpen }, "\(bp.noteOpen)")
    }

    // MARK: IDEA-004 to IDEA-006: mockups, pictures, a project from an idea

    private func writeIdea(_ e: WriteEnv) {
        let pg = board.idea
        let iid = "demo-tidepool"
        board.openIdea(iid)
        _ = wait(10) { self.shows(pg, "A tide pool you look after") }
        pg.choosePictures = { _, done in done([URL(fileURLWithPath: e.picture)]) }
        // IDEA-005: a reference picture with the next message, then the idea's own picture.
        var n = answers(e).count
        _ = press(pg.buttons["attach"])
        var a = answer(e, "/api/ideas/\(iid)/ref", after: n)
        check("w_ref_2xx", ok2xx(a), said(a))
        check("w_ref_chip", wait(5) { pg.refs.count == 1 && pg.buttons["unref0"]?.window != nil }, "\(pg.refs.map(\.file))")
        let refFile = pg.refs.first?.file ?? "-"
        check("w_ref_file_saved", FileManager.default.fileExists(atPath: "\(e.mc)/pages/ideas/pictures/\(refFile)"), refFile)
        if let f = pg.fields["say"] { typeKeys(f.field, "Like this colour") }
        pictures("write-idea-ref")
        board.openIdea(iid)
        n = answers(e).count
        _ = press(pg.buttons["send"])
        a = answer(e, "/api/ideas/\(iid)/say", after: n)
        check("w_ref_sent_2xx", ok2xx(a) && (a?.body.contains("ok") ?? false), said(a))
        check("w_ref_in_thread", wait(15) { ((self.idea(iid)?["thread"] as? [[String: Any]]) ?? []).contains { $0["who"] as? String == "you" && $0["text"] as? String == "Like this colour" && ($0["images"] as? [String] ?? []).first?.contains(refFile) == true } }
              && pg.refs.isEmpty)
        n = answers(e).count
        _ = press(pg.buttons["setPicture"])
        a = answer(e, "/api/ideas/\(iid)/image", after: n)
        check("w_picture_2xx", ok2xx(a), said(a))
        let img = idea(iid)?["img"] as? String
        check("w_picture_on_idea", img != nil && FileManager.default.fileExists(atPath: "\(e.mc)/pages/ideas/pictures/\((img ?? "").components(separatedBy: "/").last?.removingPercentEncoding ?? "")"), img ?? "none")

        // IDEA-004: a round drawn, a variant picked; a round stopped.
        _ = wait(20) { self.null(self.idea(iid)?["pending"]) }
        n = answers(e).count
        _ = press(pg.buttons["mockup"])
        a = answer(e, "/api/ideas/\(iid)/mockups", after: n)
        check("w_round_2xx", ok2xx(a), said(a))
        var rounds: [[String: Any]] = []
        let came = wait(90) {
            let m = self.idea(iid)?["mockups"] as? [String: Any]
            rounds = m?["rounds"] as? [[String: Any]] ?? []
            return !rounds.isEmpty || m?["error"] is [String: Any]
        }
        check("w_round_drawn", came && rounds.count == 1, "\((idea(iid)?["mockups"] as? [String: Any])?["error"] ?? rounds.count)")
        if !rounds.isEmpty {
            check("w_round_shown", wait(10) { pg.thumbs.count == 3 && pg.buttons["mkPick"]?.window != nil && self.shows(pg, t("idea.mockups")) }, texts(pg).prefix(12).joined(separator: " | "))
            _ = wait(6) { pg.thumbs.allSatisfy { $0.pic.image != nil } }
            if pg.thumbs.count == 3 { click(pg.thumbs[1]) }
            check("w_round_variant_viewed", wait(5) { pg.mkView == 1 && self.shows(pg, "B. ") }, "\(pg.mkView ?? -1)")
            pictures("write-idea-mockups")
            board.openIdea(iid)
            if pg.mkView != 1, pg.thumbs.count == 3 { click(pg.thumbs[1]) }
            n = answers(e).count
            _ = press(pg.buttons["mkPick"])
            a = answer(e, "/api/ideas/\(iid)/mockups/pick", after: n)
            check("w_pick_2xx", ok2xx(a) && (a?.status == 200), said(a))
            check("w_pick_on_idea", wait(10) { (self.idea(iid)?["img"] as? String ?? "").contains("mockups%2Fr1-b.png") && ((self.idea(iid)?["mockups"] as? [String: Any])?["rounds"] as? [[String: Any]])?.first?["picked"] as? String == "b" },
                  idea(iid)?["img"] as? String ?? "")
            check("w_pick_shown", wait(8) { pg.buttons["mkPick"]?.title == t("idea.picked") })
            // A round that takes long (the stand-in's SLOW), stopped.
            if let f = pg.fields["mkNote"] { typeKeys(f.field, "SLOW and darker") }
            n = answers(e).count
            _ = press(pg.buttons["mkAgain"])
            a = answer(e, "/api/ideas/\(iid)/mockups", after: n)
            check("w_round2_2xx", ok2xx(a) && (a?.body.contains("\"round\":2") ?? false), said(a))
            check("w_round2_drawing", wait(10) { pg.buttons["mkStop"]?.window != nil && self.shows(pg, "SLOW and darker") }, texts(pg).prefix(10).joined(separator: " | "))
            pictures("write-idea-drawing")
            board.openIdea(iid)
            n = answers(e).count
            _ = press(pg.buttons["mkStop"])
            a = answer(e, "/api/ideas/\(iid)/mockups/stop", after: n)
            check("w_stop_2xx", ok2xx(a) && (a?.body.contains("\"stopped\":true") ?? false), said(a))
            check("w_stop_on_hub", wait(10) { self.null((self.idea(iid)?["mockups"] as? [String: Any])?["job"]) }, "\(idea(iid)?["mockups"] ?? "")")
        }

        // IDEA-006: greenlit, then Promote to project.
        _ = wait(10) { pg.busy.isEmpty }
        _ = press(pg.buttons["greenlight"])
        check("w_promote_shown", wait(10) { pg.buttons["promote"]?.window != nil }, texts(pg).suffix(6).joined(separator: " | "))
        _ = press(pg.buttons["promote"])
        let np = board.newProject
        check("w_promote_form", wait(5) { self.board.front == .page("promote:\(iid)", t("np.title")) && np.ideaId == iid } && np.fields["name"]?.text == "A tide pool you look after"
              && (np.fields["goal"]?.text ?? "").hasPrefix("A small screen of rock pool") && shows(np, t("np.fromIdea", ["name": "A tide pool you look after"])), texts(np).prefix(8).joined(separator: " | "))
        pictures("write-idea-promote")
        board.openPromote(iid, name: "A tide pool you look after", pitch: np.fields["goal"]?.text ?? "")
        let n2 = answers(e).count
        _ = press(np.buttons["go"])
        let a2 = answer(e, "/api/project/new", after: n2, 30)
        check("w_promote_2xx", ok2xx(a2) && (answers(e).dropFirst(n2).first { $0["u"] as? String == "/api/project/new" }?["req"] as? String ?? "").contains("\"ideaId\":\"\(iid)\""), said(a2))
        let pb = brief(e, "a-tide-pool-you-look-after")
        check("w_promote_brief", pb.contains("A small screen of rock pool") && pb.contains("Greenlit"), String(pb.prefix(300)))
        check("w_promote_registry", file("\(e.mc)/projects.json").contains("\"fromIdea\": \"\(iid)\""))
        check("w_promote_idea_archived", wait(10) { self.idea(iid) == nil })
    }
}
