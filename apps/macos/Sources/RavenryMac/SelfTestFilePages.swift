// The self-test of the pages from files (scripts/sidetest.mjs --screen
// pages): the five shipped pages on the demo hub the Electron references
// were made on, then the shapes the demo has not, which the driver writes
// when asked (arrive-1): a board, a table, stats, a form, a document with
// boxes, a project's page not trusted, a page with a mistake under its last
// good version and a copy of Plans whose default changed. Each control is
// pressed as the person would and what the hub was sent, the page drew or
// the toast said is read back.

import AppKit

extension SelfTestBoard {
    private var fp: FilePage { board.files }

    /// The rows of the drawn tab's section `si`.
    private func drawnRows(_ si: Int) -> [[String: Any]] {
        (((fp.view?["drawn"] as? [String: Any])?["sections"] as? [[String: Any]]) ?? []).dropFirst(si).first?["rows"] as? [[String: Any]] ?? []
    }
    private func row(_ si: Int, _ file: String) -> [String: Any]? { drawnRows(si).first { $0["file"] as? String == file } }
    /// Opens a page as its sidebar row does, and waits for the hub's answer.
    private func openFile(_ key: String) -> Bool {
        if let r = board.sidebar.rows["page:\(key)"] { click(r) } else { board.openPage(key, board.hub.state?.pages.first { $0.key == key }?.label ?? key) }
        return wait(10) { self.fp.key == key && self.fp.view?["key"] as? String == key && self.board.root.middle === self.fp }
    }
    private func press(_ name: String) {
        if let b = fp.pb[name] as? NSButton ?? fp.buttons[name] { b.performClick(nil) }
        else if let v = fp.pb[name] as? PressBox { v.onPress?() }
        else if let t = fp.pb[name] as? TickBox { t.run?() }
        settle(0.2)
    }
    private func posted(_ n: Int, _ p: String, _ t: Double = 5) -> Bool { wait(t) { self.sentSince(n).contains("POST \(p)") } }
    private func idle() { _ = wait(10) { self.fp.pending == 0 } ; settle(0.3) }
    /// Pictures at 1280 dark and 900 light only (the shapes no Electron reference has).
    private func twoPictures(_ name: String) {
        for (w, h, dark) in [(CGFloat(1280), CGFloat(820), true), (900, 760, false)] {
            size(w, h)
            NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            settle(0.4); board.render(force: true); settle(0.5)
            picture("native-\(name)-\(Int(w))-\(dark ? "dark" : "light").png")
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        size(1280, 820)
    }

    /// A picture of what is in front on a wide window (2560 by 1440, dark).
    private func widePicture(_ name: String) {
        size(2560, 1440)
        settle(0.4); board.render(force: true); settle(0.6)
        picture("native-\(name)-2560-dark.png")
        size(1280, 820)
    }
    /// The views under `v` of a kind.
    private func all<T: NSView>(_ v: NSView, _ k: T.Type) -> [T] { ((v as? T).map { [$0] } ?? []) + v.subviews.flatMap { all($0, k) } }
    /// The field showing exactly `s` under `v`.
    private func field(_ v: NSView, _ s: String) -> NSTextField? { all(v, NSTextField.self).first { $0.stringValue == s } }

    func screenPages() {
        let k1 = "garden-planner/sf-1"
        if let r = board.sidebar.rows[k1] { click(r) }
        // A11Y-004: every pressable card of Ideas, Plans and Ship has a label (SelfTestA11y.swift).
        a11yLabelChecks()

        // MARK: Objectives
        check("objectives_opens", openFile("objectives") && board.front == .page("objectives", "Objectives") && board.root.wideMiddle && board.sidebar.rows["page:objectives"]?.selected == true, "\(board.front)")
        check("objectives_drawn", wait(5) { self.shows(self.fp, "Send the first reminders") } && shows(fp, "Step 2 of 3") && shows(fp, "Waiting on you") && shows(fp, "No brief yet") && shows(fp, "A planting calendar"),
              texts(fp).prefix(12).joined(separator: " | "))
        check("objectives_head", shows(fp.head, "Objectives") && shows(fp.head, t("pg.default")) && shows(fp.head, t("pg.shipped")) && fp.buttons["customize"] != nil && fp.buttons["close"]?.window == nil)
        // A goal from a brief in Markdown (lighthouse's "whose **lamp** turns"): the words in bold, never the marks.
        let lamp = { () -> NSTextField? in
            var hit: NSTextField?
            func walk(_ x: NSView) { if hit != nil || x.isHidden { return }; if let f = x as? NSTextField, f.stringValue.contains("lamp") && f.stringValue.contains("turns") { hit = f; return }; x.subviews.forEach(walk) }
            walk(self.fp)
            return hit
        }()
        let lampBold = lamp.map { f -> Bool in
            let a = f.attributedStringValue, r = (a.string as NSString).range(of: "lamp")
            return r.location != NSNotFound && (a.attribute(.font, at: r.location, effectiveRange: nil) as? NSFont).map { NSFontManager.shared.traits(of: $0).contains(.boldFontMask) } == true
        } ?? false
        let marks = texts(fp).filter { $0.contains("**") || $0.contains("`") }
        check("objectives_markdown_drawn", lampBold && marks.isEmpty, "\(lamp?.stringValue ?? "no lighthouse goal") marks: \(marks.prefix(3))")
        pictures("objectives")
        widePicture("objectives")
        // A plan's row opens that plan (its title, not the project's first).
        press("obj:garden-planner:Send the first reminders")
        check("objectives_open_the_plan", board.front == .page("plan:garden-planner", t("panel.plan")) && board.plan.title == "Send the first reminders", "\(board.front) \(board.plan.title ?? "-")")
        // An objective's row opens the brief at it.
        _ = openFile("objectives")
        press("obj:paper-boat:Rig the sail")
        var atBrief = false
        if case .brief(let p, _) = board.front { atBrief = p == "paper-boat" }
        check("objectives_row_opens_the_brief_at_it", atBrief && wait(8) { self.board.brief.focused == "Rig the sail" }, "\(board.front) \(board.brief.focused ?? "-")")
        // A task's dot ticks it in the brief; the page draws it ticked.
        _ = openFile("objectives")
        let taskState = { (i: Int) -> String? in
            let it = ((self.fp.view?["drawn"] as? [String: Any])?["sections"] as? [[String: Any]])?.first?["rows"] as? [[String: Any]]
            let rows = (it?.first { $0["id"] as? String == "paper-boat" }?["$ravenry"] as? [String: Any])?["rows"] as? [[String: Any]]
            return ((rows?.first { $0["title"] as? String == "Rig the sail" }?["tasks"] as? [[String: Any]]) ?? []).dropFirst(i).first?["state"] as? String
        }
        let n0 = board.hub.sent.count
        check("objectives_task_dot_shown", wait(5) { self.fp.pb["task:paper-boat:Rig the sail:2"] is TaskDot } && taskState(2) == "todo", "\(taskState(2) ?? "-")")
        (fp.pb["task:paper-boat:Rig the sail:2"] as? TaskDot)?.run()
        check("objectives_task_ticks_the_brief", posted(n0, "/api/brief/tick") && wait(10) { taskState(2) == "done" && (self.fp.pb["task:paper-boat:Rig the sail:2"] as? TaskDot)?.state == "done" }, "\(sentSince(n0)) \(taskState(2) ?? "-")")
        idle()
        let b0 = Outside.record?.count ?? 0
        press("editBrief:paper-boat")
        check("objectives_edit_the_brief", Outside.record?.dropFirst(b0).contains { $0.hasSuffix("/paper-boat/BRIEF.md") } == true, Outside.record?.suffix(1).joined() ?? "")
        _ = openFile("objectives")
        press("project:garden-planner")
        check("objectives_project_opens_its_session", board.frontKey == k1, "\(board.front)")
        _ = openFile("objectives")
        var n = board.hub.sent.count
        press("item:lighthouse:Write the brief")
        // Write the brief opens the brief's form for the project (BRIEF-006), as the project page and the panel do;
        // the form writes it: the hub's 2xx, and the brief opens with the words typed.
        let np = board.newProject
        check("objectives_write_the_brief", wait(5) { self.board.front == .page("writebrief:lighthouse", t("panel.writeBrief")) && np.briefFor?.id == "lighthouse" } && np.buttons["go"]?.title == t("np.writeBrief"),
              "\(board.front) \(sentSince(n))")
        _ = wait(5) { np.fields["goal"]?.window != nil }
        if let f = np.fields["goal"] { typeIn(f, "Turn the lamp once every ten seconds.") }
        n = board.hub.sent.count
        np.buttons["go"]?.performClick(nil)
        check("objectives_brief_form_posted", posted(n, "/api/project/brief"), sentSince(n).joined(separator: ","))
        check("objectives_brief_form_written", wait(10) { if case .brief("lighthouse", _) = self.board.front { return self.board.brief.shownText?.contains("Turn the lamp once every ten seconds.") == true }; return false },
              "\(board.front) \(board.brief.shownText?.prefix(200) ?? "-")")

        // MARK: Plans
        check("plans_opens", openFile("plans"))
        check("plans_drawn", wait(5) { self.shows(self.fp, "Send the first reminders") } && shows(fp, "garden-planner") && shows(fp, "Step 2 of 3") && shows(fp, "Finished") && shows(fp, "Find why the hull leaks") && shows(fp, "Next: write the reminder text"),
              texts(fp).prefix(12).joined(separator: " | "))
        pictures("plans")
        widePicture("plans")
        // A row keeps its padding (9 above and under) and its badges sit on its middle.
        if let row = fp.pb["row:paper-boat/Find why the hull leaks"], let title = field(row, "Find why the hull leaks"), let sub = field(row, "paper-boat"), let done = field(row, "done") {
            let tr = title.convert(title.bounds, to: row), sr = sub.convert(sub.bounds, to: row), dr = done.convert(done.bounds, to: row)
            check("plans_row_padded", tr.minY >= 8.5 && row.bounds.height - sr.maxY >= 8.5 && row.bounds.height >= 52, "row \(row.bounds.height) title y \(tr.minY) under \(row.bounds.height - sr.maxY)")
            check("plans_row_badges_centred", abs(dr.midY - row.bounds.midY) <= 1.5, "badge \(dr.midY) row \(row.bounds.midY)")
        } else { check("plans_row_padded", false, fp.pb.keys.filter { $0.hasPrefix("row:") }.joined(separator: ",")) }
        press("row:garden-planner/Send the first reminders")
        check("plans_row_opens_the_plan", board.front == .page("plan:garden-planner", t("panel.plan")) && board.plan.title == "Send the first reminders", "\(board.front)")
        _ = openFile("plans")
        press("item:garden-planner/Send the first reminders:Open the plan")
        check("plans_open_the_plan", board.front == .page("plan:garden-planner", t("panel.plan")))
        _ = openFile("plans")
        press("item:garden-planner/Send the first reminders:Open the project")
        check("plans_open_the_project", board.frontKey == k1, "\(board.front)")

        // MARK: Ideas
        check("ideas_opens", openFile("ideas"))
        check("ideas_drawn", wait(5) { self.shows(self.fp, "A tide pool you look after") } && fp.fields["seed"] != nil && shows(fp, "Spark") && shows(fp, "Parked") && shows(fp, t("pg.show")) && fp.buttons["page:Add idea"] != nil,
              texts(fp).prefix(14).joined(separator: " | "))
        check("ideas_narrow_board_as_lanes_list", fp.lanes.count == 4 && fp.pb["note:a-tide-pool-you-look-after.md"] != nil, "\(fp.lanes.count)")
        pictures("ideas")
        // Wide: the board's lanes, each picture shown whole (fit, as tall as its shape up to 220).
        size(2560, 1440); settle(0.4); board.render(force: true); settle(0.8)
        let pic = { (note: String) -> CoverImage? in self.fp.pb["note:\(note)"].flatMap { self.all($0, CoverImage.self).first } }
        _ = wait(8) { pic("harbour-race.md")?.image != nil && pic("lantern-tower.md")?.image != nil }
        if let w = pic("harbour-race.md"), let tl = pic("lantern-tower.md") {
            // As tall as its shape at the lane's width, at most 220: drawn whole inside (fit).
            let want = { (c: CoverImage, r: CGFloat) in abs(c.bounds.height - min(220, (c.bounds.width * r).rounded())) <= 1.5 }
            check("ideas_picture_whole", w.fit && tl.fit && want(w, 700.0 / 1600.0) && want(tl, 900.0 / 600.0),
                  "wide \(w.bounds.size) tall \(tl.bounds.size)")
        } else { check("ideas_picture_whole", false, fp.pb.keys.filter { $0.hasPrefix("note:") }.joined(separator: ",")) }
        picture("native-ideas-2560-dark.png")
        size(1280, 820)
        var L = board.log.count
        press("bs:add")
        check("ideas_add_needs_words", toasts(since: L).last == t("pg.typeSeed"))
        if let f = fp.fields["seed"] { typeIn(f, "A kite that maps the wind") }
        n = board.hub.sent.count
        press("bs:add")
        check("ideas_add_idea", posted(n, "/api/ideas/add") && wait(10) { self.shows(self.fp, "A kite that maps the wind") } && fp.typed("seed").isEmpty, sentSince(n).joined(separator: ","))
        idle()
        if let f = fp.fields["seed"] { typeIn(f, "a calm puzzle for a train ride") }
        n = board.hub.sent.count
        press("bs:go")
        check("ideas_get_3_directions", posted(n, "/api/ideas/brainstorm"), sentSince(n).joined(separator: ","))
        idle()
        let parked = fp.lanes.last?.view
        press("lane:parked")
        check("ideas_lane_unfolds", wait(3) { self.fp.lanes.last?.view !== parked && !self.shows(self.fp.lanes.last!.view, t("pg.show")) })
        press("lane:parked")
        press("note:a-tide-pool-you-look-after.md")
        check("ideas_card_opens_its_thread", board.front == .page("idea:demo-tidepool", t("idea.ideas")), "\(board.front)")
        _ = openFile("ideas")
        fp.buttons["page:Add idea"]?.performClick(nil)
        check("ideas_add_idea_form", fp.sheetKind == "form" && fp.fields["form:title"] != nil && shows(fp.sheetView!, "Stage") && shows(fp.sheetView!, t("pg.text")), texts(fp.sheetView ?? fp).joined(separator: " | "))
        press("sheet:cancel")
        check("form_cancel_closes", fp.sheetView == nil)

        // MARK: Rules
        check("rules_opens", openFile("rules"))
        check("rules_drawn", wait(5) { self.shows(self.fp, "~/.claude/CLAUDE.md") } && shows(fp, "Working rules") && shows(fp, "Every project") && shows(fp, "Your rules") && shows(fp, "Suggested") && fp.pb["tab:1"] != nil,
              texts(fp).prefix(12).joined(separator: " | "))
        pictures("rules")
        widePicture("rules")
        // The rules file as a document: its wrapped lines joined, one paragraph each, its link a link.
        if let dv = fp.pb.values.compactMap({ $0 as? DocView }).first(where: { $0.text.string.contains("Working rules") }) {
            let paras = dv.text.string.components(separatedBy: "\n")
            check("rules_paragraphs_joined", paras.count == 15 && paras.contains { $0.contains("A look note changes exactly the element named, in the words used. Leave siblings alone;") } && !paras.contains { $0.hasPrefix(" ") },
                  "\(paras.count): " + paras.map { String($0.prefix(24)) }.joined(separator: " | "))
            let at = (dv.text.string as NSString).range(of: "the long notes")
            check("rules_link", at.location != NSNotFound && dv.text.textStorage?.attribute(.link, at: at.location, effectiveRange: nil) as? String == "https://example.com/rules")
            check("rules_contents", dv.contentsRows.count == 3 && dv.contents?.isHidden == false, "\(dv.contentsRows.count)")
            dv.toggle(0)
            check("rules_section_folds", !dv.text.string.contains("A look note") && dv.text.string.contains("Pictures first"))
            dv.toggle(0)
            check("rules_section_unfolds", dv.text.string.contains("A look note"))
        } else { check("rules_paragraphs_joined", false, fp.pb.keys.filter { $0.hasPrefix("doc:") }.joined(separator: ",")) }
        n = board.hub.sent.count
        press("tab:1")
        check("rules_tab_is_an_intent", wait(5) { self.fp.drawnTab == 1 } && shows(fp, "Nothing you keep saying is waiting") && shows(fp, t("pg.nothingMemory")) && board.hub.sent.count == n, texts(fp).prefix(10).joined(separator: " | "))
        // A suggested rule and rules from project memory, as the board holds them (sidetest.mjs):
        // the repeats seed loads at the first look (GET /api/rules/repeats, as a board loads it at
        // its start), and three notes go into paper-boat's memory now, after the empty state.
        let rx: [String: String] = ProcessInfo.processInfo.environment["RAVENRY_MAC_RULES"].flatMap { FileManager.default.contents(atPath: $0) }.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] } ?? [:]
        let mems = [("n-global", "Use pnpm, not npm"), ("n-local", "Tilt the hull, never the deck"), ("n-dismiss", "Prefer tabs to spaces")]
        if let dir = rx["memory"] {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            for (id, text) in mems { try? "---\nname: \(id)\ndescription: \(text)\ntype: feedback\n---\n\(text).\n".write(toFile: "\(dir)/\(id).md", atomically: true, encoding: .utf8) }
        }
        var seeded = false
        for _ in 0..<50 where !seeded {
            var done = false
            board.hub.get("/api/rules/repeats") { _, j in seeded = (j["count"] as? Int ?? 0) >= 2; done = true }
            _ = wait(3) { done }
            if !seeded { settle(0.2) }
        }
        var memRules: [[String: Any]] = [], gotMem = false
        board.hub.get("/api/rules?fresh=1") { _, j in memRules = j["rules"] as? [[String: Any]] ?? []; gotMem = true }
        _ = wait(5) { gotMem }
        fp.load("rules")
        _ = wait(8) { self.fp.pb["item:rp-run-tests:Add rule"] != nil }
        fp.holdMemory(memRules)
        let landed = { (n: Int, p: String) -> String in
            var c = 0
            _ = self.wait(8) { if let a = self.board.hub.answers.first(where: { $0.seq >= n && $0.path == p }) { c = a.code; return true }; return false }
            return "\(c)"
        }
        check("rules_suggested_drawn", seeded && shows(fp, "Run the tests before a commit") && shows(fp, "Use pnpm, not npm") && shows(fp, "Tilt the hull, never the deck"), texts(fp).prefix(14).joined(separator: " | "))
        twoPictures("rules-suggested")
        press("item:rp-run-tests:Add rule")
        check("rules_save_rule_sheet", fp.sheetKind == "rule" && shows(fp.sheetView!, "Run the tests before a commit") && shows(fp.sheetView!, "Into ~/.claude/CLAUDE.md"), texts(fp.sheetView ?? fp).joined(separator: " | "))
        n = board.hub.sent.count
        press("sheet:ok")
        let global = { (try? String(contentsOfFile: rx["global"] ?? "", encoding: .utf8)) ?? "" }
        check("rules_save_rule_posts", posted(n, "/api/repeats/rp-run-tests") && landed(n, "/api/repeats/rp-run-tests") == "200" && wait(5) { global().contains("Run the tests before a commit") }, "hub \(landed(n, "/api/repeats/rp-run-tests"))")
        idle()
        _ = wait(8) { self.fp.pb["item:use-pnpm:Not now"] != nil }
        n = board.hub.sent.count
        press("item:use-pnpm:Not now")
        check("rules_not_now_posts", posted(n, "/api/repeats/use-pnpm") && landed(n, "/api/repeats/use-pnpm") == "200", "hub \(landed(n, "/api/repeats/use-pnpm"))")
        idle()
        for ((b, what), (id, text)) in zip([("global", "every project"), ("local", "this project"), ("dismiss", "not a rule")], mems) {
            _ = wait(8) { self.fp.pb["mem:\(id):\(b)"] != nil && self.fp.pending == 0 }
            n = board.hub.sent.count
            press("mem:\(id):\(b)")
            let code = landed(n, "/api/rules/\(id)")
            // Every project: the global CLAUDE.md; this project: paper-boat's CLAUDE.md; not a rule: neither.
            let local = (try? String(contentsOfFile: rx["projectClaudeMd"] ?? "", encoding: .utf8)) ?? ""
            let written = b == "global" ? global().contains(text) : b == "local" ? local.contains(text) && !global().contains(text) : !global().contains(text) && !local.contains(text)
            check("rules_memory_\(b)", posted(n, "/api/rules/\(id)") && code == "200" && written, "\(what): hub \(code)")
            idle()
        }
        press("tab:0")
        check("rules_tab_back", wait(5) { self.fp.drawnTab == 0 })

