// The command palette, Settings, Keys and the right-click menus from the
// list of actions (scripts/sidetest.mjs --screen palette, then --screen
// palette2 on the same data folder): NAV-011, SET-018 and the right-click
// menus' New and Close. Each check drives the control as the person would
// (Shift+Cmd+P through the menus' key equivalents, the palette's field and
// its Return, a click on a key then the keys pressed, Use it here, Reset,
// Reset All Keys, a right-click menu's item) and reads where it lands: a
// split in the tab, the page in front, the board's answer to a hand-off,
// settings.json, the menu bar's item and its key. Pictures of the eight
// states of the approved picture (palette-*.png, keys-*.png) and of the
// right-click menus (menu-*.png), drawn from the menus' own items.

import AppKit

extension SelfTestBoard {
    private var pal: PaletteView { board.palette }
    /// Typed into the field, the caret after the words.
    private func palType(_ s: String) {
        if let ed = pal.field.currentEditor() as? NSTextView { ed.string = s; ed.setSelectedRange(NSRange(location: (s as NSString).length, length: 0)) } else { pal.field.stringValue = s }
        pal.filter()
        settle(0.15)
    }
    private func palTitles() -> [String] { pal.shown.map { $0.0 } }
    private func palReturn() {
        guard let ed = pal.field.currentEditor() as? NSTextView else { pal.run(pal.selected); settle(0.4); return }
        _ = pal.control(pal.field, textView: ed, doCommandBy: #selector(NSResponder.insertNewline(_:)))
        settle(0.4)
    }
    private func palOpen() -> Bool {
        if pal.isOpen { pal.close() }
        _ = key("P", [.command, .shift])
        return wait(2) { self.pal.isOpen }
    }
    private func savedKeys() -> [String: String] {
        guard let f = board.settings.store.file, let d = try? Data(contentsOf: f), let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return [:] }
        return (j["keys"] as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
    }
    private func barKey(_ id: String) -> String {
        guard let i = Actions.barItem(id) else { return "no item" }
        return i.keyEquivalent.isEmpty ? "none" : "\(i.keyEquivalent.debugDescription) \(i.keyEquivalentModifierMask.rawValue)"
    }
    private func want(_ s: String) -> String { let (k, m) = KeyStroke(s)!.menuKey; return "\(k.debugDescription) \(m.rawValue)" }

    /// A key pressed on the Keys page while an action's key is being set (the chip has the keyboard).
    private func pressKeys(_ id: String, _ chars: String, _ mods: NSEvent.ModifierFlags, code: UInt16 = 0, ign: String? = nil) {
        guard let chip = board.settings.controls["key:\(id)"] as? KeyChip,
              let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: board.settings.window.windowNumber,
                                       context: nil, characters: chars, charactersIgnoringModifiers: ign ?? chars, isARepeat: false, keyCode: code) else { return }
        // As AppKit sends them: with Command, the window's key equivalents first; else the key itself.
        if mods.contains(.command) { if !board.settings.window.performKeyEquivalent(with: e) { chip.keyDown(with: e) } } else { chip.keyDown(with: e) }
        settle(0.3)
    }

