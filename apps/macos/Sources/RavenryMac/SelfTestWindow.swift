// The window's size and place kept across launches (sidetest.mjs --screen
// window): the bounds as the Electron app writes them in the layout file
// (from the top left of the main screen), read back onto a screen that is
// still there, refused when off every screen or too small.

import AppKit

extension SelfTestBoard {
    func screenWindow() {
        let main = NSRect(x: 0, y: 0, width: 1512, height: 982)
        let side = NSRect(x: 1512, y: -200, width: 1920, height: 1080)
        let mh = main.height
        // Round trip: a frame on the main screen, its bounds, the frame again.
        let f = NSRect(x: 120, y: 90, width: 1280, height: 820)
        let b = Workspace.bounds(fromFrame: f, mainHeight: mh, maximized: false)
        check("window_bounds_as_electron", b["x"] as? Int == 120 && b["y"] as? Int == Int(mh - 90 - 820) && b["width"] as? Int == 1280 && b["height"] as? Int == 820, "\(b)")
        check("window_frame_back", Workspace.frame(fromBounds: b, screens: [main, side], mainHeight: mh) == f)
        // On the second screen, kept; that screen gone, refused (the default size, centred, then).
        let onSide = Workspace.bounds(fromFrame: NSRect(x: 1700, y: 0, width: 1200, height: 800), mainHeight: mh, maximized: true)
        check("window_on_other_screen_kept", Workspace.frame(fromBounds: onSide, screens: [main, side], mainHeight: mh) != nil)
        check("window_screen_gone_refused", Workspace.frame(fromBounds: onSide, screens: [main], mainHeight: mh) == nil)
        check("window_mostly_off_refused", Workspace.frame(fromBounds: ["x": 1450, "y": 100, "width": 900, "height": 600], screens: [main], mainHeight: mh) == nil)
        check("window_too_small_refused", Workspace.frame(fromBounds: ["x": 100, "y": 100, "width": 600, "height": 400], screens: [main], mainHeight: mh) == nil)
        check("window_bad_values_refused", Workspace.frame(fromBounds: ["x": "a", "y": 1, "width": 900, "height": 600], screens: [main], mainHeight: mh) == nil)
        // Written into the layout file beside the tabs, which stay.
        guard let store = LayoutStore(offscreen: true, socket: board.ws.conn.socketPath) else { check("window_layout_store", false); return }
        board.ws.save(); board.ws.flush()
        let before = store.read().order
        store.saveBounds(b)
        let again = LayoutStore(offscreen: true, socket: board.ws.conn.socketPath)
        check("window_bounds_saved", again?.readBounds().flatMap { Workspace.frame(fromBounds: $0, screens: [main], mainHeight: mh) } == f, "\(again?.readBounds() ?? [:])")
        check("window_tabs_kept_beside", again?.read().order == before && !before.isEmpty, "\(before)")
        check("window_file_by_daemon", store.url.lastPathComponent.hasPrefix("window-"), store.url.lastPathComponent)
    }
}
