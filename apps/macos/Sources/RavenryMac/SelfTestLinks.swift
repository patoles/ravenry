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

        // A name the row's end cuts in two: a link on both rows, and a click on its second part opens it.
        let cols = v.screen.cols
        let wrapped = String(repeating: "x", count: cols - 6) + " paper-boat-7c is next."
        v.sendEvents([["text": "clear; printf '%s\\n' \"\(wrapped)\"\r"]])
        func spans() -> [NameSpan] { v.screen.lock(); defer { v.screen.unlock() }; return v.screen.nameSpans }
        let two = wait(5) { let sp = spans(); return words() == ["paper-boat-7c"] && sp.count == 2 && sp[0].x0 == cols - 5 && sp[0].x1 == cols - 1 && sp[1].y == sp[0].y + 1 && sp[1].x0 == 0 && sp[1].x1 == 7 }
        check("links_wrapped_name_both_rows", two, "\(spans())")
        if let second = spans().last {
            clickCell(v, col: 3, row: second.y)
            check("links_wrapped_click_opens", wait(3) { self.board.front == .session(boat) }, "front \(board.front)")
            ws.bar.onSelect?(shell.id)
            settle(0.5)
        }

        screenLinksInText(garden: garden, boat: boat)

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

    /// Session names in a brief, a plan, a hand-off, the panel's lines and a
    /// document (BriefDoc, InlineMd, DocView): links the same way, with the
    /// terminal's words and rules, and a plain press opens the session.
    /// paper-boat's brief (sidetest.mjs linksPrepare) names three.
    private func screenLinksInText(garden: String, boat: String) {
        let L = SessionLinks.shared
        let ws = board.ws
        let shell = ws.tabs.first
        let bp = board.brief
        func words(_ st: NSAttributedString?) -> [String] {
            guard let st else { return [] }
            var out: [String] = []
            st.enumerateAttribute(SessionLinks.wordKey, in: NSRange(location: 0, length: st.length)) { v, _, _ in if let w = v as? String { out.append(w) } }
            return out
        }
        func links(_ st: NSAttributedString?) -> [String] {
            guard let st else { return [] }
            var out: [String] = []
            st.enumerateAttribute(.link, in: NSRange(location: 0, length: st.length)) { v, _, _ in if let w = v as? String, w.hasPrefix("ravenry:") { out.append(w) } }
            return out
        }
        board.openPage("brief:paper-boat", t("panel.brief"))
        let drawn = wait(8) { words(bp.text.textStorage).contains("lighthouse-4d") }
        let bw = words(bp.text.textStorage)
        check("links_brief_names_are_links", drawn && Set(bw) == ["garden-planner-3f", "lighthouse-4d", "paper-boat-7c"] && links(bp.text.textStorage).allSatisfy { $0.hasPrefix("ravenry://session/") }, "\(bw)")
        // Goal, Next step, Plan (bold) for garden-planner-3f; the code span; the hand-off's one of three paper-boat-7c.
        let text = bp.text.string
        check("links_brief_paths_and_plain_words_not_links", bw.filter { $0 == "paper-boat-7c" }.count == 1 && text.components(separatedBy: "paper-boat-7c").count - 1 == 3 && bw.filter { $0 == "garden-planner-3f" }.count == 3 && !bw.contains("ravenry-99") && !bw.contains("garden-planner"),
              "\(bw), paper-boat-7c drawn \(text.components(separatedBy: "paper-boat-7c").count - 1) times")
        size(1280, 820)
        for dark in [true, false] {
            NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            settle(0.5)
            board.render(force: true)
            settle(0.4)
            picture("native-links2-brief-1280-\(dark ? "dark" : "light").png")
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        settle(0.4)
        // A plain press on the hand-off's name: its session, at once.
        if let p = point(of: "paper-boat-7c for", in: bp.text) { click(bp.text, at: p) }
        check("links_brief_click_opens_session", wait(3) { self.board.front == .session(boat) }, "front \(board.front), opened \(L.opened.suffix(1))")
        // A press on the code span's ended session: continued here (the tab Continue made before).
        board.openPage("brief:paper-boat", t("panel.brief"))
        _ = wait(5) { self.board.front != .session(boat) && bp.shownText != nil }
        settle(0.3)
        if let p = point(of: "lighthouse-4d", in: bp.text) { click(bp.text, at: p) }
        check("links_brief_code_span_opens_ended_session", wait(5) { self.board.front == .tab && L.opened.last == "lighthouse-4d" }, "front \(board.front), opened \(L.opened.suffix(1))")

        // The panel's brief lines (InlineMd labels in a row that takes every press): the name a link drawn in the link colour, a press on it opens it.
        board.pickSession(boat, why: "test")
        size(1280, 820)
        settle(0.6)
        board.render(force: true)
        func fields(_ v: NSView) -> [LinkField] { (v as? LinkField).map { [$0] } ?? v.subviews.flatMap(fields) }
        var goal: LinkField?
        _ = wait(5) { goal = fields(self.board.panel).first { $0.stringValue.contains("as garden-planner-3f planned") && $0.hasLinks }; return goal != nil }
        let next = fields(board.panel).first { $0.stringValue.contains("lighthouse-4d") && $0.hasLinks }
        let rects = goal?.linkRects() ?? []
        let ink = goal.map { linkInk($0, rects) } ?? (inside: 0, outside: 0)
        check("links_panel_lines_are_links", goal != nil && next != nil && rects.count == 1 && words(goal?.attributedStringValue) == ["garden-planner-3f"], "goal \(goal?.stringValue ?? "none"), next \(next?.stringValue ?? "none"), rects \(rects)")
        check("links_panel_link_drawn_where_it_presses", ink.inside > 20 && ink.outside == 0, "link-colour pixels inside its press area \(ink.inside), outside \(ink.outside)")
        for dark in [true, false] {
            NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            settle(0.5)
            board.render(force: true)
            settle(0.4)
            picture("native-links2-panel-1280-\(dark ? "dark" : "light").png")
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        settle(0.4)
        goal = fields(board.panel).first { $0.stringValue.contains("as garden-planner-3f planned") && $0.hasLinks }
        if let g = goal, let r = g.linkRects().first {
            let pt = NSPoint(x: r.midX, y: r.midY)
            let root = window.contentView!
            let hit = root.hitTest(root.superview!.convert(g.convert(pt, to: nil), from: nil))
            check("links_panel_press_reaches_the_link", hit === g && g.sessionWord(at: pt) == "garden-planner-3f", "\(hit.map { String(describing: type(of: $0)) } ?? "nil"), word at \(pt): \(g.sessionWord(at: pt) ?? "none"), field \(g.bounds), selectable \(g.isSelectable)")
            click(g, at: pt)
        }
        check("links_panel_click_opens_session", wait(3) { self.board.front == .session(garden) }, "front \(board.front), opened \(L.opened.suffix(1))")
        // Off the name, the line is the row's as before: nothing opens.
        board.pickSession(boat, why: "test")
        settle(0.6)
        goal = fields(board.panel).first { $0.stringValue.contains("as garden-planner-3f planned") && $0.hasLinks }
        let n0 = L.opened.count
        if let g = goal { click(g, at: NSPoint(x: g.bounds.minX + 8, y: g.bounds.midY)) }
        check("links_panel_plain_words_not_a_link", L.opened.count == n0 && board.front == .session(boat), "opened \(L.opened.count - n0), front \(board.front)")

        // Every Markdown line and document: a label, a wrapped line (objectives, a plan's goal), a document.
        let lab = label(md: "Ask garden-planner-3f, not ravenry-99", Fonts.pt(12.5)) as? LinkField
        let wr = wrap(md: "Then paper-boat-7c.", Fonts.pt(12.5)).text as? LinkField
        let plain = label("Ask garden-planner-3f", Fonts.pt(12.5)) as? LinkField
        check("links_markdown_lines_carry_words", lab?.hasLinks == true && words(lab?.attributedStringValue) == ["garden-planner-3f"] && wr?.hasLinks == true && plain?.hasLinks == false,
              "label \(words(lab?.attributedStringValue)), wrap \(words(wr?.attributedStringValue)), a plain label (not Markdown) \(plain?.hasLinks ?? true)")
        let dv = DocView("## Hand-off\n\nHanded to paper-boat-7c. See /tmp/paper-boat-7c/x and ravenry-99.", dir: "/tmp", canTick: false)
        check("links_document_names_are_links", links(dv.text.textStorage) == ["ravenry://session/paper-boat-7c"], "\(links(dv.text.textStorage))")
        if let sh = shell { ws.bar.onSelect?(sh.id); settle(0.4) }
        _ = dv.textView(dv.text, clickedOnLink: "ravenry://session/paper-boat-7c", at: 0)
        check("links_document_click_opens_session", wait(3) { self.board.front == .session(boat) } && !dv.clicked.isEmpty && (Outside.record?.last ?? "").contains("ravenry://") == false, "front \(board.front)")
        if let sh = shell { ws.bar.onSelect?(sh.id); settle(0.4) }
    }

    /// In a label's drawing (in the window, over what lies behind it): the
    /// pixels in the link colour inside its link rects and outside them.
    private func linkInk(_ f: NSTextField, _ rects: [NSRect]) -> (inside: Int, outside: Int) {
        guard let root = window.contentView, let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { return (0, 0) }
        root.cacheDisplay(in: root.bounds, to: rep)
        guard let img = rep.cgImage else { return (0, 0) }
        let w = img.width, h = img.height
        var px = [UInt8](repeating: 0, count: w * h * 4)
        px.withUnsafeMutableBytes { p in
            CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)?.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        var c = (r: CGFloat(0), g: CGFloat(0), b: CGFloat(0))
        f.effectiveAppearance.performAsCurrentDrawingAppearance {
            let k = Design.color("link").usingColorSpace(.sRGB) ?? .systemBlue
            c = (k.redComponent, k.greenComponent, k.blueComponent)
        }
        let s = CGFloat(w) / root.bounds.width
        let fr = f.convert(f.bounds, to: root)
        let top = root.isFlipped ? fr.minY : root.bounds.height - fr.maxY
        var inside = 0, outside = 0
        for py in Int(top * s)..<min(h, Int((top + fr.height) * s)) {
            for pxx in Int(fr.minX * s)..<min(w, Int(fr.maxX * s)) {
                let i = (py * w + pxx) * 4
                let b = CGFloat(px[i]) / 255, g = CGFloat(px[i + 1]) / 255, r = CGFloat(px[i + 2]) / 255
                guard abs(r - c.r) < 0.12, abs(g - c.g) < 0.12, abs(b - c.b) < 0.12 else { continue }
                // In the field's coordinates.
                let x = CGFloat(pxx) / s - fr.minX, yTop = CGFloat(py) / s - top
                let pt = NSPoint(x: x, y: f.isFlipped ? yTop : f.bounds.height - yTop)
                if rects.contains(where: { $0.insetBy(dx: -1, dy: -1).contains(pt) }) { inside += 1 } else { outside += 1 }
            }
        }
        return (inside, outside)
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
