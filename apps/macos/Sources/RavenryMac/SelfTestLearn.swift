// The self-test of Learn Ravenry, Machines and the phone card
// (scripts/sidetest.mjs --screen learn | machines | phone), on the demo hub:
// each control pressed as the person would, the route the hub received or
// what the page shows after. Machines draws every shape from the hub's own
// cards (hub/tools/machine-shapes.mjs through machineview.mjs, written by
// sidetest.mjs to RAVENRY_MAC_FIXTURE); the demo hub's ssh is /usr/bin/false.

import AppKit

extension SelfTestBoard {
    private func foot(_ key: String) { board.sidebar.footButtons[key]?.performClick(nil); settle(0.3) }

    // MARK: Learn Ravenry (ONB-004, ONB-005)

    func screenLearn() {
        let pg = board.learn
        foot("side.learn")
        check("learn_opens_from_foot", board.front == .page("side.learn", t("learn.title")) && board.root.middle === pg && board.root.wideMiddle, "\(board.front)")
        check("learn_foot_lit", wait(2) { self.board.sidebar.footButtons["side.learn"]?.on == true })
        check("learn_drawn", wait(3) { pg.cardViews.count == 7 } && shows(pg, t("learn.lead")) && LearnPage.cards.allSatisfy { self.shows(pg, t("learn.\($0.key).title")) && self.shows(pg, t("learn.\($0.key).line")) },
              texts(pg).prefix(8).joined(separator: " | "))
        check("learn_actions", pg.buttons["try-phone"]?.title == t("learn.phone.action") && pg.buttons["try-panes"]?.title == t("learn.tryIt"))
        // auto-fill, minmax(232px, 1fr): 3 a row at 1280 (980 of middle), 2 at 900, each as wide as the others.
        let widths = { Set(pg.cardViews.values.map { Int($0.frame.width / 2) * 2 }) }
        size(1280, 820); settle(0.5)
        check("learn_grid_1280", widths().count == 1 && (widths().first ?? 0) >= 232 && Set(pg.cardViews.values.map { Int($0.frame.minX) }).count == 3, "\(widths()) \(Set(pg.cardViews.values.map { Int($0.frame.minX) }))")
        size(900, 760); settle(0.5)
        check("learn_grid_900", widths().count == 1 && (widths().first ?? 0) >= 232 && Set(pg.cardViews.values.map { Int($0.frame.minX) }).count == 2, "\(widths())")
        let row0 = pg.cardViews["panes"]!.frame.height, row0b = pg.cardViews["needs"]!.frame.height
        check("learn_row_equal_heights", abs(row0 - row0b) < 1, "\(row0) \(row0b)")
        size(1280, 820); settle(0.3)
        pictures("learn")
        // Used: the phone card opened marks it on the board, and Learn ticks it.
        var n = board.hub.sent.count
        board.openPhone()
        check("learn_mark_posted", wait(3) { self.sentSince(n).contains("POST /api/onboarding") })
        board.phoneCard.close()
        board.openLearn()
        check("learn_used_tick", wait(4) { pg.used["phone"] == true && self.shows(pg, t("learn.used")) }, "\(pg.used)")
        // Learn more points at a card: ringed.
        board.openLearn(lit: "pick")
        check("learn_lit_card", (pg.cardViews["pick"] as? Box)?.ring == "work" && (pg.cardViews["panes"] as? Box)?.ring == "sheet-ring")
        // Try it: the assistant looked for, then a session started with the message, else said why.
        var L = board.log.count
        n = board.hub.sent.count
        pg.buttons["try-panes"]?.performClick(nil)
        let started = wait(6) { self.sentSince(n).contains("POST /api/sessions/start") || self.toasts(since: L).contains(t("learn.noAssistant")) }
        check("learn_try_starts_or_says", started, "sent \(sentSince(n)) toasts \(toasts(since: L))")
        _ = wait(4) { self.board.log.dropFirst(L).contains { $0.hasPrefix("toast ") || $0.hasPrefix("session ") || $0.hasPrefix("try: message") } }
        learnTryChecks()
        // The phone's card opens the phone card.
        board.openLearn()
        pg.buttons["try-phone"]?.performClick(nil)
        check("learn_phone_opens_card", wait(2) { self.board.phoneCard.isOpen } && board.front != .page("side.learn", t("learn.title")), "\(board.front)")
        board.phoneCard.close()
        // The filmstrip's: the terminal that printed last (no filmstrip in this app yet).
        board.openLearn()
        L = board.log.count
        pg.buttons["try-film"]?.performClick(nil)
        check("learn_film_shows_terminal", wait(2) { self.board.front == .tab } || toasts(since: L).contains(t("learn.filmNeeds")), "\(board.front)")
        // Help, Learn Ravenry; Close goes back.
        board.menuLearn(nil)
        check("learn_from_help_menu", board.front == .page("side.learn", t("learn.title")))
        pg.buttons["close"]?.performClick(nil)
        check("learn_close_goes_back", board.front != .page("side.learn", t("learn.title")) && board.root.middle !== pg, "\(board.front)")
    }

