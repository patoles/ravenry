// The sidebar, as the Electron app draws it (apps/desktop/src/renderer/app.ts
// renderSidebar, app.css .side): the brand with New session, the mix bar of
// the four states, the sections of state.sidebar (hub/server/sidebar.mjs)
// with their colours and counts, a project's header in each section it has
// a session in, a row a session (its dot, name, assistant, context percent,
// pin, and the line or mark under it), an idle project on one line; then
// the pages (state.pages) and Decisions, and the foot's buttons. It draws
// what the hub sent and decides nothing; a click says what was clicked.
//
// It folds away (View > Hide Sidebar, Cmd+Ctrl+S) and its right edge is
// dragged from 220 to 420 points (284 as the desktop's), both kept for the
// next launch (never by the bench or the self-tests).

import AppKit

final class SidebarView: Flipped {
    static let defaultWidth: CGFloat = 284
    static let minWidth: CGFloat = 220
    static let maxWidth: CGFloat = 420

    var onSession: ((String) -> Void)?
    var onProject: ((String) -> Void)?
    var onPin: ((String) -> Void)?
    var onNew: (() -> Void)?
    var onNav: ((String, String) -> Void)?
    var onResize: ((CGFloat) -> Void)?
    /// A row's right-click Close: the hub's session ids, and the name it said.
    var onCloseSessions: (([String], String) -> Void)?
    /// A row's right-click Hand off now (its key).
    var onHandOff: ((String) -> Void)?
    /// A hint's Learn more: Learn Ravenry at that card.
    var onLearn: ((String) -> Void)?
    /// New project (the list's last row, a project row's right-click menu).
    var onNewProject: (() -> Void)?
    /// "Using dev server" (holds) or "Waiting for dev server, Claude has it" for a session's row (its key), else nil.
    var useLine: ((String) -> (holds: Bool, text: String)?)?

