// The self-test's terminal rows of the build3 round (SelfTest.swift runs
// it before the tabs): each check drives the view as a person's hands or
// an input method do (keys and shortcuts through the window, clicks with
// each button, the input method's own calls) and reads where the effect
// lands: the bytes a program in the pane read (a small Python reader that
// prints them in hex), the shell's line, the frames, the daemon's
// pane.list, the pixels drawn, the window's size.
//
// - A11Y-011: Cmd+Z, Cmd+Shift+Z and Cmd+X reach the program as its keys
//   (Kitty keyboard protocol on: CSI 122;9u...), the Edit menu's Cut is off.
// - TERM-034: one answer to each terminal query (the daemon's), none from the app.
// - TERM-071: a right and a middle click reach a program that asks for the
//   mouse, with no menu; focus out and in reach one that asks for focus.
// - TERM-067: an input method's marked text is drawn, nothing sent until it
//   commits, the committed text once; a dead key the same way.
// - TERM-020: 16, 256 and truecolor backgrounds drawn in their colours,
//   fresh and after a tab switch (after a relaunch: termAfterRelaunch).
// - TERM-030: the matches marked on the scrollbar's track, the selected one amber.
// - TERM-031: Copy Path off when the pane's folder is unknown.
// - TERM-019: a 2 MB synchronized update shows whole; the main thread never waits.
// - TERM-064: `exit` closes its tab, or its split leaving the other pane whole.
// - TERM-063: a middle click on a busy shell's tab asks; Cancel keeps it.
// - TERM-072: a bigger font grows a window too small for 40 x 10.
// - TERM-017: a tab hidden during a resize takes the new size when shown;
//   columns follow a resize at once.
// - TERM-068 (selftest.sh's third launch): no tab to bring back, the first
//   shell opens in the folder of the shell in front last.

import AppKit

extension SelfTest {
    private func wsA<T>(_ f: (Workspace) -> T) -> T { main { f(workspace) } }
    /// The test's HOME (the throwaway one selftest.sh gives the app and its
    /// shells), never the person's: NSHomeDirectory() is the account's.
    private var homeA: String {
        let h = ProcessInfo.processInfo.environment["HOME"] ?? ""
        return h.isEmpty || h == NSHomeDirectory() ? NSTemporaryDirectory() : h
    }
    private func frontA() -> TerminalView? { wsA { $0.focusedView } }
    private func textOf(_ v: TerminalView?) -> String { v?.screen.text() ?? "" }
    private func promptA(_ v: TerminalView?) -> Bool { waitFor(6) { self.textOf(v).contains("~ >") } }
    private func paneList() -> [[String: Any]] {
        ((try? workspace.conn.call("pane.list", [:]))?["panes"] as? [[String: Any]]) ?? []
    }

