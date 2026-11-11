// The client's copy of a pane's screen, built from render frames
// (docs/RENDERING.md). It holds only what the daemon sent: rows of cells,
// the cursor, modes, title and the colours the program changed. Frames are
// applied on the connection's reader thread; the renderer reads under the
// same lock.

import Foundation
import os

/// A colour as a frame carries it: kind (0 default, 1 palette, 2 RGB) in
/// the top byte, then the index or R, G, B.
typealias PackedColor = UInt32

struct CellStyle: Hashable {
    var fg: PackedColor = 0
    var bg: PackedColor = 0
    var ul: PackedColor = 0
    var attrs: UInt16 = 0
    var link: UInt16 = 0

    static let bold: UInt16 = 1, faint: UInt16 = 2, italic: UInt16 = 4, blink: UInt16 = 8
    static let inverse: UInt16 = 16, invisible: UInt16 = 32, strike: UInt16 = 64, overline: UInt16 = 128
    var underline: UInt8 { UInt8((attrs >> 8) & 7) }
}

struct Cell {
    /// The grapheme: its one scalar, or an id from Graphemes for a cluster
    /// of several; 0 is an empty cell.
    var g: UInt32 = 0
    /// 1 wide (covers the next cell too), 2 the wide character's second half.
    var flags: UInt8 = 0
    var style: CellStyle = CellStyle()

    static let wide: UInt8 = 1, spacer: UInt8 = 2
}

/// Grapheme clusters of more than one scalar, by id.
final class Graphemes {
    static let shared = Graphemes()
    static let base: UInt32 = 0x20_0000
    private var ids: [String: UInt32] = [:]
    private var strings: [String] = []
    private var lock = os_unfair_lock()

    func id(_ s: String) -> UInt32 {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        if let i = ids[s] { return i }
        strings.append(s)
        let i = Graphemes.base + UInt32(strings.count - 1)
        ids[s] = i
        return i
    }

    func string(_ g: UInt32) -> String {
        if g < Graphemes.base { return Unicode.Scalar(g).map { String(Character($0)) } ?? "" }
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        let i = Int(g - Graphemes.base)
        return i < strings.count ? strings[i] : ""
    }
}

struct Cursor: Equatable {
    var x = 0, y = 0
    var inView = false, visible = true, blink = false, wideTail = false, password = false
    var style: UInt8 = 0
}

/// Two cells in screen coordinates (row 0 the oldest row of the
/// scrollback), inclusive, in reading order; a block covers columns x0 to
/// x1 of each row.
struct CellRange: Equatable {
    var x0 = 0, y0 = 0, x1 = 0, y1 = 0
    var rect = false

    func contains(x: Int, y: Int) -> Bool {
        if y < y0 || y > y1 { return false }
        if rect { return x >= min(x0, x1) && x <= max(x0, x1) }
        if y == y0 && x < x0 { return false }
        if y == y1 && x > x1 { return false }
        return true
    }

    /// The columns it covers on row y, or nil.
    func span(y: Int, cols: Int) -> ClosedRange<Int>? {
        if y < y0 || y > y1 || cols <= 0 { return nil }
        if rect { return max(0, min(x0, x1))...min(cols - 1, max(x0, x1)) }
        let a = y == y0 ? x0 : 0, b = y == y1 ? x1 : cols - 1
        return a <= b ? max(0, a)...min(cols - 1, b) : nil
    }
}

/// A search on the stream (section 6): the count of matches, the
/// selected one's index from the newest (-1 none), and the matches on the
/// view's rows.
struct FindState: Equatable {
    var active = false
    var count = 0, selected = -1
    var current: CellRange?
    var matches: [CellRange] = []
}

struct ProgramColors: Equatable {
    var fg: UInt32?, bg: UInt32?, cursor: UInt32?
    var palette: [UInt8: UInt32] = [:]
}

final class Screen {
    private var lockv = os_unfair_lock()
    func lock() { os_unfair_lock_lock(&lockv) }
    func unlock() { os_unfair_lock_unlock(&lockv) }

    var cols = 0, rows = 0
    var lines: [[Cell]] = []
    var wraps: [Bool] = []
    var cursor = Cursor()
    var modes: UInt16 = 0
    var title = ""
    var colors = ProgramColors()
    var links: [UInt16: String] = [:]
    var history = 0, offset = 0
    var bell: UInt32 = 0
    var held = false
    /// The pane's selection (section 5), nil for none.
    var selection: CellRange?
    /// The stream's search (section 6).
    var find = FindState()
    /// Rows changed: bumped by each frame that carried rows.
    var rowsVersion = 0
    /// The session names and ids in the rows (SessionLinks.swift): their
    /// cells on the view's rows, their words, and the links they were found with.
    var nameSpans: [NameSpan] = []
    var nameWords: [String] = []
    var nameGen = -1
    /// The newest frame applied, not yet drawn when > drawnSeq.
    var seq: UInt32 = 0
    var frames = 0

    static let modeMouse: UInt16 = 1, modeMouseDrag: UInt16 = 2, modeMouseMotion: UInt16 = 4
    static let modeBracketedPaste: UInt16 = 8, modeAltScreen: UInt16 = 16, modeFocus: UInt16 = 32

