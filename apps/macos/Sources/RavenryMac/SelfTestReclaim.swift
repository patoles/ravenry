// PHONE-019: a pane drawn at a size the Mac's view did not ask for (an
// older phone app resized it to a phone's size, and the person's session
// stayed that small) gets the view's own size back: the view sees the
// daemon's frames at the other size and asks for its own (reclaimSize in
// TerminalView.swift). Checked where it lands: the daemon's pane.list.

import AppKit

extension SelfTest {
    func reclaim() {
        let v: TerminalView? = main { workspace.focusedView }
        guard let v else { check("reclaim_view", false, "no view in front"); return }
        let pane = main { v.pane }
        let grid = main { v.gridSize }
        func size() -> (Int, Int)? {
            let panes = ((try? workspace.conn.call("pane.list", [:]))?["panes"] as? [[String: Any]]) ?? []
            guard let p = panes.first(where: { ($0["id"] as? String) == pane }) else { return nil }
            return ((p["cols"] as? NSNumber)?.intValue ?? 0, (p["rows"] as? NSNumber)?.intValue ?? 0)
        }
        let before = size()
        // As a phone app before 0.1.42 did: a resize to a phone's size from outside the view.
        _ = try? workspace.conn.call("pane.resize", ["pane": pane, "cols": 40, "rows": 30])
        let small = waitFor(3) { self.size2(size) == "40x30" }
        let back = waitFor(6) { self.size2(size) == "\(grid.cols)x\(grid.rows)" }
        check("reclaim_mac_takes_its_size_back", small && back, "view \(grid.cols)x\(grid.rows); before \(before.map { "\($0.0)x\($0.1)" } ?? "?"), resized from outside to 40x30 (seen: \(small)), then \(size2(size))")
    }

    private func size2(_ f: () -> (Int, Int)?) -> String { f().map { "\($0.0)x\($0.1)" } ?? "?" }
}
