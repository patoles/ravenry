// Ink, the launch's animation (Simon, 2026-11-08: "if we can support some
// shader like Ghostty does it would be nice, for example we could have an
// animation on first launch"; he picked Ink from the mockup's three): pale
// ink gathers into the raven, its eye opens with one ripple, and the mark
// flies to the app's icon on New session while the window washes in.
//
// - When: a launch with no tab to bring back (Workspace.restoredNone) opens
//   on New session, and Ink plays over it; never when tabs come back, with
//   Settings > Appearance > Opening off (`launchInk`), or with Reduce motion
//   on in macOS (or RAVENRY_MAC_REDUCE_MOTION=1 for a check).
// - It never holds the window: the overlay takes no click (hitTest nil),
//   and any click or key (an event monitor of the app's) ends it at once
//   and goes on to what is under it, the start screen.
// - The shader is Ghostty-format GLSL ported to MSL (Shaders.swift); its
//   iChannel0 is the window itself (its views drawn into a picture, at the
//   start, on a resize, when what it shows changed and at the end), and where the mark
//   lands is the start screen's real icon, read from the views each frame.
//   The last frame is the window's own picture, then the overlay goes.
// - Off every screen it plays only for its own check (RAVENRY_MAC_INK=1,
//   scripts/inkcheck.mjs), so the bench and the other self-tests see the
//   launch as before; there it draws into a texture of its own.

import AppKit
import Metal
import QuartzCore

/// What the launch decided and what Ink did (the self-test reads it).
final class InkRecord {
    var decided = ""
    var played = 0
    /// iTime of each frame drawn, this play.
    var times: [Double] = []
    var ended: String?
    var endedAt: Double = 0
    var snapshots = 0
    var snapshotMs: [Double] = []
    /// When each picture was taken (seconds into Ink) and why.
    var snapshotAt: [String] = []
    var frameMs: [Double] = []
    /// Off every screen: the last frame drawn, and the window right after Ink ended (BGRA, top row first).
    var lastFrame: [UInt8]?
    var afterEnd: (bytes: [UInt8], w: Int, h: Int)?
}

enum InkLaunch {
    static let record = InkRecord()
    static weak var current: InkOverlay?
    private static var env: [String: String] { ProcessInfo.processInfo.environment }

    /// Reduce motion in macOS (Accessibility > Display), or the check's stand-in.
    static var reduceMotion: Bool {
        if let v = env["RAVENRY_MAC_REDUCE_MOTION"], !v.isEmpty { return v == "1" }
        return NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    /// Off every screen, only for Ink's own check.
    static func applies(offscreen: Bool) -> Bool { !offscreen || env["RAVENRY_MAC_INK"] == "1" }

    /// The first window, just restored: New session and Ink when no tab came back.
    static func atLaunch(_ rw: RavenryWindow, offscreen: Bool) {
        guard applies(offscreen: offscreen) else { return }
        guard rw.ws.restoredNone else { record.decided = "tabs restored"; return }
        rw.board.openStart(nil)
        if !rw.ws.settings.bool("launchInk") { record.decided = "setting off"; return }
        if reduceMotion { record.decided = "reduced motion"; return }
        record.decided = "play"
        play(on: rw, offscreen: offscreen)
    }

    /// Plays Ink over the window now (the launch, or the check again).
    @discardableResult
    static func play(on rw: RavenryWindow, offscreen: Bool) -> InkOverlay? {
        current?.finish("replaced")
        guard let root = rw.window.contentView, let o = InkOverlay(board: rw.board, offscreen: offscreen) else {
            record.decided += " (no Metal)"
            return nil
        }
        o.frame = root.bounds
        o.autoresizingMask = [.width, .height]
        root.addSubview(o, positioned: .above, relativeTo: nil)
        current = o
        o.begin()
        return o
    }
}

final class InkOverlay: NSView {
    static let duration = 3.4
    /// The window's picture from its layers (CALayer.render, 54 to 60 ms for the
    /// window at 1440 x 900 pt at 2x), not drawn again by each view
    /// (cacheDisplay, 105 to 111 ms): the same pixels.
    static var pictureByLayer = ProcessInfo.processInfo.environment["RAVENRY_MAC_INK_PICTURE"] != "cache"
    /// What the window shows changes once the hub and New session's folders
    /// answer: the picture is taken again then, while the ink is still
    /// gathering (before 2 s; after, at the end only), so no frame of the
    /// mark's flight waits for one.
    static let refreshBefore = 2.0
    weak var board: Board?
    let offscreen: Bool
    private let metal = CAMetalLayer()
    private let host = ShaderHost.shared
    private let queue: MTLCommandQueue
    private var snapshot: MTLTexture?
    /// The picture's pixels (the colour around the icon is read from them).
    private var snapBytes: [UInt8] = []
    private var snapSize = (w: 0, h: 0)
    private var needSnapshot = true
    /// What the window showed at the last picture (New session's folders, the hub's state).
    private var shownSig = ""
    private var earlyRefresh = false
    /// Off every screen: the frames go here (the check reads the last one).
    private(set) var target: MTLTexture?
    private var began: CFTimeInterval = 0
    private var last: CFTimeInterval = 0
    private var timer: Timer?
    private var link: AnyObject?
    private var monitor: Any?
    private(set) var done = false
    var onEnd: ((String) -> Void)?
    /// For the pictures: a fixed iTime instead of the clock.
    private var scale: CGFloat { window?.backingScaleFactor ?? 2 }

