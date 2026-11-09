// Draws a Screen with Metal: one instanced quad per cell background run,
// per glyph and per line (underline, strikethrough, cursor, selection).
// Glyphs come from a CoreText atlas. The shaders are compiled from source
// when the app starts, so the build needs no Metal toolchain.

import AppKit
import CoreText
import Metal
import QuartzCore
import simd

struct Theme {
    var background: SIMD4<Float>
    var foreground: SIMD4<Float>
    var cursor: SIMD4<Float>
    var selection: SIMD4<Float>
    var ansi: [SIMD4<Float>] // 16

    static func hex(_ v: UInt32, _ a: Float = 1) -> SIMD4<Float> {
        SIMD4(Float((v >> 16) & 0xff) / 255, Float((v >> 8) & 0xff) / 255, Float(v & 0xff) / 255, a)
    }

    /// The desktop app's theme (apps/desktop/src/renderer/terminal.ts).
    static let ravenry = Theme(
        background: hex(0x0B0B0C), foreground: hex(0xD1D1D6), cursor: hex(0xE5E5EA),
        selection: SIMD4(64.0 / 255, 156.0 / 255, 1, 0.35),
        ansi: [0x1C1C1E, 0xFF6961, 0x30D158, 0xFFD60A, 0x409CFF, 0xBF5AF2, 0x64D2FF, 0xD1D1D6,
               0x636366, 0xFF8A80, 0x4CE07A, 0xFFE066, 0x6BB5FF, 0xDA8FFF, 0x8AE0FF, 0xF2F2F4].map { hex($0) })
}

/// The xterm 256-colour palette above the 16 ANSI colours.
private let xterm256: [UInt32] = {
    var p = [UInt32](repeating: 0, count: 256)
    let steps: [UInt32] = [0, 95, 135, 175, 215, 255]
    for i in 0..<216 {
        p[16 + i] = steps[i / 36] << 16 | steps[(i / 6) % 6] << 8 | steps[i % 6]
    }
    for i in 0..<24 {
        let v = UInt32(8 + 10 * i)
        p[232 + i] = v << 16 | v << 8 | v
    }
    return p
}()

private let shaderSource = """
#include <metal_stdlib>
using namespace metal;

struct Uniforms { float2 viewport; };

struct RectInst { float2 pos; float2 size; float4 color; uint kind; };
struct RectOut { float4 pos [[position]]; float4 color; float2 local; float2 size; uint kind [[flat]]; };

constant float2 corners[4] = { float2(0, 0), float2(1, 0), float2(0, 1), float2(1, 1) };

vertex RectOut rect_vertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                           const device RectInst *inst [[buffer(0)]], constant Uniforms &u [[buffer(1)]]) {
    RectInst r = inst[iid];
    float2 c = corners[vid];
    float2 p = r.pos + c * r.size;
    RectOut o;
    o.pos = float4(p.x / u.viewport.x * 2 - 1, 1 - p.y / u.viewport.y * 2, 0, 1);
    o.color = r.color;
    o.local = c * r.size;
    o.size = r.size;
    o.kind = r.kind;
    return o;
}

fragment float4 rect_fragment(RectOut in [[stage_in]]) {
    float a = 1;
    if (in.kind == 1) {
        // Curly underline: a sine through the rectangle's middle.
        float h = in.size.y;
        float y = h * 0.5 + (h * 0.35) * sin(in.local.x / h * 2.2);
        a = clamp(1.6 - abs(in.local.y - y) / max(h * 0.18, 0.7), 0.0, 1.0);
    } else if (in.kind == 2) {
        a = fmod(in.local.x, in.size.y * 2) < in.size.y ? 1 : 0;   // dotted
    } else if (in.kind == 3) {
        a = fmod(in.local.x, in.size.y * 6) < in.size.y * 4 ? 1 : 0; // dashed
    } else if (in.kind == 4) {
        // A pill: a rectangle whose short sides are half circles.
        float r = min(in.size.x, in.size.y) * 0.5;
        float2 q = abs(in.local - in.size * 0.5) - (in.size * 0.5 - r);
        float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
        a = clamp(0.5 - d, 0.0, 1.0);
    }
    return float4(in.color.rgb * in.color.a * a, in.color.a * a);
}

struct GlyphInst { float2 pos; float2 size; float2 uv0; float2 uv1; float4 color; uint colored; };
struct GlyphOut { float4 pos [[position]]; float2 uv; float4 color; uint colored [[flat]]; };

vertex GlyphOut glyph_vertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                             const device GlyphInst *inst [[buffer(0)]], constant Uniforms &u [[buffer(1)]]) {
    GlyphInst g = inst[iid];
    float2 c = corners[vid];
    float2 p = g.pos + c * g.size;
    GlyphOut o;
    o.pos = float4(p.x / u.viewport.x * 2 - 1, 1 - p.y / u.viewport.y * 2, 0, 1);
    o.uv = mix(g.uv0, g.uv1, c);
    o.color = g.color;
    o.colored = g.colored;
    return o;
}

fragment float4 glyph_fragment(GlyphOut in [[stage_in]], texture2d<float> atlas [[texture(0)]]) {
    constexpr sampler s(coord::pixel, filter::nearest);
    float4 t = atlas.sample(s, in.uv);
    if (in.colored != 0) { return t * in.color.a; }
    float a = t.a * in.color.a;
    return float4(in.color.rgb * a, a);
}
"""

