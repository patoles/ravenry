// The computer this iPhone is paired with and this device's token, kept in
// the Keychain for this device only (docs/PHONE.md section 9: "Keychain,
// this device only"); a backup or another app never reads it. The few
// plain settings (the alerts' ask shown once, the alert ids already drawn)
// are UserDefaults: nothing secret.

import Foundation
import Security
import UIKit
import Network

struct Paired: Codable, Equatable {
    var hubName: String
    var hosts: [String]
    var port: Int
    var pin: String
    var token: String
    var deviceId: String
    var deviceName: String
    /// The host that answered last, tried first.
    var lastHost: String?
}

final class Store {
    static let shared = Store()
    private let service = "dev.ravenry.ios"
    private var cached: Paired?
    private let lock = NSLock()

    func paired() -> Paired? {
        lock.lock(); defer { lock.unlock() }
        if let c = cached { return c }
        guard let d = read("paired"), let p = try? JSONDecoder().decode(Paired.self, from: d) else { return nil }
        cached = p
        return p
    }

    func save(_ p: Paired) {
        lock.lock(); defer { lock.unlock() }
        if let d = try? JSONEncoder().encode(p) { write("paired", d) }
        cached = p
    }

    func rememberHost(_ h: String) {
        guard var p = paired(), p.lastHost != h else { return }
        p.lastHost = h
        save(p)
    }

    func clear() {
        lock.lock(); defer { lock.unlock() }
        delete("paired")
        cached = nil
    }

    /// This install's id (docs/PHONE.md section 3, "The same device
    /// again"): 32 random bytes, made once and kept in the Keychain for this
    /// device only, so the app reinstalled keeps it (iOS keeps the item) and a
    /// backup restored on another device does not carry it. Pairing again
    /// sends it, and the Mac takes over this device's row instead of adding one.
    func installId() -> String {
        lock.lock(); defer { lock.unlock() }
        if let d = read("install"), let s = String(data: d, encoding: .utf8), !s.isEmpty { return s }
        var b = [UInt8](repeating: 0, count: 32)
        if SecRandomCopyBytes(kSecRandomDefault, b.count, &b) != errSecSuccess { b = (0..<32).map { _ in UInt8.random(in: 0...255) } }
        let s = Pins.b64u(Data(b))
        write("install", Data(s.utf8))
        return s
    }

    /// Pairings signed out here whose computer has not heard yet (PHONE-018):
    /// Sign out changes the screen at once, the unpair goes out until the Mac answers.
    func revokes() -> [Paired] {
        guard let d = read("revokes"), let l = try? JSONDecoder().decode([Paired].self, from: d) else { return [] }
        return l
    }
    func addRevoke(_ p: Paired) { saveRevokes(revokes().filter { $0.token != p.token } + [p]) }
    func dropRevoke(_ token: String) { saveRevokes(revokes().filter { $0.token != token }) }
    private func saveRevokes(_ l: [Paired]) {
        if l.isEmpty { delete("revokes") } else if let d = try? JSONEncoder().encode(l) { write("revokes", d) }
    }

    /// Alert ids already drawn, so each is shown once.
    func seen(_ id: String) -> Bool {
        var l = UserDefaults.standard.stringArray(forKey: "seen") ?? []
        if l.contains(id) { return true }
        l = Array((l + [id]).suffix(200))
        UserDefaults.standard.set(l, forKey: "seen")
        return false
    }

    var alertsAsked: Bool {
        get { UserDefaults.standard.bool(forKey: "alertsAsked") }
        set { UserDefaults.standard.set(newValue, forKey: "alertsAsked") }
    }

    // ------------------------------------------------------------ the Keychain

    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    private func read(_ account: String) -> Data? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    private func write(_ account: String, _ data: Data) {
        let q = query(account)
        let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        if SecItemUpdate(q as CFDictionary, attrs as CFDictionary) == errSecItemNotFound {
            var add = q
            for (k, v) in attrs { add[k] = v }
            let s = SecItemAdd(add as CFDictionary, nil)
            if s != errSecSuccess { Log.say("keychain: could not keep \(account) (\(s))") }
        }
    }

    private func delete(_ account: String) { SecItemDelete(query(account) as CFDictionary) }

    #if DEBUG
    /// For the checks (tools/ios-e2e.mjs, RAVENRY_RESET=1): this app as freshly installed.
    func wipe() {
        lock.lock(); defer { lock.unlock() }
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
        cached = nil
        if let id = Bundle.main.bundleIdentifier { UserDefaults.standard.removePersistentDomain(forName: id) }
    }
    #endif
}

/// What this iPhone's network says, for Reach's words.
enum Net {
    /// A VPN is up: an interface iOS gives VPNs (Tailscale's is a utun) with an IPv4 address.
    static func vpnUp() -> Bool {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return false }
        defer { freeifaddrs(list) }
        var p: UnsafeMutablePointer<ifaddrs>? = first
        while let a = p {
            let name = String(cString: a.pointee.ifa_name)
            if let sa = a.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET),
               ["utun", "ipsec", "ppp", "tun", "tap"].contains(where: { name.hasPrefix($0) }) { return true }
            p = a.pointee.ifa_next
        }
        return false
    }

    /// iOS does not say whether another app is installed; Tailscale is
    /// taken as there, and Open Tailscale goes to its App Store page when
    /// it is not (open.tailscale).
    static func tailscaleInstalled() -> Bool { true }

    /// Skip a host now: a tailnet one with no VPN up cannot answer, and waiting on it only delays the words.
    static let skip: (String) -> Bool = { h in Reach.tailnetHost(h) && !vpnUp() }

    static func why(_ f: HubFailure?, hosts: [String]) -> Reach.Why {
        Reach.decide(hosts, vpnUp: vpnUp(), tailscaleInstalled: tailscaleInstalled(),
                     tailnetNameUnresolved: f?.tailnetNameUnresolved ?? false, localNetworkDenied: f?.localNetworkDenied ?? false)
    }

    /// The Tailscale app, or its App Store page.
    @MainActor static func openTailscale() {
        let app = URL(string: "tailscale://")!
        UIApplication.shared.open(app, options: [:]) { ok in
            if !ok { UIApplication.shared.open(URL(string: "https://apps.apple.com/app/tailscale/id1470499037")!) }
        }
    }

    /// Ravenry's own page in Settings (Local Network, Notifications, Face ID).
    @MainActor static func openSettings() {
        UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!)
    }

    /// The network changed (joined or left a Wi-Fi): told to whoever watches.
    static let monitor = NWPathMonitor()
    static var onChange: (() -> Void)?
    static func watch() {
        var first = true
        monitor.pathUpdateHandler = { _ in
            if first { first = false; return }
            DispatchQueue.main.async { onChange?() }
        }
        monitor.start(queue: DispatchQueue(label: "net"))
    }
}

/// The app's log: NSLog, and Documents/app.log for the checks (never a secret, a token or a code).
enum Log {
    private static let q = DispatchQueue(label: "log")
    static let file = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("app.log")
    static func say(_ s: String) {
        NSLog("Ravenry: %@", s)
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(s)\n"
        q.async {
            if let h = try? FileHandle(forWritingTo: file) { h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close() }
            else { try? Data(line.utf8).write(to: file) }
        }
    }
}