    init?(board: Board?, offscreen: Bool) {
        guard let dev = host.device, let q = dev.makeCommandQueue(), host.pipeline(.ink) != nil else { return nil }
        self.board = board
        self.offscreen = offscreen
        queue = q
        super.init(frame: .zero)
        wantsLayer = true
        layerContentsRedrawPolicy = .never
        metal.device = dev
        metal.pixelFormat = .bgra8Unorm
        metal.framebufferOnly = true
        metal.isOpaque = true
        metal.maximumDrawableCount = 3
        metal.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
        metal.backgroundColor = CGColor(srgbRed: 0.043, green: 0.043, blue: 0.047, alpha: 1)
        setAccessibilityElement(false)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func makeBackingLayer() -> CALayer { metal }
    override var isFlipped: Bool { true }
    override var isOpaque: Bool { true }
    /// Never in the way: a click goes to what is under it (and ends Ink).
    override func hitTest(_ p: NSPoint) -> NSView? { nil }

    override func setFrameSize(_ s: NSSize) {
        let was = frame.size
        super.setFrameSize(s)
        if s != was { needSnapshot = true }
    }

    func begin() {
        began = CACurrentMediaTime()
        last = began
        InkLaunch.record.played += 1
        InkLaunch.record.times = []
        InkLaunch.record.ended = nil
        // Any click or key ends it and goes on (returned as it came).
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown]) { [weak self] e in
            self?.finish(e.type == .keyDown ? "key" : "click")
            return e
        }
        tick()
        if !offscreen, #available(macOS 14.0, *) {
            let l = displayLink(target: self, selector: #selector(tick))
            l.add(to: .main, forMode: .common)
            link = l
        } else {
            let t = Timer(timeInterval: 1.0 / 60, target: self, selector: #selector(tick), userInfo: nil, repeats: true)
            RunLoop.main.add(t, forMode: .common)
            timer = t
        }
    }

    @objc private func tick() {
        guard !done else { return }
        guard window != nil, bounds.width > 1, bounds.height > 1 else { finish("no window"); return }
        // New session left (Esc, which the board's own key watch takes
        // before this one sees it, a menu, a tab): Ink ends with it.
        if let b = board, b.front != .start { finish("left"); return }
        // Kept over whatever the board put on the window since (a toast).
        if let sv = superview, sv.subviews.last !== self { sv.addSubview(self, positioned: .above, relativeTo: nil) }
        let now = CACurrentMediaTime()
        let t = now - began
        let sig = shownSignature()
        if sig != shownSig && t < InkOverlay.refreshBefore { needSnapshot = true }
        // Once more early on, while the ink is faint, for what the launch drew since.
        if t >= 0.25 && !earlyRefresh { earlyRefresh = true; needSnapshot = true }
        // The end: the window as it is now, drawn as the last frame, then the window itself.
        if t >= InkOverlay.duration { needSnapshot = true }
        if needSnapshot { takeSnapshot() }
        let t0 = CACurrentMediaTime()
        draw(at: min(t, InkOverlay.duration), delta: now - last)
        InkLaunch.record.frameMs.append((CACurrentMediaTime() - t0) * 1000)
        InkLaunch.record.times.append(min(t, InkOverlay.duration))
        last = now
        if t >= InkOverlay.duration { finish("done") }
    }

