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
//   menu TOP>ITEM[>ITEM]  an item of another menu (Shell>New Shell, Edit>Find>Find...), pressed the same way
//   toast TITLE          the newest toast's button of that title, pressed
//   scroll N             N scroll-wheel lines over the pane in front, as a mouse's wheel sends them
//   activate             NSApplication.didBecomeActiveNotification, as a Dock click brings the app forward
//   closewindows         every window closed as its close button does (performClose); the app runs on with none
//   learn KEY            Learn opened, and its card KEY's button (Try it) pressed through Accessibility
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
        case "menu" where arg.contains(">"):
            var m = NSApp.mainMenu
            let path = arg.split(separator: ">").map(String.init)
            for (k, title) in path.enumerated() {
                // The menu bar's own items have no title: their submenu's is the one shown.
                guard let menu = m, let i = menu.items.firstIndex(where: { $0.title == title || (menu === NSApp.mainMenu && $0.submenu?.title == title) }) else { m = nil; break }
                if k == path.count - 1 {
                    menu.update()
                    let item = menu.items[i]
                    ans["enabled"] = item.isEnabled
                    // An item for the view with the keyboard (no target: Find...) goes to the pane in front, as when its window is key.
                    if item.target == nil, let sel = item.action, let v = workspace?.focusedView, v.responds(to: sel) {
                        ans["ok"] = NSApp.sendAction(sel, to: v, from: item)
                    } else {
                        menu.performActionForItem(at: i)
                        ans["ok"] = true
                    }
                } else { m = menu.items[i].submenu }
            }
            if ans["ok"] == nil { ans["ok"] = false }
        case "toast":
            // Pressed as the person's click: a mouse down and up at its middle, through the window.
            if let b = (board?.toastStack.items ?? []).flatMap(\.buttons).first(where: { $0.title == arg }), let w = b.window {
                w.contentView?.layoutSubtreeIfNeeded()
                let p = b.convert(NSPoint(x: b.bounds.midX, y: b.bounds.midY), to: nil)
                for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                    if let e = NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                  windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) { w.sendEvent(e) }
                }
                ans["ok"] = true
            } else { ans["ok"] = false; ans["buttons"] = (board?.toastStack.items ?? []).flatMap(\.buttons).map(\.title) }
        case "scroll":
            if let v = workspace?.focusedView, let n = Int32(arg),
               let cg = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: n, wheel2: 0, wheel3: 0) {
                cg.location = v.window.map { CGPoint(x: $0.frame.midX, y: $0.frame.midY) } ?? .zero
                if let e = NSEvent(cgEvent: cg) { v.scrollWheel(with: e); ans["ok"] = true } else { ans["ok"] = false }
            } else { ans["ok"] = false }
        case "activate":
            NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
            ans["ok"] = true
        case "closewindows":
            for w in windows { w.window.performClose(nil) }
            ans["ok"] = true
            ans["left"] = windows.filter { !$0.closing }.count
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
        case "learn":
            if let bd = board {
                bd.openLearn()
                ans["learn"] = bd.learn.buttons.keys.sorted()
                let n = bd.log.count
                // Found and pressed (NSButton's own press answers false though its action ran); what the window said since.
                if let b = bd.learn.buttons["try-\(arg)"] { _ = b.accessibilityPerformPress(); ans["ok"] = true; ans["title"] = b.title } else { ans["ok"] = false }
                ans["said"] = bd.log.dropFirst(n).filter { $0.hasPrefix("toast ") }.map { String($0.dropFirst(6)) }
                ans["front"] = "\(bd.front)"
                ans["film"] = bd.ws.film.isOpen
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
