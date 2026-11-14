// The sidebar and the session controls driven for real, at the end of
// sidetest.mjs --screen sessions (its hub follows this test's daemon and
// resumes with a stand-in of Claude): what the sidebar draws against the
// hub's state (SESS-001, 002, 003), Open in (SESS-014), a project page's
// Move here and the page with no earlier conversation (SESS-018), Also open
// in with Move here and Keep it in (SESS-016), a toast's Show and its pause
// under the pointer (SESS-019). sidetest.mjs makes what the hub must see
// (a process of a session in cmux, the stand-in's process, a pane that
// makes the hub list the processes again) when asked through
// <out>.do-<n>, answering <out>.done-<n>.

import AppKit

extension SelfTestBoard {
    /// The driver's requests so far.
    static var asks = 0
    static var lastAnswer = ""
    /// Asks the driver for something and waits for its answer.
    func ask(_ req: [String: Any], timeout: Double = 30) -> [String: Any]? {
        SelfTestBoard.asks += 1
        let n = SelfTestBoard.asks
        let d = URL(fileURLWithPath: out + ".do-\(n)"), a = URL(fileURLWithPath: out + ".done-\(n)")
        // Atomic: the driver reads the request as soon as the file is there.
        try? JSONSerialization.data(withJSONObject: req).write(to: d, options: .atomic)
        guard wait(timeout, { FileManager.default.fileExists(atPath: a.path) }) else { return nil }
        settle(0.1)
        let j = (try? Data(contentsOf: a)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        SelfTestBoard.lastAnswer = j.map { "\($0)" } ?? "none"
        return j
    }

    private func words(_ v: NSView) -> [String] {
        var out: [String] = []
        func walk(_ x: NSView) {
            if x.isHidden { return }
            if let f = x as? NSTextField { if !f.stringValue.isEmpty { out.append(f.stringValue) }; return }
            if let b = x as? RButton { out.append(b.title); return }
            x.subviews.forEach(walk)
        }
        walk(v)
        return out
    }
    /// The hub's status for each POST to `path` sent after `since` (sent count), as answered.
    func codes(_ path: String, since: Int) -> [Int] { board.hub.answers.filter { $0.seq >= since && $0.path == path }.map(\.code) }

    private func top(_ v: NSView) -> CGFloat { v.convert(v.bounds, to: nil).maxY }
    private func plainMd(_ s: String) -> String { s.replacingOccurrences(of: "*", with: "").replacingOccurrences(of: "`", with: "").replacingOccurrences(of: "\u{2060}", with: "") }

    func sessFunctionChecks() {
        sessSidebarDrawn()
        sessOpenIn()
        sessToast()
        sessProjectPage()
    }

    // MARK: SESS-001, 002, 003: what the sidebar draws, against the hub's state

    func sessSidebarDrawn() {
        board.toTerminal()
        board.hub.testPatch = nil
        board.render(force: true)
        settle(0.8)
        guard let st = board.hub.state else { check("sess_drawn_state", false); return }
        let sb = board.sidebar
        // Idle folded (the first launch's, --screen idlefold): its head pressed to open it, as the person would.
        if sb.idleFolded, let h = sb.idleHead { click(h); _ = wait(2) { !sb.idleFolded } }
        sb.layoutSubtreeIfNeeded()
        // The sections drawn: the tinted boxes, top first.
        var boxes: [Box] = []
        func walk(_ v: NSView) {
            if v.isHiddenOrHasHiddenAncestor { return }
            if let b = v as? Box, let f = b.fill, ["you-t", "work-t", "wait-t", "idle-t"].contains(f), b.subviews.contains(where: { _ in true }), words(b).count > 1 { boxes.append(b) }
            v.subviews.forEach(walk)
        }
        walk(sb)
        boxes.sort { top($0) > top($1) }
        let hubSections = st.sections
        let drawnTitles = boxes.map { b in hubSections.first { b.fill == "\($0.group)-t" && words(b).contains($0.title) }?.title ?? "?" }
        check("sess_sections_drawn_in_order", drawnTitles == hubSections.map(\.title),
              "drawn \(drawnTitles.joined(separator: ", ")); hub \(hubSections.map { "\($0.title) \($0.count)" }.joined(separator: ", "))")
        // Each section's count badge says the hub's count.
        var counts: [String] = []
        var countsOk = boxes.count == hubSections.count
        for (b, s) in zip(boxes, hubSections) {
            let w = words(b)
            let i = w.firstIndex(of: s.title)
            let badge = i.flatMap { w.indices.contains($0 + 1) ? w[$0 + 1] : nil } ?? "-"
            counts.append("\(s.title) \(badge)/\(s.count)")
            if badge != String(s.count) { countsOk = false }
        }
        check("sess_section_counts_drawn", countsOk, counts.joined(separator: ", "))
        // Each row in the section the hub put it in, in the hub's order.
        var orderOk = boxes.count == hubSections.count, orderDetail: [String] = []
        for (b, s) in zip(boxes, hubSections) {
            var rs: [Row] = []
            func rows(_ v: NSView) { if let r = v as? Row, !r.key.isEmpty, !r.key.hasPrefix("fold:") { rs.append(r) }; v.subviews.forEach(rows) }
            rows(b)
            let drawn = rs.sorted { top($0) > top($1) }.map(\.key)
            let want = s.projects.flatMap { p in p.rows.isEmpty ? ["project:\(p.id)"] : p.rows.map(\.key) }
            if drawn != want { orderOk = false }
            orderDetail.append("\(s.group): \(drawn.joined(separator: ","))\(drawn == want ? "" : " (hub \(want.joined(separator: ",")))")")
        }
        check("sess_rows_in_their_section_in_order", orderOk, orderDetail.joined(separator: "; "))
        // The mix bar: each state's share of its width is its share of the rows.
        var bars: [Box] = []
        func mixWalk(_ v: NSView) { if let b = v as? Box, let f = b.fill, ["you", "work", "wait", "idle"].contains(f), abs(b.frame.height - 6) < 0.5, b.frame.width > 0 { bars.append(b) }; v.subviews.forEach(mixWalk) }
        mixWalk(sb)
        let groups = ["you", "work", "wait", "idle"].filter { (st.counts[$0] ?? 0) > 0 }
        let total = groups.reduce(0) { $0 + (st.counts[$1] ?? 0) }
        let widthSum = bars.reduce(CGFloat(0)) { $0 + $1.frame.width }
        var mixOk = bars.count == groups.count && widthSum > 0
        var mixDetail: [String] = []
        for g in groups {
            let w = bars.first { $0.fill == g }?.frame.width ?? 0
            let share = Double(w / max(widthSum, 1)), want = Double(st.counts[g] ?? 0) / Double(max(total, 1))
            if abs(share - want) > 0.02 { mixOk = false }
            mixDetail.append(String(format: "%@ %.2f (hub %.2f)", g, share, want))
        }
        check("sess_mix_bar_shares", mixOk, mixDetail.joined(separator: ", "))
        // Each session row's fields: its name, assistant, percent, and its mark or line.
        var bad: [String] = [], seen = 0
        for s in hubSections { for p in s.projects { for r in p.rows {
            seen += 1
            guard let row = sb.rows[r.key] else { bad.append("\(r.key) not drawn"); continue }
            let w = words(row).map(plainMd)
            let name = sb.names[r.key]?.stringValue ?? ""
            let tag = sb.tags[r.key].flatMap { $0 }.map { words($0).joined() } ?? ""
            let pct = sb.pcs[r.key]?.stringValue ?? ""
            let second = (r.mark?.text ?? r.line).map(plainMd)
            if name != r.name { bad.append("\(r.key) name \(name) vs \(r.name)") }
            if tag != (r.assistant ?? "") { bad.append("\(r.key) assistant \(tag) vs \(r.assistant ?? "-")") }
            if pct != (r.pct.map { "\($0)%" } ?? "") { bad.append("\(r.key) percent \(pct) vs \(r.pct.map(String.init) ?? "-")") }
            if let s2 = second, !w.contains(where: { $0.contains(s2) || s2.contains($0) && $0.count > 8 }) { bad.append("\(r.key) line \"\(s2)\" not in \(w)") }
        } } }
        check("sess_row_fields_drawn", seen > 0 && bad.isEmpty, bad.isEmpty ? "\(seen) rows: name, assistant, percent, mark or line as the hub's" : bad.prefix(4).joined(separator: " | "))
        // A project on a machine names it on its head (the demo's projects run here: none expected).
        let onMachine = hubSections.flatMap(\.projects).filter { $0.machine != nil }
        let machinesOk = onMachine.allSatisfy { p in boxes.contains { words($0).contains(p.machine!) } }
        check("sess_machine_drawn", machinesOk, onMachine.isEmpty ? "no project on a machine in this board" : onMachine.map { "\($0.id) on \($0.machine!)" }.joined(separator: ", "))
    }

    // MARK: SESS-014: Open in, pressed

    func sessOpenIn() {
        guard let st = board.hub.state, let f = st.projects.lazy.compactMap({ p in p.sessions.first { s in s.pane == nil && s.machine == nil && (s.term ?? "").lowercased() == "cmux" }.map { (p, $0) } }).first else {
            check("sess_open_in_session", false, "no session in cmux"); return
        }
        let key = "\(f.0.id)/\(f.1.surfaceId)"
        board.pickSession(key, why: "test")
        settle(0.5)
        guard let b = board.outside.buttons["open"] else { check("sess_open_in_button", false, board.outside.buttons.keys.sorted().joined(separator: ",")); return }
        check("sess_open_in_button", b.title == "Open in cmux", b.title)
        let n = board.hub.sentBodies.count
        click(b)
        check("sess_open_in_posted", wait(5) { self.board.hub.sentBodies.dropFirst(n).contains { $0.path == "/api/open" && $0.body["surfaceId"] as? String == f.1.surfaceId } && self.board.hub.inFlight == 0 },
              board.hub.sentBodies.dropFirst(n).map(\.path).joined(separator: ","))
        // Where it lands: the hub asked cmux to bring that tab forward.
        let log = ask(["do": "read", "what": "focus"])?["text"] as? String ?? ""
        check("sess_open_in_cmux_focused", log.contains("select-workspace") && log.contains("focus-panel") && log.contains(f.1.surfaceId), log.replacingOccurrences(of: "\n", with: " | "))
    }

    // MARK: SESS-019: a toast's Show, and the pointer over the toasts

    func sessToast() {
        board.toTerminal()
        board.toastStack.clear()
        settle(0.3)
        let tv = board.toastStack
        // A plain one (5 s): the pointer over it, through the window's own events, holds it.
        board.toast("Copied the session's id.")
        settle(0.3)
        func cross(_ type: NSEvent.EventType) {
            guard let ta = tv.trackingAreas.first, let w = tv.window else { return }
            let p = tv.convert(NSPoint(x: tv.bounds.midX, y: tv.bounds.midY), to: nil)
            // The event AppKit sends the tracking area's owner when the pointer crosses it (a window
            // off every screen has no pointer to cross it), handed to that owner as AppKit does.
            if let e = NSEvent.enterExitEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber, context: nil,
                                              eventNumber: 0, trackingNumber: 0, userData: Unmanaged.passUnretained(ta).toOpaque()) {
                if type == .mouseEntered { (ta.owner as? NSResponder)?.mouseEntered(with: e) } else { (ta.owner as? NSResponder)?.mouseExited(with: e) }
            }
        }
        tv.layoutSubtreeIfNeeded()
        cross(.mouseEntered)
        settle(6.0)
        let held = board.toastTexts.contains("Copied the session's id.")
        cross(.mouseExited)
        let left = Date()
        _ = wait(5) { !self.board.toastTexts.contains("Copied the session's id.") }
        let after = Date().timeIntervalSince(left)
        // Once it leaves, what was left of its 5 s, at least 2 s more (it was paused 0.3 s in).
        check("sess_toast_pointer_holds", held && after >= 1.8 && after < 5.5, String(format: "still there 6 s in while the pointer was over it: %@; gone %.1f s after it left", held ? "yes" : "no", after))
        // A real arrival (the driver's): its toast's Show opens that session, its row lit and the panel on it.
        // A session at work now (its question is new), the others after.
        let working = board.hub.state?.sections.filter { $0.group == "work" }.flatMap { $0.projects.map(\.id) } ?? []
        guard let pid = ask(["do": "arrive", "projects": working + ["paper-boat", "notes-app", "garden-planner"], "question": "Water the seedlings before the frost, or after?"])?["project"] as? String,
              let key = wait(15, { self.board.hub.state?.project(pid)?.sessions.contains { self.board.hub.state?.sidebar(has: "\(pid)/\($0.surfaceId)", in: "you") ?? false } ?? false }) ? board.hub.state?.project(pid)?.sessions.first(where: { self.board.hub.state?.sidebar(has: "\(pid)/\($0.surfaceId)", in: "you") ?? false }).map({ "\(pid)/\($0.surfaceId)" }) : nil else {
            check("sess_toast_arrival", false, "no arrival: \(SelfTestBoard.lastAnswer)"); return
        }
        guard wait(15, { self.board.toastButtons.contains { $0.title == "Show" } }), let show = board.toastButtons.first(where: { $0.title == "Show" }) else {
            check("sess_toast_show_opens", false, "no Show: \(board.toastTexts)"); return
        }
        let said = board.toastTexts.last ?? ""
        click(show)
        check("sess_toast_show_opens", wait(4) { self.board.front == .session(key) || (self.board.front == .tab && self.board.frontKey == key) } && board.panel.key == key && board.sidebar.rows[key]?.selected == true,
              "toast \"\(said)\"; front \(board.front) panel \(board.panel.key)")
    }

