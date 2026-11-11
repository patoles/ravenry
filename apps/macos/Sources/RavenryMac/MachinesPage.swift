// The Machines page (MACH-001 to MACH-004), as the Electron app draws it
// (machines.ts, machines.css): the computers the hub reaches over ssh, each
// in its card with its state, its ravenryd beside this app's, what to do and
// the steps of its last install or uninstall; Add a machine with the hosts
// of ~/.ssh/config. What each card says, its buttons and their routes are
// the hub's (`card` of each machine, hub/server/machineview.mjs): this page
// draws them and posts the button's route. GET /api/machines, read again
// every 4 s, every half second while a job runs or a machine connects.

import AppKit

/// Words in runs as the hub sends them ({text, b, mono, cmd}), at a size and colour.
func runs(_ list: Any?, _ size: CGFloat, _ color: String = "tx2", bold: String = "tx") -> NSAttributedString {
    let out = NSMutableAttributedString()
    for r in list as? [[String: Any]] ?? [] {
        let s = r["text"] as? String ?? ""
        var a: [NSAttributedString.Key: Any] = [.font: Fonts.pt(size), .foregroundColor: Design.color(color)]
        if r["b"] as? Bool == true { a[.font] = Fonts.pt(size, .semibold); a[.foregroundColor] = Design.color(bold) }
        if r["mono"] as? Bool == true { a[.font] = NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular) }
        if r["cmd"] as? Bool == true {
            a[.font] = NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular)
            a[.foregroundColor] = Design.color("tx")
            a[.backgroundColor] = Design.color("card2")
            out.append(NSAttributedString(string: "\u{2009}" + s + "\u{2009}", attributes: a))
            continue
        }
        out.append(NSAttributedString(string: s, attributes: a))
    }
    let p = NSMutableParagraphStyle()
    p.lineHeightMultiple = 1.15
    out.addAttribute(.paragraphStyle, value: p, range: NSRange(location: 0, length: out.length))
    return out
}

/// Runs that wrap, selectable.
func wrapRuns(_ list: Any?, _ size: CGFloat, _ color: String = "tx2") -> CappedText {
    let c = wrap("", Fonts.pt(size), color)
    c.text.attributedStringValue = runs(list, size, color)
    return c
}

/// A step's mark (machines.ts ICON): done, failed, warn, pending, running.
final class StepMark: NSView {
    let state: String
    init(_ state: String) {
        self.state = state
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 16).isActive = true
        heightAnchor.constraint(equalToConstant: 16).isActive = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func draw(_ r: NSRect) {
        let k: CGFloat = 15 / 14
        let tr = NSAffineTransform(); tr.translateX(by: 0.5, yBy: 1.5); tr.scale(by: k); tr.concat()
        let c = NSBezierPath(ovalIn: NSRect(x: 1.2, y: 1.2, width: 11.6, height: 11.6))
        c.lineCapStyle = .round; c.lineJoinStyle = .round
        switch state {
        case "done":
            Design.color("ok").setStroke(); c.lineWidth = 1.7; c.stroke()
            let p = NSBezierPath(); p.move(to: NSPoint(x: 4.4, y: 7.2)); p.line(to: NSPoint(x: 6.2, y: 9)); p.line(to: NSPoint(x: 9.6, y: 5.4)); p.lineWidth = 1.7; p.lineCapStyle = .round; p.lineJoinStyle = .round; p.stroke()
        case "failed":
            Design.color("bad").setStroke(); c.lineWidth = 1.7; c.stroke()
            let p = NSBezierPath(); p.move(to: NSPoint(x: 5, y: 5)); p.line(to: NSPoint(x: 9, y: 9)); p.move(to: NSPoint(x: 9, y: 5)); p.line(to: NSPoint(x: 5, y: 9)); p.lineWidth = 1.7; p.lineCapStyle = .round; p.stroke()
        case "warn":
            Design.color("you").setStroke()
            let p = NSBezierPath(); p.move(to: NSPoint(x: 7, y: 1.8)); p.line(to: NSPoint(x: 12.6, y: 11.8)); p.line(to: NSPoint(x: 1.4, y: 11.8)); p.close(); p.lineWidth = 1.5; p.lineJoinStyle = .round; p.stroke()
            let q = NSBezierPath(); q.move(to: NSPoint(x: 7, y: 5.6)); q.line(to: NSPoint(x: 7, y: 8.4)); q.move(to: NSPoint(x: 7, y: 10.2)); q.line(to: NSPoint(x: 7, y: 10.21)); q.lineWidth = 1.5; q.lineCapStyle = .round; q.stroke()
        case "running":
            Design.color("work").setStroke()
            let d = NSBezierPath(ovalIn: NSRect(x: 1.5, y: 1.5, width: 11, height: 11)); d.lineWidth = 1.7; d.setLineDash([3, 2], count: 2, phase: 0); d.stroke()
            Design.color("work").setFill(); NSBezierPath(ovalIn: NSRect(x: 5, y: 5, width: 4, height: 4)).fill()
        default:
            Design.color("idle").setStroke()
            let d = NSBezierPath(ovalIn: NSRect(x: 1.5, y: 1.5, width: 11, height: 11)); d.lineWidth = 1.5; d.stroke()
        }
    }
}