        // MARK: Ship
        check("ship_opens", openFile("ship"))
        check("ship_drawn", wait(5) { self.shows(self.fp, "Unpushed commits") } && shows(fp, "Waiting for your call") && shows(fp, "garden-planner") && shows(fp, "Uncommitted changes") && shows(fp, "No upstream"), texts(fp).prefix(14).joined(separator: " | "))
        let card = { (p: String) in self.fp.pb.keys.first { $0.hasPrefix("card:") && $0.hasSuffix("/\(p)") } ?? "" }
        check("ship_cards", wait(5) { !card("garden-planner").isEmpty } && fp.pb.keys.filter { $0.hasPrefix("card:") }.count == 5, fp.pb.keys.filter { $0.hasPrefix("card:") }.sorted().joined(separator: ","))
        pictures("ship")
        press("item:" + card("paper-boat").dropFirst(5) + ":Open the project")
        check("ship_open_the_project", board.frontKey?.hasPrefix("paper-boat/") == true, "\(board.front)")
        _ = openFile("ship")
        press(card("notes-app"))
        check("ship_card_opens_its_sheet", fp.sheetKind == "item" && shows(fp.sheetView!, "notes-app"), fp.sheetKind)
        press("sheet:close")

        // MARK: the shapes the demo has not
        check("fixtures_written", arrival(1) && wait(20) { ["bugs", "notes", "broken"].allSatisfy { k in self.board.hub.state?.pages.contains { $0.key == k } == true } && self.board.hub.state?.pages.contains { $0.project != nil } == true },
              board.hub.state?.pages.map { $0.key }.joined(separator: ",") ?? "")

