// The card after a restart (SESS-053, RestartCard.swift), scripts/sidetest.mjs
// --screen restart: the demo hub's running file is from an older boot
// (MC_BOOT_TIME stands in for this Mac's start), with four sessions that ran
// before it and that nothing runs now (paper-boat mid-turn, notes-app,
// harbour-light on Codex, garden-planner). Stand-ins of claude and codex
// are first on the hub's PATH; each reports its SessionStart through this
// test's ravenryd a moment after it starts.
//
// - The card is in the middle, at the top where the tabs would be, with
//   Start under it: its title, the four rows in order with their chip, how
//   long each ran and what it was doing, the Mid-turn tag and note on
//   paper-boat only, Resume per row, Resume all 4 and Dismiss with its note.
// - Resume all posts to the hub; the rows go Back with Show, Resuming...,
//   Next, one at a time in order, each session's tab appearing as it comes
//   back while the card stays in front.
// - All back: their four tabs, the first in front, the toast "All 4
//   sessions are back.", and paper-boat in Needs you with "Stopped mid-turn
//   by the restart. Tell it to go on.", with no "needs you" toast for it
//   (the card says it) nor for one that needed the person before.
// Pictures: native-restart-offer-* (1280 and 900, dark and light),
// native-restart-resuming-1280-dark, native-restart-back-1280-dark.

import AppKit

