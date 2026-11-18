// The phone board in one WKWebView, and the bridge to it (docs/PHONE.md
// sections 1 and 7; the Android app's MainActivity). The page is served at
// ravenry-app://phone/ by a WKURLSchemeHandler: the app's own screens from
// the app (/phone/...), the board itself and its files from the hub through
// HubClient, so the pin and the token never leave the shell. The board
// sits under the status bar and runs to the screen's foot, where its bottom
// bar keeps clear of the home indicator (viewport-fit=cover), as round 1
// drew it; with the keyboard up the web view shrinks to the keyboard's top.
// On an iPad (C, picked 2026-11-15) its width follows the room the app
// has, live on a rotation and in Split View: see `width(of:page:pad:)`.

import UIKit
import WebKit
import LocalAuthentication
import UserNotifications

/// The paired computer's client, shared by the board, the connection watch and the alerts.
enum Hub {
    private static var cached: (Paired, HubClient)?
    static let cache = URLCache(memoryCapacity: 4 << 20, diskCapacity: 16 << 20, directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("board"))
    static var onSignedOut: () -> Void = {}

    static func client() -> HubClient? {
        guard let p = Store.shared.paired() else { return nil }
        if let c = cached, c.0.token == p.token, c.0.pin == p.pin, c.0.hosts == p.hosts { return c.1 }
        let c = HubClient.of(p, cache: cache) { h in Store.shared.rememberHost(h) }
        c.onSignedOut = { DispatchQueue.main.async { onSignedOut() } }
        cached = (p, c)
        return c
    }

    static func reset() { cached = nil }
}

