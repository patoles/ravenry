// A project's brief drawn as text, never as HTML (BRIEF-004), as the
// Electron app draws it (apps/desktop/src/renderer/briefdoc.ts, its styles
// phase2.css .md): the Key: value fields before the first section, each
// "## " section a heading, ### headings, paragraphs, lists (nested, a
// checklist when its items have marks: [x] done, [>] or [now] under way,
// [?] or [you] for the person), code blocks, and inline `code`, **bold**,
// *em*, [links](...) and bare URLs. The Plan heading counts its checked
// items; the Next step is the hub's dated entries (nextParts.entries,
// hub/server/briefnext.mjs) when it has them, the newest open.
//
// One attributed string for one NSTextView (TextKit 1, so code blocks and
// the entries' box are text blocks with a rounded background): the whole
// brief selects and copies as text. A link is the `link` attribute: the
// page opens http, https and file URLs only; "rvn-entry:N" opens or closes
// entry N; "rvn-task:N" ticks or unticks the Plan's task N.
//
// The same parser draws any Markdown document (`document`, the pages'
// document view and an item's text, DocView): wrapped lines joined into
// their paragraph, a list item's continuation lines kept in it, numbered
// lists, quotes, # and ## headings (a ## section folds) and `[ ]` boxes
// ("rvn-box:K", K among the text's boxes as the hub counts them).

import AppKit

struct BriefEntry {
    let date: String, text: String, sentences: [String]
    init(_ d: [String: Any]) {
        date = d["date"] as? String ?? ""
        text = d["text"] as? String ?? ""
        sentences = d["sentences"] as? [String] ?? []
    }
}

/// A text block with a rounded background or ring (.md pre, .md .olds):
/// the parts of one box (an entry each) round only its ends.
final class RoundBlock: NSTextBlock {
    var fillName: String?
    var ringName: String?
    var roundTop = true, roundBottom = true, lineAbove = false
    override init() {
        super.init()
        // As wide as the column (a block is as narrow as it can be otherwise).
        setContentWidth(100, type: .percentageValueType)
    }
    required init?(coder: NSCoder) { super.init(coder: coder) }
    override func drawBackground(withFrame r: NSRect, in cv: NSView?, characterRange: NSRange, layoutManager: NSLayoutManager) {
        guard let v = cv else { return }
        let rad: CGFloat = fillName != nil ? 8 : 10
        let box = r.insetBy(dx: 0.5, dy: 0)
        let path = NSBezierPath()
        let tl = roundTop ? rad : 0, bl = roundBottom ? rad : 0
        // Flipped: minY is the top.
        path.move(to: NSPoint(x: box.minX + tl, y: box.minY))
        path.line(to: NSPoint(x: box.maxX - tl, y: box.minY))
        if tl > 0 { path.appendArc(withCenter: NSPoint(x: box.maxX - tl, y: box.minY + tl), radius: tl, startAngle: 270, endAngle: 0) }
        path.line(to: NSPoint(x: box.maxX, y: box.maxY - bl))
        if bl > 0 { path.appendArc(withCenter: NSPoint(x: box.maxX - bl, y: box.maxY - bl), radius: bl, startAngle: 0, endAngle: 90) }
        path.line(to: NSPoint(x: box.minX + bl, y: box.maxY))
        if bl > 0 { path.appendArc(withCenter: NSPoint(x: box.minX + bl, y: box.maxY - bl), radius: bl, startAngle: 90, endAngle: 180) }
        path.line(to: NSPoint(x: box.minX, y: box.minY + tl))
        if tl > 0 { path.appendArc(withCenter: NSPoint(x: box.minX + tl, y: box.minY + tl), radius: tl, startAngle: 180, endAngle: 270) }
        path.close()
        v.effectiveAppearance.performAsCurrentDrawingAppearance {
            if let f = fillName { Design.color(f).setFill(); path.fill() }
            if let rg = ringName {
                Design.color(rg).setStroke()
                // The ring's sides only; its top and bottom where the box starts and ends.
                let side = NSBezierPath()
                side.lineWidth = 1
                if roundTop { side.append(path) } else if roundBottom { side.append(path) } else {
                    side.move(to: NSPoint(x: box.minX, y: box.minY)); side.line(to: NSPoint(x: box.minX, y: box.maxY))
                    side.move(to: NSPoint(x: box.maxX, y: box.minY)); side.line(to: NSPoint(x: box.maxX, y: box.maxY))
                }
                if roundTop != roundBottom {
                    // One end rounded: the path's open end is drawn as the sides only.
                    let p = NSBezierPath(); p.lineWidth = 1
                    if roundTop {
                        p.move(to: NSPoint(x: box.minX, y: box.maxY)); p.line(to: NSPoint(x: box.minX, y: box.minY + tl))
                        p.appendArc(withCenter: NSPoint(x: box.minX + tl, y: box.minY + tl), radius: tl, startAngle: 180, endAngle: 270)
                        p.line(to: NSPoint(x: box.maxX - tl, y: box.minY))
                        p.appendArc(withCenter: NSPoint(x: box.maxX - tl, y: box.minY + tl), radius: tl, startAngle: 270, endAngle: 0)
                        p.line(to: NSPoint(x: box.maxX, y: box.maxY))
                    } else {
                        p.move(to: NSPoint(x: box.minX, y: box.minY)); p.line(to: NSPoint(x: box.minX, y: box.maxY - bl))
                        p.appendArc(withCenter: NSPoint(x: box.minX + bl, y: box.maxY - bl), radius: bl, startAngle: 180, endAngle: 90, clockwise: true)
                        p.line(to: NSPoint(x: box.maxX - bl, y: box.maxY))
                        p.appendArc(withCenter: NSPoint(x: box.maxX - bl, y: box.maxY - bl), radius: bl, startAngle: 90, endAngle: 0, clockwise: true)
                        p.line(to: NSPoint(x: box.maxX, y: box.minY))
                    }
                    p.stroke()
                } else { side.stroke() }
                if lineAbove {
                    let l = NSBezierPath(); l.lineWidth = 1
                    l.move(to: NSPoint(x: box.minX, y: box.minY + 0.5)); l.line(to: NSPoint(x: box.maxX, y: box.minY + 0.5)); l.stroke()
                }
            }
        }
    }
}

