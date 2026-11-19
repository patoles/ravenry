// The alerts' key and their decryption (docs/PHONE.md section 4, "End to
// end" and "apns"), shared by the app and its Notification Service
// Extension (Sources/Notify). Apple's CryptoKit only: P-256 key agreement,
// HKDF-SHA256 and AES-128-GCM (docs/store/apple/UPLOAD.md, export
// compliance: the encryption within Apple's operating system).
//
// The hub on the Mac seals each alert for this device with Web Push message
// encryption (RFC 8291, aes128gcm, RFC 8188): the device's P-256 key
// (`p256dh`, its public half sent to the Mac) and a 16-byte auth secret.
// The relay and Apple carry only those sealed bytes; the private key never
// leaves this device.

import Foundation
import CryptoKit
import Security

enum PushCrypto {
    enum Failure: Error { case short, header, sender, record, padding }

    /// Opens an aes128gcm message for `key` and `auth`: salt(16) rs(4)
    /// idlen(1) keyid (the sender's public key, 65) and one record.
    static func open(_ message: Data, key: P256.KeyAgreement.PrivateKey, auth: Data) throws -> Data {
        let b = Data(message)
        guard b.count >= 21 + 65 + 17 else { throw Failure.short }
        let salt = b.subdata(in: 0..<16)
        let rs = b.subdata(in: 16..<20).reduce(0) { ($0 << 8) | Int($1) }
        guard b[20] == 65, rs >= 18 else { throw Failure.header }
        let senderBytes = b.subdata(in: 21..<86)
        let record = b.subdata(in: 86..<b.count)
        guard record.count <= rs else { throw Failure.record }
        guard let sender = try? P256.KeyAgreement.PublicKey(x963Representation: senderBytes) else { throw Failure.sender }
        let shared = try key.sharedSecretFromKeyAgreement(with: sender)
        // RFC 8291 section 3.4: IKM = HKDF(auth, ecdh, "WebPush: info" 0 ua_public as_public, 32).
        var info = Data("WebPush: info".utf8); info.append(0)
        info.append(key.publicKey.x963Representation); info.append(senderBytes)
        let ikm = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: auth, sharedInfo: info, outputByteCount: 32)
        // RFC 8188 section 2.2 and 2.3: the content key and the nonce.
        var cekInfo = Data("Content-Encoding: aes128gcm".utf8); cekInfo.append(0)
        var nonceInfo = Data("Content-Encoding: nonce".utf8); nonceInfo.append(0)
        let cek = HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: salt, info: cekInfo, outputByteCount: 16)
        let nonce = HKDF<SHA256>.deriveKey(inputKeyMaterial: ikm, salt: salt, info: nonceInfo, outputByteCount: 12).withUnsafeBytes { Data($0) }
        guard record.count > 16 else { throw Failure.record }
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: record.prefix(record.count - 16), tag: record.suffix(16))
        var plain = try AES.GCM.open(box, using: cek)
        // The last record: the text, the delimiter 2, then any zeros.
        while let last = plain.last, last == 0 { plain.removeLast() }
        guard plain.last == 2 else { throw Failure.padding }
        plain.removeLast()
        return plain
    }

    /// The sealed alert APNs carried (`e`, base64url) opened as the hub's message.
    static func message(_ e: String) -> [String: Any]? {
        guard let keys = PushKeys.load(), let raw = Data(b64u: e),
              let plain = try? open(raw, key: keys.key, auth: keys.auth) else { return nil }
        return (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any]
    }
}

/// This device's alert key: a P-256 key pair and a 16-byte auth secret, made
/// once, in the Keychain for this device only, in the access group the app
/// shares with its Notification Service Extension (Info.plist
/// `RavenryKeychainGroup`). Readable after the first unlock, so an alert
/// that arrives while the phone is locked is opened too.
enum PushKeys {
    private static let service = "dev.ravenry.push"
    private static let account = "alerts"

    struct Keys { let key: P256.KeyAgreement.PrivateKey; let auth: Data }

    static var group: String? {
        let g = Bundle.main.object(forInfoDictionaryKey: "RavenryKeychainGroup") as? String ?? ""
        return g.isEmpty || g.hasPrefix("$(") ? nil : g
    }

    private static func query(_ group: String?) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    static func load() -> Keys? {
        for g in [group, nil] {
            var q = query(g)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var out: CFTypeRef?
            if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data, d.count == 48,
               let k = try? P256.KeyAgreement.PrivateKey(rawRepresentation: d.prefix(32)) {
                return Keys(key: k, auth: d.suffix(16))
            }
            if group == nil { break }
        }
        return nil
    }

    /// The keys, made the first time.
    static func make() -> Keys? {
        if let k = load() { return k }
        let key = P256.KeyAgreement.PrivateKey()
        var auth = Data(count: 16)
        let ok = auth.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) } == errSecSuccess
        guard ok else { return nil }
        var add = query(group)
        add[kSecValueData as String] = key.rawRepresentation + auth
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        var s = SecItemAdd(add as CFDictionary, nil)
        // A build signed without the shared group (the simulator, ad hoc): the app's own.
        if s == errSecMissingEntitlement, group != nil {
            add.removeValue(forKey: kSecAttrAccessGroup as String)
            s = SecItemAdd(add as CFDictionary, nil)
        }
        return s == errSecSuccess ? load() : nil
    }

    /// What the Mac gets: the public key (uncompressed, 65 bytes) and the auth secret, in base64url.
    static func publicParts(_ k: Keys) -> (p256dh: String, auth: String) {
        (k.key.publicKey.x963Representation.b64u, k.auth.b64u)
    }

    #if DEBUG
    static func wipe() { for g in [group, nil] { SecItemDelete(query(g) as CFDictionary) } }
    /// For the checks: a known key in place of this device's.
    static func store(_ key: P256.KeyAgreement.PrivateKey, auth: Data) {
        wipe()
        var add = query(group)
        add[kSecValueData as String] = key.rawRepresentation + auth
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        if SecItemAdd(add as CFDictionary, nil) == errSecMissingEntitlement { add.removeValue(forKey: kSecAttrAccessGroup as String); SecItemAdd(add as CFDictionary, nil) }
    }
    #endif
}

extension Data {
    init?(b64u s: String) {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        self.init(base64Encoded: t)
    }
    var b64u: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
}
