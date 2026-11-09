// Ravenry for macOS, native: one window, one terminal, drawn by the app
// itself from the daemon's render stream (docs/RENDERING.md). The daemon
// owns the pane, its terminal state and the encoding of keys; the window
// draws the rows it is sent and sends what the person does.
//
//   RavenryMac [--socket PATH] [--attach PANE] [--option-as-alt left|right|both]
//              [--font NAME] [--font-size POINTS]
//              [--offscreen --bench OUT.json [--bench-layer] [--drag-min WIDTH]]
//              [-- COMMAND ARGS...]
//
// With no --attach, it starts a new pane (the login shell, or COMMAND) in
// the newest running daemon that has the render stream, never starting
// one, and closes the pane when the window closes.

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
/// otherwise moves a titled window back onto one.
final class TerminalWindow: NSWindow {
    var allowOffscreen = false
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
    var view: TerminalView?
    var conn: Connection?
    var ownPane = false
    var closing = false

    init(options: Options) { self.options = options }

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
        buildMenu()
        let rect = NSRect(x: 0, y: 0, width: 900, height: 560)
        let w = TerminalWindow(contentRect: rect, styleMask: [.titled, .closable, .resizable, .miniaturizable],
                               backing: .buffered, defer: false)
        w.title = "Ravenry"
        w.isReleasedWhenClosed = false
        w.isRestorable = false
        w.delegate = self
        w.allowOffscreen = options.offscreen
        w.backgroundColor = NSColor(red: 0x0B / 255.0, green: 0x0B / 255.0, blue: 0x0C / 255.0, alpha: 1)
        let scale = options.offscreen ? 2 : (NSScreen.main?.backingScaleFactor ?? 2)
        // The size the person picked last, kept in the app's defaults; the
        // bench and the self-test (offscreen) never read or write them.
        let defaultSize = min(72, max(6, options.fontSize ?? 12))
        var size = defaultSize
        if !options.offscreen && options.fontSize == nil,
           let kept = UserDefaults.standard.object(forKey: TerminalView.fontSizeKey) as? Double {
            size = min(72, max(6, CGFloat(kept)))
        }
        guard let v = TerminalView(frame: rect, scale: scale, fontName: options.font, fontSize: size) else {
            fail("Metal is not available")
            return
        }
        v.defaultFontSize = defaultSize
        v.keepsFontSize = !options.offscreen
        v.autoresizingMask = [.width, .height]
        v.offscreen = options.offscreen && !options.benchLayer
        v.optionAsAlt = options.optionAsAlt
        v.onTitle = { [weak w] t in w?.title = t.isEmpty ? "Ravenry" : t }
        w.contentView = v
        window = w
        view = v
        if options.offscreen {
            w.setFrameOrigin(NSPoint(x: -30000, y: -30000))
            w.orderFront(nil)
        } else {
            w.center()
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        w.makeFirstResponder(v)
        do {
            let c = try connect()
            conn = c
            c.onClose = { [weak self] in
                DispatchQueue.main.async {
                    guard let self, !self.closing else { return }
                    self.window?.title = "Ravenry (the daemon went away)"
                }
            }
            c.onEvent = { [weak self] ev in
                guard ev["event"] as? String == "stream.end" else { return }
                DispatchQueue.main.async { self?.paneEnded() }
            }
            var pane = options.attach ?? ""
            if pane.isEmpty {
                let g = v.renderer.grid(for: v.bounds.size)
                var params: [String: Any] = ["cols": g.cols, "rows": g.rows, "labels": ["ravenry.client": "macos"]]
                if !options.command.isEmpty { params["command"] = options.command }
                if options.bench != nil, let home = ProcessInfo.processInfo.environment["HOME"] { params["cwd"] = home }
                let r = try c.call("pane.new", params)
                pane = ((r["pane"] as? [String: Any])?["id"] as? String) ?? ""
                ownPane = true
            }
            let fps = options.offscreen ? 120 : (NSScreen.main?.maximumFramesPerSecond ?? 60)
            v.refreshInterval = 1.0 / Double(max(fps, 30))
            try v.attach(c, pane: pane, fps: fps)
        } catch {
            fail("\(error)")
            return
        }
        if let out = options.bench {
            Bench(view: v, window: w, out: out, dragMin: options.dragMin).start()
        }
    }

    private func fail(_ msg: String) {
        NSLog("RavenryMac: \(msg)")
        if options.offscreen {
            if let out = options.bench {
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

    private func paneEnded() {
        if ownPane && !closing { window?.close() }
    }

    /// Closes the pane this window started.
    func closePane() {
        guard !closing else { return }
        closing = true
        if ownPane, let c = conn, let v = view, !v.pane.isEmpty {
            _ = try? c.call("pane.close", ["pane": v.pane, "grace_ms": 500], timeout: 3)
        }
        conn?.close()
    }

    func windowWillClose(_ note: Notification) {
        closePane()
        NSApp.terminate(nil)
    }

    func applicationWillTerminate(_ note: Notification) { closePane() }

    func windowDidBecomeKey(_ note: Notification) { view?.setFocus(true) }
    func windowDidResignKey(_ note: Notification) { if !options.offscreen { view?.setFocus(false) } }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    private func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Ravenry", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let fileItem = NSMenuItem()
        main.addItem(fileItem)
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = fileMenu
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Copy", action: #selector(TerminalView.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(TerminalView.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSResponder.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Increase Font Size", action: #selector(TerminalView.increaseFontSize(_:)), keyEquivalent: "=")
        let plus = viewMenu.addItem(withTitle: "Increase Font Size", action: #selector(TerminalView.increaseFontSize(_:)), keyEquivalent: "+")
        plus.isHidden = true
        plus.allowsKeyEquivalentWhenHidden = true
        viewMenu.addItem(withTitle: "Decrease Font Size", action: #selector(TerminalView.decreaseFontSize(_:)), keyEquivalent: "-")
        viewMenu.addItem(withTitle: "Reset Font Size", action: #selector(TerminalView.resetFontSize(_:)), keyEquivalent: "0")
        viewItem.submenu = viewMenu
        NSApp.mainMenu = main
    }
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