        // A board: lanes, a drag to another lane, a button, a confirm with Undo, an approval.
        check("bugs_opens", openFile("bugs"))
        check("bugs_board", wait(5) { self.fp.lanes.count == 3 } && shows(fp, "Boat clips through the dock") && shows(fp, "physics") && fp.pb["tab:0"] != nil && shows(fp, "Board 2"), texts(fp).prefix(14).joined(separator: " | "))
        check("bugs_head_open_file", fp.buttons["openFile"] != nil && shows(fp.head, "3 files in bugs/") || shows(fp.head, "bugs in bugs/"), texts(fp.head).joined(separator: " | "))
        twoPictures("bugs")
        n = board.hub.sent.count
        check("bugs_drag_to_lane", fp.dragForTest("rain-flicker.md", to: "new") && posted(n, "/api/pages/item/set") && wait(8) { self.row(0, "rain-flicker.md")?["status"] as? String == "new" }, sentSince(n).joined(separator: ","))
        idle()
        n = board.hub.sent.count
        press("item:dock-clip.md:Mark fixed")
        check("bugs_set_button", posted(n, "/api/pages/item/set") && wait(8) { self.row(0, "dock-clip.md")?["status"] as? String == "fixed" })
        idle()
        press("item:save-lost.md:Archive")
        check("bugs_archive_confirms", fp.sheetKind == "confirm" && shows(fp.sheetView!, "Archive Save lost after a crash?"))
        n = board.hub.sent.count
        L = board.log.count
        press("sheet:ok")
        check("bugs_archive_posts", posted(n, "/api/pages/item/archive") && wait(5) { self.toasts(since: L).contains(t("pg.archived", ["title": "Save lost after a crash"])) } && wait(8) { self.row(0, "save-lost.md") == nil })
        n = board.hub.sent.count
        board.toastButton?.performClick(nil)
        check("bugs_archive_undo", posted(n, "/api/pages/item/restore") && wait(8) { self.row(0, "save-lost.md") != nil }, sentSince(n).joined(separator: ","))
        idle()
        n = board.hub.sent.count
        press("item:rain-flicker.md:Ask later")
        check("bugs_ask_needs_approval", posted(n, "/api/pages/ask") && wait(5) { self.fp.sheetKind == "approve" } && shows(fp.sheetView!, "Look at the bug"), texts(fp.sheetView ?? fp).joined(separator: " | "))
        n = board.hub.sent.count
        press("sheet:ok")
        check("bugs_approve_posts", posted(n, "/api/pages/approve") && wait(5) { self.sentSince(n).filter { $0 == "POST /api/pages/ask" }.count == 1 }, sentSince(n).joined(separator: ","))
        idle()
        // Allowed, the ask went to garden-planner's session at its prompt (the fake cmux's box, which keeps
        // what is sent), and that session came to the front, as in the Electron app.
        let typedTo = { () -> String in
            guard let d = FileManager.default.contents(atPath: rx["fake"] ?? ""), let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return "" }
            return ((j["prompts"] as? [String: Any]) ?? [:]).values.compactMap { ($0 as? [String: Any])?["sent"] as? [String] }.flatMap { $0 }.joined(separator: " / ")
        }
        check("bugs_ask_lands_in_session", wait(5) { if case .session(let k) = self.board.front { return k.hasPrefix("garden-planner/") }; return false } && wait(5) { typedTo().contains("Look at the bug Rain flickers on the menu") },
              "\(board.front); sent: \(typedTo().prefix(160))")
        _ = openFile("bugs")
        press("note:dock-clip.md")
        check("bugs_note_opens_its_sheet", fp.sheetKind == "item" && shows(fp.sheetView!, "Status") && shows(fp.sheetView!, "fixed"), texts(fp.sheetView ?? fp).joined(separator: " | "))
        press("sheet:close")
        // The form: a field needed, then a new note.
        fp.buttons["page:New bug"]?.performClick(nil)
        check("bugs_form", fp.sheetKind == "form" && fp.fields["form:size"] != nil && fp.fields["form:tags"] != nil && shows(fp.sheetView!, "Status"))
        twoPictures("bugs-form")
        n = board.hub.sent.count
        press("sheet:ok")
        check("bugs_form_says_what_is_missing", posted(n, "/api/pages/item/create") && wait(5) { self.fp.form?.error != nil } && fp.sheetKind == "form", "\(fp.form?.error ?? "-") \(sentSince(n)) \(fp.pb.keys.filter { $0.hasPrefix("sheet") })")
        if let f = fp.fields["form:title"] { typeIn(f, "Sail too bright at dusk") }
        if let f = fp.fields["form:tags"] { typeIn(f, "render, light") }
        n = board.hub.sent.count
        press("sheet:ok")
        check("bugs_form_makes_one", posted(n, "/api/pages/item/create") && wait(8) { self.fp.sheetView == nil && self.shows(self.fp, "Sail too bright at dusk") }, fp.form?.error ?? "")
        idle()
        // A table, then stats: each tab drawn when the hub answers.
        press("tab:1")
        check("bugs_table", wait(5) { self.fp.drawnTab == 1 } && shows(fp, "Size") && shows(fp, "Boat clips through the dock") && fp.pb["trow:dock-clip.md"] != nil, texts(fp).prefix(16).joined(separator: " | "))
        twoPictures("bugs-table")
        L = board.log.count
        press("item:dock-clip.md:Copy")
        check("bugs_copy", Outside.record?.last == "copy Boat clips through the dock: fixed" && toasts(since: L).last == t("pg.copied"), Outside.record?.last ?? "")
        press("trow:rain-flicker.md")
        check("bugs_table_row_opens", fp.sheetKind == "item")
        press("sheet:close")
        press("tab:2")
        check("bugs_stats", wait(5) { self.fp.drawnTab == 2 } && shows(fp, "Next due") && shows(fp, "New or fixing"), texts(fp).prefix(12).joined(separator: " | "))
        twoPictures("bugs-stats")
        press("tab:0")
        _ = wait(5) { self.fp.drawnTab == 0 }

        // A document with boxes, grouped.
        check("notes_opens", openFile("notes"))
        let notesDoc = { self.fp.pb["doc:release-04.md"] as? DocView }
        check("notes_document", wait(5) { self.shows(self.fp, "Release 0.4") } && shows(fp, "Write the changelog") && shows(fp, "release") && shows(fp, "npm run release") && notesDoc()?.boxes.count == 3, texts(fp).prefix(14).joined(separator: " | "))
        twoPictures("notes")
        n = board.hub.sent.count
        notesDoc()?.tick(1)
        check("notes_tick_posts", posted(n, "/api/pages/item/toggle") && wait(8) { notesDoc()?.boxes.dropFirst(1).first?.done == true }, sentSince(n).joined(separator: ","))
        idle()
        let before = Outside.record?.count ?? 0
        press("open:release-04.md")
        fp.buttons["openFile"]?.performClick(nil)
        check("notes_open_file_and_item", Outside.record?.dropFirst(before).contains { $0.hasSuffix("/pages/notes/release-04.md") } == true && Outside.record?.dropFirst(before).contains { $0.hasSuffix("/pages/notes.page.yaml") } == true,
              Outside.record?.suffix(2).joined(separator: ", ") ?? "")

        // A mistake: the last good version under the problem.
        check("broken_opens", openFile("broken"))
        check("broken_bar", wait(5) { self.shows(self.fp, "broken.page.yaml line") } && shows(fp, t("pg.stale")) && shows(fp, "Still listed") && shows(fp, "titel"), texts(fp).prefix(16).joined(separator: " | "))
        twoPictures("broken")
        let b2 = Outside.record?.count ?? 0
        press("bar:openFile")
        check("broken_open_file", Outside.record?.dropFirst(b2).contains { $0.hasSuffix("/pages/broken.page.yaml") } == true)
        n = board.hub.sent.count
        press("bar:askFix")
        check("broken_ask_claude_to_fix", posted(n, "/api/pages/ask"), sentSince(n).joined(separator: ","))
        idle()

        // A project's page, not trusted: off until trusted.
        let dk = board.hub.state?.pages.first { $0.project != nil }?.key ?? ""
        check("untrusted_opens", openFile(dk), dk)
        check("untrusted_bar", wait(5) { self.shows(self.fp, t("pg.trustNew")) } && shows(fp, t("pg.wouldDo")) && shows(fp, "npm run build") && fp.buttons["page:Build"]?.isEnabled == false && shows(fp.head, t("pg.readOnly")) && shows(fp.head, "garden-planner"),
              texts(fp).prefix(16).joined(separator: " | "))
        twoPictures("untrusted")
        let untrusted = fp.view
        n = board.hub.sent.count
        L = board.log.count
        press("bar:trust")
        check("untrusted_trust", posted(n, "/api/pages/trust") && wait(8) { self.toasts(since: L).contains(t("pg.trusted")) && self.fp.buttons["page:Build"]?.isEnabled == true }, toasts(since: L).joined(separator: ","))
        idle()
        n = board.hub.sent.count
        fp.buttons["page:Build"]?.performClick(nil)
        check("trusted_run_posts", posted(n, "/api/pages/run"))
        idle()
        n = board.hub.sent.count
        // "Ask Claude to fix" (above) typed its words into garden-planner's box without sending; the
        // person sends them there (Enter in cmux), so the next ask finds the prompt empty, as the hub requires.
        var fixTyped = ""
        if let path = rx["fake"], let d = FileManager.default.contents(atPath: path), var j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], var ps = j["prompts"] as? [String: Any] {
            for (k, v) in ps { if var p = v as? [String: Any], let typed = p["typed"] as? String, !typed.isEmpty { fixTyped += typed; p["sent"] = (p["sent"] as? [String] ?? []) + [typed]; p["typed"] = ""; ps[k] = p } }
            j["prompts"] = ps
            if let out = try? JSONSerialization.data(withJSONObject: j) { try? out.write(to: URL(fileURLWithPath: path)) }
        }
        check("broken_ask_typed_in_session", fixTyped.contains("broken"), String(fixTyped.prefix(120)))
        L = board.log.count
        press("item:first.md:Ask")
        check("trusted_ask_posts", posted(n, "/api/pages/ask"), "toasts \(toasts(since: L))")
        idle()
        _ = openFile(dk)
        if let u = untrusted { fp.apply(dk, u) }
        press("bar:keepReadOnly")
        check("untrusted_keep_read_only", !shows(fp, t("pg.trustNew")) && fp.buttons["page:Build"]?.isEnabled == false)

        // Your copy of Plans, its default changed since.
        check("changed_opens", openFile("plans") && wait(10) { self.fp.view?["changed"] is [Any] })
        check("changed_bar", shows(fp, t("pg.defaultChanged")) && shows(fp.head, t("pg.yourCopy")) && fp.pb["bar:seeChanged"] != nil, texts(fp).prefix(8).joined(separator: " | "))
        press("bar:seeChanged")
        check("changed_sheet_from_hub", fp.sheetKind == "changed" && shows(fp.sheetView!, "What changed in the default Plans page") && shows(fp.sheetView!, "limit: 20") && shows(fp.sheetView!, "ravenry/plans, 1 to 2"), texts(fp.sheetView ?? fp).joined(separator: " | ").prefix(300).description)
        twoPictures("changed")
        n = board.hub.sent.count
        press("sheet:ok")
        check("changed_bring_in_asks", posted(n, "/api/pages/ask"))
        idle()
        if fp.sheetView != nil { press("sheet:cancel") }
        n = board.hub.sent.count
        press("bar:hide")
        check("changed_hide", posted(n, "/api/pages/dismiss") && wait(8) { !self.shows(self.fp, t("pg.defaultChanged")) })

        // Ravenry's sessions view, as a page with it would show it.
        let sv: [String: Any] = ["key": "sessions-x", "id": "sessions-x", "origin": "global", "path": "~/.ravenry/pages/sessions-x.page.yaml", "file": "/nowhere/sessions-x.page.yaml", "dir": "~/.ravenry/pages", "ok": true, "stale": false, "problems": [], "text": "x",
                                 "model": ["title": "Sessions", "tabbed": false, "actions": [], "source": ["kind": "provider"], "tabs": [["label": NSNull(), "sections": [["kind": "plugin", "view": "ravenry:sessions", "actions": []], ["kind": "placeholder", "view": "x:chart", "reason": "Ravenry 0.9 draws this.", "title": "Chart", "actions": []]]]]],
                                 "drawn": ["tab": 0, "tabs": [["label": NSNull(), "count": NSNull()]], "pageItems": 0, "sections": [["rows": [["id": "s-1", "project_name": "paper-boat", "line": "Idle for 3 h", "assistant": "claude", "memory_kb": 204800, "closable": true, "group": "idle"]], "count": 1]]]]
        fp.apply("sessions-x", sv)
        check("sessions_view", shows(fp, "paper-boat") && shows(fp, "200 MB") && shows(fp, "Ravenry 0.9 draws this.") && fp.pb["sessions:closeIdle"] != nil)
        n = board.hub.sent.count
        press("sessions:closeIdle")
        check("sessions_close_idle", posted(n, "/api/sessions/close"))
        idle()

        // Customize: your own copy, opened.
        check("customize_opens", openFile("objectives"))
        n = board.hub.sent.count
        let b3 = Outside.record?.count ?? 0
        fp.buttons["customize"]?.performClick(nil)
        check("customize_posts", posted(n, "/api/pages/customize") && wait(5) { Outside.record?.dropFirst(b3).contains { $0.hasSuffix("/pages/objectives.page.yaml") } == true } && wait(8) { self.shows(self.fp.head, t("pg.yourCopy")) },
              Outside.record?.suffix(2).joined(separator: ", ") ?? "")
    }
}
