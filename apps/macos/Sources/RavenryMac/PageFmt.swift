// How a page's values are said as text (apps/desktop/src/renderer/pages.ts
// and pagefmt.ts, packages/page-format text.ts): a field read by its path,
// a value as words, a date as a time, how long ago, a value's tone, what a
// page's items are called, and a document's Markdown cut into blocks. This
// is drawing only: the rows, their order, groups, counts and stats come
// drawn from the hub (`drawn`, hub/server/pagedraw.mjs).

import AppKit

typealias Item = [String: Any]

enum PageFmt {
    /// A field by name or dotted path (getField).
    static func field(_ item: Item, _ path: String) -> Any? {
        var cur: Any? = item
        for seg in path.split(separator: ".", omittingEmptySubsequences: false) {
            guard let d = cur as? [String: Any] else { return nil }
            cur = d[String(seg)]
        }
        if cur is NSNull { return nil }
        return cur
    }

    /// A value as text: a list joined with commas, an object as nothing (valueText).
    static func text(_ v: Any?) -> String {
        guard let v, !(v is NSNull) else { return "" }
        if let a = v as? [Any] { return a.map { text($0) }.filter { !$0.isEmpty }.joined(separator: ", ") }
        if v is [String: Any] { return "" }
        if let n = v as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
            let d = n.doubleValue
            if d == d.rounded(), abs(d) < 1e15 { return String(Int64(d)) }
            return "\(d)"
        }
        return "\(v)"
    }

    /// Action text with each {field} filled from the item (fillText).
    static func fill(_ parts: Any?, _ item: Item) -> String {
        guard let ps = parts as? [[String: Any]] else { return "" }
        return ps.map { p in p["field"].map { text(field(item, "\($0)")) } ?? (p["text"] as? String ?? "") }.joined()
    }

    /// "fixing" is "Fixing" (capitaliseField).
    static func capitalise(_ s: String) -> String {
        let t = s.replacingOccurrences(of: "_", with: " ")
        return t.prefix(1).uppercased() + t.dropFirst()
    }

    static var now: () -> Date = { When.now() }

    private static let dayOnly = try! NSRegularExpression(pattern: "^\\d{4}-\\d{2}-\\d{2}$")
    private static func isDayOnly(_ s: String) -> Bool { dayOnly.firstMatch(in: s, range: NSRange(location: 0, length: s.utf16.count)) != nil }
    /// A date the way JavaScript's Date.parse reads the hub's: ISO times, a day alone at noon.
    static func date(_ s: String) -> Date? {
        if isDayOnly(s) {
            let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd HH:mm"
            return f.date(from: s + " 12:00")
        }
        if let d = When.date(s) { return d }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX")
        for fmt in ["yyyy-MM-dd'T'HH:mm:ssXXXXX", "yyyy-MM-dd'T'HH:mm:ss.SSSXXXXX", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm:ss"] {
            f.dateFormat = fmt
            if let d = f.date(from: s) { return d }
        }
        return nil
    }

    /// 16:52 today, Today, Yesterday, Mon this week, else Oct 30 (timeText).
    static func time(_ v: Any?) -> String {
        let s = text(v)
        guard let d = date(s) else { return s }
        let only = isDayOnly(s)
        let cal = Calendar.current, n = now()
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: d), to: cal.startOfDay(for: n)).day ?? 0
        if days == 0 && !only { let c = cal.dateComponents([.hour, .minute], from: d); return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0) }
        if days == 0 { return t("pg.today") }
        if days == 1 { return t("pg.yesterday") }
        let dayNames = t("pg.days").split(separator: ",").map(String.init)
        let months = t("pg.months").split(separator: ",").map(String.init)
        if days > 1 && days < 7 { return dayNames[(cal.component(.weekday, from: d) - 1) % 7] }
        let y = cal.component(.year, from: d)
        return "\(months[cal.component(.month, from: d) - 1]) \(cal.component(.day, from: d))\(y != cal.component(.year, from: n) ? ", \(y)" : "")"
    }

    /// "2 h ago", "3 days ago" (agoText).
    static func ago(_ v: Any?) -> String {
        guard let d = date(text(v)) else { return "" }
        let s = max(0, now().timeIntervalSince(d))
        if s < 3600 { return t("pg.minAgo", ["n": "\(max(1, Int((s / 60).rounded())))"]) }
        if s < 86400 { return t("pg.hAgo", ["n": "\(Int((s / 3600).rounded()))"]) }
        let n = Int((s / 86400).rounded())
        return n == 1 ? t("pg.yesterdayAgo") : t("pg.daysAgo", ["n": "\(n)"])
    }

    // A value's tone: words that say a thing is fine, or that it needs you (toneOf).
    private static let okWords: Set<String> = ["done", "fixed", "checked", "passed", "clean", "shipped", "greenlit", "merged", "ok", "answered", "pushed"]
    private static let youWords: Set<String> = ["out of date", "ahead", "failed", "broken", "blocked", "stale", "urgent", "you", "gate", "needs you"]
    /// "ok", "you", "muted", "faint" or nil.
    static func tone(_ v: Any?) -> String? {
        let s = text(v).lowercased()
        if okWords.contains(s) { return "ok" }
        if youWords.contains(s) { return "you" }
        if s == "changed" { return "muted" }
        if s == "no_upstream" { return "faint" }
        return nil
    }
    /// A provider's status_text takes its status's tone (fieldTone).
    static func fieldTone(_ item: Item, _ f: String) -> String? {
        guard f.hasSuffix("_text") else { return nil }
        let k = String(f.dropLast(5))
        return field(item, k) != nil ? tone(field(item, k)) : nil
    }

    /// What a page's items are called: its New button's word (New note: notes), else files (noun).
    static func noun(_ model: [String: Any], _ n: Int) -> String {
        let make = (model["actions"] as? [[String: Any]] ?? []).first { $0["kind"] as? String == "create" }
        let lbl = make?["label"] as? String ?? ""
        let w: String? = lbl.range(of: "^New (\\w+)$", options: [.regularExpression, .caseInsensitive]) != nil ? String(lbl.split(separator: " ")[1]) : nil
        guard let w else { return n == 1 ? t("pg.file") : t("pg.files") }
        let one = w.lowercased()
        return n == 1 ? one : one.hasSuffix("s") ? one : one + "s"
    }

    /// The text of an entry of a progress list (entryText).
    static func entryText(_ x: Any?) -> String {
        if let d = x as? [String: Any] { return text(d["text"] ?? d["title"] ?? d["name"]) }
        return x as? String ?? ""
    }

    /// A trust explanation's "Runs <cmd> in <where>" with its command apart (wouldText).
    static func would(_ does: String) -> (cmd: String, where: String)? {
        guard does.hasPrefix("Runs "), let r = does.range(of: " in ", options: [], range: does.index(does.startIndex, offsetBy: 5)..<does.endIndex) else { return nil }
        return (String(does[does.index(does.startIndex, offsetBy: 5)..<r.lowerBound]), String(does[r.upperBound...]))
    }

    // MARK: a document's Markdown (markdown())

    enum Block {
        case heading(Int, String)
        case para(String)
        case quote(String)
        case code(String)
        /// A list's items: text and, for a checkbox, its state and its place among the text's boxes.
        case list([(text: String, box: Bool?, k: Int)])
    }

    /// Headings, lists, checkboxes, quotes and code; raw HTML stays text, no picture is ever loaded.
    static func blocks(_ md: String) -> [Block] {
        var out: [Block] = []
        var list: [(text: String, box: Bool?, k: Int)]? = nil
        var code: [String]? = nil
        var boxes = 0
        func endList() { if let l = list { out.append(.list(l)); list = nil } }
        func m(_ s: String, _ p: String) -> [String]? {
            guard let re = try? NSRegularExpression(pattern: p), let r = re.firstMatch(in: s, range: NSRange(location: 0, length: s.utf16.count)) else { return nil }
            return (0..<r.numberOfRanges).map { i in Range(r.range(at: i), in: s).map { String(s[$0]) } ?? "" }
        }
        for raw in md.components(separatedBy: "\n") {
            let l = raw.hasSuffix("\r") ? String(raw.dropLast()) : raw
            if code != nil {
                if m(l, "^\\s*(```|~~~)") != nil { out.append(.code(code!.joined(separator: "\n"))); code = nil } else { code!.append(l) }
                continue
            }
            if m(l, "^\\s*(```|~~~)") != nil { endList(); code = []; continue }
            if let h = m(l, "^(#{1,6})\\s+(.+?)\\s*#*$") { endList(); out.append(.heading(min(h[1].count, 3), h[2])); continue }
            let box = m(l, "^\\s*(?:[-*+]|\\d+[.)])\\s+\\[([ xX])\\]\\s+(.*)$")
            let li = m(l, "^\\s*(?:[-*+]|\\d+[.)])\\s+(.*)$")
            if box != nil || li != nil {
                if list == nil { list = [] }
                if let b = box { list!.append((b[2].trimmingCharacters(in: .whitespaces), b[1] != " ", boxes)); boxes += 1 } else { list!.append((li![1], nil, -1)) }
                continue
            }
            endList()
            if l.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            if let q = m(l, "^>\\s?(.*)$") { out.append(.quote(q[1])); continue }
            out.append(.para(l))
        }
        endList()
        if let c = code { out.append(.code(c.joined(separator: "\n"))) }
        return out
    }

    /// Inline `code` and **bold** as attributed text.
    static func inline(_ s: String, _ font: NSFont, _ color: String) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let base: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: Design.color(color)]
        guard let re = try? NSRegularExpression(pattern: "(`[^`]+`|\\*\\*[^*]+\\*\\*)") else { return NSAttributedString(string: s, attributes: base) }
        var last = s.startIndex
        for r in re.matches(in: s, range: NSRange(location: 0, length: s.utf16.count)) {
            guard let rr = Range(r.range, in: s) else { continue }
            if rr.lowerBound > last { out.append(NSAttributedString(string: String(s[last..<rr.lowerBound]), attributes: base)) }
            let m = String(s[rr])
            if m.hasPrefix("`") {
                var a = base; a[.font] = Fonts.mono(12); a[.backgroundColor] = Design.color("card2")
                out.append(NSAttributedString(string: String(m.dropFirst().dropLast()), attributes: a))
            } else {
                var a = base; a[.font] = NSFont.systemFont(ofSize: font.pointSize, weight: .bold)
                out.append(NSAttributedString(string: String(m.dropFirst(2).dropLast(2)), attributes: a))
            }
            last = rr.upperBound
        }
        if last < s.endIndex { out.append(NSAttributedString(string: String(s[last...]), attributes: base)) }
        return out
    }
}
