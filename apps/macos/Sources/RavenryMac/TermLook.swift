// What the shared settings make of a terminal, as the Electron app's
// terminalSettings (apps/desktop/src/shared/settings.ts): the font and
// its size, the theme the settings pick for the system's appearance, the
// cursor, Option as Meta, copy on select, links, the scrollback, the bell,
// closing a busy tab and the pane effect. Workspace works it out from the SettingsStore
// and gives it to every pane, again on each change of the file or of the
// system's appearance.

import AppKit

struct TermLook: Equatable {
    var font = "Menlo"
    var size: CGFloat = 13
    var theme = Theme.ravenry
    /// The cursor drawn while the program leaves it a block: 0 block, 1
    /// bar, 2 underline (the frame's codes), and whether it blinks then.
    var cursor: UInt8 = 0
    var blink = false
    /// "left", "right", "both": Option acts as Alt; empty: it types characters.
    var optionAsAlt = ""
    var copyOnSelect = false
    /// A click opens a link (without Cmd), and links look like links.
    var oneClickLinks = false
    var scrollback = 10000
    /// "visual", "sound" or "off"; the Dock bounces for a bell when the app is not in front.
    var bell = "visual"
    var bounce = true
    var confirmClose = true
    /// The pane effect drawn over every terminal (Shaders.swift), nil: off.
    var effect: GhosttyShader?

    init() {}

    /// From the settings; `pins` are values given on the command line,
    /// for this run only.
    init(_ s: SettingsStore, dark: Bool, pins: [String: Any] = [:]) {
        func v(_ k: String) -> Any? { pins[k] ?? s[k] }
        font = v("fontFamily") as? String ?? "Menlo"
        size = CGFloat(v("fontSize") as? Int ?? 13)
        if let t = s.pickTheme(dark: dark) { theme = Theme(t) }
        cursor = ["bar": 1, "underline": 2][s.string("cursorStyle")] ?? 0
        blink = s.bool("cursorBlink")
        let o = v("optionAsMeta") as? String ?? "off"
        optionAsAlt = o == "off" ? "" : o
        copyOnSelect = s.bool("copyOnSelect")
        oneClickLinks = s.bool("openLinksSingleClick")
        scrollback = s.int("scrollback")
        bell = s.string("bell")
        bounce = s.bool("bellBounceDock")
        confirmClose = s.bool("confirmCloseBusy")
        effect = ["bloom": GhosttyShader.bloom, "crt": .crt][s.string("paneEffect")]
    }
}

extension Theme {
    /// The 16 colours' names in a theme file (xterm.js's ITheme).
    static let ansiNames = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
                            "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"]

    /// A theme file's colours; one it leaves out is Ravenry's.
    init(_ t: ThemeInfo) {
        let base = Theme.ravenry
        func col(_ k: String) -> SIMD4<Float>? { t.colors[k].flatMap(Theme.css) }
        let fg = col("foreground") ?? base.foreground
        self.init(background: col("background") ?? base.background, foreground: fg, cursor: col("cursor") ?? fg,
                  selection: col("selectionBackground") ?? base.selection, findMatch: base.findMatch, findCurrent: base.findCurrent,
                  ansi: Theme.ansiNames.enumerated().map { col($1) ?? base.ansi[$0] }, light: t.appearance == "light")
    }

    /// A CSS colour as the theme files write them: #rgb, #rrggbb, #rrggbbaa, rgb() or rgba().
    static func css(_ s: String) -> SIMD4<Float>? {
        let t = s.trimmingCharacters(in: .whitespaces).lowercased()
        if t.hasPrefix("#") {
            var h = String(t.dropFirst())
            if h.count == 3 || h.count == 4 { h = h.map { "\($0)\($0)" }.joined() }
            guard h.count == 6 || h.count == 8, let v = UInt64(h, radix: 16) else { return nil }
            if h.count == 6 { return hex(UInt32(v)) }
            return hex(UInt32(v >> 8), Float(v & 0xff) / 255)
        }
        guard t.hasPrefix("rgb"), let a = t.firstIndex(of: "("), let b = t.lastIndex(of: ")") else { return nil }
        let parts = t[t.index(after: a)..<b].split(separator: ",").map { Float($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count >= 3, parts.allSatisfy({ $0 != nil }) else { return nil }
        let p = parts.map { $0! }
        return SIMD4(p[0] / 255, p[1] / 255, p[2] / 255, p.count > 3 ? p[3] : 1)
    }

    var nsBackground: NSColor { NSColor(srgbRed: CGFloat(background.x), green: CGFloat(background.y), blue: CGFloat(background.z), alpha: 1) }
    var nsForeground: NSColor { NSColor(srgbRed: CGFloat(foreground.x), green: CGFloat(foreground.y), blue: CGFloat(foreground.z), alpha: 1) }
}
