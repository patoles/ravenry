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
// - New session: StartView.swift;
// - a page this window does not draw yet: a native placeholder naming it.

import AppKit

/// The middle's base: the terminal's background, a stack of its content,
/// and over it, when it was opened from another view, the link back there
/// ("‹ Brief"), as a page's head has it (InAppPage.backLink).
class MiddleView: Box, BackLinked {
    let content = StackScroll(spacing: 10, insets: NSEdgeInsets(top: 18, left: 22, bottom: 18, right: 22))
    private let sheet: Bool
    /// Where it was opened from: a bar over the content with its link (Board.showMiddle sets it).
    var backLink: (name: String, run: () -> Void)? {
        didSet { if oldValue?.name != backLink?.name { placeBack() } }
    }
    /// The link back, for the self-test.
    private(set) var backBtn: RButton?
    private var backBar: NSView?
    /// The bar's height (its link 8 under the top, as a page head's).
    static let backBarHeight: CGFloat = 38
    init(sheet: Bool = false) {
        self.sheet = sheet
        super.init(fill: sheet ? "sheet" : "term-bg")
        addSubview(content)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func layout() {
        super.layout()
        let h = backBar == nil ? 0 : Self.backBarHeight
        backBar?.frame = NSRect(x: 0, y: 0, width: bounds.width, height: h)
        content.frame = NSRect(x: 0, y: h, width: bounds.width, height: max(0, bounds.height - h))
    }
    private func placeBack() {
        backBar?.removeFromSuperview()
        backBar = nil
        backBtn = nil
        if let l = backLink {
            let b = backButton(l.name, l.run)
            let bar = hstack([b, spring()], spacing: 0, insets: NSEdgeInsets(top: 10, left: 14, bottom: 0, right: 14))
            bar.alignment = .top
            bar.translatesAutoresizingMaskIntoConstraints = true
            // On the terminal's background (a session's view): drawn in its light words in either look.
            if !sheet { bar.appearance = NSAppearance(named: .darkAqua) }
            addSubview(bar)
            backBar = bar
            backBtn = b
        }
        needsLayout = true
    }
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
    /// The note under the head (what Move here does, or that it waits), for the self-test.
    private(set) var noteText: String?

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
        let fromName = why != nil ? "the other ravenryd" : whereName
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
        // In a terminal outside Ravenry, or in a pane of a ravenryd this window
        // does not draw (an older one after an update): Move here ends it there
        // and resumes it in a pane of this window's daemon (POST /api/sessions/move).
        let movable = out != nil || (why != nil && m == nil)
        // Outside Ravenry it resumes only while open there, when the hub says it can, or once it ended (renderElsewhere's canResume).
        let resumable = out == nil || open || (out?["resumable"] as? Bool ?? false)
        let canResume = movable && s.sessionId != nil && kindOk && resumable
        let waiting = s.moving?["waiting"] as? Bool ?? false
        if movable {
            let busy = moving.contains(s.sessionId ?? "")
            let w = s.moving?["waiting"] as? Bool ?? false
            let b = RButton(w ? t("move.waiting", ["who": s.assistant == "codex" ? "Codex" : "Claude", "other": fromName]) : busy ? t("move.moving") : t("move.here"),
                            canResume && !w ? .primary : .normal) { [weak self] in self?.onMove?(p, s) }
            b.isEnabled = canResume && !busy && !w
            buttons["move"] = b
            acts.append(b)
        }
        // The words take the free width, so Open in and Move here sit at the row's right end (.else-head).
        title.lineBreakMode = .byTruncatingTail
        for l in [title, subL] {
            l.setContentCompressionResistancePriority(.init(200), for: .horizontal)
            // Neither line pulls the column narrower than the other needs (both are as wide as the column).
            l.setContentHuggingPriority(.init(1), for: .horizontal)
        }
        let words = vstack([title, subL], spacing: 4)
        words.setHuggingPriority(.init(1), for: .horizontal)
        words.setClippingResistancePriority(.init(200), for: .horizontal)
        let head = hstack([words, spring()] + acts, spacing: 16)
        head.alignment = .top
        var rows: [NSView] = [head]
        if canResume {
            // Waiting for its turn to end (amber, a clock), else what Move here does (green, a check).
            let who = s.assistant == "codex" ? "Codex" : "Claude"
            let text = waiting ? t("else.movesWhen", ["who": who, "where": fromName]) : open || why != nil ? t("else.moveNote", ["where": fromName]) : t("else.moveNoteEnded")
            let n = label(text, Fonts.pt(12.5, .medium), waiting ? "you" : "ok", lines: 2)
            noteText = text
            rows.append(hstack([Icon(waiting ? "clock" : "done", waiting ? "you" : "ok", size: 14), n], spacing: 7))
        } else { noteText = nil }
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
                case "t":
                    // A tool: its name and argument, "+N lines" it printed; a batch line with "×N".
                    if let b = x["b"] as? String {
                        let n = (x["x"] as? NSNumber)?.intValue ?? 0
                        lines.append(("⏺", b + (n > 1 ? "  ×\(n)" : ""), termTx2))
                    } else {
                        let m = (x["m"] as? NSNumber)?.intValue ?? 0
                        lines.append(("⏺", "\(x["n"] as? String ?? "") \(x["a"] as? String ?? "")" + (m > 0 ? "  +\(m) line\(m > 1 ? "s" : "")" : ""), termTx2))
                    }
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
        // Every row of its screen (the hub sends what is on it), up to the last 400.
        for (g, text, color) in lines.suffix(400) {
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

/// Why a project with no session is in its section (app.ts projectFacts):
/// a plan gate's question, who it waits on, working, idle for how long.
func projectFacts(_ p: HubProject) -> (group: String, text: String) {
    let state = p.s("state") ?? ""
    let g = ["you", "work", "wait", "idle"].contains(state) ? state : "idle"
    if let q = (p.raw["planGate"] as? [String: Any])?["question"] as? String, !q.isEmpty { return ("you", t("project.needsYouQ", ["q": q])) }
    switch g {
    case "wait": return (g, p.waitingOn.map { t("panel.waitingOn", ["who": $0]) } ?? t("panel.waitingOthers"))
    case "you": return (g, t("group.you"))
    case "work": return (g, t("panel.working"))
    default: return (g, p.since.map { t("panel.idleFor", ["ago": When.ago($0)]) } ?? t("panel.idle"))
    }
}

/// The state in words with its ring (.st).
func factLine(_ g: String, _ text: String, size: CGFloat = 13) -> NSView {
    let c = g == "idle" ? "tx2" : g
    let l = label(text, Fonts.pt(size, .semibold), c, lines: 3)
    l.preferredMaxLayoutWidth = 520
    let v = hstack([Icon("ring-\(g)", c, size: 14), l, spring()], spacing: 7)
    v.alignment = .top
    v.setAccessibilityElement(true)
    v.setAccessibilityLabel(text)
    return v
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
    /// Show it: the conversation is open in a pane of this window (its tab in front); false when it has no such pane.
    var onShowPane: ((String) -> Bool)?
    var busy = false
    /// A Continue the hub refused: said under the buttons, and the last conversation asked again (it may be open somewhere now).
    var error: String? { didSet { if error != nil { asked = .distantPast } } }
    private var last: [String: Any]?
    private var loaded = false
    private var asked = Date.distantPast

    init() { super.init(sheet: true) }
    required init?(coder: NSCoder) { fatalError() }

    /// The project left the board while its page was in front (renderProject).
    func gone(_ id: String) {
        guard projectId == id else { return }
        buttons = [:]
        let l = label(t("project.gone"), Fonts.pt(14, .semibold), "tx2")
        content.set(centred(vstack([l], spacing: 8)))
        setAccessibilityLabel(t("project.gone"))
    }

    /// Asks again for its last conversation (a Continue the hub refused because it is open somewhere).
    func reload(_ p: HubProject) { asked = .distantPast; show(p) }

    func show(_ p: HubProject) {
        if projectId != p.id { projectId = p.id; last = nil; loaded = false; error = nil; busy = false; asked = .distantPast }
        if Date().timeIntervalSince(asked) > 15 {
            asked = Date()
            hub?.get("/api/project/last?projectId=\(p.id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? p.id)") { [weak self] code, j in
                guard let self, self.projectId == p.id else { return }
                self.last = code == 200 ? j["last"] as? [String: Any] : nil
                self.loaded = true
                // It turned out open in a terminal: the page now says where, with Show it or Move here, not the refusal.
                if self.error != nil, self.last?["openIn"] is [String: Any] { self.error = nil }
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
        let facts = projectFacts(p)
        var head: [NSView?] = [name, p.folderShort.map { label($0, Fonts.pt(13), "tx3") }, factLine(facts.group, facts.text)]
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
        let inRavenry = (openIn?["ravenry"] as? Bool ?? false) ? openIn?["pane"] as? String : nil
        let outside = openIn.flatMap { ($0["ravenry"] as? Bool ?? false) ? nil : ($0["name"] as? String ?? "another terminal") }
        // The title gives up its room first; the chip and when it stopped stay whole.
        let conv = vstack([
            hstack([yields(label(l["title"] as? String ?? "", Fonts.pt(13.5, Fonts.w650)), fill: false), assistantChip(who),
                    spring(), fixedLabel(t("project.stoppedAt", ["when": When.stopped(l["stoppedAt"] as? String)]), Fonts.pt(12, .medium), "tx3")], spacing: 8),
            (l["lastPrompt"] as? String).map { said(t("project.you"), $0, "tx") },
            (l["lastText"] as? String).map { said(who, $0, "tx2") },
        ], spacing: 10)
        var rows: [NSView?] = head + [boxed(conv, fill: "card", radius: 12, insets: NSEdgeInsets(top: 14, left: 16, bottom: 14, right: 16))]
        if let o = outside { rows.append(label(t("project.stillOpen", ["where": o]), Fonts.pt(12.5), "you")) }
        let main: RButton
        if let pane = inRavenry {
            // Open in a Ravenry pane already: a second copy would be refused, so it shows that one.
            main = RButton(t("project.showIt"), .primary) { [weak self] in
                guard let self else { return }
                if self.onShowPane?(pane) != true { self.error = t("project.notHere"); self.draw(p) }
            }
        } else if outside != nil {
            main = RButton(busy ? t("move.moving") : t("move.here"), .primary) { [weak self] in self?.onMoveLast?(p, l) }
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
