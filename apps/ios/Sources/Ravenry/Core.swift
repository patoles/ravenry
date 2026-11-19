// The pairing link, the pin and its check number, the words when the Mac
// does not answer, and the order the Mac's addresses are tried in: the
// Android app's tested logic (Pairing.kt, Reach.kt, HubClient.order) written
// again in Swift, with Android's test cases in Tests/RavenryTests.
// docs/PHONE.md sections 2 and 3.

import Foundation
import CryptoKit

struct PairError: Error, Equatable { let message: String }

/// ravenry://pair?v=1&name=..&hosts=a,b&port=4601&pin=..&code=.. (docs/PHONE.md section 3).
struct PairLink: Equatable {
    var name: String
    var hosts: [String]
    var port: Int
    var pin: String?
    var code: String

    static let version = 1

    /// The link's fields, or an error the pairing screen shows as it is.
    static func parse(_ text: String) -> Result<PairLink, PairError> {
        func no(_ m: String) -> Result<PairLink, PairError> { .failure(PairError(message: m)) }
        let s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.hasPrefix("ravenry://pair") else { return no("This is not a Ravenry pairing code.") }
        let raw = s.split(separator: "?", maxSplits: 1).dropFirst().first.map(String.init) ?? ""
        let q = query(raw)
        guard let v = q["v"].flatMap({ Int($0) }) else { return no("This pairing code has no version.") }
        if v > version { return no("This pairing code is newer than this app. Update Ravenry on the \(Device.word).") }
        if v < 1 { return no("This pairing code is not one Ravenry makes.") }
        let hosts = (q["hosts"] ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if hosts.isEmpty { return no("This pairing code has no address.") }
        guard let port = q["port"].flatMap({ Int($0) }), (1...65535).contains(port) else { return no("This pairing code has no port.") }
        guard let pin = q["pin"] else { return no("This pairing code has no key.") }
        if !Pins.wellFormed(pin) { return no("This pairing code's key is not one Ravenry makes.") }
        guard let rawCode = q["code"] else { return no("This pairing code has no code.") }
        guard let code = normalizeCode(rawCode) else { return no("This pairing code's code is not one Ravenry makes.") }
        let name = q["name"].flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? hosts[0]
        return .success(PairLink(name: name, hosts: hosts, port: port, pin: pin, code: code))
    }

    /// A query as URLSearchParams writes it ("+" is a space), each value decoded once.
    private static func query(_ raw: String) -> [String: String] {
        var out: [String: String] = [:]
        for part in raw.split(separator: "&") where !part.isEmpty {
            let kv = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            func dec(_ s: Substring) -> String { String(s).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? String(s) }
            out[dec(kv[0])] = kv.count > 1 ? dec(kv[1]) : ""
        }
        return out
    }

    private static let crockford = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    /// A pairing code as typed: dashes and spaces dropped, I and L read as 1, O as 0. 16 characters.
    static func normalizeCode(_ raw: String) -> String? {
        let c = String(raw.uppercased().filter { $0 != "-" && !$0.isWhitespace }.map { ch -> Character in
            switch ch { case "I", "L": return "1"; case "O": return "0"; default: return ch }
        })
        return c.count == 16 && c.allSatisfy { crockford.contains($0) } ? c : nil
    }

    /// "host" or "host:port" as the person typed the computer's address.
    static func typed(address: String, code: String, defaultPort: Int = 4601) -> Result<PairLink, PairError> {
        var a = address.trimmingCharacters(in: .whitespacesAndNewlines)
        for p in ["https://", "http://"] where a.hasPrefix(p) { a = String(a.dropFirst(p.count)) }
        while a.hasSuffix("/") { a.removeLast() }
        if a.isEmpty { return .failure(PairError(message: "Type the computer's address.")) }
        var host = a, port: Int? = defaultPort
        if let i = a.lastIndex(of: ":"), i > a.startIndex, !a[..<i].contains(":") {
            host = String(a[..<i]); port = Int(a[a.index(after: i)...])
        }
        guard let p = port, (1...65535).contains(p) else { return .failure(PairError(message: "That port is not a number.")) }
        guard let c = normalizeCode(code) else { return .failure(PairError(message: "The code has 16 letters and digits, like ABCD-EFGH-JKMN-PQRS.")) }
        return .success(PairLink(name: host, hosts: [host], port: p, pin: nil, code: c))
    }
}

enum Pins {
    static func wellFormed(_ pin: String) -> Bool {
        pin.count == 43 && pin.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
    }

