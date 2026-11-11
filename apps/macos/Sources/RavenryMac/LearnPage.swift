// Learn Ravenry (ONB-004, ONB-005), as the Electron app draws it (learn.ts;
// app.css .ln-*): opened by the person from the ? in the sidebar's foot or
// Help, never by itself. A strip with its tab and Close, the title and the
// line under it, then seven cards in a grid (232 pt at least, 14 apart),
// each a still with a play mark, its title with Used once the person used
// that part (the hub's marks, GET /api/onboarding `learn`), its line and
// its action. Try it opens a session in the last folder used with the
// card's message ready in its input, not sent; Pair your phone opens the
// phone card; the filmstrip's shows the terminal that printed last.

import AppKit

final class LearnPage: FormPage {
    struct Card { let key: String; let action: String; let message: String?; let worktree: Bool }
    /// learn.ts LEARN_CARDS, in order; the words are shared/strings' learn.<key>.*.
    static let cards: [Card] = [
        Card(key: "panes", action: t("learn.tryIt"), message: t("learn.panes.message"), worktree: false),
        Card(key: "needs", action: t("learn.tryIt"), message: t("learn.needs.message"), worktree: false),
        Card(key: "phone", action: t("learn.phone.action"), message: nil, worktree: false),
        Card(key: "pick", action: t("learn.tryIt"), message: t("learn.pick.message"), worktree: false),
        Card(key: "review", action: t("learn.tryIt"), message: t("learn.review.message"), worktree: true),
        Card(key: "film", action: t("learn.tryIt"), message: nil, worktree: false),
        Card(key: "decisions", action: t("learn.tryIt"), message: t("learn.decisions.message"), worktree: false),
    ]
    /// What Try it does: Board's (a session started, the phone card, a terminal).
    var tryIt: ((Card) -> Void)?

    /// Try it's assistant and folder (the Electron app's tryIt()): the one
    /// new sessions start with (Settings, Hand-off: the hub's startWith),
    /// else Claude Code, else any found; the folder of the session last
    /// open (one on this Mac), else the first folder the hub offers, else
    /// home. `start` is GET /api/setup/start's answer.
    static func tryChoice(start j: [String: Any], state: HubState?, lastProject: String?) -> (kind: String, folder: String)? {
        let found = (j["assistants"] as? [[String: Any]] ?? []).filter { $0["found"] as? Bool == true }
        let want = (state?.raw["assistants"] as? [String: Any])?["startWith"] as? String ?? "claude"
        let kindOf = { (x: [String: Any]) -> String in x["kind"] as? String ?? "" }
        guard let a = found.first(where: { kindOf($0) == want }) ?? found.first(where: { kindOf($0) == "claude" }) ?? found.first,
              let kind = a["kind"] as? String else { return nil }
        var lp = lastProject.flatMap { state?.project($0) }
        if lp?.machine != nil { lp = nil }
        let folders = (j["folders"] as? [[String: Any]] ?? []).compactMap { $0["path"] as? String }
        return (kind, lp?.folder ?? folders.first ?? NSHomeDirectory())
    }
    /// The parts of Ravenry the person used (the hub's marks).
    private(set) var used: [String: Bool] = [:]
    /// The card Learn more points at, ringed.
    private(set) var lit: String?
    private var cols = 0
    private(set) var cardViews: [String: NSView] = [:]

    func show(lit: String? = nil) {
        self.lit = lit
        dirty()
        load()
        poll(nil)
        redraw()
    }

    override func load() {
        hub?.get("/api/onboarding") { [weak self] code, j in
            guard let self, code == 200 else { return }
            let l = (j["learn"] as? [String: Any] ?? [:]).compactMapValues { $0 as? Bool }
            if l != self.used { self.used = l; self.redraw() }
        }
    }

    /// The self-test's: the marks as the hub sends them.
    func apply(used u: [String: Bool]) { used = u; redraw() }

