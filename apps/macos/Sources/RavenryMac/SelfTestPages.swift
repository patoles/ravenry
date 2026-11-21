// The self-test of the pages with words and fields (FormPage): a plan, a
// new plan, an idea, Alerts, the pages from files and Decisions, one at a
// time (scripts/sidetest.mjs --screen NAME), on the demo hub. Each control
// is pressed as the person would (performClick, a mouse press) and what
// the hub was sent, the page shows or the toast says is read back.

import AppKit

extension SelfTestBoard {
    /// Every piece of text a view shows (labels, buttons, fields), in order.
    func texts(_ v: NSView) -> [String] {
        var out: [String] = []
        func walk(_ x: NSView) {
            if x.isHidden { return }
            if let b = x as? NSButton, !b.title.isEmpty { out.append(b.title) }
            else if let f = x as? NSTextField, !f.stringValue.isEmpty { out.append(f.stringValue) }
            else if let tv = x as? NSTextView, !tv.string.isEmpty, !tv.isFieldEditor { out.append(tv.string) }
            for s in x.subviews { walk(s) }
        }
        walk(v)
        return out
    }
    func shows(_ v: NSView, _ s: String) -> Bool { texts(v).contains { $0.contains(s) } }
    /// The toasts since `n` log lines.
    func toasts(since n: Int) -> [String] { board.log.dropFirst(n).filter { $0.hasPrefix("toast ") }.map { String($0.dropFirst(6)) } }
    func sentSince(_ n: Int) -> [String] { Array(board.hub.sent.dropFirst(n)) }
    /// Types into a page's field as the keyboard would.
    func typeIn(_ f: FieldBox, _ s: String) {
        window.makeFirstResponder(f.field)
        f.field.currentEditor()?.insertText(s)
        settle(0.1)
    }

    // MARK: a plan and a new plan (PLAN-001 to PLAN-004)

