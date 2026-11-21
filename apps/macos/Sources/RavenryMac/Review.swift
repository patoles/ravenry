// A worktree session's review and its project's files, as the Electron app
// shows them (review.ts, files.ts; phase2.css .rv-*, .dl, .cth, .fc-r,
// .clash-n, .fgrid): in the session's panel the card when it is done and
// asks for a review (Review, Merge without reviewing), Its copy, after a
// merge what landed with Undo the merge and Delete the branch, and Files it
// changed with a file another session changed too in orange; the review in
// the middle beside the panel (its files, the diff, a comment on a line
// that waits until Send N comments, Merge into main); and the grid of who
// changed what as a page. The hub does the git and works out the lines,
// the merge's mode and the clashes (hub/server/reviewview.mjs).

import AppKit

private func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? s }
private let termText = NSColor(srgbRed: 0xD1 / 255, green: 0xD1 / 255, blue: 0xD6 / 255, alpha: 1)
private let termDim = NSColor(srgbRed: 0x63 / 255, green: 0x63 / 255, blue: 0x66 / 255, alpha: 1)

/// "+12 −3" in the diff's colours.
func counts(_ a: Int, _ r: Int, size: CGFloat = 11.5) -> NSTextField {
    let s = NSMutableAttributedString(string: "+\(a)", attributes: [.font: Fonts.mono(size), .foregroundColor: Design.color("ok")])
    s.append(NSAttributedString(string: " −\(r)", attributes: [.font: Fonts.mono(size), .foregroundColor: Design.color("bad")]))
    let l = label("", Fonts.mono(size))
    l.attributedStringValue = s
    l.setContentCompressionResistancePriority(.required, for: .horizontal)
    return l
}

/// What the panel shows of a session's worktree and files, with what it read from the hub.
final class WorktreeCards {
    let hub: HubClient
    var rerender: () -> Void = {}
    var toast: (String) -> Void = { _ in }
    var openReview: (String) -> Void = { _ in }
    var openGrid: (String) -> Void = { _ in }
    /// Each session's last diff, by surface, and each project's files.
    private var diffs: [String: (at: Date, d: [String: Any]?, loading: Bool)] = [:]
    private var files: [String: (at: Date, d: [String: Any]?, loading: Bool)] = [:]
    /// What the self-test presses.
    private(set) var buttons: [String: RButton] = [:]
    private(set) var busy = false
    /// The sessions whose Discard asks to be sure (by surface).
    private var discardAsk = Set<String>()
    init(hub: HubClient) { self.hub = hub }

    func diffOf(_ s: HubSession) -> [String: Any]? {
        let c = diffs[s.surfaceId]
        let open = (s.worktree?["state"] as? String) == "open"
        if open, c == nil || (!(c!.loading) && Date().timeIntervalSince(c!.at) > 20) {
            diffs[s.surfaceId] = (c?.at ?? .distantPast, c?.d, true)
            hub.get("/api/sessions/\(enc(s.surfaceId))/diff") { [weak self] code, j in
                guard let self else { return }
                self.diffs[s.surfaceId] = (Date(), code == 200 ? j : c?.d, false)
                self.rerender()
            }
        }
        return c?.d
    }
    /// A diff read again at once (after a merge, from the review).
    func forget(_ surface: String) { diffs[surface] = nil }

    /// The self-test's own answer of a project's files (SelfTestReview.swift), in place of the hub's.
    var testFiles: [String: [String: Any]]?

    func filesOf(_ pid: String) -> [String: Any]? {
        if let f = testFiles?[pid] { return f }
        let c = files[pid]
        if c == nil || (!(c!.loading) && Date().timeIntervalSince(c!.at) > 4) {
            files[pid] = (c?.at ?? .distantPast, c?.d, true)
            hub.get("/api/projects/\(enc(pid))/files") { [weak self] code, j in
                guard let self else { return }
                let had = self.files[pid]?.d.flatMap { try? JSONSerialization.data(withJSONObject: $0, options: .sortedKeys) }
                let d = code == 200 ? j : nil
                self.files[pid] = (Date(), d, false)
                if d.flatMap({ try? JSONSerialization.data(withJSONObject: $0, options: .sortedKeys) }) != had { self.rerender() }
            }
        }
        return c?.d
    }

