// Sessions: the memory the running sessions hold, the idle ones closed in
// one go, and the ones closed in the last 14 days reopened. Neither the
// Electron app nor the first native port had it; the hub's browser board
// does (hub/public/app.js renderSessions, closeIdle, reopenClosed; design
// docs/design/CloseIdle.dc.html), and this page draws the same data,
// state.sessions (hub/server/index.mjs buildSessions), natively:
//
// - the head: how much memory the sessions hold, and Close N sessions;
// - what the last close did (closed, freed, each one left open and why);
// - a bar of the memory by state, and the rule a session is listed by;
// - on the left the sessions that can go, each with a tick (Handed off, No
//   activity for N h or more, Left for you), ticked as the hub board ticks
//   them (handed off and idle; a session left with a half-typed reply or a
//   question is not);
// - on the right In use, Not in a project, Not mapped, and Recently closed
//   with Reopen (six, then Show all).
//
// It opens from the sidebar foot's memory line ("Claude 2.8 GB") and from a
// row's right-click menu (Sessions and memory). Close posts the ticked ids to
// POST /api/sessions/close; the hub checks each again and ends Claude in its
// tab, keeping the transcript. Reopen posts POST /api/sessions/reopen.

import AppKit

final class SessionsPage: FormPage {
    /// Ticks the person changed, by session id (the others follow the hub's groups).
    private(set) var ticks: [String: Bool] = [:]
    private(set) var closing = false
    /// The answer of the last Close this page sent.
    private(set) var result: [String: Any]?
    private(set) var reopening = Set<String>()
    private var showAllClosed = false
    /// The tick boxes by session id, for the self-test.
    private(set) var boxes: [String: NSButton] = [:]
    /// Opens a session's own view (its tab, its project).
    var openSession: ((String) -> Void)?
    private var wide = true

    func show() {
        result = nil
        ticks = [:]
        showAllClosed = false
        dirty()
        poll(2)
        redraw()
    }

    override func load() { redraw() }

    override func layoutBody() {
        super.layoutBody()
        let w = bounds.width >= 860
        if w != wide { wide = w; dirty(); redraw() }
    }

    private var view: [String: Any]? { hub?.state?.sessionsView }

    func isTicked(_ r: SessionProc) -> Bool {
        guard r.canClose, let id = r.sessionId else { return false }
        return ticks[id] ?? (r.group == "handed" || r.group == "idle")
    }

    /// The ids Close would close now.
    var tickedIds: [String] { (hub?.state?.sessionProcs ?? []).filter(isTicked).compactMap { $0.sessionId } }

    static func plural(_ n: Int, _ one: String, _ many: String? = nil) -> String { "\(n) \(n == 1 ? one : many ?? one + "s")" }
    private func sessions(_ n: Int) -> String { SessionsPage.plural(n, t("sess.one"), t("sess.many")) }

    override func redraw() {
        guard let v = view, v["at"] is String else {
            setHead(title: t("sess.title"), src: (view?["error"] as? String).map { t("sess.readError", ["why": $0]) } ?? t("sess.reading"))
            draw("reading") { [] }
            return
        }
        let rows = (v["rows"] as? [[String: Any]] ?? []).map(SessionProc.init)
        let ticked = rows.filter(isTicked)
        let kb = ticked.reduce(0) { $0 + $1.memKb }
        let busy = closing || v["closing"] as? Bool == true
        let title = busy ? t("sess.closing") : ticked.isEmpty ? t("sess.nothingTicked") : t("sess.closeN", ["what": sessions(ticked.count), "mem": SessionProc.mem(kb)])
        let close = RButton(title, .primary) { [weak self] in self?.close() }
        close.isEnabled = !ticked.isEmpty && !busy
        buttons["closeSessions"] = close
        let count = (v["count"] as? NSNumber)?.intValue ?? rows.count
        let total = (v["totalKb"] as? NSNumber)?.doubleValue ?? 0
        setHead(title: t("sess.title"), src: t(count == 1 ? "sess.src1" : "sess.src", ["what": sessions(count), "mem": SessionProc.mem(total)]), extra: [close])
        let sig = "\(stableText(v).hashValue)|\(ticks)|\(closing)|\(stableText(result ?? [:]).hashValue)|\(reopening.sorted())|\(showAllClosed)|\(wide)"
        draw(sig) { self.rows(v, rows) }
    }