final class MachinesPage: FormPage {
    /// Copies a fix's command (the pasteboard; recorded when offscreen).
    var copy: ((String) -> Void)?
    /// The sidebar's dot follows the list.
    var onList: (() -> Void)?
    private(set) var list: [[String: Any]] = []
    private(set) var hosts: [String] = []
    private(set) var builds: [String: Any]?
    private(set) var loaded = false
    private(set) var adding = false
    private(set) var addError: String?
    /// The machine whose Uninstall asks first.
    private(set) var confirm: String?
    /// Jobs whose steps the person put away (Hide steps, Cancel), by "<name>|<startedAt>".
    private(set) var folded = Set<String>()
    private(set) var errors: [String: String] = [:]
    private(set) var working = Set<String>()
    /// The hub's answers are not read again (the self-test's shapes).
    private var held = false
    private var every: TimeInterval = 4

    func show() {
        confirm = nil
        dirty()
        held = false
        load()
        redraw()
    }

    override func viewDidHide() { super.viewDidHide(); confirm = nil }

    override func load() {
        guard !held else { return }
        hub?.get("/api/machines") { [weak self] code, j in
            guard let self, !self.held else { return }
            if code == 200 {
                self.list = j["machines"] as? [[String: Any]] ?? []
                self.hosts = j["hosts"] as? [String] ?? []
                self.builds = j["builds"] as? [String: Any]
                self.loaded = true
                self.onList?()
            }
            let fast = self.list.contains { ($0["card"] as? [String: Any])?["running"] as? Bool == true || $0["state"] as? String == "connecting" }
            let want: TimeInterval = fast ? 0.5 : 4
            if want != self.every || !self.polling { self.every = want; self.poll(want); self.polling = true }
            self.redraw()
        }
    }
    private var polling = false
    override func viewDidUnhide() { super.viewDidUnhide(); polling = false }

    /// The self-test's: a listing as the hub sends it, kept.
    func apply(_ j: [String: Any]) {
        held = true; poll(nil); polling = false
        list = j["machines"] as? [[String: Any]] ?? []
        hosts = j["hosts"] as? [String] ?? []
        builds = j["builds"] as? [String: Any]
        loaded = true
        dirty(); redraw()
    }

    /// Whether any machine needs the person (the dot on the sidebar's mark): the state's machines, else the page's.
    func attention(in st: HubState?) -> Bool {
        let l = held || st == nil ? list : (st?.raw["machines"] as? [[String: Any]] ?? list)
        return l.contains { needs($0) }
    }
    private func folded(_ m: [String: Any]) -> Bool { (card(m)["job"] as? [String: Any]).map { folded.contains($0["key"] as? String ?? "") } ?? false }
    private func card(_ m: [String: Any]) -> [String: Any] { m["card"] as? [String: Any] ?? [:] }
    private func needs(_ m: [String: Any]) -> Bool { card(m)[folded(m) ? "needsFolded" : "needs"] as? Bool ?? false }
    private func name(_ m: [String: Any]) -> String { m["name"] as? String ?? "" }