    /// "Codex is done and asks for a review", Its copy, or after a merge what landed; then Files it changed.
    func views(_ p: HubProject, _ s: HubSession, card: ([NSView?]) -> NSView, sec: (String?, NSView?, [NSView?]) -> NSView) -> [NSView] {
        buttons = [:]
        var out: [NSView] = []
        let key = "\(p.id)/\(s.surfaceId)"
        if let wt = s.worktree {
            let who = Assistants.of(s.assistant)?.short ?? "The agent"
            let topic = s.topic ?? p.name
            let base = wt["baseBranch"] as? String ?? "main"
            let branch = (wt["branch"] as? String ?? "").replacingOccurrences(of: "^ravenry/", with: "", options: .regularExpression)
            let state = wt["state"] as? String ?? ""
            if state == "merged", let m = wt["merged"] as? [String: Any] {
                let d = diffs[s.surfaceId]?.d
                let n = (d?["files"] as? [Any])?.count
                let c = ((d?["check"] as? [String: Any])?["ahead"] as? NSNumber)?.intValue
                let what = n.map { "\($0) file\($0 == 1 ? "" : "s") and \(c.map { "\($0) commit\($0 == 1 ? "" : "s")" } ?? "its commits")" } ?? "Its commits"
                let deleted = wt["branch_deleted_at"] != nil
                let undo = RButton(t("review.undoMerge"), small: true) { [weak self] in self?.post(s, "unmerge", t("review.unmerged")) }
                undo.lead = "undo"
                buttons["unmerge"] = undo
                let del = RButton(t("review.deleteBranch"), .ghost, small: true) { [weak self] in self?.post(s, "delete-branch", t("review.branchDeleted")) }
                buttons["deleteBranch"] = del
                let text = cardText("\(what) are on \(base) now. Its copy is removed; the branch \(branch) \(deleted ? "is deleted too." : "stays until you delete it.")")
                out.append(card([hstack([Icon("check-c", "ok", size: 14), label(t("review.mergedInto", ["base": base]), Fonts.pt(12, Fonts.w650), "ok"), spring(), label(When.clock(m["at"] as? String), Fonts.pt(12, .medium), "tx3")], spacing: 7),
                                 cardText(topic, Fonts.pt(14, .semibold), "tx"), text, hstack([undo, deleted ? nil : del, spring()], spacing: 6)]))
            } else if state == "open" {
                let known = diffOf(s)
                let nfiles = (known?["files"] as? [Any])?.count ?? 0
                if s.state != "working", known == nil || nfiles > 0 {
                    let check = known?["check"] as? [String: Any]
                    let moved = (check?["moved"] as? NSNumber)?.intValue ?? 0
                    let clean = check?["clean"] as? Bool ?? true
                    let movedLine = moved > 0 ? " \(base) moved \(moved) commit\(moved == 1 ? "" : "s") since it started; it \(clean ? "still merges cleanly" : "clashes now")." : ""
                    let rv = RButton(t("review.review"), .primary, small: true) { [weak self] in self?.openReview(key) }
                    buttons["review"] = rv
                    let mg = RButton(t("review.mergeWithout"), small: true) { [weak self] in self?.merge(s, known) }
                    mg.isEnabled = !busy
                    buttons["mergeWithout"] = mg
                    out.append(card([hstack([Icon("review", "you", size: 14), { let l = label(t("review.asks", ["who": who]), Fonts.pt(12, Fonts.w650), "you", lines: 0); l.preferredMaxLayoutWidth = PanelView.width - 56 - 21; return l }(), spring()], spacing: 7),
                                     cardText(topic, Fonts.pt(14, .semibold), "tx"), cardText(t("review.builtOn", ["branch": branch]) + movedLine), hstack([rv, mg, spring()], spacing: 6)]))
                }
                let kv = NSGridView(views: [[label(t("review.branch"), Fonts.pt(12), "tx3"), label(branch, Fonts.mono(12))],
                                            [label(t("checkpoint.folder"), Fonts.pt(12), "tx3"), cardText((wt["folder"] as? String ?? "").replacingOccurrences(of: NSHomeDirectory(), with: "~"), Fonts.mono(12), "tx")],
                                            [label(t("review.after"), Fonts.pt(12), "tx3"), cardText(t("review.afterLine"), Fonts.pt(12.5), "tx")]])
                kv.column(at: 0).width = 52
                kv.rowSpacing = 5
                kv.yPlacement = .top
                // Discard: its copy and its branch removed without merging (SESS-047), sure first.
                var rows: [NSView?] = [kv]
                if discardAsk.contains(s.surfaceId) {
                    let yes = RButton(t("review.discardYes"), small: true) { [weak self] in self?.discard(s, branch: branch) }
                    yes.titleColor = "bad"
                    yes.isEnabled = !busy
                    buttons["discardYes"] = yes
                    let no = RButton(t("review.discardNo"), .ghost, small: true) { [weak self] in self?.discardAsk.remove(s.surfaceId); self?.rerender() }
                    buttons["discardNo"] = no
                    rows += [cardText(t("review.discardAsk", ["branch": branch]), Fonts.pt(12.5), "bad"), hstack([yes, no, spring()], spacing: 6)]
                } else if s.state != "working" {
                    let d = RButton(t("review.discard"), .link) { [weak self] in self?.discardAsk.insert(s.surfaceId); self?.rerender() }
                    d.titleSize = 12
                    d.titleColor = "tx3"
                    buttons["discard"] = d
                    rows.append(hstack([d, spring()], spacing: 0))
                }
                out.append(sec(t("review.itsCopy"), nil, rows))
            }
        }
        if let f = filesSection(p, s, sec: sec) { out.append(f) }
        return out
    }

    private func cardText(_ s: String, _ font: NSFont = Fonts.pt(12.5), _ color: String = "tx2") -> NSTextField {
        let l = label(s, font, color, lines: 0, select: true)
        l.preferredMaxLayoutWidth = PanelView.width - 56
        return l
    }

    /// The rows Files it changed shows before "and N more".
    static let filesShown = 6