    /// Ends Ink: the overlay goes and the window shows as it is.
    func finish(_ why: String) {
        guard !done else { return }
        done = true
        InkLaunch.record.ended = why
        InkLaunch.record.endedAt = CACurrentMediaTime() - began
        timer?.invalidate()
        timer = nil
        if #available(macOS 14.0, *), let l = link as? CADisplayLink { l.invalidate() }
        link = nil
        if let m = monitor { NSEvent.removeMonitor(m) }
        monitor = nil
        if offscreen {
            InkLaunch.record.lastFrame = lastFrameBytes()
            InkLaunch.record.afterEnd = windowPicture()
        }
        removeFromSuperview()
        onEnd?(why)
    }

    // MARK: the window as a picture (iChannel0)

    private var pixelSize: (w: Int, h: Int) {
        (max(1, Int((bounds.width * scale).rounded())), max(1, Int((bounds.height * scale).rounded())))
    }

    /// The window's views drawn into a picture (sRGB, the layer's colour
    /// space), without this overlay: the start screen, the strip, the sidebar.
    func windowPicture() -> (bytes: [UInt8], w: Int, h: Int)? {
        guard let root = superview ?? window?.contentView else { return nil }
        let was = isHidden
        isHidden = true
        defer { isHidden = was }
        root.layoutSubtreeIfNeeded()
        // The views' layers drawn first (at launch none has been yet).
        root.displayIfNeeded()
        let (w, h) = pixelSize
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        guard let cs = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        // (Before the window's first display the root may have no layer yet: then drawn by its views.)
        let viaLayer = InkOverlay.pictureByLayer && root.layer != nil
        var base: CGImage?
        if !viaLayer {
            guard let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { return nil }
            root.cacheDisplay(in: root.bounds, to: rep)
            base = rep.cgImage
        }
        let ok = bytes.withUnsafeMutableBytes { buf -> Bool in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return false }
            var bg = CGColor(gray: 0, alpha: 1)
            if let win = window { win.effectiveAppearance.performAsCurrentDrawingAppearance { bg = (win.backgroundColor.usingColorSpace(.sRGB) ?? .black).cgColor } }
            ctx.setFillColor(bg)
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            if viaLayer, let l = root.layer {
                let s = CGFloat(w) / max(1, root.bounds.width)
                if root.isFlipped { ctx.translateBy(x: 0, y: CGFloat(h)); ctx.scaleBy(x: s, y: -s) } else { ctx.scaleBy(x: s, y: s) }
                l.render(in: ctx)
            } else if let b = base {
                ctx.draw(b, in: CGRect(x: 0, y: 0, width: w, height: h))
            } else { return false }
            return true
        }
        return ok ? (bytes, w, h) : nil
    }

    /// A cheap mark of what the window shows (taking its picture is not cheap).
    private func shownSignature() -> String {
        guard let b = board else { return "" }
        return "\(b.front)|\(b.start.folders.count)|\(b.start.local)|\(b.start.folder ?? "")|\(b.hub.reachable)|\(b.hub.state?.projects.count ?? -1)|\(bounds.size)"
    }

