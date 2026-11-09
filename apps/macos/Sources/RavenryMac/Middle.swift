// What the middle shows when it is not a tab's terminal, as the Electron
// app draws it (apps/desktop/src/renderer/app.ts renderElsewhere,
// renderProject, renderStart; app.css .elsewhere, .pa):
//
// - a session in cmux, iTerm2 or Rex (or in a ravenryd this window does not
//   draw): read only, its screen from the hub's Live screen (GET /api/live)
//   or its transcript, with Open in <terminal> and Move here;
// - a project no session runs in: its last conversation (GET
//   /api/project/last) with Continue this conversation (or Move here when it
//   is still open elsewhere), New session and Open brief;
// - New session: a folder and an assistant, started by the hub
//   (POST /api/sessions/start);
// - a page this window does not draw yet: a native placeholder naming it.

import AppKit

/// The middle's base: the terminal's background, a stack of its content.
class MiddleView: Box {
    let content = StackScroll(spacing: 10, insets: NSEdgeInsets(top: 18, left: 22, bottom: 18, right: 22))
    init(sheet: Bool = false) {
        super.init(fill: sheet ? "sheet" : "term-bg")
        addSubview(content)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func layout() { super.layout(); content.frame = bounds }
}

private let termTx = NSColor(srgbRed: 0xD1 / 255, green: 0xD1 / 255, blue: 0xD6 / 255, alpha: 1)
private let termTx2 = NSColor(srgbRed: 0xA1 / 255, green: 0xA1 / 255, blue: 0xA8 / 255, alpha: 1)
private let termTx3 = NSColor(srgbRed: 0x8E / 255, green: 0x8E / 255, blue: 0x93 / 255, alpha: 1)

/// A session outside this window: read only.
final class OutsideView: MiddleView {
    private(set) var buttons: [String: RButton] = [:]
    private(set) var surface = ""
    private var entries: [[String: Any]]?
    private var timer: Timer?
    var hub: HubClient?
    var onOpen: ((HubProject, HubSession) -> Void)?
    var onMove: ((HubProject, HubSession) -> Void)?
    private var last: (HubProject, HubSession, String?)?
    var moving = Set<String>()

    /// Shows the session; `why` says why its pane is not drawn here (another ravenryd).
    func show(_ p: HubProject, _ s: HubSession, why: String?) {
        if surface != s.surfaceId { entries = nil; surface = s.surfaceId; follow() }
        last = (p, s, why)
        draw()
    }

    func stop() { timer?.invalidate(); timer = nil; surface = "" }

    private func follow() {
        timer?.invalidate()
        let read = { [weak self] in
            guard let self, !self.surface.isEmpty, let h = self.hub else { return }
            let sf = self.surface
            h.get("/api/live?surface=\(sf.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? sf)") { [weak self] code, j in
                guard let self, self.surface == sf, code == 200, let e = j["entries"] as? [[String: Any]] else { return }
                self.entries = e
                self.draw()
            }
        }
        read()
        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { _ in read() }
    }