final class BoardController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    static let origin = "ravenry-app://phone"
    private(set) var web: WKWebView!
    private let scheme = SchemeHandler()
    private var events: EventStream?
    private var eventsWanted = false
    private var sockets: [Int: URLSessionWebSocketTask] = [:]
    private var nextSid = 1
    /// A body's parts on their way (`http.part`: a file the board attaches, src/board.ts), by upload.
    private var parts: [String: Data] = [:]
    private var light = false
    private var keyboardTop: CGFloat?
    let secret = SecretField()
    lazy var conn = ConnWatch(board: self)
    var ink: InkLaunch?
    /// The alert that opened the app, for the page's hello.
    var pending: [String: Any]?
    private var helloed = false
    /// Back from the background: the stream and the connection watch start over at once.
    private var wasAway = false
    /// Since when a live update waits for the page to take it (nil: none waits).
    private var unackedSince: Date?
    private var pageWatch: Timer?
    private var lastDeliveryLog = Date.distantPast
    /// The demo (src/demo.ts): sample projects, no Mac, no connection; its web view keeps nothing (a store of its own, in memory).
    var demo = false
    /// The ops that would reach a hub: refused in the demo (its page never sends them).
    static let hubOps: Set<String> = ["http", "http.part", "hub.call", "hub.events", "socket.open", "socket.send", "socket.close", "reach.retry", "conn.reconnect",
        "secret.open", "secret.move", "secret.send", "secret.close", "open.tailscale", "speech", "photo", "voice.start", "voice.stop", "voice.cancel", "push.set", "connection.set"]

    /// The board says its own colours (`bars`); the app's own pages (/phone/: a
    /// checkpoint's screen, settings) follow the phone's dark or light, so the
    /// status bar does too there, also after a switch.
    override var preferredStatusBarStyle: UIStatusBarStyle {
        if web?.url?.path.hasPrefix("/phone/") == true { return traitCollection.userInterfaceStyle == .light ? .darkContent : .lightContent }
        return light ? .darkContent : .lightContent
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Shared.dynamic("win")
        light = traitCollection.userInterfaceStyle == .light
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (c: BoardController, _: UITraitCollection) in c.setNeedsStatusBarAppearanceUpdate() }
        let c = WKWebViewConfiguration()
        scheme.demo = demo
        c.setURLSchemeHandler(scheme, forURLScheme: "ravenry-app")
        // The demo leaves no trace: its storage lives in memory and goes with this web view.
        c.websiteDataStore = demo ? .nonPersistent() : .default()
        c.preferences.javaScriptCanOpenWindowsAutomatically = true
        c.allowsInlineMediaPlayback = true
        // The channel the page's shell.ts looks for: posts go to the shell, replies and events come back through __rvRecv.
        c.userContentController.addUserScript(WKUserScript(source: Self.channel, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        // Through a weak hop: the content controller keeps its handler, and a board
        // that is replaced (signed out, paired again) must go, with its stream.
        c.userContentController.add(WeakShell(self), contentWorld: .page, name: "ravenryShell")
        let w = WKWebView(frame: .zero, configuration: c)
        w.isOpaque = false
        w.backgroundColor = .clear
        w.scrollView.backgroundColor = .clear
        w.scrollView.contentInsetAdjustmentBehavior = .never
        w.navigationDelegate = self
        w.uiDelegate = self
        #if DEBUG
        w.isInspectable = true
        #endif
        view.addSubview(w)
        web = w
        secret.board = self
        NotificationCenter.default.addObserver(self, selector: #selector(keyboard(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboard(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
        w.load(URLRequest(url: URL(string: "\(Self.origin)/")!))
        #if DEBUG
        TestDrive.start(self)
        #endif
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutWeb()
    }

    /// The web view's width in the room the app has (C, picked 2026-11-15). On
    /// an iPad: the board's own wide layout (the projects beside the open project)
    /// where it fits, from 1000 pt (an 11-inch sideways, a 13-inch either way); else
    /// the phone board in a centred column of 700 pt, the widest its phone layout
    /// takes (an 11-inch upright, Split View, Slide Over). The app's own pages (a
    /// checkpoint's screen, settings) in a centred column of 640 pt. An iPhone: the
    /// whole width, as before.
    static func width(of room: CGFloat, page: Bool, pad: Bool) -> CGFloat {
        guard pad else { return room }
        if page { return min(room, 640) }
        return room >= 1000 ? room : min(room, 700)
    }

    #if DEBUG
    /// For the checks only (TestDrive): the room of a Split View or Slide Over, drawn from the left.
    var testRoom: CGFloat?
    #endif

    /// Under the status bar; to the screen's foot, or to the keyboard's top while it is up.
    private func layoutWeb() {
        let top = view.safeAreaInsets.top
        let bottom = keyboardTop.map { min($0, view.bounds.height) } ?? view.bounds.height
        var room = view.bounds.width, left: CGFloat = 0
        #if DEBUG
        if let r = testRoom { room = min(r, room); left = 0 }
        #endif
        let w = Self.width(of: room, page: web.url?.path.hasPrefix("/phone/") == true, pad: Device.pad)
        let f = CGRect(x: left + ((room - w) / 2).rounded(), y: top, width: w, height: max(0, bottom - top))
        if web.frame != f { web.frame = f }
    }

    @objc private func keyboard(_ n: Notification) {
        let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect).map { view.convert($0, from: nil) }
        keyboardTop = (n.name == UIResponder.keyboardWillHideNotification || end == nil || end!.minY >= view.bounds.height) ? nil : end!.minY
        UIView.performWithoutAnimation { layoutWeb() }
    }

    /// The app in front. Back from the background, nothing of before is trusted: iOS
    /// may have frozen the stream's connection or left it half dead while the app
    /// was away (an iPad that slept), so the stream opens again now (the hub's
    /// first event is the whole state: every card opened meanwhile) and the
    /// connection watch checks at once, from a clean start.
    func appeared() {
        let back = wasAway
        wasAway = false
        if demo { event(["event": "alerts", "on": AlertCenter.shared.allowed]); return }
        if back {
            Hub.client()?.networkChanged()
            restartEventsIfWanted()
        }
        conn.start(fresh: back)
        event(["event": "alerts", "on": AlertCenter.shared.allowed])
        watchPage(true)
    }

    /// The app in the background: the stream closes (iOS would freeze it), the watch stops.
    func disappeared() {
        wasAway = true
        conn.stop()
        watchPage(false)
        if events != nil { events?.close(); events = nil; Log.say("live stream: closed while the app is away") }
    }

    deinit { events?.close(); pageWatch?.invalidate() }

    static let channel = """
    (function(){var l=[];var ch={onmessage:null,postMessage:function(t){window.webkit.messageHandlers.ravenryShell.postMessage(String(t))},addEventListener:function(ty,f){if(ty==='message')l.push(f)}};
    Object.defineProperty(window,'ravenryShell',{value:ch,configurable:false,writable:false});
    window.__rvRecv=function(s){var ev={data:s};l.forEach(function(f){try{f(ev)}catch(e){console.error(e)}});if(ch.onmessage)ch.onmessage(ev)};})();
    """

    // ------------------------------------------------------------ the bridge

    /// One message to the page. `text` is JSON as the hub wrote it, put at `key` (a dotted path) in
    /// the message by the page's own JSON.parse: never read and written again
    /// here, since Foundation refuses JSON that JavaScript writes and reads (half
    /// of an emoji, alone, in a string cut by length) and the board would get
    /// the hub's text in place of its state, or nothing.
    private func post(_ o: [String: Any], text: String? = nil, at key: String = "data", done: ((Bool) -> Void)? = nil) {
        guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.fragmentsAllowed]) else {
            Log.say("board: a message for the page could not be written (\(o["event"] as? String ?? "a reply"))")
            done?(false)
            return
        }
        let s = String(decoding: d, as: UTF8.self)
        DispatchQueue.main.async {
            guard let w = self.web else { done?(false); return }
            let handled: (Result<Any, Error>) -> Void = { r in
                if case .failure(let e) = r { self.undelivered(o, e) }
                done?((try? r.get()) != nil)
            }
            if let text {
                w.callAsyncJavaScript(Self.withText, arguments: ["m": s, "t": text, "k": key], in: nil, in: .page, completionHandler: handled)
            } else {
                w.callAsyncJavaScript("if (window.__rvRecv) window.__rvRecv(m); return 1;", arguments: ["m": s], in: nil, in: .page, completionHandler: handled)
            }
        }
    }

    /// The message with the hub's JSON put in by the page (as it is, if it is not JSON), handed over as text.
    static let withText = "const o = JSON.parse(m); let v; try { v = JSON.parse(t); } catch (e) { v = t; } const p = k.split('.'); let at = o; for (const x of p.slice(0, -1)) at = at[x]; at[p[p.length - 1]] = v; if (window.__rvRecv) window.__rvRecv(JSON.stringify(o)); return 1;"

    private func undelivered(_ o: [String: Any], _ e: Error) {
        guard Date().timeIntervalSince(lastDeliveryLog) > 60 else { return }
        lastDeliveryLog = Date()
        Log.say("board: a message did not reach the page (\(o["event"] as? String ?? "a reply"): \(e.localizedDescription))")
    }

    /// A live update the page has not taken within 15 s (its process stuck or gone
    /// quiet): the page loads again, from the hub's whole state.
    private func watchPage(_ on: Bool) {
        pageWatch?.invalidate(); pageWatch = nil
        unackedSince = nil
        guard on else { return }
        pageWatch = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            guard let self, let t = self.unackedSince, Date().timeIntervalSince(t) > 15 else { return }
            self.unackedSince = nil
            Log.say("board: the page took no live update for 15 s; loading it again")
            self.web?.reload()
        }
    }

    /// A hub event, its data as the hub wrote it; `first`: the first state of a new stream, said in the log once taken.
    private func hubEvent(_ name: String, _ data: String, first: Bool) {
        DispatchQueue.main.async { if self.unackedSince == nil { self.unackedSince = Date() } }
        post(["event": "hub", "name": name], text: data) { ok in
            DispatchQueue.main.async {
                if ok { self.unackedSince = nil }
                if first { Log.say("board: \(ok ? "the page has" : "the page did not take") the Mac's state (\(data.utf8.count / 1024) KB)") }
            }
        }
    }

    func reply(_ id: Int, _ result: Any? = nil) { post(["id": id, "ok": true, "result": result ?? NSNull()]) }
    func fail(_ id: Int, _ error: String) { post(["id": id, "ok": false, "error": error]) }
    func event(_ o: [String: Any]) { post(o) }

    func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage) {
        // Only the page itself: the main frame of the app's own origin.
        guard m.frameInfo.isMainFrame, m.frameInfo.securityOrigin.protocol == "ravenry-app", m.frameInfo.securityOrigin.host == "phone",
              let s = m.body as? String, let o = (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] else { return }
        let id = o["id"] as? Int ?? -1
        if (o["v"] as? Int ?? 1) != 1 { fail(id, "This app speaks bridge version 1."); return }
        handle(id, o["op"] as? String ?? "", o)
    }

    private func hub() -> HubClient? { Hub.client() }

    var features: [String] {
        var f = ["secret", "alerts.state", "http.parts"]
        let ctx = LAContext()
        let can = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        // The demo asks for Face ID before Run only when it is set up: a phone with none still sees the command run.
        if demo ? can : ctx.biometryType != .none { f.append("biometric") }
        return f
    }

    /// Out of the demo (its bar's Pair your Mac, Leave the demo): the pairing screen; the demo's alert leaves the list.
    private func leaveDemo() {
        AlertCenter.shared.clearDemo()
        Log.say("demo: left, \(scheme.served) of the app's own files served, no connection made")
        (view.window?.windowScene?.delegate as? SceneDelegate)?.showPairing()
    }

    private func handle(_ id: Int, _ op: String, _ o: [String: Any]) {
        if demo && Self.hubOps.contains(op) { fail(id, "Not in the demo."); return }
        switch op {
        case "demo.leave":
            reply(id)
            if demo { DispatchQueue.main.async { self.leaveDemo() } }
            return
        case "demo.alert":
            guard demo, let a = o["alert"] as? [String: Any] else { reply(id, ["posted": false]); return }
            reply(id, ["posted": AlertCenter.shared.demoAlert(a)])
            return
        default: break
        }
        switch op {
        case "hello":
            let p = Store.shared.paired()
            helloed = true
            let hubInfo: [String: Any] = ["name": MacName.say(p?.hubName), "port": (p?.port).map { $0 as Any } ?? NSNull()]
            let device: [String: Any] = ["id": (p?.deviceId).map { $0 as Any } ?? NSNull(), "name": (p?.deviceName).map { $0 as Any } ?? NSNull()]
            var hello: [String: Any] = ["v": 1, "platform": "ios", "form": Device.form, "app": PairModel.appVersion, "hub": hubInfo, "device": device, "features": features]
            hello["pending"] = pending.map { $0 as Any } ?? NSNull()
            hello["launch"] = ink != nil ? "ink" : "warm"
            if demo { hello["demo"] = true; hello["hub"] = NSNull(); hello["device"] = NSNull() }
            reply(id, hello)
            pending = nil
        case "http":
            let method = (o["method"] as? String ?? "GET").uppercased()
            guard let path = o["path"] as? String, path.hasPrefix("/") else { fail(id, "A path starts with /."); return }
            // A body sent in parts (http.part) is the parts put together, taken here.
            var body = (o["b64"] as? String).flatMap { Data(base64Encoded: $0) }
            if let u = o["upload"] as? String { guard let d = parts.removeValue(forKey: u) else { fail(id, "Not an upload."); return }; body = d }
            var headers: [String: String] = [:]
            for (k, v) in o["headers"] as? [String: Any] ?? [:] where ["content-type", "x-filename", "accept"].contains(k.lowercased()) { headers[k] = v as? String }
            let asked = Date()
            Task {
                guard let c = hub() else { fail(id, "This \(Device.word) is not paired."); return }
                do {
                    let r = try await c.execute(method, path, body: method == "GET" || method == "HEAD" ? nil : (body ?? Data()), headers: headers)
                    answered()
                    reply(id, ["status": r.status, "type": r.header("Content-Type") ?? "application/octet-stream", "b64": r.data.base64EncodedString()])
                } catch { fail(id, unreachable(error, asked: asked)) }
            }
        case "http.part":
            // One part of a body too big for one message, added in order; `http` with `upload` sends it.
            guard let u = o["upload"] as? String, u.range(of: "^[A-Za-z0-9_-]{4,64}$", options: .regularExpression) != nil else { fail(id, "Not an upload."); return }
            guard let d = (o["b64"] as? String).flatMap({ Data(base64Encoded: $0) }) else { parts[u] = nil; fail(id, "It could not be read."); return }
            // A cap above the hub's 64 MB a file (POST /api/inbox, which src/board.ts checks first).
            if (parts[u]?.count ?? 0) + d.count > 96 * 1024 * 1024 { parts[u] = nil; fail(id, "Too big to send."); return }
            parts[u, default: Data()].append(d)
            reply(id)
        case "hub.call":
            let method = o["method"] as? String ?? "GET"
            guard let path = o["path"] as? String, path.hasPrefix("/") else { fail(id, "A path starts with /."); return }
            let b = o["body"]
            let asked = Date()
            Task {
                guard let c = hub() else { fail(id, "This \(Device.word) is not paired."); return }
                do {
                    let r = try await c.call(method, path, json: b is NSNull ? nil : b)
                    answered()
                    // The body as the hub wrote it, read by the page (see post).
                    if r.data.isEmpty { reply(id, ["status": r.status, "body": NSNull()]) }
                    else { post(["id": id, "ok": true, "result": ["status": r.status]], text: r.text, at: "result.body") }
                } catch { fail(id, unreachable(error, asked: asked)) }
            }
        case "hub.events":
            eventsWanted = o["on"] as? Bool ?? true
            startEvents()
            reply(id)
        case "reach.now": reply(id, demo ? nil : lastReach)
        case "reach.retry":
            lastReach = nil
            reply(id)
            Task {
                do { _ = try await hub()?.call("GET", "/api/phone/hello"); answered(); web.reload() } catch { _ = unreachable(error) }
            }
        case "bars":
            light = o["light"] as? Bool ?? false
            if let c = o["color"] as? String, c.contains("(") { view.backgroundColor = Shared.parse(c) }
            setNeedsStatusBarAppearanceUpdate()
            ink?.colorChanged(view.backgroundColor)
            reply(id)
        case "open.tailscale": Net.openTailscale(); reply(id)
        case "open.settings", "alerts.settings":
            UIApplication.shared.open(URL(string: UIApplication.openNotificationSettingsURLString)!); reply(id)
        case "alerts.state": reply(id, ["on": AlertCenter.shared.allowed])
        case "alerts.clear":
            if let a = o["id"] as? String { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [a]) }
            reply(id)
        case "conn.now": reply(id, demo ? nil : conn.json())
        case "conn.reconnect": conn.reconnect(); reply(id)
        case "ink.ready": ink?.ready(o, board: self); reply(id)
        case "biometric":
            Biometrics.ask(reason: o["title"] as? String ?? "Run") { ok, err in
                if ok { self.reply(id, ["ok": true]) } else { self.fail(id, err ?? "Not confirmed.") }
            }
        case "secret.open":
            guard let cp = o["checkpoint"] as? String else { fail(id, "Which checkpoint?"); return }
            secret.open(checkpoint: cp, rect: o["rect"] as? [String: Any] ?? [:], dark: o["dark"] as? Bool ?? !light, size: o["size"] as? Double ?? 16)
            reply(id)
        case "secret.move":
            if let r = o["rect"] as? [String: Any] { secret.move(r) }
            if let rv = o["reveal"] as? Bool { secret.reveal(rv) }
            reply(id)
        case "secret.send": secret.send(id)
        case "secret.close": secret.close(); reply(id)
        case "socket.open": openSocket(id, o)
        case "socket.send":
            guard let ws = sockets[o["sid"] as? Int ?? -1] else { fail(id, "That connection is closed."); return }
            let msg: URLSessionWebSocketTask.Message = (o["b64"] as? String).flatMap { Data(base64Encoded: $0) }.map { .data($0) } ?? .string(o["text"] as? String ?? "")
            ws.send(msg) { e in if e != nil { self.fail(id, "That connection is closed.") } else { self.reply(id) } }
        case "socket.close":
            sockets.removeValue(forKey: o["sid"] as? Int ?? -1)?.cancel(with: .normalClosure, reason: nil)
            reply(id)
        case "pair.reset":
            if demo { reply(id); leaveDemo(); return }
            // The screen changes on the tap; the computer is told in the background, now and later until it answers.
            reply(id)
            events?.close(); events = nil
            Revokes.signOut()
            (view.window?.windowScene?.delegate as? SceneDelegate)?.showPairing()
        case "back.done": reply(id)
        default: fail(id, "This \(Device.model) app does not do \(op) yet.")
        }
    }

    // ------------------------------------------------------------ the live stream

    func startEvents() {
        events?.close(); events = nil
        guard eventsWanted, let c = hub() else { return }
        // The first state of each connection is said in the log once the page has it.
        let firstState = Once()
        events = c.events("/api/events", onEvent: { [weak self] name, data in
            self?.hubEvent(name, data, first: name == "state" && firstState.take())
            if name == "phone", let m = Lenient.object(data) { DispatchQueue.main.async { AlertCenter.shared.message(m) } }
        }, link: { [weak self] up, err in
            if up { firstState.reset() }
            DispatchQueue.main.async {
                guard let self else { return }
                Log.say("live stream: \(up ? "open" : "down (\(err == nil || err == "the stream ended" ? "the Mac ended it" : err == EventStream.silence ? "no word from the Mac for 35 s" : err == "signed out" ? "signed out" : "no answer"))")")
                if up { self.answered() }
                let words: Any = up ? NSNull() : (err == "signed out" ? err! : Net.why(nil, hosts: c.allHosts).words)
                self.event(["event": "link", "state": up ? "up" : "down", "error": words])
                if up { self.conn.linkUp() } else if err != "signed out" { self.conn.linkDown() }
            }
        })
    }

    func restartEventsIfWanted() { if eventsWanted { startEvents() } }

    private func openSocket(_ id: Int, _ o: [String: Any]) {
        guard let c = hub(), let path = o["path"] as? String else { fail(id, "This \(Device.word) is not paired."); return }
        let sid = nextSid; nextSid += 1
        let ws = c.socket(path, protocol: o["protocol"] as? String)
        sockets[sid] = ws
        ws.resume()
        func receive() {
            ws.receive { [weak self] r in
                guard let self else { return }
                switch r {
                case .success(.string(let t)): self.event(["event": "socket.message", "sid": sid, "text": t]); receive()
                case .success(.data(let d)): self.event(["event": "socket.message", "sid": sid, "b64": d.base64EncodedString()]); receive()
                case .success: receive()
                case .failure(let e):
                    DispatchQueue.main.async { self.sockets.removeValue(forKey: sid) }
                    self.event(["event": "socket.close", "sid": sid, "code": ws.closeCode == .invalid ? 1006 : ws.closeCode.rawValue, "reason": e.localizedDescription])
                }
            }
        }
        receive()
        reply(id, ["sid": sid])
    }

    // ------------------------------------------------------------ reaching the Mac

    /// The last reason the computer could not be reached, for the board's bar (nil once it answers).
    var lastReach: [String: Any]?
    private var answeredAt = Date.distantPast

    /// The hub answered: whatever said it could not be reached goes, by every path.
    func answered() {
        DispatchQueue.main.async {
            self.answeredAt = Date()
            self.clearReach()
            if self.conn.state != "up" { self.conn.heard() }
        }
    }

    func clearReach() {
        guard lastReach != nil else { return }
        lastReach = nil
        event(["event": "reach", "reason": NSNull(), "words": NSNull()])
    }

    @discardableResult
    func reachOf(_ f: HubFailure?, hosts: [String]) -> Reach.Why {
        let w = Net.why(f, hosts: hosts)
        lastReach = ["reason": w.reason, "words": w.words]
        return w
    }

    /// What a failed request says: why the computer cannot be reached, never a host name.
    func unreachable(_ e: Error, asked: Date = Date()) -> String {
        guard let f = e as? HubFailure else { return e.localizedDescription }
        let hosts = hub()?.allHosts ?? []
        if f.pinRefused { return "The Mac answered with another key." }
        if asked < answeredAt { return Net.why(f, hosts: hosts).words }
        let w = reachOf(f, hosts: hosts)
        DispatchQueue.main.async {
            if let r = self.lastReach { var ev = r; ev["event"] = "reach"; self.event(ev) }
            self.conn.suspect()
        }
        return w.words
    }

    // ------------------------------------------------------------ navigation

    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let u = a.request.url else { decisionHandler(.cancel); return }
        if u.scheme == "ravenry-app" { decisionHandler(.allow); return }
        // Links leave the app for Safari.
        if u.scheme == "https" || u.scheme == "http" { UIApplication.shared.open(u) }
        decisionHandler(.cancel)
    }

    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url, u.scheme == "https" || u.scheme == "http" { UIApplication.shared.open(u) }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { Log.say("board: the page's process ended; loading it again"); w.reload() }

    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { Log.say("board: page loaded (\(w.url?.path ?? ""))"); setNeedsStatusBarAppearanceUpdate() }

    func webView(_ w: WKWebView, didCommit n: WKNavigation!) {
        // Above the app's own pages, the window's colour of the phone's dark or light (the board says its own).
        if w.url?.path.hasPrefix("/phone/") == true { view.backgroundColor = Shared.dynamic("win") }
        // The board and the app's own pages each have their width on an iPad.
        layoutWeb()
        setNeedsStatusBarAppearanceUpdate()
    }
}

