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

// The phone card's QR codes read back (CIDetector), sidetest --screen phone:
// PHONE-011, the app's pairing lists the Wi-Fi's addresses, then the others
// (RAVENRY_PHONE_HOSTS stands in for Tailscale's 100.x); with none, the card
// says so and shows no code. PHONE-012, the board in the phone's browser: its
// code opens /?k=<the hub's phone key>, and New key changes it.
extension SelfTestBoard {
    func qrText(_ img: NSImage) -> String? {
        let side = 600
        guard let ctx = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.setFillColor(CGColor(gray: 1, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: side, height: side))
        var r = CGRect(x: 60, y: 60, width: side - 120, height: side - 120)
        guard let cg = img.cgImage(forProposedRect: &r, context: nil, hints: nil) else { return nil }
        ctx.draw(cg, in: CGRect(x: 60, y: 60, width: side - 120, height: side - 120))
        guard let out = ctx.makeImage(), let det = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]) else { return nil }
        return (det.features(in: CIImage(cgImage: out)).first as? CIQRCodeFeature)?.messageString
    }
    private func imageView(_ v: NSView, label: String) -> NSImageView? {
        if let i = v as? NSImageView, i.accessibilityLabel() == label { return i }
        for s in v.subviews { if let f = imageView(s, label: label) { return f } }
        return nil
    }
    private func hubPhoneKey() -> String? {
        guard let home = ProcessInfo.processInfo.environment["RAVENRY_MAC_HUB_HOME"],
              let d = try? Data(contentsOf: URL(fileURLWithPath: home).appendingPathComponent(".ravenry/phone.json")),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
        return j["key"] as? String
    }

    /// After New key (screenPhone's phone_new_key_posts): the card read again, its browser code carries the new key.
    func phoneNewKeyQr(_ pc: PhoneCard) {
        guard pc.data?["svg"] as? String != nil || hubPhoneKey() != nil else { return }
        pc.release()
        let key1 = hubPhoneKey() ?? ""
        _ = wait(5) { pc.data?["svg"] as? String != nil }
        pc.buttons["browser"]?.performClick(nil)
        check("phone_browser_qr_new_key", !key1.isEmpty && key1 != String(repeating: "k", count: 48) && wait(6) { (pc.browserQrView?.image.flatMap { self.qrText($0) } ?? "").hasSuffix("/?k=\(key1)") },
              pc.browserQrView?.image.flatMap { self.qrText($0) }?.replacingOccurrences(of: key1, with: "<new key>") ?? "no code")
        pc.buttons["appCode"]?.performClick(nil)
    }

    func phoneQrChecks(_ pc: PhoneCard) {
        // PHONE-011: the app's code, read back.
        let appImg = imageView(pc, label: "QR code that pairs the Ravenry app")?.image
        let link = appImg.flatMap { qrText($0) } ?? ""
        let hosts = URLComponents(string: link)?.queryItems?.first { $0.name == "hosts" }?.value?.split(separator: ",").map(String.init) ?? []
        let lan = (pc.data?["app"] as? [String: Any])?["hosts"] as? [String] ?? []
        check("phone_pair_lists_other_hosts_after_wifi", link.hasPrefix("ravenry://pair?") && hosts.last == "100.101.102.103" && hosts == lan && (hosts.count == 1 || !hosts[0].hasPrefix("100.")),
              "\(link.prefix(160)) \(hosts)")
        // PHONE-012: the browser's code, after its link is pressed.
        let key0 = hubPhoneKey() ?? ""
        let hasLan = pc.data?["svg"] as? String != nil
        if hasLan {
            pc.buttons["browser"]?.performClick(nil)
            settle(0.3)
            let url0 = pc.browserQrView?.image.flatMap { qrText($0) } ?? ""
            check("phone_browser_qr_opens_board_with_key", pc.browser && !key0.isEmpty && url0.hasPrefix("http://") && url0.hasSuffix("/?k=\(key0)") && shows(pc, t("phone.browserScan")),
                  "\(url0.replacingOccurrences(of: key0, with: "<key>"))")
            pictures("phone-browser")
            pc.buttons["appCode"]?.performClick(nil)
            check("phone_back_to_app_code", !pc.browser && imageView(pc, label: "QR code that pairs the Ravenry app") != nil)
        } else { check("phone_browser_qr_needs_wifi", shows(pc, t("phone.noAddress")) || pc.buttons["browser"] == nil, "no Wi-Fi address on this Mac") }
        // PHONE-011: no address at all: the line, no code.
        let real = pc.data ?? [:]
        var none = real
        var app = none["app"] as? [String: Any] ?? [:]
        app["hosts"] = [String]()
        none["app"] = app; none["svg"] = nil; none["address"] = nil
        pc.apply(none)
        check("phone_no_address_said", shows(pc, t("phone.noAddress")) && imageView(pc, label: "QR code that pairs the Ravenry app") == nil, texts(pc).prefix(6).joined(separator: " | "))
        pictures("phone-no-address")
        pc.apply(real)
    }
}