    static func b64u(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func bytes(_ pin: String) -> Data? {
        var s = pin.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        return Data(base64Encoded: s)
    }

    /// The pin of a certificate (DER): base64url SHA-256 of its SubjectPublicKeyInfo.
    static func of(certificate der: Data) -> String? {
        guard let spki = DER.subjectPublicKeyInfo(der) else { return nil }
        return b64u(Data(SHA256.hash(data: spki)))
    }

    /// The id the Mac says on the Wi-Fi (hub/server/nearby.mjs hubId): the
    /// first 12 bytes of the SHA-256 of the pin's bytes, base64url, 16
    /// characters. Only a service with this id is taken (Nearby); the pin is
    /// still what proves it is the paired Mac.
    static func hubId(_ pin: String) -> String {
        guard let b = bytes(pin) else { return "" }
        return b64u(Data(SHA256.hash(data: b)).prefix(12))
    }

    /// The check number of a typed pairing: the first five bytes of the pin
    /// read as one big-endian number, modulo 10^12, as two groups of six digits.
    static func checkNumber(_ pin: String) -> String {
        guard let b = bytes(pin), b.count >= 5 else { return "" }
        var n: UInt64 = 0
        for x in b.prefix(5) { n = n << 8 | UInt64(x) }
        let s = String(n % 1_000_000_000_000)
        let p = String(repeating: "0", count: 12 - s.count) + s
        return p.prefix(6) + " " + p.suffix(6)
    }
}

/// What a pairing sends (docs/PHONE.md section 3; the Android app's
/// PairBody): the code, the device's name, platform and form ("ipad" or
/// "iphone"), the app's version, this install's id, and the token this app
/// still holds for the same Mac (the same pin), so the Mac takes over this
/// device's own row and that old token stops working. A token for another
/// Mac never leaves the phone.
enum PairBody {
    static func of(code: String, name: String, form: String, app: String, install: String, pin: String, old: Paired?) -> [String: Any] {
        var b: [String: Any] = ["code": code, "name": name, "platform": "ios", "form": form, "app": app, "install": install]
        if let o = old, o.pin == pin, !o.token.isEmpty { b["previous"] = o.token }
        return b
    }
}

/// Just enough DER to find a certificate's SubjectPublicKeyInfo: Certificate
/// SEQUENCE { tbsCertificate SEQUENCE { [0] version?, serial, signature,
/// issuer, validity, subject, subjectPublicKeyInfo, ... }, ... }.
enum DER {
    /// The element at `i`: (tag, start of its content, end of the element).
    static func element(_ b: [UInt8], _ i: Int) -> (tag: UInt8, body: Int, end: Int)? {
        guard i + 1 < b.count else { return nil }
        let tag = b[i]
        var len = Int(b[i + 1]), p = i + 2
        if len & 0x80 != 0 {
            let n = len & 0x7f
            guard n > 0, n <= 4, p + n <= b.count else { return nil }
            len = 0
            for k in 0..<n { len = len << 8 | Int(b[p + k]) }
            p += n
        }
        guard p + len <= b.count else { return nil }
        return (tag, p, p + len)
    }