    func screenPalette() {
        let ws = board.ws, hub = board.hub
        // paper-boat's question: the top card.
        check("pal_arrival", arrival(1) && wait(30) { hub.state?.sidebar(has: "paper-boat/sf-3", in: "you") ?? false })
        settle(0.5)
        size(1280, 800)
        board.toTerminal()
        let km = KeyMap.shared
        check("pal_starts_as_shipped", km.changes.isEmpty && barKey("newShell") == want("cmd+t") && barKey("palette") == want("shift+cmd+p"), "\(km.changes) newShell \(barKey("newShell"))")

        // NAV-011: Shift+Cmd+P through the menu's key; Esc closes it.
        check("pal_opens_shift_cmd_p", palOpen() && board.ws.window.firstResponder === pal.field.currentEditor(), "\(String(describing: board.ws.window.firstResponder))")
        _ = board.escape()
        check("pal_esc_closes", !pal.isOpen && board.log.last == "esc: palette", board.log.suffix(2).joined(separator: " | "))

        // A menu action: Split Right, typed and run with Return, makes a split.
        let before = ws.active?.count ?? 0
        _ = palOpen()
        palType("split right")
        check("pal_filters_split_right", palTitles().first == "Split Right" && pal.shown.first?.2 == "\u{2318}D", "\(pal.shown.prefix(3))")
        palReturn()
        check("pal_runs_split_right", !pal.isOpen && wait(5) { (ws.active?.count ?? 0) == before + 1 }, "panes \(before) -> \(ws.active?.count ?? 0)")
        // New Session..., so it is among the ones run last.
        _ = palOpen()
        palType("new session")
        palReturn()
        check("pal_runs_new_session", board.front == .start, "\(board.front)")

        // The session view of garden-planner in front, as the picture has it.
        let k1 = "garden-planner/sf-1"
        board.topLevel { $0.pickSession(k1, why: "click") }
        settle(0.8)
        check("pal_front_session", board.frontKey == k1, board.frontKey ?? "none")

        // Before typing: the board first, then what was run last.
        _ = palOpen()
        let first = palTitles()
        // (garden-planner runs a plan here, so New plan is not among them.)
        let boardRows = [t("act.answerTopPhrase"), t("session.handOffNow")]
        check("pal_before_typing_board_first", Array(first.prefix(2)) == boardRows && pal.shown.first?.1 == "Tilting the hull, paper-boat" && pal.shown[1].1 == "Planting reminders"
              && !first.contains(t("panel.newPlan")), "\(pal.shown)")
        let recentAt = first.firstIndex(of: "New Session\u{2026}") ?? -1, splitAt = first.firstIndex(of: "Split Right") ?? -1
        check("pal_before_typing_then_recent", recentAt >= 2 && splitAt > recentAt && first[2...].allSatisfy { !boardRows.contains($0) }, "\(first)")
        picture("palette-2-before-typing-dark.png")

        // "new": one ranked list, the menus' and the board's.
        palType("new")
        let news = palTitles()
        check("pal_new_ranked", news.first == "New Session\u{2026}" && ["New Shell", "New Window", t("side.newProjectDots")].allSatisfy { news.contains($0) }
              && news.firstIndex(of: "New Window")! < (news.firstIndex(of: "Move Tab to New Window") ?? 99), "\(pal.shown)")
        check("pal_new_keys_shown", pal.shown.first { $0.0 == "New Shell" }?.2 == "\u{2318}T" && pal.shown.first { $0.0 == "New Session\u{2026}" }?.2 == "\u{21E7}\u{2318}N", "\(pal.shown)")
        picture("palette-1-new-dark.png")
        NSApp.appearance = NSAppearance(named: .aqua)
        settle(0.4); board.render(force: true); pal.draw(); settle(0.4)
        picture("palette-1-new-light.png")
        NSApp.appearance = NSAppearance(named: .darkAqua)
        settle(0.4); board.render(force: true); pal.draw(); settle(0.3)

        // A project's name: open it, its session with its tab's key, the actions on it.
        palType("garden")
        let g = pal.shown
        check("pal_project_name", g.first?.0 == t("pal.openProject", ["name": "garden-planner"]) && g.first?.1 == t("pal.project")
              && g.contains { $0.0.hasPrefix("Go to ") && $0.1 == "garden-planner" } && g.contains { $0.0 == t("session.handOffNow") && $0.1.hasSuffix(", garden-planner") }, "\(g)")
        picture("palette-3-project-dark.png")

        // Nothing found.
        palType("deploy")
        check("pal_nothing_matches", pal.shown.isEmpty && pal.nothing?.0 == "Nothing matches \u{201C}deploy\u{201D}." && pal.nothing?.1 == "Try fewer letters, or a project\u{2019}s name.", "\(String(describing: pal.nothing))")
        picture("palette-4-nothing-dark.png")
        pal.close()

        // The board's actions, on this test's board: Hand off now (the panel's own post), the top card opened
        // for the person to answer (nothing answered), New plan's page.
        _ = palOpen()
        palType("hand off")
        let hoAt = pal.shown.firstIndex { $0.0 == t("session.handOffNow") && $0.1.hasPrefix("Planting reminders") } ?? -1
        if hoAt >= 0 { pal.select(hoAt); palReturn() }
        _ = wait(4) { hub.sent.contains("POST /api/handoff") }
        check("pal_hand_off_posted", hoAt >= 0 && hub.sent.contains("POST /api/handoff"), "\(pal.shown) sent \(hub.sent.suffix(3))")
        let answered = hub.sent.filter { $0.contains("/api/checkpoints") || $0.contains("/api/send") || $0.contains("/answer") }
        _ = palOpen()
        palType("answer")
        palReturn()
        check("pal_answer_top_opens_it", wait(3) { self.board.frontKey == "paper-boat/sf-3" && self.board.panel.key == "paper-boat/sf-3" }, "front \(board.frontKey ?? "none") panel \(board.panel.key)")
        check("pal_answer_top_answers_nothing", hub.sent.filter { $0.contains("/api/checkpoints") || $0.contains("/api/send") || $0.contains("/answer") } == answered, "\(hub.sent.suffix(4))")
        _ = palOpen()
        palType("new plan")
        let np = pal.shown.first
        palReturn()
        check("pal_new_plan_page", np?.0 == t("panel.newPlan") && { if case .page(let k, _) = self.board.front { return k.hasPrefix("newplan:") } else { return false } }(), "\(String(describing: np)) front \(board.front)")
        board.toTerminal()

        // SET-018: Settings, Keys.
        board.openSettings("keys")
        let sw = board.settings
        check("keys_tab_opens", wait(3) { sw.window.isVisible && sw.tab == "keys" } && sw.tabs.map { $0.0 } == ["appearance", "behavior", "keys", "handoff", "skills"], "\(sw.tab) \(sw.tabs.map { $0.0 })")
        check("keys_lists_menus_and_board", ["newShell", "splitRight", "copy", "find", "nextTab", "minimize", "learn", "quit", "palette", "answerTop", "handOffNow", "newPlan", "revive", "newProject"].allSatisfy { sw.controls["key:\($0)"] != nil }
              && sw.controls["key:tab1"] == nil && sw.controls["key:npmBack"] == nil, sw.controls.keys.filter { $0.hasPrefix("key:") }.count.description)

        // Rebind New Shell: a click on its key, then Option+Cmd+T.
        let tabs0 = ws.tabs.count
        sw.startKeys("newShell")
        check("keys_press_keys_shown", sw.keys.recording == "newShell" && (sw.controls["keyNote"] as? NSTextField)?.stringValue == "Esc keeps \u{2318}T. Delete leaves it with none.", (sw.controls["keyNote"] as? NSTextField)?.stringValue ?? "")
        sw.keysScrollTop()
        keysPicture("keys-6-press-dark")
        pressKeys("newShell", "t", [.command, .option])
        check("keys_rebind_saved", savedKeys()["newShell"] == "opt+cmd+t" && sw.keys.recording == nil, "\(savedKeys())")
        check("keys_rebind_menu_shows", barKey("newShell") == want("opt+cmd+t"), barKey("newShell"))
        _ = key("t", [.command, .option])
        check("keys_rebind_key_makes_shell", wait(5) { ws.tabs.count == tabs0 + 1 }, "tabs \(tabs0) -> \(ws.tabs.count)")
        let tabs1 = ws.tabs.count
        _ = key("t", .command)
        settle(0.8)
        check("keys_old_key_does_nothing", ws.tabs.count == tabs1, "tabs \(tabs1) -> \(ws.tabs.count)")
        check("keys_rebind_in_palette", palOpen() && { self.palType("new shell"); return self.pal.shown.first?.2 == "\u{2325}\u{2318}T" }(), "\(pal.shown.prefix(2))")
        pal.close()
        // The right-click menu shows the key as set.
        if let v = ws.focusedView {
            let m = v.contextMenu(at: v.convert(NSPoint(x: 40, y: 40), to: nil))
            let ns = m.items.first { $0.title == "New Shell" }
            check("context_menu_rebound_key", ns?.keyEquivalent == "t" && ns?.keyEquivalentModifierMask == [.option, .command], "\(ns?.keyEquivalent.debugDescription ?? "none") \(ns?.keyEquivalentModifierMask.rawValue ?? 0)")
        } else { check("context_menu_rebound_key", false, "no pane") }

        // Refused: a key without Command, one macOS keeps, one an action keeps.
        sw.startKeys("newWindow")
        pressKeys("newWindow", "\u{14}", .control, ign: "t")
        check("keys_refuses_without_cmd", (sw.controls["keyNote"] as? NSTextField)?.stringValue == "\u{2303}T goes to the terminal. Use \u{2318} with it." && sw.keys.recording == "newWindow", (sw.controls["keyNote"] as? NSTextField)?.stringValue ?? "")
        pressKeys("newWindow", "\t", .command)
        check("keys_refuses_system", (sw.controls["keyNote"] as? NSTextField)?.stringValue == "\u{2318}\u{21E5} belongs to macOS. Press other keys.", (sw.controls["keyNote"] as? NSTextField)?.stringValue ?? "")
        pressKeys("newWindow", "1", .command)
        check("keys_refuses_fixed", (sw.controls["keyNote"] as? NSTextField)?.stringValue == "\u{2318}1 is Tab 1, which keeps it. Press other keys.", (sw.controls["keyNote"] as? NSTextField)?.stringValue ?? "")
        pressKeys("newWindow", "\u{1b}", [], code: 0x35)
        check("keys_esc_keeps", sw.keys.recording == nil && km.stroke("newWindow")?.text == "cmd+n" && savedKeys()["newWindow"] == nil, "\(savedKeys())")

        // A key another action has: said in red, then Use it here leaves the other with none.
        sw.startKeys("newShell")
        pressKeys("newShell", "d", .command)
        check("keys_conflict_said", (sw.controls["keyNote"] as? NSTextField)?.stringValue == "\u{2318}D is Split Right" && sw.controls["keyUse"] != nil && km.stroke("newShell")?.text == "opt+cmd+t",
              (sw.controls["keyNote"] as? NSTextField)?.stringValue ?? "")
        sw.keysScrollTop()
        keysPicture("keys-7-conflict-dark")
        (sw.controls["keyUse"] as? RButton)?.performClick(nil)
        settle(0.3)
        check("keys_use_it_here", savedKeys()["newShell"] == "cmd+d" && savedKeys()["splitRight"] == "" && km.stroke("splitRight") == nil && barKey("newShell") == want("cmd+d") && barKey("splitRight") == "none",
              "\(savedKeys()) splitRight \(barKey("splitRight"))")
        let tabs2 = ws.tabs.count
        _ = key("d", .command)
        check("keys_taken_key_now_new_shell", wait(5) { ws.tabs.count == tabs2 + 1 }, "tabs \(tabs2) -> \(ws.tabs.count)")

        // Reset one, Reset all.
        (sw.controls["keyReset:newShell"] as? RButton)?.performClick(nil)
        settle(0.3)
        check("keys_reset_one", km.stroke("newShell")?.text == "cmd+t" && savedKeys()["newShell"] == nil && savedKeys()["splitRight"] == "" && barKey("newShell") == want("cmd+t"), "\(savedKeys())")
        check("keys_changed_count", (sw.controls["keysChanged"] as? NSTextField)?.stringValue == "1 changed. Every key goes back as Ravenry ships it.", (sw.controls["keysChanged"] as? NSTextField)?.stringValue ?? "")
        (sw.controls["keysResetAll"] as? RButton)?.performClick(nil)
        settle(0.3)
        check("keys_reset_all", savedKeys().isEmpty && km.changes.isEmpty && barKey("splitRight") == want("cmd+d") && barKey("newShell") == want("cmd+t")
              && (sw.controls["keysChanged"] as? NSTextField)?.stringValue == "Every key is as Ravenry ships it.", "\(savedKeys())")

        rightClickMenus()

        // The pictures' states: Split Down changed (5), Hand Off Now given a key (8).
        sw.setKey("splitDown", KeyStroke("opt+cmd+d"))
        sw.keysScrollTop()
        keysPicture("keys-5-page-dark")
        NSApp.appearance = NSAppearance(named: .aqua); settle(0.3)
        sw.keysScrollTop()
        keysPicture("keys-5-page-light")
        NSApp.appearance = NSAppearance(named: .darkAqua); settle(0.3)
        sw.setKey("handOffNow", KeyStroke("ctrl+cmd+h"))
        sw.keysShow("palette")
        keysPicture("keys-8-reset-dark")
        check("keys_board_key_saved", savedKeys()["handOffNow"] == "ctrl+cmd+h" && (sw.controls["keysChanged"] as? NSTextField)?.stringValue == "2 changed. Every key goes back as Ravenry ships it.", "\(savedKeys())")
        // A board action's key runs it: Hand off now on the session in front (paper-boat's: garden-planner's is asked already).
        board.topLevel { $0.pickSession("paper-boat/sf-3", why: "click") }
        settle(0.6)
        let posts = hub.sent.filter { $0 == "POST /api/handoff" }.count
        _ = key("h", [.command, .control])
        check("keys_board_key_runs_it", wait(4) { hub.sent.filter { $0 == "POST /api/handoff" }.count == posts + 1 }, "\(hub.sent.suffix(3))")


        // Kept for the relaunch (palette2 reads it back): New Shell on Option+Cmd+T, Split Down and Hand Off Now changed.
        sw.setKey("newShell", KeyStroke("opt+cmd+t"))
        check("keys_set_for_relaunch", savedKeys() == ["newShell": "opt+cmd+t", "splitDown": "opt+cmd+d", "handOffNow": "ctrl+cmd+h"], "\(savedKeys())")
        sw.window.orderOut(nil)
    }