    private func draw() {
        guard let (p, s, why) = last else { return }
        buttons = [:]
        let m = s.machine ?? p.machine
        let whereName = m.map { "a terminal on \($0)" } ?? s.termName ?? "another terminal"
        let out = s.outside
        let open = (out?["open"] as? Bool) ?? true
        let folder = p.folderShort.map { ", in \($0)" } ?? ""
        let sub = out != nil && !open ? t("else.ran", ["where": whereName, "folder": folder]) : t("else.runs", ["where": whereName, "folder": folder])
        let title = label(s.topic ?? p.name, Fonts.pt(15, Fonts.w650))
        title.textColor = NSColor(srgbRed: 0xF2 / 255, green: 0xF2 / 255, blue: 0xF4 / 255, alpha: 1)
        let subL = label(sub, Fonts.pt(13), "tx2"); subL.textColor = termTx2
        var acts: [NSView?] = []
        if m == nil, let term = s.term, ["cmux", "iterm", "iterm2", "rex"].contains(term.lowercased()) || s.termName != nil, why == nil {
            let b = RButton(t("else.open", ["where": whereName]), .normal) { [weak self] in self?.onOpen?(p, s) }
            buttons["open"] = b
            acts.append(b)
        }
        let kindOk = (s.assistant ?? "claude").hasPrefix("claude") || (s.assistant ?? "").hasPrefix("codex")
        let canResume = out != nil && s.sessionId != nil && kindOk
        if out != nil {
            let busy = moving.contains(s.sessionId ?? "")
            let w = s.moving?["waiting"] as? Bool ?? false
            let b = RButton(w ? t("move.waiting", ["who": s.assistant == "codex" ? "Codex" : "Claude", "other": whereName]) : busy ? t("move.moving") : t("move.here"),
                            canResume && !w ? .primary : .normal) { [weak self] in self?.onMove?(p, s) }
            b.isEnabled = canResume && !busy && !w
            buttons["move"] = b
            acts.append(b)
        }
        let words = vstack([title, subL], spacing: 4)
        words.setContentHuggingPriority(.init(1), for: .horizontal)
        let head = hstack([words] + acts, spacing: 16)
        head.alignment = .top
        var rows: [NSView] = [head]
        if out != nil && canResume {
            let n = label(t("else.moveNote", ["where": whereName]), Fonts.pt(12.5, .medium), "tx2", lines: 2); n.textColor = termTx2
            rows.append(hstack([Icon("done", "tx2", size: 14), n], spacing: 7))
        }
        if let w = why { let l = label(t("else.otherDaemon", ["why": w]), Fonts.pt(12.5), "you", lines: 3); rows.append(l) }
        if let c = s.cannot, s.terminal == false || entries == nil, open { let l = label(c, Fonts.pt(12.5), "tx3", lines: 3); l.textColor = termTx3; rows.append(l) }
        // Its screen when it has something on it; else its transcript.
        let cap: String
        var lines: [(String, String, NSColor)] = []
        if let e = entries, !e.isEmpty {
            cap = t("else.live", ["term": s.termName ?? "its terminal"])
            for x in e {
                let text = (x["l"] as? [String] ?? []).joined(separator: "\n")
                switch x["k"] as? String ?? "" {
                case "u": lines.append(("❯", text, NSColor(srgbRed: 0xF2 / 255, green: 0xF2 / 255, blue: 0xF4 / 255, alpha: 1)))
                case "c": lines.append(((x["orphan"] as? Bool ?? false) ? " " : "⏺", text, termTx))
                case "r": lines.append(("※", "recap: \(text)", termTx2))
                case "s": lines.append((x["g"] as? String ?? "✻", x["t"] as? String ?? "", termTx2))
                case "o": lines.append(("⎿", x["t"] as? String ?? "", termTx2))
                case "t": lines.append(("⏺", (x["b"] as? String) ?? "\(x["n"] as? String ?? "") \(x["a"] as? String ?? "")", termTx2))
                default: lines.append((" ", text, termTx))
                }
            }
        } else if !s.screen.isEmpty {
            cap = t("else.live", ["term": s.termName ?? "its terminal"])
            lines = [(" ", s.screen.joined(separator: "\n"), termTx)]
        } else {
            cap = t("else.transcript")
            for c in s.conversation {
                if let a = c["ask"] as? String { lines.append(("❯", a, NSColor.white)) }
                if let x = c["text"] as? String { lines.append(("⏺", x, termTx)) }
            }
        }
        // The discussion sits at the bottom of the middle (.else-disc), under a gap.
        let gap = NSView()
        gap.translatesAutoresizingMaskIntoConstraints = false
        let gapH = gap.heightAnchor.constraint(equalToConstant: 0)
        gapH.isActive = true
        rows.append(gap)
        let capL = label(cap, Fonts.pt(11, .semibold), "tx3"); capL.textColor = termTx3
        let capLine = Box(fill: nil); capLine.rawFill = NSColor(white: 1, alpha: 0.08)
        capLine.translatesAutoresizingMaskIntoConstraints = false
        capLine.heightAnchor.constraint(equalToConstant: 1).isActive = true
        rows.append(vstack([capL, capLine], spacing: 3))
        for (g, text, color) in lines.suffix(80) {
            let gl = label(g, Fonts.mono(12.5)); gl.textColor = termTx3
            gl.widthAnchor.constraint(equalToConstant: 16).isActive = true
            let tl = label(text, Fonts.mono(12.5), "tx", lines: 0, select: true); tl.textColor = color
            tl.preferredMaxLayoutWidth = max(200, bounds.width - 44 - 22)
            let r = hstack([gl, tl], spacing: 6, insets: g == "❯" ? NSEdgeInsets(top: 5, left: 6, bottom: 5, right: 8) : NSEdgeInsetsZero); r.alignment = .top
            if g == "❯" {
                let b = boxed(r, fill: nil, radius: 6, insets: NSEdgeInsetsZero)
                b.rawFill = NSColor(white: 1, alpha: 0.06)
                rows.append(b)
            } else { rows.append(r) }
        }
        let atBottom = content.contentView.bounds.maxY >= (content.documentView?.frame.height ?? 0) - 40
        content.set(rows)
        gapH.constant = max(0, content.bounds.height - content.stack.fittingSize.height)
        content.stack.layoutSubtreeIfNeeded()
        if atBottom, let d = content.documentView { content.contentView.scroll(to: NSPoint(x: 0, y: max(0, d.frame.height - content.contentView.bounds.height))) }
    }
}

/// A project no session runs in: its last conversation.
final class ProjectPageView: MiddleView {
    private(set) var buttons: [String: RButton] = [:]
    private(set) var projectId = ""
    var hub: HubClient?
    var onContinue: ((HubProject, [String: Any]) -> Void)?
    var onMoveLast: ((HubProject, [String: Any]) -> Void)?
    var onNewHere: ((HubProject) -> Void)?
    var onBrief: ((HubProject) -> Void)?
    var onShowSession: ((String) -> Void)?
    var busy = false
    var error: String?
    private var last: [String: Any]?
    private var loaded = false
    private var asked = Date.distantPast

