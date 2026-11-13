// Mac notifications, posted by the app itself (ALERT rows): the hub sends
// each one to exactly one app, the one focused last (hub/server/desktop.mjs
// pickApp), down its event stream (event: notify). This app posts it with
// UNUserNotificationCenter and answers the hub (POST
// /api/alerts/desktop/result) with what macOS did, as the Electron app does
// (apps/desktop/src/main/notify.ts): shown only when macOS lists it as
// delivered within 5 s; not shown, with why, otherwise; not allowed when
// macOS refused Ravenry's notifications. A click opens the session it is
// about. The window coming to the front tells the hub (POST
// /api/alerts/desktop/focus), so the next one comes here.
//
// Off every screen (the self-tests) nothing reaches the screen or asks
// macOS anything: a stand-in records each one (`record`, and
// RAVENRY_NOTIFY_LOG) and answers shown, or not allowed with
// RAVENRY_NOTIFY_STANDIN=denied.

import AppKit
import UserNotifications

final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    struct Request { let id: String, title: String, body: String, kind: String?, projectId: String?, surfaceId: String? }
    /// The stand-in's: what was posted, newest last.
    private(set) var record: [Request] = []
    let standIn: Bool
    /// A click: the session it is about.
    var onOpen: ((Request) -> Void)?
    private var live: [String: Request] = [:]

    init(standIn: Bool) {
        self.standIn = standIn
        super.init()
        if !standIn { UNUserNotificationCenter.current().delegate = self }
    }

    static func request(_ j: [String: Any]) -> Request? {
        guard let id = j["id"] as? String, let tt = j["title"] as? String, let b = j["body"] as? String else { return nil }
        return Request(id: id, title: String(tt.prefix(200)), body: String(b.prefix(500)), kind: j["kind"] as? String, projectId: j["projectId"] as? String, surfaceId: j["surfaceId"] as? String)
    }

    /// macOS's answer when Ravenry's notifications are not allowed.
    static func denied(_ err: String) -> Bool {
        err.range(of: "not allowed|not authori[sz]ed|UNErrorDomain error 1\\b|denied", options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// Posts one; `done` gets the hub's answer { id, ok, error, denied }.
    func post(_ q: Request, done: @escaping ([String: Any]) -> Void) {
        let answer = { (ok: Bool, error: String?, denied: Bool) in
            DispatchQueue.main.async { done(["id": q.id, "ok": ok, "error": error ?? NSNull(), "denied": !ok && denied]) }
        }
        live[q.id] = q
        if standIn {
            record.append(q)
            if let log = ProcessInfo.processInfo.environment["RAVENRY_NOTIFY_LOG"], let d = try? JSONSerialization.data(withJSONObject: ["title": q.title, "body": q.body, "at": ISO8601DateFormatter().string(from: Date())]),
               let h = FileHandle(forWritingAtPath: log) ?? (FileManager.default.createFile(atPath: log, contents: nil) ? FileHandle(forWritingAtPath: log) : nil) {
                h.seekToEndOfFile(); h.write(d + Data("\n".utf8)); try? h.close()
            }
            if ProcessInfo.processInfo.environment["RAVENRY_NOTIFY_STANDIN"] == "denied" { answer(false, "Notifications are not allowed for this application", true) } else { answer(true, nil, false) }
            return
        }
        let c = UNUserNotificationCenter.current()
        // What macOS says first: refused (by the person, or never asked
        // because the ask failed) answers at once with the words the board
        // shows and its Open Notifications settings; never asked yet asks
        // now, else it posts. It asked before each one, so a refusal was
        // only ever "not allowed", with no way to tell why.
        Notifier.allowed(c) { ok, why in
            if !ok { answer(false, why, true); return }
            let content = UNMutableNotificationContent()
            content.title = q.title
            content.body = q.body
            content.sound = .default
            content.userInfo = ["id": q.id]
            c.add(UNNotificationRequest(identifier: q.id, content: content, trigger: nil)) { err in
                if let e = err as NSError? {
                    let msg = e.localizedDescription
                    answer(false, msg, (e.domain == UNErrorDomain && e.code == UNError.notificationsNotAllowed.rawValue) || Notifier.denied(msg))
                    return
                }
                // Shown only when macOS lists it as delivered.
                let t0 = Date()
                func look() {
                    c.getDeliveredNotifications { list in
                        if list.contains(where: { $0.request.identifier == q.id }) { answer(true, nil, false); return }
                        if Date().timeIntervalSince(t0) > 5 {
                            c.getNotificationSettings { s in
                                let off = s.authorizationStatus == .denied || s.alertSetting == .disabled
                                answer(false, off ? "Notifications are not allowed for this application" : "macOS did not say it showed it", off)
                            }
                            return
                        }
                        DispatchQueue.global().asyncAfter(deadline: .now() + 0.4) { look() }
                    }
                }
                look()
            }
        }
    }

    static let notAllowed = "Notifications are not allowed for this application"

    /// Whether macOS lets Ravenry post: asks once when it was never asked;
    /// `why` says it in the words app.log and the board keep.
    static func allowed(_ c: UNUserNotificationCenter, done: @escaping (Bool, String) -> Void) {
        c.getNotificationSettings { s in
            switch s.authorizationStatus {
            case .authorized, .provisional: done(true, "")
            case .notDetermined:
                c.requestAuthorization(options: [.alert, .sound]) { granted, err in
                    if let e = err as NSError? { AppLog.write("notify: macOS refused the ask: \(e.domain) \(e.code): \(e.localizedDescription)") }
                    done(granted, granted ? "" : err?.localizedDescription ?? notAllowed)
                }
            default: done(false, notAllowed)
            }
        }
    }

    /// At launch, with the window up: what macOS says about Ravenry's
    /// notifications goes in app.log, and an app macOS never asked about
    /// asks now, so its question comes while the person is at the Mac and
    /// not with the first alert at night.
    func atLaunch() {
        guard !standIn else { return }
        let c = UNUserNotificationCenter.current()
        c.getNotificationSettings { s in
            let st: String
            switch s.authorizationStatus {
            case .authorized: st = "allowed"
            case .provisional: st = "allowed quietly"
            case .denied: st = "not allowed (System Settings > Notifications > Ravenry)"
            case .notDetermined: st = "not asked yet: asking"
            default: st = "status \(s.authorizationStatus.rawValue)"
            }
            AppLog.write("notify: macOS says Ravenry's notifications are \(st)")
            if s.authorizationStatus == .notDetermined {
                Notifier.allowed(c) { ok, why in AppLog.write("notify: macOS's answer: \(ok ? "allowed" : "not allowed: \(why)")") }
            }
        }
    }

    /// The stand-in's click, as the person's on the real one.
    func click(_ id: String) { if let q = live[id] { onOpen?(q) } }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound, .list])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        let id = r.notification.request.identifier
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            self.click(id)
        }
        done()
    }
}
