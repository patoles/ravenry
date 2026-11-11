// New session, as the Electron app's Start (apps/desktop/src/renderer/app.ts
// renderStart, setupCard, startSession; app.css .fl, .fl-card, .fo, .pk,
// .ob; phase2.css .fl-why):
//
// - 1 Folder: up to three of the hub's folders (GET /api/setup/start: the
//   board's folders, then the ones that look like projects, the one asked
//   for first) as radio rows, Choose another folder, or one dropped on the
//   card;
// - 2 Assistant: Claude Code and Codex, found and signed in or not;
// - the branch line when another session already works in that folder's
//   project (the hub's `busy` on the folder, sidebar.busyIn): it gets its
//   own copy of the code (POST /api/sessions/start with worktree and
//   projectId) unless told to work in the folder;
// - step 2, once per assistant (the onboarding's `setup` marks) while its
//   hooks or the Ravenry skill are off (GET /api/setup/skills): two ticks,
//   Set them up (the routes Settings' Skills uses) or Not now, then it
//   starts.
// With no assistant found it opens a shell in the folder, in this window.
//
// With the board down (not running, or not answering) Start still works,
// as the Electron app's (startLocal, startSession's own pane): the folders
// and assistants are read here by the hub's own rules (LocalStart, from
// hub/server/firstlaunch.mjs), and Start runs the assistant in a pane of
// this window's (labelled ravenry.agent: the board follows it once it is
// up). While macOS asks whether Ravenry may read a folder (the hub waits
// on the answer, hub/server/access.mjs), the access card says so above
// the card, with Open Files & Folders; folders macOS refused are named.
// Start looks again each second and a half while it shows, so the board
// coming up, or the answer, is seen at once.

import AppKit
import UniformTypeIdentifiers

/// A box that answers a press (a pick card, a tick), on the press as the Electron app's buttons do.
class PickBox: Box {
    var onPress: (() -> Void)?
    var enabled = true { didSet { alphaValue = enabled ? 1 : dim } }
    var dim: CGFloat = 0.55
    override init(fill: String? = nil, ring: String? = nil, radius: CGFloat = 0) {
        super.init(fill: fill, ring: ring, radius: radius)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func hitTest(_ p: NSPoint) -> NSView? { super.hitTest(p) == nil ? nil : self }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func mouseDown(with e: NSEvent) { if enabled { onPress?() } }
    override func accessibilityPerformPress() -> Bool { guard enabled else { return false }; onPress?(); return true }
}

final class StartView: MiddleView {
    var hub: HubClient?
    var onStarted: ((String?, String?) -> Void)?
    /// No assistant here: a shell in the folder, in this window.
    var onShell: ((String?) -> Void)?
    /// The board down: the assistant in a pane of this window (Board shows
    /// it in front). Unset, the window's workspace runs it and Start closes.
    var onRun: ((String?, Workspace.Program) -> Void)?
    /// The self-test's home and environment for the board-down reading.
    var localHome = NSHomeDirectory()
    var localEnv = ProcessInfo.processInfo.environment
    var onCancel: (() -> Void)?
    var grid: () -> (cols: Int, rows: Int) = { (100, 30) }
    /// The folder Choose another folder picks, for the self-test (no panel then).
    var testChoice: String?

    struct Setup {
        var kind: String
        var hooks: Bool, skill: Bool
        var hooksOn: Bool, skillOn: Bool
        var hooksFile: String?, skillDir: String
        var busy = false
        var error: String?
    }

    private(set) var folders: [[String: Any]] = []
    private(set) var root: String?
    private(set) var assistants: [[String: Any]] = []
    private(set) var folder: String?
    private(set) var assistant: String?
    private(set) var inFolder = false
    private(set) var busy = false
    private(set) var error: String?
    private(set) var setup: Setup?
    private var setupReady = false
    private var read = false
    /// The folders and assistants were read here: the board is down.
    private(set) var local = false
    /// What macOS is asking about, as the hub last said (the access card).
    private(set) var asking: String?
    private var watch: Timer?
    /// The self-test's macOS question and refused folders, in place of the hub's.
    var testWaiting: String?
    /// The self-test's board down (the demo hub stays up for the rest).
    var testBoardDown = false
    var testDenied: [String]?
    private var hubWaiting: String? { testWaiting ?? hub?.waitingFor }
    /// The controls by name, for the self-test: "folder:<path>", "assistant:<kind>", "choose", "go", "cancel",
    /// "inFolder", "ownCopy", "tick:hooks", "tick:skill", "setUp", "notNow".
    var controls: [String: NSView] = [:]
    /// What a control asked for that needs the app's hub while the npm board keeps the data (NpmSwitch.swift).
    var npmAsked: String?
    var go: RButton { controls["go"] as? RButton ?? RButton(t("start.go"), .primary) }

    private let column = Flipped()
    private var top: NSLayoutConstraint!

    init() {
        super.init(sheet: true)
        let wrap = Flipped()
        wrap.addSubview(column)
        column.translatesAutoresizingMaskIntoConstraints = false
        top = column.topAnchor.constraint(equalTo: wrap.topAnchor, constant: 30)
        let w = column.widthAnchor.constraint(equalTo: wrap.widthAnchor, constant: -36)
        w.priority = .init(700)
        NSLayoutConstraint.activate([top, w, column.centerXAnchor.constraint(equalTo: wrap.centerXAnchor), column.widthAnchor.constraint(lessThanOrEqualToConstant: 560),
                                     column.bottomAnchor.constraint(equalTo: wrap.bottomAnchor, constant: -30)])
        content.set([wrap])
        registerForDraggedTypes([.fileURL])
    }
    required init?(coder: NSCoder) { fatalError() }

