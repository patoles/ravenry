// A project's pictures (PIC-001, PIC-002), as the Electron app draws them
// (inapp.ts gallery() and viewer(), app.css .ia-gal, .ia-big, .ia-vbar,
// .ia-strip): the list is the hub's (each project's brief.gallery, newest
// first: its session's last ones, then the brief's; pictures.mjs
// galleryList), the pictures its GET /api/pic routes.
//
// - The grid: a card a picture (cover, 16:10) with its name and when, at
//   least 200 points wide; the one the viewer came from ringed.
// - One picture large: fitted to the page (never bigger than its own
//   size), Previous, Next, Show in Finder (POST /api/project/reveal-picture
//   for a session's picture), and the strip. A click zooms in (to its own
//   size when that is bigger than the page, else twice as big) around the
//   point clicked, and out again; a trackpad pinch zooms around the
//   pointer and two fingers pan (the scroll view's own magnification). The
//   zoom and the place stay through the hub's refreshes; a new picture
//   starts fitted.

import AppKit

extension When {
    /// "today, 21:12", else "9 Nov, 21:12".
    static func day(_ s: String?) -> String? {
        guard let d = date(s) else { return nil }
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        let hm = String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
        if Calendar.current.isDate(d, inSameDayAs: now()) { return t("gallery.today", ["time": hm]) }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_GB"); f.dateFormat = "d MMM"
        return "\(f.string(from: d)), \(hm)"
    }
}

struct GalleryPic: Equatable {
    let url: String, name: String, at: String?, key: String?, fromBrief: Bool
    /// The hub's list (brief.gallery); a hub older than it: the brief's pictures with a URL, as they come.
    static func of(_ p: HubProject?) -> [GalleryPic] {
        let b = p?.brief ?? [:]
        if let g = b["gallery"] as? [[String: Any]] {
            return g.compactMap { x in (x["url"] as? String).map { GalleryPic(url: $0, name: x["name"] as? String ?? "", at: x["at"] as? String, key: x["key"] as? String, fromBrief: x["from"] as? String == "brief") } }
        }
        return (b["pictures"] as? [[String: Any]] ?? []).compactMap { x in
            (x["url"] as? String).map { GalleryPic(url: $0, name: x["alt"] as? String ?? ((x["path"] as? String ?? "") as NSString).lastPathComponent, at: nil, key: nil, fromBrief: !(x["auto"] as? Bool ?? false)) }
        }
    }
    var when: String? { fromBrief ? t("gallery.fromBrief") : When.day(at) }
}

/// The scroll view's clip: a picture smaller than it in its middle while
/// fitted; zoomed (`free`), anywhere that keeps it inside the frame, so the
/// point under the pointer stays there (the Electron app's margins).
final class CentringClip: NSClipView {
    var free = false
    override func constrainBoundsRect(_ proposed: NSRect) -> NSRect {
        var r = super.constrainBoundsRect(proposed)
        guard let d = documentView else { return r }
        if free {
            let dx = d.frame.width - r.width, dy = d.frame.height - r.height
            r.origin.x = min(max(proposed.origin.x, min(0, dx)), max(0, dx))
            r.origin.y = min(max(proposed.origin.y, min(0, dy)), max(0, dy))
            return r
        }
        if d.frame.width < r.width { r.origin.x = (d.frame.width - r.width) / 2 }
        if d.frame.height < r.height { r.origin.y = (d.frame.height - r.height) / 2 }
        return r
    }
}

/// The picture: a press zooms in or out where it lands.
final class FlippedImage: NSImageView {
    override var isFlipped: Bool { true }
    var onClick: ((NSPoint) -> Void)?
    override func mouseDown(with e: NSEvent) { onClick?(convert(e.locationInWindow, from: nil)) }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
}

final class ZoomView: NSScrollView {
    let picture = FlippedImage()
    var onToggle: ((NSPoint) -> Void)?
    private(set) var url = ""
    init() {
        super.init(frame: .zero)
        contentView = CentringClip()
        drawsBackground = true
        backgroundColor = NSColor(srgbRed: 0x0B / 255, green: 0x0B / 255, blue: 0x0C / 255, alpha: 1)
        hasVerticalScroller = true
        hasHorizontalScroller = true
        autohidesScrollers = true
        scrollerStyle = .overlay
        allowsMagnification = true
        picture.imageScaling = .scaleAxesIndependently
        documentView = picture
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.masksToBounds = true
        picture.onClick = { [weak self] p in self?.clicked(p) }
        picture.setAccessibilityRole(.button)
    }
    required init?(coder: NSCoder) { fatalError() }

