// The session links' self-test (sidetest.mjs --screen links,
// SessionLinks.swift): Claude's name files for the demo's sessions and a
// named session that ended in lighthouse (sidetest.mjs writes them). A
// shell prints a hand-off line: each known name and id is drawn as a link
// (the link colour, underlined), the words that name nothing are not; a
// press and release on a name opens its session at once, on the board or
// continued in a pane here; a drag over one selects; ravenry://session/<name>
// opens it; and a scan of the rows is timed.

import AppKit

extension SelfTestBoard {
    func screenLinks() {
        let ws = board.ws
        let L = SessionLinks.shared
        let known = ["paper-boat-7c", "garden-planner-3f", "a1a1a1a1", "lighthouse-4d"]
        check("links_table", wait(15) { known.allSatisfy { L.target($0) != nil } }, known.map { "\($0): \(L.target($0)?.sessionId.prefix(8) ?? "none")" }.joined(separator: ", "))
        check("links_unknown_words_not_links", L.target("ravenry-99") == nil && L.target("garden-planner") == nil && L.target("old-notes") == nil)
        check("links_ended_has_its_project", L.target("lighthouse-4d")?.projectId == "lighthouse", "\(String(describing: L.target("lighthouse-4d")))")

        guard let shell = ws.tabs.first else { return check("links_shell_tab", false) }
        ws.bar.onSelect?(shell.id)
        settle(0.5)
        guard let v = ws.focusedView else { return check("links_shell_view", false) }
        let shellPane = v.pane
        let lines = ["Done for today. I've handed my open items to paper-boat-7c.",
                     "Ask garden-planner-3f, a1a1a1a1 or lighthouse-4d later; ravenry-99 and garden-planner stay plain.",
                     "Not links: /tmp/paper-boat-7c/notes, paper-boat-7c.json, me@garden-planner-3f."]
        size(1280, 820)
        settle(0.4)
        v.sendEvents([["text": "clear; printf '%s\\n' " + lines.map { "\"\($0)\"" }.joined(separator: " ") + "\r"]])
        func words() -> [String] { v.screen.lock(); defer { v.screen.unlock() }; return v.screen.nameWords }
        func row(_ s: String) -> Int { v.screen.lock(); defer { v.screen.unlock() }; return (0..<v.screen.rows).first { v.screen.rowText($0).contains(s) } ?? -1 }
        check("links_found_in_text", wait(5) { words() == known && row("handed my open items") >= 0 && row("~ > clear") < 0 }, "\(words())")
        let r1 = row("handed my open items"), r2 = row("Ask garden-planner-3f")
        let col1 = lines[0].distance(from: lines[0].startIndex, to: lines[0].range(of: "paper-boat-7c")!.lowerBound)
        let colPlain = lines[1].distance(from: lines[1].startIndex, to: lines[1].range(of: "ravenry-99")!.lowerBound)
        let colGarden = lines[1].distance(from: lines[1].startIndex, to: lines[1].range(of: "garden-planner-3f")!.lowerBound)
        let colLight = lines[1].distance(from: lines[1].startIndex, to: lines[1].range(of: "lighthouse-4d")!.lowerBound)

        // Drawn as a link at rest: the link colour and its underline, the plain word neither.
        let blue = linkPixels(v, row: r1, col: col1, len: 13), plain = linkPixels(v, row: r2, col: colPlain, len: 10)
        check("links_drawn_link_colour", blue.glyph > 20 && blue.underline > 0.9, "glyph pixels \(blue.glyph), underline \(Int(blue.underline * 100))% lit in the link colour")
        check("links_plain_word_not_drawn", plain.glyph == 0 && plain.underline < 0.1, "glyph pixels \(plain.glyph), underline \(Int(plain.underline * 100))%")
        for dark in [true, false] {
            NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            settle(0.6)
            board.render(force: true)
            settle(0.4)
            picture("native-links-1280-\(dark ? "dark" : "light").png")
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        settle(0.4)

        // The pointing hand over a link, the I-beam over a plain word.
        v.mouseMoved(with: mouse(v, .mouseMoved, col: col1 + 2, row: r1))
        let hand = v.nameHover
        v.mouseMoved(with: mouse(v, .mouseMoved, col: colPlain + 2, row: r2))
        check("links_pointing_hand", hand && !v.nameHover, "over the link \(hand), over a plain word \(v.nameHover)")

        // A drag over a link selects; nothing opens.
        let before = L.opened.count
        v.mouseDown(with: mouse(v, .leftMouseDown, col: col1, row: r1))
        for k in 1...4 { v.mouseDragged(with: mouse(v, .leftMouseDragged, col: col1 + 3 * k, row: r1)) }
        v.mouseUp(with: mouse(v, .leftMouseUp, col: col1 + 12, row: r1))
        let selected = wait(3) { v.screen.lock(); defer { v.screen.unlock() }; return v.screen.selection != nil }
        check("links_drag_selects", selected && L.opened.count == before && board.front == .tab, "selection \(selected), opened \(L.opened.count - before), front \(board.front)")

        // A plain click on a word that names nothing: nothing opens.
        clickCell(v, col: colPlain + 1, row: r2)
        check("links_plain_click_nothing", L.opened.count == before && board.front == .tab, "front \(board.front)")

        // A click on a live session's name: its session, at once (its tab, or its view as its row opens it).
        clickCell(v, col: colGarden + 4, row: r2)
        let garden = "garden-planner/" + (board.hub.state?.project("garden-planner")?.mainSession?.surfaceId ?? "?")
        check("links_click_opens_session", wait(3) { self.board.front == .session(garden) }, "front \(board.front), opened \(L.opened.suffix(1))")

        // Back to the shell; a click on the ended session's name: continued in a pane here, in front.
        ws.bar.onSelect?(shell.id)
        settle(0.5)
        let tabs = ws.tabs.count
        clickCell(v, col: colLight + 2, row: r2)
        let posted = wait(5) { self.board.hub.sentBodies.contains { $0.path == "/api/sessions/resume" && $0.body["sessionId"] as? String == "1a9b0001-0000-4000-8000-0000000000aa" } }
        let cont = wait(15) { ws.tabs.count == tabs + 1 && self.board.front == .tab && ws.focusedView?.pane != shellPane }
        let contPane = ws.focusedView?.pane ?? ""
        check("links_click_continues_ended_session", posted && cont, "resume posted \(posted), tabs \(tabs) to \(ws.tabs.count), front \(board.front), pane \(contPane)")
        // Again from the shell: the same tab, no second pane.
        ws.bar.onSelect?(shell.id)
        settle(0.5)
        clickCell(v, col: colLight + 2, row: r2)
        check("links_click_again_same_tab", wait(5) { ws.focusedView?.pane == contPane } && ws.tabs.count == tabs + 1, "pane \(ws.focusedView?.pane ?? "") tabs \(ws.tabs.count)")

        // ravenry://session/<name>: its session; a name that is nobody's: nothing.
        guard let app = NSApp.delegate as? AppDelegate else { return check("links_app", false) }
        ws.bar.onSelect?(shell.id)
        settle(0.5)
        app.application(NSApp, open: [URL(string: "ravenry://session/paper-boat-7c")!])
        let boat = "paper-boat/" + (board.hub.state?.project("paper-boat")?.mainSession?.surfaceId ?? "?")
        check("links_url_opens_session", wait(3) { self.board.front == .session(boat) }, "front \(board.front)")
        ws.bar.onSelect?(shell.id)
        settle(0.5)
        app.application(NSApp, open: [URL(string: "ravenry://session/nobody-1")!])
        settle(0.5)
        check("links_url_unknown_nothing", board.front == .tab && ws.focusedView?.pane == shellPane, "front \(board.front)")

        // The cost of a scan of the shell's rows (on the reader thread, as a frame is applied).
        let n = 2000
        v.screen.lock()
        let m = L.matcher
        let t0 = CACurrentMediaTime()
        for _ in 0..<n { v.screen.findNames(m) }
        let us = (CACurrentMediaTime() - t0) / Double(n) * 1e6
        let grid = "\(v.screen.cols)x\(v.screen.rows)"
        v.screen.unlock()
        check("links_scan_cost", us < 200, String(format: "%.1f us a scan of %@ rows with %d words that are links", us, grid, m.words.count))
    }

    /// An event at the middle of a cell of a terminal view.
    private func mouse(_ v: TerminalView, _ type: NSEvent.EventType, col: Int, row: Int) -> NSEvent {
        let f = v.renderer.fonts
        let p = NSPoint(x: v.renderer.padding + (CGFloat(col) + 0.5) * f.cellWidth / f.scale, y: v.renderer.padding + (CGFloat(row) + 0.5) * f.cellHeight / f.scale)
        return NSEvent.mouseEvent(with: type, location: v.convert(p, to: nil), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                  windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: type == .mouseMoved ? 0 : 1, pressure: type == .leftMouseUp ? 0 : 1)!
    }

    private func clickCell(_ v: TerminalView, col: Int, row: Int) {
        v.mouseDown(with: mouse(v, .leftMouseDown, col: col, row: row))
        v.mouseUp(with: mouse(v, .leftMouseUp, col: col, row: row))
        settle(0.3)
    }

    /// In the view's drawing, over `len` cells of a row: the glyph pixels in
    /// the link colour, and the share of the underline's pixels in it.
    private func linkPixels(_ v: TerminalView, row: Int, col: Int, len: Int) -> (glyph: Int, underline: Double) {
        v.draw(sync: false)
        guard row >= 0, let img = v.snapshotImage() else { return (0, 0) }
        let w = img.width, h = img.height
        var px = [UInt8](repeating: 0, count: w * h * 4)
        px.withUnsafeMutableBytes { p in
            CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)?.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        let f = v.renderer.fonts, c = v.renderer.theme.link
        let pad = Int((v.renderer.padding * f.scale).rounded()), cw = Int(f.cellWidth), ch = Int(f.cellHeight)
        func isLink(_ x: Int, _ y: Int) -> Bool {
            guard x >= 0, y >= 0, x < w, y < h else { return false }
            let i = (y * w + x) * 4
            let b = Float(px[i]) / 255, g = Float(px[i + 1]) / 255, r = Float(px[i + 2]) / 255
            return abs(r - c.x) < 0.12 && abs(g - c.y) < 0.12 && abs(b - c.z) < 0.12
        }
        var glyph = 0
        let x0 = pad + col * cw, x1 = pad + (col + len) * cw
        let uy = pad + row * ch + Int(f.baseline + f.underlineY)
        for y in (pad + row * ch)..<(uy - 1) { for x in x0..<x1 where isLink(x, y) { glyph += 1 } }
        var on = 0
        for x in x0..<x1 where isLink(x, uy) || isLink(x, uy + 1) { on += 1 }
        return (glyph, Double(on) / Double(max(1, x1 - x0)))
    }
}
