// What the app does on this machine besides its window, as the Electron
// app's main process did on the Mac (README, "The app on its own"):
//
// - its ravenryd and hub copied to <data>/versions/<version>, bin/ravenryd
//   and bin/ravenry linked to the newest, the hub service dev.ravenry.hub
//   installed or brought to this build, and the version folders nothing
//   runs from removed a minute later: install/setup.ts, the Electron app's
//   own code (install.ts, npmswitch.ts) run on the Node the app carries;
// - the daemon: the newest running one with the render stream, else its
//   own started (`ravenryd serve --detach`), and its own started beside an
//   older one after an update (the Electron app's DaemonLink.ensure).
//
// Only a packaged app (scripts/package.mjs: build.json and setup.mjs in
// its resources, Node beside its executable) does the first part; a
// development build (scripts/build.sh) finds a daemon and starts none.
//
// What the app takes from its launch: as the Electron release (gate.ts),
// the variables that name a program to run in place of the app's own or
// feed the hub's stand-ins are dropped, unless RAVENRY_SERVICE_LABEL is a
// test's launchd label (install.ts TEST_LABEL): the install check's hub
// runs on its stand-ins, never the person's processes.

import Foundation

final class AppInstall {
    static let shared = AppInstall()

    let resources: URL
    let node: URL
    let setup: URL
    let executable: String
    /// build.json's version, when the app is packaged.
    let version: String?
    /// The environment for the setup, the hub and a daemon this starts.
    let env: [String: String]
    /// install, dry-run or off (RAVENRY_SERVICE); install by default.
    let mode: String
    /// This version's ravenryd, once staged.
    private(set) var staged: (ravenryd: String, version: String)?

    static let testLabel = try! NSRegularExpression(pattern: "^dev\\.ravenry\\.hub\\.test-[a-z0-9]{4,32}$")
    static let controlVars: Set<String> = ["RAVENRY_DRIVER", "RAVENRY_DRIVE", "RAVENRY_DRIVE_LOG", "RAVENRYD", "RAVENRY_LAUNCHCTL", "RAVENRY_NEW_SHELL",
                                           "RAVENRY_TEST_CLIPBOARD", "RAVENRY_SETTINGS_IMPORT", "RAVENRY_TEST_FOLDER", "CMUX_BIN", "TEST_RAVENRY", "NODE_OPTIONS", "NODE_PATH"]