    /// Its own size in points, as the Electron app's CSS pixels.
    private var natural: NSSize {
        guard let i = picture.image, let r = i.representations.first, r.pixelsWide > 0 else { return picture.image?.size ?? .zero }
        return NSSize(width: r.pixelsWide, height: r.pixelsHigh)
    }

    /// The magnification that fits the picture in the frame, never above its own size.
    var fit: CGFloat {
        let n = natural
        guard n.width > 0, n.height > 0, bounds.width > 0 else { return 1 }
        return min(1, bounds.width / n.width, bounds.height / n.height)
    }
    var zoomed: Bool { magnification > fit * 1.02 }

    /// A new picture: fitted. The same one: as it was.
    func show(_ u: String, _ img: NSImage?) {
        if u == url && (img == nil || picture.image === img) { return }
        let fresh = u != url
        url = u
        picture.image = img
        picture.frame = NSRect(origin: .zero, size: natural)
        if fresh || !zoomed { refit() }
    }

    /// Fitted again, in the middle.
    func fitAgain() {
        (contentView as? CentringClip)?.free = false
        magnification = fit
        contentView.scroll(to: contentView.constrainBoundsRect(contentView.bounds).origin)
        reflectScrolledClipView(contentView)
    }

    /// A pinch (the scroll view's own): free while zoomed, in the middle when back to fitted.
    override func magnify(with e: NSEvent) {
        (contentView as? CentringClip)?.free = true
        super.magnify(with: e)
        if !zoomed { fitAgain() }
    }

    func refit() {
        (contentView as? CentringClip)?.free = false
        minMagnification = max(0.01, min(fit, 1))
        maxMagnification = max(1, 6 * max(1, 1 / max(fit, 0.01)) * fit)
        magnification = fit
    }

    override func layout() {
        let wasFit = !zoomed
        super.layout()
        // Resized: still fitted when it was.
        minMagnification = max(0.01, min(fit, 1))
        if wasFit && abs(magnification - fit) > 0.001 { magnification = fit }
    }

    /// The magnification `m`, the picture's point `p` (its own coordinates) kept under the view's point `v`.
    func zoom(to m: CGFloat, keeping p: NSPoint, at v: NSPoint) {
        let mm = max(minMagnification, min(maxMagnification, m))
        (contentView as? CentringClip)?.free = mm > fit * 1.02
        magnification = mm
        let origin = NSPoint(x: p.x - v.x / mm, y: p.y - v.y / mm)
        contentView.scroll(to: contentView.constrainBoundsRect(NSRect(origin: origin, size: contentView.bounds.size)).origin)
        reflectScrolledClipView(contentView)
    }

    private func clicked(_ p: NSPoint) {
        // The point from the visible area's top left, in the view's points.
        let c = contentView.convert(p, from: picture), o = contentView.bounds.origin
        toggle(at: p, view: NSPoint(x: (c.x - o.x) * magnification, y: (c.y - o.y) * magnification))
    }

    /// A click: in to its own size (or twice the fitted size), around the point; out to fitted.
    func toggle(at p: NSPoint, view v: NSPoint) {
        if zoomed { fitAgain(); return }
        let n = natural
        let target = n.width > n.width * fit * 1.2 ? 1 : fit * 2
        // The view's point measured from the clip's top left (flipped picture: y down).
        zoom(to: target, keeping: p, at: NSPoint(x: v.x, y: v.y))
    }

    override func resetCursorRects() { addCursorRect(bounds, cursor: zoomed ? .arrow : .pointingHand) }
}

final class GalleryPage: InAppPage {
    var hub: HubClient?
    var toast: ((String) -> Void)?
    private(set) var project = ""
    /// The picture shown large, else the grid; `lit` the card the viewer came from.
    private(set) var at: Int?
    private(set) var lit: Int?
    private(set) var pics: [GalleryPic] = []
    private var images: [String: NSImage] = [:]
    private var asked = Set<String>()
    private let grid = NSScrollView()
    private let gridDoc = Flipped()
    private(set) var cards: [CoverImage] = []
    private var captions: [NSView] = []
    private var empty: NSTextField?
    let zoom = ZoomView()
    private let vbar = Flipped()
    private let strip = NSScrollView()
    private let stripDoc = Flipped()
    private(set) var thumbs: [CoverImage] = []
    private var drawn = ""
    private var name = ""
    private var revealing = false

