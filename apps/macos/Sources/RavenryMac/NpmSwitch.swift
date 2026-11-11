// The switch from the npm board (`ravenry` from npm, ravenry-app 0.4.x) to
// the app's own hub, and the way back, as the Electron app draws it
// (apps/desktop/src/renderer/npmswitch.ts, variant A; main.ts detectNpm,
// switchFromNpm, backToNpm):
//
// - the offer takes the first-launch place (Start), and says what was found
//   on this Mac and what happens to each: Switch to the app, or Not now;
// - then each step as it is done, and what the app's hub shows once it
//   answers (Everything is here), or where it stopped, with Try again;
// - after Not now, or after going back, a quiet bar at the top of the
//   terminal's sheet keeps the offer;
// - while the npm board keeps the data, what needs the app's own hub
//   (Start, Decisions, Machines, a pick, a review...) points at the npm
//   board instead (app.ts npmPoint, renderNpmPointer);
// - going back, from the Ravenry menu's Go Back to the npm Board..., is
//   asked once in a sheet over the window.
//
// The work is the hub script's (hub/server/npmswitch.mjs), run by the
// app's setup (install/setup.ts npm-detect, npm-switch, npm-back) on the
// Node the app carries; this file only says what the window shows.

import AppKit

final class NpmSwitch {
    static let shared = NpmSwitch()
    static let changed = Notification.Name("RavenryNpmSwitchChanged")

    enum Phase: String { case idle, switching, switched, goingBack = "going-back", back, error }

    private(set) var offer = "none"
    private(set) var phase: Phase = .idle
    private(set) var message: String?
    private(set) var log: [String] = []
    private(set) var steps: [[String: Any]] = []
    private(set) var counts: [String: Int]?
    private(set) var confirmBack = false
    private(set) var result: [String: Any]?
    private(set) var detect: [String: Any]?
    /// What was found when the person agreed (the steps the window lists).
    private(set) var from: [String: Any]?
    /// Everything is here was closed with Open the board.
    var dismissed = false
    /// What a control asked for that needs the app's hub ("Decisions"), for Start's pointer.
    var asked: String?
    /// The app menu's Go Back to the npm Board... (Updater.addMenuItems).
    weak var menuItem: NSMenuItem?
    private var sheet: NpmBackSheet?

    /// Runs a setup command, its log lines as they come, its answer at the end (both on the main queue).
    var run: (_ args: [String], _ onLine: @escaping (String) -> Void, _ done: @escaping ([String: Any]) -> Void) -> Void = { args, line, done in
        AppInstall.shared.runSetupLive(args, onLine: line, done: done)
    }

    // MARK: what the window shows

    /// The board found at launch, and what to offer (setup.ts hub's answer).
    func launched(_ r: [String: Any]) {
        guard phase == .idle || phase == .back else { return }
        detect = r["detect"] as? [String: Any]
        offer = r["offer"] as? String ?? "none"
        changed()
    }

    /// The centre shows the switch: the offer, its steps, its end, or where it stopped.
    var takesCentre: Bool {
        switch phase {
        case .switching, .error: return true
        case .switched: return !dismissed
        default: return offer == "screen" && phase == .idle && detect != nil
        }
    }

    /// The quiet bar, after Not now or the way back.
    var showsBar: Bool { offer == "bar" && !confirmBack && phase != .switching && phase != .goingBack && detect != nil }

    /// After the switch, the way back in the menu.
    var menuShowsBack: Bool { (detect?["record"] as? [String: Any])?["state"] as? String == "switched" }

    /// The person chose the npm board (Not now, or the way back): the app
    /// runs no hub of its own. `again`: the command that started it before.
    struct Chosen { let again: String? }
    var chosen: Chosen? {
        guard offer == "bar", let d = detect, ![.switching, .switched, .goingBack].contains(phase) else { return nil }
        let rec = d["record"] as? [String: Any]
        let recAgain = ((rec?["from"] as? [String: Any])?["board"] as? [String: Any])?["again"] as? String
        let res = phase == .back ? result?["again"] as? String : nil
        return Chosen(again: res ?? recAgain ?? running(d)?["again"] as? String)
    }

