// The packaged app started with a pane's variables (an agent in a pane ran
// `open -a Ravenry`, and macOS's open hands the caller's environment to the
// app): the daemon then takes the window for a program inside that pane,
// never the person (PROTOCOL.md section 4, Who acts as the person; it reads
// the process's initial environment, which unsetenv does not change), so
// the person's typing goes to that agent, no card can be answered and the
// hub refuses what the person clicks. Such a start relaunches the app
// through LaunchServices with a clean environment and no arguments, as the
// Dock would start it, and exits before it opens a window or reaches a
// daemon or the hub.
//
// The Electron app's apps/desktop/src/main/relaunch.ts, ported as it is:
// the same variables kept, the same PATH, the same test flag, the same
// marker (its name, its fields, its minute) and the same app.log lines, so
// either app reads the other's marker. scripts/relaunchcheck.mjs checks it
// on a packaged build.

import Foundation

enum Relaunch {
    /// What marks a process as one of a pane's (PROTOCOL.md section 3, a pane's environment).
    static let paneVarNames = ["RAVENRY_PANE", "RAVENRY_SOCKET"]

    /// The variables the relaunched app keeps: the account's own, the ones
    /// a pane takes from its daemon (daemon/internal/pane accountVar) that a
    /// Mac app uses. Everything else goes, so nothing the caller set reaches
    /// the new app: no RAVENRY_*, no ELECTRON_*, NODE_OPTIONS, TERM_PROGRAM,
    /// CLAUDE*, SSH_CONNECTION.
    static let keepNames: Set<String> = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LANGUAGE", "TZ", "SSH_AUTH_SOCK", "__CF_USER_TEXT_ENCODING"]
    static func keep(_ k: String) -> Bool { keepNames.contains(k) || k.hasPrefix("LC_") }

    /// PATH as launchd gives an app started from the Dock or the Finder; a pane's PATH holds the agent's own tool folders.
    static let systemPath = "/usr/bin:/bin:/usr/sbin:/sbin"

    /// RAVENRY_RELAUNCH_TEST=1, for scripts/relaunchcheck.mjs only: the
    /// self-heal runs in a test run too, and the new app keeps these, so it
    /// stays in the test's folders and off the person's hub, offscreen and
    /// without a service, and it opens in the background (`foreground`
    /// instead of 1: without -g). Honoured only when the data, runtime and
    /// state folders are all set, so it never runs on the person's own. It
    /// adds nothing an agent could not do with `env -i
    /// RAVENRY_DESKTOP_DATA=... open -a Ravenry`, and never keeps a variable
    /// that drives the app.
    static let testFlag = "RAVENRY_RELAUNCH_TEST"
    static let testKeep = ["RAVENRY_DESKTOP_DATA", "RAVENRY_RUNTIME_DIR", "RAVENRY_STATE_DIR", "RAVENRY_HUB_URL", "RAVENRY_SERVICE", "RAVENRY_SERVICE_LABEL", "RAVENRY_UPDATES", "RAVENRY_OFFSCREEN"]

    /// The marker the relaunching app leaves in its data folder, for the new one: the loop guard and its log line.
    static let markerName = "relaunched-from-pane.json"
    /// A marker older than this (milliseconds) is a leftover, not this launch's.
    static let markerMs: Double = 60000

    typealias Env = [String: String]

    /// The pane variables this environment carries (names).
    static func paneVars(_ env: Env) -> [String] {
        paneVarNames.filter { !(env[$0] ?? "").isEmpty }
    }

    static func testRelaunch(_ env: Env) -> Bool {
        let f = env[testFlag] ?? ""
        return (f == "1" || f == "foreground") && !(env["RAVENRY_DESKTOP_DATA"] ?? "").isEmpty
            && !(env["RAVENRY_RUNTIME_DIR"] ?? "").isEmpty && !(env["RAVENRY_STATE_DIR"] ?? "").isEmpty
    }

