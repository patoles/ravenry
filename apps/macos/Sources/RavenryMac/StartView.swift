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
    /// The controls by name, for the self-test: "folder:<path>", "assistant:<kind>", "choose", "go", "cancel",
    /// "inFolder", "ownCopy", "tick:hooks", "tick:skill", "setUp", "notNow".
    private(set) var controls: [String: NSView] = [:]
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
        setup = nil
        setupReady = false
        error = nil
        busy = false
        inFolder = false
        if let f = want { folder = f }
        draw()
        load(want)
    }

    /// The hub's folders and assistants, the one asked for first.
    private func load(_ want: String?) {
        let q = want.map { "/api/setup/start?folder=\($0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")" } ?? "/api/setup/start"
        hub?.get(q) { [weak self] code, j in
            guard let self, code == 200 else { return }
            self.folders = j["folders"] as? [[String: Any]] ?? []
            self.root = j["root"] as? String
            self.assistants = j["assistants"] as? [[String: Any]] ?? []
            if let w = want { self.folder = w }
            if self.folder == nil || !self.folders.contains(where: { $0["path"] as? String == self.folder }) { self.folder = self.folders.first?["path"] as? String ?? self.folder }
            let found = self.assistants.filter { $0["found"] as? Bool == true }
            let ready = found.first { $0["signedIn"] as? Bool == true } ?? found.first
            if self.assistant == nil || !found.contains(where: { $0["kind"] as? String == self.assistant }) { self.assistant = ready?["kind"] as? String }
            self.read = true
            self.draw()
        }
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
            items.append(card())
            if let e = error { items.append(gap(10)); items.append(centred(wrap(e, Fonts.pt(12.5), "bad"))) }
            items.append(gap(18))
            items.append(lead(t("start.foot"), size: 12.5, color: "tx3"))
        }
        for v in column.subviews { v.removeFromSuperview() }
        let s = vstack(items, spacing: 0)
        column.addSubview(s)
        NSLayoutConstraint.activate([s.leadingAnchor.constraint(equalTo: column.leadingAnchor), s.trailingAnchor.constraint(equalTo: column.trailingAnchor),
                                     s.topAnchor.constraint(equalTo: column.topAnchor), s.bottomAnchor.constraint(equalTo: column.bottomAnchor)])
        needsLayout = true
    }

    private func gap(_ h: CGFloat) -> NSView {
        let v = NSView()
        v.translatesAutoresizingMaskIntoConstraints = false
        v.heightAnchor.constraint(equalToConstant: h).isActive = true
        return v
    }
    private func centred(_ v: NSView) -> NSView {
        let w = Flipped()
        w.translatesAutoresizingMaskIntoConstraints = false
        v.translatesAutoresizingMaskIntoConstraints = false
        w.addSubview(v)
        NSLayoutConstraint.activate([v.centerXAnchor.constraint(equalTo: w.centerXAnchor), v.topAnchor.constraint(equalTo: w.topAnchor), v.bottomAnchor.constraint(equalTo: w.bottomAnchor),
                                     v.widthAnchor.constraint(lessThanOrEqualTo: w.widthAnchor)])
        return w
    }
    /// .lead: centred words, at most 540 wide.
    private func lead(_ s: String, size: CGFloat = 14.5, color: String = "tx2") -> NSView {
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
    private func rule() -> NSView {
        let b = Box(fill: "sep")
        b.translatesAutoresizingMaskIntoConstraints = false
        b.heightAnchor.constraint(equalToConstant: 1).isActive = true
        return b
    }

    /// .fl-r: a number (or a tick) beside its column.
    private func step(_ lead: NSView, _ col: [NSView], gap g: CGFloat = 9, insets: NSEdgeInsets = NSEdgeInsets(top: 16, left: 18, bottom: 16, right: 18)) -> NSView {
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
            label(t("setup.hooksH"), Fonts.pt(13.5, Fonts.w650)),
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

    private var ravenryd: String { Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/ravenryd").path }

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