struct RectInst {
    var pos: SIMD2<Float>
    var size: SIMD2<Float>
    var color: SIMD4<Float>
    var kind: UInt32
    var pad: (UInt32, UInt32, UInt32) = (0, 0, 0)
}

struct GlyphInst {
    var pos: SIMD2<Float>
    var size: SIMD2<Float>
    var uv0: SIMD2<Float>
    var uv1: SIMD2<Float>
    var color: SIMD4<Float>
    var colored: UInt32
    var pad: (UInt32, UInt32, UInt32) = (0, 0, 0)
}

/// Where a glyph sits in the atlas, and how it is drawn relative to its
/// cell's top left corner (pixels).
struct AtlasGlyph {
    var uv0: SIMD2<Float>, uv1: SIMD2<Float>
    var offset: SIMD2<Float>, size: SIMD2<Float>
    var colored: Bool
    var empty: Bool
}

/// The font and the cell it makes, in device pixels, as Ghostty computes
/// it: the cell is the advance of "M" wide and the font's ascent, descent
/// and line gap high, each rounded to a whole pixel, with no extra line
/// spacing; the baseline sits so the descent (and half the line gap) is
/// at the cell's bottom.
final class FontSet {
    let regular, bold, italic, boldItalic: CTFont
    let cellWidth: CGFloat, cellHeight: CGFloat, ascent: CGFloat, descent: CGFloat
    /// The baseline from the cell's top.
    let baseline: CGFloat
    let underlineY: CGFloat, underlineThickness: CGFloat, strikeY: CGFloat
    /// The light line of the box-drawing characters.
    let boxThickness: Int
    let scale: CGFloat
    /// The family drawn, and the size in points.
    let name: String
    let size: CGFloat

    init(name: String, size: CGFloat, scale: CGFloat) {
        self.scale = scale
        self.size = size
        let px = size * scale
        var base = CTFontCreateWithName(name as CFString, px, nil)
        if !CTFontGetSymbolicTraits(base).contains(.traitMonoSpace) {
            // CoreText gives Helvetica for a name it does not know.
            NSLog("RavenryMac: \(name) is not a monospaced font here; using Menlo")
            base = CTFontCreateWithName("Menlo" as CFString, px, nil)
        }
        self.name = CTFontCopyFamilyName(base) as String
        regular = base
        bold = CTFontCreateCopyWithSymbolicTraits(base, px, nil, .traitBold, .traitBold) ?? base
        italic = CTFontCreateCopyWithSymbolicTraits(base, px, nil, .traitItalic, .traitItalic) ?? base
        boldItalic = CTFontCreateCopyWithSymbolicTraits(base, px, nil, [.traitBold, .traitItalic], [.traitBold, .traitItalic]) ?? bold
        var glyph = CGGlyph(0)
        var ch: UniChar = 0x4D // M
        CTFontGetGlyphsForCharacters(base, &ch, &glyph, 1)
        var adv = CGSize.zero
        CTFontGetAdvancesForGlyphs(base, .horizontal, &glyph, &adv, 1)
        let a = CTFontGetAscent(base), d = CTFontGetDescent(base), gap = CTFontGetLeading(base)
        cellWidth = max(1, adv.width.rounded())
        cellHeight = max(1, (a + d + gap).rounded())
        ascent = a.rounded()
        descent = d.rounded()
        baseline = cellHeight - (d + gap / 2).rounded()
        underlineThickness = max(1, CTFontGetUnderlineThickness(base).rounded())
        // Below the baseline, kept inside the cell.
        underlineY = min((-CTFontGetUnderlinePosition(base)).rounded(), cellHeight - baseline - underlineThickness)
        strikeY = (CTFontGetXHeight(base) / 2).rounded()
        boxThickness = max(1, Int((cellWidth / 7).rounded()))
    }

