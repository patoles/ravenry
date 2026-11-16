// A project's pictures (PIC-001, PIC-002), as the Electron app draws them
// (inapp.ts gallery() and viewer(), app.css .ia-gal, .ia-big, .ia-vbar,
// .ia-strip): the list is the hub's (each project's brief.gallery, newest
// first: its session's last ones, then the brief's; pictures.mjs
// galleryList), the pictures its GET /api/pic routes.
//
// - The grid: a card a picture (16:10, the picture whole inside it, never
//   cropped) with its name and when, at least 200 points wide; the whole
//   card is the button, lit on hover. The first card is ringed when the
//   grid opens, the one the viewer came from when it comes back; the
//   arrows move the ring, Return opens it. The pictures are asked for as
//   their cards scroll into view (a spinner until each arrives, at most
//   four requests at a time), as small copies decoded off the main thread
//   (PictureCache); the viewer asks for the whole picture and its
//   neighbours.
// - One picture large: fitted to the page (never bigger than its own
//   size), Previous, Next, Show in Finder (POST /api/project/reveal-picture
//   for a session's picture), and the strip. A click zooms in (to its own
//   size when that is bigger than the page, else twice as big) around the
//   point clicked, and out again; a trackpad pinch or Ctrl and the wheel
//   zooms around the pointer and two fingers pan (the scroll view's own
//   magnification); + and - zoom, 0 fits. The left and right arrows go to
//   the previous and the next; Escape fits a zoomed picture, else goes
//   back to the grid. Each picture opens at its own fit (the whole of it,
//   worked out again once its whole copy is in), and zooms out to that fit
//   and no further; on an axis where it is smaller than the view it sits
//   in the middle. The zoom, the place and the picture shown stay through
//   the hub's new states, a new picture in the list included (the picture
//   is followed by its URL, not its place in the list).

import AppKit
import ImageIO

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

