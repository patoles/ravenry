// The self-test's terminal rows of the build2 round (SelfTest.swift runs
// it before the tabs): every check drives the view with the events a
// person's hands make (keys through the window, the wheel from a CGEvent,
// a tab switch with Cmd+T and Cmd+1) and reads where the effect lands: the
// daemon's input log (pane.inputs), the frames' offset and rows, and the
// pixels drawn.
//
// - PANEL-011: keys with Left between them; the shell runs what Typed
//   here says.
// - TERM-041: the agents' symbols drawn in the text's colour from
//   Ravenry's glyph font, not as colour emoji.
// - TERM-007: a tab switch keeps a scrolled pane where it was, rows
//   printed meanwhile counted, and never shows the live screen between.

import AppKit

extension SelfTest {
    private func scrTerm<T>(_ f: (Screen) -> T) -> T {
        view.screen.lock()
        defer { view.screen.unlock() }
        return f(view.screen)
    }

    /// Types text with real key events, one a character, through the window.
    private func typeKeys(_ s: String) {
        // The US layout's key codes of the letters these checks type.
        let codes: [Character: UInt16] = ["e": 0x0E, "c": 0x08, "h": 0x04, "o": 0x1F, "n": 0x2D, "x": 0x07, " ": 0x31]
        for ch in s {
            let code = codes[Character(ch.lowercased())] ?? 0
            deliver(String(ch), code: code, flags: ch.isUppercase ? .shift : [])
        }
    }

