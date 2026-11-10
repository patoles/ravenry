// The self-test of the Settings window (scripts/sidetest.mjs --screen
// settings): opened from the sidebar's foot, offscreen, on the test's own
// data folder (RAVENRY_DESKTOP_DATA), each control pressed as the person
// would and the settings file read back; the file changed from outside
// (the Electron app writing it) is drawn again; Skills from the demo hub.

import AppKit

extension SelfTestBoard {
    func screenSettings() {
        guard let foot = findFoot() else { check("set_foot", false); return }
        foot.performClick(nil)
        let sw = board.settings
        let root = sw.window.contentView!
        check("set_opens_from_foot", wait(3) { sw.window.isVisible && sw.tab == "appearance" } && board.log.contains("settings appearance"), board.log.suffix(3).joined(separator: ","))
        let store = sw.store
        let file = store.file
        check("set_file_in_test_data", file?.path.contains("/desktop/settings.json") == true, file?.path ?? "none")
        func saved() -> [String: Any] { (file.flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONSerialization.jsonObject(with: $0) }) as? [String: Any] ?? [:] }
        check("set_defaults_drawn", shows(root, "Menlo") && (sw.controls["size"] as? NSTextField)?.stringValue == "13" && shows(root, t("set.follow")) && shows(root, "Ravenry Dark") && shows(root, "Paper") && sw.controls.keys.filter { $0.hasPrefix("theme:") }.count == 8, texts(root).joined(separator: " | "))
        check("set_preview", sw.controls["preview"]?.accessibilityLabel() == t("set.preview", ["theme": "Ravenry Dark"]) && shows(root, "~/code/landing-page"), sw.controls["preview"]?.accessibilityLabel() ?? "")
        settingsPictures("settings-appearance")

        // Font size, family, themes, follow, cursor, blink.
        press(sw.controls["bigger"])
        check("set_bigger_saved", saved()["fontSize"] as? Int == 14 && (sw.controls["size"] as? NSTextField)?.stringValue == "14", "\(saved()["fontSize"] ?? "nil")")
        press(sw.controls["smaller"]); press(sw.controls["smaller"])
        check("set_smaller_saved", saved()["fontSize"] as? Int == 12, "\(saved()["fontSize"] ?? "nil")")
        let other = sw.fonts.first { $0 != "Menlo" } ?? "Courier"
        sw.fontPicked(NSMenuItem(title: other, action: nil, keyEquivalent: ""))
        check("set_font_family_saved", saved()["fontFamily"] as? String == other && shows(root, other), other)
        sw.fontPicked(NSMenuItem(title: "Menlo", action: nil, keyEquivalent: ""))
        check("set_font_menu_lists_monospace", !sw.fonts.isEmpty && sw.fonts.contains("Menlo") && !sw.fonts.contains("Helvetica"), "\(sw.fonts.count) fonts")
        press(sw.controls["theme:themeDark:nord"])
        check("set_theme_dark_saved", saved()["themeDark"] as? String == "nord" && (sw.controls["theme:themeDark:nord"] as? Box)?.ring == "work" && sw.controls["preview"]?.accessibilityLabel() == t("set.preview", ["theme": "Nord"]), "\(saved()["themeDark"] ?? "nil")")
        press(sw.controls["theme:themeLight:paper"])
        check("set_theme_light_saved", saved()["themeLight"] as? String == "paper", "\(saved()["themeLight"] ?? "nil")")
        press(sw.controls["follow"])
        check("set_follow_off", saved()["themeFollowsSystem"] as? Bool == false && shows(root, t("set.use")) && shows(root, t("set.followOff")) && sw.controls.keys.filter { $0.hasPrefix("theme:themeAlways:") }.count == 8, texts(root).joined(separator: " | "))
        press(sw.controls["theme:themeAlways:solarized-light"])
        check("set_theme_always_saved", saved()["themeAlways"] as? String == "solarized-light" && sw.controls["preview"]?.accessibilityLabel() == t("set.preview", ["theme": "Solarized Light"]))
        press(sw.controls["cursor:bar"])
        press(sw.controls["blink"])
        check("set_cursor_saved", saved()["cursorStyle"] as? String == "bar" && saved()["cursorBlink"] as? Bool == true && sw.controls["cursor:bar"]?.accessibilityValue() as? Bool == true)
        settingsPictures("settings-follow-off", widths: false)
        press(sw.controls["follow"]); press(sw.controls["cursor:block"]); press(sw.controls["blink"])
        check("set_kept_other_keys", saved()["version"] as? Int == 1 && saved()["scrollback"] as? Int == 10000)

