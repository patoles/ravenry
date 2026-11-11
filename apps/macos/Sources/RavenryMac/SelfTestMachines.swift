// Machines checks of the 2026-11-11 audit (sidetest --screen machines),
// called from screenMachines (SelfTestLearn.swift):
//
// - MACH-002: the hosts of the hub's ~/.ssh/config as chips; a chip fills
//   the host; Add and install posts the add, then the install of that
//   machine, each the hub's 200; Add only posted no install.
// - MACH-003: End them and uninstall sends endSessions, Use Ravenry's
//   instead sends replaceHooks, each the hub's 200.
// - MACH-008: a machine on an older ravenryd, or one this app cannot talk
//   to, in the hub's state: one toast each, Update it opens Machines, said
//   once, and not again by a later read of the same folder (a relaunch).

import AppKit

extension SelfTestBoard {
    private func answered(_ path: String, after n: Int) -> Int? { board.hub.answers.last { $0.seq >= n && $0.path == path }?.code }

    func machinesAddInstall(_ pg: MachinesPage) {
        check("machines_add_only_no_install", !board.hub.sent.contains("POST /api/machines/install"), board.hub.sent.filter { $0.contains("machines") }.joined(separator: ","))
        guard let home = ProcessInfo.processInfo.environment["RAVENRY_MAC_HUB_HOME"] else { check("machines_hub_home", false); return }
        let cfg = URL(fileURLWithPath: home).appendingPathComponent(".ssh/config")
        try? FileManager.default.createDirectory(at: cfg.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? "Host chipbox\n  HostName 127.0.0.1\n  User tester\n\nHost *\n  ServerAliveInterval 30\n".write(to: cfg, atomically: true, encoding: .utf8)
        pg.load()
        _ = wait(5) { pg.hosts.contains("chipbox") }
        if pg.buttons["addEmpty"] != nil { pg.buttons["addEmpty"]?.performClick(nil) } else { pg.buttons["add"]?.performClick(nil) }
        check("machines_ssh_hosts_chips", wait(5) { pg.hosts == ["chipbox"] && pg.buttons["chip-chipbox"] != nil && self.shows(pg, t("mach.fromConfig")) }, "\(pg.hosts)")
        pictures("machines-add-chips")
        pg.buttons["chip-chipbox"]?.performClick(nil)
        check("machines_chip_fills_host", pg.fields["m-host"]?.text == "chipbox", pg.fields["m-host"]?.text ?? "")
        let n = board.hub.sent.count
        pg.buttons["addInstall"]?.performClick(nil)
        check("machines_add_and_install_posts", wait(8) { self.answered("/api/machines/add", after: n) == 200 && self.answered("/api/machines/install", after: n) == 200 }
              && Array(sentSince(n).prefix(2)) == ["POST /api/machines/add", "POST /api/machines/install"]
              && board.hub.sentBodies.last { $0.path == "/api/machines/install" }?.body["name"] as? String == "chipbox",
              "\(sentSince(n)) \(board.hub.answers.filter { $0.seq >= n }.map { "\($0.path) \($0.code)" })")
        _ = wait(8) { pg.working.isEmpty }
        // Gone again, so the page is empty for what follows (its install, ssh being /usr/bin/false, stops at once).
        _ = wait(10) { !(pg.list.first { $0["name"] as? String == "chipbox" }.flatMap { ($0["job"] as? [String: Any])?["state"] as? String } == "running") }
        pg.post("/api/machines/remove", ["name": "chipbox"], "chipbox")
        _ = wait(6) { pg.list.isEmpty }
        try? FileManager.default.removeItem(at: cfg)
        pg.load()
        _ = wait(5) { pg.hosts.isEmpty }
    }

    /// The bodies of the steps' buttons (pressed by screenMachines just before).
    func machinesStepBodies(lab: (Int, Int), laptop: (Int, Int)) {
        let nLab = lab.1, nLaptop = laptop.1
        let lab = board.hub.sentBodies.dropFirst(lab.0).first { $0.path == "/api/machines/install" }
        check("machines_use_ravenrys_hooks_sends_replace", lab?.body["name"] as? String == "lab" && lab?.body["replaceHooks"] as? Bool == true && answered("/api/machines/install", after: nLab) == 200,
              "\(lab?.body ?? [:]) \(answered("/api/machines/install", after: nLab) ?? 0)")
        let lap = board.hub.sentBodies.dropFirst(laptop.0).first { $0.path == "/api/machines/uninstall" }
        check("machines_end_them_sends_end_sessions", lap?.body["name"] as? String == "old-laptop" && lap?.body["endSessions"] as? Bool == true && answered("/api/machines/uninstall", after: nLaptop) == 200,
              "\(lap?.body ?? [:]) \(answered("/api/machines/uninstall", after: nLaptop) ?? 0)")
    }

    /// MACH-008 on the hub's state, its machines as the fixture's shapes.
    func machinesSaidToast(_ shapes: [[String: Any]]) {
        board.openPage("side.alerts", t("side.alerts"))
        _ = wait(3) { self.board.front != .page("side.machines", t("mach.title")) }
        let L = board.log.count
        board.hub.testPatch = { st in var s = st; s["machines"] = shapes; return s }
        // A new state from the hub: a machine added (the hub sends its state again).
        board.hub.post("/api/machines/add", ["host": "said-trigger", "name": "said-trigger"]) { _, _ in }
        let want = [t("mach.saidOlder", ["name": "gpu-box", "version": "0.1.21"]), t("mach.saidProtocol", ["name": "old-nas", "version": " (0.0.9)"])]
        check("machines_older_toasted_once", wait(10) { want.allSatisfy { w in self.toasts(since: L).contains(w) } } && toasts(since: L).filter { $0.contains("ravenryd") }.count == 2,
              toasts(since: L).joined(separator: " / "))
        picture("native-machines-said-toast-1280-dark.png")
        // Another state: nothing said again.
        board.hub.post("/api/machines/remove", ["name": "said-trigger"]) { _, _ in }
        settle(3)
        check("machines_said_not_again", toasts(since: L).filter { $0.contains("ravenryd") }.count == 2, toasts(since: L).joined(separator: " / "))
        // A relaunch reads the same data folder: nothing to say.
        check("machines_said_kept_for_relaunch", MachinesSaid(offscreen: true).newly(in: shapes).isEmpty
              && ProcessInfo.processInfo.environment["RAVENRY_DESKTOP_DATA"].map { FileManager.default.fileExists(atPath: $0 + "/machines-said.json") } == true)
        // Update it opens Machines.
        let upd = board.toastStack.buttons.first { $0.title == t("mach.updateIt") }
        upd?.performClick(nil)
        check("machines_update_it_opens", upd != nil && board.front == .page("side.machines", t("mach.title")), "\(board.front)")
        board.hub.testPatch = nil
    }
}