/// The scroll view's clip, each axis on its own: a picture smaller than the
/// view on it sits in its middle (fitted or zoomed, during a pinch and
/// after), a bigger one is kept covering the view (never a margin past its
/// edge). A tall page zoomed in but still narrower than the view stays in
/// the middle across, and scrolls down.
final class CentringClip: NSClipView {
    override func constrainBoundsRect(_ proposed: NSRect) -> NSRect {
        var r = super.constrainBoundsRect(proposed)
        guard let d = documentView else { return r }
        let f = d.frame
        r.origin.x = f.width <= r.width ? f.minX - (r.width - f.width) / 2 : min(max(proposed.origin.x, f.minX), f.maxX - r.width)
        r.origin.y = f.height <= r.height ? f.minY - (r.height - f.height) / 2 : min(max(proposed.origin.y, f.minY), f.maxY - r.height)
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
    /// Escape while it has the keyboard (the page's escape()).
    var onEscape: (() -> Bool)?
    private(set) var url = ""
    /// The whole picture at its fit, worked out again whenever the picture
    /// or the view changes (its whole copy after the small one, a resize);
    /// false once the person zooms in, until it is fitted again. Never
    /// guessed from the magnification: a fit worked out before the picture
    /// was in (none: 1) or on its small copy is not this picture's.
    private(set) var fitted = true
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
    private var natural: NSSize { picture.image.map(Self.pixels) ?? .zero }

    /// The magnification that fits the picture in the frame, never above its own size.
    var fit: CGFloat {
        let n = natural
        guard n.width > 0, n.height > 0, bounds.width > 0, bounds.height > 0 else { return 1 }
        return min(1, bounds.width / n.width, bounds.height / n.height)
    }
    var zoomed: Bool { !fitted }

    /// A new picture: at its fit. The same one: as the person left it; a
    /// bigger copy of it (the whole one after the small one) takes its place
    /// at the same zoom and place on the picture, at its fit when fitted; a
    /// smaller copy never replaces a bigger one.
    func show(_ u: String, _ img: NSImage?) {
        if u != url {
            url = u
            put(img)
            fitAgain()
            return
        }
        guard let img, picture.image !== img else { return }
        let was = natural, now = Self.pixels(img)
        if picture.image != nil && now.width * now.height < was.width * was.height { return }
        guard !fitted, was.width > 0, now.width > 0 else { put(img); fitAgain(); return }
        let k = now.width / was.width
        let m = magnification, o = contentView.bounds.origin
        put(img)
        limits()
        magnification = max(minMagnification, min(maxMagnification, m / k))
        contentView.scroll(to: contentView.constrainBoundsRect(NSRect(origin: NSPoint(x: o.x * k, y: o.y * k), size: contentView.bounds.size)).origin)
        reflectScrolledClipView(contentView)
    }

    private func put(_ img: NSImage?) {
        picture.image = img
        picture.frame = NSRect(origin: .zero, size: natural)
    }

    /// A picture's own size in pixels: its size, set to its pixels when it
    /// was decoded (PictureCache.whole and thumb), never read from its
    /// representations (drawing adds copies of other sizes to them).
    static func pixels(_ i: NSImage) -> NSSize { i.size }

    /// Fitted again, in the middle.
    func fitAgain() {
        fitted = true
        limits()
        magnification = fit
        recentre()
    }

    /// The zoom's bounds from this picture in this view: down to its fit (the whole picture, never short of it), up to six times its own size.
    private func limits() {
        let f = max(0.0001, fit)
        if minMagnification != f { minMagnification = f }
        if maxMagnification != 6 { maxMagnification = 6 }
    }

    /// The clip where the clip's rule puts it (in the middle on a smaller axis, covering on a bigger one).
    private func recentre() {
        let o = contentView.constrainBoundsRect(contentView.bounds).origin
        if o != contentView.bounds.origin { contentView.scroll(to: o) }
        reflectScrolledClipView(contentView)
    }

    /// A pinch (the scroll view's own, around the pointer): zoomed from its
    /// first step; at its end, back to fitted when it is (nearly) there.
    override func magnify(with e: NSEvent) {
        fitted = false
        super.magnify(with: e)
        if e.phase.isEmpty || e.phase.contains(.ended) || e.phase.contains(.cancelled) { settle() }
    }
    /// A two-finger double tap: the scroll view's own zoom, then as a pinch's end.
    override func smartMagnify(with e: NSEvent) {
        fitted = false
        super.smartMagnify(with: e)
        settle()
    }
    private func settle() { if magnification <= fit * 1.02 { fitAgain() } }

    /// Resized (or laid out again): fitted, at the new fit; zoomed, at the same zoom, the clip's rule kept.
    override func layout() {
        super.layout()
        limits()
        if fitted {
            if magnification != fit { magnification = fit }
            recentre()
        } else if magnification <= fit * 1.0001 { fitAgain() } else { recentre() }
    }

    /// The magnification `m`, the picture's point `p` (its own coordinates) kept under the view's point `v`; at its fit or below, fitted.
    func zoom(to m: CGFloat, keeping p: NSPoint, at v: NSPoint) {
        let mm = max(minMagnification, min(maxMagnification, m))
        if mm <= fit * 1.02 { fitAgain(); return }
        fitted = false
        magnification = mm
        let origin = NSPoint(x: p.x - v.x / mm, y: p.y - v.y / mm)
        contentView.scroll(to: contentView.constrainBoundsRect(NSRect(origin: origin, size: contentView.bounds.size)).origin)
        reflectScrolledClipView(contentView)
    }

    /// Ctrl and the wheel: in or out around the pointer (up is in), as the Electron app's ctrlKey wheel.
    override func scrollWheel(with e: NSEvent) {
        guard e.modifierFlags.contains(.control), picture.image != nil else { return super.scrollWheel(with: e) }
        let dy = e.hasPreciseScrollingDeltas ? e.scrollingDeltaY : e.scrollingDeltaY * 12
        zoomAround(picture.convert(e.locationInWindow, from: nil), factor: exp(dy * 0.01))
    }

    /// + and -: in or out around the middle of what shows.
    func zoomStep(_ f: CGFloat) {
        let b = contentView.bounds
        zoomAround(NSPoint(x: b.midX, y: b.midY), factor: f)
    }

    /// The magnification times `f`, the picture's point `p` kept where it is on screen; back to fitted below it.
    func zoomAround(_ p: NSPoint, factor f: CGFloat) {
        let o = contentView.bounds.origin
        let v = NSPoint(x: (p.x - o.x) * magnification, y: (p.y - o.y) * magnification)
        let m = magnification * f
        if m <= fit * 1.02 { fitAgain(); return }
        zoom(to: m, keeping: p, at: v)
    }

    override func cancelOperation(_ sender: Any?) { if onEscape?() != true { super.cancelOperation(sender) } }

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

    override func resetCursorRects() { for r in uncovered(bounds) { addCursorRect(r, cursor: zoomed ? .arrow : .pointingHand) } }
}

/// A picture of the grid: the whole card is one button (the picture, its
/// name and when), the picture shown whole on a dark well (never cropped),
/// a spinner until it arrives, lit on hover, ringed when it is the one the
/// keyboard is on or the viewer came from.
final class GalleryCard: Box {
    var image: NSImage? { didSet { well.needsDisplay = true; spin.isHidden = image != nil || failed; if image != nil { spin.stopAnimation(nil) } } }
    var failed = false { didSet { spin.isHidden = image != nil || failed; well.needsDisplay = true } }
    var lit = false { didSet { restyle() } }
    var onOpen: (() -> Void)?
    let well = PictureWell()
    let caption = Flipped()
    private let spin = NSProgressIndicator()
    private var hovering = false { didSet { restyle() } }
    /// Its picture is on its way (the spinner shows).
    var loading: Bool { image == nil && !failed && !spin.isHidden }

