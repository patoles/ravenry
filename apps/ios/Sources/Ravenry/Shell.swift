// What the shell adds around the board: the connection watch for the top
// bar's chip, the private keyboard for a secret, and the alerts while the
// app is open (docs/PHONE.md sections 1, 5 and 7; the Android app's
// ConnWatch, SecretField and Notifier).

import UIKit
import UserNotifications

/// Whether the phone reaches the Mac and how (docs/PHONE.md, The
/// connection): the path in use (Reach.via), up, reconnecting (the stream
/// or a check failed, fewer than three times in a row) or offline (three:
/// with the reason words and the bar), since when it is up, and a measured
/// round trip (GET /api/phone/hello, every 30 s while up, every 3 s while not).
final class ConnWatch {
    private weak var board: BoardController?
    private(set) var state = "reconnecting"
    private var via = "wifi"
    private var since: Date?
    private var rtt: Int?
    private var fails = 0
    private var probing = false
    private var stopped = true
    private var timer: Timer?
    /// The check now running: a newer one takes over from one that has not answered in 12 s.
    private var checkN = 0

    init(board: BoardController) { self.board = board }

    func json() -> [String: Any] {
        let r = board?.lastReach
        return ["state": state, "via": via, "since": since.map { Int($0.timeIntervalSince1970 * 1000) } ?? NSNull(), "rtt": rtt ?? NSNull(),
                "reason": state == "offline" ? (r?["reason"] ?? NSNull()) : NSNull(), "words": state == "offline" ? (r?["words"] ?? NSNull()) : NSNull(),
                "mac": Store.shared.paired().map { MacName.say($0.hubName) } ?? NSNull()]
    }

    private func emit() { var o = json(); o["event"] = "conn"; board?.event(o) }

    private func set(_ s: String) {
        if s == "up" && state != "up" { since = Date() }
        if s != "up" { since = nil }
        let changed = s != state
        state = s
        if changed || s == "up" { emit() }
        if changed { Log.say("connection: \(s)\(s == "up" ? " (\(via))" : "")") }
    }

    /// `fresh`: back from the background, no check of before counts (one iOS froze may never answer).
    func start(fresh: Bool = false) {
        stopped = false
        if fresh { probing = false; checkN += 1; fails = 0 }
        Net.onChange = { [weak self] in Hub.client()?.networkChanged(); self?.schedule(0.5) }
        schedule(0)
    }

    func stop() { stopped = true; Net.onChange = nil; timer?.invalidate(); timer = nil }

    private func schedule(_ s: TimeInterval) {
        timer?.invalidate()
        guard !stopped else { return }
        timer = Timer.scheduledTimer(withTimeInterval: s, repeats: false) { [weak self] _ in self?.probe() }
    }

    func linkUp() {
        fails = 0
        if let c = Hub.client() { via = Reach.via(c.host, c.allHosts) }
        if state != "up" { set("up"); board?.ink?.answered(); probe() }
    }

    func linkDown() {
        if state == "up" { set("reconnecting") }
        schedule(3)
    }

    func reconnect() {
        fails = 0
        board?.clearReach()
        Hub.reset()
        set("reconnecting")
        board?.restartEventsIfWanted()
        probe()
    }

    /// The hub answered something: when the watch did not think it up, it checks now.
    func heard() { if state != "up" && !stopped { probe() } }

    /// A request failed: check now whether the Mac still answers.
    func suspect() { if !stopped { schedule(0) } }

    private func probe() {
        guard !probing, !stopped else { return }
        probing = true
        checkN += 1
        let n = checkN
        // A check that never answers (its connection frozen with the app) counts as
        // failed after 12 s by the wall clock, and the next one goes: the chip
        // never stays on reconnecting with nothing tried.
        DispatchQueue.main.asyncAfter(wallDeadline: .now() + 12) { [weak self] in
            guard let self, n == self.checkN, self.probing else { return }
            Log.say("connection: a check had no answer in 12 s; checking again")
            self.probing = false
            self.checkN += 1
            self.fails += 1
            if self.state == "up" { self.set("reconnecting") }
            self.schedule(0)
        }
        Task { @MainActor in
            let c = Hub.client()
            var result: Result<(host: String, ms: Int), Error>
            do {
                guard let c else { throw HubFailure(hosts: [], underlying: "not paired") }
                result = .success(try await c.probe())
            } catch { result = .failure(error) }
            guard n == checkN else { return }
            probing = false
            switch result {
            case .success(let r):
                rtt = r.ms; fails = 0
                let was = via
                via = Reach.via(r.host, c!.allHosts)
                board?.answered()
                // The path changed (the Wi-Fi again, or away): the stream follows it now.
                if state == "up" && was != via { board?.restartEventsIfWanted() }
                if state != "up" { set("up"); board?.ink?.answered(); board?.restartEventsIfWanted() } else { emit() }
                schedule(30)
            case .failure(let e):
                fails += 1
                if fails >= 3, let c {
                    board?.reachOf(e as? HubFailure, hosts: c.allHosts)
                    set("offline")
                    if var r = board?.lastReach { r["event"] = "reach"; board?.event(r); board?.ink?.unreached(r["words"] as? String ?? "") }
                } else if state != "offline" { set("reconnecting") }
                schedule(3)
            }
        }
    }
}