    /// The relaunched app's environment, and the names of the variables it drops (sorted).
    static func cleanEnv(_ env: Env) -> (env: Env, dropped: [String]) {
        let test = testRelaunch(env)
        var out: Env = [:]
        var dropped: [String] = []
        for (k, v) in env {
            if keep(k) || (test && testKeep.contains(k)) { out[k] = v } else if k != "PATH" { dropped.append(k) }
        }
        out["PATH"] = systemPath
        return (out, dropped.sorted())
    }

    /// The .app bundle an executable runs from (.../Ravenry.app/Contents/MacOS/Ravenry), or nil.
    static func bundleOf(_ execPath: String) -> String? {
        let macos = (execPath as NSString).deletingLastPathComponent
        let contents = (macos as NSString).deletingLastPathComponent
        let bundle = (contents as NSString).deletingLastPathComponent
        guard (macos as NSString).lastPathComponent == "MacOS", (contents as NSString).lastPathComponent == "Contents", bundle.hasSuffix(".app") else { return nil }
        return bundle
    }

    /// What the relaunching app left for the new one, when it is this launch's.
    struct Marker { let pid: Int; let at: Double; let dropped: [String] }

    static func nowMs() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }

    static func readMarker(_ file: URL, now: Double = nowMs()) -> Marker? {
        guard let d = try? Data(contentsOf: file), let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let at = (j["at"] as? NSNumber)?.doubleValue, now - at <= markerMs, now >= at - 5000 else { return nil }
        let pid = (j["pid"] as? NSNumber)?.intValue ?? Int("\(j["pid"] ?? "")") ?? 0
        let dropped = (j["dropped"] as? [Any])?.map { "\($0)" } ?? []
        return Marker(pid: pid, at: at, dropped: dropped)
    }

    enum Plan {
        case relaunch(bundle: String, env: Env, dropped: [String], background: Bool)
        /// clean, not-packaged, offscreen, test-run, no-bundle or loop.
        case stay(String)
    }

    /// Whether this start relaunches clean. `marker` is the relaunching
    /// app's marker when this start is its relaunch: one that still carries
    /// a pane's variables (they came back from somewhere else, launchctl
    /// setenv) stays. `offscreen` is --offscreen or RAVENRY_OFFSCREEN=1
    /// (the bench and the self-tests).
    static func plan(env: Env, packaged: Bool, offscreen: Bool, execPath: String, marker: Marker?) -> Plan {
        if paneVars(env).isEmpty { return .stay("clean") }
        if !packaged { return .stay("not-packaged") }
        if !testRelaunch(env) {
            if offscreen { return .stay("offscreen") }
            // A test's data folder or hub label: a test run, which decides what its app is.
            if !(env["RAVENRY_DESKTOP_DATA"] ?? "").isEmpty || !(env["RAVENRY_SERVICE_LABEL"] ?? "").isEmpty { return .stay("test-run") }
        }
        if marker != nil { return .stay("loop") }
        guard let bundle = bundleOf(execPath) else { return .stay("no-bundle") }
        let clean = cleanEnv(env)
        // A test's relaunch stays in the background: it never takes the focus from the person.
        return .relaunch(bundle: bundle, env: clean.env, dropped: clean.dropped, background: testRelaunch(env) && env[testFlag] != "foreground")
    }

    /// The helper that starts the new app: /bin/sh with these arguments,
    /// detached, with the clean environment. It waits (up to 10 s) until
    /// this process is gone, so the two never run at once, then asks
    /// LaunchServices for a new instance of the bundle, with no arguments.
    /// A failed open is said in app.log. `background` (a test's) adds -g.
    static func helperArgs(pid: Int32, bundle: String, log: String, background: Bool) -> [String] {
        let script = [
            "i=0",
            "while [ \"$i\" -lt 200 ]; do",
            "  s=$(/bin/ps -o stat= -p \"$1\" 2>/dev/null) || break",
            "  case \"$s\" in Z*) break ;; esac",
            "  /bin/sleep 0.05; i=$((i + 1))",
            "done",
            "/usr/bin/open -n\(background ? " -g" : "") -a \"$2\" || echo \"$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ) launch: relaunching clean failed: open -a $2 said no\" >> \"$3\"",
        ].joined(separator: "\n")
        return ["-c", script, "ravenry-relaunch", String(pid), bundle, log]
    }

    /// The app's data folder, where the marker goes: RAVENRY_DESKTOP_DATA,
    /// else the Electron app's (~/Library/Application Support/Ravenry).
    static func dataFolder(_ env: Env) -> URL {
        if let d = env["RAVENRY_DESKTOP_DATA"], !d.isEmpty { return URL(fileURLWithPath: d) }
        let lib = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return lib.appendingPathComponent("Ravenry")
    }

    /// At launch, with the environment as it came: relaunches clean and
    /// exits when this start carries a pane's variables; else returns, after
    /// saying in app.log what a relaunch left or why one stays.
    static func atLaunch(env: Env, offscreen: Bool) {
        let inst = AppInstall.shared
        let packaged = inst.packaged
        // The relaunching app's marker, read once: the loop guard and the log line.
        let file = dataFolder(env).appendingPathComponent(markerName)
        let marker = packaged ? readMarker(file) : nil
        if packaged { try? FileManager.default.removeItem(at: file) }
        let p = plan(env: env, packaged: packaged, offscreen: offscreen, execPath: Bundle.main.executablePath ?? CommandLine.arguments[0], marker: marker)
        let vars = paneVars(env).joined(separator: ", ")
        guard case let .relaunch(bundle, cleanEnv, dropped, background) = p else {
            if case .stay(let why) = p {
                if let marker, why == "clean" {
                    inst.log("launch: relaunched clean (pid \(marker.pid) was started with a pane's variables); dropped: \(marker.dropped.isEmpty ? "nothing" : marker.dropped.joined(separator: ", "))")
                } else if why == "loop" {
                    inst.log("launch: still started with \(vars) after relaunching clean; staying, and the window says its answers are off")
                }
            }
            return
        }
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            let m: [String: Any] = ["pid": Int(getpid()), "at": nowMs(), "dropped": dropped]
            try JSONSerialization.data(withJSONObject: m).write(to: file)
            let logDir = URL(fileURLWithPath: cleanEnv["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? NSHomeDirectory()).appendingPathComponent("Library/Logs/Ravenry")
            try FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
            try spawnDetached("/bin/sh", helperArgs(pid: getpid(), bundle: bundle, log: logDir.appendingPathComponent("app.log").path, background: background), env: cleanEnv)
        } catch {
            inst.log("launch: started with \(vars) and could not relaunch clean: \(error)")
            try? FileManager.default.removeItem(at: file)
            return
        }
        inst.log("quit: started with \(vars): relaunching clean through LaunchServices, and this process quits (exit 0)")
        exit(0)
    }

    struct SpawnError: Error, CustomStringConvertible { let description: String }

    /// Starts a program in a session of its own (setsid), in /, with this
    /// environment only and no input or output, and leaves it running.
    static func spawnDetached(_ path: String, _ args: [String], env: Env) throws {
        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID))
        var fa: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&fa)
        defer { posix_spawn_file_actions_destroy(&fa) }
        for fd: Int32 in [0, 1, 2] { posix_spawn_file_actions_addopen(&fa, fd, "/dev/null", fd == 0 ? O_RDONLY : O_WRONLY, 0) }
        posix_spawn_file_actions_addchdir_np(&fa, "/")
        let cargs: [UnsafeMutablePointer<CChar>?] = ([path] + args).map { strdup($0) } + [nil]
        let cenv: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { for p in cargs + cenv { free(p) } }
        var pid: pid_t = 0
        let rc = posix_spawn(&pid, path, &fa, &attr, cargs, cenv)
        if rc != 0 { throw SpawnError(description: "\(path): \(String(cString: strerror(rc)))") }
    }
}
