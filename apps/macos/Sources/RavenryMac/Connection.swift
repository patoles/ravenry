// One connection to ravenryd: the protocol's WebSocket (PROTOCOL.md
// section 1) over the daemon's unix socket, written here on a plain socket
// so nothing else is needed. Requests are JSON with ids; render frames
// come as binary messages and go to onBinary on the reader thread.

import Foundation

enum ConnectionError: Error, CustomStringConvertible {
    case connect(String)
    case handshake(String)
    case closed
    case daemon(code: String, message: String)
    case timeout

    var description: String {
        switch self {
        case .connect(let s): return "connect: \(s)"
        case .handshake(let s): return "handshake: \(s)"
        case .closed: return "the connection closed"
        case .daemon(let code, let message): return "\(code): \(message)"
        case .timeout: return "no answer in time"
        }
    }
}

final class Connection {
    typealias Reply = (Result<[String: Any], ConnectionError>) -> Void

    private let fd: Int32
    private let writeLock = NSLock()
    private let lock = NSLock()
    private var nextID: UInt64 = 0
    private var pending: [UInt64: Reply] = [:]
    private var closed = false
    private var inbuf = [UInt8]()
    private var inpos = 0

    /// A binary message (a frame) on a channel no route takes, on the
    /// reader thread.
    var onBinary: ((UnsafeRawBufferPointer) -> Void)?
    /// Each render stream's frames go to its own pane (route).
    private var routes: [UInt32: (UnsafeRawBufferPointer) -> Void] = [:]
    private let routeLock = NSLock()
    /// An event, on the reader thread.
    var onEvent: (([String: Any]) -> Void)?
    var onClose: (() -> Void)?
    private(set) var methods: Set<String> = []
    private(set) var daemonVersion = ""
    /// The newer daemon this one drains for (hello's daemon.draining), else "".
    private(set) var daemonDraining = ""
    /// Whether render.find takes case_sensitive and regex here: nil until
    /// asked (TerminalView.askFindOptions), false on an older daemon,
    /// which refuses them. Main thread.
    var findOptions: Bool?

    /// The daemon's socket (the layout file is kept by daemon: Layout.swift).
    private(set) var socketPath = ""

    init(socket path: String) throws {
        socketPath = path
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        if fd < 0 { throw ConnectionError.connect(String(cString: strerror(errno))) }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            Darwin.close(fd)
            throw ConnectionError.connect("socket path too long")
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { p in
            p.copyBytes(from: bytes)
            p[bytes.count] = 0
        }
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if ok != 0 {
            let e = String(cString: strerror(errno))
            Darwin.close(fd)
            throw ConnectionError.connect(e)
        }
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        try handshake()
    }