    init(name: String, when: String?) {
        super.init(fill: "card", ring: "sep", radius: 10)
        layer?.masksToBounds = true
        addSubview(well)
        addSubview(caption)
        spin.style = .spinning
        spin.controlSize = .small
        spin.isDisplayedWhenStopped = false
        spin.startAnimation(nil)
        well.addSubview(spin)
        let nm = label(name, Fonts.pt(12.5, .semibold))
        let wh = when.map { label($0, Fonts.pt(12), "tx2") }
        let st = vstack([nm, wh], spacing: 2, insets: NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10))
        st.translatesAutoresizingMaskIntoConstraints = true
        st.autoresizingMask = [.width, .height]
        caption.addSubview(st)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(t("gallery.open", ["name": name]))
        restyle()
    }
    required init?(coder: NSCoder) { fatalError() }

    func place(_ r: NSRect, pictureHeight ih: CGFloat) {
        frame = r
        well.frame = NSRect(x: 0, y: 0, width: r.width, height: ih)
        caption.frame = NSRect(x: 0, y: ih, width: r.width, height: r.height - ih)
        caption.subviews.first?.frame = caption.bounds
        spin.frame = NSRect(x: (r.width - 16) / 2, y: (ih - 16) / 2, width: 16, height: 16)
    }

    private func restyle() {
        ring = lit ? "work" : hovering ? "tx3" : "sep"
        ringWidth = lit ? 2 : 1
        well.bright = hovering
        caption.wantsLayer = true
        effectiveAppearance.performAsCurrentDrawingAppearance { caption.layer?.backgroundColor = hovering ? Design.color("sel").cgColor : nil }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for t in trackingAreas { removeTrackingArea(t) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with e: NSEvent) { hovering = true }
    override func mouseExited(with e: NSEvent) { hovering = false }
    override func resetCursorRects() { handCursor() }
    override func hitTest(_ p: NSPoint) -> NSView? { super.hitTest(p) == nil ? nil : self }
    override func mouseDown(with e: NSEvent) { onOpen?() }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { onOpen?(); return true }
    func press() { onOpen?() }
}

/// The picture whole inside its well (aspect fit, centred), on a dark ground.
final class PictureWell: NSView {
    var bright = false { didSet { needsDisplay = true } }
    override var isFlipped: Bool { true }
    private var card: GalleryCard? { superview as? GalleryCard }
    override func draw(_ r: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            Design.color("term-bg").setFill()
            bounds.fill()
            guard let c = card else { return }
            if c.failed {
                let s = NSAttributedString(string: t("gallery.notLoaded"), attributes: [.font: Fonts.pt(12), .foregroundColor: Design.color("tx3")])
                let z = s.size()
                s.draw(at: NSPoint(x: (bounds.width - z.width) / 2, y: (bounds.height - z.height) / 2))
                return
            }
            guard let img = c.image, img.size.width > 0, img.size.height > 0 else { return }
            let k = min(bounds.width / img.size.width, bounds.height / img.size.height)
            let w = img.size.width * k, h = img.size.height * k
            let dst = NSRect(x: (bounds.width - w) / 2, y: (bounds.height - h) / 2, width: w, height: h).integral
            NSGraphicsContext.current?.imageInterpolation = .high
            img.draw(in: dst, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            if bright { NSColor.white.withAlphaComponent(0.06).setFill(); dst.fill(using: .sourceOver) }
        }
    }
}

/// The pictures the gallery has fetched: small copies for the grid and the
/// strip (decoded off the main thread, at most 640 px), whole ones for the
/// viewer, each list kept to its size (the oldest used goes first), at most
/// four requests at a time, the ones on screen first.
final class PictureCache {
    weak var hub: HubClient?
    private(set) var small: [String: NSImage] = [:]
    private(set) var large: [String: NSImage] = [:]
    private(set) var failed = Set<String>()
    private var order: [String] = []
    private var bigOrder: [String] = []
    private var inFlight = Set<String>()
    private var queue: [(url: String, big: Bool)] = []
    /// Every URL asked of the hub, in order (the self-test reads it).
    private(set) var fetched: [String] = []
    var changed: ((String) -> Void)?
    let keepSmall = 120, keepLarge = 6, atOnce = 4