    /// The npm board serving the data, when it is not one of the app's.
    func running(_ d: [String: Any]) -> [String: Any]? {
        guard let b = d["board"] as? [String: Any], b["own"] as? Bool != true else { return nil }
        return b
    }
    func hooks(_ d: [String: Any]) -> (claude: Int, codex: Int) {
        let h = d["hooks"] as? [String: Any]
        return ((h?["claude"] as? [Any])?.count ?? 0, (h?["codex"] as? [Any])?.count ?? 0)
    }
    /// "Claude Code and Codex reports" said right: the key for one or both.
    func who(_ d: [String: Any]) -> (who: String, both: Bool) {
        let h = hooks(d)
        if h.claude > 0 && h.codex > 0 { return ("Claude Code and Codex", true) }
        return (h.claude > 0 ? "Claude Code" : "Codex", false)
    }
    func hasHooks(_ d: [String: Any]) -> Bool { let h = hooks(d); return h.claude + h.codex > 0 }
    func version(_ d: [String: Any]) -> String {
        guard let v = (d["copy"] as? [String: Any])?["version"] as? String, !v.isEmpty else { return "" }
        return " \(v)"
    }
    func logins(_ d: [String: Any]) -> Int { (d["login"] as? [Any])?.count ?? 0 }

    // MARK: what the person does

    private var resources: String { AppInstall.shared.resources.path }

    func switchNow() {
        guard phase != .switching, phase != .goingBack else { return }
        phase = .switching; message = nil; log = []; steps = []; counts = nil; result = nil; from = detect; dismissed = false
        changed()
        run(["npm-switch", "--resources", resources, "--exe", AppInstall.shared.executable], { [weak self] l in self?.line(l) }) { [weak self] j in
            guard let self else { return }
            self.result = j["result"] as? [String: Any]
            self.counts = j["counts"] as? [String: Int]
            if let d = j["detect"] as? [String: Any] { self.detect = d }
            if let f = j["from"] as? [String: Any], self.from == nil { self.from = f }
            self.phase = Phase(rawValue: j["phase"] as? String ?? "") ?? (j["ok"] as? Bool == true ? .switched : .error)
            if self.phase == .switched { self.offer = "none" }
            self.message = j["message"] as? String ?? (self.phase == .error ? j["error"] as? String ?? t("npm.stoppedLead") : nil)
            self.changed()
        }
    }

    private func line(_ l: String) {
        if l.hasPrefix("@step "), let d = l.dropFirst(6).data(using: .utf8), let s = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
            // The hub's step comes twice: starting, then done.
            if let i = steps.firstIndex(where: { $0["id"] as? String == s["id"] as? String }) { steps[i] = s } else { steps.append(s) }
        } else {
            log.append(l)
        }
        changed()
    }

    func notNow() {
        run(["npm-choice", "--set", "not-now"], { _ in }) { _ in }
        if detect?["npm"] as? Bool == true { offer = "bar" }
        changed()
    }

    func confirm(_ on: Bool) {
        confirmBack = on
        changed()
    }

    func back() {
        guard phase != .switching, phase != .goingBack else { return }
        phase = .goingBack; message = nil; log = []; result = nil; confirmBack = false
        changed()
        run(["npm-back", "--resources", resources], { [weak self] l in self?.log.append(l); self?.changed() }) { [weak self] j in
            guard let self else { return }
            self.result = j["result"] as? [String: Any]
            if let d = j["detect"] as? [String: Any] { self.detect = d }
            if j["ok"] as? Bool == true {
                self.phase = .back
                self.offer = j["offer"] as? String ?? "bar"
            } else {
                self.phase = .error
                self.message = j["message"] as? String ?? j["error"] as? String ?? t("npm.backStopped")
            }
            self.changed()
        }
    }

    /// The self-test's states, drawn without a board of npm's.
    func preview(offer o: String, phase p: Phase, detect d: [String: Any]?, steps s: [[String: Any]] = [], counts c: [String: Int]? = nil,
                 message m: String? = nil, result r: [String: Any]? = nil, confirmBack cb: Bool = false) {
        offer = o; phase = p; detect = d; from = d; steps = s; counts = c; message = m; result = r; confirmBack = cb; dismissed = false
        changed()
    }

    func changed() {
        menuItem?.isHidden = !menuShowsBack
        updateSheet()
        NotificationCenter.default.post(name: NpmSwitch.changed, object: nil)
    }

    // MARK: the way back's sheet

    private func updateSheet() {
        let on = confirmBack || phase == .goingBack
        if !on {
            if let s = sheet { s.sheetParent?.endSheet(s); s.orderOut(nil) }
            sheet = nil
            return
        }
        let s = sheet ?? NpmBackSheet()
        s.draw(self)
        if sheet == nil {
            sheet = s
            if let w = Board.lastFront?.ws.window ?? NSApp.keyWindow { w.beginSheet(s) { _ in } }
        }
    }
    /// The sheet over the window, for the self-test's picture.
    var backSheet: NpmBackSheet? { sheet }
}

