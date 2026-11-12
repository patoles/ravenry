// The hand-off card's words (2026-11-12, the person: "The hand-off card is a
// wall of text, not really useful"). The hub sends the entry's first useful
// sentence, already short (hub/server/handoffline.mjs); the card still draws
// it in at most two lines, so an older hub's whole entry, or a long sentence,
// never makes a wall: cut at a word, "…" at the cut.

import AppKit

enum TwoLines {
    /// `s` as a wrapping label of `font` at `width` draws it: whole when it
    /// fits in `lines` lines, else its longest start that does, cut at a word
    /// (a word longer than the room: at a character), with "…".
    static func cut(_ s: String, font: NSFont, width: CGFloat, lines: Int = 2) -> String {
        let t = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        if t.isEmpty { return t }
        let f = NSTextField(wrappingLabelWithString: "")
        f.font = font
        f.maximumNumberOfLines = 0
        f.preferredMaxLayoutWidth = width
        func height(_ x: String) -> CGFloat {
            f.stringValue = x
            return f.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: width, height: 100_000)).height ?? 0
        }
        let one = height("Ag"), two = height("Ag\nAg")
        let limit = one + (two - one) * CGFloat(max(1, lines) - 1) + (two - one) / 2
        if height(t) <= limit { return t }
        let chars = Array(t)
        func with(_ n: Int) -> String { String(chars[0..<n]).replacingOccurrences(of: "[\\s,;:(\\-–\\[{]+$", with: "", options: .regularExpression) + "…" }
        // The word ends: each space's place.
        let ends = chars.indices.filter { chars[$0] == " " && $0 > 0 }
        var lo = 0, hi = ends.count - 1, best = -1
        while lo <= hi {
            let mid = (lo + hi) / 2
            if height(with(ends[mid])) <= limit { best = mid; lo = mid + 1 } else { hi = mid - 1 }
        }
        if best >= 0 { return with(ends[best]) }
        var a = 1, b = chars.count - 1, n = 1
        while a <= b {
            let mid = (a + b) / 2
            if height(String(chars[0..<mid]) + "…") <= limit { n = mid; a = mid + 1 } else { b = mid - 1 }
        }
        return String(chars[0..<n]) + "…"
    }
}
