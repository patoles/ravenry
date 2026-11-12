// The self-test of Away from home in the phone card (scripts/sidetest.mjs
// --screen away; PHONE-011, PHONE-013 to PHONE-016): the board's device
// joins a tailnet of this Mac (daemon/tools/tailnetlab, Tailscale's test
// control server on 127.0.0.1, never a real one; its admin URL in
// RAVENRY_MAC_TAILNET_LAB). Every step is the card's own control pressed
// through the window, with its effect read where it lands: the hub's
// answer, the device on the tailnet (the lab's list), the keys folder in
// the board's data, a phone stand-in pairing over the tailnet with the
// code the card shows. The sign-in page goes to the stand-in opener
// (Outside.record), and the check opens it as the person's browser would.
// Each state leaves a picture of the window and of the card alone, to set
// beside the mockup's.

import AppKit

extension SelfTestBoard {
    /// One call to the lab's admin URL: its JSON answer (nil: none in 70 s).
    func labCall(_ lab: String, _ method: String, _ p: String, _ body: [String: Any]? = nil) -> Any? {
        guard let u = URL(string: lab + p) else { return nil }
        var r = URLRequest(url: u, timeoutInterval: 70)
        r.httpMethod = method
        if let b = body { r.httpBody = try? JSONSerialization.data(withJSONObject: b); r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        var out: Any?
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: r) { d, _, _ in out = d.flatMap { try? JSONSerialization.jsonObject(with: $0) }; done.signal() }.resume()
        // The main loop keeps turning (the card's own reads come back meanwhile).
        _ = wait(72) { done.wait(timeout: .now()) == .success }
        return out
    }

