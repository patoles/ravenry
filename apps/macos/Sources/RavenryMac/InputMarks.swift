// What an agent, or the hub, typed into the pane on screen, marked beside
// the line it shows on (TERM-044), as the Electron app's marks.ts: a thin
// bar in the terminal's right gutter, in the agent's colour, and its name
// and the time when the pointer is on it. Nothing is drawn over the cells.
// The person's own input (the window's typing and pastes, the phone's) is
// never marked; every input stays in the panel's Typed here.
//
// Where an input shows: the daemon logs each input with `mark`, the output
// position just before it, and each render frame's header carries the
// output position it shows (ravenryd 0.1.36). After each frame the view
// notes which output position its cursor stood at, on which row; the echo
// of an input starts at or after the last such point before its mark, so
// its lines are looked for from there. A program that redraws its region
// (Claude Code's input box) may never show the echo where it was typed: the
// mark then goes to the line nearest above the cursor that shows its last
// line, else, after a few frames, on the line the cursor stood on when it
// came. An input from before the view showed (its mark is older than the
// first frame) is looked for backwards from there. Rows are counted from
// the oldest row the pane keeps (history - offset + the row on screen), so
// a mark follows scrolling; a mark whose line no longer shows its text
// moves to the nearest line that does, or goes. The client holds only the
// rows on screen, so a mark is placed and checked while its line shows. On
// the alternate screen (a full-screen program) none are drawn.
//
// The lines looked for are the record's `shown` (the lines entered, the
// cursor's moves replayed), else its text's lines as the Electron app's
// echoParts reads them.

import AppKit

final class InputMarks {
    /// Where the cursor stood after a frame: the output position, the row
    /// (from the oldest row kept) and the column.
    struct Point { let mark: UInt64; let row: Int; let x: Int }
    /// A placed mark: its row, the text its line must keep, the record.
    struct Placed { var row: Int; let text: String; let rec: [String: Any] }
    /// The rows on screen when the marks are placed.
    struct View {
        let top: Int
        /// The rows on screen, and a row's text (read under the screen's lock).
        let count: Int
        let row: (Int) -> String
        let cursorRow: Int, cursorX: Int
        let alt: Bool
        func text(_ abs: Int) -> String? {
            let i = abs - top
            return i >= 0 && i < count ? row(i) : nil
        }
    }

    /// Who typed (Board.sourceOf's name, through Workspace.whoOf).
    var whoOf: (([String: Any]) -> String?)?
    private(set) var placed: [Int: Placed] = [:]
    private var points: [Point] = []
    private var snapshotAt: Point?
    private var pending: [[String: Any]] = []
    private var records: [[String: Any]] = []
    private var gone = Set<Int>()
    private var tries: [Int: Int] = [:]

    static let maxPoints = 4000, lookAhead = 40, echoFrames = 3
    /// Clients that type for the person (app.ts PERSON_CLIENTS).
    static let personClients: Set<String> = ["ravenry-desktop", "ravenry-hub-term"]

    private static func seq(_ r: [String: Any]) -> Int { (r["seq"] as? NSNumber)?.intValue ?? 0 }
    private static func mark(_ r: [String: Any]) -> UInt64 { (r["mark"] as? NSNumber)?.uint64Value ?? 0 }

    /// Who typed a record, with its colour's name; nil for the person.
    func who(_ r: [String: Any]) -> (name: String, cls: String)? {
        guard let src = r["source"] as? [String: Any], src["kind"] as? String != "person",
              !InputMarks.personClients.contains(src["client"] as? String ?? "") else { return nil }
        let name = whoOf?(src) ?? (src["kind"] as? String == "agent" ? "An agent" : src["client"] as? String ?? "A program")
        return (name, Assistants.list.first { $0.chip == name }?.id ?? "other")
    }

    /// A new stream: everything starts over; the records are kept.
    func reset() {
        placed = [:]
        points = []
        snapshotAt = nil
        pending = []
        gone = []
        tries = [:]
    }

    /// A frame was drawn with the cursor at p; the first of a stream is the snapshot.
    func written(_ p: Point, snapshot: Bool) {
        if snapshot {
            let rec = records
            reset()
            records = rec
            pending = rec.filter { who($0) != nil }
            snapshotAt = p
        }
        points.append(p)
        if points.count > InputMarks.maxPoints { points.removeFirst(points.count - InputMarks.maxPoints) }
    }