    func screenPlan() {
        let pg = board.plan
        let k1 = "garden-planner/sf-1"
        if let r = board.sidebar.rows[k1] { click(r) }
        _ = wait(3) { self.board.panel.buttons["plan"] != nil }
        board.panel.buttons["plan"]?.performClick(nil)
        check("plan_opens_from_panel", board.front == .page("plan:garden-planner", t("panel.plan")) && board.root.middle === pg && board.root.wideMiddle, "\(board.front)")
        check("plan_from_hub_list", (board.hub.state?.project("garden-planner")?.raw["planPages"] as? [[String: Any]])?.first?["running"] as? Bool == true)
        check("plan_drawn", shows(pg, "Send the first reminders") && shows(pg, "Running") && shows(pg, "1 of 3 done") && shows(pg, "Started 2026-11-07 10:00"), texts(pg).prefix(8).joined(separator: " | "))
        check("plan_steps_and_proof", shows(pg, "Do: Work out each bed's sowing window") && shows(pg, "Proof: windows.json has 12 beds") && shows(pg, "Gate: Pick when the first reminder goes out"))
        check("plan_goal", shows(pg, "\"Send each bed's first reminder at the right time\""))
        pictures("plan")
        var n = board.hub.sent.count
        pg.buttons["pause"]?.performClick(nil)
        check("plan_pause_posts", wait(3) { self.sentSince(n).contains("POST /api/plan/pause") }, sentSince(n).joined(separator: ","))
        check("plan_paused_shows_resume", wait(10) { self.board.render(); return pg.buttons["resume"] != nil && self.shows(pg, "Paused") }, texts(pg).prefix(6).joined(separator: " | "))
        n = board.hub.sent.count
        pg.buttons["resume"]?.performClick(nil)
        check("plan_resume_posts", wait(3) { self.sentSince(n).contains("POST /api/plan/resume") })
        _ = wait(10) { self.board.render(); return pg.buttons["pause"] != nil }
        pg.buttons["openBrief"]?.performClick(nil)
        check("plan_open_in_brief", board.front == .brief("garden-planner", k1) || { if case .brief("garden-planner", _) = board.front { return true }; return false }(), "\(board.front)")
        board.openPlan("garden-planner", title: nil)
        pg.buttons["showSession"]?.performClick(nil)
        check("plan_show_its_session", board.front == .session(k1) || (board.front == .tab && board.frontKey == k1), "\(board.front)")

        // A gate with choices, a gate with a field, a plan of the brief, an older hub: drawn from shapes as the hub sends them.
        let steps: [[String: Any]] = [["kind": "do", "text": "A", "state": "done", "proofs": [["text": "a.txt"]]], ["kind": "gate", "text": "Pick", "state": "todo", "proofs": []]]
        let gp: [String: Any] = ["id": "garden-planner", "name": "garden-planner", "sessions": [],
                                 "planGate": ["question": "Which day?", "choices": ["Monday", "Friday"]],
                                 "planPages": [["title": "Gated", "running": true, "plan": ["title": "Gated", "state": "gate", "steps": steps]],
                                               ["title": "Old one", "running": false, "plan": ["title": "Old one", "state": "done", "steps": [["kind": "do", "text": "Z", "state": "done", "proofs": []]]]]]]
        let fake = HubState(["projects": [gp]])
        board.openPlan("garden-planner", title: nil)
        pg.holdState = true
        pg.show("garden-planner", mode: .plan, state: fake)
        check("plan_gate_choices", shows(pg, "It waits for you") && shows(pg, "Which day?") && pg.buttons["choice1"]?.title == "Friday" && shows(pg, "At a gate") && pg.buttons["pause"] == nil, texts(pg).prefix(8).joined(separator: " | "))
        check("plan_no_session_no_button", pg.buttons["showSession"] == nil)
        pictures("plan-gate")
        pg.holdState = false
        // A real gate: the session reached it and marked it [?] in the brief, as a session
        // does; the page draws it from the hub, and a choice pressed is the hub's 200 and
        // written under the gate.
        let brief = URL(fileURLWithPath: (board.hub.state?.project("garden-planner")?.folder ?? "/nowhere") + "/BRIEF.md")
        let read = { (try? String(contentsOf: brief, encoding: .utf8)) ?? "" }
        let write = { (s: String) in try? s.write(to: brief, atomically: true, encoding: .utf8) }
        write(read().replacingOccurrences(of: "- [ ] Do: Write the reminder text", with: "- [x] Do: Write the reminder text")
                    .replacingOccurrences(of: "- [ ] Gate: Pick when the first reminder goes out", with: "- [?] Gate: Pick when the first reminder goes out"))
        pg.show("garden-planner", mode: .plan, state: board.hub.state)
        check("plan_real_gate_drawn", wait(10) { self.board.render(); return pg.buttons["choice1"]?.title == "On the first frost-free day" } && shows(pg, "Pick when the first reminder goes out"),
              texts(pg).prefix(10).joined(separator: " | "))
        n = board.hub.sent.count
        pg.buttons["choice1"]?.performClick(nil)
        check("plan_choice_posts", wait(3) { self.sentSince(n).contains("POST /api/plan/answer") })
        _ = wait(3) { pg.busy.isEmpty }
        check("plan_choice_in_brief", wait(3) { read().contains("- [x] Gate: Pick when the first reminder goes out") && read().contains("Answer: On the first frost-free day") },
              read().components(separatedBy: "\n").filter { $0.contains("Gate") || $0.contains("Answer") }.joined(separator: " / "))
        // A question with no choices: its own field. The session stops at a step to ask
        // (a gate with no Choices line gets Go ahead and Not yet from the hub, so a field is a step's
        // Question). After the plan's last step, before its Log (the hub keeps the log after the steps).
        let second = "- [?] Do: Send the second reminder\n  - Question: Say when the second reminder goes out\n"
        let had = read()
        write(had.contains("\n\nLog:\n") ? had.replacingOccurrences(of: "\n\nLog:\n", with: "\n" + second + "\nLog:\n") : had + (had.hasSuffix("\n") ? "" : "\n") + second)
        _ = wait(10) { self.board.render(); return pg.buttons["send"] != nil }
        let L = board.log.count
        pg.buttons["send"]?.performClick(nil)
        let gf = pg.gateField
        check("plan_gate_field_needs_words", gf.contains("Say when the second reminder goes out") && toasts(since: L).last == t("plan.typeAnswer") && window.firstResponder === pg.fields[gf]?.field.currentEditor(),
              "field \(gf); " + toasts(since: L).joined(separator: ","))
        if let f = pg.fields[gf] { typeIn(f, "Next Monday") }
        // What is typed stays through the hub's redraws.
        pg.refresh(board.hub.state); pg.dirty(); pg.redraw()
        check("plan_typed_kept", pg.fields[gf]?.text == "Next Monday" && pg.fields[gf]?.window != nil)
        n = board.hub.sent.count
        pg.buttons["send"]?.performClick(nil)
        check("plan_gate_field_posts", wait(3) { self.sentSince(n).contains("POST /api/plan/answer") })
        _ = wait(3) { pg.busy.isEmpty }
        // Answered, the step runs again with it (writeAnswer: its mark back to [ ]).
        check("plan_field_in_brief", wait(3) { read().contains("- [ ] Do: Send the second reminder") && read().contains("Answer: \"Next Monday\"") },
              read().components(separatedBy: "\n").filter { $0.contains("second") || $0.contains("Answer") }.joined(separator: " / "))
        // Stop the plan (PLAN-007): asked first, Cancel posts nothing; Stop the plan is the hub's 200 and the brief reads stopped.
        _ = wait(10) { self.board.render(); return pg.buttons["stop"] != nil }
        n = board.hub.sent.count
        pg.buttons["stop"]?.performClick(nil)
        check("plan_stop_asks_first", wait(3) { pg.buttons["stopYes"] != nil } && shows(pg, "Its session finishes the step in hand and starts no other.") && sentSince(n).isEmpty, texts(pg).suffix(6).joined(separator: " | "))
        pictures("plan-stop")
        pg.buttons["stopNo"]?.performClick(nil)
        check("plan_stop_cancel_posts_nothing", wait(3) { pg.buttons["stopYes"] == nil } && sentSince(n).isEmpty && !read().contains("State: stopped"))
        pg.buttons["stop"]?.performClick(nil)
        _ = wait(3) { pg.buttons["stopYes"] != nil }
        let L3 = board.log.count
        pg.buttons["stopYes"]?.performClick(nil)
        check("plan_stop_posts", wait(5) { self.board.hub.answers.contains { $0.seq >= n && $0.path == "/api/plan/stop" && $0.code == 200 } }, sentSince(n).joined(separator: ","))
        check("plan_stop_in_brief", wait(5) { read().contains("State: stopped") && read().contains("Stopped at step") }, read().components(separatedBy: "\n").filter { $0.contains("State") || $0.contains("Stopped") }.joined(separator: " / "))
        check("plan_stopped_shown", wait(10) { self.board.render(); return self.shows(pg, "Stopped") && pg.buttons["stop"] == nil && pg.buttons["pause"] == nil } && toasts(since: L3).contains { $0.hasPrefix(t("plan.stopped")) },
              texts(pg).prefix(4).joined(separator: " | ") + " toasts " + toasts(since: L3).joined(separator: ","))
        pg.holdState = true
        pg.show("garden-planner", mode: .plan, title: "Old one", state: fake)
        check("plan_of_the_brief_by_title", shows(pg, "Old one") && shows(pg, "Done") && pg.buttons["pause"] == nil && !shows(pg, "It waits for you"), texts(pg).prefix(5).joined(separator: " | "))
        let older = HubState(["projects": [["id": "garden-planner", "name": "garden-planner", "sessions": [], "plan": ["title": "Older hub", "state": "running", "steps": steps]]]])
        pg.show("garden-planner", mode: .plan, state: older)
        check("plan_older_hub", shows(pg, "Older hub") && pg.buttons["pause"] != nil)
        pg.show("garden-planner", mode: .plan, title: "Nowhere", state: fake)
        check("plan_gone", shows(pg, t("plan.gone")) && shows(pg, t("plan.openBrief")))
        pg.holdState = false

        // A new plan: the brief's goal, the field, a draft from the stub, its questions, Discard.
        board.openPage("newplan:paper-boat", t("panel.newPlan"))
        check("newplan_opens", board.front == .page("newplan:paper-boat", t("panel.newPlan")) && pg.mode == .new && board.root.middle === pg)
        check("newplan_drawn", wait(5) { pg.draftFor == "paper-boat" } && shows(pg, "What it should get done") && shows(pg, "it starts from its goal"), texts(pg).prefix(8).joined(separator: " | "))
        pictures("newplan")
        let L2 = board.log.count
        pg.buttons["draft"]?.performClick(nil)
        check("newplan_needs_goal", toasts(since: L2).last == t("newplan.sayFirst"))
        if let f = pg.fields["goal"] { typeIn(f, "Make the boat tilt with the street") }
        n = board.hub.sent.count
        pg.buttons["draft"]?.performClick(nil)
        check("newplan_draft_posts", wait(3) { self.sentSince(n).contains("POST /api/plan/draft") })
        check("newplan_draft_shown", wait(30) { pg.buttons["start"] != nil && pg.buttons["discard"] != nil }, texts(pg).prefix(8).joined(separator: " | "))
        check("newplan_questions", shows(pg, t("newplan.question")) && pg.buttons["q0o0"] != nil && pg.buttons["start"]?.isEnabled == false && shows(pg, t("newplan.answerFirst")), texts(pg).joined(separator: " | ").prefix(300).description)
        pictures("newplan-draft")
        n = board.hub.sent.count
        pg.buttons["q0o0"]?.performClick(nil)
        check("newplan_answer_posts", wait(3) { self.sentSince(n).contains("POST /api/plan/edit") })
        _ = wait(5) { pg.busy.isEmpty && (pg.buttons["q0o0"]?.accessibilityValue() as? Bool) == true }
        check("newplan_answer_shown", (pg.buttons["q0o0"]?.accessibilityValue() as? Bool) == true)
        n = board.hub.sent.count
        pg.buttons["discard"]?.performClick(nil)
        check("newplan_discard", wait(3) { self.sentSince(n).contains("POST /api/plan/discard") } && wait(5) { pg.buttons["draft"]?.window != nil && pg.buttons["start"]?.window == nil })
        pg.buttons["cancel"]?.performClick(nil)
        // Back where it was opened from (the plan in front before it; Board's back stack).
        check("newplan_cancel_goes_back", board.front != .page("newplan:paper-boat", t("panel.newPlan")) && pg.mode != .new, "\(board.front)")
    }