    /// Files it changed (19 A): each with its counts, one another session changed too in orange with what that means.
    private func filesSection(_ p: HubProject, _ s: HubSession, sec: (String?, NSView?, [NSView?]) -> NSView) -> NSView? {
        guard let d = filesOf(p.id), let me = (d["sessions"] as? [[String: Any]] ?? []).first(where: { $0["surfaceId"] as? String == s.surfaceId }) else { return nil }
        let fs = me["files"] as? [[String: Any]] ?? []
        if fs.isEmpty { return nil }
        let num = { (f: [String: Any], k: String) in (f[k] as? NSNumber)?.intValue ?? 0 }
        let added = fs.reduce(0) { $0 + num($1, "added") }, removed = fs.reduce(0) { $0 + num($1, "removed") }
        let changed = fs.filter { !($0["read"] as? Bool ?? false) }.count
        let hit = { (f: [String: Any]) in f["clash"] != nil && !(f["read"] as? Bool ?? false) ? 1 : 0 }
        let sorted = fs.sorted { hit($0) != hit($1) ? hit($0) > hit($1) : !($0["read"] as? Bool ?? false) && ($1["read"] as? Bool ?? false) }
        var rows: [NSView?] = []
        // At most filesShown rows (the panel's lists show 6, as Sessions' closed ones), then "and N more", which opens the grid.
        for f in sorted.prefix(Self.filesShown) {
            let path = f["path"] as? String ?? ""
            let pl = label(path, Fonts.mono(11.5), "tx")
            pl.lineBreakMode = .byTruncatingHead
            pl.setContentCompressionResistancePriority(.init(1), for: .horizontal)
            if let c = f["clash"] as? [String: Any], !(f["read"] as? Bool ?? false) {
                pl.textColor = Design.color("you")
                rows.append(hstack([Icon("warn", "you", size: 13), pl, spring(), counts(num(f, "added"), num(f, "removed"))], spacing: 8))
                let a = c["assistant"] as? String
                let who = (Assistants.of(a)?.short ?? "Another agent") + ((c["topic"] as? String).map { ", in \($0)," } ?? "")
                let when = (c["at"] as? String).map { When.ago($0) == "now" ? " just now" : " \(When.ago($0)) ago" } ?? ""
                let same = c["same"] as? Bool ?? false
                let txt = label("\(who) changed this file too\(when). \(same ? t("files.sameFolder") : t("files.ownCopy"))", Fonts.pt(12.5), "tx", lines: 0, select: true)
                txt.preferredMaxLayoutWidth = PanelView.width - 56 - 20
                let both = RButton(t("files.seeBoth"), .link) { [weak self] in self?.openGrid(p.id) }
                buttons["seeBoth:\(path)"] = both
                rows.append(boxed(vstack([txt, hstack([both, spring()], spacing: 0)], spacing: 6), fill: "amber-t", radius: 8, insets: NSEdgeInsets(top: 9, left: 10, bottom: 9, right: 10)))
            } else if f["read"] as? Bool ?? false {
                pl.textColor = Design.color("tx3")
                rows.append(hstack([pl, spring(), label(t("files.readOnly"), Fonts.pt(11.5), "tx3")], spacing: 8))
            } else {
                rows.append(hstack([pl, spring(), counts(num(f, "added"), num(f, "removed"))], spacing: 8))
            }
        }
        if sorted.count > Self.filesShown {
            let more = RButton(t("files.more", ["n": "\(sorted.count - Self.filesShown)"]), .link) { [weak self] in self?.openGrid(p.id) }
            buttons["filesMore"] = more
            rows.append(hstack([more, spring()], spacing: 0))
        } else { buttons["filesMore"] = nil }
        let all = RButton(t("files.seeAll", ["project": p.name]), .link) { [weak self] in self?.openGrid(p.id) }
        buttons["seeAll"] = all
        rows.append(hstack([all, spring()], spacing: 0))
        return sec(t("files.itChanged"), label("\(changed) file\(fs.count == 1 ? "" : "s"), +\(added) −\(removed)", Fonts.pt(12, .medium).withTabularDigits, "tx3"), rows)
    }

    func merge(_ s: HubSession, _ d: [String: Any]?, done: ((Bool) -> Void)? = nil) {
        guard !busy else { return }
        busy = true
        rerender()
        hub.post("/api/sessions/\(enc(s.surfaceId))/merge", ["mode": d?["mergeMode"] as? String ?? "ff"]) { [weak self] code, j in
            guard let self else { return }
            self.busy = false
            if code != 200 { self.toast(j["error"] as? String ?? "The board answered \(code).") }
            self.forget(s.surfaceId)
            self.rerender()
            done?(code == 200)
        }
    }

    func discard(_ s: HubSession, branch: String) {
        guard !busy else { return }
        busy = true
        rerender()
        hub.post("/api/sessions/\(enc(s.surfaceId))/discard", [:]) { [weak self] code, j in
            guard let self else { return }
            self.busy = false
            self.discardAsk.remove(s.surfaceId)
            self.toast(code == 200 ? t("review.discarded", ["branch": branch]) : j["error"] as? String ?? "The board answered \(code).")
            self.forget(s.surfaceId)
            self.rerender()
        }
    }

    private func post(_ s: HubSession, _ what: String, _ ok: String) {
        hub.post("/api/sessions/\(enc(s.surfaceId))/\(what)", [:]) { [weak self] code, j in
            self?.toast(code == 200 ? ok : j["error"] as? String ?? "The board answered \(code).")
            self?.forget(s.surfaceId)
            self?.rerender()
        }
    }
}

