// The window's colours and sizes, the Electron app's
// (apps/desktop/src/renderer/app.css :root, dark and light; the tab strip
// in .tabs and .tab, the splits in phase2.css .split, .phead, .gutter).
// The terminal is dark in both themes, as there; the strip follows the
// system's appearance.
//
// TODO(tokens): read shared/tokens/tokens.json once it exists (docs/
// FEATURES.md, rule "Copy and design tokens come from shared files"),
// rather than these values copied from app.css.

import AppKit

enum Design {
    private static func rgb(_ v: UInt32, _ a: CGFloat = 1) -> NSColor {
        NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: a)
    }

    /// A colour for dark and one for light, as the system appearance goes.
    private static func pair(_ name: String, dark: NSColor, light: NSColor) -> NSColor {
        NSColor(name: NSColor.Name(name)) { ap in
            ap.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
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
    static let termBg = rgb(0x0B0B0C)
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
    static let tabFont = NSFont.systemFont(ofSize: 12.5)
    static let closeSize: CGFloat = 16
    /// Left of the first tab: the window's buttons (at 18, 18 in the
    /// Electron window's sidebar; here beside the tabs).
    static let stripLead: CGFloat = 78

    // .split, .phead, .gutter
    static let gutter: CGFloat = 6
    static let headHeight: CGFloat = 28
    static let headFont = NSFont.systemFont(ofSize: 12)
    static let headNameFont = NSFont.systemFont(ofSize: 12, weight: .semibold)
    static let paneMin: CGFloat = 160
    /// The pane without the keyboard, a little dimmed.
    static let unfocusedAlpha: CGFloat = 0.82
}