    /// In the middle of the room when it fits (.fl's justify-content: center), else from the top.
    override func layout() {
        super.layout()
        let h = column.fittingSize.height
        let t = max(30, floor((bounds.height - h) / 2))
        if abs(top.constant - t) > 0.5 { top.constant = t; needsLayout = true }
    }

    // MARK: what it shows

    func show(folder want: String?) {
        npmAsked = NpmSwitch.shared.asked
        NpmSwitch.shared.asked = nil
        setup = nil
        setupReady = false
        error = nil
        busy = false
        inFolder = false
        if let f = want { folder = f }
        draw()
        load(want)
    }

    /// The hub's folders and assistants, the one asked for first; with the
    /// board down, the same read here.
    private func load(_ want: String?) {
        asking = hubWaiting
        watchHub()
        guard let hub, hub.reachable, !testBoardDown else { return answer(LocalStart.view(home: localHome, env: localEnv, want: want), want, local: true) }
        let q = want.map { "/api/setup/start?folder=\($0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")" } ?? "/api/setup/start"
        hub.get(q) { [weak self] code, j in
            guard let self else { return }
            guard code == 200 else { return self.answer(LocalStart.view(home: self.localHome, env: self.localEnv, want: want), want, local: true) }
            self.answer(j, want, local: false)
        }
    }