    /// The pane's input log, oldest first (pane.inputs).
    func show(_ recs: [[String: Any]]) {
        records = recs
        pending = recs.filter { r in
            let s = InputMarks.seq(r)
            return placed[s] == nil && !gone.contains(s) && who(r) != nil
        }
    }

    /// A record from the daemon's pane.input event: new, or one that grew (the same seq).
    func add(_ r: [String: Any]) {
        var recs = records
        if let i = recs.firstIndex(where: { InputMarks.seq($0) == InputMarks.seq(r) }) { recs[i] = r } else { recs.append(r) }
        if recs.count > 200 { recs.removeFirst(recs.count - 200) }
        show(recs)
    }

    /// The lines its echo shows.
    static func parts(_ r: [String: Any]) -> [String] {
        if let shown = r["shown"] as? String {
            return shown.components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        }
        // panes.ts echoParts: the text's lines, and ^C, ^Z, ^\ for those keys.
        let t = r["text"] as? String ?? ""
        var out: [String] = []
        guard let re = try? NSRegularExpression(pattern: "<([A-Za-z0-9+/]+)>") else { return out }
        var at = t.startIndex
        func text(_ s: Substring) {
            for line in s.components(separatedBy: CharacterSet(charactersIn: "\r\n")) where !line.trimmingCharacters(in: .whitespaces).isEmpty { out.append(line) }
        }
        for m in re.matches(in: t, range: NSRange(t.startIndex..., in: t)) {
            guard let r = Range(m.range, in: t), let k = Range(m.range(at: 1), in: t) else { continue }
            text(t[at..<r.lowerBound])
            if ["Ctrl+C", "Ctrl+Z", "Ctrl+\\"].contains(String(t[k])) { out.append("^" + String(t[k].last!)) }
            at = r.upperBound
        }
        text(t[at...])
        return out
    }

    private func findFrom(_ v: View, _ s: String, _ y: Int, _ x: Int) -> (y: Int, x: Int)? {
        for yy in y..<(y + InputMarks.lookAhead) {
            guard let t = v.text(yy) else { if yy >= v.top { break } else { continue } }
            let from = yy == y ? min(max(0, x), t.count) : 0
            let start = t.index(t.startIndex, offsetBy: from)
            if let r = t.range(of: s, range: start..<t.endIndex) { return (yy, t.distance(from: t.startIndex, to: r.lowerBound)) }
        }
        return nil
    }

    private func findBefore(_ v: View, _ s: String, _ y: Int, _ x: Int) -> (y: Int, x: Int)? {
        var yy = y
        while yy >= v.top {
            if let t = v.text(yy) {
                // The last one starting at or before x on the first row.
                let limit = yy == y ? min(max(0, x - s.count) + s.count, t.count) : t.count
                let end = t.index(t.startIndex, offsetBy: limit)
                if let r = t.range(of: s, options: .backwards, range: t.startIndex..<end) { return (yy, t.distance(from: t.startIndex, to: r.lowerBound)) }
            }
            yy -= 1
        }
        return nil
    }

