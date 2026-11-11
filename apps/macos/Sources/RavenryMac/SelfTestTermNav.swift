// sidetest.mjs --screen termnav (and termnav2, the app again on the same
// board and daemon): the rows of Terminal and of Navigation and windows
// the build3 round proves on the board, each driven as the person drives it
// (a press or a drag through the window, a key, a menu's item, a row's
// click) and checked where it lands. Also run from the review and the
// settings screens (navReviewTab, termThemeImport), which have the hub's
// worktree and the import's file.
//
// - A11Y-011: in New project's name field, Undo, Redo, Select All and Cut
//   from the Edit menu: the text undone and back, the pasteboard (the test's
//   own, never the person's) holds the cut and the field is empty.
// - TERM-065: `cd` in a shell: the tab's second line and the panel's Folder follow.
// - NAV-005, NAV-006: a session in front continued under a new id is
//   followed; ended, its last words stay, a toast says so, its tab dims and
//   its tip says it ended.
// - NAV-007: Cmd+Ctrl+S folds the sidebar and View's item reads Show
//   Sidebar; the edge dragged to 400 and double-clicked back to 284, then
//   400 kept for the relaunch (termnav2 reads it back).
// - NAV-008: every key the sidebar, its foot and the panel's links open is
//   drawn: the "not drawn in this window" placeholder never shows.
// - WIN-005: the strip's empty part moves the window (AppKit's
//   mouseDownCanMoveWindow under the pointer), a double click zooms, or
//   minimizes, or does nothing, as the system's setting says.
// - WIN-006: Cmd+N opens a window; after the first, a window is cascaded
//   from the one in front.
// - TERM-069 (with termnav2): a session tab whose pane went while Ravenry
//   was not running closes quietly at launch; the tab in front comes back in front.
// - NAV-004 (navReviewTab): the Review tab names its branch, sits right
//   after its session's tab, and its x goes back to the session.
// - TERM-040 (termThemeImport): a file over 1 MB is refused in words, one
//   that is not a theme says why, nothing saved.

import AppKit

/// The self-test's field editor: Cut, Copy and Paste in a text field use
/// the test's own pasteboard (TerminalWindow.testPasteboard), never the
/// person's clipboard. Only while a test sets that pasteboard.
final class PrivatePasteboardEditor: NSTextView {
    override func writeSelection(to pboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool {
        super.writeSelection(to: TerminalWindow.testPasteboard ?? pboard, types: types)
    }
    override func readSelection(from pboard: NSPasteboard) -> Bool {
        super.readSelection(from: TerminalWindow.testPasteboard ?? pboard)
    }
    override func readSelection(from pboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        super.readSelection(from: TerminalWindow.testPasteboard ?? pboard, type: type)
    }
    override func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(paste(_:)), let pb = TerminalWindow.testPasteboard { return pb.string(forType: .string) != nil }
        return super.validateMenuItem(item)
    }
    override func paste(_ sender: Any?) {
        guard let pb = TerminalWindow.testPasteboard else { return super.paste(sender) }
        if let s = pb.string(forType: .string) { insertText(s, replacementRange: selectedRange()) }
    }
}

extension TerminalWindow {
    static var testPasteboard: NSPasteboard?
    private static var testEditor: PrivatePasteboardEditor?
    override func fieldEditor(_ createFlag: Bool, for object: Any?) -> NSText? {
        guard TerminalWindow.testPasteboard != nil else { return super.fieldEditor(createFlag, for: object) }
        if TerminalWindow.testEditor == nil {
            let e = PrivatePasteboardEditor()
            e.isFieldEditor = true
            e.allowsUndo = true
            TerminalWindow.testEditor = e
        }
        return TerminalWindow.testEditor
    }
}

extension SelfTestBoard {
    // MARK: helpers

