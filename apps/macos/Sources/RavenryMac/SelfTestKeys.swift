// A11Y-002, no app shortcut swallows a terminal key (sidetest --screen keys):
// a pane running `cat -v` with the terminal raw, each key a terminal program
// needs delivered as AppKit delivers it (the window's key equivalents, then
// the main menu's, then the window's keyDown to the terminal), and each must
// reach the program: the pane prints something for it, and the window did
// nothing of its own (no tab, page or split changed). And the menus: every
// key equivalent carries Command, but Ctrl+Tab and Ctrl+Shift+Tab (the next
// and the previous tab, as in the Electron app).

import AppKit

extension SelfTestBoard {
    func screenKeys() {
        let ws = board.ws
        let before = Set(ws.tabs.map { $0.host })
        ws.newTab(in: nil, program: Workspace.Program(command: ["/bin/sh", "-c", "stty raw -echo; printf 'ready>'; exec cat -v"], name: "keys", agent: nil))
        guard wait(8, { ws.tabs.contains { !before.contains($0.host) } }), let pane = ws.tabs.first(where: { !before.contains($0.host) })?.host,
              let v = ws.boxes[pane]?.term else { check("keys_pane", false); return }
        window.makeFirstResponder(v)
        let text = { v.screen.text().replacingOccurrences(of: "\n", with: "") }
        // What a key changed: the text, or where the cursor is (a Tab prints blanks).
        let seen = { "\(text())|\(v.screen.cursor.x),\(v.screen.cursor.y)" }
        check("keys_pane_ready", wait(8) { text().contains("ready>") }, text().prefix(80).description)
        var codes: [String: UInt16] = [:]
        for (k, name) in KeyCodes.table where name.hasPrefix("Key") { codes[name.dropFirst(3).lowercased()] = k }
        // (name, characters, ignoring modifiers, key code, modifiers)
        var keys: [(String, String, String, UInt16, NSEvent.ModifierFlags)] = []
        for l in "abcdefghklnopqrstuvwxyz" {   // Ctrl+I and Ctrl+J are Tab and newline, Ctrl+M Return: below
            let s = String(l), c = String(UnicodeScalar(UInt8(l.asciiValue! - 96)))
            keys.append(("ctrl_\(s)", c, s, codes[s] ?? 0, .control))
        }
        keys += [("ctrl_space", "\u{0}", " ", 0x31, .control), ("ctrl_bracket", "\u{1b}", "[", 0x21, .control), ("ctrl_backslash", "\u{1c}", "\\", 0x2A, .control),
                 ("ctrl_close_bracket", "\u{1d}", "]", 0x1E, .control), ("ctrl_minus", "\u{1f}", "-", 0x1B, .control), ("escape", "\u{1b}", "\u{1b}", 0x35, []), ("tab", "\t", "\t", 0x30, []),
                 ("shift_tab", "\u{19}", "\t", 0x30, .shift), ("return", "\r", "\r", 0x24, []), ("backspace", "\u{7f}", "\u{7f}", 0x33, []),
                 ("up", "\u{F700}", "\u{F700}", 0x7E, [.function, .numericPad]), ("left", "\u{F702}", "\u{F702}", 0x7B, [.function, .numericPad]),
                 ("home", "\u{F729}", "\u{F729}", 0x73, .function), ("end", "\u{F72B}", "\u{F72B}", 0x77, .function),
                 ("page_up", "\u{F72C}", "\u{F72C}", 0x74, .function), ("page_down", "\u{F72D}", "\u{F72D}", 0x79, .function),
                 ("forward_delete", "\u{F728}", "\u{F728}", 0x75, .function),
                 ("f1", "\u{F704}", "\u{F704}", 0x7A, .function), ("f5", "\u{F708}", "\u{F708}", 0x60, .function), ("f12", "\u{F70F}", "\u{F70F}", 0x6F, .function),
                 ("ctrl_up", "\u{F700}", "\u{F700}", 0x7E, [.control, .function, .numericPad]), ("ctrl_left", "\u{F702}", "\u{F702}", 0x7B, [.control, .function, .numericPad]),
                 ("option_left", "\u{F702}", "\u{F702}", 0x7B, [.option, .function, .numericPad]), ("ctrl_option_a", "\u{1}", "a", codes["a"] ?? 0, [.control, .option])]
        var swallowed: [String] = [], acted: [String] = []
        for (name, ch, ign, code, mods) in keys {
            let was = seen(), tabs = ws.tabs.map { $0.host }, front = board.front
            guard let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                           context: nil, characters: ch, charactersIgnoringModifiers: ign, isARepeat: false, keyCode: code) else { continue }
            // AppKit's order: the window's key equivalents, the main menu's, then the key itself.
            if !(window.performKeyEquivalent(with: e) || (NSApp.mainMenu?.performKeyEquivalent(with: e) ?? false)) { window.sendEvent(e) }
            if let up = NSEvent.keyEvent(with: .keyUp, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                         context: nil, characters: ch, charactersIgnoringModifiers: ign, isARepeat: false, keyCode: code) { window.sendEvent(up) }
            if !wait(2, { seen() != was }) { swallowed.append(name) }
            if ws.tabs.map({ $0.host }) != tabs || board.front != front || ws.active?.host != pane { acted.append(name) }
            if window.firstResponder !== v { window.makeFirstResponder(v) }
        }
        check("keys_none_swallowed", swallowed.isEmpty, "\(keys.count) keys; swallowed: \(swallowed.joined(separator: ","))")
        check("keys_window_did_nothing", acted.isEmpty, acted.joined(separator: ","))
        check("keys_reached_as_typed", text().contains("^A") && text().contains("^Z") && (text().contains("^[OP") || text().contains("^[[11~")), text().suffix(200).description)
        // The menus: Command on every shortcut but the tab keys.
        var noCmd: [String] = []
        func walk(_ m: NSMenu) {
            for i in m.items {
                if let s = i.submenu { walk(s) }
                guard !i.keyEquivalent.isEmpty else { continue }
                let f = i.keyEquivalentModifierMask
                // macOS's own (Start Dictation, Emoji & Symbols: the globe key) are not the app's.
                if [Selector(("startDictation:")), #selector(NSApplication.orderFrontCharacterPalette(_:))].contains(i.action) || f.contains(.function) { continue }
                if !f.contains(.command) && !(["\t", "\u{19}"].contains(i.keyEquivalent) && f.contains(.control)) { noCmd.append("\(i.title) (\(i.keyEquivalent.debugDescription) \(f.rawValue))") }
            }
        }
        if let mm = NSApp.mainMenu { walk(mm) }
        check("keys_menu_shortcuts_have_command", NSApp.mainMenu != nil && noCmd.isEmpty, noCmd.joined(separator: ", "))
        // A11Y-001: the menus, each action with its shortcut, Edit's whole; Cmd+, from the terminal opens Settings.
        let top = NSApp.mainMenu?.items.compactMap { $0.submenu?.title } ?? []
        let edit = NSApp.mainMenu?.items.first { $0.submenu?.title == "Edit" }?.submenu
        let editKeys = ["Undo": "z", "Redo": "Z", "Cut": "x", "Copy": "c", "Paste": "v", "Select All": "a"]
        let missing = editKeys.filter { k, v in !(edit?.items.contains { $0.title == k && $0.keyEquivalent == v && $0.keyEquivalentModifierMask.contains(.command) } ?? false) }.map(\.key)
        check("keys_menus_with_shortcuts", ["Shell", "Edit", "View", "Window", "Help"].allSatisfy { top.contains($0) } && missing.isEmpty, "\(top) missing \(missing)")
        window.makeFirstResponder(v)
        if let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                    context: nil, characters: ",", charactersIgnoringModifiers: ",", isARepeat: false, keyCode: 0x2B) {
            let took = window.performKeyEquivalent(with: e) || (NSApp.mainMenu?.performKeyEquivalent(with: e) ?? false)
            check("keys_cmd_comma_from_terminal", window.firstResponder !== nil && took && wait(3) { self.board.settings.window.isVisible }, "took \(took)")
            board.settings.window.orderOut(nil)
        }
        ws.closePane(pane)
        focusRingSweep()
    }
}