    /// Places what can be placed on the rows on screen; true when a mark came, moved or went.
    @discardableResult
    func place(_ v: View) -> Bool {
        guard let snap = snapshotAt, !v.alt else { return false }
        var changed = follow(v)
        var left: [[String: Any]] = []
        // Before the snapshot: backwards, each before the one after it.
        var limit = (y: snap.row, x: snap.x)
        for r in pending.filter({ InputMarks.mark($0) < snap.mark }).sorted(by: { InputMarks.seq($0) > InputMarks.seq($1) }) {
            let parts = InputMarks.parts(r)
            if parts.isEmpty { continue }
            var found: [(y: Int, x: Int, n: Int)] = []
            var at = limit
            for part in parts.reversed() {
                guard let f = findBefore(v, part, at.y, at.x) else { break }
                found.insert((f.y, f.x, part.count), at: 0)
                at = f
            }
            if found.count == parts.count {
                decorate(r, found, parts)
                changed = true
                limit = (found[0].y, found[0].x)
            }
        }
        // After it: from the last point at or before its mark.
        for r in pending where InputMarks.mark(r) >= snap.mark {
            let parts = InputMarks.parts(r)
            if parts.isEmpty { continue }
            guard let from = points.last(where: { $0.mark <= InputMarks.mark(r) }) else { left.append(r); continue }
            var found: [(y: Int, x: Int, n: Int)] = []
            var at = (y: from.row, x: from.x)
            for part in parts {
                guard let f = findFrom(v, part, at.y, at.x) else { break }
                found.append((f.y, f.x, part.count))
                at = (f.y, f.x + part.count)
            }
            if found.count == parts.count { decorate(r, found, parts); changed = true; continue }
            // A program that redraws may have put it above where it came.
            let last = parts[parts.count - 1]
            if last.count > 1, let up = findBefore(v, last, v.cursorRow, v.cursorX + 1), up.y >= from.row - InputMarks.lookAhead {
                decorate(r, [(up.y, up.x, last.count)], parts)
                changed = true
                continue
            }
            // Not echoed yet, or redrawn away: after a few frames, the cursor's line when it came.
            let s = InputMarks.seq(r)
            let n = (tries[s] ?? 0) + 1
            tries[s] = n
            if n >= InputMarks.echoFrames && points.contains(where: { $0.mark > InputMarks.mark(r) }) {
                decorate(r, [(from.row, from.x, 1)], parts)
                changed = true
            } else {
                left.append(r)
            }
        }
        pending = left
        return changed
    }

    private func decorate(_ r: [String: Any], _ found: [(y: Int, x: Int, n: Int)], _ parts: [String]) {
        guard who(r) != nil, let last = found.last else { return }
        let s = InputMarks.seq(r)
        tries[s] = nil
        // What must stay on that line: its echo (none when placed by the cursor).
        let text = found.count == parts.count && last.n > 1 ? parts[parts.count - 1] : ""
        placed[s] = Placed(row: last.y, text: text, rec: r)
    }

    /// A mark whose line no longer shows its text follows it to the nearest line that does, or goes.
    private func follow(_ v: View) -> Bool {
        var changed = false
        for (s, p) in placed where !p.text.isEmpty {
            guard let t = v.text(p.row) else { continue }
            if t.contains(p.text) { continue }
            var best: Int?
            for yy in (p.row - InputMarks.lookAhead)...(p.row + InputMarks.lookAhead) {
                if let tt = v.text(yy), tt.contains(p.text), best == nil || abs(yy - p.row) < abs(best! - p.row) { best = yy }
            }
            changed = true
            if let b = best { placed[s]?.row = b } else { placed[s] = nil; gone.insert(s) }
        }
        return changed
    }

    /// The marks on the rows on screen: the row on screen, the record, who and its colour.
    func visible(top: Int, rows: Int) -> [(row: Int, rec: [String: Any], who: String, cls: String)] {
        placed.values.compactMap { p in
            let y = p.row - top
            guard y >= 0, y < rows, let w = who(p.rec) else { return nil }
            return (y, p.rec, w.name, w.cls)
        }.sorted { $0.row < $1.row }
    }

    /// Each mark's line, for tests: its row from the oldest kept, and who.
    var lines: [(seq: Int, row: Int, who: String)] {
        placed.map { ($0.key, $0.value.row, who($0.value.rec)?.name ?? "") }.sorted { $0.seq < $1.seq }
    }

    /// The bar's colour (phase2.css .am-gut).
    static func color(_ cls: String) -> SIMD4<Float> {
        switch cls {
        case "claude": return SIMD4(191 / 255, 90 / 255, 242 / 255, 1)
        case "codex": return SIMD4(64 / 255, 156 / 255, 1, 1)
        default: return SIMD4(209 / 255, 209 / 255, 214 / 255, 0.55)
        }
    }

    /// The name's colour in the label (phase2.css .am-lbl b).
    static func nameColor(_ cls: String) -> NSColor {
        switch cls {
        case "claude": return NSColor(srgbRed: 0xDA / 255, green: 0x8F / 255, blue: 1, alpha: 1)
        case "codex": return NSColor(srgbRed: 0x6B / 255, green: 0xB5 / 255, blue: 1, alpha: 1)
        default: return NSColor(srgbRed: 0xD1 / 255, green: 0xD1 / 255, blue: 0xD6 / 255, alpha: 1)
        }
    }
}