    override init() {
        super.init()
        grid.drawsBackground = false
        grid.hasVerticalScroller = true
        grid.autohidesScrollers = true
        grid.scrollerStyle = .overlay
        grid.automaticallyAdjustsContentInsets = false
        grid.documentView = gridDoc
        strip.drawsBackground = false
        strip.hasHorizontalScroller = true
        strip.autohidesScrollers = true
        strip.scrollerStyle = .overlay
        strip.automaticallyAdjustsContentInsets = false
        strip.documentView = stripDoc
        for v in [grid, zoom, vbar, strip] as [NSView] { body.addSubview(v) }
    }
    required init?(coder: NSCoder) { fatalError() }

    /// Shows a project's gallery (at nil) or one of its pictures large.
    func show(_ pid: String, at i: Int?, lit l: Int? = nil, state: HubState?) {
        if pid != project { drawn = ""; project = pid }
        let p = state?.project(pid)
        name = p?.name ?? pid
        pics = GalleryPic.of(p)
        at = i.map { max(0, min(pics.count - 1, $0)) }
        if pics.isEmpty { at = nil }
        lit = l
        draw()
    }

    /// The hub's state again: drawn again only when the list changed.
    func refresh(_ state: HubState?) { show(project, at: at, lit: lit, state: state) }

    private func image(_ u: String) -> NSImage? {
        if let i = images[u] { return i }
        if !asked.contains(u), let hub {
            asked.insert(u)
            hub.data(u) { [weak self] d in
                guard let self else { return }
                if let d, let i = NSImage(data: d) { self.images[u] = i } else { self.asked.remove(u) }
                self.drawn = ""
                self.draw()
            }
        }
        return nil
    }

    private func draw() {
        let sig = "\(project)|\(at ?? -1)|\(lit ?? -1)|\(revealing)|" + pics.map { $0.url + ($0.at ?? "") + $0.name }.joined(separator: ",") + "|\(images.count)"
        if sig == drawn { return }
        drawn = sig
        let n = pics.count
        if let i = at {
            setHead(title: nil, src: t("gallery.nOf", ["i": "\(i + 1)", "n": "\(n)"]), back: (t("gallery.title"), { [weak self] in self?.go(nil, lit: i) }))
            drawViewer(i)
        } else {
            setHead(title: t("gallery.title"), src: t(n == 1 ? "gallery.srcOne" : "gallery.src", ["name": name, "n": "\(n)"]))
            drawGrid()
        }
        grid.isHidden = at != nil
        for v in [zoom, vbar, strip] as [NSView] { v.isHidden = at == nil }
        if at != nil && n < 2 { strip.isHidden = true }
        needsLayout = true
    }

    private func go(_ i: Int?, lit l: Int? = nil) {
        at = i
        lit = l
        draw()
    }