        // The file written by the other app: drawn again.
        if let f = file {
            var j = saved(); j["fontSize"] = 20
            settle(1.1)
            if let d = try? JSONSerialization.data(withJSONObject: j) { try? d.write(to: f) }
            check("set_file_from_outside_drawn", wait(5) { (sw.controls["size"] as? NSTextField)?.stringValue == "20" } && store.int("fontSize") == 20, "\((sw.controls["size"] as? NSTextField)?.stringValue ?? "")")
            press(sw.controls["smaller"])
            check("set_after_outside_keeps_writing", saved()["fontSize"] as? Int == 19)
            j = saved(); j["fontSize"] = "huge"; j["mystery"] = 1
            settle(1.1)
            if let d = try? JSONSerialization.data(withJSONObject: j) { try? d.write(to: f) }
            check("set_wrong_value_reads_default", wait(5) { store.int("fontSize") == 13 } && (sw.controls["size"] as? NSTextField)?.stringValue == "13")
            press(sw.controls["bigger"])
            check("set_unknown_key_kept", saved()["mystery"] as? Int == 1 && saved()["fontSize"] as? Int == 14)
            press(sw.controls["smaller"])
        }

        // Behavior.
        press(sw.tabButtons["behavior"])
        check("set_tab_behavior", sw.tab == "behavior" && sw.window.title == t("set.behavior") && shows(root, t("set.keyboard")) && shows(root, t("set.metaOff")), texts(root).prefix(8).joined(separator: " | "))
        settingsPictures("settings-behavior")
        press(sw.controls["meta:left"])
        check("set_meta_saved", saved()["optionAsMeta"] as? String == "left" && shows(root, t("set.metaSide")))
        press(sw.controls["copy"])
        press(sw.controls["links"])
        check("set_copy_links_saved", saved()["copyOnSelect"] as? Bool == true && saved()["openLinksSingleClick"] as? Bool == true && shows(root, t("set.linksOn")))
        if let sb = sw.controls["scrollback"] as? ScrollbackField {
            check("set_scrollback_shown", sb.field.stringValue == "10,000", sb.field.stringValue)
            sw.commitScrollback("20,000")
            check("set_scrollback_saved", saved()["scrollback"] as? Int == 20000 && (sw.controls["scrollback"] as? ScrollbackField)?.field.stringValue == "20,000")
            sw.commitScrollback("lots")
            check("set_scrollback_wrong_red", sw.scrollbackBad && (sw.controls["scrollback"] as? ScrollbackField)?.ring == "bad" && saved()["scrollback"] as? Int == 20000)
            sw.commitScrollback("50")
            check("set_scrollback_out_of_range", sw.scrollbackBad && saved()["scrollback"] as? Int == 20000)
            sw.commitScrollback("10000")
        } else { check("set_scrollback_shown", false) }
        press(sw.controls["bell:off"])
        let bounce = sw.controls["bounce"] as? CheckRow
        press(bounce)
        check("set_bell_off_bounce_off", saved()["bell"] as? String == "off" && bounce?.enabled == false && bounce?.alphaValue ?? 1 < 0.5 && saved()["bellBounceDock"] as? Bool == true)
        press(sw.controls["bell:sound"])
        press(sw.controls["bounce"])
        press(sw.controls["close"])
        check("set_bell_bounce_close_saved", saved()["bell"] as? String == "sound" && saved()["bellBounceDock"] as? Bool == false && saved()["confirmCloseBusy"] as? Bool == false)