    // MARK: drawing

    private func rows(_ v: [String: Any], _ rows: [SessionProc]) -> [NSView] {
        boxes = [:]
        var out: [NSView] = []
        if let r = result ?? (v["result"] as? [String: Any]) { if let x = resultView(r) { out.append(x) } }
        out.append(meter(rows))
        let hours = (v["idleHours"] as? NSNumber)?.doubleValue ?? 24
        // "24 h", or minutes under an hour.
        let h = hours >= 1 ? "\(Int(hours.rounded())) h" : "\(max(1, Int((hours * 60).rounded()))) min"
        out.append(wrap(t("sess.rule", ["h": h]), Fonts.pt(12), "tx3"))
        let left = vstack(leftCards(rows, h), spacing: 12)
        let right = vstack(rightCards(v, rows), spacing: 12)
        if wide {
            let both = NSStackView(views: [left, right])
            both.orientation = .horizontal
            both.alignment = .top
            both.distribution = .fill
            both.spacing = 16
            both.translatesAutoresizingMaskIntoConstraints = false
            // The tick list wider (flex-basis 560), the other column the rest.
            left.widthAnchor.constraint(equalTo: right.widthAnchor, multiplier: 1.3).isActive = true
            out.append(both)
        } else {
            out.append(left)
            out.append(right)
        }
        return out
    }

    private func resultView(_ r: [String: Any]) -> NSView? {
        var lines: [NSView] = []
        let n = (r["closed"] as? NSNumber)?.intValue ?? 0
        if n > 0 {
            lines.append(wrap(t("sess.closed", ["what": sessions(n), "mem": SessionProc.mem((r["freedKb"] as? NSNumber)?.doubleValue ?? 0),
                                                "now": SessionProc.mem((r["nowKb"] as? NSNumber)?.doubleValue ?? 0)]), Fonts.pt(13, .semibold), "ok"))
        }
        for f in r["failed"] as? [[String: Any]] ?? [] {
            lines.append(wrap(t("sess.leftOpen", ["label": f["label"] as? String ?? "", "why": f["error"] as? String ?? ""]), Fonts.pt(12.5), "bad"))
        }
        return lines.isEmpty ? nil : vstack(lines, spacing: 4)
    }

    /// The memory by state: a bar and its legend.
    private func meter(_ rows: [SessionProc]) -> NSView {
        let mix: [(String, String, String)] = [("you", t("sess.mixYou"), "you"), ("work", t("sess.mixWork"), "work"), ("wait", t("sess.mixWait"), "wait"),
                                               ("idle", t("sess.mixIdle"), "idle"), ("unmapped", t("sess.mixUnmapped"), "tx3")]
        var by: [String: Double] = [:]
        for r in rows { by[r.mix, default: 0] += r.memKb }
        let parts = mix.filter { (by[$0.0] ?? 0) > 0 }
        let bar = MixBar(parts.map { (by[$0.0] ?? 0, $0.2) })
        bar.setAccessibilityLabel(parts.map { "\($0.1) \(SessionProc.mem(by[$0.0] ?? 0))" }.joined(separator: ", "))
        let legend = parts.map { p -> NSView in
            let d = Box(fill: p.2, radius: 2)
            d.translatesAutoresizingMaskIntoConstraints = false
            d.widthAnchor.constraint(equalToConstant: 8).isActive = true
            d.heightAnchor.constraint(equalToConstant: 8).isActive = true
            return hstack([d, fixedLabel(p.1, Fonts.pt(12), "tx2"), fixedLabel(SessionProc.mem(by[p.0] ?? 0), Fonts.pt(12).withTabularDigits, "tx")], spacing: 5)
        }
        return vstack([bar, hstack(legend + [spring()], spacing: 14)], spacing: 8)
    }

