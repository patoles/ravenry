// The marks on tabs not on screen (sidetest.mjs --screen tabmarks): a
// second shell prints and rings its bell while the first is in front (the
// daemon's pane.activity and pane.bell), a question waits in its pane (an
// open checkpoint there, as the hub lists it), and an agent's own pane
// holds its lease (ravenryd new and lease, typed in the first shell). Each
// shows on its tab until the tab is opened.

import AppKit

extension SelfTestBoard {
    private func model(_ id: String) -> TabModel? { board.ws.bar.items.first { $0.model.id == id }?.model }
    private func send(_ pane: String, _ text: String) {
        board.ws.conn.request("pane.send", ["pane": pane, "input": [["text": text, "mode": "paste"], ["key": "Enter"]]])
    }

    func screenTabMarks() {
        let ws = board.ws
        guard wait(10, { ws.active != nil }), let first = ws.active else { check("marks_first_tab", false); return }
        ws.newTab(nil)
        guard wait(5, { ws.tabs.count == 2 && ws.active !== first }), let second = ws.active else { check("marks_second_tab", false); return }
        settle(1.2)
        ws.show(first)
        settle(1.2)
        check("marks_none_at_first", model(second.id).map { !$0.bell && !$0.activity && $0.dot == nil } ?? false)
        send(second.host, "printf 'building the tiles\\n'")
        check("marks_activity_dot", wait(6) { self.model(second.id)?.activity == true }, "\(String(describing: model(second.id)))")
        check("marks_no_dot_on_front", model(first.id)?.activity == false)
        send(second.host, "printf 'done\\a\\n'")
        check("marks_bell", wait(6) { self.model(second.id)?.bell == true })
        // An agent in the second shell reports it waits on the person, then that it works (ravenryd hook, as its hooks do).
        let bin = Bundle.main.bundlePath + "/Contents/MacOS/ravenryd"
        send(second.host, "echo '{}' | '\(bin)' hook --assistant aider --event Notification --state needs_you --need question")
        check("marks_agent_waits_dot", wait(6) { self.model(second.id)?.dot == "you" }, "\(model(second.id)?.dot ?? "nil") state \(ws.paneInfo(second.host)?.agentState ?? "nil") \(ws.paneInfo(second.host)?.agent ?? "nil")")
        send(second.host, "echo '{}' | '\(bin)' hook --assistant aider --event PreToolUse --state working")
        check("marks_agent_works_dot", wait(6) { self.model(second.id)?.dot == "work" }, "\(model(second.id)?.dot ?? "nil")")
        // A question waiting in the second shell's pane: its dot in the colour of Needs you.
        board.hub.testCheckpoints = [["id": "cptab1", "kind": "ask", "state": "open", "title": "Ship it?", "pane": second.host, "created_at": ISO8601DateFormatter().string(from: Date())]]
        board.render(force: true)
        check("marks_waiting_dot", wait(3) { self.model(second.id)?.dot == "you" }, "\(model(second.id)?.dot ?? "nil")")
        // An agent's own panes: the first beside its shell, the next a tab of its own holding its lease.
        send(first.host, "'\(bin)' new --name 'dev server' -- /bin/sleep 600 >/dev/null; id=$('\(bin)' new --name 'tile cache' -- /bin/sleep 600) && '\(bin)' lease $id --ttl 10m >/dev/null 2>&1 &")
        check("marks_lent_badge", wait(10) { ws.tabs.count == 3 && ws.tabs.count > 1 && self.model(ws.tabs[1].id)?.lent == "An agent" }, ws.tabs.map { "\($0.host)+\($0.guest ?? "-") \(self.model($0.id)?.lent ?? "")" }.joined(separator: ","))
        check("marks_lent_tab_after_owner", ws.tabs.firstIndex { $0 === first } == 0 && first.guest != nil && ws.tabs.count == 3 && ws.label(ws.tabs[1].host).name == "tile cache" && ws.label(ws.tabs[1].host).sub == "An agent's" && ws.tabs[2] === second)
        let strip = ws.bar.items.first { $0.model.id == second.id }
        check("marks_tab_widens", (strip?.idealWidth(withSub: false) ?? 0) > 100, "\(strip?.idealWidth(withSub: false) ?? 0)")
        pictures("tabmarks")
        ws.show(first)
        // Opened: its bell and dot go; the waiting dot stays while the question does.
        ws.show(second)
        check("marks_cleared_when_opened", model(second.id).map { !$0.bell && !$0.activity && $0.dot == "you" } ?? false)
        ws.show(first)
        board.hub.testCheckpoints = nil
        board.render(force: true)
        check("marks_waiting_dot_goes", wait(3) { self.model(second.id)?.dot == "work" })
    }
}