/// The private keyboard (docs/PHONE.md section 7): a secure UITextField laid
/// over the secret card's field. No suggestions, no autocorrection, nothing
/// learned. The page never sees what is typed, only how many characters;
/// Send answers the checkpoint from here and forgets the text.
final class SecretField: NSObject, UITextFieldDelegate {
    weak var board: BoardController?
    private var field: UITextField?
    private(set) var checkpoint: String?
    private var rect: [String: Any] = [:]

    func open(checkpoint cp: String, rect r: [String: Any], dark: Bool, size: Double) {
        close()
        guard let b = board else { return }
        checkpoint = cp
        let f = UITextField()
        f.isSecureTextEntry = true
        f.autocorrectionType = .no
        f.spellCheckingType = .no
        f.autocapitalizationType = .none
        f.smartQuotesType = .no
        f.smartDashesType = .no
        f.smartInsertDeleteType = .no
        f.inlinePredictionType = .no
        // Not a password to save or fill: no Passwords bar over the keyboard (as round 1 drew it).
        f.textContentType = .oneTimeCode
        f.backgroundColor = .clear
        f.borderStyle = .none
        f.font = .monospacedSystemFont(ofSize: CGFloat(size), weight: .regular)
        f.textColor = Shared.color("tx", dark: dark)
        f.tintColor = Shared.color("work", dark: dark)
        f.returnKeyType = .send
        f.accessibilityLabel = "Secret"
        f.accessibilityIdentifier = "secret-field"
        f.delegate = self
        f.addTarget(self, action: #selector(changed), for: .editingChanged)
        b.view.addSubview(f)
        field = f
        move(r)
        f.becomeFirstResponder()
        Log.say("secret: the private field is open")
    }

    /// `rect` is x, y, width, height in CSS px from the page's top left.
    func move(_ r: [String: Any]) {
        rect = r
        guard let f = field, let w = board?.web else { return }
        func n(_ k: String, _ alt: String, _ d: Double) -> CGFloat { CGFloat(r[k] as? Double ?? r[alt] as? Double ?? d) }
        f.frame = CGRect(x: w.frame.minX + n("x", "left", 0), y: w.frame.minY + n("y", "top", 0), width: n("w", "width", 200), height: n("h", "height", 44))
    }

    func relayout() { move(rect) }

    func reveal(_ on: Bool) {
        guard let f = field else { return }
        f.isSecureTextEntry = !on
    }

    @objc private func changed() { board?.event(["event": "secret.count", "n": field?.text?.count ?? 0]) }

    func textFieldShouldReturn(_ t: UITextField) -> Bool { send(nil); return false }

    /// The shell answers the checkpoint itself; the page learns only whether it went.
    func send(_ id: Int?) {
        guard let b = board, let cp = checkpoint, let f = field else { if let id { board?.fail(id, "No secret is open.") }; return }
        let s = f.text ?? ""
        f.text = ""
        changed()
        if s.count < 4 {
            let err = "A secret has at least 4 characters."
            if let id { b.fail(id, err) } else { b.event(["event": "secret.done", "ok": false, "error": err]) }
            return
        }
        Task { @MainActor in
            var err: String?
            do {
                guard let c = Hub.client() else { throw HubFailure(hosts: []) }
                let r = try await c.call("POST", "/api/checkpoints/answer", json: ["id": cp, "secret": s, "by": "phone"])
                if r.status != 200 { err = (r.json?["error"] as? String) ?? "It was not sent." }
            } catch { err = b.unreachable(error) }
            Log.say("secret: \(err == nil ? "sent to the Mac" : "not sent")")
            if err == nil { close() }
            if let id { if err == nil { b.reply(id, ["ok": true]) } else { b.fail(id, err!) } }
            b.event(["event": "secret.done", "ok": err == nil, "error": err ?? NSNull()])
        }
    }

    func close() {
        guard let f = field else { return }
        f.text = ""
        f.resignFirstResponder()
        f.removeFromSuperview()
        field = nil
        checkpoint = nil
    }
}

/// The alerts (docs/PHONE.md section 5): the hub's messages on the live
/// stream while the app is open, drawn by iOS once each, and the alerts
/// through APNs while it is closed (Push.swift, drawn by the Notification
/// Service Extension); both with the same words and buttons
/// (Sources/Shared/AlertContent.swift). A close takes one off, whichever
/// way it came. A button answers the Mac as Android's does; Run, Allow once
/// and This session open the app and ask for Face ID first.
final class AlertCenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = AlertCenter()
    private(set) var allowed = false
    weak var board: BoardController?

