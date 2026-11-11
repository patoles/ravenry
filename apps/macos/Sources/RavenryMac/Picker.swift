// A pick, side by side, in the middle beside the panel (the Electron app's
// picker.ts, phase2.css .pk-h, .pk-row, .pv, .pk-f): every picture at once
// with its letter and label, Pick A (or 1 to 4), Circle a part (drag a ring
// on the picture, then say what you want there: the note is pinned to the
// ring), anything else for the agent, None of these, and Send B, with 1
// note. The answer is { pick: { label, region (fractions of the picture),
// note } }, or { decline, reason } (PROTOCOL.md section 4, pick), posted as
// the panel posts its answers. The pictures are the hub's kept copies (GET
// /api/checkpoints/<id>/variants/<n>).

import AppKit

/// One picture of the pick: drawn as `object-fit: cover`, a ring dragged on it while circling.
final class PickImage: NSView {
    var image: NSImage? { didSet { needsDisplay = true } }
    var picked = false { didSet { needsDisplay = true } }
    var drawing = false { didSet { window?.invalidateCursorRects(for: self) } }
    /// The ring, in fractions of the picture (x, y, w, h from the top left).
    var region: NSRect? { didSet { needsDisplay = true } }
    var empty = ""
    var letter = ""
    var onRing: ((NSRect) -> Void)?
    var onClick: (() -> Void)?
    private var start: NSPoint?
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func resetCursorRects() { if drawing { for r in uncovered(bounds) { addCursorRect(r, cursor: .crosshair) } } }
    override func draw(_ r: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let path = NSBezierPath(roundedRect: bounds, xRadius: 9, yRadius: 9)
            NSGraphicsContext.saveGraphicsState()
            path.addClip()
            Design.color("card2").setFill()
            bounds.fill()
            if let img = image, img.size.width > 0 {
                let k = max(bounds.width / img.size.width, bounds.height / img.size.height)
                let w = img.size.width * k, h = img.size.height * k
                img.draw(in: NSRect(x: (bounds.width - w) / 2, y: (bounds.height - h) / 2, width: w, height: h), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            } else if !empty.isEmpty {
                let a: [NSAttributedString.Key: Any] = [.font: Fonts.pt(13), .foregroundColor: Design.color("tx3")]
                (empty as NSString).draw(at: NSPoint(x: 20, y: 20), withAttributes: a)
            }
            // The letter, top left (.pv-img .plab).
            let lr = NSRect(x: 10, y: 10, width: 22, height: 22)
            NSColor(srgbRed: 20 / 255, green: 20 / 255, blue: 22 / 255, alpha: 0.82).setFill()
            NSBezierPath(roundedRect: lr, xRadius: 5, yRadius: 5).fill()
            let la: [NSAttributedString.Key: Any] = [.font: Fonts.pt(12, .bold), .foregroundColor: NSColor.white]
            let ls = (letter as NSString).size(withAttributes: la)
            (letter as NSString).draw(at: NSPoint(x: lr.midX - ls.width / 2, y: lr.midY - ls.height / 2), withAttributes: la)
            if let g = region {
                let rr = NSRect(x: g.minX * bounds.width, y: g.minY * bounds.height, width: g.width * bounds.width, height: g.height * bounds.height)
                let ring = NSBezierPath(ovalIn: rr.insetBy(dx: 1.25, dy: 1.25))
                ring.lineWidth = 2.5
                Design.color("you").setStroke()
                ring.stroke()
            }
            NSGraphicsContext.restoreGraphicsState()
            let edge = NSBezierPath(roundedRect: bounds.insetBy(dx: picked ? 1.25 : 0.5, dy: picked ? 1.25 : 0.5), xRadius: 9, yRadius: 9)
            edge.lineWidth = picked ? 2.5 : 1
            Design.color(picked ? "work" : "sep").setStroke()
            edge.stroke()
        }
    }
    private func frac(_ e: NSEvent) -> NSPoint {
        let p = convert(e.locationInWindow, from: nil)
        return NSPoint(x: min(1, max(0, p.x / max(1, bounds.width))), y: min(1, max(0, p.y / max(1, bounds.height))))
    }
    private func rect(_ a: NSPoint, _ b: NSPoint) -> NSRect { NSRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y)) }
    override func mouseDown(with e: NSEvent) {
        guard drawing else { onClick?(); return }
        start = frac(e)
    }
    override func mouseDragged(with e: NSEvent) {
        guard drawing, let s = start else { return }
        region = rect(s, frac(e))
    }
    override func mouseUp(with e: NSEvent) {
        guard drawing, let s = start else { return }
        start = nil
        let r = rect(s, frac(e))
        if r.width < 0.02 || r.height < 0.02 { region = nil; return }
        onRing?(r)
    }
}

