// Updates, as the Electron app's apps/desktop/src/main/updater.ts offers
// them: a check a little after launch and every few hours, a new version
// downloaded in the background and installed when the app quits, or at
// once from the Ravenry menu (Check for Updates..., then Restart to Update
// to <version>).
//
// The feed: the same GitHub Releases the Electron updater reads (the
// repository the app was built from, Resources/app-update.json, written by
// scripts/package.mjs as electron-builder writes app-update.yml). The
// native build's file there is latest-mac-native.json (package.mjs writes
// it beside RavenryNative-<version>.zip): its version, the zip's name and
// its SHA-256. Releases are public once the repository is; until then the
// check fails quietly, and RAVENRY_UPDATE_TOKEN (a GitHub token with read
// access) lets a maintainer test from the private repository, as the
// Electron app's does. No token is ever built into the app.
//
// Nothing is replaced before it is checked: the zip's SHA-256 against the
// feed, then the app inside it with `codesign --verify --deep --strict`,
// and the Security framework's check of the same with a requirement: this
// app's own identifier, Apple's anchor and this app's own Team ID. The
// version inside must be the feed's and newer than this one. A build signed
// for no team (ad hoc) never updates itself: it has no team to compare.
//
// The swap: the new app waits in ~/Library/Caches/Ravenry/Updates. When the
// app quits, a detached /bin/sh waits for this process to end, moves this
// bundle aside, moves the new one to its place (the old one put back if
// that fails) and, for Restart Now, starts it again through LaunchServices
// with the clean environment the relaunch from a pane uses
// (Relaunch.cleanEnv: no RAVENRY_PANE, RAVENRY_SOCKET, TERM_PROGRAM...).
// Sessions live in ravenryd, outside the app: the new version starts its
// daemon beside the old one, which drains, and brings the hub service to
// its build, exactly as after an install by hand (Install.swift).
//
//   RAVENRY_UPDATES=0          never check
//   RAVENRY_UPDATE_FEED=URL    the feed file itself (scripts/updatecheck.mjs's
//                              local server); the zip's name is read against it
//   RAVENRY_UPDATE_TEST=restart|quit|check   scripts/updatecheck.mjs only,
//                              honoured only with a test's data, runtime and
//                              state folders: checks off every screen too,
//                              a second after launch, and once the update
//                              is ready restarts to it (restart) or quits
//                              (quit: installed on quit, not started again);
//                              launch: off every screen too, at the real
//                              times (15 s, then every 4 hours), nothing else
//                              (scripts/updatedialogcheck.mjs), the repeat
//                              every RAVENRY_UPDATE_EVERY seconds when set

import AppKit
import CryptoKit
import Security

final class Updater: NSObject, NSMenuItemValidation {
    static let shared = Updater()

    enum State: Equatable {
        case idle, checking
        case downloading(String)
        case ready(String)
        case error(String)
    }

    private(set) var state: State = .idle {
        didSet { if state != oldValue { DispatchQueue.main.async { self.stateChanged() } } }
    }

    /// The feed's answer.
    struct Feed { let version: String, file: String, sha256: String, size: Int?; let base: URL }

    let env = ProcessInfo.processInfo.environment
    /// This app's version (Info.plist), its bundle and identifier.
    let current: String
    let bundle: URL
    let bundleId: String
    /// The new app, checked and waiting for the quit.
    private(set) var staged: (version: String, app: URL)?
    private var timer: Timer?
    private var started = false
    private var running = false
    private var relaunch = false
    private var waiters: [(Result<Feed?, UpdateError>) -> Void] = []
    /// What a test asked for (RAVENRY_UPDATE_TEST), when honoured.
    let test: String?
    /// The menu's item (its title follows the state) and the npm board's way back.
    private weak var item: NSMenuItem?
    /// Dialogs shown, for the self-test (their sheets stay open there).
    private(set) var shown: [NSAlert] = []
    /// Off every screen, a dialog is not run but kept (the self-test's pictures).
    var offscreen = false

    struct UpdateError: Error, CustomStringConvertible { let description: String }