    // MARK: Machines (MACH-001 to MACH-004)

    func screenMachines() {
        let pg = board.machines
        foot("side.machines")
        check("machines_opens_from_foot", board.front == .page("side.machines", t("mach.title")) && board.root.middle === pg, "\(board.front)")
        check("machines_empty_drawn", wait(5) { pg.loaded && self.shows(pg, t("mach.empty")) } && pg.buttons["add"] != nil && pg.buttons["addEmpty"] != nil, texts(pg).prefix(6).joined(separator: " | "))
        check("machines_foot_lit_no_dot", board.sidebar.footButtons["side.machines"]?.on == true && board.sidebar.machinesDot == false)
        pictures("machines")
        // Add a machine: a host is needed; Add only posts it (ssh is /usr/bin/false here: it cannot connect).
        pg.buttons["addEmpty"]?.performClick(nil)
        check("machines_add_opens", pg.adding && pg.fields["m-host"]?.window != nil && pg.buttons["add"] == nil && shows(pg, "ssh uses your keys and ~/.ssh/config"))
        pictures("machines-add")
        pg.buttons["addOnly"]?.performClick(nil)
        check("machines_host_needed", shows(pg, t("mach.needHost")))
        if let f = pg.fields["m-host"] { typeIn(f, "tester@devbox") }
        check("machines_name_placeholder_follows", pg.fields["m-name"]?.field.placeholderAttributedString?.string == "devbox", pg.fields["m-name"]?.field.placeholderAttributedString?.string ?? "")
        var n = board.hub.sent.count
        pg.buttons["addOnly"]?.performClick(nil)
        check("machines_add_posted", wait(4) { self.sentSince(n).contains("POST /api/machines/add") } && wait(6) { !pg.adding && pg.list.contains { $0["name"] as? String == "devbox" } }, "\(sentSince(n)) \(pg.addError ?? "")")
        // This board dials no machine (it has no ravenryd of its own): the new one waits, Connecting, with no buttons, as on the Electron app.
        check("machines_added_waits", wait(6) { self.shows(pg, "Connecting") && self.shows(pg, "tester@devbox") } && pg.buttons["devbox:a0"] == nil, texts(pg).prefix(10).joined(separator: " | "))
        n = board.hub.sent.count
        pg.post("/api/machines/remove", ["name": "devbox"], "devbox")
        check("machines_removed", wait(4) { self.sentSince(n).contains("POST /api/machines/remove") } && wait(6) { pg.list.isEmpty && self.shows(pg, t("mach.empty")) }, "\(sentSince(n)) \(pg.list.count)")
        machinesAddInstall(pg)
        // Every shape, as the hub's cards say it.
        guard let fx = ProcessInfo.processInfo.environment["RAVENRY_MAC_FIXTURE"], let d = try? Data(contentsOf: URL(fileURLWithPath: fx)),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { check("machines_fixture", false, "no RAVENRY_MAC_FIXTURE"); return }
        // The hub has each of them too (the empty page above had none), so each
        // button's route reaches a machine the hub knows and gets its 200.
        for m in j["machines"] as? [[String: Any]] ?? [] {
            board.hub.post("/api/machines/add", ["host": m["host"] ?? "", "name": m["name"] ?? ""]) { _, _ in }
        }
        check("machines_fixture_registered_posts", wait(8) { self.board.hub.inFlight == 0 }, "\((j["machines"] as? [Any])?.count ?? 0) machines")
        pg.apply(j)
        board.render(force: true)
        settle(0.3)
        check("machines_all_shapes", ["Connected", "Older ravenryd", "Newer ravenryd", "Cannot talk to it", "Not installed", "Cannot connect", "Installing", "Install stopped", "Installed, hooks left as they were", "Sessions still run there"].allSatisfy { self.shows(pg, $0) },
              texts(pg).joined(separator: " | ").prefix(300).description)
        check("machines_dot_on_foot", board.sidebar.machinesDot)
        // Names in the order drawn (a host that is its name too counts once).
        let order = texts(pg).filter { n in pg.list.contains { $0["name"] as? String == n } }.reduce(into: [String]()) { if $0.last != $1 { $0.append($1) } }
        // Running first, then those that need you, then the rest, the connected last, each by name.
        check("machines_order", order == ["render-1", "bsd-box", "gpu-box", "old-laptop", "old-nas", "pi", "build-server", "devbox", "lab", "studio"], order.joined(separator: ","))
        check("machines_msg_and_facts", shows(pg, "gpu-box runs ravenryd 0.1.21; this app carries 0.1.24") && shows(pg, "Sessions on 0.1.21 until they end") && shows(pg, "Another board takes its answers") && shows(pg, "4.2 of 8.8 MB"))
        pictures("machines-all")
        screenMachinesWrap()
        // Each button posts its route.
        func press(_ key: String, _ route: String, _ name: String) {
            let n = board.hub.sent.count
            pg.buttons[key]?.performClick(nil)
            check(name, wait(4) { self.sentSince(n).contains("POST \(route)") }, "\(key): \(sentSince(n))")
            _ = wait(4) { pg.working.isEmpty }
        }
        press("gpu-box:a0", "/api/machines/install", "machines_update_posts")
        press("build-server:a1", "/api/machines/retry", "machines_retry_posts")
        press("pi:a1", "/api/machines/install", "machines_install_posts")
        press("pi:a0", "/api/machines/remove", "machines_remove_shape_posts")
        // The hub's refusal said under the card: pi's card (this page holds it) installed
        // again after the hub let it go, which the hub answers 404.
        let nPi = board.hub.sent.count
        pg.buttons["pi:a1"]?.performClick(nil)
        check("machines_error_under_card", wait(4) { pg.errors["pi"] != nil && self.shows(pg, pg.errors["pi"] ?? "-") } && board.hub.answers.contains { $0.seq >= nPi && $0.path == "/api/machines/install" && $0.code == 404 },
              "\(pg.errors)")
        _ = wait(4) { pg.working.isEmpty }
        press("studio:a0", "/api/machines/install", "machines_install_newer_posts")
        let nLab = (board.hub.sentBodies.count, board.hub.sent.count)
        press("lab:step-hooks-0", "/api/machines/install", "machines_replace_hooks_posts")
        let nLaptop = (board.hub.sentBodies.count, board.hub.sent.count)
        press("old-laptop:step-sessions-0", "/api/machines/uninstall", "machines_end_sessions_posts")
        machinesStepBodies(lab: nLab, laptop: nLaptop)
        // Uninstall asks first: its words, the card ringed red, Cancel puts it back.
        pg.buttons["devbox:a0"]?.performClick(nil)
        check("machines_uninstall_asks", pg.confirm == "devbox" && shows(pg, "Uninstall from devbox?") && pg.buttons["devbox:confirmYes"] != nil)
        pg.buttons["devbox:confirmNo"]?.performClick(nil)
        check("machines_uninstall_cancel", pg.confirm == nil && !shows(pg, "Uninstall from devbox?"))
        pg.buttons["devbox:a0"]?.performClick(nil)
        press("devbox:confirmYes", "/api/machines/uninstall", "machines_uninstall_posts")
        // A fix's command copied; Hide steps folds a stopped job away; Cancel on sessions still running too.
        let L = board.log.count
        pg.buttons["bsd-box:copy-disk"]?.performClick(nil)
        check("machines_copy_fix", Outside.record?.last == "copy df -h ~" && toasts(since: L).last == t("mach.copied"), Outside.record?.last ?? "")
        pg.buttons["bsd-box:hide"]?.performClick(nil)
        check("machines_hide_steps", pg.folded.contains { $0.hasPrefix("bsd-box|") } && !shows(pg, "Room on the disk"))
        pg.buttons["old-laptop:step-sessions-1"]?.performClick(nil)
        check("machines_cancel_folds", pg.folded.contains { $0.hasPrefix("old-laptop|") } && !shows(pg, "End them and uninstall"))
        pg.buttons["render-1:a0"].map { _ in check("machines_running_has_no_buttons", false) } ?? check("machines_running_has_no_buttons", true)
        machinesSaidToast(j["machines"] as? [[String: Any]] ?? [])
    }