final class PickerView: Box, BackLinked {
    private(set) var id: String?
    /// Where it was opened from, as the head's "‹ Paper-boat" (Board.showMiddle sets it).
    var backLink: (name: String, run: () -> Void)? {
        didSet { if oldValue?.name != backLink?.name, cp["id"] != nil { draw() } }
    }
    private var cp: [String: Any] = [:]
    var hub: HubClient?
    var answer: ((String, [String: Any], @escaping (Bool, String?) -> Void) -> Void)?
    var onClose: (() -> Void)?
    /// A hint's Learn more: Learn Ravenry at that card.
    var onLearn: ((String) -> Void)?
    /// "Tilting the hull, paper-boat": the asking session and its project.
    var whereOf: (([String: Any]) -> String?)?
    private(set) var picked: Int?
    private(set) var circling = false
    private(set) var region: NSRect?
    private(set) var pin = ""
    private var editingPin = false
    private(set) var busy = false
    private(set) var error: String?
    /// What the self-test presses.
    private(set) var buttons: [String: RButton] = [:]
    private(set) var images: [PickImage] = []
    let extra = NSTextField(string: "")
    private let pinField = NSTextField(string: "")
    /// The pick's head and pictures (the self-test reads where they are).
    let scroll = StackScroll(spacing: 0, insets: NSEdgeInsetsZero)
    private let foot = Box(fill: nil)
    private var pictures: [Int: NSImage] = [:]
    /// The head's least top room: the system's soft edge (8 pt) under the title bar's band falls in it, never on the words.
    static let edgeRoom: CGFloat = 10
    /// How much of the picker's top the window's title bar covers (layout()).
    private(set) var titleBand: CGFloat = 0

    init() {
        super.init(fill: "sheet")
        addSubview(scroll)
        addSubview(foot)
        scroll.automaticallyAdjustsContentInsets = false
        for f in [extra, pinField] {
            f.isBordered = false
            f.drawsBackground = false
            f.focusRingType = .none
            f.font = Fonts.pt(12.5)
            f.cell?.isScrollable = true
            f.delegate = self
        }
        pinField.font = Fonts.pt(12)
        pinField.textColor = NSColor(srgbRed: 0xF2 / 255, green: 0xF2 / 255, blue: 0xF4 / 255, alpha: 1)
        pinField.placeholderAttributedString = NSAttributedString(string: t("pick.whatHere"), attributes: [.font: Fonts.pt(12), .foregroundColor: NSColor(white: 0.6, alpha: 1)])
        setAccessibilityRole(.group)
        setAccessibilityLabel(t("pick.tab"))
    }
    required init?(coder: NSCoder) { fatalError() }

    override var acceptsFirstResponder: Bool { true }

    /// Shows a pick (the same one keeps what was picked and typed).
    func show(_ cp: [String: Any]) {
        let cid = cp["id"] as? String
        if cid != id {
            id = cid; picked = nil; circling = false; region = nil; pin = ""; editingPin = false; busy = false; error = nil
            extra.stringValue = ""; pictures = [:]
            let n = (cp["variants"] as? [Any] ?? []).count
            for i in 0..<n {
                hub?.data("/api/checkpoints/\(cid ?? "")/variants/\(i)") { [weak self] d in
                    guard let self, self.id == cid, let img = d.flatMap(NSImage.init(data:)) else { return }
                    self.pictures[i] = img
                    if i < self.images.count { self.images[i].image = img }
                }
            }
        }
        self.cp = cp
        draw()
    }

    /// The board moved on: its words and state, kept while the same pick shows.
    func refresh(_ st: HubState?) {
        guard let cid = id, let c = st?.checkpoints.first(where: { $0["id"] as? String == cid }) else { return }
        if (c["state"] as? String) != (cp["state"] as? String) { cp = c; draw() } else { cp = c }
    }