    init() { super.init(sheet: true) }
    required init?(coder: NSCoder) { fatalError() }

    func show(_ p: HubProject) {
        if projectId != p.id { projectId = p.id; last = nil; loaded = false; error = nil; busy = false; asked = .distantPast }
        if Date().timeIntervalSince(asked) > 15 {
            asked = Date()
            hub?.get("/api/project/last?projectId=\(p.id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? p.id)") { [weak self] code, j in
                guard let self, self.projectId == p.id else { return }
                self.last = code == 200 ? j["last"] as? [String: Any] : nil
                self.loaded = true
                self.draw(p)
            }
        }
        draw(p)
    }

    private func centred(_ v: NSView) -> [NSView] {
        let wrap = Flipped()
        wrap.translatesAutoresizingMaskIntoConstraints = false
        v.translatesAutoresizingMaskIntoConstraints = false
        wrap.addSubview(v)
        let top = max(24, (bounds.height - 260) / 2)
        NSLayoutConstraint.activate([v.centerXAnchor.constraint(equalTo: wrap.centerXAnchor), v.widthAnchor.constraint(equalToConstant: min(560, max(200, bounds.width - 48))),
                                     v.topAnchor.constraint(equalTo: wrap.topAnchor, constant: top), v.bottomAnchor.constraint(equalTo: wrap.bottomAnchor)])
        return [wrap]
    }

