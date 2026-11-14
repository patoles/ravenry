// Idle folded in the sidebar (scripts/sidetest.mjs --screen idlefold, then
// --screen idlefold2 on the same data folder): folded at the first launch,
// a press on its head opens it and folds it again, Return and Space on the
// head do the same with the keyboard kept there, the choice kept for the
// next launch (idlefold2 reads it back), open with no chevron when every
// session is idle, the idle project in front keeps its line under the
// folded head, a session gone idle drops into the fold, and Needs you,
// Working and Waiting never fold. Pictures of the sidebar alone at 284 and
// 220 points, dark and light, in each state (sidebar-*.png).

import AppKit
import ImageIO

extension SelfTestBoard {
    /// The board's state changed by `f`; nil: its sidebar as the hub sent it at the start (`hub.state.raw` carries the last change).
    private func idlePatch(_ f: (([String: Any]) -> [String: Any])?) {
        let original = idleOriginal
        board.hub.testPatch = f ?? { st in var r = st; if let o = original { r["sidebar"] = o }; return r }
        board.hub.testCheckpoints = board.hub.state?.checkpoints
        settle(0.4)
        board.render(force: true)
        settle(0.3)
    }

    private static var original: [String: Any]?
    private var idleOriginal: [String: Any]? { SelfTestBoard.original }
    private var idleSection: SideSection? { board.hub.state?.sections.first { $0.group == "idle" } }
    /// The idle projects' one-line rows drawn now.
    private func idleRowsDrawn() -> [String] { (idleSection?.projects ?? []).map { "project:\($0.id)" }.filter { board.sidebar.rows[$0] != nil } }
    /// Every row of Needs you, Working and Waiting drawn.
    private func othersDrawn() -> (drawn: Int, of: Int) {
        let keys = (board.hub.state?.sections ?? []).filter { $0.group != "idle" }.flatMap { s in s.projects.flatMap { p in p.rows.isEmpty ? ["project:\(p.id)"] : p.rows.map(\.key) } }
        return (keys.filter { board.sidebar.rows[$0] != nil }.count, keys.count)
    }
    /// The head's chevron as drawn ("chevron" folded, "down" open), nil with none.
    private func chevronName() -> String? {
        guard let h = board.sidebar.idleHead else { return nil }
        func walk(_ v: NSView) -> String? { if let i = v as? Icon, i.name == "chevron" || i.name == "down" { return i.name }; return v.subviews.lazy.compactMap(walk).first }
        return walk(h)
    }
    /// The words of the head's count pill.
    private func headCount() -> String? {
        guard let h = board.sidebar.idleHead else { return nil }
        func walk(_ v: NSView) -> [NSTextField] { ((v as? NSTextField).map { [$0] } ?? []) + v.subviews.flatMap(walk) }
        return walk(h).last { Int($0.stringValue) != nil }?.stringValue
    }
    /// Every Row in the sidebar's list that folds a section (only Idle's).
    private func foldHeads() -> [Row] {
        func walk(_ v: NSView) -> [Row] { ((v as? Row).flatMap { $0.key.hasPrefix("fold:") ? [$0] : nil } ?? []) + v.subviews.flatMap(walk) }
        return walk(board.sidebar)
    }