// MARK: the centre (Start's place)

extension StartView {
    /// The npm board's screens in Start's place: the switch (offer, steps,
    /// end, where it stopped) or the pointer; nil when Start shows itself.
    func npmItems() -> [NSView]? {
        let n = NpmSwitch.shared
        if n.takesCentre {
            switch n.phase {
            case .switching, .error: return npmSwitching(n)
            case .switched: return npmDone(n)
            default: return n.detect.map { npmOffer(n, $0) }
            }
        }
        if n.chosen != nil { return npmPointer(n, what: npmAsked ?? t("npm.need.start")) }
        return nil
    }

    private var menuWhere: String { t("npm.menuWhere") }

    /// Words with `code` chips (.sw-c code), as one wrapping line.
    func npmText(_ parts: [(String, Bool)], size: CGFloat = 12.5, color: String = "tx2") -> NSView {
        let m = NSMutableAttributedString()
        for (s, code) in parts {
            if code {
                m.append(NSAttributedString(string: "\u{2009}\(s)\u{2009}", attributes: [.font: Fonts.mono(size - 1), .foregroundColor: Design.color("tx2"), .backgroundColor: Design.color("input")]))
            } else {
                m.append(NSAttributedString(string: s, attributes: [.font: Fonts.pt(size), .foregroundColor: Design.color(color)]))
            }
        }
        let p = NSMutableParagraphStyle(); p.minimumLineHeight = ceil(size * 1.45); p.maximumLineHeight = ceil(size * 1.45)
        m.addAttribute(.paragraphStyle, value: p, range: NSRange(location: 0, length: m.length))
        let w = wrap("", Fonts.pt(size), color)
        w.text.attributedStringValue = m
        return w
    }

    /// .sw-i: the row's round mark, plain, ticked (ok), stopped (bad) or turning (run).
    func npmMark(_ icon: String?, _ kind: String) -> NSView {
        let b = Box(fill: kind == "ok" ? "ok" : kind == "bad" ? "bad" : kind == "run" ? nil : "card2", ring: kind == "run" ? "work" : nil, radius: 11)
        if kind == "run" { b.ringWidth = 2 }
        b.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([b.widthAnchor.constraint(equalToConstant: 22), b.heightAnchor.constraint(equalToConstant: 22)])
        if let icon {
            let i = Icon(icon, kind == "ok" || kind == "bad" ? "tx" : "tx2", size: kind == "ok" ? 11 : 12)
            if kind == "ok" || kind == "bad" { i.image = SharedIcons.image(icon, color: "tx", size: 11, dark: true) }
            i.translatesAutoresizingMaskIntoConstraints = false
            b.addSubview(i)
            NSLayoutConstraint.activate([i.centerXAnchor.constraint(equalTo: b.centerXAnchor), i.centerYAnchor.constraint(equalTo: b.centerYAnchor)])
        }
        return b
    }

    /// .sw-r: a mark beside its title and the words under it.
    func npmRow(_ icon: String?, _ kind: String, _ title: String, _ sub: [(String, Bool)]?) -> NSView {
        var col: [NSView] = [wrap(title, Fonts.pt(13.5, Fonts.w650), "tx")]
        if let s = sub { col.append(npmText(s)) }
        return step(npmMark(icon, kind), col, gap: 4, insets: NSEdgeInsets(top: 14, left: 18, bottom: 14, right: 18))
    }

    /// .fl-card.sw-card: the rows, a line between each, and the go row.
    func npmCard(_ rows: [NSView], go: NSView?) -> NSView {
        var all: [NSView] = []
        for r in rows { if !all.isEmpty { all.append(rule()) }; all.append(r) }
        if let g = go { all.append(rule()); all.append(g) }
        let c = Box(fill: "card", radius: 14)
        c.layer?.masksToBounds = true
        let st = vstack(all, spacing: 0)
        st.translatesAutoresizingMaskIntoConstraints = false
        c.addSubview(st)
        NSLayoutConstraint.activate([st.leadingAnchor.constraint(equalTo: c.leadingAnchor), st.trailingAnchor.constraint(equalTo: c.trailingAnchor),
                                     st.topAnchor.constraint(equalTo: c.topAnchor), st.bottomAnchor.constraint(equalTo: c.bottomAnchor)])
        controls["npm-card"] = c
        return c
    }

