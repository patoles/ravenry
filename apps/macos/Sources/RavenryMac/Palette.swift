// The command palette (NAV-011): Shift+Cmd+P, or the key the person gave
// it, floats a panel in the middle of the window over everything. One
// ranked list: every action of the menus that can run now (Actions.swift),
// the board's own (answer the top card, Hand off now, New plan, Revive from
// the brief, New project), a project to open, a session to go to, the
// sidebar's pages. Each row: its icon, the action (the letters typed in
// bold), where it lives (the menu, Board, or the project or session it acts
// on) and its key. Before anything is typed: the board's actions first,
// then what the person ran last. Up and Down move, Return runs, Esc or a
// press outside closes.
//
// The board's actions only open or ask what the person would click: the top
// card opens for the person to answer (never answered for them), Hand off
// now is the panel's own button, New plan and New project open their pages.

import AppKit

// MARK: the board's actions

extension Board {
    /// The top card: the first session of Needs you, as the sidebar lists it.
    var topCard: (key: String, name: String, project: String)? {
        guard let st = hub.state, let sec = st.sections.first(where: { $0.group == "you" }) else { return nil }
        for p in sec.projects { for r in p.rows where st.find(r.key) != nil { return (r.key, r.name, p.name) } }
        return nil
    }

    /// The session in front, when the board knows it.
    var frontSession: (project: HubProject, session: HubSession)? { frontKey.flatMap { hub.state?.find($0) } }

    /// The project in front: its page, its session's, else the one used last.
    var frontProject: HubProject? {
        if case .project(let id) = front { return hub.state?.project(id) }
        if let f = frontSession { return f.project }
        return lastProject.flatMap { hub.state?.project($0) }
    }

    /// What the panel's Hand off now needs: the session's context known, not asked already.
    func canHandOff(_ p: HubProject, _ s: HubSession) -> Bool { s.ctx != nil && !s.handoffQueued }
    /// The panel's New plan: no plan running.
    func canNewPlan(_ p: HubProject) -> Bool { p.plan == nil && p.raw["unowned"] as? Bool != true }
    /// The project page's Revive from the brief: a folder on this Mac, a brief, no session running.
    func canRevive(_ p: HubProject) -> Bool { p.machine == nil && p.folder != nil && p.brief != nil && !p.sessions.contains { !$0.handed } }

    /// The projects in the sidebar's order.
    var projectsInOrder: [HubProject] {
        guard let st = hub.state else { return [] }
        var seen = Set<String>(), out: [HubProject] = []
        for sec in st.sections { for sp in sec.projects where !seen.contains(sp.id) { seen.insert(sp.id); if let p = st.project(sp.id) { out.append(p) } } }
        for p in st.projects where !seen.contains(p.id) { out.append(p) }
        return out
    }

    /// Revive's project with nothing named: the one in front, else the first the sidebar lists that can.
    var reviveTarget: HubProject? {
        if let p = frontProject, canRevive(p) { return p }
        return projectsInOrder.first { canRevive($0) }
    }

    /// Whether a board action can run now, on what is in front (its key's item, the palette).
    func boardAvailable(_ id: String) -> Bool {
        switch id {
        case "palette", "newProject": return true
        case "answerTop": return topCard != nil
        case "handOffNow": return frontSession.map { canHandOff($0.project, $0.session) } ?? false
        case "newPlan": return frontProject.map { canNewPlan($0) } ?? false
        case "revive": return reviveTarget != nil
        default: return false
        }
    }

    /// A board action, on what is in front or on `target` (a session's key, a project's id).
    func boardAction(_ id: String, target: String? = nil) {
        guard let st = hub.state else { if id == "palette" { togglePalette() }; return }
        switch id {
        case "palette": togglePalette()
        case "answerTop":
            // Opened for the person to answer, never answered for them.
            guard let k = target ?? topCard?.key else { return }
            note("palette: answer the top card \(k)")
            topLevel { $0.pickSession(k, why: "palette") }
        case "handOffNow":
            guard let f = target.flatMap({ st.find($0) }) ?? frontSession, canHandOff(f.project, f.session) else { return }
            note("palette: hand off now \(f.project.id)/\(f.session.surfaceId)")
            panel.handOff(f.project, f.session)
        case "newPlan":
            guard let p = target.flatMap({ st.project($0) }) ?? frontProject, canNewPlan(p) else { return }
            topLevel { $0.openPage("newplan:\(p.id)", t("panel.newPlan")) }
        case "revive":
            guard let p = target.flatMap({ st.project($0) }) ?? reviveTarget, canRevive(p) else { return }
            note("palette: revive \(p.id)")
            topLevel { $0.pickProject(p.id, why: "palette") }
            projectPage.revive(p)
        case "newProject": topLevel { $0.openPage("newproject", t("side.newProjectDots")) }
        default: break
        }
    }

