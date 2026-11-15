// The iPhone app driven as a person would, on a simulator, against a test
// hub on 127.0.0.1 with demo content (tools/ios-e2e.mjs starts it, passes
// it here as TEST_RUNNER_RAVENRY_* and answers the Face ID signals). Each
// step asserts its effect where it lands: the hub's own state, read on the
// hub's board port as the Mac reads it.

import XCTest

final class FlowTests: XCTestCase {
    let env = ProcessInfo.processInfo.environment
    var board: String { env["RAVENRY_BOARD"] ?? "" }
    var theme: String { env["RAVENRY_THEME"] ?? "dark" }
    /// Only the pictures (the second theme): no asserts on what the first pass already proved.
    var shotsOnly: Bool { env["RAVENRY_SHOTS_ONLY"] == "1" }

    override class func setUp() { super.setUp(); Quiet.off() }

    override func setUp() {
        continueAfterFailure = false
        if board.isEmpty { XCTFail("no test hub: run tools/ios-e2e.mjs") }
    }

    // ------------------------------------------------------------ helpers

    func launch(reset: Bool, ink: Bool = false, _ extra: [String: String] = [:]) -> XCUIApplication {
        let a = XCUIApplication()
        if let sig = env["RAVENRY_SIG"] { try? FileManager.default.createDirectory(atPath: "\(sig)/drive", withIntermediateDirectories: true); a.launchEnvironment["RAVENRY_TEST_DRIVE"] = "\(sig)/drive" }
        a.launchEnvironment["RAVENRY_RESET"] = reset ? "1" : "0"
        a.launchEnvironment["RAVENRY_REDUCE_MOTION"] = ink ? "0" : "1"
        for (k, v) in extra { a.launchEnvironment[k] = v }
        a.launch()
        return a
    }

    /// The whole screen as the simulator shows it (tools/ios-e2e.mjs takes it with
    /// `simctl io screenshot`: XCUIScreen leaves the keyboard out).
    func shot(_ name: String) {
        guard let dir = env["RAVENRY_SHOTS"], let sig = env["RAVENRY_SIG"] else { return }
        let u = URL(fileURLWithPath: "\(sig)/shot.wait")
        try? Data("\(dir)/\(name)-\(theme).png".utf8).write(to: u)
        _ = until(10) { !FileManager.default.fileExists(atPath: u.path) }
    }

    func mark(_ line: String) {
        guard let dir = env["RAVENRY_SIG"] else { return }
        let u = URL(fileURLWithPath: "\(dir)/marks.log")
        let s = "\(Date().timeIntervalSince1970) \(line)\n"
        if let h = try? FileHandle(forWritingTo: u) { h.seekToEndOfFile(); h.write(Data(s.utf8)); try? h.close() } else { try? Data(s.utf8).write(to: u) }
    }

    /// The hub as the Mac reads it (its board port on 127.0.0.1).
    func hub(_ method: String, _ path: String, _ body: [String: Any]? = nil) -> (Int, [String: Any]) {
        var r = URLRequest(url: URL(string: board + path)!)
        r.httpMethod = method
        if let body { r.httpBody = try? JSONSerialization.data(withJSONObject: body); r.setValue("application/json", forHTTPHeaderField: "Content-Type"); r.setValue("1", forHTTPHeaderField: "X-Ravenry") }
        let done = DispatchSemaphore(value: 0)
        var out: (Int, [String: Any]) = (0, [:])
        URLSession.shared.dataTask(with: r) { d, resp, _ in
            out = ((resp as? HTTPURLResponse)?.statusCode ?? 0, (d.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:])
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 10)
        return out
    }

    func checkpoint(_ kind: String) -> [String: Any]? {
        let (_, j) = hub("GET", "/api/checkpoints?all")
        return (j["checkpoints"] as? [[String: Any]] ?? []).first { $0["kind"] as? String == kind }
    }

