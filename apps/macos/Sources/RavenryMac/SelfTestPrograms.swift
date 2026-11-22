// A plain program's status on the board (sidetest.mjs --screen programs,
// SESS-056): two shells of this window, one in recipe-box's folder running
// "npm run deploy", one in star-map's running "make release", each a
// small script that reports itself with OSC 7501 as a build or a deploy
// does (working with its progress, blocked on a sign-in, done, failed).
// Each step is the script's own report through the daemon, read by the
// demo board (this tree's hub, following this test's daemon), whose state
// the window draws: nothing here is made up.
// Checks the sidebar row (Shell, progress, the line, Done and Failed held
// under the project), the tab dot, the toast, the panel's lines, Reply
// typing into the pane, the seen post on leaving an opened Failed, and the
// row gone once the hub drops it. Pictures: programs-1-blocked,
// programs-3-working, programs-4-done-failed, programs-5-failed-panel.

import AppKit

extension SelfTestBoard {
    /// The row of a pane's program as drawn from the state: its section and row.
    private func programRow(_ pane: String) -> (group: String, project: String, row: SideRow)? {
        for s in board.hub.state?.sections ?? [] { for p in s.projects { for r in p.rows where r.surfaceId == "ravenry:\(pane)" && r.program != nil { return (s.group, p.id, r) } } }
        return nil
    }
    private func tabModel(_ pane: String) -> TabModel? {
        guard let tb = board.ws.tabs.first(where: { $0.has(pane) }) else { return nil }
        return board.ws.bar.items.first { $0.model.id == tb.id }?.model
    }
    private func typeIn(_ pane: String, _ text: String) {
        board.ws.conn.request("pane.send", ["pane": pane, "input": [["text": text, "mode": "paste"], ["key": "Enter"]]])
    }

