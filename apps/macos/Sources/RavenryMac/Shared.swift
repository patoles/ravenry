// The words and the icons every client shares (shared/README.md): the
// strings from shared/strings/en.json and the icons from shared/icons/
// (written from the desktop's icons.ts by shared/icons/export.mjs), both
// bundled with the app and read at launch. A key the file does not have is
// shown as the key itself, so a missing word is seen, never blank.

import AppKit

enum Words {
    private static let words: [String: Any] = {
        guard let u = Bundle.main.url(forResource: "en", withExtension: "json"), let d = try? Data(contentsOf: u) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] ?? [:]
    }()

    static func t(_ key: String, _ vars: [String: String] = [:]) -> String {
        guard key != "$comment", let s = words[key] as? String else { return key }
        return vars.reduce(s) { $0.replacingOccurrences(of: "{\($1.key)}", with: $1.value) }
    }
}

func t(_ key: String, _ vars: [String: String] = [:]) -> String { Words.t(key, vars) }

enum SharedIcons {
    private static var cache: [String: NSImage] = [:]

    /// An icon of shared/icons drawn in a token's colour (`currentColor`),
    /// its `var(--x)` colours filled from the tokens, for the appearance
    /// in effect; `size` is its size in points (else the file's).
    static func image(_ name: String, color: String = "tx2", size: CGFloat? = nil, dark: Bool? = nil) -> NSImage? {
        let isDark = dark ?? (NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)
        let key = "\(name)|\(color)|\(size ?? 0)|\(isDark)"
        if let i = cache[key] { return i }
        guard let u = Bundle.main.url(forResource: name, withExtension: "svg", subdirectory: "icons")
                ?? Bundle.main.url(forResource: name, withExtension: "svg"),
              var s = try? String(contentsOf: u, encoding: .utf8) else { return nil }
        s = s.replacingOccurrences(of: "currentColor", with: Design.hex(color, dark: isDark))
        // var(--tx) and the like: the token's colour.
        while let r = s.range(of: "var(--") {
            guard let e = s[r.upperBound...].firstIndex(of: ")") else { break }
            let tok = String(s[r.upperBound..<e])
            s.replaceSubrange(r.lowerBound...e, with: Design.hex(tok, dark: isDark))
        }
        // A size the file leaves to its stylesheet (the rings): 14 points.
        if !s.contains("width=") { s = s.replacingOccurrences(of: "<svg ", with: "<svg width=\"14\" height=\"14\" ") }
        guard let img = NSImage(data: Data(s.utf8)) else { return nil }
        if let sz = size { img.size = NSSize(width: sz, height: sz) }
        cache[key] = img
        return img
    }

    static func clear() { cache.removeAll() }
}

/// The app's fonts at the token sizes: the system face, as the desktop's
/// -apple-system.
enum Fonts {
    static func ui(_ size: String, _ weight: NSFont.Weight = .regular) -> NSFont {
        NSFont.systemFont(ofSize: Design.size(size, 13), weight: weight)
    }
    static func pt(_ points: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        NSFont.systemFont(ofSize: points, weight: weight)
    }
    static func mono(_ points: CGFloat = 12) -> NSFont {
        NSFont.monospacedSystemFont(ofSize: points, weight: .regular)
    }
    /// Weight 650 in the desktop's CSS: between semibold and bold.
    static let w650 = NSFont.Weight(rawValue: 0.35)
}
