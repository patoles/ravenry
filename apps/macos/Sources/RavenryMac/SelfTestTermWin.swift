// sidetest.mjs --screen termwin: the terminal's and the windows' controls
// the audit could not see working (TERM-016, TERM-033, TERM-056, WIN-002,
// WIN-003), each driven as the person drives it and checked where it lands:
//
// - Cmd+W on a busy shell shows the real sheet (on the window off every
//   screen), Return is Cancel and keeps the pane, Don't ask again and Close
//   write the setting and close the pane at the daemon;
// - Option as Meta (off, left, right, both): Option+F through the window
//   with the left and the right Option key, the bytes the program in the
//   pane read (ESC f as Meta, else the composed ƒ);
// - a wheel event made from a CGEvent, through the window, scrolls a
//   crowded tab strip;
// - the Window and Help menus' items pressed through their menus (Minimize
//   and Zoom recorded off every screen, Bring All to Front, Merge All
//   Windows), the tab's right-click Move Tab to New Window, and Cmd+N with
//   no window left.

import AppKit

extension SelfTestBoard {
    func screenTermWin() {
        var seen: [String] = []
        let offAll = { (when: String) in
            for w in NSApp.windows where w.isVisible && NSScreen.screens.contains(where: { $0.frame.intersects(w.frame) }) { seen.append("\(when): \(type(of: w)) \(w.frame)") }
        }
        termCloseSheet(); offAll("close")
        termOptionAsMeta(); offAll("option")
        termWheelOnStrip(); offAll("wheel")
        winMenus(); offAll("menus")
        check("termwin_every_window_off_screen", seen.isEmpty, seen.joined(separator: "; "))
    }

    // MARK: helpers