    static func subjectPublicKeyInfo(_ der: Data) -> Data? {
        let b = [UInt8](der)
        guard let cert = element(b, 0), cert.tag == 0x30, let tbs = element(b, cert.body), tbs.tag == 0x30 else { return nil }
        var i = tbs.body
        if let v = element(b, i), v.tag == 0xA0 { i = v.end }
        // serial, signature, issuer, validity, subject
        for _ in 0..<5 { guard let e = element(b, i) else { return nil }; i = e.end }
        guard let spki = element(b, i), spki.tag == 0x30 else { return nil }
        return Data(b[i..<spki.end])
    }
}

/// The Mac as a person names it, never its host name (Android MacName.kt, the hub's sayMac).
enum MacName {
    private static let models: [(String, String)] = [
        ("macbook-pro", "MacBook Pro"), ("macbook-air", "MacBook Air"), ("macbook", "MacBook"),
        ("imac-pro", "iMac Pro"), ("imac", "iMac"), ("mac-mini", "Mac mini"), ("mac-studio", "Mac Studio"), ("mac-pro", "Mac Pro"),
    ]

    static func say(_ name: String?) -> String {
        let n = (name ?? "").trimmingCharacters(in: .whitespaces)
        if n.isEmpty { return "your Mac" }
        if n.contains(where: { $0 == " " || $0.isUppercase }) && !n.contains("-") { return n }
        let first = String(n.split(separator: ".", omittingEmptySubsequences: false).first ?? "")
        let h = first.lowercased().replacingOccurrences(of: #"-\d+$"#, with: "", options: .regularExpression)
        for (k, v) in models where h.range(of: "(^|-)\(k)(-|$)", options: .regularExpression) != nil { return v }
        return first
    }
}

/// Why the Mac cannot be reached, in plain words, never a host name or an
/// address (docs/PHONE.md, Reaching the Mac; Android Reach.kt). The iPhone
/// adds one case Android does not have: Local Network turned off for
/// Ravenry in Settings, which keeps the phone off the Mac's Wi-Fi address.
enum Reach {
    struct Why: Equatable { let reason: String; let words: String }

    static var tailscaleOff: Why { Why(reason: "tailscale-off", words: "Tailscale is off on this \(Device.word). Turn it on, then try again.") }
    static var tailscaleMissing: Why { Why(reason: "tailscale-missing", words: "This \(Device.word) doesn't have Tailscale. Install it and sign in, then try again.") }
    static let macAway = Why(reason: "unreachable", words: "Your Mac didn't answer. Check that it's on and awake, and that Tailscale is connected on both.")
    static var macWifi: Why { Why(reason: "unreachable", words: "Your Mac didn't answer. Check that it's on and awake, and that this \(Device.word) is on its Wi-Fi.") }
    static let localNetworkOff = Why(reason: "local-network-off", words: "Local Network is off for Ravenry, so it can't reach your Mac on this Wi-Fi. Turn it on in Settings, then try again.")

    /// A host only the tailnet reaches: a MagicDNS name, a 100.64/10 or fd7a:115c:a1e0:: address.
    static func tailnetHost(_ h: String) -> Bool {
        var s = h.trimmingCharacters(in: .whitespaces).lowercased()
        if s.hasPrefix("[") { s.removeFirst() }
        if s.hasSuffix("]") { s.removeLast() }
        if s.hasSuffix(".ts.net") { return true }
        if s.hasPrefix("fd7a:115c:a1e0:") { return true }
        let q = s.split(separator: ".", omittingEmptySubsequences: false)
        if q.count == 4, q.allSatisfy({ Int($0).map { (0...255).contains($0) } ?? false }) {
            return q[0] == "100" && (64...127).contains(Int(q[1])!)
        }
        return false
    }

    /// This phone itself (the simulator reaching a hub on the same Mac).
    static func loopback(_ h: String) -> Bool { ["127.0.0.1", "localhost", "::1", "[::1]"].contains(h.lowercased()) }

    /// The words for a failure to reach the Mac at these hosts: Local Network
    /// off when iOS kept the phone off the Wi-Fi's address, Tailscale when
    /// only the tailnet could have answered and no VPN is up (or a tailnet
    /// name did not resolve), else that the Mac did not answer.
    static func decide(_ hosts: [String], vpnUp: Bool, tailscaleInstalled: Bool, tailnetNameUnresolved: Bool = false, localNetworkDenied: Bool = false) -> Why {
        if localNetworkDenied && hosts.contains(where: { !tailnetHost($0) && !loopback($0) }) { return localNetworkOff }
        let tail = hosts.contains(where: tailnetHost)
        if tail && (!vpnUp || tailnetNameUnresolved) { return tailscaleInstalled ? tailscaleOff : tailscaleMissing }
        return tail ? macAway : macWifi
    }