    /// A pane on a machine (MACH-006): the hub's terminal stream (GET
    /// /api/term?pane=, hub/server/termproxy.mjs), which joins this
    /// connection to the machine's daemon over ssh. The same protocol from
    /// the hello on; the hub lets through what draws and types into a pane.
    init(hub: URL, pane: String) throws {
        guard let host = hub.host, let port = hub.port ?? (hub.scheme == "http" ? 80 : nil) else { throw ConnectionError.connect("no board address") }
        socketPath = "\(hub.absoluteString)/api/term?pane=\(pane)"
        var hints = addrinfo(ai_flags: 0, ai_family: AF_INET, ai_socktype: SOCK_STREAM, ai_protocol: 0, ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
        var res: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, String(port), &hints, &res) == 0, let ai = res else { throw ConnectionError.connect("cannot find \(host)") }
        defer { freeaddrinfo(res) }
        fd = socket(ai.pointee.ai_family, ai.pointee.ai_socktype, ai.pointee.ai_protocol)
        if fd < 0 { throw ConnectionError.connect(String(cString: strerror(errno))) }
        // A throw from here closes fd in deinit (the instance is whole).
        if Darwin.connect(fd, ai.pointee.ai_addr, ai.pointee.ai_addrlen) != 0 { throw ConnectionError.connect(String(cString: strerror(errno))) }
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, socklen_t(MemoryLayout<Int32>.size))
        try handshake(path: "/api/term?pane=\(pane)", host: "\(host):\(port)")
    }

    deinit { Darwin.close(fd) }

    // MARK: handshake

    private func handshake(path: String = "/v1", host: String = "ravenryd") throws {
        var key = [UInt8](repeating: 0, count: 16)
        arc4random_buf(&key, 16)
        let req = "GET \(path) HTTP/1.1\r\nHost: \(host)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: \(Data(key).base64EncodedString())\r\n" +
            "Sec-WebSocket-Protocol: ravenry.v1\r\n\r\n"
        try writeAll(Array(req.utf8))
        // The response, up to the blank line.
        var head = [UInt8]()
        while true {
            guard let b = try readByte() else { throw ConnectionError.handshake("closed") }
            head.append(b)
            if head.count >= 4 && head.suffix(4) == [13, 10, 13, 10] { break }
            if head.count > 16384 { throw ConnectionError.handshake("response too long") }
        }
        let text = String(decoding: head, as: UTF8.self)
        guard text.hasPrefix("HTTP/1.1 101") else {
            throw ConnectionError.handshake(text.components(separatedBy: "\r\n").first ?? text)
        }
    }

    // MARK: reading

    private func fill() throws -> Bool {
        if inpos > 0 && inpos == inbuf.count {
            inbuf.removeAll(keepingCapacity: true)
            inpos = 0
        }
        var tmp = [UInt8](repeating: 0, count: 256 << 10)
        let n = tmp.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
        if n < 0 {
            if errno == EINTR { return true }
            throw ConnectionError.closed
        }
        if n == 0 { return false }
        if inpos > 0 {
            inbuf.removeFirst(inpos)
            inpos = 0
        }
        inbuf.append(contentsOf: tmp[0..<n])
        return true
    }

    private func readByte() throws -> UInt8? {
        while inpos >= inbuf.count {
            if try !fill() { return nil }
        }
        let b = inbuf[inpos]
        inpos += 1
        return b
    }

    private func need(_ n: Int) throws -> Bool {
        while inbuf.count - inpos < n {
            if try !fill() { return false }
        }
        return true
    }

    /// Starts the reader thread.
    func start() {
        let t = Thread { [weak self] in self?.readLoop() }
        t.name = "ravenry-reader"
        t.qualityOfService = .userInteractive
        t.start()
    }

    private func readLoop() {
        var message = [UInt8]()
        var messageOp: UInt8 = 0
        do {
            while true {
                guard try need(2) else { break }
                let b0 = inbuf[inpos], b1 = inbuf[inpos + 1]
                let fin = b0 & 0x80 != 0
                let op = b0 & 0x0f
                var len = Int(b1 & 0x7f)
                let masked = b1 & 0x80 != 0
                var hdr = 2
                if len == 126 {
                    guard try need(4) else { break }
                    len = Int(inbuf[inpos + 2]) << 8 | Int(inbuf[inpos + 3])
                    hdr = 4
                } else if len == 127 {
                    guard try need(10) else { break }
                    len = 0
                    for i in 0..<8 { len = len << 8 | Int(inbuf[inpos + 2 + i]) }
                    hdr = 10
                }
                var mask = [UInt8](repeating: 0, count: 4)
                if masked {
                    guard try need(hdr + 4) else { break }
                    for i in 0..<4 { mask[i] = inbuf[inpos + hdr + i] }
                    hdr += 4
                }
                guard try need(hdr + len) else { break }
                let start = inpos + hdr
                inpos = start + len
                if masked {
                    for i in 0..<len { inbuf[start + i] ^= mask[i & 3] }
                }
                switch op {
                case 0x8:
                    throw ConnectionError.closed
                case 0x9:
                    try send(opcode: 0xA, Array(inbuf[start..<start + len]))
                    continue
                case 0xA:
                    continue
                default:
                    break
                }
                if op != 0 { messageOp = op }
                if fin && message.isEmpty {
                    inbuf.withUnsafeBytes { p in
                        dispatch(op: messageOp, UnsafeRawBufferPointer(rebasing: p[start..<start + len]))
                    }
                } else {
                    message.append(contentsOf: inbuf[start..<start + len])
                    if fin {
                        message.withUnsafeBytes { dispatch(op: messageOp, $0) }
                        message.removeAll(keepingCapacity: true)
                    }
                }
            }
        } catch {}
        shutdown()
    }

    /// Sends a channel's frames to f (nil: drops them from now on).
    func route(_ channel: UInt32, _ f: ((UnsafeRawBufferPointer) -> Void)?) {
        routeLock.lock()
        routes[channel] = f
        routeLock.unlock()
    }

    private func dispatch(op: UInt8, _ p: UnsafeRawBufferPointer) {
        if op == 2 {
            // The frame header (PROTOCOL.md section 5): version, kind,
            // channel (4 bytes), mark.
            if p.count >= 6 {
                let ch = UInt32(p[2]) << 24 | UInt32(p[3]) << 16 | UInt32(p[4]) << 8 | UInt32(p[5])
                routeLock.lock()
                let f = routes[ch]
                routeLock.unlock()
                if let f { f(p); return }
            }
            onBinary?(p)
            return
        }
        guard let obj = try? JSONSerialization.jsonObject(with: Data(p)) as? [String: Any],
              let type = obj["type"] as? String else { return }
        switch type {
        case "result", "error":
            guard let id = (obj["id"] as? NSNumber)?.uint64Value else { return }
            lock.lock()
            let r = pending.removeValue(forKey: id)
            lock.unlock()
            if type == "result" {
                r?(.success(obj["result"] as? [String: Any] ?? [:]))
            } else {
                let e = obj["error"] as? [String: Any] ?? [:]
                r?(.failure(.daemon(code: e["code"] as? String ?? "?", message: e["message"] as? String ?? "")))
            }
        case "event":
            onEvent?(obj)
        default:
            break
        }
    }

    private func shutdown() {
        lock.lock()
        let was = closed
        closed = true
        let p = pending
        pending = [:]
        lock.unlock()
        for (_, r) in p { r(.failure(.closed)) }
        if !was { onClose?() }
    }

    // MARK: writing

    private func writeAll(_ b: [UInt8]) throws {
        var off = 0
        while off < b.count {
            let n = b.withUnsafeBytes { write(fd, $0.baseAddress! + off, b.count - off) }
            if n < 0 {
                if errno == EINTR { continue }
                throw ConnectionError.closed
            }
            off += n
        }
    }

    /// One WebSocket frame, masked as a client's must be.
    private func send(opcode: UInt8, _ payload: [UInt8]) throws {
        var f = [UInt8]()
        f.reserveCapacity(payload.count + 14)
        f.append(0x80 | opcode)
        let n = payload.count
        if n < 126 {
            f.append(0x80 | UInt8(n))
        } else if n < 65536 {
            f.append(0x80 | 126)
            f.append(UInt8(n >> 8)); f.append(UInt8(n & 0xff))
        } else {
            f.append(0x80 | 127)
            for i in (0..<8).reversed() { f.append(UInt8((n >> (8 * i)) & 0xff)) }
        }
        var mask = [UInt8](repeating: 0, count: 4)
        arc4random_buf(&mask, 4)
        f.append(contentsOf: mask)
        for i in 0..<n { f.append(payload[i] ^ mask[i & 3]) }
        writeLock.lock()
        defer { writeLock.unlock() }
        try writeAll(f)
    }

    func sendJSON(_ obj: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return }
        try? send(opcode: 1, [UInt8](d))
    }

    /// Sends a request; done runs on the reader thread.
    func request(_ method: String, _ params: [String: Any] = [:], done: Reply? = nil) {
        lock.lock()
        if closed {
            lock.unlock()
            done?(.failure(.closed))
            return
        }
        nextID += 1
        let id = nextID
        if let done { pending[id] = done } else { pending[id] = { _ in } }
        lock.unlock()
        var m = params
        m["v"] = 1
        m["type"] = method
        m["id"] = id
        sendJSON(m)
    }

    /// Sends a request and waits for its answer (not on the reader thread).
    func call(_ method: String, _ params: [String: Any] = [:], timeout: TimeInterval = 10) throws -> [String: Any] {
        let sem = DispatchSemaphore(value: 0)
        var out: Result<[String: Any], ConnectionError> = .failure(.timeout)
        request(method, params) { r in
            out = r
            sem.signal()
        }
        if sem.wait(timeout: .now() + timeout) == .timedOut { throw ConnectionError.timeout }
        return try out.get()
    }

    /// hello, which must come first.
    func hello(client: String, timeout: TimeInterval = 10) throws {
        let r = try call("hello", ["client": ["name": client, "version": "0.0.1"]], timeout: timeout)
        methods = Set(r["methods"] as? [String] ?? [])
        let d = r["daemon"] as? [String: Any]
        daemonVersion = d?["version"] as? String ?? ""
        daemonDraining = d?["draining"] as? String ?? ""
    }

    func close() {
        Darwin.shutdown(fd, SHUT_RDWR)
    }
}
