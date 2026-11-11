// Ravenry's glyph font (TERM-041): the symbols coding agents print
// (Claude Code's record and spinner stars, warnings, check marks,
// arrows) drawn as text one cell wide, never by the system's colour
// emoji font, which made Claude's "⏺" an orange box. The font is the
// phone terminal's, "Ravenry Glyphs" (apps/phone/tools/glyph-font.py,
// from the Noto fonts under the SIL Open Font License 1.1), bundled as
// the phone has it: apps/phone/src/glyphs.css, one WOFF2 face a block of
// characters, which CoreText reads as it is.
//
// The order a cell's character is drawn in: the terminal's font when it
// has it, else these faces, else CoreText's own fallback (CJK, emoji).
// A character asked for as an emoji (U+FE0F after it) stays an emoji, and
// the characters Unicode shows as emoji by default are not in the font
// (an agent that prints ✅ means the emoji). Box drawing, blocks and
// braille (Codex's spinner) are drawn by the renderer itself (Sprites).

import AppKit
import CoreText

enum GlyphFont {
    /// The faces, in the stylesheet's order, read once.
    static let faces: [CTFontDescriptor] = {
        guard let url = Bundle.main.url(forResource: "glyphs", withExtension: "css"),
              let css = try? String(contentsOf: url, encoding: .utf8),
              let re = try? NSRegularExpression(pattern: "base64,([A-Za-z0-9+/=]+)\\)") else {
            NSLog("RavenryMac: no glyphs.css in the app; agents' symbols use the system's fonts")
            return []
        }
        var out: [CTFontDescriptor] = []
        for m in re.matches(in: css, range: NSRange(css.startIndex..., in: css)) {
            guard let r = Range(m.range(at: 1), in: css), let data = Data(base64Encoded: String(css[r])) else { continue }
            out += CTFontManagerCreateFontDescriptorsFromData(data as CFData) as? [CTFontDescriptor] ?? []
        }
        return out
    }()

    /// The glyph font's face for s at a size, when s is one character the
    /// terminal's font lacks and the glyph font has (not asked for as an
    /// emoji); nil: draw it as before.
    static func face(for s: String, base: CTFont, sized: inout [CTFont]?) -> CTFont? {
        var scalars = Array(s.unicodeScalars)
        if scalars.contains(where: { $0.value == 0xFE0F }) { return nil }
        scalars.removeAll { $0.value == 0xFE0E }
        guard scalars.count == 1, scalars[0].value >= 0x80 else { return nil }
        var units = Array(String(scalars[0]).utf16)
        var glyphs = [CGGlyph](repeating: 0, count: units.count)
        if CTFontGetGlyphsForCharacters(base, &units, &glyphs, units.count) { return nil }
        if sized == nil { sized = faces.map { CTFontCreateWithFontDescriptor($0, CTFontGetSize(base), nil) } }
        return sized?.first { CTFontGetGlyphsForCharacters($0, &units, &glyphs, units.count) }
    }
}