    // MARK: the phone card (PHONE-001, PHONE-002, PHONE-006; ALERT-006)

    func screenPhone() {
        let pc = board.phoneCard
        var n = board.hub.sent.count
        foot("side.phone")
        check("phone_opens_from_foot", pc.isOpen && board.sidebar.footButtons["side.phone"]?.on == true)
        check("phone_off_drawn", wait(4) { pc.data != nil && self.shows(pc, t("phone.off")) } && shows(pc, t("phone.footOff")) && pc.toggle.on == false, texts(pc).joined(separator: " | "))
        check("phone_marks_learn", wait(3) { self.sentSince(n).contains("POST /api/onboarding") })
        if let m = board.sidebar.footButtons["side.phone"], let root = pc.superview {
            let a = m.convert(m.bounds, to: root)
            check("phone_card_over_its_mark", abs(pc.frame.width - 420) < 1 && pc.frame.minX <= a.minX && (root.isFlipped ? pc.frame.maxY <= a.minY : pc.frame.minY >= a.maxY), "card \(pc.frame) mark \(a)")
        }
        pictures("phone")
        // Escape closes it; the foot's mark opens it again.
        pc.cancelOperation(nil)
        check("phone_escape_closes", !pc.isOpen && board.sidebar.footButtons["side.phone"]?.on != true)
        foot("side.phone")
        _ = wait(4) { pc.data != nil }
        // The board's port (sidetest.mjs runs this screen's board as the
        // person's: RAVENRY_HUB_BIND=phone): access off, the Wi-Fi's address
        // is refused at TCP, loopback answers; the app's stream stays open
        // through every switch.
        let wifi = Self.wifiAddress(), port = URL(string: board.hub.url)?.port ?? 0
        let starts = board.hub.streamStarts
        check("phone_board_wifi_refused_off", wifi != nil && port > 0 && !Self.tcpOpen(wifi!, port) && Self.tcpOpen("127.0.0.1", port) && Self.tcpOpen("::1", port), "wifi \(wifi ?? "none") port \(port)")
        // On: the QR code, the code and its check number (or no address to reach).
        n = board.hub.sent.count
        click(pc.toggle, at: NSPoint(x: 30, y: 13))
        check("phone_access_on", wait(4) { self.sentSince(n).contains("POST /api/phone/access") } && wait(6) { pc.toggle.on && (self.shows(pc, t("phone.scan")) || self.shows(pc, t("phone.noAddress"))) }, texts(pc).joined(separator: " | "))
        let onCode = wifi.flatMap { w in wait(4) { Self.tcpOpen(w, port) } ? Self.httpStatus("http://\(w):\(port)/api/phone") : nil }
        check("phone_board_wifi_answers_on", onCode.map { (200..<500).contains($0) } == true && board.hub.reachable && board.hub.streamStarts == starts, "wifi \(wifi ?? "none"):\(port) answered \(onCode.map(String.init) ?? "nothing"); stream opened \(board.hub.streamStarts - starts) more times")
        let realApp = pc.data?["app"] as? [String: Any]
        check("phone_code_and_check", realApp == nil || (shows(pc, realApp?["code"] as? String ?? "-") && shows(pc, t("phone.check"))))
        pictures("phone-on")
        phoneQrChecks(pc)
        _ = wait(4) { !pc.busy }
        // Devices as the hub lists them, each with the hub's line: the board's own two
        // (sidetest.mjs seeds them), so Rename and Sign out reach real ones. New key,
        // which signs every device out, comes after.
        var card = pc.data ?? [:]
        card["devices"] = [
            ["id": "d1a2", "name": "Pixel 8", "platform": "android", "app": "0.4.2", "lastSeen": "2026-11-09T11:58:00Z", "line": ["name": "Pixel 8", "sub": "Android app, seen 2 min ago", "renamable": true]],
            ["id": "d3b4", "name": NSNull(), "platform": "browser", "lastSeen": "2026-11-08T09:00:00Z", "line": ["name": "Phone browser", "sub": "Signed in with the browser code, seen yesterday"]],
        ]
        pc.apply(card)
        check("phone_devices_drawn", shows(pc, "Pixel 8") && shows(pc, "Android app, seen 2 min ago") && shows(pc, "Phone browser") && pc.buttons["rename-d1a2"] != nil && pc.buttons["rename-d3b4"] == nil)
        pictures("phone-devices")
        pc.buttons["rename-d1a2"]?.performClick(nil)
        check("phone_rename_field", pc.editing == "d1a2" && pc.nameField?.stringValue == "Pixel 8")
        n = board.hub.sent.count
        pc.nameField?.stringValue = "  Kitchen   phone "
        pc.finishEdit(save: true)
        check("phone_rename_posts", wait(4) { self.sentSince(n).contains("POST /api/phone/devices/rename") } && pc.editing == nil)
        _ = wait(4) { !pc.busy }
        pc.buttons["rename-d1a2"]?.performClick(nil)
        n = board.hub.sent.count
        pc.cancelOperation(nil)
        check("phone_rename_escape_keeps", pc.editing == nil && pc.isOpen && !sentSince(n).contains("POST /api/phone/devices/rename"))
        pc.buttons["signOut-d1a2"]?.performClick(nil)
        check("phone_sign_out_posts", wait(4) { self.sentSince(n).contains("POST /api/phone/devices/revoke") })
        _ = wait(4) { !pc.busy }
        n = board.hub.sent.count
        pc.buttons["newKey"]?.performClick(nil)
        check("phone_new_key_posts", wait(4) { self.sentSince(n).contains("POST /api/phone/new-key") })
        _ = wait(4) { !pc.busy }
        phoneNewKeyQr(pc)
        // Alerts' Pair your phone opens it too; access off again.
        pc.close()
        board.openAlerts()
        _ = wait(5) { self.board.alerts.buttons["pair"] != nil }
        board.alerts.buttons["pair"]?.performClick(nil)
        check("phone_from_alerts", wait(2) { pc.isOpen })
        _ = wait(4) { pc.data != nil }
        n = board.hub.sent.count
        click(pc.toggle, at: NSPoint(x: 10, y: 13))
        check("phone_access_off", wait(4) { self.sentSince(n).contains("POST /api/phone/access") } && wait(6) { !pc.toggle.on && self.shows(pc, t("phone.off")) })
        check("phone_board_wifi_refused_again", wifi.map { w in wait(4) { !Self.tcpOpen(w, port) } } == true && Self.tcpOpen("127.0.0.1", port) && Self.httpStatus("http://127.0.0.1:\(port)/api/state") == 200 && board.hub.reachable && board.hub.streamStarts == starts, "stream opened \(board.hub.streamStarts - starts) more times, reachable \(board.hub.reachable)")
        pc.close()
    }