    private func pictureTerm() -> (bytes: [UInt8], w: Int, h: Int) {
        guard let img: CGImage = main({ view.draw(sync: false); return view.snapshotImage() }) else { return ([], 0, 0) }
        let w = img.width, h = img.height
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        bytes.withUnsafeMutableBytes { p in
            let ctx = CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
            ctx?.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        return (bytes, w, h)
    }

    private func savePicture(_ name: String) {
        let img: CGImage? = main { view.draw(sync: false); return view.snapshotImage() }
        guard let img else { return }
        let url = URL(fileURLWithPath: out).deletingLastPathComponent().appendingPathComponent(name)
        try? NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:])?.write(to: url)
    }

    func termItems() {
        typedLineCursor()
        agentGlyphs()
        scrollKeptAcrossTabs()
    }

    // MARK: PANEL-011

    private func typedLineCursor() {
        let left = String(UnicodeScalar(NSLeftArrowFunctionKey)!)
        main { view.sendEvents([["text": "\u{15}"]]) }
        sleep(0.2)
        typeKeys("echo one")
        deliver(left, code: 0x7B)
        deliver(left, code: 0x7B)
        typeKeys("X")
        deliver("\r", code: 0x24)
        let ran = waitFor(5) { self.scrTerm { s in (0..<s.rows).contains { s.rowText($0) == "oXne" } } }
        var shown = ""
        _ = waitFor(5) {
            let r = try? self.workspace.conn.call("pane.inputs", ["pane": self.view.pane], timeout: 3)
            let last = (r?["inputs"] as? [[String: Any]])?.last { ($0["shown"] as? String ?? "").contains("echo o") }
            // Keys a display sends close together gather into one record: its last line entered.
            shown = (last?["shown"] as? String ?? "").components(separatedBy: "\n").last ?? ""
            return shown == "echo oXne"
        }
        check("typed_here_follows_cursor", ran && shown == "echo oXne", "the shell printed oXne: \(ran); Typed here's last line \"\(shown)\"")
    }

    // MARK: TERM-041

    private func agentGlyphs() {
        // ⏺ U+23FA, ★ U+2605, ⚠ U+26A0, ✻ U+273B, ✓ U+2713, ⠋ U+280B, ⎿ U+23BF, ⏵ U+23F5, ⏸ U+23F8.
        let line = "sym: \u{23FA} \u{2605} \u{26A0} \u{273B} \u{2713} \u{280B} \u{23BF} \u{23F5} \u{23F8}"
        main { view.sendEvents([["text": "printf '%s\\n' '\(line)'\r"]]) }
        guard waitFor(5, { self.scrTerm { s in (0..<s.rows).contains { s.rowText($0) == line } } }) else {
            return check("glyphs_line", false, scrTerm { $0.text() })
        }
        sleep(0.3)
        let row = scrTerm { s in (0..<s.rows).first { s.rowText($0) == line } ?? 0 }
        let p = pictureTerm()
        let f = view.renderer.fonts
        let pad = Int((view.renderer.padding * f.scale).rounded())
        let cw = Int(f.cellWidth), ch = Int(f.cellHeight)
        var detail: [String] = []
        var ok = true
        func ink(_ col: Int) -> (lit: Int, chroma: Int) {
            var lit = 0, chroma = 0
            for y in pad + row * ch ..< min(p.h, pad + (row + 1) * ch) {
                for x in pad + col * cw ..< min(p.w, pad + (col + 1) * cw) {
                    let k = (y * p.w + x) * 4
                    let b = Int(p.bytes[k]), g = Int(p.bytes[k + 1]), r = Int(p.bytes[k + 2])
                    if max(r, g, b) > 90 {
                        lit += 1
                        chroma = max(chroma, max(r, g, b) - min(r, g, b))
                    }
                }
            }
            return (lit, chroma)
        }
        for (i, col) in [5, 7, 9, 11, 13, 15, 17, 19, 21].enumerated() {
            let (lit, chroma) = ink(col)
            // Drawn (some ink), in the text's grey, not an emoji's colours,
            // and inside its cell (the spaces either side stay blank).
            let spill = ink(col - 1).lit + ink(col + 1).lit
            if lit < 8 || chroma > 40 || spill > 0 { ok = false }
            detail.append("\(Array(line.unicodeScalars)[5 + 2 * i].escaped(asASCII: true)) \(lit) px chroma \(chroma) spill \(spill)")
        }
        // The ones the terminal's font (Menlo) lacks come from the glyph font (before: STIX Two Math and Hiragino).
        let fromFont = ["\u{23FA}", "\u{23BF}", "\u{23F5}", "\u{23F8}"].allSatisfy { s in
            var sized: [CTFont]?
            return GlyphFont.face(for: s, base: f.regular, sized: &sized) != nil
        }
        check("glyphs_agent_symbols_text", ok && fromFont && !GlyphFont.faces.isEmpty,
              "faces \(GlyphFont.faces.count), from the glyph font \(fromFont); " + detail.joined(separator: ", "))
        // Asked for as an emoji (U+FE0F), it stays one.
        var sized: [CTFont]?
        check("glyphs_emoji_asked_stays", GlyphFont.face(for: "\u{26A0}\u{FE0F}", base: f.regular, sized: &sized) == nil)
        savePicture("selftest-glyphs.png")
    }

    // MARK: TERM-007

    private func scrollKeptAcrossTabs() {
        let v = view
        // Output that comes while the tab is behind: 41 rows a second from now.
        main { v.sendEvents([["text": "\u{15}clear; seq 1 200; (sleep 1.2; seq 1000 1040) &\r"]]) }
        _ = waitFor(5) { self.scrTerm { s in (0..<s.rows).contains { s.rowText($0).hasSuffix("~ >") || s.rowText($0).hasPrefix("[1]") } } }
        sleep(0.3)
        let cg = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: 6, wheel2: 0, wheel3: 0)!
        main { v.scrollWheel(with: NSEvent(cgEvent: cg)!) }
        _ = waitFor(3) { self.scrTerm { $0.offset } > 0 }
        let before = scrTerm { ($0.offset, $0.history, $0.rowText(0)) }
        // Cmd+T: a new tab in front, this one behind (no stream).
        let n0 = main { workspace.tabs.count }
        deliver("t", code: 0x11, flags: .command)
        _ = waitFor(3) { self.main { self.workspace.tabs.count } == n0 + 1 && !v.live }
        sleep(2.0)
        // Every draw from the switch back on: its top row.
        var tops: [String] = []
        main { v.onDraw = { _, _ in v.screen.lock(); tops.append(v.screen.rowText(0)); v.screen.unlock() } }
        deliver("1", code: 0x12, flags: .command)
        let settled = waitFor(3) { self.scrTerm { $0.offset } > before.0 && self.scrTerm { $0.history } > before.1 }
        sleep(0.3)
        main { v.onDraw = nil }
        let after = scrTerm { ($0.offset, $0.history, $0.rowText(0)) }
        let grew = after.1 - before.1
        check("tab_switch_keeps_scroll", settled && after.2 == before.2 && after.0 == before.0 + grew && grew >= 41,
              "before offset \(before.0) history \(before.1) top \"\(before.2)\"; after offset \(after.0) history \(after.1) top \"\(after.2)\"")
        check("tab_switch_no_live_flash", !tops.isEmpty && tops.allSatisfy { $0 == before.2 }, "draws' top rows \(Set(tops))")
        savePicture("selftest-scroll-kept.png")
        // Back to the live screen; the extra tab closed.
        main { v.scrollToBottom(nil) }
        _ = waitFor(3) { self.scrTerm { $0.offset } == 0 }
        deliver("2", code: 0x13, flags: .command)
        deliver("w", code: 0x0D, flags: .command)
        _ = waitFor(3) { self.main { self.workspace.tabs.count } == n0 }
        deliver("1", code: 0x12, flags: .command)
        _ = waitFor(3) { v.live }
    }
}
