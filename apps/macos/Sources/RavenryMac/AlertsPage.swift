// Alerts (ALERT rows), as the Electron app draws them (inapp.ts
// alertsPage(); app.css .ia-al, .ia-setup, .ia-sw, .ia-qr): GET
// /api/alerts/setup, read again every 2 s while it shows.
//
// - Mac notifications: what macOS did with the last one and never more
//   (shown, sent but unconfirmed through macOS's script, not shown and
//   why, not allowed with Open Notifications settings), Send a test, and
//   the switch.
// - Your phone: Pair your phone.
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

    func show() {
        open = nil
        dirty()
        load()
        poll(2)
        redraw()
    }

    override func load() {
        hub?.get("/api/alerts/setup") { [weak self] code, j in
            guard let self else { return }
            if code == 200 { self.setup = j }
            self.redraw()
        }
    }

    /// The self-test's: a setup as the hub sends it, kept (no reading again).
    func apply(_ j: [String: Any]) { poll(nil); setup = j; dirty(); redraw() }

    override func cancelOperation(_ sender: Any?) { if open != nil { open = nil; redraw() } }
    override func keyDown(with e: NSEvent) { if e.keyCode == 53, open != nil { open = nil; redraw() } else { super.keyDown(with: e) } }

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
        let sig = "\(busy)|\(open ?? "-")|\(stableText(a).hashValue)"
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
        let pair = RButton(t("alerts.pair"), .primary) { [weak self] in self?.pairPhone?() }
        buttons["pair"] = pair
        out.append(card([alRow(t("alerts.phone"), t("alerts.phoneLine"), on: false, [pair])]))

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