    func togglePalette() {
        if palette.isOpen { palette.close() } else { palette.open(on: self) }
    }
}

// MARK: the rows

struct PaletteEntry {
    /// The action's id (menu and board ones: kept as what the person ran last), else a row of the board's.
    let id: String
    let title: String
    /// Where it lives: its menu, Board, or what it acts on; `long` when something is typed.
    let context: String
    var long: String? = nil
    var keys: String = ""
    var icon: String = "act-prompt"
    /// Matched only by its target's name (another project's New plan), not by its words alone.
    var needsContext = false
    let run: () -> Void
}

enum PaletteRank {
    /// The words of a text, for a match at a word's start ("garden" in "garden-planner").
    static func words(_ s: String) -> [Substring] { s.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }) }

    /// How well a query matches: every word typed must be in the title or where it lives; nil for no match.
    static func score(_ e: PaletteEntry, _ q: String) -> Int? {
        let qs = q.lowercased().split(separator: " ").map(String.init).filter { !$0.isEmpty }
        guard !qs.isEmpty else { return 0 }
        let title = e.title.lowercased(), tw = words(e.title)
        let ctx = (e.long ?? e.context).lowercased(), cw = words(e.long ?? e.context)
        var s = 0, inContext = false
        for w in qs {
            if title.hasPrefix(w) { s += 40 }
            else if tw.contains(where: { $0.hasPrefix(w) }) { s += 30 }
            else if title.contains(w) { s += 20 }
            else if cw.contains(where: { $0.hasPrefix(w) }) { s += 10; inContext = true }
            else if ctx.contains(w) { s += 5; inContext = true }
            else { return nil }
        }
        if e.needsContext && !inContext { return nil }
        return s
    }

    /// The range of the title the query matched, drawn bold.
    static func match(_ title: String, _ q: String) -> [NSRange] {
        let ns = title as NSString
        var out: [NSRange] = []
        for w in q.lowercased().split(separator: " ") where !w.isEmpty {
            var r = ns.range(of: String(w), options: [.caseInsensitive, .anchored])
            if r.location == NSNotFound {
                // At a word's start, else anywhere.
                let lower = title.lowercased() as NSString
                var at = 0
                while at < lower.length {
                    let f = lower.range(of: String(w), options: [], range: NSRange(location: at, length: lower.length - at))
                    if f.location == NSNotFound { break }
                    let before = f.location == 0 ? " " : lower.substring(with: NSRange(location: f.location - 1, length: 1))
                    if before.rangeOfCharacter(from: .alphanumerics) == nil { r = f; break }
                    at = f.location + 1
                }
                if r.location == NSNotFound { r = ns.range(of: String(w), options: .caseInsensitive) }
            }
            if r.location != NSNotFound { out.append(r) }
        }
        return out
    }
}

// MARK: the panel