    /// A button's route posted for a machine: its card waits, an error is said under it.
    func post(_ route: String, _ body: [String: Any], _ name: String) {
        guard let hub, !working.contains(name) else { return }
        confirm = nil
        working.insert(name)
        errors[name] = nil
        dirty(); redraw()
        hub.post(route, body) { [weak self] code, j in
            guard let self else { return }
            if code != 200 { self.errors[name] = j["error"] as? String ?? t("mach.answered", ["code": "\(code)"]) }
            else if !self.held, let l = j["machines"] as? [[String: Any]] { self.list = l }
            self.working.remove(name)
            self.dirty(); self.redraw()
            self.load()
        }
    }

    /// Opens the Add card.
    func openAdd(_ host: String = "") {
        adding = true
        addError = nil
        field("m-host", t("mach.hostPh")).text = host
        field("m-name", "devbox").text = ""
        dirty(); redraw()
        if let f = fields["m-host"] { window?.makeFirstResponder(f.field) }
    }

    func add(install: Bool) {
        let host = typed("m-host")
        if host.isEmpty { addError = t("mach.needHost"); dirty(); redraw(); return }
        let given = typed("m-name")
        let name = given.isEmpty ? host.replacingOccurrences(of: "^.*@", with: "", options: .regularExpression) : given
        guard let hub, !working.contains("+add") else { return }
        working.insert("+add"); addError = nil; dirty(); redraw()
        hub.post("/api/machines/add", ["host": host].merging(given.isEmpty ? [:] : ["name": name]) { a, _ in a }) { [weak self] code, j in
            guard let self else { return }
            self.working.remove("+add")
            if code != 200 { self.addError = j["error"] as? String ?? t("mach.answered", ["code": "\(code)"]); self.dirty(); self.redraw(); return }
            if !self.held, let l = j["machines"] as? [[String: Any]] { self.list = l }
            self.adding = false
            self.dirty(); self.redraw()
            if install { self.post("/api/machines/install", ["name": name], name) } else { self.load() }
        }
    }

    override func cancelOperation(_ sender: Any?) { if adding { adding = false; dirty(); redraw() } }

    override func redraw() {
        let addB: RButton? = adding ? nil : RButton(t("mach.add"), .primary, small: true) { [weak self] in self?.openAdd() }
        buttons["add"] = addB
        setHead(title: t("mach.title"), src: t("mach.src"), extra: [addB].compactMap { $0 }, closable: false)
        let sig = "\(adding)|\(addError ?? "")|\(confirm ?? "")|\(folded.sorted())|\(errors)|\(working.sorted())|\(loaded)|\(stableText(list).hashValue)|\(hosts)|\(typed("m-host"))"
        draw(sig) { self.rows() }
    }

    private func rows() -> [NSView] {
        var out: [NSView] = []
        if adding { out.append(addCard()) }
        if list.isEmpty && !adding && loaded {
            let b = RButton(t("mach.add"), .primary) { [weak self] in self?.openAdd() }
            buttons["addEmpty"] = b
            out.append(boxed(vstack([wrap(t("mach.empty"), Fonts.pt(13), "tx2"), hstack([b, spring()], spacing: 0)], spacing: 12), fill: nil, ring: "sep", radius: 10, insets: NSEdgeInsets(top: 18, left: 18, bottom: 18, right: 18)))
        }
        let order = { (m: [String: Any]) -> Int in (self.card(m)[self.folded(m) ? "orderFolded" : "order"] as? Int) ?? 2 }
        let sorted = list.sorted { order($0) != order($1) ? order($0) < order($1) : name($0).localizedCompare(name($1)) == .orderedAscending }
        for m in sorted { out.append(machine(m)) }
        return out
    }