        // Skills: the hub's rows with their hooks; Install posts to it.
        // The file as a person or an older app left it (the poll reads it again).
        if let f = file {
            let dir = f.deletingLastPathComponent()
            func put(_ text: String, _ k: Double) {
                try? text.write(to: f, atomically: true, encoding: .utf8)
                try? FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(k)], ofItemAtPath: f.path)
            }
            // Broken: kept beside as settings.json.broken, the defaults read.
            put("{ \"fontSize\": 15,\n", 10)
            let broken = wait(5) { FileManager.default.fileExists(atPath: dir.appendingPathComponent("settings.json.broken").path) && store.problems.first?.contains("not JSON") == true }
            check("set_broken_kept_aside", broken && (try? String(contentsOf: dir.appendingPathComponent("settings.json.broken"), encoding: .utf8)) == "{ \"fontSize\": 15,\n" && store.int("fontSize") == 13,
                  store.problems.joined(separator: "; "))
            // Version 0, xterm.js's names: migrated, the old file kept as settings.v0.json, an unknown key kept.
            put(#"{ "fontFamily": "'Monaco', Menlo, monospace", "fontSize": 14, "macOptionIsMeta": true, "bellStyle": "none", "theme": "nord", "myOwn": 7 }"#, 20)
            let migrated = wait(5) { saved()["version"] as? Int == 1 }
            let j = saved()
            check("set_migrated_v0", migrated && j["fontFamily"] as? String == "Monaco" && j["optionAsMeta"] as? String == "both" && j["bell"] as? String == "off"
                  && j["themeAlways"] as? String == "nord" && j["themeFollowsSystem"] as? Bool == false && j["macOptionIsMeta"] == nil && j["bellStyle"] == nil && j["theme"] == nil
                  && j["myOwn"] as? Int == 7 && store.string("fontFamily") == "Monaco" && store.string("bell") == "off", "\(j)")
            check("set_migrated_old_kept", FileManager.default.fileExists(atPath: dir.appendingPathComponent("settings.v0.json").path))
            // From a newer app: read what this one knows, a copy kept once.
            put(#"{ "version": 9, "fontSize": 16, "futureKey": "x" }"#, 30)
            check("set_newer_kept", wait(5) { store.int("fontSize") == 16 && FileManager.default.fileExists(atPath: dir.appendingPathComponent("settings.v9.json").path) } && store.problems.first?.contains("newer") == true,
                  store.problems.joined(separator: "; "))
            put(#"{ "version": 1 }"#, 40)
            _ = wait(5) { store.int("fontSize") == 13 && store.string("bell") == "visual" }
            settle(0.3)
        }
        // Import: the file (RAVENRY_SETTINGS_IMPORT, as the Electron app's
        // tests) made a theme by the hub, saved in the data folder's themes/.
        press(sw.tabButtons["appearance"])
        if let imp = ProcessInfo.processInfo.environment["RAVENRY_SETTINGS_IMPORT"] {
            let pal = (0..<16).map { "palette = \($0)=#\(String(format: "%06X", 0x0F0F0F + 0x101010 * ($0 % 15)))" }.joined(separator: "\n")
            try? "# Harbour Night\nbackground = #1a1b26\nforeground = #c0caf5\n\(pal)\n".write(toFile: imp, atomically: true, encoding: .utf8)
            check("set_import_row", shows(root, t("set.import")) && shows(root, t("set.importHint")), texts(root).joined(separator: " | "))
            var s0 = board.hub.sent.count
            press(sw.controls["import"])
            let dir = store.themesDir
            let fileSaved = wait(8) { dir.map { FileManager.default.fileExists(atPath: $0.appendingPathComponent("harbour-night.json").path) } ?? false }
            check("set_import_saves", sentSince(s0).contains("POST /api/settings/theme-import") && fileSaved && store.themes.contains { $0.id == "user:harbour-night" && $0.appearance == "dark" },
                  sentSince(s0).joined(separator: ","))
            check("set_import_note", wait(3) { self.shows(root, t("set.imported", ["name": "Harbour Night", "appearance": "dark"])) } && sw.controls["theme:themeDark:user:harbour-night"] != nil,
                  texts(root).joined(separator: " | "))
            settingsPictures("settings-imported")
            // The same file again: the same theme, no second copy.
            press(sw.controls["import"])
            _ = wait(3) { self.sentSince(s0).filter { $0 == "POST /api/settings/theme-import" }.count == 2 }
            settle(0.5)
            check("set_import_same_once", store.userThemes.filter { $0.name == "Harbour Night" }.count == 1)
            // A broken file: the hub's reason, in red, nothing saved.
            try? "background = #000000\nforeground = #ffffff\n".write(toFile: imp, atomically: true, encoding: .utf8)
            s0 = board.hub.sent.count
            press(sw.controls["import"])
            check("set_import_refused", wait(5) { self.shows(root, "This Ghostty theme has no palette = 0.") } && store.userThemes.count == 1, texts(root).joined(separator: " | "))
            // Pick it: the terminals take it.
            press(sw.controls["theme:themeDark:user:harbour-night"])
            check("set_import_used", wait(3) { saved()["themeDark"] as? String == "user:harbour-night" && self.board.ws.look.theme.background == Theme.css("#1A1B26") })
            store.set(["themeDark": "ravenry-dark"])
        } else {
            check("set_import_env", false, "no RAVENRY_SETTINGS_IMPORT")
        }
        press(sw.tabButtons["skills"])
        // Read with ?ravenryd= (GETs are not in hub.sent): each row then says its hooks.
        check("set_skills_read", wait(8) { sw.skillsRead && !sw.skills.isEmpty && sw.skills.allSatisfy { ["on", "off", "unavailable"].contains($0["hooks"] as? String ?? "") } }, "\(sw.skills)")
        check("set_skills_rows", (sw.skills.isEmpty && shows(root, t("set.needsBoard"))) || (shows(root, "Claude Code") && sw.skills.allSatisfy { $0["hooks"] != nil } && shows(root, t("set.hooksTitle"))), texts(root).joined(separator: " | "))
        settingsPictures("settings-skills")
        if let b = sw.controls["skill:claude"] as? RButton {
            let s = board.hub.sent.count
            b.performClick(nil)
            check("set_skill_install_posts", wait(8) { self.sentSince(s).contains("POST /api/setup/skills") && sw.busy == nil }, sentSince(s).joined(separator: ","))
            check("set_skill_installed_or_said", wait(8) { (sw.skills.first { $0["kind"] as? String == "claude" }?["ours"] as? Bool == true) || sw.skillError != nil }, "\(sw.skillError ?? "")")
            if sw.skills.first(where: { $0["kind"] as? String == "claude" })?["ours"] as? Bool == true, let r = sw.controls["skill:claude"] as? RButton {
                let s2 = board.hub.sent.count
                r.performClick(nil)
                check("set_skill_remove_posts", wait(8) { self.sentSince(s2).contains("POST /api/setup/skills") && sw.skills.first { $0["kind"] as? String == "claude" }?["ours"] as? Bool != true })
            }
        }
        if let h = sw.controls["hooks:claude"] as? RButton {
            let s = board.hub.sent.count
            h.performClick(nil)
            check("set_hooks_posts", wait(8) { self.sentSince(s).contains("POST /api/setup/hooks") && sw.busy == nil }, sentSince(s).joined(separator: ","))
        }
        let sq = squeezed(root)
        check("set_no_squeezed_text", sq.isEmpty, sq.joined(separator: " | "))
        // Cmd+, from the menu, on the tab it was left on.
        board.menuSettings(nil)
        check("set_menu_reopens", sw.tab == "skills" && sw.window.isVisible)
        sw.window.orderOut(nil)
    }

    /// The foot's Settings button.
    private func findFoot() -> RButton? {
        func walk(_ v: NSView) -> RButton? {
            if let b = v as? RButton, b.toolTip == t("side.settings") { return b }
            for s in v.subviews { if let x = walk(s) { return x } }
            return nil
        }
        return walk(board.sidebar)
    }

    private func press(_ v: NSView?) {
        if let c = v as? CheckRow { c.press() }
        else if let b = v as? TapBox { b.press() }
        else if let b = v as? NSButton { b.performClick(nil) }
        else { check("set_control_missing", false) }
        settle(0.15)
    }

    /// The Settings window in dark and light (`widths`: unused, one size: it is 720 wide).
    private func settingsPictures(_ name: String, widths: Bool = true) {
        let sw = board.settings
        for dark in [true, false] {
            NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            sw.draw()
            settle(0.4)
            guard let root = sw.window.contentView, let rep = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { continue }
            root.cacheDisplay(in: root.bounds, to: rep)
            let s: CGFloat = 2
            let w = Int(root.bounds.width * s), h = Int(root.bounds.height * s)
            guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue), let base = rep.cgImage else { continue }
            var bg = CGColor(gray: 0, alpha: 1)
            sw.window.effectiveAppearance.performAsCurrentDrawingAppearance { bg = Design.color("sheet").cgColor }
            ctx.setFillColor(bg); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            ctx.draw(base, in: CGRect(x: 0, y: 0, width: w, height: h))
            if let img = ctx.makeImage() { try? NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("native-\(name)-\(dark ? "dark" : "light").png")) }
            let sq = squeezed(root)
            check("\(name)_no_squeezed_text_\(dark ? "dark" : "light")", sq.isEmpty, sq.joined(separator: " | "))
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        sw.draw()
    }
}