extension SelfTestBoard {
    func screenRestart() {
        let hub = board.hub
        let card = board.start.restartCard
        let got = wait(30) { (hub.state?.raw["restart"] as? [String: Any]) != nil }
        let c = hub.state?.raw["restart"] as? [String: Any] ?? [:]
        check("restart_card_in_state", got, "\(c["title"] ?? "none")")
        check("restart_start_in_middle", wait(10) { self.board.front == .start && card.window != nil && !card.isHiddenOrHasHiddenAncestor }, "front \(board.front)")
        settle(0.6)
        // At the top of the middle, where the tabs would be: under the strip, over Start.
        let r = card.convert(card.bounds, to: board.root)
        let mid = board.start.convert(board.start.bounds, to: board.root)
        check("restart_card_at_the_top_of_the_middle", r.minX >= mid.minX && r.maxX <= mid.maxX && r.minY - mid.minY < 60 && r.width >= 560, "card \(r), middle \(mid)")
        let rows = card.rows
        check("restart_four_rows_in_order", rows.map { $0["project"] as? String ?? "" } == ["paper-boat", "notes-app", "harbour-light", "garden-planner"], rows.map { $0["project"] as? String ?? "" }.joined(separator: ","))
        let texts = allText(card)
        check("restart_card_words", texts.contains("4 sessions were running before the restart") && texts.contains { $0.hasPrefix("This Mac restarted at ") && $0.hasSuffix("Each one picks up its conversation in its own folder, with its own assistant.") }
              && texts.contains("Dismiss keeps them in Recently closed on the Sessions page, each with Reopen."), texts.prefix(6).joined(separator: " | "))
        check("restart_row_words", texts.contains("Claude Opus 5.5") && texts.contains("Codex gpt-5.4") && texts.contains("Ran 2 h 10 min") && texts.contains("Was working: rendering the tilt frames") && texts.filter { $0 == "At its prompt" }.count == 3,
              texts.filter { $0.hasPrefix("Ran ") || $0.hasPrefix("Was ") || $0.contains("Opus") || $0.contains("Codex") }.joined(separator: " | "))
        check("restart_mid_turn_on_paper_boat_only", texts.filter { $0 == "Mid-turn" }.count == 1 && texts.contains { $0.hasPrefix("It stopped in the middle of a turn.") }, "")
        check("restart_buttons", card.controls.keys.filter { $0.hasPrefix("resume:") }.count == 4 && (card.controls["all"] as? RButton)?.title == "Resume all 4" && (card.controls["dismiss"] as? RButton)?.title == "Dismiss",
              card.controls.keys.sorted().joined(separator: ","))
        let tabs0 = board.ws.tabs.count
        pictures("restart-offer")
        size(1280, 820)
        settle(0.4)

        // Resume all: one at a time, in order.
        guard let all = card.controls["all"] as? RButton else { return check("restart_resume_all_pressed", false, "no button") }
        all.performClick(nil)
        check("restart_resume_all_posted", wait(5) { hub.sentBodies.contains { $0.path == "/api/restart/resume" && $0.body["sessionId"] == nil } }, hub.sent.suffix(3).joined(separator: ", "))
        var seen: [[String]] = []
        var shot = false
        let done = wait(90) {
            let s = card.drawnStates
            if seen.last != s { seen.append(s) }
            // A picture while one is back, the next resumes and two wait.
            if !shot, s == ["back", "resuming", "next", "next"] {
                shot = true
                // Drawn first (the card was just rebuilt), then the picture.
                self.board.render(force: true)
                card.layoutSubtreeIfNeeded()
                self.settle(0.3)
                self.picture("native-restart-resuming-1280-dark.png")
            }
            return (hub.state?.raw["restart"] as? [String: Any])?["phase"] as? String == "done"
        }
        check("restart_all_back", done, seen.suffix(3).map { $0.joined(separator: ",") }.joined(separator: " / "))
        check("restart_one_at_a_time", seen.allSatisfy { $0.filter { $0 == "resuming" }.count <= 1 } && seen.contains(["resuming", "next", "next", "next"]) && seen.contains(["back", "back", "resuming", "next"]),
              seen.map { $0.joined(separator: ",") }.joined(separator: " / "))
        check("restart_resuming_picture", shot, "")
        // Each tab as it came back, while the card stayed in front.
        let tabsDuring = board.log.filter { $0.hasPrefix("restart: ") && $0.contains(" back in pane ") }
        check("restart_tabs_as_they_come_back", tabsDuring.count == 4, tabsDuring.joined(separator: " | "))
        check("restart_back_tabs_in_front", wait(10) { self.board.front == .tab && self.board.ws.tabs.count >= tabs0 + 4 && self.board.restartTabs.count == 4
            && self.board.ws.active?.has(self.board.restartTabs[0]) == true }, "front \(board.front), tabs \(board.ws.tabs.count) (were \(tabs0)), active \(board.ws.active?.id ?? "none")")
        check("restart_toast", wait(5) { self.board.log.contains("toast All 4 sessions are back.") }, board.log.filter { $0.hasPrefix("toast ") }.suffix(3).joined(separator: " | "))
        // No "needs you" toast while the card was on screen: not the card's own mid-turn session, not one from before the window opened.
        check("restart_no_needs_you_toast", !board.log.contains { $0.hasPrefix("toast ") && $0.contains(" needs you") } && board.log.contains { $0.hasSuffix(": on the restart card, no toast") },
              board.log.filter { $0.hasPrefix("toast ") || $0.hasPrefix("arrived ") }.joined(separator: " | "))
        let you = wait(20) { hub.state?.sections.first { $0.group == "you" }?.projects.contains { p in p.rows.contains { $0.line == "Stopped mid-turn by the restart. Tell it to go on." } } == true }
        check("restart_mid_turn_needs_you", you, hub.state?.sections.map { "\($0.group): \($0.projects.map { $0.id }.joined(separator: ","))" }.joined(separator: " | ") ?? "")
        settle(1.2)
        board.render(force: true)
        settle(0.4)
        picture("native-restart-back-1280-dark.png")
    }

    /// Every label's words in a view, in order.
    private func allText(_ v: NSView) -> [String] {
        var out: [String] = []
        func walk(_ x: NSView) {
            if x.isHidden { return }
            if let f = x as? NSTextField { out.append(f.stringValue) }
            for s in x.subviews { walk(s) }
        }
        walk(v)
        return out
    }
}