    func font(bold b: Bool, italic i: Bool) -> CTFont {
        switch (b, i) {
        case (true, true): return boldItalic
        case (true, false): return bold
        case (false, true): return italic
        default: return regular
        }
    }
}

final class Atlas {
    let device: MTLDevice
    private(set) var texture: MTLTexture
    let size: Int
    private var x = 1, y = 1, rowH = 0
    private var cache: [UInt64: AtlasGlyph] = [:]
    private let fonts: FontSet

    init(device: MTLDevice, fonts: FontSet, size: Int = 2048) {
        self.device = device
        self.fonts = fonts
        self.size = size
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: size, height: size, mipmapped: false)
        d.usage = .shaderRead
        d.storageMode = .shared
        texture = device.makeTexture(descriptor: d)!
    }

    func glyph(_ g: UInt32, bold: Bool, italic: Bool, wide: Bool) -> AtlasGlyph {
        if Sprites.covers(g) {
            if let a = cache[UInt64(g)] { return a }
            let a = sprite(g)
            cache[UInt64(g)] = a
            return a
        }
        let key = UInt64(g) | (bold ? 1 << 40 : 0) | (italic ? 1 << 41 : 0) | (wide ? 1 << 42 : 0)
        if let a = cache[key] { return a }
        let a = render(Graphemes.shared.string(g), bold: bold, italic: italic, wide: wide)
        cache[key] = a
        return a
    }

    private static let emptyGlyph = AtlasGlyph(uv0: .zero, uv1: .zero, offset: .zero, size: .zero, colored: false, empty: true)

    /// A character the renderer draws itself (Sprites), the cell's size.
    private func sprite(_ g: UInt32) -> AtlasGlyph {
        let w = Int(fonts.cellWidth), h = Int(fonts.cellHeight)
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        let cs = CGColorSpaceCreateDeviceRGB()
        let made: Bool = bytes.withUnsafeMutableBytes { p in
            guard let ctx = CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
            else { return false }
            ctx.setShouldAntialias(true)
            // Top-down coordinates.
            ctx.translateBy(x: 0, y: CGFloat(h))
            ctx.scaleBy(x: 1, y: -1)
            Sprites.draw(g, ctx, w: w, h: h, t: fonts.boxThickness)
            return true
        }
        return made ? upload(bytes, w, h, pad: 0, colored: false) : Atlas.emptyGlyph
    }

    private func render(_ s: String, bold: Bool, italic: Bool, wide: Bool) -> AtlasGlyph {
        let empty = Atlas.emptyGlyph
        if s.isEmpty || s == " " { return empty }
        let font = fonts.font(bold: bold, italic: italic)
        // No ligatures: each cell shows its own character.
        let attr = NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: NSColor.white, .ligature: 0])
        let line = CTLineCreateWithAttributedString(attr)
        var colored = false
        if let runs = CTLineGetGlyphRuns(line) as? [CTRun] {
            for r in runs {
                let attrs = CTRunGetAttributes(r) as NSDictionary
                if let f = attrs[kCTFontAttributeName] {
                    if CTFontGetSymbolicTraits(f as! CTFont).contains(.traitColorGlyphs) { colored = true }
                }
            }
        }
        let cells = wide ? 2 : 1
        let cw = fonts.cellWidth * CGFloat(cells), ch = fonts.cellHeight
        // Room around the cell for glyphs that reach past it (italics,
        // some symbols).
        let pad = ceil(fonts.cellHeight / 3)
        let w = Int(cw + 2 * pad), h = Int(ch + 2 * pad)
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        let cs = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(data: &bytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return empty }
        ctx.setAllowsFontSmoothing(false)
        ctx.setShouldSmoothFonts(false)
        ctx.setAllowsAntialiasing(true)
        ctx.setShouldAntialias(true)
        var x0 = pad
        if colored {
            // An emoji: scaled to fit its cells, centred.
            let bounds = CTLineGetImageBounds(line, ctx)
            let fit = min(cw / max(bounds.width, 1), ch / max(bounds.height, 1), 1)
            if fit < 1 {
                ctx.translateBy(x: pad + cw / 2, y: pad + (ch - fonts.baseline))
                ctx.scaleBy(x: fit, y: fit)
                ctx.translateBy(x: -(bounds.midX), y: 0)
                x0 = 0
                ctx.textPosition = CGPoint(x: 0, y: 0)
            } else {
                x0 = pad + (cw - CTLineGetTypographicBounds(line, nil, nil, nil)) / 2
                ctx.textPosition = CGPoint(x: x0, y: pad + (ch - fonts.baseline))
            }
        } else {
            ctx.textPosition = CGPoint(x: x0, y: pad + (ch - fonts.baseline))
        }
        CTLineDraw(line, ctx)
        return upload(bytes, w, h, pad: pad, colored: colored)
    }

    /// Puts what is inked in a w by h picture into the atlas; pad is how
    /// far the cell's corner is inside the picture.
    private func upload(_ bytes: [UInt8], _ w: Int, _ h: Int, pad: CGFloat, colored: Bool) -> AtlasGlyph {
        let empty = Atlas.emptyGlyph
        // Trim to the inked box.
        var minX = w, minY = h, maxX = -1, maxY = -1
        for yy in 0..<h {
            for xx in 0..<w where bytes[(yy * w + xx) * 4 + 3] != 0 {
                minX = min(minX, xx); maxX = max(maxX, xx); minY = min(minY, yy); maxY = max(maxY, yy)
            }
        }
        if maxX < 0 { return empty }
        let gw = maxX - minX + 1, gh = maxY - minY + 1
        if x + gw + 1 >= size {
            x = 1
            y += rowH + 1
            rowH = 0
        }
        if y + gh + 1 >= size {
            // The atlas is full: start it again (glyphs are drawn anew).
            cache.removeAll()
            x = 1; y = 1; rowH = 0
        }
        var sub = [UInt8](repeating: 0, count: gw * gh * 4)
        for yy in 0..<gh {
            let src = ((minY + yy) * w + minX) * 4
            sub.withUnsafeMutableBytes { d in
                bytes.withUnsafeBytes { s in
                    (d.baseAddress! + yy * gw * 4).copyMemory(from: s.baseAddress! + src, byteCount: gw * 4)
                }
            }
        }
        texture.replace(region: MTLRegionMake2D(x, y, gw, gh), mipmapLevel: 0, withBytes: sub, bytesPerRow: gw * 4)
        let g = AtlasGlyph(uv0: SIMD2(Float(x), Float(y)), uv1: SIMD2(Float(x + gw), Float(y + gh)),
                           offset: SIMD2(Float(CGFloat(minX) - pad), Float(CGFloat(minY) - pad)),
                           size: SIMD2(Float(gw), Float(gh)), colored: colored, empty: false)
        x += gw + 1
        rowH = max(rowH, gh)
        return g
    }
}