    /// An Edit menu item as the menu sends it to the key window: the first
    /// responder that takes the action, validated first. (Off every screen
    /// no window is key, so the menu itself finds no target.)
    /// What the Edit menu's item reaches, for a check's detail.
    private func editTrail(_ title: String) -> String {
        guard let item = NSApp.mainMenu?.items.first(where: { $0.submenu?.title == "Edit" })?.submenu?.items.first(where: { $0.title == title }), let a = item.action else { return "no item" }
        var r: NSResponder? = window.firstResponder, out: [String] = []
        while let x = r { out.append("\(type(of: x))\(x.responds(to: a) ? "*" : "")"); r = x.nextResponder }
        let fe = window.firstResponder as? NSTextView
        return out.joined(separator: " < ") + "; editor undo \(fe?.allowsUndo ?? false), its manager \(fe?.undoManager.map { "\(ObjectIdentifier($0).hashValue)" } ?? "nil") canUndo \(fe?.undoManager?.canUndo ?? false), the field's \(((fe?.delegate as? UndoField)?.history).map { "\(ObjectIdentifier($0).hashValue)" } ?? "none")"
    }

    private func editItem(_ title: String) -> (enabled: Bool, done: Bool) {
        guard let m = NSApp.mainMenu?.items.first(where: { $0.submenu?.title == "Edit" })?.submenu,
              let item = m.items.first(where: { $0.title == title }), let a = item.action else { return (false, false) }
        var r: NSResponder? = window.firstResponder
        while let x = r, !x.responds(to: a) { r = x.nextResponder }
        guard let target = r else { return (false, false) }
        let on = (target as? NSMenuItemValidation)?.validateMenuItem(item) ?? (target as? NSUserInterfaceValidations)?.validateUserInterfaceItem(item) ?? true
        guard on else { return (false, false) }
        NSApp.sendAction(a, to: target, from: item)
        settle(0.2)
        return (true, true)
    }