    // MARK: SESS-018 and SESS-016: a project's page, Move here, Also open in

    func sessProjectPage() {
        // No earlier conversation (old-notes, its brief written by the driver): New session here and Open brief.
        board.pickProject("old-notes")
        let pp = board.projectPage
        if let p = board.hub.state?.project("old-notes") { pp.reload(p) }
        check("sess_pp_none_found_buttons", wait(6) { pp.buttons["new"] != nil && pp.buttons["brief"] != nil } && shows(pp, t("project.noEarlier")),
              "\(pp.buttons.keys.sorted()) \(texts(pp).prefix(6))")
        if let b = pp.buttons["brief"] { click(b) }
        var atBrief = false
        _ = wait(4) { if case .brief(let id, _) = self.board.front { atBrief = id == "old-notes" }; return atBrief }
        // Its text, drawn in the brief's text view.
        func briefText() -> String { var out = ""; func walk(_ v: NSView) { if let tv = v as? NSTextView { out += tv.string }; v.subviews.forEach(walk) }; walk(board.brief); return out }
        check("sess_pp_open_brief_opens", atBrief && wait(6) { briefText().contains("Keep the notes from before the app") }, "\(board.front) \(briefText().prefix(80))")
        board.pickProject("old-notes")
        _ = wait(6) { pp.buttons["new"] != nil }
        if let b = pp.buttons["new"] { click(b) }
        check("sess_pp_new_session_here_opens_start", wait(4) { self.board.front == .start } && board.start.folder?.hasSuffix("old-notes") == true, "\(board.front) folder \(board.start.folder ?? "-")")

        // lighthouse's last conversation still open in cmux (a process of it there, the driver's): Move here.
        let lh = "1a9b0001-0000-4000-8000-0000000000aa"
        guard ask(["do": "cmux", "project": "lighthouse", "sid": lh]) != nil else { check("sess_driver", false, "no answer"); return }
        board.pickProject("lighthouse")
        func mainTitle() -> String { pp.buttons["continue"]?.title ?? "none" }
        var moved = false
        for _ in 0..<6 where !moved {
            if let p = board.hub.state?.project("lighthouse") { pp.reload(p) }
            moved = wait(3) { mainTitle() == "Move here" }
        }
        check("sess_pp_move_here_shown", moved && shows(pp, "Still open in cmux."), "\(mainTitle()) \(texts(pp).prefix(8))")
        let n = board.hub.sentBodies.count
        if let b = pp.buttons["continue"] { click(b) }
        check("sess_pp_move_here_posted", wait(10) { self.board.hub.sentBodies.dropFirst(n).contains { $0.path == "/api/sessions/move" && $0.body["sessionId"] as? String == lh && $0.body["keep"] as? String == "ravenry" } && self.board.hub.inFlight == 0 },
              board.hub.sentBodies.dropFirst(n).map(\.path).joined(separator: ","))
        check("sess_pp_move_resumed_here", wait(10) { self.board.log.contains { $0.hasPrefix("move \(lh): resumed in pane") } }, board.log.filter { $0.hasPrefix("move ") }.suffix(2).joined(separator: " | "))

        // Now in a Ravenry pane, and a process of it in cmux again: Also open in cmux, with Move here and Keep it in cmux.
        func alsoOpen() -> (key: String, s: HubSession)? {
            guard let p = board.hub.state?.project("lighthouse"), let s = p.sessions.first(where: { $0.sessionId == lh && $0.alsoOpen != nil }) else { return nil }
            return ("lighthouse/\(s.surfaceId)", s)
        }
        for (i, keep) in ["ravenry", "outside"].enumerated() {
            let t0 = Date()
            guard ask(["do": "cmux", "project": "lighthouse", "sid": lh, "standin": true]) != nil, wait(75, { alsoOpen() != nil }), let a = alsoOpen() else {
                let procs = board.hub.state?.sessionProcs.filter { $0.sessionId == lh }.map { "\($0.pid) \($0.surfaceId ?? "-") \($0.raw["termKind"] ?? "-")" } ?? []
                check("sess_also_open_\(i)", false, "not also open: \(board.hub.state?.project("lighthouse")?.sessions.map { "\($0.surfaceId) \($0.alsoOpen ?? "-")" } ?? []); its processes \(procs); driver \(SelfTestBoard.lastAnswer)"); return
            }
            let alsoAt = Date().timeIntervalSince(t0)
            board.pickSession(a.key, why: "test")
            if !board.panelVisible { _ = key("b", [.command, .option]) }
            check("sess_also_open_said_\(i)", wait(4) { self.shows(self.board.panel, "Also open in cmux") || self.shows(self.board.panel, "also open in cmux") || self.board.panel.buttons["keep"] != nil },
                  texts(board.panel).prefix(12).joined(separator: " | "))
            let n2 = board.hub.sentBodies.count, sent2 = board.hub.sent.count
            if let b = board.panel.buttons[keep == "ravenry" ? "move" : "keep"] { click(b) }
            let name = keep == "ravenry" ? "sess_also_move_here_posted" : "sess_also_keep_it_in_posted"
            check("sess_also_open_after_\(i)", true, String(format: "the hub said it also open %.1f s after the driver listed it", alsoAt))
            check(name, wait(10) { self.board.hub.sentBodies.dropFirst(n2).contains { $0.path == "/api/sessions/move" && $0.body["keep"] as? String == keep && $0.body["sessionId"] as? String == lh } && self.board.hub.inFlight == 0 }
                  && !codes("/api/sessions/move", since: sent2).isEmpty && codes("/api/sessions/move", since: sent2).allSatisfy { (200..<300).contains($0) },
                  board.hub.sentBodies.dropFirst(n2).map { "\($0.path) \($0.body["keep"] ?? "")" }.joined(separator: ",") + "; the hub answered \(codes("/api/sessions/move", since: sent2))")
            settle(1.0)
        }
    }
}

extension SelfTestBoard {
    /// UPD-003: the stopped update's toast, its Try again pressed: the hub's setup runs again with --retry, and the toast goes.
    func updTryAgainPressed() {
        var ran: [[String]] = []
        AppInstall.testSetup = { args in DispatchQueue.main.async { ran.append(args) }; return ["ok": true, "plan": "hub"] }
        defer { AppInstall.testSetup = nil }
        guard let b = board.toastButtons.first(where: { $0.title == t("update.tryAgain") }) else { check("update_try_again_runs_retry", false, "no Try again: \(board.toastTexts)"); return }
        click(b)
        check("update_try_again_runs_retry", wait(5) { ran.contains { $0.first == "hub" && $0.contains("--retry") && $0.contains("--resources") } } && !board.toastTexts.contains { $0.hasPrefix("The update to 0.1.29") },
              "setup ran: \(ran.map { $0.prefix(1).joined() + ($0.contains("--retry") ? " --retry" : "") }.joined(separator: ", ")); toasts \(board.toastTexts.count)")
    }
}
