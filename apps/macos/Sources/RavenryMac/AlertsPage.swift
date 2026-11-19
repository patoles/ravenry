// Alerts (ALERT rows), as the Electron app draws them (inapp.ts
// alertsPage(); app.css .ia-al, .ia-setup, .ia-sw, .ia-qr): GET
// /api/alerts/setup, read again every 2 s while it shows.
//
// - Mac notifications: what macOS did with the last one and never more
//   (shown, sent but unconfirmed through macOS's script, not shown and
//   why, not allowed with Open Notifications settings), Send a test, and
//   the switch.
// - Phones (docs/PHONE.md section 4): each phone that gets alerts, with how
//   (an Android phone through the Ravenry app, an iPhone through ntfy) and
//   its last one, Send a test, Remove for an iPhone; Pair an Android phone
//   (the phone card) and Add an iPhone, whose setup opens under the list:
//   the steps, what the iPhone gets, the QR (the board's Safari sign-in
//   link + #iphone, only while phone access is on) and Copy the code
//   instead (then Send a test and It arrived from here).
// - Telegram, a Discord or Slack webhook, ntfy: each's state, Send a test,
//   Turn off or Use it, and its setup opened under it (the token and Find
//   the chat, the address, the QR code with Copy the link and New topic,
//   and a server of your own in place of ntfy.sh).
//   Escape closes the setup.

import AppKit

final class AlertsPage: FormPage {
    var pairPhone: (() -> Void)?
    /// GET /api/alerts/setup, nil until read.
    private(set) var setup: [String: Any]?
    /// The channel whose setup is open.
    private(set) var open: String?
    private(set) var switches: [String: Switch] = [:]
    private var qr: (String, NSImage?)?
    /// Add an iPhone's setup is open under the Phones card.
    private(set) var iphoneOpen = false
    /// The iPhones through ntfy when the setup opened: one more (It arrived, on the iPhone) closes it.
    private var iphonesAtOpen = 0
    private var iqr: (String, NSImage?)?

    func show() {
        open = nil
        iphoneOpen = false
        dirty()
        load()
        poll(2)
        redraw()
    }

    override func load() {
        hub?.get("/api/alerts/setup") { [weak self] code, j in
            guard let self else { return }
            if code == 200 { self.setup = j; self.iphoneJoined() }
            self.redraw()
        }
    }

    /// The self-test's: a setup as the hub sends it, kept (no reading again).
    func apply(_ j: [String: Any]) { poll(nil); setup = j; dirty(); redraw() }

    override func cancelOperation(_ sender: Any?) { closeSetups() }
    override func keyDown(with e: NSEvent) { if e.keyCode == 53, open != nil || iphoneOpen { closeSetups() } else { super.keyDown(with: e) } }
    private func closeSetups() { guard open != nil || iphoneOpen else { return }; open = nil; iphoneOpen = false; redraw() }

    private func ntfyPhones(_ a: [String: Any]?) -> Int { (a?["phones"] as? [[String: Any]] ?? []).filter { $0["transport"] as? String == "ntfy" }.count }
    /// An iPhone confirmed while its setup shows (It arrived, on the iPhone or here): the setup closes, the row is there.
    private func iphoneJoined() {
        guard iphoneOpen, ntfyPhones(setup) > iphonesAtOpen else { return }
        iphoneOpen = false
        toast?(t("alerts.iphoneAdded"))
    }

    private func post(_ p: String, _ body: [String: Any] = [:], done: (([String: Any]) -> Void)? = nil) {
        act(p, "/api/alerts/\(p)", body, done: done)
    }

