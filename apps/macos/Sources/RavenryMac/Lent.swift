// Who drives a pane, as the Electron app shows it (panepanel.ts, phase2.css
// .lstrip, .who-g): the strip across the top of a pane an agent holds the
// lease of (who has it since when, who waits, Hand it to and Take it back),
// and "Who can type here" in a shell's panel (you always; the agent whose
// pane it is; an agent the person let type for its session, which they can
// take back; any other agent asks each time). The data is the daemon's
// (pane.list, pane.lease, pane.grants); the names are the board's.

import AppKit

/// Who a Source is, as people know it ("Claude", "in Tilting the hull").
struct Who {
    var who: String
    var place: String?
    /// claude, codex, other, you.
    var cls: String
}

/// One line of "Who can type here".
struct WhoRow {
    var who: Who
    /// always, own, asks or can.
    var value: String
    /// The grant that lets it type, which the person can take back.
    var grant: String?
}

/// The strip across the top of a lent pane (.lstrip): over the terminal, in its own colours in both themes.
final class LeaseStrip: Box {
    private(set) var buttons: [String: RButton] = [:]
    private(set) var text = ""
    init(holder: Who, since: String, waiting: [Who], handTo: (() -> Void)?, takeBack: @escaping () -> Void) {
        super.init(fill: nil)
        rawFill = NSColor(srgbRed: 191 / 255, green: 90 / 255, blue: 242 / 255, alpha: 0.09)
        let waits = waiting.isEmpty ? "" : " \(waiting.map(\.who).joined(separator: " and ")) \(waiting.count > 1 ? "are" : "is") waiting for it."
        text = t("lease.has", ["who": holder.who, "where": holder.place.map { t("lease.in", ["where": $0]) } ?? "", "since": since]) + waits + " " + t("lease.stillYours")
        let a = NSMutableAttributedString(string: text, attributes: [.font: Fonts.pt(12.5), .foregroundColor: NSColor(srgbRed: 0xD1 / 255, green: 0xD1 / 255, blue: 0xD6 / 255, alpha: 1)])
        a.addAttributes([.font: Fonts.pt(12.5, Fonts.w650), .foregroundColor: NSColor(srgbRed: 0xF2 / 255, green: 0xF2 / 255, blue: 0xF4 / 255, alpha: 1)], range: NSRange(location: 0, length: (holder.who as NSString).length))
        let l = label("", Fonts.pt(12.5), "tx", lines: 0, select: true)
        l.attributedStringValue = a
        l.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        l.setContentHuggingPriority(.init(1), for: .horizontal)
        let icon = Icon("holds", "", size: 15)
        let img = SharedIcons.image("holds", color: "tx", size: 15, dark: true)
        img?.isTemplate = true
        icon.image = img
        icon.contentTintColor = NSColor(srgbRed: 0xDA / 255, green: 0x8F / 255, blue: 1, alpha: 1)
        var items: [NSView?] = [icon, l]
        let dark = { (b: RButton) in
            b.titleColor = nil
            b.wantsLayer = true
            b.layer?.backgroundColor = NSColor(srgbRed: 0x3A / 255, green: 0x3A / 255, blue: 0x40 / 255, alpha: 1).cgColor
            b.layer?.cornerRadius = 6
            b.attributedTitle = NSAttributedString(string: b.title, attributes: [.font: Fonts.pt(12, .medium), .foregroundColor: NSColor(srgbRed: 0xF2 / 255, green: 0xF2 / 255, blue: 0xF4 / 255, alpha: 1)])
        }
        if let h = handTo, let next = waiting.first {
            let b = RButton(t("lease.handTo", ["who": next.who]), .quiet, small: true, run: h)
            dark(b)
            buttons["handTo"] = b
            items.append(b)
        }
        let back = RButton(t("lease.takeBack"), .quiet, small: true, run: takeBack)
        dark(back)
        buttons["takeBack"] = back
        items.append(back)
        let s = hstack(items, spacing: 12, insets: NSEdgeInsets(top: 10, left: 14, bottom: 10, right: 14))
        s.alignment = .centerY
        s.translatesAutoresizingMaskIntoConstraints = false
        addSubview(s)
        let line = Box(fill: nil)
        line.rawFill = NSColor(srgbRed: 191 / 255, green: 90 / 255, blue: 242 / 255, alpha: 0.45)
        line.translatesAutoresizingMaskIntoConstraints = false
        addSubview(line)
        NSLayoutConstraint.activate([s.leadingAnchor.constraint(equalTo: leadingAnchor), s.trailingAnchor.constraint(equalTo: trailingAnchor),
                                     s.topAnchor.constraint(equalTo: topAnchor), s.bottomAnchor.constraint(equalTo: line.topAnchor),
                                     line.leadingAnchor.constraint(equalTo: leadingAnchor), line.trailingAnchor.constraint(equalTo: trailingAnchor),
                                     line.bottomAnchor.constraint(equalTo: bottomAnchor), line.heightAnchor.constraint(equalToConstant: 1)])
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(text)
    }
    required init?(coder: NSCoder) { fatalError() }
    /// Its height at a width (the words wrap on a narrow window).
    func height(for w: CGFloat) -> CGFloat {
        frame.size.width = w
        layoutSubtreeIfNeeded()
        return ceil(fittingSize.height)
    }
}

