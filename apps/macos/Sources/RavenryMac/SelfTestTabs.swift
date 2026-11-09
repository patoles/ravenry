// The self-test's keys, tabs and splits (SelfTest.swift runs it last):
// every shortcut goes the way AppKit delivers a person's key (the
// window's views, then the menu, then the view with the keyboard); a
// tab's click, drag and middle click and the divider's drag and double
// click go through the views' own handlers. Each check reads the model,
// the views, the daemon's panes and window.json.
//
// --restore-check reads what a self-test run left (selftest.json's
// "restore") and checks that the window came back with those tabs,
// splits and tab in front.

import AppKit

extension SelfTest {
    private func ws<T>(_ f: (Workspace) -> T) -> T { DispatchQueue.main.sync { f(workspace) } }

    /// A key as AppKit delivers it: a key equivalent to the window's
    /// views, then to the menu, else a keyDown to the first responder.
    func deliver(_ chars: String, code: UInt16, flags: NSEvent.ModifierFlags = []) {
        var f = flags
        if [0x7B, 0x7C, 0x7D, 0x7E].contains(code) { f.formUnion([.numericPad, .function]) }
        if code == 0x75 { f.formUnion(.function) }
        let ign = flags.contains(.shift) ? chars : chars.lowercased()
        let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: f, timestamp: ProcessInfo.processInfo.systemUptime,
                                 windowNumber: window.windowNumber, context: nil, characters: chars,
                                 charactersIgnoringModifiers: ign, isARepeat: false, keyCode: code)!
        DispatchQueue.main.sync {
            if f.contains(.command) || f.contains(.control) {
                if window.performKeyEquivalent(with: e) { return }
                if NSApp.mainMenu?.performKeyEquivalent(with: e) == true { return }
            }
            window.firstResponder?.keyDown(with: e)
        }
    }

    private func arrow(_ code: UInt16) -> String {
        let k: Int = [0x7B: NSLeftArrowFunctionKey, 0x7C: NSRightArrowFunctionKey, 0x7D: NSDownArrowFunctionKey, 0x7E: NSUpArrowFunctionKey][code]!
        return String(UnicodeScalar(k)!)
    }

    private func focusedText(_ v: TerminalView?) -> String { v?.screen.text() ?? "" }

    /// The command line after the prompt, and the cursor's column.
    private func promptLine(_ v: TerminalView) -> (String, Int) {
        v.screen.lock()
        defer { v.screen.unlock() }
        // The cursor's row: the prompt and the command line.
        let t = v.screen.rowText(v.screen.cursor.y)
        let line = t.hasPrefix("~ >") ? String(t.dropFirst(3)).replacingOccurrences(of: "^ |\\s+$", with: "", options: .regularExpression) : "?" + t
        return (line, v.screen.cursor.x)
    }

    // MARK: a Mac's keys at the prompt (docs/RENDERING.md, Key bindings)

    func macKeys() {
        let v = view
        let line = "echo one two three"
        let L: UInt16 = 0x7B, R: UInt16 = 0x7C
        let cases: [(String, [(String, UInt16, NSEvent.ModifierFlags)], Int, String)] = [
            ("key_cmd_left_line_start", [(arrow(L), L, .command)], 4, line),
            ("key_cmd_right_line_end", [(arrow(L), L, .command), (arrow(R), R, .command)], 22, line),
            ("key_option_left_word", [(arrow(L), L, .option), (arrow(L), L, .option)], 13, line),
            ("key_option_right_word", [(arrow(L), L, .command), (arrow(R), R, .option)], 9, line),
            ("key_cmd_backspace_line", [("\u{7f}", 0x33, .command)], 4, ""),
            ("key_option_backspace_word", [("\u{7f}", 0x33, .option)], 17, "echo one two"),
            ("key_option_delete_word", [(arrow(L), L, .command), (String(UnicodeScalar(NSDeleteFunctionKey)!), 0x75, .option)], 4, " one two three"),
            ("key_cmd_delete_line_end", [(arrow(L), L, .option), (String(UnicodeScalar(NSDeleteFunctionKey)!), 0x75, .command)], 17, "echo one two"),
            ("key_ctrl_left_word", [(arrow(L), L, .control), (arrow(L), L, .control)], 13, line),
            ("key_ctrl_right_word", [(arrow(L), L, .command), (arrow(R), R, .control)], 9, line),
        ]
        for (name, keys, x, text) in cases {
            main { v.sendEvents([["text": "\u{15}" + line]]) }
            _ = waitFor(3) { self.promptLine(v).0 == line && self.promptLine(v).1 == 22 }
            for k in keys { deliver(k.0, code: k.1, flags: k.2) }
            let ok = waitFor(2) { self.promptLine(v) == (text, x) }
            let got = promptLine(v)
            check(name, ok, "cursor \(got.1), line \"\(got.0)\"")
        }
        main { v.sendEvents([["text": "\u{15}"]]) }
        _ = waitFor(2) { self.promptLine(v).0.isEmpty }
    }

    // MARK: tabs and splits

    private func count() -> Int { ws { $0.tabs.count } }
    private func activeIndex() -> Int { ws { w in w.tabs.firstIndex { $0 === w.active } ?? -1 } }
    private func paneIds() -> Set<String> {
        guard let r = try? workspace.conn.call("pane.list", [:]) else { return [] }
        return Set((r["panes"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String })
    }
    private func savedLayout() -> [String: Any] {
        guard let d = ProcessInfo.processInfo.environment["RAVENRY_DESKTOP_DATA"],
              let data = try? Data(contentsOf: URL(fileURLWithPath: d).appendingPathComponent("window.json")) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
    private func prompt(_ v: TerminalView?) -> Bool { waitFor(5) { self.focusedText(v).contains("~ >") } }
    private func front() -> TerminalView? { ws { $0.focusedView } }

    func tabsAndSplits() {
        // Cmd+T: a new tab, in front, with a shell at its prompt.
        let n0 = count()
        deliver("t", code: 0x11, flags: .command)
        let t2 = front()
        check("tab_cmd_t_new", count() == n0 + 1 && activeIndex() == n0 && t2 !== view && prompt(t2), "tabs \(count())")
        let shellName = ((ProcessInfo.processInfo.environment["SHELL"] ?? "zsh") as NSString).lastPathComponent
        let m = ws { $0.bar.items.map { $0.model } }
        check("tab_named_like_electron", m.count == n0 + 1 && m[n0].name == shellName && m[n0].sub == "~" && m[n0].active,
              "\(m.map { "\($0.name) \($0.sub ?? "-")" })")
        // The title the program sets names the tab.
        main { t2?.sendEvents([["text": "printf '\\033]0;my title\\007'\r"]]) }
        check("tab_title_from_program", waitFor(3) { self.ws { $0.bar.items.last?.model.name } == "my title" },
              ws { $0.bar.items.last?.model.name ?? "" })
        // The + button.
        let plus = ws { $0.bar.plus }
        main { plus.action?() }
        let t3 = front()
        check("tab_plus_new", count() == n0 + 2 && prompt(t3), "tabs \(count())")

        // Cmd+1, Cmd+Shift+] and [, Ctrl+Tab and Ctrl+Shift+Tab.
        deliver("1", code: 0x12, flags: .command)
        check("tab_cmd_1", activeIndex() == 0, "front \(activeIndex())")
        deliver("2", code: 0x13, flags: .command)
        check("tab_cmd_2", activeIndex() == 1, "front \(activeIndex())")
        deliver("}", code: 0x1E, flags: [.command, .shift])
        check("tab_cmd_shift_bracket_next", activeIndex() == 2, "front \(activeIndex())")
        deliver("{", code: 0x21, flags: [.command, .shift])
        check("tab_cmd_shift_bracket_previous", activeIndex() == 1, "front \(activeIndex())")
        deliver("\t", code: 0x30, flags: .control)
        check("tab_ctrl_tab_next", activeIndex() == 2, "front \(activeIndex())")
        deliver("\u{19}", code: 0x30, flags: [.control, .shift])
        check("tab_ctrl_shift_tab_previous", activeIndex() == 1, "front \(activeIndex())")

        // A tab not in front has no stream and draws nothing while its
        // program prints; back in front it shows its rows at once.
        let busy = front()!
        let busyIndex = activeIndex()
        main { busy.sendEvents([["text": "for i in $(seq 1 60); do echo tick $i; sleep 0.02; done\r"]]) }
        _ = waitFor(3) { self.focusedText(busy).contains("tick 3") }
        var hiddenDraws = 0
        main { busy.onDraw = { _, _ in hiddenDraws += 1 } }
        deliver("1", code: 0x12, flags: .command)
        sleep(0.6)
        let (live, ch) = main { (busy.live, busy.channel) }
        check("tab_hidden_no_stream_no_draws", !live && ch == 0 && hiddenDraws == 0, "live \(live), channel \(ch), draws \(hiddenDraws)")
        var firstText = ""
        main { busy.onDraw = { _, _ in if firstText.isEmpty { firstText = busy.screen.text() } } }
        let t0 = CACurrentMediaTime()
        deliver("\(busyIndex + 1)", code: [0x12, 0x13, 0x14][busyIndex], flags: .command)
        let firstFrame = waitFor(2) { self.focusedText(busy).contains("tick 60") || busy.screen.frames > 0 && busy.channel != 0 }
        let ms = (CACurrentMediaTime() - t0) * 1000
        _ = waitFor(3) { self.focusedText(busy).contains("tick 60") }
        main { busy.onDraw = nil }
        check("tab_show_draws_rows_at_once", firstFrame && firstText.contains("tick") && busy.channel != 0,
              String(format: "first draw had rows: %@, stream back in %.1f ms", firstText.contains("tick") ? "yes" : "no", ms))
        check("tab_show_catches_up", focusedText(busy).contains("tick 60"))

        // A drag along the strip moves a tab; window.json keeps the order.
        let before = ws { $0.tabs.map { $0.id } }
        let item = ws { $0.bar.items[0] }
        let other = ws { $0.bar.items[1] }
        func ev(_ type: NSEvent.EventType, _ x: CGFloat, button: Int = 0) -> NSEvent {
            let p = main { item.superview!.convert(NSPoint(x: x, y: 20), to: nil) }
            return NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                      windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        }
        let x0 = main { item.frame.midX }, x1 = main { other.frame.maxX + 4 }
        main { item.mouseDown(with: ev(.leftMouseDown, x0)) }
        for k in 1...10 { main { item.mouseDragged(with: ev(.leftMouseDragged, x0 + (x1 - x0) * CGFloat(k) / 10)) } }
        main { item.mouseUp(with: ev(.leftMouseUp, x1)) }
        let after = ws { $0.tabs.map { $0.id } }
        sleep(0.4)
        let savedOrder = savedLayout()["order"] as? [String] ?? []
        check("tab_drag_reorders", after.count == before.count && after[1] == before[0] && after[0] == before[1],
              "\(before) -> \(after)")
        check("tab_order_saved", savedOrder.filter { after.contains($0) } == after, "\(savedOrder)")

        // Cmd+D: split right, the new pane with the keyboard; the header,
        // the ring, the split count on the tab.
        deliver("1", code: 0x12, flags: .command)
        let host = front()!
        deliver("d", code: 0x02, flags: .command)
        let guest = front()
        let tab = ws { $0.active! }
        let boxes = ws { w in w.panes(of: tab).compactMap { w.boxes[$0] } }
        let frames = main { boxes.map { $0.convert($0.bounds, to: nil) } }
        check("split_cmd_d_right", tab.guest != nil && tab.side == "right" && tab.focus == 1 && guest !== host && prompt(guest) &&
              frames.count == 2 && frames[1].minX >= frames[0].maxX + Design.gutter - 0.5, "\(frames)")
        check("split_keyboard_to_new", main { window.firstResponder === guest })
        check("split_tab_shows_2", ws { $0.bar.items.first { $0.model.active }?.model.split } == true)
        check("split_headers_ring", main { boxes.allSatisfy { $0.showsHead } && boxes[1].inFocus && !boxes[0].inFocus && host.alphaValue < 1 })
        // Each pane's grid is its own, and the daemon's.
        func daemonSize(_ id: String) -> (Int, Int) {
            let r = (try? workspace.conn.call("pane.list", [:]))?["panes"] as? [[String: Any]] ?? []
            let p = r.first { $0["id"] as? String == id } ?? [:]
            return ((p["cols"] as? NSNumber)?.intValue ?? 0, (p["rows"] as? NSNumber)?.intValue ?? 0)
        }
        sleep(0.3)
        let hg = main { host.gridSize }, gg = main { guest!.gridSize }
        check("split_grids_daemon", daemonSize(host.pane) == (hg.cols, hg.rows) && daemonSize(guest!.pane) == (gg.cols, gg.rows),
              "host \(hg) daemon \(daemonSize(host.pane)), guest \(gg) daemon \(daemonSize(guest!.pane))")

        // Cmd+Option+Left: the keyboard to the left pane; a click: back.
        deliver(arrow(0x7B), code: 0x7B, flags: [.command, .option])
        check("split_cmd_option_left", main { window.firstResponder === host } && tab.focus == 0)
        deliver(arrow(0x7C), code: 0x7C, flags: [.command, .option])
        check("split_cmd_option_right", main { window.firstResponder === guest } && tab.focus == 1)
        let click = NSEvent.mouseEvent(with: .leftMouseDown, location: main { host.convert(NSPoint(x: 40, y: 40), to: nil) }, modifierFlags: [],
                                       timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
                                       eventNumber: 0, clickCount: 1, pressure: 1)!
        main { host.mouseDown(with: click); host.mouseUp(with: click) }
        check("split_click_focuses", main { window.firstResponder === host } && tab.focus == 0)

        // The divider: dragged (as AppKit's tracking moves it), the share
        // kept and the pane resized in the daemon; a double click evens.
        let sv = main { boxes[0].superview as? PaneSplitView }
        main { sv?.beginDrag(); sv?.setFraction(0.3); sv?.endDrag() }
        sleep(0.4)
        let hg2 = main { host.gridSize }
        check("split_divider_drag", abs(tab.size - 30) < 1 && hg2.cols < hg.cols && daemonSize(host.pane) == (hg2.cols, hg2.rows),
              "size \(tab.size), host \(hg) -> \(hg2), daemon \(daemonSize(host.pane))")
        let dpt = main { () -> NSPoint in
            let a = sv!.arrangedSubviews[0].frame
            return sv!.convert(NSPoint(x: a.maxX + 3, y: 50), to: nil)
        }
        let dbl = NSEvent.mouseEvent(with: .leftMouseDown, location: dpt, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                     windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 2, pressure: 1)!
        main { sv?.mouseDown(with: dbl) }
        check("split_double_click_evens", abs(tab.size - 50) < 1, "size \(tab.size)")
        main { sv?.setFraction(0.4); sv?.endDrag() }
        deliver("=", code: 0x18, flags: [.command, .control])
        check("split_cmd_ctrl_equal_evens", abs(tab.size - 50) < 1, "size \(tab.size)")
        sleep(0.4)
        let saved = savedLayout()
        let sp = (saved["splits"] as? [[String: Any]] ?? []).first { $0["host"] as? String == tab.id }
        check("split_saved", sp?["guest"] as? String == "s:" + (tab.guest ?? "") && sp?["side"] as? String == "right"
              && saved["active"] as? String == tab.id, "\(sp ?? [:])")

        // Cmd+Shift+Enter: the pane with the keyboard alone, and back.
        deliver("\r", code: 0x24, flags: [.command, .shift])
        let zoomed = main { (tab.zoom, host.superview?.superview is StageView || host.superview is StageView, guest!.window == nil) }
        deliver("\r", code: 0x24, flags: [.command, .shift])
        check("split_zoom", zoomed.0 && zoomed.1 && zoomed.2 && !tab.zoom && main { guest!.window != nil }, "\(zoomed)")

        // Cmd+Shift+D: split down, in another tab.
        deliver("3", code: 0x14, flags: .command)
        deliver("D", code: 0x02, flags: [.command, .shift])
        let down = ws { $0.active! }
        let dboxes = ws { w in w.panes(of: down).compactMap { w.boxes[$0] } }
        let dframes = main { dboxes.map { $0.convert($0.bounds, to: nil) } }
        check("split_cmd_shift_d_down", down.guest != nil && down.side == "down" && prompt(front()) && dframes.count == 2
              && abs(dframes[0].minX - dframes[1].minX) < 1, "\(dframes)")
        // Cmd+D on a split tab: a new tab, as the Electron app.
        let n1 = count()
        deliver("d", code: 0x02, flags: .command)
        check("split_on_split_tab_new_tab", count() == n1 + 1 && ws { $0.active!.guest } == nil)

        // Cmd+W in a split: that pane closes and its tab is whole.
        deliver("3", code: 0x14, flags: .command)
        let gone = ws { $0.active!.focusedPane }
        deliver("w", code: 0x0D, flags: .command)
        sleep(0.4)
        check("split_cmd_w_closes_pane", ws { $0.tabs[2].guest } == nil && !paneIds().contains(gone), "gone \(gone)")
        // Cmd+W on a whole tab: the tab and its pane go.
        let n2 = count()
        let lastPane = ws { $0.tabs.last!.host }
        deliver("\(n2)", code: [0x12, 0x13, 0x14, 0x15, 0x17, 0x16, 0x1A, 0x1C, 0x19][n2 - 1], flags: .command)
        deliver("w", code: 0x0D, flags: .command)
        sleep(0.4)
        check("tab_cmd_w_closes", count() == n2 - 1 && !paneIds().contains(lastPane) && activeIndex() == n2 - 2, "tabs \(count())")
        // A middle click closes a tab.
        main { workspace.newTab(nil) }
        _ = prompt(front())
        let mid = ws { $0.bar.items.last! }
        let midPane = ws { $0.tabs.last!.host }
        let up = NSEvent.mouseEvent(with: .otherMouseUp, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                    windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 0)!
        // (A made mouse event has button 0; the middle button is 2.)
        if let cg = up.cgEvent {
            cg.setIntegerValueField(.mouseEventButtonNumber, value: 2)
            main { mid.otherMouseUp(with: NSEvent(cgEvent: cg)!) }
        }
        sleep(0.4)
        check("tab_middle_click_closes", count() == n2 - 1 && !paneIds().contains(midPane), "tabs \(count())")

        // The layout a relaunch must restore (selftest.sh runs the app
        // again with --restore-check).
        sleep(0.4)
        restore = ws { w in
            ["order": w.tabs.map { $0.id }, "splits": w.tabs.compactMap { t in t.guest.map { "\(t.id)>\($0)>\(t.side)" } },
             "active": w.active?.id ?? ""]
        }
    }

    // MARK: --restore-check

    func restoreCheck(_ expectFile: String) {
        let data = (try? Data(contentsOf: URL(fileURLWithPath: expectFile))).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
        let want = data?["restore"] as? [String: Any] ?? [:]
        let got = ws { w -> [String: Any] in
            ["order": w.tabs.map { $0.id }, "splits": w.tabs.compactMap { t in t.guest.map { "\(t.id)>\($0)>\(t.side)" } },
             "active": w.active?.id ?? ""]
        }
        check("restore_tabs_order", (got["order"] as? [String]) == (want["order"] as? [String]) && !(got["order"] as? [String] ?? []).isEmpty,
              "\(got["order"] ?? "") want \(want["order"] ?? "")")
        check("restore_splits", (got["splits"] as? [String]) == (want["splits"] as? [String]) && !(got["splits"] as? [String] ?? []).isEmpty,
              "\(got["splits"] ?? "") want \(want["splits"] ?? "")")
        check("restore_active", got["active"] as? String == want["active"] as? String, "\(got["active"] ?? "")")
        let v = front()
        check("restore_front_draws", prompt(v) && v?.channel != 0)
    }
}
