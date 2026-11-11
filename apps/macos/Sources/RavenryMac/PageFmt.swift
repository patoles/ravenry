// How a page's values are said as text (apps/desktop/src/renderer/pages.ts
// and pagefmt.ts, packages/page-format text.ts): a field read by its path,
// a value as words, a date as a time, how long ago, a value's tone, what a
// page's items are called. A document's Markdown is BriefDoc.document's,
// drawn by DocView. This is drawing only: the rows, their order, groups,
// counts and stats come drawn from the hub (`drawn`, hub/server/pagedraw.mjs).

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
}
