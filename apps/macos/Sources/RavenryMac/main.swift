// Ravenry for macOS, native: one window of tabs and splits, each pane
// drawn by the app itself from the daemon's render stream
// (docs/RENDERING.md). The daemon owns the panes, their terminal state
// and the encoding of keys; the window draws the rows it is sent and
// sends what the person does.
//
//   RavenryMac [--socket PATH] [--attach PANE] [--option-as-alt left|right|both]
//              [--font NAME] [--font-size POINTS]
//              [--offscreen --bench OUT.json [--bench-layer] [--drag-min WIDTH] [--bench-resize [--bench-onscreen]]]
//              [--offscreen --selftest OUT.json] [-- COMMAND ARGS...]
//
// RAVENRY_OFFSCREEN=1 is --offscreen. A packaged app started with a pane's
// variables (RAVENRY_PANE, RAVENRY_SOCKET) relaunches itself clean through
// LaunchServices and exits (Relaunch.swift).
//
// It connects to the newest running daemon that has the render stream
// (a packaged app starts its own) and to every other running daemon that
// has it (Daemons.swift), and shows their shells as tabs (Workspace.swift),
// a new one (the login shell, or COMMAND) when it has none; --attach
// brings that pane to the front. Closing the window leaves the panes
// running, for the next launch (and the Electron app) to show again.

import AppKit

struct Options {
    var socket: String?
    var attach: String?
    var offscreen = false
    var bench: String?
    /// The bench draws through the window's Metal layer, as on screen,
    /// instead of into an offscreen texture.
    var benchLayer = false
    /// The bench's drag of the whole window (the sidebar, the panel, the
    /// tabs) on a test's hub, through the window's Metal layer.
    var benchResize = false
    /// With --bench-resize: the window on the screen, not off every one,
    /// for the drawables as the person's screen gives them back.
    var benchOnscreen = false
    var dragMin: CGFloat = 300
    var optionAsAlt = ""
    /// The font and its size in points for this run (else the settings').
    var font: String?
    var fontSize: CGFloat?
    var selftest: String?
    /// With --selftest: only check that the tabs a self-test left came
    /// back (its selftest.json).
    var restoreCheck: String?
    /// The sidebar and panel's self-test (SelfTestBoard.swift), on a test's hub.
    var sidetest: String?
    /// With --sidetest: one screen's checks only (SelfTestScreens.swift).
    var screen: String?
    var command: [String] = []

