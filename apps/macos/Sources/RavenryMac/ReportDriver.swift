// The commands a check off every screen gives the app through its report's
// command file (<RAVENRY_MAC_REPORT>.do, main.swift report): one line, run
// on the main thread, its answer appended to <report>.done as a JSON line.
//
//   wake                 NSWorkspace.didWakeNotification posted, as macOS does after a sleep (Wake.swift)
//   menu TITLE           the app menu's item of that title, pressed as a click does (NSMenu performActionForItem)
//   press TITLE          the button of that title on the dialog in front, pressed through Accessibility
//   box on|off           the dialog's checkbox, clicked to that state
//   shot PATH            a PNG of the dialog in front (its sheet window), for the look
//   state                the dialog in front: its title, text, buttons; the menu's titles
//
// A release takes none: it quits on --offscreen (Gate.swift).

import AppKit

extension AppDelegate {
    func reportCommand(_ line: String, report: String) {
        let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
        let cmd = parts.first ?? "", arg = parts.count > 1 ? parts[1] : ""
        var ans: [String: Any] = ["cmd": line]
        let dialog = Updater.shared.shown.last { $0.window.isVisible }
        switch cmd {
        case "wake":
            // As macOS says it after a sleep, through the observer Wake.swift set.
            NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.didWakeNotification, object: NSWorkspace.shared)
            ans["ok"] = true
        case "menu":
            let items = NSApp.mainMenu?.items.first?.submenu?.items ?? []
            if let i = items.firstIndex(where: { $0.title == arg }), let m = NSApp.mainMenu?.items.first?.submenu {
                m.update()
                ans["enabled"] = m.items[i].isEnabled
                m.performActionForItem(at: i)
                ans["ok"] = true
            } else { ans["ok"] = false; ans["titles"] = items.map(\.title) }
        case "press":
            if let b = dialog?.buttons.first(where: { $0.title == arg }) { ans["ok"] = b.accessibilityPerformPress() } else { ans["ok"] = false }
        case "box":
            if let b = dialog?.accessoryView as? NSButton {
                if (b.state == .on) != (arg == "on") { b.performClick(nil) }
                ans["ok"] = (b.state == .on) == (arg == "on")
            } else { ans["ok"] = false }
        case "shot":
            // The content over the window's own background, as the update self-test pictures its dialogs.
            if let w = dialog?.window, let v = w.contentView, let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) {
                v.cacheDisplay(in: v.bounds, to: rep)
                let pw = rep.pixelsWide, ph = rep.pixelsHigh
                var bg = CGColor(gray: 0, alpha: 1)
                w.effectiveAppearance.performAsCurrentDrawingAppearance { bg = (NSColor.windowBackgroundColor.usingColorSpace(.sRGB) ?? .black).cgColor }
                if let img = rep.cgImage, let ctx = CGContext(data: nil, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                                             bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
                    ctx.setFillColor(bg)
                    ctx.fill(CGRect(x: 0, y: 0, width: pw, height: ph))
                    ctx.draw(img, in: CGRect(x: 0, y: 0, width: pw, height: ph))
                    ans["ok"] = (try? ctx.makeImage().map { NSBitmapImageRep(cgImage: $0) }?.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: arg))) != nil
                } else { ans["ok"] = false }
            } else { ans["ok"] = false }
        case "state": ans["ok"] = true
        default: ans["ok"] = false
        }
        if let d = Updater.shared.shown.last(where: { $0.window.isVisible }) {
            ans["dialog"] = ["title": d.messageText, "text": d.informativeText, "buttons": d.buttons.map(\.title),
                             "box": (d.accessoryView as? NSButton).map { ["title": $0.title, "on": $0.state == .on] } as Any]
        }
        ans["menu"] = NSApp.mainMenu?.items.first?.submenu?.items.map(\.title) ?? []
        ans["toasts"] = board?.toastTexts ?? []
        ans["outside"] = Outside.record ?? []
        if let d = try? JSONSerialization.data(withJSONObject: ans), let h = FileHandle(forWritingAtPath: report + ".done") ?? {
            FileManager.default.createFile(atPath: report + ".done", contents: nil); return FileHandle(forWritingAtPath: report + ".done") }() {
            h.seekToEndOfFile(); h.write(d); h.write(Data("\n".utf8)); try? h.close()
        }
    }
}