final class PaletteView: Flipped, NSTextFieldDelegate {
    private weak var board: Board?
    private let card = Box(fill: "sheet", ring: "sheet-ring", radius: 12)
    let field = NSTextField()
    private let line = Box(fill: "sep")
    private let list = Flipped()
    private var rowViews: [PaletteRowView] = []
    private(set) var results: [PaletteEntry] = []
    private(set) var selected = 0
    private var all: [PaletteEntry] = []
    private weak var before: NSResponder?
    var isOpen: Bool { superview != nil }
    /// What it showed last, for the self-test: each row's title, where it lives and its key.
    var shown: [(String, String, String)] { results.map { ($0.title, rowContext($0), $0.keys) } }
    /// The empty state's two lines when nothing matches.
    private(set) var nothing: (String, String)?
    /// Rows at most (the list does not scroll: a word more narrows it).
    static let most = 8

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        autoresizingMask = [.width, .height]
        addSubview(card)
        card.wantsLayer = true
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = Fonts.pt(16)
        field.textColor = Design.color("tx")
        field.delegate = self
        field.cell?.usesSingleLineMode = true
        field.cell?.isScrollable = true
        field.setAccessibilityLabel(t("pal.placeholder"))
        card.addSubview(field)
        card.addSubview(line)
        card.addSubview(list)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(t("act.palette"))
    }
    required init?(coder: NSCoder) { fatalError() }

    override func updateLayer() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            self.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.18).cgColor
            // 0 18px 50px rgba(0,0,0,.55)
            if let l = self.card.layer {
                l.shadowColor = NSColor.black.cgColor
                l.shadowOpacity = 0.55
                l.shadowRadius = 25
                l.shadowOffset = CGSize(width: 0, height: -18)
                l.masksToBounds = false
            }
            self.field.textColor = Design.color("tx")
            self.field.placeholderAttributedString = NSAttributedString(string: t("pal.placeholder"), attributes: [.font: Fonts.pt(16), .foregroundColor: Design.color("tx3")])
        }
    }
    override var wantsUpdateLayer: Bool { true }
    override func viewDidChangeEffectiveAppearance() { needsDisplay = true; draw() }

    func open(on b: Board) {
        board = b
        let root = b.root
        before = root.window?.firstResponder
        frame = root.bounds
        root.addSubview(self, positioned: .above, relativeTo: nil)
        field.stringValue = ""
        // The rows and whether each can run, read now, with the keyboard still where it was.
        all = entries(b)
        filter()
        root.window?.makeFirstResponder(field)
        b.note("palette open: \(all.count) actions")
    }

    func close() {
        guard isOpen else { return }
        let w = window
        removeFromSuperview()
        if let r = before, let w, (r as? NSView)?.window === w || r === w { w.makeFirstResponder(r) }
        board?.note("palette closed")
    }

    // MARK: what it lists

    private var recentStore: UserDefaults? { board?.prefs }
    /// The ids the person ran last, the newest first.
    var recent: [String] {
        get { recentStore?.stringArray(forKey: "paletteRecent") ?? Self.recentMemory }
        set { let v = Array(newValue.prefix(12)); if let d = recentStore { d.set(v, forKey: "paletteRecent") } else { Self.recentMemory = v } }
    }
    private static var recentMemory: [String] = []

    private func keyText(_ id: String) -> String { KeyMap.shared.stroke(id)?.symbols ?? "" }

    /// Every row it can show now.
    private func entries(_ b: Board) -> [PaletteEntry] {
        var out: [PaletteEntry] = []
        // The menus' actions that can run now, as their items say (title and all).
        var updated = Set<ObjectIdentifier>()
        for a in Actions.all where a.palette && a.menu != "Board" {
            if let only = a.only, !only() { continue }
            guard let item = Actions.barItem(a.id), let m = item.menu else { continue }
            if !updated.contains(ObjectIdentifier(m)) { m.update(); updated.insert(ObjectIdentifier(m)) }
            guard !item.isHidden, item.isEnabled else { continue }
            let title = item.title
            out.append(PaletteEntry(id: a.id, title: title, context: a.menu, keys: keyText(a.id), icon: a.icon) {
                // As the menu item does, with the keyboard back where it was.
                if let sel = item.action { NSApp.sendAction(sel, to: item.target, from: item) }
            })
        }
        guard let st = b.hub.state else { return out + boardFixed(b) }
        // A project to open, a session to go to (its Cmd+digit when it has a tab).
        for p in b.projectsInOrder {
            out.append(PaletteEntry(id: "open:\(p.id)", title: t("pal.openProject", ["name": p.name]), context: t("pal.project"), icon: "act-folder") { [weak b] in
                b?.topLevel { $0.pickProject(p.id, why: "palette") }
            })
        }
        for sec in st.sections {
            for sp in sec.projects {
                for r in sp.rows where st.find(r.key) != nil {
                    var keys = ""
                    if let f = st.find(r.key), let pane = f.session.pane, let i = b.ws.tabs.firstIndex(where: { $0.has(pane) }), i < 9 {
                        keys = KeyMap.shared.stroke("tab\(i + 1)")?.symbols ?? ""
                    }
                    let k = r.key
                    out.append(PaletteEntry(id: "go:\(k)", title: t("pal.goTo", ["name": r.name]), context: sp.name, keys: keys, icon: "act-tab") { [weak b] in
                        b?.topLevel { $0.pickSession(k, why: "palette") }
                    })
                }
            }
        }
        // The board's, on what is in front first (their key's own), then on every other one.
        var board: [PaletteEntry] = []
        let ph = { (id: String) in Actions.byId[id]?.phrase ?? Actions.byId[id]?.title ?? id }
        let icon = { (id: String) in Actions.byId[id]?.icon ?? "act-prompt" }
        if let c = b.topCard {
            board.append(PaletteEntry(id: "answerTop", title: ph("answerTop"), context: "\(c.name), \(c.project)", keys: keyText("answerTop"), icon: icon("answerTop")) { [weak b] in b?.boardAction("answerTop", target: c.key) })
        }
        let fs = b.frontSession, fp = b.frontProject
        for p in b.projectsInOrder {
            for s in p.sessions where !s.handed && b.canHandOff(p, s) {
                let front = fs.map { $0.project.id == p.id && $0.session.surfaceId == s.surfaceId } ?? false
                let name = st.sections.lazy.flatMap { $0.projects }.flatMap { $0.rows }.first { $0.key == "\(p.id)/\(s.surfaceId)" }?.name ?? s.topic ?? p.name
                board.append(PaletteEntry(id: "handOffNow", title: ph("handOffNow"), context: name, long: "\(name), \(p.name)", keys: front ? keyText("handOffNow") : "", icon: icon("handOffNow"), needsContext: !front) { [weak b] in
                    b?.boardAction("handOffNow", target: "\(p.id)/\(s.surfaceId)")
                })
            }
        }
        for p in b.projectsInOrder where b.canNewPlan(p) {
            let front = fp?.id == p.id
            board.append(PaletteEntry(id: "newPlan", title: ph("newPlan"), context: p.name, keys: front ? keyText("newPlan") : "", icon: icon("newPlan"), needsContext: !front) { [weak b] in b?.boardAction("newPlan", target: p.id) })
        }
        let rt = b.reviveTarget
        for p in b.projectsInOrder where b.canRevive(p) {
            let front = rt?.id == p.id
            board.append(PaletteEntry(id: "revive", title: ph("revive"), context: p.name, keys: front ? keyText("revive") : "", icon: icon("revive"), needsContext: !front) { [weak b] in b?.boardAction("revive", target: p.id) })
        }
        out += board
        out += boardFixed(b)
        // The sidebar's pages and its foot.
        for pg in st.pages {
            out.append(PaletteEntry(id: "page:\(pg.key)", title: pg.label, context: t("pal.board"), icon: "doc") { [weak b] in b?.topLevel { $0.openPage(pg.key, pg.label) } })
        }
        for (k, title) in [("decisions", t("side.decisions")), ("sessions", t("sess.title")), ("side.alerts", t("side.alerts")), ("side.machines", t("side.machines")), ("side.phone", t("side.phone"))] {
            out.append(PaletteEntry(id: "page:\(k)", title: title, context: t("pal.board"), icon: k == "decisions" ? "book" : k == "side.alerts" ? "bell" : k == "side.machines" ? "machines" : k == "side.phone" ? "phone" : "doc") { [weak b] in
                b?.topLevel { $0.openPage(k, title) }
            })
        }
        return out
    }

    /// The board's actions that need nothing on it: New project.
    private func boardFixed(_ b: Board) -> [PaletteEntry] {
        let a = Actions.byId["newProject"]!
        return [PaletteEntry(id: "newProject", title: a.phrase ?? a.title, context: t("pal.board"), keys: keyText("newProject"), icon: a.icon) { [weak b] in b?.boardAction("newProject") }]
    }

    private var query: String { field.stringValue.trimmingCharacters(in: .whitespaces) }

    private func rowContext(_ e: PaletteEntry) -> String { query.isEmpty ? e.context : (e.long ?? e.context) }

    /// The rows for what is typed: ranked, the best first; before typing, the board's then the ones run last.
    func filter() {
        let q = query
        if q.isEmpty {
            let boardIds = ["answerTop", "handOffNow", "newPlan", "revive"]
            var out: [PaletteEntry] = []
            for id in boardIds { if let e = all.first(where: { $0.id == id && !$0.needsContext }) { out.append(e) } }
            for id in recent where !boardIds.contains(id) {
                if let e = all.first(where: { $0.id == id && !$0.needsContext }), !out.contains(where: { $0.id == e.id }) { out.append(e) }
            }
            results = Array(out.prefix(Self.most))
        } else {
            let rec = recent
            let scored = all.enumerated().compactMap { i, e in PaletteRank.score(e, q).map { (e, $0, rec.firstIndex(of: e.id) ?? 99, i) } }
            results = scored.sorted { a, b in a.1 != b.1 ? a.1 > b.1 : a.2 != b.2 ? a.2 < b.2 : a.3 < b.3 }.prefix(Self.most).map { $0.0 }
        }
        nothing = results.isEmpty && !q.isEmpty ? (t("pal.nothing", ["q": q]), t("pal.nothingHint")) : nil
        selected = 0
        draw()
    }

    // MARK: drawing

    private var hintLabel: NSTextField?
    private var nothingViews: [NSView] = []
    private var searchIcon: Icon?

    override func layout() { super.layout(); draw() }

    func draw() {
        guard isOpen else { return }
        let w: CGFloat = min(600, bounds.width - 32)
        let top: CGFloat = bounds.height >= 600 ? 96 : 24
        // The field, 48 high: the glass, then the words.
        if searchIcon == nil { let i = Icon("search", "tx3", size: 16); i.translatesAutoresizingMaskIntoConstraints = true; card.addSubview(i); searchIcon = i }
        searchIcon?.frame = NSRect(x: 16, y: 16, width: 16, height: 16)
        field.frame = NSRect(x: 42, y: 13, width: w - 58, height: 22)
        line.frame = NSRect(x: 0, y: 48, width: w, height: 1)
        // The list.
        rowViews.forEach { $0.removeFromSuperview() }
        rowViews = []
        hintLabel?.removeFromSuperview(); hintLabel = nil
        nothingViews.forEach { $0.removeFromSuperview() }; nothingViews = []
        var y: CGFloat = 6
        if query.isEmpty, !results.isEmpty {
            let h = plainLabel(t("pal.first"), Fonts.pt(12.5), "tx3")
            h.frame = NSRect(x: 16, y: y + 2, width: w - 32, height: 18)
            list.addSubview(h)
            hintLabel = h
            y += 24
        }
        if let n = nothing {
            let a = plainLabel(n.0, Fonts.pt(13), "tx2"), b = plainLabel(n.1, Fonts.pt(12.5), "tx3")
            for (v, yy) in [(a, y + 22), (b, y + 43)] as [(NSTextField, CGFloat)] {
                v.alignment = .center
                v.frame = NSRect(x: 16, y: yy, width: w - 32, height: 19)
                list.addSubview(v)
                nothingViews.append(v)
            }
            y += 22 + 21 + 19 + 26
        }
        for (i, e) in results.enumerated() {
            let r = PaletteRowView(e, context: rowContext(e), query: query, on: i == selected, width: w - 12)
            r.frame = NSRect(x: 6, y: y, width: w - 12, height: 32)
            r.onPress = { [weak self] in self?.run(i) }
            r.onHover = { [weak self] in self?.select(i) }
            list.addSubview(r)
            rowViews.append(r)
            y += 32
        }
        y += 6
        list.frame = NSRect(x: 0, y: 49, width: w, height: y)
        card.frame = NSRect(x: ((bounds.width - w) / 2).rounded(), y: top, width: w, height: 49 + y)
    }

    func select(_ i: Int) {
        guard i != selected, results.indices.contains(i) else { return }
        selected = i
        for (n, r) in rowViews.enumerated() { r.on = n == selected }
    }

    /// The row's action: the palette closes first, so it acts where the keyboard was.
    func run(_ i: Int) {
        guard results.indices.contains(i) else { return }
        let e = results[i]
        close()
        if Actions.byId[e.id] != nil { recent = [e.id] + recent.filter { $0 != e.id } }
        board?.note("palette run \(e.id): \(e.title)")
        e.run()
    }

    // MARK: the keyboard and the mouse

    func controlTextDidChange(_ n: Notification) { filter() }

    func control(_ c: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        switch sel {
        case #selector(NSResponder.moveDown(_:)): select(min(results.count - 1, selected + 1)); return true
        case #selector(NSResponder.moveUp(_:)): select(max(0, selected - 1)); return true
        case #selector(NSResponder.insertNewline(_:)): run(selected); return true
        case #selector(NSResponder.cancelOperation(_:)): close(); return true
        default: return false
        }
    }

    /// A press outside the panel closes it.
    override func mouseDown(with e: NSEvent) {
        if !card.frame.contains(convert(e.locationInWindow, from: nil)) { close() }
    }
    override func hitTest(_ p: NSPoint) -> NSView? { isHidden ? nil : (super.hitTest(p) ?? self) }
    override func scrollWheel(with e: NSEvent) {}
    override func rightMouseDown(with e: NSEvent) {}
}