    /// .sw-go: the buttons on the left, a small line on the right.
    func npmGo(_ buttons: [NSView], note: String?) -> NSView {
        var row: [NSView?] = buttons
        row.append(spring())
        if let n = note { let l = label(n, Fonts.pt(12), "tx3"); l.lineBreakMode = .byTruncatingTail; l.setContentCompressionResistancePriority(.init(200), for: .horizontal); row.append(l) }
        return hstack(row, spacing: 10, insets: NSEdgeInsets(top: 14, left: 18, bottom: 14, right: 18))
    }

    func npmButton(_ key: String, _ title: String, _ kind: RButton.Kind, large: Bool = false, run: @escaping () -> Void) -> RButton {
        let b = RButton(title, kind, run: run)
        if large { b.titleSize = 14; b.heightAnchor.constraint(greaterThanOrEqualToConstant: 38).isActive = true }
        controls["npm:\(key)"] = b
        return b
    }

    private func npmHead(_ title: String, _ lead: String, icon: Bool = true) -> [NSView] {
        var out: [NSView] = []
        if icon {
            let i = Icon("app-icon", "tx", size: 64)
            i.wantsLayer = true
            i.layer?.cornerRadius = 15
            i.layer?.masksToBounds = true
            out += [centred(i), gap(18)]
        }
        out += [centred(label(title, Fonts.pt(26, .bold))), gap(8), self.lead(lead), gap(26)]
        return out
    }

    private func npmFoot(_ s: String) -> [NSView] { [gap(16), lead(s, size: 12.5, color: "tx3")] }

    // The offer (npmswitch.ts offer).
    private func npmOffer(_ n: NpmSwitch, _ d: [String: Any]) -> [NSView] {
        let b = n.running(d)
        let again = b?["again"] as? String
        let atLogin = n.logins(d) > 0
        let same = t("npm.same")
        let v = n.version(d)
        let w = n.who(d)
        let rows = [
            b != nil
                ? npmRow("npm-board", "", t("npm.runs", ["version": v, "port": "\(b?["port"] ?? 4600)"]),
                         atLogin ? [(t("npm.startedAtLogin") + " " + same, false)] : again.map { [(t("npm.startedWith"), false), ($0, true), (". " + same, false)] } ?? [(same, false)])
                : npmRow("npm-board", "", t("npm.notRunning", ["version": v]), [(t("npm.notRunningS"), false)]),
            n.hasHooks(d) ? npmRow("plus", "", t(w.both ? "npm.hooksTwo" : "npm.hooksOne", ["who": w.who]), [(t("npm.hooksS"), false)])
                : npmRow("plus", "", t("npm.noHooks"), [(t("npm.noHooksS"), false)]),
            atLogin ? npmRow("npm-login", "", t("npm.login"), [(t("npm.loginS"), false)]) : npmRow("npm-login", "", t("npm.noLogin"), [(t("npm.noLoginS"), false)]),
        ]
        let go = npmGo([npmButton("switch", t("npm.switch"), .primary, large: true) { n.switchNow() },
                        npmButton("not-now", t("npm.notNow"), .normal) { [weak self] in n.notNow(); self?.onCancel?() }], note: t("npm.copyFirst"))
        return npmHead(t("npm.title"), t("npm.lead")) + [npmCard(rows, go: go)] + npmFoot(t("npm.foot", ["menu": menuWhere]))
    }

