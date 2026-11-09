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
        c.requestAuthorization(options: [.alert, .sound]) { granted, err in
            if !granted {
                answer(false, err?.localizedDescription ?? "Notifications are not allowed for this application", true)
                return
            }
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