    /// .ln-strip: the page's own tab (? and its name) and Close, under a line.
    private func strip() {
        head.subviews.forEach { $0.removeFromSuperview() }
        let close = RButton(t("learn.closeLabel"), .icon, small: true, icon: "close") { [weak self] in self?.onClose?() }
        // .ln-tab .x: an x of 10 in tx3, in 18.
        close.iconView?.side == 14 ? { close.iconView?.removeFromSuperview(); let x = Icon("close", "tx3", size: 10); close.addSubview(x)
            NSLayoutConstraint.activate([x.centerXAnchor.constraint(equalTo: close.centerXAnchor), x.centerYAnchor.constraint(equalTo: close.centerYAnchor)]) }() : ()
        buttons["close"] = close
        let tab = hstack([Icon("question", "tx", size: 14), label(t("learn.title"), Fonts.pt(12.5)), close], spacing: 7)
        // 40 high: the tab's middle 23 from the top (8 above it), the line at its foot.
        let s = Flipped()
        s.frame = NSRect(x: 0, y: 0, width: 600, height: 40)
        s.autoresizingMask = [.width]
        tab.translatesAutoresizingMaskIntoConstraints = false
        s.addSubview(tab)
        let line = Box(fill: "sep")
        line.translatesAutoresizingMaskIntoConstraints = false
        s.addSubview(line)
        NSLayoutConstraint.activate([tab.leadingAnchor.constraint(equalTo: s.leadingAnchor, constant: 22), tab.centerYAnchor.constraint(equalTo: s.topAnchor, constant: 23),
                                     line.leadingAnchor.constraint(equalTo: s.leadingAnchor), line.trailingAnchor.constraint(equalTo: s.trailingAnchor),
                                     line.bottomAnchor.constraint(equalTo: s.bottomAnchor), line.heightAnchor.constraint(equalToConstant: 1)])
        head.addSubview(s)
        needsLayout = true
    }

    /// .ln-strip is 40 high.
    override var headHeight: CGFloat { 40 }

    override func layoutBody() {
        super.layoutBody()
        // repeat(auto-fill, minmax(232px, 1fr)), 14 apart, inside 22 at each side.
        let n = max(1, Int((body.bounds.width - 44 + 14) / (232 + 14)))
        if n != cols && body.bounds.width > 0 { cols = n; dirty(); redraw() }
    }

    override func redraw() {
        if head.subviews.isEmpty { strip() }
        let n = max(1, cols)
        draw("\(n)|\(lit ?? "-")|\(used.keys.sorted().filter { used[$0] == true })") { self.rows(n) }
    }

    private func rows(_ n: Int) -> [NSView] {
        let h = label(t("learn.title"), Fonts.pt(21, .bold))
        let lead = spaced(wrap(t("learn.lead"), Fonts.pt(13.5), "tx2"), 1.5)
        let head = vstack([h, lead], spacing: 8)
        var out: [NSView] = [boxedTop(head, 22)]
        cardViews = [:]
        var row: [NSView] = []
        func flush() {
            while row.count < n { let s = NSView(); s.translatesAutoresizingMaskIntoConstraints = false; row.append(s) }
            let r = NSStackView(views: row)
            r.orientation = .horizontal
            r.distribution = .fillEqually
            r.alignment = .top
            r.spacing = 14
            r.translatesAutoresizingMaskIntoConstraints = false
            // Every column as wide as the first, the empty ones of a last row too.
            for v in row.dropFirst() { v.widthAnchor.constraint(equalTo: row[0].widthAnchor).isActive = true }
            for v in row where v is Box {
                let c = v.heightAnchor.constraint(equalTo: r.heightAnchor)
                c.priority = .init(749)
                c.isActive = true
            }
            out.append(r)
            row = []
        }
        for c in Self.cards {
            row.append(card(c))
            if row.count == n { flush() }
        }
        if !row.isEmpty { flush() }
        return out
    }

