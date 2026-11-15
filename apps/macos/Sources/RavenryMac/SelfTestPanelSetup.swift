// PANEL-003 in the session panel (scripts/sidetest.mjs --screen settings): the
// "This session" box is shown only when something is missing. The hooks and
// the skill are set up and taken out in the hub's own HOME (RAVENRY_MAC_HUB_HOME)
// through the hub, as Settings does, and the panel is read where it lands:
// - both on: no box;
// - one off: that line alone, with its fix (Set up, Install) that the panel
//   runs in place (the hub's POST, the hub then saying on);
// - the line just fixed turns green, then the box fades: the time measured;
// - someone else's skill in the skill folder: the line, Settings, no Install;
// - on demand, the head's assistant chip: both lines; pressed again, gone;
// - a pane started as a session before the board lists it: Folder and
//   Assistant, no green lines.
// It drives the views as the person would and asks nothing of the panel's
// internals, so the same checks run on an app from before the change.

import AppKit

extension SelfTestBoard {
    func panelSetupQuiet() {
        let b = board
        guard let st = b.hub.state else { check("pset_state", false); return }
        let picks = st.projects.flatMap { p in p.sessions.filter { $0.assistant == "claude" && $0.machine == nil && p.machine == nil && st.checkpoint(of: p, $0) == nil }.map { (p, $0) } }
        guard let (p, s) = picks.first(where: { $0.1.group != "you" }) ?? picks.first else { check("pset_session", false, "no Claude session without a question"); return }
        let sw = board.settings
        if sw.window.isVisible { sw.window.orderOut(nil) }
        size(1280, 820)
        b.topLevel { $0.pickSession("\(p.id)/\(s.surfaceId)", why: "test") }
        if !b.panelVisible { b.togglePanel() }
        window.makeFirstResponder(nil)
        let panel = b.panel
        let rd = AppInstall.shared.hookRavenryd
        let title = t("panel.thisSession"), on = t("panel.alertsOn"), off = t("panel.alertsOff"), skOn = t("panel.skillOn"), skOff = t("panel.skillOff")
        func post(_ path: String, _ body: [String: Any]) {
            var done = false
            b.hub.post(path, body) { _, _ in done = true }
            _ = wait(8) { done }
        }
        /// The hub's own answer (GET /api/setup/skills), Claude Code's row.
        func row() -> [String: Any] {
            var r: [String: Any]? = nil
            b.hub.get("/api/setup/skills?ravenryd=\(rd.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")") { _, j in r = (j["skills"] as? [[String: Any]] ?? []).first { $0["kind"] as? String == "claude" } ?? [:] }
            _ = wait(5) { r != nil }
            return r ?? [:]
        }
        func hubSays(hooks: Bool, skill: Bool) -> Bool { let r = row(); return (r["hooks"] as? String == "on") == hooks && (r["ours"] as? Bool == true) == skill }
        func set(hooks: Bool, skill: Bool) {
            post("/api/setup/hooks", hooks ? ["ravenryd": rd, "only": "claude"] : ["ravenryd": rd, "only": "claude", "remove": true])
            post("/api/setup/skills", skill ? ["kind": "claude", "on": true, "ravenryd": rd, "version": "0.0.0"] : ["kind": "claude", "on": false])
            SettingsWindow.said("hooks")
            check("pset_hub_set_\(hooks ? "hooks" : "nohooks")_\(skill ? "skill" : "noskill")", hubSays(hooks: hooks, skill: skill), "\(row())")
            // Past a line's few green seconds (a line turned on here is "just fixed").
            settle(4.2)
            b.render(force: true); settle(0.3)
        }
        func buttons(_ v: NSView) -> [RButton] { if let r = v as? RButton { return [r] }; return v.subviews.flatMap { buttons($0) } }
        func button(_ title: String) -> RButton? { buttons(panel).first { $0.title == title && !$0.isHidden && $0.window != nil } }
        func showsNow(_ s: String) -> Bool { b.render(); return shows(panel, s) }
        func said() -> String { texts(panel).prefix(14).joined(separator: " | ") }

        // Both on: no box.
        set(hooks: true, skill: true)
        check("pset_all_on_no_box", !shows(panel, title) && !shows(panel, on) && !shows(panel, skOn), said())
        picture("native-panel-setup-all-on.png")

        // Alerts off: that line alone, and Set up turns them on in place.
        set(hooks: false, skill: true)
        check("pset_hooks_off_line_alone", shows(panel, title) && shows(panel, off) && !shows(panel, skOn) && !shows(panel, skOff) && button(t("set.setUp")) != nil, said())
        picture("native-panel-setup-hooks-off.png")
        if let fix = button(t("set.setUp")) {
            let n = b.hub.sentBodies.count
            let t0 = Date()
            fix.performClick(nil)
            let green = wait(8) { showsNow(on) }
            let tGreen = Date().timeIntervalSince(t0)
            check("pset_hooks_fix_in_place", green && b.hub.sentBodies.dropFirst(n).contains { $0.path == "/api/setup/hooks" && $0.body["only"] as? String == "claude" && $0.body["remove"] == nil } && hubSays(hooks: true, skill: true),
                  String(format: "green %@ at %.2f s, %@", green ? "yes" : "no", tGreen, said()))
            picture("native-panel-setup-just-fixed.png")
            let gone = wait(8) { !showsNow(on) && !self.shows(panel, title) }
            let tGone = Date().timeIntervalSince(t0)
            // Green about 3 s, then a 0.35 s fade: gone between 2.5 s and 5 s after it turned green.
            check("pset_fixed_green_then_box_fades", gone && tGone - tGreen > 2.5 && tGone - tGreen < 5,
                  String(format: "green at %.2f s, box gone at %.2f s after the press (%.2f s green)", tGreen, tGone, tGone - tGreen))
        } else { check("pset_hooks_fix_in_place", false, "no Set up: \(said())"); check("pset_fixed_green_then_box_fades", false, "no Set up") }

        // Skill missing: that line alone, and Install puts it in place.
        set(hooks: true, skill: false)
        check("pset_skill_off_line_alone", shows(panel, skOff) && !shows(panel, on) && !shows(panel, off) && button(t("set.install")) != nil, said())
        picture("native-panel-setup-skill-off.png")
        if let fix = button(t("set.install")) {
            fix.performClick(nil)
            check("pset_skill_fix_in_place", wait(8) { showsNow(skOn) } && hubSays(hooks: true, skill: true), said())
            _ = wait(8) { !showsNow(skOn) }
        } else { check("pset_skill_fix_in_place", false, "no Install: \(said())") }

        // Someone else's skill in its folder: the line says so, Settings, no Install (Ravenry leaves it alone).
        if let home = ProcessInfo.processInfo.environment["RAVENRY_MAC_HUB_HOME"], !home.isEmpty {
            // From Ravenry's own skill, on and so not shown, to someone else's in its place.
            set(hooks: true, skill: true)
            let skill = URL(fileURLWithPath: home).appendingPathComponent(".claude/skills/ravenry/SKILL.md")
            try? FileManager.default.createDirectory(at: skill.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? "---\nname: ravenry\ndescription: my own notes\n---\n\nMine.\n".write(to: skill, atomically: true, encoding: .utf8)
            let r = row()
            SettingsWindow.said("skills")
            check("pset_someone_elses_skill_points_to_settings", r["installed"] as? Bool == true && r["ours"] as? Bool != true && wait(8) { showsNow(skOff) } && button(t("set.install")) == nil && button(t("side.settings")) != nil,
                  "hub \(r["installed"] ?? "nil")/\(r["ours"] ?? "nil"): \(said())")
            try? FileManager.default.removeItem(at: skill.deletingLastPathComponent())
        } else { check("pset_someone_elses_skill_points_to_settings", false, "no RAVENRY_MAC_HUB_HOME") }

        // On demand: the head's assistant chip opens both lines, and closes them.
        set(hooks: true, skill: true)
        let chip = panel.headChip?.superview as? TapBox
        chip?.press(); settle(0.3); b.render()
        check("pset_on_demand_lists_both", chip != nil && shows(panel, title) && shows(panel, on) && shows(panel, skOn) && chip?.toolTip == t("panel.setupTip"), "chip \(chip != nil): \(said())")
        picture("native-panel-setup-on-demand.png")
        chip?.press(); settle(0.3); b.render()
        check("pset_on_demand_closes", chip != nil && !shows(panel, on) && !shows(panel, title), said())

        // A pane started as a Claude session, before the board lists it: Folder and Assistant, no green lines.
        if let tb = b.ws.tabs.first {
            let was = panel.host?.paneLabels
            panel.host?.paneLabels = { _ in ["ravenry.session": "claude"] }
            b.ws.bar.onSelect?(tb.id)
            b.render(force: true); settle(0.3)
            check("pset_new_session_no_green_lines", panel.shows == "new" && shows(panel, t("panel.folder")) && shows(panel, "Claude Code") && !shows(panel, on) && !shows(panel, skOn), "\(panel.shows): \(said())")
            picture("native-panel-setup-new-session.png")
            if let w = was { panel.host?.paneLabels = w }
        } else { check("pset_new_session_no_green_lines", false, "no tab") }
    }
}
