// Characters the renderer draws itself instead of taking them from the
// font, as Ghostty does: box drawing (U+2500 to U+257F), block elements
// (U+2580 to U+259F), braille (U+2800 to U+28FF) and the Powerline
// triangles (U+E0B0 to U+E0B3). Each fills its cell exactly, so lines and
// blocks join across cells and rows with no gap, whatever the font's own
// glyphs would leave.

import CoreGraphics

enum Sprites {
    static func covers(_ g: UInt32) -> Bool {
        (g >= 0x2500 && g <= 0x259F) || (g >= 0x2800 && g <= 0x28FF) || (g >= 0xE0B0 && g <= 0xE0B3)
    }

    /// Draws g in white into ctx, a w by h pixel cell whose coordinates run
    /// from the top left corner down (the caller flips the context). t is
    /// the light line's thickness in pixels.
    static func draw(_ g: UInt32, _ ctx: CGContext, w: Int, h: Int, t: Int) {
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        switch g {
        case 0x2500...0x257F: box(g, ctx, w, h, t)
        case 0x2580...0x259F: block(g, ctx, w, h)
        case 0x2800...0x28FF: braille(g, ctx, w, h)
        default: powerline(g, ctx, w, h, t)
        }
    }

    // MARK: box drawing

    private enum Kind { case none, light, heavy, double }

    /// U+2500 to U+257F: the line going up, right, down and left from the
    /// cell's centre ("." none, "l" light, "h" heavy, "d" double). Empty:
    /// dashes, arcs and diagonals, drawn on their own.
    private static let lines: [String] = [
        ".l.l", ".h.h", "l.l.", "h.h.", "", "", "", "", "", "", "", "", ".ll.", ".hl.", ".lh.", ".hh.",
        "..ll", "..lh", "..hl", "..hh", "ll..", "lh..", "hl..", "hh..", "l..l", "l..h", "h..l", "h..h", "lll.", "lhl.", "hll.", "llh.",
        "hlh.", "hhl.", "lhh.", "hhh.", "l.ll", "l.lh", "h.ll", "l.hl", "h.hl", "h.lh", "l.hh", "h.hh", ".lll", ".llh", ".hll", ".hlh",
        ".lhl", ".lhh", ".hhl", ".hhh", "ll.l", "ll.h", "lh.l", "lh.h", "hl.l", "hl.h", "hh.l", "hh.h", "llll", "lllh", "lhll", "lhlh",
        "hlll", "llhl", "hlhl", "hllh", "hhll", "llhh", "lhhl", "hhlh", "lhhh", "hlhh", "hhhl", "hhhh", "", "", "", "",
        ".d.d", "d.d.", ".dl.", ".ld.", ".dd.", "..ld", "..dl", "..dd", "ld..", "dl..", "dd..", "l..d", "d..l", "d..d", "ldl.", "dld.",
        "ddd.", "l.ld", "d.dl", "d.dd", ".dld", ".ldl", ".ddd", "ld.d", "dl.l", "dd.d", "ldld", "dldl", "dddd", "", "", "",
        "", "", "", "", "...l", "l...", ".l..", "..l.", "...h", "h...", ".h..", "..h.", ".h.l", "l.h.", ".l.h", "h.l.",
    ]

    private static func kind(_ c: Character) -> Kind {
        switch c {
        case "l": return .light
        case "h": return .heavy
        case "d": return .double
        default: return .none
        }
    }