    // The steps, each done, under way (or where it stopped), or still to come (npmswitch.ts steps).
    private func npmSteps(_ n: NpmSwitch) -> [NSView] {
        let d = n.from ?? n.detect
        var got: [String: [String: Any]] = [:]
        for s in n.steps { if let id = s["id"] as? String { got[id] = s } }
        let recPort = (n.detect?["record"] as? [String: Any])?["port"]
        let port = "\(got["hub"]?["port"] ?? d.flatMap { n.running($0)?["port"] } ?? recPort ?? 4600)"
        var want: [(id: String, title: String, sub: (([String: Any]) -> [(String, Bool)])?)] = []
        if let d, n.logins(d) > 0 { want.append(("login", t(n.logins(d) > 1 ? "npm.stepLogins" : "npm.stepLogin"), { _ in [(t("npm.stepLoginS"), false)] })) }
        if let d, n.running(d) != nil { want.append(("stopped", t("npm.stepStopped"), nil)) }
        want.append(("backup", t("npm.stepBackup"), { s in [("~/.ravenry/\(s["dir"] as? String ?? "backups")", true), (t("npm.stepBackupS", ["files": "\(s["files"] ?? 0)"]), false)] }))
        if d == nil || n.hasHooks(d!) {
            let w = d.map { n.who($0) } ?? (who: "Claude Code", both: false)
            want.append(("hooks", t(w.both ? "npm.stepHooksTwo" : "npm.stepHooksOne", ["who": w.who]), { _ in [(t("npm.stepHooksS"), false)] }))
        }
        let hubDone = got["hub"]?["done"] as? Bool == true
        want.append(("hub", t(hubDone ? "npm.stepHubDone" : "npm.stepHub", ["port": port]), nil))
        var next = true
        return want.map { w in
            let s = got[w.id]
            let done = s != nil && (w.id != "hub" || hubDone)
            var kind = done ? "ok" : "", icon: String? = done ? "check" : nil
            if !done && next {
                next = false
                if n.phase == .error { kind = "bad"; icon = "close" } else if n.phase == .switching { kind = "run" }
            }
            return npmRow(icon, kind, w.title, done ? w.sub?(s!) : nil)
        }
    }

    private func npmSwitching(_ n: NpmSwitch) -> [NSView] {
        let err = n.phase == .error
        let go = err ? npmGo([npmButton("switch", t("npm.tryAgain"), .primary) { n.switchNow() }], note: t("npm.goingBack", ["menu": menuWhere])) : nil
        return npmHead(err ? t("npm.stoppedTitle") : t("npm.switchingTitle"), err ? (n.message ?? t("npm.stoppedLead")) : t("npm.switchingLead"), icon: false)
            + [npmCard(npmSteps(n), go: go)]
    }

    private func npmDone(_ n: NpmSwitch) -> [NSView] {
        let c = n.counts
        func tile(_ k: String, _ one: String, _ many: String) -> NSView {
            let v = c?[k] ?? 0
            let words = label(t(v == 1 ? one : many), Fonts.pt(12), "tx2", lines: 2)
            words.lineBreakMode = .byWordWrapping
            words.setContentCompressionResistancePriority(.init(200), for: .horizontal)
            let b = boxed(vstack([label("\(v)", Fonts.pt(20, .bold)), words], spacing: 2),
                          fill: "input", ring: "sep", radius: 9, insets: NSEdgeInsets(top: 10, left: 12, bottom: 10, right: 12))
            return b
        }
        var rows: [NSView] = []
        if c != nil {
            let g = NSStackView(views: [tile("projects", "npm.nProject", "npm.nProjects"), tile("sessions", "npm.nSession", "npm.nSessions"), tile("ideas", "npm.nIdea", "npm.nIdeas"),
                                        tile("plans", "npm.nPlan", "npm.nPlans"), tile("rules", "npm.nRule", "npm.nRules")])
            // One height for every tile, the tallest's ("plans running" on two lines).
            for v in g.arrangedSubviews.dropFirst() { v.heightAnchor.constraint(equalTo: g.arrangedSubviews[0].heightAnchor).isActive = true }
            g.orientation = .horizontal
            g.distribution = .fillEqually
            g.alignment = .top
            g.spacing = 8
            g.edgeInsets = NSEdgeInsets(top: 14, left: 18, bottom: 14, right: 18)
            rows.append(g)
        }
        let go = npmGo([npmButton("done", t("npm.openBoard"), .primary, large: true) { [weak self] in
            n.dismissed = true
            n.changed()
            self?.onCancel?()
        }], note: t("npm.goingBack", ["menu": menuWhere]))
        return npmHead(t("npm.doneTitle"), t("npm.doneLead")) + [npmCard(rows, go: go)]
    }