struct BriefDoc {
    /// The brief's folder, for relative links.
    let dir: String
    /// The dated entries open (by index); the newest is open at first.
    var open: Set<Int>
    /// The text's width, for an entry's line cut to one line.
    var width: CGFloat
    /// The checkboxes drawn (for the self-test): their marks in order.
    private(set) var boxes: [String] = []

    static let size: CGFloat = 14.5
    /// .md is a column with this gap between its blocks (app.css .md gap).
    static let gap: CGFloat = 6
    /// A dated entry's row: "rvn-entry:N", opened or closed by a press;
    /// in a document, a section's heading "rvn-fold:N" and a box "rvn-box:K".
    static let entryKey = NSAttributedString.Key("ravenryEntry")
    /// The body's size and line height (a document is drawn smaller than a brief).
    var size: CGFloat = BriefDoc.size
    var lh: CGFloat = 1.6
    private var bodyFont: NSFont { Fonts.pt(size) }
    /// A document's boxes (`[ ]` and `[x]` only, as the hub counts them): pressable when `tick`.
    var tick = false
    /// The colour behind code (a document on a card: card2, the brief on the sheet: card).
    var codeFill = "card"
    private var doc = false
    /// A document's boxes drawn, in order: their text and state.
    private(set) var docBoxes: [(text: String, done: Bool)] = []
    /// A brief's Plan tasks tick with a press ("rvn-task:N" for planTasks[N]).
    var planTick = false
    /// The Plan's tasks drawn, in order: the objective (### heading) each is under, its words, done or not.
    private(set) var planTasks: [(objective: String, text: String, done: Bool)] = []
    private var inPlan = false
    private var objective = ""

    init(dir: String, open: Set<Int> = [0], width: CGFloat = 620) {
        self.dir = dir; self.open = open; self.width = width
    }

    private func para(_ before: CGFloat = 0, after: CGFloat = 8, indent: CGFloat = 0, first: CGFloat? = nil, tab: CGFloat? = nil, lh: CGFloat? = nil, size: CGFloat? = nil) -> NSMutableParagraphStyle {
        let lh = lh ?? self.lh, size = size ?? self.size
        let p = NSMutableParagraphStyle()
        p.paragraphSpacingBefore = before
        p.paragraphSpacing = after
        p.headIndent = indent
        p.firstLineHeadIndent = first ?? indent
        if let t = tab { p.tabStops = [NSTextTab(textAlignment: .left, location: t)]; p.defaultTabInterval = t }
        let h = ceil(size * lh)
        p.minimumLineHeight = h
        p.maximumLineHeight = h
        return p
    }