    func until(_ s: TimeInterval, _ f: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(s)
        while Date() < end { if f() { return true }; Thread.sleep(forTimeInterval: 0.3) }
        return f()
    }

    /// Asks tools/ios-e2e.mjs for a Face ID match or no match, once the prompt is up.
    func faceID(_ what: String) {
        guard let dir = env["RAVENRY_SIG"] else { return }
        let u = URL(fileURLWithPath: "\(dir)/faceid.wait")
        try? Data(what.utf8).write(to: u)
        _ = until(15) { !FileManager.default.fileExists(atPath: u.path) }
    }

    private var jsN = 0
    /// A line of script run in the board's page (the app's debug-only TestDrive): its answer as JSON text.
    func js(_ body: String, timeout: TimeInterval = 8) -> String? {
        guard let sig = env["RAVENRY_SIG"] else { return nil }
        jsN += 1
        let base = "\(sig)/drive/\(jsN)-\(Int(Date().timeIntervalSince1970 * 1000))"
        try? Data(body.utf8).write(to: URL(fileURLWithPath: base + ".js"))
        var out: String?
        _ = until(timeout) { out = try? String(contentsOfFile: base + ".out", encoding: .utf8); return out != nil }
        return out
    }

    /// Waits until the board shows an element with this text (a button or a chip) and presses it.
    func press(_ text: String, exact: Bool = false, timeout: TimeInterval = 20) -> Bool {
        let t = text.replacingOccurrences(of: "'", with: "\\'")
        let code = """
        const want = '\(t)';
        const els = [...document.querySelectorAll('button, [role=button], .pchip, [data-act]')].filter((e) => e.offsetParent !== null && !e.disabled);
        const hit = els.find((e) => { const s = (e.innerText || e.textContent || '').trim(); return \(exact ? "s === want" : "s === want || s.startsWith(want + ' ') || s.startsWith(want + '\\n')"); });
        if (!hit) return false;
        hit.scrollIntoView({ block: 'center' }); hit.click(); return true;
        """
        return until(timeout) { js(code) == "true" }
    }

    /// Whether the board shows this text anywhere.
    func shows(_ text: String, timeout: TimeInterval = 20) -> Bool {
        let t = text.replacingOccurrences(of: "'", with: "\\'")
        return until(timeout) { js("return document.body && document.body.innerText.includes('\(t)');") == "true" }
    }

    // ------------------------------------------------------------ the steps, in order