    // In Start's place while the npm board keeps the data (npmswitch.ts renderNpmPointer).
    private func npmPointer(_ n: NpmSwitch, what: String) -> [NSView] {
        let again = n.chosen?.again ?? "ravenry"
        let reachable = hub?.reachable ?? false
        let url = hub?.url.isEmpty == false ? hub!.url.trimmingCharacters(in: CharacterSet(charactersIn: "/")) : "http://localhost:4600"
        let sw = npmButton("switch", t("npm.switch"), .normal) { n.switchNow() }
        let shell = npmButton("new-shell", t("npm.newShell"), .normal) { [weak self] in self?.onShell?(nil) }
        let rows: [NSView]
        let first: RButton
        if reachable {
            rows = [npmRow("npm-board", "", t("npm.onBoard"), [(t("npm.onBoardS1"), false), (url, true), (t("npm.onBoardS2"), false)]),
                    npmRow("plus", "", t("npm.shells"), [(t("npm.shellsS"), false)])]
            first = npmButton("open-board", t("npm.openNpmBoard"), .primary, large: true) { Outside.open(url) }
        } else {
            rows = [npmRow("npm-board", "", t("npm.startAgain"), [(again, true), (t("npm.startAgainS"), false)]),
                    npmRow("plus", "", t("npm.shells"), [(t("npm.shellsS"), false)])]
            first = npmButton("copy", t("npm.copyCommand"), .primary, large: true) { Outside.copy(again) }
        }
        return npmHead(reachable ? t("npm.ptrUp") : t("npm.ptrDown"), t("npm.ptrWhy", ["what": what]))
            + [npmCard(rows, go: npmGo([first, shell, spring(), sw], note: nil))] + npmFoot(t("npm.ptrFoot"))
    }
}

// MARK: the quiet bar

/// .qbar: first in the terminal's sheet, after Not now or the way back.
final class NpmBar: Box {
    weak var hub: HubClient?
    private(set) var buttons: [String: RButton] = [:]
    private(set) var text = ""
    private var timer: Timer?
    private var drawnFor = ""
    static let height: CGFloat = 38

    init() {
        super.init(fill: "work-t")
        addSubview(line)
    }
    required init?(coder: NSCoder) { fatalError() }
    /// The bar's bottom edge (border-bottom: 1px solid var(--sep)).
    private let line = Box(fill: "sep")
    override func layout() {
        super.layout()
        line.frame = NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        timer?.invalidate()
        timer = nil
        // The npm board starting or stopping changes what the bar says.
        if window != nil { timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.update() } }
    }

    func update() {
        let n = NpmSwitch.shared
        guard let d = n.detect else { return }
        let rec = d["record"] as? [String: Any]
        let back = n.phase == .back || rec?["state"] as? String == "back"
        let down = !(hub?.reachable ?? (n.running(d) != nil))
        let again = n.chosen?.again
        let key = "\(back)|\(down)|\(again ?? "")"
        guard key != drawnFor else { return }
        drawnFor = key
        fill = back ? "idle-t" : "work-t"
        for v in subviews where !(v is Box) { v.removeFromSuperview() }
        buttons = [:]
        let sw = RButton(t("npm.switch"), back ? .normal : .primary, small: true) { n.switchNow() }
        buttons["switch"] = sw
        var row: [NSView?] = []
        if back && down, let a = again {
            text = t("npm.barAgain")
            let code = boxed(label(a, Fonts.mono(11.5), "tx2"), fill: "input", ring: "sep", radius: 5, insets: NSEdgeInsets(top: 2, left: 6, bottom: 2, right: 6))
            let copy = RButton(t("npm.copy"), .normal, small: true) { Outside.copy(a) }
            buttons["copy"] = copy
            row = [label(text, Fonts.pt(12.5), "tx"), code, copy, spring(), sw]
        } else {
            text = back ? (down ? t("npm.barBackDown") : t("npm.barBack")) : t("npm.barKeeps")
            let l = label(text, Fonts.pt(12.5), "tx")
            l.lineBreakMode = .byTruncatingTail
            l.setContentCompressionResistancePriority(.init(200), for: .horizontal)
            row = [l, spring(), sw]
        }
        let h = hstack(row, spacing: 10, insets: NSEdgeInsets(top: 0, left: 14, bottom: 1, right: 10))
        h.translatesAutoresizingMaskIntoConstraints = false
        addSubview(h)
        NSLayoutConstraint.activate([h.leadingAnchor.constraint(equalTo: leadingAnchor), h.trailingAnchor.constraint(equalTo: trailingAnchor),
                                     h.topAnchor.constraint(equalTo: topAnchor), h.bottomAnchor.constraint(equalTo: bottomAnchor)])
    }
}