    override init() {
        let b = Bundle.main
        bundle = b.bundleURL
        bundleId = b.bundleIdentifier ?? "dev.ravenry.app"
        current = b.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? AppInstall.shared.version ?? "0"
        let e = ProcessInfo.processInfo.environment
        let folders = !(e["RAVENRY_DESKTOP_DATA"] ?? "").isEmpty && !(e["RAVENRY_RUNTIME_DIR"] ?? "").isEmpty && !(e["RAVENRY_STATE_DIR"] ?? "").isEmpty
        test = folders ? ["restart", "quit", "check", "launch"].first { $0 == e["RAVENRY_UPDATE_TEST"] } : nil
        super.init()
    }

    // MARK: where updates come from

    /// owner and repo from Resources/app-update.json, when the app was packaged with one.
    lazy var source: (owner: String, repo: String)? = {
        guard let d = try? Data(contentsOf: AppInstall.shared.resources.appendingPathComponent("app-update.json")),
              let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let o = j["owner"] as? String, let r = j["repo"] as? String, !o.isEmpty, !r.isEmpty else { return nil }
        return (o, r)
    }()

    static let feedName = "latest-mac-native.json"

    /// The feed file a test names (http on this Mac, or https).
    private var feedOverride: URL? {
        guard let s = env["RAVENRY_UPDATE_FEED"], let u = URL(string: s), let sc = u.scheme?.lowercased() else { return nil }
        if sc == "https" { return u }
        if sc == "http", ["127.0.0.1", "localhost"].contains(u.host ?? "") { return u }
        return nil
    }

    var releasesURL: URL? { source.map { URL(string: "https://github.com/\($0.owner)/\($0.repo)/releases")! } }