    private func takeSnapshot() {
        needSnapshot = false
        shownSig = shownSignature()
        let t0 = CACurrentMediaTime()
        guard let p = windowPicture(), let dev = host.device else { needSnapshot = true; return }
        if snapshot == nil || snapshot!.width != p.w || snapshot!.height != p.h {
            let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: p.w, height: p.h, mipmapped: false)
            d.usage = [.shaderRead]
            snapshot = dev.makeTexture(descriptor: d)
        }
        p.bytes.withUnsafeBytes { snapshot?.replace(region: MTLRegionMake2D(0, 0, p.w, p.h), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: p.w * 4) }
        snapBytes = p.bytes
        snapSize = (p.w, p.h)
        InkLaunch.record.snapshots += 1
        InkLaunch.record.snapshotMs.append((CACurrentMediaTime() - t0) * 1000)
        InkLaunch.record.snapshotAt.append(String(format: "%.2f s %.0f ms", began > 0 ? t0 - began : 0, (CACurrentMediaTime() - t0) * 1000))
    }

    // MARK: where things are (window points, top-left origin)

    /// The start screen's icon, in this view.
    var iconRect: NSRect? {
        guard let b = board, let icon = b.start.iconView, icon.window != nil, !icon.isHiddenOrHasHiddenAncestor else { return nil }
        let r = icon.convert(icon.bounds, to: self)
        return r.width > 1 ? r : nil
    }

    /// iLayout: the window, the mark in the middle, the mark on the icon, the icon's tile, the colour around it.
    func layoutValues() -> [SIMD4<Float>] {
        let W = bounds.width, H = bounds.height
        let unitA = 4.1 * min(H / 700, W / 1120)
        let a = SIMD4<Float>(Float(W / 2), Float(H / 2 - 8), Float(unitA), 0)
        let g = GhosttyShader.iconGlyph, gc = GhosttyShader.glyphCentre
        var b = SIMD4<Float>(Float(W / 2), Float(H * 0.3), Float(unitA / 6), 0)
        var tile = SIMD4<Float>(-1000, -1000, 0, 0)
        var around = SIMD4<Float>(0.118, 0.118, 0.129, 0)
        if let r = iconRect {
            let side = r.width
            let unit = side * g.scale / 1024
            b = SIMD4(Float(r.minX + side * g.x / 1024 + CGFloat(gc.x) * unit), Float(r.minY + side * g.y / 1024 + CGFloat(gc.y) * unit), Float(unit), 0)
            tile = SIMD4(Float(r.midX), Float(r.midY), Float(side / 2), Float(15 * side / 64))
            if let c = pixel(at: NSPoint(x: r.minX - 6, y: r.midY)) { around = c }
        }
        return [SIMD4(Float(W), Float(H), 0, 0), a, b, tile, around]
    }

    /// The picture's colour at a point of this view.
    private func pixel(at p: NSPoint) -> SIMD4<Float>? {
        let s = CGFloat(snapSize.w) / max(1, bounds.width)
        let x = Int(p.x * s), y = Int(p.y * s)
        guard x >= 0, y >= 0, x < snapSize.w, y < snapSize.h, snapBytes.count == snapSize.w * snapSize.h * 4 else { return nil }
        let i = (y * snapSize.w + x) * 4
        return SIMD4(Float(snapBytes[i + 2]) / 255, Float(snapBytes[i + 1]) / 255, Float(snapBytes[i]) / 255, 1)
    }

    // MARK: drawing

    private func offscreenTarget(_ w: Int, _ h: Int) -> MTLTexture? {
        if let t = target, t.width == w, t.height == h { return t }
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: w, height: h, mipmapped: false)
        d.usage = [.renderTarget, .shaderRead]
        d.storageMode = .shared
        target = host.device?.makeTexture(descriptor: d)
        return target
    }

    /// One frame at iTime t: into the layer's drawable, or (off every screen) the texture of its own.
    private func draw(at t: Double, delta: Double) {
        guard let src = snapshot, let cb = queue.makeCommandBuffer() else { return }
        let (w, h) = pixelSize
        if offscreen {
            guard let dst = offscreenTarget(w, h) else { return }
            host.encode(.ink, source: src, into: dst, commandBuffer: cb, time: t, delta: delta, layout: layoutValues())
            cb.commit()
            cb.waitUntilCompleted()
            return
        }
        let size = CGSize(width: w, height: h)
        if metal.drawableSize != size { metal.drawableSize = size }
        metal.contentsScale = scale
        guard let d = metal.nextDrawable() else { return }
        host.encode(.ink, source: src, into: d.texture, commandBuffer: cb, time: t, delta: delta, layout: layoutValues())
        cb.present(d)
        cb.commit()
    }

    /// The frame at iTime t as a picture, the window drawn again first (the pictures, the check).
    func picture(at t: Double) -> CGImage? {
        takeSnapshot()
        let (w, h) = pixelSize
        guard let src = snapshot, let dst = offscreenTarget(w, h), let cb = queue.makeCommandBuffer() else { return nil }
        host.encode(.ink, source: src, into: dst, commandBuffer: cb, time: t, layout: layoutValues())
        cb.commit()
        cb.waitUntilCompleted()
        return InkOverlay.image(dst)
    }

    /// The last frame drawn off every screen, as bytes (BGRA, top row first).
    func lastFrameBytes() -> [UInt8]? {
        guard let t = target else { return nil }
        var b = [UInt8](repeating: 0, count: t.width * t.height * 4)
        t.getBytes(&b, bytesPerRow: t.width * 4, from: MTLRegionMake2D(0, 0, t.width, t.height), mipmapLevel: 0)
        return b
    }

    static func image(_ t: MTLTexture) -> CGImage? {
        var b = [UInt8](repeating: 0, count: t.width * t.height * 4)
        t.getBytes(&b, bytesPerRow: t.width * 4, from: MTLRegionMake2D(0, 0, t.width, t.height), mipmapLevel: 0)
        return image(b, t.width, t.height)
    }

    static func image(_ bytes: [UInt8], _ w: Int, _ h: Int) -> CGImage? {
        var b = bytes
        return b.withUnsafeMutableBytes { buf in
            CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)?.makeImage()
        }
    }
}
