// The self-test of the app menu, the updater's dialogs and the switch from
// the npm board (scripts/sidetest.mjs --screen updates), on the demo hub:
// no board of npm's and no feed. The setup's commands (npm-switch,
// npm-back, npm-choice) are answered by a stand-in that says the steps the
// hub script says, so each screen is driven by its own buttons and the
// menu as the person would; scripts/npmswitchcheck.mjs runs the real
// setup on a board of npm's, and scripts/updatecheck.mjs a real update.

import AppKit

extension SelfTestBoard {
    /// A window's content (a sheet, an alert, the About panel) as a picture.
    func pictureWindow(_ w: NSWindow, _ name: String) {
        guard let v = w.contentView, let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
        v.cacheDisplay(in: v.bounds, to: rep)
        let s: CGFloat = 2
        let pw = Int(v.bounds.width * s), ph = Int(v.bounds.height * s)
        guard let ctx = CGContext(data: nil, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue), let img = rep.cgImage else { return }
        var bg = CGColor(gray: 0, alpha: 1)
        w.effectiveAppearance.performAsCurrentDrawingAppearance { bg = (NSColor.windowBackgroundColor.usingColorSpace(.sRGB) ?? .black).cgColor }
        ctx.setFillColor(bg)
        ctx.fill(CGRect(x: 0, y: 0, width: pw, height: ph))
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: pw, height: ph))
        guard let out = ctx.makeImage() else { return }
        try? NSBitmapImageRep(cgImage: out).representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent(name))
    }

    /// Dark and light pictures of a window's content.
    func picturesOfWindow(_ w: NSWindow, _ name: String) {
        for dark in [true, false] {
            NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            w.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            settle(0.3)
            pictureWindow(w, "native-\(name)-\(dark ? "dark" : "light").png")
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        w.appearance = nil
    }

    func screenUpdates() {
        guard let menu = NSApp.mainMenu?.items.first?.submenu else { check("app_menu", false); return }
        let titles = menu.items.map { $0.isSeparatorItem ? "-" : $0.title }

        // The app menu, as the Electron app's: About, Check for Updates..., Settings..., Services, Hide, Hide Others, Show All, Quit.
        check("app_menu_items", titles.starts(with: ["About Ravenry", "Check for Updates\u{2026}"]) && titles.contains("Services") && titles.contains("Settings\u{2026}")
              && titles.contains("Hide Ravenry") && titles.contains("Hide Others") && titles.contains("Show All") && titles.last == "Quit Ravenry", titles.joined(separator: " | "))
        let item = { (t: String) in menu.items.first { $0.title == t } }
        check("app_menu_hide_keys", item("Hide Ravenry")?.keyEquivalent == "h" && item("Hide Ravenry")?.keyEquivalentModifierMask == .command
              && item("Hide Others")?.keyEquivalent == "h" && item("Hide Others")?.keyEquivalentModifierMask == [.command, .option]
              && item("Hide Ravenry")?.action == #selector(NSApplication.hide(_:)) && item("Show All")?.action == #selector(NSApplication.unhideAllApplications(_:)))
        check("app_menu_services", item("Services")?.submenu != nil && NSApp.servicesMenu === item("Services")?.submenu)
        let back = menu.items.first { $0.title == "Go Back to the npm Board\u{2026}" }
        check("app_menu_npm_back_hidden", back != nil && back!.isHidden)

        // About Ravenry: the system's panel, its picture taken off every screen.
        let before = Set(NSApp.windows.map { ObjectIdentifier($0) })
        NSApp.orderFrontStandardAboutPanel(nil)
        if let about = NSApp.windows.first(where: { !before.contains(ObjectIdentifier($0)) && $0.isVisible }) {
            about.alphaValue = 0
            about.setFrameOrigin(NSPoint(x: -20000, y: -20000))
            settle(0.3)
            let ver = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
            check("about_panel", texts(about.contentView!).contains { $0.contains(ver) }, texts(about.contentView!).joined(separator: " | "))
            picturesOfWindow(about, "about")
            about.close()
        } else {
            check("about_panel", false, NSApp.windows.map { "\($0.className) \($0.title) \($0.isVisible)" }.joined(separator: ", "))
        }

        // The updater: a development build says it does not update itself.
        let up = Updater.shared
        check("update_dev_build_says_so", up.whyNot() == "This is a development build. It does not update itself.", up.whyNot() ?? "-")
        up.checkNow()
        settle(0.4)
        if let a = up.shown.last, a.window.isVisible {
            check("update_dev_dialog", a.messageText == "Updates")
            picturesOfWindow(a.window, "update-devbuild")
            window.endSheet(a.window)
        } else { check("update_dev_dialog", false) }
        // Downloading, then ready: the menu says Restart to Update to it.
        up.preview(.downloading("0.1.29"))
        settle(0.2)
        up.showDownloading("0.1.29")
        settle(0.4)
        if let a = up.shown.last, a.window.isVisible {
            check("update_downloading_dialog", a.messageText == "Ravenry 0.1.29 is downloading" && a.informativeText.contains("installs when you quit"), a.messageText)
            picturesOfWindow(a.window, "update-downloading")
            window.endSheet(a.window)
        } else { check("update_downloading_dialog", false) }
        up.preview(.ready("0.1.29"))
        settle(0.2)
        let ui = menu.items.first { $0.action == #selector(Updater.menuUpdate(_:)) }
        check("update_menu_restart", ui?.title == "Restart to Update to 0.1.29", ui?.title ?? "-")
        up.offerRestart()
        settle(0.4)
        if let a = up.shown.last, a.window.isVisible {
            check("update_ready_dialog", a.messageText == "Ravenry 0.1.29 is ready" && a.buttons.map(\.title) == ["Restart Now", "Later"], a.buttons.map(\.title).joined(separator: ","))
            picturesOfWindow(a.window, "update-ready")
            window.endSheet(a.window)
        } else { check("update_ready_dialog", false) }
        // (Never Restart Now here: it quits the app.)
        up.preview(.idle)
        settle(0.2)
        check("update_menu_check", ui?.title == "Check for Updates\u{2026}", ui?.title ?? "-")
        check("update_helper_args", Updater.helperArgs(pid: 42, app: "/A/Ravenry.app", new: "/C/new/Ravenry.app", old: "/C/previous.app", log: "/L/app.log", version: "0.1.29", relaunch: true, background: false).suffix(7)
              == ["42", "/A/Ravenry.app", "/C/new/Ravenry.app", "/C/previous.app", "/L/app.log", "0.1.29", "1"])

        // The hub's update that stopped after 3 tries (setup.ts hub: stopped): said until pressed, with Try again (UPD-003).
        board.toTerminal()
        AppInstall.shared.hubAnswered(["ok": false, "plan": "hub", "stopped": true, "version": "0.1.29", "why": "the new hub did not answer"])
        settle(0.3)
        check("update_stopped_toast", board.toastTexts.contains("The update to 0.1.29 did not start after 3 tries (the new hub did not answer), so Ravenry keeps the hub that runs now.")
              && board.toastButtons.contains { $0.title == "Try again" }, board.toastTexts.joined(separator: " | "))
        pictures("update-stopped")
        board.toastStack.clear()

        screenNpm(menu)
    }

    /// The switch from the npm board, its screens driven by their buttons.
    private func screenNpm(_ menu: NSMenu) {
        let n = NpmSwitch.shared, st = board.start
        var ran: [[String]] = []
        // The setup's stand-in: the hub script's steps, a little apart, then its answer.
        n.run = { args, line, done in
            ran.append(args)
            let at = { (s: Double, f: @escaping () -> Void) in DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: f) }
            switch args.first {
            case "npm-switch":
                at(0.2) { line("@step {\"id\":\"login\"}") }
                at(0.6) { line("@step {\"id\":\"backup\",\"dir\":\"backups/switch-2026-11-11\",\"files\":214}") }
                at(0.8) { line("@step {\"id\":\"hooks\"}") }
                at(1.0) { line("@step {\"id\":\"hub\",\"port\":4600,\"done\":false}") }
                at(8.0) {
                    line("@step {\"id\":\"hub\",\"port\":4600,\"done\":true}")
                    done(["ok": true, "phase": "switched", "counts": ["projects": 5, "sessions": 9, "ideas": 12, "plans": 2, "rules": 7],
                          "detect": SelfTestBoard.npmDetect(running: false, record: "switched"), "offer": "none"])
                }
            case "npm-back":
                at(1.5) { done(["ok": true, "phase": "back", "offer": "bar", "result": ["again": "ravenry --no-open"], "detect": SelfTestBoard.npmDetect(running: false, record: "back")]) }
            default: done(["ok": true])
            }
        }
        board.toTerminal()
        board.render(force: true)

        // The offer, in Start's place: what was found and what happens to each.
        AppInstall.shared.hubAnswered(["ok": true, "plan": "offer", "detect": SelfTestBoard.npmDetect(running: true, record: nil), "offer": "screen"])
        check("npm_offer_takes_centre", wait(3) { self.board.front == .start && st.controls["npm:switch"] != nil }, "\(board.front)")
        check("npm_offer_words", shows(st, "You already run Ravenry from npm") && shows(st, "The npm board 0.4.0 runs on :4600") && shows(st, "Started at login. It stops, and the app's hub starts on the same port.")
              && shows(st, "Claude Code and Codex report to it") && shows(st, "It starts at login") && shows(st, "You can go back any time: Ravenry menu, Go Back to the npm Board."),
              texts(st).prefix(14).joined(separator: " | "))
        pictures("npm-offer")
        // A board run by hand: the command it ran.
        n.preview(offer: "screen", phase: .idle, detect: SelfTestBoard.npmDetect(running: true, record: nil, login: false))
        settle(0.3)
        check("npm_offer_by_hand", shows(st, "Started in a terminal with") && shows(st, "ravenry --no-open") && shows(st, "Nothing starts it at login"), texts(st).prefix(14).joined(separator: " | "))
        pictures("npm-offer-byhand")

        // Not now (started at login again): the quiet bar, the terminal back, Start points at the npm board.
        n.preview(offer: "screen", phase: .idle, detect: SelfTestBoard.npmDetect(running: true, record: nil))
        settle(0.3)
        if let b = st.controls["npm:not-now"] { click(b) }
        settle(0.3)
        let bar = { self.board.root.notice as? NpmBar }
        check("npm_not_now_bar", ran.last == ["npm-choice", "--set", "not-now"] && board.front == .tab && bar() != nil
              && bar()?.text == "Your npm board runs this data, so the app shows it and starts no hub of its own.", "\(board.front) \(bar()?.text ?? "no bar")")
        pictures("npm-bar")
        board.openPage("decisions", "Decisions")
        settle(0.4)
        check("npm_pointer_decisions", board.front == .start && shows(st, "Decisions needs the app's own hub, which does not run while the npm board keeps your data.")
              && shows(st, "Your board is the npm board") && st.controls["npm:open-board"] != nil, texts(st).prefix(10).joined(separator: " | "))
        pictures("npm-pointer")
        if let b = st.controls["npm:open-board"] { click(b) }
        check("npm_pointer_opens_board", Outside.record?.last?.hasPrefix("open http://127.0.0.1:") ?? false, Outside.record?.last ?? "-")
        board.openStart(nil)
        settle(0.3)
        check("npm_pointer_start", shows(st, "Starting a session needs the app's own hub"), texts(st).prefix(6).joined(separator: " | "))

        // Switch to the app, from the bar: each step as it is done, then what the app's hub shows.
        board.back()
        settle(0.2)
        if let b = bar()?.buttons["switch"] { click(b) }
        check("npm_switching", wait(3) { n.phase == .switching && self.board.front == .start && n.steps.count >= 3 } && shows(st, "Switching to the app"), "\(n.phase) \(n.steps.count)")
        check("npm_steps_ticked", shows(st, "Its login start is off") && shows(st, "The npm board stopped") && shows(st, "A copy of your data is kept"), texts(st).prefix(12).joined(separator: " | "))
        _ = wait(2) { n.steps.contains { $0["id"] as? String == "hub" } }
        settle(0.2)
        pictures("npm-steps")
        check("npm_switched", wait(12) { n.phase == .switched } && shows(st, "Everything is here") && shows(st, "plans running") && shows(st, "12"), texts(st).prefix(14).joined(separator: " | "))
        check("npm_bar_gone", board.root.notice == nil)
        pictures("npm-done")
        check("npm_menu_back_shown", menu.items.first { $0.title == "Go Back to the npm Board\u{2026}" }?.isHidden == false)
        if let b = st.controls["npm:done"] { click(b) }
        check("npm_open_board", board.front == .tab && !n.takesCentre, "\(board.front)")

        // Where it stopped, with Try again.
        n.preview(offer: "none", phase: .error, detect: SelfTestBoard.npmDetect(running: true, record: nil), steps: [["id": "login"], ["id": "stopped"]],
                  message: "The npm board did not stop within 10 s (pid 4242).")
        check("npm_stopped", wait(2) { self.board.front == .start } && shows(st, "The switch stopped") && shows(st, "The npm board did not stop within 10 s") && st.controls["npm:switch"] != nil)
        pictures("npm-stopped")

        // Go Back to the npm Board..., from the menu: asked once, in a sheet.
        n.preview(offer: "none", phase: .switched, detect: SelfTestBoard.npmDetect(running: false, record: "switched"), counts: ["projects": 5])
        n.dismissed = true
        n.changed()
        board.back()
        settle(0.3)
        if let mi = menu.items.first(where: { $0.title == "Go Back to the npm Board\u{2026}" }), let a = mi.action { NSApp.sendAction(a, to: mi.target, from: mi) }
        settle(0.4)
        let sheet = n.backSheet
        check("npm_back_sheet", sheet != nil && window.attachedSheet === sheet && sheet?.title2 == "Go back to the npm board?", "\(String(describing: window.attachedSheet))")
        if let s = sheet { picturesOfWindow(s, "npm-back-sheet") }
        if let b = sheet?.buttons["back"] { _ = b.accessibilityPerformPress() }
        settle(0.2)
        check("npm_going_back", n.phase == .goingBack && ran.last?.first == "npm-back" && sheet?.title2 == "Going back to the npm board...", "\(n.phase)")
        if let s = n.backSheet { picturesOfWindow(s, "npm-back-busy") }
        check("npm_back_done", wait(4) { n.phase == .back } && window.attachedSheet == nil && bar() != nil, "\(n.phase)")
        settle(0.3)
        // (The demo hub answers, so the npm board reads as running again.)
        check("npm_back_bar", wait(3) { bar()?.text == "Back on the npm board." } && bar()?.fill == "idle-t", bar()?.text ?? "-")
        pictures("npm-bar-back")
        n.preview(offer: "none", phase: .idle, detect: nil)
        board.toTerminal()
    }

    /// What the hub script's detect says of a board of npm's (npmswitch.mjs).
    static func npmDetect(running: Bool, record: String?, login: Bool = true) -> [String: Any] {
        var d: [String: Any] = [
            "ok": true, "npm": true,
            "board": running ? ["port": 4600, "pid": 4242, "version": "0.4.0", "own": false, "again": login ? NSNull() : "ravenry --no-open", "command": "node ravenry"] as [String: Any] : NSNull(),
            "login": login ? [["label": "gg.ravenry.board", "plist": "~/Library/LaunchAgents/gg.ravenry.board.plist", "loaded": running]] : [],
            "hooks": ["claude": [["event": "Stop", "command": "node hooks/events.mjs"]], "codex": [["event": "Stop", "command": "node hooks/events.mjs"]]],
            "copy": ["root": "/usr/local/lib/node_modules/ravenry-app", "version": "0.4.0", "node": "/usr/local/bin/node"],
        ]
        if let r = record {
            d["record"] = ["state": r, "port": 4600, "from": ["board": ["again": "ravenry --no-open", "command": "node ravenry"]], "login": login ? [["label": "gg.ravenry.board"]] : []] as [String: Any]
        } else { d["record"] = NSNull() }
        return d
    }
}