    /// Each second and a half while it shows: the board came up (its
    /// folders), went down, or macOS's question changed.
    private func watchHub() {
        guard watch == nil else { return }
        watch = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] tm in
            guard let self, self.window != nil, !self.isHidden, self.setup == nil else { tm.invalidate(); self?.watch = nil; return }
            guard let hub = self.hub, !self.busy else { return }
            let up = hub.reachable && !self.testBoardDown
            if self.hubWaiting != self.asking || up == self.local { self.load(self.folder) }
        }
    }

    /// What Start offers (the hub's answer, or the same read here): the
    /// folder asked for, else the one picked when still offered, else the
    /// first; the assistant picked when still found, else the first signed in.
    private func answer(_ j: [String: Any], _ want: String?, local: Bool) {
        self.local = local
        asking = hubWaiting
        folders = j["folders"] as? [[String: Any]] ?? []
        root = j["root"] as? String
        assistants = j["assistants"] as? [[String: Any]] ?? []
        if let w = want { folder = w }
        if folder == nil || !folders.contains(where: { $0["path"] as? String == folder }) && want == nil { folder = folders.first?["path"] as? String ?? folder }
        let found = assistants.filter { $0["found"] as? Bool == true }
        let ready = found.first { $0["signedIn"] as? Bool == true } ?? found.first
        if assistant == nil || !found.contains(where: { $0["kind"] as? String == assistant }) { assistant = ready?["kind"] as? String }
        read = true
        draw()
    }

    /// The folder's own words from the hub, else said from its path.
    private func entry(_ path: String) -> [String: Any] {
        if let f = folders.first(where: { $0["path"] as? String == path }) { return f }
        let home = NSHomeDirectory()
        return ["name": (path as NSString).lastPathComponent, "path": path, "short": path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path]
    }

    /// Another session working in the folder's project (the hub's `busy`).
    var busyHere: [String: Any]? {
        guard assistantPicked != nil, let f = folder else { return nil }
        return entry(f)["busy"] as? [String: Any]
    }
    private var assistantPicked: [String: Any]? { assistants.first { $0["kind"] as? String == assistant && $0["found"] as? Bool == true } }
    private func name(_ kind: String) -> String { kind == "claude" ? "Claude" : kind == "codex" ? "Codex" : kind.prefix(1).uppercased() + kind.dropFirst() }
    private var folderName: String? { folder.map { ($0 as NSString).lastPathComponent } }

    func draw() {
        controls = [:]
        // The npm board's switch, or where to go while it keeps the data (NpmSwitch.swift).
        if let npm = npmItems() { return place(npm) }
        var items: [NSView] = []
        let icon = Icon("app-icon", "tx", size: 64)
        icon.wantsLayer = true
        icon.layer?.cornerRadius = 15
        icon.layer?.masksToBounds = true
        items.append(centred(icon))
        if let su = setup {
            items += setupCard(su)
        } else {
            items.append(gap(18))
            items.append(centred(label(t("start.heading"), Fonts.pt(26, .bold))))
            items.append(gap(8))
            items.append(lead(t("start.lead")))
            items.append(gap(26))
            if let a = accessCard() { items.append(a); items.append(gap(12)) }
            items.append(card())
            if let e = error { items.append(gap(10)); items.append(centred(wrap(e, Fonts.pt(12.5), "bad"))) }
            if local && read { items.append(gap(12)); items.append(lead(t("start.local"), size: 12.5, color: "tx2")) }
            items.append(gap(18))
            items.append(lead(t("start.foot"), size: 12.5, color: "tx3"))
        }
        place(items)
    }

    /// The column's items, in the middle of the room.
    private func place(_ items: [NSView]) {
        for v in column.subviews { v.removeFromSuperview() }
        let s = vstack(items, spacing: 0)
        column.addSubview(s)
        NSLayoutConstraint.activate([s.leadingAnchor.constraint(equalTo: column.leadingAnchor), s.trailingAnchor.constraint(equalTo: column.trailingAnchor),
                                     s.topAnchor.constraint(equalTo: column.topAnchor), s.bottomAnchor.constraint(equalTo: column.bottomAnchor)])
        needsLayout = true
    }

    func gap(_ h: CGFloat) -> NSView {
        let v = NSView()
        v.translatesAutoresizingMaskIntoConstraints = false
        v.heightAnchor.constraint(equalToConstant: h).isActive = true
        return v
    }
    func centred(_ v: NSView) -> NSView {
        let w = Flipped()
        w.translatesAutoresizingMaskIntoConstraints = false
        v.translatesAutoresizingMaskIntoConstraints = false
        w.addSubview(v)
        NSLayoutConstraint.activate([v.centerXAnchor.constraint(equalTo: w.centerXAnchor), v.topAnchor.constraint(equalTo: w.topAnchor), v.bottomAnchor.constraint(equalTo: w.bottomAnchor),
                                     v.widthAnchor.constraint(lessThanOrEqualTo: w.widthAnchor)])
        return w
    }
    /// .lead: centred words, at most 540 wide.
    func lead(_ s: String, size: CGFloat = 14.5, color: String = "tx2") -> NSView {
        let w = WrapField(wrapping: s)
        w.font = Fonts.pt(size); w.textColor = Design.color(color); w.alignment = .center
        let p = NSMutableParagraphStyle(); p.alignment = .center; p.minimumLineHeight = ceil(size * 1.5); p.maximumLineHeight = ceil(size * 1.5)
        w.attributedStringValue = NSAttributedString(string: s, attributes: [.font: Fonts.pt(size), .foregroundColor: Design.color(color), .paragraphStyle: p])
        let c = CenteredWrap(w, maxW: 540)
        return c
    }

    /// .fl-n: the step's number, blue once it is answered.
    private func number(_ n: String, _ ok: Bool) -> NSView {
        let b = Box(fill: ok ? "work" : "card2", radius: 11)
        b.translatesAutoresizingMaskIntoConstraints = false
        let l = label(n, Fonts.pt(12, .bold), ok ? "tx" : "tx2")
        if ok { l.textColor = .white }
        l.translatesAutoresizingMaskIntoConstraints = false
        b.addSubview(l)
        NSLayoutConstraint.activate([b.widthAnchor.constraint(equalToConstant: 22), b.heightAnchor.constraint(equalToConstant: 22),
                                     l.centerXAnchor.constraint(equalTo: b.centerXAnchor), l.centerYAnchor.constraint(equalTo: b.centerYAnchor)])
        return b
    }

    /// A line between the card's rows (border-top: 1px solid var(--sep)).
    func rule() -> NSView {
        let b = Box(fill: "sep")
        b.translatesAutoresizingMaskIntoConstraints = false
        b.heightAnchor.constraint(equalToConstant: 1).isActive = true
        return b
    }

    /// .fl-r: a number (or a tick) beside its column.
    func step(_ lead: NSView, _ col: [NSView], gap g: CGFloat = 9, insets: NSEdgeInsets = NSEdgeInsets(top: 16, left: 18, bottom: 16, right: 18)) -> NSView {
        let c = vstack(col, spacing: g)
        let lw = Flipped()
        lw.translatesAutoresizingMaskIntoConstraints = false
        lw.addSubview(lead)
        lead.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([lead.leadingAnchor.constraint(equalTo: lw.leadingAnchor), lead.trailingAnchor.constraint(equalTo: lw.trailingAnchor), lead.topAnchor.constraint(equalTo: lw.topAnchor, constant: 1)])
        let h = NSStackView(views: [lw, c])
        h.orientation = .horizontal
        h.alignment = .top
        h.spacing = 14
        h.edgeInsets = insets
        h.translatesAutoresizingMaskIntoConstraints = false
        lw.heightAnchor.constraint(greaterThanOrEqualToConstant: 23).isActive = true
        // The column takes the rest of the row (.fl-c's flex: 1).
        c.trailingAnchor.constraint(equalTo: h.trailingAnchor, constant: -insets.right).isActive = true
        return h
    }

    private func card() -> NSView {
        let first = folder != nil
        // 1 Folder: up to three picks, the one picked among them.
        var picks = Array(folders.prefix(3))
        if let f = folder, !picks.contains(where: { $0["path"] as? String == f }) { picks.insert(entry(f), at: 0) }
        var col1: [NSView] = [label(t("start.folder"), Fonts.pt(13.5, Fonts.w650))]
        if !picks.isEmpty {
            let rows = picks.map { f -> NSView in
                let path = f["path"] as? String ?? ""
                let r = Row(radius: 6)
                r.key = "folder:\(path)"
                r.selected = path == folder
                r.setAccessibilityLabel(f["name"] as? String ?? path)
                r.onOpen = { [weak self] in self?.pick(folder: path) }
                let radio = Box(fill: r.selected ? "work" : nil, ring: r.selected ? "work" : "tx3", radius: 7)
                radio.ringWidth = 1.5
                radio.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([radio.widthAnchor.constraint(equalToConstant: 14), radio.heightAnchor.constraint(equalToConstant: 14)])
                if r.selected {
                    let dot = Box(radius: 2.5); dot.rawFill = .white
                    dot.translatesAutoresizingMaskIntoConstraints = false
                    radio.addSubview(dot)
                    NSLayoutConstraint.activate([dot.widthAnchor.constraint(equalToConstant: 5), dot.heightAnchor.constraint(equalToConstant: 5),
                                                 dot.centerXAnchor.constraint(equalTo: radio.centerXAnchor), dot.centerYAnchor.constraint(equalTo: radio.centerYAnchor)])
                }
                let short = label(f["short"] as? String ?? path, Fonts.mono(11.5), "tx3")
                short.lineBreakMode = .byTruncatingHead
                short.setContentCompressionResistancePriority(.init(200), for: .horizontal)
                let line = hstack([radio, label(f["name"] as? String ?? path, Fonts.pt(13)), spring(), short], spacing: 10, insets: NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10))
                line.translatesAutoresizingMaskIntoConstraints = false
                r.addSubview(line)
                NSLayoutConstraint.activate([line.leadingAnchor.constraint(equalTo: r.leadingAnchor), line.trailingAnchor.constraint(equalTo: r.trailingAnchor),
                                             line.topAnchor.constraint(equalTo: r.topAnchor), line.bottomAnchor.constraint(equalTo: r.bottomAnchor)])
                controls[r.key] = r
                return r
            }
            col1.append(boxed(vstack(rows, spacing: 2), fill: "input", ring: "sep", radius: 10, insets: NSEdgeInsets(top: 6, left: 6, bottom: 6, right: 6)))
        }
        let choose = RButton(t("start.chooseAnother"), .link) { [weak self] in self?.choose() }
        choose.titleSize = 12
        controls["choose"] = choose
        let found = root != nil && !picks.isEmpty ? t("start.foundIn", ["root": root!]) + " " : ""
        col1.append(hstack([found.isEmpty ? nil : label(found, Fonts.pt(12), "tx3"), choose, label(t("start.orDrop"), Fonts.pt(12), "tx3"), spring()], spacing: 0))
        let row1 = step(number("1", first), col1)

        // 2 Assistant: a card each, the ones not here dimmed.
        let a = assistantPicked
        var col2: [NSView] = [label(t("start.assistant"), Fonts.pt(13.5, Fonts.w650))]
        if assistants.contains(where: { $0["found"] as? Bool == true }) {
            let cards = assistants.map { x -> NSView in
                let kind = x["kind"] as? String ?? ""
                let isFound = x["found"] as? Bool == true, signed = x["signedIn"] as? Bool == true
                let on = kind == assistant
                let b = PickBox(fill: "input", ring: on ? "work" : "sep", radius: 10)
                b.ringWidth = on ? 2 : 1
                b.enabled = isFound
                b.setAccessibilityLabel(x["name"] as? String ?? kind)
                b.onPress = { [weak self] in self?.pick(assistant: kind) }
                let dot = Box(fill: isFound && signed ? "ok" : isFound ? "you" : "idle", radius: 3.5)
                dot.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([dot.widthAnchor.constraint(equalToConstant: 7), dot.heightAnchor.constraint(equalToConstant: 7)])
                let s = isFound ? (signed ? t("start.signedIn") : t("start.notSignedIn")) : t("start.notHere")
                let inner = vstack([label(x["name"] as? String ?? kind, Fonts.pt(13.5, Fonts.w650)), hstack([dot, label(s, Fonts.pt(12), "tx2"), spring()], spacing: 6)], spacing: 4)
                inner.translatesAutoresizingMaskIntoConstraints = false
                b.addSubview(inner)
                NSLayoutConstraint.activate([inner.leadingAnchor.constraint(equalTo: b.leadingAnchor, constant: 12), inner.trailingAnchor.constraint(equalTo: b.trailingAnchor, constant: -12),
                                             inner.topAnchor.constraint(equalTo: b.topAnchor, constant: 11), inner.bottomAnchor.constraint(equalTo: b.bottomAnchor, constant: -11)])
                controls["assistant:\(kind)"] = b
                return b
            }
            let row = NSStackView(views: cards)
            row.orientation = .horizontal
            row.distribution = .fillEqually
            row.spacing = 10
            row.translatesAutoresizingMaskIntoConstraints = false
            col2.append(row)
        } else {
            col2.append(wrap(t("start.noAssistant"), Fonts.pt(12), "tx2"))
        }
        let row2 = step(number("2", a != nil), col2)

        // The branch line: its own copy, or right in the folder.
        var why: NSView?
        if let b = busyHere {
            let topic = b["topic"] as? String ?? "", project = b["project"] as? String ?? ""
            let bold = inFolder ? t("start.inFolderB") : t("start.ownCopyB")
            let rest = inFolder ? t("start.inFolder", ["topic": topic]) : t("start.ownCopy", ["topic": topic, "project": project])
            let txt = NSMutableAttributedString(string: bold, attributes: [.font: Fonts.pt(12.5, Fonts.w650), .foregroundColor: Design.color("tx")])
            txt.append(NSAttributedString(string: rest, attributes: [.font: Fonts.pt(12.5), .foregroundColor: Design.color("tx2")]))
            let p = NSMutableParagraphStyle(); p.minimumLineHeight = 19; p.maximumLineHeight = 19
            txt.addAttribute(.paragraphStyle, value: p, range: NSRange(location: 0, length: txt.length))
            let words = wrap("", Fonts.pt(12.5), "tx2")
            words.text.attributedStringValue = txt
            let link = RButton(inFolder ? t("start.ownCopyLink") : t("start.inFolderLink"), .link) { [weak self] in self?.setInFolder(!(self?.inFolder ?? false)) }
            link.titleSize = 12.5
            controls[inFolder ? "ownCopy" : "inFolder"] = link
            let icon = Icon("branch", "tx2", size: 14)
            why = step(icon, [words, hstack([link, spring()], spacing: 0)], gap: 0, insets: NSEdgeInsets(top: 12, left: 18, bottom: 12, right: 18))
            (why as? NSStackView)?.spacing = 10
        }

        // Start <assistant> in <folder>, the key, Cancel.
        let fname = folderName
        let title = a.flatMap { x in fname.map { t("start.goAssistant", ["assistant": name(x["kind"] as? String ?? ""), "folder": $0]) } }
            ?? fname.map { t("start.goShell", ["folder": $0]) } ?? t("start.goShellOnly")
        let goB = RButton(title, .primary) { [weak self] in self?.startSession() }
        goB.titleSize = 14
        goB.heightAnchor.constraint(greaterThanOrEqualToConstant: 38).isActive = true
        goB.isEnabled = !busy
        controls["go"] = goB
        let key = label(t("start.key", ["key": "⌘⇧N"]), Fonts.pt(12), "tx3")
        key.lineBreakMode = .byWordWrapping
        var goRow: [NSView?] = [goB, key, spring()]
        if onCancel != nil {
            let c = RButton(t("start.cancel"), .ghost) { [weak self] in self?.onCancel?() }
            controls["cancel"] = c
            goRow.append(c)
        }
        let goLine = hstack(goRow, spacing: 12, insets: NSEdgeInsets(top: 14, left: 18, bottom: 14, right: 18))

        var rows: [NSView] = [row1, rule(), row2]
        if let w = why { rows += [rule(), w] }
        rows += [rule(), goLine]
        let c = DropCard(fill: "card", radius: 14)
        c.layer?.masksToBounds = true
        let st = vstack(rows, spacing: 0)
        st.translatesAutoresizingMaskIntoConstraints = false
        c.addSubview(st)
        NSLayoutConstraint.activate([st.leadingAnchor.constraint(equalTo: c.leadingAnchor), st.trailingAnchor.constraint(equalTo: c.trailingAnchor),
                                     st.topAnchor.constraint(equalTo: c.topAnchor), st.bottomAnchor.constraint(equalTo: c.bottomAnchor)])
        return c
    }

    // MARK: macOS's question

    /// The folders macOS refused (the hub's state.access.denied), as "~/Documents".
    var denied: [String] {
        if let d = testDenied { return d }
        let a = hub?.state?.raw["access"] as? [String: Any]
        return (a?["denied"] as? [[String: Any]] ?? []).compactMap { $0["folder"] as? String }
    }

    static let privacyPane = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")!
    /// Opens the Privacy pane (the self-test records it instead).
    var openPrivacy: () -> Void = { NSWorkspace.shared.open(StartView.privacyPane) }

    /// The access card (app.ts accessCard, deniedNote): what macOS asks and
    /// where to answer it, or the folders it refused; nil when neither.
    private func accessCard() -> NSView? {
        let refused = denied
        guard asking != nil || !refused.isEmpty else { return nil }
        var col: [NSView] = []
        if let w = asking {
            col.append(wrap(t("start.askingT", ["folder": w]), Fonts.pt(13.5, Fonts.w650), "tx"))
            col.append(wrap(t("start.askingS", ["folder": w]), Fonts.pt(12.5), "tx2"))
        } else {
            col.append(wrap(t("start.denied", ["folders": refused.joined(separator: ", ")]), Fonts.pt(12.5), "tx2"))
        }
        let open = RButton(t("start.openPrivacy"), .normal) { [weak self] in self?.openPrivacy() }
        controls["openPrivacy"] = open
        col.append(hstack([open, spring()], spacing: 0))
        let icon = Icon("lock", "you", size: 15)
        let row = step(icon, col, gap: 8)
        let c = Box(fill: "card", ring: "you", radius: 14)
        c.ringWidth = 1
        c.layer?.masksToBounds = true
        row.translatesAutoresizingMaskIntoConstraints = false
        c.addSubview(row)
        NSLayoutConstraint.activate([row.leadingAnchor.constraint(equalTo: c.leadingAnchor), row.trailingAnchor.constraint(equalTo: c.trailingAnchor),
                                     row.topAnchor.constraint(equalTo: c.topAnchor), row.bottomAnchor.constraint(equalTo: c.bottomAnchor)])
        controls["access"] = c
        return c
    }

    // MARK: step 2

    private func setupCard(_ su: Setup) -> [NSView] {
        let who = name(su.kind)
        let fname = folderName ?? t("start.yourFolder")
        func tick(_ key: String, _ on: Bool, _ disabled: Bool) -> NSView {
            let b = PickBox(fill: on ? "work" : nil, ring: on ? nil : "tx3", radius: 5)
            b.ringWidth = 1.5
            b.dim = 0.7
            b.enabled = !disabled
            b.setAccessibilityRole(.checkBox)
            b.setAccessibilityValue(on ? 1 : 0)
            b.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([b.widthAnchor.constraint(equalToConstant: 18), b.heightAnchor.constraint(equalToConstant: 18)])
            if on {
                let i = Icon("check", "tx", size: 11)
                i.image = SharedIcons.image("check", color: "tx", size: 11, dark: true)
                b.addSubview(i)
                NSLayoutConstraint.activate([i.centerXAnchor.constraint(equalTo: b.centerXAnchor), i.centerYAnchor.constraint(equalTo: b.centerYAnchor)])
            }
            b.onPress = { [weak self] in
                guard var s = self?.setup else { return }
                if key == "hooks" { s.hooks.toggle() } else { s.skill.toggle() }
                self?.setup = s
                self?.draw()
            }
            controls["tick:\(key)"] = b
            return b
        }
        func para(_ s: NSAttributedString) -> NSView {
            let w = wrap("", Fonts.pt(12.5), "tx2")
            let m = NSMutableAttributedString(attributedString: s)
            let p = NSMutableParagraphStyle(); p.minimumLineHeight = 19; p.maximumLineHeight = 19
            m.addAttribute(.paragraphStyle, value: p, range: NSRange(location: 0, length: m.length))
            w.text.attributedStringValue = m
            return w
        }
        let plain: [NSAttributedString.Key: Any] = [.font: Fonts.pt(12.5), .foregroundColor: Design.color("tx2")]
        let mark = { (s: String, ok: Bool) -> NSView in label(s, ok ? Fonts.pt(11.5) : Fonts.mono(11.5), ok ? "ok" : "tx3") }
        let hooksLine = step(tick("hooks", su.hooksOn || su.hooks, su.hooksOn || su.hooksFile == nil || su.busy), [
            label(t("setup.hooksH", ["who": who]), Fonts.pt(13.5, Fonts.w650)),
            para(NSAttributedString(string: t("setup.hooksP", ["who": who]), attributes: plain)),
            su.hooksOn ? mark(t("setup.hooksDone"), true) : su.hooksFile.map { mark(t("setup.hooksAdds", ["file": $0]), false) } ?? mark(t("setup.hooksNeeds"), false),
        ], gap: 5)
        (hooksLine as? NSStackView)?.spacing = 12
        let skillP = NSMutableAttributedString(string: t("setup.skillP", ["who": who]), attributes: plain)
        skillP.append(NSAttributedString(string: "ravenry skill", attributes: [.font: Fonts.mono(11.5), .foregroundColor: Design.color("tx2")]))
        skillP.append(NSAttributedString(string: t("setup.skillP2"), attributes: plain))
        let newTag = boxed(label(t("setup.new"), Fonts.pt(11, .semibold), "work"), fill: "work-t", radius: 5, insets: NSEdgeInsets(top: 1, left: 6, bottom: 1, right: 6))
        let skillLine = step(tick("skill", su.skillOn || su.skill, su.skillOn || su.busy), [
            hstack([label(t("setup.skillH"), Fonts.pt(13.5, Fonts.w650)), newTag, spring()], spacing: 8),
            para(skillP),
            su.skillOn ? mark(t("setup.skillDone"), true) : mark(t("setup.skillAdds", ["dir": su.skillDir]), false),
        ], gap: 5)
        (skillLine as? NSStackView)?.spacing = 12
        let yes = RButton(t("setup.yes"), .primary) { [weak self] in self?.answerSetup(true) }
        yes.titleSize = 14
        yes.heightAnchor.constraint(greaterThanOrEqualToConstant: 38).isActive = true
        let no = RButton(t("setup.no"), .ghost) { [weak self] in self?.answerSetup(false) }
        no.titleSize = 13
        yes.isEnabled = !su.busy; no.isEnabled = !su.busy
        controls["setUp"] = yes; controls["notNow"] = no
        let then = label(t("setup.then", ["who": who, "folder": fname]), Fonts.pt(12), "tx3")
        let goLine = hstack([yes, no, spring(), then], spacing: 12, insets: NSEdgeInsets(top: 14, left: 18, bottom: 14, right: 18))
        let c = Box(fill: "card", radius: 14)
        c.layer?.masksToBounds = true
        let st = vstack([hooksLine, rule(), skillLine, rule(), goLine], spacing: 0)
        st.translatesAutoresizingMaskIntoConstraints = false
        c.addSubview(st)
        NSLayoutConstraint.activate([st.leadingAnchor.constraint(equalTo: c.leadingAnchor), st.trailingAnchor.constraint(equalTo: c.trailingAnchor),
                                     st.topAnchor.constraint(equalTo: c.topAnchor), st.bottomAnchor.constraint(equalTo: c.bottomAnchor)])
        // Step 2 of 2: two dots, the second lit.
        func dot(_ on: Bool) -> NSView {
            let d = Box(fill: on ? "work" : "tx3", radius: 3)
            d.alphaValue = on ? 1 : 0.5
            d.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([d.widthAnchor.constraint(equalToConstant: 6), d.heightAnchor.constraint(equalToConstant: 6)])
            return d
        }
        var out: [NSView] = [gap(18), centred(label(t("setup.title", ["who": who]), Fonts.pt(26, .bold))), gap(8),
                             lead(t("setup.lead", ["who": who, "folder": fname])), gap(26), c]
        if let e = su.error { out += [gap(10), centred(wrap(e, Fonts.pt(12.5), "bad"))] }
        out += [gap(18), lead(t("setup.foot"), size: 12.5, color: "tx3"), gap(12),
                centred(hstack([dot(false), dot(true), label(t("setup.steps"), Fonts.pt(12), "tx2")], spacing: 6))]
        return out
    }

    // MARK: what the person does

    func pick(folder p: String) {
        folder = p
        error = nil
        draw()
    }

    func pick(assistant k: String) {
        guard assistants.contains(where: { $0["kind"] as? String == k && $0["found"] as? Bool == true }) else { return }
        assistant = k
        draw()
    }

    func setInFolder(_ v: Bool) {
        inFolder = v
        draw()
    }

    /// A folder from elsewhere: the hub says it again, first, with whether a session works there.
    func take(folder p: String) {
        folder = p
        error = nil
        draw()
        load(p)
    }

    private func choose() {
        if let c = testChoice { take(folder: c); return }
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        // A new folder can be made there; it opens on the folder picked, else home (main.ts chooseFolder).
        p.canCreateDirectories = true
        p.prompt = t("start.choosePrompt")
        p.directoryURL = URL(fileURLWithPath: folder.map { ($0 as NSString).deletingLastPathComponent } ?? localHome, isDirectory: true)
        guard let w = window else { return }
        p.beginSheetModal(for: w) { [weak self] r in
            guard r == .OK, let u = p.url else { return }
            self?.take(folder: u.path)
        }
    }

    // A folder dropped on the card (or anywhere on the screen): it is the one.
    override func draggingEntered(_ s: NSDraggingInfo) -> NSDragOperation { folderIn(s) == nil ? [] : .copy }
    override func performDragOperation(_ s: NSDraggingInfo) -> Bool {
        guard let p = folderIn(s) else { return false }
        take(folder: p)
        return true
    }
    private func folderIn(_ s: NSDraggingInfo) -> String? { folder(in: s.draggingPasteboard) }
    /// A folder on a pasteboard (a drop's), if the first file there is one.
    func folder(in pb: NSPasteboard) -> String? {
        guard setup == nil, let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], let u = urls.first else { return nil }
        var dir: ObjCBool = false
        return FileManager.default.fileExists(atPath: u.path, isDirectory: &dir) && dir.boolValue ? u.path : nil
    }

    /// The stable ravenryd the hooks name (AppInstall.hookRavenryd), not the one inside the app.
    private var ravenryd: String { AppInstall.shared.hookRavenryd }

    /// Step 2 for an assistant, unless it was answered before or both are on.
    private func setupStep(_ kind: String, _ done: @escaping (Setup?) -> Void) {
        hub?.get("/api/onboarding") { [weak self] code, o in
            guard let self else { return }
            if (o["setup"] as? [String: Any])?[kind] as? Bool == true { done(nil); return }
            let q = "/api/setup/skills?ravenryd=\(self.ravenryd.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")"
            self.hub?.get(q) { code, j in
                guard code == 200, let r = (j["skills"] as? [[String: Any]] ?? []).first(where: { $0["kind"] as? String == kind }) else { done(nil); return }
                let hk = r["hooks"] as? String ?? "unavailable"
                let hooksOn = hk == "on", installed = r["installed"] as? Bool == true, skillOn = r["ours"] as? Bool == true || installed
                if hooksOn && skillOn { done(nil); return }
                done(Setup(kind: kind, hooks: hk != "unavailable", skill: !installed, hooksOn: hooksOn, skillOn: skillOn, hooksFile: r["hooksFile"] as? String, skillDir: r["dir"] as? String ?? ""))
            }
        }
    }

    private func answerSetup(_ yes: Bool) {
        guard var su = setup, !su.busy else { return }
        let finish = { [weak self] in
            guard let self else { return }
            self.hub?.post("/api/onboarding", ["setup": [su.kind: true]]) { _, _ in }
            // The hooks or the skill set up here: the panel says so at once.
            SettingsWindow.said("hooks")
            self.setup = nil
            self.setupReady = true
            self.startSession()
        }
        guard yes else { finish(); return }
        su.busy = true; su.error = nil
        setup = su
        draw()
        let fail = { [weak self] (msg: String) in
            guard let self, var s = self.setup else { return }
            s.busy = false; s.error = msg
            self.setup = s
            self.draw()
        }
        let skill = { [weak self] in
            guard let self else { return }
            guard su.skill && !su.skillOn else { finish(); return }
            let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
            self.hub?.post("/api/setup/skills", ["kind": su.kind, "on": true, "ravenryd": self.ravenryd, "version": version]) { code, j in
                if code != 200 { fail(t("setup.skillFailed", ["why": j["error"] as? String ?? "\(code)"])); return }
                finish()
            }
        }
        guard su.hooks && !su.hooksOn else { skill(); return }
        hub?.post("/api/setup/hooks", ["ravenryd": ravenryd, "only": su.kind]) { code, j in
            if code != 200 { fail(t("setup.hooksFailed", ["why": j["error"] as? String ?? "\(code)"])); return }
            skill()
        }
    }

    func startSession() {
        guard !busy else { return }
        busy = true
        error = nil
        draw()
        let a = assistantPicked
        // The board down: the assistant in a pane of this window, as the Electron app's.
        if local {
            busy = false
            draw()
            guard let kind = a?["kind"] as? String else { onShell?(folder); return }
            let path = a?["path"] as? String ?? kind
            let prog = Workspace.Program(command: [path], name: a?["name"] as? String ?? name(kind), agent: kind)
            if let run = onRun { run(folder, prog); return }
            (window?.contentView as? RootView)?.workspace?.newTab(in: folder ?? localHome, program: prog)
            onCancel?()
            return
        }
        if let kind = a?["kind"] as? String, !setupReady {
            setupStep(kind) { [weak self] su in
                guard let self else { return }
                if let su { self.busy = false; self.setup = su; self.draw(); return }
                self.setupReady = true
                self.busy = false
                self.startSession()
            }
            return
        }
        setupReady = false
        guard let kind = a?["kind"] as? String else {
            busy = false
            draw()
            onShell?(folder)
            return
        }
        let g = grid()
        var body: [String: Any] = ["folder": folder ?? NSHomeDirectory(), "assistant": kind, "cols": g.cols, "rows": g.rows]
        if let b = busyHere, !inFolder, let pid = b["projectId"] as? String { body["worktree"] = true; body["projectId"] = pid }
        hub?.post("/api/sessions/start", body) { [weak self] code, j in
            guard let self else { return }
            self.busy = false
            if code != 200 {
                self.error = t("start.failed", ["why": j["error"] as? String ?? "the board answered \(code)"])
                self.draw()
                return
            }
            self.draw()
            let key = (j["projectId"] as? String).flatMap { pid in (j["surfaceId"] as? String).map { "\(pid)/\($0)" } }
            self.onStarted?(key, (j["pane"] as? [String: Any])?["id"] as? String)
        }
    }
}