    /// Keys typed into the first responder, each a key event through the window.
    private func typeKeys(_ s: String) {
        for ch in s {
            let c = String(ch)
            guard let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: ch.isUppercase ? .shift : [], timestamp: ProcessInfo.processInfo.systemUptime,
                                           windowNumber: window.windowNumber, context: nil, characters: c, charactersIgnoringModifiers: c.lowercased(),
                                           isARepeat: false, keyCode: 0) else { continue }
            window.sendEvent(e)
        }
        settle(0.2)
    }

    /// A mouse event at a window point.
    private func mouseAt(_ t: NSEvent.EventType, _ p: NSPoint, clicks: Int = 1) -> NSEvent {
        NSEvent.mouseEvent(with: t, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                           windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: t == .leftMouseUp ? 0 : 1)!
    }

    private func viewsOf<T: NSView>(_ type: T.Type, in v: NSView) -> [T] {
        ((v as? T).map { [$0] } ?? []) + v.subviews.flatMap { viewsOf(type, in: $0) }
    }

    private func tabModel(_ id: String) -> TabModel? { board.ws.bar.items.first { $0.model.id == id }?.model }

    private func paneNewTN(_ labels: [String: String], _ name: String, _ command: [String]) -> String? {
        let p: [String: Any] = ["cols": 80, "rows": 24, "name": name, "labels": labels, "cwd": board.ws.home, "command": command]
        return ((try? board.ws.conn.call("pane.new", p, timeout: 5))?["pane"] as? [String: Any])?["id"] as? String
    }

    /// Types a line and Enter into a pane's view.
    private func typeIn(_ v: TerminalView, _ line: String) {
        v.sendEvents([["text": line]])
        settle(0.2)
        if let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                    windowNumber: window.windowNumber, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 0x24) {
            v.keyDown(with: e)
        }
    }

    // MARK: the screen

    func screenTermNav() {
        size(1440, 900)
        let general = NSPasteboard.general.changeCount
        textFieldsEdit()
        cdFollowed()
        sessionFollowedAndEnded()
        sidebarFoldAndEdge()
        everyKeyDrawn()
        stripIsTitleBar()
        newWindowsCascade()
        filmStallsAndLost()
        shellWords()
        sessionTabsForRelaunch()
        check("termnav_general_pasteboard_untouched", NSPasteboard.general.changeCount == general)
    }

    // MARK: A11Y-011

    private func textFieldsEdit() {
        let b = board, np = b.newProject
        guard let nb = b.sidebar.newProjectButton else { return check("edit_np_button", false) }
        click(nb)
        guard wait(3, { if case .page("newproject", _) = b.front { return true }; return false }) else { return check("edit_np_open", false, "\(b.front)") }
        _ = wait(5) { np.known != nil }
        let f = np.field("name", "").field
        window.makeFirstResponder(f)
        settle(0.2)
        let editing = { (f.currentEditor() as? NSTextView)?.string ?? f.stringValue }
        typeKeys("Kite Tracker")
        let typed = editing()
        let undo = editItem("Undo")
        let undone = editing()
        let redo = editItem("Redo")
        let redone = editing()
        check("edit_undo_redo_in_field", typed == "Kite Tracker" && undo.done && undone.isEmpty && redo.done && redone == "Kite Tracker",
              "typed \"\(typed)\", Undo \(undo) \"\(undone)\", Redo \(redo) \"\(redone)\"; \(editTrail("Undo"))")
        // Cut: the test's own pasteboard (the person's clipboard is never written).
        let pb = NSPasteboard(name: NSPasteboard.Name("dev.ravenry.sidetest.\(getpid())"))
        pb.clearContents()
        TerminalWindow.testPasteboard = pb
        defer { TerminalWindow.testPasteboard = nil; pb.releaseGlobally() }
        window.makeFirstResponder(nil)
        window.makeFirstResponder(f)
        settle(0.2)
        let all = editItem("Select All")
        let cut = editItem("Cut")
        let afterCut = editing()
        let held = pb.string(forType: .string) ?? ""
        check("edit_cut_in_field", all.done && cut.done && afterCut.isEmpty && held == "Kite Tracker", "Cut \(cut), field \"\(afterCut)\", pasteboard \"\(held)\"")
        let paste = editItem("Paste")
        check("edit_paste_in_field", paste.done && editing() == "Kite Tracker", "Paste \(paste), field \"\(editing())\"; \(editTrail("Paste"))")
        pictures("termnav-edit-field")
        window.makeFirstResponder(nil)
        np.clear("name")
        b.back()
    }

    // MARK: TERM-065

    private func cdFollowed() {
        let b = board, ws = b.ws
        guard let t = ws.tabs.first else { return check("cd_tab", false) }
        b.ws.bar.onSelect?(t.id)
        settle(0.3)
        guard let v = ws.focusedView else { return check("cd_view", false) }
        let dir = (board.ws.home as NSString).appendingPathComponent("harbour notes")
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        if !b.panelVisible { b.togglePanel() }
        typeIn(v, "cd ~/harbour\\ notes")
        let t0 = Date()
        let tab = wait(3) { self.tabModel(t.id)?.sub == "harbour notes" }
        let took = Date().timeIntervalSince(t0)
        b.render(force: true)
        let panel = wait(2) { self.texts(b.panel).contains { $0.hasSuffix("/harbour notes") } }
        check("cd_tab_and_panel_follow", tab && panel && took < 1,
              String(format: "tab's second line \"%@\" after %.2f s, panel \"%@\"", tabModel(t.id)?.sub ?? "-", took, texts(b.panel).filter { $0.contains("harbour") }.joined(separator: " | ")))
        pictures("termnav-cd")
        typeIn(v, "cd ~")
        _ = wait(3) { self.tabModel(t.id)?.sub != "harbour notes" }
    }

    // MARK: NAV-005, NAV-006

    private func sessionFollowedAndEnded() {
        let b = board, hub = b.hub
        guard let st = hub.state,
              let p = st.projects.first(where: { p in p.machine == nil && p.sessions.contains { $0.pane == nil && $0.machine == nil && $0.sessionId != nil } }),
              let s = p.sessions.first(where: { $0.pane == nil && $0.machine == nil && $0.sessionId != nil }), let sid = s.sessionId else {
            return check("ended_session", false, "no session outside on the board")
        }
        let k = "\(p.id)/\(s.surfaceId)"
        guard let row = b.sidebar.rows[k] else { return check("ended_row", false, k) }
        click(row)
        guard wait(3, { b.front == .session(k) && b.root.middle === b.outside }) else { return check("ended_opened", false, "\(b.front)") }
        _ = wait(4) { !self.texts(b.outside).isEmpty }
        // Continued: the same conversation under a new surface (Continue, Move here).
        let newSurface = s.surfaceId + "-continued"
        let k2 = "\(p.id)/\(newSurface)"
        hub.testPatch = { r in
            var r = r
            r["projects"] = (r["projects"] as? [[String: Any]] ?? []).map { pj in
                var pj = pj
                pj["sessions"] = (pj["sessions"] as? [[String: Any]] ?? []).map { x in var x = x; if x["sessionId"] as? String == sid { x["surfaceId"] = newSurface }; return x }
                return pj
            }
            return r
        }
        hub.testCheckpoints = []
        b.render(force: true)
        check("nav_follows_continued", wait(3) { b.front == .session(k2) } && b.log.contains { $0.contains("followed to \(k2)") }, "\(b.front) \(b.log.suffix(2))")
        let tabId = "view:\(k2)"
        let named = wait(3) { self.tabModel(tabId) != nil }
        let before = tabModel(tabId)
        pictures("termnav-session-live")
        // Ended: gone from the board.
        let toasts0 = b.toastTexts.count
        hub.testPatch = { r in
            var r = r
            r["projects"] = (r["projects"] as? [[String: Any]] ?? []).map { pj in
                var pj = pj
                pj["sessions"] = (pj["sessions"] as? [[String: Any]] ?? []).filter { $0["sessionId"] as? String != sid }
                return pj
            }
            return r
        }
        hub.testCheckpoints = []
        b.render(force: true)
        let toast = wait(3) { b.toastTexts.contains(t("else.ended")) && b.toastTexts.count > toasts0 }
        let stays = b.front == .session(k2) && b.root.middle === b.outside && !texts(b.outside).isEmpty
        check("nav_ended_toast_last_words_stay", toast && stays, "toasts \(b.toastTexts), front \(b.front), the middle says \(texts(b.outside).prefix(3))")
        b.render(force: true)
        let m = tabModel(tabId)
        let item = b.ws.bar.items.first { $0.model.id == tabId }
        check("nav_ended_tab_dims", named && before?.ended == false && m?.ended == true && m?.tip == t("else.ended") && item?.toolTip == t("else.ended") && m?.name == before?.name,
              "before \(before.map { "\($0.name) ended \($0.ended)" } ?? "none"), after \(m.map { "\($0.name) ended \($0.ended) tip \($0.tip)" } ?? "none"), tooltip \(item?.toolTip ?? "none")")
        if let item { pictureOver("termnav-tab-ended", [item]) }
        pictures("termnav-session-ended")
        hub.testPatch = nil
        hub.testCheckpoints = []
        b.ws.bar.onClose?(tabId)
        settle(0.3)
        b.topLevel { $0.back() }
        if let first = b.ws.tabs.first { b.ws.bar.onSelect?(first.id) }
        settle(0.3)
    }

    // MARK: NAV-007

    private func sidebarFoldAndEdge() {
        let b = board
        guard let vm = NSApp.mainMenu?.items.first(where: { $0.submenu?.title == "View" })?.submenu,
              let item = vm.items.first(where: { $0.action == #selector(AppDelegate.menuToggleSidebar(_:)) }) else { return check("side_menu_item", false) }
        vm.update()
        let shownTitle = item.title
        _ = key("s", [.command, .control])
        let folded = wait(2) { b.sideHidden && b.root.sideWidth == 0 }
        vm.update()
        let foldedTitle = item.title
        _ = key("s", [.command, .control])
        let back = wait(2) { !b.sideHidden && b.root.sideWidth > 0 }
        vm.update()
        check("side_menu_hide_show", folded && back && shownTitle == t("side.hide") && foldedTitle == t("side.show") && item.title == t("side.hide"),
              "shown \"\(shownTitle)\", folded \(folded) \"\(foldedTitle)\", back \(back) \"\(item.title)\"")
        // The edge: dragged to 400, a double click back to 284.
        guard let h = viewsOf(ResizeHandle.self, in: window.contentView!).first(where: { $0.window === window && !$0.isHidden }) else { return check("side_edge", false) }
        // The edge's own handlers with the events a press, a drag and a release make.
        func drag(by dx: CGFloat) {
            let p = h.convert(NSPoint(x: h.bounds.midX, y: h.bounds.midY), to: nil)
            h.mouseDown(with: mouseAt(.leftMouseDown, p))
            for i in 1...5 { h.mouseDragged(with: mouseAt(.leftMouseDragged, NSPoint(x: p.x + dx * CGFloat(i) / 5, y: p.y))) }
            h.mouseUp(with: mouseAt(.leftMouseUp, NSPoint(x: p.x + dx, y: p.y)))
            settle(0.3)
        }
        let w0 = b.sideWidth
        drag(by: 400 - w0)
        let dragged = b.sideWidth
        let p = h.convert(NSPoint(x: h.bounds.midX, y: h.bounds.midY), to: nil)
        h.mouseDown(with: mouseAt(.leftMouseDown, p, clicks: 1)); h.mouseUp(with: mouseAt(.leftMouseUp, p, clicks: 1))
        h.mouseDown(with: mouseAt(.leftMouseDown, p, clicks: 2)); h.mouseUp(with: mouseAt(.leftMouseUp, p, clicks: 2))
        settle(0.3)
        let doubled = b.sideWidth
        drag(by: 400 - b.sideWidth)
        check("side_edge_drag_and_double_click", dragged == 400 && doubled == SidebarView.defaultWidth && b.sideWidth == 400,
              "from \(w0) dragged to \(dragged), double click \(doubled), dragged again \(b.sideWidth) (kept for the relaunch)")
        pictures("termnav-sidebar-400")
    }

    // MARK: NAV-008

    private func everyKeyDrawn() {
        let b = board
        guard let st = b.hub.state else { return check("keys_state", false) }
        var shown: [String] = [], tried: [String] = []
        func placeholderShown() -> Bool { b.root.middle === b.placeholder || shows(b.files, "is not something this Ravenry draws here") }
        func after(_ key: String) {
            tried.append(key)
            settle(0.4)
            if placeholderShown() { shown.append(key) }
            b.topLevel { _ in }
            var n = 0
            while b.root.middle != nil && n < 8 { b.back(); n += 1 }
        }
        // The sidebar's page rows, Decisions and the foot, each pressed.
        for (k, row) in b.sidebar.rows where k.hasPrefix("page:") { click(row); after(String(k.dropFirst(5))) }
        for (k, btn) in b.sidebar.footButtons where !["side.settings", "side.phone"].contains(k) { click(btn); after(k) }
        // The panel's and the pages' links, through the panel's own way in.
        for p in st.projects where p.machine == nil {
            for k in ["brief:\(p.id)", "gallery:\(p.id)", "plan:\(p.id)", "newplan:\(p.id)", "files:\(p.id)", "writebrief:\(p.id)"] {
                b.panel.host?.openPage(k, k); after(k)
            }
        }
        for pg in st.pages { b.panel.host?.openPage(pg.key, pg.label); after(pg.key) }
        check("keys_every_one_drawn", shown.isEmpty && tried.count > 20, "\(tried.count) keys opened; the placeholder for \(shown)")
    }

    // MARK: WIN-005

    private func stripIsTitleBar() {
        let ws = board.ws, bar = ws.bar
        guard let tw = window as? TerminalWindow else { return check("strip_window", false) }
        // The strip's empty part: right of the last tab, left of the strip's buttons.
        let lastMax = bar.items.map { $0.convert($0.bounds, to: bar).maxX }.max() ?? 0
        let pt = bar.convert(NSPoint(x: min(bar.bounds.width - 120, lastMax + 60), y: bar.bounds.midY), to: nil)
        let hit = window.contentView?.superview?.hitTest(pt) ?? window.contentView?.hitTest(pt)
        var movers: [String] = []
        var v: NSView? = hit
        var moves = true
        while let x = v, x !== window.contentView?.superview { movers.append("\(type(of: x)):\(x.mouseDownCanMoveWindow)"); if !x.mouseDownCanMoveWindow { moves = false }; v = x.superview }
        check("strip_empty_part_moves_window", tw.isMovable && moves && hit != nil, "under the pointer: \(movers.joined(separator: " < "))")
        // A double click there, as the system's setting says.
        func double() { window.sendEvent(mouseAt(.leftMouseDown, pt, clicks: 2)); window.sendEvent(mouseAt(.leftMouseUp, pt, clicks: 2)); settle(0.2) }
        var got: [String] = []
        for setting in ["Maximize", "Minimize", "None"] {
            TabBar.doubleClickAction = setting
            let n = tw.offscreenAsked.count
            double()
            got.append("\(setting): \(tw.offscreenAsked.dropFirst(n).joined(separator: ","))")
        }
        TabBar.doubleClickAction = nil
        check("strip_double_click_as_system_says", got == ["Maximize: zoom", "Minimize: miniaturize", "None: "], got.joined(separator: "; "))
    }

    // MARK: WIN-006

    private func newWindowsCascade() {
        guard let app = NSApp.delegate as? AppDelegate else { return check("cascade_app", false) }
        let n = app.windows.filter { !$0.closing }.count
        _ = key("n", .command)
        let opened = wait(5) { app.windows.filter { !$0.closing }.count == n + 1 }
        let made = app.windows.last
        // The onscreen path's placement, on windows never shown (off every
        // screen a window is not placed by it): each cascaded from the one before.
        let vf = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let first = NSWindow(contentRect: NSRect(x: vf.minX + 80, y: vf.maxY - 700, width: 900, height: 600), styleMask: [.titled, .resizable, .closable], backing: .buffered, defer: true)
        let second = NSWindow(contentRect: .zero, styleMask: [.titled, .resizable, .closable], backing: .buffered, defer: true)
        let third = NSWindow(contentRect: .zero, styleMask: [.titled, .resizable, .closable], backing: .buffered, defer: true)
        first.isReleasedWhenClosed = false; second.isReleasedWhenClosed = false; third.isReleasedWhenClosed = false
        AppDelegate.cascade(second, after: first)
        AppDelegate.cascade(third, after: second)
        let f1 = first.frame, f2 = second.frame, f3 = third.frame
        let offset = { (a: NSRect, b: NSRect) in b.minX > a.minX && b.maxY < a.maxY && b.size == a.size }
        let none = !first.isVisible && !second.isVisible && !third.isVisible
        check("new_window_cascaded", opened && offset(f1, f2) && offset(f2, f3) && none,
              "Cmd+N: \(n) to \(app.windows.filter { !$0.closing }.count) windows; frames \(f1) \(f2) \(f3), shown \(!none)")
        if let made, made !== app.windows.first { made.window.performClose(nil) }
        settle(0.5)
    }

    // MARK: TERM-045

    /// A pane that printed, stopped 3 s and printed again: the strip says
    /// the stall; read over a connection that closed, it says so.
    private func filmStallsAndLost() {
        let ws = board.ws
        guard let pane = paneNewTN(["ravenry.kind": "shell"], "film", ["/bin/sh", "-c", "for i in 1 2 3 4 5; do echo tick $i; sleep 0.2; done; sleep 3; for i in 1 2 3 4 5; do echo tock $i; sleep 0.2; done; exec sleep 600"]),
              wait(8, { ws.tab(showing: pane) != nil }), let tab = ws.tab(showing: pane) else { return check("film_stall_setup", false) }
        ws.bar.onSelect?(tab.id)
        _ = wait(10) { ws.boxes[pane]?.term.screen.text().contains("tock 5") ?? false }
        settle(0.5)
        let f = ws.film
        f.load(pane)
        _ = wait(30) { !f.loading }
        board.render(force: true)
        settle(0.4)
        let said = texts(f).joined(separator: " | ")
        check("film_stall_said", f.error == nil && shows(f, t("film.stall1", ["s": "3"])), said)
        picture("native-film-stall-1280.png")
        (f.controls["close"] as? RButton)?.run?()
        settle(0.3)
        // Over a connection to the daemon that closed: the words, with Try again.
        let keep = f.conn
        if let c = try? Connection(socket: ws.conn.socketPath) {
            c.start()
            c.close()
            f.conn = { _ in c }
            f.load(pane)
            _ = wait(10) { !f.loading }
            board.render(force: true)
            settle(0.3)
            check("film_connection_closed_said", f.error == t("film.failed", ["why": t("film.whyLost")]) || shows(f, t("film.whyLost")),
                  "error \(f.error ?? "none"), \(texts(f).joined(separator: " | "))")
            picture("native-film-lost-1280.png")
            f.conn = keep
            (f.controls["close"] as? RButton)?.run?()
        } else { check("film_connection_closed_said", false, "no connection") }
        // The daemon too slow: the words for a request that timed out.
        check("film_slow_words", Film.why(.timeout) == t("film.whySlow"), Film.why(.timeout))
        ws.closePane(pane)
        settle(0.3)
    }

    // MARK: TERM-070

    /// A shell that could not open says why in a toast (the Electron app's words).
    private func shellWords() {
        let b = board, ws = b.ws
        let n = ws.tabs.count, t0 = b.toastTexts.count
        ws.newTab(in: "/nonexistent/harbour notes")
        settle(0.6)
        let said = b.toastTexts.dropFirst(t0).joined(separator: " | ")
        check("shell_open_failed_said", ws.tabs.count == n && said.hasPrefix(t("term.newShellFailed", ["why": ""])) && said.count > 25, "tabs \(ws.tabs.count) of \(n), toasts \"\(said)\"")
        pictures("termnav-shell-failed")
    }

    // MARK: TERM-069 (the first run's end)

    /// Two session tabs (a session's own panes, ravenry.session); the one
    /// whose process the driver ends while Ravenry is not running, and the
    /// one in front at the end.
    private func sessionTabsForRelaunch() {
        let ws = board.ws
        guard let dead = paneNewTN(["ravenry.session": "claude"], "Claude", ["/bin/sleep", "600"]),
              let live = paneNewTN(["ravenry.session": "claude"], "Claude", ["/bin/sleep", "601"]),
              let td = ws.tab(showing: dead), let tl = ws.tab(showing: live) else { return check("relaunch_setup", false) }
        ws.show(td)
        settle(0.3)
        ws.bar.onSelect?(tl.id)
        board.render(force: true)
        settle(0.5)
        ws.save()
        ws.flush()
        let pid = ((try? ws.conn.call("pane.list", [:]))?["panes"] as? [[String: Any]] ?? []).first { $0["id"] as? String == dead }?["pid"] as? NSNumber
        let note: [String: Any] = ["dead": dead, "deadPid": pid?.intValue ?? 0, "live": live, "front": tl.id]
        try? JSONSerialization.data(withJSONObject: note).write(to: URL(fileURLWithPath: out + ".termnav"))
        check("relaunch_setup", pid != nil && ws.active === tl, "dead \(dead) pid \(pid?.intValue ?? 0), live \(live) in front")
    }

    // MARK: termnav2: the app again on the same board and daemon

    func screenTermNav2() {
        let ws = board.ws, b = board
        let note = (try? Data(contentsOf: URL(fileURLWithPath: out.replacingOccurrences(of: "-termnav2.json", with: ".json") + ".termnav")))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] ?? [:]
        guard let dead = note["dead"] as? String, let live = note["live"] as? String, let front = note["front"] as? String else {
            return check("relaunch_note", false, "\(note)")
        }
        settle(1.5)
        b.render(force: true)
        settle(0.5)
        let ids = ws.tabs.map(\.id)
        let deadTab = ws.tabs.contains { $0.host == dead || $0.guest == dead }
        let quiet = !b.toastTexts.contains { $0.lowercased().contains("gone") || $0.contains("ended") || $0.contains("Could not") }
        check("relaunch_dead_session_tab_closes_quietly", !deadTab && quiet, "tabs \(ids), toasts \(b.toastTexts)")
        check("relaunch_front_tab_comes_back", ws.active?.id == front && ws.tabs.contains { $0.host == live }, "front \(ws.active?.id ?? "none") want \(front)")
        check("relaunch_sidebar_width_kept", b.sideWidth == 400 && b.root.sideWidth == 400, "\(b.sideWidth)")
        pictures("termnav2-relaunch")
    }

    // MARK: NAV-004 (from --screen review)

    func navReviewTab() {
        let b = board
        // As --screen review has it: the files it changed (the fixture's answer), notes-app's worktree
        // session running in this window's daemon, done with its turn.
        if let fx = ProcessInfo.processInfo.environment["RAVENRY_MAC_FILES"], let d = try? Data(contentsOf: URL(fileURLWithPath: fx)),
           let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let path = j["path"] as? String, let answer = j["answer"] as? [String: Any] {
            b.hub.testAnswers[path] = answer
        }
        let pane = b.ws.active?.host ?? ""
        b.hub.testPatch = { st in
            var st = st
            var ps = st["projects"] as? [[String: Any]] ?? []
            for i in ps.indices where ps[i]["id"] as? String == "notes-app" {
                var ss = ps[i]["sessions"] as? [[String: Any]] ?? []
                if !ss.isEmpty { ss[0]["pane"] = pane; ss[0]["state"] = "idle" }
                ps[i]["sessions"] = ss
            }
            st["projects"] = ps
            return st
        }
        b.hub.testCheckpoints = []
        defer { b.hub.testPatch = nil; b.hub.testCheckpoints = [] }
        guard let p = b.hub.state?.project("notes-app"), let s = p.sessions.first else { return check("review_tab_session", false) }
        let key = "notes-app/\(s.surfaceId)"
        b.topLevel { $0.pickSession(key, why: "test") }
        _ = wait(6) { b.worktrees.buttons["review"] != nil }
        guard let rb = b.worktrees.buttons["review"] else { return check("review_tab_button", false) }
        click(rb)
        guard wait(3, { b.root.middle === b.review }) else { return check("review_tab_open", false, "\(b.front)") }
        b.render(force: true)
        settle(0.3)
        let items = b.ws.bar.items.map(\.model)
        let i = items.firstIndex { $0.id == "view:page" }
        let sessionTab = s.pane.flatMap { pane in b.ws.tabs.first { $0.host == pane || $0.guest == pane }?.id } ?? "view:\(key)"
        let j = items.firstIndex { $0.id == sessionTab }
        let m = i.map { items[$0] }
        check("review_tab_named_after_session", m?.name == t("review.tab") && m?.sub == "sync-settings" && i != nil && j != nil && i! == j! + 1,
              "strip \(items.map { "\($0.id)=\($0.name)/\($0.sub ?? "")" }), want Review/sync-settings right after \(sessionTab)")
        if let item = b.ws.bar.items.first(where: { $0.model.id == "view:page" }) {
            pictureOver("review-tab", [item])
            // The x, pressed as the person presses it (its own press and release).
            let c = item.close, p = c.convert(NSPoint(x: c.bounds.midX, y: c.bounds.midY), to: nil)
            c.mouseDown(with: mouseAt(.leftMouseDown, p))
            c.mouseUp(with: mouseAt(.leftMouseUp, p))
            settle(0.3)
        }
        check("review_tab_x_back_to_session", wait(3) { b.front == .session(key) || (b.front == .tab && b.root.middle == nil && s.pane != nil) }, "\(b.front)")
    }

    // MARK: TERM-040 (from --screen settings)

    func termThemeImport() {
        guard let imp = ProcessInfo.processInfo.environment["RAVENRY_SETTINGS_IMPORT"] else { return check("theme_import_env", false) }
        let sw = board.settings, store = sw.store
        if !sw.window.isVisible { board.sidebar.footButtons["side.settings"]?.performClick(nil); settle(0.5) }
        sw.tabButtons["appearance"]?.press()
        settle(0.3)
        let root = sw.window.contentView!
        let themes0 = store.userThemes.count
        // Over 1 MB: refused before it is read.
        let big = String(repeating: "# a comment line to pass one megabyte\n", count: 30_000)
        try? big.write(toFile: imp, atomically: true, encoding: .utf8)
        var s0 = board.hub.sent.count
        (sw.controls["import"] as? NSButton)?.performClick(nil)
        settle(0.5)
        let bigSaid = wait(3) { self.shows(root, t("set.importBig")) }
        check("theme_import_over_1mb_refused", bigSaid && store.userThemes.count == themes0 && !board.hub.sent.dropFirst(s0).contains("POST /api/settings/theme-import"),
              texts(root).filter { $0.contains("MB") || $0.contains("theme") }.joined(separator: " | "))
        settingsPictures("settings-import-big")
        // Not a theme: the hub's reason, nothing saved.
        try? "Harbour notes\nThe tide tables for the week, by hand.\n".write(toFile: imp, atomically: true, encoding: .utf8)
        s0 = board.hub.sent.count
        (sw.controls["import"] as? NSButton)?.performClick(nil)
        let said = wait(5) { self.shows(root, "This is not a Ghostty theme file") }
        check("theme_import_not_a_theme_says_why", said && store.userThemes.count == themes0 && board.hub.sent.dropFirst(s0).contains("POST /api/settings/theme-import"),
              texts(root).filter { $0.contains("theme") }.joined(separator: " | "))
        settingsPictures("settings-import-not-theme")
    }

}
