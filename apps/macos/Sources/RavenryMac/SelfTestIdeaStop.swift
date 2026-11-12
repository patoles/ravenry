// IDEA-009 on the clock (sidetest.mjs --screen ideastop): an idea's reply
// and a brainstorm stop when the board's time is up, one at a time each.
// The board's limit is its claudeTimeoutMs setting (3 minutes when unset,
// hub/server/config.mjs); the demo board here has it at a few seconds
// (RAVENRY_MAC_IDEA_STOP_MS says how many), and its stand-in for claude
// (hub/tools/stub-claude.mjs) never answers a message or a seed with SLOW
// in it, so the stop is the board's. Each step presses the window's own
// button and reads what the page draws and what the board keeps.

import AppKit

extension SelfTestBoard {
    func screenIdeaStop() {
        let limitMs = Int(ProcessInfo.processInfo.environment["RAVENRY_MAC_IDEA_STOP_MS"] ?? "") ?? 0
        check("istop_limit_given", limitMs >= 1000, "RAVENRY_MAC_IDEA_STOP_MS \(limitMs)")
        let stopped = "No answer after \(limitMs / 1000) seconds, so it was stopped."
        let pg = board.idea
        // JSON's null comes as NSNull.
        let none = { (x: Any?) -> Bool in x == nil || x is NSNull }

        // MARK: an idea's reply
        board.openPage("idea:demo-tidepool", t("idea.ideas"))
        check("istop_idea_opens", wait(6) { pg.ideas != nil && self.shows(pg, "A tide pool you look after") })
        if let f = pg.fields["say"] { typeIn(f, "SLOW: think it over with the tides") }
        var n = board.hub.sent.count
        let t0 = Date()
        pg.buttons["send"]?.performClick(nil)
        check("istop_reply_posts", wait(4) { self.board.hub.answers.contains { $0.seq >= n && $0.path == "/api/ideas/demo-tidepool/say" && $0.code == 200 } }, sentSince(n).joined(separator: ","))
        check("istop_reply_running_drawn", wait(6) { self.shows(pg, t("idea.answering")) && pg.buttons["send"]?.isEnabled == false },
              "send enabled \(pg.buttons["send"]?.isEnabled ?? true) | \(texts(pg).suffix(4).joined(separator: " | "))")
        picture("native-ideastop-reply-running.png")
        // One at a time: while it runs the board takes no second message (the window's Send is off, above).
        var second = 0
        board.hub.post("/api/ideas/demo-tidepool/say", ["text": "And another thing", "images": [String]()]) { code, _ in second = code }
        check("istop_reply_one_at_a_time", wait(4) { second != 0 } && second == 409, "the board answered \(second)")
        // The board's stop: the error in the thread, drawn as one; the running line gone; Send back.
        let errDrawn = { () -> Bool in pg.dirty(); pg.redraw(); return self.texts(pg).contains { $0.contains(stopped) } && !self.shows(pg, t("idea.answering")) }
        let stoppedIn = wait(Double(limitMs) / 1000 + 15) { errDrawn() }
        let took = Date().timeIntervalSince(t0)
        check("istop_reply_stopped_drawn", stoppedIn && pg.buttons["send"]?.isEnabled == true,
              String(format: "%.1f s after Send (limit %d ms) | ", took, limitMs) + texts(pg).suffix(4).joined(separator: " | "))
        check("istop_reply_stopped_on_time", stoppedIn && took >= Double(limitMs) / 1000 - 0.5 && took <= Double(limitMs) / 1000 + 6, String(format: "%.1f s", took))
        // What the board keeps: the error as the thread's last message, nothing pending.
        var kept: [String: Any]? = nil
        board.hub.get("/api/ideas") { _, j in kept = (j["ideas"] as? [[String: Any]])?.first { $0["id"] as? String == "demo-tidepool" } }
        _ = wait(4) { kept != nil }
        let last = (kept?["thread"] as? [[String: Any]])?.last
        check("istop_reply_stopped_kept", none(kept?["pending"]) && last?["error"] as? Bool == true && (last?["text"] as? String ?? "").hasPrefix(stopped),
              "pending \(kept?["pending"] ?? "none"), last \(last ?? [:])")
        picture("native-ideastop-reply-stopped.png")
        // After the stop a new message goes again.
        if let f = pg.fields["say"] { typeIn(f, "Shorter then: one creature or two?") }
        n = board.hub.sent.count
        pg.buttons["send"]?.performClick(nil)
        check("istop_reply_again_after_stop", wait(4) { self.board.hub.answers.contains { $0.seq >= n && $0.path == "/api/ideas/demo-tidepool/say" && $0.code == 200 } }
              && wait(10) { pg.dirty(); pg.redraw(); return self.texts(pg).contains { $0.hasPrefix("Stub reply") && $0.contains("one creature or two?") } }, texts(pg).suffix(3).joined(separator: " | "))

        // MARK: a brainstorm
        let fp = board.files
        if let r = board.sidebar.rows["page:ideas"] { click(r) } else { board.openPage("ideas", "Ideas") }
        check("istop_ideas_opens", wait(10) { fp.key == "ideas" && fp.view?["key"] as? String == "ideas" && self.board.root.middle === fp })
        if let f = fp.fields["seed"] { typeIn(f, "a lighthouse keeper game SLOW") }
        n = board.hub.sent.count
        let t1 = Date()
        if let b = fp.pb["bs:go"] as? NSButton ?? fp.buttons["bs:go"] { b.performClick(nil) }
        check("istop_brainstorm_posts", wait(4) { self.board.hub.answers.contains { $0.seq >= n && $0.path == "/api/ideas/brainstorm" && $0.code == 200 } }, sentSince(n).joined(separator: ","))
        let running = { self.texts(fp).contains { $0.contains("is thinking up 3 directions for \"a lighthouse keeper game SLOW\"") } }
        check("istop_brainstorm_running_drawn", wait(6) { self.board.render(); return running() }, texts(fp).prefix(14).joined(separator: " | "))
        // Its seconds go up while it runs (the line is read again each second).
        let secsNow = { () -> Int in
            guard let l = self.texts(fp).first(where: { $0.contains("s so far") }), let r = l.range(of: "\\d+(?= s so far)", options: .regularExpression) else { return -1 }
            return Int(l[r]) ?? -1
        }
        let s1 = secsNow()
        settle(2.2)
        board.render()
        let s2 = secsNow()
        check("istop_brainstorm_seconds_count", s1 >= 0 && s2 > s1, "\(s1) s, then \(s2) s")
        twoPictures("ideastop-brainstorm-running")
        var second2 = 0
        board.hub.post("/api/ideas/brainstorm", ["seed": "a second seed"]) { code, _ in second2 = code }
        check("istop_brainstorm_one_at_a_time", wait(4) { second2 != 0 } && second2 == 409, "the board answered \(second2)")
        let bsStopped = wait(Double(limitMs) / 1000 + 15) { self.board.render(); return self.texts(fp).contains { $0.contains(stopped) } && fp.pb["bs:clear"] != nil && !running() }
        let took2 = Date().timeIntervalSince(t1)
        check("istop_brainstorm_stopped_drawn", bsStopped, String(format: "%.1f s after the press | ", took2) + texts(fp).prefix(14).joined(separator: " | "))
        check("istop_brainstorm_stopped_on_time", bsStopped && took2 >= Double(limitMs) / 1000 - 0.5 && took2 <= Double(limitMs) / 1000 + 7, String(format: "%.1f s", took2))
        var j0: [String: Any]? = nil
        board.hub.get("/api/ideas") { _, j in j0 = j }
        _ = wait(4) { j0 != nil }
        check("istop_brainstorm_stopped_kept", none(j0?["brainstorm"]) && (j0?["brainstormError"] as? String ?? "").hasPrefix(stopped)
              && !((j0?["ideas"] as? [[String: Any]]) ?? []).contains { ($0["status"] as? String ?? "").contains("lighthouse keeper") }, "\(j0?["brainstormError"] ?? "none")")
        twoPictures("ideastop-brainstorm-stopped")
        // Clear puts the stopped one away, for good.
        n = board.hub.sent.count
        if let b = fp.pb["bs:clear"] as? NSButton ?? fp.buttons["bs:clear"] { b.performClick(nil) }
        var j1: [String: Any]? = nil
        let cleared = wait(5) { self.board.hub.answers.contains { $0.seq >= n && $0.path == "/api/ideas/brainstorm/clear" && $0.code == 200 } }
        board.hub.get("/api/ideas") { _, j in j1 = j }
        check("istop_brainstorm_clear", cleared && wait(4) { j1 != nil } && none(j1?["brainstormError"]) && wait(5) { self.board.render(); return !self.texts(fp).contains { $0.contains(stopped) } && fp.pb["bs:clear"] == nil },
              "\(j1?["brainstormError"] ?? "none")")
    }

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
}