    /// The path a host is: "tailscale" (Ravenry's own device on the person's
    /// tailnet, its MagicDNS name or the 100.x address listed right after it),
    /// "tailscale-mac" (the Mac's own Tailscale app), "local" (this device) or "wifi".
    static func via(_ host: String, _ hosts: [String]) -> String {
        let h = host.trimmingCharacters(in: .whitespaces).lowercased()
        if h == "127.0.0.1" || h == "localhost" || h == "::1" { return "local" }
        if !tailnetHost(h) { return "wifi" }
        let own = { (x: String?) -> Bool in guard let x = x?.lowercased() else { return false }; return x.hasPrefix("ravenry.") && x.hasSuffix(".ts.net") }
        if own(h) { return "tailscale" }
        if let i = hosts.firstIndex(where: { $0.lowercased() == h }), i > 0, own(hosts[i - 1]) { return "tailscale" }
        return "tailscale-mac"
    }
}

/// The order the Mac's addresses are tried in (Android HubClient.order,
/// docs/PHONE.md, The connection): the Wi-Fi addresses ("home": any that is
/// not a tailnet host), then the tailnet ones, the last that answered first
/// within each; a Wi-Fi address that did not answer goes after Tailscale
/// until it answers again or the network changes, except in the connection
/// watch's check, which tries every Wi-Fi address first every time.
final class Route {
    /// The computer's addresses: the saved ones, and any found on the Wi-Fi that answered.
    var hosts: [String] { lock.lock(); defer { lock.unlock() }; return list }
    private var list: [String]
    private(set) var host: String
    private var homeDown = Set<String>()
    private let lock = NSLock()
    let isTailnet: (String) -> Bool
    let skip: (String) -> Bool
    var onHost: (String) -> Void

    init(_ hosts: [String], isTailnet: @escaping (String) -> Bool = Reach.tailnetHost, skip: @escaping (String) -> Bool = { _ in false }, onHost: @escaping (String) -> Void = { _ in }) {
        var seen = Set<String>()
        list = hosts.filter { seen.insert($0).inserted }
        host = list.first ?? ""
        self.isTailnet = isTailnet
        self.skip = skip
        self.onHost = onHost
    }

    func order(check: Bool = false) -> [String] {
        lock.lock(); defer { lock.unlock() }
        let home = list.filter { !isTailnet($0) }, tail = list.filter { isTailnet($0) }
        let last = { (l: [String]) -> [String] in l.contains(self.host) ? [self.host] + l.filter { $0 != self.host } : l }
        let h = last(home)
        let first = check ? h : h.filter { !homeDown.contains($0) }
        let rest = h.filter { !first.contains($0) }
        return (first + last(tail) + rest).filter { !skip($0) }
    }

    func answered(_ h: String) {
        lock.lock()
        homeDown.remove(h)
        // Found on the Wi-Fi (Nearby): one of the computer's addresses from now on.
        if !list.contains(h) { list.insert(h, at: 0) }
        let changed = h != host
        if changed { host = h }
        lock.unlock()
        if changed { onHost(h) }
    }

    func failed(_ h: String) {
        guard !isTailnet(h) else { return }
        lock.lock(); homeDown.insert(h); lock.unlock()
    }

    /// The phone joined or left a Wi-Fi: every Wi-Fi address gets a first try again.
    func networkChanged() { lock.lock(); homeDown.removeAll(); lock.unlock() }