/// What a draw shows besides the screen.
struct Overlay {
    var focused = true
    var cursorOn = true
    var marked: String = ""
    /// The overlay scrollbar's opacity, 0 hidden.
    var scrollbar: Float = 0
    /// The link under the pointer while Cmd is held (screen coordinates).
    var link: CellRange?
}

final class Renderer {
    let device: MTLDevice
    let queue: MTLCommandQueue
    private let rectPipeline: MTLRenderPipelineState
    private let glyphPipeline: MTLRenderPipelineState
    private(set) var fonts: FontSet
    private(set) var atlas: Atlas
    var theme = Theme.ravenry
    var padding: CGFloat = 4 // points
    private var rects: [RectInst] = []
    private var glyphs: [GlyphInst] = []
    /// Drawn over the glyphs: the scrollbar, the bell's flash.
    private var topRects: [RectInst] = []
    private var buffers: [(MTLBuffer, MTLBuffer)] = []
    private var bufferIndex = 0
    private let inflight = DispatchSemaphore(value: 3)
    var fontName: String { fonts.name }
    var fontSize: CGFloat { fonts.size }

    /// Timing of the last frames (milliseconds): CPU to build and encode,
    /// GPU from start to end.
    var onTiming: ((Double, Double) -> Void)?

    init?(scale: CGFloat, fontName: String = "Menlo", fontSize: CGFloat = 12) {
        guard let dev = MTLCreateSystemDefaultDevice(), let q = dev.makeCommandQueue() else { return nil }
        device = dev
        queue = q
        do {
            let lib = try dev.makeLibrary(source: shaderSource, options: nil)
            func pipe(_ v: String, _ f: String) throws -> MTLRenderPipelineState {
                let d = MTLRenderPipelineDescriptor()
                d.vertexFunction = lib.makeFunction(name: v)
                d.fragmentFunction = lib.makeFunction(name: f)
                let a = d.colorAttachments[0]!
                a.pixelFormat = .bgra8Unorm
                a.isBlendingEnabled = true
                a.sourceRGBBlendFactor = .one
                a.destinationRGBBlendFactor = .oneMinusSourceAlpha
                a.sourceAlphaBlendFactor = .one
                a.destinationAlphaBlendFactor = .oneMinusSourceAlpha
                return try dev.makeRenderPipelineState(descriptor: d)
            }
            rectPipeline = try pipe("rect_vertex", "rect_fragment")
            glyphPipeline = try pipe("glyph_vertex", "glyph_fragment")
        } catch {
            NSLog("RavenryMac: shaders: \(error)")
            return nil
        }
        fonts = FontSet(name: fontName, size: fontSize, scale: scale)
        atlas = Atlas(device: dev, fonts: fonts)
    }

