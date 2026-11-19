// The Notification Service Extension (docs/PHONE.md section 4, "apns"):
// APNs brings the relay's fixed placeholder ("Ravenry", "Open Ravenry to
// see this alert.") with the sealed alert as `e`. This opens it with the
// device's own key (Sources/Shared/PushCrypto.swift) and draws the real
// alert: the hub's title and words, the project as the thread, and its
// buttons (Sources/Shared/AlertContent.swift). If it cannot open it (not
// made for this device, the key gone with a reinstall), or iOS's time runs
// out, the placeholder is what shows: never anything the relay was sent in
// clear, since it was sent none.

import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var placeholder: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler handler: @escaping (UNNotificationContent) -> Void) {
        self.handler = handler
        placeholder = request.content
        AlertContent.service(request.content) { [weak self] c in self?.finish(c ?? request.content) }
    }

    override func serviceExtensionTimeWillExpire() {
        if let p = placeholder { finish(p) }
    }

    private func finish(_ c: UNNotificationContent) {
        guard let h = handler else { return }
        handler = nil
        h(c)
    }
}
