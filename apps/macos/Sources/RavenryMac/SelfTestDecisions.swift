// The self-test of Decisions (scripts/sidetest.mjs --screen decisions), on
// the demo hub with the ledger of decisions-fixture.mjs: a decision
// replaced by a newer one, one for every project, an edited one, one said
// in a session, one read many times, over several days; then an agent
// saves one inside its undo minute (arrive-1) and replaces one (arrive-2),
// as `ravenry decide` would. Each control is pressed as the person would
// and what the hub was asked, the page shows or the toast says is read back.

import AppKit

extension SelfTestBoard {
    func screenDecisions() {
        let pg = board.decisions
        let side = board.sidebar
        guard let row = side.rows["page:decisions"] else { check("dec_row", false); return }
        click(row)
        check("dec_row_opens_page", board.front == .page("decisions", t("side.decisions")) && board.root.middle === pg, "\(board.front)")
        check("dec_drawn", wait(8) { pg.view != nil && self.shows(pg, "A week is too early in a cold spring") }, texts(pg).prefix(10).joined(separator: " | "))
        check("dec_sidebar_count", wait(8) { side.decisions == (5, false) && self.shows(side.rows["page:decisions"]!, "5") }, "\(side.decisions)")
        check("dec_head_and_count", shows(pg, t("dec.src")) && shows(pg, "6 decisions, 1 replaced") && pg.cards["dold2345"] == nil && pg.cards.count == 5, texts(pg).prefix(12).joined(separator: " | "))
        check("dec_days_newest_first", { let x = texts(pg); let a = x.firstIndex { $0.hasPrefix("Today, ") }, b = x.firstIndex { $0.hasPrefix("Yesterday, ") }
            return a != nil && b != nil && a! < b! }(), texts(pg).filter { $0.contains(", ") && $0.count < 20 }.joined(separator: " | "))
        check("dec_replaces_crossed", shows(pg, "Replaces what you said on") && shows(pg, "Planting reminders go out a week before sowing."))
        check("dec_where_and_who", shows(pg, "said in Planting reminders") && shows(pg, "said in Tilting the hull") && shows(pg, "you added it") && shows(pg, "Every project") && shows(pg, "garden-planner"), texts(pg).joined(separator: " | "))
        check("dec_reads", shows(pg, "Read 7 times today") && shows(pg, "Read 23 times today") && shows(pg, "Read once today") && shows(pg, "Read twice"))
        pictures("decisions")
        // A wrapping text first laid out narrow (a page drawn before it had
        // its width) widens with its row: the replaces line and the count.
        for (name, wide) in [("replaces_row", true), ("count_by_spring", false)] {
            let w = wrap("Replaces what you said on Fri Nov 6, 09:12", Fonts.pt(12), "tx2")
            let row = wide ? boxed(hstack([Icon("undo", "tx3", size: 14), w], spacing: 8), fill: "card2", radius: 6, insets: NSEdgeInsets(top: 7, left: 10, bottom: 7, right: 10))
                : hstack([label("Holds now", Fonts.pt(12)), spring(), w], spacing: 8)
            let host = Flipped(frame: NSRect(x: 0, y: 0, width: 30, height: 600))
            host.addSubview(row)
            NSLayoutConstraint.activate([row.leadingAnchor.constraint(equalTo: host.leadingAnchor), row.trailingAnchor.constraint(equalTo: host.trailingAnchor), row.topAnchor.constraint(equalTo: host.topAnchor)])
            host.layoutSubtreeIfNeeded(); host.layoutSubtreeIfNeeded()
            host.setFrameSize(NSSize(width: 700, height: 600))
            for _ in 0..<3 { host.layoutSubtreeIfNeeded() }
            check("dec_wrap_widens_\(name)", w.text.frame.width > 200 && w.text.frame.height < 30, "\(w.text.frame)")
        }

        // Holds now, Replaced, All.
        guard let tabs = pg.tabs, tabs.segs.count == 3 else { check("dec_tabs", false); finishDecisions(); return }
        tabs.segs[1].performClick(nil)
        check("dec_tab_replaced", wait(5) { pg.asked.contains("show=replaced") && self.shows(pg, "Replaced yesterday at 16:40") && !self.shows(pg, "No em dashes") }, pg.asked + " " + texts(pg).suffix(6).joined(separator: " | "))
        pg.tabs?.segs[2].performClick(nil)
        check("dec_tab_all", wait(5) { pg.asked.contains("show=all") && self.shows(pg, "No em dashes") && self.shows(pg, "Replaced yesterday at 16:40") }, pg.asked)
        pg.tabs?.segs[0].performClick(nil)
        check("dec_tab_now", wait(5) { pg.asked.contains("show=now") && !self.shows(pg, "Replaced yesterday") }, pg.asked)

        // The project menu.
        let titles = pg.projectMenu.items.map { $0.title }
        check("dec_menu_lists_projects", titles.first == t("dec.allProjects") && titles.contains("garden-planner") && titles.contains("recipe-box") && !titles.contains(t("dec.everyProject")), titles.joined(separator: ","))
        if let i = pg.projectMenu.items.firstIndex(where: { $0.title == "garden-planner" }) { pg.projectMenu.performActionForItem(at: i) }
        check("dec_menu_picks_project", wait(5) { pg.asked.contains("only=garden-planner") && self.shows(pg, "first warm day") && !self.shows(pg, "No em dashes") && self.shows(pg, "garden-planner") }, pg.asked)
        pg.projectMenu.performActionForItem(at: 0)
        check("dec_menu_all_projects", wait(5) { pg.asked.contains("only=&") && self.shows(pg, "No em dashes") }, pg.asked)

        // The search.
        guard let f = pg.fields["search"] else { check("dec_search_field", false); finishDecisions(); return }
        typeIn(f, "warm DAY")
        check("dec_search_asks_hub", wait(5) { pg.asked.hasSuffix("search=warm%20DAY") && self.shows(pg, "first warm day") && !self.shows(pg, "hull tilts") }, pg.asked)
        f.text = ""
        typeIn(f, "zebra")
        check("dec_search_nothing_matches", wait(5) { self.shows(pg, t("dec.nothingMatches")) }, texts(pg).suffix(3).joined(separator: " | "))
        f.text = ""
        pg.load()
        _ = wait(5) { self.shows(pg, "hull tilts") }

        // An agent saves one: the toast with Undo and Show, the card lit with Just now and Undo, the dot.
        var n = board.log.count
        check("dec_agent_saves", arrival(1))
        check("dec_toast_saved", wait(8) { self.toasts(since: n).contains("Saved your decision: the sail.") } && board.toastButtons.map { $0.title } == [t("dec.undo"), t("dec.show")],
              toasts(since: n).joined(separator: ",") + " " + board.toastButtons.map { $0.title }.joined(separator: ","))
        check("dec_sidebar_dot", wait(8) { side.decisions == (6, true) }, "\(side.decisions)")
        board.toastButtons.last?.performClick(nil)
        let liveId = board.log.last { $0.hasPrefix("decisions d") }.map { String($0.dropFirst(10)) } ?? ""
        check("dec_toast_show_lights_it", !liveId.isEmpty && pg.lit == liveId && board.root.middle === pg, board.log.suffix(3).joined(separator: ","))
        check("dec_live_card", wait(5) { pg.undos[liveId] != nil && self.shows(pg.cards[liveId] ?? pg, t("dec.justNow")) && pg.cards[liveId]?.ring == "work" }, texts(pg.cards[liveId] ?? pg).joined(separator: " | "))
        picture("native-decisions-live-1280-dark.png")
        n = board.log.count
        var s = board.hub.sent.count
        pg.undos[liveId]?.performClick(nil)
        check("dec_card_undo_posts", wait(5) { self.sentSince(s).contains("POST /api/decisions/undo") }, sentSince(s).joined(separator: ","))
        check("dec_card_undo_done", wait(8) { self.toasts(since: n).contains(t("dec.undone")) && !self.shows(pg, "The sail stays white") && side.decisions == (5, false) }, toasts(since: n).joined(separator: ",") + " \(side.decisions)")

        // An agent replaces one: the toast's own Undo brings the old one back.
        n = board.log.count
        check("dec_agent_replaces", arrival(2))
        check("dec_toast_replaced", wait(8) { self.toasts(since: n).contains(t("dec.replacedToast")) } && board.toastButtons.count == 2, toasts(since: n).joined(separator: ","))
        check("dec_replaced_drops_old", wait(5) { self.shows(pg, "Reminders go out at 8 in the morning.") && pg.cards["dnew2345"] == nil }, texts(pg).prefix(8).joined(separator: " | "))
        s = board.hub.sent.count
        n = board.log.count
        board.toastButtons.first?.performClick(nil)
        check("dec_toast_undo_posts", wait(5) { self.sentSince(s).contains("POST /api/decisions/undo") }, sentSince(s).joined(separator: ","))
        check("dec_toast_undo_done", wait(8) { self.toasts(since: n).contains(t("dec.undone")) && !self.shows(pg, "8 in the morning") && pg.cards["dnew2345"] != nil }, toasts(since: n).joined(separator: ","))

        // Two saved close together (the hub's group, server/push.mjs groupDecision): one
        // toast, the second updating the first, with the count and the latest, and Undo for both.
        let until = ISO8601DateFormatter().string(from: When.now().addingTimeInterval(60))
        let saved = { (id: String, quote: String, scope: String, ids: [String], words: String) in
            self.board.onDecision(["type": "saved", "undo_until": until, "decision": ["id": id, "by": "agent", "quote": quote, "scope": scope, "overrides": [], "undo_until": until],
                                   "group": ["id": "dec:\(ids[0])", "ids": ids, "count": ids.count, "words": words, "undo_until": until]])
        }
        saved("dgrpaaaa", "The dock is on the right.", "dock", ["dgrpaaaa"], "Saved your decision: the dock.")
        saved("dgrpbbbb", "The dock hides in full screen.", "dock in full screen", ["dgrpaaaa", "dgrpbbbb"], "Saved 2 decisions, the latest on the dock in full screen.")
        let saidNow = board.toastTexts.filter { $0.hasPrefix("Saved") }
        check("dec_group_one_toast_updated", saidNow == ["Saved 2 decisions, the latest on the dock in full screen."] && board.toastButtons.map { $0.title } == [t("dec.undo"), t("dec.show")],
              board.toastTexts.joined(separator: ",") + " " + board.toastButtons.map { $0.title }.joined(separator: ","))
        board.toastStack.drop(key: "decision")
        screenDecisionsMore()
        finishDecisions()
    }

    /// The empty ledger, as the Electron app's reference shows it.
    private func finishDecisions() {
        let pg = board.decisions
        board.openDecisions()
        settle(5.5)
        pg.apply(["ok": true, "total": 0, "active": 0, "replaced": 0, "undoable": false, "projects": [], "days": [], "empty": "none"])
        check("dec_empty", shows(pg, t("dec.empty")) && shows(pg, "0 decisions"), texts(pg).joined(separator: " | "))
        pictures("decisions-empty")
    }
}