    static func parse(_ args: [String]) -> Options {
        var o = Options()
        // As the Electron app reads it: what a relaunch from a pane keeps
        // for a test (Relaunch.swift), since LaunchServices passes no argument.
        o.offscreen = ProcessInfo.processInfo.environment["RAVENRY_OFFSCREEN"] == "1"
        var i = 1
        while i < args.count {
            let a = args[i]
            switch a {
            case "--socket": i += 1; o.socket = args[safe: i]
            case "--attach": i += 1; o.attach = args[safe: i]
            case "--offscreen": o.offscreen = true
            case "--bench": i += 1; o.bench = args[safe: i]
            case "--bench-layer": o.benchLayer = true
            case "--bench-resize": o.benchResize = true; o.benchLayer = true
            case "--bench-onscreen": o.benchOnscreen = true
            case "--drag-min": i += 1; o.dragMin = CGFloat(Double(args[safe: i] ?? "") ?? 300)
            case "--option-as-alt": i += 1; o.optionAsAlt = args[safe: i] ?? ""
            case "--font": i += 1; o.font = args[safe: i]
            case "--selftest": i += 1; o.selftest = args[safe: i]
            case "--restore-check": i += 1; o.restoreCheck = args[safe: i]
            case "--sidetest": i += 1; o.sidetest = args[safe: i]
            case "--screen": i += 1; o.screen = args[safe: i]
            case "--font-size": i += 1; o.fontSize = Double(args[safe: i] ?? "").map { CGFloat($0) }
            case "--": o.command = Array(args[(i + 1)...]); i = args.count
            default: break // AppKit's own (-NSDocumentRevisionsDebugMode ...)
            }
            i += 1
        }
        return o
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

/// A window that may sit off every screen (the bench's), since AppKit
/// otherwise moves a titled window back onto one. Its title bar is the
/// tab strip: transparent, the title hidden, the window's three buttons
/// centred in the strip's height, as the Electron window places them.
final class TerminalWindow: NSWindow {
    var allowOffscreen = false
    /// The bench's drag: the window counts as in a live resize, as while
    /// the person drags its edge (AppKit's own flag cannot be set).
    var simulatedLiveResize = false
    var liveResizing: Bool { inLiveResize || simulatedLiveResize }

    /// The end of the bench's drag: what AppKit tells each view and the
    /// delegate when the person lets go of the edge.
    func endSimulatedLiveResize() {
        simulatedLiveResize = false
        func walk(_ v: NSView) { v.viewDidEndLiveResize(); v.subviews.forEach(walk) }
        if let c = contentView { walk(c) }
        (delegate as? NSWindowDelegate)?.windowDidEndLiveResize?(Notification(name: NSWindow.didEndLiveResizeNotification, object: self))
    }

    func placeButtons() {
        guard let close = standardWindowButton(.closeButton), let bar = close.superview, let container = bar.superview else { return }
        if styleMask.contains(.fullScreen) { return }
        let h = Design.stripHeight
        var f = container.frame
        if f.height != h, let parent = container.superview {
            f.size.height = h
            f.origin.y = parent.bounds.height - h
            container.frame = f
        }
        for (i, kind) in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].enumerated() {
            guard let b = standardWindowButton(kind) else { continue }
            b.setFrameOrigin(NSPoint(x: 18 + CGFloat(i) * 20, y: (bar.bounds.height - b.frame.height) / 2))
        }
    }

    override func sendEvent(_ e: NSEvent) {
        if e.type == .scrollWheel && EventLog.shared.enabled {
            let hit = contentView?.hitTest(contentView?.superview?.convert(e.locationInWindow, from: nil) ?? e.locationInWindow)
            EventLog.shared.write("window scrollWheel hit \(hit.map { String(describing: type(of: $0)) } ?? "none") firstResponder \(firstResponder.map { String(describing: type(of: $0)) } ?? "none") key \(isKeyWindow)")
        }
        super.sendEvent(e)
    }
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        allowOffscreen ? frameRect : super.constrainFrameRect(frameRect, to: screen)
    }
}

