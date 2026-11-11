// Reduced motion (A11Y-010, Motion.swift), in sidetest.mjs --screen strip:
// a tab dragged past another, the other moves into its place at once under
// reduced motion and slides there otherwise; the filmstrip's play holds each
// frame at least half a second under reduced motion.

import AppKit

extension SelfTestBoard {
    func motionChecks() {
        let ws = board.ws, bar = ws.bar
        while ws.tabs.count < 3 { ws.newTab(nil); settle(0.4) }
        board.render(force: true)
        settle(0.4)
        // A tab dragged over its right neighbour's middle: that neighbour takes its place.
        func swap(reduced: Bool) -> (atOnce: Bool, after: Bool, detail: String) {
            Motion.test = reduced
            defer { Motion.test = nil }
            guard bar.items.count >= 2 else { return (false, false, "\(bar.items.count) tabs") }
            let a = bar.items[0], b = bar.items[1]
            let wasA = a.slot
            let wp = bar.convert(NSPoint(x: b.frame.midX, y: bar.bounds.height - 10), to: nil)
            bar.beginDrag(a, at: a.frame.midX)
            bar.drag(a, to: NSPoint(x: b.slot.maxX + 4, y: b.frame.midY), window: wp)
            // Right after: where the neighbour is drawn now, against its new place.
            let atOnce = abs(b.frame.minX - b.slot.minX) < 0.5 && abs(b.slot.minX - wasA.minX) < 0.5
            let shown = b.frame
            settle(0.35)
            let after = abs(b.frame.minX - b.slot.minX) < 0.5
            bar.endDrag(a, window: wp)
            settle(0.3)
            return (atOnce, after, "neighbour drawn at \(shown.minX) right after, its place \(b.slot.minX), then \(b.frame.minX)")
        }
        let red = swap(reduced: true)
        check("motion_reduced_tab_at_once", red.atOnce && red.after, red.detail)
        let full = swap(reduced: false)
        check("motion_tab_slides", !full.atOnce && full.after, full.detail)

        // The filmstrip's play: under reduced motion, every frame held at least 0.5 s.
        guard let fv = ws.focusedView else { check("motion_film_pane", false); return }
        // Frames a quarter of a second apart.
        for k in 1...8 { ws.conn(of: fv.pane).request("pane.send", ["pane": fv.pane, "input": [["text": "echo motion line \(k)", "mode": "paste"], ["key": "Enter"]]]); settle(0.25) }
        settle(0.6)
        if !ws.film.isOpen { _ = bar.filmButton.accessibilityPerformPress() }
        guard wait(10, { ws.film.isOpen && !ws.film.loading && ws.film.frames.count >= 3 }) else {
            check("motion_film_frames", false, "open \(ws.film.isOpen) frames \(ws.film.frames.count)")
            return
        }
        func play(reduced: Bool) -> [Double] {
            Motion.test = reduced
            defer { Motion.test = nil }
            ws.film.step(-1000)
            ws.film.play()
            settle(1.8)
            if ws.film.playing { ws.film.play() }
            return ws.film.playGaps
        }
        let gr = play(reduced: true)
        check("motion_reduced_film_holds", !gr.isEmpty && gr.allSatisfy { $0 >= 0.5 }, gr.map { String(format: "%.2f", $0) }.joined(separator: ","))
        let gf = play(reduced: false)
        check("motion_film_plays_at_its_pace", !gf.isEmpty && gf.count > gr.count, "gaps \(gf.map { String(format: "%.2f", $0) }.joined(separator: ",")) (\(gf.count) in 1.8 s; reduced \(gr.count))")
        (ws.film.controls["close"] as? RButton)?.run?()
        settle(0.3)
    }
}

extension SelfTestBoard {
    /// A11Y-004: Ideas (its lane heads and idea cards), Plans (its rows) and
    /// Ship (its cards): every view that takes a press as a button says what
    /// it is (an accessibility label, the words VoiceOver reads), as the
    /// audit's scan of the app's AX tree found none did.
    func a11yLabelChecks() {
        for key in ["ideas", "plans", "ship"] {
            if let r = board.sidebar.rows["page:\(key)"] { click(r) }
            let fp = board.files
            let drawn = wait(10) { fp.key == key && fp.view?["key"] as? String == key && self.board.root.middle === fp }
            settle(0.5)
            var pressable: [NSView] = []
            func walk(_ v: NSView) {
                if v.isHiddenOrHasHiddenAncestor { return }
                if v.isAccessibilityElement() && v.accessibilityRole() == .button && !(v is NSButton) { pressable.append(v) }
                v.subviews.forEach(walk)
            }
            walk(fp)
            let unlabeled = pressable.filter { ($0.accessibilityLabel() ?? "").isEmpty }
            check("a11y_\(key)_cards_labelled", drawn && !pressable.isEmpty && unlabeled.isEmpty,
                  "\(pressable.count) pressable, \(unlabeled.count) without a label; e.g. \(pressable.prefix(4).map { "\"\($0.accessibilityLabel() ?? "")\"" }.joined(separator: ", "))")
        }
    }
}
