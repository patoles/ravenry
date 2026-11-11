// The headless self-test (--offscreen --selftest OUT.json): the window
// off every screen, the view driven through its own event handlers with
// real NSEvent objects (keys, the wheel from CGEvents, clicks and drags,
// a drop), and each result checked in what the daemon sent back and the
// view applied: the frames' offset, selection and find sections, the
// grid, the link under the pointer, the private pasteboard, the
// accessibility value, the bell's flash, the scrollbar. The person's
// clipboard is never written (a private pasteboard) and no link is
// opened (they are recorded).
//
// scripts/selftest.sh runs it on a throwaway daemon.

import AppKit

final class SelfTest {
    let view: TerminalView
    let window: NSWindow
    let out: String
    private var checks: [[String: Any]] = []
    private let pasteboard: NSPasteboard
    private var opened: [URL] = []
    private let generalChanges = NSPasteboard.general.changeCount
    /// The layout a relaunch must show (SelfTestTabs.swift).
    var restore: [String: Any]?
    /// --restore-check: only check the relaunch against this file.
    var restoreFrom: String?

    let workspace: Workspace

    init(view: TerminalView, window: NSWindow, out: String, workspace: Workspace) {
        self.workspace = workspace
        self.view = view
        self.window = window
        self.out = out
        pasteboard = NSPasteboard(name: NSPasteboard.Name("dev.ravenry.selftest.\(getpid())"))
    }

    func start() {
        view.pasteboard = pasteboard
        view.openURL = { [weak self] u in self?.opened.append(u) }
        view.blinkOffscreen = true
        Thread { self.run() }.start()
    }

    // MARK: helpers

    func main<T>(_ f: () -> T) -> T { Thread.isMainThread ? f() : DispatchQueue.main.sync(execute: f) }
    func sleep(_ s: Double) { Thread.sleep(forTimeInterval: s) }

    func check(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
        var c: [String: Any] = ["name": name, "ok": ok]
        let d = detail()
        if !d.isEmpty { c["detail"] = d }
        NSLog("selftest: %@ %@ %@", ok ? "pass" : "FAIL", name, d)
        checks.append(c)
    }

    func waitFor(_ timeout: Double, _ cond: () -> Bool) -> Bool {
        let end = CACurrentMediaTime() + timeout
        while CACurrentMediaTime() < end {
            if cond() { return true }
            sleep(0.005)
        }
        return cond()
    }

    /// Reads the view's screen under its lock.
    private func scr<T>(_ f: (Screen) -> T) -> T {
        view.screen.lock()
        defer { view.screen.unlock() }
        return f(view.screen)
    }

    func text() -> String { view.screen.text() }

