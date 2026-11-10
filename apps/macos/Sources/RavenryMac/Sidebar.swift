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

    private let brand = Flipped()
    private let mix = Flipped()
    private let list = StackScroll(spacing: 10, insets: NSEdgeInsets(top: 0, left: 4, bottom: 0, right: 4))
    private let nav = Flipped()
    private let foot = Flipped()
    private let empty = label("", Fonts.pt(12.5), "tx3", lines: 6)
    /// What the list says when it has no row (the install check's report).
    var emptyText: String? { empty.isHidden ? nil : empty.stringValue }
    private let handle = ResizeHandle()
    let newButton = RButton(t("side.newSession"), .icon, small: true, icon: "plus")
    private var navStack: NSStackView?
    private var footStack: NSStackView?
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
        addSubview(empty)
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
        let footH: CGFloat = 34
        foot.frame = NSRect(x: pad, y: bounds.height - 10 - footH, width: inner, height: footH)
        let navH = navStack?.fittingSize.height ?? 0
        nav.frame = NSRect(x: pad, y: foot.frame.minY - 12 - navH, width: inner, height: navH)
        let listH = max(0, nav.frame.minY - 12 - y)
        list.frame = NSRect(x: pad - 4, y: y, width: inner + 8, height: listH)
        empty.frame = NSRect(x: pad + 6, y: y + 4, width: inner - 12, height: min(listH, 120))
        handle.frame = NSRect(x: w - 3, y: 0, width: 6, height: bounds.height)
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

    /// The folder macOS is asking about while the hub waits (HubClient.waitingFor).
    var waitingFor: String?

    func update(state: HubState?, reachable: Bool, front: String?, pinned: Set<String>, page: String?, alerts: Bool) {
        let times = state?.sections.flatMap { $0.projects.map { timeText($0) } }.joined(separator: ",") ?? ""
        let sig = [(try? JSONSerialization.data(withJSONObject: state?.raw["sidebar"] ?? [:], options: .sortedKeys)).map { String($0.hashValue) } ?? "", String(reachable), pinned.sorted().joined(separator: ","),
                   page ?? "", times, state.map { $0.pages.map { "\($0.key)\($0.number ?? -1)" }.joined() } ?? "", state?.memoryLine ?? "",
                   String(alerts), "\(decisions.count)\(decisions.live)", "\(machinesDot)\(footOn.sorted())", waitingFor ?? ""].joined(separator: "|")
        guard sig != signature else { select(front, page: page); return }
        signature = sig
        rows = [:]
        pins = [:]
        let sections = state?.sections ?? []
        // The mix bar: each state's share of the rows.
        mixCounts = ["you", "work", "wait", "idle"].compactMap { g in (state?.counts[g] ?? 0) > 0 ? (g, state!.counts[g]!) : nil }
        mix.subviews.forEach { $0.removeFromSuperview() }
        for (g, _) in mixCounts { let b = Box(fill: g, radius: 0); mix.addSubview(b) }
        mix.isHidden = mixCounts.isEmpty
        if sections.isEmpty {
            empty.stringValue = state == nil && !reachable
                ? (waitingFor.map { t("side.emptyAccess", ["folder": $0]) } ?? t("side.emptyNoBoard")) : t("side.empty")
            empty.isHidden = false
            list.set([])
        } else {
            empty.isHidden = true
            list.set(sections.map { section($0, front: front, pinned: pinned) })
        }
        buildNav(state, page: page)
        buildFoot(state, alerts: alerts)
        select(front, page: page)
        needsLayout = true
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
        let s = hstack([Icon("machine", "tx3", size: 12), label(m, Fonts.pt(11.5, .medium), "tx2")], spacing: 4)
        s.toolTip = "Runs on \(m)"
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
                let line = hstack([label(p.name, idle ? Fonts.pt(12.5) : Fonts.pt(13, Fonts.w650), idle ? "tx2" : "tx"), machineTag(p.machine), spring(),
                                   label(timeText(p), Fonts.pt(12.5).withTabularDigits, "tx3")], spacing: 8, insets: NSEdgeInsets(top: 6, left: 10, bottom: 6, right: 10))
                r.addSubview(line)
                pinEdges(line, r)
                r.selected = psel
                r.setAccessibilityLabel(p.name)
                r.onOpen = { [weak self] in self?.onProject?(p.id) }
                rows[pk] = r
                items.append(r)
                continue
            }
            items.append(hstack([label(p.name, Fonts.pt(13, Fonts.w650)), machineTag(p.machine), spring(), label(timeText(p), Fonts.pt(13).withTabularDigits, "tx3")],
                                spacing: 8, insets: NSEdgeInsets(top: 6, left: 10, bottom: 2, right: 10)))
            for r in p.rows { items.append(sessionRow(r, selected: front == r.key, pinned: pinned.contains(r.key))) }
        }
        let st = vstack(items, spacing: 1)
        return boxed(st, fill: "\(s.group)-t", radius: 10, insets: NSEdgeInsets(top: 4, left: 4, bottom: 4, right: 4))
    }

    private func pinEdges(_ v: NSView, _ p: NSView) {
        v.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([v.leadingAnchor.constraint(equalTo: p.leadingAnchor), v.trailingAnchor.constraint(equalTo: p.trailingAnchor),
                                     v.topAnchor.constraint(equalTo: p.topAnchor), v.bottomAnchor.constraint(equalTo: p.bottomAnchor)])
    }

    /// .ss: the dot, the name, the assistant, the percent (the pin over it
    /// on hover, and always when pinned), and the line under it.
    private func sessionRow(_ r: SideRow, selected: Bool, pinned: Bool) -> NSView {
        let row = Row()
        row.key = r.key
        let dot = Box(fill: r.group, radius: 3.5)
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.widthAnchor.constraint(equalToConstant: 7).isActive = true
        dot.heightAnchor.constraint(equalToConstant: 7).isActive = true
        let tag = r.assistant.map { a -> NSView in
            let b = boxed(label(a, Fonts.pt(11, .semibold), "tx2"), fill: nil, ring: "sep", radius: 5, insets: NSEdgeInsets(top: 3, left: 7, bottom: 3, right: 7))
            b.setContentHuggingPriority(.required, for: .horizontal)
            return b
        }
        let pc = label(r.pct.map { "\($0)%" } ?? "", Fonts.pt(11.5).withTabularDigits, r.pctWarn ? "you" : "tx3")
        pc.alignment = .right
        pc.widthAnchor.constraint(equalToConstant: 28).isActive = true
        let pinB = RButton(pinned ? t("side.unpin") : t("side.pin"), .icon, small: true, icon: "pin")
        pinB.removeConstraints(pinB.constraints.filter { $0.firstAttribute == .width || $0.firstAttribute == .height })
        pinB.widthAnchor.constraint(equalToConstant: 18).isActive = true
        pinB.heightAnchor.constraint(equalToConstant: 18).isActive = true
        pinB.iconView?.tint = pinned ? "tx2" : "tx3"
        pinB.on = pinned
        pinB.isHidden = !pinned
        pinB.run = { [weak self] in self?.onPin?(r.key) }
        pins[r.key] = pinB
        let name = label(r.name, Fonts.pt(12.5))
        let top = hstack([dot, name, tag, pinned ? nil : pc, pinB], spacing: 8)
        var second: NSView?
        if let m = r.mark {
            let icon: String = ["ask": "ask", "approve": "run", "secret": "key", "drive": "keyboard", "pick": "pick", "review": "review"][m.kind] ?? "ask"
            second = hstack([Icon(icon, "you", size: 13), label(m.text, m.code ? Fonts.mono(11.5) : Fonts.pt(12), m.code ? "tx" : "tx2")],
                            spacing: 6, insets: NSEdgeInsets(top: 0, left: 14, bottom: 0, right: 0))
        } else if let l = r.line {
            second = hstack([label(l, Fonts.pt(12), "tx2")], spacing: 0, insets: NSEdgeInsets(top: 0, left: 15, bottom: 0, right: 0))
        }
        let col = vstack([top, second], spacing: 4, insets: NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10))
        row.addSubview(col)
        pinEdges(col, row)
        row.selected = selected
        row.setAccessibilityLabel([r.name, r.assistant, r.pct.map { "\($0)%" }, r.mark?.text ?? r.line].compactMap { $0 }.joined(separator: ", "))
        row.onOpen = { [weak self] in self?.onSession?(r.key) }
        // The pin shows on hover in the percent's place.
        row.onHover = { [weak pinB, weak pc] on in
            guard !pinned else { return }
            pinB?.isHidden = !on
            pc?.isHidden = on
        }
        rows[r.key] = row
        return row
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
    private func buildFoot(_ state: HubState?, alerts: Bool) {
        footStack?.removeFromSuperview()
        let b = { (key: String, icon: String) -> RButton in
            let x = RButton(t(key), .icon, icon: icon)
            x.run = { [weak self] in self?.onNav?(key, t(key)) }
            x.on = self.footOn.contains(key)
            self.footButtons[key] = x
            return x
        }
        let bell = b("side.alerts", "bell")
        if alerts { bell.iconView?.tint = "you" }
        let mem = state?.memoryLine.map { label(t("side.memory", ["mem": $0]), Fonts.pt(11.5).withTabularDigits, "tx3") }
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
        let s = hstack([b("side.settings", "settings"), b("side.phone", "phone"), bell, b("side.learn", "question"), mach, spring(), mem],
                       spacing: 2, insets: NSEdgeInsets(top: 4, left: 2, bottom: 0, right: 6))
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