/// The card a folder can be dropped on (its view, StartView, takes the drop).
final class DropCard: Box {}

/// Centred words at most `maxW` wide (.lead).
final class CenteredWrap: Flipped {
    let text: WrapField
    private let maxW: CGFloat
    init(_ t: WrapField, maxW: CGFloat) {
        text = t; self.maxW = maxW
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        t.translatesAutoresizingMaskIntoConstraints = false
        addSubview(t)
        let w = t.widthAnchor.constraint(equalTo: widthAnchor); w.priority = .init(700)
        NSLayoutConstraint.activate([t.centerXAnchor.constraint(equalTo: centerXAnchor), t.topAnchor.constraint(equalTo: topAnchor), t.bottomAnchor.constraint(equalTo: bottomAnchor),
                                     t.widthAnchor.constraint(lessThanOrEqualToConstant: maxW), t.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor), w])
    }
    required init?(coder: NSCoder) { fatalError() }
    override func layout() {
        let w = max(40, min(maxW, bounds.width))
        if abs(text.preferredMaxLayoutWidth - w) > 0.5 { text.preferredMaxLayoutWidth = w; text.invalidateIntrinsicContentSize() }
        super.layout()
    }
}

/// What Start offers with the board down, read here by the hub's own rules
/// (hub/server/firstlaunch.mjs startView, findProjectFolders,
/// findAssistants): at most five folders that look like projects, newest
/// first, from the first of the usual project roots that has any; Claude
/// Code and Codex, found on the PATH or in the usual folders, and signed in
/// when their own login files say so.
enum LocalStart {
    static let roots = ["code", "Code", "Projects", "projects", "Developer", "dev", "src", "repos", "git", "work"]
    static let markers = [".git", "package.json", "go.mod", "Cargo.toml", "pyproject.toml", "README.md"]