    /// Room above a view (.ln-b's padding-top; the stack's spacing makes the rest).
    private func boxedTop(_ v: NSView, _ top: CGFloat) -> NSView {
        let b = Flipped()
        b.translatesAutoresizingMaskIntoConstraints = false
        v.translatesAutoresizingMaskIntoConstraints = false
        b.addSubview(v)
        NSLayoutConstraint.activate([v.leadingAnchor.constraint(equalTo: b.leadingAnchor), v.trailingAnchor.constraint(lessThanOrEqualTo: b.trailingAnchor),
                                     v.widthAnchor.constraint(lessThanOrEqualToConstant: 640), v.topAnchor.constraint(equalTo: b.topAnchor, constant: top), v.bottomAnchor.constraint(equalTo: b.bottomAnchor, constant: -2)])
        let w = v.widthAnchor.constraint(equalTo: b.widthAnchor); w.priority = .init(700); w.isActive = true
        return b
    }

    /// .ln-c: the still with its play mark, then the title (and Used), the line and the action.
    private func card(_ c: Card) -> NSView {
        let pic = LearnStill(c.key)
        pic.translatesAutoresizingMaskIntoConstraints = false
        pic.heightAnchor.constraint(equalToConstant: 146).isActive = true
        var ti: [NSView?] = [label(t("learn.\(c.key).title"), Fonts.pt(13.5, Fonts.w650)), spring()]
        if used[c.key] == true { ti.append(hstack([Icon("check-c", "ok", size: 12), label(t("learn.used"), Fonts.pt(12, .medium), "ok")], spacing: 4)) }
        let b = RButton(c.action, small: true) { [weak self] in self?.tryIt?(c) }
        buttons["try-\(c.key)"] = b
        // .ln-txt p { flex: 1 }: the action at the card's foot, the cards of a row as tall as each other.
        let gap = NSView()
        gap.translatesAutoresizingMaskIntoConstraints = false
        gap.setContentHuggingPriority(.init(1), for: .vertical)
        gap.heightAnchor.constraint(greaterThanOrEqualToConstant: 0).isActive = true
        let txt = vstack([hstack(ti, spacing: 8), spaced(wrap(t("learn.\(c.key).line"), Fonts.pt(12.5), "tx2"), 1.5), gap, hstack([b, spring()], spacing: 0)], spacing: 6, insets: NSEdgeInsets(top: 12, left: 13, bottom: 13, right: 13))
        txt.setCustomSpacing(0, after: txt.arrangedSubviews[1])
        let col = vstack([pic, txt], spacing: 0)
        let box = Box(fill: "card", ring: lit == c.key ? "work" : "sheet-ring", radius: 11)
        if lit == c.key { box.ringWidth = 2 }
        box.layer?.masksToBounds = true
        box.translatesAutoresizingMaskIntoConstraints = false
        col.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(col)
        NSLayoutConstraint.activate([col.leadingAnchor.constraint(equalTo: box.leadingAnchor), col.trailingAnchor.constraint(equalTo: box.trailingAnchor), col.topAnchor.constraint(equalTo: box.topAnchor),
                                     col.bottomAnchor.constraint(equalTo: box.bottomAnchor)])
        box.setAccessibilityElement(true)
        box.setAccessibilityRole(.group)
        box.setAccessibilityLabel(t("learn.\(c.key).title"))
        cardViews[c.key] = box
        return box
    }
}

/// A card's still (.ln-s): drawn as in the design (the onboarding round 3),
/// dark in both appearances, with the play mark at its corner.
final class LearnStill: Flipped {
    let key: String
    init(_ key: String) { self.key = key; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError() }