    func setUp() {
        let c = UNUserNotificationCenter.current()
        c.delegate = self
        // Each alert's buttons are a category made for it (AlertContent.prepare).
        refresh()
    }

    func refresh(_ done: (() -> Void)? = nil) {
        UNUserNotificationCenter.current().getNotificationSettings { s in
            DispatchQueue.main.async {
                self.allowed = [.authorized, .provisional, .ephemeral].contains(s.authorizationStatus)
                done?()
            }
        }
    }

    /// One message of the hub (an alert, a close or a test).
    func message(_ m: [String: Any]) {
        guard let type = m["type"] as? String, let id = m["id"] as? String else { return }
        if type == "close" { remove(id); return }
        guard type == "alert" || type == "test", !Store.shared.seen(id) else { return }
        let c = UNMutableNotificationContent()
        AlertContent.prepare(c, m) {
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: c, trigger: nil)) { e in
                Log.say("alert: \(e == nil ? "shown" : "not shown") (\(m["kind"] as? String ?? type))")
            }
        }
    }

    /// The alert a notification carries (drawn, or still sealed: AlertContent.alertOf).
    static func alertOf(_ n: UNNotification) -> [String: Any]? { AlertContent.alertOf(n.request.content.userInfo) }

    /// Takes an alert off: the one the app drew (its id is the alert's) and one
    /// that came through APNs (iOS gave it an id of its own; the alert says its id).
    func remove(_ id: String) {
        let c = UNUserNotificationCenter.current()
        c.removePendingNotificationRequests(withIdentifiers: [id])
        c.getDeliveredNotifications { ns in
            let ids = ns.filter { $0.request.identifier == id || (Self.alertOf($0)?["id"] as? String) == id }.map { $0.request.identifier }
            c.removeDeliveredNotifications(withIdentifiers: ids.isEmpty ? [id] : ids)
        }
    }

    /// The demo's question (Board.swift's demo), posted by the phone itself when the
    /// question arrives and iOS shows Ravenry's alerts (never asked for here). Its
    /// buttons answer the demo's card on the board; nothing leaves the phone.
    func demoAlert(_ m: [String: Any]) -> Bool {
        guard allowed, let id = m["id"] as? String, id.hasPrefix("demo:") else { return false }
        let acts = (m["actions"] as? [[String: Any]] ?? []).compactMap { a -> UNNotificationAction? in
            guard let i = a["id"] as? String, let l = a["label"] as? String, i.hasPrefix("choice:") else { return nil }
            return UNNotificationAction(identifier: i, title: l, options: [])
        }
        let c = UNUserNotificationCenter.current()
        c.getNotificationCategories { cats in
            c.setNotificationCategories(Set(cats.filter { $0.identifier != "demo" }).union([UNNotificationCategory(identifier: "demo", actions: acts, intentIdentifiers: [])]))
            let n = UNMutableNotificationContent()
            n.title = m["title"] as? String ?? "Ravenry"
            n.body = [m["body"] as? String, m["detail"] as? String].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            n.sound = .default
            n.categoryIdentifier = "demo"
            if let d = try? JSONSerialization.data(withJSONObject: m) { n.userInfo = ["alert": String(decoding: d, as: UTF8.self)] }
            c.add(UNNotificationRequest(identifier: id, content: n, trigger: nil)) { e in Log.say("demo: alert \(e == nil ? "shown" : "not shown")") }
        }
        return true
    }

    /// Every alert of the demo's off the list (leaving the demo).
    func clearDemo() {
        let c = UNUserNotificationCenter.current()
        c.getDeliveredNotifications { ns in c.removeDeliveredNotifications(withIdentifiers: ns.map { $0.request.identifier }.filter { $0.hasPrefix("demo:") }) }
    }

    /// In front: an alert through APNs that the live stream already drew is not drawn twice.
    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        if n.request.trigger is UNPushNotificationTrigger, let id = Self.alertOf(n)?["id"] as? String {
            DispatchQueue.main.async { done(Store.shared.seen(id) ? [] : [.banner, .list, .sound]) }
            return
        }
        done([.banner, .list, .sound])
    }

    /// A tap on an alert, or one of its buttons. iOS asks off the main thread, and
    /// its answer must go back on it: the async form of this method answered from
    /// a background thread, and UIKit stopped the app ("Call must be made on main
    /// thread") on every tap, the app open or not (2026-11-15, a launch from an alert).
    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        DispatchQueue.main.async {
            self.tapped(r, done: done)
        }
    }

    private func tapped(_ r: UNNotificationResponse, done: @escaping () -> Void) {
        // An answer from the alert, without the app in front: iOS waits for it.
        var answered = false
        defer { if !answered { done() } }
        guard let a = Self.alertOf(r.notification) else { return }
        let cp = (a["checkpoint"] as? [String: Any])?["id"] as? String
        Log.say("alert: tapped (\(r.actionIdentifier == UNNotificationDefaultActionIdentifier ? "open" : r.actionIdentifier))")
        // The demo's alert: its buttons answer the demo's card, on its board only.
        if (a["id"] as? String)?.hasPrefix("demo:") == true {
            guard let b = board, b.demo else { return }
            if r.actionIdentifier.hasPrefix("choice:"), let cp, let n = Int(r.actionIdentifier.dropFirst("choice:".count)) {
                b.event(["event": "demo.action", "checkpoint": cp, "answer": ["choice": n]])
            } else { b.open(a) }
            return
        }
        let act = r.actionIdentifier
        let sendTo = { (path: String, body: [String: Any]) in
            answered = true
            Task {
                let why: String?
                do {
                    let res = try await Hub.client()?.call("POST", path, json: body)
                    if let res { why = (200..<300).contains(res.status) ? nil : (res.json?["error"] as? String) ?? "The Mac said no (HTTP \(res.status))." }
                    else { why = "This \(Device.model) is not paired." }
                } catch { why = "The Mac did not answer." }
                Log.say("alert: answer \(why == nil ? "sent" : "not sent") (\(act))")
                await MainActor.run {
                    if let why { self.notSent(a, why) }
                    done()
                }
            }
        }
        let answer = { (extra: [String: Any]) in
            guard let cp else { return }
            sendTo("/api/checkpoints/answer", ["id": cp, "by": "phone"].merging(extra) { $1 })
        }
        let session = a["session"] as? [String: Any]
        let projectId = (a["project"] as? [String: Any])?["id"] as? String
        let toSession = { (extra: [String: Any]) in
            guard let projectId, let sf = session?["surfaceId"] as? String else { return }
            sendTo("/api/send", ["projectId": projectId, "surfaceId": sf].merging(extra) { $1 })
        }
        let actionOf = { (id: String) in (a["actions"] as? [[String: Any]] ?? []).first { $0["id"] as? String == id } }
        switch act {
        case "run", "allow:once", "allow:session":
            // Run, and letting an agent type into a tab, always ask for Face ID, from the alert and in the app.
            guard let cp else { return }
            Biometrics.ask(reason: a["title"] as? String ?? "Run") { ok, why in
                guard ok else { if let why { self.notSent(a, why) }; return }
                var body: [String: Any] = ["id": cp, "approve": true, "by": "phone"]
                if act.hasPrefix("allow:") { body["allow"] = String(act.dropFirst("allow:".count)) }
                Task { _ = try? await Hub.client()?.call("POST", "/api/checkpoints/answer", json: body) }
            }
        case "refuse", "decline":
            answer(["decline": true])
        case _ where act.hasPrefix("choice:"):
            if let n = Int(act.dropFirst("choice:".count)) { answer(["choice": n]) }
        case _ where act.hasPrefix("pick:"):
            let vs = (a["checkpoint"] as? [String: Any])?["variants"] as? [[String: Any]] ?? []
            if let n = Int(act.dropFirst("pick:".count)), n < vs.count, let l = vs[n]["label"] as? String { answer(["pick": ["label": l]]) }
        case _ where act.hasPrefix("quick:"):
            if let t = actionOf(act)?["text"] as? String { toSession(["text": t]) }
            else if let n = Int(act.dropFirst("quick:".count)) { toSession(["choice": n]) }
        case "later":
            break
        case "reply":
            let text = ((r as? UNTextInputNotificationResponse)?.userText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }
            if (a["reply"] as? [String: Any])?["action"] as? String == "text" { answer(["text": text]) } else { toSession(["text": text]) }
        default:
            if let b = board { b.open(a) } else { SceneDelegate.pendingAlert = a }
        }
    }

    /// An answer from an alert the Mac did not take: said in an alert of its own, with Open.
    private func notSent(_ a: [String: Any], _ why: String) {
        var m = a
        m["id"] = "\(a["id"] as? String ?? "alert"):not-sent"
        m["body"] = "Not sent: \(why)"
        m["detail"] = nil
        m["reply"] = nil
        m["actions"] = [["id": "open", "label": "Open"]]
        let c = UNMutableNotificationContent()
        AlertContent.prepare(c, m) {
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: m["id"] as? String ?? "not-sent", content: c, trigger: nil))
        }
    }
}
