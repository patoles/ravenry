// Decisions (DEC-002, DEC-003), as the Electron app draws them
// (decisions.ts; phase2.css .dec-tools, .dsel, .dsearch, .dec-day, .dcard,
// .dmeta): the person's directions in their words, newest first in days,
// with when, where and who saved each; a decision that replaced others
// carries them crossed out; a replaced one is crossed out itself; how often
// agents read each; Undo inside an agent's minute. The project menu, the
// search and Holds now, Replaced and All ask the hub, which sends what the
// page shows (GET /api/decisions?page=1, hub/server/decisions.mjs page()),
// read again every 3 s while it shows; the search asks once typing pauses
// (150 ms), and the list shown stays until the answer differs.
//
// The person's own (DEC-004): Add a decision opens a card at the top (the
// words, the project or every project, what it is about), saved with POST
// /api/decisions/add; each card has Edit (the same card in its place, POST
// /api/decisions/edit with what changed) and Remove, asked first on the
// card itself (POST /api/decisions/remove: the ones it replaced hold
// again).

import AppKit

final class DecisionsPage: FormPage {
    /// The hub's answer for what the page asks (nil until read).
    private(set) var view: [String: Any]?
    /// Holds now, Replaced or All: "now", "replaced", "all".
    private(set) var showing = "now"
    /// The project picked in the menu ("" for all).
    private(set) var only = ""
    /// The decision a toast's Show points at: lit and scrolled to.
    private(set) var lit: String?
    /// The last question asked of the hub (the self-test reads it).
    private(set) var asked = ""
    /// The cards by decision id, and their Undo links.
    private(set) var cards: [String: Box] = [:]
    private(set) var undos: [String: RButton] = [:]
    private(set) var tabs: PageTabs?
    private(set) var projectMenu = NSMenu()
    /// Read again after Undo or a change on the hub's stream.
    var changed: (() -> Void)?
    /// The card being written: "new" for Add, a decision's id for Edit, nil when none.
    private(set) var editing: String?
    /// The project the open card names ("" for every project).
    private(set) var editProject = ""
    /// The decision whose Remove waits for a yes.
    private(set) var removing: String?
    private(set) var editMenu = NSMenu()
    private var searchWait: DispatchWorkItem?

    func show(lit id: String? = nil) {
        lit = id
        if id != nil { showing = "now" }
        dirty()
        load()
        poll(3)
        redraw()
    }