/// The sockets of the running daemons, newest first, from the bundled
/// ravenryd (the same lookup every Ravenry client uses).
func daemonSockets() -> [String] {
    let exe = Bundle.main.executableURL!.deletingLastPathComponent().appendingPathComponent("ravenryd")
    let p = Process()
    p.executableURL = exe
    p.arguments = ["daemons", "--json"]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return [] }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] ?? []
    return rows.compactMap { $0["socket"] as? String }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let options: Options
    /// Every window open (Windows.swift), the first opened first.
    var windows: [RavenryWindow] = []
    /// The window used last (the menus act on it when none is key).
    weak var lastActive: RavenryWindow?
    var daemons: Daemons?
    var closing = false
    /// Quitting: a window that closes now keeps its tabs for the next launch.
    var terminating = false
    /// The first window has opened (its failure ends the app; a later one's does not).
    var launched = false
    /// What the app did with its windows, for the self-test.
    var windowLog: [String] = []

    init(options: Options) { self.options = options }

    /// The first window still open, its tabs, its board and its hub (the bench, the self-test, the install check).
    var window: TerminalWindow? { windows.first?.window }
    var workspace: Workspace? { windows.first?.ws }
    var board: Board? { windows.first?.board }
    var hub: HubClient? { (current ?? windows.first)?.hub }

    /// The view with the keyboard (the bench and the self-test drive it).
    var view: TerminalView? { workspace?.focusedView }

    /// Connects to the daemon: the one given; else the newest running
    /// that has the render stream; a packaged app starts its own when none
    /// runs, or beside an older one after an update (Install.swift), as
    /// the Electron app's DaemonLink.ensure does.
    func connect() throws -> Connection {
        if let s = options.socket { return try open([s]) }
        let inst = AppInstall.shared
        let own = inst.active(offscreen: options.offscreen) ? inst.staged : nil
        let lister = own?.ravenryd ?? Bundle.main.executableURL!.deletingLastPathComponent().appendingPathComponent("ravenryd").path
        // Newest first, one that drains (an older version's, after an update) last.
        let live = liveDaemons(lister, env: inst.env)
        let found: Connection? = try? open((live.filter { !$0.draining } + live.filter { $0.draining }).map(\.socket))
        guard let own else {
            if let found { return found }
            return try open(daemonSockets())
        }
        if let f = found, compareVersions(own.version, f.daemonVersion) <= 0 {
            inst.log("daemon: using \(f.daemonVersion) at \(f.socketPath)")
            return f
        }
        let was = found.map { "beside \($0.daemonVersion)" } ?? "none ran"
        found?.close()
        inst.log("daemon: starting this app's \(own.version) (\(was))")
        _ = startDaemon(own.ravenryd, env: inst.env)
        var why = "the daemon it started did not answer"
        for _ in 0..<100 {
            let mine = liveDaemons(own.ravenryd, env: inst.env).filter { $0.version == own.version && !$0.draining }.map(\.socket)
            if !mine.isEmpty {
                do {
                    let c = try open(mine)
                    inst.log("daemon: using \(c.daemonVersion) at \(c.socketPath)")
                    return c
                } catch { why = "\(error)" }
            }
            usleep(50_000)
        }
        throw ConnectionError.connect(why)
    }

    /// The first of these daemons that answers with the render stream.
    private func open(_ sockets: [String]) throws -> Connection {
        var why = "no daemon is running"
        for s in sockets {
            do {
                let c = try Connection(socket: s)
                c.start()
                // The Electron app's name: the daemon takes the Ravenry app's own
                // process (pane.DesktopApp: an app bundle's executable, not run as
                // Node) for the person wherever it was started from, and cancels
                // the drive cards its keys made while it was not (2026-11-10: this
                // app, opened from an agent's pane, turned the person's focus-out
                // into "Claude wants to type <Esc>[O"). Under its own name it was
                // judged by its environment like any program.
                try c.hello(client: "ravenry-desktop")
                if c.methods.contains("pane.render") { return c }
                why = "the daemon at \(s) (\(c.daemonVersion)) is older than the render stream"
                c.close()
            } catch {
                why = "\(s): \(error)"
            }
        }
        throw ConnectionError.connect(why)
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        EventLog.shared.open(offscreen: options.offscreen)
        // Off every screen, nothing is opened outside the window: recorded (Outside.swift).
        if options.offscreen { Outside.record = [] }
        // A packaged app: its ravenryd and hub copied out first, so a daemon
        // it starts runs from that copy (Install.swift).
        let inst = AppInstall.shared
        let installing = inst.active(offscreen: options.offscreen)
        if installing { inst.stage() }
        let c: Connection
        do {
            c = try connect()
        } catch {
            fail("\(error)")
            return
        }
        // Every other daemon beside it with the render stream: their panes
        // are tabs too, each over its own connection (Daemons.swift). With
        // --socket, that daemon only.
        let ds = Daemons(first: c, watch: options.socket == nil, log: installing ? { inst.log($0) } : { NSLog("RavenryMac: \($0)") })
        ds.joinNow()
        daemons = ds
        buildMenu()
        ds.onEvent = { [weak self] d, ev in self?.route(ev, from: d) }
        ds.onLeave = { [weak self] d in
            guard let self, !self.closing else { return }
            for w in self.windows where !w.closing { w.ws.left(d) }
        }
        // The first window: every tab as the last launch left it.
        guard let first = makeWindow(.restore) else { return }
        let ws = first.ws, w = first.window, bd = first.board!
        // Daemons that start later (a newer app's after an update) join as they come, in the first window open.
        ds.onJoin = { [weak self] d in self?.windows.first { !$0.closing }?.ws.joined(d) }
        ds.watch()
        // The hub service, in the background (Install.swift); the window
        // reads the hub as soon as it answers.
        if installing { inst.setUpHub() }
        // Updates: a check a little after launch, then every few hours (Updater.swift).
        Updater.shared.start(offscreen: options.offscreen)
        if options.offscreen, let rp = ProcessInfo.processInfo.environment["RAVENRY_MAC_REPORT"], !rp.isEmpty { report(to: rp) }
        guard let v = ws.focusedView else {
            fail("no pane to show")
            return
        }
        if let out = options.bench {
            let b = Bench(view: v, window: w, out: out, dragMin: options.dragMin, workspace: ws)
            b.board = bd
            b.resizeOnly = options.benchResize
            b.onscreen = options.benchOnscreen
            b.start()
        } else if let out = options.sidetest {
            let st = SelfTestBoard(board: bd, window: w, out: out)
            st.screen = options.screen
            st.start()
        } else if let out = options.selftest {
            let st = SelfTest(view: v, window: w, out: out, workspace: ws)
            st.restoreFrom = options.restoreCheck
            st.start()
        }
    }

    /// Off every screen, for the install check (scripts/installcheck.mjs):
    /// each second, the daemon the window is on, its tabs, the tab in
    /// front and what its pane drew.
    private func report(to path: String) {
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self, let ws = self.workspace else { return }
            let c = ws.conn
            let v = ws.focusedView
            let j: [String: Any] = [
                "daemon": c.daemonVersion, "socket": c.socketPath,
                "daemons": ws.daemons.all.map { ["version": $0.version, "socket": $0.socket, "draining": $0.draining] },
                "tabs": ws.tabs.map { t in
                    ["host": t.host, "guest": t.guest ?? "", "daemon": ws.daemon(of: t.host)?.version ?? "",
                     "frames": ws.boxes[t.host]?.term.screen.frames ?? 0]
                },
                "front": ws.active?.host ?? "",
                "sidebarEmpty": self.board?.sidebar.emptyText ?? "",
                "focused": ["pane": v?.pane ?? "", "frames": v?.screen.frames ?? 0, "draws": v?.drawCount ?? 0, "text": v?.screen.text() ?? ""],
            ]
            if let d = try? JSONSerialization.data(withJSONObject: j) { try? d.write(to: URL(fileURLWithPath: path), options: .atomic) }
        }
    }

    func fail(_ msg: String) {
        NSLog("RavenryMac: \(msg)")
        if options.offscreen {
            if let out = options.bench ?? options.selftest {
                try? JSONSerialization.data(withJSONObject: ["error": msg]).write(to: URL(fileURLWithPath: out))
            }
            NSApp.terminate(nil)
            return
        }
        let a = NSAlert()
        a.messageText = "Ravenry cannot open a terminal"
        a.informativeText = msg
        a.runModal()
        NSApp.terminate(nil)
    }

    /// Ravenry quits; its panes keep running in the daemon (TERM-001),
    /// and come back as tabs at the next launch.
    private func shutdown() {
        guard !closing else { return }
        closing = true
        terminating = true
        for w in windows {
            w.ws.save()
            w.ws.flush()
            w.hub.stop()
        }
        daemons?.close()
    }

    func applicationWillTerminate(_ note: Notification) {
        shutdown()
        // A downloaded update goes in once this process has ended (Updater.swift).
        Updater.shared.atQuit()
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        terminating = true
        return .terminateNow
    }

    /// The last window closed: Ravenry keeps running (a Mac app's habit;
    /// the Dock's icon, Cmd+N, Help or the Dock opens one again).
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

    /// The menus, as the Electron app's (apps/desktop/src/main/main.ts) and
    /// a Mac app's: each command acts on the window in front (Windows.swift).
    private func buildMenu() {
        let main = NSMenu()
        func menu(_ title: String) -> NSMenu {
            let item = NSMenuItem()
            main.addItem(item)
            let m = NSMenu(title: title)
            item.submenu = m
            return m
        }
        @discardableResult
        func add(_ m: NSMenu, _ title: String, _ action: Selector, _ key: String, _ mods: NSEvent.ModifierFlags = .command,
                 target: AnyObject? = nil, tag: Int = 0, hidden: Bool = false) -> NSMenuItem {
            let i = m.addItem(withTitle: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            i.target = target
            i.tag = tag
            if hidden {
                i.isHidden = true
                i.allowsKeyEquivalentWhenHidden = true
            }
            return i
        }
        // The app menu, as a Mac app's: About, Settings, Services, Hide, Quit.
        let appMenu = menu("Ravenry")
        add(appMenu, "About Ravenry", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), "", target: NSApp)
        // Check for Updates... (Restart to Update), and Go Back to the npm Board... after a switch (Updater.swift).
        Updater.shared.addMenuItems(to: appMenu)
        appMenu.addItem(.separator())
        add(appMenu, "Settings\u{2026}", #selector(menuSettings(_:)), ",", target: self)
        appMenu.addItem(.separator())
        let services = NSMenu(title: "Services")
        appMenu.addItem(withTitle: "Services", action: nil, keyEquivalent: "").submenu = services
        NSApp.servicesMenu = services
        appMenu.addItem(.separator())
        add(appMenu, "Hide Ravenry", #selector(NSApplication.hide(_:)), "h", target: NSApp)
        add(appMenu, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option], target: NSApp)
        add(appMenu, "Show All", #selector(NSApplication.unhideAllApplications(_:)), "", target: NSApp)
        appMenu.addItem(.separator())
        add(appMenu, "Quit Ravenry", #selector(NSApplication.terminate(_:)), "q")

        // The Electron app's Shell menu (apps/desktop/src/main/main.ts).
        let shell = menu("Shell")
        add(shell, "New Shell", #selector(menuNewTab(_:)), "t", target: self)
        add(shell, "New Session\u{2026}", #selector(menuNewSession(_:)), "N", [.command, .shift], target: self)
        add(shell, "New Window", #selector(menuNewWindow(_:)), "n", target: self)
        shell.addItem(.separator())
        add(shell, "Split Right", #selector(menuSplitRight(_:)), "d", target: self)
        add(shell, "Split Down", #selector(menuSplitDown(_:)), "D", [.command, .shift], target: self)
        let arrows: [(String, String, Int)] = [("Select Pane Left", String(UnicodeScalar(NSLeftArrowFunctionKey)!), 0),
                                               ("Select Pane Right", String(UnicodeScalar(NSRightArrowFunctionKey)!), 1),
                                               ("Select Pane Above", String(UnicodeScalar(NSUpArrowFunctionKey)!), 2),
                                               ("Select Pane Below", String(UnicodeScalar(NSDownArrowFunctionKey)!), 3)]
        for (t, k, tag) in arrows { add(shell, t, #selector(menuFocusPane(_:)), k, [.command, .option], target: self, tag: tag) }
        add(shell, "Zoom Pane", #selector(menuZoom(_:)), "\r", [.command, .shift], target: self)
        add(shell, "Equalize Splits", #selector(menuEqualize(_:)), "=", [.command, .control], target: self)
        shell.addItem(.separator())
        add(shell, "Close", #selector(menuClose(_:)), "w", target: self)
        add(shell, "Close Window", #selector(NSWindow.performClose(_:)), "w", [.command, .shift])

        let editMenu = menu("Edit")
        editMenu.addItem(withTitle: "Copy", action: #selector(TerminalView.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(TerminalView.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSResponder.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(withTitle: "Clear", action: #selector(TerminalView.clearScreen(_:)), keyEquivalent: "k")
        editMenu.addItem(.separator())
        let findItem = editMenu.addItem(withTitle: "Find", action: nil, keyEquivalent: "")
        let findMenu = NSMenu(title: "Find")
        findMenu.addItem(withTitle: "Find\u{2026}", action: #selector(TerminalView.showFindBar(_:)), keyEquivalent: "f")
        findMenu.addItem(withTitle: "Find Next", action: #selector(TerminalView.findNext(_:)), keyEquivalent: "g")
        let previous = findMenu.addItem(withTitle: "Find Previous", action: #selector(TerminalView.findPrevious(_:)), keyEquivalent: "g")
        previous.keyEquivalentModifierMask = [.command, .shift]
        findItem.submenu = findMenu

        let viewMenu = menu("View")
        viewMenu.addItem(withTitle: "Increase Font Size", action: #selector(TerminalView.increaseFontSize(_:)), keyEquivalent: "=")
        let plus = viewMenu.addItem(withTitle: "Increase Font Size", action: #selector(TerminalView.increaseFontSize(_:)), keyEquivalent: "+")
        plus.isHidden = true
        plus.allowsKeyEquivalentWhenHidden = true
        viewMenu.addItem(withTitle: "Decrease Font Size", action: #selector(TerminalView.decreaseFontSize(_:)), keyEquivalent: "-")
        viewMenu.addItem(withTitle: "Reset Font Size", action: #selector(TerminalView.resetFontSize(_:)), keyEquivalent: "0")
        viewMenu.addItem(.separator())
        add(viewMenu, "Next Tab", #selector(menuNextTab(_:)), "\t", .control, target: self)
        add(viewMenu, "Previous Tab", #selector(menuPreviousTab(_:)), "\t", [.control, .shift], target: self)
        // (Shift+Tab types a back tab, U+0019.)
        add(viewMenu, "Previous Tab", #selector(menuPreviousTab(_:)), "\u{19}", [.control, .shift], target: self, hidden: true)
        add(viewMenu, "Next Tab", #selector(menuNextTab(_:)), "}", .command, target: self, hidden: true)
        add(viewMenu, "Previous Tab", #selector(menuPreviousTab(_:)), "{", .command, target: self, hidden: true)
        add(viewMenu, "Next Tab", #selector(menuNextTab(_:)), "]", [.command, .shift], target: self, hidden: true)
        add(viewMenu, "Previous Tab", #selector(menuPreviousTab(_:)), "[", [.command, .shift], target: self, hidden: true)
        for i in 0..<9 { add(viewMenu, "Tab \(i + 1)", #selector(menuSelectTab(_:)), "\(i + 1)", target: self, tag: i, hidden: true) }
        viewMenu.addItem(.separator())
        add(viewMenu, t("side.hide"), #selector(menuToggleSidebar(_:)), "s", [.command, .control], target: self)
        add(viewMenu, t("panel.hideMenu"), #selector(menuTogglePanel(_:)), "b", [.command, .option], target: self)

        // The Window menu, as a Mac app's (the Electron app's windowMenu
        // role): AppKit lists the windows under it.
        let windowMenu = menu("Window")
        add(windowMenu, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
        add(windowMenu, "Zoom", #selector(NSWindow.performZoom(_:)), "")
        windowMenu.addItem(.separator())
        add(windowMenu, "Move Tab to New Window", #selector(menuMoveTabToNewWindow(_:)), "", target: self)
        add(windowMenu, "Merge All Windows", #selector(menuMergeAllWindows(_:)), "", target: self)
        windowMenu.addItem(.separator())
        add(windowMenu, "Bring All to Front", #selector(NSApplication.arrangeInFront(_:)), "", target: NSApp)
        NSApp.windowsMenu = windowMenu

        // Help, Learn Ravenry (learn.ts), as the Electron app's Help menu.
        let help = menu("Help")
        NSApp.helpMenu = help
        add(help, t("learn.title"), #selector(menuLearn(_:)), "", target: self)
        NSApp.mainMenu = main
    }
}

// Run as Node (the hub service, the hooks): before anything else, with the
// environment as it came (NodeRunner.swift).
if ProcessInfo.processInfo.environment["ELECTRON_RUN_AS_NODE"] == "1" { NodeRunner.run() }

// The environment as launched: the relaunch from a pane (Relaunch.swift)
// judges the launch as it came.
let launchEnv = ProcessInfo.processInfo.environment

// A start that stays with a pane's variables (a development build, a test
// run, the self-tests, the loop guard below) must not pass them on to what
// it starts (its daemon, the setup's Node, a link it opens). This does not
// change what the daemon reads of this process (the kernel's copy of its
// first environment): that is what the relaunch below is for.
for name in ["RAVENRY_PANE", "RAVENRY_SOCKET", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"] {
    unsetenv(name)
}

let options = Options.parse(CommandLine.arguments)
// --older-hub-check IN OUT: a state from an older hub, filled as the window
// fills it (OlderHub.swift), for its check; no window.
if let i = CommandLine.arguments.firstIndex(of: "--older-hub-check"), CommandLine.arguments.count > i + 2,
   let d = try? Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[i + 1])),
   let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
    let out = OlderHub().fill(j)
    try? JSONSerialization.data(withJSONObject: out).write(to: URL(fileURLWithPath: CommandLine.arguments[i + 2]))
    exit(0)
}

// Started with a pane's variables (an agent in a pane opened the app):
// relaunched clean, as the Dock starts it, before any window, daemon or
// hub (Relaunch.swift, the Electron app's relaunch.ts). Such a start exits here.
Relaunch.atLaunch(env: launchEnv, offscreen: options.offscreen)

let app = NSApplication.shared
// The bench runs without a Dock icon and never takes focus.
app.setActivationPolicy(options.offscreen ? .accessory : .regular)
let delegate = AppDelegate(options: options)
app.delegate = delegate
app.run()
