// What the window shows, in pixels, for the self-test: the window server's
// own picture of the window (what a person sees, an offscreen window
// included), and the pick's check that its pictures and head are drawn there.
//
// CGWindowListCreateImage is looked up at run time: the SDK marks it
// unavailable, the system still has it, and a process may take its own
// windows' picture without the screen recording permission. Where it is
// missing, the views are drawn again (cacheDisplay), which can come out
// blank for a scroll view's content (the picker's, the first time).

import AppKit

private typealias WindowListCreateImage = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
private let windowListCreateImage: WindowListCreateImage? = {
    guard let h = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW), let f = dlsym(h, "CGWindowListCreateImage") else { return nil }
    return unsafeBitCast(f, to: WindowListCreateImage.self)
}()

extension SelfTestBoard {
    /// The window as the window server composes it (2x, the frame without
    /// its shadow), or nil.
    func windowImage() -> CGImage? {
        // kCGWindowListOptionIncludingWindow, kCGWindowImageBoundsIgnoreFraming | kCGWindowImageBestResolution
        windowListCreateImage?(.null, 8, UInt32(window.windowNumber), 1 | 8)?.takeRetainedValue()
    }

    /// RGBA bytes of `img` scaled to w x h.
    private func rgba(_ img: CGImage, _ w: Int, _ h: Int, crop: CGRect? = nil) -> [UInt8] {
        var px = [UInt8](repeating: 0, count: w * h * 4)
        px.withUnsafeMutableBytes { b in
            guard let ctx = CGContext(data: b.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
            ctx.interpolationQuality = .medium
            let src = crop.flatMap { img.cropping(to: $0) } ?? img
            ctx.draw(src, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        return px
    }

    /// Whether the pick's pictures and its question are drawn in the window
    /// a person sees: each picture's place matches the
    /// picture the hub sent drawn there as the picker draws it (cover,
    /// centred), 48 points wide, in at least 60% of its points (the letter, a ring and its
    /// note cover the rest), and the question's line is not one colour.
    func pickDrawn(_ pk: PickerView) -> (ok: Bool, detail: String) {
        window.contentView?.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        settle(0.2)
        guard let root = window.contentView, pk.window === window, !pk.isHiddenOrHasHiddenAncestor else { return (false, "the picker is not in the window") }
        let shot = windowImage()
        var img = shot
        if img == nil, let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) { root.cacheDisplay(in: root.bounds, to: rep); img = rep.cgImage }
        guard let win = img else { return (false, "no picture of the window") }
        let k = CGFloat(win.width) / max(1, root.bounds.width)
        // A view's place in the picture (top-left origin, pixels).
        func place(_ v: NSView) -> CGRect {
            let r = v.convert(v.bounds, to: root)
            let y = root.isFlipped ? r.minY : root.bounds.height - r.maxY
            return CGRect(x: r.minX * k, y: y * k, width: r.width * k, height: r.height * k).integral
        }
        var parts: [String] = []
        var ok = pk.images.count >= 2
        for (i, v) in pk.images.enumerated() {
            guard let pic = v.image, let cg = pic.cgImage(forProposedRect: nil, context: nil, hints: nil), v.bounds.width > 20, v.bounds.height > 20 else { ok = false; parts.append("\(i): no picture"); continue }
            let r = place(v)
            let W = 48, H = max(8, Int((48 * r.height / max(1, r.width)).rounded()))
            let seen = rgba(win, W, H, crop: r)
            // The picture as PickImage.draw puts it: cover, centred.
            var want = [UInt8](repeating: 0, count: W * H * 4)
            want.withUnsafeMutableBytes { b in
                guard let ctx = CGContext(data: b.baseAddress, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
                let s = max(CGFloat(W) / pic.size.width, CGFloat(H) / pic.size.height)
                let w = pic.size.width * s, h = pic.size.height * s
                ctx.draw(cg, in: CGRect(x: (CGFloat(W) - w) / 2, y: (CGFloat(H) - h) / 2, width: w, height: h))
            }
            var same = 0
            for p in 0..<(W * H) {
                let d = (0..<3).map { abs(Int(seen[p * 4 + $0]) - Int(want[p * 4 + $0])) }.max() ?? 255
                if d <= 40 { same += 1 }
            }
            let frac = Double(same) / Double(W * H)
            if frac < 0.6 { ok = false }
            parts.append("\(i): \(Int(frac * 100))% as sent")
        }
        // The question (the head's first multi-line label): drawn, not one colour.
        if let head = pk.scroll.stack.arrangedSubviews.first {
            let labels = allSubviews(head).compactMap { $0 as? NSTextField }.filter { !$0.stringValue.isEmpty && ($0.font?.pointSize ?? 0) >= 18 }
            if let q = labels.first {
                let px = rgba(win, 64, 8, crop: place(q))
                let first = Array(px[0..<3])
                let varied = stride(from: 0, to: px.count, by: 4).filter { p in (0..<3).contains { abs(Int(px[p + $0]) - Int(first[$0])) > 60 } }.count
                if varied < 8 { ok = false }
                parts.append("question \"\(q.stringValue.prefix(30))\": \(varied) of 512 points not the background")
            } else { ok = false; parts.append("no question line") }
        } else { ok = false; parts.append("no head") }
        return (ok, (shot == nil ? "views drawn again (no window server picture); " : "window server picture; ") + parts.joined(separator: ", "))
    }

    private func allSubviews(_ v: NSView) -> [NSView] { v.subviews + v.subviews.flatMap { allSubviews($0) } }
}