    private func paneNew(_ name: String, _ command: [String]) -> String? {
        let p: [String: Any] = ["cols": 80, "rows": 24, "name": name, "labels": ["ravenry.kind": "shell"], "cwd": board.ws.home, "command": command]
        return ((try? board.ws.conn.call("pane.new", p, timeout: 5))?["pane"] as? [String: Any])?["id"] as? String
    }
    private func daemonPanes() -> [String] {
        ((try? board.ws.conn.call("pane.list", [:], timeout: 5))?["panes"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
    }
    private func send(_ pane: String, _ text: String) {
        board.ws.conn(of: pane).request("pane.send", ["pane": pane, "input": [["text": text, "mode": "paste"], ["key": "Enter"]]])
    }
    private func screenText(_ pane: String) -> String { board.ws.boxes[pane]?.term.screen.text() ?? "" }
    private func buttons(_ v: NSView) -> [NSButton] { (v as? NSButton).map { [$0] } ?? [] + v.subviews.flatMap { buttons($0) } }
    /// A menu's item pressed as the menu presses it (its action sent, validated first).
    private func pressMenu(_ menu: NSMenu?, _ title: String) -> Bool {
        guard let m = menu, let i = m.items.firstIndex(where: { $0.title == title }) else { return false }
        m.update()
        let item = m.items[i]
        if item.isEnabled { m.performActionForItem(at: i) }
        // Off every screen no window is the key one, so an item for the window in front (Minimize,
        // Zoom) finds no target: its action is sent to the window in front, as the key window's would be.
        else if let a = item.action, let w = (NSApp.delegate as? AppDelegate)?.current?.window { NSApp.sendAction(a, to: w, from: item) }
        else { return false }
        settle(0.4)
        return true
    }
    private func topMenu(_ title: String) -> NSMenu? { NSApp.mainMenu?.items.first { $0.submenu?.title == title }?.submenu }

    // MARK: TERM-016

    private func termCloseSheet() {
        let ws = board.ws
        Workspace.testCloseAnswer = nil
        defer { Workspace.testCloseAnswer = (true, false) }
        ws.settings.set(["confirmCloseBusy": true])
        _ = wait(5) { ws.look.confirmClose }
        guard let pane = paneNew("busy", ["/bin/zsh", "-f", "-i"]), wait(8, { ws.tab(showing: pane) != nil }), let tab = ws.tab(showing: pane) else {
            check("close_sheet_setup", false); return
        }
        ws.show(tab)
        board.render(force: true)
        _ = wait(5) { !self.screenText(pane).isEmpty }
        send(pane, "sleep 300")
        settle(1.0)
        // Cmd+W, as the person presses it: the menu's Close.
        // Cmd+W, as the person presses it: the menu's Close.
        _ = key("w", .command)
        guard wait(5, { ws.closeAlert != nil }), let a = ws.closeAlert else { check("close_sheet_shown", false, "no alert; asked \(ws.closeAsked)"); return }
        let bs = a.buttons
        let close = bs.first { $0.title == t("close.close") }, cancel = bs.first { $0.title == t("close.cancel") }
        check("close_sheet_shown", a.messageText == "Close this tab?" && a.informativeText.contains("zsh is running sleep 300") && close != nil && cancel != nil
              && a.suppressionButton?.title == t("close.dont") && a.showsSuppressionButton, "\(a.messageText) \(a.informativeText); buttons \(bs.map(\.title))")
        check("close_sheet_never_on_screen", !a.window.isVisible && window.attachedSheet == nil, "visible \(a.window.isVisible) frame \(a.window.frame)")
        check("close_sheet_cancel_is_default", cancel?.keyEquivalent == "\r" && close?.keyEquivalent == "" && close?.hasDestructiveAction == true,
              "cancel \(cancel?.keyEquivalent.debugDescription ?? "-") close \(close?.keyEquivalent.debugDescription ?? "-")")
        // Return: AppKit's key equivalents pick the button, Cancel; the pane runs on.
        if let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: a.window.windowNumber,
                                    context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36) {
            _ = a.window.performKeyEquivalent(with: e)
        }
        let gone = wait(3) { ws.closeAlert == nil }
        settle(0.5)
        check("close_sheet_return_cancels", gone && daemonPanes().contains(pane) && ws.tab(showing: pane) != nil && ws.look.confirmClose,
              "answered \(gone), at the daemon \(daemonPanes().contains(pane))")
        // Again: Don't ask again ticked, then Close: the setting written, the pane closed at the daemon.
        _ = key("w", .command)
        guard wait(5, { ws.closeAlert != nil }), let a2 = ws.closeAlert else { check("close_sheet_again", false); return }
        a2.suppressionButton?.performClick(nil)
        a2.buttons.first { $0.title == t("close.close") }?.performClick(nil)
        let closed = wait(5) { !self.daemonPanes().contains(pane) }
        let file = ws.settings.bool("confirmCloseBusy")
        check("close_sheet_dont_ask_and_close", closed && ws.closeAlert == nil && !file && ws.tab(showing: pane) == nil,
              "closed at the daemon \(closed), confirmCloseBusy \(file)")
        ws.settings.set(["confirmCloseBusy": true])
    }

    // MARK: TERM-033

    private func termOptionAsMeta() {
        let ws = board.ws
        let out = dir.appendingPathComponent("option-bytes.bin")
        try? Data().write(to: out)
        // The program reads its terminal raw and keeps every byte it gets.
        let py = "import os,sys,tty\ntty.setraw(0)\nf=open(sys.argv[1],'ab',0)\nos.write(1,b'ready\\r\\n')\nwhile True:\n b=os.read(0,64)\n if not b: break\n f.write(b)\n"
        guard let pane = paneNew("raw", ["/usr/bin/python3", "-I", "-c", py, out.path]), wait(8, { ws.tab(showing: pane) != nil }), let tab = ws.tab(showing: pane) else {
            check("option_meta_setup", false); return
        }
        ws.show(tab)
        board.render(force: true)
        guard wait(8, { self.screenText(pane).contains("ready") }), let view = ws.boxes[pane]?.term else { check("option_meta_setup", false, screenText(pane)); return }
        window.makeFirstResponder(view)
        // Option+F with one Option key: its flagsChanged, the key down and up, Option let go.
        func press(left: Bool) -> [UInt8] {
            try? Data().write(to: out)
            let side: UInt = left ? 0x20 : 0x40 // NX_DEVICELALTKEYMASK, NX_DEVICERALTKEYMASK
            let down = NSEvent.ModifierFlags(rawValue: NSEvent.ModifierFlags.option.rawValue | side)
            let code: UInt16 = left ? 58 : 61
            let ts = ProcessInfo.processInfo.systemUptime
            let fc = { (f: NSEvent.ModifierFlags) -> NSEvent? in
                guard let cg = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true) else { return nil }
                cg.type = .flagsChanged
                cg.flags = CGEventFlags(rawValue: UInt64(f.rawValue))
                return NSEvent(cgEvent: cg)
            }
            if let e = fc(down) { view.flagsChanged(with: e) }
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                if let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: down, timestamp: ts, windowNumber: window.windowNumber, context: nil,
                                            characters: "\u{192}", charactersIgnoringModifiers: "f", isARepeat: false, keyCode: 3) {
                    window.sendEvent(e)
                }
            }
            if let e = fc([]) { view.flagsChanged(with: e) }
            settle(0.6)
            return [UInt8]((try? Data(contentsOf: out)) ?? Data())
        }
        let meta: [UInt8] = [0x1b, 0x66], composed: [UInt8] = Array("\u{192}".utf8)
        let hex = { (b: [UInt8]) in b.map { String(format: "%02x", $0) }.joined(separator: " ") }
        for (mode, wantLeft, wantRight) in [("off", composed, composed), ("left", meta, composed), ("right", composed, meta), ("both", meta, meta)] {
            ws.settings.set(["optionAsMeta": mode])
            _ = wait(5) { view.optionAsAlt == (mode == "off" ? "" : mode) }
            let l = press(left: true), r = press(left: false)
            check("option_meta_\(mode)_bytes", l == wantLeft && r == wantRight, "left Option+F \(hex(l)) (want \(hex(wantLeft))), right \(hex(r)) (want \(hex(wantRight)))")
        }
        ws.settings.set(["optionAsMeta": "off"])
        ws.closePane(pane)
    }

    // MARK: TERM-056

    private func termWheelOnStrip() {
        let ws = board.ws, bar = ws.bar
        size(900, 760)
        let had = ws.tabs.count
        for k in 0..<max(0, 12 - had) { _ = paneNew("strip-\(k)", ["/bin/zsh", "-f", "-i"]) }
        _ = wait(10) { ws.tabs.count >= 12 }
        if let t0 = ws.tabs.last { ws.show(t0) }
        board.render(force: true)
        settle(0.6)
        guard bar.overflows else { check("strip_wheel_event_setup", false, "\(ws.tabs.count) tabs (had \(had)), not crowded"); return }
        let before = bar.offset
        // A mouse wheel's turn over the strip, as macOS makes it: a CGEvent, its NSEvent, through the window.
        let at = bar.clip.convert(NSPoint(x: bar.clip.bounds.midX, y: bar.clip.bounds.midY), to: nil)
        let onScreen = window.convertPoint(toScreen: at)
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: 3, wheel2: 0, wheel3: 0) else { check("strip_wheel_event", false, "no CGEvent"); return }
        // An event of no window has its point in screen coordinates: placed so that point is the strip's in the window.
        _ = onScreen
        cg.location = CGPoint(x: at.x, y: top - at.y)
        guard let e = NSEvent(cgEvent: cg) else { check("strip_wheel_event", false, "no NSEvent"); return }
        let hit = window.contentView?.hitTest(window.contentView?.superview?.convert(e.locationInWindow, from: nil) ?? e.locationInWindow)
        window.sendEvent(e)
        settle(0.3)
        check("strip_wheel_event_scrolls", bar.offset < before - 0.5,
              "offset \(before) -> \(bar.offset); event at \(e.locationInWindow) window \(e.windowNumber), hit \(hit.map { String(describing: type(of: $0)) } ?? "none"), deltaY \(e.scrollingDeltaY)")
        // Back the other way.
        guard let cg2 = cg.copy() else { return }
        cg2.setIntegerValueField(.scrollWheelEventDeltaAxis1, value: -3)
        let o1 = bar.offset
        if let e2 = NSEvent(cgEvent: cg2) { window.sendEvent(e2) }
        settle(0.3)
        check("strip_wheel_event_back", bar.offset > o1 + 0.5, "offset \(o1) -> \(bar.offset)")
    }

    // MARK: WIN-002, WIN-003

    private func winMenus() {
        guard let app = NSApp.delegate as? AppDelegate, let w1 = app.windows.first else { check("win_menus_app", false); return }
        let wm = topMenu("Window"), help = topMenu("Help")
        // Minimize and Zoom: the menu's item reaches the window in front (off every screen it records them).
        let tw = w1.window
        let minimized = pressMenu(wm, "Minimize") && tw.offscreenAsked.last == "miniaturize"
        check("win_menu_minimize", minimized && !tw.isMiniaturized, "\(tw.offscreenAsked)")
        let zoomed = pressMenu(wm, "Zoom") && tw.offscreenAsked.last == "zoom"
        check("win_menu_zoom", zoomed && tw.frame.minX < -1000, "\(tw.offscreenAsked) frame \(tw.frame)")
        // Bring All to Front: every window ordered in, each still off every screen.
        guard key("n", .command), wait(5, { app.windows.count == 2 }) else { check("win_menu_setup_second", false, "\(app.windows.count)"); return }
        let w2 = app.windows[1]
        w1.window.orderBack(nil)
        let front = pressMenu(wm, "Bring All to Front")
        let ordered = NSApp.orderedWindows.filter { $0 is TerminalWindow }
        check("win_menu_bring_all_to_front", front && app.windows.allSatisfy { $0.window.isVisible && $0.window.frame.minX < -1000 } && ordered.count >= 2,
              "visible \(app.windows.map(\.window.isVisible)) frames \(app.windows.map { $0.window.frame.minX })")
        // Merge All Windows: the second window's tabs join the first's.
        let all = Set(app.windows.flatMap { w in w.ws.tabs.map(\.host) })
        let target = app.current ?? w2
        let merged = pressMenu(wm, "Merge All Windows") && wait(3) { app.windows.filter { !$0.closing }.count == 1 }
        let left = app.windows.filter { !$0.closing }
        let after = Set(left.flatMap { w in w.ws.tabs.map(\.host) })
        check("win_menu_merge_all", merged && after == all && left.first === target, "windows \(left.count), tabs \(after.count) of \(all.count)")
        // The tab's right click: the menu a right click on a tab gets, its Move Tab to New Window pressed.
        guard let rw = left.first, rw.ws.tabs.count >= 2,
              let item = rw.ws.bar.items.first(where: { !$0.model.id.hasPrefix("view:") && !$0.model.active }) ?? rw.ws.bar.items.first(where: { !$0.model.id.hasPrefix("view:") }) else {
            check("win_tab_menu_setup", false); return
        }
        rw.window.contentView?.layoutSubtreeIfNeeded()
        let p = item.convert(NSPoint(x: item.bounds.midX, y: item.bounds.midY), to: nil)
        let moving = item.model.id
        let movingHost = rw.ws.tabs.first { $0.id == moving }?.host
        var pressed = false
        if let e = NSEvent.mouseEvent(with: .rightMouseDown, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: rw.window.windowNumber,
                                      context: nil, eventNumber: 0, clickCount: 1, pressure: 1) {
            // The event the menu reads (NSApp.currentEvent), taken from the queue as AppKit takes it; the menu is not shown.
            NSApp.postEvent(e, atStart: true)
            let got = NSApp.nextEvent(matching: .rightMouseDown, until: Date(), inMode: .default, dequeue: true)
            if let got, let m = rw.ws.bar.menu(for: got) {
                m.delegate?.menuNeedsUpdate?(m)
                if let i = m.items.firstIndex(where: { $0.title == "Move Tab to New Window" }), m.items[i].isEnabled { m.performActionForItem(at: i); pressed = true }
            }
        }
        settle(0.5)
        let nw = app.windows.filter { !$0.closing }
        check("win_tab_menu_moves_tab", pressed && nw.count == 2 && nw.last?.ws.tabs.map(\.host) == [movingHost ?? "-"] && rw.ws.tabs.allSatisfy { $0.host != movingHost },
              "pressed \(pressed), windows \(nw.count), new window's tabs \(nw.last?.ws.tabs.map(\.host) ?? [])")
        // Every window closed: Cmd+N opens one; Help's Learn Ravenry with none open opens one too.
        for w in app.windows { w.window.performClose(nil); settle(0.3) }
        let none = app.windows.isEmpty
        let opened = key("n", .command) && wait(5) { app.windows.count == 1 }
        check("win_cmd_n_after_last", none && opened && wait(5) { (app.windows.first?.ws.focusedView?.screen.frames ?? 0) > 0 }, "none \(none) windows \(app.windows.count)")
        for w in app.windows { w.window.performClose(nil); settle(0.3) }
        let learned = app.windows.isEmpty && pressMenu(help, t("learn.title")) && wait(5) { app.windows.count == 1 }
        check("win_help_after_last", learned && wait(3) { app.windows.first?.board.front == .page("side.learn", t("learn.title")) }, "windows \(app.windows.count) front \(String(describing: app.windows.first?.board.front))")
    }
}
