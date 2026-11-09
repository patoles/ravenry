// The terminal settings, the Electron app's own (apps/desktop/src/main/
// settingsstore.ts): settings.json in the app's data folder
// (RAVENRY_DESKTOP_DATA, else ~/Library/Application Support/Ravenry), its
// keys, kinds, ranges and defaults from shared/settings/settings.json, the
// shipped themes from shared/themes/ and the imported ones from the data
// folder's themes/ (ids "user:<file>"). A missing or wrong value reads as
// its default; a change is checked whole and written whole at once (a
// temporary file renamed over it), keeping the keys this app does not
// know. The file is read again when the other app writes it.
//
// A window off every screen (the bench, the self-test) without
// RAVENRY_DESKTOP_DATA keeps them in memory only, never the person's.

import Foundation

struct ThemeInfo {
    let id: String
    let name: String
    let appearance: String
    let credit: String?
    let builtIn: Bool
    /// The xterm.js ITheme: background, foreground, cursor, black ... brightWhite, as CSS colours.
    let colors: [String: String]
}

final class SettingsStore {
    /// shared/settings/settings.json.
    static let spec: [String: Any] = {
        guard let u = Bundle.main.url(forResource: "settings", withExtension: "json"), let d = try? Data(contentsOf: u),
              let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return [:] }
        return j
    }()
    static var keys: [String: [String: Any]] { spec["keys"] as? [String: [String: Any]] ?? [:] }
    static var fallback: [String] { spec["fontFallback"] as? [String] ?? ["Menlo"] }
    static func range(_ k: String) -> (min: Int, max: Int) { (keys[k]?["min"] as? Int ?? 0, keys[k]?["max"] as? Int ?? 0) }

    let file: URL?
    let themesDir: URL?
    private(set) var values: [String: Any] = [:]
    /// What the file held besides the settings (kept on writing).
    private var other: [String: Any] = [:]
    private(set) var userThemes: [ThemeInfo] = []
    private var stamp: Date?
    private var timer: Timer?
    /// After any change: this app's or the file's.
    var onChange: (() -> Void)?

    init(offscreen: Bool, env: [String: String] = ProcessInfo.processInfo.environment) {
        var dir: URL?
        if let d = env["RAVENRY_DESKTOP_DATA"], !d.isEmpty { dir = URL(fileURLWithPath: d) }
        else if !offscreen {
            dir = (FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")).appendingPathComponent("Ravenry")
        }
        file = dir?.appendingPathComponent("settings.json")
        themesDir = dir?.appendingPathComponent("themes")
        load()
        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.readIfChanged() }
    }

    private func modified() -> Date? {
        guard let f = file else { return nil }
        return (try? FileManager.default.attributesOfItem(atPath: f.path))?[.modificationDate] as? Date
    }

    private func readIfChanged() {
        guard file != nil, modified() != stamp else { return }
        load()
        onChange?()
    }

    private func load() {
        var raw: [String: Any] = [:]
        if let f = file, let d = try? Data(contentsOf: f), let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] { raw = j }
        stamp = modified()
        userThemes = readThemes()
        values = [:]
        other = raw.filter { Self.keys[$0.key] == nil }
        for (k, f) in Self.keys { values[k] = Self.ok(k, raw[k], themes: nil) ? raw[k] : f["default"] }
    }

    /// The shipped themes in the window's order, then the imported ones.
    var themes: [ThemeInfo] { Self.builtIn + userThemes }

    static let builtIn: [ThemeInfo] = (spec["themes"] as? [String] ?? []).compactMap { id in
        guard let u = Bundle.main.url(forResource: id, withExtension: "json", subdirectory: "themes") else { return nil }
        return theme(u, id: id, builtIn: true)
    }

    private static func theme(_ u: URL, id: String, builtIn: Bool) -> ThemeInfo? {
        guard let d = try? Data(contentsOf: u), let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let name = j["name"] as? String, let ap = j["appearance"] as? String, ap == "dark" || ap == "light",
              let c = j["theme"] as? [String: String], c["background"] != nil, c["foreground"] != nil else { return nil }
        return ThemeInfo(id: id, name: name, appearance: ap, credit: j["credit"] as? String, builtIn: builtIn, colors: c)
    }

    private func readThemes() -> [ThemeInfo] {
        guard let dir = themesDir, let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
        return names.filter { $0.hasSuffix(".json") }.sorted().compactMap { Self.theme(dir.appendingPathComponent($0), id: "user:\(String($0.dropLast(5)))", builtIn: false) }
    }

    /// A value's check, from its kind (apps/desktop/src/shared/settings.ts FIELDS); `themes` also asks the theme to exist.
    static func ok(_ k: String, _ v: Any?, themes: [ThemeInfo]?) -> Bool {
        guard let f = keys[k], let v else { return false }
        switch f["kind"] as? String {
        case "bool": return (v as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } ?? false
        case "int":
            guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue == n.doubleValue.rounded() else { return false }
            return n.intValue >= range(k).min && n.intValue <= range(k).max
        case "oneOf": return (v as? String).map { (f["values"] as? [String] ?? []).contains($0) } ?? false
        case "family":
            guard let s = v as? String else { return false }
            return !s.trimmingCharacters(in: .whitespaces).isEmpty && s.count <= 100 && s.range(of: "[\"',;{}\\\\\\u{0000}-\\u{001f}]", options: .regularExpression) == nil
        case "theme":
            guard let s = v as? String, s.range(of: "^(user:)?[a-z0-9][a-z0-9-]{0,59}$", options: .regularExpression) != nil else { return false }
            return themes.map { $0.contains { $0.id == s } } ?? true
        default: return false
        }
    }

    subscript(_ k: String) -> Any? { values[k] }
    func bool(_ k: String) -> Bool { values[k] as? Bool ?? false }
    func int(_ k: String) -> Int { values[k] as? Int ?? 0 }
    func string(_ k: String) -> String { values[k] as? String ?? "" }

    /// A change: every key a setting and every value right, else nothing changes (the error says why).
    @discardableResult
    func set(_ patch: [String: Any]) -> String? {
        for (k, v) in patch {
            guard Self.keys[k] != nil else { return "\(k) is not a setting" }
            guard Self.ok(k, v, themes: themes) else { return "\(k): \(v) is not right" }
        }
        for (k, v) in patch { values[k] = (k == "fontFamily" ? (v as? String)?.trimmingCharacters(in: .whitespaces) : nil) ?? v }
        write()
        onChange?()
        return nil
    }

    private func write() {
        guard let f = file else { return }
        var out = other
        out["version"] = Self.spec["version"] as? Int ?? 1
        for (k, v) in values { out[k] = v }
        guard let d = try? JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]) else { return }
        try? FileManager.default.createDirectory(at: f.deletingLastPathComponent(), withIntermediateDirectories: true)
        let tmp = f.deletingLastPathComponent().appendingPathComponent(".settings.json.\(getpid()).tmp")
        guard (try? (d + Data("\n".utf8)).write(to: tmp)) != nil else { return }
        if rename(tmp.path, f.path) != 0 { try? FileManager.default.removeItem(at: tmp) }
        stamp = modified()
    }

    /// The theme the settings pick for the system's appearance (shared/settings.ts pickTheme).
    func pickTheme(dark: Bool) -> ThemeInfo? {
        let follow = bool("themeFollowsSystem")
        let id = follow ? string(dark ? "themeDark" : "themeLight") : string("themeAlways")
        let fb = dark || !follow ? Self.spec["defaultDarkTheme"] as? String : Self.spec["defaultLightTheme"] as? String
        return themes.first { $0.id == id } ?? Self.builtIn.first { $0.id == fb }
    }
}
