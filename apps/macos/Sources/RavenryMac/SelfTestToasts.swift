// The toasts' place (scripts/sidetest.mjs --screen toasts): at the top right
// of the terminal, under the head of its top right pane, never over a pane's
// last six rows (the prompt and the input line, 2026-11-26: "on mac the
// notifications cover the typing area") or its cursor's line, nor a pane
// head's buttons, nor the phone card, and inside the window: at 1280, narrow
// with the panel hidden, at the window's smallest, in a split, and with a
// page in front.
// SIDETEST_FILM_CONTENT=PATH runs that zsh script in the pane (a Claude
// screen, say) in place of its own lines.

import AppKit

extension SelfTestBoard {
    func screenToasts() {
        let ws = board.ws
        let own = ProcessInfo.processInfo.environment["RAVENRY_MAC_FILM_CONTENT"].flatMap { $0.isEmpty ? nil : $0 }
        // A busy screen: a long output, then a prompt with words typed on its last line.
        let lines = "i=1; while [ $i -le 200 ]; do echo \"line $i of the session's output, the quick brown fox jumps over the lazy dog\"; i=$((i+1)); done; "
            + "printf '%s\\n' '----------------------------------------' '> keep the typing area clear' '----------------------------------------'; printf '  accept edits on'; while :; do sleep 1; done"
        let cmd = own.map { ["/bin/zsh", $0] } ?? ["/bin/sh", "-c", lines]
        guard let id = ((try? ws.conn.call("pane.new", ["cols": 120, "rows": 40, "name": "claude", "labels": [:] as [String: String], "cwd": ws.home, "command": cmd], timeout: 5))?["pane"] as? [String: Any])?["id"] as? String,
              let tab = ws.tab(showing: id) ?? { _ = wait(5) { ws.tab(showing: id) != nil }; return ws.tab(showing: id) }() else {
            return check("toasts_pane", false, "no pane")
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        size(1280, 820)
        ws.show(tab)
        settle(1.5)
        check("toasts_tab_in_front", board.front == .tab, "\(board.front)")

        func three() {
            board.toastStack.clear()
            board.toast("paper-boat needs you: Tilt the hull with the slope too, or keep it level?", actions: [("Show", {})], key: "toasts-needs", seconds: .infinity)
            board.toast(t("dec.savedScope", ["scope": "toast placement on the Mac"]), actions: [(t("dec.undo"), {}), (t("dec.show"), {})], key: "decision", seconds: 60)
            board.toast(t("move.notDone", ["why": "the board answered 500"]), actions: [], key: nil, seconds: 60)
        }
        three()
        clearOfTyping("1280")
        check("toasts_1280_all_three", board.toastStack.items.filter { !$0.isHidden }.count == 3, board.toastTexts.joined(separator: " | "))
        // Right-aligned, 14 pt in from the pane's right edge.
        if let b = topRight() {
            let pr = b.convert(b.bounds, to: board.root), st = board.toastStack.frame
            check("toasts_1280_top_right", abs(st.maxX - (pr.maxX - 14)) < 1 && abs(st.minY - (pr.minY + Design.headHeight + 10)) < 1, "stack \(st) pane \(pr)")
            check("toasts_right_aligned", board.toastStack.items.allSatisfy { abs($0.frame.maxX - st.width) < 1 }, board.toastStack.items.map { "\($0.frame)" }.joined(separator: " "))
        }
        picture("native-toasts-top-right-1280.png")

        // Narrow, the panel hidden: the words wrap, the stack stays in.
        size(900, 600)
        clearOfTyping("narrow")
        check("toasts_narrow_panel_hidden", board.root.panelMode != .docked, "\(board.root.panelMode)")
        picture("native-toasts-top-right-900.png")
        // The phone card open beside them.
        board.openPhone()
        settle(0.4)
        clearOfTyping("narrow_phone")
        let pc = board.phoneCard
        check("toasts_clear_of_phone_card", pc.isOpen && !pc.frame.intersects(board.toastStack.frame), "card \(pc.frame) stack \(board.toastStack.frame)")
        picture("native-toasts-phone-900.png")
        pc.close()
        settle(0.3)

        // The window at its smallest: the older ones wait, the newest shows, in the
        // window. (A pane of eight rows has no room above its last six: not asked there.)
        let m = window.contentMinSize
        size(m.width, m.height)
        clearOfTyping("smallest", typing: false)
        check("toasts_smallest_newest_shows", board.toastStack.items.last?.isHidden == false && board.toastTexts.count == 3, board.toastTexts.joined(separator: " | "))
        size(1280, 820)
        clearOfTyping("back_1280")
        check("toasts_back_all_three", board.toastStack.items.filter { !$0.isHidden }.count == 3)

        // Split right, then down: under the head of the pane at the top right.
        ws.split("right")
        settle(1.0)
        clearOfTyping("split_right")
        ws.split("down")
        settle(1.0)
        clearOfTyping("split_down")
        picture("native-toasts-split-1280.png")

        // A page in front: the top right of the page, in the window.
        board.openMachines()
        settle(0.6)
        three()
        board.render(force: true)
        settle(0.4)
        if let mv = board.root.middle {
            let r = mv.convert(mv.bounds, to: board.root), st = board.toastStack.frame
            check("toasts_page_top_right", r.contains(st) && abs(st.maxX - (r.maxX - 14)) < 1, "stack \(st) page \(r)")
        } else { check("toasts_page_in_front", false, "no page") }
        board.toTerminal()
        board.toastStack.clear()
    }

    /// The pane at the stage's top right (the rightmost of the top row).
    private func topRight() -> PaneBox? {
        let root = board.root
        return board.ws.boxes.values.filter { $0.window != nil && !$0.isHiddenOrHasHiddenAncestor }
            .min { a, b in
                let ra = a.convert(a.bounds, to: root), rb = b.convert(b.bounds, to: root)
                return (ra.minY.rounded(), -ra.maxX) < (rb.minY.rounded(), -rb.maxX)
            }
    }

    /// The stack shown, inside the window, off every pane's last six rows
    /// and the stage's, and off every pane head's buttons.
    private func clearOfTyping(_ tag: String, typing asked: Bool = true) {
        board.render(force: true)
        settle(0.5)
        let root = board.root, tv = board.toastStack, st = tv.frame
        check("toasts_\(tag)_shown", !tv.isHidden && st.width > 0 && st.height > 0, "\(st)")
        check("toasts_\(tag)_in_window", root.bounds.contains(st), "stack \(st) window \(root.bounds)")
        if !asked { return }
        var typing: [String] = [], heads: [String] = []
        let boxes = board.ws.boxes.values.filter { $0.window != nil && !$0.isHiddenOrHasHiddenAncestor }
        for b in boxes {
            let t = b.term, rd = t.renderer, cell = rd.fonts.cellHeight / rd.fonts.scale
            let tr = t.convert(t.bounds, to: root)
            let rows = t.gridSize.rows
            let y = tr.minY + rd.padding + CGFloat(max(0, rows - 6)) * cell
            let last6 = NSRect(x: tr.minX, y: y, width: tr.width, height: tr.maxY - y)
            if st.intersects(last6) { typing.append("\(b.name) rows \(rows) last six \(last6)") }
            // The line being typed, wherever it is (a fresh shell's prompt is at the top).
            let cur = t.convert(t.cursorRow, to: root)
            if st.intersects(cur) { typing.append("\(b.name) cursor line \(cur)") }
            for h in b.headView.buttons where !h.isHidden {
                let hr = h.convert(h.bounds, to: root)
                if st.intersects(hr) { heads.append("\(b.name) \(hr)") }
            }
        }
        // The stage's own last six rows (at the font of the pane in front).
        if let s = board.root.stage, let rd = board.ws.focusedView?.renderer {
            let sr = s.convert(s.bounds, to: root), cell = rd.fonts.cellHeight / rd.fonts.scale
            let last6 = NSRect(x: sr.minX, y: sr.maxY - 6 * cell - 2 * rd.padding, width: sr.width, height: 6 * cell + 2 * rd.padding)
            if st.intersects(last6) { typing.append("stage last six \(last6)") }
        }
        check("toasts_\(tag)_off_typing_area", typing.isEmpty, "stack \(st): " + typing.joined(separator: " | "))
        check("toasts_\(tag)_off_pane_buttons", heads.isEmpty, "stack \(st): " + heads.joined(separator: " | "))
    }
}