    /// A card: its title and what it counts on one line, its rows under a line each.
    private func card(_ title: String, _ sub: String, _ rows: [NSView]) -> NSView {
        let head = hstack([yields(label(title, Fonts.pt(13, Fonts.w650))), fixedLabel(sub, Fonts.pt(12, .medium).withTabularDigits, "tx2")], spacing: 8,
                          insets: NSEdgeInsets(top: 11, left: 14, bottom: 9, right: 14))
        var items: [NSView] = [head]
        for r in rows {
            let line = Box(fill: "sep")
            line.translatesAutoresizingMaskIntoConstraints = false
            line.heightAnchor.constraint(equalToConstant: 1).isActive = true
            items.append(line)
            items.append(r)
        }
        return boxed(vstack(items, spacing: 0), fill: "card", radius: 10, insets: NSEdgeInsetsZero)
    }

    private func countMem(_ rows: [SessionProc]) -> String { "\(sessions(rows.count)), \(SessionProc.mem(rows.reduce(0) { $0 + $1.memKb }))" }

    private func note(_ s: String) -> NSView {
        let w = wrap(s, Fonts.pt(12.5), "tx2")
        return vstack([w], insets: NSEdgeInsets(top: 10, left: 14, bottom: 11, right: 14))
    }

    private func leftCards(_ rows: [SessionProc], _ h: String) -> [NSView] {
        let age = { (r: SessionProc) -> Double in When.date(r.since)?.timeIntervalSince1970 ?? 0 }
        let handed = rows.filter { $0.group == "handed" }.sorted { age($0) != age($1) ? age($0) < age($1) : $0.memKb > $1.memKb }
        let idle = rows.filter { $0.group == "idle" }.sorted { $0.memKb > $1.memKb }
        let left = rows.filter { $0.group == "left" }.sorted { $0.memKb > $1.memKb }
        var out: [NSView] = []
        if !handed.isEmpty { out.append(card(t("sess.handed"), countMem(handed), handed.map(tickRow))) }
        if !idle.isEmpty { out.append(card(t("sess.idleFor", ["h": h]), countMem(idle), idle.map(tickRow))) }
        if !left.isEmpty { out.append(card(t("sess.left"), countMem(left), left.map(tickRow))) }
        if out.isEmpty { out.append(card(t("sess.nothingIdle"), "", [note(t("sess.nothingIdleText", ["h": h]))])) }
        return out
    }

