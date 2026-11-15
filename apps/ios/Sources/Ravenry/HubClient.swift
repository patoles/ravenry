// Every byte between the iPhone and the hub (docs/PHONE.md section 2; the
// Android app's HubClient): TLS that trusts exactly one key, the pinned
// one, whoever signed the certificate; the device token on every request;
// `X-Ravenry: 1` on every write; the Mac's addresses tried in Route's order.
//
// A Wi-Fi address gets HOME_CONNECT seconds to accept a connection, as on
// Android. URLSession has no time to connect apart from its idle time, so
// a Wi-Fi address that has not answered in the last 20 s is first knocked
// on with a bare TCP connection (Network.framework) that has that limit;
// the same knock is where iOS says it keeps the app off the local network
// (Settings, Privacy, Local Network), which Reach turns into its words.

import Foundation
import Network

/// The pinned key's check, for every connection of a session.
final class PinnedTrust: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
    let pin: String?
    private let lock = NSLock()
    private var _seen: String?
    private var _refused = Set<String>()

    init(pin: String?) { self.pin = pin }

    /// The key the server showed last (a typed pairing compares it as the check number).
    var seen: String? { lock.lock(); defer { lock.unlock() }; return _seen }
    func refused(_ host: String) -> Bool { lock.lock(); defer { lock.unlock() }; return _refused.contains(host.lowercased()) }

    /// Whether this chain's leaf is the pinned key (any key, kept in `seen`, when there is no pin yet).
    func accepts(_ trust: SecTrust, host: String) -> Bool {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first,
              let p = Pins.of(certificate: SecCertificateCopyData(leaf) as Data) else { return false }
        lock.lock(); defer { lock.unlock() }
        _seen = p
        let ok = pin == nil || p == pin
        if ok { _refused.remove(host.lowercased()) } else { _refused.insert(host.lowercased()) }
        return ok
    }

    func urlSession(_ s: URLSession, didReceive c: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard c.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust, let t = c.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil); return
        }
        // The key is the computer's identity, not a name: an address on the
        // Wi-Fi or Tailscale has no certificate name to check.
        if accepts(t, host: c.protectionSpace.host) { completionHandler(.useCredential, URLCredential(trust: t)) }
        else { completionHandler(.cancelAuthenticationChallenge, nil) }
    }

    func urlSession(_ s: URLSession, task: URLSessionTask, didReceive c: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        urlSession(s, didReceive: c, completionHandler: completionHandler)
    }
}

/// Why a request reached no address: what Reach needs for its words.
struct HubFailure: Error, LocalizedError {
    var hosts: [String]
    var pinRefused = false
    var tailnetNameUnresolved = false
    var localNetworkDenied = false
    var underlying: String = ""
    var errorDescription: String? { pinRefused ? "The Mac answered with another key. Not paired." : underlying }
}

struct HubReply {
    let status: Int
    let headers: [String: String]
    let data: Data
    var text: String { String(decoding: data, as: UTF8.self) }
    var json: [String: Any]? { Lenient.object(text) }
    func header(_ n: String) -> String? { headers.first { $0.key.caseInsensitiveCompare(n) == .orderedSame }?.value }
}

final class HubClient {
    static let homeConnect: TimeInterval = 1.5

    let route: Route
    let port: Int
    let token: String?
    let trust: PinnedTrust
    let session: URLSession
    private let homeConnect: TimeInterval
    var onSignedOut: () -> Void = {}
    /// What iOS said at the last knock on a Wi-Fi address (Local Network off for Ravenry).
    private(set) var localNetworkDenied = false
    /// How long a knock waits while iOS keeps the app off the local network: a
    /// pairing's first request waits for the person's answer to iOS's ask.
    var localNetworkPatience: TimeInterval = 0
    private var warm: [String: Date] = [:]
    private let lock = NSLock()

    /// The connect target for a host: itself, except in tests (a stand-in name).
    var resolve: (String) -> String = { $0 }