    private func fill(_ r: NSRect, _ c: NSColor, _ radius: CGFloat) { c.setFill(); NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius).fill() }
    private func ring(_ r: NSRect, _ c: NSColor, _ radius: CGFloat, _ w: CGFloat = 1) {
        c.setStroke()
        let p = NSBezierPath(roundedRect: r.insetBy(dx: w / 2, dy: w / 2), xRadius: radius, yRadius: radius)
        p.lineWidth = w
        p.stroke()
    }
    /// .ln-l: a line of text, 4 high, `w` of the width.
    private func line(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ w: CGFloat, _ c: NSColor) { fill(NSRect(x: x, y: y, width: width * w, height: 4), c, 2) }

    override func draw(_ dirty: NSRect) {
        let D = Design.dark
        let bg = D("term-bg"), ln = D("btn"), frame = D("sheet-ring"), or = D("you"), gr = D("ok"), rd = D("bad"), hi = D("tx"), blue = D("work")
        fill(bounds, bg, 0)
        let W = bounds.width, H = bounds.height, p: CGFloat = 10
        switch key {
        case "panes":
            let w = (W - 2 * p - 6) / 2
            for i in 0..<2 {
                let r = NSRect(x: p + CGFloat(i) * (w + 6), y: p, width: w, height: H - 2 * p)
                ring(r, frame, 6)
                let x = r.minX + 8, iw = r.width - 16
                if i == 0 { line(x, r.maxY - 39, iw, 0.6, ln); line(x, r.maxY - 29, iw, 0.8, ln); line(x, r.maxY - 19, iw, 0.4, or) }
                else {
                    let tag = NSAttributedString(string: "Claude", attributes: [.font: Fonts.pt(9, .semibold), .foregroundColor: D("claude")])
                    let ts = tag.size()
                    fill(NSRect(x: x, y: r.minY + 8, width: ts.width + 10, height: ts.height + 2), D("claude-t"), 4)
                    tag.draw(at: NSPoint(x: x + 5, y: r.minY + 9))
                    line(x, r.maxY - 29, iw, 0.5, gr); line(x, r.maxY - 19, iw, 0.7, ln)
                }
            }
        case "needs":
            let side = NSRect(x: p, y: p, width: (W - 2 * p) * 0.3, height: H - 2 * p)
            fill(side, D("amber-t"), 5)
            line(side.minX + 6, side.minY + 9, side.width - 12, 0.3, or); line(side.minX + 6, side.minY + 19, side.width - 12, 0.6, ln); line(side.minX + 6, side.minY + 29, side.width - 12, 0.5, ln)
            let ph = NSRect(x: W - p - 30, y: (H - 56) / 2, width: 30, height: 56)
            let card = NSRect(x: side.maxX + 6, y: p, width: ph.minX - 6 - side.maxX - 6, height: H - 2 * p)
            fill(card, D("sheet"), 5); ring(card, or, 5, 1.5)
            line(card.minX + 6, card.minY + 9, card.width - 12, 0.7, hi)
            for i in 0..<3 { fill(NSRect(x: card.minX + 6, y: card.minY + 22 + CGFloat(i) * 14, width: card.width - 12, height: 9), D("card"), 3) }
            fill(ph, D("sheet"), 7); ring(ph, ln, 7)
            fill(NSRect(x: ph.midX - 8, y: ph.midY - 5, width: 16, height: 10), or, 3)
        case "phone":
            let qr = NSRect(x: W / 2 - 9 - 64 + 2, y: (H - 64) / 2, width: 64, height: 64)
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(roundedRect: qr, xRadius: 6, yRadius: 6).addClip()
            for yy in 0..<8 { for xx in 0..<8 { (((xx + yy) % 2 == 0) ? D("tx") : NSColor(white: 0.82, alpha: 1)).setFill(); NSRect(x: qr.minX + CGFloat(xx) * 8, y: qr.minY + CGFloat(yy) * 8, width: 8, height: 8).fill() } }
            NSGraphicsContext.restoreGraphicsState()
            let ph = NSRect(x: W / 2 + 9 + 2, y: (H - 64) / 2, width: 40, height: 64)
            fill(ph, D("sheet"), 7); ring(ph, ln, 7)
            fill(NSRect(x: ph.midX - 10, y: ph.midY - 8, width: 20, height: 7), or, 3)
            fill(NSRect(x: ph.midX - 10, y: ph.midY + 2, width: 20, height: 7), gr, 3)
        case "pick":
            let w = (W - 2 * p - 12) / 3
            for i in 0..<3 {
                let r = NSRect(x: p + CGFloat(i) * (w + 6), y: p, width: w, height: H - 2 * p)
                NSGraphicsContext.saveGraphicsState()
                NSBezierPath(roundedRect: r, xRadius: 6, yRadius: 6).addClip()
                // The made-up pictures' own colours, as app.css paints them.
                if i == 0 {
                    NSColor(srgbRed: 0xF2 / 255, green: 0xED / 255, blue: 0xE4 / 255, alpha: 1).setFill(); r.fill()
                    let tri = NSBezierPath(); tri.move(to: NSPoint(x: r.maxX, y: r.minY)); tri.line(to: NSPoint(x: r.maxX, y: r.maxY)); tri.line(to: NSPoint(x: r.minX, y: r.maxY)); tri.close()
                    NSColor(srgbRed: 0xE0 / 255, green: 0x5A / 255, blue: 0x33 / 255, alpha: 1).setFill(); tri.fill()
                } else if i == 1 { NSColor(srgbRed: 0x10 / 255, green: 0x20 / 255, blue: 0x3F / 255, alpha: 1).setFill(); r.fill() }
                else {
                    NSColor(srgbRed: 0xE9 / 255, green: 0xEE / 255, blue: 0xF4 / 255, alpha: 1).setFill(); r.fill()
                    Design.light("work").setFill()
                    NSRect(x: r.minX, y: r.minY + r.height * 0.4, width: r.width, height: r.height * 0.6).fill()
                }
                NSGraphicsContext.restoreGraphicsState()
                if i == 1 { ring(r.insetBy(dx: -2, dy: -2), blue, 8, 2) }
            }
        case "review":
            let tag = NSAttributedString(string: "Merge", attributes: [.font: Fonts.pt(9, .semibold), .foregroundColor: NSColor.white])
            let ts = tag.size()
            fill(NSRect(x: W - 10 - ts.width - 10, y: 10, width: ts.width + 10, height: ts.height + 2), blue, 4)
            tag.draw(at: NSPoint(x: W - 10 - ts.width - 5, y: 11))
            let iw = W - 32
            let ys: [(CGFloat, NSColor)] = [(0.8, gr), (0.6, gr), (0.7, ln), (0.5, rd), (0.65, gr)]
            let top = (H - CGFloat(ys.count) * 10) / 2
            for (i, (w, c)) in ys.enumerated() { line(16, top + CGFloat(i) * 10 + 3, iw, w, c) }
        case "film":
            let scrubY = H - p - 7
            let fh = scrubY - 6 - p
            let w = (W - 2 * p - 15) / 4
            for i in 0..<4 {
                let r = NSRect(x: p + CGFloat(i) * (w + 5), y: p, width: w, height: fh)
                fill(r, bg, 5)
                ring(r, i == 1 ? blue : frame, 5, i == 1 ? 2 : 1)
            }
            let sw = W - 2 * p - 26
            fill(NSRect(x: p, y: scrubY, width: sw, height: 3), ln, 1.5)
            fill(NSRect(x: p, y: scrubY, width: sw * 0.4, height: 3), blue, 1.5)
            blue.setFill(); NSBezierPath(ovalIn: NSRect(x: p + sw * 0.4 - 4.5, y: scrubY - 3, width: 9, height: 9)).fill()
        default:
            let iw = W - 36
            let top = (H - 3 * 18 - 2 * 8) / 2
            for i in 0..<3 {
                let r = NSRect(x: 18, y: top + CGFloat(i) * 26, width: iw, height: 18)
                fill(r, D("sheet"), 4)
                blue.setFill(); NSRect(x: r.minX, y: r.minY + 1, width: 2, height: r.height - 2).fill()
            }
        }
        // .ln-play: a dark circle with a white triangle, 10 from the corner.
        let c = NSRect(x: W - 10 - 22, y: H - 10 - 22, width: 22, height: 22)
        NSColor(white: 0, alpha: 0.72).setFill()
        NSBezierPath(ovalIn: c).fill()
        let tri = NSBezierPath()
        tri.move(to: NSPoint(x: c.minX + 9, y: c.minY + 7)); tri.line(to: NSPoint(x: c.minX + 15, y: c.minY + 11)); tri.line(to: NSPoint(x: c.minX + 9, y: c.minY + 15)); tri.close()
        NSColor.white.setFill(); tri.fill()
    }
}
