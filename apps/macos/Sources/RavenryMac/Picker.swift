// A pick, side by side, in the middle beside the panel (the Electron app's
// picker.ts, phase2.css .pk-h, .pk-row, .pv, .pk-f): every picture at once,
// whole (never cropped), with its letter and label, Pick A (or 1 to 4),
// Circle a part (drag a ring on the picture, then say what you want there:
// the note is pinned to the ring), anything else for the agent, None of
// these, and Send B, with 1 note. The answer is { pick: { label, region
// (fractions of the whole picture), note } }, or { decline, reason }
// (PROTOCOL.md section 4, pick), posted as the panel posts its answers. The
// pictures are the hub's kept copies (GET /api/checkpoints/<id>/variants/<n>).
//
// A click on a picture (here or on the panel's card) opens it up close in
// the picker's place (the pickzoom round, 2026-11-15): the gallery's
// ZoomView ("‹ All 4" back to side by side), zoomed by a click, a pinch,
// Ctrl and the wheel, + and - (0 fits), panned with two fingers, the "%
// Fit" chip while zoomed; Previous and Next, the arrows and the lettered
// strip move; Pick B and the number keys pick; Esc fits, then goes back to
// side by side. Circle a part works while zoomed: the ring is drawn on the
// picture itself, so it is kept in fractions of the whole picture and
// follows the zoom and the pan, its note pinned beside it.

import AppKit

/// One picture of the pick: drawn whole and centred on a dark well, a ring dragged on it while circling.
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
    override func resetCursorRects() { if drawing { for r in uncovered(bounds) { addCursorRect(r, cursor: .crosshair) } } else if onClick != nil { handCursor() } }
    /// Where the picture is drawn: the whole of it, as big as fits, in the middle.
    var pictureRect: NSRect {
        guard let img = image, img.size.width > 0, img.size.height > 0, bounds.width > 0, bounds.height > 0 else { return bounds }
        let k = min(bounds.width / img.size.width, bounds.height / img.size.height)
        let w = img.size.width * k, h = img.size.height * k
        return NSRect(x: (bounds.width - w) / 2, y: (bounds.height - h) / 2, width: w, height: h)
    }
    override func draw(_ r: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let path = NSBezierPath(roundedRect: bounds, xRadius: 9, yRadius: 9)
            NSGraphicsContext.saveGraphicsState()
            path.addClip()
            Design.color(image == nil ? "card2" : "term-bg").setFill()
            bounds.fill()
            let pr = pictureRect
            if let img = image, img.size.width > 0 {
                NSGraphicsContext.current?.imageInterpolation = .high
                img.draw(in: pr, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
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
                let rr = NSRect(x: pr.minX + g.minX * pr.width, y: pr.minY + g.minY * pr.height, width: g.width * pr.width, height: g.height * pr.height)
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
    /// The point in fractions of the picture (not of the well around it).
    private func frac(_ e: NSEvent) -> NSPoint {
        let p = convert(e.locationInWindow, from: nil), pr = pictureRect
        return NSPoint(x: min(1, max(0, (p.x - pr.minX) / max(1, pr.width))), y: min(1, max(0, (p.y - pr.minY) / max(1, pr.height))))
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
    override func accessibilityPerformPress() -> Bool { onClick?(); return onClick != nil }
}

/// The ring on the picture up close: a view over the picture in its own
/// coordinates (the zoom scales and moves it with the picture), so a ring
/// dragged while zoomed is in fractions of the whole picture. It takes the
/// mouse only while circling; otherwise a click goes to the picture (zoom).
final class PickRing: NSView {
    var region: NSRect? { didSet { needsDisplay = true } }
    var drawing = false { didSet { window?.invalidateCursorRects(for: self) } }
    /// The zoom's magnification: the ring stays 2.5 points on screen.
    var mag: CGFloat = 1 { didSet { if abs(mag - oldValue) > 0.0001 { needsDisplay = true } } }
    var onRing: ((NSRect) -> Void)?
    private var start: NSPoint?
    override var isFlipped: Bool { true }
    override func hitTest(_ p: NSPoint) -> NSView? { drawing ? super.hitTest(p) : nil }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func resetCursorRects() { if drawing { addCursorRect(visibleRect, cursor: .crosshair) } }
    override func draw(_ r: NSRect) {
        guard let g = region else { return }
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let lw = 2.5 / max(0.01, mag)
            let rr = NSRect(x: g.minX * bounds.width, y: g.minY * bounds.height, width: g.width * bounds.width, height: g.height * bounds.height)
            let ring = NSBezierPath(ovalIn: rr.insetBy(dx: lw / 2, dy: lw / 2))
            ring.lineWidth = lw
            Design.color("you").setStroke()
            ring.stroke()
        }
    }
    private func frac(_ e: NSEvent) -> NSPoint {
        let p = convert(e.locationInWindow, from: nil)
        return NSPoint(x: min(1, max(0, p.x / max(1, bounds.width))), y: min(1, max(0, p.y / max(1, bounds.height))))
    }
    private func rect(_ a: NSPoint, _ b: NSPoint) -> NSRect { NSRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y)) }
    override func mouseDown(with e: NSEvent) { start = frac(e) }
    override func mouseDragged(with e: NSEvent) { if let s = start { region = rect(s, frac(e)) } }
    override func mouseUp(with e: NSEvent) {
        guard let s = start else { return }
        start = nil
        let r = rect(s, frac(e))
        // Too small to mean anything on screen (8 points), at this zoom.
        if r.width * bounds.width * mag < 8 || r.height * bounds.height * mag < 8 { region = nil; return }
        onRing?(r)
    }
}