    private func keyEvent(_ chars: String, code: UInt16, flags: NSEvent.ModifierFlags = [], type: NSEvent.EventType = .keyDown) -> NSEvent {
        let ign = flags.contains(.shift) ? chars : chars.lowercased()
        return NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                windowNumber: window.windowNumber, context: nil, characters: chars,
                                charactersIgnoringModifiers: ign, isARepeat: false, keyCode: code)!
    }

    /// A key through keyDown, as AppKit delivers a person's key.
    private func key(_ chars: String, code: UInt16, flags: NSEvent.ModifierFlags = []) {
        let e = keyEvent(chars, code: code, flags: flags)
        main { view.keyDown(with: e) }
    }

    /// A key with Command through performKeyEquivalent, AppKit's path for
    /// shortcuts.
    private func shortcut(_ chars: String, code: UInt16, flags: NSEvent.ModifierFlags = .command) -> Bool {
        let e = keyEvent(chars, code: code, flags: flags)
        return main { window.contentView!.performKeyEquivalent(with: e) }
    }

    /// Types a command line and Enter, and waits for its output.
    private func run(_ cmd: String, until: @escaping (String) -> Bool, timeout: Double = 5) -> Bool {
        main { view.sendEvents([["text": cmd]]) }
        _ = waitFor(2) { self.text().contains(cmd.prefix(20)) }
        key("\r", code: 0x24)
        return waitFor(timeout) { until(self.text()) }
    }

    private var cellPt: CGSize {
        let f = view.renderer.fonts
        return CGSize(width: f.cellWidth / f.scale, height: f.cellHeight / f.scale)
    }

    /// The window point of a cell of the view (column, row on the view),
    /// at a fraction of the cell.
    private func windowPoint(col: CGFloat, row: CGFloat) -> NSPoint {
        let c = cellPt, pad = view.renderer.padding
        let p = NSPoint(x: pad + col * c.width, y: pad + row * c.height)
        return main { view.convert(p, to: nil) }
    }

    private func mouse(_ type: NSEvent.EventType, col: CGFloat, row: CGFloat, flags: NSEvent.ModifierFlags = [], clicks: Int = 1) -> NSEvent {
        let p = windowPoint(col: col, row: row)
        return NSEvent.mouseEvent(with: type, location: p, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                  windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks,
                                  pressure: type == .leftMouseUp ? 0 : 1)!
    }

    /// A scroll event as the system makes it: precise (a trackpad, in
    /// points) or a wheel's notches (lines).
    private func scrollEvent(precise: Bool, _ delta: Int32) -> NSEvent {
        let cg = CGEvent(scrollWheelEvent2Source: nil, units: precise ? .pixel : .line, wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0)!
        return NSEvent(cgEvent: cg)!
    }

    /// The view row that holds text, or -1.
    private func rowOf(_ s: String) -> Int {
        scr { sc in (0..<sc.rows).first { sc.rowText($0).contains(s) } ?? -1 }
    }

    // MARK: the test

    private func run() {
        defer { finish() }
        if let f = restoreFrom {
            restoreCheck(f)
            return
        }
        guard waitFor(20, { self.text().contains("~ >") }) else {
            checks.append(["name": "prompt", "ok": false, "detail": "no prompt: " + text()])
            return
        }
        sleep(0.3)
        fonts()
        scrolling()
        selecting()
        pasteAndDrop()
        links()
        finding()
        boxDrawing()
        cursor()
        titleAndBell()
        menuAndClear()
        accessibility()
        macKeys()
        settingsApplied()
        termItems()
        tabsAndSplits()
        check("general_pasteboard_untouched", NSPasteboard.general.changeCount == generalChanges)
    }

    private func fonts() {
        let f = view.renderer.fonts
        // The shared settings' default (shared/settings/settings.json): Menlo 13.
        check("font_default_menlo_13", view.renderer.fontName == "Menlo" && view.renderer.fontSize == 13,
              "\(view.renderer.fontName) \(view.renderer.fontSize)")
        check("cell_16x30_px_at_2x", f.scale == 2 && f.cellWidth == 16 && f.cellHeight == 30, "\(f.cellWidth)x\(f.cellHeight) at \(f.scale)")
        let g0 = main { view.gridSize }
        check("grid_fills_view", scr { $0.cols == g0.cols && $0.rows == g0.rows }, "view \(g0), frames \(scr { ($0.cols, $0.rows) })")
        // Cmd+= through keyDown, Cmd+- and Cmd+0 through the shortcut path.
        key("=", code: 0x18, flags: .command)
        let bigger = waitFor(3) { self.scr { $0.cols } < g0.cols }
        let g1 = main { view.gridSize }
        check("cmd_plus_bigger", bigger && view.renderer.fontSize == 14 && view.renderer.fonts.cellHeight > 30,
              "size \(view.renderer.fontSize), grid \(g1), frames \(scr { ($0.cols, $0.rows) })")
        check("cmd_plus_writes_settings", fileValue("fontSize") as? Int == 14, "\(fileValue("fontSize") ?? "none")")
        _ = shortcut("-", code: 0x1B)
        _ = shortcut("-", code: 0x1B)
        let smaller = waitFor(3) { self.scr { $0.cols } > g0.cols }
        check("cmd_minus_smaller", smaller && view.renderer.fontSize == 12 && fileValue("fontSize") as? Int == 12, "size \(view.renderer.fontSize)")
        _ = shortcut("0", code: 0x1D)
        let back = waitFor(3) { self.scr { $0.cols } == g0.cols }
        check("cmd_0_default", back && view.renderer.fontSize == 13 && main { view.gridSize } == g0 && fileValue("fontSize") as? Int == 13,
              "size \(view.renderer.fontSize)")
        // The window's smallest content size: 40 x 10 cells at the font,
        // larger with a larger font.
        let min12 = main { window.contentMinSize }
        // (The tab strip is above the terminal.)
        let grid12 = main { view.renderer.grid(for: NSSize(width: min12.width, height: min12.height - Design.stripHeight)) }
        _ = shortcut("=", code: 0x18)
        _ = waitFor(3) { view.renderer.fontSize == 14 }
        let min13 = main { window.contentMinSize }
        let grid13 = main { view.renderer.grid(for: NSSize(width: min13.width, height: min13.height - Design.stripHeight)) }
        _ = shortcut("0", code: 0x1D)
        _ = waitFor(3) { view.renderer.fontSize == 13 }
        check("window_min_size_40x10", grid12 == (40, 10) && grid13 == (40, 10) && min13.width > min12.width && min13.height > min12.height,
              "at 13 pt \(min12) is \(grid12), at 14 pt \(min13) is \(grid13)")
        sleep(0.3)
    }

    private func scrolling() {
        _ = run("seq 1 300", until: { $0.contains("300\n~ >") || $0.hasSuffix("300\n~ >") })
        _ = waitFor(2) { self.scr { $0.history } > 0 }
        let history = scr { $0.history }
        check("scrollback_has_history", history > 100, "history \(history)")
        sleep(0.3)
        // A trackpad: three events of two rows' worth of points.
        let ch = cellPt.height
        let ev = scrollEvent(precise: true, Int32(2 * ch))
        let perEvent = Double(ev.scrollingDeltaY / ch)
        for _ in 0..<3 { main { view.scrollWheel(with: scrollEvent(precise: true, Int32(2 * ch))) } }
        let want = Int(3 * perEvent)
        let precise = waitFor(3) { self.scr { $0.offset } == want }
        check("wheel_precise_rows", ev.hasPreciseScrollingDeltas && precise,
              "precise \(ev.hasPreciseScrollingDeltas), \(ev.scrollingDeltaY) pt an event, offset \(scr { $0.offset }) want \(want)")
        check("scrollbar_shows", view.scrollbarAlpha > 0, "alpha \(view.scrollbarAlpha)")
        // The thumb at the right edge, lit; nothing to its left.
        let p = picture()
        let s = Int(view.renderer.fonts.scale)
        let thumbX = p.w - 5 * s
        let lit = (0..<p.h).filter { bright(p, thumbX, $0) > 60 }
        check("scrollbar_drawn", lit.count > 24 * s && bright(p, p.w - 12 * s, lit.first ?? 0) < 60,
              "thumb \(lit.count) px tall at x \(thumbX)")
        savePNG("selftest-scrollbar.png")
        // The arrow over the scrollbar while it shows, the I-beam over the text.
        let edge = main { view.cursorAt(NSPoint(x: view.bounds.maxX - 4, y: view.bounds.midY)) }
        let middle = main { view.cursorAt(NSPoint(x: view.bounds.midX, y: view.bounds.midY)) }
        check("cursor_arrow_over_scrollbar", edge === NSCursor.arrow && middle === NSCursor.iBeam,
              "edge \(String(describing: edge)), middle \(String(describing: middle))")
        // A mouse wheel: one notch is three rows.
        let notch = scrollEvent(precise: false, 1)
        let before = scr { $0.offset }
        main { view.scrollWheel(with: notch) }
        let wantN = before + Int((notch.scrollingDeltaY * 3).rounded())
        let discrete = waitFor(3) { self.scr { $0.offset } == wantN }
        check("wheel_discrete_3_rows_a_notch", !notch.hasPreciseScrollingDeltas && discrete,
              "delta \(notch.scrollingDeltaY), offset \(scr { $0.offset }) want \(wantN)")
        // The scrollbar fades out about a second after the last scroll.
        sleep(1.4)
        check("scrollbar_hides", view.scrollbarAlpha == 0, "alpha \(view.scrollbarAlpha)")
        // Cmd+Home, Cmd+End.
        _ = shortcut("", code: 0x73)
        let topOK = waitFor(3) { self.scr { $0.offset == $0.history } }
        check("cmd_home_top", topOK, "offset \(scr { $0.offset }) of \(scr { $0.history })")
        check("scrollbar_shows_on_offset_change", view.scrollbarAlpha > 0)
        _ = shortcut("", code: 0x77)
        check("cmd_end_bottom", waitFor(3) { self.scr { $0.offset } == 0 }, "offset \(scr { $0.offset })")
        // A key brings a scrolled view back: the daemon does it.
        main { view.scrollWheel(with: scrollEvent(precise: false, 2)) }
        _ = waitFor(3) { self.scr { $0.offset } > 0 }
        key("x", code: 0x07)
        check("key_scrolls_back", waitFor(3) { self.scr { $0.offset } == 0 }, "offset \(scr { $0.offset })")
        key("\u{7f}", code: 0x33)
        sleep(0.2)
        // What the window does with a trackpad event on screen: it
        // hit-tests the event's location to a view. Nothing may sit over
        // the terminal there (a headless run cannot have the window server
        // deliver the event itself). Then the view's path, as the event
        // log records it on the person's Mac.
        let hit = main { () -> NSView? in
            let p = view.convert(NSPoint(x: view.bounds.midX, y: view.bounds.midY), to: nil)
            return window.contentView?.hitTest(window.contentView?.superview?.convert(p, from: nil) ?? p)
        }
        let b0 = scr { $0.offset }
        main { view.scrollWheel(with: scrollEvent(precise: true, Int32(3 * cellPt.height))) }
        let moved = waitFor(3) { self.scr { $0.offset } > b0 }
        sleep(0.2)
        EventLog.shared.flush()
        let logText = (try? String(contentsOfFile: EventLog.shared.path ?? "", encoding: .utf8)) ?? ""
        let steps = ["view scrollWheel phase", "precise true", "firstResponder true", "history ", "daemon wheel ok", "frame offset"]
        let missing = steps.filter { !logText.contains($0) }
        check("wheel_hit_test_and_logged", hit === view && moved && missing.isEmpty,
              "hit \(hit.map { String(describing: type(of: $0)) } ?? "none"), offset \(b0) to \(scr { $0.offset }), log \(EventLog.shared.path ?? "none") missing \(missing)")
        _ = shortcut("", code: 0x77)
        _ = waitFor(3) { self.scr { $0.offset } == 0 }
    }

    private func click(col: CGFloat, row: CGFloat, flags: NSEvent.ModifierFlags = [], clicks: Int = 1) {
        let d = mouse(.leftMouseDown, col: col, row: row, flags: flags, clicks: clicks)
        let u = mouse(.leftMouseUp, col: col, row: row, flags: flags, clicks: clicks)
        main { view.mouseDown(with: d) }
        main { view.mouseUp(with: u) }
    }

    private func drag(from a: (CGFloat, CGFloat), to b: (CGFloat, CGFloat), flags: NSEvent.ModifierFlags = []) {
        main { view.mouseDown(with: mouse(.leftMouseDown, col: a.0, row: a.1, flags: flags)) }
        for i in 1...4 {
            let f = CGFloat(i) / 4
            main { view.mouseDragged(with: mouse(.leftMouseDragged, col: a.0 + (b.0 - a.0) * f, row: a.1 + (b.1 - a.1) * f, flags: flags)) }
        }
        main { view.mouseUp(with: mouse(.leftMouseUp, col: b.0, row: b.1, flags: flags)) }
    }

    private var selection: CellRange? { scr { $0.selection } }

    /// Cmd+C, and what reached the private pasteboard.
    private func copied() -> String {
        pasteboard.clearContents()
        _ = shortcut("c", code: 0x08)
        var got = ""
        _ = waitFor(3) {
            got = self.main { self.pasteboard.string(forType: .string) } ?? ""
            return !got.isEmpty
        }
        return got
    }

    private func clearLine() {
        key("\u{15}", code: 0x20, flags: .control) // Ctrl+U
        sleep(0.2)
    }

    private func selecting() {
        // Octal escapes, so the command line does not hold the words.
        guard run(#"printf 'alph\141 beta gamma\ndelt\141 epsilon\n'"#, until: { $0.contains("delta epsilon") }) else {
            check("selection_text", false, text())
            return
        }
        sleep(0.3)
        let r = CGFloat(rowOf("alpha beta gamma"))
        let top = scr { $0.history - $0.offset }
        let y = top + Int(r)
        // Two clicks: a word. The daemon counts the clicks.
        click(col: 7.5, row: r + 0.5)
        click(col: 7.5, row: r + 0.5, clicks: 2)
        let word = waitFor(3) { self.selection == CellRange(x0: 6, y0: y, x1: 9, y1: y) }
        check("select_double_click_word", word, "\(String(describing: selection)) want x 6 to 9 on row \(y)")
        let w = copied()
        check("copy_cmd_c_private_pasteboard", w == "beta", "\"\(w)\"")
        // Three: the line.
        sleep(0.6)
        click(col: 2.5, row: r + 0.5)
        click(col: 2.5, row: r + 0.5, clicks: 2)
        click(col: 2.5, row: r + 0.5, clicks: 3)
        _ = waitFor(3) { self.selection.map { $0.x0 == 0 && $0.y0 == y && $0.x1 > 10 } ?? false }
        let line = copied()
        check("select_triple_click_line", line == "alpha beta gamma", "\"\(line)\" \(String(describing: selection))")
        // A drag, from the left half of the first cell to the right half
        // of the 13th.
        sleep(0.6)
        drag(from: (0.2, r + 0.5), to: (12.7, r + 0.5))
        _ = waitFor(3) { self.selection?.x1 == 12 }
        let dragged = copied()
        check("select_drag", dragged == "alpha beta ga", "\"\(dragged)\" \(String(describing: selection))")
        // Shift extends it.
        sleep(0.6)
        click(col: 15.7, row: r + 0.5, flags: .shift)
        _ = waitFor(3) { self.selection?.x1 == 15 }
        let ext = copied()
        check("select_shift_extends", ext == "alpha beta gamma", "\"\(ext)\"")
        // Option: a block over two rows.
        sleep(0.6)
        drag(from: (6.2, r + 0.5), to: (9.7, r + 1.5), flags: .option)
        _ = waitFor(3) { self.selection?.rect == true && self.selection?.y1 == y + 1 }
        let block = copied()
        check("select_option_block", selection?.rect == true && block == "beta\nepsi", "\"\(block)\" \(String(describing: selection))")
        // A click alone clears it.
        sleep(0.6)
        click(col: 3.5, row: r + 0.5)
        check("select_click_clears", waitFor(3) { self.selection == nil }, String(describing: selection))
        // Cmd+A: everything, scrollback too.
        _ = shortcut("a", code: 0x00)
        let all = waitFor(3) { self.selection.map { $0.y0 == 0 && $0.y1 >= y + 1 } ?? false }
        check("select_all_cmd_a", all, String(describing: selection))
        sleep(0.6)
        click(col: 3.5, row: r + 0.5)
        _ = waitFor(3) { self.selection == nil }
        // A drag past the top edge scrolls the view and selects on.
        sleep(0.6)
        let topBefore = scr { $0.history - $0.offset }
        main { view.mouseDown(with: mouse(.leftMouseDown, col: 2.5, row: 5.5)) }
        main { view.mouseDragged(with: mouse(.leftMouseDragged, col: 2.5, row: 2.5)) }
        main { view.mouseDragged(with: mouse(.leftMouseDragged, col: 2.5, row: -1.5)) }
        let scrolling = main { view.autoscrolling }
        sleep(0.6)
        let off1 = scr { $0.offset }
        main { view.mouseUp(with: mouse(.leftMouseUp, col: 2.5, row: -1.5)) }
        let stopped = !main { view.autoscrolling }
        // A step may be on its way at the release; then it stops.
        sleep(0.3)
        let off2 = scr { $0.offset }
        sleep(0.4)
        let off3 = scr { $0.offset }
        let sel = selection
        check("drag_past_top_autoscrolls", scrolling && off1 >= 5 && stopped && off2 <= off1 + 1 && off3 == off2 && (sel?.y0 ?? Int.max) < topBefore,
              "offset \(off1), \(off2), \(off3), selection \(String(describing: sel)), screen top was \(topBefore)")
        _ = shortcut("", code: 0x77)
        _ = waitFor(3) { self.scr { $0.offset } == 0 }
    }

    private func pasteAndDrop() {
        pasteboard.clearContents()
        pasteboard.setString("echo pasted-ok", forType: .string)
        _ = shortcut("v", code: 0x09)
        check("paste_cmd_v", waitFor(3) { self.text().contains("~ > echo pasted-ok") }, lastLines())
        clearLine()
        let drop = NSPasteboard(name: NSPasteboard.Name("dev.ravenry.selftest.drop.\(getpid())"))
        defer { drop.releaseGlobally() }
        drop.clearContents()
        drop.writeObjects([NSURL(fileURLWithPath: "/tmp/a b.txt"), NSURL(fileURLWithPath: "/tmp/it's")])
        let info = DragInfo(pasteboard: drop, window: window)
        let op = main { view.draggingEntered(info) }
        let done = main { view.performDragOperation(info) }
        check("drop_files_quoted_paths", op == .copy && done && waitFor(3) { self.text().contains(#"/tmp/a\ b.txt /tmp/it\'s"#) }, lastLines())
        clearLine()
        drop.clearContents()
        drop.setString("dropped words", forType: .string)
        _ = main { view.performDragOperation(DragInfo(pasteboard: drop, window: window)) }
        check("drop_text_pasted", waitFor(3) { self.text().contains("~ > dropped words") }, lastLines())
        clearLine()
    }

    /// Draws now and reads the picture: BGRA bytes, width, height.
    private func picture() -> (bytes: [UInt8], w: Int, h: Int) {
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

    /// How bright a pixel is, 0 to 255.
    private func bright(_ p: (bytes: [UInt8], w: Int, h: Int), _ x: Int, _ y: Int) -> Int {
        guard x >= 0, y >= 0, x < p.w, y < p.h else { return 0 }
        let i = (y * p.w + x) * 4
        return max(Int(p.bytes[i]), Int(p.bytes[i + 1]), Int(p.bytes[i + 2]))
    }

    /// The share of the pixels of a pixel row, from cell column c0 to c1
    /// of a view row, at y pixels down the cell, that are lit.
    private func lit(_ p: (bytes: [UInt8], w: Int, h: Int), row: Int, y: Int, cols c0: Int, _ c1: Int) -> Double {
        let f = view.renderer.fonts
        let pad = Int((view.renderer.padding * f.scale).rounded())
        let cw = Int(f.cellWidth), ch = Int(f.cellHeight)
        let py = pad + row * ch + y
        var on = 0, n = 0
        for x in (pad + c0 * cw)..<(pad + (c1 + 1) * cw) {
            n += 1
            if bright(p, x, py) > 120 { on += 1 }
        }
        return n == 0 ? 0 : Double(on) / Double(n)
    }

    private func flagsEvent(_ flags: NSEvent.ModifierFlags) -> NSEvent {
        NSEvent.keyEvent(with: .flagsChanged, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                         windowNumber: window.windowNumber, context: nil, characters: "", charactersIgnoringModifiers: "",
                         isARepeat: false, keyCode: 0x37)!
    }

    private func links() {
        let url = "https://ravenry.dev/docs"
        guard run(#"printf 'go to https://ravenry.dev/doc\163.\n'"#, until: { $0.contains("go to https://ravenry.dev/docs.") }) else {
            check("link_text", false, text())
            return
        }
        sleep(0.3)
        let r = scr { sc in (0..<sc.rows).first { sc.rowText($0) == "go to https://ravenry.dev/docs." } ?? -1 }
        let y = scr { $0.history - $0.offset } + r
        let row = CGFloat(r) + 0.5
        // Without Cmd, moving the pointer asks nothing.
        main { view.mouseMoved(with: mouse(.mouseMoved, col: 10.5, row: row)) }
        sleep(0.3)
        check("link_none_without_cmd", view.link == nil && !view.linkCursor)
        // TERM-022: resting on the link without Cmd, the tip says how to open it; nothing underlined.
        let tip = waitFor(3) { self.main { self.view.linkTipText } == "Cmd+click to open" }
        let tipFrame = main { view.linkTip?.frame ?? .zero }
        let at = main { view.convert(windowPoint(col: 10.5, row: row), from: nil) }
        check("link_hover_tip", tip && view.link == nil && !view.linkCursor && tipFrame.minX > at.x && !tipFrame.contains(at) && abs(tipFrame.midY - at.y) < 40,
              "tip \(main { view.linkTipText } ?? "none") at \(tipFrame), pointer \(at)")
        savePNGWithTip("selftest-link-tip.png")
        // Off the link: no tip.
        main { view.mouseMoved(with: mouse(.mouseMoved, col: 1.5, row: row)) }
        check("link_tip_off_link", waitFor(3) { self.main { self.view.linkTipText } == nil })
        main { view.mouseMoved(with: mouse(.mouseMoved, col: 10.5, row: row)) }
        _ = waitFor(3) { self.main { self.view.linkTipText } != nil }
        // Cmd pressed with the pointer on the URL.
        main { view.flagsChanged(with: flagsEvent(.command)) }
        let found = waitFor(3) { self.main { self.view.link } != nil }
        let l = main { view.link }
        check("link_cmd_finds_url", found && l?.uri == url && l?.range == CellRange(x0: 6, y0: y, x1: 29, y1: y),
              "\(String(describing: l)) want x 6 to 29 on row \(y)")
        // The pointing hand where the pointer is (the view's cursor rects), the tip gone.
        let hand = main { view.cursorAt(view.convert(windowPoint(col: 10.5, row: row), from: nil)) }
        check("link_pointing_hand", main { view.linkCursor } && hand === NSCursor.pointingHand, "cursor \(String(describing: hand))")
        check("link_cmd_hides_tip", main { view.linkTipText } == nil)
        let ulY = Int(view.renderer.fonts.baseline + view.renderer.fonts.underlineY)
        let on = lit(picture(), row: r, y: ulY, cols: 6, 29)
        check("link_underline_drawn", on > 0.9, String(format: "%.0f%% of the underline's pixels lit", on * 100))
        // Moving off the URL with Cmd held: no link.
        main { view.mouseMoved(with: mouse(.mouseMoved, col: 1.5, row: row, flags: .command)) }
        check("link_cmd_move_off", waitFor(3) { self.main { self.view.link } == nil })
        main { view.mouseMoved(with: mouse(.mouseMoved, col: 20.5, row: row, flags: .command)) }
        _ = waitFor(3) { self.main { self.view.link } != nil }
        // A plain click never opens; Cmd+click does.
        click(col: 20.5, row: row)
        sleep(0.3)
        check("link_plain_click_never_opens", opened.isEmpty, "\(opened)")
        sleep(0.6)
        click(col: 20.5, row: row, flags: .command)
        _ = waitFor(3) { !self.opened.isEmpty }
        check("link_cmd_click_opens", opened.map { $0.absoluteString } == [url], "\(opened)")
        // Releasing Cmd takes the underline and the hand away.
        main { view.flagsChanged(with: flagsEvent([])) }
        let gone = waitFor(3) { self.main { self.view.link == nil && !self.view.linkCursor } }
        let off = lit(picture(), row: r, y: ulY, cols: 6, 29)
        check("link_cmd_release_clears", gone && off < 0.5, String(format: "%.0f%% lit", off * 100))
        let back = main { view.cursorAt(view.convert(windowPoint(col: 20.5, row: row), from: nil)) }
        check("link_tip_back_after_cmd", waitFor(3) { self.main { self.view.linkTipText } != nil } && back === NSCursor.iBeam,
              "tip \(main { view.linkTipText } ?? "none"), cursor \(String(describing: back))")
        main { view.mouseExited(with: mouse(.mouseMoved, col: 20.5, row: row)) }
        check("link_tip_goes_on_exit", main { view.linkTipText } == nil)
    }

    /// A cell's background colour, read just inside its top left corner.
    private func cellColor(_ p: (bytes: [UInt8], w: Int, h: Int), col: Int, row: Int) -> (r: Int, g: Int, b: Int) {
        let f = view.renderer.fonts
        let pad = Int((view.renderer.padding * f.scale).rounded())
        let x = pad + col * Int(f.cellWidth) + 1, y = pad + row * Int(f.cellHeight) + 1
        guard x < p.w, y < p.h else { return (0, 0, 0) }
        let i = (y * p.w + x) * 4
        return (Int(p.bytes[i + 2]), Int(p.bytes[i + 1]), Int(p.bytes[i]))
    }

    private func findLabel() -> String { main { view.findBar?.count.stringValue ?? "" } }

    private func finding() {
        guard run(#"printf 'ne\145dle%d\n' 1 2 3"#, until: { $0.contains("needle3") }) else {
            check("find_text", false, text())
            return
        }
        sleep(0.3)
        let opened = shortcut("f", code: 0x03)
        let bar = main { view.findBar }
        let typing = main { bar.map { window.firstResponder === $0.editor } ?? false }
        check("find_cmd_f_opens_bar", opened && main { view.findBarVisible } && typing)
        guard let bar else { return }
        // The arrow over the bar and its buttons, never the terminal's I-beam.
        let overBar = main { view.cursorAt(NSPoint(x: bar.frame.maxX - 3, y: bar.frame.midY)) }
        let overField = main { view.cursorAt(bar.convert(NSPoint(x: bar.field.frame.midX, y: bar.field.frame.midY), to: view)) }
        let below = main { view.cursorAt(NSPoint(x: bar.frame.midX, y: bar.frame.maxY + 20)) }
        check("cursor_arrow_over_find_bar", overBar === NSCursor.arrow && overField === NSCursor.arrow && below === NSCursor.iBeam,
              "bar \(String(describing: overBar)), field area in the view's regions \(String(describing: overField)), below \(String(describing: below))")
        // Typing: the first character selects the newest match.
        main { bar.editor.insertText("needle", replacementRange: NSRange(location: NSNotFound, length: 0)) }
        let first = waitFor(3) { self.findLabel() == "1 of 3" }
        check("find_typing_counts", first, "label \"\(findLabel())\"")
        main {
            if let rep = bar.bitmapImageRepForCachingDisplay(in: bar.bounds) {
                bar.cacheDisplay(in: bar.bounds, to: rep)
                let url = URL(fileURLWithPath: out).deletingLastPathComponent().appendingPathComponent("selftest-findbar.png")
                try? rep.representation(using: .png, properties: [:])?.write(to: url)
            }
        }
        _ = waitFor(3) { self.scr { $0.find.active && $0.find.current != nil } }
        let f = scr { $0.find }
        let top = scr { $0.history - $0.offset }
        check("find_frames_section", f.active && f.count == 3 && f.selected == 0 && f.current != nil && f.matches.count == 2,
              "\(f)")
        // The selected match orange, the others yellow, on the picture.
        if let cur = f.current, let other = f.matches.first {
            let p = picture()
            let c = cellColor(p, col: cur.x0, row: cur.y0 - top), m = cellColor(p, col: other.x0, row: other.y0 - top)
            let none = cellColor(p, col: cur.x1 + 3, row: cur.y0 - top)
            check("find_highlights_drawn", c.r > 150 && c.g > 70 && c.g < 150 && c.b < 60 && m.r > 80 && m.g > 70 && m.b < 40 && none.r < 30,
                  "current \(c), other \(m), plain \(none)")
        }
        // Enter: the next (older) one; Shift+Enter back.
        main { bar.editor.keyDown(with: keyEvent("\r", code: 0x24)) }
        check("find_enter_next", waitFor(3) { self.findLabel() == "2 of 3" }, findLabel())
        main { bar.editor.keyDown(with: keyEvent("\r", code: 0x24, flags: .shift)) }
        check("find_shift_enter_previous", waitFor(3) { self.findLabel() == "1 of 3" }, findLabel())
        // Cmd+G and Cmd+Shift+G, while the bar has the keyboard.
        _ = shortcut("g", code: 0x05)
        check("find_cmd_g_next", waitFor(3) { self.findLabel() == "2 of 3" }, findLabel())
        _ = shortcut("G", code: 0x05, flags: [.command, .shift])
        check("find_cmd_shift_g_previous", waitFor(3) { self.findLabel() == "1 of 3" }, findLabel())
        _ = waitFor(3) { self.scr { $0.find.selected } == 0 }
        savePNG("selftest-find.png")
        findToggles(bar)
        main { bar.editor.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0)) }
        check("find_no_matches", waitFor(3) { self.findLabel() == "No matches" }, findLabel())
        // Esc: the search ends and the terminal has the keyboard again.
        main { bar.editor.keyDown(with: keyEvent("\u{1b}", code: 0x35)) }
        let closed = waitFor(3) { !self.scr { $0.find.active } }
        check("find_esc_closes", closed && !main { view.findBarVisible } && main { window.firstResponder === view })
        let items = main { () -> [String] in
            let edit = NSApp.mainMenu?.items.first { $0.submenu?.title == "Edit" }?.submenu
            return edit?.items.first { $0.title == "Find" }?.submenu?.items.map { $0.title } ?? []
        }
        check("find_menu_items", items == ["Find…", "Find Next", "Find Previous"], "\(items)")
    }

    /// Match case (Aa) and Regular expression (.*), as the Electron app's
    /// toggles: a needle in another case, a pattern, one that does not
    /// parse (the line under the bar, no dialog), and a tab of an older
    /// daemon (its refusal of the options is the daemon's, TestRenderFind
    /// and the 0.1.28 release's ravenryd: bad_request, unknown field).
    private func findToggles(_ bar: FindBar) {
        let set = { (s: String) in self.main { bar.field.stringValue = s; self.view.findChanged(s) } }
        check("find_toggles_there", main { bar.matchCase.toolTip == "Match case" && bar.regex.toolTip == "Regular expression" && !bar.matchCase.unavailable && !bar.regex.unavailable && !bar.matchCase.on && !bar.regex.on },
              main { "\(bar.matchCase.toolTip ?? "") \(bar.regex.toolTip ?? "") \(bar.matchCase.unavailable)" })
        set("NEEDLE")
        check("find_any_case", waitFor(3) { self.findLabel() == "3 matches" }, findLabel())
        main { bar.matchCase.performClick(nil) }
        check("find_match_case", waitFor(3) { self.findLabel() == "No matches" && self.scr { $0.find.count } == 0 } && main { bar.matchCase.on && bar.matchCase.layer?.borderWidth == 1.5 },
              "\(findLabel()), frames \(scr { $0.find.count })")
        set("needle")
        check("find_match_case_counts", waitFor(3) { self.findLabel() == "3 matches" }, findLabel())
        main { bar.matchCase.performClick(nil) }
        set("needle[23]$")
        check("find_regex_off_literal", waitFor(3) { self.findLabel() == "No matches" }, findLabel())
        main { bar.regex.performClick(nil) }
        check("find_regex", waitFor(3) { self.findLabel() == "1 of 2" && self.scr { $0.find.count } == 2 } && main { bar.regex.on && !bar.matchCase.on },
              "\(findLabel()), frames \(scr { $0.find.count })")
        // A pattern that does not parse: the line under the bar, in the bad colour; no dialog.
        set("needle(")
        let said = waitFor(3) { self.main { !bar.problem.isHidden && bar.problem.stringValue == "Not a valid pattern: missing closing )" } }
        check("find_bad_pattern_inline", said && findLabel() == "" && main { bar.frame.height == FindBar.size.height + FindBar.problemHeight && window.attachedSheet == nil && NSApp.modalWindow == nil },
              main { "\"\(bar.problem.stringValue)\" count \"\(bar.count.stringValue)\" height \(bar.frame.height)" })
        main {
            if let rep = bar.bitmapImageRepForCachingDisplay(in: bar.bounds) {
                bar.cacheDisplay(in: bar.bounds, to: rep)
                let url = URL(fileURLWithPath: out).deletingLastPathComponent().appendingPathComponent("selftest-findbar-badpattern.png")
                try? rep.representation(using: .png, properties: [:])?.write(to: url)
            }
        }
        set("needle[0-9]")
        check("find_pattern_fixed", waitFor(3) { self.findLabel() == "3 matches" } && main { bar.problem.isHidden && bar.frame.height == FindBar.size.height }, findLabel())
        main {
            bar.matchCase.performClick(nil)
            if let rep = bar.bitmapImageRepForCachingDisplay(in: bar.bounds) {
                bar.cacheDisplay(in: bar.bounds, to: rep)
                let url = URL(fileURLWithPath: out).deletingLastPathComponent().appendingPathComponent("selftest-findbar-toggles.png")
                try? rep.representation(using: .png, properties: [:])?.write(to: url)
            }
        }
        // A tab of an older daemon: the toggles off and dimmed, their tips
        // and a press say why, and the find goes on in any case.
        main { view.findOptionsKnown(false) }
        let dimmed = main { bar.matchCase.unavailable && bar.regex.unavailable && !bar.matchCase.on && !bar.regex.on && view.findCase == false && view.findRegex == false }
        check("find_old_daemon_toggles", dimmed && main { bar.matchCase.toolTip == "Match case needs a newer daemon. New tabs have it." && bar.regex.toolTip == "Regular expressions need a newer daemon. New tabs have them." },
              main { bar.matchCase.toolTip ?? "" })
        main { bar.regex.performClick(nil) }
        check("find_old_daemon_says", main { !bar.regex.on && !bar.problem.isHidden && bar.problem.stringValue == "Regular expressions need a newer daemon. New tabs have them." }, main { bar.problem.stringValue })
        main {
            if let rep = bar.bitmapImageRepForCachingDisplay(in: bar.bounds) {
                bar.cacheDisplay(in: bar.bounds, to: rep)
                let url = URL(fileURLWithPath: out).deletingLastPathComponent().appendingPathComponent("selftest-findbar-olddaemon.png")
                try? rep.representation(using: .png, properties: [:])?.write(to: url)
            }
        }
        set("NEEDLE")
        check("find_old_daemon_finds", waitFor(3) { self.findLabel() == "3 matches" } && main { bar.problem.isHidden }, findLabel())
        main { view.findOptionsKnown(true) }
        set("needle")
        _ = waitFor(3) { self.findLabel() == "3 matches" }
    }

    /// savePNG with the link tip drawn where it lies over the terminal
    /// (a subview: the terminal's own drawing does not hold it).
    private func savePNGWithTip(_ name: String) {
        let img: CGImage? = main { view.draw(sync: false); return view.snapshotImage() }
        guard let img else { return }
        let w = img.width, h = img.height
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return }
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        main {
            guard let tip = view.linkTip, !tip.isHidden, let rep = tip.bitmapImageRepForCachingDisplay(in: tip.bounds) else { return }
            tip.cacheDisplay(in: tip.bounds, to: rep)
            // cacheDisplay leaves out the layer's own fill and ring: drawn here first.
            let s = CGFloat(w) / view.bounds.width
            let r = CGRect(x: tip.frame.minX * s, y: CGFloat(h) - tip.frame.maxY * s, width: tip.frame.width * s, height: tip.frame.height * s)
            ctx.saveGState()
            let path = CGPath(roundedRect: r, cornerWidth: 5 * s, cornerHeight: 5 * s, transform: nil)
            view.effectiveAppearance.performAsCurrentDrawingAppearance {
                ctx.addPath(path); ctx.setFillColor(Design.color("card2").cgColor); ctx.fillPath()
                ctx.addPath(path); ctx.setStrokeColor(Design.color("sep").cgColor); ctx.setLineWidth(s); ctx.strokePath()
            }
            ctx.restoreGState()
            if let cg = rep.cgImage { ctx.draw(cg, in: r) }
        }
        guard let image = ctx.makeImage() else { return }
        let url = URL(fileURLWithPath: out).deletingLastPathComponent().appendingPathComponent(name)
        try? NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: url)
    }

    private func savePNG(_ name: String) {
        let img: CGImage? = main { view.draw(sync: false); return view.snapshotImage() }
        guard let img else { return }
        let url = URL(fileURLWithPath: out).deletingLastPathComponent().appendingPathComponent(name)
        try? NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:])?.write(to: url)
    }

    /// The share of a pixel column x (pixels into the cell of column
    /// col) lit from the middle of view row r0 to the middle of r1.
    private func litDown(_ p: (bytes: [UInt8], w: Int, h: Int), col: Int, x: Int, rows r0: Int, _ r1: Int) -> Double {
        let f = view.renderer.fonts
        let pad = Int((view.renderer.padding * f.scale).rounded())
        let cw = Int(f.cellWidth), ch = Int(f.cellHeight)
        var on = 0, n = 0
        for y in (pad + r0 * ch + ch / 2)..<(pad + r1 * ch + ch / 2) {
            n += 1
            if bright(p, pad + col * cw + x, y) > 120 { on += 1 }
        }
        return n == 0 ? 0 : Double(on) / Double(n)
    }

    private func boxDrawing() {
        _ = shortcut("k", code: 0x28)
        _ = waitFor(3) { self.scr { $0.history } == 0 }
        sleep(0.3)
        let art = ["┌──┬──┐", "│██│▒▒│", "├──┼──┤", "╰──┴──╯", "╔══╦══╗", "║▀▄║▌▐║", "╚══╩══╝",
                   "━━┃┏┓┗┛╋ ╍╍┅┅┄┄", "▁▂▃▄▅▆▇█▉▊▋▌▍▎▏", "░▒▓▖▗▘▙▚▛▜▝▞▟", "⠁⠃⠇⡇⣇⣧⣷⣿ ⠿⣀", "\u{E0B0}\u{E0B1}\u{E0B2}\u{E0B3} ╱╲╳"]
        let cmd = "printf '" + art.joined(separator: "\\n") + "\\n'"
        guard run(cmd, until: { $0.contains("╰──┴──╯\n╔") }) else {
            check("box_text", false, text())
            return
        }
        sleep(0.3)
        let r = scr { sc in (0..<sc.rows).first { sc.rowText($0) == "┌──┬──┐" } ?? -1 }
        let p = picture()
        savePNG("selftest-box.png")
        let f = view.renderer.fonts
        let t = f.boxThickness, cw = Int(f.cellWidth), ch = Int(f.cellHeight)
        // The horizontal line through ┌──┬──┐ with no gap between cells.
        let across = lit(p, row: r, y: (ch - t) / 2, cols: 1, 5)
        check("box_lines_join_across", across == 1, String(format: "%.0f%% lit", across * 100))
        // The vertical line down ┌ │ ├ in the first column, across rows.
        let down = litDown(p, col: 0, x: (cw - t) / 2, rows: r, r + 2)
        check("box_lines_join_down", down == 1, String(format: "%.0f%% lit", down * 100))
        // A full block fills its cell.
        var full = true
        let pad = Int((view.renderer.padding * f.scale).rounded())
        for yy in 0..<ch { for xx in 0..<cw where bright(p, pad + cw + xx, pad + (r + 1) * ch + yy) < 120 { full = false } }
        check("block_fills_cell", full)
    }

    private func cursor() {
        _ = run(#"printf '\e[5 q'"#, until: { _ in self.scr { $0.cursor.style == 1 && $0.cursor.blink } })
        check("cursor_bar_blink_from_frame", scr { $0.cursor.style == 1 && $0.cursor.blink } && main { view.cursorBlinking })
        var on = false, off = false
        _ = waitFor(2) {
            if self.main({ self.view.cursorOn }) { on = true } else { off = true }
            return on && off
        }
        check("cursor_blinks", on && off)
        // The bar: the left of the cursor's cell lit, the right not.
        _ = waitFor(2) { self.main { self.view.cursorOn } }
        var p = picture()
        let c = scr { $0.cursor }
        let f = view.renderer.fonts
        let pad = Int((view.renderer.padding * f.scale).rounded())
        let cw = Int(f.cellWidth), ch = Int(f.cellHeight)
        let cx = pad + c.x * cw, cy = pad + c.y * ch
        check("cursor_bar_drawn", bright(p, cx + 1, cy + ch / 2) > 120 && bright(p, cx + cw - 2, cy + ch / 2) < 60)
        // Unfocused: no blink, a hollow block.
        main { view.setFocus(false) }
        _ = waitFor(2) { !self.main { self.view.cursorBlinking } }
        p = picture()
        let hollow = bright(p, cx, cy + ch / 2) > 120 && bright(p, cx + cw - 1, cy + ch / 2) > 120 && bright(p, cx + cw / 2, cy + ch / 2) < 60
        check("cursor_unfocused_hollow_no_blink", !main { view.cursorBlinking } && main { view.cursorOn } && hollow)
        main { view.setFocus(true) }
        check("cursor_focused_blinks_again", waitFor(2) { self.main { self.view.cursorBlinking } })
        _ = run(#"printf '\e[4 q'"#, until: { _ in self.scr { $0.cursor.style == 2 && !$0.cursor.blink } })
        _ = waitFor(2) { !self.main { self.view.cursorBlinking } }
        check("cursor_steady_underline", scr { $0.cursor.style == 2 && !$0.cursor.blink } && !main { view.cursorBlinking })
        _ = run(#"printf '\e[0 q'"#, until: { _ in self.scr { $0.cursor.style == 0 } })
    }

    private func titleAndBell() {
        _ = run(#"printf '\e]0;selftest title\a'"#, until: { _ in self.main { self.window.title } == "selftest title" })
        check("title_from_program", main { window.title } == "selftest title", main { window.title })
        sleep(0.3)
        main { view.sendEvents([["text": #"printf '\a'"#]]) }
        _ = waitFor(2) { self.text().contains(#"printf '\a'"#) }
        key("\r", code: 0x24)
        var flashed = false, brighter = 0
        _ = waitFor(3) {
            if self.main({ self.view.bellFlashing }) {
                flashed = true
                // A blank cell at the bottom right, lit by the flash.
                let p = self.picture()
                brighter = self.bright(p, p.w - 40, p.h - 40)
                return true
            }
            return false
        }
        check("bell_flash_shows", flashed && brighter > 30, "background under the flash \(brighter)")
        sleep(0.3)
        let p = picture()
        check("bell_flash_ends", !main { view.bellFlashing } && bright(p, p.w - 40, p.h - 40) < 20)
    }

    private func menuAndClear() {
        let e = mouse(.rightMouseDown, col: 5.5, row: 2.5)
        let titles = main { view.menu(for: e)?.items.map { $0.isSeparatorItem ? "-" : $0.title } ?? [] }
        check("context_menu_items", titles == ["Copy", "Paste", "Select All", "-", "Copy Path", "Find…", "Clear", "-", "Split Right", "Split Down"], "\(titles)")
        _ = run(#"printf '\e[?1000h'"#, until: { _ in self.scr { $0.modes & Screen.modeMouse != 0 } })
        check("context_menu_none_with_mouse_reporting", main { view.menu(for: e) } == nil)
        _ = run(#"printf '\e[?1000l'"#, until: { _ in self.scr { $0.modes & Screen.modeMouse == 0 } })
        _ = run("seq 1 100", until: { $0.contains("100\n~ >") })
        _ = waitFor(2) { self.scr { $0.history } > 0 }
        _ = shortcut("k", code: 0x28)
        let cleared = waitFor(3) { self.scr { $0.history == 0 && $0.rowText(0) == "~ >" } }
        check("clear_cmd_k", cleared, lastLines())
    }

    private func accessibility() {
        _ = run(#"printf 'acc\145ssible row\n'"#, until: { $0.contains("accessible row") })
        sleep(0.5)
        let (role, label, value, n, posts) = main { (view.accessibilityRole(), view.accessibilityLabel(), view.accessibilityValue() as? String ?? "",
                                                    view.accessibilityNumberOfCharacters(), view.a11yPosts) }
        check("a11y_text_area", main { view.isAccessibilityElement() } && role == .textArea && label == "Terminal", "\(String(describing: role)) \(label ?? "")")
        check("a11y_value_rows", value == text() && value.contains("accessible row") && n == (value as NSString).length, "\(n) characters")
        let i = (value as NSString).range(of: "accessible row").location
        let line = main { view.accessibilityLine(for: i) }
        let lineRange = main { view.accessibilityRange(forLine: line) }
        let lineText = main { view.accessibilityString(for: lineRange) }
        check("a11y_lines", line == rowOf("accessible row") && lineText == "accessible row", "line \(line), \"\(lineText ?? "")\"")
        check("a11y_value_changed_posted", posts > 0, "\(posts) notifications")
    }

    private func lastLines() -> String {
        text().split(separator: "\n").suffix(3).joined(separator: " | ")
    }

    // MARK: the shared settings applied

    /// The settings file the app reads (the test's RAVENRY_DESKTOP_DATA).
    private var settingsFile: URL? { workspace.settings.file }

    private func fileValue(_ k: String) -> Any? {
        guard let f = settingsFile, let d = try? Data(contentsOf: f),
              let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return nil }
        return j[k]
    }

    /// Writes the file as the other app (or a person) would: the app
    /// follows within its poll (1.5 s).
    private func writeSettings(_ patch: [String: Any]) {
        guard let f = settingsFile else { return }
        var j = ((try? Data(contentsOf: f)).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? ["version": 1]
        for (k, v) in patch { j[k] = v }
        try? FileManager.default.createDirectory(at: f.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONSerialization.data(withJSONObject: j, options: [.prettyPrinted, .sortedKeys]).write(to: f)
        // A new modification time even within the same second.
        try? FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(Double(checks.count) + 1)], ofItemAtPath: f.path)
    }

    private func settingsApplied() {
        guard settingsFile != nil else { return check("settings_file", false, "no RAVENRY_DESKTOP_DATA") }
        _ = run(#"printf '\e[2 q'"#, until: { _ in self.scr { $0.cursor.style == 0 && !$0.cursor.blink } })
        let cols0 = scr { $0.cols }
        // Another app writes the file: the font and size, a light theme,
        // a bar cursor that blinks, the scrollback, Option as Meta.
        writeSettings(["fontFamily": "Monaco", "fontSize": 15, "themeFollowsSystem": false, "themeAlways": "paper",
                       "cursorStyle": "bar", "cursorBlink": true, "scrollback": 2000, "optionAsMeta": "left"])
        let applied = waitFor(5) { self.main { self.view.renderer.fontName == "Monaco" && self.view.renderer.fontSize == 15 } }
        let refit = waitFor(3) { self.scr { $0.cols } < cols0 }
        check("settings_font_live", applied && refit, "\(view.renderer.fontName) \(view.renderer.fontSize), cols \(cols0) to \(scr { $0.cols })")
        _ = waitFor(2) { self.main { self.view.cursorOn } }
        sleep(0.2)
        var p = picture()
        let bg = cellColor(p, col: scr { $0.cols } - 2, row: scr { $0.rows } - 2)
        check("settings_theme_paper", abs(bg.r - 0xF2) < 3 && abs(bg.g - 0xEE) < 3 && abs(bg.b - 0xDE) < 3, "background \(bg)")
        let paper = main { Design.tbg.usingColorSpace(.sRGB) }
        check("settings_theme_chrome", main { workspace.look.theme.light } && abs((paper?.redComponent ?? 0) - 0xF2 / 255.0) < 0.01,
              "tab in front \(String(describing: paper))")
        savePNG("selftest-settings-paper.png")
        // The bar from the settings while the program leaves a block; it blinks.
        _ = waitFor(2) { self.main { self.view.cursorOn } }
        p = picture()
        let c = scr { $0.cursor }
        let f = view.renderer.fonts
        let pad = Int((view.renderer.padding * f.scale).rounded())
        let cw = Int(f.cellWidth), ch = Int(f.cellHeight)
        let cx = pad + c.x * cw, cy = pad + c.y * ch
        // On paper the bar is dark: the left of the cell dark, the right as the background.
        check("settings_cursor_bar", bright(p, cx + 1, cy + ch / 2) < 120 && bright(p, cx + cw - 2, cy + ch / 2) > 200,
              "left \(bright(p, cx + 1, cy + ch / 2)), right \(bright(p, cx + cw - 2, cy + ch / 2))")
        check("settings_cursor_blinks", main { view.cursorBlinking })
        check("settings_option_as_meta", main { view.optionAsAlt } == "left")
        let sb = (try? workspace.conn.call("pane.list", [:]))?["panes"] as? [[String: Any]] ?? []
        let mine = sb.first { $0["id"] as? String == view.pane }?["scrollback"] as? Int
        check("settings_scrollback_to_daemon", mine == 2000, "pane scrollback \(mine.map(String.init) ?? "none")")
        // A family that is not here: the settings' first fallback.
        writeSettings(["fontFamily": "No Such Mono"])
        check("settings_font_fallback", waitFor(5) { self.main { self.view.renderer.askedFont == "No Such Mono" } } && view.renderer.fontName == "Menlo",
              view.renderer.fontName)
        // Copy on select: a drag copies; a click opens a link.
        writeSettings(["copyOnSelect": true, "openLinksSingleClick": true, "fontFamily": "Menlo", "fontSize": 13])
        _ = waitFor(5) { self.main { self.view.look.copyOnSelect && self.view.renderer.fontSize == 13 } }
        guard run(#"printf 'see https://ravenry.dev/setting\163 now\n'"#, until: { $0.contains("see https://ravenry.dev/settings now") }) else {
            return check("settings_link_text", false, lastLines())
        }
        sleep(0.3)
        let r = CGFloat(scr { sc in (0..<sc.rows).first { sc.rowText($0) == "see https://ravenry.dev/settings now" } ?? 0 }) + 0.5
        main { pasteboard.clearContents() }
        drag(from: (0.2, r), to: (2.8, r))
        var got = ""
        _ = waitFor(3) { got = self.main { self.pasteboard.string(forType: .string) } ?? ""; return !got.isEmpty }
        check("settings_copy_on_select", got == "see", "copied \(got)")
        opened.removeAll()
        main { view.mouseMoved(with: mouse(.mouseMoved, col: 10.5, row: r)) }
        let live = waitFor(3) { self.main { self.view.link } != nil }
        click(col: 10.5, row: r)
        let one = waitFor(3) { self.main { self.opened.last?.absoluteString } == "https://ravenry.dev/settings" }
        check("settings_link_one_click", live && one, "underlined \(live), opened \(opened)")
        let handOne = main { view.cursorAt(view.convert(windowPoint(col: 10.5, row: r), from: nil)) }
        check("settings_link_one_click_no_tip", main { view.linkTipText } == nil && handOne === NSCursor.pointingHand,
              "tip \(main { view.linkTipText } ?? "none"), cursor \(String(describing: handOne))")
        // The bell: a sound and the Dock (recorded here), no flash; off: nothing.
        writeSettings(["bell": "sound", "copyOnSelect": false, "openLinksSingleClick": false])
        _ = waitFor(5) { self.main { self.view.look.bell == "sound" } }
        let heard = main { view.bellsHeard.count }
        _ = run(#"printf '\a'"#, until: { _ in self.main { self.view.bellsHeard.contains("sound") } })
        check("settings_bell_sound", Array(main { view.bellsHeard }.dropFirst(heard)) == ["sound", "bounce"] && !main { view.bellFlashing }, "\(main { view.bellsHeard })")
        writeSettings(["bell": "off"])
        _ = waitFor(5) { self.main { self.view.look.bell == "off" } }
        _ = run(#"printf '\a'; echo rung"#, until: { $0.contains("rung\n~ >") })
        sleep(0.2)
        check("settings_bell_off", main { view.bellsHeard }.count == heard + 2 && !main { view.bellFlashing })
        // Closing a busy shell asks first; Don't ask again writes the setting.
        main { view.sendEvents([["text": "sleep 30"]]) }
        _ = waitFor(2) { self.text().contains("sleep 30") }
        key("\r", code: 0x24)
        sleep(0.5)
        var closed = false
        main { workspace.closeAnswer = (false, false) }
        main { workspace.askClose(view.pane) { closed = true } }
        let asked = waitFor(3) { self.main { self.workspace.closeAsked.count } == 1 }
        sleep(0.2)
        check("settings_close_busy_asks", asked && !closed && main { workspace.closeAsked.first ?? "" } == "Close this tab? zsh is running sleep 30. Close it anyway?",
              main { workspace.closeAsked.first ?? "" })
        main { workspace.closeAnswer = (true, true) }
        main { workspace.askClose(view.pane) { closed = true } }
        _ = waitFor(3) { closed }
        check("settings_close_dont_ask_again", closed && waitFor(2) { self.fileValue("confirmCloseBusy") as? Bool == false })
        key("\u{03}", code: 0x08, flags: .control) // Ctrl+C
        _ = waitFor(3) { self.lastLines().hasSuffix("~ >") }
        // An idle shell closes at once, asked or not.
        writeSettings(["confirmCloseBusy": true])
        _ = waitFor(5) { self.main { self.workspace.look.confirmClose } }
        closed = false
        main { workspace.askClose(view.pane) { closed = true } }
        check("settings_close_idle_at_once", waitFor(3) { closed } && main { workspace.closeAsked.count } == 2)
        // The defaults back for the relaunch.
        if let f = settingsFile { try? FileManager.default.removeItem(at: f) }
        writeSettings([:])
        _ = waitFor(5) { self.main { self.view.renderer.fontSize == 13 && !self.workspace.look.theme.light } }
    }

    private func finish() {
        var r: [String: Any] = ["checks": checks]
        if let restore { r["restore"] = restore }
        let d = try? JSONSerialization.data(withJSONObject: r, options: [.prettyPrinted, .sortedKeys])
        try? d?.write(to: URL(fileURLWithPath: out))
        pasteboard.releaseGlobally()
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }
}

/// A drop as AppKit hands it to the view: its pasteboard.
private final class DragInfo: NSObject, NSDraggingInfo {
    let draggingPasteboard: NSPasteboard
    let draggingDestinationWindow: NSWindow?
    init(pasteboard: NSPasteboard, window: NSWindow) {
        draggingPasteboard = pasteboard
        draggingDestinationWindow = window
    }
    var draggingSourceOperationMask: NSDragOperation { .copy }
    var draggingLocation: NSPoint { NSPoint(x: 100, y: 100) }
    var draggedImageLocation: NSPoint { .zero }
    var draggedImage: NSImage? { nil }
    var draggingSource: Any? { nil }
    var draggingSequenceNumber: Int { 1 }
    func slideDraggedImage(to screenPoint: NSPoint) {}
    var draggingFormation: NSDraggingFormation = .default
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    func enumerateDraggingItems(options enumOpts: NSDraggingItemEnumerationOptions = [], for view: NSView?, classes classArray: [AnyClass],
                                searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:],
                                using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }
    func resetSpringLoading() {}
}