extension Board {
    /// Who a Source is (the Electron app's sourceOf): an agent by the session in its pane, else its pane's label; the hub as Ravenry.
    func sourceOf(_ src: [String: Any]?) -> Who {
        guard let s = src, s["kind"] as? String != "person" else { return Who(who: "You", place: nil, cls: "you") }
        if s["kind"] as? String == "agent", let pane = s["pane"] as? String {
            var kind: String? = nil
            var place: String? = nil
            if let st = hub.state {
                for p in st.projects { for x in p.sessions where x.pane == pane && x.machine == nil && p.machine == nil { kind = x.assistant; place = x.topic ?? p.name } }
            }
            let i = ws.paneInfo(pane)
            kind = kind ?? i?.agent ?? i?.labels["ravenry.agent"]
            let who = kind == "claude" ? "Claude" : kind == "codex" ? "Codex" : kind.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? "An agent"
            if place == nil, i != nil { place = ws.label(pane).name }
            return Who(who: who, place: place == who ? nil : place, cls: kind == "claude" || kind == "codex" ? kind! : "other")
        }
        if s["client"] as? String == "ravenry-hub" { return Who(who: "Ravenry", place: nil, cls: "other") }
        return Who(who: s["client"] as? String ?? "A program", place: nil, cls: "other")
    }

    /// The lease an agent holds on a pane, still running; nil when none or the person's.
    func leaseOf(_ pane: String) -> [String: Any]? {
        guard let l = ws.paneInfo(pane)?.lease, let h = l["holder"] as? [String: Any], h["kind"] as? String != "person",
              let exp = When.date(l["expires_at"] as? String), exp > When.now() else { return nil }
        return l
    }