    func test1_PairByTheTypedCode() throws {
        let a = launch(reset: true)
        XCTAssertTrue(a.buttons["type-instead"].waitForExistence(timeout: 10))
        shot("pair")
        a.buttons["type-instead"].tap()
        let addr = a.textFields["pair-address"], code = a.textFields["pair-code"]
        XCTAssertTrue(addr.waitForExistence(timeout: 5))
        addr.tap(); addr.typeText("127.0.0.1:\(env["RAVENRY_PHONE_PORT"] ?? "")")
        code.tap(); code.typeText(env["RAVENRY_CODE"] ?? "")
        shot("pair-typed")
        a.buttons["pair-next"].tap()
        let check = a.staticTexts["check-number"]
        XCTAssertTrue(check.waitForExistence(timeout: 20), "the check number")
        mark("check number shown: \(check.label)")
        if !shotsOnly { XCTAssertEqual(check.label, env["RAVENRY_CHECK"], "the phone's check number is the Mac's") }
        shot("pair-check")
        a.buttons["pair-match"].tap()
        // Paired: the alerts' ask, "Connected to MacBook Pro" on top (no iPhone through ntfy yet: test 6 makes one).
        XCTAssertTrue(a.buttons["alerts-on"].waitForExistence(timeout: 20), "the alerts' ask after pairing (a fresh install)")
        XCTAssertTrue(a.otherElements["connected-line"].exists || a.staticTexts["Connected to MacBook Pro"].exists, "the connected line on top")
        shot("alerts-connected")
        a.buttons["alerts-on"].tap()
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = sb.buttons["Allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 8), "iOS's own ask")
        Thread.sleep(forTimeInterval: 0.8)
        shot("alerts-sheet")
        allow.tap()
        XCTAssertTrue(shows("recipe-box", timeout: 30), "the board after pairing")
        Thread.sleep(forTimeInterval: 1.5)
        shot("board")
        if !shotsOnly {
            let (_, d) = hub("GET", "/api/phone/devices")
            let ios = (d["devices"] as? [[String: Any]] ?? []).filter { $0["platform"] as? String == "ios" }
            XCTAssertEqual(ios.count, 1, "the hub has the iPhone as a device")
            mark("paired by the typed code: device \(ios.first?["id"] ?? "?")")
        }
    }

    func test2_ARelaunchKeepsThePairing() throws {
        let a = launch(reset: false)
        XCTAssertTrue(shows("garden-planner", timeout: 30), "the board, no pairing screen: the token survived the relaunch")
        XCTAssertFalse(a.buttons["type-instead"].exists)
        mark("relaunch: the board, paired")
    }

    func test3_AnAnswerOnTheBoardReachesTheHub() throws {
        if shotsOnly { return }
        let a = launch(reset: false)
        XCTAssertTrue(press("notes-app"), "the chip notes-app")
        XCTAssertTrue(press("Ship it", exact: true), "the ask's answers on the board")
        XCTAssertTrue(until(10) { (checkpoint("ask")?["state"] as? String) != "open" }, "the ask answered on the hub")
        let cp = checkpoint("ask") ?? [:]
        mark("ask: \(cp["state"] ?? "?") \(String(describing: cp["answer"] ?? ""))")
        let ans = cp["answer"] as? [String: Any] ?? [:]
        XCTAssertEqual(ans["choice"] as? Int, 0, "Ship it is the first answer")
    }

    func test4_RunAsksFaceIDAndOnlyAMatchRuns() throws {
        let a = launch(reset: false)
        XCTAssertTrue(press("recipe-box"), "the chip recipe-box")
        XCTAssertTrue(shows("Face ID first."), "the board names Face ID")
        XCTAssertTrue(press("Run", exact: true), "Run")
        Thread.sleep(forTimeInterval: 1.2)
        shot("run")
        if shotsOnly { faceID("nomatch"); return }
        faceID("nomatch")
        Thread.sleep(forTimeInterval: 1.5)
        shot("run-nomatch")
        // iOS offers Try Face ID Again after a face it did not know; the person
        // presses Cancel (iOS's own sheet, outside the app: pressed where it is drawn).
        a.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.579)).tap()
        Thread.sleep(forTimeInterval: 2)
        shot("run-cancelled")
        XCTAssertEqual(checkpoint("approve")?["state"] as? String, "open", "no match: nothing ran")
        mark("face id no match: the command is still waiting")
        XCTAssertTrue(press("Run", exact: true, timeout: 8), "Run, pressable again after no match")
        Thread.sleep(forTimeInterval: 1.2)
        faceID("match")
        XCTAssertTrue(until(10) { (checkpoint("approve")?["state"] as? String) != "open" }, "a match runs it")
        let ans = checkpoint("approve")?["answer"] as? [String: Any] ?? [:]
        mark("face id match: \(checkpoint("approve")?["state"] ?? "?") \(ans)")
        XCTAssertEqual((ans["approved"] as? NSNumber)?.boolValue, true, "approved by the phone")
        XCTAssertEqual(ans["by"] as? String, "phone")
    }

    func test5_TheSecretGoesStraightToTheHub() throws {
        let a = launch(reset: false)
        XCTAssertTrue(press("garden-planner"), "the chip garden-planner")
        XCTAssertTrue(press("Type it", exact: true), "Type it")
        let f = a.secureTextFields["secret-field"]
        XCTAssertTrue(f.waitForExistence(timeout: 15), "the private field over the card")
        Thread.sleep(forTimeInterval: 1)
        shot("secret")
        f.typeText(env["RAVENRY_TYPED"] ?? "demo-key-tw0-fl4me-77")
        Thread.sleep(forTimeInterval: 0.6)
        shot("secret-typed")
        // The Send button stays above the keyboard: the web view shrank to it.
        let kb = a.keyboards.firstMatch
        let sendBottom = js("const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim().startsWith('Send')); return b ? b.getBoundingClientRect().bottom : null;").flatMap { Double($0) }
        let top = a.webViews.firstMatch.frame.minY
        XCTAssertTrue(kb.exists, "the keyboard is up")
        if let sb = sendBottom { XCTAssertLessThanOrEqual(top + sb, kb.frame.minY + 1, "Send above the keyboard"); mark("send button bottom \(top + sb), keyboard top \(kb.frame.minY)") } else { XCTFail("no Send button") }
        if shotsOnly { return }
        f.typeText("\n")
        XCTAssertTrue(until(10) { (checkpoint("secret")?["state"] as? String) != "open" }, "the secret answered on the hub")
        mark("secret: \(checkpoint("secret")?["state"] ?? "?")")
    }

    func test6_ThePairLinkAndWhichIPhone() throws {
        // An iPhone through ntfy, as the Mac's Add an iPhone makes it (its server is the checks' stand-in).
        let (_, st) = hub("POST", "/api/alerts/iphone/start", [:])
        let ntfy = st["id"] as? String ?? ""
        _ = hub("POST", "/api/alerts/iphone/confirm", ["id": ntfy])
        let (_, card) = hub("GET", "/api/phone?code=new")
        let link = (card["app"] as? [String: Any])?["link"] as? String ?? ""
        XCTAssertTrue(link.hasPrefix("ravenry://pair"))
        let a = launch(reset: true)
        XCTAssertTrue(a.buttons["type-instead"].waitForExistence(timeout: 10))
        a.open(URL(string: link)!)
        XCTAssertTrue(a.buttons["pair-confirm"].waitForExistence(timeout: 10), "the link asks first")
        XCTAssertTrue(a.staticTexts["Pair with MacBook Pro?"].exists)
        shot("pair-confirm")
        a.buttons["pair-confirm"].tap()
        XCTAssertTrue(a.buttons["which-continue"].waitForExistence(timeout: 20), "Which iPhone is this?")
        XCTAssertTrue(a.staticTexts["Connected to MacBook Pro"].exists)
        shot("which")
        a.buttons["which-continue"].tap()
        XCTAssertTrue(shows("recipe-box", timeout: 30), "the board after the takeover")
        if shotsOnly { return }
        let (_, d) = hub("GET", "/api/phone/devices")
        let ids = (d["devices"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
        XCTAssertTrue(ids.contains(ntfy), "this iPhone took over the ntfy iPhone's record")
        mark("pair link + which iPhone: devices \(ids)")
    }

    func test7_AWrongPinIsRefused() throws {
        if shotsOnly { return }
        let (_, card) = hub("GET", "/api/phone?code=new")
        let link = (card["app"] as? [String: Any])?["link"] as? String ?? ""
        let bad = link.replacingOccurrences(of: #"pin=[A-Za-z0-9_-]{43}"#, with: "pin=HeUsQdW9nukFaxot8W-JlMEAczEFqYec5G1Jpzyferk", options: .regularExpression)
        let before = (hub("GET", "/api/phone/devices").1["devices"] as? [Any])?.count ?? -1
        let a = launch(reset: true)
        XCTAssertTrue(a.buttons["type-instead"].waitForExistence(timeout: 10))
        a.open(URL(string: bad)!)
        XCTAssertTrue(a.buttons["pair-confirm"].waitForExistence(timeout: 10))
        a.buttons["pair-confirm"].tap()
        let err = a.staticTexts["pair-error"]
        XCTAssertTrue(err.waitForExistence(timeout: 15))
        mark("wrong pin: \(err.label)")
        XCTAssertTrue(err.label.contains("another key"), err.label)
        shot("pair-wrong-pin")
        let after = (hub("GET", "/api/phone/devices").1["devices"] as? [Any])?.count ?? -2
        XCTAssertEqual(before, after, "no device was added")
        // Paired again for the next steps.
        let (_, c2) = hub("GET", "/api/phone?code=new")
        a.open(URL(string: (c2["app"] as? [String: Any])?["link"] as? String ?? "")!)
        XCTAssertTrue(a.buttons["pair-confirm"].waitForExistence(timeout: 10))
        a.buttons["pair-confirm"].tap()
        XCTAssertTrue(shows("recipe-box", timeout: 30))
    }

    func test8_TheInkPlaysAndEndsOnTheBoard() throws {
        let a = launch(reset: false, ink: true, ["RAVENRY_INK_FRAMES": "0.6,1.3,2.0,2.6,2.9"])
        let t0 = Date()
        for t in [1.0, 2.2, 3.0] {
            let wait = t - Date().timeIntervalSince(t0)
            if wait > 0 { Thread.sleep(forTimeInterval: wait) }
            shot(String(format: "ink-live-%.1f", t))
        }
        XCTAssertTrue(shows("recipe-box", timeout: 15))
        Thread.sleep(forTimeInterval: 2)
        shot("ink-end")
        mark("ink: board shown after the ink")
    }

    // ------------------------------------------------------------ cards that arrive while the board is open

    /// Asks tools/ios-e2e.mjs to open a card on the test hub (as `ravenry approve`, `ask` or `pick` in that project): its id.
    func newCard(_ spec: [String: Any]) -> String? {
        guard let dir = env["RAVENRY_SIG"] else { return nil }
        let out = URL(fileURLWithPath: "\(dir)/card.out")
        try? FileManager.default.removeItem(at: out)
        try? JSONSerialization.data(withJSONObject: spec).write(to: URL(fileURLWithPath: "\(dir)/card.wait"))
        var id: String?
        _ = until(15) { id = try? String(contentsOf: out, encoding: .utf8); return id != nil }
        mark("card opened: \(spec["kind"] ?? "?") in \(spec["project"] ?? "?"): \(id ?? "nothing")")
        return id.flatMap { $0.hasPrefix("error") ? nil : $0 }
    }

    /// Whether the board shows this text on the project's own screen (the
    /// board's own route, no reload), within the time a person waits.
    func onBoard(_ project: String, _ text: String, timeout: TimeInterval = 12) -> Bool {
        let p = project.replacingOccurrences(of: "'", with: "\\'")
        let t = text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
        let code = """
        if (location.hash !== '#\(p)') location.hash = '#\(p)';
        return !!document.body && document.body.innerText.includes('\(t)');
        """
        return until(timeout) { js(code) == "true" }
    }

    /// Asks tools/ios-e2e.mjs to stop the test hub for that many seconds (its connections stay open, unanswered).
    func silent(_ seconds: Int) {
        guard let dir = env["RAVENRY_SIG"] else { return }
        try? Data("\(seconds)".utf8).write(to: URL(fileURLWithPath: "\(dir)/pause.wait"))
        _ = until(5) { !FileManager.default.fileExists(atPath: "\(dir)/pause.wait") }
        mark("the Mac silent for \(seconds) s")
    }

    /// The app in the background for that long (Home), then in front again. Nothing
    /// keeps the keyboard's focus across it: XCUITest's own hook crashes the app when a
    /// text field's session starts again as the app comes back.
    func away(_ a: XCUIApplication, seconds: TimeInterval, during: () -> Void = {}) {
        _ = js("if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true;")
        XCUIDevice.shared.press(.home)
        let t0 = Date()
        during()
        let left = seconds - Date().timeIntervalSince(t0)
        if left > 0 { Thread.sleep(forTimeInterval: left) }
        a.activate()
    }

    /// Whether the board's connection chip says connected within that time.
    func connUp(within s: TimeInterval) -> Bool {
        until(s) { js("return (window.ravenryApp && window.ravenryApp.conn && window.ravenryApp.conn.state) || null;", timeout: 3) == "\"up\"" }
    }

    /// What the page heard from the shell so far (only to say why, when a card did not show).
    func heard() -> String { js("return JSON.stringify(window.__rvHeard || null);") ?? "nothing" }

    func test9_ANewCardArrivesLiveOnTheOpenBoard() throws {
        if shotsOnly { return }
        // Every case measured, not only up to the first that fails.
        continueAfterFailure = true
        let a = launch(reset: false)
        XCTAssertTrue(shows("recipe-box", timeout: 30), "the board")
        Thread.sleep(forTimeInterval: 2)
        // A mark in the page (a reload would lose it), and a count of what the shell hands the page.
        _ = js("""
        window.__rvLive = 'same page';
        if (!window.__rvHeard) { const o = window.__rvRecv; const h = window.__rvHeard = { n: 0, hub: 0, textOnly: 0, names: {} };
          window.__rvRecv = function (s) { h.n++; try { const m = typeof s === 'string' ? JSON.parse(s) : s; if (m && m.event === 'hub') { h.hub++; h.names[m.name] = (h.names[m.name] || 0) + 1; if (typeof m.data === 'string') h.textOnly++; } } catch (e) { h.err = String(e); } return o(s); }; }
        return true;
        """)
        let samePage = { self.js("return window.__rvLive || null;") == "\"same page\"" }

        // 1. An approve card.
        XCTAssertNotNil(newCard(["kind": "approve", "project": "paper-boat", "command": "echo \"live one: it ran\"", "why": "A card that arrives while the board is open."]))
        let one = onBoard("paper-boat", "live one: it ran")
        mark("live approve on the board: \(one); heard \(heard())")
        // The card in sight for the picture (it sits under the project's head on a phone).
        _ = js("const hit = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === 'Run'); if (hit) hit.scrollIntoView({ block: 'center' }); return !!hit;")
        Thread.sleep(forTimeInterval: 4)
        shot("live-approve")
        XCTAssertTrue(one, "a new approve card shows on the open board")

        // 2. An ask, its words with quotes, an apostrophe, accents, a line separator and a sign outside the BMP.
        let askTitle = "Ship \"Caf\u{e9} cr\u{e8}me\" to l'\u{e9}quipe? \u{65e5}\u{672c} \u{1F680}"
        XCTAssertNotNil(newCard(["kind": "ask", "project": "weather-widget", "title": askTitle + "\u{2028}It goes to the 12 testers.", "options": ["Ship it now", "Not yet"]]))
        let two = onBoard("weather-widget", "Caf\u{e9} cr\u{e8}me")
        mark("live ask with quotes and accents: \(two); heard \(heard())")
        XCTAssertTrue(two, "a new ask with quotes and non-ASCII words shows")
        XCTAssertTrue(onBoard("weather-widget", "Ship it now", timeout: 3), "the ask's answers")

        // 4. A card in a large state (60 more cards with a long why each: the board's state goes over 150 KB, as a busy Mac's).
        XCTAssertNotNil(newCard(["kind": "approve", "project": "weather-widget", "command": "echo \"live big: it ran\"", "why": "A large state.", "fill": ["project": "garden-planner", "cards": 60]]))
        let four = onBoard("weather-widget", "live big: it ran", timeout: 20)
        mark("live approve in a large state: \(four); heard \(heard())")
        XCTAssertTrue(four, "a new card shows with a large state")

        // 5. A card opened while the app is in the background shows when it comes back; 6. one after that, live.
        away(a, seconds: 5, during: { XCTAssertNotNil(self.newCard(["kind": "approve", "project": "paper-boat", "command": "echo \"live five: it ran\"", "why": "Opened while the app was away."])) })
        let five = onBoard("paper-boat", "live five: it ran", timeout: 10)
        mark("card opened in the background, after coming back: \(five); heard \(heard())")
        XCTAssertTrue(five, "a card opened while the app was in the background shows when it comes back")
        XCTAssertNotNil(newCard(["kind": "ask", "project": "weather-widget", "title": "After coming back: one more?", "options": ["Yes", "No"]]))
        let six = onBoard("weather-widget", "After coming back: one more?")
        mark("live ask after coming back: \(six); heard \(heard())")
        XCTAssertTrue(six, "a new card shows live after the app came back")

        // 7. The network goes silent with the app in front (the Mac stops answering, its
        // connections left open, as a Wi-Fi that drops): when it answers again, the
        // board is connected and live within seconds.
        silent(50)
        Thread.sleep(forTimeInterval: 51)
        let back7 = connUp(within: 10)
        XCTAssertNotNil(newCard(["kind": "approve", "project": "paper-boat", "command": "echo \"live seven: it ran\"", "why": "After the network came back."]))
        let seven = onBoard("paper-boat", "live seven: it ran", timeout: 10)
        mark("after 50 s of silence in front: connected \(back7), card \(seven); heard \(heard())")
        XCTAssertTrue(back7, "connected again within 10 s of the Mac answering")
        XCTAssertTrue(seven, "a new card shows live after the network came back")

        // 8. Away while the network is silent (an iPad that sleeps), then back.
        away(a, seconds: 40, during: { self.silent(30) })
        let back8 = connUp(within: 10)
        XCTAssertNotNil(newCard(["kind": "ask", "project": "weather-widget", "title": "Back from sleep: still there?", "options": ["Yes", "No"]]))
        let eight = onBoard("weather-widget", "Back from sleep: still there?", timeout: 10)
        mark("back after 40 s away, 30 s of it silent: connected \(back8), card \(eight); heard \(heard())")
        shot("live-after-foreground")
        XCTAssertTrue(back8, "connected again within 10 s of coming back")
        XCTAssertTrue(eight, "a new card shows live after coming back from sleep")

        // 9. An idea named at the Mac with an emoji where the hub cuts names (80
        // characters): half of the emoji, alone, goes in the hub's ideas event
        // (JSON.stringify writes it as \\udXXX, JSON.parse reads it). The idea shows
        // in Ideas, and a card after it still arrives live.
        let name = "Trail map " + String(repeating: "\u{2501}", count: 69) + "\u{1F5FA} more"
        let (st, made) = hub("POST", "/api/ideas/add", ["name": name])
        mark("idea added on the hub: \(st) \((made["idea"] as? [String: Any])?["id"] ?? made["id"] ?? "?")")
        let idea = until(10) { self.js("const b = [...document.querySelectorAll('#bnav [data-pnav]')].find((x) => x.dataset.pnav === 'ideas'); if (b && !b.classList.contains('on')) b.click(); return document.body.innerText.includes('Trail map ');") == "true" }
        mark("an idea with half an emoji alone in Ideas: \(idea); heard \(heard())")
        shot("live-idea-cut-emoji")
        XCTAssertTrue(idea, "an idea whose name the hub cut in the middle of an emoji shows in Ideas")
        _ = js("const b = [...document.querySelectorAll('#bnav [data-pnav]')].find((x) => x.dataset.pnav === 'projects'); if (b) b.click(); return true;")
        XCTAssertNotNil(newCard(["kind": "approve", "project": "weather-widget", "command": "echo \"live nine: it ran\"", "why": "After the idea."]))
        let nine = onBoard("weather-widget", "live nine: it ran", timeout: 10)
        mark("live approve after the idea: \(nine); heard \(heard())")
        XCTAssertTrue(nine, "a new card shows after the idea")
        mark("same page throughout: \(samePage())")
    }
}