/// The page's channel through a weak hop (WKUserContentController keeps its handler).
final class WeakShell: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(u, didReceive: m) }
}

/// A flag taken once until reset, from any thread.
final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var armed = true
    func take() -> Bool { lock.withLock { let a = armed; armed = false; return a } }
    func reset() { lock.withLock { armed = true } }
}

/// Serves ravenry-app://phone/: the app's own screens from the app, the
/// board and its files from the hub (docs/PHONE.md section 1).
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    private var live = Set<ObjectIdentifier>()
    static let bundle = Bundle.main.url(forResource: "phone", withExtension: nil)
    /// The demo: the app's own files only, never the hub (`demoResource`).
    var demo = false
    /// How many of the app's own files the demo served (the log's line when it is left).
    private(set) var served = 0
    private lazy var demoFiles: [String: [String: String]] = {
        guard let base = Self.bundle, let d = try? Data(contentsOf: base.appendingPathComponent("demo/files.json")),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: [String: String]] else { return [:] }
        return o
    }()
    /// The policy of the demo's board page: its own files only, never another origin.
    static let demoCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' data: blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"

    /// A recorded hub path's key, as the recording has it: the cache-busting `v` left out (apps/phone/src/demo.ts keyOf).
    static func demoKey(_ path: String, _ query: String?) -> String {
        let q = (query ?? "").split(separator: "&").filter { !$0.isEmpty && !$0.hasPrefix("v=") }.joined(separator: "&")
        return q.isEmpty ? path : "\(path)?\(q)"
    }

    /// The demo's side of the origin: the board's page as the hub has it (built into the app from hub/public), with the
    /// app's layer first marked as the demo's; its files; the recording's pictures. Anything else is not there.
    private func demoResource(_ task: WKURLSchemeTask, _ req: URLRequest, _ path: String, _ query: String?) {
        guard req.httpMethod ?? "GET" == "GET", let base = Self.bundle else { return finish(task, 404, Data(), "text/plain") }
        served += 1
        if path == "/" || path == "/index.html" {
            guard var html = (try? Data(contentsOf: base.appendingPathComponent("board/index.html"))).map({ String(decoding: $0, as: UTF8.self) }) else { return finish(task, 404, Data(), "text/plain") }
            if let i = html.range(of: "<head>") { html.replaceSubrange(i, with: "<head>\n<script src=\"/phone/board.js\" data-demo></script>") }
            html = html.replacingOccurrences(of: "width=device-width", with: "width=device-width, viewport-fit=cover")
            return finish(task, 200, Data(html.utf8), "text/html; charset=utf-8", ["Cache-Control": "no-store", "Content-Security-Policy": Self.demoCSP])
        }
        if path.hasPrefix("/api/") {
            guard let f = demoFiles[Self.demoKey(path, query)], let name = f["file"], !name.contains(".."),
                  let d = try? Data(contentsOf: base.appendingPathComponent("demo/\(name)")) else { return finish(task, 404, Data(), "text/plain") }
            return finish(task, 200, d, f["type"] ?? Self.type(name), ["Cache-Control": "no-store"])
        }
        let rel = String(path.dropFirst())
        guard !rel.contains(".."), let d = try? Data(contentsOf: base.appendingPathComponent("board/\(rel)")) else { return finish(task, 404, Data(), "text/plain") }
        finish(task, 200, d, Self.type(rel), ["Cache-Control": "no-store"])
    }

    func webView(_ w: WKWebView, start task: WKURLSchemeTask) {
        live.insert(ObjectIdentifier(task))
        let req = task.request
        guard let url = req.url else { return finish(task, 400, Data(), "text/plain") }
        let path = url.path.isEmpty ? "/" : url.path
        let query = url.query.map { "?\($0)" } ?? ""
        // The demo: the app's own files only (the hub's side of the origin from the recording), never the hub.
        if demo && (path.hasPrefix("/phone/hub/") || !path.hasPrefix("/phone/")) {
            return demoResource(task, req, path.hasPrefix("/phone/hub/") ? String(path.dropFirst("/phone/hub".count)) : path, url.query)
        }
        if path.hasPrefix("/phone/hub/") {
            // Only the page itself: a frame of another origin never reads the hub through this door.
            guard req.httpMethod ?? "GET" == "GET", Self.allowed(req) else { return refuse(task, req) }
            let p = String(path.dropFirst("/phone/hub".count)) + query
            if let r = Self.range(req), let part = MediaBlocks.part(r) { return mediaPart(task, p, part, range: r) }
            return hubResource(task, p, range: Self.range(req))
        }
        if path.hasPrefix("/phone/") {
            var rel = String(path.dropFirst("/phone/".count))
            if rel.isEmpty { rel = "index.html" }
            guard !rel.contains(".."), let base = Self.bundle, let d = try? Data(contentsOf: base.appendingPathComponent(rel)) else { return finish(task, 404, Data(), "text/plain") }
            return finish(task, 200, d, Self.type(rel))
        }
        // The rest of the origin is the hub's own board, the app's home: its
        // page for this web view, its files and pictures for that page only.
        guard req.httpMethod ?? "GET" == "GET" else { return refuse(task, req) }
        if req.mainDocumentURL == url && (path == "/" || path == "/index.html") { return boardPage(task) }
        guard Self.allowed(req) else { return refuse(task, req) }
        if let r = Self.range(req), let part = MediaBlocks.part(r) { return mediaPart(task, path + query, part, range: r) }
        hubResource(task, path + query, range: Self.range(req))
    }

    func webView(_ w: WKWebView, stop task: WKURLSchemeTask) { live.remove(ObjectIdentifier(task)) }

    /// The page's own requests carry its Referer (and its Origin, when they carry one).
    static func allowed(_ r: URLRequest) -> Bool {
        if let o = r.value(forHTTPHeaderField: "Origin"), o != BoardController.origin { return false }
        if r.mainDocumentURL?.absoluteString.hasPrefix(BoardController.origin + "/") == true && r.value(forHTTPHeaderField: "Referer") == nil { return true }
        guard let ref = r.value(forHTTPHeaderField: "Referer") else { return false }
        return ref.hasPrefix(BoardController.origin + "/")
    }

    static func type(_ name: String) -> String {
        switch (name as NSString).pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "woff2": return "font/woff2"
        case "json": return "application/json"
        case "txt": return "text/plain; charset=utf-8" // licences.txt, the open source licences (Settings)
        default: return "application/octet-stream"
        }
    }

    private func refuse(_ task: WKURLSchemeTask, _ r: URLRequest) {
        Log.say("board: refused \(r.httpMethod ?? "GET") \(r.url?.path ?? "") (not the page's own)")
        finish(task, 403, Data(), "text/plain")
    }

    private func finish(_ task: WKURLSchemeTask, _ status: Int, _ data: Data, _ type: String, _ extra: [String: String] = [:]) {
        let go = {
            guard self.live.contains(ObjectIdentifier(task)), let url = task.request.url else { return }
            self.live.remove(ObjectIdentifier(task))
            var h = ["Content-Type": type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"]
            for (k, v) in extra { h[k] = v }
            task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: h)!)
            task.didReceive(data)
            task.didFinish()
        }
        if Thread.isMainThread { go() } else { DispatchQueue.main.async(execute: go) }
    }

    /// The board's page (the hub's `/`), with the app's layer (board.js) first in its head.
    private func boardPage(_ task: WKURLSchemeTask) {
        Task {
            guard let c = Hub.client() else { return finish(task, 200, Self.unreached("unreachable"), "text/html; charset=utf-8") }
            do {
                let r = try await c.execute("GET", "/")
                guard r.status == 200 else { return finish(task, r.status, r.data, r.header("Content-Type") ?? "text/html") }
                var html = r.text
                if let i = html.range(of: "<head>") { html.replaceSubrange(i, with: "<head>\n<script src=\"/phone/board.js\"></script>") }
                html = html.replacingOccurrences(of: "width=device-width", with: "width=device-width, viewport-fit=cover")
                finish(task, 200, Data(html.utf8), "text/html; charset=utf-8", ["Cache-Control": "no-store"])
            } catch {
                // The computer did not answer: the app's own page says why (its board.js runs there, with the bar and Try again).
                let w = Net.why(error as? HubFailure, hosts: c.allHosts)
                finish(task, 200, Self.unreached(w.reason), "text/html; charset=utf-8", ["Cache-Control": "no-store"])
            }
        }
    }

    static func unreached(_ reason: String) -> Data {
        Data("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\"><script src=\"/phone/board.js\"></script><style>body{margin:0;background:#161618;color:#A1A1A8}@media (prefers-color-scheme: light){body{background:#F1F0ED;color:#5F5F66}}</style></head><body data-unreached=\"\(reason)\"></body></html>".utf8)
    }

    /// The part of a file a player asks for ("bytes=0-1"), passed to the hub as it is; nil when none.
    static func range(_ r: URLRequest) -> String? {
        guard let v = r.value(forHTTPHeaderField: "Range")?.trimmingCharacters(in: .whitespaces), v.range(of: #"^bytes=\d*-\d*$"#, options: .regularExpression) != nil else { return nil }
        return v
    }

    /// A picture or file of the hub, fetched with the pin and the token; the hub's own policy goes with it.
    /// A player's part of a video (a pick's, the pickvideo round) is asked for and passed on as the hub answers it (206).
    private func hubResource(_ task: WKURLSchemeTask, _ path: String, range: String? = nil) {
        Task {
            guard let c = Hub.client() else { return finish(task, 502, Data(), "text/plain") }
            do {
                let r = try await c.execute("GET", path, headers: range.map { ["Range": $0] } ?? [:])
                var extra: [String: String] = [:]
                if let csp = r.header("Content-Security-Policy") { extra["Content-Security-Policy"] = csp }
                for k in ["Content-Range", "Accept-Ranges"] { if let v = r.header(k) { extra[k] = v } }
                if r.status == 206 || r.header("Accept-Ranges") != nil { extra["Content-Length"] = "\(r.data.count)" }
                if let e = r.header("ETag") { extra["ETag"] = e }
                let type = r.header("Content-Type") ?? "application/octet-stream"
                finish(task, r.status, r.data, type, extra)
            } catch { finish(task, 502, Data(), "text/plain") }
        }
    }

    /// A player's part of a file (a pick's video): answered from the file's blocks (MediaBlocks), each asked of the hub once.
    /// A file the hub does not serve in parts, or a part too large to hold, is passed on as the hub answers it.
    private func mediaPart(_ task: WKURLSchemeTask, _ path: String, _ part: (Int, Int?), range: String) {
        Task {
            guard let c = Hub.client() else { return finish(task, 502, Data(), "text/plain") }
            let got = await MediaBlocks.shared.answer(path, part) { r in
                guard let x = try? await c.execute("GET", path, headers: ["Range": r]) else { return nil }
                return MediaBlocks.Fetched(status: x.status, data: x.data, contentRange: x.header("Content-Range"), type: x.header("Content-Type"))
            }
            switch got {
            case .part(let data, let from, let total, let type):
                finish(task, 206, data, type, ["Content-Range": "bytes \(from)-\(from + data.count - 1)/\(total)", "Accept-Ranges": "bytes", "Content-Length": "\(data.count)"])
            case .outside(let total):
                finish(task, 416, Data(), "text/plain", ["Content-Range": "bytes */\(total)"])
            case .passOn:
                hubResource(task, path, range: range)
            case .failed:
                Log.say("board: a video's part (\(range)) did not come from the Mac")
                finish(task, 502, Data(), "text/plain")
            }
        }
    }
}