    /// The strip over the pane in front when an agent holds it (19 A).
    func leaseStrip() -> LeaseStrip? {
        guard case .tab = front, let tab = ws.active else { return nil }
        let pane = tab.focusedPane
        guard let l = leaseOf(pane) else { return nil }
        let waiting = (l["waiting"] as? [[String: Any]] ?? []).map { sourceOf($0) }
        let name = ws.label(pane).name
        let release = { [weak self] (takeBack: Bool) in
            guard let self else { return }
            var p: [String: Any] = ["pane": pane, "release": true]
            if takeBack { p["refuse_waiting"] = true }
            self.leaseActs.append(takeBack ? "take back \(pane)" : "hand \(pane)")
            self.ws.conn.request("pane.lease", p) { [weak self] r in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if case .failure(let e) = r { self.toast(t("lease.failed", ["why": "\(e)"])); return }
                    self.toast(takeBack ? t("lease.yoursAgain", ["pane": name]) : t("lease.handed", ["who": waiting.first?.who ?? "The next one", "pane": name]))
                }
            }
        }
        return LeaseStrip(holder: sourceOf(l["holder"] as? [String: Any]), since: When.clock(l["acquired_at"] as? String), waiting: waiting,
                          handTo: waiting.isEmpty ? nil : { release(false) }, takeBack: { release(true) })
    }

    /// The grants on a pane (pane.grants), read when its panel shows, at most every 3 s.
    func grantsOf(_ pane: String) -> [[String: Any]] {
        if Date().timeIntervalSince(grantsAsked[pane] ?? .distantPast) > 3 {
            grantsAsked[pane] = Date()
            ws.conn.request("pane.grants", ["pane": pane]) { [weak self] r in
                guard case .success(let j) = r else { return }
                let list = j["grants"] as? [[String: Any]] ?? []
                DispatchQueue.main.async {
                    guard let self else { return }
                    let changed = (self.grants[pane] ?? []).compactMap { $0["id"] as? String } != list.compactMap { $0["id"] as? String }
                    self.grants[pane] = list
                    if changed { self.render() }
                }
            }
        }
        return grants[pane] ?? []
    }

    /// "Who can type here" (6 C): you always; the pane's own agent; agents let for their session; the others ask each time.
    func whoCanType(_ pane: String) -> [WhoRow] {
        let creator = ws.paneInfo(pane)?.creator
        let gs = grantsOf(pane)
        var rows = [WhoRow(who: Who(who: "You", place: nil, cls: "you"), value: "always", grant: nil)]
        var seen = Set<String>()
        let same = { (a: [String: Any]?, b: [String: Any]) -> Bool in
            guard let a else { return false }
            return a["kind"] as? String == b["kind"] as? String && (a["pane"] as? String) == (b["pane"] as? String) && (a["client"] as? String) == (b["client"] as? String)
        }
        let add = { (src: [String: Any]) in
            let key = src["kind"] as? String == "agent" ? "a:\(src["pane"] as? String ?? "")" : "c:\(src["client"] as? String ?? "")"
            if seen.contains(key) || src["kind"] as? String == "person" { return }
            seen.insert(key)
            if same(creator, src) { rows.append(WhoRow(who: self.sourceOf(src), value: "own", grant: nil)); return }
            let g = gs.first { same($0["agent"] as? [String: Any], src) && (($0["action"] as? String).map { $0 == "input" } ?? true) }
            rows.append(WhoRow(who: self.sourceOf(src), value: g == nil ? "asks" : "can", grant: g?["id"] as? String))
        }
        if let c = creator, c["kind"] as? String != "person" { add(c) }
        for g in gs { if let a = g["agent"] as? [String: Any] { add(a) } }
        // The agents of the sessions this window's daemon runs.
        for p in hub.state?.projects ?? [] where p.machine == nil {
            for s in p.sessions where s.machine == nil {
                if let sp = s.pane, sp != pane, ws.paneInfo(sp) != nil { add(["kind": "agent", "pane": sp]) }
            }
        }
        return rows
    }

    /// Takes back what the person let an agent do (pane.revoke): it asks each time again.
    func revokeGrant(_ pane: String, _ grant: String) {
        leaseActs.append("revoke \(grant)")
        ws.conn.request("pane.revoke", ["grant": grant]) { [weak self] r in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .failure(let e) = r { self.toast(t("lease.revokeFailed", ["why": "\(e)"])); return }
                self.grantsAsked[pane] = nil
                self.toast(t("lease.asksAgain"))
                _ = self.grantsOf(pane)
            }
        }
    }

    /// "Opened by you, 16:58, in paper-boat".
    func openedLine(_ pane: String) -> String? {
        guard let i = ws.paneInfo(pane) else { return nil }
        let c = i.creator
        let by = c == nil || c?["kind"] as? String == "person" ? "you" : sourceOf(c).who
        let at = i.createdAt.isEmpty ? "" : ", \(When.clock(i.createdAt))"
        let proj = hub.state?.projects.first { p in p.folder.map { !i.cwd.isEmpty && (i.cwd == $0 || i.cwd.hasPrefix($0 + "/")) } ?? false }
        return t("lease.opened", ["by": by]) + at + (proj.map { ", in \($0.name)" } ?? "")
    }
}