    private func attrs(_ font: NSFont, _ color: String = "tx", _ p: NSParagraphStyle? = nil) -> [NSAttributedString.Key: Any] {
        var a: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: Design.color(color)]
        if let p { a[.paragraphStyle] = p; a[.baselineOffset] = (p.minimumLineHeight - font.ascender + font.descender) / 4 }
        return a
    }

    // MARK: inline

    private static let inlineRe = try! NSRegularExpression(pattern: "`([^`]+)`|\\*\\*([^*]+)\\*\\*|\\[([^\\]]+)\\]\\(([^)\\s]+)\\)|(?<![\\w*])[*_]([^*_\\s][^*_]*)[*_](?![\\w*])")
    private static let urlRe = try! NSRegularExpression(pattern: "\\b(https?://[^\\s<>()]+[^\\s<>().,;:!?'\"])")

    /// The URL a link opens: absolute, or a path made a file URL from the brief's folder.
    func url(_ href: String) -> String {
        if href.range(of: "^[a-zA-Z][a-zA-Z0-9+.-]*:", options: .regularExpression) != nil { return href }
        let p = href.hasPrefix("/") ? href : (dir.hasSuffix("/") ? String(dir.dropLast()) : dir) + "/" + href
        return URL(fileURLWithPath: p).absoluteString
    }

    /// One line's inline Markdown, in the font and colour given.
    func inline(_ s: String, _ font: NSFont, _ color: String = "tx", _ p: NSParagraphStyle? = nil) -> NSMutableAttributedString {
        let out = NSMutableAttributedString()
        let base = attrs(font, color, p)
        let ns = s as NSString
        func text(_ t: String) {
            var rest = t as NSString
            while true {
                guard let m = BriefDoc.urlRe.firstMatch(in: rest as String, range: NSRange(location: 0, length: rest.length)) else {
                    if rest.length > 0 { out.append(NSAttributedString(string: rest as String, attributes: base)) }
                    break
                }
                if m.range.location > 0 { out.append(NSAttributedString(string: rest.substring(to: m.range.location), attributes: base)) }
                let u = rest.substring(with: m.range(at: 1))
                out.append(link(u, u, base))
                rest = rest.substring(from: m.range.location + m.range.length) as NSString
            }
        }
        var at = 0
        for m in BriefDoc.inlineRe.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            text(ns.substring(with: NSRange(location: at, length: m.range.location - at)))
            let g = { (i: Int) -> String? in m.range(at: i).location == NSNotFound ? nil : ns.substring(with: m.range(at: i)) }
            if let c = g(1) {
                var a = base
                a[.font] = NSFont.monospacedSystemFont(ofSize: font.pointSize - 2, weight: .regular)
                a[.backgroundColor] = Design.color(codeFill)
                out.append(NSAttributedString(string: "\u{2009}" + c + "\u{2009}", attributes: a))
            } else if let b = g(2) {
                var a = base
                a[.font] = NSFont.systemFont(ofSize: font.pointSize, weight: .bold)
                out.append(NSAttributedString(string: b, attributes: a))
            } else if let l = g(3), let h = g(4) {
                out.append(link(l, h, base))
            } else if let e = g(5) {
                var a = base
                a[.font] = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)
                out.append(NSAttributedString(string: e, attributes: a))
            }
            at = m.range.location + m.range.length
        }
        text(ns.substring(from: at))
        return out
    }

    private func link(_ label: String, _ href: String, _ base: [NSAttributedString.Key: Any]) -> NSAttributedString {
        var a = base
        let u = url(href)
        a[.link] = u
        a[.toolTip] = u
        return NSAttributedString(string: label, attributes: a)
    }

    // MARK: blocks

    private static let task = try! NSRegularExpression(pattern: "^\\[([ xX>?~-]|now|you|wait)\\]\\s+")
    private static let done: Set<String> = ["x", "X", "-"]

    /// A checkbox (.md .chkl i.cb): plain, done (ticked, green), under way (a blue dot), for you (orange).
    static func checkbox(_ mark: String) -> NSImage {
        let img = NSImage(size: NSSize(width: 13, height: 13), flipped: false) { r in
            let box = NSBezierPath(roundedRect: r.insetBy(dx: 0.75, dy: 0.75), xRadius: 3.5, yRadius: 3.5)
            box.lineWidth = 1.5
            if done.contains(mark) {
                Design.color("ok").setFill()
                NSBezierPath(roundedRect: r, xRadius: 4, yRadius: 4).fill()
                let t = NSBezierPath()
                t.lineWidth = 1.8; t.lineCapStyle = .round; t.lineJoinStyle = .round
                let s: CGFloat = 13 / 10
                t.move(to: NSPoint(x: 2 * s + 0.6, y: 13 - 5.2 * s)); t.line(to: NSPoint(x: 4 * s + 0.6, y: 13 - 7.2 * s)); t.line(to: NSPoint(x: 8 * s + 0.6, y: 13 - 2.8 * s))
                NSColor.white.setStroke(); t.stroke()
            } else if mark == ">" || mark == "now" {
                Design.color("work").setStroke(); box.stroke()
                Design.color("work").setFill()
                NSBezierPath(ovalIn: NSRect(x: 6.5 - 2.75, y: 6.5 - 2.75, width: 5.5, height: 5.5)).fill()
            } else {
                Design.color(mark == "?" || mark == "you" ? "you" : "tx3").setStroke(); box.stroke()
            }
            return true
        }
        return img
    }

    private struct Item { let indent: Int; var text: String; var marker = "-" }

    private mutating func list(_ items: [Item], level: Int, into out: NSMutableAttributedString) {
        guard let base = items.first?.indent else { return }
        let tasks = items.contains { $0.indent == base && BriefDoc.task.firstMatch(in: $0.text, range: NSRange(location: 0, length: ($0.text as NSString).length)) != nil }
        var i = 0
        while i < items.count {
            let it = items[i]
            if it.indent > base { i += 1; continue }
            var kids: [Item] = []
            var j = i + 1
            while j < items.count && items[j].indent > base { kids.append(items[j]); j += 1 }
            let ns = it.text as NSString
            let m = BriefDoc.task.firstMatch(in: it.text, range: NSRange(location: 0, length: ns.length))
            let mark = m.map { ns.substring(with: $0.range(at: 1)) }
            // A document's box: only `[ ]` and `[x]` are boxes (the hub's checklist), K-th in the text.
            let boxK: Int? = doc && mark.map({ [" ", "x", "X"].contains($0) }) == true ? docBoxes.count : nil
            if boxK != nil { docBoxes.append((ns.substring(from: m!.range.length).trimmingCharacters(in: .whitespaces), mark != " ")) }
            let num = it.marker.first?.isNumber == true ? it.marker : nil
            let body = m.map { ns.substring(from: $0.range.length) } ?? it.text
            // .md ul: 20 points a level; a checklist has none of its own, its box then 9 points.
            let left = CGFloat(level) * 22 + (tasks ? 0 : 20)
            let p = tasks ? para(after: 2, indent: left + 22, first: left, tab: left + 22) : para(after: 2, indent: left, first: max(0, left - (num != nil ? 20 : 14)), tab: left)
            let line = NSMutableAttributedString()
            if let mk = mark {
                let a = NSTextAttachment()
                let img = BriefDoc.checkbox(mk)
                a.image = img
                a.bounds = NSRect(x: 0, y: -1.5, width: 13, height: 13)
                let box = NSMutableAttributedString(attachment: a)
                if let k = boxK, tick { box.addAttribute(BriefDoc.entryKey, value: "rvn-box:\(k)", range: NSRange(location: 0, length: box.length)) }
                // A plan's steps (Do:, Gate: ...) move as it runs: not ticked by hand.
                if inPlan && planTick && body.range(of: "^(Do|Done when|Branch|Gate)\\s*:", options: [.regularExpression, .caseInsensitive]) == nil {
                    box.addAttribute(BriefDoc.entryKey, value: "rvn-task:\(planTasks.count)", range: NSRange(location: 0, length: box.length))
                    box.addAttribute(.toolTip, value: t(BriefDoc.done.contains(mk) ? "pg.untickTask" : "pg.tickTask", ["task": body]), range: NSRange(location: 0, length: box.length))
                    planTasks.append((objective, body.trimmingCharacters(in: .whitespaces), BriefDoc.done.contains(mk)))
                }
                line.append(box)
                boxes.append(mk)
                line.append(NSAttributedString(string: "\t", attributes: attrs(bodyFont, "tx", p)))
            } else if tasks {
                line.append(NSAttributedString(string: "\t", attributes: attrs(bodyFont, "tx", p)))
            } else {
                line.append(NSAttributedString(string: (num ?? "•") + "\t", attributes: attrs(num != nil ? bodyFont.withTabularDigits : bodyFont, num != nil ? "tx2" : "tx", p)))
            }
            let isDone = mark.map { BriefDoc.done.contains($0) } ?? false
            let txt = inline(body, bodyFont, isDone ? "tx3" : "tx", p)
            if isDone { txt.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: NSRange(location: 0, length: txt.length)) }
            line.append(txt)
            line.append(NSAttributedString(string: "\n", attributes: attrs(bodyFont, "tx", p)))
            line.addAttribute(.paragraphStyle, value: p, range: NSRange(location: 0, length: line.length))
            out.append(line)
            if !kids.isEmpty { list(kids, level: level + 1, into: out) }
            i = j
        }
        // The list's margin under it (.md ul margin-bottom 8).
        if level == 0 { bumpLast(out, by: 8 + BriefDoc.gap) }
    }

    /// The last paragraph's space after, made `by` more.
    private func bumpLast(_ out: NSMutableAttributedString, by: CGFloat) {
        guard out.length > 0 else { return }
        let r = (out.string as NSString).paragraphRange(for: NSRange(location: out.length - 1, length: 0))
        if let p = (out.attribute(.paragraphStyle, at: r.location, effectiveRange: nil) as? NSParagraphStyle)?.mutableCopy() as? NSMutableParagraphStyle {
            p.paragraphSpacing += by
            out.addAttribute(.paragraphStyle, value: p, range: r)
        }
    }

    private mutating func blocks(_ lines: [String], into out: NSMutableAttributedString) {
        var paraLines: [String] = []
        var quoteLines: [String] = []
        var items: [Item] = []
        func flushQuote() {
            guard !quoteLines.isEmpty else { return }
            // .md blockquote: a line at its left, its words in tx2.
            let blk = NSTextBlock()
            blk.setContentWidth(100, type: .percentageValueType)
            blk.setWidth(3, type: .absoluteValueType, for: .border, edge: .minX)
            blk.setBorderColor(Design.color("sep"), for: .minX)
            blk.setWidth(12, type: .absoluteValueType, for: .padding, edge: .minX)
            let p = para(after: 0)
            p.textBlocks = [blk]
            let s = inline(quoteLines.joined(separator: " "), bodyFont, "tx2", p)
            s.append(NSAttributedString(string: "\n", attributes: attrs(bodyFont, "tx2", p)))
            out.append(s)
            bumpLast(out, by: 8 + BriefDoc.gap)
            quoteLines = []
        }
        func flushPara() {
            flushQuote()
            guard !paraLines.isEmpty else { return }
            let p = para()
            let s = inline(paraLines.joined(separator: " "), bodyFont, "tx", p)
            s.append(NSAttributedString(string: "\n", attributes: attrs(bodyFont, "tx", p)))
            out.append(s)
            bumpLast(out, by: BriefDoc.gap)
            paraLines = []
        }
        func flush() {
            flushPara()
            if !items.isEmpty { list(items, level: 0, into: out); items = [] }
        }
        var i = 0
        while i < lines.count {
            let l = lines[i]
            if l.range(of: "^\\s*(```|~~~)", options: .regularExpression) != nil {
                flush()
                var code: [String] = []
                i += 1
                while i < lines.count && lines[i].range(of: "^\\s*(```|~~~)", options: .regularExpression) == nil { code.append(lines[i]); i += 1 }
                i += 1
                let blk = RoundBlock()
                blk.fillName = codeFill
                blk.setWidth(12, type: .absoluteValueType, for: .padding, edge: .minX)
                blk.setWidth(12, type: .absoluteValueType, for: .padding, edge: .maxX)
                blk.setWidth(10, type: .absoluteValueType, for: .padding, edge: .minY)
                blk.setWidth(10, type: .absoluteValueType, for: .padding, edge: .maxY)
                blk.setWidth(10, type: .absoluteValueType, for: .margin, edge: .maxY)
                let p = para(after: 0, lh: 1.5, size: 12.5)
                p.textBlocks = [blk]
                p.lineBreakMode = .byCharWrapping
                let f = NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)
                out.append(NSAttributedString(string: code.joined(separator: "\u{2028}") + "\n", attributes: attrs(f, "tx", p)))
                bumpLast(out, by: BriefDoc.gap)
                continue
            }
            if let m = l.range(of: "^#{3,6}\\s+", options: .regularExpression) {
                flush()
                if inPlan { objective = String(l[m.upperBound...]).trimmingCharacters(in: .whitespaces) }
                let hs = doc ? size + 0.5 : 13.5
                let p = para(14, after: 4 + BriefDoc.gap, lh: 1.6, size: hs)
                let s = inline(String(l[m.upperBound...]), Fonts.pt(hs, Fonts.w650), "tx", p)
                s.append(NSAttributedString(string: "\n", attributes: attrs(bodyFont, "tx", p)))
                out.append(s)
                i += 1
                continue
            }
            if let li = l.range(of: "^(\\s*)(?:[-*+]|\\d+[.)])\\s+", options: .regularExpression) {
                flushPara()
                let lead = l[l.startIndex..<li.upperBound]
                let ind = lead.prefix { $0 == " " || $0 == "\t" }.replacingOccurrences(of: "\t", with: "  ").count
                let mk = lead.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ")", with: ".")
                items.append(Item(indent: ind, text: String(l[li.upperBound...]), marker: mk))
                i += 1
                continue
            }
            if l.trimmingCharacters(in: .whitespaces).isEmpty { flush(); i += 1; continue }
            if let q = l.range(of: "^\\s*>\\s?", options: .regularExpression) {
                if !items.isEmpty { flush() }
                if !paraLines.isEmpty { flushPara() }
                quoteLines.append(String(l[q.upperBound...]).trimmingCharacters(in: .whitespaces))
                i += 1
                continue
            }
            if !items.isEmpty && l.range(of: "^\\s{2,}\\S", options: .regularExpression) != nil {
                items[items.count - 1].text += " " + l.trimmingCharacters(in: .whitespaces)
                i += 1
                continue
            }
            if !items.isEmpty { flush() }
            flushQuote()
            paraLines.append(l.trimmingCharacters(in: .whitespaces))
            i += 1
        }
        flush()
    }

    private func heading(_ name: String, count: String?, first: Bool) -> NSMutableAttributedString {
        let p = para(first ? 0 : 20, after: 6 + BriefDoc.gap, lh: 1.6, size: 15)
        let s = inline(name, Fonts.pt(15, .bold), "tx", p)
        if let c = count { s.append(NSAttributedString(string: "  " + c, attributes: attrs(Fonts.pt(12, .medium), "tx3", p))) }
        s.append(NSAttributedString(string: "\n", attributes: attrs(Fonts.pt(15, .bold), "tx", p)))
        return s
    }

    /// One line of `s` in `font` that fits `w`, cut with an ellipsis.
    private func oneLine(_ s: NSAttributedString, _ w: CGFloat) -> NSAttributedString {
        if s.size().width <= w { return s }
        var lo = 0, hi = s.length
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            let t = NSMutableAttributedString(attributedString: s.attributedSubstring(from: NSRange(location: 0, length: mid)))
            t.append(NSAttributedString(string: "…"))
            if t.size().width <= w { lo = mid } else { hi = mid - 1 }
        }
        let t = NSMutableAttributedString(attributedString: s.attributedSubstring(from: NSRange(location: 0, length: lo)))
        t.append(NSAttributedString(string: "…", attributes: s.length > 0 ? s.attributes(at: max(0, lo - 1), effectiveRange: nil) : [:]))
        return t
    }

    /// A legacy Next step: its dated entries, newest first and open, the others one line each.
    private func entries(_ list: [BriefEntry], into out: NSMutableAttributedString) {
        let f = Fonts.pt(13.5)
        for (i, e) in list.enumerated() {
            let isOpen = open.contains(i)
            let blk = RoundBlock()
            blk.ringName = "sep"
            blk.roundTop = i == 0
            blk.roundBottom = i == list.count - 1
            blk.lineAbove = i > 0
            blk.setWidth(14, type: .absoluteValueType, for: .padding, edge: .minX)
            blk.setWidth(14, type: .absoluteValueType, for: .padding, edge: .maxX)
            blk.setWidth(8, type: .absoluteValueType, for: .padding, edge: .minY)
            blk.setWidth(isOpen && e.sentences.count > 1 ? 12 : 8, type: .absoluteValueType, for: .padding, edge: .maxY)
            if i == list.count - 1 { blk.setWidth(8 + BriefDoc.gap, type: .absoluteValueType, for: .margin, edge: .maxY) }
            if i == 0 { blk.setWidth(6, type: .absoluteValueType, for: .margin, edge: .minY) }
            let p = para(after: 0, indent: 118, first: 0, tab: 118, lh: 1.5, size: 13.5)
            p.tabStops = [NSTextTab(textAlignment: .left, location: 24), NSTextTab(textAlignment: .left, location: 118)]
            p.textBlocks = [blk]
            let row = NSMutableAttributedString()
            let tog = "rvn-entry:\(i)"
            var ca = attrs(f, "tx3", p); ca[BriefDoc.entryKey] = tog
            row.append(NSAttributedString(string: isOpen ? "⌄" : "›", attributes: ca))
            var da = attrs(NSFont.monospacedSystemFont(ofSize: 12, weight: .regular), "tx3", p); da[BriefDoc.entryKey] = tog
            row.append(NSAttributedString(string: "\t" + e.date + "\t", attributes: da))
            let head = inline(isOpen ? (e.sentences.first ?? e.text) : e.text, isOpen ? Fonts.pt(13.5, .semibold) : f, "tx", p)
            // The whole row opens or closes it, but for its own links.
            head.enumerateAttribute(.link, in: NSRange(location: 0, length: head.length)) { v, r, _ in if v == nil { head.addAttribute(BriefDoc.entryKey, value: tog, range: r) } }
            row.append(isOpen ? head : oneLine(head, max(60, width - 28 - 118)))
            row.append(NSAttributedString(string: "\n", attributes: attrs(f, "tx", p)))
            row.addAttribute(.paragraphStyle, value: p, range: NSRange(location: 0, length: row.length))
            out.append(row)
            if isOpen && e.sentences.count > 1 {
                for s in e.sentences.dropFirst() {
                    let q = para(after: 0, indent: 118 + 18, first: 118 + 4, tab: 118 + 18, lh: 1.6, size: 13.5)
                    q.textBlocks = [blk]
                    let x = NSMutableAttributedString(string: "•\t", attributes: attrs(f, "tx2", q))
                    x.append(inline(s, f, "tx2", q))
                    x.append(NSAttributedString(string: "\n", attributes: attrs(f, "tx2", q)))
                    out.append(x)
                }
            }
        }
    }

    /// A document's heading: its level (1 or 2), its words, where they are in
    /// the text, and for a section (##) its number among the sections and whether it is folded.
    struct Heading { let level: Int; let title: String; let range: NSRange; let section: Int?; let folded: Bool }

    private static let boxLine = try! NSRegularExpression(pattern: "^\\s*(?:[-*+]|\\d+[.)])\\s+\\[([ xX])\\]\\s+(.*)$")

    /// A Markdown document (a rules file, a page's item) as one text: # a
    /// title, ## a section that folds (`folded`: their numbers), ### under it,
    /// paragraphs with their wrapped lines joined into one, lists whose
    /// continuation lines stay in their item, numbered lists, boxes, quotes,
    /// code, links and *em*. Front matter is not drawn.
    mutating func document(_ md: String, folded: Set<Int> = [], skipTitle: String? = nil) -> (text: NSAttributedString, headings: [Heading]) {
        doc = true; boxes = []; docBoxes = []
        let out = NSMutableAttributedString()
        var heads: [Heading] = []
        var lines = md.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        if lines.first == "---", let end = lines.dropFirst().firstIndex(of: "---") { lines = Array(lines[(end + 1)...]) }
        var body: [String] = []
        var section = -1
        var fenced = false
        func flushBody() {
            if section >= 0 && folded.contains(section) {
                // Not drawn, but its boxes keep their places among the text's.
                var f = false
                for l in body {
                    if l.range(of: "^\\s*(```|~~~)", options: .regularExpression) != nil { f.toggle(); continue }
                    let ns = l as NSString
                    if !f, let m = BriefDoc.boxLine.firstMatch(in: l, range: NSRange(location: 0, length: ns.length)) {
                        docBoxes.append((ns.substring(with: m.range(at: 2)).trimmingCharacters(in: .whitespaces), ns.substring(with: m.range(at: 1)) != " "))
                    }
                }
            } else { blocks(body, into: out) }
            body = []
        }
        for l in lines {
            if l.range(of: "^\\s*(```|~~~)", options: .regularExpression) != nil { fenced.toggle(); body.append(l); continue }
            guard !fenced, let m = l.range(of: "^#{1,2}\\s+", options: .regularExpression) else { body.append(l); continue }
            flushBody()
            let level = l.hasPrefix("##") ? 2 : 1
            let title = String(l[m.upperBound...]).replacingOccurrences(of: "\\s+#+\\s*$", with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
            // The title the card's head already says is not said twice.
            if level == 1 && out.length == 0 && heads.isEmpty && title == skipTitle { continue }
            if level == 2 { section += 1 }
            let isFolded = level == 2 && folded.contains(section)
            let hs: CGFloat = level == 1 ? size + 6 : size + 2
            let p = para(out.length == 0 ? 0 : (level == 1 ? 24 : 16), after: level == 1 ? 10 : 2 + BriefDoc.gap, lh: 1.35, size: hs)
            let s = inline(title, Fonts.pt(hs, level == 1 ? .bold : Fonts.w650), isFolded ? "tx2" : "tx", p)
            if level == 2 {
                // The heading's words fold or unfold its section (its links still open).
                s.enumerateAttribute(.link, in: NSRange(location: 0, length: s.length)) { v, r, _ in if v == nil { s.addAttribute(BriefDoc.entryKey, value: "rvn-fold:\(section)", range: r) } }
            }
            heads.append(Heading(level: level, title: s.string, range: NSRange(location: out.length, length: s.length), section: level == 2 ? section : nil, folded: isFolded))
            s.append(NSAttributedString(string: "\n", attributes: attrs(Fonts.pt(hs, .bold), "tx", p)))
            out.append(s)
        }
        flushBody()
        if out.length > 0, out.string.hasSuffix("\n") { out.deleteCharacters(in: NSRange(location: out.length - 1, length: 1)) }
        return (out, heads)
    }

    private static let fields: [(String, String)] = [("^goal:\\s*", "Goal"), ("^done means:\\s*", "Done means"), ("^kind:\\s*", "Kind"), ("^stage:\\s*", "Stage"), ("^waiting on:\\s*", "Waiting on")]

    /// The brief as a page: its sections in order, the Next step's dated entries (the hub's), the plan's count.
    mutating func page(_ md: String, entries next: [BriefEntry]) -> NSAttributedString {
        boxes = []
        planTasks = []
        let out = NSMutableAttributedString()
        let lines = md.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        var i = 0
        while i < lines.count && lines[i].range(of: "^##\\s", options: .regularExpression) == nil {
            let l = lines[i].trimmingCharacters(in: .whitespaces)
            if let f = BriefDoc.fields.first(where: { l.range(of: $0.0, options: [.regularExpression, .caseInsensitive]) != nil }),
               let r = l.range(of: f.0, options: [.regularExpression, .caseInsensitive]) {
                out.append(heading(f.1, count: nil, first: out.length == 0))
                let p = para()
                let s = inline(String(l[r.upperBound...]), bodyFont, "tx", p)
                s.append(NSAttributedString(string: "\n", attributes: attrs(bodyFont, "tx", p)))
                out.append(s)
                bumpLast(out, by: BriefDoc.gap)
            }
            i += 1
        }
        while i < lines.count {
            let name = lines[i].replacingOccurrences(of: "^##\\s+", with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
            var body: [String] = []
            i += 1
            while i < lines.count && lines[i].range(of: "^##\\s", options: .regularExpression) == nil { body.append(lines[i]); i += 1 }
            let key = name.lowercased()
            if (key == "next step" || key == "next") && !next.isEmpty {
                out.append(heading(name, count: t("brief.entriesSplit", ["n": "\(next.count)"]), first: out.length == 0))
                entries(next, into: out)
                continue
            }
            var count: String? = nil
            if key == "plan" {
                let tasks = body.filter { $0.range(of: "^\\s*[-*+]\\s+\\[", options: .regularExpression) != nil }
                let done = tasks.filter { $0.range(of: "^\\s*[-*+]\\s+\\[[xX-]\\]", options: .regularExpression) != nil }.count
                if !tasks.isEmpty { count = t("brief.planCount", ["done": "\(done)", "n": "\(tasks.count)"]) }
            }
            out.append(heading(name, count: count, first: out.length == 0))
            inPlan = key == "plan" || key == "objectives" || key == "milestones"
            objective = ""
            blocks(body, into: out)
            inPlan = false
        }
        // No trailing empty line.
        if out.length > 0, out.string.hasSuffix("\n") { out.deleteCharacters(in: NSRange(location: out.length - 1, length: 1)) }
        // The page's padding (.bdoc .doc-b 26 above, 40 under) in its first
        // and last paragraphs: a text view keeps its first line at the top
        // when it reflows, so an inset above would be scrolled away.
        // The space above is a line of its own: a text container's first
        // paragraph has no space before it.
        if out.length > 0 {
            let sp = NSMutableParagraphStyle()
            sp.minimumLineHeight = 26; sp.maximumLineHeight = 26
            out.insert(NSAttributedString(string: "\n", attributes: [.font: Fonts.pt(4), .paragraphStyle: sp]), at: 0)
            bumpLast(out, by: 40)
        }
        return out
    }
}