    init(hosts: [String], port: Int, pin: String?, token: String?, homeConnect: TimeInterval = HubClient.homeConnect,
         isTailnet: @escaping (String) -> Bool = Reach.tailnetHost, skip: @escaping (String) -> Bool = { _ in false },
         onHost: @escaping (String) -> Void = { _ in }, cache: URLCache? = nil) {
        route = Route(hosts, isTailnet: isTailnet, skip: skip, onHost: onHost)
        self.port = port
        self.token = token
        self.homeConnect = homeConnect
        trust = PinnedTrust(pin: pin)
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 120
        cfg.httpCookieStorage = nil
        cfg.httpShouldSetCookies = false
        // The board's own files come with an ETag and no-cache (hub/server/static.mjs):
        // kept between reloads, asked again each time, a 304 when the same.
        cfg.urlCache = cache
        cfg.requestCachePolicy = cache == nil ? .reloadIgnoringLocalCacheData : .useProtocolCachePolicy
        session = URLSession(configuration: cfg, delegate: trust, delegateQueue: nil)
        // The live stream lasts as long as it is open: no limit on the whole
        // response, only on a silence (45 s, the request's own timeout).
        let sc = URLSessionConfiguration.default
        sc.timeoutIntervalForResource = 7 * 24 * 3600
        sc.httpCookieStorage = nil
        sc.requestCachePolicy = .reloadIgnoringLocalCacheData
        streaming = URLSession(configuration: sc, delegate: trust, delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel(); streaming.invalidateAndCancel() }

    /// The live stream's session (the same pinned key).
    let streaming: URLSession

    static func of(_ p: Paired, cache: URLCache? = nil, onHost: @escaping (String) -> Void = { _ in }) -> HubClient {
        let order = (p.lastHost.map { [$0] } ?? []) + p.hosts
        return HubClient(hosts: order, port: p.port, pin: p.pin, token: p.token, skip: Net.skip, onHost: onHost, cache: cache)
    }

    var host: String { route.host }
    var allHosts: [String] { route.hosts }

    func url(_ h: String, _ path: String) -> URL {
        let target = resolve(h)
        let hh = target.contains(":") && !target.hasPrefix("[") ? "[\(target)]" : target
        return URL(string: "https://\(hh):\(port)\(path)")!
    }

    func request(_ h: String, _ method: String, _ path: String, body: Data? = nil, headers: [String: String] = [:], timeout: TimeInterval = 30) -> URLRequest {
        var r = URLRequest(url: url(h, path), timeoutInterval: timeout)
        let m = method.uppercased()
        r.httpMethod = m
        if let t = token { r.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        if m != "GET" && m != "HEAD" { r.setValue("1", forHTTPHeaderField: "X-Ravenry"); r.httpBody = body ?? Data() }
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        return r
    }

    /// A Wi-Fi address that has not answered lately is knocked on first, within its short time to connect.
    private func knock(_ h: String) async -> Bool {
        if route.isTailnet(h) { return true }
        let w = lock.withLock { warm[h] }
        if let w, Date().timeIntervalSince(w) < 20 { return true }
        let r = await Knock.tcp(resolve(h), port: port, timeout: homeConnect, patience: localNetworkPatience)
        lock.withLock { localNetworkDenied = (r == .localNetworkDenied) }
        return r == .ready
    }

    private func answered(_ h: String) {
        lock.lock(); warm[h] = Date(); lock.unlock()
        route.answered(h)
    }

    private func failed(_ h: String) {
        lock.lock(); warm[h] = nil; lock.unlock()
        route.failed(h)
    }

    func networkChanged() { lock.lock(); warm.removeAll(); lock.unlock(); route.networkChanged() }

    private func failure(_ hosts: [String], _ errors: [(String, Error)]) -> HubFailure {
        var f = HubFailure(hosts: allHosts)
        f.pinRefused = errors.contains { trust.refused($0.0) }
        f.tailnetNameUnresolved = errors.contains { e in
            Reach.tailnetHost(e.0) && !e.0.first!.isNumber && [URLError.cannotFindHost, .dnsLookupFailed].contains((e.1 as? URLError)?.code ?? .unknown)
        }
        lock.lock(); f.localNetworkDenied = localNetworkDenied; lock.unlock()
        f.underlying = errors.last.map { "\($0.1.localizedDescription)" } ?? "No address can answer now"
        return f
    }

    /// Runs a request on the first address that answers. Throws HubFailure when none does.
    func execute(_ method: String, _ path: String, body: Data? = nil, headers: [String: String] = [:], timeout: TimeInterval = 30, check: Bool = false) async throws -> HubReply {
        let order = route.order(check: check)
        var errors: [(String, Error)] = []
        for h in order {
            guard await knock(h) else { failed(h); errors.append((h, URLError(.cannotConnectToHost))); continue }
            do {
                let (data, resp) = try await session.data(for: request(h, method, path, body: body, headers: headers, timeout: timeout))
                guard let r = resp as? HTTPURLResponse else { throw URLError(.badServerResponse) }
                answered(h)
                var hs: [String: String] = [:]
                for (k, v) in r.allHeaderFields { hs[String(describing: k)] = String(describing: v) }
                let reply = HubReply(status: r.statusCode, headers: hs, data: data)
                if r.statusCode == 401, reply.text.contains("\"signedOut\":true") { onSignedOut() }
                return reply
            } catch {
                failed(h)
                errors.append((h, error))
            }
        }
        throw failure(order, errors)
    }

    /// A JSON call: `json` is the body or nil.
    func call(_ method: String, _ path: String, json: Any? = nil) async throws -> HubReply {
        let body = try json.map { try JSONSerialization.data(withJSONObject: $0, options: [.fragmentsAllowed]) }
        return try await execute(method, path, body: body, headers: body != nil ? ["Content-Type": "application/json"] : [:])
    }

    /// How the Mac answers now: GET /api/phone/hello on the first address that
    /// answers within 5 s, every Wi-Fi address first, and the round trip in ms.
    func probe() async throws -> (host: String, ms: Int) {
        let t = Date()
        let r = try await execute("GET", "/api/phone/hello", timeout: 5, check: true)
        guard (200..<300).contains(r.status) else { throw HubFailure(hosts: allHosts, underlying: "HTTP \(r.status)") }
        return (host, Int(Date().timeIntervalSince(t) * 1000))
    }

    /// The host a stream opens on: the last that answered, unless it is not worth a try now.
    func streamHost() -> String { route.order().first ?? host }

    func events(_ path: String, onEvent: @escaping (String, String) -> Void, link: @escaping (Bool, String?) -> Void) -> EventStream {
        let s = EventStream(client: self, path: path, onEvent: onEvent, link: link)
        s.start()
        return s
    }

    func socket(_ path: String, protocol proto: String?) -> URLSessionWebSocketTask {
        let h = streamHost()
        var r = request(h, "GET", path)
        var c = URLComponents(url: r.url!, resolvingAgainstBaseURL: false)!
        c.scheme = "wss"
        r.url = c.url
        if let p = proto { r.setValue(p, forHTTPHeaderField: "Sec-WebSocket-Protocol") }
        return session.webSocketTask(with: r)
    }

    fileprivate func streamAnswered(_ h: String) { answered(h) }
    fileprivate func streamFailed(_ h: String) { failed(h) }
}

/// Server-sent events (GET /api/events): each `event:` with its `data:`.
/// Reconnects after a drop until closed; `link` says up or down. Between
/// tries it waits 1 s, doubling to 15 s; wake() (the network changed, the
/// Mac answered another request) ends the wait now. The hub says something
/// at least every 15 s (its heartbeat): 35 s without a byte, by the clock on
/// the wall (an iPad asleep in between too), and the connection is taken for
/// dead and made again, whatever URLSession thinks of it.
final class EventStream {
    static let silence = "silence"
    static var quiet: TimeInterval = 35
    private weak var client: HubClient?
    private let path: String
    private let onEvent: (String, String) -> Void
    private let link: (Bool, String?) -> Void
    private var task: Task<Void, Never>?
    private var closed = false
    private var waiter: CheckedContinuation<Void, Never>?
    private let lock = NSLock()

    init(client: HubClient, path: String, onEvent: @escaping (String, String) -> Void, link: @escaping (Bool, String?) -> Void) {
        self.client = client; self.path = path; self.onEvent = onEvent; self.link = link
    }

    func start() { task = Task.detached { [weak self] in await self?.loop() } }

    func close() {
        lock.lock(); closed = true; let w = waiter; waiter = nil; lock.unlock()
        w?.resume()
        task?.cancel()
    }

    func wake() { lock.lock(); let w = waiter; waiter = nil; lock.unlock(); w?.resume() }

    private var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closed }

    private func loop() async {
        var wait: UInt64 = 1_000
        while !isClosed {
            guard let c = client else { return }
            let h = c.streamHost()
            do {
                var r = c.request(h, "GET", path, timeout: 45)
                r.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                let (bytes, resp) = try await c.streaming.bytes(for: r)
                let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
                if status == 401 { c.onSignedOut(); lock.withLock { closed = true }; link(false, "signed out"); return }
                guard (200..<300).contains(status) else { throw URLError(.badServerResponse) }
                c.streamAnswered(h)
                link(true, nil)
                wait = 1_000
                let heard = Heard()
                let dog = Task.detached {
                    while !Task.isCancelled {
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                        if heard.since > EventStream.quiet { heard.dead = true; bytes.task.cancel(); return }
                    }
                }
                defer { dog.cancel() }
                var name = "message", data = "", line = [UInt8]()
                do {
                    for try await b in bytes {
                        if isClosed { break }
                        if b != 10 { line.append(b); continue }
                        heard.now()
                        if line.last == 13 { line.removeLast() }
                        let l = String(decoding: line, as: UTF8.self)
                        line.removeAll(keepingCapacity: true)
                        if l.isEmpty {
                            if !data.isEmpty { onEvent(name, data) }
                            name = "message"; data = ""
                        } else if l.hasPrefix(":") {
                        } else if l.hasPrefix("event:") {
                            name = l.dropFirst(6).trimmingCharacters(in: .whitespaces)
                        } else if l.hasPrefix("data:") {
                            var d = String(l.dropFirst(5)); if d.hasPrefix(" ") { d.removeFirst() }
                            data += data.isEmpty ? d : "\n" + d
                        }
                    }
                } catch where heard.dead {
                    c.streamFailed(h)
                }
                if !isClosed { link(false, heard.dead ? Self.silence : "the stream ended") }
            } catch {
                if isClosed { break }
                c.streamFailed(h)
                link(false, error.localizedDescription)
                // Another address may answer now (the Wi-Fi went, Tailscale is up).
                _ = try? await c.call("GET", "/api/phone/hello")
            }
            if isClosed { break }
            let ms = wait
            await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
                lock.lock(); waiter = k; lock.unlock()
                DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(Int(ms))) { [weak self] in self?.wake() }
            }
            wait = min(wait * 2, 15_000)
        }
    }
}

