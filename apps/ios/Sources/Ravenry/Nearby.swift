// The paired Mac on the Wi-Fi (docs/PHONE.md, Finding the Mac on the
// Wi-Fi; the Android app's Nearby.kt): while phone access is on, the hub
// says `_ravenry._tcp` by Bonjour with its id in the TXT record
// (hub/server/nearby.mjs). When no saved Wi-Fi address answers (the Mac got
// a new address), HubClient asks here before Tailscale: only a service whose
// id is the paired Mac's (Pins.hubId) is taken, only its IPv4 address (the
// hub's phone port takes no other), and the pinned key still decides
// whether it is that Mac. Info.plist names the service (NSBonjourServices)
// and says why the app looks on the local network.

import Foundation
import Network

enum Nearby {
    static let service = "_ravenry._tcp"
    /// How long a look lasts at most; the Mac on the same Wi-Fi answers in well under a second.
    static let lookFor: TimeInterval = 3

    /// A service the look found: the id in its TXT record (nil: none), and its addresses.
    struct Service: Equatable { let id: String?; let addresses: [String] }

    /// The addresses of the services with this id: IPv4, not a tailnet one, each once.
    static func matching(_ found: [Service], id: String) -> [String] {
        var out: [String] = []
        for s in found where s.id == id {
            for a in s.addresses where IPv4Address(a) != nil && !Reach.tailnetHost(a) && !out.contains(a) { out.append(a) }
        }
        return out
    }

    /// The finder HubClient uses for the Mac with this pin.
    static func finder(pin: String) -> () async -> [String] {
        let id = Pins.hubId(pin)
        return { await look(id: id, timeout: lookFor) }
    }

    private final class Look: @unchecked Sendable {
        let lock = NSLock()
        var done = false
        var found: [Service] = []
        var asked = Set<String>()
        var connections: [NWConnection] = []
    }

    /// Browses for at most `timeout`, and asks each service with this id for
    /// its IPv4 address (a TCP connection to it, closed at once); ends at the
    /// first address.
    static func look(id: String, timeout: TimeInterval) async -> [String] {
        let t0 = Date()
        let found: [Service] = await withCheckedContinuation { (k: CheckedContinuation<[Service], Never>) in
            let q = DispatchQueue(label: "nearby")
            let b = NWBrowser(for: .bonjourWithTXTRecord(type: service, domain: nil), using: .tcp)
            let o = Look()
            @Sendable func finish() {
                let list: [Service]? = o.lock.withLock {
                    if o.done { return nil }
                    o.done = true
                    return o.found
                }
                guard let list else { return }
                b.cancel()
                o.lock.withLock { o.connections.forEach { $0.cancel() }; o.connections.removeAll() }
                k.resume(returning: list)
            }
            b.browseResultsChangedHandler = { results, _ in
                for r in results {
                    guard case .bonjour(let txt) = r.metadata, let rid = txt["id"], rid == id else { continue }
                    let key = "\(r.endpoint)"
                    let fresh = o.lock.withLock { o.asked.insert(key).inserted && !o.done }
                    guard fresh else { continue }
                    let p = NWParameters.tcp
                    if let ip = p.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
                    let c = NWConnection(to: r.endpoint, using: p)
                    o.lock.withLock { o.connections.append(c) }
                    c.stateUpdateHandler = { s in
                        switch s {
                        case .ready:
                            if case .hostPort(let host, _) = c.currentPath?.remoteEndpoint, case .ipv4(let a) = host {
                                let addr = "\(a)".split(separator: "%").first.map(String.init) ?? "\(a)"
                                o.lock.withLock { o.found.append(Service(id: rid, addresses: [addr])) }
                                c.cancel()
                                finish()
                            } else { c.cancel() }
                        case .failed, .waiting: c.cancel()
                        default: break
                        }
                    }
                    c.start(queue: q)
                }
            }
            b.stateUpdateHandler = { s in
                if case .failed(let e) = s { Log.say("nearby: the look did not start (\(e))"); finish() }
            }
            b.start(queue: q)
            q.asyncAfter(deadline: .now() + timeout) { finish() }
        }
        let out = matching(found, id: id)
        let ms = Int(Date().timeIntervalSince(t0) * 1000)
        Log.say(out.isEmpty ? "nearby: the paired Mac is not on this Wi-Fi (\(ms) ms)" : "nearby: found the paired Mac on the Wi-Fi at \(out.joined(separator: ", ")) in \(ms) ms")
        return out
    }
}
