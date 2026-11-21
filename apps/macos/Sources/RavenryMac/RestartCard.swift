// The card after a restart (SESS-053), in the middle where the tabs would
// be: "N sessions were running before the restart", a row per session
// (its project, topic, assistant and model, how long it ran, what it was
// doing, Resume), the Mid-turn tag and its note, Resume all and Dismiss.
// While they resume each row says Back with Show, Resuming... or Next.
//
// The hub decides all of it and sends the words (state.restart, from
// hub/server/restart.mjs cardView); this view draws them and reports the
// person's clicks. Board shows it at the top of Start (StartView.restart).

import AppKit

/// The restart symbol: an arrow coming round (the mockup's path, 16 x 16).
final class RestartGlyph: NSView {
    var tint = "work" { didSet { needsDisplay = true } }
    private let side: CGFloat
    init(size: CGFloat = 16) {
        side = size
        super.init(frame: NSRect(x: 0, y: 0, width: size, height: size))
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: size).isActive = true
        heightAnchor.constraint(equalToConstant: size).isActive = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func draw(_ r: NSRect) {
        let k = side / 16
        let pt = { (x: CGFloat, y: CGFloat) in NSPoint(x: x * k, y: y * k) }
        let c = Design.color(tint)
        // "M13 8a5 5 0 1 1-1.6-3.7": most of a circle round (8, 8), from its right, ending up and to the right.
        let p = NSBezierPath()
        let start = atan2(8.0 - 8.0, 13.0 - 8.0) * 180 / .pi
        let end = atan2(4.3 - 8.0, 11.4 - 8.0) * 180 / .pi
        p.appendArc(withCenter: pt(8, 8), radius: 5 * k, startAngle: start, endAngle: end + 360, clockwise: false)
        // "M11.6 1.8v2.9H8.7": its head.
        p.move(to: pt(11.6, 1.8)); p.line(to: pt(11.6, 4.7)); p.line(to: pt(8.7, 4.7))
        p.lineWidth = 1.6 * k; p.lineCapStyle = .round; p.lineJoinStyle = .round
        c.setStroke(); p.stroke()
    }
    override func viewDidChangeEffectiveAppearance() { needsDisplay = true }
}

/// An "i" in a ring, for the mid-turn note.
final class InfoGlyph: NSView {
    init(size: CGFloat = 14) {
        super.init(frame: NSRect(x: 0, y: 0, width: size, height: size))
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: size).isActive = true
        heightAnchor.constraint(equalToConstant: size).isActive = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isFlipped: Bool { true }
    override func draw(_ r: NSRect) {
        let s = bounds.width, c = Design.color("work")
        let ring = NSBezierPath(ovalIn: bounds.insetBy(dx: 0.8, dy: 0.8))
        ring.lineWidth = 1.3
        c.setStroke(); ring.stroke()
        let stem = NSBezierPath()
        stem.move(to: NSPoint(x: s / 2, y: s * 0.45)); stem.line(to: NSPoint(x: s / 2, y: s * 0.74))
        stem.lineWidth = 1.4; stem.lineCapStyle = .round; stem.stroke()
        c.setFill(); NSBezierPath(ovalIn: NSRect(x: s / 2 - 0.85, y: s * 0.26, width: 1.7, height: 1.7)).fill()
    }
    override func viewDidChangeEffectiveAppearance() { needsDisplay = true }
}

final class RestartCard: Box {
    /// Resume one (its session id), or all (nil).
    var onResume: ((String?) -> Void)?
    var onDismiss: (() -> Void)?
    /// Show a session that is back (its row): its tab in front.
    var onShow: (([String: Any]) -> Void)?
    /// What it draws, as the hub sent it.
    private(set) var card: [String: Any] = [:]
    /// The controls by name, for the self-test: "all", "dismiss", "resume:<id>", "show:<id>".
    private(set) var controls: [String: NSView] = [:]
    /// Each row's state as drawn ("waiting", "resuming", "next", "back", "failed"), in order, for the self-test.
    private(set) var drawnStates: [String] = []
    private let body = Flipped()
    private var drawnKey = ""