// A11Y-004, the keyboard's ring on every control that takes it
// (sidetest --screen keys, after the keys): the main window with Alerts open
// (its fields and buttons, the sidebar, the tabs, the panel) and each tab of
// Settings. Each text field is given the keyboard and its ring must show at
// once (its box's ring turned --work, or AppKit's own); every other control
// must have a ring AppKit draws (focusRingType not none and a mask that
// paints).
extension SelfTestBoard {
    private func maskPixels(_ v: NSView) -> Int {
        let w = Int(ceil(v.bounds.width)), h = Int(ceil(v.bounds.height))
        guard w > 0, h > 0, v.focusRingMaskBounds.width >= 1,
              let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0), let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return 0 }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        NSColor.black.setFill()
        v.drawFocusRingMask()
        NSGraphicsContext.restoreGraphicsState()
        var n = 0
        for y in stride(from: 0, to: h, by: 2) { for x in stride(from: 0, to: w, by: 2) where (rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.1 { n += 1 } }
        return n
    }

    private func drawsOwnRing(_ win: NSWindow, _ v: NSView) -> Bool {
        func shot() -> Data? { guard let r = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return nil }; v.cacheDisplay(in: v.bounds, to: r); return r.tiffRepresentation }
        win.makeFirstResponder(nil); v.needsDisplay = true
        let a = shot()
        guard win.makeFirstResponder(v) else { return false }
        v.needsDisplay = true
        let b = shot()
        win.makeFirstResponder(nil)
        return a != nil && b != nil && a != b
    }

    private func ringFailures(_ win: NSWindow, _ root: NSView, _ place: String) -> (checked: Int, bad: [String]) {
        var bad: [String] = [], checked = 0
        func name(_ v: NSView) -> String { "\(place): \(type(of: v)) \((v.accessibilityLabel() ?? (v as? NSButton)?.title ?? (v as? NSTextField)?.placeholderString ?? "").prefix(30))" }
        func walk(_ v: NSView) {
            if v.isHiddenOrHasHiddenAncestor || v.alphaValue == 0 || v.visibleRect.isEmpty { return }
            if v is TerminalView { return } // its cursor is where the keyboard is
            if let f = v as? NSTextField, f.isEditable, f.isEnabled {
                checked += 1
                win.makeFirstResponder(f)
                settle(0.05)
                var lit = f.focusRingType != .none
                var p = f.superview
                while let s = p, !lit { if let b = s as? Box, b.ring == "work" { lit = true }; p = s.superview }
                if !lit { bad.append(name(f)) }
                return
            }
            let takes = v.canBecomeKeyView || (v is NSButton && (v as? NSButton)?.isEnabled == true)
            if takes && !(v is NSScrollView) && !(v is NSClipView) && !(v is NSTextView) {
                checked += 1
                // AppKit's ring, else one the control draws itself (the hand-off track's thumb): it looks different with the keyboard.
                if v.focusRingType == .none || maskPixels(v) == 0, !drawsOwnRing(win, v) { bad.append(name(v)) }
            }
            v.subviews.forEach(walk)
        }
        walk(root)
        win.makeFirstResponder(nil)
        return (checked, bad)
    }

    func focusRingSweep() {
        board.openPage("side.alerts", t("side.alerts"))
        let pg = board.alerts
        _ = wait(5) { pg.setup != nil }
        pg.buttons["telegram-toggle"]?.performClick(nil)
        settle(0.4)
        if let f = pg.fields["tg"] { window.makeFirstResponder(f.field); settle(0.3); picture("native-focus-field-1280-dark.png") }
        let main = ringFailures(window, window.contentView!, "main")
        let sw = board.settings
        board.menuSettings(nil)
        _ = wait(3) { sw.window.isVisible }
        var set = (checked: 0, bad: [String]())
        for tab in ["appearance", "behavior", "handoff", "skills"] {
            (sw.tabButtons[tab] as TapBox?)?.press()
            settle(0.6)
            let r = ringFailures(sw.window, sw.window.contentView!, "settings \(tab)")
            set.checked += r.checked; set.bad += r.bad
        }
        sw.window.orderOut(nil)
        check("a11y_focus_ring_every_control", main.checked > 20 && set.checked > 20 && main.bad.isEmpty && set.bad.isEmpty,
              "main \(main.checked) checked, settings \(set.checked); no ring: \((main.bad + set.bad).joined(separator: "; "))")
    }
}
