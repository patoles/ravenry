// Ravenry's windows, as a Mac app has them (and the Electron app's Cmd+N):
// each window has its own tabs and splits (Workspace), its own sidebar,
// panel and pages (Board) and its own stream from the hub, over the same
// daemons. So the console can sit in one window and the board in another
// (Simon, 2026-11-10: "can't split console from UI").
//
// - Shell > New Window (Cmd+N): a window with a shell of its own, in the
//   folder of the pane in front (as Cmd+T), cascaded from the window in
//   front. With no window open, the tabs come back as at launch.
// - Window > Move Tab to New Window (also on a tab's right click): the tab
//   in front goes to a window of its own; its panes keep running, nothing
//   is closed. Merge All Windows brings every tab into the window in front.
// - Closing a window never ends a shell: its tabs join the window in front
//   (their panes keep running, as the daemon keeps them). Closing the last
//   one keeps Ravenry running (the Dock's icon, Cmd+N or a click on the
//   Dock opens a window again with every tab). Quit ends the app, never
//   the panes (TERM-001).
// - The menus act on the window in front (the key window, else the one
//   used last): a tab command brings its terminal to the front first
//   (Board.tabCommand), Cmd+W closes what is in front (a page goes back,
//   on a terminal the pane), and Cmd+W with Settings in front closes Settings.
// - The daemons' events go to the window that has the pane; an agent's new
//   pane to the window of the pane that made it, else the one in front, so
//   no pane is a tab in two windows.

import AppKit

/// One window: its tabs, its board, its hub stream.
final class RavenryWindow: NSObject, NSWindowDelegate {
    let window: TerminalWindow
    let ws: Workspace
    let hub: HubClient
    private(set) var board: Board!
    weak var app: AppDelegate?
    var closing = false
    /// The strip's right click (Move Tab to New Window).
    let tabMenu = TabMenu()

    init(window: TerminalWindow, ws: Workspace, hub: HubClient) {
        self.window = window
        self.ws = ws
        self.hub = hub
        super.init()
        tabMenu.rw = self
        let m = NSMenu()
        m.delegate = tabMenu
        ws.bar.menu = m
    }

    func attach(_ b: Board) { board = b }

    func windowDidResize(_ note: Notification) { board?.resized() }
    func windowDidEndLiveResize(_ note: Notification) { board?.resizeEnded() }
    func windowDidBecomeKey(_ note: Notification) {
        app?.lastActive = self
        ws.focusedView?.setFocus(true)
    }
    func windowDidResignKey(_ note: Notification) { if !ws.options.offscreen { ws.focusedView?.setFocus(false) } }
    func windowWillClose(_ note: Notification) { app?.windowClosed(self) }
}

extension AppDelegate {
    /// What a new window shows first.
    enum Opening {
        /// Every running tab, as at launch (the first window, or one opened when none is).
        case restore
        /// A new shell in this folder (Cmd+N).
        case shell(String?)
        /// These panes, as one tab (Move Tab to New Window).
        case panes([String])
    }

    /// The window in front: the key window, else the one used last, else the newest.
    var current: RavenryWindow? {
        let live = windows.filter { !$0.closing }
        return live.first { $0.window === NSApp.keyWindow } ?? live.first { $0 === lastActive } ?? live.last
    }