    /// A session that can go: its tick, where it is and what it last said, its chips, how long it has been quiet and its memory.
    private func tickRow(_ r: SessionProc) -> NSView {
        let can = r.canClose
        let id = r.sessionId ?? "pid-\(r.pid)"
        let box = NSButton(checkboxWithTitle: "", target: nil, action: nil)
        box.state = isTicked(r) ? .on : .off
        box.isEnabled = can
        box.setContentHuggingPriority(.required, for: .horizontal)
        box.setContentCompressionResistancePriority(.required, for: .horizontal)
        let a11y = "\(r.label): \(r.line), \(idleWord(r)), \(SessionProc.mem(r.memKb))\(can ? "" : ". " + r.whyNot)"
        box.setAccessibilityLabel(a11y)
        let flip = { [weak self] in
            guard let self, can, let sid = r.sessionId else { return }
            self.ticks[sid] = !self.isTicked(r)
            self.redraw()
        }
        box.target = PopTarget.shared
        box.action = #selector(PopTarget.toggled(_:))
        PopTarget.shared.run[ObjectIdentifier(box)] = { [weak self, weak box] in
            guard let self, can, let sid = r.sessionId else { return }
            self.ticks[sid] = box?.state == .on
            self.redraw()
        }
        boxes[id] = box
        let name = label(r.label, Fonts.pt(13, r.isFolder ? .medium : .semibold), r.isFolder ? "tx2" : "tx")
        name.setContentCompressionResistancePriority(.init(240), for: .horizontal)
        name.setContentHuggingPriority(.required, for: .horizontal)
        let line = yields(label(r.line, Fonts.pt(12.5), "tx2"))
        var chips: [NSView?] = []
        if r.tag == "draft" { chips.append(pill(t("sess.tagDraft"), "you")) }
        if r.tag == "asked" { chips.append(pill(t("sess.tagAsked"), "you")) }
        if !can, let b = r.blocked { let p = pill(b.range(of: "^(Outside|In) \\S+$", options: .regularExpression) != nil ? b : t("sess.cannotCloseShort"), nil); p.toolTip = b; chips.append(p) }
        if let a = r.assistant { chips.append(assistantChip(a == "codex" ? "Codex" : "Claude")) }
        let top = hstack([name, line] + chips, spacing: 8)
        // How long it has been quiet over its memory, both whole, flush right.
        let right = NSStackView(views: [fixedLabel(idleWord(r), Fonts.pt(12).withTabularDigits, "tx3"), fixedLabel(SessionProc.mem(r.memKb), Fonts.pt(12, .medium).withTabularDigits, "tx2")])
        right.orientation = .vertical
        right.alignment = .trailing
        right.spacing = 1
        right.setClippingResistancePriority(.required, for: .horizontal)
        let row = PressRow { flip() }
        let s = hstack([box, top, right], spacing: 10, insets: NSEdgeInsets(top: 9, left: 12, bottom: 9, right: 14))
        row.addSubview(s)
        s.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([s.leadingAnchor.constraint(equalTo: row.leadingAnchor), s.trailingAnchor.constraint(equalTo: row.trailingAnchor),
                                     s.topAnchor.constraint(equalTo: row.topAnchor), s.bottomAnchor.constraint(equalTo: row.bottomAnchor)])
        row.toolTip = [r.folder, r.sessionId.map { "session \($0.prefix(8))" }, "pid \(r.pid)", can ? nil : r.whyNot].compactMap { $0 }.joined(separator: ", ")
        row.enabled = can
        return row
    }

    private func idleWord(_ r: SessionProc) -> String {
        guard r.since != nil else { return "" }
        let a = When.ago(r.since)
        return r.group == "handed" ? t("sess.handedAgo", ["ago": a]) : a
    }

    private func rightCards(_ v: [String: Any], _ rows: [SessionProc]) -> [NSView] {
        let order = ["you", "work", "wait", "idle"]
        let byMix = { (a: SessionProc, b: SessionProc) -> Bool in
            let x = order.firstIndex(of: a.mix) ?? 9, y = order.firstIndex(of: b.mix) ?? 9
            return x != y ? x < y : a.memKb > b.memKb
        }
        let use = rows.filter { $0.group == "use" && !$0.unowned }.sorted(by: byMix)
        let useUn = rows.filter { $0.group == "use" && $0.unowned }.sorted(by: byMix)
        var out: [NSView] = []
        out.append(card(t("sess.inUseTitle"), use.isEmpty ? t("sess.none") : countMem(use),
                        use.isEmpty ? [note(useUn.isEmpty ? t("sess.allIdle") : t("sess.allIdleProject"))] : use.map(useRow)))
        if !useUn.isEmpty { out.append(card(t("sess.notInProject"), countMem(useUn), useUn.map(useRow))) }
        let un = rows.filter { $0.group == "unmapped" }
        if !un.isEmpty {
            out.append(card(t("sess.notMapped"), countMem(un), un.map { r in
                infoRow([yields(label(r.label, Fonts.pt(12.5, .medium), "tx2"), fill: false), yields(label(t("sess.notMappedLine", ["pid": "\(r.pid)"]), Fonts.pt(12.5), "tx3"))],
                        mem: r.memKb, tip: r.folder)
            }))
        }
        let closed = v["closed"] as? [[String: Any]] ?? []
        let shown = showAllClosed ? closed : Array(closed.prefix(6))
        var crow: [NSView] = shown.map(closedRow)
        if closed.count > 6 {
            let b = RButton(showAllClosed ? t("sess.showFewer") : t("sess.showAll"), .link) { [weak self] in
                guard let self else { return }
                self.showAllClosed.toggle()
                self.redraw()
            }
            buttons["showAll"] = b
            crow.append(vstack([hstack([label(showAllClosed ? "" : t("sess.more", ["n": "\(closed.count - 6)"]), Fonts.pt(12), "tx2"), spring(), b], spacing: 8)],
                               insets: NSEdgeInsets(top: 9, left: 14, bottom: 9, right: 14)))
        }
        if closed.isEmpty { crow = [note(t("sess.recentEmpty"))] }
        out.append(card(t("sess.recent"), closed.isEmpty ? t("sess.noneYet") : t("sess.recentSub", ["what": sessions(closed.count)]), crow))
        if !closed.isEmpty { out.append(wrap(t("sess.reopenNote"), Fonts.pt(12), "tx3")) }
        return out
    }

