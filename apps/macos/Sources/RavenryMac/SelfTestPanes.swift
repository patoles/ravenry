// The agents' own panes' self-test (sidetest.mjs --screen panes): in the
// window's first shell, a program runs as an agent does there (the daemon
// knows it by the pane it runs in): `ravenryd new` (a pane of its own,
// "dev server") and `ravenryd lease` on it, typed into the shell. The new pane opens as a split beside its owner's
// tab without the keyboard; brought to the keyboard, the strip says the
// agent has it and Take it back gives it back; its panel says who opened
// it and who can type there.

import AppKit

extension SelfTestBoard {
    func screenPanes() {
        let ws = board.ws
        guard wait(10, { ws.active != nil }), let owner = ws.active?.host else { check("panes_owner_tab", false); return }
        let before = ws.tabs.count
        let bin = Bundle.main.bundlePath + "/Contents/MacOS/ravenryd"
        let line = "id=$('\(bin)' new --name 'dev server' -- /bin/sleep 600) && '\(bin)' lease $id --ttl 10m >/dev/null 2>&1 &"
        var sent = false
        ws.conn.request("pane.send", ["pane": owner, "input": [["text": line, "mode": "paste"], ["key": "Enter"]]]) { r in if case .success = r { sent = true } }
        check("panes_agent_ran", wait(5) { sent })
        check("panes_split_beside_owner", wait(10) { ws.active?.host == owner && ws.active?.guest != nil },
              "tabs \(ws.tabs.map { "\($0.host)+\($0.guest ?? "-")" }) active \(ws.active?.host ?? "")")
        guard let tab = ws.active, let own = tab.guest else { return }
        check("panes_split_no_keyboard", tab.focus == 0 && board.front == .tab && ws.tabs.count == before)
        check("panes_split_named", ws.label(own).name == "dev server", ws.label(own).name)
        check("panes_creator_agent", ws.paneInfo(own)?.creator?["kind"] as? String == "agent" && ws.paneInfo(own)?.creator?["pane"] as? String == owner)
        check("panes_lease_seen", wait(10) { self.board.leaseOf(own) != nil })
        // The owner's pane in front: no strip (the lease is on the other one).
        board.render(force: true)
        check("panes_no_strip_on_owner", board.root.strip == nil)
        // The agent's pane gets the keyboard: the strip and its panel.
        if let t = ws.tab(showing: own) { ws.show(t) }
        board.render(force: true)
        settle(0.4)
        check("panes_strip_shown", board.root.strip?.text.contains("has this pane since") == true && board.root.strip?.buttons["takeBack"] != nil, board.root.strip?.text ?? "none")
        check("panes_strip_over_stage", (board.root.strip?.frame.maxY ?? 0) <= (ws.stage.frame.minY + 0.5) && (board.root.strip?.frame.height ?? 0) > 30, "\(board.root.strip?.frame ?? .zero) \(ws.stage.frame)")
        check("panes_panel_tag", board.panel.shows == "shell" && shows(board.panel, "An agent's pane"), texts(board.panel).prefix(6).joined(separator: " | "))
        check("panes_panel_opened_by", shows(board.panel, "Opened by An agent"), texts(board.panel).prefix(8).joined(separator: " | "))
        check("panes_who_can_type", shows(board.panel, "Who can type here") && shows(board.panel, "Always") && shows(board.panel, "Its own pane"), texts(board.panel).joined(separator: " | "))
        pictures("panes")
        if let t = ws.tab(showing: own) { ws.show(t) }
        board.render(force: true)
        let n = board.leaseActs.count
        board.root.strip?.buttons["takeBack"]?.performClick(nil)
        check("panes_take_back", wait(5) { self.board.leaseActs.count > n && self.board.leaseOf(own) == nil } && wait(3) { self.board.root.strip == nil }, board.leaseActs.joined(separator: ","))
        check("panes_take_back_toast", toasts(since: 0).contains { $0.contains("is yours again") }, toasts(since: 0).joined(separator: ","))
        // The split is kept: by daemon, in the layout file.
        ws.save()
        ws.flush()
        check("panes_split_saved", ws.tabs.contains { $0.host == owner && $0.guest == own })
    }
}