/// A video's parts for the board's player (the pickvideo round's fourth part,
/// 2026-11-16). WebKit's player on iOS reads a video through the app's
/// handler in small parts, a few bytes to some KB at a time: five rounds
/// between a pick's two videos (30 s and 15 s, 14 MB) made 5,731 requests,
/// each a round trip to the Mac. On the person's iPad, over Wi-Fi, the video
/// being watched could not get its parts as fast as it played and loaded for
/// ever. Here each file is asked of the hub in blocks of 512 KB, each block
/// once, and every part the player asks for is answered from them; the
/// blocks are kept (48 MB at most, the least recently used going first), so
/// a video come back to plays from them.
actor MediaBlocks {
    static let shared = MediaBlocks()
    static let size = 512 * 1024
    /// The most a part answered from blocks may be; larger ones are passed on.
    static let largest = 8 * 1024 * 1024
    let budget: Int
    init(budget: Int = 48 * 1024 * 1024) { self.budget = budget }

    /// The hub's answer to a block's request.
    struct Fetched: Sendable { let status: Int; let data: Data; let contentRange: String?; let type: String? }
    enum Answer: Equatable { case part(Data, from: Int, total: Int, type: String), outside(total: Int), passOn, failed }
    private struct Block { let data: Data; let total: Int; let type: String }

    private var blocks: [String: Block] = [:]
    private var used: [String] = []
    private var held = 0
    private var asking: [String: Task<Block?, Never>] = [:]
    /// How many blocks were asked of the hub (the checks read it).
    private(set) var asked = 0

    /// "bytes=a-b" or "bytes=a-": its first byte and its last (nil: to the end). Nil for a part from the end ("bytes=-n").
    static func part(_ range: String) -> (Int, Int?)? {
        guard range.hasPrefix("bytes=") else { return nil }
        let s = range.dropFirst(6).split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard s.count == 2, let a = Int(s[0]), a >= 0 else { return nil }
        if s[1].isEmpty { return (a, nil) }
        guard let b = Int(s[1]), b >= a else { return nil }
        return (a, b)
    }

    /// The part of `path` from `part.0` to `part.1` (the end when nil), from its blocks; `fetch` asks the hub for a range.
    func answer(_ path: String, _ part: (Int, Int?), fetch: @escaping @Sendable (String) async -> Fetched?) async -> Answer {
        let (a, b) = part
        let k0 = a / Self.size
        guard let first = await block(path, k0, fetch) else { return .failed }
        guard first.total > 0 else { return .passOn }
        if a >= first.total { return .outside(total: first.total) }
        let e = min(b ?? first.total - 1, first.total - 1)
        if e - a + 1 > Self.largest { return .passOn }
        var out = Data(capacity: e - a + 1)
        for k in k0...(e / Self.size) {
            guard let bl = k == k0 ? first : await block(path, k, fetch), bl.total > 0 else { return .failed }
            let lo = max(a, k * Self.size) - k * Self.size, hi = min(e, k * Self.size + bl.data.count - 1) - k * Self.size
            guard lo <= hi, hi < bl.data.count else { return .failed }
            out.append(bl.data[bl.data.startIndex + lo...bl.data.startIndex + hi])
        }
        return .part(out, from: a, total: first.total, type: first.type)
    }

    /// Block k of `path`: kept, being asked (the same answer then), or asked of the hub now (once more when it failed).
    private func block(_ path: String, _ k: Int, _ fetch: @escaping @Sendable (String) async -> Fetched?) async -> Block? {
        let key = "\(k) \(path)"
        if let b = blocks[key] { used.removeAll { $0 == key }; used.append(key); return b }
        if let t = asking[key] { return await t.value }
        asked += 1
        let r = "bytes=\(k * Self.size)-\((k + 1) * Self.size - 1)"
        let t = Task { () -> Block? in
            for _ in 0..<2 {
                guard let f = await fetch(r) else { continue }
                let total = f.contentRange?.split(separator: "/").last.flatMap { Int($0) }
                // Past the file's end: no bytes, its size. A file the hub does not serve in parts: total 0, passed on as it is.
                if f.status == 416, let total { return Block(data: Data(), total: total, type: "") }
                guard f.status == 206, let total else { return f.status >= 500 ? nil : Block(data: Data(), total: 0, type: "") }
                return Block(data: f.data, total: total, type: f.type ?? "application/octet-stream")
            }
            return nil
        }
        asking[key] = t
        let b = await t.value
        asking[key] = nil
        if let b, b.total > 0, !b.data.isEmpty {
            blocks[key] = b
            used.append(key)
            held += b.data.count
            while held > budget, let old = used.first { used.removeFirst(); held -= blocks.removeValue(forKey: old)?.data.count ?? 0 }
        }
        return b
    }
}