/// One line of the diff (.dl): its number, its sign, its text; a press on it starts a comment.
final class DiffLine: Box, Hovers {
    var onComment: (() -> Void)?
    init(_ l: [String: Any], commented: Bool) {
        let kind = l["kind"] as? String ?? "ctx"
        super.init(fill: nil)
        rawFill = kind == "add" ? NSColor(srgbRed: 48 / 255, green: 209 / 255, blue: 88 / 255, alpha: 0.12)
            : kind == "del" ? NSColor(srgbRed: 1, green: 105 / 255, blue: 97 / 255, alpha: 0.12)
            : kind == "hunk" ? NSColor(white: 1, alpha: 0.03) : nil
        translatesAutoresizingMaskIntoConstraints = false
        let no = (l["newNo"] as? NSNumber) ?? (l["oldNo"] as? NSNumber)
        let ln = label(no.map { "\($0)" } ?? "", Fonts.mono(12), "")
        ln.textColor = termDim
        ln.alignment = .right
        let sg = label(kind == "add" ? "+" : kind == "del" ? "−" : "", Fonts.mono(12), "")
        sg.textColor = kind == "add" ? NSColor(srgbRed: 0x4C / 255, green: 0xE0 / 255, blue: 0x7A / 255, alpha: 1) : NSColor(srgbRed: 1, green: 0x8A / 255, blue: 0x80 / 255, alpha: 1)
        let tx = label(l["text"] as? String ?? "", Fonts.mono(12), "")
        tx.textColor = kind == "hunk" ? NSColor(srgbRed: 0x8E / 255, green: 0x8E / 255, blue: 0x93 / 255, alpha: 1) : termText
        tx.lineBreakMode = .byClipping
        tx.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        for v in [ln, sg, tx] { v.translatesAutoresizingMaskIntoConstraints = false; addSubview(v) }
        NSLayoutConstraint.activate([ln.leadingAnchor.constraint(equalTo: leadingAnchor), ln.widthAnchor.constraint(equalToConstant: 34),
                                     sg.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 44), sg.widthAnchor.constraint(equalToConstant: 18),
                                     tx.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 62), tx.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -16),
                                     heightAnchor.constraint(equalToConstant: 20)] + [ln, sg, tx].map { $0.centerYAnchor.constraint(equalTo: centerYAnchor) })
        if commented {
            let bar = Box(fill: "you")
            bar.translatesAutoresizingMaskIntoConstraints = false
            addSubview(bar)
            NSLayoutConstraint.activate([bar.leadingAnchor.constraint(equalTo: leadingAnchor), bar.widthAnchor.constraint(equalToConstant: 2), bar.topAnchor.constraint(equalTo: topAnchor), bar.bottomAnchor.constraint(equalTo: bottomAnchor)])
        }
        numberLabel = ln
        if kind != "hunk" {
            // The blue + at the line under the pointer, over its sign (.dl:hover .cm-btn): a press there comments.
            let plus = boxed(label("+", Fonts.pt(13, .bold), ""), fill: "work", radius: 4, insets: NSEdgeInsets(top: 0, left: 4, bottom: 0, right: 4))
            (plus.subviews.first as? NSTextField)?.textColor = .white
            (plus.subviews.first as? NSTextField)?.alignment = .center
            plus.isHidden = true
            plus.translatesAutoresizingMaskIntoConstraints = false
            addSubview(plus)
            NSLayoutConstraint.activate([plus.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 40), plus.widthAnchor.constraint(equalToConstant: 18),
                                         plus.heightAnchor.constraint(equalToConstant: 18), plus.centerYAnchor.constraint(equalTo: centerYAnchor)])
            plusMark = plus
            toolTip = t("review.commentHere")
            setAccessibilityElement(true)
            setAccessibilityRole(.button)
            setAccessibilityLabel("\(t("review.commentHere")): \(no.map { "\($0)" } ?? "")")
        }
    }
    required init?(coder: NSCoder) { fatalError() }
    private weak var numberLabel: NSTextField?
    /// The + shown while the pointer is on the line.
    private(set) weak var plusMark: NSView?
    var hovering = false {
        didSet {
            plusMark?.isHidden = !hovering
            numberLabel?.textColor = hovering && plusMark != nil ? Design.color("link") : termDim
        }
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for t in trackingAreas { removeTrackingArea(t) }
        if plusMark != nil { addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)) }
    }
    /// Only a line with its + lights.
    var takesHover: Bool { plusMark != nil }
    override func mouseEntered(with e: NSEvent) { hovering = true; Hover.entered(self) }
    override func mouseExited(with e: NSEvent) { hovering = false; Hover.exited(self) }
    override func resetCursorRects() { if plusMark != nil { for r in uncovered(NSRect(x: 0, y: 0, width: 62, height: bounds.height)) { addCursorRect(r, cursor: .pointingHand) } } }
    /// The width its text needs on one line, with the gutter and the right margin.
    static func width(of text: String) -> CGFloat { ceil((text as NSString).size(withAttributes: [.font: Fonts.mono(12)]).width) + 62 + 16 }
    /// The press is the line's, not its words' (a label would keep it).
    override func hitTest(_ p: NSPoint) -> NSView? { frame.contains(p) ? self : nil }
    override func accessibilityPerformPress() -> Bool { onComment?(); return true }
    /// The presses it got, for the self-test (a press on its words is not a comment: it takes a double click there).
    private(set) var presses = 0
    override func mouseDown(with e: NSEvent) { presses += 1; if e.clickCount >= 2 || convert(e.locationInWindow, from: nil).x < 62 { onComment?() } }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
}

/// JSON with sorted keys: the same for equal values, whatever order their dictionaries keep.
func stableText(_ v: Any?) -> String {
    guard let v, !(v is NSNull) else { return "" }
    if JSONSerialization.isValidJSONObject(v), let d = try? JSONSerialization.data(withJSONObject: v, options: [.sortedKeys]) { return String(decoding: d, as: UTF8.self) }
    return String(describing: v)
}

/// The review in the middle (33 A): its files on the left, the diff on the right.
final class ReviewView: Box, BackLinked {
    var hub: HubClient?
    var cards: WorktreeCards?
    var toast: (String) -> Void = { _ in }
    var back: () -> Void = {}
    /// Where it was opened from, as the head's "‹ Paper-boat" (Board.showMiddle sets it); Close goes back too.
    var backLink: (name: String, run: () -> Void)? {
        didSet { if oldValue?.name != backLink?.name { drawn = ""; draw() } }
    }
    private(set) var key: String?
    private var surface = ""
    private(set) var diff: [String: Any]?
    private(set) var comments: [[String: Any]] = []
    private(set) var sel: String?
    private(set) var composing: (file: String, line: Int, side: String)?
    private(set) var busy = false
    private var loadedAt = Date.distantPast
    private var commentsAt = Date.distantPast
    private var project: HubProject?
    private var session: HubSession?
    private let head = Flipped()
    private let list = StackScroll(spacing: 2, insets: NSEdgeInsets(top: 10, left: 8, bottom: 10, right: 8))
    private let body = StackScroll(spacing: 0, insets: NSEdgeInsets(top: 0, left: 0, bottom: 20, right: 0))
    /// The diff's scroll view, for the self-test.
    var diffScroll: StackScroll { body }
    private let listEdge = Box(fill: "sep")
    private var drawn = ""
    /// What the self-test presses.
    private(set) var buttons: [String: RButton] = [:]
    private(set) var lines: [String: DiffLine] = [:]
    /// How many times it was drawn again, for the self-test.
    private(set) var draws = 0
    private(set) var composer: KeyTextView?
    private var timer: Timer?