    /// The self-test's: the whole copies let go, as when newer ones pushed them out (a picture opens on its small copy first again).
    func dropLarge() { large = [:]; bigOrder = [] }

    func smallImage(_ u: String) -> NSImage? { if let i = small[u] { touch(u, big: false); return i }; return nil }
    func largeImage(_ u: String) -> NSImage? { if let i = large[u] { touch(u, big: true); return i }; return nil }

    /// Asks for these, first ones first; what is already queued and not wanted any more waits behind them.
    func want(_ urls: [String], big: Bool) {
        let fresh = urls.filter { u in (big ? large[u] : small[u]) == nil && !failed.contains(u) && !inFlight.contains(u + (big ? "#L" : "")) }
        queue.removeAll { q in q.big == big && fresh.contains(q.url) }
        queue.insert(contentsOf: fresh.map { ($0, big) }, at: 0)
        pump()
    }

    private func pump() {
        while inFlight.count < atOnce, !queue.isEmpty {
            let (u, big) = queue.removeFirst()
            let key = u + (big ? "#L" : "")
            guard !inFlight.contains(key), (big ? large[u] : small[u]) == nil else { continue }
            // A big one already here makes the small one at once.
            if !big, let L = large[u] { put(u, Self.thumb(L), big: false); continue }
            guard let hub else { return }
            inFlight.insert(key)
            fetched.append(u)
            hub.data(u) { [weak self] d in
                guard let d else { self?.done(key, u, nil, big: big); return }
                DispatchQueue.global(qos: .userInitiated).async {
                    let img = big ? Self.whole(d) : Self.thumb(d)
                    DispatchQueue.main.async { self?.done(key, u, img, big: big) }
                }
            }
        }
    }

    private func done(_ key: String, _ u: String, _ img: NSImage?, big: Bool) {
        inFlight.remove(key)
        if let img { put(u, img, big: big) } else { failed.insert(u) }
        changed?(u)
        pump()
    }

    private func put(_ u: String, _ img: NSImage, big: Bool) {
        if big { large[u] = img } else { small[u] = img }
        touch(u, big: big)
        let keep = big ? keepLarge : keepSmall
        var list = big ? bigOrder : order
        while list.count > keep { let gone = list.removeFirst(); if big { large[gone] = nil } else { small[gone] = nil } }
        if big { bigOrder = list } else { order = list }
    }