    /// A round over `order` (HubClient.execute; Android HubClient.tries): each
    /// host tried in turn until `attempt` gives an answer, with the Mac's
    /// addresses found on the Wi-Fi (`find`, given what was tried) put just
    /// before the first tailnet host, or at the end: looked for only when the
    /// round gets there, so only when no saved Wi-Fi address answered.
    /// Order: the saved Wi-Fi addresses, the found ones, then Tailscale.
    static func round<T>(_ order: [String], isTailnet: (String) -> Bool, find: (([String]) async -> [String])?,
                         attempt: (String) async -> T?) async -> T? {
        var tried: [String] = []
        var looked = find == nil
        var i = 0
        while i <= order.count {
            let h: String? = i < order.count ? order[i] : nil
            if !looked && (h == nil || isTailnet(h!)) {
                looked = true
                var found: [String] = []
                for n in await find?(tried) ?? [] where !tried.contains(n) && !found.contains(n) && !isTailnet(n) { found.append(n) }
                for n in found { tried.append(n); if let r = await attempt(n) { return r } }
            }
            guard let h else { break }
            tried.append(h)
            if let r = await attempt(h) { return r }
            i += 1
        }
        return nil
    }
}

/// When the Mac is looked for on the Wi-Fi (HubClient's finder; Android
/// HubClient.nearby): at most once a minute while no saved address answers,
/// the wait doubling to 15 minutes while nothing is found; a network change
/// (and finding the Mac) start it again at a minute. A request that comes
/// during a look waits for it and gets its answer.
actor Looks {
    static let every: TimeInterval = 60
    static let most: TimeInterval = 15 * 60
    private let look: () async -> [String]
    private var next: Date?
    private var gap = Looks.every
    private var found: [String] = []
    private var running: Task<[String], Never>?
    private(set) var count = 0

    init(_ look: @escaping () async -> [String]) { self.look = look }

    func get() async -> [String] {
        if let r = running { return await r.value }
        if let n = next, Date() < n { return found }
        let t = Task { await look() }
        running = t
        count += 1
        let f = await t.value
        running = nil
        found = f
        next = Date().addingTimeInterval(gap)
        gap = f.isEmpty ? min(gap * 2, Looks.most) : Looks.every
        return f
    }

    func reset() { next = nil; gap = Looks.every }
}

/// JSON the hub wrote, read here (an alert, a reply). JavaScript writes half of
/// an emoji alone as `\ud83d` when the hub cuts a string by length, and reads it
/// back; Foundation refuses the whole text. Such a half is read as U+FFFD.
enum Lenient {
    static func parse(_ text: String) -> Any? {
        if let o = try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed]) { return o }
        let fixed = loneHalves(text)
        guard fixed != text else { return nil }
        return try? JSONSerialization.jsonObject(with: Data(fixed.utf8), options: [.fragmentsAllowed])
    }

    static func object(_ text: String) -> [String: Any]? { parse(text) as? [String: Any] }

    /// Every `\uD800`-`\uDFFF` escape that is not half of a pair becomes `�`.
    static func loneHalves(_ s: String) -> String {
        let u = Array(s.utf16)
        var out = [UInt16]()
        out.reserveCapacity(u.count)
        func hex(_ i: Int) -> UInt16? {
            guard i + 6 <= u.count, u[i] == 0x5C, u[i + 1] == 0x75 else { return nil }
            var v: UInt16 = 0
            for c in u[(i + 2)..<(i + 6)] {
                let d: UInt16
                switch c { case 0x30...0x39: d = c - 0x30; case 0x41...0x46: d = c - 0x37; case 0x61...0x66: d = c - 0x57; default: return nil }
                v = v << 4 | d
            }
            return v
        }
        var i = 0
        var escaped = false
        while i < u.count {
            if !escaped, let v = hex(i) {
                if (0xD800...0xDBFF).contains(v), let w = hex(i + 6), (0xDC00...0xDFFF).contains(w) {
                    out.append(contentsOf: u[i..<(i + 12)]); i += 12; continue
                }
                if (0xD800...0xDFFF).contains(v) { out.append(contentsOf: Array("\\uFFFD".utf16)); i += 6; continue }
                out.append(contentsOf: u[i..<(i + 6)]); i += 6; continue
            }
            escaped = !escaped && u[i] == 0x5C
            out.append(u[i]); i += 1
        }
        return String(decoding: out, as: UTF16.self)
    }
}