    private static let plain = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
    private func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: Self.plain) ?? "" }

    override func load() {
        let q = "/api/decisions?page=1&show=\(showing)&only=\(enc(only))&search=\(enc(typed("search")))"
        asked = q
        hub?.get(q) { [weak self] code, j in
            guard let self, q == self.asked else { return }
            if code == 200 { self.view = j }
            self.redraw()
        }
    }

    /// The self-test's: an answer as the hub sends it, kept (no reading again).
    func apply(_ j: [String: Any]) { poll(nil); view = j; dirty(); redraw() }

    func pick(show s: String) { showing = s; dirty(); load(); redraw() }
    func pick(project id: String) { only = id; dirty(); load(); redraw() }

    override func redraw() {
        let add = RButton(t("dec.add"), .normal, small: true) { [weak self] in self?.startEdit("new") }
        add.isEnabled = editing != "new"
        buttons["add"] = add
        setHead(title: t("side.decisions"), src: t("dec.src"), extra: [add], closable: false)
        let now = When.now()
        let items = days.flatMap { $0["items"] as? [[String: Any]] ?? [] }
        let live = items.filter { undoable($0, now) }.map { "\($0["id"] ?? "")" }.joined(separator: ",")
        let data = view.flatMap { try? JSONSerialization.data(withJSONObject: $0, options: .sortedKeys) }.map { "\($0.hashValue)" } ?? "-"
        draw("\(busy)|\(showing)|\(only)|\(lit ?? "")|\(live)|\(data)|\(editing ?? "")|\(editProject)|\(removing ?? "")") { [tools(), editing == "new" ? editor(nil) : nil, list(now)].compactMap { $0 } }
        if let id = lit, let c = cards[id] {
            DispatchQueue.main.async { c.scrollToVisible(c.bounds) }
        }
    }

    private var days: [[String: Any]] { view?["days"] as? [[String: Any]] ?? [] }

    private func undoable(_ d: [String: Any], _ now: Date) -> Bool {
        guard let u = When.date(d["undo_until"] as? String) else { return false }
        return u > now
    }

    // MARK: .dec-tools

    private func tools() -> NSView {
        let projects = view?["projects"] as? [[String: Any]] ?? []
        let name = projects.first { $0["id"] as? String == only }?["name"] as? String
        projectMenu = NSMenu()
        for (id, title) in [("", t("dec.allProjects"))] + projects.map({ ($0["id"] as? String ?? "", $0["name"] as? String ?? "") }) {
            let it = NSMenuItem(title: title, action: #selector(menuPick(_:)), keyEquivalent: "")
            it.target = self
            it.representedObject = id
            it.state = id == only ? .on : .off
            projectMenu.addItem(it)
        }
        let sel = MenuBox(only.isEmpty ? t("dec.allProjects") : name ?? only, menu: projectMenu)
        sel.setAccessibilityLabel(t("dec.project"))
        let first = fields["search"] == nil
        let search = field("search", t("dec.search"), icon: "search")
        if first {
            // .dsearch: 330 wide, narrower when the row is short of room.
            search.ringOnFocus = false
            search.onChange = { [weak self] in self?.searchTyped() }
            let w = search.widthAnchor.constraint(equalToConstant: 330)
            w.priority = .init(200)
            w.isActive = true
            search.widthAnchor.constraint(lessThanOrEqualToConstant: 330).isActive = true
            search.widthAnchor.constraint(greaterThanOrEqualToConstant: 140).isActive = true
        }
        let keys = ["now", "replaced", "all"]
        let tb = PageTabs([(t("dec.holdsNow"), nil), (t("dec.replaced"), nil), (t("dec.all"), nil)], on: keys.firstIndex(of: showing) ?? 0) { [weak self] i in self?.pick(show: keys[i]) }
        tb.setContentCompressionResistancePriority(.required, for: .horizontal)
        tabs = tb
        let total = view?["total"] as? Int ?? 0, replaced = view?["replaced"] as? Int ?? 0
        let n = total == 1 ? t("dec.countOne") : t("dec.count", ["n": "\(total)"])
        // .t3.small: on one line while there is room; when the row is short
        // the search gives way first (to 140), then the count wraps.
        let count = wrap(replaced > 0 ? t("dec.countReplaced", ["count": n, "n": "\(replaced)"]) : n, Fonts.pt(12).withTabularDigits, "tx3")
        count.setContentCompressionResistancePriority(.init(300), for: .horizontal)
        count.setContentHuggingPriority(.required, for: .horizontal)
        return hstack([sel, search, tb, spring(), count], spacing: 8)
    }

    /// Typing in the search: the hub asked once it pauses, not at every key.
    private func searchTyped() {
        searchWait?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.load() }
        searchWait = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: w)
    }

    // MARK: the person's own: add, edit, remove

    func startEdit(_ id: String) {
        editing = id
        removing = nil
        for k in ["quote", "scope"] { clear("ed:\(k)") }
        if id != "new", let d = item(id) {
            field("ed:quote", t("dec.quoteHint"), area: true, height: 66).text = d["quote"] as? String ?? ""
            field("ed:scope", t("dec.scopeHint")).text = d["scope"] as? String ?? ""
            editProject = d["project"] as? String ?? ""
        } else {
            editProject = only
        }
        dirty(); redraw()
        DispatchQueue.main.async { [weak self] in if let f = self?.fields["ed:quote"] { self?.window?.makeFirstResponder(f.field) } }
    }

    func cancelEdit() { editing = nil; dirty(); redraw() }

    func saveEdit() {
        guard let id = editing else { return }
        if need("ed:quote", t("dec.quoteNeeded")) { return }
        let quote = typed("ed:quote"), scope = typed("ed:scope")
        if id == "new" {
            var body: [String: Any] = ["quote": quote]
            if !editProject.isEmpty { body["project"] = editProject }
            if !scope.isEmpty { body["scope"] = scope }
            act("save", "/api/decisions/add", body) { [weak self] _ in
                self?.editing = nil
                self?.toast?(t("dec.added"))
                self?.changed?()
            }
            return
        }
        guard let d = item(id) else { cancelEdit(); return }
        var body: [String: Any] = ["id": id]
        if quote != d["quote"] as? String ?? "" { body["quote"] = quote }
        if scope != d["scope"] as? String ?? "" { body["scope"] = scope }
        if editProject != d["project"] as? String ?? "" { body["project"] = editProject.isEmpty ? NSNull() : editProject }
        guard body.count > 1 else { cancelEdit(); return }
        act("save", "/api/decisions/edit", body) { [weak self] _ in
            self?.editing = nil
            self?.toast?(t("dec.edited"))
            self?.changed?()
        }
    }

    func askRemove(_ id: String) { removing = id; editing = nil; dirty(); redraw() }

    func remove(_ id: String) {
        let back = !(item(id)?["replaces"] as? [[String: Any]] ?? []).isEmpty
        act("remove:\(id)", "/api/decisions/remove", ["id": id]) { [weak self] _ in
            self?.removing = nil
            self?.toast?(back ? t("dec.removedBack") : t("dec.removed"))
            self?.changed?()
        }
    }

    private func item(_ id: String) -> [String: Any]? {
        days.flatMap { $0["items"] as? [[String: Any]] ?? [] }.first { $0["id"] as? String == id }
    }

    /// Every project of the board (the menu's), named.
    private var boardProjects: [(String, String)] {
        (hub?.state?.projects ?? []).map { ($0.id, $0.name) }
    }

    /// The card that writes one: the words, the project, what it is about, Save and Cancel.
    private func editor(_ id: String?) -> NSView {
        let quote = field("ed:quote", t("dec.quoteHint"), area: true, height: 66)
        quote.onReturn = { [weak self] in self?.saveEdit() }
        let scope = field("ed:scope", t("dec.scopeHint"))
        scope.onReturn = { [weak self] in self?.saveEdit() }
        editMenu = NSMenu()
        let names = boardProjects
        for (pid, title) in [("", t("dec.everyProject"))] + names {
            let it = NSMenuItem(title: title, action: #selector(editPick(_:)), keyEquivalent: "")
            it.target = self
            it.representedObject = pid
            it.state = pid == editProject ? .on : .off
            editMenu.addItem(it)
        }
        let pname = editProject.isEmpty ? t("dec.everyProject") : names.first { $0.0 == editProject }?.1 ?? editProject
        let pm = MenuBox(pname, menu: editMenu)
        pm.setAccessibilityLabel(t("dec.project"))
        let save = RButton(id == nil ? t("dec.save") : t("dec.saveEdit"), .primary, small: true) { [weak self] in self?.saveEdit() }
        save.isEnabled = busy.isEmpty
        let cancel = RButton(t("dec.cancel"), .ghost, small: true) { [weak self] in self?.cancelEdit() }
        buttons["save"] = save; buttons["cancel"] = cancel
        let title = label(id == nil ? t("dec.addTitle") : t("dec.editTitle"), Fonts.pt(12.5, Fonts.w650), "tx2")
        let col = vstack([title, quote, hstack([label(t("dec.for"), Fonts.pt(12.5), "tx2"), pm, scope], spacing: 8), hstack([wrap(t("dec.addHint"), Fonts.pt(11.5), "tx3"), spring(), cancel, save], spacing: 8)], spacing: 10)
        let b = boxed(col, fill: "card", ring: "work", radius: 10, insets: NSEdgeInsets(top: 12, left: 16, bottom: 12, right: 16))
        b.ringWidth = 1.5
        if let id { cards[id] = b }
        return b
    }

    @objc private func editPick(_ it: NSMenuItem) { editProject = it.representedObject as? String ?? ""; dirty(); redraw() }

    @objc private func menuPick(_ it: NSMenuItem) { pick(project: it.representedObject as? String ?? "") }

    // MARK: .dec-list

    private func list(_ now: Date) -> NSView {
        cards = [:]
        undos = [:]
        guard let v = view else { return NSView() }
        if v["empty"] as? String != nil || days.isEmpty {
            // .empty-pg: 13 on the body's line height (1.4).
            let s = v["empty"] as? String == "nomatch" ? t("dec.nothingMatches") : t("dec.empty")
            let e = wrap(s, Fonts.pt(13), "tx3")
            let para = NSMutableParagraphStyle(); para.minimumLineHeight = 18.2; para.maximumLineHeight = 18.2
            e.text.attributedStringValue = NSAttributedString(string: s, attributes: [.font: Fonts.pt(13), .foregroundColor: Design.color("tx3"), .paragraphStyle: para])
            return e
        }
        var rows: [NSView] = []
        for g in days {
            // .dec-day: padding 6 above, 2 at the left.
            rows.append(hstack([label(dayLabel(g), Fonts.pt(12.5, Fonts.w650), "tx2"), spring()], spacing: 0, insets: NSEdgeInsets(top: 6, left: 2, bottom: 0, right: 0)))
            for d in g["items"] as? [[String: Any]] ?? [] { rows.append(card(d, now)) }
        }
        return vstack(rows, spacing: 10)
    }

    /// .dcard: the quote, what it replaced, then when, the project, where and the reads.
    private func card(_ d: [String: Any], _ now: Date) -> NSView {
        let id = d["id"] as? String ?? ""
        if editing == id { return editor(id) }
        let gone = d["gone"] as? Bool ?? false
        let canUndo = undoable(d, now)
        let isNew = !gone && (canUndo || lit == id)
        let quote = "\u{201C}\(d["quote"] as? String ?? "")\u{201D}"
        let q = wrap(quote, Fonts.pt(14), gone ? "tx3" : "tx")
        // .dcard .q: 14 on a line of 1.4.
        let para = NSMutableParagraphStyle(); para.minimumLineHeight = 19.6; para.maximumLineHeight = 19.6
        var qa: [NSAttributedString.Key: Any] = [.font: Fonts.pt(14), .foregroundColor: Design.color(gone ? "tx3" : "tx"), .paragraphStyle: para]
        if gone { qa[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        q.text.attributedStringValue = NSAttributedString(string: quote, attributes: qa)
        var col: [NSView] = [q]
        if !gone {
            for o in d["replaces"] as? [[String: Any]] ?? [] {
                let a = NSMutableAttributedString(string: t("dec.replaces", ["when": longWhen(o["at"] as? String)]), attributes: [.font: Fonts.pt(12), .foregroundColor: Design.color("tx2")])
                a.append(NSAttributedString(string: "\u{201C}\(o["quote"] as? String ?? "")\u{201D}", attributes: [.font: Fonts.pt(12), .foregroundColor: Design.color("tx3"), .strikethroughStyle: NSUnderlineStyle.single.rawValue]))
                let tx = wrap("", Fonts.pt(12), "tx2")
                tx.text.attributedStringValue = a
                let ic = Icon("undo", "tx3", size: 14)
                ic.setContentHuggingPriority(.required, for: .horizontal)
                col.append(boxed(hstack([ic, tx], spacing: 8), fill: "card2", radius: 6, insets: NSEdgeInsets(top: 7, left: 10, bottom: 7, right: 10)))
            }
        }
        // .dmeta
        var meta: [NSView] = []
        if canUndo { meta.append(badge(t("dec.justNow"), fg: "work", bg: "work-t")) }
        else if gone { meta.append(badge(t("dec.replaced"), fg: "tx2", bg: "card2")) }
        meta.append(label(timeOnly(d["at"] as? String), Fonts.pt(12).withTabularDigits, "tx3"))
        meta.append(label(d["project_name"] as? String ?? t("dec.everyProject"), Fonts.pt(12, Fonts.w650), "tx2"))
        if let w = d["where"] as? String { meta.append(label(t("dec.saidIn", ["where": w]), Fonts.pt(12), "tx3")) }
        else if d["by"] as? String == "person" { meta.append(label(t("dec.youAdded"), Fonts.pt(12), "tx3")) }
        meta.append(spring())
        if gone {
            let r = d["replaced_at"] as? String
            meta.append(label(r != nil ? t("dec.replacedAt", ["day": dayWord(r), "time": timeOnly(r)]) : t("dec.replaced"), Fonts.pt(12), "tx3"))
        } else if canUndo {
            let b = RButton(t("dec.undo"), .link, small: true) { [weak self] in self?.undo(id) }
            undos[id] = b
            buttons["undo:\(id)"] = b
            meta.append(b)
        } else if let r = reads(d) {
            meta.append(hstack([Icon("book", "tx3", size: 14), label(r, Fonts.pt(12), "tx3")], spacing: 6))
        }
        // The person's own: Edit (an active one) and Remove, asked first (inside the minute, Undo is the remove).
        if removing != id {
            if !gone {
                let e = RButton(t("dec.edit"), .quiet, small: true) { [weak self] in self?.startEdit(id) }
                buttons["edit:\(id)"] = e
                meta.append(e)
            }
            if !canUndo {
                let r = RButton(t("dec.remove"), .quiet, small: true) { [weak self] in self?.askRemove(id) }
                buttons["remove:\(id)"] = r
                meta.append(r)
            }
        }
        for m in meta.dropLast() where !(m is RButton) { m.setContentCompressionResistancePriority(.init(700), for: .horizontal) }
        col.append(hstack(meta, spacing: 8))
        if removing == id {
            let yes = RButton(t("dec.remove"), .no, small: true) { [weak self] in self?.remove(id) }
            yes.isEnabled = busy.isEmpty
            let no = RButton(t("dec.keep"), .ghost, small: true) { [weak self] in self?.removing = nil; self?.dirty(); self?.redraw() }
            buttons["confirm:\(id)"] = yes; buttons["keep:\(id)"] = no
            let replaces = !(d["replaces"] as? [[String: Any]] ?? []).isEmpty
            col.append(hstack([wrap(replaces ? t("dec.removeAskBack") : t("dec.removeAsk"), Fonts.pt(12.5), "tx"), spring(), no, yes], spacing: 8))
        }
        let b = boxed(vstack(col, spacing: 8), fill: gone ? nil : isNew ? "work-t" : "card", ring: gone ? "sep" : isNew ? "work" : nil, radius: 10, insets: NSEdgeInsets(top: 12, left: 16, bottom: 12, right: 16))
        if isNew { b.ringWidth = 1.5 }
        // --shadow: a card that holds lifts a little off the page.
        if !gone && !isNew { b.layer?.shadowColor = NSColor.black.cgColor; b.layer?.shadowOpacity = 0.06; b.layer?.shadowRadius = 2; b.layer?.shadowOffset = CGSize(width: 0, height: -1) }
        b.setAccessibilityLabel(quote)
        cards[id] = b
        return b
    }

    /// .dmeta .badge: a word on a tint.
    private func badge(_ s: String, fg: String, bg: String) -> NSView {
        let b = boxed(label(s, Fonts.pt(11, Fonts.w650), fg), fill: bg, radius: 5, insets: NSEdgeInsets(top: 3, left: 7, bottom: 3, right: 7))
        b.setContentHuggingPriority(.required, for: .horizontal)
        return b
    }

    private func undo(_ id: String) {
        act("undo:\(id)", "/api/decisions/undo", ["id": id]) { [weak self] _ in
            self?.toast?(t("dec.undone"))
            self?.changed?()
        }
    }

    // MARK: words for times (drawing only: the days and their order come from the hub)

    private static func fmt(_ f: String, _ locale: String) -> DateFormatter {
        let d = DateFormatter(); d.locale = Locale(identifier: locale); d.dateFormat = f; return d
    }
    private static let hm = fmt("HH:mm", "en_US_POSIX")
    private static let wd = fmt("EEE", "en_GB")
    private static let wdUS = fmt("EEE", "en_US")
    private static let md = fmt("MMM d", "en_US")
    private static let dayKey = fmt("yyyy-MM-dd", "en_US_POSIX")

    /// "14:05".
    func timeOnly(_ iso: String?) -> String { When.date(iso).map { Self.hm.string(from: $0) } ?? "" }
    /// "Sat Nov 7, 10:00".
    func longWhen(_ iso: String?) -> String {
        guard let d = When.date(iso) else { return "" }
        return "\(Self.wd.string(from: d)) \(Self.md.string(from: d)), \(Self.hm.string(from: d))"
    }
    /// "today", "yesterday", "on Nov 7".
    func dayWord(_ iso: String?) -> String {
        guard let d = When.date(iso) else { return "" }
        let cal = Calendar.current, now = When.now()
        if cal.isDate(d, inSameDayAs: now) { return t("dec.dayToday") }
        if let y = cal.date(byAdding: .day, value: -1, to: now), cal.isDate(d, inSameDayAs: y) { return t("dec.dayYesterday") }
        return t("dec.dayOn", ["date": Self.md.string(from: d)])
    }
    /// "Today, Mon Nov 9", "Yesterday, Sun Nov 8", "Sat, Nov 7" (the hub's day and how near it is).
    func dayLabel(_ g: [String: Any]) -> String {
        guard let d = Self.dayKey.date(from: g["day"] as? String ?? "") else { return g["day"] as? String ?? "" }
        let w = Self.wdUS.string(from: d), m = Self.md.string(from: d)
        switch g["rel"] as? String {
        case "today": return t("dec.today", ["date": "\(w) \(m)"])
        case "yesterday": return t("dec.yesterday", ["date": "\(w) \(m)"])
        default: return "\(w), \(m)"
        }
    }
    /// "Read 7 times today", "Read twice".
    func reads(_ d: [String: Any]) -> String? {
        let times = { (n: Int) in n == 1 ? t("dec.once") : n == 2 ? t("dec.twice") : t("dec.times", ["n": "\(n)"]) }
        if let n = d["reads_today"] as? Int, n > 0 { return t("dec.readToday", ["times": times(n)]) }
        if let n = d["reads_total"] as? Int, n > 0 { return t("dec.readTotal", ["times": times(n)]) }
        return nil
    }
}

/// .dsel: what is picked and a chevron on the field's colour; a press opens the menu under it.
final class MenuBox: Box {
    let items: NSMenu
    init(_ title: String, menu: NSMenu) {
        self.items = menu
        super.init(fill: "input", ring: "sep", radius: 7)
        translatesAutoresizingMaskIntoConstraints = false
        let l = label(title, Fonts.pt(12.5))
        l.setContentCompressionResistancePriority(.required, for: .horizontal)
        let row = hstack([l, Icon("down", "tx2", size: 12)], spacing: 8, insets: NSEdgeInsets(top: 0, left: 10, bottom: 0, right: 10))
        addSubview(row)
        NSLayoutConstraint.activate([row.leadingAnchor.constraint(equalTo: leadingAnchor), row.trailingAnchor.constraint(equalTo: trailingAnchor),
                                     row.topAnchor.constraint(equalTo: topAnchor), row.bottomAnchor.constraint(equalTo: bottomAnchor)])
        heightAnchor.constraint(equalToConstant: 32).isActive = true
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        setAccessibilityElement(true)
        setAccessibilityRole(.popUpButton)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func mouseDown(with e: NSEvent) { items.popUp(positioning: nil, at: NSPoint(x: 0, y: bounds.height + 4), in: self) }
    override func resetCursorRects() { handCursor() }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { items.popUp(positioning: nil, at: NSPoint(x: 0, y: bounds.height + 4), in: self); return true }
}
