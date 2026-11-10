// The terminal's look from the shared settings, in the whole window
// (scripts/sidetest.mjs --screen terminal): the theme follows the
// system's appearance, or one theme always; the tab in front, the pane
// heads and the sheet take its colours, as the Electron app's --tbg and
// --tfg. Pictures at 1280 and 900, dark and light, then on Paper in Monaco 15.

import AppKit

extension SelfTestBoard {
    func screenTerminal() {
        let ws = board.ws
        guard let tab = ws.tabs.first else { return check("term_tab", false) }
        ws.bar.onSelect?(tab.id)
        settle(0.5)
        check("term_in_front", board.front == .tab, "\(board.front)")
        func theme(_ id: String) -> Theme? { SettingsStore.builtIn.first { $0.id == id }.map(Theme.init) }
        for dark in [true, false] {
            NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            let want = theme(dark ? "ravenry-dark" : "ravenry-light")
            let ok = wait(3) { ws.look.theme == want && ws.focusedView?.renderer.theme == want }
            check("term_follows_system_\(dark ? "dark" : "light")", ok && Design.terminal == want, "light \(ws.look.theme.light)")
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        pictures("term")
        // One theme always, another font and size: every pane and the chrome follow.
        ws.settings.set(["themeFollowsSystem": false, "themeAlways": "paper", "fontFamily": "Monaco", "fontSize": 15, "cursorStyle": "bar"])
        let paper = theme("paper")
        check("term_paper_applied", wait(3) { ws.look.theme == paper && ws.focusedView?.renderer.fontName == "Monaco" && ws.focusedView?.renderer.fontSize == 15 },
              "\(ws.focusedView?.renderer.fontName ?? "") \(ws.focusedView?.renderer.fontSize ?? 0)")
        let bg = Design.tbg.usingColorSpace(.sRGB)
        check("term_paper_chrome", abs((bg?.redComponent ?? 0) * 255 - 0xF2) < 1 && abs((bg?.blueComponent ?? 0) * 255 - 0xDE) < 1, "\(String(describing: bg))")
        for (w, h) in [(CGFloat(1280), CGFloat(820)), (900, 760)] {
            size(w, h)
            settle(0.6)
            board.render(force: true)
            settle(0.4)
            picture("native-term-paper-\(Int(w))-dark.png")
        }
        size(1280, 820)
        for k in ["themeFollowsSystem", "themeAlways", "fontFamily", "fontSize", "cursorStyle"] {
            if let d = SettingsStore.keys[k]?["default"] { ws.settings.set([k: d]) }
        }
        check("term_defaults_back", wait(3) { ws.look.theme == theme("ravenry-dark") && ws.focusedView?.renderer.fontSize == 13 })
    }
}