    /// The window's picture, then the card alone (cut from it, with a margin).
    func cardPictures(_ name: String, _ pc: PhoneCard) {
        size(1280, 820)
        for dark in [true, false] {
            NSApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            settle(0.4)
            board.render(force: true)
            settle(0.4)
            let file = "native-\(name)-1280-\(dark ? "dark" : "light").png"
            picture(file)
            let url = dir.appendingPathComponent(file)
            guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil), let root = pc.superview else { continue }
            let s: CGFloat = 2, m: CGFloat = 20
            let f = pc.frame
            let top = root.isFlipped ? f.minY : root.bounds.height - f.maxY
            let crop = CGRect(x: max(0, (f.minX - m) * s), y: max(0, (top - m) * s), width: (f.width + 2 * m) * s, height: (f.height + 2 * m) * s).intersection(CGRect(x: 0, y: 0, width: img.width, height: img.height))
            if let c = img.cropping(to: crop) {
                try? NSBitmapImageRep(cgImage: c).representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("native-\(name)-card-\(dark ? "dark" : "light").png"))
            }
        }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        settle(0.3)
    }

    /// A press and release in the middle of a button, as the window gets them (the release queued first, so its tracking ends).
    func pressButton(_ b: NSView) {
        window.contentView?.layoutSubtreeIfNeeded()
        click(b, at: NSPoint(x: b.bounds.midX, y: b.bounds.midY))
    }

    func screenAway() {
        let pc = board.phoneCard
        let step = { (s: String) in NSLog("self-test away: %@, state %@", s, (pc.data?["away"] as? [String: Any])?["state"] as? String ?? "-") }
        let env = ProcessInfo.processInfo.environment
        guard let lab = env["RAVENRY_MAC_TAILNET_LAB"], let home = env["RAVENRY_MAC_HUB_HOME"] else { check("away_lab", false, "no tailnet lab"); return }
        let keys = home + "/.ravenry/tailnet"
        let fm = FileManager.default
        let ravenryOnTailnet = { () -> Bool in ((self.labCall(lab, "GET", "/nodes") as? [[String: Any]]) ?? []).contains { $0["name"] as? String == "ravenry" } }
        let away = { () -> [String: Any] in pc.data?["away"] as? [String: Any] ?? [:] }
        let state = { () -> String in away()["state"] as? String ?? "" }
        let opened = { (since: Int) -> [String] in Array((Outside.record ?? []).dropFirst(since)).filter { $0.hasPrefix("open ") }.map { String($0.dropFirst(5)) } }
        // The phone card from the sidebar's foot, phone access on (sidetest.mjs seeds it).
        board.sidebar.footButtons["side.phone"]?.performClick(nil)
        settle(0.3)
        check("away_card_opens", wait(6) { pc.isOpen && pc.data?["away"] != nil && pc.toggle.on }, texts(pc).joined(separator: " | "))

        // 1 Off.
        step("1 Off.")
        check("away_off_drawn", wait(4) { self.shows(pc, t("phone.away.title")) && self.shows(pc, t("phone.away.off")) } && !pc.awayToggle.on && shows(pc, t("phone.whereHome")) && shows(pc, t("phone.footOnHome")) && !shows(pc, "ts.net"), texts(pc).joined(separator: " | "))
        let wifi = pc.data?["wifi"] as? String
        check("away_home_wifi_row", wifi == nil || (shows(pc, t("phone.addrHome")) && shows(pc, wifi!)), wifi ?? "no Wi-Fi")
        check("away_off_nothing_joined", !ravenryOnTailnet() && !fm.fileExists(atPath: keys))
        cardPictures("away-1-off", pc)

        // 2 Switched on: ready to sign in. Nothing joins yet.
        step("2 Switched on")
        var n = board.hub.sent.count
        click(pc.awayToggle, at: NSPoint(x: 30, y: 13))
        check("away_switch_on_posts", wait(4) { self.sentSince(n).contains("POST /api/phone/away") } && wait(6) { pc.awayToggle.on && pc.buttons["awaySignIn"] != nil && self.shows(pc, t("phone.away.about")) && self.shows(pc, t("phone.away.signInNote")) }, texts(pc).joined(separator: " | "))
        check("away_ready_nothing_joined", state() == "ready" && !ravenryOnTailnet() && !fm.fileExists(atPath: keys), state())
        cardPictures("away-2-ready", pc)

        // 3 Sign in with Tailscale: the hub's sign-in page goes to the browser (the stand-in opener); waiting.
        step("3 Sign in with Tailscale")
        var o = Outside.record?.count ?? 0
        n = board.hub.sent.count
        if let b = pc.buttons["awaySignIn"] { pressButton(b) }
        let page = { () -> String? in opened(o).first { $0.hasPrefix("http://127.0.0.1:") && $0.contains("/auth/") } }
        check("away_sign_in_opens_the_page", wait(20) { page() != nil } && sentSince(n).contains("POST /api/phone/away/signin"), (Outside.record ?? []).suffix(3).joined(separator: " | "))
        check("away_waiting_drawn", wait(4) { self.shows(pc, t("phone.away.waiting")) && pc.buttons["awayOpenAgain"] != nil && pc.buttons["awayCancel"] != nil } && state() == "waiting" && away()["authURL"] as? String == page(), texts(pc).joined(separator: " | "))
        let mode = ((try? fm.attributesOfItem(atPath: keys))?[.posixPermissions] as? NSNumber)?.intValue ?? 0
        check("away_keys_folder_0700", mode == 0o700, String(mode, radix: 8))
        cardPictures("away-3-waiting", pc)
        // Open the sign-in page again: the same page.
        step("Open the sign-in page again")
        o = Outside.record?.count ?? 0
        if let b = pc.buttons["awayOpenAgain"] { pressButton(b) }
        check("away_open_again", wait(2) { opened(o) == [page() ?? "-"] || opened(o).first == (away()["authURL"] as? String) }, opened(o).joined(separator: " | "))
        // Cancel: ready again, nothing kept.
        step("Cancel: ready again")
        n = board.hub.sent.count
        if let b = pc.buttons["awayCancel"] { pressButton(b) }
        check("away_cancel", wait(8) { self.sentSince(n).contains("POST /api/phone/away/cancel") && pc.buttons["awaySignIn"] != nil && state() == "ready" } && wait(4) { !fm.fileExists(atPath: keys) }, state())

        // Sign in again; the page opened in "the browser": on.
        step("Sign in again; the page")
        o = Outside.record?.count ?? 0
        if let b = pc.buttons["awaySignIn"] { pressButton(b) }
        _ = wait(20) { page() != nil }
        let browser = page().flatMap { Self.httpStatus($0) }
        check("away_page_opened_signs_in", browser == 200, "\(page() ?? "no page") \(browser.map(String.init) ?? "no answer")")
        check("away_on_drawn", wait(30) { state() == "on" && self.shows(pc, "ravenry.tail1234.ts.net") && self.shows(pc, t("phone.away.onlyYou")) && pc.buttons["awaySignOut"] != nil }, texts(pc).joined(separator: " | "))
        let acct = away()["account"] as? String ?? "-"
        check("away_on_words", shows(pc, t("phone.away.reachable", ["name": "ravenry", "account": acct])) && shows(pc, t("phone.addrAway")) && shows(pc, t("phone.addrNote")) && shows(pc, t("phone.whereAway")) && shows(pc, t("phone.footOnAway")), texts(pc).joined(separator: " | "))
        check("away_on_the_tailnet", ravenryOnTailnet() && fm.fileExists(atPath: keys + "/tailscaled.state"))
        // The pairing the card's QR carries: the Wi-Fi, then ravenry's name and address.
        let app = pc.data?["app"] as? [String: Any] ?? [:]
        let link = app["link"] as? String ?? ""
        let hosts = URLComponents(string: link.replacingOccurrences(of: "ravenry://", with: "https://"))?.queryItems?.first { $0.name == "hosts" }?.value?.split(separator: ",").map(String.init) ?? []
        let ip = (away()["ips"] as? [String])?.first ?? "-"
        let iName = hosts.firstIndex(of: "ravenry.tail1234.ts.net") ?? -1
        check("away_pairing_hosts", iName >= 0 && hosts.firstIndex(of: ip) == iName + 1 && (wifi == nil || hosts.first == wifi), hosts.joined(separator: ","))
        cardPictures("away-4-on", pc)
        // The owner's phone pairs over the tailnet with the code the card shows; another account's is closed.
        step("The owner's phone pairs")
        let port = app["port"] as? Int ?? (pc.data?["port"] as? Int ?? 0)
        let code = app["code"] as? String ?? ""
        let pair = labCall(lab, "POST", "/phone", ["name": "pixel", "kind": "owner", "addr": "\(ip):\(port)", "method": "POST", "path": "/api/phone/pair", "body": "{\"code\":\"\(code)\",\"name\":\"Pixel away\",\"platform\":\"android\"}"]) as? [String: Any] ?? [:]
        check("away_owner_phone_pairs", pair["status"] as? Int == 200 && (pair["body"] as? String ?? "").contains("\"token\""), "\(pair)".prefix(300).description)
        check("away_paired_phone_listed", wait(6) { ((pc.data?["devices"] as? [[String: Any]]) ?? []).contains { $0["name"] as? String == "Pixel away" } })
        let stranger = labCall(lab, "POST", "/phone", ["name": "stranger", "kind": "stranger", "addr": "\(ip):\(port)", "method": "GET", "path": "/api/phone/hello"]) as? [String: Any] ?? [:]
        check("away_stranger_closed", stranger["status"] as? Int == 0 && stranger["error"] != nil, "\(stranger)")

        // Sign out: off the tailnet, the keys and the switch gone.
        step("Sign out: off the tailnet")
        n = board.hub.sent.count
        if let b = pc.buttons["awaySignOut"] { pressButton(b) }
        check("away_sign_out", wait(30) { self.sentSince(n).contains("POST /api/phone/away/signout") && state() == "off" && !pc.awayToggle.on && self.shows(pc, t("phone.away.off")) } && !fm.fileExists(atPath: keys), state())
        let after = labCall(lab, "POST", "/phone", ["name": "pixel", "addr": "\(ip):\(port)", "method": "GET", "path": "/api/phone/hello"]) as? [String: Any] ?? [:]
        check("away_signed_out_nothing_answers", after["status"] as? Int == 0, "\(after)")

        // 5 A sign-in left unfinished (the board waits 6 s here): failed, nothing changed; Try again.
        step("5 A sign-in left")
        click(pc.awayToggle, at: NSPoint(x: 30, y: 13))
        _ = wait(6) { pc.buttons["awaySignIn"] != nil }
        o = Outside.record?.count ?? 0
        if let b = pc.buttons["awaySignIn"] { pressButton(b) }
        _ = wait(20) { page() != nil }
        check("away_failed_drawn", wait(25) { state() == "failed" && self.shows(pc, t("phone.away.failed")) && pc.buttons["awayTryAgain"] != nil } && !fm.fileExists(atPath: keys), texts(pc).joined(separator: " | "))
        cardPictures("away-5-failed", pc)
        o = Outside.record?.count ?? 0
        if let b = pc.buttons["awayTryAgain"] { pressButton(b) }
        check("away_try_again_opens_the_page", wait(20) { page() != nil })
        _ = page().flatMap { Self.httpStatus($0) }
        check("away_try_again_on", wait(30) { state() == "on" })

        // 6 No internet: the lab's servers go; offline, the name kept.
        step("6 No internet")
        _ = labCall(lab, "POST", "/down")
        check("away_offline_drawn", wait(75) { state() == "offline" && self.shows(pc, t("phone.away.offline")) && self.shows(pc, t("phone.away.offlineNote")) && self.shows(pc, "ravenry.tail1234.ts.net") }, texts(pc).joined(separator: " | "))
        cardPictures("away-6-offline", pc)
        pc.close()
    }
}