    func setScale(_ scale: CGFloat) {
        guard scale != fonts.scale else { return }
        fonts = FontSet(name: fontName, size: fontSize, scale: scale)
        atlas = Atlas(device: device, fonts: fonts)
    }

    /// Another font size (points): a new cell and a new atlas.
    func setFontSize(_ size: CGFloat) {
        guard size != fontSize else { return }
        fonts = FontSet(name: fontName, size: size, scale: fonts.scale)
        atlas = Atlas(device: device, fonts: fonts)
    }

    /// The grid that fits a view of this size in points.
    func grid(for size: CGSize) -> (cols: Int, rows: Int) {
        let s = fonts.scale
        let w = (size.width - 2 * padding) * s, h = (size.height - 2 * padding) * s
        return (max(1, Int(w / fonts.cellWidth)), max(1, Int(h / fonts.cellHeight)))
    }

    private func resolve(_ c: PackedColor, _ screen: Screen, fg: Bool) -> SIMD4<Float> {
        switch c >> 24 {
        case 1:
            let i = UInt8(c & 0xff)
            if let o = screen.colors.palette[i] { return Theme.hex(o) }
            if i < 16 { return theme.ansi[Int(i)] }
            return Theme.hex(xterm256[Int(i)])
        case 2:
            return Theme.hex(c & 0xff_ffff)
        default:
            if fg { return screen.colors.fg.map { Theme.hex($0) } ?? theme.foreground }
            return screen.colors.bg.map { Theme.hex($0) } ?? theme.background
        }
    }

    /// The default background (the program's, or the theme's).
    func background(_ screen: Screen) -> SIMD4<Float> {
        screen.colors.bg.map { Theme.hex($0) } ?? theme.background
    }

