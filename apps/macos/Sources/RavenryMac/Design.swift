// The window's colours and sizes, the Electron app's: the colours and
// type sizes from the shared design tokens (shared/tokens/tokens.json,
// bundled with the app and read at launch; the values here are only a
// fallback for a build without it), the component sizes from
// apps/desktop/src/renderer/app.css (.tabs, .tab) and phase2.css
// (.split, .phead, .gutter). The terminal is dark in both themes, as
// there; the strip follows the system's appearance.

import AppKit

enum Design {
    private static func rgb(_ v: UInt32, _ a: CGFloat = 1) -> NSColor {
        NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: a)
    }

    /// shared/tokens/tokens.json, as bundled.
    private static let tokens: [String: Any] = {
        guard let u = Bundle.main.url(forResource: "tokens", withExtension: "json"), let d = try? Data(contentsOf: u) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] ?? [:]
    }()

    /// A token's colour: "#RRGGBB" or "rgba(r,g,b,a)".
    private static func token(_ theme: String, _ name: String) -> NSColor? {
        guard let c = ((tokens["color"] as? [String: Any])?[theme] as? [String: Any])?[name] as? String else { return nil }
        if c.hasPrefix("#"), c.count == 7, let v = UInt32(c.dropFirst(), radix: 16) { return rgb(v) }
        let n = c.replacingOccurrences(of: "rgba(", with: "").replacingOccurrences(of: ")", with: "").split(separator: ",")
            .compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard n.count == 4 else { return nil }
        return NSColor(srgbRed: n[0] / 255, green: n[1] / 255, blue: n[2] / 255, alpha: n[3])
    }

    /// A type size of the tokens (size.md is 12.5).
    private static func size(_ name: String, _ fallback: CGFloat) -> CGFloat {
        ((tokens["size"] as? [String: Any])?[name] as? NSNumber).map { CGFloat($0.doubleValue) } ?? fallback
    }

    /// A colour for dark and one for light, as the system appearance goes:
    /// the tokens' (named as app.css's variables), else these.
    private static func pair(_ name: String, dark: NSColor, light: NSColor) -> NSColor {
        let d = token("dark", name) ?? dark, l = token("light", name) ?? light
        return NSColor(name: NSColor.Name(name)) { ap in
            ap.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? d : l
        }
    }

    // :root
    static let sheet = pair("sheet", dark: rgb(0x1E1E21), light: rgb(0xFFFFFF))
    static let sep = pair("sep", dark: rgb(0x36363B), light: rgb(0xE4E2DD))
    static let tx = pair("tx", dark: rgb(0xF2F2F4), light: rgb(0x1D1D1F))
    static let tx2 = pair("tx2", dark: rgb(0xA1A1A8), light: rgb(0x5F5F66))
    static let tx3 = pair("tx3", dark: rgb(0x8E8E93), light: rgb(0x6B6B70))
    static let work = pair("work", dark: rgb(0x0A84FF), light: rgb(0x2F6FEB))
    static let hover = pair("sel", dark: rgb(0xFFFFFF, 0.09), light: rgb(0x000000, 0.06))
    /// --term-bg, and the terminal's foreground (the tab in front joins
    /// its terminal: .tab.on).
    static let termBg = token("dark", "term-bg") ?? rgb(0x0B0B0C)
    static let termFg = rgb(0xF2F2F4)
    /// The header's text (.phead: --tfg at 55%, the name at 75%, the
    /// focused pane's name whole) and its line (12%).
    static let headFg = rgb(0xD1D1D6, 0.55)
    static let headName = rgb(0xD1D1D6, 0.75)
    static let headLine = rgb(0xD1D1D6, 0.12)

    // .tabs and .tab
    static let stripHeight: CGFloat = 40
    static let tabHeight: CGFloat = 32
    static let tabRadius: CGFloat = 8
    static let tabPadLeft: CGFloat = 12
    static let tabPadRight: CGFloat = 8
    static let tabGap: CGFloat = 2
    static let tabInnerGap: CGFloat = 7
    static let tabMaxWidth: CGFloat = 240
    static let tabFont = NSFont.systemFont(ofSize: size("md", 12.5))
    static let closeSize: CGFloat = 16
    /// Left of the first tab: the window's buttons (at 18, 18 in the
    /// Electron window's sidebar; here beside the tabs).
    static let stripLead: CGFloat = 78

    // .split, .phead, .gutter
    static let gutter: CGFloat = 6
    static let headHeight: CGFloat = 28
    static let headFont = NSFont.systemFont(ofSize: size("sm", 12))
    static let headNameFont = NSFont.systemFont(ofSize: size("sm", 12), weight: .semibold)
    static let paneMin: CGFloat = 160
    /// The pane without the keyboard, a little dimmed.
    static let unfocusedAlpha: CGFloat = 0.82
}