    private var words: [String: Any] { cp["words"] as? [String: Any] ?? [:] }
    private var open: Bool { (cp["state"] as? String) == "open" }
    private func letter(_ n: Int) -> String {
        let v = words["variants"] as? [[String: Any]] ?? []
        return n < v.count ? v[n]["letter"] as? String ?? "\(n + 1)" : "\(n + 1)"
    }

    override func layout() {
        super.layout()
        let fh: CGFloat = 57
        foot.frame = NSRect(x: 0, y: bounds.height - fh, width: bounds.width, height: fh)
        // The scroll starts under the title bar's band, never in it: a scroll
        // view in it gets the system's scroll edge effect (a blur band over
        // the pick's head, which also drew the whole scroll blank in a
        // cached drawing). The head's own top room is what the band takes.
        var band: CGFloat = 0
        if window != nil { band = max(0, min(bounds.height, safeAreaInsets.top)) }
        scroll.frame = NSRect(x: 0, y: band, width: bounds.width, height: max(0, bounds.height - fh - band))
        if abs(band - titleBand) > 0.5 { titleBand = band; if cp["id"] != nil { DispatchQueue.main.async { [weak self] in self?.draw() } } }
    }

    func draw() {
        buttons = [:]
        images = []
        let w = words
        let vs = cp["variants"] as? [[String: Any]] ?? []
        var where_: String? = whereOf?(cp)
        if where_ == nil { where_ = cp["project"] as? String }
        // .pk-h: the kind, the question, its body, how long it waits, Close.
        let kindRow = hstack([Icon("pick", "you", size: 14), label(w["heading"] as? String ?? "", Fonts.pt(12, .bold), "you"), where_.map { label($0, Fonts.pt(12), "tx3") }], spacing: 7)
        let title = label(md: w["head"] as? String ?? "", Fonts.pt(20, .bold), "tx", lines: 0)
        title.preferredMaxLayoutWidth = 700
        var tt: [NSView?] = [kindRow, title]
        if let b = w["body"] as? String { let l = label(b, Fonts.pt(13), "tx2", lines: 0); l.preferredMaxLayoutWidth = 700; tt.append(l) }
        let tcol = vstack(tt, spacing: 4)
        tcol.setContentHuggingPriority(.init(1), for: .horizontal)
        let close = RButton(t("pick.closeTip"), .icon, small: true, icon: "close") { [weak self] in self?.onClose?() }
        buttons["close"] = close
        // Where it was opened from ("‹ Paper-boat"), at the head's left; Close goes back there too.
        let back = backLink.map { l -> RButton in let b = backButton(l.name, l.run); buttons["back"] = b; return b }
        let head = hstack([back, tcol, spring(), label(cpWaiting(cp), Fonts.pt(12).withTabularDigits, "tx3"), close], spacing: 10, insets: NSEdgeInsets(top: max(Self.edgeRoom, 16 - titleBand), left: 22, bottom: 10, right: 22))
        head.alignment = .top
        // .pk-row: the pictures in up to three columns.
        let cols = max(1, min(vs.count, 3))
        var cells: [NSView] = []
        let says = w["variants"] as? [[String: Any]] ?? []
        for (n, v) in vs.enumerated() {
            let on = picked == n
            let img = PickImage()
            img.letter = letter(n)
            img.picked = on
            img.drawing = circling
            img.image = pictures[n]
            img.empty = (v["type"] as? String) == "html" ? t("pick.htmlPage") : pictures[n] == nil ? "" : ""
            if on { img.region = region }
            img.onRing = { [weak self] r in self?.ringed(n, r) }
            img.translatesAutoresizingMaskIntoConstraints = false
            img.heightAnchor.constraint(equalTo: img.widthAnchor, multiplier: 10.0 / 16).isActive = true
            images.append(img)
            var imgBox: NSView = img
            if on, region != nil, editingPin || !pin.trimmingCharacters(in: .whitespaces).isEmpty {
                imgBox = withPin(img, region!)
            }
            let nameRow = hstack([label(v["label"] as? String ?? "", Fonts.pt(13.5, Fonts.w650)), spring(), on ? pill(t("pick.yourPick"), "work") : nil], spacing: 8)
            var col: [NSView?] = [imgBox, nameRow]
            if n < says.count, let s = says[n]["says"] as? String { let l = label(s, Fonts.pt(12.5), "tx2", lines: 0); l.preferredMaxLayoutWidth = 300; col.append(l) }
            let b: RButton
            if on {
                b = RButton(t("pick.picked"), .primary, small: true)
                b.lead = "check-c"
            } else {
                b = RButton(t("pick.pickLetter", ["letter": letter(n)]), small: true) { [weak self] in self?.pickN(n) }
            }
            b.isEnabled = open
            b.refusesFirstResponder = true
            buttons["pick\(n + 1)"] = b
            let kb = boxed(label("\(n + 1)", Fonts.pt(10.5, Fonts.w650), "tx3"), fill: nil, ring: "sep", radius: 4, insets: NSEdgeInsets(top: 1, left: 5, bottom: 1, right: 5))
            col.append(hstack([b, kb, spring()], spacing: 8))
            cells.append(vstack(col, spacing: 8))
        }
        var rows: [NSView] = []
        var i = 0
        while i < cells.count {
            var r = Array(cells[i..<min(i + cols, cells.count)])
            while r.count < cols { r.append(NSView()) }
            let s = NSStackView(views: r)
            s.orientation = .horizontal
            s.distribution = .fillEqually
            s.alignment = .top
            s.spacing = 14
            rows.append(s)
            i += cols
        }
        let grid = vstack(rows, spacing: 14, insets: NSEdgeInsets(top: 6, left: 22, bottom: 16, right: 22))
        var all: [NSView] = [head]
        // The first pick: under its title, room made for it (the pick hint).
        if open, Hints.shared.wants("pick") {
            let h = hintView("pick", bold: t("hint.pickB"), text: t("hint.pick"), width: min(560, max(220, bounds.width - 44))) { [weak self] k in self?.onLearn?(k) }
            let wrapH = Flipped()
            wrapH.translatesAutoresizingMaskIntoConstraints = false
            h.translatesAutoresizingMaskIntoConstraints = false
            wrapH.addSubview(h)
            NSLayoutConstraint.activate([h.leadingAnchor.constraint(equalTo: wrapH.leadingAnchor, constant: 22), h.topAnchor.constraint(equalTo: wrapH.topAnchor),
                                         h.bottomAnchor.constraint(equalTo: wrapH.bottomAnchor, constant: -8), h.widthAnchor.constraint(lessThanOrEqualToConstant: 560),
                                         h.trailingAnchor.constraint(lessThanOrEqualTo: wrapH.trailingAnchor, constant: -22)])
            all.append(wrapH)
        } else { Hints.shared.gone("pick") }
        all.append(grid)
        if let e = error { all.append(vstack([label(e, Fonts.pt(12), "bad", lines: 0)], spacing: 0, insets: NSEdgeInsets(top: 0, left: 22, bottom: 0, right: 22))) }
        scroll.set(all)
        drawFoot()
        if editingPin { DispatchQueue.main.async { [weak self] in self.map { $0.window?.makeFirstResponder($0.pinField) } } }
    }

