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
        // Its header: the name, then the agent's chip (no session runs in the owner's shell here: "Agent").
        board.render(force: true)
        settle(0.3)
        let head = ws.boxes[own]?.headView
        head?.display()
        check("panes_agent_chip", head?.badge == "Agent" && head?.badgeRect != nil && !(head?.isHidden ?? true), "\(head?.badge ?? "none") \(head?.badgeRect ?? .zero)")
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

        // An approved command (ravenry approve in a shell of its own, approved here as the person
        // does): its pane opens beside the asking pane, as the card says, and goes when it ends.
        let tabsA = ws.tabs.count
        ws.newTab(in: nil)
        guard wait(5, { ws.tabs.count > tabsA }), let askTab = ws.tabs.last else { check("panes_approve_shell", false); return }
        let asker = askTab.host
        var typed = false
        ws.conn.request("pane.send", ["pane": asker, "input": [["text": "'\(bin)' approve 'echo approved-ran; sleep 4' >/dev/null 2>&1 &", "mode": "paste"], ["key": "Enter"]]]) { r in if case .success = r { typed = true } }
        let hub0 = board.hub
        var cpId: String?
        check("panes_approve_asked", wait(10) { typed && { cpId = hub0.daemonCps.items.values.first { $0.cp["kind"] as? String == "approve" && $0.cp["pane"] as? String == asker && $0.cp["state"] as? String == "open" }?.cp["id"] as? String; return cpId != nil }() })
        if let id = cpId {
            var took = false
            hub0.answerCheckpoint(id, ["approve": true]) { ok, _ in took = ok }
            check("panes_approved_run_beside", wait(10) { took && askTab.guest.map { ws.paneInfo($0)?.labels["ravenry.checkpoint"] == id } == true },
                  "tabs \(ws.tabs.map { "\($0.host)+\($0.guest ?? "-")" })")
            check("panes_approved_run_named", askTab.guest.map { ws.label($0).name.hasPrefix("Approved: echo approved-ran") } == true, askTab.guest.map { ws.label($0).name } ?? "none")
            board.render(force: true)
            settle(0.4)
            picture("native-panes-approved-run.png")
            check("panes_approved_run_goes", wait(12) { askTab.guest == nil }, askTab.guest ?? "")
        }

        // Panes it uses, in the panel of the session whose agent runs in the owner's shell:
        // its own (the dev server) and a shell of the person's lent to it, which another agent waits for
        // (the lease as the daemon's pane.list says it).
        let tabs0 = ws.tabs.count
        ws.newTab(in: nil)
        guard wait(5, { ws.tabs.count > tabs0 }), let other = ws.tabs.last?.host else { check("panes_uses_second_shell", false); return }
        let soon = ISO8601DateFormatter().string(from: Date().addingTimeInterval(600)), ago = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-60))
        ws.paneInfo(other)?.lease = ["holder": ["kind": "agent", "pane": owner], "acquired_at": ago, "expires_at": soon, "waiting": [["kind": "agent", "pane": own]]]
        let hub = board.hub
        hub.testPatch = { st in
            var st = st
            var ps = st["projects"] as? [[String: Any]] ?? []
            for i in ps.indices where ps[i]["id"] as? String == "notes-app" {
                var ss = ps[i]["sessions"] as? [[String: Any]] ?? []
                if !ss.isEmpty { ss[0]["pane"] = owner }
                ps[i]["sessions"] = ss
            }
            st["projects"] = ps
            return st
        }
        hub.testCheckpoints = []
        guard let s0 = hub.state?.project("notes-app")?.sessions.first else { check("panes_uses_session", false); return }
        board.pickSession("notes-app/\(s0.surfaceId)", why: "test")
        let otherName = ws.label(other).name
        check("panes_uses_section", wait(5) { self.shows(self.board.panel, "Panes it uses") } && shows(board.panel, "dev server") && shows(board.panel, "Its own") && shows(board.panel, "Yours, lent") && shows(board.panel, otherName),
              texts(board.panel).joined(separator: " | "))
        check("panes_uses_waiting", shows(board.panel, "An agent is waiting for the \(otherName).") && board.usesButtons["handOver:\(other)"] != nil, texts(board.panel).joined(separator: " | "))
        pictures("panes-uses")
        board.pickSession("notes-app/\(s0.surfaceId)", why: "test")
        let m = board.leaseActs.count
        if let b = board.usesButtons["handOver:\(other)"] { click(b) }
        check("panes_uses_hand_over", wait(5) { self.board.leaseActs.count > m && self.board.leaseActs.last == "hand \(other)" }, board.leaseActs.joined(separator: ","))
        hub.testPatch = nil
        hub.testCheckpoints = nil
    }
}