/// One row: the icon, the action with the typed letters bold, where it lives, its key.
final class PaletteRowView: Box {
    var onPress: (() -> Void)?
    var onHover: (() -> Void)?
    var on: Bool { didSet { fill = on ? "sel" : nil; ring = on ? "selring" : nil } }
    let entry: PaletteEntry

    init(_ e: PaletteEntry, context: String, query: String, on: Bool, width: CGFloat) {
        self.entry = e
        self.on = on
        super.init(fill: on ? "sel" : nil, ring: on ? "selring" : nil, radius: 6)
        let icon = Icon(e.icon, "tx2", size: 16)
        icon.translatesAutoresizingMaskIntoConstraints = true
        icon.frame = NSRect(x: 10, y: 8, width: 16, height: 16)
        addSubview(icon)
        let one = NSMutableParagraphStyle()
        one.lineBreakMode = .byTruncatingTail
        let a = NSMutableAttributedString(string: e.title, attributes: [.font: Fonts.pt(13), .foregroundColor: Design.color("tx"), .paragraphStyle: one])
        if !query.isEmpty {
            for r in PaletteRank.match(e.title, query) { a.addAttributes([.font: Fonts.pt(13, .bold), .foregroundColor: Design.color("tx")], range: r) }
        }
        let title = plainLabel("", Fonts.pt(13))
        title.attributedStringValue = a
        let keys = plainLabel(e.keys, Fonts.pt(13), "tx2")
        keys.attributedStringValue = NSAttributedString(string: e.keys, attributes: [.font: Fonts.pt(13), .foregroundColor: Design.color("tx2"), .kern: 0.8, .paragraphStyle: one])
        let kw = e.keys.isEmpty ? 0 : ceil(keys.attributedStringValue.size().width) + 6
        keys.frame = NSRect(x: width - 10 - kw, y: 7, width: kw, height: 18)
        let tw = min(ceil(a.size().width) + 6, width - 46 - kw - 20)
        title.frame = NSRect(x: 36, y: 7, width: tw, height: 18)
        let ctx = plainLabel(context, Fonts.pt(13), "tx3")
        ctx.lineBreakMode = .byTruncatingTail
        let cx = 36 + tw + 4
        ctx.frame = NSRect(x: cx, y: 7, width: max(0, width - cx - 10 - kw - 10), height: 18)
        for v in [title, ctx, keys] { addSubview(v) }
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel([e.title, context, e.keys].filter { !$0.isEmpty }.joined(separator: ", "))
    }
    required init?(coder: NSCoder) { fatalError() }

    override func mouseDown(with e: NSEvent) { onPress?() }
    override func mouseMoved(with e: NSEvent) { onHover?() }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach { removeTrackingArea($0) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self))
    }
    override func accessibilityPerformPress() -> Bool { onPress?(); return true }
}

/// A label placed by its frame (no constraints): the palette lays out its rows itself.
func plainLabel(_ s: String, _ font: NSFont, _ color: String = "tx") -> NSTextField {
    let f = NSTextField(labelWithString: s)
    f.font = font
    f.textColor = Design.color(color)
    f.lineBreakMode = .byTruncatingTail
    f.maximumNumberOfLines = 1
    f.drawsBackground = false
    return f
}