    /// A session at work: its state, where, what it does, its chip and memory. A press opens it.
    private func useRow(_ r: SessionProc) -> NSView {
        let ring = Icon("ring-\(["you", "work", "wait"].contains(r.mix) ? r.mix : "idle")", r.mix == "idle" ? "tx3" : r.mix, size: 13)
        let name = label(r.label, Fonts.pt(12.5, r.unowned ? .medium : .semibold), r.unowned ? "tx2" : "tx")
        name.setContentCompressionResistancePriority(.init(240), for: .horizontal)
        name.setContentHuggingPriority(.required, for: .horizontal)
        var items: [NSView?] = [ring, name, yields(label(r.line, Fonts.pt(12.5), "tx2"))]
        if let a = r.assistant { items.append(assistantChip(a == "codex" ? "Codex" : "Claude")) }
        let v = infoRow(items, mem: r.memKb, tip: [r.folder, r.sessionId.map { "session \($0.prefix(8))" }, "pid \(r.pid)"].compactMap { $0 }.joined(separator: ", "))
        if let pid = r.projectId, let sf = r.surfaceId, hub?.state?.find("\(pid)/\(sf)") != nil, let p = v as? PressRow {
            p.run = { [weak self] in self?.openSession?("\(pid)/\(sf)") }
            p.setAccessibilityRole(.button)
        }
        return v
    }

    private func infoRow(_ items: [NSView?], mem: Double, tip: String?) -> NSView {
        let row = PressRow(nil)
        let s = hstack(items + [fixedLabel(SessionProc.mem(mem), Fonts.pt(12).withTabularDigits, "tx")], spacing: 9, insets: NSEdgeInsets(top: 9, left: 14, bottom: 9, right: 14))
        row.addSubview(s)
        s.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([s.leadingAnchor.constraint(equalTo: row.leadingAnchor), s.trailingAnchor.constraint(equalTo: row.trailingAnchor),
                                     s.topAnchor.constraint(equalTo: row.topAnchor), s.bottomAnchor.constraint(equalTo: row.bottomAnchor)])
        row.toolTip = tip
        return row
    }

    /// A closed session: where, when, its last line, its memory, Reopen.
    private func closedRow(_ c: [String: Any]) -> NSView {
        let id = c["id"] as? String ?? ""
        let name = label(c["label"] as? String ?? c["project"] as? String ?? t("sess.session"), Fonts.pt(12.5, .semibold))
        name.setContentCompressionResistancePriority(.init(240), for: .horizontal)
        let at = c["closedAt"] as? String
        let ago = When.ago(at) == "now" ? t("sess.closedNow") : t("sess.closedAgo", ["ago": When.ago(at)])
        let top = hstack([name, fixedLabel(ago, Fonts.pt(12).withTabularDigits, "tx3"), spring(), fixedLabel(SessionProc.mem((c["memKb"] as? NSNumber)?.doubleValue ?? 0), Fonts.pt(12).withTabularDigits, "tx3")], spacing: 8)
        let col = vstack([top, (c["lastLine"] as? String).map { yields(label($0, Fonts.pt(12), "tx2")) }], spacing: 2)
        col.setHuggingPriority(.init(1), for: .horizontal)
        let busy = reopening.contains(id)
        let b = RButton(busy ? t("sess.reopening") : t("sess.reopen"), small: true) { [weak self] in self?.reopen(id, c["label"] as? String) }
        b.isEnabled = !busy
        b.setAccessibilityLabel(t("sess.reopenA11y", ["label": c["label"] as? String ?? t("sess.session")]))
        buttons["reopen:\(id)"] = b
        return hstack([col, b], spacing: 10, insets: NSEdgeInsets(top: 9, left: 14, bottom: 9, right: 14))
    }

