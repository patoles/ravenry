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
    }
}