    /// This app's Team ID, from its own signature; nil when signed ad hoc or not at all.
    lazy var team: String? = {
        var me: SecCode?
        guard SecCodeCopySelf([], &me) == errSecSuccess, let me else { return nil }
        var st: SecStaticCode?
        guard SecCodeCopyStaticCode(me, [], &st) == errSecSuccess, let st else { return nil }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(st, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let d = info as? [String: Any] else { return nil }
        return d[kSecCodeInfoTeamIdentifier as String] as? String
    }()

    /// Why this copy does not update itself; nil when it does.
    func whyNot() -> String? {
        if !AppInstall.shared.packaged { return t("update.devBuild") }
        if source == nil && feedOverride == nil { return t("update.noSource") }
        if team == nil { return t("update.unsigned") }
        return nil
    }

    // MARK: the checks

    /// A check a little after launch, then every few hours. Nothing where
    /// updates are off, in a development build, or off every screen (but a test's).
    func start(offscreen: Bool) {
        self.offscreen = offscreen
        guard !started, env["RAVENRY_UPDATES"] != "0", whyNot() == nil, !offscreen || test != nil else { return }
        started = true
        let first: TimeInterval = test != nil && test != "launch" ? 1 : 15
        timer = Timer.scheduledTimer(withTimeInterval: first, repeats: false) { [weak self] _ in
            self?.check { _ in }
            // Every 4 hours; a test's RAVENRY_UPDATE_EVERY (seconds) in its place, honoured with a test only.
            let every = (self?.test != nil ? self?.env["RAVENRY_UPDATE_EVERY"].flatMap(Double.init) : nil) ?? 4 * 3600
            self?.timer = Timer.scheduledTimer(withTimeInterval: every, repeats: true) { [weak self] _ in self?.check { _ in } }
        }
        AppInstall.shared.log("update: checking \(feedOverride?.absoluteString ?? source.map { "\($0.owner)/\($0.repo)" } ?? "") a little after launch, then every 4 hours (this is \(current))")
    }

    /// Looks at the feed; downloads and checks a newer version. `done` gets
    /// the feed when a newer version is there (downloading, or ready), nil
    /// when this one is the newest, or why the check failed.
    func check(_ done: @escaping (Result<Feed?, UpdateError>) -> Void) {
        if case .ready = state { return done(.success(nil)) }
        waiters.append(done)
        guard !running else { return }
        running = true
        state = .checking
        readFeed { [weak self] r in
            guard let self else { return }
            switch r {
            case .failure(let e):
                self.finish(.failure(e))
            case .success(let f):
                guard compareVersions(f.version, self.current) > 0 else {
                    self.state = .idle
                    return self.finish(.success(nil))
                }
                self.state = .downloading(f.version)
                self.finishWaiters(.success(f))
                self.download(f)
            }
        }
    }

    private func finishWaiters(_ r: Result<Feed?, UpdateError>) {
        let w = waiters
        waiters = []
        for d in w { DispatchQueue.main.async { d(r) } }
    }

    private func finish(_ r: Result<Feed?, UpdateError>) {
        if case .failure(let e) = r {
            state = .error(e.description)
            AppInstall.shared.log("update: \(e.description)")
        }
        running = false
        finishWaiters(r)
    }

    private func request(_ u: URL, binary: Bool = false) -> URLRequest {
        var q = URLRequest(url: u, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        q.setValue("Ravenry/\(current) (macOS)", forHTTPHeaderField: "User-Agent")
        if let tok = env["RAVENRY_UPDATE_TOKEN"], !tok.isEmpty, u.host == "api.github.com" {
            q.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization")
            q.setValue(binary ? "application/octet-stream" : "application/vnd.github+json", forHTTPHeaderField: "Accept")
        }
        return q
    }

    /// Where a file of the release is: the feed's folder (a test's, the
    /// public release's latest/download/), or with a token the API's asset.
    private var assets: [String: URL] = [:]

    private func readFeed(_ done: @escaping (Result<Feed, UpdateError>) -> Void) {
        let main = { (r: Result<Feed, UpdateError>) in DispatchQueue.main.async { done(r) } }
        if let u = feedOverride { return fetchFeed(u, main) }
        guard let s = source else { return main(.failure(UpdateError(description: t("update.noSource")))) }
        if let tok = env["RAVENRY_UPDATE_TOKEN"], !tok.isEmpty {
            // The private repository: the latest release's assets through the API.
            let api = URL(string: "https://api.github.com/repos/\(s.owner)/\(s.repo)/releases/latest")!
            URLSession.shared.dataTask(with: request(api)) { [weak self] d, resp, err in
                guard let self else { return }
                guard let d, (resp as? HTTPURLResponse)?.statusCode == 200, let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else {
                    return main(.failure(UpdateError(description: err?.localizedDescription ?? t("update.why.noRelease"))))
                }
                var a: [String: URL] = [:]
                for x in j["assets"] as? [[String: Any]] ?? [] {
                    if let n = x["name"] as? String, let us = x["url"] as? String, let u = URL(string: us) { a[n] = u }
                }
                DispatchQueue.main.async { self.assets = a }
                guard let feed = a[Updater.feedName] else { return main(.failure(UpdateError(description: t("update.why.noFeed")))) }
                self.fetchFeed(feed, main)
            }.resume()
            return
        }
        fetchFeed(URL(string: "https://github.com/\(s.owner)/\(s.repo)/releases/latest/download/\(Updater.feedName)")!, main)
    }

    private func fetchFeed(_ u: URL, _ done: @escaping (Result<Feed, UpdateError>) -> Void) {
        URLSession.shared.dataTask(with: request(u, binary: true)) { d, resp, err in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard let d, code == 200 else {
                return done(.failure(UpdateError(description: err?.localizedDescription ?? (code == 404 ? t("update.why.noFeed") : t("update.why.http", ["code": "\(code)"])))))
            }
            guard let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
                  let v = j["version"] as? String, let f = j["url"] as? String ?? j["file"] as? String,
                  let sha = (j["sha256"] as? String)?.lowercased(), sha.count == 64, !f.contains("/") || f.hasPrefix("https://") else {
                return done(.failure(UpdateError(description: t("update.why.badFeed"))))
            }
            done(.success(Feed(version: v, file: f, sha256: sha, size: j["size"] as? Int, base: u)))
        }.resume()
    }

    /// The update's own folder: ~/Library/Caches/Ravenry/Updates (a test's HOME's).
    var folder: URL { URL(fileURLWithPath: AppInstall.shared.home).appendingPathComponent("Library/Caches/Ravenry/Updates") }

    private func download(_ f: Feed) {
        let zipURL: URL
        if f.file.hasPrefix("https://") { zipURL = URL(string: f.file)! } else if feedOverride == nil, let a = assets[f.file] { zipURL = a } else { zipURL = f.base.deletingLastPathComponent().appendingPathComponent(f.file) }
        AppInstall.shared.log("update: \(f.version) is out (this is \(current)): downloading \(f.file)")
        URLSession.shared.downloadTask(with: request(zipURL, binary: true)) { [weak self] tmp, resp, err in
            guard let self else { return }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            guard let tmp, code == 200 else {
                let e = UpdateError(description: err?.localizedDescription ?? t("update.why.http", ["code": "\(code)"]))
                return DispatchQueue.main.async { self.finish(.failure(e)) }
            }
            let r = Result { try self.unpackAndCheck(tmp, f) }.mapError { ($0 as? UpdateError) ?? UpdateError(description: "\($0)") }
            DispatchQueue.main.async {
                switch r {
                case .success(let app):
                    self.staged = (f.version, app)
                    self.state = .ready(f.version)
                    AppInstall.shared.log("update: \(f.version) is ready at \(app.path): SHA-256, codesign --verify --deep --strict and Team ID \(self.team ?? "") checked; it installs when Ravenry quits")
                    self.running = false
                    self.whenReady()
                case .failure(let e): self.finish(.failure(e))
                }
            }
        }.resume()
    }

    /// The zip's SHA-256, the app inside it unpacked to its own folder, and
    /// that app's signature, identifier, team and version. The app's URL.
    private func unpackAndCheck(_ zip: URL, _ f: Feed) throws -> URL {
        let fm = FileManager.default
        let dir = folder.appendingPathComponent(f.version)
        try? fm.removeItem(at: folder)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let z = dir.appendingPathComponent(f.file.hasPrefix("https://") ? "update.zip" : f.file)
        try fm.moveItem(at: zip, to: z)
        let sum = try sha256(z)
        guard sum == f.sha256 else { throw UpdateError(description: t("update.why.checksum", ["got": String(sum.prefix(12)), "want": String(f.sha256.prefix(12))])) }
        let out = dir.appendingPathComponent("unpacked")
        try fm.createDirectory(at: out, withIntermediateDirectories: true)
        guard run("/usr/bin/ditto", ["-x", "-k", z.path, out.path]).status == 0 else { throw UpdateError(description: t("update.why.unzip")) }
        try? fm.removeItem(at: z)
        let apps = (try? fm.contentsOfDirectory(atPath: out.path).filter { $0.hasSuffix(".app") }) ?? []
        guard apps.count == 1 else { throw UpdateError(description: t("update.why.unzip")) }
        let app = out.appendingPathComponent(apps[0])
        _ = run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app.path])
        try verify(app, version: f.version)
        return app
    }