    private func drawGrid() {
        gridDoc.subviews.forEach { $0.removeFromSuperview() }
        cards = []; captions = []; empty = nil
        if pics.isEmpty {
            let e = label(t("gallery.none"), Fonts.pt(13), "tx2", lines: 2)
            e.translatesAutoresizingMaskIntoConstraints = true
            empty = e
            gridDoc.addSubview(e)
            return
        }
        for (i, x) in pics.enumerated() {
            let c = CoverImage()
            c.image = image(x.url)
            c.fillColor = .black
            c.onClick = { [weak self] in self?.go(i) }
            c.setAccessibilityRole(.button)
            c.setAccessibilityLabel(t("gallery.open", ["name": x.name]))
            let cap = Box(fill: "card", radius: 0)
            let nm = label(x.name, Fonts.pt(12.5, .semibold))
            let wh = x.when.map { label($0, Fonts.pt(12), "tx2") }
            let st = vstack([nm, wh], spacing: 2, insets: NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10))
            st.translatesAutoresizingMaskIntoConstraints = true
            cap.addSubview(st)
            let card = Box(fill: "card", ring: i == lit ? "work" : "sep", radius: 10)
            card.ringWidth = i == lit ? 2 : 1
            card.layer?.masksToBounds = true
            card.addSubview(c)
            card.addSubview(cap)
            gridDoc.addSubview(card)
            cards.append(c)
            captions.append(cap)
        }
    }

    private func drawViewer(_ i: Int) {
        let x = pics[i]
        zoom.show(x.url, image(x.url))
        zoom.picture.setAccessibilityLabel(x.name)
        vbar.subviews.forEach { $0.removeFromSuperview() }
        let prev = RButton(t("gallery.previous")) { [weak self] in self?.go(i - 1) }
        prev.isEnabled = i > 0
        let next = RButton(t("gallery.next")) { [weak self] in self?.go(i + 1) }
        next.isEnabled = i < pics.count - 1
        buttons["previous"] = prev; buttons["next"] = next
        var reveal: RButton? = nil
        if let k = x.key {
            let b = RButton(t("gallery.showInFinder")) { [weak self] in self?.reveal(k, x.name) }
            b.isEnabled = !revealing
            reveal = b
        }
        buttons["reveal"] = reveal
        let row = hstack([label(x.name, Fonts.pt(13, .semibold)), x.when.map { label($0, Fonts.pt(12), "tx3") }, spring(), prev, next, reveal], spacing: 10)
        row.translatesAutoresizingMaskIntoConstraints = true
        row.autoresizingMask = [.width, .height]
        vbar.addSubview(row)
        stripDoc.subviews.forEach { $0.removeFromSuperview() }
        thumbs = []
        for (k, y) in pics.enumerated() {
            let c = CoverImage()
            c.image = image(y.url)
            c.radius = 6
            c.fillColor = .clear
            c.dim = k == i ? 1 : 0.6
            c.onClick = { [weak self] in self?.go(k) }
            c.setAccessibilityLabel(t("gallery.showOne", ["name": y.name]))
            c.setAccessibilityRole(.button)
            let ring = Box(fill: nil, ring: k == i ? "work" : nil, radius: 7)
            ring.ringWidth = 2
            ring.addSubview(c)
            stripDoc.addSubview(ring)
            thumbs.append(c)
        }
    }

    private func reveal(_ key: String, _ name: String) {
        guard let hub, !revealing else { return }
        revealing = true
        draw()
        hub.post("/api/project/reveal-picture", ["projectId": project, "key": key]) { [weak self] code, j in
            guard let self else { return }
            self.revealing = false
            self.drawn = ""
            self.draw()
            if code == 200 { self.toast?(t("gallery.shown", ["path": j["path"] as? String ?? name])) } else { self.toast?(j["error"] as? String ?? t("page.didNotWork")) }
        }
    }

    override func layoutBody() {
        let b = body.bounds
        let pad: CGFloat = 22
        let w = max(1, b.width - 2 * pad)
        if at == nil {
            grid.frame = NSRect(x: 0, y: 0, width: b.width, height: b.height)
            if let e = empty { e.frame = NSRect(x: pad, y: 0, width: w, height: 40); gridDoc.frame = NSRect(x: 0, y: 0, width: b.width, height: max(b.height, 60)); return }
            // repeat(auto-fill, minmax(200px, 1fr)), gap 14.
            let gap: CGFloat = 14
            let cols = max(1, Int((w + gap) / (200 + gap)))
            let cw = (w - gap * CGFloat(cols - 1)) / CGFloat(cols)
            let ih = (cw * 10 / 16).rounded()
            let ch = ih + 52
            for (i, c) in cards.enumerated() {
                let r = i / cols, k = i % cols
                let card = c.superview!
                card.frame = NSRect(x: pad + CGFloat(k) * (cw + gap), y: CGFloat(r) * (ch + gap), width: cw, height: ch)
                c.frame = NSRect(x: 0, y: 0, width: cw, height: ih)
                captions[i].frame = NSRect(x: 0, y: ih, width: cw, height: ch - ih)
                captions[i].subviews.first?.frame = captions[i].bounds
            }
            let rows = (cards.count + cols - 1) / cols
            gridDoc.frame = NSRect(x: 0, y: 0, width: b.width, height: max(b.height, CGFloat(rows) * (ch + gap) + 6))
            return
        }
        // .ia-view: the picture takes what the bar (32) and the strip (58) leave, gap 14.
        let stripH: CGFloat = strip.isHidden ? 0 : 58
        let barH: CGFloat = 32
        let bigH = max(120, b.height - 20 - barH - 14 - (stripH > 0 ? stripH + 14 : 0))
        zoom.frame = NSRect(x: pad, y: 0, width: w, height: bigH)
        vbar.frame = NSRect(x: pad, y: bigH + 14, width: w, height: barH)
        vbar.subviews.first?.frame = vbar.bounds
        strip.frame = NSRect(x: pad - 2, y: bigH + 14 + barH + 14, width: w + 4, height: stripH)
        for (k, c) in thumbs.enumerated() {
            let ring = c.superview!
            ring.frame = NSRect(x: 2 + CGFloat(k) * 92, y: 2, width: 84, height: 54)
            c.frame = ring.bounds.insetBy(dx: 0, dy: 0)
        }
        stripDoc.frame = NSRect(x: 0, y: 0, width: max(strip.bounds.width, CGFloat(thumbs.count) * 92 + 4), height: stripH)
    }
}