/// When the stream last said something (a line), by the wall clock.
private final class Heard: @unchecked Sendable {
    private let lock = NSLock()
    private var at = Date()
    private var _dead = false
    func now() { lock.withLock { at = Date() } }
    var since: TimeInterval { lock.withLock { Date().timeIntervalSince(at) } }
    var dead: Bool { get { lock.withLock { _dead } } set { lock.withLock { _dead = newValue } } }
}

/// A bare TCP connection to a host, to learn within a short time whether it
/// answers, and whether iOS keeps the app off the local network.
enum Knock {
    enum Result { case ready, failed, timeout, localNetworkDenied }

    private final class Once: @unchecked Sendable {
        let lock = NSLock()
        var done = false
        var denied = false
    }

    static func tcp(_ host: String, port: Int, timeout: TimeInterval, patience: TimeInterval = 0) async -> Result {
        await withCheckedContinuation { (k: CheckedContinuation<Result, Never>) in
            let c = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(integerLiteral: UInt16(clamping: port)), using: .tcp)
            let q = DispatchQueue(label: "knock")
            let o = Once()
            @Sendable func finish(_ r: Result) {
                let first = o.lock.withLock { () -> Bool in if o.done { return false }; o.done = true; return true }
                guard first else { return }
                c.stateUpdateHandler = nil
                c.cancel()
                k.resume(returning: r)
            }
            let denied = { o.lock.withLock { o.denied } }
            c.stateUpdateHandler = { s in
                switch s {
                case .ready: finish(.ready)
                case .failed: finish(denied() ? .localNetworkDenied : .failed)
                case .waiting:
                    if c.currentPath?.unsatisfiedReason == .localNetworkDenied {
                        o.lock.withLock { o.denied = true }
                        // iOS's ask may be on screen: wait for the answer (pairing), else say so now.
                        if patience <= 0 { finish(.localNetworkDenied) }
                    } else { finish(.failed) }
                default: break
                }
            }
            c.start(queue: q)
            q.asyncAfter(deadline: .now() + timeout) { if !denied() { finish(.timeout) } }
            q.asyncAfter(deadline: .now() + max(timeout, patience)) { finish(denied() ? .localNetworkDenied : .timeout) }
        }
    }
}