// MARK: going back, asked once

/// .veil .vsheet: Go back to the npm board?, over the window.
final class NpmBackSheet: NSWindow {
    private let box = Box(fill: "sheet")
    private(set) var buttons: [String: RButton] = [:]
    private(set) var title2 = ""

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 520, height: 260), styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
        titlebarAppearsTransparent = true
        titleVisibility = .hidden
        isReleasedWhenClosed = false
        contentView = box
    }

    func draw(_ n: NpmSwitch) {
        for v in box.subviews { v.removeFromSuperview() }
        buttons = [:]
        let rec = n.detect?["record"] as? [String: Any]
        let atLogin = !((rec?["login"] as? [Any]) ?? []).isEmpty
        let busy = n.phase == .goingBack
        title2 = busy ? t("npm.backBusy") : t("npm.backTitle")
        let hd = label(title2, Fonts.pt(17, .bold))
        func para(_ s: String) -> NSView { wrap(s, Fonts.pt(13), "tx2") }
        let bullets = ["npm.backLi1", "npm.backLi2", "npm.backLi3"].map { k -> NSView in hstack([label("\u{2022}", Fonts.pt(13), "tx2"), para(t(k))], spacing: 8) }
        let bd = vstack([para(t("npm.backLead")), vstack(bullets, spacing: 3, insets: NSEdgeInsets(top: 4, left: 4, bottom: 4, right: 0)),
                         para(atLogin ? t("npm.backLogin") : t("npm.backByHand"))], spacing: 4)
        let cancel = RButton(t("npm.cancel"), .normal) { n.confirm(false) }
        cancel.isEnabled = !busy
        cancel.keyEquivalent = "\u{1b}"
        let go = RButton(busy ? t("npm.going") : t("npm.goBack"), .primary) { n.back() }
        go.isEnabled = !busy
        go.keyEquivalent = "\r"
        buttons = ["cancel": cancel, "back": go]
        let ft = hstack([spring(), cancel, go], spacing: 8)
        let all = vstack([hd, bd, ft], spacing: 12, insets: NSEdgeInsets(top: 22, left: 22, bottom: 18, right: 22))
        all.setCustomSpacing(6, after: hd)
        all.setCustomSpacing(16, after: bd)
        all.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(all)
        NSLayoutConstraint.activate([all.leadingAnchor.constraint(equalTo: box.leadingAnchor), all.trailingAnchor.constraint(equalTo: box.trailingAnchor),
                                     all.topAnchor.constraint(equalTo: box.topAnchor), all.widthAnchor.constraint(equalToConstant: 520)])
        box.layoutSubtreeIfNeeded()
        setContentSize(NSSize(width: 520, height: ceil(all.fittingSize.height)))
    }
}

// MARK: the window

extension Board {
    /// Follows the switch: the centre while it takes it, the quiet bar, Start's pointer.
    func followNpm() {
        NotificationCenter.default.addObserver(forName: NpmSwitch.changed, object: nil, queue: .main) { [weak self] _ in self?.npmChanged() }
        npmChanged()
    }

    func npmChanged() {
        guard !closed else { return }
        let n = NpmSwitch.shared
        if n.takesCentre, front != .start { openStart(nil) } else if front == .start { start.draw() }
        if n.showsBar {
            let b = (root.notice as? NpmBar) ?? NpmBar()
            b.hub = hub
            b.update()
            if root.notice !== b { root.notice = b }
        } else if root.notice is NpmBar {
            root.notice = nil
        }
    }

    /// A control that needs the app's own hub while the npm board keeps
    /// the data: Start, pointing at the npm board instead (app.ts npmPoint).
    /// True when it pointed.
    func npmPoints(_ key: String) -> Bool {
        guard NpmSwitch.shared.chosen != nil else { return false }
        let what: String?
        if key == "decisions" { what = t("npm.need.decisions") }
        else if key == "side.machines" { what = t("npm.need.machines") }
        else if key.hasPrefix("pick:") { what = t("npm.need.picker") }
        else if key.hasPrefix("review:") { what = t("npm.need.review") }
        else if key.hasPrefix("files:") { what = t("npm.need.grid") }
        else if hub.state?.pages.contains(where: { $0.key == key }) == true { what = t("npm.need.page") }
        else { what = nil }
        guard let what else { return false }
        NpmSwitch.shared.asked = what
        openStart(nil)
        return true
    }
}
