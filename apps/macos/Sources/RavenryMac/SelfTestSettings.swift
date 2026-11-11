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
            scrollbackKeys(saved)
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
        screenSettingsHandoff()
        press(sw.tabButtons["skills"])
        // Read with ?ravenryd= (GETs are not in hub.sent): each row then says its hooks.
        check("set_skills_read", wait(8) { sw.skillsRead && !sw.skills.isEmpty && sw.skills.allSatisfy { ["on", "off", "unavailable"].contains($0["hooks"] as? String ?? "") } }, "\(sw.skills)")
        check("set_skills_rows", (sw.skills.isEmpty && shows(root, t("set.needsBoard"))) || (shows(root, "Claude Code") && sw.skills.allSatisfy { $0["hooks"] != nil } && shows(root, t("set.hooksTitle"))), texts(root).joined(separator: " | "))
        settingsPictures("settings-skills")
        screenSettingsSkillsFollow()
        screenSettingsLive()
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
        skillsLeftAlone(root)
        let sq = squeezed(root)
        check("set_no_squeezed_text", sq.isEmpty, sq.joined(separator: " | "))
        // Cmd+, from the menu, on the tab it was left on.
        board.menuSettings(nil)
        check("set_menu_reopens", sw.tab == "skills" && sw.window.isVisible)
        sw.window.orderOut(nil)
    }

    /// Simon on 0.1.33: "when installing the skill the checkbox in 'This
    /// session' only updated after closing the modal". The skill and the
    /// hooks set up and removed from the Settings window: the panel's rows
    /// beside a Claude session follow each press while Settings is open.
    /// The hooks name the stable bin/ravenryd (AppInstall.hookRavenryd).
    func screenSettingsLive() {
        let sw = board.settings, b = board
        guard let st = b.hub.state, let (p, s) = st.projects.lazy.compactMap({ p -> (HubProject, HubSession)? in
            guard p.machine == nil, let s = p.sessions.first(where: { $0.assistant == "claude" && $0.machine == nil && st.checkpoint(of: p, $0) == nil }) else { return nil }
            return (p, s) }).first else { check("set_live_session", false, "no Claude session without a question"); return }
        // The app's data folder has its bin/ravenryd link, as a packaged app's: the hooks name it.
        if let data = ProcessInfo.processInfo.environment["RAVENRY_DESKTOP_DATA"] {
            let link = URL(fileURLWithPath: data).appendingPathComponent("bin/ravenryd")
            try? FileManager.default.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: link.path) { try? FileManager.default.createSymbolicLink(at: link, withDestinationURL: Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/ravenryd")) }
        }
        size(1280, 820)
        b.topLevel { $0.pickSession("\(p.id)/\(s.surfaceId)", why: "test") }
        if !b.panelVisible { b.togglePanel() }
        sw.show("skills")
        _ = wait(8) { sw.skillsRead && sw.busy == nil }
        let panel = b.panel
        func row(_ yes: String) -> Bool { b.render(force: true); return shows(panel, yes) }
        func pressAndFollow(_ ctl: String, _ yes: String, _ no: String, _ id: String) {
            guard let btn = sw.controls[ctl] as? RButton else { check("set_live_\(id)_button", false, "\(sw.controls.keys.sorted())"); return }
            _ = wait(8) { row(yes) || row(no) }
            let was = row(yes)
            btn.performClick(nil)
            check("set_live_\(id)_panel_follows_with_settings_open", wait(8) { row(was ? no : yes) } && sw.window.isVisible,
                  "was \(was) now \(texts(panel).filter { $0 == yes || $0 == no })")
            if id == "hooks" {
                picture("native-panel-this-session-\(was ? "off" : "on")-1280.png")
                size(900, 760)
                if !b.panelVisible { b.togglePanel() }
                settle(0.4); b.render(force: true); settle(0.3)
                let sq = squeezed(window.contentView!)
                check("set_live_hooks_rows_whole_900", sq.isEmpty && row(was ? no : yes), sq.joined(separator: " | "))
                picture("native-panel-this-session-\(was ? "off" : "on")-900.png")
                size(1280, 820)
            }
            guard let back = sw.controls[ctl] as? RButton else { return }
            back.performClick(nil)
            check("set_live_\(id)_panel_follows_back", wait(8) { row(was ? yes : no) } && sw.window.isVisible, "\(texts(panel).filter { $0 == yes || $0 == no })")
            if id == "hooks" {
                picture("native-panel-this-session-\(was ? "on" : "off")-1280.png")
                size(900, 760)
                if !b.panelVisible { b.togglePanel() }
                settle(0.4); b.render(force: true); settle(0.3)
                let sq = squeezed(window.contentView!)
                check("set_live_hooks_rows_whole_900_back", sq.isEmpty && row(was ? yes : no), sq.joined(separator: " | "))
                picture("native-panel-this-session-\(was ? "on" : "off")-900.png")
                size(1280, 820)
            }
        }
        let n = b.hub.sentBodies.count
        pressAndFollow("skill:claude", t("panel.skillOn"), t("panel.skillOff"), "skill")
        pressAndFollow("hooks:claude", t("panel.alertsOn"), t("panel.alertsOff"), "hooks")
        let sent = b.hub.sentBodies.dropFirst(n).filter { $0.path == "/api/setup/hooks" && $0.body["remove"] == nil }.compactMap { $0.body["ravenryd"] as? String }
        check("set_live_hooks_name_stable_ravenryd", !sent.isEmpty && sent.allSatisfy { $0.hasSuffix("/bin/ravenryd") && !$0.contains(".app/Contents/") }, sent.joined(separator: ","))
        settingsPictures("settings-skills-hooks")
    }

    /// SET-012 as the person types: the keys go to the Settings window's field editor (Return and
    /// Escape through its doCommandBy). 50 and Return: ringed red, what was typed kept, the range said
    /// in words beside it, settings.json keeps its value; Escape puts the saved value back; 25,000 and
    /// Return saves it.
    private func scrollbackKeys(_ saved: () -> [String: Any]) {
        let sw = board.settings
        func keyIn(_ chars: String, _ code: UInt16) {
            if let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: sw.window.windowNumber,
                                        context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) { sw.window.sendEvent(e) }
            settle(0.2)
        }
        func typeAll(_ s: String) {
            guard let f = (sw.controls["scrollback"] as? ScrollbackField)?.field else { return }
            if f.currentEditor() == nil { sw.window.makeFirstResponder(f) }
            f.currentEditor()?.selectAll(nil)
            for ch in s { f.currentEditor()?.insertText(String(ch)) }
            settle(0.1)
        }
        let before = saved()["scrollback"] as? Int
        typeAll("50")
        keyIn("\r", 36)
        let sb = sw.controls["scrollback"] as? ScrollbackField
        let range = sw.controls["scrollbackRange"] as? NSTextField
        check("set_scrollback_enter_out_of_range_kept", sw.scrollbackBad && sb?.ring == "bad" && sb?.field.stringValue == "50" && saved()["scrollback"] as? Int == before,
              "bad \(sw.scrollbackBad) ring \(sb?.ring ?? "") field \(sb?.field.stringValue ?? "") saved \(saved()["scrollback"] ?? "nil")")
        check("set_scrollback_range_said", range?.isHidden == false && range?.window != nil && range?.stringValue == "From 100 to 100,000 lines" && sb?.toolTip == "From 100 to 100,000 lines", "\(range?.stringValue ?? "none") hidden \(range?.isHidden ?? true)")
        settingsPictures("settings-scrollback-range")
        keyIn("\u{1b}", 53)
        let sb2 = sw.controls["scrollback"] as? ScrollbackField
        check("set_scrollback_escape_puts_back", !sw.scrollbackBad && sb2?.field.stringValue == "10,000" && sb2?.ring == "sep" && (sw.controls["scrollbackRange"]?.isHidden ?? false) && saved()["scrollback"] as? Int == before,
              "field \(sb2?.field.stringValue ?? "") ring \(sb2?.ring ?? "") bad \(sw.scrollbackBad)")
        typeAll("25000")
        keyIn("\r", 36)
        check("set_scrollback_enter_saves", wait(3) { saved()["scrollback"] as? Int == 25000 } && (sw.controls["scrollback"] as? ScrollbackField)?.field.stringValue == "25,000" && !sw.scrollbackBad, "\(saved()["scrollback"] ?? "nil")")
        sw.commitScrollback("10000")
        sw.window.makeFirstResponder(nil)
    }

    /// SET-013 and SET-014 on the hub's own files (its HOME, RAVENRY_MAC_HUB_HOME): a ravenry skill
    /// of someone else's is said and offers no Install, and the file stays as it was; Codex's hooks
    /// turned off in its config.toml are said, and Set up (the hub's 200) leaves the line as set.
    private func skillsLeftAlone(_ root: NSView) {
        let sw = board.settings
        guard let home = ProcessInfo.processInfo.environment["RAVENRY_MAC_HUB_HOME"], !home.isEmpty else { check("set_skill_hub_home", false, "no RAVENRY_MAC_HUB_HOME"); return }
        let fm = FileManager.default
        // Claude Code's skill folder, someone else's (no Ravenry mark).
        let skill = URL(fileURLWithPath: home).appendingPathComponent(".claude/skills/ravenry/SKILL.md")
        if (sw.skills.first { $0["kind"] as? String == "claude" }?["ours"] as? Bool) == true, let r = sw.controls["skill:claude"] as? RButton { r.performClick(nil); _ = wait(8) { sw.busy == nil && sw.skills.first { $0["kind"] as? String == "claude" }?["ours"] as? Bool != true } }
        try? fm.createDirectory(at: skill.deletingLastPathComponent(), withIntermediateDirectories: true)
        let mine = "---\nname: ravenry\ndescription: my own notes, not Ravenry's\n---\n\nMine.\n"
        try? mine.write(to: skill, atomically: true, encoding: .utf8)
        sw.readSkills()
        let claude = { sw.skills.first { $0["kind"] as? String == "claude" } ?? [:] }
        check("set_skill_someone_else_said", wait(8) { claude()["installed"] as? Bool == true && claude()["ours"] as? Bool != true && self.shows(root, t("set.someoneElse")) },
              "\(claude()) | \(texts(root).filter { $0.contains("ravenry") }.joined(separator: ","))")
        check("set_skill_someone_else_no_install", sw.controls["skill:claude"] == nil && (try? String(contentsOf: skill, encoding: .utf8)) == mine, "\(sw.controls.keys.filter { $0.hasPrefix("skill") })")
        settingsPictures("settings-skills-someone-else")
        try? fm.removeItem(at: skill.deletingLastPathComponent())

        // Codex's hooks off in its own config.toml.
        let toml = URL(fileURLWithPath: home).appendingPathComponent(".codex/config.toml")
        try? fm.createDirectory(at: toml.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? "model = \"gpt-5\"\n\n[features]\nhooks = false\n".write(to: toml, atomically: true, encoding: .utf8)
        sw.readSkills()
        let codex = { sw.skills.first { $0["kind"] as? String == "codex" } ?? [:] }
        check("set_codex_hooks_off_in_config_said", wait(8) { codex()["hooksOff"] as? Bool == true && codex()["hooks"] as? String == "off" && self.shows(root, t("set.hooksOffInConfig")) },
              "\(codex())")
        settingsPictures("settings-skills-codex-off")
        if let b = sw.controls["hooks:codex"] as? RButton {
            let n = board.hub.sentBodies.count
            b.performClick(nil)
            check("set_codex_hooks_setup_posts", wait(10) { self.board.hub.sentBodies.dropFirst(n).contains { $0.path == "/api/setup/hooks" } && sw.busy == nil && sw.skillError == nil }, "\(sw.skillError ?? "")")
            let after = (try? String(contentsOf: toml, encoding: .utf8)) ?? ""
            check("set_codex_hooks_line_left_as_set", after.contains("[features]\nhooks = false") && wait(8) { codex()["hooksOff"] as? Bool == true && self.shows(root, t("set.hooksOffInConfig")) }, after)
        } else { check("set_codex_hooks_setup_posts", false, "no Set up for Codex: \(codex())") }
    }

    /// SET-015: a board started with MC_PROJECTS_ROOT (sidetest --screen settingsroot): Hand-off
    /// shows that folder with the lock line and no Change.
    func screenSettingsRoot() {
        let sw = board.settings
        let want = ProcessInfo.processInfo.environment["RAVENRY_MAC_LOCKED_ROOT"] ?? ""
        board.menuSettings(nil)
        _ = wait(3) { sw.window.isVisible }
        press(sw.tabButtons["handoff"])
        let root = sw.window.contentView!
        let pathShown = { (sw.controls["ho:root:path"] as? NSTextField)?.stringValue ?? "" }
        check("set_root_locked_path", !want.isEmpty && wait(8) { pathShown() == want }, "shown \(pathShown()) want \(want)")
        check("set_root_locked_line", shows(root, t("ho.rootLocked")), texts(root).filter { $0.contains("MC_") || $0.contains("Projects") }.joined(separator: ","))
        check("set_root_locked_no_change", sw.controls["ho:root:change"] == nil, "\(sw.controls.keys.filter { $0.hasPrefix("ho:root") })")
        // The hub refuses a change it locked: POST /api/settings/projects-root is not 200.
        var code = 0
        board.hub.post("/api/settings/projects-root", ["path": NSTemporaryDirectory()]) { c, _ in code = c }
        check("set_root_locked_hub_refuses", wait(6) { code != 0 } && code != 200 && wait(4) { pathShown() == want }, "hub \(code)")
        settingsPictures("settings-root-locked")
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
    func settingsPictures(_ name: String, widths: Bool = true) {
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