    init() {
        super.init(fill: "sheet")
        addSubview(head)
        addSubview(list)
        addSubview(body)
        addSubview(listEdge)
        body.drawsBackground = true
        body.backgroundColor = Design.color("term-bg")
        // Long lines scroll sideways, whole (.rv-d overflow: auto, white-space: pre).
        body.hasHorizontalScroller = true
        body.horizontalScrollElasticity = .allowed
        for s in [list, body] { s.automaticallyAdjustsContentInsets = false }
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); draw() }

    override func layout() {
        super.layout()
        let hh = head.subviews.first?.fittingSize.height ?? 56
        head.frame = NSRect(x: 0, y: 0, width: bounds.width, height: hh)
        head.subviews.first?.frame = head.bounds
        list.frame = NSRect(x: 0, y: hh, width: 220, height: max(0, bounds.height - hh))
        listEdge.frame = NSRect(x: 220, y: hh, width: 1, height: max(0, bounds.height - hh))
        body.frame = NSRect(x: 221, y: hh, width: max(0, bounds.width - 221), height: max(0, bounds.height - hh))
    }

    func show(_ key: String, _ p: HubProject, _ s: HubSession) {
        if self.key != key { self.key = key; surface = s.surfaceId; diff = nil; sel = nil; composing = nil; comments = []; commentsAt = .distantPast; loadedAt = .distantPast }
        drawn = drawn.isEmpty ? "" : drawn
        project = p; session = s
        if diff == nil || Date().timeIntervalSince(loadedAt) > 15 { load() }
        if Date().timeIntervalSince(commentsAt) > 3 { loadComments() }
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
                guard let self, self.window != nil, !self.isHidden else { return }
                self.loadComments()
            }
        }
        draw()
    }

    func load() {
        loadedAt = Date()
        let sf = surface
        hub?.get("/api/sessions/\(enc(sf))/diff") { [weak self] code, j in
            guard let self, self.surface == sf else { return }
            self.diff = code == 200 ? j : ["ok": false, "files": [], "error": j["error"] as? String ?? t("review.couldNotRead")]
            let files = self.diff?["files"] as? [[String: Any]] ?? []
            if self.sel == nil || !files.contains(where: { $0["path"] as? String == self.sel }) { self.sel = files.first?["path"] as? String }
            self.draw()
        }
    }

    func loadComments() {
        commentsAt = Date()
        let sf = surface
        hub?.get("/api/sessions/\(enc(sf))/review") { [weak self] code, j in
            guard let self, self.surface == sf, code == 200 else { return }
            let list = j["comments"] as? [[String: Any]] ?? []
            if (list as NSArray) != (self.comments as NSArray) { self.comments = list; self.draw() }
        }
    }

    private var pending: [[String: Any]] { comments.filter { $0["state"] as? String == "pending" } }

    func select(_ path: String) { sel = path; composing = nil; draw() }

    func draw() {
        guard let p = project, let s = session else { return }
        // Drawn again only when what it shows changed (the board draws at every state; a comment being typed stays).
        // Said with sorted keys: a dictionary's description lists its keys in no fixed order, so two
        // equal answers read apart said different things and the review was built again every few
        // seconds, the line or button under the pointer swapped for a new one mid-press.
        let sig = [diff?["diff"] as? String ?? "", stableText(diff?["check"]), stableText(comments), sel ?? "",
                   composing.map { "\($0.file):\($0.line):\($0.side)" } ?? "", "\(busy)", stableText(s.worktree), s.state, s.topic ?? "", p.name,
                   effectiveAppearance.name.rawValue, backLink?.name ?? "-"].joined(separator: "|")
        if sig == drawn { return }
        drawn = sig
        draws += 1
        let oldBack = buttons["back"]
        buttons = [:]
        let d = diff
        let wt = s.worktree
        let topic = s.topic ?? p.name
        let files = d?["files"] as? [[String: Any]] ?? []
        let num = { (f: [String: Any], k: String) in (f[k] as? NSNumber)?.intValue ?? 0 }
        let added = files.reduce(0) { $0 + num($1, "added") }, removed = files.reduce(0) { $0 + num($1, "removed") }
        let base = wt?["baseBranch"] as? String ?? "main"
        let check = d?["check"] as? [String: Any]
        // .rv-h
        var sub: [NSView?] = []
        if let b = wt?["branch"] as? String { sub.append(hstack([Icon("branch", "tx3", size: 12), label(b.replacingOccurrences(of: "^ravenry/", with: "", options: .regularExpression), Fonts.mono(11.5), "tx3")], spacing: 4)) }
        sub.append(label(d == nil ? t("review.reading") : "\(files.count) file\(files.count == 1 ? "" : "s"), +\(added) −\(removed)", Fonts.pt(12).withTabularDigits, "tx3"))
        if let u = d?["uncommitted"] as? [Any], !u.isEmpty { sub.append(hstack([Icon("warn", "you", size: 12), label(t("review.notCommitted", ["n": "\(u.count)"]), Fonts.pt(12), "you")], spacing: 5)) }
        if let c = check {
            let clean = c["clean"] as? Bool ?? true
            let n = (c["conflicts"] as? [Any])?.count ?? 0
            sub.append(clean ? hstack([Icon("check-c", "ok", size: 12), label(t("review.noClashes", ["base": base]), Fonts.pt(12), "ok")], spacing: 5)
                : hstack([Icon("warn", "you", size: 12), label("Clashes with \(base) in \(n) file\(n == 1 ? "" : "s")", Fonts.pt(12), "you")], spacing: 5))
        }
        let title = hstack([Icon("review", "tx", size: 15), label(s.state != "working" ? t("review.ready", ["topic": topic]) : t("review.soFar", ["topic": topic]), Fonts.pt(15, .bold))], spacing: 8)
        let tt = vstack([title, hstack(sub, spacing: 12)], spacing: 3)
        tt.setContentHuggingPriority(.init(1), for: .horizontal)
        var acts: [NSView?] = []
        if !pending.isEmpty {
            let n = pending.count
            let b = RButton("Send \(n) comment\(n == 1 ? "" : "s")", small: true) { [weak self] in self?.sendComments() }
            b.isEnabled = !busy
            buttons["send"] = b
            acts.append(b)
        }
        let merge = RButton(t("review.mergeInto", ["base": base]), .primary, small: true) { [weak self] in self?.merge() }
        merge.lead = "merge"
        merge.isEnabled = !busy && (wt?["state"] as? String) == "open" && d != nil && !files.isEmpty
        buttons["merge"] = merge
        acts.append(merge)
        // Where it was opened from ("‹ Paper-boat"), back there as its tab's x, Esc and Cmd+W
        // (no Close of its own: at 900 the head has no room for one beside Merge).
        var lead: [NSView?] = []
        if let l = backLink { let b = backButton(l.name, l.run, reusing: oldBack); buttons["back"] = b; lead.append(b) }
        let h = hstack(lead + [tt, spring()] + acts, spacing: 10, insets: NSEdgeInsets(top: 12, left: lead.isEmpty ? 18 : 12, bottom: 12, right: 18))
        h.translatesAutoresizingMaskIntoConstraints = true
        let line = Box(fill: "sep")
        line.translatesAutoresizingMaskIntoConstraints = false
        h.addSubview(line)
        NSLayoutConstraint.activate([line.leadingAnchor.constraint(equalTo: h.leadingAnchor), line.trailingAnchor.constraint(equalTo: h.trailingAnchor), line.bottomAnchor.constraint(equalTo: h.bottomAnchor), line.heightAnchor.constraint(equalToConstant: 1)])
        head.subviews.forEach { $0.removeFromSuperview() }
        head.addSubview(h)
        // The files (.rv-fl).
        var fl: [NSView] = [vstack([label("\(files.count) file\(files.count == 1 ? "" : "s")", Fonts.pt(12, Fonts.w650), "tx2")], spacing: 0, insets: NSEdgeInsets(top: 4, left: 8, bottom: 8, right: 8))]
        for f in files {
            let path = f["path"] as? String ?? ""
            let n = comments.filter { $0["file"] as? String == path }.count
            let pl = label(path, Fonts.mono(11.5), "tx")
            pl.lineBreakMode = .byTruncatingTail
            pl.setContentCompressionResistancePriority(.init(1), for: .horizontal)
            var items: [NSView?] = [pl, spring()]
            if n > 0 { items.append(boxed(label("\(n)", Fonts.pt(10, .bold), "win"), fill: "you", radius: 8, insets: NSEdgeInsets(top: 1, left: 5, bottom: 1, right: 5))) }
            items.append(counts(num(f, "added"), num(f, "removed")))
            let row = Row(radius: 6)
            row.selected = path == sel
            let st = hstack(items, spacing: 6, insets: NSEdgeInsets(top: 6, left: 8, bottom: 6, right: 8))
            st.translatesAutoresizingMaskIntoConstraints = false
            row.addSubview(st)
            NSLayoutConstraint.activate([st.leadingAnchor.constraint(equalTo: row.leadingAnchor), st.trailingAnchor.constraint(equalTo: row.trailingAnchor), st.topAnchor.constraint(equalTo: row.topAnchor), st.bottomAnchor.constraint(equalTo: row.bottomAnchor)])
            row.toolTip = path
            row.onOpen = { [weak self] in self?.select(path) }
            fl.append(row)
        }
        list.set(fl)
        // The diff (.rv-d).
        lines = [:]
        composer = nil
        var dv: [NSView] = []
        if d == nil { dv.append(pad(label(t("review.reading"), Fonts.pt(13), "tx3"))) }
        else if (d?["ok"] as? Bool) == false { dv.append(pad(label(d?["error"] as? String ?? t("review.nothing"), Fonts.pt(13), "tx3", lines: 0))) }
        else if let path = sel, let f = files.first(where: { $0["path"] as? String == path }) {
            let fh = hstack([label(path, Fonts.mono(12)), label("+\(num(f, "added")) −\(num(f, "removed"))", Fonts.mono(12), "")], spacing: 10, insets: NSEdgeInsets(top: 10, left: 16, bottom: 10, right: 16))
            (fh.arrangedSubviews[0] as? NSTextField)?.textColor = NSColor(srgbRed: 0xF2 / 255, green: 0xF2 / 255, blue: 0xF4 / 255, alpha: 1)
            (fh.arrangedSubviews[1] as? NSTextField)?.textColor = NSColor(srgbRed: 0x8E / 255, green: 0x8E / 255, blue: 0x93 / 255, alpha: 1)
            dv.append(fh)
            if f["binary"] as? Bool ?? false { dv.append(pad(label(t("review.binary"), Fonts.pt(12), "tx3"))) }
            let who = Assistants.of(s.assistant)?.short ?? "the agent"
            let fl = (d?["lines"] as? [String: Any])?[path] as? [[String: Any]] ?? []
            body.minWidth = fl.map { DiffLine.width(of: $0["text"] as? String ?? "") }.max() ?? 0
            for l in fl {
                let kind = l["kind"] as? String ?? "ctx"
                let no = ((l["newNo"] as? NSNumber) ?? (l["oldNo"] as? NSNumber))?.intValue ?? 0
                let side = l["newNo"] is NSNumber ? "new" : "old"
                let cs = comments.filter { $0["file"] as? String == path && ($0["line"] as? NSNumber)?.intValue == no && $0["side"] as? String == side }
                let comp = composing.map { $0.file == path && $0.line == no && $0.side == side } ?? false
                let row = DiffLine(l, commented: !cs.isEmpty || comp)
                if kind != "hunk" {
                    row.onComment = { [weak self] in self?.compose(path, no, side) }
                    lines["\(side):\(no)"] = row
                }
                dv.append(row)
                if !cs.isEmpty || comp { dv.append(thread(cs, comp: comp, who: who)) }
            }
        }
        body.set(dv)
        needsLayout = true
        if composing != nil, let c = composer { DispatchQueue.main.async { [weak self] in self?.window?.makeFirstResponder(c) } }
    }

    private func pad(_ v: NSView) -> NSView { vstack([v], spacing: 0, insets: NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)) }

    /// The comments on a line and the agent's replies (.cth), with the composer when it is open there.
    private func thread(_ cs: [[String: Any]], comp: Bool, who: String) -> NSView {
        var items: [NSView?] = []
        for c in cs {
            var h: [NSView?] = [label("You", Fonts.pt(12.5, .bold)), label(When.clock(c["at"] as? String), Fonts.pt(12).withTabularDigits, "tx3")]
            if c["state"] as? String == "sent" { h.append(hstack([Icon("check-c", "ok", size: 12), label(t("review.sentTo", ["who": who]), Fonts.pt(12), "ok")], spacing: 4)) }
            else {
                h.append(label(t("review.notSent"), Fonts.pt(12), "you"))
                let id = c["id"] as? String ?? ""
                let tb = RButton(t("review.takeBack"), .link) { [weak self] in self?.remove(id) }
                buttons["takeBack:\(id)"] = tb
                h.append(tb)
            }
            h.append(spring())
            let tx = label(c["text"] as? String ?? "", Fonts.pt(12.5), "tx", lines: 0, select: true)
            tx.preferredMaxLayoutWidth = 520
            items.append(vstack([hstack(h, spacing: 8), tx], spacing: 3))
            for r in c["replies"] as? [[String: Any]] ?? [] {
                let rt = label(r["text"] as? String ?? "", Fonts.pt(12.5), "tx", lines: 0, select: true)
                rt.preferredMaxLayoutWidth = 520
                items.append(vstack([hstack([label(who.prefix(1).uppercased() + who.dropFirst(), Fonts.pt(12.5, .bold)), label(When.clock(r["at"] as? String), Fonts.pt(12).withTabularDigits, "tx3"), spring()], spacing: 8), rt], spacing: 3))
            }
        }
        if comp {
            let tv = KeyTextView()
            tv.isRichText = false
            tv.font = Fonts.pt(12.5)
            tv.textColor = Design.color("tx")
            tv.drawsBackground = false
            tv.textContainerInset = NSSize(width: 6, height: 6)
            tv.setAccessibilityLabel(t("review.sayWhat"))
            tv.onEscape = { [weak self] in self?.composing = nil; self?.draw() }
            tv.onCommandReturn = { [weak self] in self?.addComment() }
            composer = tv
            let box = Box(fill: "input", ring: "sep", radius: 7)
            box.translatesAutoresizingMaskIntoConstraints = false
            tv.translatesAutoresizingMaskIntoConstraints = false
            box.addSubview(tv)
            NSLayoutConstraint.activate([tv.leadingAnchor.constraint(equalTo: box.leadingAnchor), tv.trailingAnchor.constraint(equalTo: box.trailingAnchor), tv.topAnchor.constraint(equalTo: box.topAnchor), tv.bottomAnchor.constraint(equalTo: box.bottomAnchor), box.heightAnchor.constraint(equalToConstant: 60)])
            let add = RButton(t("review.addComment"), .primary, small: true) { [weak self] in self?.addComment() }
            buttons["addComment"] = add
            let cancel = RButton(t("checkpoint.cancel"), .ghost, small: true) { [weak self] in self?.composing = nil; self?.draw() }
            buttons["cancelComment"] = cancel
            items.append(vstack([box, hstack([add, cancel, spring()], spacing: 6)], spacing: 6))
        }
        let card = boxed(vstack(items, spacing: 10), fill: "card", ring: "sep", radius: 8, insets: NSEdgeInsets(top: 10, left: 12, bottom: 10, right: 12))
        // Under its line, at most 640 wide: a diff wider than the view scrolls, the thread stays in view.
        let wrapV = Flipped()
        wrapV.translatesAutoresizingMaskIntoConstraints = false
        wrapV.addSubview(card)
        let fill = card.trailingAnchor.constraint(equalTo: wrapV.trailingAnchor, constant: -16)
        fill.priority = .init(700)
        NSLayoutConstraint.activate([card.leadingAnchor.constraint(equalTo: wrapV.leadingAnchor, constant: 62), card.topAnchor.constraint(equalTo: wrapV.topAnchor, constant: 6),
                                     card.bottomAnchor.constraint(equalTo: wrapV.bottomAnchor, constant: -10), card.widthAnchor.constraint(lessThanOrEqualToConstant: 640), fill,
                                     card.trailingAnchor.constraint(lessThanOrEqualTo: wrapV.trailingAnchor, constant: -16)])
        return wrapV
    }

    func compose(_ file: String, _ line: Int, _ side: String) {
        composing = (file, line, side)
        draw()
    }

    func addComment(_ text: String? = nil) {
        guard let c = composing else { return }
        let txt = (text ?? composer?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if txt.isEmpty { if let v = composer { window?.makeFirstResponder(v) }; return }
        hub?.post("/api/sessions/\(enc(surface))/review/comment", ["file": c.file, "line": c.line, "side": c.side, "text": txt]) { [weak self] code, j in
            guard let self else { return }
            if code != 200 { self.toast(j["error"] as? String ?? t("review.notKept")); return }
            self.composing = nil
            self.loadComments()
            self.draw()
        }
    }

    private func remove(_ id: String) {
        hub?.post("/api/sessions/\(enc(surface))/review/remove", ["id": id]) { [weak self] code, j in
            if code != 200 { self?.toast(j["error"] as? String ?? t("review.couldNotTakeBack")) }
            self?.loadComments()
        }
    }

    func sendComments() {
        guard !busy else { return }
        busy = true
        draw()
        hub?.post("/api/sessions/\(enc(surface))/review/send", [:]) { [weak self] code, j in
            guard let self else { return }
            self.busy = false
            if code == 200 { let n = (j["sent"] as? [Any])?.count ?? 0; self.toast("Sent \(n) comment\(n == 1 ? "" : "s").") }
            else { self.toast(t("review.couldNotSend", ["why": j["error"] as? String ?? "the board answered \(code)"])) }
            self.loadComments()
            self.draw()
        }
    }

    func merge() {
        guard let s = session, let cards else { return }
        busy = true
        draw()
        cards.merge(s, diff) { [weak self] ok in
            self?.busy = false
            if ok { self?.back() } else { self?.draw() }
        }
    }
}

