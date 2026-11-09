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
        n = board.hub.sent.count
        pg.buttons["choice1"]?.performClick(nil)
        check("plan_choice_posts", wait(3) { self.sentSince(n).contains("POST /api/plan/answer") })
        _ = wait(3) { pg.busy.isEmpty }
        var gp2 = gp; gp2["planGate"] = ["question": "Say when"]
        pg.show("garden-planner", mode: .plan, state: HubState(["projects": [gp2]]))
        let L = board.log.count
        pg.buttons["send"]?.performClick(nil)
        check("plan_gate_field_needs_words", toasts(since: L).last == t("plan.typeAnswer") && window.firstResponder === pg.fields["gate"]?.field.currentEditor(), toasts(since: L).joined(separator: ","))
        if let f = pg.fields["gate"] { typeIn(f, "Next Monday") }
        // What is typed stays through the hub's redraws.
        pg.refresh(HubState(["projects": [gp2]])); pg.dirty(); pg.redraw()
        check("plan_typed_kept", pg.fields["gate"]?.text == "Next Monday" && pg.fields["gate"]?.window != nil)
        n = board.hub.sent.count
        pg.buttons["send"]?.performClick(nil)
        check("plan_gate_field_posts", wait(3) { self.sentSince(n).contains("POST /api/plan/answer") })
        _ = wait(3) { pg.busy.isEmpty }
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
        check("newplan_cancel_goes_back", board.root.middle !== pg, "\(board.front)")
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
        board.openIdea("nowhere")
        check("idea_gone", wait(3) { self.shows(pg, t("idea.gone")) })
        pg.buttons["back"]?.performClick(nil)
        check("idea_back_to_ideas", { if case .page(let k, _) = board.front { return k != "idea:nowhere" }; return false }(), "\(board.front)")
    }
}