    /// The right-click menus (the picked variant B): the terminal's, a tab's and the empty strip's, each
    /// item from the list of actions; New Shell and Close run.
    private func rightClickMenus() {
        let ws = board.ws
        board.toTerminal()
        settle(0.4)
        guard let v = ws.focusedView else { return check("context_pane", false) }
        let m = v.contextMenu(at: v.convert(NSPoint(x: 40, y: 40), to: nil))
        let titles = m.items.map { $0.isSeparatorItem ? "-" : $0.title }
        check("context_menu_new_and_close", titles == ["Copy", "Paste", "Select All", "-", "Copy Path", "Find\u{2026}", "Clear", "-", "Split Right", "Split Down", "Move to Own Tab", "Zoom Pane", "-",
                                                       "New Shell", "New Session\u{2026}", "New Window", "-", "Close"], "\(titles)")
        let keysShown = m.items.filter { !$0.isSeparatorItem }.map { i in i.keyEquivalent.isEmpty ? "" : (KeyStroke.from(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: i.keyEquivalentModifierMask, timestamp: 0, windowNumber: 0, context: nil, characters: i.keyEquivalent, charactersIgnoringModifiers: i.keyEquivalent, isARepeat: false, keyCode: 0)!)?.symbols ?? "?") }
        check("context_menu_keys", keysShown == ["\u{2318}C", "\u{2318}V", "\u{2318}A", "", "\u{2318}F", "\u{2318}K", "\u{2318}D", "\u{21E7}\u{2318}D", "", "\u{21E7}\u{2318}\u{21A9}", "\u{2318}T", "\u{21E7}\u{2318}N", "\u{2318}N", "\u{2318}W"], "\(keysShown)")
        // Under the pointer in the pane, as the picture has it (the picture's top left is the window's).
        let pr = v.convert(v.bounds, to: nil), H = window.contentView?.bounds.height ?? 0
        menuPicture(m, at: NSPoint(x: pr.minX + 260, y: H - pr.maxY + 60), "menu-terminal-dark")
        // New Shell from the menu makes a shell; Close closes the pane right-clicked.
        let tabs0 = ws.tabs.count
        if let ns = m.items.first(where: { $0.title == "New Shell" }), let a = ns.action { NSApp.sendAction(a, to: ns.target, from: ns) }
        check("context_new_shell_runs", wait(5) { ws.tabs.count == tabs0 + 1 }, "tabs \(tabs0) -> \(ws.tabs.count)")
        settle(0.8)
        if let v2 = ws.focusedView {
            let pane = v2.pane
            let m2 = v2.contextMenu(at: v2.convert(NSPoint(x: 40, y: 40), to: nil))
            if let c = m2.items.first(where: { $0.title == "Close" }), let a = c.action { NSApp.sendAction(a, to: c.target, from: c) }
            check("context_close_runs", wait(5) { ws.boxes[pane] == nil && !ws.tabs.contains { $0.has(pane) } }, "pane \(pane) still \(ws.boxes[pane] != nil)")
        }
        // A tab's menu: its Move first, then New; the empty strip: the New ones.
        let rw = (NSApp.delegate as? AppDelegate)?.windows.first { $0.ws === ws }
        guard let tm = rw?.tabMenu, let item = ws.bar.items.first(where: { !$0.model.id.hasPrefix("view:") }) else { return check("tab_menu", false) }
        let tabMenu = NSMenu()
        tm.fill(tabMenu, at: item.convert(NSPoint(x: item.bounds.midX, y: item.bounds.midY), to: nil))
        check("tab_menu_items", tabMenu.items.map { $0.isSeparatorItem ? "-" : $0.title } == ["Move Tab to New Window", "-", "New Shell", "New Session\u{2026}", "New Window"], "\(tabMenu.items.map(\.title))")
        let ir = item.convert(item.bounds, to: nil)
        menuPicture(tabMenu, at: NSPoint(x: ir.midX, y: (window.contentView?.bounds.height ?? 0) - ir.minY + 2), "menu-tab-dark")
        let strip = NSMenu()
        // A point of the strip no tab is under: just past the last tab (the + is there), as the window has them.
        let bar = ws.bar
        let barRect = bar.convert(bar.bounds, to: nil)
        let lastX = bar.items.map { $0.convert($0.bounds, to: nil).maxX }.max() ?? barRect.minX
        var empty = NSPoint(x: lastX + 12, y: barRect.midY)
        if !barRect.contains(empty) || bar.items.contains(where: { $0.bounds.contains($0.convert(empty, from: nil)) }) {
            for x in stride(from: barRect.maxX - 70, through: barRect.minX, by: -10) {
                let w = NSPoint(x: x, y: barRect.midY)
                if !bar.items.contains(where: { $0.bounds.contains($0.convert(w, from: nil)) }) { empty = w; break }
            }
        }
        check("strip_point_on_strip", barRect.contains(empty) && !bar.items.contains { $0.bounds.contains($0.convert(empty, from: nil)) },
              "at \(Int(empty.x)),\(Int(empty.y)) in the strip \(barRect.integral); tabs \(bar.items.map { "\($0.model.id) \(Int($0.convert($0.bounds, to: nil).minX))-\(Int($0.convert($0.bounds, to: nil).maxX))" })")
        tm.fill(strip, at: empty)
        check("strip_menu_items", strip.items.map(\.title) == ["New Shell", "New Session\u{2026}", "New Window"], "\(strip.items.map(\.title))")
        menuPicture(strip, at: NSPoint(x: empty.x - 20, y: (window.contentView?.bounds.height ?? 0) - empty.y + 12), "menu-strip-dark")
        let tabs1 = ws.tabs.count
        if let nw = strip.items.first(where: { $0.title == "New Shell" }), let a = nw.action { NSApp.sendAction(a, to: nw.target, from: nw) }
        check("strip_menu_new_shell_runs", wait(5) { ws.tabs.count == tabs1 + 1 }, "tabs \(tabs1) -> \(ws.tabs.count)")
    }

    /// The app again on the same data folder: the keys as the person left them.
    func screenPalette2() {
        let km = KeyMap.shared
        let ws = board.ws
        board.toTerminal()
        check("keys_kept_relaunch", km.stroke("newShell")?.text == "opt+cmd+t" && km.stroke("splitDown")?.text == "opt+cmd+d" && km.stroke("handOffNow")?.text == "ctrl+cmd+h"
              && barKey("newShell") == want("opt+cmd+t") && barKey("splitDown") == want("opt+cmd+d"), "\(km.changes) newShell \(barKey("newShell"))")
        let tabs0 = ws.tabs.count
        _ = key("t", [.command, .option])
        check("keys_kept_key_makes_shell", wait(5) { ws.tabs.count == tabs0 + 1 }, "tabs \(tabs0) -> \(ws.tabs.count)")
        board.openSettings("keys")
        let sw = board.settings
        _ = wait(3) { sw.window.isVisible && sw.tab == "keys" }
        check("keys_kept_page_says_was", sw.controls["keyReset:newShell"] != nil && (sw.controls["keysChanged"] as? NSTextField)?.stringValue == "3 changed. Every key goes back as Ravenry ships it.",
              (sw.controls["keysChanged"] as? NSTextField)?.stringValue ?? "")
        (sw.controls["keysResetAll"] as? RButton)?.performClick(nil)
        settle(0.3)
        check("keys_reset_all_after_relaunch", km.changes.isEmpty && barKey("newShell") == want("cmd+t"), "\(km.changes)")
        sw.window.orderOut(nil)
    }

    /// The Settings window as it shows, in the appearance in effect.
    private func keysPicture(_ name: String) {
        let sw = board.settings
        sw.draw()
        settle(0.3)
        guard let root = sw.window.contentView, let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { return }
        root.cacheDisplay(in: root.bounds, to: rep)
        let s: CGFloat = 2
        let w = Int(root.bounds.width * s), h = Int(root.bounds.height * s)
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue), let base = rep.cgImage else { return }
        var bg = CGColor(gray: 0, alpha: 1)
        sw.window.effectiveAppearance.performAsCurrentDrawingAppearance { bg = Design.color("sheet").cgColor }
        ctx.setFillColor(bg); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.draw(base, in: CGRect(x: 0, y: 0, width: w, height: h))
        if let img = ctx.makeImage() { try? NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("native-\(name).png")) }
        let sq = squeezed(root)
        check("\(name)_no_squeezed_text", sq.isEmpty, sq.joined(separator: " | "))
    }

    /// A right-click menu over the window, drawn from its own items (their titles, keys, lines and
    /// greying) as a Mac menu shows them: off every screen a real menu cannot be shown.
    private func menuPicture(_ m: NSMenu, at p: NSPoint, _ name: String) {
        picture("\(name)-base.png")
        guard let base = NSImage(contentsOf: dir.appendingPathComponent("\(name)-base.png")) else { return }
        try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(name)-base.png"))
        let font = NSFont.menuFont(ofSize: 13)
        let rowH: CGFloat = 22, sepH: CGFloat = 11, padX: CGFloat = 14
        let items = m.items
        func keys(_ i: NSMenuItem) -> String {
            guard !i.keyEquivalent.isEmpty, let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: i.keyEquivalentModifierMask, timestamp: 0, windowNumber: 0, context: nil,
                                                                      characters: i.keyEquivalent, charactersIgnoringModifiers: i.keyEquivalent, isARepeat: false, keyCode: 0) else { return "" }
            return KeyStroke.from(e)?.symbols ?? ""
        }
        let tw = items.map { ($0.title as NSString).size(withAttributes: [.font: font]).width }.max() ?? 100
        let kw = items.map { (keys($0) as NSString).size(withAttributes: [.font: font]).width }.max() ?? 0
        let mw = ceil(padX + tw + 40 + kw + padX), mh = items.reduce(CGFloat(10)) { $0 + ($1.isSeparatorItem ? sepH : rowH) }
        let W0 = base.size.width, H0 = base.size.height
        // The picture is at twice the window's points.
        let k = W0 / max(1, window.contentView?.bounds.width ?? W0)
        let W = W0 / k, H = H0 / k
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(W0), pixelsHigh: Int(H0), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0), let gc = NSGraphicsContext(bitmapImageRep: rep) else { return }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: gc.cgContext, flipped: true)
        let cg = gc.cgContext
        cg.translateBy(x: 0, y: H0); cg.scaleBy(x: 1, y: -1)
        do {
            base.draw(in: NSRect(x: 0, y: 0, width: W0, height: H0), from: .zero, operation: .copy, fraction: 1, respectFlipped: true, hints: nil)
            cg.scaleBy(x: k, y: k)
            let r = NSRect(x: min(p.x, W - mw - 8), y: min(p.y, H - mh - 8), width: mw, height: mh)
            let shadow = NSShadow(); shadow.shadowBlurRadius = 18; shadow.shadowOffset = NSSize(width: 0, height: -8); shadow.shadowColor = NSColor.black.withAlphaComponent(0.5)
            NSGraphicsContext.saveGraphicsState(); shadow.set()
            NSColor(srgbRed: 0.17, green: 0.17, blue: 0.18, alpha: 0.98).setFill()
            NSBezierPath(roundedRect: r, xRadius: 8, yRadius: 8).fill()
            NSGraphicsContext.restoreGraphicsState()
            NSColor.white.withAlphaComponent(0.12).setStroke()
            NSBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), xRadius: 8, yRadius: 8).stroke()
            var y = r.minY + 5
            for i in items {
                if i.isSeparatorItem {
                    NSColor.white.withAlphaComponent(0.12).setFill()
                    NSRect(x: r.minX + 10, y: y + 5, width: r.width - 20, height: 1).fill()
                    y += sepH; continue
                }
                let c = i.isEnabled ? NSColor.white.withAlphaComponent(0.9) : NSColor.white.withAlphaComponent(0.3)
                (i.title as NSString).draw(at: NSPoint(x: r.minX + padX, y: y + 3), withAttributes: [.font: font, .foregroundColor: c])
                let k = keys(i)
                let ks = (k as NSString).size(withAttributes: [.font: font])
                (k as NSString).draw(at: NSPoint(x: r.maxX - padX - ks.width, y: y + 3), withAttributes: [.font: font, .foregroundColor: i.isEnabled ? NSColor.white.withAlphaComponent(0.5) : NSColor.white.withAlphaComponent(0.25)])
                y += rowH
            }
        }
        NSGraphicsContext.restoreGraphicsState()
        if let png = rep.representation(using: .png, properties: [:]) { try? png.write(to: dir.appendingPathComponent("native-\(name).png")) }
    }
}
