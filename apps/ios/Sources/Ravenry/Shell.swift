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

    func start() {
        stopped = false
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
        Task { @MainActor in
            let c = Hub.client()
            var result: Result<(host: String, ms: Int), Error>
            do {
                guard let c else { throw HubFailure(hosts: [], underlying: "not paired") }
                result = .success(try await c.probe())
            } catch { result = .failure(error) }
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

/// The alerts while the app is open (docs/PHONE.md section 5): the hub's
/// messages on the live stream drawn by iOS, once each; a close takes one
/// off. A command's alert has Run (Face ID in the app first) and Refuse.
/// Push (APNs, the alerts while the app is closed) comes later.
final class AlertCenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = AlertCenter()
    private(set) var allowed = false
    weak var board: BoardController?

    func setUp() {
        let c = UNUserNotificationCenter.current()
        c.delegate = self
        let run = UNNotificationAction(identifier: "run", title: "Run", options: [.foreground, .authenticationRequired])
        let refuse = UNNotificationAction(identifier: "refuse", title: "Refuse", options: [.destructive, .authenticationRequired])
        let open = UNNotificationAction(identifier: "open", title: "Open", options: [.foreground])
        c.setNotificationCategories([UNNotificationCategory(identifier: "approve", actions: [run, refuse, open], intentIdentifiers: [])])
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
        if type == "close" {
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [id])
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])
            return
        }
        guard type == "alert" || type == "test", !Store.shared.seen(id) else { return }
        let c = UNMutableNotificationContent()
        c.title = m["title"] as? String ?? "Ravenry"
        c.body = [m["body"] as? String, m["detail"] as? String].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
        c.sound = .default
        if (m["kind"] as? String) == "approve" { c.categoryIdentifier = "approve" }
        if let p = (m["project"] as? [String: Any])?["id"] as? String { c.threadIdentifier = p }
        if let d = try? JSONSerialization.data(withJSONObject: m) { c.userInfo = ["alert": String(decoding: d, as: UTF8.self)] }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: c, trigger: nil)) { e in
            Log.say("alert: \(e == nil ? "shown" : "not shown") (\(m["kind"] as? String ?? type))")
        }
    }

    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification) async -> UNNotificationPresentationOptions { [.banner, .list, .sound] }

    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse) async {
        guard let s = r.notification.request.content.userInfo["alert"] as? String,
              let a = (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] else { return }
        let cp = (a["checkpoint"] as? [String: Any])?["id"] as? String
        await MainActor.run {
            switch r.actionIdentifier {
            case "run":
                guard let cp else { return }
                // Run always asks for Face ID, from the alert and in the app.
                Biometrics.ask(reason: a["title"] as? String ?? "Run") { ok, _ in
                    guard ok else { return }
                    Task { _ = try? await Hub.client()?.call("POST", "/api/checkpoints/answer", json: ["id": cp, "approve": true, "by": "phone"]) }
                }
            case "refuse":
                guard let cp else { return }
                Task { _ = try? await Hub.client()?.call("POST", "/api/checkpoints/answer", json: ["id": cp, "decline": true, "by": "phone"]) }
            default:
                if let b = board { b.event(["event": "open", "alert": a]) } else { SceneDelegate.pendingAlert = a }
            }
        }
    }
}