    // MARK: what the person clicked

    /// Close the ticked sessions: the hub checks each again, ends Claude in its tab and keeps a Reopen.
    func close() {
        let ids = tickedIds
        guard !ids.isEmpty, !closing, let hub else { return }
        closing = true
        result = nil
        redraw()
        hub.post("/api/sessions/close", ["ids": ids]) { [weak self] code, j in
            guard let self else { return }
            self.closing = false
            if code == 200 {
                self.result = j
                self.ticks = [:]
                if (j["closed"] as? NSNumber)?.intValue ?? 0 == 0, !(j["failed"] as? [Any] ?? []).isEmpty { self.toast?(t("sess.closeFailed")) }
            } else { self.toast?(j["error"] as? String ?? t("page.didNotWork")) }
            self.dirty()
            self.redraw()
        }
    }

    func reopen(_ id: String, _ name: String?) {
        guard let hub, !reopening.contains(id) else { return }
        reopening.insert(id)
        redraw()
        hub.post("/api/sessions/reopen", ["id": id]) { [weak self] code, j in
            guard let self else { return }
            self.reopening.remove(id)
            if code == 200 { self.toast?(t("sess.reopened", ["label": j["label"] as? String ?? name ?? t("sess.session")])) }
            else { self.toast?(t("sess.reopenFailed", ["why": j["error"] as? String ?? "\(code)"])) }
            self.dirty()
            self.redraw()
        }
    }
}

/// A row pressed as a whole (a tick row toggles its tick; a session at work opens), lit on hover.
final class PressRow: Box {
    var run: (() -> Void)?
    var enabled = true
    private var hover = false { didSet { fill = hover && run != nil && enabled ? "sel" : nil } }
    init(_ run: (() -> Void)?) {
        self.run = run
        super.init(radius: 0)
        translatesAutoresizingMaskIntoConstraints = false
    }
    required init?(coder: NSCoder) { fatalError() }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for t in trackingAreas { removeTrackingArea(t) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with e: NSEvent) { hover = true }
    override func mouseExited(with e: NSEvent) { hover = false }
    override func mouseDown(with e: NSEvent) { if enabled { run?() } }
    /// Its own buttons (the tick, Reopen) take their press.
    override func hitTest(_ p: NSPoint) -> NSView? {
        guard let v = super.hitTest(p) else { return nil }
        var x: NSView? = v
        while let c = x, c !== self { if c is NSButton { return v }; x = c.superview }
        if LinkField.takes(v, p, from: superview) { return v }
        return run == nil ? v : self
    }
    override func accessibilityPerformPress() -> Bool { if enabled { run?() }; return run != nil }
}

/// The memory by state: one rounded bar, each state's share in its colour.
final class MixBar: Flipped {
    private let parts: [(Double, String)]
    init(_ parts: [(Double, String)]) {
        self.parts = parts
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 8).isActive = true
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ r: NSRect) {
        NSBezierPath(roundedRect: bounds, xRadius: 4, yRadius: 4).addClip()
        Design.color("card2").setFill()
        bounds.fill()
        let total = parts.reduce(0) { $0 + $1.0 }
        guard total > 0 else { return }
        var x: CGFloat = 0
        let gaps = CGFloat(max(0, parts.count - 1)) * 2
        for (v, c) in parts {
            let w = (bounds.width - gaps) * CGFloat(v / total)
            Design.color(c).setFill()
            NSRect(x: x, y: 0, width: w, height: bounds.height).fill()
            x += w + 2
        }
    }
    override func viewDidChangeEffectiveAppearance() { needsDisplay = true }
}