    private func touch(_ u: String, big: Bool) {
        if big { bigOrder.removeAll { $0 == u }; bigOrder.append(u) } else { order.removeAll { $0 == u }; order.append(u) }
    }

    /// The whole picture, its size in points its size in pixels (a Retina
    /// shot's 144 dpi aside), set once here: a drawn NSImage keeps copies
    /// of itself at the sizes it was drawn (a small picture drawn at 2x
    /// gains a copy twice its pixels), so its representations are no
    /// measure of the picture once it has been shown.
    static func whole(_ d: Data) -> NSImage? {
        guard let img = NSImage(data: d) else { return nil }
        if let r = img.representations.first, r.pixelsWide > 0 { img.size = NSSize(width: r.pixelsWide, height: r.pixelsHigh) }
        return img
    }

    /// At most 640 px on its longer side, decoded now (not when first drawn).
    static func thumb(_ d: Data) -> NSImage? {
        guard let src = CGImageSourceCreateWithData(d as CFData, nil),
              let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 640, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        else { return whole(d) }
        return NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
    }
    static func thumb(_ i: NSImage) -> NSImage { i.tiffRepresentation.flatMap { thumb($0) } ?? i }
}

final class GalleryPage: InAppPage {
    var hub: HubClient? { didSet { cache.hub = hub } }
    var toast: ((String) -> Void)?
    private(set) var project = ""
    /// The picture shown large, else the grid; `lit` the card the keyboard is on (the one the viewer came from).
    private(set) var at: Int?
    private(set) var lit: Int?
    private(set) var pics: [GalleryPic] = []
    let cache = PictureCache()
    private let grid = NSScrollView()
    private let gridDoc = Flipped()
    private(set) var cards: [GalleryCard] = []
    private var empty: NSTextField?
    let zoom = ZoomView()
    private let vbar = Flipped()
    private let strip = NSScrollView()
    private let stripDoc = Flipped()
    private(set) var thumbs: [FitImage] = []
    private var drawn = ""
    private var name = ""
    private var revealing = false
    /// Columns of the grid as last laid out (the up and down arrows).
    private(set) var cols = 1

    override init() {
        super.init()
        grid.drawsBackground = false
        grid.hasVerticalScroller = true
        grid.autohidesScrollers = true
        grid.scrollerStyle = .overlay
        grid.automaticallyAdjustsContentInsets = false
        grid.documentView = gridDoc
        grid.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: grid.contentView)
        strip.drawsBackground = false
        strip.hasHorizontalScroller = true
        strip.autohidesScrollers = true
        strip.scrollerStyle = .overlay
        strip.automaticallyAdjustsContentInsets = false
        strip.documentView = stripDoc
        for v in [grid, zoom, vbar, strip] as [NSView] { body.addSubview(v) }
        cache.changed = { [weak self] u in self?.arrived(u) }
        zoom.onEscape = { [weak self] in self?.escape() ?? false }
    }
    required init?(coder: NSCoder) { fatalError() }

    /// Shows a project's gallery (at nil) or one of its pictures large; the
    /// grid opened afresh rings its first card (the keyboard starts there).
    func show(_ pid: String, at i: Int?, lit l: Int? = nil, state: HubState?) {
        if pid != project { drawn = ""; project = pid }
        let p = state?.project(pid)
        name = p?.name ?? pid
        pics = GalleryPic.of(p)
        at = i.map { max(0, min(pics.count - 1, $0)) }
        if pics.isEmpty { at = nil }
        lit = l ?? (i == nil && !pics.isEmpty ? 0 : nil)
        draw()
        takeKeys()
    }