    /// A folder as people read it (public/homepath.mjs sayPath).
    static func say(_ p: String, home: String) -> String {
        let h = home.hasSuffix("/") ? String(home.dropLast()) : home
        if p.isEmpty || h.isEmpty { return p }
        if p == h { return "~" }
        if p.hasPrefix(h + "/") { return "~" + p.dropFirst(h.count) }
        return p
    }

    static func projectFolders(home: String, max: Int = 5) -> (root: String?, folders: [[String: Any]]) {
        let fm = FileManager.default
        for r in roots.map({ (home as NSString).appendingPathComponent($0) }) {
            guard let names = try? fm.contentsOfDirectory(atPath: r) else { continue }
            var found: [(String, Date)] = []
            for n in names where !n.hasPrefix(".") {
                let p = (r as NSString).appendingPathComponent(n)
                var dir: ObjCBool = false
                guard fm.fileExists(atPath: p, isDirectory: &dir), dir.boolValue,
                      markers.contains(where: { fm.fileExists(atPath: (p as NSString).appendingPathComponent($0)) }) else { continue }
                let t = (try? fm.attributesOfItem(atPath: p)[.modificationDate] as? Date) ?? .distantPast
                found.append((p, t))
            }
            if found.isEmpty { continue }
            found.sort { $0.1 > $1.1 }
            return (r, found.prefix(max).map { pick($0.0, home: home) })
        }
        return (nil, [])
    }

