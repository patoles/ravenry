// Alerts while the app is closed: push through APNs (docs/PHONE.md
// section 4, "apns"). Once the app is paired and iOS shows its alerts, it
// asks iOS for its APNs device token and tells the Mac where to send
// (POST /api/phone/push { kind: "apns", relay, token, environment, p256dh,
// auth }): the relay that holds the APNs key for this build (Info.plist
// RavenryRelay, set by scripts/archive.sh), the APNs this build talks to
// (a debug build: the sandbox), and the public half of this device's alert
// key (Sources/Shared/PushCrypto.swift). The Mac seals each alert for
// this device; the Notification Service Extension opens it (Sources/Notify).
// iOS turned Ravenry's alerts off after that: the Mac is told none, so
// nothing goes to the relay.

import UIKit
import UserNotifications

final class Push {
    static let shared = Push()
    private var token: String?
    /// The token and pairing told this run: told again only when either changes.
    private var told: String?
    /// The device id the Mac last took an apns target from: it is told none once alerts go off.
    private var sentTo: String? {
        get { UserDefaults.standard.string(forKey: "pushSentTo") }
        set { UserDefaults.standard.set(newValue, forKey: "pushSentTo") }
    }

    static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    static var relay: String? {
        let r = (Bundle.main.object(forInfoDictionaryKey: "RavenryRelay") as? String ?? "").trimmingCharacters(in: .whitespaces)
        return r.isEmpty || r.hasPrefix("$(") ? nil : r
    }

    /// Paired, and iOS shows the alerts: ask iOS for the token (each start, it may change).
    /// Alerts off after the Mac had a target from here: the Mac is told none.
    func start() {
        guard Store.shared.paired() != nil else { return }
        UNUserNotificationCenter.current().getNotificationSettings { s in
            let on = [.authorized, .provisional, .ephemeral].contains(s.authorizationStatus)
            DispatchQueue.main.async {
                if on {
                    #if DEBUG
                    // The checks (tools/ios-e2e.mjs): a token of their own, with no APNs.
                    if let t = ProcessInfo.processInfo.environment["RAVENRY_TEST_APNS_TOKEN"], !t.isEmpty { self.arrived(hex: t); return }
                    #endif
                    UIApplication.shared.registerForRemoteNotifications()
                } else if self.sentTo != nil { self.off() }
            }
        }
    }

    func arrived(_ token: Data) { arrived(hex: token.map { String(format: "%02x", $0) }.joined()) }

    func arrived(hex: String) {
        token = hex
        Task { await register() }
    }

    func failed(_ e: Error) { Log.say("push: iOS gave no APNs token (\((e as NSError).code))") }

    private func register() async {
        guard let token, let p = Store.shared.paired(), let c = Hub.client() else { return }
        let what = "\(token)|\(p.deviceId)|\(p.hubName)"
        if told == what { return }
        guard let keys = PushKeys.make() else { Log.say("push: the alerts' key could not be made"); return }
        let parts = PushKeys.publicParts(keys)
        var body: [String: Any] = ["kind": "apns", "token": token, "environment": Self.environment, "p256dh": parts.p256dh, "auth": parts.auth]
        if let r = Self.relay { body["relay"] = r }
        do {
            let r = try await c.call("POST", "/api/phone/push", json: body)
            if (200..<300).contains(r.status) { sentTo = p.deviceId; told = what; Log.say("push: the Mac sends alerts through APNs (\(Self.environment))") }
            else { Log.say("push: the Mac did not take it (HTTP \(r.status))") }
        } catch { Log.say("push: the Mac did not answer; again at the next start") }
    }

    private func off() {
        guard let c = Hub.client() else { return }
        Task {
            let r = try? await c.call("POST", "/api/phone/push", json: ["kind": "none"])
            if let r, (200..<300).contains(r.status) { sentTo = nil; Log.say("push: alerts are off in iOS; the Mac sends none") }
        }
    }

    /// A silent push (a close: the alert answered, cancelled or gone elsewhere): opened here and done.
    func background(_ info: [AnyHashable: Any], done: @escaping (UIBackgroundFetchResult) -> Void) {
        guard let e = info["e"] as? String, let m = PushCrypto.message(e) else { done(.noData); return }
        DispatchQueue.main.async {
            AlertCenter.shared.message(m)
            // removeDelivered is asynchronous: a moment before iOS may suspend the app.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { done(.newData) }
        }
    }
}