    // MARK: an idea's thread (IDEA-003)

    func screenIdea() {
        let pg = board.idea
        board.openPage("idea:demo-tidepool", t("idea.ideas"))
        check("idea_opens", board.front == .page("idea:demo-tidepool", t("idea.ideas")) && board.root.middle === pg && board.root.wideMiddle, "\(board.front)")
        check("idea_read_from_hub", wait(5) { pg.ideas != nil } && board.hub.sent.isEmpty == board.hub.sent.isEmpty)
        check("idea_drawn", wait(3) { self.shows(pg, "A tide pool you look after") } && shows(pg, "Spark") && shows(pg, "A small screen of rock pool") && shows(pg, "Would this work as a phone widget?") && shows(pg, "It stays calm because nothing is urgent."), texts(pg).prefix(8).joined(separator: " | "))
        check("idea_who_and_when", texts(pg).contains { $0.hasPrefix("You, today, ") } && texts(pg).contains { $0.hasPrefix("Claude, today, ") }, texts(pg).filter { $0.contains("today") }.joined(separator: ","))
        pictures("idea")
        let L = board.log.count
        pg.buttons["send"]?.performClick(nil)
        check("idea_send_needs_words", toasts(since: L).last == t("idea.typeReply"))
        if let f = pg.fields["say"] { typeIn(f, "Could the creature be a hermit crab?") }
        pg.dirty(); pg.redraw()
        check("idea_typed_kept", pg.fields["say"]?.text == "Could the creature be a hermit crab?")
        var n = board.hub.sent.count
        pg.buttons["send"]?.performClick(nil)
        check("idea_send_posts", wait(3) { self.sentSince(n).contains("POST /api/ideas/demo-tidepool/say") } && wait(20) { pg.fields["say"]?.text == "" }, sentSince(n).joined(separator: ","))
        check("idea_reply_in_thread", wait(20) { self.shows(pg, "Could the creature be a hermit crab?") }, texts(pg).suffix(8).joined(separator: " | "))
        n = board.hub.sent.count
        _ = wait(20) { pg.busy.isEmpty }
        pg.buttons["greenlight"]?.performClick(nil)
        check("idea_greenlight", wait(3) { self.sentSince(n).contains("POST /api/ideas/demo-tidepool/update") } && wait(6) { self.shows(pg, "Greenlit") && pg.buttons["greenlight"] == nil }, texts(pg).prefix(4).joined(separator: " | "))
        n = board.hub.sent.count
        _ = wait(20) { pg.busy.isEmpty }
        pg.buttons["park"]?.performClick(nil)
        check("idea_park", wait(3) { self.sentSince(n).contains("POST /api/ideas/demo-tidepool/update") } && wait(6) { self.shows(pg, "Parked") && pg.buttons["park"] == nil && pg.buttons["greenlight"] != nil })
        n = board.hub.sent.count
        let L2 = board.log.count
        _ = wait(20) { pg.busy.isEmpty }
        pg.buttons["mockup"]?.performClick(nil)
        check("idea_mockup_round", wait(3) { self.sentSince(n).contains("POST /api/ideas/demo-tidepool/mockups") } && wait(5) { !self.toasts(since: L2).isEmpty }, toasts(since: L2).joined(separator: ","))
        pictures("idea-after")
        // Pictures dropped and pasted, and Kill (SelfTestIdeaPics.swift).
        ideaPicturesAndKill(pg)
        board.openIdea("nowhere")
        check("idea_gone", wait(3) { self.shows(pg, t("idea.gone")) })
        pg.buttons["back"]?.performClick(nil)
        check("idea_back_to_ideas", { if case .page(let k, _) = board.front { return k != "idea:nowhere" }; return false }(), "\(board.front)")
    }