    /// Builds the instances for the screen. The caller holds its lock.
    private func build(_ screen: Screen, _ o: Overlay, viewport: SIMD2<Float>) {
        rects.removeAll(keepingCapacity: true)
        glyphs.removeAll(keepingCapacity: true)
        topRects.removeAll(keepingCapacity: true)
        let cw = Float(fonts.cellWidth), ch = Float(fonts.cellHeight)
        let px = Float(round(padding * fonts.scale)), py = px
        let defBg = background(screen)
        let top = screen.history - screen.offset
        let ulY = Float(fonts.baseline + fonts.underlineY), ulT = Float(fonts.underlineThickness)
        for y in 0..<min(screen.rows, screen.lines.count) {
            let row = screen.lines[y]
            let oy = py + Float(y) * ch
            // Backgrounds, run by run.
            var runStart = -1
            var runColor = SIMD4<Float>(repeating: 0)
            func flush(_ end: Int) {
                if runStart >= 0 {
                    rects.append(RectInst(pos: SIMD2(px + Float(runStart) * cw, oy), size: SIMD2(Float(end - runStart) * cw, ch), color: runColor, kind: 0))
                }
                runStart = -1
            }
            for x in 0..<row.count {
                let c = row[x]
                var bg = c.style.bg
                var hasBg = bg != 0
                if c.style.attrs & CellStyle.inverse != 0 {
                    bg = c.style.fg
                    hasBg = true
                }
                let color = hasBg ? resolve(bg, screen, fg: c.style.attrs & CellStyle.inverse != 0 && c.style.fg == 0) : defBg
                let selected = screen.selection?.contains(x: x, y: top + y) ?? false
                let col = selected ? mix(color, SIMD4(theme.selection.x, theme.selection.y, theme.selection.z, 1), t: theme.selection.w) : color
                if !hasBg && !selected {
                    flush(x)
                    continue
                }
                if runStart >= 0 && col == runColor { continue }
                flush(x)
                runStart = x
                runColor = col
            }
            flush(row.count)
            // Glyphs and lines.
            for x in 0..<row.count {
                let c = row[x]
                if c.flags & Cell.spacer != 0 { continue }
                let st = c.style
                if st.attrs & CellStyle.invisible != 0 { continue }
                var fg = st.attrs & CellStyle.inverse != 0 ? resolve(st.bg, screen, fg: false) : resolve(st.fg, screen, fg: true)
                if st.attrs & CellStyle.inverse != 0 && st.bg == 0 { fg = defBg }
                if st.attrs & CellStyle.faint != 0 { fg.w *= 0.6 }
                let wide = c.flags & Cell.wide != 0
                let ox = px + Float(x) * cw
                if c.g != 0 && c.g != 32 {
                    let g = atlas.glyph(c.g, bold: st.attrs & CellStyle.bold != 0, italic: st.attrs & CellStyle.italic != 0, wide: wide)
                    if !g.empty {
                        glyphs.append(GlyphInst(pos: SIMD2(ox, oy) + g.offset, size: g.size, uv0: g.uv0, uv1: g.uv1,
                                                color: fg, colored: g.colored ? 1 : 0))
                    }
                }
                let w = wide ? 2 * cw : cw
                let ul = st.underline
                if ul != 0 || st.link != 0 {
                    let ulc = st.ul != 0 ? resolve(st.ul, screen, fg: true) : fg
                    let kind: UInt32 = ul == 3 ? 1 : ul == 4 ? 2 : ul == 5 ? 3 : 0
                    let h = kind == 1 ? ulT * 3 : ulT
                    let yy = oy + ulY - (kind == 1 ? ulT : 0)
                    rects.append(RectInst(pos: SIMD2(ox, yy), size: SIMD2(w, h), color: ulc, kind: kind))
                    if ul == 2 {
                        rects.append(RectInst(pos: SIMD2(ox, yy + 2 * ulT), size: SIMD2(w, ulT), color: ulc, kind: 0))
                    }
                }
                if st.attrs & CellStyle.strike != 0 {
                    rects.append(RectInst(pos: SIMD2(ox, oy + Float(fonts.baseline - fonts.strikeY)), size: SIMD2(w, ulT), color: fg, kind: 0))
                }
                if st.attrs & CellStyle.overline != 0 {
                    rects.append(RectInst(pos: SIMD2(ox, oy), size: SIMD2(w, ulT), color: fg, kind: 0))
                }
            }
        }
        // The link under the pointer, underlined; it may run over rows.
        if let l = o.link {
            for y in 0..<screen.rows {
                guard let sp = l.span(y: top + y, cols: screen.cols) else { continue }
                rects.append(RectInst(pos: SIMD2(px + Float(sp.lowerBound) * cw, py + Float(y) * ch + ulY),
                                      size: SIMD2(Float(sp.count) * cw, ulT), color: theme.foreground, kind: 0))
            }
        }
        // The cursor.
        let cur = screen.cursor
        if cur.inView && cur.visible && cur.y < screen.rows && (o.cursorOn || !o.focused) {
            let cc = screen.colors.cursor.map { Theme.hex($0) } ?? theme.cursor
            let ox = px + Float(cur.x) * cw, oy = py + Float(cur.y) * ch
            var w = cw
            if cur.y < screen.lines.count, cur.x < screen.lines[cur.y].count, screen.lines[cur.y][cur.x].flags & Cell.wide != 0 { w = 2 * cw }
            let t = max(1, Float(round(fonts.scale)))
            if !o.focused || cur.style == 3 {
                rects.append(RectInst(pos: SIMD2(ox, oy), size: SIMD2(w, t), color: cc, kind: 0))
                rects.append(RectInst(pos: SIMD2(ox, oy + ch - t), size: SIMD2(w, t), color: cc, kind: 0))
                rects.append(RectInst(pos: SIMD2(ox, oy), size: SIMD2(t, ch), color: cc, kind: 0))
                rects.append(RectInst(pos: SIMD2(ox + w - t, oy), size: SIMD2(t, ch), color: cc, kind: 0))
            } else if cur.style == 1 {
                rects.append(RectInst(pos: SIMD2(ox, oy), size: SIMD2(2 * t, ch), color: cc, kind: 0))
            } else if cur.style == 2 {
                rects.append(RectInst(pos: SIMD2(ox, oy + ch - 2 * t), size: SIMD2(w, 2 * t), color: cc, kind: 0))
            } else {
                rects.append(RectInst(pos: SIMD2(ox, oy), size: SIMD2(w, ch), color: cc, kind: 0))
                // The glyph under a block cursor, in the background colour.
                if cur.y < screen.lines.count, cur.x < screen.lines[cur.y].count {
                    let c = screen.lines[cur.y][cur.x]
                    if c.g != 0 && c.g != 32 {
                        let g = atlas.glyph(c.g, bold: c.style.attrs & CellStyle.bold != 0, italic: c.style.attrs & CellStyle.italic != 0, wide: c.flags & Cell.wide != 0)
                        if !g.empty {
                            glyphs.append(GlyphInst(pos: SIMD2(ox, oy) + g.offset, size: g.size, uv0: g.uv0, uv1: g.uv1, color: defBg, colored: g.colored ? 1 : 0))
                        }
                    }
                }
            }
        }
        // Text an input method is composing, at the cursor, underlined.
        if !o.marked.isEmpty && cur.inView {
            var x = cur.x
            for ch1 in o.marked {
                let s = String(ch1)
                let g = s.unicodeScalars.count == 1 ? s.unicodeScalars.first!.value : Graphemes.shared.id(s)
                let wide = s.unicodeScalars.first.map { $0.properties.isEmojiPresentation || ($0.value >= 0x1100 && isWide($0.value)) } ?? false
                let ox = px + Float(x) * cw, oy = py + Float(cur.y) * ch
                let w = wide ? 2 * cw : cw
                rects.append(RectInst(pos: SIMD2(ox, oy), size: SIMD2(w, ch), color: defBg, kind: 0))
                let a = atlas.glyph(g, bold: false, italic: false, wide: wide)
                if !a.empty {
                    glyphs.append(GlyphInst(pos: SIMD2(ox, oy) + a.offset, size: a.size, uv0: a.uv0, uv1: a.uv1, color: theme.foreground, colored: a.colored ? 1 : 0))
                }
                rects.append(RectInst(pos: SIMD2(ox, oy + ulY), size: SIMD2(w, ulT), color: theme.foreground, kind: 0))
                x += wide ? 2 : 1
            }
        }
        // The overlay scrollbar, macOS style: a thin pill at the right
        // edge, its length the screen's share of the scrollback.
        if o.scrollbar > 0 && screen.history > 0 {
            let s = Float(fonts.scale)
            let inset = 2 * s, width = 6 * s
            let trackH = viewport.y - 2 * inset
            let total = Float(screen.history + screen.rows)
            let thumbH = min(trackH, max(24 * s, trackH * Float(screen.rows) / total))
            let frac = Float(screen.history - min(screen.offset, screen.history)) / Float(screen.history)
            let y = inset + (trackH - thumbH) * frac
            topRects.append(RectInst(pos: SIMD2(viewport.x - inset - width, y), size: SIMD2(width, thumbH),
                                color: SIMD4(1, 1, 1, 0.45 * o.scrollbar), kind: 4))
        }
    }