    /// A new window on the app's daemons. nil when it could not show a tab.
    @discardableResult
    func makeWindow(_ how: Opening) -> RavenryWindow? {
        guard let ds = daemons else { return nil }
        let first = windows.isEmpty && !launched
        let rect = NSRect(x: 0, y: 0, width: 900, height: 560 + Design.stripHeight)
        let w = TerminalWindow(contentRect: rect, styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
                               backing: .buffered, defer: false)
        w.title = "Ravenry"
        w.titleVisibility = .hidden
        w.titlebarAppearsTransparent = true
        w.isReleasedWhenClosed = false
        w.isRestorable = false
        w.tabbingMode = .disallowed
        w.allowOffscreen = options.offscreen
        w.backgroundColor = Design.termBg
        let scale = options.offscreen && !options.benchOnscreen ? 2 : (NSScreen.main?.backingScaleFactor ?? 2)
        let ws = Workspace(window: w, options: options, daemons: ds, scale: scale)
        w.backgroundColor = Design.tbg
        ws.root.frame = NSRect(origin: .zero, size: rect.size)
        ws.root.autoresizingMask = [.width, .height]
        w.contentView = ws.root
        ws.root.onLayout = { [weak w] in w?.placeButtons() }
        let hc = HubClient(offscreen: options.offscreen)
        let rw = RavenryWindow(window: w, ws: ws, hub: hc)
        rw.app = self
        rw.tabMenu.app = self
        w.delegate = rw
        let before = current
        windows.append(rw)
        lastActive = rw
        // Placed: the first where it was left; another cascaded from the window in front.
        if options.offscreen && options.benchOnscreen {
            w.setFrameOrigin(NSScreen.main?.visibleFrame.origin ?? .zero)
            w.orderFront(nil)
        } else if options.offscreen {
            w.setFrameOrigin(NSPoint(x: -30000 - CGFloat(windows.count - 1) * 2000, y: -30000))
            w.orderFront(nil)
        } else {
            if let b = before?.window, !first {
                w.setFrame(b.frame, display: false)
                w.setFrameTopLeftPoint(w.cascadeTopLeft(from: NSPoint(x: b.frame.minX, y: b.frame.maxY)))
            } else if !ws.placeWindow() { w.center() }
            ws.keepBounds()
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        w.placeButtons()
        switch how {
        case .restore:
            do { try ws.restore() } catch {
                NSLog("RavenryMac: restore: \(error)")
                if first { return failed(rw, "\(error)") }
            }
        case .shell(let cwd):
            ws.newTab(in: cwd)
        case .panes(let ids):
            for id in ids { _ = ws.tab(showing: id) }
            if let t = ws.tabs.first { ws.show(t, wait: true) }
        }
        if ws.tabs.isEmpty {
            if first { return failed(rw, "no pane to show") }
            NSLog("RavenryMac: the new window has no pane to show")
        }
        // The sidebar and the panel, from the hub. The bench and the
        // terminal's self-test measure the terminal: the sidebar starts
        // folded there (RAVENRY_MAC_SIDEBAR=1 shows it).
        let measuring = options.bench != nil || options.selftest != nil
        let bd = Board(ws: ws, hub: hc, keep: !options.offscreen,
                       sidebarOn: !first || !measuring || options.benchResize || ProcessInfo.processInfo.environment["RAVENRY_MAC_SIDEBAR"] == "1")
        rw.attach(bd)
        launched = true
        log("window \(windows.count): \(how)")
        return rw
    }

    private func failed(_ rw: RavenryWindow, _ why: String) -> RavenryWindow? {
        windows.removeAll { $0 === rw }
        rw.closing = true
        fail(why)
        return nil
    }

    /// What the app did with its windows, for the self-test.
    func log(_ s: String) { windowLog.append(s) }

    // MARK: the menus' window commands

    /// Cmd+N: a window with a new shell in the folder of the pane in front; with none open, every tab as at launch.
    @objc func menuNewWindow(_ sender: Any?) {
        guard let c = current else { makeWindow(.restore); return }
        let cwd = c.ws.focusedView.flatMap { v in c.ws.paneInfo(v.pane)?.cwd }
        makeWindow(.shell(cwd))
    }

    /// The tab in front to a window of its own: its panes keep running, its place here goes.
    @objc func menuMoveTabToNewWindow(_ sender: Any?) {
        guard let c = current, let t = c.ws.active else { return }
        moveTab(t, from: c)
    }

    @discardableResult
    func moveTab(_ t: Tab, from c: RavenryWindow) -> RavenryWindow? {
        guard c.ws.tabs.count > 1 else { return nil }
        let ids = c.ws.panes(of: t)
        c.board.toTerminal()
        guard let nw = makeWindow(.panes(ids)) else { return nil }
        // Out of the old window without closing them (the guest first, so the tab goes whole).
        for id in ids.reversed() { c.ws.removePane(id) }
        c.board.render()
        log("moved \(ids.joined(separator: "+")) to window \(windows.count)")
        return nw
    }

    /// Every tab of every window into the window in front; the others close.
    @objc func menuMergeAllWindows(_ sender: Any?) {
        guard let c = current else { return }
        for o in windows where o !== c && !o.closing { o.window.close() }
        c.window.makeKeyAndOrderFront(nil)
    }

    /// A window closed (its button, Cmd+Shift+W, its last tab): its tabs
    /// join the window in front; its views stop drawing. The last one
    /// closed, Ravenry keeps running.
    func windowClosed(_ rw: RavenryWindow) {
        guard !rw.closing else { return }
        rw.closing = true
        windows.removeAll { $0 === rw }
        if lastActive === rw { lastActive = nil }
        rw.ws.save()
        rw.ws.flush()
        if !terminating, let to = current {
            var moved: [String] = []
            for t in rw.ws.tabs {
                for id in rw.ws.panes(of: t) where to.ws.tab(showing: id) != nil { moved.append(id) }
            }
            if !moved.isEmpty {
                to.ws.refresh()
                to.ws.save()
                to.board.render()
            }
            log("window closed: \(moved.count) panes joined the window in front")
        } else {
            log("window closed: the last; Ravenry keeps running")
        }
        for b in rw.ws.boxes.values { b.term.pause() }
        rw.board?.close()
    }

    /// The Dock's icon clicked with no window: one again, with every tab.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if windows.isEmpty { makeWindow(.restore) }
        return true
    }

    // MARK: the menus' tab and board commands, for the window in front