    // MARK: Alerts and Mac notifications (ALERT rows)

    /// ALERT-014: ntfy on a server of your own (sidetest's stand-in on 127.0.0.1, RAVENRY_MAC_NTFY_SERVER).
    /// Save with nothing typed says what goes in; the address typed and Save is the hub's 200, the line
    /// and the code name it; Use it, then Send a test: the server gets the alert on the topic.
    private func alertsOwnNtfy(_ pg: AlertsPage) {
        let env = ProcessInfo.processInfo.environment
        guard let srv = env["RAVENRY_MAC_NTFY_SERVER"], let logPath = env["RAVENRY_MAC_NTFY_LOG"] else { check("alerts_ntfy_server_env", false, "no stand-in server"); return }
        _ = wait(5) { pg.busy.isEmpty }
        if pg.open != "ntfy" { pg.buttons["ntfy-toggle"]?.performClick(nil) }
        let qr0 = (pg.setup?["ntfy"] as? [String: Any])?["qr"] as? String
        var L = board.log.count
        pg.buttons["save-nt"]?.performClick(nil)
        check("alerts_ntfy_server_needed", toasts(since: L).last == t("alerts.ntfyServerFirst"), toasts(since: L).joined(separator: ","))
        if let f = pg.fields["nt"] { typeIn(f, srv) }
        var n = board.hub.sent.count
        L = board.log.count
        pg.buttons["save-nt"]?.performClick(nil)
        let ntfy = { pg.setup?["ntfy"] as? [String: Any] ?? [:] }
        check("alerts_ntfy_server_saved", wait(5) { self.sentSince(n).contains("POST /api/alerts/ntfy") && self.toasts(since: L).contains(t("alerts.ntfyServerSaved", ["server": srv])) }
              && wait(6) { ntfy()["server"] as? String == srv && self.texts(pg).contains { $0.contains("on \(srv)") } } && ntfy()["qr"] as? String != qr0,
              "\(sentSince(n)) \(toasts(since: L)) \(ntfy()["server"] ?? "nil")")
        pictures("alerts-ntfy-server")
        _ = wait(5) { pg.busy.isEmpty }
        n = board.hub.sent.count
        pg.buttons["ntfy-use"]?.performClick(nil)
        check("alerts_ntfy_own_in_use", wait(6) { self.sentSince(n).contains("POST /api/alerts/done") && pg.buttons["ntfy-test"] != nil }, "\(sentSince(n))")
        _ = wait(5) { pg.busy.isEmpty }
        L = board.log.count
        n = board.hub.sent.count
        pg.buttons["ntfy-test"]?.performClick(nil)
        let got = { () -> [[String: Any]] in
            ((try? String(contentsOfFile: logPath, encoding: .utf8)) ?? "").split(separator: "\n").compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
        }
        let body = { () -> [String: Any] in (got().last?["body"] as? String).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] } ?? [:] }
        check("alerts_ntfy_test_reaches_own_server", wait(10) { (body()["topic"] as? String ?? "").count >= 8 && got().last?["method"] as? String == "POST" } && wait(5) { self.toasts(since: L).contains(t("alerts.testSent")) },
              "\(got()) \(toasts(since: L))")
        // Turned off again, so the rest of the screen starts from no channel.
        _ = wait(5) { pg.busy.isEmpty }
        pg.buttons["ntfy-use"]?.performClick(nil)
        _ = wait(6) { pg.buttons["ntfy-use"]?.title == t("alerts.useIt") }
    }

    /// The iPhone app's rows (docs/PHONE.md section 4, the fixture in scripts/sidetest.mjs): moved from ntfy
    /// ("Moved from ntfy today, ..."); Apple says the app is gone ("No alerts: ...") with Use ntfy again, which
    /// posts its route and makes it a row through ntfy (then Remove forgets it), and with Remove alone when
    /// there is no ntfy topic to go back to, which signs it out. Neither gone row has Send a test.
    private func alertsAppRows(_ pg: AlertsPage) {
        let phones = { pg.setup?["phones"] as? [[String: Any]] ?? [] }
        let row = { (id: String) in phones().first { $0["id"] as? String == id } }
        _ = wait(6) { row("dgone01") != nil && pg.busy.isEmpty }
        let moved = When.day(row("dmoved1")?["moved"] as? String) ?? "?"
        check("alerts_app_moved_row", wait(6) { self.shows(pg, "Work iPhone") && self.texts(pg).contains(t("alerts.movedFromNtfy", ["when": moved])) } && pg.buttons["phoneTest-dmoved1"] != nil && pg.buttons["remove-dmoved1"] == nil,
              texts(pg).filter { $0.contains("Moved") || $0.contains("Gets") }.joined(separator: " | "))
        check("alerts_app_gone_rows", texts(pg).contains(t("alerts.appGone", ["device": "iPad"])) && texts(pg).contains(t("alerts.appGone", ["device": "iPhone"]))
              && pg.buttons["ntfyAgain-dgone01"]?.title == t("alerts.ntfyAgain") && pg.buttons["remove-dgone01"] != nil && pg.buttons["phoneTest-dgone01"] == nil
              && pg.buttons["ntfyAgain-dgone02"] == nil && pg.buttons["remove-dgone02"] != nil && pg.buttons["phoneTest-dgone02"] == nil,
              texts(pg).filter { $0.hasPrefix("No alerts") }.joined(separator: " | "))
        pictures("alerts-app-rows")
        var n = board.hub.sent.count
        var L = board.log.count
        pg.buttons["ntfyAgain-dgone01"]?.performClick(nil)
        check("alerts_app_ntfy_again", wait(5) { self.sentSince(n).contains("POST /api/alerts/phone/ntfy-again") && self.toasts(since: L).contains(t("alerts.ntfyAgainDone", ["name": "iPad"])) }
              && wait(6) { row("dgone01")?["transport"] as? String == "ntfy" && pg.buttons["ntfyAgain-dgone01"]?.window == nil && pg.buttons["remove-dgone01"] != nil },
              "\(sentSince(n)) \(toasts(since: L)) \(row("dgone01") ?? [:])")
        _ = wait(5) { pg.busy.isEmpty }
        n = board.hub.sent.count
        pg.buttons["remove-dgone01"]?.performClick(nil)
        check("alerts_app_ntfy_again_then_remove", wait(5) { self.sentSince(n).contains("POST /api/alerts/iphone/remove") } && wait(6) { row("dgone01") == nil && !self.shows(pg, "iPad") }, "\(sentSince(n))")
        _ = wait(5) { pg.busy.isEmpty }
        n = board.hub.sent.count
        L = board.log.count
        pg.buttons["remove-dgone02"]?.performClick(nil)
        check("alerts_app_gone_remove_signs_out", wait(5) { self.sentSince(n).contains("POST /api/phone/devices/revoke") && self.toasts(since: L).contains(t("alerts.removedApp", ["name": "Old iPhone"])) } && wait(6) { row("dgone02") == nil },
              "\(sentSince(n)) \(toasts(since: L))")
        _ = wait(5) { pg.busy.isEmpty }
    }

    /// Phones (docs/PHONE.md section 4): the Pixel the board knows as a row, Add an iPhone's setup
    /// (the steps, the QR while phone access is on), Copy the code instead, then Send a test and It
    /// arrived from here: each posts the hub's route, the stand-in ntfy gets the test on the
    /// iPhone's own topic, and the iPhone's row comes; its Send a test and Remove.
    private func alertsPhones(_ pg: AlertsPage) {
        let env = ProcessInfo.processInfo.environment
        let logPath = env["RAVENRY_MAC_NTFY_LOG"] ?? ""
        let got = { () -> [[String: Any]] in
            ((try? String(contentsOfFile: logPath, encoding: .utf8)) ?? "").split(separator: "\n").compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
                .compactMap { ($0["body"] as? String).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] } }
        }
        let phones = { pg.setup?["phones"] as? [[String: Any]] ?? [] }
        _ = wait(5) { pg.busy.isEmpty }
        if pg.open != nil { pg.buttons["\(pg.open!)-toggle"]?.performClick(nil) }
        check("alerts_phones_card", wait(6) { self.shows(pg, t("alerts.phones")) && self.shows(pg, "Pixel 8") && self.shows(pg, "· " + t("alerts.viaApp")) && self.shows(pg, t("alerts.phonesLine")) }
              && pg.buttons["pair"]?.title == t("alerts.pairAndroid") && pg.buttons["addIphone"]?.title == t("alerts.addIphone") && shows(pg, t("alerts.oneWay")), texts(pg).prefix(14).joined(separator: " | "))
        let pixel = phones().first { $0["name"] as? String == "Pixel 8" }?["id"] as? String ?? ""
        var n = board.hub.sent.count
        var L = board.log.count
        pg.buttons["phoneTest-\(pixel)"]?.performClick(nil)
        check("alerts_phone_test_android", !pixel.isEmpty && wait(5) { self.sentSince(n).contains("POST /api/alerts/phone/test") && self.toasts(since: L).contains(t("alerts.phoneTestSent", ["name": "Pixel 8"])) }, "\(sentSince(n)) \(toasts(since: L))")
        _ = wait(5) { pg.busy.isEmpty }
        pg.buttons["addIphone"]?.performClick(nil)
        let qrShown = { () -> Bool in var found = false; func walk(_ v: NSView) { if (v as? NSImageView)?.image != nil, v.accessibilityLabel() == t("alerts.iphoneQr") { found = true }; v.subviews.forEach(walk) }; walk(pg); return found }
        let access = (pg.setup?["iphone"] as? [String: Any])?["access"] as? Bool == true
        check("alerts_add_iphone_opens", pg.iphoneOpen && pg.buttons["addIphone"]?.title == t("alerts.close") && shows(pg, t("alerts.iphoneTitle")) && shows(pg, t("alerts.iphoneStore")) && shows(pg, t("alerts.iphoneNtfyLead")) && shows(pg, t("alerts.iphoneQrCap"))
              && pg.buttons["iphoneCopy"] != nil && texts(pg).contains { $0.hasPrefix("What the iPhone gets:") && $0.contains("unencrypted") }, texts(pg).prefix(24).joined(separator: " | "))
        check("alerts_add_iphone_qr", access && wait(3) { qrShown() }, "access \(access)")
        // The Ravenry app first (ALERT-016): its App Store page's code reads back as the page's address
        // (shared strings alerts.appStoreUrl), with the words; its link opens that page in the browser.
        let storeUrl = t("alerts.appStoreUrl")
        let storeImg = { () -> NSImage? in var img: NSImage?; func walk(_ v: NSView) { if let iv = v as? NSImageView, iv.accessibilityLabel() == t("alerts.iphoneStoreQr") { img = iv.image }; v.subviews.forEach(walk) }; walk(pg); return img }
        var storeRead = ""
        check("alerts_iphone_store_qr", storeUrl.hasPrefix("https://apps.apple.com/app/id") && wait(3) { storeRead = storeImg().flatMap { self.qrText($0) } ?? ""; return storeRead == storeUrl }
              && shows(pg, t("alerts.iphoneStoreCap")), "read \(storeRead)")
        let o = Outside.record?.count ?? 0
        let storeLink = pg.buttons["iphoneStore"]
        storeLink?.performClick(nil)
        let opened = Array((Outside.record ?? []).dropFirst(o))
        check("alerts_iphone_store_link", storeLink?.title == t("alerts.iphoneStoreLink") && storeLink?.external == true && opened == ["open \(storeUrl)"], "\(opened)")
        pictures("alerts-iphone-setup")
        _ = wait(5) { pg.busy.isEmpty }
        n = board.hub.sent.count
        L = board.log.count
        pg.buttons["iphoneCopy"]?.performClick(nil)
        check("alerts_iphone_copy", wait(5) { self.sentSince(n).contains("POST /api/alerts/iphone/copy") && self.toasts(since: L).contains(t("alerts.iphoneCopied")) }
              && wait(6) { pg.buttons["iphoneTest"] != nil && pg.buttons["iphoneArrived"] != nil && self.shows(pg, t("alerts.iphoneThen")) }, "\(sentSince(n)) \(toasts(since: L))")
        pictures("alerts-iphone-copied")
        _ = wait(5) { pg.busy.isEmpty }
        let before = got().count
        n = board.hub.sent.count
        L = board.log.count
        pg.buttons["iphoneTest"]?.performClick(nil)
        check("alerts_iphone_test_reaches_ntfy", wait(5) { self.sentSince(n).contains("POST /api/alerts/iphone/test") } && wait(10) { got().count > before && got().last?["title"] as? String == "Ravenry test" && (got().last?["topic"] as? String ?? "").hasPrefix("ravenry-") && got().last?["priority"] as? Int == 3 }
              && wait(5) { self.toasts(since: L).contains(t("alerts.iphoneTestSent")) }, "\(got().last ?? [:]) \(toasts(since: L))")
        let iphoneTopic = got().last?["topic"] as? String ?? ""
        _ = wait(5) { pg.busy.isEmpty }
        n = board.hub.sent.count
        L = board.log.count
        pg.buttons["iphoneArrived"]?.performClick(nil)
        let iphone = { phones().first { $0["transport"] as? String == "ntfy" } }
        check("alerts_iphone_arrived_row", wait(5) { self.sentSince(n).contains("POST /api/alerts/iphone/confirm") } && wait(6) { iphone() != nil && !pg.iphoneOpen && self.toasts(since: L).contains(t("alerts.iphoneAdded")) }
              && shows(pg, "iPhone") && shows(pg, "· " + t("alerts.viaNtfy")) && texts(pg).contains { $0.hasPrefix(t("alerts.getsNtfy").dropLast().description) } && pg.buttons["addIphone"]?.title == t("alerts.addIphone"),
              "\(sentSince(n)) \(toasts(since: L)) \(phones())")
        let iid = iphone()?["id"] as? String ?? ""
        check("alerts_iphone_row_buttons", pg.buttons["phoneTest-\(iid)"] != nil && pg.buttons["remove-\(iid)"] != nil && pg.buttons["remove-\(pixel)"] == nil, iid)
        pictures("alerts-phones")
        _ = wait(5) { pg.busy.isEmpty }
        let b2 = got().count
        n = board.hub.sent.count
        pg.buttons["phoneTest-\(iid)"]?.performClick(nil)
        check("alerts_iphone_row_test", wait(5) { self.sentSince(n).contains("POST /api/alerts/phone/test") } && wait(10) { got().count > b2 && got().last?["topic"] as? String == iphoneTopic }, "\(got().last ?? [:])")
        _ = wait(5) { pg.busy.isEmpty }
        n = board.hub.sent.count
        L = board.log.count
        pg.buttons["remove-\(iid)"]?.performClick(nil)
        check("alerts_iphone_remove", wait(5) { self.sentSince(n).contains("POST /api/alerts/iphone/remove") && self.toasts(since: L).contains(t("alerts.removed", ["name": "iPhone"])) } && wait(6) { iphone() == nil && pg.buttons["remove-\(iid)"]?.window == nil && !self.shows(pg, "· " + t("alerts.viaNtfy")) }, "\(phones())")
        // Escape closes Add an iPhone's setup, as it closes a channel's.
        _ = wait(5) { pg.busy.isEmpty }
        pg.buttons["addIphone"]?.performClick(nil)
        window.makeFirstResponder(pg)
        pg.keyDown(with: NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53)!)
        check("alerts_escape_closes_iphone_setup", !pg.iphoneOpen)
    }

    func screenAlerts() {
        let pg = board.alerts
        board.openPage("side.alerts", t("side.alerts"))
        check("alerts_opens", board.front == .page("side.alerts", t("alerts.title")) && board.root.middle === pg, "\(board.front)")
        check("alerts_drawn", wait(5) { pg.setup != nil && self.shows(pg, t("alerts.mac")) } && shows(pg, t("alerts.phones")) && shows(pg, "Telegram") && shows(pg, "Discord or Slack webhook") && shows(pg, "ntfy") && shows(pg, t("alerts.oneWay")), texts(pg).prefix(10).joined(separator: " | "))
        pictures("alerts")
        // The window in front tells the hub; Send a test comes back down this app's stream and the stand-in posts it.
        var n = board.hub.sent.count
        board.reportFocus()
        check("alerts_focus_reported", wait(3) { self.sentSince(n).contains("POST /api/alerts/desktop/focus") })
        var L = board.log.count
        n = board.hub.sent.count
        pg.buttons["desktopTest"]?.performClick(nil)
        check("alerts_test_posts", wait(3) { self.sentSince(n).contains("POST /api/alerts/desktop/test") })
        check("notify_posted_by_this_app", wait(10) { self.board.notifier.record.count == 1 } && board.notifier.record.first?.title == "Ravenry", board.notifier.record.map { $0.title + ": " + $0.body }.joined(separator: ","))
        check("notify_answered_shown", wait(10) { self.sentSince(n).contains("POST /api/alerts/desktop/result") } && wait(10) { self.toasts(since: L).contains(t("alerts.testShown")) }, toasts(since: L).joined(separator: ","))
        check("alerts_line_last_shown", wait(5) { self.texts(pg).contains { $0.hasPrefix("On. Last shown today") } }, texts(pg).prefix(4).joined(separator: " | "))
        n = board.hub.sent.count
        if let sw = pg.switches["desktop"] { click(sw, at: NSPoint(x: 10, y: 10)) }
        check("alerts_switch_off", wait(3) { self.sentSince(n).contains("POST /api/alerts/desktop") } && wait(6) { pg.switches["desktop"]?.on == false && self.shows(pg, t("alerts.off")) && pg.buttons["desktopTest"]?.isEnabled == false })
        _ = wait(5) { pg.busy.isEmpty }
        if let sw = pg.switches["desktop"] { click(sw, at: NSPoint(x: 10, y: 10)) }
        check("alerts_switch_on", wait(6) { pg.switches["desktop"]?.on == true })
        // Telegram: its setup opens; an empty token says so; a wrong one, the hub's words.
        _ = wait(5) { pg.busy.isEmpty }
        pg.buttons["telegram-toggle"]?.performClick(nil)
        check("alerts_setup_opens", pg.open == "telegram" && shows(pg, t("alerts.tgHow")) && pg.fields["tg"]?.window != nil && pg.buttons["telegram-toggle"]?.title == t("alerts.close"))
        L = board.log.count
        pg.buttons["save-tg"]?.performClick(nil)
        check("alerts_token_needed", toasts(since: L).last == t("alerts.tgPasteFirst"))
        if let f = pg.fields["tg"] { typeIn(f, "not-a-token") }
        L = board.log.count
        pg.buttons["save-tg"]?.performClick(nil)
        check("alerts_token_refused_said", wait(5) { self.toasts(since: L).contains { $0.hasPrefix("That is not a bot token") } }, toasts(since: L).joined(separator: ","))
        pictures("alerts-telegram")
        window.makeFirstResponder(pg)
        pg.keyDown(with: NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53)!)
        check("alerts_escape_closes_setup", pg.open == nil)
        // A webhook: saved, then Use it, then Turn off (never a test: that would reach Discord).
        _ = wait(5) { pg.busy.isEmpty }
        pg.buttons["webhook-toggle"]?.performClick(nil)
        if let f = pg.fields["wh"] { typeIn(f, "https://discord.com/api/webhooks/1/abc") }
        n = board.hub.sent.count
        pg.buttons["save-wh"]?.performClick(nil)
        check("alerts_webhook_saved", wait(3) { self.sentSince(n).contains("POST /api/alerts/webhook") } && wait(6) { pg.buttons["webhook-use"]?.title == t("alerts.useIt") && self.shows(pg, t("alerts.chReady")) })
        _ = wait(5) { pg.busy.isEmpty }
        pg.buttons["webhook-use"]?.performClick(nil)
        check("alerts_webhook_in_use", wait(6) { pg.buttons["webhook-use"]?.title == t("alerts.turnOff") && pg.buttons["webhook-test"] != nil }, texts(pg).joined(separator: " | ").prefix(200).description)
        pictures("alerts-webhook")
        _ = wait(5) { pg.busy.isEmpty }
        pg.buttons["webhook-use"]?.performClick(nil)
        check("alerts_webhook_off", wait(6) { pg.buttons["webhook-use"]?.title == t("alerts.useIt") })
        // ntfy: the QR code, Copy the link, New topic.
        _ = wait(5) { pg.busy.isEmpty }
        pg.buttons["ntfy-toggle"]?.performClick(nil)
        let qr = { () -> NSImage? in var found: NSImage? = nil; func walk(_ v: NSView) { if let i = (v as? NSImageView)?.image, v.accessibilityLabel() == t("alerts.ntfyQr") { found = i }; v.subviews.forEach(walk) }; walk(pg); return found }
        check("alerts_ntfy_qr", wait(3) { (qr()?.size.width ?? 0) > 0 } && shows(pg, "Scan this with the ntfy app"), "\(qr()?.size ?? .zero)")
        L = board.log.count
        pg.buttons["copyLink"]?.performClick(nil)
        check("alerts_ntfy_copy", wait(5) { self.toasts(since: L).contains(t("alerts.copied")) }, toasts(since: L).joined(separator: ","))
        _ = wait(5) { pg.busy.isEmpty }
        L = board.log.count
        pg.buttons["newTopic"]?.performClick(nil)
        check("alerts_ntfy_new_topic", wait(5) { self.toasts(since: L).contains(t("alerts.newTopicDone")) })
        pictures("alerts-ntfy")
        alertsAppRows(pg)
        alertsOwnNtfy(pg)
        alertsPhones(pg)
        formKeepsTyping(pg)
        pg.buttons["pair"]?.performClick(nil)
        check("alerts_pair_phone", wait(2) { self.board.phoneCard.isOpen }, "\(board.front)")
        board.phoneCard.close()
        // macOS refusing them: said, with the way to System Settings.
        board.openPage("side.alerts", t("side.alerts"))
        _ = wait(5) { pg.setup != nil }
        settle(1.5)
        var den = pg.setup ?? [:]
        den["desktop"] = ["enabled": true, "last": ["at": ISO8601DateFormatter().string(from: Date()), "ok": false, "error": "Notifications are not allowed for this application", "denied": true]]
        pg.apply(den)
        check("alerts_denied_line", shows(pg, t("alerts.denied")) && pg.buttons["settings"] != nil)
        let o = Outside.record?.count ?? 0
        pg.buttons["settings"]?.performClick(nil)
        check("alerts_open_settings", Outside.record?.dropFirst(o).contains("open x-apple.systempreferences:com.apple.Notifications-Settings.extension") ?? false)
        pictures("alerts-denied")
        // A hub before `phones` (its apps' names only): each a row through the Ravenry app, no buttons of its own.
        var older = den
        older["phones"] = nil
        older["apps"] = ["Pixel 8"]
        pg.apply(older)
        check("alerts_phones_older_hub", shows(pg, "Pixel 8") && shows(pg, "· " + t("alerts.viaApp")) && !shows(pg, "· " + t("alerts.viaNtfy")) && pg.buttons["pair"]?.title == t("alerts.pairAndroid"), texts(pg).joined(separator: " | ").prefix(300).description)
        check("notify_denied_words", Notifier.denied("Notifications are not allowed for this application") && Notifier.denied("UNErrorDomain error 1.") && !Notifier.denied("macOS did not say it showed it"))
        // A click on one opens the session it is about.
        board.notifier.post(Notifier.Request(id: "n-click", title: "garden-planner needs you", body: "Asked you a question", kind: "ask", projectId: "garden-planner", surfaceId: "sf-1")) { _ in }
        board.notifier.click("n-click")
        check("notify_click_opens_session", board.front == .session("garden-planner/sf-1") || (board.front == .tab && board.frontKey == "garden-planner/sf-1"), "\(board.front)")
        // The Dock icon's badge (SelfTestDockBadge.swift).
        dockBadge()
    }
}