extension PopTarget {
    /// A tick box's change, run by its closure.
    @objc func toggled(_ b: NSButton) { run[ObjectIdentifier(b)]?() }
}

extension Board {
    /// A sidebar row's right-click Close: the hub checks each again and ends
    /// it in its tab; the toast says what happened, with Reopen (one) or
    /// Show (the Sessions page, where Recently closed has them all).
    func closeFromSidebar(_ ids: [String], _ name: String) {
        hub.post("/api/sessions/close", ["ids": ids]) { [weak self] code, j in
            guard let self else { return }
            guard code == 200 else { self.toast(j["error"] as? String ?? t("page.didNotWork")); return }
            let n = (j["closed"] as? NSNumber)?.intValue ?? 0
            let failed = j["failed"] as? [[String: Any]] ?? []
            if n == 0, let f = failed.first {
                self.toast(t("sess.leftOpen", ["label": f["label"] as? String ?? name, "why": f["error"] as? String ?? ""]), action: (t("sess.showSessions"), { [weak self] in self?.openPage("sessions", t("sess.title")) }))
                return
            }
            let mem = SessionProc.mem((j["freedKb"] as? NSNumber)?.doubleValue ?? 0)
            if n == 1, ids.count == 1 {
                self.toast(t("sess.closedOne", ["label": name, "mem": mem]), action: (t("sess.reopen"), { [weak self] in
                    self?.hub.post("/api/sessions/reopen", ["id": ids[0]]) { code, j in
                        self?.toast(code == 200 ? t("sess.reopened", ["label": j["label"] as? String ?? name]) : t("sess.reopenFailed", ["why": j["error"] as? String ?? "\(code)"]))
                    }
                }))
            } else {
                self.toast(t("sess.closedSome", ["what": SessionsPage.plural(n, t("sess.one"), t("sess.many")), "mem": mem]), action: (t("sess.showSessions"), { [weak self] in self?.openPage("sessions", t("sess.title")) }))
            }
        }
    }

    /// Hand off now from a row's right-click menu, as the panel's button posts it.
    func handOffFromSidebar(_ key: String) {
        guard let f = hub.state?.find(key) else { return }
        hub.post("/api/handoff", ["projectId": f.project.id, "surfaceId": f.session.surfaceId]) { [weak self] code, j in
            self?.toast(code == 200 ? t("session.handOffQueued") : (j["error"] as? String ?? "\(code)"))
        }
    }
}

extension Board {
    /// What group 2's views need from the window: the sidebar's right-click
    /// actions and its lease line, the Sessions page's way to a session, a
    /// pane shown from the panel or the project page.
    func wireSessions() {
        sidebar.onCloseSessions = { [weak self] ids, name in self?.closeFromSidebar(ids, name) }
        sidebar.onHandOff = { [weak self] k in self?.handOffFromSidebar(k) }
        sidebar.useLine = { [weak self] k in self?.useLineOf(k) }
        sessionsPage.openSession = { [weak self] k in self?.pickSession(k, why: "sessions page") }
        projectPage.onShowPane = { [weak self] pane in self?.showPane(pane) ?? false }
        panel.host?.showPane = { [weak self] pane in self?.showPane(pane) ?? false }
        panel.host?.paneLabels = { [weak self] pane in self?.ws.paneInfo(pane)?.labels }
        panel.host?.whoOf = { [weak self] src in
            guard let self else { return ("You", nil) }
            let w = self.sourceOf(src)
            return (w.who, w.place)
        }
        panel.host?.redraw = { [weak self] in self?.render(force: true) }
        panel.host?.driveFacts = { [weak self] cp in self?.driveFacts(cp) }
        // A page's run button: its approval card over the page (B18).
        files.host?.showCheckpoint = { [weak self] id in self?.showCheckpoint(id) }
        // The one-time hints: their marks read once, the window drawn again when one is dismissed.
        sidebar.onLearn = { [weak self] k in self?.openLearn(lit: k) }
        picker.onLearn = { [weak self] k in self?.openLearn(lit: k) }
        Hints.shared.hub = hub
        Hints.shared.load()
        NotificationCenter.default.addObserver(forName: Hints.changed, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.render(force: true)
            if case .page(let k, _) = self.front, k.hasPrefix("pick:") { self.picker.draw() }
        }
    }

