// The launch: the Mac's Ink on the iPhone (docs/PHONE.md, The launch). The
// Mac app's shader (apps/macos Shaders.swift, compiled from its source as
// is) plays over the app on a cold start, 3.4 s: pale ink gathers into the
// raven, its eye opens with one ripple, the mark flies to the board's top
// bar mark while the board washes in from there. In the board's own colours:
// dark is the board's window (#161618, not the Mac's black), light mixes
// the glows in rather than adding them (as the Android port does). Its
// input is a picture of the board taken when the board says where its mark
// is (ink.ready); until then the ink holds on the formed raven at 2.15 s,
// with "Reaching your Mac..." under it. Any touch ends it; with Reduce
// Motion on there is none.

import UIKit
import Metal
import QuartzCore

final class InkLaunch {
    static let duration = 3.4
    static let formed = 2.15

    private let view: InkView
    private let layer: CAMetalLayer
    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private let pipe: MTLRenderPipelineState
    private var source: MTLTexture
    private var link: CADisplayLink?
    private var began = CACurrentMediaTime()
    private var last = CACurrentMediaTime()
    private var heldFor = 0.0
    private var isReady = false
    private var layout: [SIMD4<Float>]
    private let dark: Bool
    private let label = UILabel()
    private var done = false
    private var frames: [Double] = []
    var onEnd: () -> Void = {}

    static var reduceMotion: Bool { UIAccessibility.isReduceMotionEnabled || ProcessInfo.processInfo.environment["RAVENRY_REDUCE_MOTION"] == "1" }

    /// Starts over `root` on a cold start, or nil (Reduce Motion, no Metal).
    static func begin(over root: UIView, dark: Bool) -> InkLaunch? {
        if reduceMotion { Log.say("launch: still (Reduce Motion)"); return nil }
        guard let dev = MTLCreateSystemDefaultDevice(), let q = dev.makeCommandQueue(), let p = pipeline(dev, dark: dark) else { Log.say("launch: no Metal, no ink"); return nil }
        let ink = InkLaunch(root: root, device: dev, queue: q, pipe: p, dark: dark)
        Log.say("launch: ink (\(dark ? "dark" : "light"))")
        return ink
    }