    private func addCard() -> NSView {
        let busy = working.contains("+add")
        let noBuilds = builds == nil
        let host = field("m-host", t("mach.hostPh"), height: 34)
        let nm = field("m-name", "devbox", height: 34)
        let typedHost = typed("m-host")
        nm.field.placeholderAttributedString = NSAttributedString(string: typedHost.isEmpty ? "devbox" : typedHost.replacingOccurrences(of: "^.*@", with: "", options: .regularExpression), attributes: [.font: Fonts.pt(13), .foregroundColor: Design.color("tx3")])
        host.onChange = { [weak self] in self?.dirty(); self?.redraw() }
        host.onReturn = { [weak self] in self?.add(install: !noBuilds) }
        nm.onReturn = { [weak self] in self?.add(install: !noBuilds) }
        let fl = { (title: String, f: NSView) -> NSStackView in vstack([label(title, Fonts.pt(12, .medium), "tx2"), f], spacing: 5) }
        let hostCol = fl(t("mach.host"), host), nameCol = fl(t("mach.name"), nm)
        nameCol.widthAnchor.constraint(equalToConstant: 200).isActive = true
        hostCol.setHuggingPriority(.init(1), for: .horizontal)
        var items: [NSView?] = [label(t("mach.add"), Fonts.pt(14, Fonts.w650)), hstack([hostCol, nameCol], spacing: 10)]
        if !hosts.isEmpty {
            var chips: [NSView] = [label(t("mach.fromConfig"), Fonts.pt(12), "tx3")]
            for x in hosts.prefix(12) {
                let on = typedHost == x
                let c = RButton(x, .normal, small: true) { [weak self] in
                    guard let self else { return }
                    self.fields["m-host"]?.text = x
                    self.dirty(); self.redraw()
                }
                c.setAccessibilityLabel(x)
                if on { c.on = true }
                buttons["chip-\(x)"] = c
                chips.append(on ? boxed(label(x, Fonts.pt(12), "tx"), fill: "work", radius: 6, insets: NSEdgeInsets(top: 4, left: 9, bottom: 4, right: 9)) : c)
            }
            items.append(hstack(chips + [spring()], spacing: 6))
        }
        items.append(wrap(noBuilds ? t("mach.hintNoBuilds") : t("mach.hint", ["version": builds?["version"] as? String ?? ""]), Fonts.pt(12), "tx3"))
        if let e = addError { items.append(wrap(e, Fonts.pt(12.5), "bad")) }
        let addInstall: RButton? = noBuilds ? nil : RButton(t("mach.addInstall"), .primary) { [weak self] in self?.add(install: true) }
        let addOnly = RButton(noBuilds ? t("mach.addPlain") : t("mach.addOnly"), noBuilds ? .primary : .ghost) { [weak self] in self?.add(install: false) }
        let cancel = RButton(t("mach.cancel"), .ghost) { [weak self] in self?.adding = false; self?.dirty(); self?.redraw() }
        for b in [addInstall, addOnly, cancel] { b?.isEnabled = !busy }
        buttons["addInstall"] = addInstall; buttons["addOnly"] = addOnly; buttons["addCancel"] = cancel
        items.append(hstack([addInstall, addOnly, spring(), cancel], spacing: 8))
        let b = boxed(vstack(items, spacing: 12), fill: "sheet", ring: "work", radius: 10, insets: NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16))
        b.ringWidth = 1.5
        return b
    }

    /// A hub button ({label, route, body, style}, or confirm, or fold) for a machine.
    private func button(_ a: [String: Any], _ m: [String: Any], key: String) -> RButton {
        let n = name(m)
        let style = a["style"] as? String ?? ""
        let kind: RButton.Kind = style == "pri" ? .primary : style == "ghost" ? .ghost : style == "danger" ? .no : .normal
        let b = RButton(a["label"] as? String ?? "", kind, small: true) { [weak self] in
            guard let self else { return }
            if a["confirm"] as? Bool == true { self.confirm = n; self.dirty(); self.redraw(); return }
            if a["fold"] as? Bool == true { if let k = (self.card(m)["job"] as? [String: Any])?["key"] as? String { self.folded.insert(k) }; self.dirty(); self.redraw(); return }
            if let r = a["route"] as? String { self.post(r, a["body"] as? [String: Any] ?? ["name": n], n) }
        }
        let running = card(m)["running"] as? Bool ?? false
        b.isEnabled = !working.contains(n) && !running
        buttons["\(n):\(key)"] = b
        return b
    }

    private func machine(_ m: [String: Any]) -> NSView {
        let c = card(m), n = name(m)
        let job = c["job"] as? [String: Any]
        let running = c["running"] as? Bool ?? false
        let isFolded = folded(m)
        let showSteps = job != nil && (running || !isFolded)
        let confirming = confirm == n && !running && c["confirm"] is [String: Any]
        let tone = c["tone"] as? String ?? "off"
        // .m-st: a dot and the word in the state's colour (off: tx3 with an idle dot).
        let dot = Box(fill: tone == "off" ? "idle" : tone, radius: 3.5)
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.widthAnchor.constraint(equalToConstant: 7).isActive = true
        dot.heightAnchor.constraint(equalToConstant: 7).isActive = true
        let st = hstack([dot, label(c["word"] as? String ?? "", Fonts.pt(12, .semibold), tone == "off" ? "tx3" : tone)], spacing: 6)
        st.setContentCompressionResistancePriority(.required, for: .horizontal)
        let hostL = label(m["host"] as? String ?? "", NSFont.monospacedSystemFont(ofSize: 12, weight: .regular), "tx3")
        var head: [NSView?] = [label(n, Fonts.pt(14, Fonts.w650)), hostL, st]
        var tail: [NSView] = []
        if let j = job, j["canHide"] as? Bool == true, showSteps {
            let hide = RButton(t("mach.hideSteps"), .ghost, small: true) { [weak self] in self?.folded.insert(j["key"] as? String ?? ""); self?.dirty(); self?.redraw() }
            buttons["\(n):hide"] = hide
            tail.append(hide)
        }
        if !confirming { for (i, a) in (c["actions"] as? [[String: Any]] ?? []).enumerated() { tail.append(button(a, m, key: "a\(i)")) } }
        // .m-h: flex-wrap; the buttons at the right while there is room, under the name when not.
        var items: [NSView?] = [FlowRow(head.compactMap { $0 }, right: tail, gap: 10)]
        if let msg = c["msg"] as? [[String: Any]], !showSteps { items.append(wrapRuns(msg, 12.5)) }
        let facts = c["facts"] as? [[[String: Any]]] ?? []
        if !facts.isEmpty && !(showSteps && job?["state"] as? String != "done") {
            let fs = facts.map { f -> NSView in NSTextField(labelWithAttributedString: runsFacts(f)) }
            // .m-facts: flex-wrap, 18 apart.
            items.append(FlowRow(fs, right: [], gap: 18, lineGap: 4))
        }
        if showSteps, let j = job { items.append(steps(m, j)) }
        if confirming, let cf = c["confirm"] as? [String: Any] {
            let yes = button(cf["yes"] as? [String: Any] ?? [:], m, key: "confirmYes")
            let no = RButton(t("mach.cancel"), .ghost, small: true) { [weak self] in self?.confirm = nil; self?.dirty(); self?.redraw() }
            buttons["\(n):confirmNo"] = no
            items.append(vstack([wrapRuns(cf["words"], 12.5), hstack([yes, no, spring()], spacing: 8)], spacing: 10))
        }
        if let e = errors[n] { items.append(wrap(e, Fonts.pt(12.5), "bad")) }
        let tag = confirming ? "bad" : (c[isFolded ? "tagFolded" : "tag"] as? String ?? "")
        let b = boxed(vstack(items, spacing: 10), fill: "card", ring: tag.isEmpty ? nil : tag == "bad" ? "bad" : "you", radius: 10, insets: NSEdgeInsets(top: 14, left: 16, bottom: 14, right: 16))
        b.setAccessibilityElement(true)
        b.setAccessibilityRole(.group)
        b.setAccessibilityLabel(n)
        return b
    }

    /// .m-facts b: the version in tx, 500.
    private func runsFacts(_ f: [[String: Any]]) -> NSAttributedString {
        let out = NSMutableAttributedString()
        for r in f {
            let b = r["b"] as? Bool == true
            out.append(NSAttributedString(string: r["text"] as? String ?? "", attributes: [.font: Fonts.pt(12, b ? .medium : .regular), .foregroundColor: Design.color(b ? "tx" : "tx2")]))
        }
        return out
    }

    /// .m-steps: each step's mark, title, words, bar, fix and button, and its time.
    private func steps(_ m: [String: Any], _ j: [String: Any]) -> NSView {
        let n = name(m)
        var rows: [NSView] = []
        for s in j["steps"] as? [[String: Any]] ?? [] {
            let state = s["state"] as? String ?? "pending"
            let tc = state == "failed" ? "bad" : state == "warn" ? "you" : state == "pending" || state == "skipped" ? "tx3" : "tx"
            var bd: [NSView?] = [label(s["title"] as? String ?? "", Fonts.pt(12.5, state == "pending" || state == "skipped" ? .medium : .semibold), tc)]
            if let d = s["detail"] as? [[String: Any]] { bd.append(wrapRuns(d, 12)) }
            if let pct = s["bar"] as? Int {
                let track = Box(fill: "card2", radius: 2)
                let fillB = Box(fill: "work", radius: 0)
                track.translatesAutoresizingMaskIntoConstraints = false
                fillB.translatesAutoresizingMaskIntoConstraints = false
                track.addSubview(fillB)
                track.layer?.masksToBounds = true
                NSLayoutConstraint.activate([track.heightAnchor.constraint(equalToConstant: 4), track.widthAnchor.constraint(equalToConstant: 260),
                                             fillB.leadingAnchor.constraint(equalTo: track.leadingAnchor), fillB.topAnchor.constraint(equalTo: track.topAnchor), fillB.bottomAnchor.constraint(equalTo: track.bottomAnchor),
                                             fillB.widthAnchor.constraint(equalTo: track.widthAnchor, multiplier: CGFloat(max(0, min(100, pct))) / 100)])
                bd.append(boxedTop(track, 6))
            }
            if let fx = s["fix"] as? [String: Any], let cmd = fx["cmd"] as? String {
                let chip = boxed(label(cmd, NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular), "tx", select: true), fill: "card2", radius: 5, insets: NSEdgeInsets(top: 3, left: 7, bottom: 3, right: 7))
                let cp = RButton(t("mach.copy"), .ghost, small: true) { [weak self] in self?.copy?(cmd); self?.toast?(t("mach.copied")) }
                buttons["\(n):copy-\(s["id"] as? String ?? "")"] = cp
                bd.append(boxedTop(hstack([(fx["what"] as? String).map { label($0, Fonts.pt(12), "tx2") }, chip, cp, spring()], spacing: 8), 6))
            }
            if let act = s["action"] as? [String: Any] {
                var row: [NSView?] = []
                for (i, a) in (act["buttons"] as? [[String: Any]] ?? []).enumerated() {
                    let b = button(a, m, key: "step-\(s["id"] as? String ?? "")-\(i)")
                    b.isEnabled = !working.contains(n)
                    row.append(b)
                }
                if let h = act["hint"] as? String { row.append(label(h, Fonts.pt(12), "tx3")) }
                bd.append(boxedTop(hstack(row + [spring()], spacing: 8), 6))
            }
            let col = vstack(bd, spacing: 2)
            // .bd { flex: 1 }: the time at the row's right.
            col.setHuggingPriority(.init(1), for: .horizontal)
            col.setContentCompressionResistancePriority(.init(1), for: .horizontal)
            let tm = (s["time"] as? String).map { label($0, Fonts.pt(11.5).withTabularDigits, "tx3") }
            let mark = StepMark(s["icon"] as? String ?? state)
            let r = NSStackView(views: [mark, col] + [tm].compactMap { $0 })
            r.orientation = .horizontal; r.alignment = .top; r.spacing = 10
            r.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
            r.translatesAutoresizingMaskIntoConstraints = false
            // .bd { flex: 1 }: the words take the row, the time at its right.
            let cw = col.widthAnchor.constraint(equalTo: r.widthAnchor, constant: -(12 + 16 + 10 + 12) - (tm.map { ceil($0.intrinsicContentSize.width) + 10 } ?? 0))
            cw.priority = .init(750)
            cw.isActive = true
            rows.append(r)
        }
        return boxed(vstack(rows, spacing: 0), fill: "input", ring: "sep", radius: 8, insets: NSEdgeInsets(top: 4, left: 0, bottom: 4, right: 0))
    }

    /// Room above a view inside a column.
    private func boxedTop(_ v: NSView, _ top: CGFloat) -> NSView {
        let b = Flipped()
        b.translatesAutoresizingMaskIntoConstraints = false
        v.translatesAutoresizingMaskIntoConstraints = false
        b.addSubview(v)
        NSLayoutConstraint.activate([v.leadingAnchor.constraint(equalTo: b.leadingAnchor), v.trailingAnchor.constraint(lessThanOrEqualTo: b.trailingAnchor), v.topAnchor.constraint(equalTo: b.topAnchor, constant: top), v.bottomAnchor.constraint(equalTo: b.bottomAnchor)])
        if !(v is Box) { let w = v.widthAnchor.constraint(equalTo: b.widthAnchor); w.priority = .init(700); w.isActive = true }
        return b
    }
}