    func screenPrograms() {
        let ws = board.ws, sb = board.sidebar, hub = board.hub
        let env = ProcessInfo.processInfo.environment
        guard let home = env["RAVENRY_MAC_HUB_HOME"] else { check("prog_hub_home", false); return }
        let root = (home as NSString).appendingPathComponent("Projects")
        let dir = ((home as NSString).deletingLastPathComponent as NSString).appendingPathComponent("scratch/programs")
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        // The two programs: each reports itself with OSC 7501, a step at a time (a file the test writes lets it on).
        let script = """
        #!/bin/sh
        n=$1; d=$2
        o() { printf '\\033]7501;%s\\033\\\\' "$1"; }
        m() { printf '%s' "$1" | base64 | tr -d '\\n'; }
        w() { while [ ! -e "$d/$n-$1" ]; do sleep 0.1; done; }
        if [ "$n" = deploy ]; then
          printf '\\n> recipe-box@2.3.0 deploy\\n> node scripts/deploy.mjs\\n\\nBuilding 2.3.0 ... done (41 s)\\nUploading build 1 of 5 ... done\\nUploading build 2 of 5 ... done\\nUploading build 3 of 5 ...'
          o "state=working:app=deploy:progress=60:msg=$(m 'Uploading build 3 of 5')"
          w blocked
          printf ' done\\n\\nThe store asks for a sign-in to go on.\\nEnter the 2FA code from your phone: '
          o "state=blocked:kind=auth:app=deploy:progress=60:msg=$(m 'Waiting for the 2FA code')"
          read code
          printf '%s\\n' "$code" > "$d/deploy-got"
          printf 'Uploading build 4 of 5 ... done\\nUploading build 5 of 5 ... done\\nDeployed 2.3.0 to the store\\n'
          o "state=done:app=deploy:msg=$(m 'Deployed 2.3.0 to the store')"
        else
          printf 'cc -O2 -c src/stars.c\\ncc -O2 -c src/path.c\\nld -o build/star-core build/*.o\\n'
          o "state=working:app=make:progress=44:msg=$(m 'Compiling 212 of 480')"
          w fail
          printf 'Running 212 tests ...\\nFAIL  path: wraps at the seam (3 cases)\\nTests failed: 3 of 212\\nmake: *** [release] Error 2\\n'
          o "state=error:app=make:msg=$(m 'Tests failed: 3 of 212')"
          exit 2
        fi
        """
        let prog = (dir as NSString).appendingPathComponent("prog.sh")
        try? script.write(toFile: prog, atomically: true, encoding: .utf8)
        let step = { (s: String) in FileManager.default.createFile(atPath: (dir as NSString).appendingPathComponent(s), contents: Data()) }
        size(1440, 900)
        sb.idleOpen = true
        guard wait(10, { ws.active != nil }) else { check("prog_first_tab", false); return }
        // Two shells, one in each project's folder; the commands as a person types them.
        var panes: [String] = []
        for (project, fn) in [("recipe-box", "npm() { sh '\(prog)' deploy '\(dir)'; }"), ("star-map", "make() { sh '\(prog)' release '\(dir)'; }")] {
            let before = ws.tabs.count
            ws.newTab(nil)
            guard wait(6, { ws.tabs.count == before + 1 }), let tb = ws.active else { check("prog_tab_\(project)", false); return }
            settle(1.0)
            typeIn(tb.host, "cd '\(root)/\(project)'; \(fn); clear")
            panes.append(tb.host)
        }
        let deploy = panes[0], release = panes[1]
        settle(1.0)
        typeIn(deploy, "npm run deploy")
        typeIn(release, "make release")
        // The daemon's own record of each (pane.agent): working.
        check("prog_daemon_reports_working", wait(8) { ws.paneInfo(deploy)?.agentState == "working" && ws.paneInfo(release)?.agentState == "working" },
              "\(ws.paneInfo(deploy)?.agent ?? "-") / \(ws.paneInfo(release)?.agent ?? "-")")
        // The board's rows for them (SESS-056).
        check("prog_hub_sends_rows", wait(12) { self.programRow(deploy) != nil }, "\(hub.state?.sections.map { "\($0.group) \($0.count)" } ?? [])")
        board.render(force: true)

        // 3. Working: a row under recipe-box and star-map, Shell and its progress; its tab has the blue dot.
        check("prog_working_rows", wait(8) {
            guard let a = self.programRow(deploy), let b = self.programRow(release) else { return false }
            return a.group == "work" && a.project == "recipe-box" && b.group == "work" && b.project == "star-map"
        }, "\(String(describing: programRow(deploy).map { ($0.group, $0.project) })) \(String(describing: programRow(release).map { ($0.group, $0.project) }))")
        if let r = programRow(deploy) {
            let k = r.row.key
            board.render(force: true)
            let chip = (sb.tags[k] ?? nil).map { texts($0).joined() } ?? ""
            check("prog_row_shell_chip", chip == "Shell", chip)
            check("prog_row_progress", sb.pcs[k]?.stringValue == "60%", sb.pcs[k]?.stringValue ?? "-")
            check("prog_row_line", sb.rows[k].map { shows($0, "Uploading build 3 of 5") } ?? false)
            check("prog_row_name", sb.names[k]?.stringValue == "npm run deploy", sb.names[k]?.stringValue ?? "-")
        }
        check("prog_tab_dot_working", wait(4) { self.tabModel(deploy)?.dot == "work" && self.tabModel(release)?.dot == "work" }, "\(tabModel(deploy)?.dot ?? "nil") \(tabModel(release)?.dot ?? "nil")")
        ws.show(ws.tabs[0])
        shot("programs-3-working.png")

        // 1. Blocked: recipe-box up to Needs you with the program's row, the toast; a click opens its tab and panel.
        step("deploy-blocked")
        check("prog_daemon_reports_blocked", wait(8) { ws.paneInfo(deploy)?.agentState == "needs_you" }, ws.paneInfo(deploy)?.agent ?? "-")
        check("prog_blocked_row", wait(8) { self.programRow(deploy)?.group == "you" && self.programRow(deploy)?.project == "recipe-box" }, "\(String(describing: programRow(deploy).map { ($0.group, $0.project) }))")
        board.render(force: true)
        if let r = programRow(deploy) {
            let k = r.row.key
            check("prog_blocked_line", sb.rows[k].map { shows($0, "Waiting for the 2FA code") } ?? false)
            check("prog_blocked_progress", sb.pcs[k]?.stringValue == "60%", sb.pcs[k]?.stringValue ?? "-")
        }
        let toastText = "npm run deploy in recipe-box needs you: Waiting for the 2FA code"
        check("prog_toast", wait(6) { self.board.toastTexts.contains(toastText) }, board.toastTexts.joined(separator: " | "))
        check("prog_tab_dot_blocked", wait(4) { self.tabModel(deploy)?.dot == "you" }, tabModel(deploy)?.dot ?? "nil")
        shot("programs-1-toast.png")
        // A click on its row: its shell tab in front, its panel.
        if let r = programRow(deploy), let row = sb.rows[r.row.key] {
            click(row)
            board.render(force: true)
            check("prog_click_opens_tab", wait(4) { ws.active?.has(deploy) == true }, "active \(ws.active?.host ?? "-")")
            let pn = board.panel
            let since = When.clock(hub.state?.find(r.row.key)?.session.program?.since)
            check("prog_panel_blocked", wait(4) { self.board.render(force: true); return pn.shows == "program" && pn.programLines["state"] == "npm run deploy needs you to sign in since \(since)" },
                  "\(pn.shows) \(pn.programLines)")
            check("prog_panel_said", pn.programLines["said"]?.hasPrefix("From the program: it said so ") ?? false, pn.programLines["said"] ?? "-")
            check("prog_panel_question", pn.programLines["message"] == "Waiting for the 2FA code", pn.programLines["message"] ?? "-")
            check("prog_panel_head", (pn.headChip.map { texts($0).joined() } ?? "") == "Shell" && shows(pn, "npm run deploy"), texts(pn).prefix(4).joined(separator: " | "))
            check("prog_panel_reply_box", pn.programReply != nil && shows(pn, "Or type in the terminal."))
            shot("programs-1-blocked.png")
            // Reply: the words go to the hub's person-only route, and into the pane with Enter.
            if let box = pn.programReply {
                box.field.stringValue = "424242"
                ProgramReplyBox.drafts[box.key] = "424242"
                click(box.sendButton)
                _ = wait(8) { hub.inFlight == 0 }
                let body = hub.sentBodies.last { $0.path == "/api/program/reply" }?.body
                check("prog_reply_sent", body?["text"] as? String == "424242" && body?["surfaceId"] as? String == "ravenry:\(deploy)" && body?["projectId"] as? String == "recipe-box",
                      "\(body ?? [:])")
                let got = (dir as NSString).appendingPathComponent("deploy-got")
                check("prog_reply_reaches_pane", wait(8) { (try? String(contentsOfFile: got, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) == "424242" },
                      (try? String(contentsOfFile: got, encoding: .utf8)) ?? "nothing read")
            }
        } else { check("prog_click_opens_tab", false, "no row") }

        // 4. Done and failed: each row stays under its project, Done or Failed, until seen.
        step("release-fail")
        ws.show(ws.tabs[0])
        check("prog_done_failed_held", wait(10) { self.programRow(deploy)?.row.program?.state == "done" && self.programRow(release)?.row.program?.state == "failed" },
              "\(programRow(deploy)?.row.program?.state ?? "-") \(programRow(release)?.row.program?.state ?? "-")")
        board.render(force: true)
        for (pane, word, color) in [(deploy, "Done", "ok"), (release, "Failed", "bad")] {
            guard let r = programRow(pane) else { check("prog_row_\(word.lowercased())", false, "no row"); continue }
            let pc = sb.pcs[r.row.key]
            check("prog_row_\(word.lowercased())", r.group == "idle" && pc?.stringValue == word && pc?.textColor == Design.color(color) && sb.rows[r.row.key] != nil,
                  "\(r.group) \(pc?.stringValue ?? "-")")
        }
        check("prog_row_failed_line", programRow(release).flatMap { sb.rows[$0.row.key] }.map { shows($0, "Tests failed: 3 of 212") } ?? false)
        check("prog_tab_no_dot_when_ended", wait(4) { self.tabModel(deploy)?.dot == nil && self.tabModel(release)?.dot == nil }, "\(tabModel(deploy)?.dot ?? "nil") \(tabModel(release)?.dot ?? "nil")")
        shot("programs-4-done-failed.png")

        // 5. A click on the failed one: its tab, and the panel says so; leaving it is seeing it.
        let seenBefore = hub.sentBodies.filter { $0.path == "/api/program/seen" }.count
        if let r = programRow(release), let row = sb.rows[r.row.key] {
            click(row)
            board.render(force: true)
            check("prog_failed_opens_tab", wait(4) { ws.active?.has(release) == true }, "active \(ws.active?.host ?? "-")")
            let pn = board.panel
            let since = When.clock(hub.state?.find(r.row.key)?.session.program?.since)
            check("prog_panel_failed", wait(4) { self.board.render(force: true); return pn.shows == "program" && pn.programLines["state"] == "make release failed at \(since)" && pn.programLines["message"] == "Tests failed: 3 of 212" },
                  "\(pn.shows) \(pn.programLines)")
            check("prog_failed_no_seen_while_shown", hub.sentBodies.filter { $0.path == "/api/program/seen" }.count == seenBefore)
            shot("programs-5-failed-panel.png")
            ws.show(ws.tabs[0])
            board.render(force: true)
            let seen = hub.sentBodies.last { $0.path == "/api/program/seen" }?.body
            check("prog_seen_posted", seen?["surfaceId"] as? String == "ravenry:\(release)" && seen?["projectId"] as? String == r.project, "\(seen ?? [:])")
            check("prog_seen_row_goes", wait(10) { self.board.render(force: true); return self.programRow(release) == nil }, "\(programRow(release)?.row.key ?? "gone")")
        } else { check("prog_failed_opens_tab", false, "no row") }

        // How it leaves: a new command in its shell, and the project is back to its own state.
        typeIn(deploy, "echo next")
        check("prog_new_command_row_goes", wait(10) { self.board.render(force: true); return self.programRow(deploy) == nil }, "\(programRow(deploy)?.row.key ?? "gone")")
        check("prog_no_rows_left", (board.hub.state?.sections ?? []).allSatisfy { $0.projects.allSatisfy { $0.rows.allSatisfy { $0.program == nil } } })
        check("prog_project_back_to_its_own", hub.state?.project("star-map").map { p in !p.sessions.contains { $0.program != nil } } ?? false)
    }

    /// The window at 1440 by 1180, tall enough for every row of the sidebar, as drawn now.
    private func shot(_ name: String) {
        size(1440, 1180)
        board.render(force: true)
        settle(0.6)
        picture(name)
        size(1440, 900)
    }
}
