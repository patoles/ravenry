// --screen cards on real checkpoints: sidetest.mjs has agents in panes of the
// test daemon ask, propose a command, ask for a secret and show a pick
// (ravenry ask/approve/secret/pick), several of each, and the demo hub follows
// that daemon (RAVENRY_DAEMON_BIN). The fixture's cards keep their words; an
// answer that should land goes to a fresh real checkpoint (the card's `real`
// ids), so the hub takes it with a 2xx and the agent gets it, and one that
// should be refused goes to the card's made-up id, which the hub refuses.

import AppKit

extension SelfTestBoard {
    /// The `kind` card answered next on its real copy `n`, or on its made-up id (nil).
    func useCard(_ kind: String, real n: Int?) {
        guard var cps = board.hub.testCheckpoints, let i = cps.firstIndex(where: { $0["kind"] as? String == kind }) else { return }
        let fake = cps[i]["fakeId"] as? String ?? cps[i]["id"] as? String ?? ""
        let real = cps[i]["real"] as? [String] ?? []
        cps[i]["fakeId"] = fake
        cps[i]["id"] = n.flatMap { real.indices.contains($0) ? real[$0] : nil } ?? fake
        // The keyboard out of the card first: the panel keeps a card the person is typing in through a refresh.
        window.makeFirstResponder(nil)
        board.hub.testCheckpoints = cps
        // Until the panel's card is that checkpoint (a card drawn for the one before would answer it).
        let want = cps[i]["id"] as? String ?? ""
        let shows = { self.board.panel.shownCard?.id == want }
        if !wait(3, shows) {
            // The panel still on the card that just closed: its session picked again draws the open one.
            board.pickSession("\(cps[i]["projectId"] as? String ?? "")/\(cps[i]["surfaceId"] as? String ?? "")", why: "test")
            if !wait(3, shows) {
                // Drawn again whatever the panel's signature says: if this shows it, the panel missed a redraw.
                board.render(force: true)
                let forced = wait(2, shows)
                let fr = window.firstResponder.map { String(describing: type(of: $0)) } ?? "none"
                let open = board.hub.state?.checkpoints.filter { $0["kind"] as? String == kind }.map { "\($0["id"] ?? "")/\($0["state"] ?? "")" } ?? []
                check("cards_real_\(kind)_\(n.map(String.init) ?? "made_up")_shown", false, "forced redraw \(forced ? "shows it" : "does not show it either"); panel card \(board.panel.shownCard?.id ?? "none"), want \(want); keyboard \(fr); state \(open)")
            }
        }
        settle(0.2)
    }

    /// The id the `kind` card answers now.
    func cardId(_ kind: String) -> String { board.hub.testCheckpoints?.first { $0["kind"] as? String == kind }?["id"] as? String ?? "" }

    /// The hub's answer to the last POST to `path`: its status.
    func lastStatus(_ path: String) -> Int? { board.hub.answers.last { $0.path == path }?.code }

    /// The answer posted after `n` (sentBodies' count before the press) reached
    /// the hub for the `kind` card's checkpoint now, and the hub took it (200).
    func landed(after n: Int, _ kind: String) -> Bool {
        wait(6) {
            let mine = self.board.hub.answers.filter { $0.seq >= n && $0.path == "/api/checkpoints/answer" }
            return mine.last?.code == 200 && self.board.hub.sentBodies.dropFirst(n).last { $0.path == "/api/checkpoints/answer" }?.body["id"] as? String == self.cardId(kind)
        }
    }
}