    /// A key typed as the person types it: posted to the app and taken off its queue (NSApp.currentEvent is the key).
    /// With `focus`: that key's moment gives the keyboard to `focus` instead (a row takes it only from a key press, Row.acceptsFirstResponder).
    private func typeKey(_ chars: String, _ code: UInt16, focus: NSResponder? = nil) {
        guard let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                       context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) else { return }
        NSApp.postEvent(e, atStart: false)
        let end = Date().addingTimeInterval(0.4)
        while Date() < end {
            // Taken off the queue (NSApp.currentEvent is the key), then to this window: off every screen it is not the key window.
            if let ev = NSApp.nextEvent(matching: .any, until: Date().addingTimeInterval(0.02), inMode: .default, dequeue: true) {
                if ev.type == .keyDown, ev.windowNumber == window.windowNumber { if let f = focus { window.makeFirstResponder(f) } else { window.sendEvent(ev) } } else { NSApp.sendEvent(ev) }
            }
        }
    }

    /// The sidebar alone at `w` points, dark and light: sidebar-NAME-{dark,light}-W.png.
    private func sidePictures(_ name: String, hover: Bool = false) {
        for w in [CGFloat(284), 220] {
            board.sidebar.onResize?(w)
            for dark in [true, false] {
                NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                settle(0.3)
                board.render(force: true)
                settle(0.3)
                if hover, let h = board.sidebar.idleHead, let e = NSEvent.enterExitEvent(with: .mouseEntered, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, trackingNumber: 0, userData: nil) {
                    h.mouseEntered(with: e)
                    settle(0.1)
                }
                // The window as composed (picture()), cut to the sidebar's width.
                let full = "sidebar-\(name)-\(dark ? "dark" : "light")-\(Int(w))-full.png"
                picture(full)
                let fu = dir.appendingPathComponent(full)
                if let src = CGImageSourceCreateWithURL(fu as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil),
                   let cut = img.cropping(to: CGRect(x: 0, y: 0, width: min(img.width, Int(w * 2)), height: img.height)) {
                    let rep = NSBitmapImageRep(cgImage: cut)
                    try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("sidebar-\(name)-\(dark ? "dark" : "light")-\(Int(w)).png"))
                    try? FileManager.default.removeItem(at: fu)
                }
                if hover, let h = board.sidebar.idleHead, let e = NSEvent.enterExitEvent(with: .mouseExited, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, trackingNumber: 0, userData: nil) {
                    h.mouseExited(with: e)
                }
            }
        }
        board.sidebar.onResize?(SidebarView.defaultWidth)
        NSApp.appearance = NSAppearance(named: .darkAqua)
        settle(0.3)
        board.render(force: true)
    }

    func screenIdleFold() {
        let sb = board.sidebar
        size(1280, 1100)
        board.toTerminal()
        settle(0.4)
        SelfTestBoard.original = board.hub.state?.raw["sidebar"] as? [String: Any]
        guard let idle = idleSection, idle.projects.count >= 2 else { return check("idle_section", false, "\(board.hub.state?.sections.map { "\($0.group) \($0.count)" } ?? [])") }
        sidePictures("1-folded")
        sidePictures("2-folded-hover", hover: true)

        // The first launch: folded, the head with its count, no idle line in the list (nor in the Tab order).
        let first = sb.idleFolded && idleRowsDrawn().isEmpty && chevronName() == "chevron" && headCount() == String(idle.count)
        check("idle_folded_first_launch", first, "folded \(sb.idleFolded), idle lines drawn \(idleRowsDrawn()), chevron \(chevronName() ?? "none"), count \(headCount() ?? "-") of \(idle.count)")
        let ax = sb.idleHead?.accessibilityRole() == .button && sb.idleHead?.accessibilityLabel() == "Idle, \(idle.count), folded"
        check("idle_head_voiceover_folded", ax, "\(sb.idleHead?.accessibilityRole()?.rawValue ?? "-") \"\(sb.idleHead?.accessibilityLabel() ?? "")\"")

        // Only Idle folds: one head that folds, every row of the other sections drawn; a press on Working's head folds nothing.
        let o = othersDrawn()
        var otherHeads = 0
        func walkLabels(_ v: NSView) -> [NSTextField] { ((v as? NSTextField).map { [$0] } ?? []) + v.subviews.flatMap(walkLabels) }
        let titles = (board.hub.state?.sections ?? []).filter { $0.group != "idle" }.map(\.title)
        for f in walkLabels(sb) where titles.contains(f.stringValue) && f.window === window { click(f); otherHeads += 1 }
        let o2 = othersDrawn()
        check("idle_only_idle_folds", foldHeads().count == 1 && o.drawn == o.of && o.of > 0 && o2.drawn == o2.of && otherHeads == titles.count,
              "fold heads \(foldHeads().count), other rows \(o.drawn) of \(o.of), after pressing \(otherHeads) other heads \(o2.drawn) of \(o2.of)")

        // A click opens it (every idle line drawn, the chevron down), a click folds it.
        if let h = sb.idleHead { click(h) }
        let opened = wait(2) { sb.idleHead != nil && !sb.idleFolded && self.idleRowsDrawn().count == idle.projects.count }
        check("idle_click_opens", opened && chevronName() == "down" && sb.idleHead?.accessibilityLabel() == "Idle, \(idle.count), open",
              "open \(!sb.idleFolded), lines \(idleRowsDrawn().count) of \(idle.projects.count), chevron \(chevronName() ?? "none"), \"\(sb.idleHead?.accessibilityLabel() ?? "")\"")
        sidePictures("4-opened")
        if let h = sb.idleHead { click(h) }
        check("idle_click_folds", wait(2) { sb.idleFolded && self.idleRowsDrawn().isEmpty } && chevronName() == "chevron", "folded \(sb.idleFolded), lines \(idleRowsDrawn())")

        // The keyboard: Tab reaches the head, Return opens, Space folds, the keyboard stays on the head.
        // From the first row of the list (Needs you's), as the keyboard would be after a Tab into the sidebar.
        let start = sb.keyRows.first { $0.key.contains("/") }
        typeKey("\u{F710}", 0x69, focus: start)
        let startOk = start != nil && window.firstResponder === start
        var tabs = 0, path: [String] = []
        while window.firstResponder !== sb.idleHead && tabs < 80 {
            typeKey("\t", 48); tabs += 1
            let r = window.firstResponder
            path.append((r as? Row).map { $0.key.isEmpty ? "row" : $0.key } ?? r.map { String(describing: type(of: $0)) } ?? "nil")
        }
        let reached = window.firstResponder === sb.idleHead
        typeKey("\r", 36)
        let retOpened = sb.idleHead != nil && !sb.idleFolded && idleRowsDrawn().count == idle.projects.count && window.firstResponder === sb.idleHead
        typeKey(" ", 49)
        let spaceFolded = sb.idleFolded && idleRowsDrawn().isEmpty && window.firstResponder === sb.idleHead
        check("idle_keyboard_toggle", startOk && reached && retOpened && spaceFolded, "from \(start?.key ?? "none") \(startOk), Tab reached the head \(reached) after \(tabs), Return opened \(retOpened), Space folded \(spaceFolded); Tab went \(path.suffix(6).joined(separator: " > "))")
        // Folded, Tab never stops on a hidden line; open, it goes through each of them after the head.
        let idleKeys = Set(idle.projects.map { "project:\($0.id)" })
        let foldedLoop = sb.keyRows.map(\.key)
        if let h = sb.idleHead { click(h) }
        let openLoop = sb.keyRows.map(\.key)
        if let h = sb.idleHead { click(h) }
        let after = openLoop.firstIndex(of: "fold:idle").map { Array(openLoop.dropFirst($0 + 1).prefix(idleKeys.count)) } ?? []
        check("idle_folded_lines_leave_tab_order", foldedLoop.contains("fold:idle") && foldedLoop.allSatisfy { !idleKeys.contains($0) } && Set(after) == idleKeys,
              "folded: \(foldedLoop.joined(separator: " > ")); open, after the head: \(after.joined(separator: " > "))")
        window.makeFirstResponder(nil)

        // The tab in front on an idle project while folded: its one line, selected, under the head; the head keeps the whole count.
        let p = idle.projects[min(2, idle.projects.count - 1)]
        board.topLevel { $0.pickProject(p.id) }
        settle(0.5)
        let line = sb.rows["project:\(p.id)"]
        check("idle_front_project_line_while_folded", sb.idleFolded && line?.selected == true && idleRowsDrawn() == ["project:\(p.id)"] && headCount() == String(idle.count),
              "folded \(sb.idleFolded), lines \(idleRowsDrawn()), selected \(line?.selected ?? false), count \(headCount() ?? "-")")
        sidePictures("3-front-idle")
        board.topLevel { $0.back() }
        board.toTerminal()
        settle(0.4)
        check("idle_front_gone_line_folds_away", wait(2) { self.board.render(); return self.idleRowsDrawn().isEmpty }, "lines \(idleRowsDrawn())")

        // A session going from Working to idle drops into the fold: its row leaves Working, no line shows, the count grows.
        let raw0 = board.hub.state?.raw["sidebar"] as? [String: Any] ?? [:]
        let secs0 = raw0["sections"] as? [[String: Any]] ?? []
        if let wi = secs0.firstIndex(where: { $0["group"] as? String == "work" }), let wp = (secs0[wi]["projects"] as? [[String: Any]])?.first,
           let pid = wp["id"] as? String, let rk = ((wp["rows"] as? [[String: Any]])?.first)?["key"] as? String {
            let drawnBefore = sb.rows[rk] != nil
            idlePatch { st in
                var r = st
                var side = r["sidebar"] as? [String: Any] ?? [:]
                var secs = side["sections"] as? [[String: Any]] ?? []
                guard let w = secs.firstIndex(where: { $0["group"] as? String == "work" }), let i = secs.firstIndex(where: { $0["group"] as? String == "idle" }) else { return r }
                var wps = secs[w]["projects"] as? [[String: Any]] ?? []
                guard let k = wps.firstIndex(where: { $0["id"] as? String == pid }) else { return r }
                var moved = wps.remove(at: k)
                moved["rows"] = [[String: Any]]()
                secs[w]["projects"] = wps
                secs[w]["count"] = max(0, ((secs[w]["count"] as? NSNumber)?.intValue ?? 1) - 1)
                secs[i]["projects"] = [moved] + (secs[i]["projects"] as? [[String: Any]] ?? [])
                secs[i]["count"] = ((secs[i]["count"] as? NSNumber)?.intValue ?? 0) + 1
                if wps.isEmpty { secs.remove(at: w) }
                side["sections"] = secs
                r["sidebar"] = side
                return r
            }
            let n = idleSection?.count ?? 0
            check("idle_session_gone_idle_drops_into_fold", drawnBefore && sb.rows[rk] == nil && sb.rows["project:\(pid)"] == nil && sb.idleFolded && headCount() == String(n) && n == idle.count + 1,
                  "\(rk) drawn before \(drawnBefore), after \(sb.rows[rk] != nil), its line \(sb.rows["project:\(pid)"] != nil), count \(headCount() ?? "-") (was \(idle.count))")
            idlePatch(nil)
        } else { check("idle_session_gone_idle_drops_into_fold", false, "no Working session on the board") }

        // Everything idle: the section shows open with no chevron and no button, though the choice is folded.
        idlePatch { st in
            var r = st
            var side = r["sidebar"] as? [String: Any] ?? [:]
            let secs = side["sections"] as? [[String: Any]] ?? []
            guard var i = secs.first(where: { $0["group"] as? String == "idle" }) else { return r }
            let others = secs.filter { $0["group"] as? String != "idle" }.flatMap { ($0["projects"] as? [[String: Any]]) ?? [] }.map { p -> [String: Any] in var q = p; q["rows"] = [[String: Any]](); return q }
            i["projects"] = others + ((i["projects"] as? [[String: Any]]) ?? [])
            i["count"] = ((i["projects"] as? [[String: Any]]) ?? []).count
            side["sections"] = [i]
            r["sidebar"] = side
            return r
        }
        let all = idleSection
        check("idle_all_idle_shows_open", board.hub.state?.sections.count == 1 && sb.idleHead == nil && foldHeads().isEmpty && !(all?.projects.isEmpty ?? true)
              && idleRowsDrawn().count == all?.projects.count && !sb.idleOpen,
              "sections \(board.hub.state?.sections.map(\.group) ?? []), head button \(sb.idleHead != nil), lines \(idleRowsDrawn().count) of \(all?.projects.count ?? 0), choice open \(sb.idleOpen)")
        sidePictures("5-allidle")
        idlePatch(nil)
        check("idle_back_folded_with_others", wait(2) { sb.idleFolded && self.idleRowsDrawn().isEmpty && self.othersDrawn().of > 0 }, "folded \(sb.idleFolded), lines \(idleRowsDrawn())")

        // Opened for the relaunch (idlefold2 reads it back).
        if let h = sb.idleHead { click(h) }
        check("idle_opened_for_relaunch", wait(2) { sb.idleHead != nil && !sb.idleFolded }, "head \(sb.idleHead != nil), folded \(sb.idleFolded)")
    }

    /// The app again on the same data folder: Idle as the person left it (open), then folded again and kept.
    func screenIdleFold2() {
        let sb = board.sidebar
        board.toTerminal()
        settle(0.4)
        guard let idle = idleSection else { return check("idle_section", false) }
        check("idle_choice_kept_relaunch", sb.idleHead != nil && !sb.idleFolded && sb.idleOpen && idleRowsDrawn().count == idle.projects.count && chevronName() == "down",
              "folded \(sb.idleFolded), lines \(idleRowsDrawn().count) of \(idle.projects.count), chevron \(chevronName() ?? "none")")
        if let h = sb.idleHead { click(h) }
        check("idle_folds_after_relaunch", wait(2) { sb.idleFolded && self.idleRowsDrawn().isEmpty })
    }
}