    /// The hub's state again: drawn again only when the list changed. The
    /// picture shown and the card ringed are followed through the new list
    /// (a new picture goes first and moves every other one along); the one
    /// shown stays, at its place, even when it has left the list (the
    /// session's oldest, pushed out by a new one).
    func refresh(_ state: HubState?) {
        let shown = at.flatMap { pics.indices.contains($0) ? pics[$0] : nil }
        let ringed = lit.flatMap { pics.indices.contains($0) ? pics[$0] : nil }
        pics = GalleryPic.of(state?.project(project))
        if let a = at, let x = shown {
            if let i = place(of: x) { at = i } else { at = min(a, pics.count); pics.insert(x, at: at!) }
        } else if let a = at { at = pics.isEmpty ? nil : min(a, pics.count - 1) }
        if let l = lit { lit = pics.isEmpty ? nil : ringed.flatMap { place(of: $0) } ?? min(l, pics.count - 1) }
        draw()
    }

    /// Where a picture is in the list now: by its URL, else its key (a session's picture whose file changed), else a brief's by its name.
    private func place(of x: GalleryPic) -> Int? {
        if let i = pics.firstIndex(where: { $0.url == x.url }) { return i }
        if let k = x.key, let i = pics.firstIndex(where: { $0.key == k }) { return i }
        return x.fromBrief ? pics.firstIndex { $0.fromBrief && $0.name == x.name } : nil
    }