    /// This Mac's Wi-Fi address (en0's private IPv4), else another private one.
    static func wifiAddress() -> String? {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return nil }
        defer { freeifaddrs(list) }
        var found: [(String, String)] = []
        for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
            guard let sa = p.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let a = String(cString: host), q = a.split(separator: ".").compactMap { Int($0) }
            guard q.count == 4, q[0] == 10 || (q[0] == 172 && (16...31).contains(q[1])) || (q[0] == 192 && q[1] == 168) else { continue }
            found.append((String(cString: p.pointee.ifa_name), a))
        }
        return (found.first { $0.0 == "en0" } ?? found.first)?.1
    }

    /// Whether a TCP connection to host:port is accepted (within a second).
    static func tcpOpen(_ host: String, _ port: Int) -> Bool {
        var hints = addrinfo(ai_flags: AI_NUMERICHOST, ai_family: AF_UNSPEC, ai_socktype: SOCK_STREAM, ai_protocol: 0, ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
        var res: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, String(port), &hints, &res) == 0, let ai = res else { return false }
        defer { freeaddrinfo(res) }
        let fd = socket(ai.pointee.ai_family, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        if connect(fd, ai.pointee.ai_addr, ai.pointee.ai_addrlen) == 0 { return true }
        guard errno == EINPROGRESS else { return false }
        var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        guard poll(&pfd, 1, 1000) == 1 else { return false }
        var err: Int32 = 0
        var len = socklen_t(MemoryLayout<Int32>.size)
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len)
        return err == 0
    }

    /// The HTTP status of a GET (nil: no answer in 3 s).
    static func httpStatus(_ url: String) -> Int? {
        guard let u = URL(string: url) else { return nil }
        var code: Int?
        let done = DispatchSemaphore(value: 0)
        var r = URLRequest(url: u, timeoutInterval: 3)
        r.setValue("1", forHTTPHeaderField: "X-Ravenry")
        URLSession.shared.dataTask(with: r) { _, resp, _ in code = (resp as? HTTPURLResponse)?.statusCode; done.signal() }.resume()
        _ = done.wait(timeout: .now() + 3.5)
        return code
    }
}
