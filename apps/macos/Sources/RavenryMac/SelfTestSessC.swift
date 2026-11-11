// --screen sessions, PANEL-029 (called at the end of screenSessions): the
// panel of a tab whose session left the board says what was last known, its
// last turn too, and its Move here is the hub's move, resumed in a pane here.

import AppKit

extension SelfTestBoard {
    func offBoardMoveHere() {
        let hub = board.hub, ws = board.ws, pn = board.panel
        guard let st = hub.state, let p = st.projects.first(where: { pr in pr.machine == nil && pr.sessions.contains { $0.sessionId != nil && !$0.surfaceId.hasPrefix("ravenry:") && !$0.conversation.isEmpty } }),
              let s = p.sessions.first(where: { $0.sessionId != nil && !$0.surfaceId.hasPrefix("ravenry:") && !$0.conversation.isEmpty }),
              let tb = ws.tabs.first else { check("offboard_session", false, "no session with a last turn"); return }
        let pane = tb.host
        let last = s.conversation.last ?? [:]
        let lastText = (last["text"] as? String).map { String($0.prefix(40)) } ?? ""
        let apply = { (f: (([String: Any]) -> [String: Any])?) in
            hub.testPatch = f
            hub.testCheckpoints = hub.state?.checkpoints
            self.settle(0.4); self.board.render(force: true); self.settle(0.3)
        }
        let withPane = { (keep: Bool) -> ([String: Any]) -> [String: Any] in
            { st in
                var st = st
                var ps = st["projects"] as? [[String: Any]] ?? []
                for i in ps.indices where ps[i]["id"] as? String == p.id {
                    var ss = ps[i]["sessions"] as? [[String: Any]] ?? []
                    if keep { for k in ss.indices where ss[k]["surfaceId"] as? String == s.surfaceId { ss[k]["pane"] = pane } } else { ss = ss.filter { $0["surfaceId"] as? String != s.surfaceId } }
                    ps[i]["sessions"] = ss
                }
                st["projects"] = ps
                return st
            }
        }
        apply(withPane(true))
        ws.bar.onSelect?(tb.id)
        _ = wait(4) { self.board.render(force: true); return pn.shows == "session" }
        apply(withPane(false))
        check("offboard_last_turn", wait(4) { self.board.render(force: true); return pn.shows == "offboard" } && shows(pn, "Not running now") && (lastText.isEmpty || texts(pn).contains { $0.contains(lastText.prefix(30)) }),
              "\(pn.shows) last \(lastText) | " + texts(pn).prefix(12).joined(separator: " | "))
        pictures("sessions-offboard-last")
        let n = hub.sent.count, tabs0 = ws.tabs.count
        check("offboard_move_here_button", pn.buttons["move"] != nil, pn.buttons.keys.sorted().joined(separator: ","))
        pn.buttons["move"]?.performClick(nil)
        check("offboard_move_here_posts", wait(10) { hub.answers.contains { $0.seq >= n && $0.path == "/api/sessions/move" && $0.code == 200 } },
              "\(hub.sentBodies.dropFirst(n).map { "\($0.path) \($0.body["sessionId"] ?? "")" }) \(hub.answers.filter { $0.seq >= n }.map { "\($0.path) \($0.code)" })")
        apply(nil)
        hub.testCheckpoints = nil
        check("offboard_move_here_resumed", wait(15) { ws.tabs.count > tabs0 || ws.tabs.contains { t in ws.paneInfo(t.host)?.labels["ravenry.session"] != nil } }, "tabs \(tabs0) -> \(ws.tabs.count)")
    }
}