    private func isWide(_ v: UInt32) -> Bool {
        (v >= 0x1100 && v <= 0x115F) || (v >= 0x2E80 && v <= 0xA4CF) || (v >= 0xAC00 && v <= 0xD7A3) ||
            (v >= 0xF900 && v <= 0xFAFF) || (v >= 0xFE30 && v <= 0xFE4F) || (v >= 0xFF00 && v <= 0xFF60) ||
            (v >= 0xFFE0 && v <= 0xFFE6) || (v >= 0x20000 && v <= 0x3FFFD)
    }

    private func buffer(_ len: Int, _ old: MTLBuffer?) -> MTLBuffer {
        if let b = old, b.length >= len { return b }
        return device.makeBuffer(length: max(len, 64 << 10) * 2, options: .storageModeShared)!
    }

    /// Draws the screen into texture (a drawable's, or an offscreen one).
    /// It holds the screen's lock only while it builds the instances. It
    /// returns the frame number it drew.
    @discardableResult
    func encode(screen: Screen, overlay: Overlay, into texture: MTLTexture, commandBuffer cb: MTLCommandBuffer) -> UInt32 {
        let t0 = CACurrentMediaTime()
        let viewport = SIMD2(Float(texture.width), Float(texture.height))
        screen.lock()
        build(screen, overlay, viewport: viewport)
        let bg = background(screen)
        let seq = screen.seq
        screen.unlock()
        inflight.wait()
        if buffers.count < 3 {
            buffers.append((device.makeBuffer(length: 256 << 10, options: .storageModeShared)!, device.makeBuffer(length: 256 << 10, options: .storageModeShared)!))
        }
        bufferIndex = (bufferIndex + 1) % buffers.count
        var (rb, gb) = buffers[bufferIndex]
        rb = buffer((rects.count + topRects.count) * MemoryLayout<RectInst>.stride, rb)
        gb = buffer(glyphs.count * MemoryLayout<GlyphInst>.stride, gb)
        buffers[bufferIndex] = (rb, gb)
        rects.withUnsafeBytes { if let p = $0.baseAddress { rb.contents().copyMemory(from: p, byteCount: $0.count) } }
        let topOffset = rects.count * MemoryLayout<RectInst>.stride
        topRects.withUnsafeBytes { if let p = $0.baseAddress { (rb.contents() + topOffset).copyMemory(from: p, byteCount: $0.count) } }
        glyphs.withUnsafeBytes { if let p = $0.baseAddress { gb.contents().copyMemory(from: p, byteCount: $0.count) } }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].storeAction = .store
        pass.colorAttachments[0].clearColor = MTLClearColor(red: Double(bg.x), green: Double(bg.y), blue: Double(bg.z), alpha: 1)
        guard let enc = cb.makeRenderCommandEncoder(descriptor: pass) else {
            inflight.signal()
            return seq
        }
        var u = viewport
        if !rects.isEmpty {
            enc.setRenderPipelineState(rectPipeline)
            enc.setVertexBuffer(rb, offset: 0, index: 0)
            enc.setVertexBytes(&u, length: MemoryLayout<SIMD2<Float>>.size, index: 1)
            enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: rects.count)
        }
        if !glyphs.isEmpty {
            enc.setRenderPipelineState(glyphPipeline)
            enc.setVertexBuffer(gb, offset: 0, index: 0)
            enc.setVertexBytes(&u, length: MemoryLayout<SIMD2<Float>>.size, index: 1)
            enc.setFragmentTexture(atlas.texture, index: 0)
            enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: glyphs.count)
        }
        if !topRects.isEmpty {
            enc.setRenderPipelineState(rectPipeline)
            enc.setVertexBuffer(rb, offset: topOffset, index: 0)
            enc.setVertexBytes(&u, length: MemoryLayout<SIMD2<Float>>.size, index: 1)
            enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: topRects.count)
        }
        enc.endEncoding()
        let cpu = (CACurrentMediaTime() - t0) * 1000
        let sem = inflight
        let timing = onTiming
        cb.addCompletedHandler { b in
            sem.signal()
            timing?(cpu, (b.gpuEndTime - b.gpuStartTime) * 1000)
        }
        return seq
    }
}
