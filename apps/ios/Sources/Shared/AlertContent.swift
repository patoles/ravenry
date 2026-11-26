// An alert as iOS draws it (docs/PHONE.md section 5), shared by the app
// (alerts on its live stream) and its Notification Service Extension
// (alerts through APNs): the title, the body and the detail, the project as
// the thread, the hub's message itself in `userInfo["alert"]` (what a tap
// or a button reads), and its buttons. iOS shows the buttons on a long
// press; they are a category's, so each set of buttons is a category made
// for it ("a." and a hash of the buttons), registered before the alert is.
//
// The buttons, as Android's (section 5, "Kinds, buttons and the reply line"):
// - Run, Allow once, This session (marked `biometric`): open the app, which
//   asks for Face ID before it answers; never answered from the alert alone.
// - Refuse, Not now (decline): the phone unlocked first.
// - an answer (choice:, quick:, pick:) and the reply line: the phone
//   unlocked first, then answered without opening the app.
// - Open, Type it, Compare: open the app on it.
// - a pick shows Compare and Not now, whatever the message lists; a secret
//   never has a reply line.

import Foundation
import UserNotifications
import CryptoKit

enum AlertContent {
    static let maxLabel = 40

    /// The notification's words and data for a message (`alert` or `test`).
    static func fill(_ c: UNMutableNotificationContent, _ m: [String: Any]) {
        c.title = str(m["title"]) ?? "Ravenry"
        c.body = [str(m["body"]), str(m["detail"])].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
        c.sound = .default
        if let p = str((m["project"] as? [String: Any])?["id"]) { c.threadIdentifier = p }
        if let d = try? JSONSerialization.data(withJSONObject: m) { c.userInfo = ["alert": String(decoding: d, as: UTF8.self)] }
    }

    /// The buttons of a message, as iOS actions, in its order.
    static func actions(_ m: [String: Any]) -> [UNNotificationAction] {
        let kind = str(m["kind"]) ?? ""
        var list = (m["actions"] as? [[String: Any]] ?? []).compactMap { a -> (String, String, Bool)? in
            guard let id = str(a["id"]), let label = str(a["label"]) else { return nil }
            return (id, label, a["biometric"] as? Bool == true)
        }
        if kind == "pick" { list = [("open", "Compare", false), ("later", "Not now", false)] }
        var out: [UNNotificationAction] = list.map { id, label, bio in
            let title = label.count > maxLabel ? String(label.prefix(maxLabel - 3)) + "..." : label
            if bio || id == "run" || id.hasPrefix("allow:") { return UNNotificationAction(identifier: id, title: title, options: [.foreground, .authenticationRequired]) }
            if id == "refuse" || id == "decline" { return UNNotificationAction(identifier: id, title: title, options: [.destructive, .authenticationRequired]) }
            if id == "open" { return UNNotificationAction(identifier: id, title: title, options: [.foreground]) }
            return UNNotificationAction(identifier: id, title: title, options: [.authenticationRequired])
        }
        if kind != "secret", let r = m["reply"] as? [String: Any], let label = str(r["label"]) {
            out.append(UNTextInputNotificationAction(identifier: "reply", title: label, options: [.authenticationRequired],
                                                     textInputButtonTitle: "Send", textInputPlaceholder: str(r["hint"]) ?? label))
        }
        return out
    }

    /// The category for these buttons: "a." and the first 12 characters of a hash of them.
    static func categoryId(_ actions: [UNNotificationAction]) -> String {
        let key = actions.map { "\($0.identifier)\u{1}\($0.title)\u{1}\($0.options.rawValue)\u{1}\($0 is UNTextInputNotificationAction)" }.joined(separator: "\u{2}")
        let h = SHA256.hash(data: Data(key.utf8)).prefix(9)
        return "a." + Data(h).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
    }

    /// Fills `c` for `m` and registers its buttons' category, then `done`.
    /// At most 100 categories made here are kept (iOS keeps each set until it is replaced); other categories stay.
    static func prepare(_ c: UNMutableNotificationContent, _ m: [String: Any], done: @escaping () -> Void) {
        fill(c, m)
        let acts = actions(m)
        guard !acts.isEmpty else { done(); return }
        let id = categoryId(acts)
        c.categoryIdentifier = id
        let center = UNUserNotificationCenter.current()
        center.getNotificationCategories { cats in
            if cats.contains(where: { $0.identifier == id }) { done(); return }
            let mine = cats.filter { $0.identifier.hasPrefix("a.") }
            let others = cats.filter { !$0.identifier.hasPrefix("a.") }
            let keep = Array(mine.sorted { $0.identifier < $1.identifier }.suffix(99))
            center.setNotificationCategories(others.union(keep).union([UNNotificationCategory(identifier: id, actions: acts, intentIdentifiers: [], options: [])]))
            // iOS takes the new set a moment later: wait for it, at most 1 s.
            var tries = 0
            func check() {
                center.getNotificationCategories { now in
                    tries += 1
                    if now.contains(where: { $0.identifier == id }) || tries >= 10 { done() } else { DispatchQueue.global().asyncAfter(deadline: .now() + 0.1, execute: check) }
                }
            }
            check()
        }
    }

    /// What the Notification Service Extension draws for what APNs brought
    /// (Sources/Notify): the sealed alert (`e`) opened with this device's key
    /// and drawn, or nil when it cannot be opened (the placeholder stays).
    static func service(_ content: UNNotificationContent, done: @escaping (UNNotificationContent?) -> Void) {
        guard let e = content.userInfo["e"] as? String, let m = PushCrypto.message(e),
              let type = m["type"] as? String, type == "alert" || type == "test" else { done(nil); return }
        let c = UNMutableNotificationContent()
        prepare(c, m) { done(c) }
    }

    /// The alert a notification carries: drawn by the app or the extension (`alert`), or still
    /// sealed (`e`: the extension could not draw it in time; the app opens it on a tap).
    static func alertOf(_ info: [AnyHashable: Any]) -> [String: Any]? {
        if let s = info["alert"] as? String { return (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] }
        if let e = info["e"] as? String { return PushCrypto.message(e) }
        return nil
    }

    /// A string field, never "null" or a number.
    static func str(_ v: Any?) -> String? { (v as? String).flatMap { $0.isEmpty ? nil : $0 } }
}
