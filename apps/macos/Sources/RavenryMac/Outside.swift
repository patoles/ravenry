// What the window hands to the system: a link to the browser, a file to its
// editor, a picture to the Finder. A window off every screen (the
// self-tests) records them instead, so a test never opens anything on the
// person's screen.

import AppKit

enum Outside {
    /// Off every screen: what would have opened, "open URL" or "reveal PATH".
    static var record: [String]? = nil

    /// http, https and file URLs only, as the Electron app's links.
    static func open(_ s: String) {
        guard let u = URL(string: s), let sc = u.scheme?.lowercased(), ["http", "https", "file"].contains(sc) else { return }
        if record != nil { record?.append("open \(u.absoluteString)"); return }
        NSWorkspace.shared.open(u)
    }

    static func openFile(_ path: String) {
        if record != nil { record?.append("open \(path)"); return }
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    static func reveal(_ path: String) {
        if record != nil { record?.append("reveal \(path)"); return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }
}
