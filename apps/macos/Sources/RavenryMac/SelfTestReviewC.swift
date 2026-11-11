// --screen review, what the first round left (called at the end of
// screenReview): See both changes opens the project's grid; a clash in the
// same folder says whoever saves last wins (the hub's `same`, drawn from its
// answer); after Undo the merge the card asks again and Merge without
// reviewing merges (the hub's merge route) and the merged card says the
// files and commits that are on main now.

import AppKit

extension SelfTestBoard {
    func reviewScopeC(key: String, filesPath: String) {
        let hub = board.hub, wc = board.worktrees
        // PANEL-013: See both changes.
        board.pickSession(key, why: "test")
        _ = wait(6) { self.board.render(force: true); return wc.buttons["seeBoth:app/sync.js"] != nil }
        wc.buttons["seeBoth:app/sync.js"]?.performClick(nil)
        let g = board.filesGrid
        check("review_see_both_opens_grid", wait(3) { self.board.root.middle === g } && shows(g, "Who changed what in notes-app") && shows(g, "app/sync.js"), "\(board.front)")
        g.buttons["close"]?.performClick(nil)
        // The same file changed in the same folder (no copy of its own): the words for it.
        if var a = hub.testAnswers[filesPath] {
            var ss = a["sessions"] as? [[String: Any]] ?? []
            for i in ss.indices {
                var fs = ss[i]["files"] as? [[String: Any]] ?? []
                for k in fs.indices where fs[k]["clash"] is [String: Any] { var c = fs[k]["clash"] as! [String: Any]; c["same"] = true; fs[k]["clash"] = c }
                ss[i]["files"] = fs
            }
            a["sessions"] = ss
            hub.testAnswers[filesPath] = a
        }
        board.pickSession(key, why: "test")
        check("review_files_same_folder_words", wait(10) { self.board.render(force: true); return self.shows(self.board.panel, "Both are in the same folder, so whoever saves last wins.") }, texts(board.panel).filter { $0.contains("changed this file") }.joined(separator: " | "))
        pictures("review-same-folder")
        // PANEL-014: after Undo the merge the card asks again; Merge without reviewing merges, and says what is on main now.
        _ = wait(10) { self.board.render(force: true); return wc.buttons["mergeWithout"] != nil }
        let n = hub.sentBodies.count
        wc.buttons["mergeWithout"]?.performClick(nil)
        check("review_merge_without_reviewing", wait(10) { hub.answers.contains { $0.seq >= n && $0.path.hasSuffix("/merge") && $0.code == 200 } }
              && wait(10) { self.board.render(force: true); return self.shows(self.board.panel, "Merged into main") }, "\(hub.sentBodies.dropFirst(n).map { $0.path }) \(hub.answers.filter { $0.seq >= n }.map { "\($0.path) \($0.code)" })")
        check("review_its_commits", wait(8) { self.board.render(force: true); return self.texts(self.board.panel).contains { $0.contains("are on main now") && $0.contains("commit") } },
              texts(board.panel).filter { $0.contains("main now") }.joined(separator: " | "))
    }
}