/// The "100%  Fit" chip over a zoomed picture: back to the whole picture.
final class FitChip: Box {
    let pct = label("", Fonts.pt(12).withTabularDigits, "tx2")
    var run: (() -> Void)?
    init() {
        super.init(fill: "card2", ring: "sep", radius: 7)
        let row = hstack([pct, label(t("pick.fit"), Fonts.pt(12, .semibold))], spacing: 6, insets: NSEdgeInsets(top: 4, left: 9, bottom: 4, right: 9))
        row.translatesAutoresizingMaskIntoConstraints = true
        addSubview(row)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(t("pick.fitTip"))
        toolTip = t("pick.fitTip")
    }
    required init?(coder: NSCoder) { fatalError() }
    override var fittingSize: NSSize { subviews.first?.fittingSize ?? .zero }
    override func layout() { super.layout(); subviews.first?.frame = bounds }
    override func mouseDown(with e: NSEvent) { run?() }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func resetCursorRects() { handCursor() }
    override func accessibilityPerformPress() -> Bool { run?(); return true }
}

/// A pick's picture in its pixels: the zoom's sizes and percentages are the picture's own.
func inPixels(_ img: NSImage) -> NSImage {
    let px = img.representations.map { NSSize(width: $0.pixelsWide, height: $0.pixelsHigh) }.max { $0.width * $0.height < $1.width * $1.height } ?? .zero
    if px.width > 0, px.height > 0, img.size != px { img.size = px }
    return img
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
    /// The picture shown up close in the picker's place, else nil (side by side).
    private(set) var viewing: Int?
    /// The viewer: the gallery's zoom, the ring over its picture, the "% Fit" chip, the strip.
    let zoom = ZoomView()
    let pickRing = PickRing()
    let chip = FitChip()
    private let viewer = Flipped()
    private var vhead: NSView?
    private var vbar: NSView?
    private let vstrip = Flipped()
    private(set) var thumbs: [FitImage] = []
    /// The ring's note while a picture is up close, pinned beside the ring where it shows.
    private(set) var vnote: NSView?
    /// The head's least top room: the system's soft edge (8 pt) under the title bar's band falls in it, never on the words.
    static let edgeRoom: CGFloat = 10
    /// How much of the picker's top the window's title bar covers (layout()).
    private(set) var titleBand: CGFloat = 0

    init() {
        super.init(fill: "sheet")
        addSubview(scroll)
        addSubview(viewer)
        addSubview(foot)
        viewer.isHidden = true
        for v in [zoom, vstrip, chip] as [NSView] { viewer.addSubview(v) }
        zoom.picture.addSubview(pickRing)
        pickRing.autoresizingMask = [.width, .height]
        pickRing.onRing = { [weak self] r in if let self, let n = self.viewing { self.ringed(n, r) } }
        zoom.onEscape = { [weak self] in self?.escape() ?? false }
        chip.isHidden = true
        chip.run = { [weak self] in self?.zoom.fitAgain(); self?.zoomMoved() }
        zoom.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(zoomMoved), name: NSView.boundsDidChangeNotification, object: zoom.contentView)
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

    /// Shows a pick (the same one keeps what was picked and typed), side by
    /// side, or with picture `at` up close (a click on the card's picture).
    func show(_ cp: [String: Any], at: Int? = nil) {
        let cid = cp["id"] as? String
        let n = (cp["variants"] as? [Any] ?? []).count
        if cid != id {
            id = cid; picked = nil; circling = false; region = nil; pin = ""; editingPin = false; busy = false; error = nil
            extra.stringValue = ""; pictures = [:]; viewing = nil
            // Read once (HubClient.picture): the card's pictures are drawn here at once.
            for i in 0..<n {
                pictures[i] = hub?.picture(pictureURL(cid ?? "", i)) { [weak self] img in
                    guard let self, self.id == cid, let img else { return }
                    self.pictures[i] = inPixels(img)
                    if i < self.images.count { self.images[i].image = img }
                    if i < self.thumbs.count { self.thumbs[i].image = img }
                    if self.viewing == i { self.zoom.show(self.pictureURL(cid ?? "", i), img); self.zoomMoved() }
                }
                if let p = pictures[i] { pictures[i] = inPixels(p) }
            }
        }
        if let a = at, a >= 0, a < n { viewing = a }
        self.cp = cp
        draw()
    }

    private func pictureURL(_ cid: String, _ i: Int) -> String { "/api/checkpoints/\(cid)/variants/\(i)?as=png" }

    /// Picture n up close in the picker's place (at its fit), or side by side again (nil).
    func view(_ n: Int?) {
        let count = (cp["variants"] as? [Any] ?? []).count
        if let k = n, k < 0 || k >= count { return }
        viewing = n
        draw()
        window?.makeFirstResponder(self)
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
        viewer.frame = scroll.frame
        layoutViewer()
        if abs(band - titleBand) > 0.5 { titleBand = band; if cp["id"] != nil { DispatchQueue.main.async { [weak self] in self?.draw() } } }
    }

    func draw() {
        let oldBack = buttons["back"]
        buttons = [:]
        images = []
        scroll.isHidden = viewing != nil
        viewer.isHidden = viewing == nil
        pickRing.drawing = circling && viewing != nil
        if let i = viewing {
            drawViewer(i)
            drawFoot()
            if editingPin { DispatchQueue.main.async { [weak self] in self.map { $0.window?.makeFirstResponder($0.pinField) } } }
            return
        }
        vnote?.removeFromSuperview(); vnote = nil
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
        let back = backLink.map { l -> RButton in let b = backButton(l.name, l.run, reusing: oldBack); buttons["back"] = b; return b }
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
            img.onClick = { [weak self] in self?.view(n) }
            img.toolTip = t("pick.lookTip", ["name": v["label"] as? String ?? letter(n)])
            img.setAccessibilityRole(.button)
            img.setAccessibilityLabel(t("pick.lookTip", ["name": v["label"] as? String ?? letter(n)]))
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
        let note = noteView()
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

    /// The ring's note (.note-pin): its number, and a field while typed, else its words.
    private func noteView() -> Box {
        let dot = boxed(label("1", Fonts.pt(10.5, .bold), "", lines: 1), fill: "you", radius: 8.5, insets: NSEdgeInsets(top: 1, left: 5, bottom: 1, right: 5))
        (dot.subviews.first as? NSTextField)?.textColor = NSColor(srgbRed: 0x1D / 255, green: 0x1D / 255, blue: 0x1F / 255, alpha: 1)
        let content: NSView
        if editingPin {
            pinField.removeFromSuperview()
            pinField.stringValue = pin
            pinField.translatesAutoresizingMaskIntoConstraints = false
            if !pinField.constraints.contains(where: { $0.firstAttribute == .width }) { pinField.widthAnchor.constraint(equalToConstant: 150).isActive = true }
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
        note.setAccessibilityLabel(pin)
        return note
    }

    // MARK: one picture up close

    /// The viewer in the picker's place (the pickzoom pictures, mac 3 to 6):
    /// its head ("‹ All 4", the question, "2 of 4", Close), the picture in the
    /// gallery's zoom, its bar (the letter and name, the agent's words, Your
    /// pick, Previous, Next, Pick B and its key) and the strip of the variants.
    private func drawViewer(_ i: Int) {
        let w = words
        let vs = cp["variants"] as? [[String: Any]] ?? []
        let says = w["variants"] as? [[String: Any]] ?? []
        let cid = id ?? ""
        let name = { (n: Int) in n < says.count ? says[n]["name"] as? String ?? "" : vs[n]["label"] as? String ?? "" }
        var where_: String? = whereOf?(cp)
        if where_ == nil { where_ = cp["project"] as? String }
        vhead?.removeFromSuperview(); vbar?.removeFromSuperview()
        // The head: the picker's, "‹ All 4" back to side by side, "2 of 4" for how long it waits.
        let back = backButton(t("pick.all", ["n": "\(vs.count)"])) { [weak self] in self?.view(nil) }
        buttons["all"] = back
        let kindRow = hstack([Icon("pick", "you", size: 14), label(w["heading"] as? String ?? "", Fonts.pt(12, .bold), "you"), where_.map { label($0, Fonts.pt(12), "tx3") }], spacing: 7)
        let title = label(md: w["head"] as? String ?? "", Fonts.pt(20, .bold), "tx", lines: 0)
        title.preferredMaxLayoutWidth = 700
        let tcol = vstack([kindRow, title], spacing: 4)
        tcol.setContentHuggingPriority(.init(1), for: .horizontal)
        let close = RButton(t("pick.closeTip"), .icon, small: true, icon: "close") { [weak self] in self?.onClose?() }
        buttons["close"] = close
        let head = hstack([back, tcol, spring(), label(t("pick.nOf", ["i": "\(i + 1)", "n": "\(vs.count)"]), Fonts.pt(12).withTabularDigits, "tx3"), close], spacing: 10, insets: NSEdgeInsets(top: max(Self.edgeRoom, 16 - titleBand), left: 22, bottom: 10, right: 22))
        head.alignment = .top
        head.translatesAutoresizingMaskIntoConstraints = true
        viewer.addSubview(head)
        vhead = head
        // The picture: at its fit when it is another one, as the person left it when the same.
        zoom.show(pictureURL(cid, i), pictures[i])
        zoom.picture.setAccessibilityLabel("\(letter(i)). \(name(i))")
        pickRing.frame = zoom.picture.bounds
        pickRing.region = picked == i ? region : nil
        // The bar.
        let sayLine = i < says.count ? says[i]["says"] as? String : nil
        // The letter and name and Your pick always show; the agent's words give way (cut at the end) in a narrow window.
        let sayL = sayLine.map { l -> NSTextField in let f = label(l, Fonts.pt(12.5), "tx2"); f.lineBreakMode = .byTruncatingTail; f.setContentCompressionResistancePriority(.init(1), for: .horizontal); return f }
        let nm = hstack([label("\(letter(i)). \(name(i))", Fonts.pt(13.5, Fonts.w650)), sayL, picked == i ? pill(t("pick.yourPick"), "work") : nil], spacing: 10)
        nm.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        let prev = RButton(t("gallery.previous")) { [weak self] in self?.step(-1) }
        prev.isEnabled = i > 0
        let next = RButton(t("gallery.next")) { [weak self] in self?.step(1) }
        next.isEnabled = i < vs.count - 1
        let pb: RButton
        if picked == i { pb = RButton(t("pick.picked"), .primary); pb.lead = "check-c" } else { pb = RButton(t("pick.pickLetter", ["letter": letter(i)]), .primary) { [weak self] in self?.pickN(i) } }
        pb.isEnabled = open
        for b in [prev, next, pb] { b.refusesFirstResponder = true }
        buttons["previous"] = prev; buttons["next"] = next; buttons["pick\(i + 1)"] = pb
        let kb = boxed(label("\(i + 1)", Fonts.pt(10.5, Fonts.w650), "tx3"), fill: nil, ring: "sep", radius: 4, insets: NSEdgeInsets(top: 1, left: 5, bottom: 1, right: 5))
        let bar = hstack([nm, spring(), prev, next, pb, kb], spacing: 10)
        bar.alignment = .centerY
        bar.translatesAutoresizingMaskIntoConstraints = true
        viewer.addSubview(bar)
        vbar = bar
        // The strip: each variant whole, its letter, the one shown ringed, the picked one checked.
        vstrip.subviews.forEach { $0.removeFromSuperview() }
        thumbs = []
        for k in vs.indices {
            let c = FitImage()
            c.image = pictures[k]
            c.dim = k == i ? 1 : 0.6
            c.onClick = { [weak self] in self?.view(k) }
            c.setAccessibilityLabel(t("pick.showOne", ["letter": letter(k), "name": name(k)]))
            c.setAccessibilityRole(.button)
            let r = Box(fill: nil, ring: k == i ? "work" : nil, radius: 7)
            r.ringWidth = 2
            r.addSubview(c)
            let b = boxed(label(letter(k), Fonts.pt(10.5, .bold), ""), fill: nil, radius: 5, insets: NSEdgeInsets(top: 1, left: 5, bottom: 1, right: 5))
            b.rawFill = NSColor(srgbRed: 20 / 255, green: 20 / 255, blue: 22 / 255, alpha: 0.82)
            (b.subviews.first as? NSTextField)?.textColor = .white
            r.addSubview(b)
            if picked == k { r.addSubview(Icon("check-c", "work", size: 14)) }
            vstrip.addSubview(r)
            thumbs.append(c)
        }
        // The note, pinned beside the ring where it shows.
        vnote?.removeFromSuperview(); vnote = nil
        if picked == i, region != nil, editingPin || !pin.trimmingCharacters(in: .whitespaces).isEmpty {
            let n = noteView()
            n.translatesAutoresizingMaskIntoConstraints = true
            viewer.addSubview(n)
            vnote = n
        }
        viewer.addSubview(chip)
        layoutViewer()
        zoomMoved()
    }

    private func layoutViewer() {
        guard viewing != nil, let head = vhead else { return }
        let pad: CGFloat = 22, W = viewer.bounds.width
        let hh = head.fittingSize.height
        head.frame = NSRect(x: 0, y: 0, width: W, height: hh)
        let stripH: CGFloat = 54, barH: CGFloat = 34
        let bigH = max(120, viewer.bounds.height - hh - 6 - 14 - barH - 14 - stripH - 14)
        let zf = NSRect(x: pad, y: hh + 6, width: max(1, W - 2 * pad), height: bigH)
        if zoom.frame != zf { zoom.frame = zf }
        vbar?.frame = NSRect(x: pad, y: zf.maxY + 14, width: zf.width, height: barH)
        let sw = CGFloat(thumbs.count) * 92 - 8
        vstrip.frame = NSRect(x: max(pad, (W - sw) / 2), y: zf.maxY + 14 + barH + 14, width: sw, height: stripH)
        for (k, c) in thumbs.enumerated() {
            guard let r = c.superview else { continue }
            r.frame = NSRect(x: CGFloat(k) * 92, y: 0, width: 84, height: stripH)
            c.frame = r.bounds
            for v in r.subviews where v !== c {
                if v is Icon { v.frame = NSRect(x: 84 - 19, y: 5, width: 14, height: 14) } else { v.frame = NSRect(origin: NSPoint(x: 5, y: 5), size: v.fittingSize) }
            }
        }
        zoomMoved()
    }

    /// The zoom moved (a pinch, a click, the keys, a pan, a resize): the chip says how big, the ring keeps its width, the note follows the ring.
    @objc func zoomMoved() {
        guard viewing != nil else { chip.isHidden = true; return }
        pickRing.frame = zoom.picture.bounds
        pickRing.mag = zoom.magnification
        chip.isHidden = !zoom.zoomed
        if zoom.zoomed {
            chip.pct.stringValue = "\(Int((zoom.magnification * 100).rounded()))%"
            let s = chip.fittingSize
            chip.frame = NSRect(x: zoom.frame.maxX - s.width - 10, y: zoom.frame.maxY - s.height - 10, width: s.width, height: s.height)
        }
        placeNote()
    }

    /// The note beside the ring as it shows now: on the right when there is room, else the left, inside the picture's area.
    private func placeNote() {
        guard let n = vnote, let g = region else { return }
        let pb = zoom.picture.bounds
        let pr = NSRect(x: g.minX * pb.width, y: g.minY * pb.height, width: g.width * pb.width, height: g.height * pb.height)
        let on = viewer.convert(pr, from: zoom.picture)
        let vis = zoom.frame
        let s = n.fittingSize
        let right = on.maxX + 10 + s.width <= vis.maxX - 6
        let x = right ? on.maxX + 10 : on.minX - s.width - 10
        n.frame = NSRect(x: max(vis.minX + 6, min(x, vis.maxX - s.width - 6)), y: max(vis.minY + 6, min(on.minY - 8, vis.maxY - s.height - 6)), width: s.width, height: s.height)
        // While it is typed it stays; its words hide with the ring when the ring is out of sight.
        n.isHidden = !editingPin && !vis.intersects(on)
    }

    /// Previous (-1) or next (1) picture up close.
    func step(_ d: Int) { if let i = viewing { view(i + d) } }

    /// Escape: a zoomed picture fitted, else side by side again, else nil (the picker closes). False when there is nothing to do.
    @discardableResult func escape() -> Bool {
        guard viewing != nil else { return false }
        if zoom.zoomed { zoom.fitAgain(); zoomMoved(); return true }
        view(nil)
        return true
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
        // Mid-sentence: the hub's whoMid ("the agent"), never who ("The agent").
        let who = words["whoMid"] as? String ?? "the agent"
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
        if viewing != nil { viewing = n }
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
        if e.keyCode == 53 { if !escape() { onClose?() }; return }
        if viewing != nil {
            let ch = e.charactersIgnoringModifiers ?? ""
            switch e.keyCode {
            case 123: step(-1); return
            case 124: step(1); return
            default: break
            }
            if ch == "+" || ch == "=" { zoom.zoomStep(1.5); zoomMoved(); return }
            if ch == "-" { zoom.zoomStep(1 / 1.5); zoomMoved(); return }
            if ch == "0" { zoom.fitAgain(); zoomMoved(); return }
        }
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