    static func pick(_ p: String, home: String) -> [String: Any] {
        ["name": (p as NSString).lastPathComponent, "path": p, "short": say(p, home: home)]
    }

    static func onPath(_ bin: String, env: [String: String], home: String) -> String? {
        let dirs = (env["PATH"] ?? "").split(separator: ":").map(String.init) + [
            "\(home)/.local/bin", "\(home)/.claude/local", "/opt/homebrew/bin", "/usr/local/bin", "\(home)/.npm-global/bin", "\(home)/.volta/bin"]
        for d in dirs where !d.isEmpty {
            let p = (d as NSString).appendingPathComponent(bin)
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        return nil
    }

    static func assistants(env: [String: String], home: String) -> [[String: Any]] {
        let claude = onPath("claude", env: env, home: home), codex = onPath("codex", env: env, home: home)
        var claudeIn = !(env["ANTHROPIC_API_KEY"] ?? "").isEmpty
        if !claudeIn, let s = try? String(contentsOfFile: "\(home)/.claude.json", encoding: .utf8) {
            claudeIn = s.range(of: #""oauthAccount"\s*:\s*\{"#, options: .regularExpression) != nil
        }
        let codexHome = env["CODEX_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? "\(home)/.codex"
        let codexIn = !(env["OPENAI_API_KEY"] ?? "").isEmpty || FileManager.default.fileExists(atPath: "\(codexHome)/auth.json")
        return [
            ["kind": "claude", "name": "Claude Code", "found": claude != nil, "signedIn": claude != nil && claudeIn, "path": claude ?? NSNull()],
            ["kind": "codex", "name": "Codex", "found": codex != nil, "signedIn": codex != nil && codexIn, "path": codex ?? NSNull()],
        ]
    }

    /// The Start screen's answer, as GET /api/setup/start gives it (without the board's own folders).
    static func view(home: String, env: [String: String], want: String?, max: Int = 5) -> [String: Any] {
        let found = projectFolders(home: home, max: max)
        var folders = found.folders
        if let w = want, w.hasPrefix("/"), !folders.contains(where: { $0["path"] as? String == w }) { folders = Array(([pick(w, home: home)] + folders).prefix(max)) }
        return ["root": found.root.map { say($0, home: home) } as Any, "folders": folders, "assistants": assistants(env: env, home: home)]
    }
}