    /// Types a command line into a view and presses Enter (a real key).
    private func typeLine(_ v: TerminalView, _ cmd: String) {
        main { v.sendEvents([["text": cmd]]) }
        _ = waitFor(2) { self.textOf(v).contains(cmd.prefix(16)) }
        let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                 windowNumber: window.windowNumber, context: nil, characters: "\r", charactersIgnoringModifiers: "\r",
                                 isARepeat: false, keyCode: 0x24)!
        main { v.keyDown(with: e) }
    }

    /// Cmd+K on the view in front, then waits for an empty prompt.
    private func clearA(_ v: TerminalView) {
        main { v.clearScreen(nil) }
        _ = waitFor(2) { self.textOf(v).trimmingCharacters(in: .whitespacesAndNewlines).count < 8 }
        sleep(0.2)
    }

    /// The reader: a Python program that turns modes on, reads every byte
    /// that reaches it until a "q" (or 10 s), and prints "TAG <hex>".
    private func writeReader() -> String {
        let path = homeA + "/reader.py"
        let py = """
        import os, sys, termios, tty, select, time
        on = {"kitty": b"\\x1b[>1u", "mouse": b"\\x1b[?1000h\\x1b[?1006h", "focus": b"\\x1b[?1004h", "none": b""}
        off = {"kitty": b"\\x1b[<u", "mouse": b"\\x1b[?1000l\\x1b[?1006l", "focus": b"\\x1b[?1004l", "none": b""}
        mode, tag = sys.argv[1], sys.argv[2]
        fd = 0
        old = termios.tcgetattr(fd)
        tty.setraw(fd)
        buf = b""
        try:
            os.write(1, on[mode] + b"READY\\r\\n")
            end = time.time() + 10
            while time.time() < end and not buf.endswith(b"q"):
                r, _, _ = select.select([fd], [], [], 0.05)
                if r:
                    buf += os.read(fd, 4096)
        finally:
            os.write(1, off[mode])
            termios.tcsetattr(fd, termios.TCSADRAIN, old)
        print(tag, buf.hex())
        """
        try? py.write(toFile: path, atomically: true, encoding: .utf8)
        return path
    }

    /// Starts the reader in the view, waits until it reads.
    private func startReader(_ v: TerminalView, mode: String, tag: String) -> Bool {
        clearA(v)
        typeLine(v, "python3 ~/reader.py \(mode) \(tag)")
        return waitFor(8) { self.textOf(v).contains("READY") }
    }

    /// Ends the reader with a "q" and returns what it read, in hex.
    private func endReader(_ v: TerminalView, tag: String) -> String {
        main { v.sendEvents([["text": "q"]]) }
        var got = ""
        _ = waitFor(5) {
            for line in self.textOf(v).split(separator: "\n") where line.hasPrefix(tag + " ") {
                got = String(line.dropFirst(tag.count + 1)).trimmingCharacters(in: .whitespaces)
                return true
            }
            return false
        }
        _ = promptA(v)
        return got
    }

    private func hex(_ s: String) -> String { s.utf8.map { String(format: "%02x", $0) }.joined() }

    /// A key with modifiers, as AppKit delivers it (SelfTestTabs.deliver).
    private func keyA(_ chars: String, _ ign: String, code: UInt16, flags: NSEvent.ModifierFlags) {
        let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                 windowNumber: window.windowNumber, context: nil, characters: chars,
                                 charactersIgnoringModifiers: ign, isARepeat: false, keyCode: code)!
        main {
            if flags.contains(.command) || flags.contains(.control) {
                if window.performKeyEquivalent(with: e) { return }
                if NSApp.mainMenu?.performKeyEquivalent(with: e) == true { return }
            }
            window.firstResponder?.keyDown(with: e)
        }
    }

    private func pictureA(_ v: TerminalView) -> (bytes: [UInt8], w: Int, h: Int) {
        guard let img: CGImage = main({ v.draw(sync: false); return v.snapshotImage() }) else { return ([], 0, 0) }
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

    private func pixel(_ p: (bytes: [UInt8], w: Int, h: Int), _ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int) {
        guard x >= 0, y >= 0, x < p.w, y < p.h else { return (-1, -1, -1) }
        let i = (y * p.w + x) * 4
        return (Int(p.bytes[i + 2]), Int(p.bytes[i + 1]), Int(p.bytes[i]))
    }

    /// The middle of a cell of the view (column, view row), in pixels.
    private func cellMiddle(_ v: TerminalView, col: Int, row: Int) -> (Int, Int) {
        let f = v.renderer.fonts
        let pad = Int((v.renderer.padding * f.scale).rounded())
        return (pad + col * Int(f.cellWidth) + Int(f.cellWidth) / 2, pad + row * Int(f.cellHeight) + Int(f.cellHeight) / 2)
    }

    private func savePNGA(_ v: TerminalView, _ name: String) {
        let img: CGImage? = main { v.draw(sync: false); return v.snapshotImage() }
        guard let img else { return }
        let url = URL(fileURLWithPath: out).deletingLastPathComponent().appendingPathComponent(name)
        try? NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:])?.write(to: url)
    }

    // MARK: the run

    func termA() {
        _ = writeReader()
        editKeysToProgram()
        queriesOnce()
        mouseAndFocusToProgram()
        inputMethods()
        colours(tag: "fresh")
        coloursAfterTabSwitch()
        findMarksOnScrollbar()
        copyPathUnknown()
        bigUpdate()
        exitCloses()
        middleClickBusy()
        fontGrowsWindow()
        hiddenTabResize()
        if let v = frontA() { clearA(v) }
    }

    // MARK: A11Y-011

    private func editKeysToProgram() {
        guard let v = frontA() else { return check("edit_keys_view", false) }
        let edit = main { NSApp.mainMenu?.items.first { $0.submenu?.title == "Edit" }?.submenu }
        let titles = main { edit?.items.map(\.title) ?? [] }
        check("edit_menu_has_undo_redo_cut", ["Undo", "Redo", "Cut", "Copy", "Paste", "Select All"].allSatisfy(titles.contains),
              titles.joined(separator: ", "))
        // Cut is off while a terminal has the keyboard (the menu asks the first responder).
        let cut = main { edit?.items.first { $0.title == "Cut" } }
        let cutOn = main { cut.map { v.validateMenuItem($0) } ?? true }
        check("edit_cut_off_in_terminal", main { window.firstResponder === v } && cut != nil && !cutOn, "Cut enabled: \(cutOn)")
        guard startReader(v, mode: "kitty", tag: "EDITKEYS") else { return check("edit_keys_reader", false, textOf(v)) }
        keyA("z", "z", code: 0x06, flags: .command)
        keyA("Z", "Z", code: 0x06, flags: [.command, .shift])
        keyA("x", "x", code: 0x07, flags: .command)
        sleep(0.3)
        let got = endReader(v, tag: "EDITKEYS")
        // The Kitty keyboard protocol's disambiguate: Cmd (super, 8) is mods 9, with Shift 10.
        let want = hex("\u{1b}[122;9u") + hex("\u{1b}[122;10u") + hex("\u{1b}[120;9u")
        check("edit_cmd_z_shift_z_x_reach_program", got.hasPrefix(want), "read \(got), want \(want)...")
    }

    // MARK: TERM-034

    private func queriesOnce() {
        guard let v = frontA() else { return }
        clearA(v)
        let py = homeA + "/query.py"
        try? """
        import os, termios, tty, select, time
        fd = 0
        old = termios.tcgetattr(fd)
        tty.setraw(fd)
        buf = b""
        try:
            os.write(1, b"\\x1b[c\\x1b[6n\\x1b[>c")
            end = time.time() + 1.5
            while time.time() < end:
                r, _, _ = select.select([fd], [], [], 0.05)
                if r:
                    buf += os.read(fd, 4096)
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)
        print("QUERIES", buf.count(b"\\x1b[?"), buf.count(b"R"), buf.count(b"\\x1b[>"), buf.hex())
        """.write(toFile: py, atomically: true, encoding: .utf8)
        typeLine(v, "python3 ~/query.py")
        var line = ""
        _ = waitFor(6) {
            line = self.textOf(v).split(separator: "\n").first { $0.hasPrefix("QUERIES ") }.map(String.init) ?? ""
            return !line.isEmpty
        }
        let parts = line.split(separator: " ")
        // DA1 (ESC [ ?...c), the cursor's place (ESC [ r;c R) and DA2 (ESC [ >...c): each answered once.
        check("queries_answered_once", parts.count >= 4 && parts[1] == "1" && parts[2] == "1" && parts[3] == "1", line)
        _ = promptA(v)
    }

    // MARK: TERM-071

    private func mouseAndFocusToProgram() {
        guard let v = frontA() else { return }
        guard startReader(v, mode: "mouse", tag: "MOUSE") else { return check("mouse_reader", false, textOf(v)) }
        _ = waitFor(3) { v.screen.modes & Screen.modeMouse != 0 }
        let p = main { v.convert(NSPoint(x: v.renderer.padding + 5.5 * v.renderer.fonts.cellWidth / v.renderer.fonts.scale,
                                         y: v.renderer.padding + 3.5 * v.renderer.fonts.cellHeight / v.renderer.fonts.scale), to: nil) }
        func ev(_ t: NSEvent.EventType, button: Int64) -> NSEvent {
            let e = NSEvent.mouseEvent(with: t, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                       windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
            guard button != 0, let cg = e.cgEvent else { return e }
            cg.setIntegerValueField(.mouseEventButtonNumber, value: button)
            return NSEvent(cgEvent: cg) ?? e
        }
        let rd = ev(.rightMouseDown, button: 1)
        let menu = main { v.menu(for: rd) }
        main { v.rightMouseDown(with: rd) }
        main { v.rightMouseUp(with: ev(.rightMouseUp, button: 1)) }
        main { v.otherMouseDown(with: ev(.otherMouseDown, button: 2)) }
        main { v.otherMouseUp(with: ev(.otherMouseUp, button: 2)) }
        sleep(0.3)
        let got = endReader(v, tag: "MOUSE")
        // SGR: right is button 2, middle 1, at column 6 row 4 (1-based); M a press, m a release.
        let want = hex("\u{1b}[<2;6;4M") + hex("\u{1b}[<2;6;4m") + hex("\u{1b}[<1;6;4M") + hex("\u{1b}[<1;6;4m")
        check("mouse_right_middle_reach_program", menu == nil && got.hasPrefix(want), "menu \(menu == nil ? "none" : "shown"), read \(got), want \(want)")
        // Focus: the keyboard leaves the pane, then comes back.
        guard startReader(v, mode: "focus", tag: "FOCUS") else { return check("focus_reader", false, textOf(v)) }
        _ = waitFor(3) { v.screen.modes & Screen.modeFocus != 0 }
        main { _ = window.makeFirstResponder(nil) }
        sleep(0.2)
        main { _ = window.makeFirstResponder(v) }
        sleep(0.3)
        let f = endReader(v, tag: "FOCUS")
        check("focus_out_in_reach_program", f.hasPrefix(hex("\u{1b}[O") + hex("\u{1b}[I")), "read \(f)")
    }

    // MARK: TERM-067

    private func inputMethods() {
        guard let v = frontA() else { return }
        clearA(v)
        let before = main { v.screen.text() }
        let beforeRows = before.split(separator: "\n").first { $0.hasPrefix("~ >") }.map(String.init) ?? ""
        let p0 = pictureA(v)
        // Composing: the input method sets its marked text, as it does while "nihon" is typed.
        main { v.setMarkedText("にほん", selectedRange: NSRange(location: 3, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0)) }
        sleep(0.4)
        let during = main { v.screen.text() }
        let p1 = pictureA(v)
        // The marked text drawn at the cursor: the cells after the prompt change.
        let c = main { v.screen.cursor }
        var changed = 0
        for col in (c.x + 1)..<(c.x + 6) {
            let (x, y) = cellMiddle(v, col: col, row: c.y)
            for dy in -6...6 where pixel(p0, x, y + dy) != pixel(p1, x, y + dy) { changed += 1 }
        }
        savePNGA(v, "selftest-ime-marked.png")
        check("ime_composing_sends_nothing", during == before && main { v.hasMarkedText() } && changed > 10,
              "line \(during.split(separator: "\n").first { $0.hasPrefix("~ >") } ?? "") was \(beforeRows), drawn pixels changed \(changed)")
        // Commit: the input method inserts the text and ends the marked text.
        main { v.insertText("日本", replacementRange: NSRange(location: NSNotFound, length: 0)) }
        let committed = waitFor(3) { self.textOf(v).contains("~ > 日本") }
        sleep(0.3)
        let line = textOf(v).split(separator: "\n").first { $0.hasPrefix("~ >") }.map(String.init) ?? ""
        check("ime_commit_sends_once", committed && line.trimmingCharacters(in: .whitespaces) == "~ > 日本" && !main { v.hasMarkedText() }, "line \"\(line)\"")
        keyA("\u{15}", "u", code: 0x20, flags: .control) // Ctrl+U
        sleep(0.2)
        // A dead key (Option+E then E): the system's input context composes it
        // with the same calls, the accent marked ("´"), then "é" committed. An
        // app off every screen is never active, so its input context is not:
        // the calls are made as the input context makes them.
        main { v.setMarkedText("\u{B4}", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0)) }
        sleep(0.3)
        let accentOnly = (textOf(v).split(separator: "\n").first { $0.hasPrefix("~ >") }.map(String.init) ?? "").trimmingCharacters(in: .whitespaces) == "~ >"
        main { v.insertText("\u{E9}", replacementRange: NSRange(location: NSNotFound, length: 0)) }
        let dead = waitFor(3) { self.textOf(v).contains("~ > \u{E9}") }
        sleep(0.2)
        let dl = textOf(v).split(separator: "\n").first { $0.hasPrefix("~ >") }.map(String.init) ?? ""
        check("dead_key_accent_composed", accentOnly && dead && dl.trimmingCharacters(in: .whitespaces) == "~ > \u{E9}", "line \"\(dl)\", nothing sent while the accent was marked: \(accentOnly)")
        keyA("\u{15}", "u", code: 0x20, flags: .control)
        sleep(0.2)
    }

    // MARK: TERM-020

    /// Prints a row of 16 colours, one of 256 and a truecolor one as
    /// backgrounds, and reads the pixels drawn in each.
    func colours(tag: String) {
        guard let v = frontA() else { return check("colours_\(tag)", false, "no view") }
        clearA(v)
        typeLine(v, #"for i in {0..15}; do printf "\e[48;5;${i}m  "; done; printf '\e[0m C16\n\e[48;5;196m  \e[48;5;21m  \e[48;5;46m  \e[0m C256\n\e[48;2;18;52;86m  \e[38;2;250;128;114mXX\e[0m CTRUE\n'"#)
        guard waitFor(5, { self.textOf(v).contains("CTRUE") }) else { return check("colours_\(tag)", false, textOf(v)) }
        sleep(0.4)
        let rows = textOf(v).split(separator: "\n", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        guard let r16 = rows.firstIndex(where: { $0.hasSuffix("C16") }),
              let r256 = rows.firstIndex(where: { $0.hasSuffix("C256") }), let rt = rows.firstIndex(where: { $0.hasSuffix("CTRUE") }) else {
            return check("colours_\(tag)", false, rows.joined(separator: "|"))
        }
        let p = pictureA(v)
        let th = main { v.renderer.theme }
        func want(_ c: SIMD4<Float>) -> (Int, Int, Int) { (Int((c.x * 255).rounded()), Int((c.y * 255).rounded()), Int((c.z * 255).rounded())) }
        func near(_ a: (r: Int, g: Int, b: Int), _ b: (Int, Int, Int)) -> Bool { abs(a.r - b.0) <= 3 && abs(a.g - b.1) <= 3 && abs(a.b - b.2) <= 3 }
        var bad: [String] = []
        for i in 0..<16 {
            let (x, y) = cellMiddle(v, col: 2 * i, row: r16)
            let got = pixel(p, x, y), w = want(th.ansi[i])
            if !near(got, w) { bad.append("ansi \(i) \(got) want \(w)") }
        }
        for (k, w) in [(0, (255, 0, 0)), (1, (0, 0, 255)), (2, (0, 255, 0))] {
            let (x, y) = cellMiddle(v, col: 2 * k, row: r256)
            if !near(pixel(p, x, y), w) { bad.append("256 #\(k) \(pixel(p, x, y)) want \(w)") }
        }
        let (tx, ty) = cellMiddle(v, col: 0, row: rt)
        if !near(pixel(p, tx, ty), (18, 52, 86)) { bad.append("truecolor bg \(pixel(p, tx, ty))") }
        // The truecolor foreground: the glyph's brightest pixel in its colour.
        let f = v.renderer.fonts
        let (gx, gy) = cellMiddle(v, col: 2, row: rt)
        var best = (r: 0, g: 0, b: 0)
        for dx in -Int(f.cellWidth) / 2..<Int(f.cellWidth) / 2 {
            for dy in -Int(f.cellHeight) / 3..<Int(f.cellHeight) / 3 {
                let q = pixel(p, gx + dx, gy + dy)
                if q.r + q.g + q.b > best.r + best.g + best.b { best = q }
            }
        }
        if !near(best, (250, 128, 114)) && !(best.r > 230 && abs(best.g - 128) < 20 && abs(best.b - 114) < 20) { bad.append("truecolor fg \(best)") }
        savePNGA(v, "selftest-colours-\(tag).png")
        check("colours_drawn_\(tag)", bad.isEmpty, bad.isEmpty ? "16, 256 (196, 21, 46) and truecolor (18,52,86 bg, 250,128,114 fg) as asked" : bad.joined(separator: "; "))
    }

    private func coloursAfterTabSwitch() {
        // Cmd+T, then Cmd+1 back: the first tab's colours drawn again from its kept rows and its new stream.
        let n = wsA { $0.tabs.count }
        keyA("t", "t", code: 0x11, flags: .command)
        _ = waitFor(5) { self.wsA { $0.tabs.count } == n + 1 }
        _ = promptA(frontA())
        let made = wsA { $0.tabs.last?.host }
        keyA("1", "1", code: 0x12, flags: .command)
        _ = waitFor(3) { self.wsA { $0.active === $0.tabs.first } }
        sleep(0.5)
        colours(tag: "after_tab_switch")
        // The tab Cmd+T made goes again.
        if let m = made, let t = wsA({ $0.tabs.first { $0.host == m } }) { main { workspace.closeTab(t) } }
        _ = waitFor(3) { self.wsA { $0.tabs.count } == n }
    }

    /// After the relaunch (restoreCheck): the colours drawn by the app started again.
    func termAfterRelaunch() {
        colours(tag: "after_relaunch")
    }

    // MARK: TERM-030

    private func findMarksOnScrollbar() {
        guard let v = frontA() else { return }
        clearA(v)
        typeLine(v, "seq 1 400 | awk '{print ($1%50==0) ? \"mark\" \"x \" $1 : \"row \" $1}'")
        guard waitFor(5, { self.textOf(v).contains("row 399") }) else { return check("find_marks_text", false, textOf(v)) }
        _ = promptA(v)
        keyA("f", "f", code: 0x03, flags: .command)
        guard let bar = main({ v.findBar }) else { return check("find_marks_bar", false) }
        main { bar.editor.insertText("markx", replacementRange: NSRange(location: NSNotFound, length: 0)) }
        let counted = waitFor(3) { self.main { bar.count.stringValue } == "1 of 8" }
        _ = waitFor(3) { self.main { v.findMarks.rows.count } == 8 }
        sleep(0.3)
        let rows = main { v.findMarks.rows }, lines = main { v.findMarks.lines }
        let p = pictureA(v)
        let s = Int(v.renderer.fonts.scale)
        let x = p.w - 2 * s - 3 * s
        // The marks down the track: runs of the match colour, and one of the selected one's.
        var runs: [(y: Int, amber: Bool)] = []
        var inRun = false
        for y in 0..<p.h {
            let q = pixel(p, x, y)
            let gold = abs(q.r - 0xC9) < 12 && abs(q.g - 0xA2) < 12 && abs(q.b - 0x27) < 16
            let amber = abs(q.r - 0xFF) < 12 && abs(q.g - 0x9F) < 12 && q.b < 30
            if gold || amber {
                if !inRun { runs.append((y, amber)) } else if amber { runs[runs.count - 1].amber = true }
                inRun = true
            } else { inRun = false }
        }
        savePNGA(v, "selftest-find-marks.png")
        let spread = runs.count >= 2 && runs.last!.y - runs.first!.y > p.h / 3
        check("find_marks_on_scrollbar", counted && rows.count == 8 && lines > 400 && runs.count == 8 && runs.filter(\.amber).count == 1 && spread,
              "label \(main { bar.count.stringValue }), rows \(rows) of \(lines), drawn marks at \(runs.map { "\($0.y)\($0.amber ? "*" : "")" })")
        main { v.closeFindBar() }
        sleep(0.3)
        let p2 = pictureA(v)
        let left = (0..<p2.h).filter { y in let q = pixel(p2, x, y); return abs(q.r - 0xC9) < 12 && abs(q.g - 0xA2) < 12 && abs(q.b - 0x27) < 16 }.count
        check("find_marks_gone_with_bar", left == 0, "\(left) marked pixels after Esc")
        clearA(v)
    }

    // MARK: TERM-031

    private func copyPathUnknown() {
        guard let v = frontA() else { return }
        let p = main { v.convert(NSPoint(x: v.bounds.midX, y: v.bounds.midY), to: nil) }
        let known = main { v.contextMenu(at: p).items.first { $0.title == t("term.copyPath") }?.isEnabled ?? false }
        // A pane whose folder the daemon does not know (no cwd in pane.list, no OSC 7).
        let was = main { v.folderPath }
        main { v.folderPath = { nil } }
        let unknown = main { v.contextMenu(at: p).items.first { $0.title == t("term.copyPath") }?.isEnabled ?? true }
        main { v.folderPath = was }
        check("menu_copy_path_off_when_unknown", known && !unknown, "known folder: on \(known); unknown: on \(unknown)")
    }

    // MARK: TERM-019

    private func bigUpdate() {
        guard let v = frontA() else { return }
        clearA(v)
        let py = homeA + "/big.py"
        try? """
        import sys
        out = sys.stdout.buffer
        line = b"0123456789abcdefghijklmnopqrstuvwxyz" * 2 + b"\\r\\n"
        out.write(b"\\x1b[?2026h")
        for i in range(30000):
            out.write(b"%06d " % i + line)
        out.write(b"BIGEND\\r\\n\\x1b[?2026l")
        out.flush()
        """.write(toFile: py, atomically: true, encoding: .utf8)
        // The main thread's longest wait while 2.3 MB arrive in one synchronized update.
        var longest = 0.0
        let t0 = CACurrentMediaTime()
        typeLine(v, "python3 ~/big.py")
        var done = false
        while !done && CACurrentMediaTime() - t0 < 20 {
            let a = CACurrentMediaTime()
            main { }
            longest = max(longest, CACurrentMediaTime() - a)
            done = textOf(v).contains("BIGEND")
            sleep(0.005)
        }
        let took = CACurrentMediaTime() - t0
        _ = promptA(v)
        // Whole: the last rows are the update's last lines in order, no row half drawn.
        let rows = textOf(v).split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        let nums = rows.compactMap { r -> Int? in r.count > 8 && r.hasSuffix("uvwxyz") ? Int(r.prefix(6)) : nil }
        let inOrder = !nums.isEmpty && zip(nums, nums.dropFirst()).allSatisfy { $1 == $0 + 1 } && nums.last == 29999
        check("big_update_whole_never_freezes", done && inOrder && longest < 0.1,
              String(format: "2.3 MB in one synchronized update: shown after %.2f s, the main thread's longest wait %.1f ms, last rows %d..%d in order %@", took, longest * 1000, nums.first ?? -1, nums.last ?? -1, inOrder ? "yes" : "no"))
        clearA(v)
    }

    // MARK: TERM-064

    private func exitCloses() {
        let n = wsA { $0.tabs.count }
        keyA("t", "t", code: 0x11, flags: .command)
        guard waitFor(5, { self.wsA { $0.tabs.count } == n + 1 }), let v = frontA(), promptA(v) else { return check("exit_setup", false) }
        let pane = v.pane
        typeLine(v, "exit")
        let gone = waitFor(5) { self.wsA { $0.tabs.count } == n && !self.wsA { $0.tabs.contains { $0.host == pane } } }
        let left = paneList().contains { $0["id"] as? String == pane && ($0["state"] as? String ?? "running") == "running" }
        check("exit_closes_tab", gone && !left, "tabs \(wsA { $0.tabs.count }) of \(n), pane still running \(left)")
        // A split: exit in one pane, the tab stays with the other, unsplit.
        keyA("t", "t", code: 0x11, flags: .command)
        guard waitFor(5, { self.wsA { $0.tabs.count } == n + 1 }), let host = frontA(), promptA(host) else { return check("exit_split_setup", false) }
        keyA("d", "d", code: 0x02, flags: .command)
        guard waitFor(5, { self.wsA { $0.active?.guest != nil } }), let guest = frontA(), guest !== host, promptA(guest) else {
            return check("exit_split_setup", false, "no split")
        }
        let tab = wsA { $0.active }
        typeLine(guest, "exit")
        let unsplit = waitFor(5) { self.wsA { _ in tab?.guest == nil } }
        let hostStays = wsA { $0.tabs.contains { $0 === tab } } && paneList().contains { $0["id"] as? String == host.pane }
        let whole = waitFor(3) { self.main { host.bounds.width > self.window.contentLayoutRect.width * 0.8 } }
        check("exit_in_split_keeps_other_whole", unsplit && hostStays && whole && wsA { $0.focusedView } === host,
              "guest \(tab?.guest ?? "none"), host there \(hostStays), host width \(main { host.bounds.width }) of \(main { window.contentLayoutRect.width })")
        typeLine(host, "exit")
        _ = waitFor(5) { self.wsA { $0.tabs.count } == n }
    }

    // MARK: TERM-063

    private func middleClickBusy() {
        let n = wsA { $0.tabs.count }
        keyA("t", "t", code: 0x11, flags: .command)
        guard waitFor(5, { self.wsA { $0.tabs.count } == n + 1 }), let v = frontA(), promptA(v) else { return check("middle_busy_setup", false) }
        let pane = v.pane
        typeLine(v, "sleep 100")
        sleep(0.8)
        let item = wsA { w in w.bar.items.first { $0.model.id == w.active?.id } }
        func middle() {
            let up = NSEvent.mouseEvent(with: .otherMouseUp, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                        windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 0)!
            guard let cg = up.cgEvent else { return }
            cg.setIntegerValueField(.mouseEventButtonNumber, value: 2)
            main { item?.otherMouseUp(with: NSEvent(cgEvent: cg)!) }
        }
        let asked0 = wsA { $0.closeAsked.count }
        let was = wsA { $0.closeAnswer }
        main { workspace.settings.set(["confirmCloseBusy": true]) }
        _ = waitFor(3) { self.wsA { $0.look.confirmClose } }
        main { workspace.closeAnswer = (false, false) } // Cancel
        middle()
        let asked = waitFor(3) { self.wsA { $0.closeAsked.count } == asked0 + 1 }
        sleep(0.3)
        let tabKept = wsA { $0.tabs.count } == n + 1, paneKept = paneList().contains { $0["id"] as? String == pane }
        let words = wsA { $0.closeAsked.last ?? "" }
        check("middle_click_busy_asks", asked && tabKept && paneKept && words.hasPrefix(t("close.title.tab")),
              "asked \(asked): \"\(words)\", the tab kept \(tabKept) (\(wsA { $0.tabs.count }) of \(n + 1)), its pane running \(paneKept)")
        main { workspace.closeAnswer = (true, false) } // Close
        middle()
        let closed = waitFor(5) { self.wsA { $0.tabs.count } == n && !self.paneList().contains { $0["id"] as? String == pane } }
        check("middle_click_busy_close_closes", closed, "tabs \(wsA { $0.tabs.count })")
        main { workspace.closeAnswer = was }
    }

    // MARK: TERM-072

    private func fontGrowsWindow() {
        guard let v = frontA() else { return }
        let frame0 = main { window.frame }
        // As small as it goes at 13 pt.
        main { window.setContentSize(window.contentMinSize) }
        sleep(0.5)
        let small = main { window.contentRect(forFrameRect: window.frame).size }
        for _ in 0..<11 { keyA("=", "=", code: 0x18, flags: .command); sleep(0.05) } // 13 to 24 pt
        _ = waitFor(3) { v.renderer.fontSize == 24 }
        sleep(0.8)
        let big = main { window.contentRect(forFrameRect: window.frame).size }
        let minNow = main { window.contentMinSize }
        let g = main { v.gridSize }
        let daemonGrid = paneList().first { $0["id"] as? String == v.pane }.map { (($0["cols"] as? NSNumber)?.intValue ?? 0, ($0["rows"] as? NSNumber)?.intValue ?? 0) } ?? (0, 0)
        let framesGrid = v.screen.cols >= 40 && v.screen.rows >= 10
        check("font_bigger_grows_window", v.renderer.fontSize == 24 && big.width >= minNow.width && big.height >= minNow.height && big.width > small.width && g.cols >= 40 && g.rows >= 10 && daemonGrid.0 >= 40 && daemonGrid.1 >= 10 && framesGrid,
              "at 13 pt \(small), at 24 pt \(big) (smallest \(minNow)), grid \(g), the daemon's \(daemonGrid)")
        keyA("0", "0", code: 0x1D, flags: .command)
        _ = waitFor(3) { v.renderer.fontSize == 13 }
        main { window.setFrame(frame0, display: true) }
        sleep(0.5)
    }

    // MARK: TERM-017

    private func hiddenTabResize() {
        let n = wsA { $0.tabs.count }
        guard let a = frontA() else { return }
        let frame0 = main { window.frame }
        // Columns at once: a narrower window, the frames at the new width.
        var f = frame0
        f.size.width -= 160
        let t0 = CACurrentMediaTime()
        main { window.setFrame(f, display: true) }
        let want = main { a.gridSize }
        let cols = waitFor(2) { a.screen.cols == want.cols }
        let colsAfter = CACurrentMediaTime() - t0
        check("resize_columns_at_once", cols && want.cols < 200 && colsAfter < 0.25, String(format: "%d columns in the frames %.0f ms after the step", want.cols, colsAfter * 1000))
        // A tab hidden during a resize.
        keyA("t", "t", code: 0x11, flags: .command)
        guard waitFor(5, { self.wsA { $0.tabs.count } == n + 1 }), let b = frontA(), promptA(b) else { return check("hidden_resize_setup", false) }
        var g = frame0
        g.size.width += 120
        g.size.height += 80
        main { window.setFrame(g, display: true) }
        sleep(0.5)
        let hiddenCols = a.screen.cols
        keyA("1", "1", code: 0x12, flags: .command)
        let t1 = CACurrentMediaTime()
        let wantA = main { a.gridSize }
        let shown = waitFor(3) { a.screen.cols == wantA.cols && a.screen.rows == wantA.rows }
        let tookShown = CACurrentMediaTime() - t1
        let daemon = paneList().first { $0["id"] as? String == a.pane }.map { (($0["cols"] as? NSNumber)?.intValue ?? 0, ($0["rows"] as? NSNumber)?.intValue ?? 0) } ?? (0, 0)
        check("hidden_tab_resizes_when_shown", shown && daemon.0 == wantA.cols && daemon.1 == wantA.rows && hiddenCols != wantA.cols,
              String(format: "hidden at %d columns, shown at %dx%d (the daemon's %dx%d) %.0f ms after Cmd+1", hiddenCols, wantA.cols, wantA.rows, daemon.0, daemon.1, tookShown * 1000))
        let made = b.pane
        if let tb = wsA({ $0.tabs.first { $0.host == made } }) { main { workspace.closeTab(tb) } }
        _ = waitFor(3) { self.wsA { $0.tabs.count } == n }
        main { window.setFrame(frame0, display: true) }
        sleep(0.5)
    }

    // MARK: TERM-068 (selftest.sh's third launch)

    /// The end of the relaunch: the shell in front goes to a folder of its
    /// own, then every tab is closed, so the next launch has none to bring back.
    func lastFolderLeave() -> String {
        guard let v = frontA() else { return "" }
        let dir = homeA + "/last folder"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        clearA(v)
        typeLine(v, "cd ~/last\\ folder")
        _ = waitFor(3) { self.wsA { $0.paneInfo(v.pane)?.cwd } == dir }
        sleep(0.5)
        main { workspace.flush() }
        for tb in wsA({ $0.tabs }) { main { workspace.closeTab(tb) } }
        _ = waitFor(5) { self.wsA { $0.tabs.isEmpty } }
        sleep(0.5)
        main { workspace.flush() }
        return dir
    }

    /// The third launch: no tab came back; the new shell is in the last folder.
    func lastFolderCheck() {
        let dir = homeA + "/last folder"
        guard let v = frontA() else { return check("last_folder_shell", false, "no view") }
        let cwd = paneList().first { $0["id"] as? String == v.pane }?["cwd"] as? String ?? ""
        _ = promptA(v)
        typeLine(v, "pwd")
        let printed = waitFor(3) { self.textOf(v).contains("\n" + dir) || self.textOf(v).hasPrefix(dir) }
        check("last_folder_new_shell_there", wsA { $0.tabs.count } == 1 && cwd == dir && printed, "cwd \(cwd), pwd printed \(printed), want \(dir)")
    }
}