    enum DecodeError: Error { case short, version(UInt8) }

    /// Applies a frame's payload. The caller holds the lock.
    func apply(_ p: UnsafeRawBufferPointer) throws {
        let b = p.bindMemory(to: UInt8.self)
        guard b.count >= 30 else { throw DecodeError.short }
        guard b[0] == 1 else { throw DecodeError.version(b[0]) }
        func u16(_ i: Int) -> Int { Int(b[i]) << 8 | Int(b[i + 1]) }
        func u32(_ i: Int) -> Int { Int(b[i]) << 24 | Int(b[i + 1]) << 16 | Int(b[i + 2]) << 8 | Int(b[i + 3]) }
        let flags = b[1]
        let full = flags & 1 != 0
        let fcols = u16(6), frows = u16(8)
        let rowsBefore = rowsVersion, sized = full || fcols != cols || frows != rows
        if full || fcols != cols || frows != rows {
            var nl = [[Cell]](repeating: [Cell](repeating: Cell(), count: fcols), count: frows)
            if !full {
                // A new size without a full frame: keep what fits.
                for y in 0..<min(frows, lines.count) {
                    for x in 0..<min(fcols, lines[y].count) { nl[y][x] = lines[y][x] }
                }
            }
            lines = nl
            var nw = [Bool](repeating: false, count: frows)
            if !full { for y in 0..<min(frows, wraps.count) { nw[y] = wraps[y] } }
            wraps = nw
            cols = fcols
            rows = frows
        }
        held = flags & 2 != 0
        seq = UInt32(u32(2))
        history = u32(10)
        offset = u32(14)
        let cf = b[22]
        cursor = Cursor(x: u16(18), y: u16(20), inView: cf & 1 != 0, visible: cf & 2 != 0, blink: cf & 4 != 0,
                        wideTail: cf & 8 != 0, password: cf & 16 != 0, style: b[23])
        modes = UInt16(u16(24))
        bell = UInt32(u32(26))
        var i = 30
        while i < b.count {
            guard i + 5 <= b.count else { throw DecodeError.short }
            let tag = b[i]
            let n = u32(i + 1)
            let s = i + 5
            guard s + n <= b.count else { throw DecodeError.short }
            switch tag {
            case 1:
                title = String(decoding: UnsafeBufferPointer(rebasing: b[s..<s + n]), as: UTF8.self)
            case 2:
                guard n >= 12 else { throw DecodeError.short }
                let set = b[s]
                func rgb(_ j: Int) -> UInt32 { UInt32(b[j]) << 16 | UInt32(b[j + 1]) << 8 | UInt32(b[j + 2]) }
                var c = ProgramColors()
                if set & 1 != 0 { c.fg = rgb(s + 1) }
                if set & 2 != 0 { c.bg = rgb(s + 4) }
                if set & 4 != 0 { c.cursor = rgb(s + 7) }
                let k = u16(s + 10)
                guard n >= 12 + 4 * k else { throw DecodeError.short }
                for e in 0..<k { c.palette[b[s + 12 + 4 * e]] = rgb(s + 13 + 4 * e) }
                colors = c
            case 3:
                var q = s + 2
                for _ in 0..<u16(s) {
                    let id = UInt16(u16(q)), l = u16(q + 2)
                    links[id] = String(decoding: UnsafeBufferPointer(rebasing: b[q + 4..<q + 4 + l]), as: UTF8.self)
                    q += 4 + l
                }
            case 4:
                var q = s + 2
                for _ in 0..<u16(s) {
                    let y = u16(q), fl = b[q + 2], l = u32(q + 3)
                    let d = q + 7
                    if y < rows {
                        try decodeRow(b, d, d + l, y)
                        wraps[y] = fl & 1 != 0
                    }
                    q = d + l
                }
                rowsVersion += 1
            case 5:
                guard n >= 13 else { throw DecodeError.short }
                var r = range(b, s + 1)
                r.rect = b[s] & 2 != 0
                selection = b[s] & 1 != 0 ? r : nil
            case 6:
                guard n >= 11 else { throw DecodeError.short }
                var f = FindState()
                f.active = b[s] & 1 != 0
                f.count = u32(s + 1)
                f.selected = Int(Int32(truncatingIfNeeded: u32(s + 5)))
                var q = s + 9
                if b[s] & 2 != 0 {
                    guard q + 12 <= s + n else { throw DecodeError.short }
                    f.current = range(b, q)
                    q += 12
                }
                guard q + 2 <= s + n else { throw DecodeError.short }
                let k = u16(q)
                q += 2
                guard q + 12 * k <= s + n else { throw DecodeError.short }
                for m in 0..<k { f.matches.append(range(b, q + 12 * m)) }
                find = f
            default:
                break // a newer section
            }
            i = s + n
        }
        // The session links in the rows it brought, found here on the
        // reader thread, never in a draw.
        if sized || rowsVersion != rowsBefore { findNames(SessionLinks.shared.matcher) }
        frames += 1
    }