/// Face ID before every Run (docs/PHONE.md section 5); it cannot be turned off.
enum Biometrics {
    static func ask(reason: String, done: @escaping (Bool, String?) -> Void) {
        let ctx = LAContext()
        ctx.localizedCancelTitle = "Cancel"
        var e: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &e) else {
            let none = (e?.code == LAError.biometryNotEnrolled.rawValue)
            Log.say("face id: not available (\(none ? "none set up" : "no Face ID"))")
            done(false, none ? "Run needs Face ID, and none is set up on this \(Device.model). Set it up in Settings, or run it on the computer."
                             : "Run needs Face ID, and this \(Device.model) can't use it now. Run it on the computer.")
            return
        }
        ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, err in
            Log.say("face id: \(ok ? "matched" : "not matched")")
            DispatchQueue.main.async { done(ok, ok ? nil : ((err as? LAError)?.code == .userCancel ? "Not confirmed." : "Face ID did not confirm it.")) }
        }
    }
}

/// Sign out on this phone: the pairing screen at once; the computer is told
/// (POST /api/phone/unpair with the old token) in the background, again
/// after 5 s doubling to 5 min and at each start of the app, until it answers.
enum Revokes {
    static func signOut() {
        guard let p = Store.shared.paired() else { return }
        Store.shared.addRevoke(p)
        Store.shared.clear()
        Hub.reset()
        Log.say("signed out on this phone; telling the Mac")
        run()
    }