    /// The page takes the keyboard when it shows (a page in front, not the terminal behind it).
    private func takeKeys() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let w = self.window, !self.isHidden else { return }
            if !(w.firstResponder is NSTextView) { w.makeFirstResponder(self) }
        }
    }

    private func arrived(_ u: String) {
        if let i = at, pics.indices.contains(i), pics[i].url == u, let L = cache.largeImage(u) { zoom.show(u, L) }
        for (k, x) in pics.enumerated() where x.url == u {
            if k < cards.count { cards[k].image = cache.smallImage(u); cards[k].failed = cache.failed.contains(u) }
            if k < thumbs.count { thumbs[k].image = cache.smallImage(u) }
        }
        // The viewer's picture while its whole copy is still on its way: the small one, never black.
        if let i = at, pics.indices.contains(i), pics[i].url == u, cache.largeImage(u) == nil, let s = cache.smallImage(u), zoom.picture.image == nil { zoom.show(u, s) }
    }

    private func draw() {
        let sig = "\(project)|\(at ?? -1)|\(lit ?? -1)|\(revealing)|" + pics.map { $0.url + ($0.at ?? "") + $0.name }.joined(separator: ",")
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

    func go(_ i: Int?, lit l: Int? = nil) {
        at = i
        lit = l ?? lit
        draw()
        takeKeys()
        if i == nil { DispatchQueue.main.async { [weak self] in self?.revealLit() } }
    }

    private func drawGrid() {
        gridDoc.subviews.forEach { $0.removeFromSuperview() }
        cards = []; empty = nil
        if pics.isEmpty {
            let e = label(t("gallery.none"), Fonts.pt(13), "tx2", lines: 2)
            e.translatesAutoresizingMaskIntoConstraints = true
            empty = e
            gridDoc.addSubview(e)
            return
        }
        for (i, x) in pics.enumerated() {
            let c = GalleryCard(name: x.name, when: x.when)
            c.image = cache.smallImage(x.url)
            c.failed = cache.failed.contains(x.url)
            c.lit = i == lit
            c.onOpen = { [weak self] in self?.lit = i; self?.go(i) }
            gridDoc.addSubview(c)
            cards.append(c)
        }
    }

    /// The cards on screen (and a screen below) asked for first, the rest after.
    @objc private func scrolled() { loadVisible() }
    private func loadVisible() {
        guard at == nil, !cards.isEmpty else { return }
        let vis = grid.contentView.bounds.insetBy(dx: 0, dy: -grid.contentView.bounds.height * 0.5)
        let urls = cards.enumerated().filter { $0.element.frame.intersects(vis) }.map { pics[$0.offset].url }
        cache.want(urls, big: false)
    }

    private func drawViewer(_ i: Int) {
        let x = pics[i]
        zoom.show(x.url, cache.largeImage(x.url) ?? cache.smallImage(x.url))
        cache.want([x.url], big: true)
        // The neighbours next, so Previous and Next show at once.
        cache.want([i + 1, i - 1].filter { pics.indices.contains($0) }.map { pics[$0].url }, big: true)
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
            let c = FitImage()
            c.image = cache.smallImage(y.url)
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
        cache.want(pics.map { $0.url }, big: false)
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

    // MARK: the keyboard

    override var acceptsFirstResponder: Bool { true }
    override func keyDown(with e: NSEvent) {
        let cmd = e.modifierFlags.contains(.command)
        if let i = at {
            switch e.keyCode {
            case 123: if i > 0 { go(i - 1) }; return
            case 124: if i < pics.count - 1 { go(i + 1) }; return
            case 53: if escape() { return }
            default:
                let ch = e.charactersIgnoringModifiers ?? ""
                if ch == "+" || ch == "=" { zoom.zoomStep(1.5); return }
                if ch == "-" { zoom.zoomStep(1 / 1.5); return }
                if ch == "0" { zoom.fitAgain(); return }
            }
        } else if !pics.isEmpty && !cmd {
            let l = lit ?? 0
            switch e.keyCode {
            case 123: move(to: l - 1); return
            case 124: move(to: l + 1); return
            case 126: move(to: l - cols); return
            case 125: move(to: l + cols); return
            case 36, 76, 49: go(l, lit: l); return
            default: break
            }
        }
        super.keyDown(with: e)
    }

    /// Escape in the viewer: a zoomed picture fitted again, else back to the grid. False when it had nothing to do.
    @discardableResult func escape() -> Bool {
        guard let i = at else { return false }
        if zoom.zoomed { zoom.fitAgain(); return true }
        go(nil, lit: i)
        return true
    }
    override func cancelOperation(_ sender: Any?) { if !escape() { super.cancelOperation(sender) } }

    private func move(to k: Int) {
        guard !cards.isEmpty else { return }
        let n = max(0, min(cards.count - 1, k))
        lit = n
        for (i, c) in cards.enumerated() { c.lit = i == n }
        drawn = ""
        draw()
        revealLit()
    }

    private func revealLit() {
        guard at == nil, let l = lit, l < cards.count else { return }
        cards[l].scrollToVisible(cards[l].bounds.insetBy(dx: 0, dy: -14))
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
            cols = max(1, Int((w + gap) / (200 + gap)))
            let cw = (w - gap * CGFloat(cols - 1)) / CGFloat(cols)
            let ih = (cw * 10 / 16).rounded()
            let ch = ih + 52
            for (i, c) in cards.enumerated() {
                let r = i / cols, k = i % cols
                c.place(NSRect(x: pad + CGFloat(k) * (cw + gap), y: CGFloat(r) * (ch + gap), width: cw, height: ch), pictureHeight: ih)
            }
            let rows = (cards.count + cols - 1) / cols
            gridDoc.frame = NSRect(x: 0, y: 0, width: b.width, height: max(b.height, CGFloat(rows) * (ch + gap) + 6))
            loadVisible()
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

/// A strip thumbnail: the picture whole on the dark ground, in rounded corners; dimmed unless it is the one shown.
final class FitImage: NSView {
    var image: NSImage? { didSet { needsDisplay = true } }
    var dim: CGFloat = 1 { didSet { needsDisplay = true } }
    /// A video's first frame: the play mark over it (PickVideo.swift).
    var playMark = false { didSet { needsDisplay = true } }
    var onClick: (() -> Void)?
    override var isFlipped: Bool { true }
    override func draw(_ r: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).addClip()
            Design.color("term-bg").setFill()
            bounds.fill()
            defer { if playMark { drawPlayMark(in: bounds, size: min(22, bounds.height * 0.42)) } }
            guard let img = image, img.size.width > 0, img.size.height > 0 else { return }
            let k = min(bounds.width / img.size.width, bounds.height / img.size.height)
            let w = img.size.width * k, h = img.size.height * k
            img.draw(in: NSRect(x: (bounds.width - w) / 2, y: (bounds.height - h) / 2, width: w, height: h), from: .zero, operation: .sourceOver, fraction: dim, respectFlipped: true, hints: nil)
        }
    }
    override func mouseDown(with e: NSEvent) { onClick?() }
    override func resetCursorRects() { handCursor(onClick != nil) }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { onClick?(); return true }
}