/// A row that wraps (flex-wrap): its views left to right at their own
/// sizes, onto the next line when the width is used; the `right` ones at the
/// right end while the whole fits on one line, else on a line of their own.
final class FlowRow: Flipped {
    let left: [NSView], right: [NSView]
    let gap: CGFloat, lineGap: CGFloat
    private var height: CGFloat = 0
    init(_ left: [NSView], right: [NSView], gap: CGFloat, lineGap: CGFloat = 8) {
        self.left = left; self.right = right; self.gap = gap; self.lineGap = lineGap
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        for v in left + right { v.translatesAutoresizingMaskIntoConstraints = true; addSubview(v) }
        height = place(100000, apply: false)
    }
    required init?(coder: NSCoder) { fatalError() }
    private func size(_ v: NSView) -> NSSize { let f = v.fittingSize; return NSSize(width: ceil(f.width), height: ceil(f.height)) }
    private func place(_ w: CGFloat, apply: Bool) -> CGFloat {
        let ls = left.map(size), rs = right.map(size)
        let lw = ls.reduce(0) { $0 + $1.width } + gap * CGFloat(max(0, ls.count - 1))
        let rw = rs.reduce(0) { $0 + $1.width } + gap * CGFloat(max(0, rs.count - 1))
        var lines: [[(NSView, NSSize)]] = []
        func flow(_ vs: [NSView], _ ss: [NSSize]) {
            var cur: [(NSView, NSSize)] = [], x: CGFloat = 0
            for (v, s0) in zip(vs, ss) {
                let s = NSSize(width: min(s0.width, w), height: s0.height)
                if !cur.isEmpty && x + s.width > w { lines.append(cur); cur = []; x = 0 }
                cur.append((v, s)); x += s.width + gap
            }
            if !cur.isEmpty { lines.append(cur) }
        }
        var y: CGFloat = 0
        if lw + (rs.isEmpty ? 0 : gap + rw) <= w {
            // One line: the left ones, the right ones at the end, centred on the line.
            let h = (ls + rs).map { $0.height }.max() ?? 0
            if apply {
                var x: CGFloat = 0
                for (v, s) in zip(left, ls) { v.frame = NSRect(x: x, y: (h - s.height) / 2, width: s.width, height: s.height); x += s.width + gap }
                x = w - rw
                for (v, s) in zip(right, rs) { v.frame = NSRect(x: x, y: (h - s.height) / 2, width: s.width, height: s.height); x += s.width + gap }
            }
            return h
        }
        flow(left, ls)
        flow(right, rs)
        for (i, line) in lines.enumerated() {
            let h = line.map { $0.1.height }.max() ?? 0
            var x: CGFloat = 0
            if apply { for (v, s) in line { v.frame = NSRect(x: x, y: y + (h - s.height) / 2, width: s.width, height: s.height); x += s.width + gap } }
            y += h + (i < lines.count - 1 ? lineGap : 0)
        }
        return y
    }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: height) }
    override func layout() {
        super.layout()
        let h = place(bounds.width, apply: true)
        if abs(h - height) > 0.5 { height = h; invalidateIntrinsicContentSize() }
    }
}