    private static func rgb(_ key: String, dark: Bool) -> String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        Shared.color(key, dark: dark).getRed(&r, green: &g, blue: &b, alpha: &a)
        return String(format: "vec3(%.3f, %.3f, %.3f)", r, g, b)
    }

    /// The Mac's MSL with the board's colours: the window's dark in dark; the
    /// light window, ink and eye with the glows mixed in, in light.
    static func pipeline(_ dev: MTLDevice, dark: Bool) -> MTLRenderPipelineState? {
        var src = ShaderHost.source(.ink)
        var swaps = [("const vec3 BG  = vec3(0.043, 0.043, 0.047);", "const vec3 BG  = \(rgb("win", dark: dark));")]
        if !dark {
            swaps += [
                ("const vec3 INK = vec3(0.949, 0.949, 0.957);", "const vec3 INK = \(rgb("tx", dark: false));"),
                ("const vec3 EYE = vec3(0.039, 0.518, 1.000);", "const vec3 EYE = \(rgb("work", dark: false));"),
                ("col += INK * aura * markA;", "col = mix(col, INK, clamp(aura * markA, 0.0, 1.0));"),
                ("col += EYE * (eGlow + ripple) * markA * 0.55;", "col = mix(col, EYE, clamp((eGlow + ripple) * markA * 0.55, 0.0, 1.0));"),
            ]
        }
        for (a, b) in swaps {
            guard src.contains(a) else { Log.say("launch: the Mac's shader changed (\(a)), no ink"); return nil }
            src = src.replacingOccurrences(of: a, with: b)
        }
        do {
            let lib = try dev.makeLibrary(source: src, options: nil)
            let d = MTLRenderPipelineDescriptor()
            d.vertexFunction = lib.makeFunction(name: "fx_vertex")
            d.fragmentFunction = lib.makeFunction(name: "fx_fragment")
            d.colorAttachments[0].pixelFormat = .bgra8Unorm
            return try dev.makeRenderPipelineState(descriptor: d)
        } catch { Log.say("launch: shader: \(error)"); return nil }
    }

    private init(root: UIView, device: MTLDevice, queue: MTLCommandQueue, pipe: MTLRenderPipelineState, dark: Bool) {
        self.device = device; self.queue = queue; self.pipe = pipe; self.dark = dark
        view = InkView(frame: root.bounds)
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        layer = view.layer as! CAMetalLayer
        layer.device = device
        layer.pixelFormat = .bgra8Unorm
        layer.framebufferOnly = false
        layer.contentsScale = root.window?.screen.scale ?? UIScreen.main.scale
        layer.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
        let W = Float(root.bounds.width), H = Float(root.bounds.height)
        let win = Shared.color("win", dark: dark)
        source = InkLaunch.solid(device, win)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        win.getRed(&r, green: &g, blue: &b, alpha: &a)
        let unitA: Float = 1.55
        layout = [SIMD4(W, H, 0, 0), SIMD4(W / 2, H / 2 - 8, unitA, 0), SIMD4(W / 2, H * 0.3, unitA / 6, 0), SIMD4(-1000, -1000, 0, 0), SIMD4(Float(r), Float(g), Float(b), 0)]
        label.text = "Reaching your Mac..."
        label.textColor = Shared.color("tx2", dark: dark)
        label.font = .systemFont(ofSize: 15)
        label.textAlignment = .center
        label.alpha = 0
        label.frame = CGRect(x: 20, y: CGFloat(H / 2 + 100), width: CGFloat(W) - 40, height: 44)
        label.numberOfLines = 2
        view.addSubview(label)
        view.onTouch = { [weak self] in self?.finish("touch") }
        root.addSubview(view)
        let l = CADisplayLink(target: self, selector: #selector(tick))
        l.add(to: .main, forMode: .common)
        link = l
        draw(at: 0)
    }

    private static func solid(_ dev: MTLDevice, _ c: UIColor) -> MTLTexture {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        c.getRed(&r, green: &g, blue: &b, alpha: &a)
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: 1, height: 1, mipmapped: false)
        let t = dev.makeTexture(descriptor: d)!
        var px: [UInt8] = [UInt8(b * 255), UInt8(g * 255), UInt8(r * 255), 255]
        t.replace(region: MTLRegionMake2D(0, 0, 1, 1), mipmapLevel: 0, withBytes: &px, bytesPerRow: 4)
        return t
    }

    /// The board drew its top bar: where its mark is (CSS px in the web view), and its picture.
    func ready(_ o: [String: Any], board: BoardController) {
        guard !done, !isReady, let web = board.web else { return }
        let x = (o["x"] as? Double ?? 0) + Double(web.frame.minX), y = (o["y"] as? Double ?? 0) + Double(web.frame.minY)
        let mw = o["w"] as? Double ?? 24, mh = o["h"] as? Double ?? 24
        let k = mw / 100
        let markB = SIMD4<Float>(Float(x + k * (4.77 + 0.8954 * 50.5)), Float(y + k * (-2.10 + 0.8954 * 58.5)), Float(k * 0.8954), 0)
        let tile = SIMD4<Float>(Float(x + mw / 2), Float(y + mh / 2), Float(mw / 2 + 2), 0)
        web.takeSnapshot(with: nil) { [weak self, weak board] img, _ in
            guard let self, let board, let img, !self.done else { return }
            let W = board.view.bounds.width, H = board.view.bounds.height
            let f = UIGraphicsImageRendererFormat(); f.scale = self.layer.contentsScale; f.opaque = true
            let full = UIGraphicsImageRenderer(size: CGSize(width: W, height: H), format: f).image { c in
                (board.view.backgroundColor ?? .black).setFill(); c.fill(CGRect(x: 0, y: 0, width: W, height: H)); img.draw(in: web.frame)
            }
            guard let cg = full.cgImage, let tex = InkLaunch.texture(self.device, cg) else { return }
            self.source = tex
            self.layout[2] = markB
            self.layout[3] = tile
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            (board.view.backgroundColor ?? .black).getRed(&r, green: &g, blue: &b, alpha: &a)
            self.layout[4] = SIMD4(Float(r), Float(g), Float(b), 0)
            self.isReady = true
            Log.say(String(format: "launch: the board's mark is there at %.2f s", CACurrentMediaTime() - self.began - self.heldFor))
            if let ts = ProcessInfo.processInfo.environment["RAVENRY_INK_FRAMES"] { self.writeFrames(ts) }
        }
    }

    func answered() {}

    /// The Mac does not answer: the ink goes, and the board's own page says why.
    func unreached(_ words: String) { finish("unreached") }

    func colorChanged(_ c: UIColor?) {}

    @objc private func tick() {
        let now = CACurrentMediaTime()
        var t = now - began - heldFor
        if t > InkLaunch.formed && !isReady {
            heldFor += t - InkLaunch.formed
            t = InkLaunch.formed
            let hold = now - began - InkLaunch.formed
            if hold > 0.6 && label.alpha == 0 { UIView.animate(withDuration: 0.3) { self.label.alpha = 1 } }
            if hold > 15 { finish("held too long"); return }
        } else if label.alpha > 0 { label.alpha = 0 }
        let t0 = CACurrentMediaTime()
        draw(at: min(t, InkLaunch.duration))
        frames.append((CACurrentMediaTime() - t0) * 1000)
        last = now
        if t >= InkLaunch.duration { finish("done") }
    }

    private func encode(_ cb: MTLCommandBuffer, into target: MTLTexture, at t: Double) {
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = target
        pass.colorAttachments[0].loadAction = .dontCare
        pass.colorAttachments[0].storeAction = .store
        guard let enc = cb.makeRenderCommandEncoder(descriptor: pass) else { return }
        var u = ShaderHost.Uniforms(resolution: SIMD4(Float(target.width), Float(target.height), 1, 0), time: SIMD4(Float(t), 1.0 / 60, 0, 0), mouse: .zero,
                                    layout: (layout[0], layout[1], layout[2], layout[3], layout[4]))
        enc.setRenderPipelineState(pipe)
        enc.setFragmentBytes(&u, length: MemoryLayout<ShaderHost.Uniforms>.stride, index: 0)
        enc.setFragmentTexture(source, index: 0)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
    }

    private func draw(at t: Double) {
        let s = layer.contentsScale
        layer.drawableSize = CGSize(width: view.bounds.width * s, height: view.bounds.height * s)
        guard let d = layer.nextDrawable(), let cb = queue.makeCommandBuffer() else { return }
        encode(cb, into: d.texture, at: t)
        cb.present(d)
        cb.commit()
    }

    func finish(_ why: String) {
        guard !done else { return }
        done = true
        link?.invalidate(); link = nil
        let sorted = frames.sorted()
        let med = sorted.isEmpty ? 0 : sorted[sorted.count / 2]
        Log.say(String(format: "launch: ink ended (%@) at %.2f s, %d frames, %.1f ms a frame to encode (median)", why, CACurrentMediaTime() - began - heldFor, frames.count, med))
        view.removeFromSuperview()
        onEnd()
    }

    /// For the checks: the ink at given times over the picture it has now, as PNGs in Documents.
    private func writeFrames(_ list: String) {
        let w = Int(view.bounds.width * layer.contentsScale), h = Int(view.bounds.height * layer.contentsScale)
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: w, height: h, mipmapped: false)
        d.usage = [.renderTarget, .shaderRead]; d.storageMode = .shared
        guard let dst = device.makeTexture(descriptor: d) else { return }
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        for t in list.split(separator: ",").compactMap({ Double($0) }) {
            guard let cb = queue.makeCommandBuffer() else { continue }
            encode(cb, into: dst, at: t)
            cb.commit(); cb.waitUntilCompleted()
            var px = [UInt8](repeating: 0, count: w * h * 4)
            dst.getBytes(&px, bytesPerRow: w * 4, from: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0)
            let img = px.withUnsafeMutableBytes { b in
                CGContext(data: b.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                          bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)?.makeImage()
            }
            if let img { try? UIImage(cgImage: img).pngData()?.write(to: docs.appendingPathComponent(String(format: "ink-%@-%.1f.png", dark ? "dark" : "light", t))) }
        }
        Log.say("launch: frames written")
    }

    static func texture(_ dev: MTLDevice, _ img: CGImage) -> MTLTexture? {
        let w = img.width, h = img.height
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        bytes.withUnsafeMutableBytes { b in
            let ctx = CGContext(data: b.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
            ctx?.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: w, height: h, mipmapped: false)
        d.usage = [.shaderRead]
        guard let t = dev.makeTexture(descriptor: d) else { return nil }
        bytes.withUnsafeBytes { t.replace(region: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: w * 4) }
        return t
    }
}

/// The overlay: a Metal layer; any touch ends the ink.
final class InkView: UIView {
    override class var layerClass: AnyClass { CAMetalLayer.self }
    var onTouch: () -> Void = {}
    override func touchesBegan(_ t: Set<UITouch>, with e: UIEvent?) { onTouch() }
}