    /// The checks before a bundle may replace this one.
    func verify(_ app: URL, version: String) throws {
        let cs = run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
        guard cs.status == 0 else { throw UpdateError(description: t("update.why.signature", ["why": cs.out.split(separator: "\n").first.map(String.init) ?? "codesign said no"])) }
        guard let team else { throw UpdateError(description: t("update.unsigned")) }
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code else { throw UpdateError(description: t("update.why.signature", ["why": "unreadable"])) }
        var req: SecRequirement?
        let text = "identifier \"\(bundleId)\" and anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
        guard SecRequirementCreateWithString(text as CFString, [], &req) == errSecSuccess, let req else { throw UpdateError(description: "requirement") }
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode)
        var cfErr: Unmanaged<CFError>?
        guard SecStaticCodeCheckValidityWithErrors(code, flags, req, &cfErr) == errSecSuccess else {
            let theirs = signingTeam(code) ?? "none"
            // The same team but another app (its signature's identifier is not this app's): said as such,
            // not as "signed by team X, not X" (updatecheck.mjs, refused bundle-id).
            if theirs == team, signingIdentifier(code) != bundleId { throw UpdateError(description: t("update.why.notRavenry")) }
            throw UpdateError(description: t("update.why.team", ["theirs": theirs, "ours": team]))
        }
        let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")) as? [String: Any] ?? [:]
        guard info["CFBundleIdentifier"] as? String == bundleId else { throw UpdateError(description: t("update.why.notRavenry")) }
        let v = info["CFBundleShortVersionString"] as? String ?? ""
        guard v == version, compareVersions(v, current) > 0 else { throw UpdateError(description: t("update.why.version", ["got": v, "want": version])) }
    }

    private func signingIdentifier(_ code: SecStaticCode) -> String? {
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess, let d = info as? [String: Any] else { return nil }
        return d[kSecCodeInfoIdentifier as String] as? String
    }

    private func signingTeam(_ code: SecStaticCode) -> String? {
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess, let d = info as? [String: Any] else { return nil }
        return d[kSecCodeInfoTeamIdentifier as String] as? String
    }

    private func sha256(_ f: URL) throws -> String {
        let h = try FileHandle(forReadingFrom: f)
        defer { try? h.close() }
        var sha = SHA256()
        while let d = try h.read(upToCount: 1 << 20), !d.isEmpty { sha.update(data: d) }
        return sha.finalize().map { String(format: "%02x", $0) }.joined()
    }

    @discardableResult
    private func run(_ exe: String, _ args: [String]) -> (status: Int32, out: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { return (-1, "\(error)") }
        let d = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(decoding: d, as: UTF8.self))
    }

    // MARK: installing

    /// The app's folder takes the new one: its parent and the bundle itself writable.
    var canReplace: Bool {
        let fm = FileManager.default
        return fm.isWritableFile(atPath: bundle.deletingLastPathComponent().path) && fm.isWritableFile(atPath: bundle.path)
    }

    private func whenReady() {
        if !canReplace {
            let why = t("update.why.folder", ["folder": bundle.deletingLastPathComponent().path])
            staged = nil
            state = .error(why)
            AppInstall.shared.log("update: \(why)")
            return
        }
        switch test {
        case "restart": installNow()
        case "quit": NSApp.terminate(nil)
        default: break
        }
    }

    /// Restart Now, and the menu's Restart to Update: quits, and the new version starts.
    func installNow() {
        guard case .ready = state else { return }
        relaunch = true
        AppInstall.shared.log("update: restarting to \(staged?.version ?? "")")
        NSApp.terminate(nil)
    }

    /// The app quits (AppDelegate.applicationWillTerminate): a ready update
    /// is put in place once this process has ended, and started again for
    /// Restart Now. The helper's script, run by /bin/sh with its arguments.
    func atQuit() {
        guard case .ready(let v) = state, let s = staged, FileManager.default.fileExists(atPath: s.app.path) else { return }
        let old = folder.appendingPathComponent("previous.app")
        let log = URL(fileURLWithPath: AppInstall.shared.home).appendingPathComponent("Library/Logs/Ravenry/app.log")
        let clean = Relaunch.cleanEnv(ProcessInfo.processInfo.environment)
        let background = Relaunch.testRelaunch(env) && env[Relaunch.testFlag] != "foreground"
        let args = Updater.helperArgs(pid: getpid(), app: bundle.path, new: s.app.path, old: old.path, log: log.path, version: v, relaunch: relaunch, background: background)
        do {
            try Relaunch.spawnDetached("/bin/sh", args, env: clean.env)
            AppInstall.shared.log("update: installing \(v) over \(bundle.path) once this process ends\(relaunch ? ", then starting it" : "")")
        } catch {
            AppInstall.shared.log("update: could not start the install of \(v): \(error)")
        }
    }

    /// The swap: waits (up to 30 s) for the app's process to end, moves its
    /// bundle aside, the new one in, the old one back if that failed, then
    /// removes the old one and, for a restart, opens the app again.
    static func helperArgs(pid: Int32, app: String, new: String, old: String, log: String, version: String, relaunch: Bool, background: Bool) -> [String] {
        let script = [
            "log=$5",
            "say() { echo \"$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ) update: $1\" >> \"$log\"; }",
            "i=0",
            "while [ \"$i\" -lt 600 ]; do",
            "  s=$(/bin/ps -o stat= -p \"$1\" 2>/dev/null) || break",
            "  case \"$s\" in Z*) break ;; esac",
            "  /bin/sleep 0.05; i=$((i + 1))",
            "done",
            "/bin/rm -rf \"$4\"",
            "if /bin/mv \"$2\" \"$4\"; then",
            "  if /bin/mv \"$3\" \"$2\"; then",
            "    say \"installed $6 at $2\"",
            "    /bin/rm -rf \"$4\"",
            "  else",
            "    /bin/mv \"$4\" \"$2\"",
            "    say \"could not move $6 into place; the version before it stays\"",
            "  fi",
            "else",
            "  say \"could not move $2 aside; nothing changed\"",
            "fi",
            "if [ \"$7\" = 1 ]; then /usr/bin/open -n\(background ? " -g" : "") -a \"$2\" || say \"starting $2 again failed\"; fi",
        ].joined(separator: "\n")
        return ["-c", script, "ravenry-update", String(pid), app, new, old, log, version, relaunch ? "1" : "0"]
    }

    // MARK: the menu

    /// Check for Updates... (or Restart to Update to <version>) and Go Back
    /// to the npm Board... after About in the app menu (main.swift).
    func addMenuItems(to menu: NSMenu) {
        let at = (menu.items.firstIndex { $0.action == #selector(NSApplication.orderFrontStandardAboutPanel(_:)) } ?? -1) + 1
        let u = NSMenuItem(title: t("update.check"), action: #selector(menuUpdate(_:)), keyEquivalent: "")
        u.target = self
        menu.insertItem(u, at: at)
        item = u
        let back = NSMenuItem(title: t("menu.npmBack"), action: #selector(menuNpmBack(_:)), keyEquivalent: "")
        back.target = self
        back.isHidden = !NpmSwitch.shared.menuShowsBack
        menu.insertItem(back, at: at + 1)
        NpmSwitch.shared.menuItem = back
        stateChanged()
    }

    /// The menu item's title for the state.
    var menuTitle: String {
        if case .ready(let v) = state { return t("update.restartTo", ["version": v]) }
        return t("update.check")
    }

    private func stateChanged() {
        item?.title = menuTitle
    }

    func validateMenuItem(_ m: NSMenuItem) -> Bool {
        if m.action == #selector(menuUpdate(_:)) { m.title = menuTitle }
        if m.action == #selector(menuNpmBack(_:)) { m.isHidden = !NpmSwitch.shared.menuShowsBack }
        return true
    }

    @objc func menuNpmBack(_ sender: Any?) { NpmSwitch.shared.confirm(true) }

    @objc func menuUpdate(_ sender: Any?) {
        if case .ready = state { installNow() } else { checkNow() }
    }

    // MARK: what Check for Updates says (updater.ts checkNow, offerRestart)

    /// The menu's Check for Updates: says what it found.
    func checkNow() {
        if let why = whyNot() {
            let a = alert(t("update.title"), why, buttons: releasesURL != nil ? [t("update.openReleases"), t("update.ok")] : [t("update.ok")])
            show(a) { [weak self] r in if r == .alertFirstButtonReturn, let u = self?.releasesURL, a.buttons.count > 1 { Outside.open(u.absoluteString) } }
            return
        }
        if case .ready = state { return offerRestart() }
        if case .downloading(let v) = state { return showDownloading(v) }
        check { [weak self] r in
            guard let self else { return }
            switch r {
            case .success(let f?): self.showDownloading(f.version)
            case .success(nil):
                if case .ready = self.state { return self.offerRestart() }
                self.show(self.alert(t("update.upToDate"), t("update.upToDateS", ["version": self.current]), buttons: [t("update.ok")]))
            case .failure(let e):
                let a = self.alert(t("update.couldNot"), e.description, buttons: self.releasesURL != nil ? [t("update.openReleases"), t("update.ok")] : [t("update.ok")], warning: true)
                self.show(a) { r in if r == .alertFirstButtonReturn, let u = self.releasesURL, a.buttons.count > 1 { Outside.open(u.absoluteString) } }
            }
        }
    }

    func showDownloading(_ v: String) {
        show(alert(t("update.downloading", ["version": v]), t("update.downloadingS"), buttons: [t("update.ok")]))
    }

    func offerRestart() {
        guard case .ready(let v) = state else { return }
        let a = alert(t("update.ready", ["version": v]), t("update.readyS"), buttons: [t("update.restartNow"), t("update.later")])
        show(a) { [weak self] r in if r == .alertFirstButtonReturn { self?.installNow() } }
    }

    func alert(_ title: String, _ detail: String, buttons: [String], warning: Bool = false) -> NSAlert {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = detail
        a.alertStyle = warning ? .warning : .informational
        for b in buttons { a.addButton(withTitle: b) }
        if buttons.count > 1, let last = a.buttons.last { last.keyEquivalent = "\u{1b}" }
        return a
    }

    /// Over the window in front as a sheet, else on its own.
    func show(_ a: NSAlert, _ done: ((NSApplication.ModalResponse) -> Void)? = nil) {
        shown.append(a)
        if shown.count > 8 { shown.removeFirst() }
        let w = Board.lastFront?.ws.window ?? NSApp.keyWindow ?? NSApp.mainWindow
        if let w, w.attachedSheet == nil {
            a.beginSheetModal(for: w) { r in done?(r) }
        } else if !offscreen {
            done?(a.runModal())
        }
    }

    /// The self-test: a state drawn without a feed (its dialogs' pictures).
    func preview(_ s: State) { state = s }
}
