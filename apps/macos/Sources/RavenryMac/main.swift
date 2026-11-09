// Ravenry for macOS, native: one window of tabs and splits, each pane
// drawn by the app itself from the daemon's render stream
// (docs/RENDERING.md). The daemon owns the panes, their terminal state
// and the encoding of keys; the window draws the rows it is sent and
// sends what the person does.
//
//   RavenryMac [--socket PATH] [--attach PANE] [--option-as-alt left|right|both]
//              [--font NAME] [--font-size POINTS]
//              [--offscreen --bench OUT.json [--bench-layer] [--drag-min WIDTH]]
//              [--offscreen --selftest OUT.json] [-- COMMAND ARGS...]
//
// It connects to the newest running daemon that has the render stream
// (never starting one) and shows its shells as tabs (Workspace.swift),
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
    var dragMin: CGFloat = 300
    var optionAsAlt = ""
    /// The font, and its size in points; Menlo 12 (Rex's, Ghostty's
    /// default on a Mac) when not given.
    var font = "Menlo"
    var fontSize: CGFloat?
    var selftest: String?
    /// With --selftest: only check that the tabs a self-test left came
    /// back (its selftest.json).
    var restoreCheck: String?
    var command: [String] = []

    static func parse(_ args: [String]) -> Options {
        var o = Options()
        var i = 1
        while i < args.count {
            let a = args[i]
            switch a {
            case "--socket": i += 1; o.socket = args[safe: i]
            case "--attach": i += 1; o.attach = args[safe: i]
            case "--offscreen": o.offscreen = true
            case "--bench": i += 1; o.bench = args[safe: i]
            case "--bench-layer": o.benchLayer = true
            case "--drag-min": i += 1; o.dragMin = CGFloat(Double(args[safe: i] ?? "") ?? 300)
            case "--option-as-alt": i += 1; o.optionAsAlt = args[safe: i] ?? ""
            case "--font": i += 1; o.font = args[safe: i] ?? "Menlo"
            case "--selftest": i += 1; o.selftest = args[safe: i]
            case "--restore-check": i += 1; o.restoreCheck = args[safe: i]
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

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let options: Options
    var window: TerminalWindow?
    var workspace: Workspace?
    var conn: Connection?
    var closing = false

    init(options: Options) { self.options = options }

    /// The view with the keyboard (the bench and the self-test drive it).
    var view: TerminalView? { workspace?.focusedView }

    /// Connects to the daemon: the one given, or the newest that has the
    /// render stream.
    func connect() throws -> Connection {
        let sockets = options.socket.map { [$0] } ?? daemonSockets()
        var why = "no daemon is running"
        for s in sockets {
            do {
                let c = try Connection(socket: s)
                c.start()
                try c.hello(client: "ravenry-macos")
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
        let rect = NSRect(x: 0, y: 0, width: 900, height: 560 + Design.stripHeight)
        let w = TerminalWindow(contentRect: rect, styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
                               backing: .buffered, defer: false)
        w.title = "Ravenry"
        w.titleVisibility = .hidden
        w.titlebarAppearsTransparent = true
        w.isReleasedWhenClosed = false
        w.isRestorable = false
        w.tabbingMode = .disallowed
        w.delegate = self
        w.allowOffscreen = options.offscreen
        w.backgroundColor = Design.termBg
        let scale = options.offscreen ? 2 : (NSScreen.main?.backingScaleFactor ?? 2)
        // The size the person picked last, kept in the app's defaults; the
        // bench and the self-test (offscreen) never read or write them.
        let defaultSize = min(72, max(6, options.fontSize ?? 12))
        var size = defaultSize
        if !options.offscreen && options.fontSize == nil,
           let kept = UserDefaults.standard.object(forKey: TerminalView.fontSizeKey) as? Double {
            size = min(72, max(6, CGFloat(kept)))
        }
        window = w
        let c: Connection
        do {
            c = try connect()
        } catch {
            fail("\(error)")
            return
        }
        conn = c
        let ws = Workspace(window: w, options: options, conn: c, scale: scale, fontSize: size)
        ws.defaultFontSize = defaultSize
        workspace = ws
        ws.root.frame = NSRect(origin: .zero, size: rect.size)
        ws.root.autoresizingMask = [.width, .height]
        w.contentView = ws.root
        ws.root.onLayout = { [weak w] in w?.placeButtons() }
        buildMenu(ws)
        c.onClose = { [weak self] in
            DispatchQueue.main.async {
                guard let self, !self.closing else { return }
                self.window?.title = "Ravenry (the daemon went away)"
            }
        }
        c.onEvent = { [weak ws] ev in DispatchQueue.main.async { ws?.event(ev) } }
        c.request("events.subscribe", ["display": true])
        if options.offscreen {
            w.setFrameOrigin(NSPoint(x: -30000, y: -30000))
            w.orderFront(nil)
        } else {
            w.center()
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        w.placeButtons()
        do {
            try ws.restore()
        } catch {
            fail("\(error)")
            return
        }
        guard let v = ws.focusedView else {
            fail("no pane to show")
            return
        }
        if let out = options.bench {
            Bench(view: v, window: w, out: out, dragMin: options.dragMin, workspace: ws).start()
        } else if let out = options.selftest {
            let st = SelfTest(view: v, window: w, out: out, workspace: ws)
            st.restoreFrom = options.restoreCheck
            st.start()
        }
    }

    private func fail(_ msg: String) {
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

    /// The window goes; its panes keep running in the daemon (TERM-001),
    /// and come back as tabs at the next launch.
    private func shutdown() {
        guard !closing else { return }
        closing = true
        workspace?.save()
        workspace?.flush()
        conn?.close()
    }

    func windowWillClose(_ note: Notification) {
        shutdown()
        NSApp.terminate(nil)
    }

    func applicationWillTerminate(_ note: Notification) { shutdown() }

    func windowDidBecomeKey(_ note: Notification) { view?.setFocus(true) }
    func windowDidResignKey(_ note: Notification) { if !options.offscreen { view?.setFocus(false) } }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    private func buildMenu(_ ws: Workspace) {
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
        let appMenu = menu("Ravenry")
        add(appMenu, "Quit Ravenry", #selector(NSApplication.terminate(_:)), "q")

        // The Electron app's Shell menu (apps/desktop/src/main/main.ts).
        let shell = menu("Shell")
        add(shell, "New Shell", #selector(Workspace.menuNewTab(_:)), "t", target: ws)
        shell.addItem(.separator())
        add(shell, "Split Right", #selector(Workspace.menuSplitRight(_:)), "d", target: ws)
        add(shell, "Split Down", #selector(Workspace.menuSplitDown(_:)), "D", [.command, .shift], target: ws)
        let arrows: [(String, String, Int)] = [("Select Pane Left", String(UnicodeScalar(NSLeftArrowFunctionKey)!), 0),
                                               ("Select Pane Right", String(UnicodeScalar(NSRightArrowFunctionKey)!), 1),
                                               ("Select Pane Above", String(UnicodeScalar(NSUpArrowFunctionKey)!), 2),
                                               ("Select Pane Below", String(UnicodeScalar(NSDownArrowFunctionKey)!), 3)]
        for (t, k, tag) in arrows { add(shell, t, #selector(Workspace.menuFocusPane(_:)), k, [.command, .option], target: ws, tag: tag) }
        add(shell, "Zoom Pane", #selector(Workspace.menuZoom(_:)), "\r", [.command, .shift], target: ws)
        add(shell, "Equalize Splits", #selector(Workspace.menuEqualize(_:)), "=", [.command, .control], target: ws)
        shell.addItem(.separator())
        add(shell, "Close", #selector(Workspace.menuClose(_:)), "w", target: ws)
        add(shell, "Close Window", #selector(NSWindow.performClose(_:)), "w", [.command, .shift])

        let editMenu = menu("Edit")
        editMenu.addItem(withTitle: "Copy", action: #selector(TerminalView.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(TerminalView.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSResponder.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(withTitle: "Clear", action: #selector(TerminalView.clearScreen(_:)), keyEquivalent: "k")
        editMenu.addItem(.separator())
        let findItem = editMenu.addItem(withTitle: "Find", action: nil, keyEquivalent: "")
        let findMenu = NSMenu(title: "Find")
        findMenu.addItem(withTitle: "Find…", action: #selector(TerminalView.showFindBar(_:)), keyEquivalent: "f")
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
        add(viewMenu, "Next Tab", #selector(Workspace.menuNextTab(_:)), "\t", .control, target: ws)
        add(viewMenu, "Previous Tab", #selector(Workspace.menuPreviousTab(_:)), "\t", [.control, .shift], target: ws)
        // (Shift+Tab types a back tab, U+0019.)
        add(viewMenu, "Previous Tab", #selector(Workspace.menuPreviousTab(_:)), "\u{19}", [.control, .shift], target: ws, hidden: true)
        add(viewMenu, "Next Tab", #selector(Workspace.menuNextTab(_:)), "}", .command, target: ws, hidden: true)
        add(viewMenu, "Previous Tab", #selector(Workspace.menuPreviousTab(_:)), "{", .command, target: ws, hidden: true)
        add(viewMenu, "Next Tab", #selector(Workspace.menuNextTab(_:)), "]", [.command, .shift], target: ws, hidden: true)
        add(viewMenu, "Previous Tab", #selector(Workspace.menuPreviousTab(_:)), "[", [.command, .shift], target: ws, hidden: true)
        for i in 0..<9 { add(viewMenu, "Tab \(i + 1)", #selector(Workspace.menuSelectTab(_:)), "\(i + 1)", target: ws, tag: i, hidden: true) }
        NSApp.mainMenu = main
    }
}

extension Workspace {
    @objc func menuNewTab(_ sender: Any?) { newTab(sender) }
    @objc func menuSplitRight(_ sender: Any?) { split("right") }
    @objc func menuSplitDown(_ sender: Any?) { split("down") }
    @objc func menuFocusPane(_ sender: NSMenuItem) { focusToward(["left", "right", "up", "down"][sender.tag]) }
    @objc func menuZoom(_ sender: Any?) { toggleZoom() }
    @objc func menuEqualize(_ sender: Any?) { equalize() }
    @objc func menuClose(_ sender: Any?) { closeFocused() }
    @objc func menuNextTab(_ sender: Any?) { step(1) }
    @objc func menuPreviousTab(_ sender: Any?) { step(-1) }
    @objc func menuSelectTab(_ sender: NSMenuItem) { select(index: sender.tag) }
}

// A window started from inside a Ravenry pane must not pass the pane's
// variables on: the daemon would take the window for that pane's program.
for name in ["RAVENRY_PANE", "RAVENRY_SOCKET", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"] {
    unsetenv(name)
}

let options = Options.parse(CommandLine.arguments)
let app = NSApplication.shared
// The bench runs without a Dock icon and never takes focus.
app.setActivationPolicy(options.offscreen ? .accessory : .regular)
let delegate = AppDelegate(options: options)
app.delegate = delegate
app.run()
