// Ravenry for macOS, the native spike: one window, one Ghostty terminal,
// attached to a pane of ravenryd. The window holds no state that matters:
// the pane lives in the daemon, and `ravenryd attach` (bundled beside this
// executable) carries its bytes, keys and size (apps/macos/README.md).
//
//   RavenryMac [--socket PATH] [--attach PANE] [--offscreen] [--selftest OUT.json] [-- COMMAND ARGS...]
//
// With no --attach, it starts a new pane (the login shell, or COMMAND)
// and closes it when the window closes.

import AppKit
import GhosttyKit

struct Options {
    var socket: String?
    var attach: String?
    var offscreen = false
    var selftest: String?
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
            case "--selftest": i += 1; o.selftest = args[safe: i]
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

func shellQuote(_ s: String) -> String {
    "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

/// A window that may sit off every screen (the self-test's), since AppKit
/// otherwise moves a titled window back onto one.
final class TerminalWindow: NSWindow {
    var allowOffscreen = false
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        allowOffscreen ? frameRect : super.constrainFrameRect(frameRect, to: screen)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let options: Options
    var window: TerminalWindow?
    var view: TerminalView?

    init(options: Options) { self.options = options }

    func attachCommand() -> String {
        let exe = Bundle.main.executableURL!.deletingLastPathComponent().appendingPathComponent("ravenryd").path
        // --no-start: the window never starts a daemon of its own version.
        var args = [exe, "attach", "--no-start"]
        if let s = options.socket { args += ["--socket", s] }
        if let p = options.attach {
            args.append(p)
        } else {
            args += ["--new", "--label", "ravenry.client=macos"]
            if options.selftest == nil { args.append("--close") }
            if !options.command.isEmpty { args += ["--"] + options.command }
        }
        return args.map(shellQuote).joined(separator: " ")
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        let conf = Bundle.main.path(forResource: "ghostty", ofType: "conf")
        guard let rt = GhosttyRuntime.start(configPath: conf) else {
            NSLog("RavenryMac: Ghostty failed to start")
            NSApp.terminate(nil)
            return
        }
        let rect = NSRect(x: 0, y: 0, width: 900, height: 560)
        let w = TerminalWindow(contentRect: rect, styleMask: [.titled, .closable, .resizable, .miniaturizable],
                               backing: .buffered, defer: false)
        w.title = "Ravenry"
        w.isReleasedWhenClosed = false
        w.isRestorable = false
        w.delegate = self
        w.allowOffscreen = options.offscreen
        let v = TerminalView(app: rt.app, command: attachCommand(), frame: rect)
        v.autoresizingMask = [.width, .height]
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
        v.setFocus(true)
        if let out = options.selftest {
            SelfTest(view: v, window: w, out: out).start()
        }
    }

    func windowWillClose(_ note: Notification) {
        // Freeing the surface hangs up its pty: the attach command ends
        // (closing the pane it started), and the app quits.
        view?.free()
        NSApp.terminate(nil)
    }

    func applicationDidBecomeActive(_ note: Notification) {
        if let rt = GhosttyRuntime.shared { ghostty_app_set_focus(rt.app, true) }
    }

    func applicationDidResignActive(_ note: Notification) {
        if let rt = GhosttyRuntime.shared { ghostty_app_set_focus(rt.app, false) }
    }

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
        NSApp.mainMenu = main
    }
}

// A window started from inside a Ravenry pane must not pass the pane's
// variables on: the daemon would take the window for that pane's program
// (and the attach command would follow RAVENRY_SOCKET).
for name in ["RAVENRY_PANE", "RAVENRY_SOCKET", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"] {
    unsetenv(name)
}

// Ghostty's global state; only the program name, so none of our flags is
// read as a Ghostty action.
var ghosttyArgv: [UnsafeMutablePointer<CChar>?] = [strdup(CommandLine.arguments[0]), nil]
if ghostty_init(1, &ghosttyArgv) != GHOSTTY_SUCCESS {
    FileHandle.standardError.write("RavenryMac: ghostty_init failed\n".data(using: .utf8)!)
    exit(1)
}

let options = Options.parse(CommandLine.arguments)
let app = NSApplication.shared
// The self-test runs without a Dock icon and never takes focus.
app.setActivationPolicy(options.offscreen ? .accessory : .regular)
let delegate = AppDelegate(options: options)
app.delegate = delegate
app.run()