    private init() {
        let b = Bundle.main
        resources = b.resourceURL ?? URL(fileURLWithPath: ".")
        executable = b.executablePath ?? CommandLine.arguments[0]
        node = URL(fileURLWithPath: executable).deletingLastPathComponent().appendingPathComponent("node")
        setup = resources.appendingPathComponent("setup.mjs")
        var v: String?
        if let d = try? Data(contentsOf: resources.appendingPathComponent("build.json")),
           let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] { v = j["version"] as? String }
        version = v
        var e = ProcessInfo.processInfo.environment
        let label = e["RAVENRY_SERVICE_LABEL"] ?? ""
        let isTest = AppInstall.testLabel.firstMatch(in: label, range: NSRange(label.startIndex..., in: label)) != nil
        if !isTest {
            if !label.isEmpty { e["RAVENRY_SERVICE_LABEL"] = nil }
            for k in Array(e.keys) where AppInstall.controlVars.contains(k) || k.hasPrefix("MC_") || k.hasPrefix("FAKE_") || k.hasPrefix("STUB_") { e[k] = nil }
        }
        // Electron's own variables would change how programs in the panes run.
        for k in Array(e.keys) where k.hasPrefix("ELECTRON_") || k == "GOOGLE_API_KEY" || k.hasPrefix("CHROME_") { e[k] = nil }
        env = e
        mode = ["install", "dry-run", "off"].contains(e["RAVENRY_SERVICE"] ?? "") ? e["RAVENRY_SERVICE"]! : "install"
    }

    /// Packaged: it carries its hub, its Node and the setup.
    var packaged: Bool {
        version != nil && FileManager.default.isExecutableFile(atPath: node.path) && FileManager.default.fileExists(atPath: setup.path)
    }

    /// Whether this run sets the machine up: a packaged app on screen, or
    /// one a test asked to (RAVENRY_SERVICE set) off every screen.
    func active(offscreen: Bool) -> Bool {
        packaged && (!offscreen || ProcessInfo.processInfo.environment["RAVENRY_SERVICE"] != nil)
    }

    /// The home folder as HOME says (a test's throwaway one), else the account's.
    var home: String { env["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? NSHomeDirectory() }

    /// A line in the app's log (~/Library/Logs/Ravenry/app.log), as the Electron app wrote it.
    func log(_ line: String) {
        let dir = URL(fileURLWithPath: home).appendingPathComponent("Library/Logs/Ravenry")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let f = dir.appendingPathComponent("app.log")
        let text = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
        if let h = try? FileHandle(forWritingTo: f) {
            h.seekToEndOfFile()
            h.write(text.data(using: .utf8)!)
            try? h.close()
        } else {
            try? text.data(using: .utf8)!.write(to: f)
        }
    }

    /// Runs one setup command on the app's Node; its JSON answer.
    func runSetup(_ args: [String]) -> [String: Any] {
        let p = Process()
        p.executableURL = node
        p.arguments = ["--disable-sigusr1", setup.path] + args
        p.environment = env
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return ["ok": false, "error": "\(error)"] }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let last = String(decoding: data, as: UTF8.self).split(separator: "\n").last.map(String.init) ?? ""
        return (try? JSONSerialization.jsonObject(with: Data(last.utf8))) as? [String: Any] ?? ["ok": false, "error": "setup \(args.first ?? "") ended with \(p.terminationStatus)"]
    }

    /// This version's ravenryd and hub copied out of the app (fast when
    /// that build is there already). Before the daemon is looked for.
    func stage() {
        let r = runSetup(["stage", "--resources", resources.path])
        if r["ok"] as? Bool == true, let bin = r["ravenryd"] as? String, let v = r["version"] as? String {
            staged = (bin, v)
        } else {
            log("install: could not copy ravenryd and the hub out of the app: \(r["error"] ?? "")")
        }
    }

    /// The hub service, in the background; the prune a minute after it ran.
    func setUpHub(done: (([String: Any]) -> Void)? = nil) {
        guard mode != "off" else { return }
        DispatchQueue.global(qos: .utility).async { [self] in
            let r = runSetup(["hub", "--resources", resources.path, "--exe", executable])
            done?(r)
            guard r["ok"] as? Bool == true, r["service"] != nil, let v = staged?.version ?? version else { return }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + (env["RAVENRY_PRUNE_AFTER"].flatMap(Double.init) ?? 60)) { [self] in
                _ = runSetup(["prune", "--keep", v])
            }
        }
    }
}

// ------------------------------------------------------------ the daemon

/// A running daemon, as `ravenryd daemons --json` lists it (newest first).
struct LiveDaemon { let socket: String, version: String, draining: Bool }

func liveDaemons(_ bin: String, env: [String: String]) -> [LiveDaemon] {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: bin)
    p.arguments = ["daemons", "--json"]
    p.environment = env
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return [] }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] ?? []
    return rows.compactMap { r in
        guard let s = r["socket"] as? String else { return nil }
        let d = r["draining"] as? String ?? ""
        return LiveDaemon(socket: s, version: r["version"] as? String ?? "", draining: !d.isEmpty)
    }
}

/// Semver order, a prerelease before its release (@ravenry/client compareVersions).
func compareVersions(_ a: String, _ b: String) -> Int {
    func parse(_ v: String) -> ([Int], String) {
        let core = String(v.drop(while: { $0 == "v" }).split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        let parts = core.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        return (parts[0].split(separator: ".").map { Int($0) ?? 0 }, parts.count > 1 ? String(parts[1]) : "")
    }
    let (x, xp) = parse(a), (y, yp) = parse(b)
    for i in 0..<max(x.count, y.count) {
        let d = (i < x.count ? x[i] : 0) - (i < y.count ? y[i] : 0)
        if d != 0 { return d > 0 ? 1 : -1 }
    }
    if xp == yp { return 0 }
    if xp.isEmpty { return 1 }
    if yp.isEmpty { return -1 }
    return xp < yp ? -1 : 1
}

/// `ravenryd serve --detach`: the daemon in its own process session, so
/// it outlives the app, the hub and their restarts.
func startDaemon(_ bin: String, env: [String: String]) -> Bool {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: bin)
    p.arguments = ["serve", "--detach"]
    p.environment = env
    p.currentDirectoryURL = URL(fileURLWithPath: env["HOME"] ?? NSHomeDirectory())
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return false }
    p.waitUntilExit()
    return p.terminationStatus == 0
}
