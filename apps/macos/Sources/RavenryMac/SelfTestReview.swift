// A worktree session's review (sidetest.mjs --screen review): notes-app is
// a git repository whose session works in a worktree of two commits (the
// hub's real diff, comments and merge routes, on the demo hub), its files
// as the hub works them out (filesview.mjs, with another session's change
// to the same file), and the session running in a pane of this window's
// daemon (its panel shows what a Ravenry session's does).

import AppKit

extension SelfTestBoard {
    func screenReview() {
        guard let fx = ProcessInfo.processInfo.environment["RAVENRY_MAC_FILES"], let d = try? Data(contentsOf: URL(fileURLWithPath: fx)),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let path = j["path"] as? String, let answer = j["answer"] as? [String: Any] else { check("review_fixture", false); return }
        let hub = board.hub
        hub.testAnswers[path] = answer
        let pane = board.ws.active?.host ?? ""
        // The session runs in this window's daemon, done with its turn.
        hub.testPatch = { st in
            var st = st
            var ps = st["projects"] as? [[String: Any]] ?? []
            for i in ps.indices where ps[i]["id"] as? String == "notes-app" {
                var ss = ps[i]["sessions"] as? [[String: Any]] ?? []
                if !ss.isEmpty { ss[0]["pane"] = pane; ss[0]["state"] = "idle" }
                ps[i]["sessions"] = ss
            }
            st["projects"] = ps
            return st
        }
        hub.testCheckpoints = []
        guard let p = hub.state?.project("notes-app"), let s = p.sessions.first else { check("review_session", false); return }
        let key = "notes-app/\(s.surfaceId)"
        check("review_worktree_in_state", s.worktree?["state"] as? String == "open" && s.worktree?["branch"] as? String == "ravenry/sync-settings", "\(s.worktree ?? [:])")
        board.pickSession(key, why: "test")
        let wc = board.worktrees
        check("review_card_asks", wait(8) { self.shows(self.board.panel, "Claude is done and asks for a review") && wc.buttons["review"] != nil }, texts(board.panel).prefix(12).joined(separator: " | "))
        check("review_its_copy", shows(board.panel, "Its copy") && shows(board.panel, "sync-settings") && shows(board.panel, "Merge removes the copy and keeps the branch"))
        check("review_files_section", wait(6) { self.shows(self.board.panel, "Files it changed") && self.shows(self.board.panel, "app/settings-screen.js") }, texts(board.panel).joined(separator: " | "))
        check("review_files_clash", shows(board.panel, "Codex, in Offline mode, changed this file too") && shows(board.panel, "Each has its own copy, so it shows when you merge.") && wc.buttons["seeBoth:app/sync.js"] != nil)
        check("review_files_read_only", shows(board.panel, "read only"))
        check("review_files_counts", shows(board.panel, "2 files, +5 −1"), texts(board.panel).filter { $0.contains("file") }.joined(separator: " | "))
        pictures("review-panel")
        board.pickSession(key, why: "test")
        wc.buttons["seeAll"]?.performClick(nil)
        let g = board.filesGrid
        check("review_grid_opens", wait(3) { self.board.root.middle === g } && shows(g, "Who changed what in notes-app") && shows(g, "Offline mode") && shows(g, "You"), texts(g).prefix(12).joined(separator: " | "))
        check("review_grid_rows", shows(g, "app/sync.js") && shows(g, "NOTES.md") && shows(g, "read"))
        pictures("review-grid")
        g.buttons["close"]?.performClick(nil)
        board.pickSession(key, why: "test")
        _ = wait(4) { wc.buttons["review"] != nil }
        wc.buttons["review"]?.performClick(nil)
        let rv = board.review
        check("review_opens_beside_panel", wait(3) { self.board.root.middle === rv && !self.board.root.wideMiddle && self.board.panel.key == key && self.board.root.panelMode == .docked }, "\(board.front)")
        check("review_diff_read", wait(8) { (rv.diff?["files"] as? [Any])?.count == 2 && rv.sel != nil && !rv.lines.isEmpty }, "\(rv.diff?["error"] ?? "") \(rv.lines.count)")
        check("review_clean", shows(rv, "No clashes with main") && shows(rv, "2 files, +5 −1") && shows(rv, "Sync settings, ready to merge"), texts(rv).prefix(10).joined(separator: " | "))
        // Its head names where it was opened from (none from a terminal tab: the class of Simon's brief with no way back).
        check("review_back_link", (rv.buttons["back"]?.title).map { $0 == "‹  " + (self.board.backName ?? "") } ?? (board.backName == nil),
              "\(rv.buttons["back"]?.title ?? "none") backName \(board.backName ?? "nil")")
        rv.select("app/sync.js")
        check("review_file_picked", rv.sel == "app/sync.js" && rv.lines["new:3"] != nil && rv.lines["old:2"] != nil, rv.lines.keys.sorted().joined(separator: ","))
        // A line longer than the view scrolls sideways, whole; the line under the pointer shows its + (group A 29, 30).
        let ds = rv.diffScroll
        let need = ds.minWidth
        ds.minWidth = 3000
        ds.layoutSubtreeIfNeeded()
        check("review_long_lines_scroll", ds.hasHorizontalScroller && (ds.documentView?.frame.width ?? 0) >= 3000 && need > 62, "doc \(Int(ds.documentView?.frame.width ?? 0)), longest line \(Int(need))")
        ds.minWidth = need
        if let ln = rv.lines["new:3"] { ln.hovering = true; check("review_hover_plus", ln.plusMark?.isHidden == false); ln.hovering = false }
        // Left alone, it is not drawn again (the board's states and the comments read every 3 s change nothing).
        let d0 = rv.draws
        settle(7)
        check("review_not_redrawn_idle", rv.draws == d0, "drawn \(rv.draws - d0) times in 7 s")
        // A single click on a line's words reaches it (docked beside the panel) but is not a comment,
        // as in the Electron app, where the number is the button; a double click there is.
        if let ln = rv.lines["new:2"] {
            let p0 = ln.presses
            ln.scrollToVisible(ln.bounds)
            click(ln, at: NSPoint(x: ln.bounds.midX, y: ln.bounds.midY))
            check("review_click_words_reaches_line", ln.presses == p0 + 1 && rv.composing == nil, "presses \(ln.presses - p0)")
            click(ln, at: NSPoint(x: ln.bounds.midX, y: ln.bounds.midY), count: 2)
            check("review_double_click_words", wait(2) { rv.composing?.line == 2 }, "\(String(describing: rv.composing))")
            rv.buttons["cancelComment"]?.performClick(nil)
            settle(0.2)
        } else { check("review_click_words_reaches_line", false, rv.lines.keys.sorted().joined(separator: ",")) }
        // A click on its number, by the mouse: a comment on that line.
        var hitName = "none"
        if let ln = rv.lines["new:3"] {
            ln.scrollToVisible(ln.bounds)
            window.contentView?.layoutSubtreeIfNeeded()
            let at = NSPoint(x: 17, y: ln.bounds.midY)
            let w = ln.convert(at, to: nil)
            if let root = window.contentView?.superview, let hv = root.hitTest(root.convert(w, from: nil)) {
                var chain: [String] = []; var x: NSView? = hv
                while let c = x { chain.append("\(type(of: c))\(c.isHidden ? "(hidden)" : "")"); x = c.superview }
                hitName = "\(type(of: hv)) \(hv === ln ? "(the line)" : "") chain \(chain.joined(separator: "<")) front \(board.front) middle \(board.root.middle.map { "\(type(of: $0))" } ?? "nil") line in window \(ln.window != nil) at \(w) composing \(String(describing: rv.composing))"
            }
            click(ln, at: at)
        }
        check("review_compose_on_line", wait(2) { rv.composing?.line == 3 && rv.composing?.side == "new" && rv.composer != nil }, "hit \(hitName)")
        var n = hub.sentBodies.count
        rv.composer?.string = "Keep the check, but log when sync is off"
        rv.buttons["addComment"]?.performClick(nil)
        check("review_comment_kept", wait(6) { rv.comments.count == 1 && rv.composing == nil } && hub.sentBodies.dropFirst(n).contains { $0.path.hasSuffix("/review/comment") && $0.body["line"] as? Int == 3 && $0.body["file"] as? String == "app/sync.js" }, "\(rv.comments)")
        check("review_comment_waits", shows(rv, "Not sent yet") && rv.buttons["send"]?.title == "Send 1 comment")
        pictures("review")
        board.openReview(key)
        n = hub.sentBodies.count
        rv.buttons["send"]?.performClick(nil)
        check("review_send_posts", wait(6) { hub.sentBodies.dropFirst(n).contains { $0.path.hasSuffix("/review/send") } && !rv.busy })
        if let id = rv.comments.first?["id"] as? String, rv.comments.first?["state"] as? String == "pending" {
            rv.buttons["takeBack:\(id)"]?.performClick(nil)
            check("review_take_back", wait(6) { rv.comments.isEmpty })
        } else { check("review_take_back", rv.comments.first?["state"] as? String == "sent", "\(rv.comments)") }
        n = hub.sentBodies.count
        rv.buttons["merge"]?.performClick(nil)
        check("review_merge_posts", wait(10) { hub.sentBodies.dropFirst(n).contains { $0.path.hasSuffix("/merge") && $0.body["mode"] as? String == "ff" } && self.board.root.middle !== rv }, "\(board.front)")
        check("review_merged_card", wait(10) { self.shows(self.board.panel, "Merged into main") && wc.buttons["unmerge"] != nil }, texts(board.panel).prefix(10).joined(separator: " | "))
        pictures("review-merged")
        board.pickSession(key, why: "test")
        _ = wait(4) { wc.buttons["deleteBranch"] != nil }
        n = hub.sentBodies.count
        wc.buttons["deleteBranch"]?.performClick(nil)
        check("review_delete_branch", wait(8) { hub.sentBodies.dropFirst(n).contains { $0.path.hasSuffix("/delete-branch") } && self.shows(self.board.panel, "is deleted too") }, toasts(since: 0).suffix(2).joined(separator: ","))
        n = hub.sentBodies.count
        wc.buttons["unmerge"]?.performClick(nil)
        check("review_unmerge_posts", wait(8) { hub.sentBodies.dropFirst(n).contains { $0.path.hasSuffix("/unmerge") } }, toasts(since: 0).suffix(2).joined(separator: ","))
        hub.testPatch = nil
        hub.testCheckpoints = nil
    }
}