    init() {
        super.init(fill: "card", ring: "sep", radius: 12)
        ringLightOnly = true
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(t("restart.a11y"))
        body.translatesAutoresizingMaskIntoConstraints = false
        addSubview(body)
        NSLayoutConstraint.activate([body.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 18), body.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -18),
                                     body.topAnchor.constraint(equalTo: topAnchor, constant: 16), body.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14)])
    }
    required init?(coder: NSCoder) { fatalError() }

    private func s(_ k: String) -> String { card[k] as? String ?? "" }
    var rows: [[String: Any]] { card["rows"] as? [[String: Any]] ?? [] }

    /// The hub's card; drawn again only when what it says changed.
    func set(_ c: [String: Any]) {
        let key = (try? JSONSerialization.data(withJSONObject: c, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) } ?? ""
        card = c
        if key == drawnKey { return }
        drawnKey = key
        build()
    }

    private func build() {
        controls = [:]
        for v in body.subviews { v.removeFromSuperview() }
        // The head: the symbol on its tint, the title and what happened.
        let ic = Box(fill: "work-t", radius: 8)
        ic.translatesAutoresizingMaskIntoConstraints = false
        let g = RestartGlyph(size: 16)
        ic.addSubview(g)
        NSLayoutConstraint.activate([ic.widthAnchor.constraint(equalToConstant: 28), ic.heightAnchor.constraint(equalToConstant: 28),
                                     g.centerXAnchor.constraint(equalTo: ic.centerXAnchor), g.centerYAnchor.constraint(equalTo: ic.centerYAnchor)])
        let title = wrap(s("title"), Fonts.pt(15, Fonts.w650), "tx")
        let sub = spaced(wrap(s("body"), Fonts.pt(12.5), "tx2"), 1.3)
        let words = vstack([title, sub], spacing: 3)
        let head = NSStackView(views: [ic, words])
        head.orientation = .horizontal
        head.alignment = .top
        head.spacing = 10
        head.translatesAutoresizingMaskIntoConstraints = false

        // The rows, under the title (38 in, past the symbol).
        var items: [NSView] = []
        drawnStates = []
        for (i, r) in rows.enumerated() {
            if i > 0 { items.append(rule()) }
            items.append(row(r))
        }
        // The foot: Resume all, Dismiss and what Dismiss does.
        let busy = card["resumeAllBusy"] as? Bool ?? false
        let all = RButton(s("resumeAll"), .primary) { [weak self] in self?.onResume?(nil) }
        all.isEnabled = !busy
        all.setAccessibilityLabel(s("resumeAll"))
        controls["all"] = all
        let dismiss = RButton(s("dismiss"), .normal) { [weak self] in self?.onDismiss?() }
        controls["dismiss"] = dismiss
        let note = spaced(wrap(s("dismissNote"), Fonts.pt(11.5), "tx3"), 1.3)
        let foot = NSStackView(views: [all, dismiss, note])
        foot.orientation = .horizontal
        foot.alignment = .centerY
        foot.spacing = 8
        foot.setCustomSpacing(14, after: dismiss)
        foot.translatesAutoresizingMaskIntoConstraints = false
        let footWrap = vstack([rule(), gap(10), foot], spacing: 0)
        let list = vstack(items + [footWrap], spacing: 0, insets: NSEdgeInsets(top: 6, left: 38, bottom: 0, right: 0))
        let all2 = vstack([head, list], spacing: 4)
        body.addSubview(all2)
        NSLayoutConstraint.activate([all2.leadingAnchor.constraint(equalTo: body.leadingAnchor), all2.trailingAnchor.constraint(equalTo: body.trailingAnchor),
                                     all2.topAnchor.constraint(equalTo: body.topAnchor), all2.bottomAnchor.constraint(equalTo: body.bottomAnchor)])
        needsLayout = true
    }

    /// One session: project, topic and the Mid-turn tag, its state or Resume at the right;
    /// its chip, how long it ran and what it was doing under them; the mid-turn note while it waits.
    private func row(_ r: [String: Any]) -> NSView {
        let sid = r["sessionId"] as? String ?? ""
        let state = r["state"] as? String ?? "waiting"
        drawnStates.append(state)
        let dim = state == "next"
        let project = fixedLabel(r["project"] as? String ?? "", Fonts.pt(13.5, Fonts.w650), "tx")
        let topic = yields(label(r["topic"] as? String ?? "", Fonts.pt(13.5), "tx2"), fill: false)
        if dim { project.alphaValue = 0.75; topic.alphaValue = 0.75 }
        var lineA: [NSView?] = [project, topic]
        if r["midTurn"] as? Bool == true, let tag = r["midTurnTag"] as? String {
            lineA.append(boxed(fixedLabel(tag, Fonts.pt(11, Fonts.w650), "work"), fill: "work-t", radius: 5, insets: NSEdgeInsets(top: 1, left: 6, bottom: 1, right: 6)))
        }
        lineA.append(spring())
        lineA.append(right(r, sid: sid, state: state))
        let a = hstack(lineA, spacing: 8)
        a.setCustomSpacing(10, after: project)
        var lineB: [NSView?] = [assistantChip(r["chip"] as? String ?? "")]
        if let ran = r["ran"] as? String { lineB.append(fixedLabel(ran, Fonts.pt(12), "tx3")) }
        if let doing = r["doing"] as? String, !doing.isEmpty {
            lineB.append(fixedLabel("\u{00B7}", Fonts.pt(12), "tx3"))
            lineB.append(yields(label(doing, Fonts.pt(12), "tx3")))
        } else { lineB.append(spring()) }
        let b = hstack(lineB, spacing: 8)
        var col: [NSView] = [a, b]
        if let e = r["error"] as? String, state == "failed" { col.append(wrap(e, Fonts.pt(12), "bad")) }
        if r["midTurn"] as? Bool == true, state != "back", let n = r["midTurnNote"] as? String {
            let inner = NSStackView(views: [InfoGlyph(size: 14), spaced(wrap(n, Fonts.pt(12), "tx2"), 1.3)])
            inner.orientation = .horizontal
            inner.alignment = .top
            inner.spacing = 8
            col.append(boxed(inner, fill: "card2", radius: 8, insets: NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10)))
        }
        let v = vstack(col, spacing: 6, insets: NSEdgeInsets(top: 10, left: 0, bottom: 10, right: 0))
        v.setCustomSpacing(4, after: a)
        if col.count > 2 { v.setCustomSpacing(8, after: b) }
        return v
    }

    /// What the row's right side says: Resume, Resuming..., Next, or Back with Show.
    private func right(_ r: [String: Any], sid: String, state: String) -> NSView {
        let word = r["stateWord"] as? String ?? ""
        switch state {
        case "resuming":
            let spin = NSProgressIndicator()
            spin.style = .spinning
            spin.controlSize = .small
            spin.isIndeterminate = true
            spin.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([spin.widthAnchor.constraint(equalToConstant: 14), spin.heightAnchor.constraint(equalToConstant: 14)])
            spin.startAnimation(nil)
            return hstack([spin, fixedLabel(word, Fonts.pt(12.5), "tx2")], spacing: 6)
        case "next":
            return fixedLabel(word, Fonts.pt(12.5), "tx3")
        case "back":
            let show = RButton(s("show"), .link) { [weak self] in self?.onShow?(r) }
            show.titleSize = 12.5
            show.setAccessibilityLabel(t("restart.showA11y", ["project": r["project"] as? String ?? ""]))
            controls["show:\(sid)"] = show
            return hstack([Icon("check-c", "ok", size: 14), fixedLabel(word, Fonts.pt(12.5), "ok"), show], spacing: 6)
        default:
            let b = RButton(s("resume"), .normal, small: true) { [weak self] in self?.onResume?(sid) }
            b.setAccessibilityLabel(t("restart.resumeA11y", ["project": r["project"] as? String ?? ""]))
            controls["resume:\(sid)"] = b
            return b
        }
    }

    private func rule() -> NSView {
        let b = Box(fill: "sep")
        b.translatesAutoresizingMaskIntoConstraints = false
        b.heightAnchor.constraint(equalToConstant: 1).isActive = true
        return b
    }
    private func gap(_ h: CGFloat) -> NSView {
        let v = NSView()
        v.translatesAutoresizingMaskIntoConstraints = false
        v.heightAnchor.constraint(equalToConstant: h).isActive = true
        return v
    }
}