    func draw(_ p: HubProject) {
        buttons = [:]
        let name = label(p.name, Fonts.pt(20, .bold))
        var head: [NSView?] = [name, p.folderShort.map { label($0, Fonts.pt(13), "tx3") }]
        if let s = p.sessions.first(where: { !$0.handed }) {
            head.append(label(t("project.runsIn"), Fonts.pt(13)))
            let b = RButton(t("project.showSession"), .primary) { [weak self] in self?.onShowSession?("\(p.id)/\(s.surfaceId)") }
            buttons["show"] = b
            content.set(centred(vstack(head + [hstack([b, spring()], spacing: 0)], spacing: 14)))
            return
        }
        guard loaded else {
            content.set(centred(vstack(head + [label(t("project.looking"), Fonts.pt(13), "tx3")], spacing: 14)))
            return
        }
        let newHere = p.folder != nil && p.machine == nil
        let brief = p.brief != nil ? RButton(t("panel.openBrief"), .link) { [weak self] in self?.onBrief?(p) } : nil
        if let b = brief { buttons["brief"] = b }
        guard let l = last else {
            var acts: [NSView?] = []
            if newHere { let b = RButton(t("project.newHere"), .primary) { [weak self] in self?.onNewHere?(p) }; buttons["new"] = b; acts.append(b) }
            if p.brief != nil { let b = RButton(t("panel.openBrief")) { [weak self] in self?.onBrief?(p) }; buttons["brief"] = b; acts.append(b) }
            acts.append(spring())
            content.set(centred(vstack(head + [label(t("project.noEarlier"), Fonts.pt(13)), hstack(acts, spacing: 10)], spacing: 14)))
            return
        }
        let who = (l["assistant"] as? String) == "codex" ? "Codex" : "Claude"
        let openIn = l["openIn"] as? [String: Any]
        let outside = openIn.flatMap { ($0["ravenry"] as? Bool ?? false) ? nil : ($0["name"] as? String ?? "another terminal") }
        let conv = vstack([
            hstack([label(l["title"] as? String ?? "", Fonts.pt(13.5, Fonts.w650)), boxed(label(who, Fonts.pt(11, .semibold), "tx2"), fill: nil, ring: "sep", radius: 5, insets: NSEdgeInsets(top: 3, left: 7, bottom: 3, right: 7)),
                    spring(), label(t("project.stoppedAt", ["when": When.stopped(l["stoppedAt"] as? String)]), Fonts.pt(12, .medium), "tx3")], spacing: 8),
            (l["lastPrompt"] as? String).map { said(t("project.you"), $0, "tx") },
            (l["lastText"] as? String).map { said(who, $0, "tx2") },
        ], spacing: 10)
        var rows: [NSView?] = head + [boxed(conv, fill: "card", radius: 12, insets: NSEdgeInsets(top: 14, left: 16, bottom: 14, right: 16))]
        if let o = outside { rows.append(label(t("project.stillOpen", ["where": o]), Fonts.pt(12.5), "you")) }
        let main: RButton
        if let o = outside {
            main = RButton(busy ? t("move.moving") : t("move.here"), .primary) { [weak self] in self?.onMoveLast?(p, l) }
            _ = o
        } else {
            main = RButton(busy ? t("project.continuing") : t("project.continue"), .primary) { [weak self] in self?.onContinue?(p, l) }
        }
        main.isEnabled = !busy
        buttons["continue"] = main
        var acts: [NSView?] = [main]
        if newHere { let b = RButton(t("project.newSession")) { [weak self] in self?.onNewHere?(p) }; buttons["new"] = b; acts.append(b) }
        acts.append(spring())
        acts.append(brief)
        rows.append(hstack(acts, spacing: 10))
        if let e = error { rows.append(label(e, Fonts.pt(12.5), "bad", lines: 3)) }
        let cmd = (outside.map { t("project.movesIn", ["where": $0]) } ?? t("project.continuesIn")) + (l["command"] as? String ?? "") + t("project.inFolder", ["folder": l["folderShort"] as? String ?? ""])
        rows.append(label(cmd, Fonts.pt(11.5), "tx3", lines: 3))
        content.set(centred(vstack(rows, spacing: 14)))
    }