    private static func fill(_ ctx: CGContext, _ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int) {
        guard x1 > x0, y1 > y0 else { return }
        ctx.fill(CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0))
    }

    private static func box(_ g: UInt32, _ ctx: CGContext, _ w: Int, _ h: Int, _ t: Int) {
        let i = Int(g - 0x2500)
        switch g {
        case 0x2504...0x250B, 0x254C...0x254F:
            dashes(g, ctx, w, h, t)
            return
        case 0x256D...0x2570:
            arc(g, ctx, w, h, t)
            return
        case 0x2571...0x2573:
            diagonal(g, ctx, w, h, t)
            return
        default:
            break
        }
        let spec = Array(lines[i])
        guard spec.count == 4 else { return }
        let u = kind(spec[0]), r = kind(spec[1]), d = kind(spec[2]), l = kind(spec[3])
        let heavy = 2 * t
        func thick(_ k: Kind) -> Int { k == .heavy ? heavy : t }
        // A single line of thickness T: from vx(T) across, from hy(T) down.
        func vx(_ T: Int) -> Int { (w - T) / 2 }
        func hy(_ T: Int) -> Int { (h - T) / 2 }
        // A double line: two light strokes with a light gap between.
        let xa = (w - 3 * t) / 2, xb = xa + 2 * t
        let ya = (h - 3 * t) / 2, yb = ya + 2 * t
        func single(_ k: Kind) -> Bool { k == .light || k == .heavy }

        // Horizontal arms. For the right arm `inner` is where it starts,
        // for the left one where it ends.
        for (k, right) in [(r, true), (l, false)] where k != .none {
            let opposite = right ? l : r
            func joinSingle(_ T: Int) -> Int { right ? vx(T) : vx(T) + T }
            if single(k) {
                let T = thick(k)
                var inner: Int
                if opposite == k {
                    inner = right ? 0 : w
                } else if u == .double || d == .double {
                    inner = right ? xb : xa + t
                } else if single(u) || single(d) {
                    inner = joinSingle(max(single(u) ? thick(u) : 0, single(d) ? thick(d) : 0))
                } else {
                    inner = joinSingle(T)
                }
                right ? fill(ctx, inner, hy(T), w, hy(T) + T) : fill(ctx, 0, hy(T), inner, hy(T) + T)
            } else {
                for (y, near, far) in [(ya, u, d), (yb, d, u)] {
                    var inner: Int
                    if near == .double {
                        inner = right ? xb : xa + t
                    } else if single(near) {
                        inner = joinSingle(thick(near))
                    } else if far == .double {
                        inner = right ? xa : xb + t
                    } else if single(far) {
                        inner = joinSingle(thick(far))
                    } else if opposite == .double {
                        inner = right ? 0 : w
                    } else {
                        inner = w / 2
                    }
                    right ? fill(ctx, inner, y, w, y + t) : fill(ctx, 0, y, inner, y + t)
                }
            }
        }
        // Vertical arms, the same way: `inner` is where the lower arm
        // starts and the upper one ends.
        for (k, down) in [(d, true), (u, false)] where k != .none {
            let opposite = down ? u : d
            func joinSingle(_ T: Int) -> Int { down ? hy(T) : hy(T) + T }
            if single(k) {
                let T = thick(k)
                var inner: Int
                if opposite == k {
                    inner = down ? 0 : h
                } else if l == .double || r == .double {
                    inner = down ? yb : ya + t
                } else if single(l) || single(r) {
                    inner = joinSingle(max(single(l) ? thick(l) : 0, single(r) ? thick(r) : 0))
                } else {
                    inner = joinSingle(T)
                }
                down ? fill(ctx, vx(T), inner, vx(T) + T, h) : fill(ctx, vx(T), 0, vx(T) + T, inner)
            } else {
                for (x, near, far) in [(xa, l, r), (xb, r, l)] {
                    var inner: Int
                    if near == .double {
                        inner = down ? yb : ya + t
                    } else if single(near) {
                        inner = joinSingle(thick(near))
                    } else if far == .double {
                        inner = down ? ya : yb + t
                    } else if single(far) {
                        inner = joinSingle(thick(far))
                    } else if opposite == .double {
                        inner = down ? 0 : h
                    } else {
                        inner = h / 2
                    }
                    down ? fill(ctx, x, inner, x + t, h) : fill(ctx, x, 0, x + t, inner)
                }
            }
        }
    }

    /// Dashed lines: three, four or two dashes along the cell.
    private static func dashes(_ g: UInt32, _ ctx: CGContext, _ w: Int, _ h: Int, _ t: Int) {
        let n: Int, vertical: Bool, heavy: Bool
        switch g {
        case 0x2504...0x2507: n = 3; vertical = g >= 0x2506; heavy = g & 1 == 1
        case 0x2508...0x250B: n = 4; vertical = g >= 0x250A; heavy = g & 1 == 1
        default: n = 2; vertical = g >= 0x254E; heavy = g & 1 == 1
        }
        let T = heavy ? 2 * t : t
        let len = vertical ? h : w
        let gap = max(1, len / (n * 4))
        for k in 0..<n {
            let a = k * len / n + gap / 2, b = (k + 1) * len / n - (gap - gap / 2)
            if vertical {
                fill(ctx, (w - T) / 2, a, (w - T) / 2 + T, b)
            } else {
                fill(ctx, a, (h - T) / 2, b, (h - T) / 2 + T)
            }
        }
    }

    /// Rounded corners: the light lines meet in a quarter circle.
    private static func arc(_ g: UInt32, _ ctx: CGContext, _ w: Int, _ h: Int, _ t: Int) {
        let cx = CGFloat((w - t) / 2) + CGFloat(t) / 2, cy = CGFloat((h - t) / 2) + CGFloat(t) / 2
        let W = CGFloat(w), H = CGFloat(h)
        // The vertical end, the corner, the horizontal end.
        let (vEnd, hEnd): (CGPoint, CGPoint)
        switch g {
        case 0x256D: (vEnd, hEnd) = (CGPoint(x: cx, y: H), CGPoint(x: W, y: cy))   // down and right
        case 0x256E: (vEnd, hEnd) = (CGPoint(x: cx, y: H), CGPoint(x: 0, y: cy))   // down and left
        case 0x256F: (vEnd, hEnd) = (CGPoint(x: cx, y: 0), CGPoint(x: 0, y: cy))   // up and left
        default: (vEnd, hEnd) = (CGPoint(x: cx, y: 0), CGPoint(x: W, y: cy))       // up and right
        }
        let r = min(abs(hEnd.x - cx), abs(vEnd.y - cy))
        let p = CGMutablePath()
        p.move(to: vEnd)
        p.addArc(tangent1End: CGPoint(x: cx, y: cy), tangent2End: hEnd, radius: r)
        p.addLine(to: hEnd)
        ctx.setLineWidth(CGFloat(t))
        ctx.setLineCap(.butt)
        ctx.addPath(p)
        ctx.strokePath()
    }

    /// Diagonals, drawn past the cell's corners so they meet the next
    /// cell's.
    private static func diagonal(_ g: UInt32, _ ctx: CGContext, _ w: Int, _ h: Int, _ t: Int) {
        let W = CGFloat(w), H = CGFloat(h)
        ctx.setLineWidth(CGFloat(t))
        ctx.setLineCap(.butt)
        func line(_ a: CGPoint, _ b: CGPoint) {
            let dx = (b.x - a.x) * 0.1, dy = (b.y - a.y) * 0.1
            ctx.move(to: CGPoint(x: a.x - dx, y: a.y - dy))
            ctx.addLine(to: CGPoint(x: b.x + dx, y: b.y + dy))
            ctx.strokePath()
        }
        if g == 0x2571 || g == 0x2573 { line(CGPoint(x: W, y: 0), CGPoint(x: 0, y: H)) }
        if g == 0x2572 || g == 0x2573 { line(CGPoint(x: 0, y: 0), CGPoint(x: W, y: H)) }
    }

    // MARK: blocks

    private static func block(_ g: UInt32, _ ctx: CGContext, _ w: Int, _ h: Int) {
        func eighthsDown(_ k: Int) -> Int { (h * k + 4) / 8 }
        func eighthsAcross(_ k: Int) -> Int { (w * k + 4) / 8 }
        let mx = w / 2, my = h / 2
        switch g {
        case 0x2580: fill(ctx, 0, 0, w, my)
        case 0x2581...0x2588: fill(ctx, 0, h - eighthsDown(Int(g - 0x2580)), w, h)
        case 0x2589...0x258F: fill(ctx, 0, 0, eighthsAcross(Int(0x2590 - g)), h)
        case 0x2590: fill(ctx, mx, 0, w, h)
        case 0x2591, 0x2592, 0x2593:
            ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: CGFloat(g - 0x2590) * 0.25))
            fill(ctx, 0, 0, w, h)
        case 0x2594: fill(ctx, 0, 0, w, eighthsDown(1))
        case 0x2595: fill(ctx, w - eighthsAcross(1), 0, w, h)
        default:
            // Quadrants: upper left, upper right, lower left, lower right.
            let q: [UInt32: (Bool, Bool, Bool, Bool)] = [
                0x2596: (false, false, true, false), 0x2597: (false, false, false, true),
                0x2598: (true, false, false, false), 0x2599: (true, false, true, true),
                0x259A: (true, false, false, true), 0x259B: (true, true, true, false),
                0x259C: (true, true, false, true), 0x259D: (false, true, false, false),
                0x259E: (false, true, true, false), 0x259F: (false, true, true, true),
            ]
            guard let (ul, ur, ll, lr) = q[g] else { return }
            if ul { fill(ctx, 0, 0, mx, my) }
            if ur { fill(ctx, mx, 0, w, my) }
            if ll { fill(ctx, 0, my, mx, h) }
            if lr { fill(ctx, mx, my, w, h) }
        }
    }

    // MARK: braille

    /// Eight dots in two columns of four: dots 1 to 3 and 7 down the left,
    /// 4 to 6 and 8 down the right.
    private static func braille(_ g: UInt32, _ ctx: CGContext, _ w: Int, _ h: Int) {
        let bits = g - 0x2800
        let d = max(1, CGFloat((w * 3 + 5) / 10))
        let cols: [CGFloat] = [CGFloat(w) / 4, CGFloat(w) * 3 / 4]
        let rows: [CGFloat] = (0..<4).map { CGFloat(h) * CGFloat(2 * $0 + 1) / 8 }
        let dots: [(Int, Int)] = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2), (0, 3), (1, 3)]
        for (i, (c, r)) in dots.enumerated() where bits & (1 << UInt32(i)) != 0 {
            let x = (cols[c] - d / 2).rounded(), y = (rows[r] - d / 2).rounded()
            ctx.fillEllipse(in: CGRect(x: x, y: y, width: d, height: d))
        }
    }

    // MARK: Powerline

    private static func powerline(_ g: UInt32, _ ctx: CGContext, _ w: Int, _ h: Int, _ t: Int) {
        let W = CGFloat(w), H = CGFloat(h)
        let pointsRight = g == 0xE0B0 || g == 0xE0B1
        let base: CGFloat = pointsRight ? 0 : W, tip: CGFloat = pointsRight ? W : 0
        let p = CGMutablePath()
        p.move(to: CGPoint(x: base, y: 0))
        p.addLine(to: CGPoint(x: tip, y: H / 2))
        p.addLine(to: CGPoint(x: base, y: H))
        if g == 0xE0B0 || g == 0xE0B2 {
            p.closeSubpath()
            ctx.addPath(p)
            ctx.fillPath()
        } else {
            ctx.setLineWidth(CGFloat(t))
            ctx.setLineJoin(.miter)
            ctx.addPath(p)
            ctx.strokePath()
        }
    }
}