/// "Who changed what in <project>" (19 B): a row a file, a column a session and you, the files two changed in orange.
final class FilesGridPage: FormPage {
    private(set) var project: String?
    var cards: WorktreeCards?
    func show(_ pid: String, name: String) {
        project = pid
        dirty()
        redraw(name: name)
    }
    func redraw(name: String) {
        guard let pid = project else { return }
        let d = cards?.filesOf(pid)
        let grid = d?["grid"] as? [String: Any]
        let cols = grid?["cols"] as? [[String: Any]] ?? []
        let you = grid?["you"] as? Bool ?? false
        setHead(title: t("files.whoChanged", ["project": name]), src: "\(cols.count) session\(cols.count == 1 ? "" : "s")\(you ? " and you" : ""), the files each one changed")
        let sig = (try? JSONSerialization.data(withJSONObject: [d ?? [:], name], options: .sortedKeys)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        draw(sig) {
            guard let d else { return [label(t("files.reading"), Fonts.pt(13), "tx3")] }
            let rows = grid?["rows"] as? [[String: Any]] ?? []
            if rows.isEmpty { _ = d; return [label(t("files.none"), Fonts.pt(13), "tx3")] }
            var g: [[NSView]] = []
            let headCell = { (a: String, b: String?) -> NSView in
                let v = vstack([label(a, Fonts.pt(12, Fonts.w650), "tx2"), b.map { label($0, Fonts.pt(12), "tx3") }], spacing: 1)
                v.alignment = .centerX
                return v
            }
            g.append([label(t("files.file"), Fonts.pt(12, Fonts.w650), "tx2")] + cols.map { c in
                let a = c["assistant"] as? String
                return headCell(c["topic"] as? String ?? "Session", Assistants.of(a)?.chip)
            } + [headCell("You", nil)])
            for r in rows {
                let clash = r["clash"] as? Bool ?? false
                var line: [NSView] = [label(r["path"] as? String ?? "", Fonts.mono(12), clash ? "you" : "tx")]
                for c in r["cells"] as? [Any] ?? [] {
                    if let c = c as? [String: Any] {
                        line.append(c["read"] as? Bool ?? false ? label(t("files.read"), Fonts.pt(12), "tx3") : counts((c["added"] as? NSNumber)?.intValue ?? 0, (c["removed"] as? NSNumber)?.intValue ?? 0, size: 12))
                    } else { line.append(label("", Fonts.pt(12))) }
                }
                g.append(line)
            }
            let gv = NSGridView(views: g)
            gv.rowSpacing = 0
            gv.columnSpacing = 0
            gv.yPlacement = .center
            for i in 0..<gv.numberOfColumns { gv.column(at: i).xPlacement = i == 0 ? .leading : .center; gv.column(at: i).leadingPadding = 10; gv.column(at: i).trailingPadding = 10 }
            for i in 0..<gv.numberOfRows { gv.row(at: i).topPadding = i == 0 ? 6 : 8; gv.row(at: i).bottomPadding = 8 }
            gv.column(at: 0).width = 280
            // The rows of a file two sessions changed, tinted.
            let wrap = GridTint(gv, rows: rows.enumerated().filter { $0.element["clash"] as? Bool ?? false }.map { $0.offset + 1 })
            let note = label(t("files.note"), Fonts.pt(12), "tx3", lines: 0)
            return [secBox(nil, [wrap, note])]
        }
    }
}

/// A grid with lines between its rows and the clashing rows tinted (.fgrid tr.clash).
final class GridTint: Flipped {
    let grid: NSGridView
    let tinted: [Int]
    init(_ g: NSGridView, rows: [Int]) {
        grid = g; tinted = rows
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        g.translatesAutoresizingMaskIntoConstraints = false
        addSubview(g)
        NSLayoutConstraint.activate([g.leadingAnchor.constraint(equalTo: leadingAnchor), g.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor), g.topAnchor.constraint(equalTo: topAnchor), g.bottomAnchor.constraint(equalTo: bottomAnchor)])
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ r: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            for i in 1..<max(1, grid.numberOfRows) {
                let cells = (0..<grid.numberOfColumns).compactMap { grid.cell(atColumnIndex: $0, rowIndex: i).contentView?.frame }
                guard let top = cells.map(\.minY).min(), let bot = cells.map(\.maxY).max() else { continue }
                let y0 = top - 8, y1 = bot + 8
                if tinted.contains(i) {
                    Design.color("amber-t").setFill()
                    NSRect(x: 0, y: y0, width: bounds.width, height: y1 - y0).fill()
                    Design.color("you").setFill()
                    NSRect(x: 0, y: y0, width: 3, height: y1 - y0).fill()
                }
                Design.color("sep").setFill()
                NSRect(x: 0, y: y0, width: bounds.width, height: 1).fill()
            }
        }
    }
    override func layout() { super.layout(); needsDisplay = true }
}