    static func run(wait: TimeInterval = 5) {
        let list = Store.shared.revokes()
        guard !list.isEmpty else { return }
        Task.detached {
            var left = false
            for p in list {
                let c = HubClient.of(p)
                if let r = try? await c.call("POST", "/api/phone/unpair", json: [String: Any]()), r.status == 200 || r.status == 401 {
                    Store.shared.dropRevoke(p.token)
                    Log.say("the Mac heard the sign-out (\(r.status))")
                } else { left = true }
            }
            if left { DispatchQueue.main.asyncAfter(deadline: .now() + wait) { run(wait: min(wait * 2, 300)) } }
        }
    }
}

#if DEBUG
/// For the checks only (a debug build, RAVENRY_TEST_DRIVE set by
/// Tests/RavenryUITests): the checks press the board's own buttons by
/// running a line of script in the page, as the Android checks do through
/// the WebView's debugging port: each `<n>.js` in that folder is run in the
/// page and its answer written to `<n>.out`.
enum TestDrive {
    static func start(_ b: BoardController) {
        guard let dir = ProcessInfo.processInfo.environment["RAVENRY_TEST_DRIVE"] else { return }
        Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak b] t in
            guard let b, b.view.window != nil else { if b == nil { t.invalidate() }; return }
            let fm = FileManager.default
            // A Split View or Slide Over's room, in points ("0": the whole window again).
            if let r = try? String(contentsOfFile: "\(dir)/room", encoding: .utf8) {
                try? fm.removeItem(atPath: "\(dir)/room")
                let v = Double(r.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
                b.testRoom = v > 0 ? CGFloat(v) : nil
                b.view.setNeedsLayout()
            }
            for f in (try? fm.contentsOfDirectory(atPath: dir)) ?? [] where f.hasSuffix(".js") {
                let p = "\(dir)/\(f)"
                guard let code = try? String(contentsOfFile: p, encoding: .utf8) else { continue }
                try? fm.removeItem(atPath: p)
                b.web.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { r in
                    let out: String
                    switch r {
                    case .success(let v): out = (try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed])).map { String(decoding: $0, as: UTF8.self) } ?? "null"
                    case .failure(let e): out = "error: \(e.localizedDescription)"
                    }
                    try? out.write(toFile: p.replacingOccurrences(of: ".js", with: ".out"), atomically: true, encoding: .utf8)
                }
            }
        }
    }
}
#endif