    /// A range: x0 (2 bytes), y0 (4), x1 (2), y1 (4).
    private func range(_ b: UnsafeBufferPointer<UInt8>, _ i: Int) -> CellRange {
        func u16(_ j: Int) -> Int { Int(b[j]) << 8 | Int(b[j + 1]) }
        func u32(_ j: Int) -> Int { Int(b[j]) << 24 | Int(b[j + 1]) << 16 | Int(b[j + 2]) << 8 | Int(b[j + 3]) }
        return CellRange(x0: u16(i), y0: u32(i + 2), x1: u16(i + 6), y1: u32(i + 8))
    }

    private func decodeRow(_ b: UnsafeBufferPointer<UInt8>, _ start: Int, _ end: Int, _ y: Int) throws {
        var row = [Cell](repeating: Cell(), count: cols)
        var i = start
        var x = 0
        func color(_ j: Int) -> PackedColor {
            switch b[j] {
            case 1: return 1 << 24 | UInt32(b[j + 1])
            case 2: return 2 << 24 | UInt32(b[j + 1]) << 16 | UInt32(b[j + 2]) << 8 | UInt32(b[j + 3])
            default: return 0
            }
        }
        while i < end {
            guard i + 18 <= end else { throw DecodeError.short }
            let st = CellStyle(fg: color(i), bg: color(i + 4), ul: color(i + 8),
                               attrs: UInt16(b[i + 12]) << 8 | UInt16(b[i + 13]), link: UInt16(b[i + 14]) << 8 | UInt16(b[i + 15]))
            let n = Int(b[i + 16]) << 8 | Int(b[i + 17])
            i += 18
            for _ in 0..<n {
                guard i < end else { throw DecodeError.short }
                let c = b[i]
                i += 1
                var cell = Cell(g: 0, flags: 0, style: st)
                if c == 0xff {
                    cell.flags = Cell.spacer
                } else if c != 0 {
                    let l = Int(c & 0x7f)
                    guard i + l <= end else { throw DecodeError.short }
                    if c & 0x80 != 0 { cell.flags = Cell.wide }
                    cell.g = grapheme(b, i, l)
                    i += l
                }
                if x < cols { row[x] = cell }
                x += 1
            }
        }
        lines[y] = row
    }

    private func grapheme(_ b: UnsafeBufferPointer<UInt8>, _ i: Int, _ l: Int) -> UInt32 {
        if l == 1 { return UInt32(b[i]) }
        // One scalar of 2 to 4 bytes.
        let lead = b[i]
        let one = (lead >= 0xc0 && lead < 0xe0 && l == 2) || (lead >= 0xe0 && lead < 0xf0 && l == 3) || (lead >= 0xf0 && l == 4)
        if one {
            var v: UInt32
            switch l {
            case 2: v = UInt32(lead & 0x1f)
            case 3: v = UInt32(lead & 0x0f)
            default: v = UInt32(lead & 0x07)
            }
            for k in 1..<l { v = v << 6 | UInt32(b[i + k] & 0x3f) }
            return v
        }
        let s = String(decoding: UnsafeBufferPointer(rebasing: b[i..<i + l]), as: UTF8.self)
        return Graphemes.shared.id(s)
    }

    /// A row's text, a space for each empty cell, trailing spaces removed.
    /// The caller holds the lock.
    func rowText(_ y: Int) -> String {
        guard y < lines.count else { return "" }
        var s = ""
        for c in lines[y] {
            if c.flags & Cell.spacer != 0 { continue }
            s += c.g == 0 ? " " : Graphemes.shared.string(c.g)
        }
        while s.hasSuffix(" ") { s.removeLast() }
        return s
    }

    /// How many rows have text on them (a cell neither empty nor a space),
    /// a row that goes on a filled row wrapped into it counted with it (a
    /// full row reflowed narrower leaves its last cell, maybe a space, on
    /// the next row). The caller holds the lock.
    func filledRows() -> Int {
        var n = 0, above = false
        for y in 0..<min(rows, lines.count) {
            let filled = lines[y].contains(where: { $0.g != 0 && $0.g != 32 }) || (above && y > 0 && y - 1 < wraps.count && wraps[y - 1])
            if filled { n += 1 }
            above = filled
        }
        return n
    }

    /// How many rows end in a lone character: the last column filled, the
    /// two before it empty. A program's redraw laid out for a wider width
    /// (words placed at absolute columns) on a narrower screen puts every
    /// word past the margin in the last column: a bar of single letters
    /// down the right edge. The caller holds the lock.
    func barRows() -> Int {
        guard cols > 3 else { return 0 }
        var n = 0
        for y in 0..<min(rows, lines.count) where lines[y].count >= cols {
            let l = lines[y]
            let g = { (x: Int) in l[x].g != 0 && l[x].g != 32 }
            if g(cols - 1) && !g(cols - 2) && !g(cols - 3) { n += 1 }
        }
        return n
    }

    /// The screen's text, one line per row. Takes the lock.
    func text() -> String {
        lock()
        defer { unlock() }
        return (0..<rows).map { rowText($0) }.joined(separator: "\n")
    }
}