    /// .ia-al: a title and its line, then its buttons.
    private func alRow(_ title: String, _ line: String, on: Bool, _ acts: [NSView?]) -> NSView {
        let ln = CappedText(line, Fonts.pt(12), on ? "ok" : "tx3", maxW: 10000)
        ln.setContentHuggingPriority(.init(1), for: .horizontal)
        ln.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        let tx = vstack([label(title, Fonts.pt(13, .semibold)), ln], spacing: 2)
        tx.setContentHuggingPriority(.init(1), for: .horizontal)
        tx.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        return hstack([tx, spring()] + acts, spacing: 12)
    }
    private func card(_ inner: [NSView]) -> Box {
        boxed(vstack(inner, spacing: 10), fill: "card", radius: 10, insets: NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14))
    }

    override func redraw() {
        setHead(title: t("alerts.title"), src: t("alerts.src"))
        guard let a = setup else { draw("reading") { [wrap(t("alerts.reading"), Fonts.pt(13), "tx3")] }; return }
        let sig = "\(busy)|\(open ?? "-")|\(iphoneOpen)|\(stableText(a).hashValue)"
        draw(sig) { self.rows(a) }
    }

    private func rows(_ a: [String: Any]) -> [NSView] {
        let dk = a["desktop"] as? [String: Any] ?? [:]
        let dkOn = dk["enabled"] as? Bool ?? true
        let dl = dk["last"] as? [String: Any]
        let dlOk = dl?["ok"] as? Bool ?? false
        let denied = dkOn && dl != nil && !dlOk && (dl?["denied"] as? Bool ?? false)
        let when = When.day(dl?["at"] as? String) ?? ""
        let line = !dkOn ? t("alerts.off") : dl == nil ? t("alerts.on") : denied ? t("alerts.denied")
            : dlOk ? ((dl?["unconfirmed"] as? Bool ?? false) ? t("alerts.unconfirmed", ["when": when]) : t("alerts.lastShown", ["when": when]))
            : t("alerts.notShown", ["error": (dl?["error"] as? String) ?? t("alerts.noAnswer")])
        var settingsB: RButton? = nil
        if denied { settingsB = RButton(t("alerts.openSettings"), .primary) { Outside.settings("x-apple.systempreferences:com.apple.Notifications-Settings.extension") } }
        buttons["settings"] = settingsB
        let test = RButton(t("alerts.sendTest")) { [weak self] in
            self?.post("desktop/test") { b in self?.toast?((b["unconfirmed"] as? Bool ?? false) ? t("alerts.testUnconfirmed") : t("alerts.testShown")) }
        }
        test.isEnabled = busy.isEmpty && dkOn
        buttons["desktopTest"] = test
        let sw = Switch(dkOn, label: t("alerts.mac")) { [weak self] in self?.post("desktop", ["enabled": !dkOn]) }
        sw.enabled = busy.isEmpty
        switches["desktop"] = sw
        var out: [NSView] = [card([alRow(t("alerts.mac"), line, on: dkOn && !denied, [settingsB, test, sw])])]
        out.append(phonesCard(a))

        let tg = a["telegram"] as? [String: Any] ?? [:], wh = a["webhook"] as? [String: Any] ?? [:], nt = a["ntfy"] as? [String: Any] ?? [:]
        let bot = (tg["bot"] as? String).map { "@" + $0 }
        out.append(channel(a, "telegram", t("alerts.telegram")) {
            var v: [NSView?] = []
            if let tok = tg["token"] as? String {
                v.append(wrap(t("alerts.tgNow", ["bot": bot ?? tok, "chat": (tg["chat"] as? String).map { t("alerts.tgChat", ["chat": $0]) } ?? ""]), Fonts.pt(12), "tx2"))
            } else { v.append(wrap(t("alerts.tgHow"), Fonts.pt(12), "tx2")) }
            v.append(self.saveRow("tg", t("alerts.tgToken"), t("alerts.tgPasteFirst")) { self.post("telegram", ["token": $0]) { _ in self.clear("tg") } })
            if tg["token"] is String {
                let find = RButton(t("alerts.findChat")) { [weak self] in self?.post("telegram/find-chat") }
                find.isEnabled = self.busy.isEmpty
                self.buttons["findChat"] = find
                v.append(acts([label(t("alerts.tgThen", ["bot": bot ?? t("alerts.tgTheBot")]), Fonts.pt(12), "tx2"), find]))
            }
            return v.compactMap { $0 }
        })
        out.append(channel(a, "webhook", t("alerts.webhook")) {
            [wrap((wh["url"] as? String).map { t("alerts.whNow", ["url": $0]) } ?? t("alerts.whHow"), Fonts.pt(12), "tx2"),
             self.saveRow("wh", t("alerts.whAddress"), t("alerts.whPasteFirst")) { self.post("webhook", ["url": $0]) { _ in self.clear("wh") } }]
        })
        out.append(channel(a, "ntfy", t("alerts.ntfy")) {
            var v: [NSView] = [wrap(t("alerts.ntfyHow", ["topic": (nt["topic"] as? String).map { " (\($0))" } ?? "", "server": nt["server"] as? String ?? "ntfy.sh"]), Fonts.pt(12), "tx2")]
            if let svg = nt["qr"] as? String {
                if self.qr?.0 != svg { self.qr = (svg, NSImage(data: Data(svg.utf8))) }
                let iv = NSImageView()
                iv.image = self.qr?.1
                iv.imageScaling = .scaleProportionallyUpOrDown
                iv.setAccessibilityLabel(t("alerts.ntfyQr"))
                let b = boxed(iv, fill: nil, radius: 8, insets: NSEdgeInsets(top: 6, left: 6, bottom: 6, right: 6))
                b.rawFill = .white
                b.widthAnchor.constraint(equalToConstant: 156).isActive = true
                b.heightAnchor.constraint(equalToConstant: 156).isActive = true
                v.append(hstack([b, spring()], spacing: 0))
            }
            let copy = RButton(t("alerts.copyLink")) { [weak self] in self?.post("ntfy/copy") { _ in self?.toast?(t("alerts.copied")) } }
            let topic = RButton(t("alerts.newTopic")) { [weak self] in self?.post("ntfy/new-topic") { _ in self?.toast?(t("alerts.newTopicDone")) } }
            copy.isEnabled = self.busy.isEmpty; topic.isEnabled = self.busy.isEmpty
            self.buttons["copyLink"] = copy; self.buttons["newTopic"] = topic
            v.append(acts([copy, topic]))
            // A server of your own (ALERT-014): POST /api/alerts/ntfy, then the code subscribes there.
            v.append(self.saveRow("nt", t("alerts.ntfyServer"), t("alerts.ntfyServerFirst")) { typed in
                self.post("ntfy", ["server": typed]) { _ in
                    self.clear("nt")
                    self.toast?(t("alerts.ntfyServerSaved", ["server": typed.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "/+$", with: "", options: .regularExpression)]))
                }
            })
            return v
        })
        out.append(wrap(t("alerts.oneWay"), Fonts.pt(12), "tx3"))
        return out
    }

    // MARK: Phones

    /// The Phones card: one row per phone with how it gets alerts, then
    /// Pair an Android phone and Add an iPhone, and that setup when open.
    private func phonesCard(_ a: [String: Any]) -> NSView {
        // A hub before `phones`: its apps' names, each through the Ravenry app.
        let list = a["phones"] as? [[String: Any]] ?? (a["apps"] as? [String] ?? []).map { ["name": $0, "transport": "app"] }
        let head = vstack([label(t("alerts.phones"), Fonts.pt(13, .semibold)), wrap(list.isEmpty ? t("alerts.phoneLine") : t("alerts.phonesLine"), Fonts.pt(12), "tx3")], spacing: 2)
        var inner: [NSView] = [head]
        for p in list { inner.append(hline()); inner.append(phoneRow(p)) }
        let pair = RButton(t("alerts.pairAndroid"), list.isEmpty ? .primary : .normal) { [weak self] in self?.pairPhone?() }
        buttons["pair"] = pair
        let add = RButton(iphoneOpen ? t("alerts.close") : t("alerts.addIphone")) { [weak self] in
            guard let self else { return }
            self.iphoneOpen.toggle()
            self.iphonesAtOpen = self.ntfyPhones(self.setup)
            self.redraw()
        }
        add.setAccessibilityExpanded(iphoneOpen)
        buttons["addIphone"] = add
        inner.append(acts([pair, add]))
        if iphoneOpen { inner.append(hline()); inner.append(iphoneSetup(a)) }
        return card(inner)
    }

    /// A phone: its icon, its name and how it gets alerts, what it got last, Send a test, Remove for an iPhone through ntfy.
    /// The iPhone app (docs/PHONE.md section 4): "Moved from ntfy" after the takeover, until an alert went; when Apple
    /// says the app is gone, no alerts, with Use ntfy again (its old topic) and Remove (signs it out).
    private func phoneRow(_ p: [String: Any]) -> NSView {
        let id = p["id"] as? String ?? ""
        let name = p["name"] as? String ?? ""
        let ntfy = p["transport"] as? String == "ntfy"
        let last = p["last"] as? [String: Any]
        let gone = p["gone"] as? String
        let moved = p["moved"] as? String
        let failed = gone != nil || (last != nil && !(last?["ok"] as? Bool ?? true))
        let when = When.day(last?["at"] as? String)
        // Moved from ntfy, until an alert went after it: then the last one, as every phone.
        let movedWhen = moved.flatMap { m in (last?["at"] as? String).map { $0 <= m } ?? true ? When.day(m) : nil }
        let device = p["form"] as? String == "ipad" ? "iPad" : "iPhone"
        let line = gone != nil ? t("alerts.appGone", ["device": device])
            : failed ? t("alerts.phoneFailed", ["error": last?["error"] as? String ?? t("alerts.noAnswer")])
            : ntfy ? (when.map { t("alerts.getsNtfyLast", ["when": $0]) } ?? t("alerts.getsNtfy"))
            : movedWhen.map { t("alerts.movedFromNtfy", ["when": $0]) }
            ?? (when.map { t("alerts.getsLast", ["when": $0]) } ?? t("alerts.gets"))
        let iphone = ntfy || p["platform"] as? String == "ios"
        // The iOS app on an iPad draws an iPad (the hub's `form`), never an iPhone.
        let ipad = p["form"] as? String == "ipad"
        let glyph = symbol(ipad ? "ipad" : iphone || NSImage(systemSymbolName: "smartphone", accessibilityDescription: nil) == nil ? "iphone" : "smartphone", "tx2", 13)
        let icon = boxed(glyph, fill: "card2", radius: 8, insets: NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0))
        icon.widthAnchor.constraint(equalToConstant: 30).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 30).isActive = true
        let title = hstack([label(name, Fonts.pt(13, .semibold)), label("· " + t(ntfy ? "alerts.viaNtfy" : "alerts.viaApp"), Fonts.pt(13), "tx2")], spacing: 4)
        let ln = CappedText(line, Fonts.pt(12), failed ? "bad" : "ok", maxW: 10000)
        ln.setContentHuggingPriority(.init(1), for: .horizontal)
        ln.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        let tx = vstack([title, ln], spacing: 2)
        tx.setContentHuggingPriority(.init(1), for: .horizontal)
        tx.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        var test: RButton? = nil, remove: RButton? = nil
        if !id.isEmpty, gone != nil {
            // Apple says the app is gone: nothing to test; its old ntfy topic back, or Remove (signs it out).
            if p["ntfyBack"] as? Bool == true {
                test = RButton(t("alerts.ntfyAgain")) { [weak self] in self?.post("phone/ntfy-again", ["id": id]) { _ in self?.toast?(t("alerts.ntfyAgainDone", ["name": name])) } }
                test?.isEnabled = busy.isEmpty
                buttons["ntfyAgain-\(id)"] = test
            }
            remove = RButton(t("alerts.remove")) { [weak self] in self?.act("remove-\(id)", "/api/phone/devices/revoke", ["id": id]) { _ in self?.toast?(t("alerts.removedApp", ["name": name])) } }
            remove?.isEnabled = busy.isEmpty
            buttons["remove-\(id)"] = remove
        } else if !id.isEmpty {
            test = RButton(t("alerts.sendTest")) { [weak self] in self?.post("phone/test", ["id": id]) { _ in self?.toast?(t("alerts.phoneTestSent", ["name": name])) } }
            test?.isEnabled = busy.isEmpty
            buttons["phoneTest-\(id)"] = test
            if ntfy {
                remove = RButton(t("alerts.remove")) { [weak self] in self?.post("iphone/remove", ["id": id]) { _ in self?.toast?(t("alerts.removed", ["name": name])) } }
                remove?.isEnabled = busy.isEmpty
                buttons["remove-\(id)"] = remove
            }
        }
        let row = hstack([icon, tx, spring(), test, remove], spacing: 12)
        row.alignment = .centerY
        return row
    }

    /// Add an iPhone: the steps and what the iPhone gets, beside the code to scan and Copy the code instead.
    private func iphoneSetup(_ a: [String: Any]) -> NSView {
        let ip = a["iphone"] as? [String: Any] ?? [:]
        let server = (ip["server"] as? String ?? "https://ntfy.sh").replacingOccurrences(of: "^https?://", with: "", options: .regularExpression)
        func step(_ n: Int, _ md: String) -> NSView {
            let k = boxed(label("\(n)", Fonts.pt(11.5, .semibold), "work"), fill: "work-t", radius: 10, insets: NSEdgeInsets(top: 2, left: 6.5, bottom: 2, right: 6.5))
            k.widthAnchor.constraint(equalToConstant: 20).isActive = true
            k.heightAnchor.constraint(equalToConstant: 20).isActive = true
            let w = wrap(md: md, Fonts.pt(12.5))
            w.setContentHuggingPriority(.init(1), for: .horizontal)
            w.setContentCompressionResistancePriority(.init(1), for: .horizontal)
            let h = hstack([k, w], spacing: 10)
            h.alignment = .top
            return h
        }
        let privacy = boxed(wrap(md: t("alerts.iphonePrivacy", ["server": server]), Fonts.pt(12), "tx2"), fill: "card2", radius: 8, insets: NSEdgeInsets(top: 10, left: 12, bottom: 10, right: 12))
        let left = vstack([label(t("alerts.iphoneTitle"), Fonts.pt(14, .semibold)), wrap(t("alerts.iphoneWhy"), Fonts.pt(12.5), "tx2"),
                           step(1, t("alerts.iphoneStep1")), step(2, t("alerts.iphoneStep2")), step(3, t("alerts.iphoneStep3")), privacy], spacing: 10)
        left.alignment = .leading
        left.setContentHuggingPriority(.init(1), for: .horizontal)
        left.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        for v in left.arrangedSubviews.dropFirst() { v.widthAnchor.constraint(equalTo: left.widthAnchor).isActive = true }
        // The code to scan, only while phone access is on; else the words why, in its place.
        let tile: Box
        if let svg = ip["qr"] as? String {
            if iqr?.0 != svg { iqr = (svg, NSImage(data: Data(svg.utf8))) }
            let iv = NSImageView()
            iv.image = iqr?.1
            iv.imageScaling = .scaleProportionallyUpOrDown
            iv.setAccessibilityLabel(t("alerts.iphoneQr"))
            tile = boxed(iv, fill: nil, radius: 8, insets: NSEdgeInsets(top: 6, left: 6, bottom: 6, right: 6))
            tile.rawFill = .white
        } else {
            let why = wrap(t(ip["access"] as? Bool == true ? "alerts.iphoneNoWifi" : "alerts.iphoneAccessOff"), Fonts.pt(12), "tx2")
            tile = boxed(vstack([spring(), why, spring()], spacing: 0), fill: "card2", radius: 8, insets: NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12))
        }
        tile.widthAnchor.constraint(equalToConstant: 168).isActive = true
        tile.heightAnchor.constraint(equalToConstant: 168).isActive = true
        let copy = RButton(t("alerts.iphoneCopy"), .link) { [weak self] in self?.post("iphone/copy") { _ in self?.toast?(t("alerts.iphoneCopied")) } }
        copy.isEnabled = busy.isEmpty
        buttons["iphoneCopy"] = copy
        var right: [NSView] = [tile, centered(t("alerts.iphoneQrCap")), copy, centered(t("alerts.iphoneCopyCap"))]
        // This Mac's code, copied and not confirmed yet: Send a test and It arrived from here.
        if let pid = (ip["pending"] as? [String: Any])?["id"] as? String {
            let test = RButton(t("alerts.sendTest"), small: true) { [weak self] in self?.post("iphone/test", ["id": pid]) { _ in self?.toast?(t("alerts.iphoneTestSent")) } }
            let arrived = RButton(t("alerts.iphoneArrived"), small: true) { [weak self] in self?.post("iphone/confirm", ["id": pid]) }
            test.isEnabled = busy.isEmpty; arrived.isEnabled = busy.isEmpty
            buttons["iphoneTest"] = test; buttons["iphoneArrived"] = arrived
            right.append(centered(t("alerts.iphoneThen")))
            right.append(hstack([spring(), test, arrived, spring()], spacing: 6))
        } else { buttons["iphoneTest"] = nil; buttons["iphoneArrived"] = nil }
        let col = vstack(right, spacing: 6)
        col.alignment = .centerX
        col.widthAnchor.constraint(equalToConstant: 180).isActive = true
        for v in right.dropFirst() where !(v is RButton) { v.widthAnchor.constraint(equalTo: col.widthAnchor).isActive = true }
        let h = hstack([left, col], spacing: 22)
        h.alignment = .top
        return h
    }

    private func centered(_ s: String) -> NSView {
        let w = wrap(s, Fonts.pt(11.5), "tx3")
        w.text.alignment = .center
        return w
    }

    /// A field and Save (.ia-reply): an empty field says what goes in it.
    private func saveRow(_ id: String, _ ph: String, _ needWords: String, save: @escaping (String) -> Void) -> NSView {
        let f = field(id, ph)
        let b = RButton(t("alerts.save")) { [weak self] in
            guard let self else { return }
            if self.need(id, needWords) { return }
            save(self.typed(id))
        }
        b.isEnabled = busy.isEmpty
        f.onReturn = { b.performClick(nil) }
        buttons["save-\(id)"] = b
        return hstack([f, b], spacing: 10)
    }

    /// A channel's row, and its setup under it when open.
    private func channel(_ a: [String: Any], _ id: String, _ title: String, form: () -> [NSView]) -> NSView {
        let ready = (a["ready"] as? [String: Any])?[id] as? Bool ?? false
        let active = a["channel"] as? String == id && (a["enabled"] as? Bool ?? false)
        let last = a["last"] as? [String: Any]
        let line = active ? (last != nil && !(last?["ok"] as? Bool ?? true) ? t("alerts.chFailed", ["error": last?["error"] as? String ?? t("alerts.noAnswer")])
                             : (a["channelLabel"] as? String).map { t("alerts.chOnLabel", ["label": $0]) } ?? t("alerts.on"))
            : ready ? t("alerts.chReady") : t("alerts.off")
        var test: RButton? = nil, use: RButton? = nil
        if active {
            test = RButton(t("alerts.sendTest")) { [weak self] in self?.post("test", ["channel": id]) { _ in self?.toast?(t("alerts.testSent")) } }
            use = RButton(t("alerts.turnOff")) { [weak self] in self?.post("switch", ["enabled": false]) }
        } else if ready {
            use = RButton(t("alerts.useIt"), .primary) { [weak self] in self?.post("done", ["channel": id, "enable": true]) }
        }
        test?.isEnabled = busy.isEmpty; use?.isEnabled = busy.isEmpty
        let opened = open == id
        let toggle = RButton(opened ? t("alerts.close") : ready ? t("alerts.change") : t("alerts.setUp")) { [weak self] in
            guard let self else { return }
            self.open = opened ? nil : id
            self.redraw()
        }
        toggle.setAccessibilityExpanded(opened)
        buttons["\(id)-test"] = test; buttons["\(id)-use"] = use; buttons["\(id)-toggle"] = toggle
        return card([alRow(title, line, on: active, [test, use, toggle])] + (opened ? form() : []))
    }
}