    private let brand = Flipped()
    private let mix = Flipped()
    private let list = StackScroll(spacing: 10, insets: NSEdgeInsets(top: 0, left: 4, bottom: 0, right: 4))
    private let nav = Flipped()
    private let foot = Flipped()
    private let empty = label("", Fonts.pt(12.5), "tx3", lines: 6)
    /// A folder macOS is asking about, or did not let the board read, over a
    /// list that has rows (app.ts deniedNote, .access-note: the "you" colour
    /// on its tint, the question in bold, Open Files & Folders under it).
    private let note = Box(fill: "you-t", radius: 8)
    private let noteText = label("", Fonts.pt(12), "you", lines: 8)
    private(set) var noteButton: RButton?
    /// What the access note says, for the self-test.
    var noteShown: String? { note.isHidden ? nil : noteText.stringValue }
    /// The list goes on under its bottom edge: a fade says so (the overlay scroller hides).
    private let fade = FadeEdge()
    /// The board as last drawn: the right-click menus read its sessions.
    private(set) var lastState: HubState?
    /// No tab is open and the board is down or has no project: the foot keeps Settings, Learn and Machines, the pages are dimmed (app.ts firstRun).
    private(set) var firstRun = false
    /// What the list says when it has no row (the install check's report).
    var emptyText: String? { empty.isHidden ? nil : empty.stringValue }
    private let handle = ResizeHandle()
    let newButton = RButton(t("side.newSession"), .icon, small: true, icon: "plus")
    private var navStack: NSStackView?
    private var footStack: NSStackView?
    /// The foot on two lines (the memory line over the buttons), in a narrow sidebar.
    private var footTall = false { didSet { if footTall != oldValue { needsLayout = true } } }
    private var signature = ""
    /// The rows drawn, by their key ("<project>/<surface>", "project:<id>", "page:<key>").
    private(set) var rows: [String: Row] = [:]
    private(set) var pins: [String: RButton] = [:]

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Sidebar")
        // .brand: the logo, Ravenry, the + of New session.
        let logo = Icon("logo", "tx", size: 19)
        let name = label("Ravenry", Fonts.pt(14, .bold))
        newButton.toolTip = "\(t("side.newSession")) (⌘⇧N)"
        newButton.run = { [weak self] in self?.onNew?() }
        let b = hstack([logo, name, spring(), newButton], spacing: 7, insets: NSEdgeInsets(top: 4, left: 6, bottom: 0, right: 6))
        brand.addSubview(b)
        pin(b, to: brand)
        addSubview(brand)
        addSubview(mix)
        addSubview(list)
        addSubview(fade)
        addSubview(note)
        addSubview(empty)
        note.isHidden = true
        noteText.preferredMaxLayoutWidth = 230
        list.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: list.contentView, queue: .main) { [weak self] _ in self?.placeFade() }
        addSubview(nav)
        addSubview(foot)
        addSubview(handle)
        handle.onDrag = { [weak self] w in self?.onResize?(w) }
        mix.wantsLayer = true
        mix.layer?.cornerRadius = 3
        mix.layer?.masksToBounds = true
    }
    required init?(coder: NSCoder) { fatalError() }

    private func pin(_ v: NSView, to p: NSView) {
        v.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([v.leadingAnchor.constraint(equalTo: p.leadingAnchor), v.trailingAnchor.constraint(equalTo: p.trailingAnchor),
                                     v.topAnchor.constraint(equalTo: p.topAnchor), v.bottomAnchor.constraint(equalTo: p.bottomAnchor)])
    }

    // .side: padding 14 10 10, gap 12; the window's buttons in its top 36.
    override func layout() {
        super.layout()
        let w = bounds.width, pad: CGFloat = 10
        let inner = w - 2 * pad
        var y: CGFloat = 36 + 12
        brand.frame = NSRect(x: pad, y: y, width: inner, height: 34)
        y += 34 + 12
        if !mix.isHidden { mix.frame = NSRect(x: pad + 6, y: y, width: inner - 12, height: 6); y += 6 + 12 }
        layoutMix()
        if !note.isHidden {
            noteText.preferredMaxLayoutWidth = inner - 24
            let nh = ceil(note.fittingSize.height)
            note.frame = NSRect(x: pad, y: y, width: inner, height: nh)
            y += nh + 10
        }
        let footH: CGFloat = footTall ? 54 : 34
        foot.frame = NSRect(x: pad, y: bounds.height - 10 - footH, width: inner, height: footH)
        let navH = navStack?.fittingSize.height ?? 0
        nav.frame = NSRect(x: pad, y: foot.frame.minY - 12 - navH, width: inner, height: navH)
        let listH = max(0, nav.frame.minY - 12 - y)
        list.frame = NSRect(x: pad - 4, y: y, width: inner + 8, height: listH)
        placeFade()
        empty.frame = NSRect(x: pad + 6, y: y + 4, width: inner - 12, height: min(listH, 120))
        handle.frame = NSRect(x: w - 3, y: 0, width: 6, height: bounds.height)
    }

    /// The fade over the list's last 18 points while more rows wait below them.
    private func placeFade() {
        let doc = list.documentView?.frame.height ?? 0
        let below = doc - list.contentView.bounds.maxY
        fade.isHidden = below <= 2 || list.isHidden
        fade.frame = NSRect(x: list.frame.minX, y: list.frame.maxY - 18, width: list.frame.width, height: 18)
    }

    private var mixCounts: [(String, Int)] = []
    private func layoutMix() {
        let total = mixCounts.reduce(0) { $0 + $1.1 }
        var x: CGFloat = 0
        let gaps = CGFloat(max(0, mixCounts.count - 1)) * 2
        for (i, v) in mix.subviews.enumerated() where i < mixCounts.count {
            let wv = total > 0 ? (mix.bounds.width - gaps) * CGFloat(mixCounts[i].1) / CGFloat(total) : 0
            v.frame = NSRect(x: x, y: 0, width: wv, height: 6)
            x += wv + 2
        }
    }

    /// Draws the board as the hub sent it; nothing when nothing changed.
    /// Decisions' row: the active ones, and a dot while one can still be undone (the hub's count, Board polls it).
    var decisions: (count: Int, live: Bool) = (0, false)
    /// The foot's Machines mark carries a dot while a machine needs the person (the hub's cards).
    var machinesDot = false
    /// The foot's marks lit: the page or card each opens is in front ("side.phone", "side.learn", "side.machines").
    var footOn = Set<String>()
    /// The foot's buttons by key (the phone card sits over its own).
    private(set) var footButtons: [String: RButton] = [:]

    /// The folder macOS is asking about while the hub waits (HubClient.waitingFor), and what Settings calls it (waitingFolder).
    var waitingFor: String?
    var waitingFolder: String?
    /// The self-test's stand-in for both, as the hub's 503 says them.
    var testWaiting: (folder: String, name: String?)?
    /// The pane of System Settings the note's button opens.
    static let privacyPane = "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"

    func update(state: HubState?, reachable: Bool, front: String?, pinned: Set<String>, page: String?, alerts: Bool) {
        lastState = state
        let times = state?.sections.flatMap { $0.projects.map { timeText($0) } }.joined(separator: ",") ?? ""
        let sections = state?.sections ?? []
        uses = [:]
        for s in sections { for p in s.projects { for r in p.rows { if let u = useLine?(r.key) { uses[r.key] = u } } } }
        let denied = (((state?.raw["access"] as? [String: Any])?["denied"] as? [[String: Any]]) ?? []).compactMap { $0["folder"] as? String }
        let asking = testWaiting ?? waitingFor.map { (folder: $0, name: waitingFolder) }
        firstRun = sections.isEmpty && (!reachable || (state?.projects.isEmpty ?? true)) && !hasTabs
        let sig = [(try? JSONSerialization.data(withJSONObject: state?.raw["sidebar"] ?? [:], options: .sortedKeys)).map { String($0.hashValue) } ?? "", String(reachable), pinned.sorted().joined(separator: ","),
                   page ?? "", times, state.map { $0.pages.map { "\($0.key)\($0.number ?? -1)" }.joined() } ?? "", state?.memoryLine ?? "",
                   String(alerts), "\(decisions.count)\(decisions.live)", "\(machinesDot)\(footOn.sorted())", asking.map { "\($0.folder)\($0.name ?? "")" } ?? "",
                   uses.map { "\($0.key)=\($0.value.text)" }.sorted().joined(separator: ","), denied.joined(separator: ","), "\(Hints.shared.loaded)\(Hints.shared.done.sorted())\(Hints.shared.current ?? "")", String(firstRun), String(bounds.width < 260)].joined(separator: "|")
        guard sig != signature else { select(front, page: page); return }
        signature = sig
        rows = [:]
        pins = [:]
        hintShown = false
        // macOS asking for a folder, or refused one, while rows show (deniedNote).
        noteButton = nil
        if !sections.isEmpty, let w = asking {
            // Electron's words: the question in bold, then where to turn it on.
            let s = NSMutableAttributedString(string: t("start.askingT", ["folder": w.folder]), attributes: [.font: Fonts.pt(12, Fonts.w650), .foregroundColor: Design.color("you")])
            s.append(NSAttributedString(string: " " + t("side.accessClosed", ["folder": w.name ?? w.folder]), attributes: [.font: Fonts.pt(12), .foregroundColor: Design.color("you")]))
            let p = NSMutableParagraphStyle(); p.lineBreakMode = .byWordWrapping; p.lineHeightMultiple = 1.15
            s.addAttribute(.paragraphStyle, value: p, range: NSRange(location: 0, length: s.length))
            noteText.attributedStringValue = s
            let b = RButton(t("side.openPrivacy"), .link) { Outside.settings(SidebarView.privacyPane) }
            b.titleColor = "you"
            noteButton = b
            setNote([noteText, hstack([b, spring()], spacing: 0)])
        } else if !sections.isEmpty, !denied.isEmpty {
            noteText.stringValue = t("side.accessDenied", ["folders": denied.joined(separator: ", ")])
            noteText.textColor = Design.color("you")
            setNote([noteText])
        } else { note.isHidden = true }
        // The mix bar: each state's share of the rows.
        mixCounts = ["you", "work", "wait", "idle"].compactMap { g in (state?.counts[g] ?? 0) > 0 ? (g, state!.counts[g]!) : nil }
        mix.subviews.forEach { $0.removeFromSuperview() }
        for (g, _) in mixCounts { let b = Box(fill: g, radius: 0); mix.addSubview(b) }
        mix.isHidden = mixCounts.isEmpty
        if sections.isEmpty {
            empty.stringValue = state == nil && !reachable
                ? (waitingFor.map { t("side.emptyAccess", ["folder": $0]) } ?? t("side.emptyNoBoard")) : t("side.empty")
            empty.isHidden = false
            // The board answers with no project yet: New project under what the list says.
            if state != nil {
                let gap = Flipped()
                gap.translatesAutoresizingMaskIntoConstraints = false
                gap.heightAnchor.constraint(equalToConstant: ceil(empty.sizeThatFits(NSSize(width: max(120, bounds.width - 32), height: 400)).height) + 12).isActive = true
                list.set([gap, newProjectRow()])
            } else { list.set([]) }
        } else {
            empty.isHidden = true
            list.set(sections.map { section($0, front: front, pinned: pinned) } + (state != nil ? [newProjectRow()] : []))
            if !hintShown { Hints.shared.gone("needs-you") }
        }
        buildNav(state, page: page)
        nav.alphaValue = firstRun ? 0.55 : 1
        buildFoot(state, alerts: alerts, page: page)
        select(front, page: page)
        needsLayout = true
        // More rows below the fold: the scroller shows a moment, and the fade stays.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.placeFade()
            if !self.fade.isHidden { self.list.flashScrollers() }
        }
    }

    private var hintShown = false
    /// A tab is open (the window is not on its first run).
    var hasTabs = true
    private var uses: [String: (holds: Bool, text: String)] = [:]

    private func setNote(_ views: [NSView]) {
        note.subviews.forEach { $0.removeFromSuperview() }
        let s = vstack(views, spacing: 6, insets: NSEdgeInsets(top: 9, left: 12, bottom: 9, right: 12))
        note.addSubview(s)
        pinEdges(s, note)
        note.isHidden = false
    }

    /// The highlighted row: what is in front (a project's row when its
    /// session has no row of its own), and the page open. Only the rows'
    /// highlight changes, nothing is drawn again (a tab switch stays fast).
    private func select(_ front: String?, page: String?) {
        for (k, r) in rows {
            if k.hasPrefix("page:") { r.selected = page == String(k.dropFirst(5)); continue }
            if k.hasPrefix("project:") {
                let id = String(k.dropFirst(8))
                r.selected = front == k || (front.map { $0.hasPrefix("\(id)/") } ?? false) && rows[front!] == nil
                continue
            }
            r.selected = front == k
        }
    }

    private func timeText(_ p: SideProject) -> String { p.timeStyle == "clock" ? When.clock(p.timeAt) : When.ago(p.timeAt) }

    private func machineTag(_ m: String?) -> NSView? {
        guard let m else { return nil }
        let s = hstack([Icon("machine", "tx3", size: 12), fixedLabel(m, Fonts.pt(11.5, .medium), "tx2")], spacing: 4)
        s.toolTip = "Runs on \(m)"
        s.setContentCompressionResistancePriority(.required, for: .horizontal)
        s.setHuggingPriority(.required, for: .horizontal)
        return s
    }

    /// .grp: its tint, its head (ring, title, count), its projects.
    private func section(_ s: SideSection, front: String?, pinned: Set<String>) -> NSView {
        let color = s.group == "idle" ? "tx2" : s.group
        let count = label(String(s.count), Fonts.pt(12, .bold), s.group == "you" ? "" : s.group == "idle" ? "tx2" : "")
        count.textColor = s.group == "you" ? NSColor(srgbRed: 0x1D / 255, green: 0x1D / 255, blue: 0x1F / 255, alpha: 1) : s.group == "idle" ? Design.color("tx2") : .white
        count.alignment = .center
        let pill = boxed(count, fill: s.group == "idle" ? "card2" : s.group, radius: 10, insets: NSEdgeInsets(top: 2, left: 6, bottom: 2, right: 6))
        pill.widthAnchor.constraint(greaterThanOrEqualToConstant: 20).isActive = true
        let head = hstack([Icon("ring-\(s.group)", color, size: 14), label(s.title, Fonts.pt(12.5, Fonts.w650), color), spring(), pill],
                          spacing: 8, insets: NSEdgeInsets(top: 8, left: 10, bottom: 6, right: 10))
        var items: [NSView] = [head]
        for p in s.projects {
            let pk = "project:\(p.id)"
            let psel = front == pk || (front.map { $0.hasPrefix("\(p.id)/") } ?? false) && !p.rows.contains { $0.key == front }
            if p.rows.isEmpty {
                // An idle project on one line (.idl), a project shown with no row (.pj.open).
                let idle = s.group == "idle"
                let r = Row()
                r.key = pk
                let line = hstack([yields(label(p.name, idle ? Fonts.pt(12.5) : Fonts.pt(13, Fonts.w650), idle ? "tx2" : "tx"), fill: false), machineTag(p.machine), spring(),
                                   fixedLabel(timeText(p), Fonts.pt(12.5).withTabularDigits, "tx3")], spacing: 8, insets: NSEdgeInsets(top: 6, left: 10, bottom: 6, right: 10))
                r.addSubview(line)
                pinEdges(line, r)
                r.selected = psel
                r.setAccessibilityLabel(p.name)
                r.onOpen = { [weak self] in self?.onProject?(p.id) }
                r.menuItems = { [weak self] in self?.projectMenu(p) }
                rows[pk] = r
                items.append(r)
                continue
            }
            items.append(hstack([yields(label(p.name, Fonts.pt(13, Fonts.w650)), fill: false), machineTag(p.machine), spring(), fixedLabel(timeText(p), Fonts.pt(13).withTabularDigits, "tx3")],
                                spacing: 8, insets: NSEdgeInsets(top: 6, left: 10, bottom: 2, right: 10)))
            for r in p.rows {
                items.append(sessionRow(r, selected: front == r.key, pinned: pinned.contains(r.key)))
                // The first time a session waits on the person: a line under its row (the needs-you hint).
                if s.group == "you", !hintShown, Hints.shared.wants("needs-you") {
                    hintShown = true
                    let h = hintView("needs-you", bold: t("hint.needsYouB"), text: t("hint.needsYou"), width: bounds.width - 28) { [weak self] k in self?.onLearn?(k) }
                    items.append(vstack([h], insets: NSEdgeInsets(top: 4, left: 6, bottom: 6, right: 6)))
                }
            }
        }
        let st = vstack(items, spacing: 1)
        return boxed(st, fill: "\(s.group)-t", radius: 10, insets: NSEdgeInsets(top: 4, left: 4, bottom: 4, right: 4))
    }

    /// The list's last row: New project, its folder, its brief and a first session (SESS-023).
    private(set) var newProjectButton: RButton?
    private func newProjectRow() -> NSView {
        let b = RButton(t("side.newProject"), .ghost, small: true) { [weak self] in self?.onNewProject?() }
        b.lead = "plus"
        b.toolTip = t("side.newProjectTip")
        newProjectButton = b
        return hstack([b, spring()], spacing: 0, insets: NSEdgeInsets(top: 0, left: 2, bottom: 6, right: 0))
    }

    private func pinEdges(_ v: NSView, _ p: NSView) {
        v.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([v.leadingAnchor.constraint(equalTo: p.leadingAnchor), v.trailingAnchor.constraint(equalTo: p.trailingAnchor),
                                     v.topAnchor.constraint(equalTo: p.topAnchor), v.bottomAnchor.constraint(equalTo: p.bottomAnchor)])
    }

    /// .ss: the dot, the name (cut first, taking the free width so every
    /// row's chip and percent line up on the right), the assistant's chip
    /// (never squeezed), the percent (the pin in its place on hover; a
    /// pinned row shows both), and the line under it.
    private func sessionRow(_ r: SideRow, selected: Bool, pinned: Bool) -> NSView {
        let row = Row()
        row.key = r.key
        let dot = Box(fill: r.group, radius: 3.5)
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.widthAnchor.constraint(equalToConstant: 7).isActive = true
        dot.heightAnchor.constraint(equalToConstant: 7).isActive = true
        let tag = r.assistant.map { assistantChip($0) }
        tags[r.key] = tag
        let pc = fixedLabel(r.pct.map { "\($0)%" } ?? "", Fonts.pt(11.5).withTabularDigits, r.pctWarn ? "you" : "tx3")
        pc.alignment = .right
        let pinB = RButton(pinned ? t("side.unpin") : t("side.pin"), .icon, small: true, icon: "pin")
        pinB.removeConstraints(pinB.constraints.filter { $0.firstAttribute == .width || $0.firstAttribute == .height })
        pinB.widthAnchor.constraint(equalToConstant: 18).isActive = true
        pinB.heightAnchor.constraint(equalToConstant: 18).isActive = true
        pinB.iconView?.tint = pinned ? "tx2" : "tx3"
        pinB.on = pinned
        pinB.run = { [weak self] in self?.onPin?(r.key) }
        pins[r.key] = pinB
        // The percent's slot, 28 wide: an unpinned row's pin shows there on hover.
        let slot = Flipped()
        slot.translatesAutoresizingMaskIntoConstraints = false
        slot.widthAnchor.constraint(equalToConstant: 28).isActive = true
        slot.heightAnchor.constraint(equalToConstant: 18).isActive = true
        slot.addSubview(pc)
        pc.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([pc.leadingAnchor.constraint(equalTo: slot.leadingAnchor), pc.trailingAnchor.constraint(equalTo: slot.trailingAnchor), pc.centerYAnchor.constraint(equalTo: slot.centerYAnchor)])
        if !pinned {
            slot.addSubview(pinB)
            pinB.trailingAnchor.constraint(equalTo: slot.trailingAnchor).isActive = true
            pinB.centerYAnchor.constraint(equalTo: slot.centerYAnchor).isActive = true
            pinB.isHidden = true
        }
        pcs[r.key] = pc
        let name = yields(label(r.name, Fonts.pt(12.5)))
        names[r.key] = name
        let top = hstack([dot, name, tag, slot, pinned ? pinB : nil], spacing: 8)
        var second: NSView?
        if let m = r.mark {
            let icon: String = ["ask": "ask", "approve": "run", "secret": "key", "drive": "keyboard", "pick": "pick", "review": "review"][m.kind] ?? "ask"
            second = hstack([Icon(icon, "you", size: 13), yields(m.code ? label(m.text, Fonts.mono(11.5), "tx") : label(md: m.text, Fonts.pt(12), "tx2"))],
                            spacing: 6, insets: NSEdgeInsets(top: 0, left: 14, bottom: 0, right: 0))
        } else if let l = r.line {
            second = hstack([yields(label(md: l, Fonts.pt(12), "tx2"))], spacing: 0, insets: NSEdgeInsets(top: 0, left: 15, bottom: 0, right: 0))
        } else if let u = uses[r.key] {
            // An agent holding a pane, or waiting for one (useLine).
            second = hstack([Icon(u.holds ? "holds" : "clock", u.holds ? "claude" : "tx3", size: 13), yields(label(u.text, Fonts.pt(12), u.holds ? "tx2" : "tx3"))],
                            spacing: 6, insets: NSEdgeInsets(top: 0, left: 14, bottom: 0, right: 0))
        }
        let col = vstack([top, second], spacing: 4, insets: NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10))
        row.addSubview(col)
        pinEdges(col, row)
        row.selected = selected
        row.setAccessibilityLabel([r.name, r.assistant, r.pct.map { "\($0)%" }, pinned ? t("side.pinned") : nil, r.mark?.text ?? r.line ?? uses[r.key]?.text].compactMap { $0 }.joined(separator: ", "))
        row.toolTip = [r.name, r.mark?.text ?? r.line].compactMap { $0 }.joined(separator: "\n")
        row.onOpen = { [weak self] in self?.onSession?(r.key) }
        row.menuItems = { [weak self] in self?.sessionMenu(r, pinned: pinned) }
        // The pin shows on hover in the percent's place (a pinned row's stays where it is).
        row.onHover = { [weak pinB, weak pc] on in
            pc?.isHidden = on
            if !pinned { pinB?.isHidden = !on }
        }
        rows[r.key] = row
        return row
    }

    /// The chip, the percent and the name of each row drawn, for the self-test.
    private(set) var tags: [String: NSView?] = [:]
    private(set) var pcs: [String: NSTextField] = [:]
    private(set) var names: [String: NSTextField] = [:]

    // MARK: right-click menus (Electron has none; the hub's board closes sessions from its Sessions view)

    /// The rows of state.sessions that stand for a sidebar session: by its session id, else its tab.
    func procRows(of key: String) -> [SessionProc] {
        guard let st = lastState, let f = st.find(key) else { return [] }
        let all = st.sessionProcs
        if let sid = f.session.sessionId, let r = all.first(where: { $0.sessionId == sid }) { return [r] }
        return all.filter { $0.surfaceId == f.session.surfaceId && f.session.surfaceId != "" }
    }

    private func item(_ title: String, enabled: Bool = true, _ run: (() -> Void)? = nil) -> NSMenuItem {
        let i = MenuAction.item(title, run)
        i.isEnabled = enabled && run != nil
        return i
    }

    /// Close for the sessions a row stands for: ended in its tab, its transcript kept, Reopen on the Sessions page.
    private func closeItems(_ procs: [SessionProc], name: String) -> [NSMenuItem] {
        let can = procs.filter { $0.canClose }
        if can.isEmpty {
            let why = procs.first.map { $0.whyNot } ?? t("sess.notRunning")
            let i = item(t("sess.closeOne"), enabled: false, nil)
            i.toolTip = why
            let w = item(why, enabled: false, nil)
            return [i, w]
        }
        let ids = can.compactMap { $0.sessionId }
        let mem = can.reduce(0) { $0 + $1.memKb }
        let title = can.count == 1 ? t("sess.closeOneFrees", ["mem": SessionProc.mem(mem)]) : t("sess.closeNFrees", ["n": "\(can.count)", "mem": SessionProc.mem(mem)])
        return [item(title) { [weak self] in self?.onCloseSessions?(ids, name) }]
    }

    private func sessionMenu(_ r: SideRow, pinned: Bool) -> NSMenu {
        let m = NSMenu()
        m.autoenablesItems = false
        m.addItem(item(t("sess.open")) { [weak self] in self?.onSession?(r.key) })
        m.addItem(item(pinned ? t("side.unpin") : t("side.pin")) { [weak self] in self?.onPin?(r.key) })
        if let f = lastState?.find(r.key) {
            if f.session.sessionId != nil, f.session.ctx != nil, !(f.session.handoffQueued) {
                m.addItem(item(t("session.handOffNow")) { [weak self] in self?.onHandOff?(r.key) })
            }
            if f.project.brief != nil { m.addItem(item(t("panel.openBrief")) { [weak self] in self?.onNav?("brief:\(f.project.id)", t("panel.brief")) }) }
        }
        m.addItem(.separator())
        for i in closeItems(procRows(of: r.key), name: r.name) { m.addItem(i) }
        m.addItem(item(t("sess.manage")) { [weak self] in self?.onNav?("sessions", t("sess.title")) })
        return m
    }

    private func projectMenu(_ p: SideProject) -> NSMenu {
        let m = NSMenu()
        m.autoenablesItems = false
        m.addItem(item(t("sess.open")) { [weak self] in self?.onProject?(p.id) })
        if lastState?.project(p.id)?.brief != nil { m.addItem(item(t("panel.openBrief")) { [weak self] in self?.onNav?("brief:\(p.id)", t("panel.brief")) }) }
        let procs = lastState?.sessionProcs.filter { $0.projectId == p.id } ?? []
        if !procs.isEmpty {
            m.addItem(.separator())
            for i in closeItems(procs, name: p.name) { m.addItem(i) }
        }
        m.addItem(.separator())
        m.addItem(item(t("sess.manage")) { [weak self] in self?.onNav?("sessions", t("sess.title")) })
        m.addItem(item(t("side.newProjectDots")) { [weak self] in self?.onNewProject?() })
        return m
    }

    /// .nav: the pages from their files (state.pages: the shipped ones,
    /// then the added ones), Decisions after the shipped ones.
    private func buildNav(_ state: HubState?, page: String?) {
        navStack?.removeFromSuperview()
        let pages = state?.pages ?? []
        let shipped = pages.filter { $0.slot != nil && $0.origin != "project" }
        let added = pages.filter { !($0.slot != nil && $0.origin != "project") }
        func navRow(_ key: String, _ text: String, _ icon: String, _ count: String?, dot: Bool = false) -> NSView {
            let r = Row(radius: 6)
            r.key = "page:\(key)"
            let l = label(text, Fonts.pt(13), page == key ? "tx" : "tx2")
            // .ndot: 6 wide, --work, before the count.
            let nd: NSView? = dot ? { let b = Box(fill: "work", radius: 3); b.translatesAutoresizingMaskIntoConstraints = false
                b.widthAnchor.constraint(equalToConstant: 6).isActive = true; b.heightAnchor.constraint(equalToConstant: 6).isActive = true; return b }() : nil
            let line = hstack([Icon(icon, page == key ? "tx2" : "tx3", size: 14), l, spring(), count.map { c -> NSView in let n = label(c, Fonts.pt(11.5).withTabularDigits, "tx3"); return nd.map { hstack([$0, n], spacing: 5) } ?? n }],
                              spacing: 9, insets: NSEdgeInsets(top: 6, left: 10, bottom: 6, right: 10))
            r.addSubview(line)
            pinEdges(line, r)
            r.selected = page == key
            r.setAccessibilityLabel(text)
            r.onOpen = { [weak self] in self?.onNav?(key, text) }
            r.onHover = { [weak l] on in l?.textColor = Design.color(on || page == key ? "tx" : "tx2") }
            rows["page:\(key)"] = r
            return r
        }
        let icons = ["target": "nav-objectives", "plans": "nav-plans", "idea": "nav-ideas", "rules": "nav-rules", "ship": "nav-ship"]
        let count = { (p: NavPage) -> String? in p.number.flatMap { $0 == 0 ? nil : "\($0)\(p.countLabel.map { " \($0)" } ?? "")" } }
        var items: [NSView] = shipped.map { navRow($0.key, $0.label, icons[$0.icon] ?? "doc", count($0)) }
        items.append(navRow("decisions", t("side.decisions"), "book", decisions.count > 0 ? "\(decisions.count)" : nil, dot: decisions.count > 0 && decisions.live))
        if !added.isEmpty {
            let gap = Box(fill: "sep")
            gap.heightAnchor.constraint(equalToConstant: 1).isActive = true
            items.append(gap)
            items += added.map { navRow($0.key, $0.label, icons[$0.icon] ?? "doc", count($0)) }
        }
        let s = vstack(items, spacing: 1, insets: NSEdgeInsets(top: 8, left: 0, bottom: 0, right: 0))
        nav.subviews.forEach { $0.removeFromSuperview() }
        // Its line on top (border-top: 1px var(--sep)).
        let line = Box(fill: "sep")
        line.frame = NSRect(x: 0, y: 0, width: nav.bounds.width, height: 1)
        line.autoresizingMask = [.width]
        nav.addSubview(line)
        nav.addSubview(s)
        pinEdges(s, nav)
        navStack = s
    }

    /// .foot: Settings, the phone, Alerts, Learn, Machines, and the memory line.
    private func buildFoot(_ state: HubState?, alerts: Bool, page: String?) {
        footStack?.removeFromSuperview()
        footButtons = [:]
        let b = { (key: String, icon: String) -> RButton in
            let x = RButton(t(key), .icon, icon: icon)
            x.run = { [weak self] in self?.onNav?(key, t(key)) }
            x.on = self.footOn.contains(key)
            self.footButtons[key] = x
            return x
        }
        let bell = b("side.alerts", "bell")
        if alerts { bell.iconView?.tint = "you" }
        // The memory the sessions hold: it opens Sessions (close the idle ones, reopen a closed one).
        let mem = state?.memoryLine.map { line -> RButton in
            // Always "Claude 2.8 GB": narrow (a sidebar under 260 pt) it has a line of its own over the buttons, so it is never cut.
            let x = RButton(t("side.memory", ["mem": line]), .link) { [weak self] in self?.onNav?("sessions", t("sess.title")) }
            x.titleColor = page == "sessions" ? "tx" : "tx3"
            x.titleSize = 11.5
            x.on = page == "sessions"
            let idle = state?.sessionsIdle ?? 0
            x.toolTip = t(idle == 1 ? "sess.memTip1" : "sess.memTip", ["n": "\(idle)"])
            x.setAccessibilityLabel(t("sess.memA11y", ["mem": line, "n": "\(idle)"]))
            self.footButtons["sessions"] = x
            return x
        }
        // .m-foot .bdot: 7 wide, --you, ringed in the window's colour, at its top right.
        let mach = b("side.machines", "machines")
        mach.onFill = true
        if machinesDot {
            let d = Box(fill: "you", ring: "win", radius: 5.5)
            d.ringWidth = 2
            // The button is not flipped: 3 from its top and right edges, 11 with the ring.
            d.frame = NSRect(x: 16, y: 16, width: 11, height: 11)
            d.autoresizingMask = [.minXMargin, .minYMargin]
            d.setAccessibilityElement(false)
            mach.addSubview(d)
            mach.setAccessibilityValue("needs you")
        }
        // Five buttons take 162 of a 220 pt sidebar's 192: the memory line goes on a line of its own over them.
        let narrow = bounds.width > 0 && bounds.width < 260
        footTall = narrow && !firstRun && mem != nil
        let icons = hstack([b("side.settings", "settings"), firstRun ? nil : b("side.phone", "phone"), firstRun ? nil : bell, b("side.learn", "question"), mach, spring(), footTall ? nil : firstRun ? nil : mem],
                           spacing: 2, insets: NSEdgeInsets(top: 4, left: 2, bottom: 0, right: 6))
        let s = footTall ? vstack([hstack([mem, spring()], spacing: 0, insets: NSEdgeInsets(top: 0, left: 10, bottom: 0, right: 6)), icons], spacing: 4) : icons
        foot.addSubview(s)
        pinEdges(s, foot)
        footStack = s
    }
}

/// The sidebar's right edge, dragged to change its width.
final class ResizeHandle: NSView {
    var onDrag: ((CGFloat) -> Void)?
    private var startX: CGFloat = 0
    private var startW: CGFloat = 0
    override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeLeftRight) }
    override func mouseDown(with e: NSEvent) {
        startX = e.locationInWindow.x
        startW = superview?.frame.width ?? SidebarView.defaultWidth
    }
    override func mouseDragged(with e: NSEvent) {
        onDrag?(min(SidebarView.maxWidth, max(SidebarView.minWidth, startW + e.locationInWindow.x - startX)))
    }
    override func mouseUp(with e: NSEvent) {
        // A double click puts it back to the desktop's width.
        if e.clickCount == 2 { onDrag?(SidebarView.defaultWidth) }
    }
}

extension NSFont {
    /// Tabular digits (.num).
    var withTabularDigits: NSFont {
        let d = fontDescriptor.addingAttributes([.featureSettings: [[NSFontDescriptor.FeatureKey.typeIdentifier: kNumberSpacingType,
                                                                     NSFontDescriptor.FeatureKey.selectorIdentifier: kMonospacedNumbersSelector]]])
        return NSFont(descriptor: d, size: pointSize) ?? self
    }
}