    private func said(_ who: String, _ text: String, _ color: String) -> NSView {
        let w = label(who, Fonts.pt(12), "tx3")
        w.widthAnchor.constraint(equalToConstant: 52).isActive = true
        let x = label(text, Fonts.pt(12.5), color, lines: 4, select: true)
        x.preferredMaxLayoutWidth = 440
        let r = hstack([w, x], spacing: 10); r.alignment = .top
        return r
    }
}

/// A page this window does not draw yet: named, never a web view.
final class PlaceholderView: MiddleView {
    private(set) var page = ""
    init() { super.init(sheet: true) }
    required init?(coder: NSCoder) { fatalError() }
    func show(_ name: String) {
        page = name
        let a = label(t("page.notNative", ["page": name]), Fonts.pt(14, .semibold), "tx2")
        a.alignment = .center
        let b = label(t("page.notNativeHint"), Fonts.pt(12.5), "tx3")
        b.alignment = .center
        let s = vstack([a, b], spacing: 8)
        let wrap = Flipped()
        wrap.addSubview(s)
        s.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([s.centerXAnchor.constraint(equalTo: wrap.centerXAnchor), s.widthAnchor.constraint(equalToConstant: 420),
                                     s.topAnchor.constraint(equalTo: wrap.topAnchor, constant: max(40, bounds.height / 2 - 40)), s.bottomAnchor.constraint(equalTo: wrap.bottomAnchor)])
        content.set([wrap])
        setAccessibilityLabel(name)
    }
}

/// New session, for now a folder and an assistant: the hub starts it.
final class StartView: MiddleView {
    var hub: HubClient?
    var onStarted: ((String?, String?) -> Void)?
    var grid: () -> (cols: Int, rows: Int) = { (100, 30) }
    private let folders = NSPopUpButton()
    private let assistants = NSPopUpButton()
    private(set) var go = RButton(t("start.go"), .primary)
    private let note = label("", Fonts.pt(12.5), "bad", lines: 3)
    private var paths: [String] = []

    init() { super.init(sheet: true) }
    required init?(coder: NSCoder) { fatalError() }

    func show(folder: String?) {
        let title = label(t("start.title"), Fonts.pt(20, .bold))
        folders.removeAllItems()
        paths = []
        if let f = folder { add(f) }
        let choose = RButton(t("start.choose"), small: true) { [weak self] in self?.choose() }
        assistants.removeAllItems()
        assistants.addItems(withTitles: ["Claude Code", "Codex"])
        go = RButton(t("start.go"), .primary) { [weak self] in self?.start() }
        note.stringValue = ""
        let rows = vstack([title,
                           hstack([label(t("start.folder"), Fonts.pt(12.5), "tx3"), folders, choose, spring()], spacing: 8),
                           hstack([label(t("start.assistant"), Fonts.pt(12.5), "tx3"), assistants, spring()], spacing: 8),
                           hstack([go, spring()], spacing: 0), note], spacing: 14)
        let wrap = Flipped()
        wrap.addSubview(rows)
        rows.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([rows.centerXAnchor.constraint(equalTo: wrap.centerXAnchor), rows.widthAnchor.constraint(equalToConstant: 460),
                                     rows.topAnchor.constraint(equalTo: wrap.topAnchor, constant: 80), rows.bottomAnchor.constraint(equalTo: wrap.bottomAnchor)])
        content.set([wrap])
        hub?.get("/api/project/folders") { [weak self] _, j in
            for f in j["folders"] as? [[String: Any]] ?? [] { if let p = f["folder"] as? String { self?.add(p) } }
        }
    }

    private func add(_ path: String) {
        guard !paths.contains(path) else { return }
        paths.append(path)
        let home = NSHomeDirectory()
        folders.addItem(withTitle: path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path)
    }

    private func choose() {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        guard let w = window else { return }
        p.beginSheetModal(for: w) { [weak self] r in
            guard r == .OK, let u = p.url, let self else { return }
            self.add(u.path)
            self.folders.selectItem(at: self.paths.firstIndex(of: u.path) ?? 0)
        }
    }

    private func start() {
        let i = folders.indexOfSelectedItem
        guard i >= 0, i < paths.count else { return }
        go.isEnabled = false
        go.setTitle(t("start.starting"))
        let g = grid()
        hub?.post("/api/sessions/start", ["folder": paths[i], "assistant": assistants.indexOfSelectedItem == 1 ? "codex" : "claude", "cols": g.cols, "rows": g.rows]) { [weak self] code, j in
            guard let self else { return }
            self.go.isEnabled = true
            self.go.setTitle(t("start.go"))
            if code != 200 { self.note.stringValue = t("start.failed", ["why": j["error"] as? String ?? "the board answered \(code)"]); return }
            let key = (j["projectId"] as? String).flatMap { pid in (j["surfaceId"] as? String).map { "\(pid)/\($0)" } }
            self.onStarted?(key, (j["pane"] as? [String: Any])?["id"] as? String)
        }
    }
}