    /// The ring's note, pinned beside it (.note-pin): a field while typed, else its words.
    private func withPin(_ img: PickImage, _ r: NSRect) -> NSView {
        let wrap = Flipped()
        wrap.translatesAutoresizingMaskIntoConstraints = false
        wrap.addSubview(img)
        NSLayoutConstraint.activate([img.leadingAnchor.constraint(equalTo: wrap.leadingAnchor), img.trailingAnchor.constraint(equalTo: wrap.trailingAnchor),
                                     img.topAnchor.constraint(equalTo: wrap.topAnchor), img.bottomAnchor.constraint(equalTo: wrap.bottomAnchor)])
        let dot = boxed(label("1", Fonts.pt(10.5, .bold), "", lines: 1), fill: "you", radius: 8.5, insets: NSEdgeInsets(top: 1, left: 5, bottom: 1, right: 5))
        (dot.subviews.first as? NSTextField)?.textColor = NSColor(srgbRed: 0x1D / 255, green: 0x1D / 255, blue: 0x1F / 255, alpha: 1)
        let content: NSView
        if editingPin {
            pinField.stringValue = pin
            pinField.translatesAutoresizingMaskIntoConstraints = false
            pinField.widthAnchor.constraint(equalToConstant: 150).isActive = true
            content = pinField
        } else {
            let l = label(pin, Fonts.pt(12), "", lines: 0)
            l.textColor = NSColor(srgbRed: 0xF2 / 255, green: 0xF2 / 255, blue: 0xF4 / 255, alpha: 1)
            l.preferredMaxLayoutWidth = 130
            content = l
        }
        let note = boxed(hstack([dot, content], spacing: 8), fill: nil, radius: 8, insets: NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10))
        note.rawFill = NSColor(srgbRed: 20 / 255, green: 20 / 255, blue: 22 / 255, alpha: 0.9)
        (note.subviews.first as? NSStackView)?.alignment = .top
        wrap.addSubview(note)
        let right = r.maxX + 0.02 > 0.62
        // Beside the ring, on the side with room, a little above its top.
        NSLayoutConstraint.activate([
            note.topAnchor.constraint(equalTo: wrap.topAnchor, constant: 0),
            note.widthAnchor.constraint(lessThanOrEqualToConstant: 170),
        ])
        wrap.postsFrameChangedNotifications = true
        let place = { [weak wrap, weak note] in
            guard let wrap, let note else { return }
            let W = wrap.bounds.width, H = wrap.bounds.height
            let s = note.fittingSize
            let y = max(0.02 * H, r.minY * H - 0.06 * H)
            let x = right ? W * (r.minX - 0.02) - s.width : W * min(r.maxX + 0.02, 0.98)
            note.translatesAutoresizingMaskIntoConstraints = true
            note.frame = NSRect(x: max(4, min(x, W - s.width - 4)), y: y, width: s.width, height: s.height)
        }
        NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: wrap, queue: .main) { _ in place() }
        DispatchQueue.main.async { place() }
        note.setAccessibilityLabel(pin)
        return wrap
    }

    private func notes() -> Int { region != nil && !pin.trimmingCharacters(in: .whitespaces).isEmpty ? 1 : 0 }

    /// The bar at the bottom (.pk-f): Circle a part, anything else, None of these, Send.
    private func drawFoot() {
        foot.subviews.forEach { $0.removeFromSuperview() }
        let line = Box(fill: "sep")
        line.frame = NSRect(x: 0, y: 0, width: 4000, height: 1)
        foot.addSubview(line)
        let circ = RButton(circling ? t("pick.drag") : t("pick.circle"), .normal, small: true) { [weak self] in self?.toggleCircle() }
        circ.lead = "circle"
        circ.titleColor = "you"
        circ.toolTip = t("pick.circleTip")
        circ.isEnabled = open
        circ.on = circling
        circ.refusesFirstResponder = true
        buttons["circle"] = circ
        let ring = Box(fill: circling ? "amber-t" : nil, ring: "you", radius: 7)
        ring.ringWidth = 1.5
        ring.translatesAutoresizingMaskIntoConstraints = false
        ring.addSubview(circ)
        circ.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([circ.leadingAnchor.constraint(equalTo: ring.leadingAnchor, constant: 2), circ.trailingAnchor.constraint(equalTo: ring.trailingAnchor, constant: -2),
                                     circ.topAnchor.constraint(equalTo: ring.topAnchor), circ.bottomAnchor.constraint(equalTo: ring.bottomAnchor)])
        let who = words["who"] as? String ?? ""
        extra.placeholderAttributedString = NSAttributedString(string: t("pick.anythingElse", ["who": who]), attributes: [.font: Fonts.pt(12.5), .foregroundColor: Design.color("tx3")])
        extra.setAccessibilityLabel(t("pick.anythingElse", ["who": who]))
        extra.textColor = Design.color("tx")
        let fbox = Box(fill: "input", ring: "sep", radius: 7)
        fbox.translatesAutoresizingMaskIntoConstraints = false
        extra.translatesAutoresizingMaskIntoConstraints = false
        extra.removeFromSuperview()
        fbox.addSubview(extra)
        NSLayoutConstraint.activate([fbox.heightAnchor.constraint(equalToConstant: 32), extra.leadingAnchor.constraint(equalTo: fbox.leadingAnchor, constant: 10),
                                     extra.trailingAnchor.constraint(equalTo: fbox.trailingAnchor, constant: -10), extra.centerYAnchor.constraint(equalTo: fbox.centerYAnchor)])
        fbox.setContentHuggingPriority(.init(1), for: .horizontal)
        let none = RButton(t("pick.none"), .ghost, small: false) { [weak self] in self?.send(decline: true) }
        none.isEnabled = open && !busy
        buttons["none"] = none
        let n = notes()
        let send = RButton(picked.map { notes() > 0 ? t("pick.sendNote", ["letter": letter($0), "n": "\(n)"]) : t("pick.send", ["letter": letter($0)]) } ?? t("pick.pickFirst"), .primary) { [weak self] in self?.send() }
        send.isEnabled = open && !busy && picked != nil
        buttons["send"] = send
        for b in [none, send] { b.refusesFirstResponder = true }
        let row = hstack([ring, fbox, none, send], spacing: 10, insets: NSEdgeInsets(top: 0, left: 22, bottom: 0, right: 22))
        row.alignment = .centerY
        row.translatesAutoresizingMaskIntoConstraints = true
        row.frame = NSRect(x: 0, y: 1, width: foot.bounds.width, height: 56)
        row.autoresizingMask = [.width]
        foot.addSubview(row)
    }

    func pickN(_ n: Int) {
        guard open else { return }
        if picked != n { region = nil; pin = "" }
        picked = n
        draw()
    }

    func toggleCircle() { circling.toggle(); draw() }

    /// A ring dragged on picture n: it is picked, and its note is asked for.
    private func ringed(_ n: Int, _ r: NSRect) {
        if picked != n { pin = "" }
        picked = n
        region = round(r)
        circling = false
        editingPin = true
        draw()
    }

    /// For the self-test and pictures: a ring and its note, as a drag would leave them.
    func circle(_ n: Int, _ r: NSRect, note: String) {
        picked = n; region = round(r); pin = note; editingPin = false; circling = false
        draw()
    }

    private func round(_ r: NSRect) -> NSRect {
        let f = { (x: CGFloat) in (x * 10000).rounded() / 10000 }
        return NSRect(x: f(r.minX), y: f(r.minY), width: f(r.width), height: f(r.height))
    }

    func send(decline: Bool = false) {
        guard !busy, let cid = id else { return }
        if !decline && picked == nil { return }
        let more = extra.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        var reply: [String: Any]
        if decline {
            reply = ["decline": true]
            if !more.isEmpty { reply["reason"] = String(more.prefix(1000)) }
        } else {
            let vs = cp["variants"] as? [[String: Any]] ?? []
            var p: [String: Any] = ["label": vs[picked!]["label"] as? String ?? ""]
            // Four decimals, written as such (0.3, not 0.29999999999999999).
            let dec = { (x: CGFloat) in NSDecimalNumber(string: String(format: "%.4f", Double(x))) }
            if let r = region { p["region"] = ["x": dec(r.minX), "y": dec(r.minY), "w": dec(r.width), "h": dec(r.height)] }
            let note = [region != nil ? pin.trimmingCharacters(in: .whitespaces) : "", more].filter { !$0.isEmpty }.joined(separator: "\n\n")
            if !note.isEmpty { p["note"] = String(note.prefix(4000)) }
            reply = ["pick": p]
        }
        busy = true; error = nil
        drawFoot()
        answer?(cid, reply) { [weak self] ok, why in
            guard let self, self.id == cid else { return }
            self.busy = false
            if ok { self.onClose?() } else { self.error = why; self.draw() }
        }
    }

    /// A number key picks that picture; Esc closes (picker.ts key).
    override func keyDown(with e: NSEvent) {
        if !e.modifierFlags.intersection([.command, .control, .option]).isEmpty { super.keyDown(with: e); return }
        if e.keyCode == 53 { onClose?(); return }
        if let n = Int(e.charactersIgnoringModifiers ?? ""), n >= 1, n <= (cp["variants"] as? [Any] ?? []).count { pickN(n - 1); return }
        super.keyDown(with: e)
    }
    override func mouseDown(with e: NSEvent) { window?.makeFirstResponder(self) }
}

extension PickerView: NSTextFieldDelegate {
    func controlTextDidChange(_ n: Notification) {
        if (n.object as? NSTextField) === pinField { pin = pinField.stringValue; drawFoot() }
    }
    func controlTextDidEndEditing(_ n: Notification) {
        if (n.object as? NSTextField) === pinField, editingPin { editingPin = false; draw() }
    }
    func control(_ c: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
        if c === pinField, sel == #selector(NSResponder.insertNewline(_:)) || sel == #selector(NSResponder.cancelOperation(_:)) {
            editingPin = false; window?.makeFirstResponder(self); draw(); return true
        }
        if c === extra, sel == #selector(NSResponder.insertNewline(_:)), picked != nil { send(); return true }
        return false
    }
}