    /// A drive card's pane said as the Electron app says it (cardCtx.drive): what it is, who asks from which session, opened by whom and when, its folder.
    func driveFacts(_ cp: [String: Any]) -> DriveFacts? {
        guard let d = cp["drive"] as? [String: Any] else { return nil }
        let asker = sourceOf(d["agent"] as? [String: Any])
        let pane = d["pane"] as? String ?? ""
        let i = pane.isEmpty ? nil : ws.paneInfo(pane)
        let c = i?.creator
        let byPerson = c == nil || c?["kind"] as? String == "person"
        let shellish = i.map { ($0.command.first ?? "").range(of: "(^|/)(zsh|bash|sh|fish|login)$", options: .regularExpression) != nil || $0.labels["ravenry.kind"] == "shell" } ?? false
        var what: String
        if let st = hub.state, let s = st.projects.flatMap({ $0.sessions }).first(where: { $0.pane == pane && $0.machine == nil }) {
            what = t("checkpoint.whatSession", ["who": s.assistant == "codex" ? "Codex" : s.assistant == "claude" || s.assistant == nil ? "Claude" : s.assistant!])
        } else if byPerson { what = shellish ? t("checkpoint.whatShell") : t("checkpoint.whatYours") }
        else { what = t("checkpoint.whatOwn", ["who": sourceOf(c).who]) }
        if i == nil, pane.isEmpty { what = "" }
        let opened = i.map { t("checkpoint.openedBy", ["by": byPerson ? t("checkpoint.you") : sourceOf(c).who, "time": When.clock($0.createdAt)]) }
        let folder = i.flatMap { $0.cwd.isEmpty ? nil : ($0.cwd.hasPrefix(NSHomeDirectory()) ? "~" + $0.cwd.dropFirst(NSHomeDirectory().count) : $0.cwd) }
        return DriveFacts(what: what, session: asker.place, opened: opened, folder: folder)
    }

    /// The tab of a pane of this window in front (a click on its tab); false when this window has no such pane.
    @discardableResult
    func showPane(_ pane: String) -> Bool {
        guard let tb = ws.tab(showing: pane) else { return false }
        ws.bar.onSelect?(tb.id)
        return true
    }

    /// A session's row's second line from the leases of this window's
    /// daemon (app.ts useLine): "Using dev server" while its agent holds a
    /// pane, "Waiting for dev server, Claude has it" while it waits for one.
    func useLineOf(_ key: String) -> (holds: Bool, text: String)? {
        guard let f = hub.state?.find(key), let agent = f.session.pane, f.session.machine == nil, f.project.machine == nil, ws.paneInfo(agent) != nil else { return nil }
        for id in ws.paneIDs() where id != agent {
            guard let l = leaseOf(id) else { continue }
            if (l["holder"] as? [String: Any])?["pane"] as? String == agent { return (true, t("side.using", ["pane": ws.label(id).name])) }
        }
        for id in ws.paneIDs() where id != agent {
            guard let l = leaseOf(id), (l["waiting"] as? [[String: Any]] ?? []).contains(where: { $0["pane"] as? String == agent }) else { continue }
            return (false, t("side.waitingFor", ["pane": ws.label(id).name, "who": sourceOf(l["holder"] as? [String: Any]).who]))
        }
        return nil
    }
}