    @objc func menuNewTab(_ sender: Any?) { current?.board.tabCommand("new shell") { $0.newTab(nil) } }
    @objc func menuSplitRight(_ sender: Any?) { current?.board.tabCommand("split right") { $0.split("right") } }
    @objc func menuSplitDown(_ sender: Any?) { current?.board.tabCommand("split down") { $0.split("down") } }
    @objc func menuFocusPane(_ sender: NSMenuItem) {
        let dir = ["left", "right", "up", "down"][sender.tag]
        current?.board.tabCommand("pane \(dir)") { $0.focusToward(dir) }
    }
    @objc func menuZoom(_ sender: Any?) { current?.board.tabCommand("zoom") { $0.toggleZoom() } }
    @objc func menuEqualize(_ sender: Any?) { current?.board.tabCommand("equalize") { $0.equalize() } }
    @objc func menuNextTab(_ sender: Any?) { current?.board.stepTab(1) }
    @objc func menuPreviousTab(_ sender: Any?) { current?.board.stepTab(-1) }
    @objc func menuSelectTab(_ sender: NSMenuItem) { current?.board.tabCommand("tab \(sender.tag + 1)") { $0.select(index: sender.tag) } }
    /// Cmd+W: Settings (or another window that is not a terminal's) closes; else what is in front.
    @objc func menuClose(_ sender: Any?) {
        if let k = NSApp.keyWindow, !windows.contains(where: { $0.window === k }) { k.performClose(sender); return }
        current?.board.closeCommand()
    }
    @objc func menuNewSession(_ sender: Any?) { current?.board.openStart(nil) }
    @objc func menuSettings(_ sender: Any?) { (current?.board ?? Board.lastFront)?.openSettings() }
    @objc func menuLearn(_ sender: Any?) {
        guard let c = current ?? makeWindow(.restore) else { return }
        c.board.openLearn()
    }
    @objc func menuToggleSidebar(_ sender: Any?) { current?.board.toggleSidebar() }
    @objc func menuTogglePanel(_ sender: Any?) { current?.board.togglePanel() }

    @objc func validateMenuItem(_ item: NSMenuItem) -> Bool {
        let c = current
        switch item.action {
        case #selector(menuToggleSidebar(_:)):
            item.title = c?.board.sideHidden ?? false ? t("side.show") : t("side.hide")
            return c != nil
        case #selector(menuTogglePanel(_:)):
            item.title = c?.board.panelVisible ?? false ? t("panel.hideMenu") : t("panel.showMenu")
            return c != nil
        case #selector(menuMoveTabToNewWindow(_:)): return (c?.ws.tabs.count ?? 0) > 1
        case #selector(menuMergeAllWindows(_:)): return windows.filter { !$0.closing }.count > 1
        case #selector(menuNewWindow(_:)), #selector(menuSettings(_:)), #selector(menuLearn(_:)): return true
        case #selector(menuClose(_:)): return NSApp.keyWindow != nil || c != nil
        default: return c != nil
        }
    }

    // MARK: the daemons' events, to the window that has the pane

    func route(_ ev: [String: Any], from d: DaemonLink) {
        let live = windows.filter { !$0.closing }
        guard !live.isEmpty else { return }
        let name = ev["event"] as? String ?? ""
        guard let p = ev["pane"] as? [String: Any], let id = p["id"] as? String else {
            // A stream's end: each window looks for it among its own.
            for w in live { w.ws.event(ev, from: d) }
            return
        }
        var to = live.filter { $0.ws.paneInfo(id) != nil }
        if to.isEmpty {
            // A pane no window knows yet (an agent's own pane): the window of the pane that made it, else the one in front.
            let maker = (p["creator"] as? [String: Any])?["pane"] as? String
            to = [maker.flatMap { m in live.first { $0.ws.paneInfo(m) != nil } } ?? current ?? live[0]]
        }
        for w in to {
            if name == "pane.focus", w.ws.tabs.contains(where: { $0.host == id || $0.guest == id }) {
                // ravenryd focus: that window in front, its terminal in front of any page.
                w.board.toTerminal()
                if !options.offscreen { w.window.makeKeyAndOrderFront(nil) }
            }
            w.ws.event(ev, from: d)
        }
    }
}

/// A tab's right click: Move Tab to New Window (the tab under the pointer).
final class TabMenu: NSObject, NSMenuDelegate {
    weak var app: AppDelegate?
    weak var rw: RavenryWindow?
    private var tabId: String?

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        guard let rw, let e = NSApp.currentEvent, e.window === rw.window else { return }
        guard let item = rw.ws.bar.items.first(where: { $0.bounds.contains($0.convert(e.locationInWindow, from: nil)) }),
              !item.model.id.hasPrefix("view:") else { return }
        tabId = item.model.id
        let mv = menu.addItem(withTitle: "Move Tab to New Window", action: #selector(moveTab(_:)), keyEquivalent: "")
        mv.target = self
        mv.isEnabled = rw.ws.tabs.count > 1
    }

    @objc func moveTab(_ sender: Any?) {
        guard let rw, let app, let t = rw.ws.tabs.first(where: { $0.id == tabId }) else { return }
        app.moveTab(t, from: rw)
    }
}
