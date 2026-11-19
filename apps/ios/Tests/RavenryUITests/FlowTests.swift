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

    /// The demo (apps/phone/src/demo.ts, Board.swift's demo), on a phone with no Mac: "No Mac yet? Try the demo"
    /// on the pairing screen; never an ask for alerts of its own; the board on sample projects with the demo's bar
    /// on every screen; the question's alert ("Demo: notes-app needs you") and its Ship it answering the card; the
    /// command run; the pick, B with a circle; the settings; Pair your Mac back to the pairing screen.
    func test0_TheDemoBeforeAnyPairing() throws {
        executionTimeAllowance = 300
        // Alerts not allowed yet (a fresh install): the demo never asks for them.
        var a = launch(reset: true)
        XCTAssertTrue(a.buttons["try-demo"].waitForExistence(timeout: 10), "the pairing screen's demo line")
        a.buttons["try-demo"].tap()
        XCTAssertTrue(shows("paper-boat", timeout: 20), "the demo's board")
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        Thread.sleep(forTimeInterval: 9)
        XCTAssertFalse(sb.buttons["Allow"].exists, "the demo never asks for alerts")
        _ = js("document.querySelector('.rv-demo button').click(); return true;")
        XCTAssertTrue(a.buttons["try-demo"].waitForExistence(timeout: 10), "Pair your Mac: the pairing screen")
        a.terminate()

        // Alerts allowed (as the alerts' ask after pairing would have it), then the demo, step by step.
        a = launch(reset: true, ["RAVENRY_TEST_ASK_ALERTS": "1"])
        if sb.buttons["Allow"].waitForExistence(timeout: 8) { sb.buttons["Allow"].tap() }
        XCTAssertTrue(a.buttons["try-demo"].waitForExistence(timeout: 10))
        shot("demo-01-pairing")
        a.buttons["try-demo"].tap()
        XCTAssertTrue(shows("paper-boat", timeout: 20), "the demo's board")
        Thread.sleep(forTimeInterval: 1)
        let bar = "const b = document.querySelector('.rv-demo'); if (!b) return false; const r = b.getBoundingClientRect(); return r.top === 0 && document.elementFromPoint(20, r.top + r.height / 2).closest('.rv-demo') === b && /^Demo\\. Sample projects, nothing leaves this phone\\.Pair your Mac$/.test(b.textContent);"
        XCTAssertEqual(js(bar), "true", "the bar on the board")
        shot("demo-02-board")
        // The question arrives, with its alert; its Ship it answers the card.
        // It comes 6 s in, as a banner over the board for a few seconds: looked for at once.
        XCTAssertTrue(until(15) { js("return window.ravenryDemo.asked();") == "true" }, "the question arrives")
        let banner = sb.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Demo: notes-app needs you'")).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 10), "the alert: Demo: notes-app needs you")
        mark("demo alert: \(banner.label)")
        XCTAssertTrue(banner.label.contains("Sample question. Your answer stays on this phone.") || sb.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Sample question. Your answer stays on this phone.'")).firstMatch.exists, "its text")
        shot("demo-06-alert")
        banner.press(forDuration: 1.2)
        let ship = sb.buttons["Ship it"]
        if ship.waitForExistence(timeout: 6) {
            shot("demo-07-alert-open")
            ship.tap()
            XCTAssertTrue(until(8) { js("return !(window.ravenryDemo.openCheckpoints().some((c) => c.kind === 'ask'));") == "true" }, "the alert's Ship it answers the card")
        } else {
            XCTFail("the alert's buttons did not show")
        }
        _ = js("document.querySelector('#pchips .pchip[data-id=\"notes-app\"]').click(); return true;")
        Thread.sleep(forTimeInterval: 1)
        XCTAssertEqual(js("return !document.querySelector('[data-act=cp-choice]');"), "true", "the question's card is closed")
        shot("demo-08-question-answered")

        for (k, more) in [("ideas", "#sheet [data-idea]"), ("rules", "#sheet [data-rtab=\"sug\"]"), ("ship", "#sheet [data-goto]"), ("pages", "#sheet button")] {
            _ = js("document.querySelector('#bnav [data-pnav=\"\(k)\"]').click(); return true;")
            Thread.sleep(forTimeInterval: 1.2)
            XCTAssertEqual(js(bar), "true", "the bar on \(k)")
            shot("demo-03-\(k)")
            let was = js("return document.querySelector('#sheet').innerText.slice(0, 300);")
            _ = js("const e = document.querySelector('\(more.replacingOccurrences(of: "'", with: "\\'"))'); if (!e) return false; e.click(); return true;")
            Thread.sleep(forTimeInterval: 1.2)
            XCTAssertNotEqual(js("return document.querySelector('#sheet').innerText.slice(0, 300);"), was, "one more screen behind \(k)")
            shot("demo-04-\(k)-more")
        }
        _ = js("document.querySelector('#bnav [data-pnav=\"projects\"]').click(); return true;")
        Thread.sleep(forTimeInterval: 1)
        _ = js("document.querySelector('#pchips .pchip[data-id=\"paper-boat\"]').click(); return true;")
        Thread.sleep(forTimeInterval: 1)
        _ = js("document.querySelector('#lv-scroll').click(); return true;")
        XCTAssertTrue(until(5) { js("return !document.querySelector('#lv-fs').hidden;") == "true" }, "the live screen full")
        XCTAssertEqual(js(bar), "true", "the bar on the live screen")
        shot("demo-05-live")
        _ = js("window.ravenryBack(); return true;")

        // The command: Run (Face ID when it is set up), then done.
        _ = js("document.querySelector('#pchips .pchip[data-id=\"recipe-box\"]').click(); return true;")
        Thread.sleep(forTimeInterval: 1)
        _ = js("document.querySelector('[data-act=cp-run]').scrollIntoView({ block: 'center' }); return true;")
        shot("demo-09-approval")
        _ = js("document.querySelector('[data-act=cp-run]').click(); return true;")
        if js("return !!document.querySelector('[data-act=cp-run]');") == "true" { faceID("match") }
        XCTAssertTrue(until(12) { js("return !document.querySelector('[data-act=cp-run]') && /Published recipe-box 2\\.3\\.0/.test(document.querySelector('#lv-lines').innerText);") == "true" }, "Run: the command runs")
        shot("demo-10-approval-ran")

        // The pick: B, circled, sent.
        _ = js("document.querySelector('#pchips .pchip[data-id=\"paper-boat\"]').click(); return true;")
        Thread.sleep(forTimeInterval: 1)
        _ = js("document.querySelector('[data-act=cp-open]').click(); return true;")
        XCTAssertTrue(until(10) { js("return location.pathname.startsWith('/phone/') && document.querySelectorAll('.ptrack img').length === 3 && [...document.querySelectorAll('.ptrack img')].every((i) => i.complete && i.naturalWidth > 0);") == "true" }, "the pick's screen and its pictures")
        XCTAssertEqual(js(bar), "true", "the bar on the pick")
        shot("demo-11-pick")
        _ = js("const t = document.querySelector('.ptrack'); t.scrollLeft = t.clientWidth; return true;")
        XCTAssertTrue(until(5) { js("return /B, 2 of 3/.test(document.body.innerText);") == "true" }, "B")
        _ = js("[...document.querySelectorAll('button')].find((x) => /Circle a part/.test(x.textContent)).click(); return true;")
        Thread.sleep(forTimeInterval: 1.2)
        let w = a.webViews.firstMatch
        let from = w.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.35)), to = w.coordinate(withNormalizedOffset: CGVector(dx: 0.62, dy: 0.47))
        from.press(forDuration: 0.2, thenDragTo: to)
        Thread.sleep(forTimeInterval: 1)
        shot("demo-12-pick-circled")
        let sent = js("const b = [...document.querySelectorAll('.pzv button.pri')].find((x) => /^Send B|^Pick B/.test(x.textContent)); if (!b) return null; b.click(); return b.textContent;") ?? ""
        XCTAssertTrue(sent.contains("B"), "B sent: \(sent)")
        XCTAssertTrue(until(10) { js("return location.pathname === '/' && !!document.querySelector('#pchips .pchip') && window.ravenryDemo.openCheckpoints().length === 0;") == "true" }, "every card answered and closed")
        shot("demo-13-answered")

        // The settings, then Pair your Mac.
        _ = js("document.querySelector('#pb-more').click(); return true;")
        Thread.sleep(forTimeInterval: 0.6)
        _ = js("document.querySelector('#pmenu [data-act=pn-app]').click(); return true;")
        XCTAssertTrue(until(8) { js("return location.hash === '#/settings' && /A sample Mac, for the demo/.test(document.body.innerText) && /Leave the demo/.test(document.body.innerText);") == "true" }, "the settings say it is the demo")
        shot("demo-14-settings")
        XCTAssertEqual(js("return JSON.stringify(window.ravenryDemo.misses);"), "\"[]\"", "every request answered from the recording")
        _ = js("document.querySelector('.rv-demo button').click(); return true;")
        XCTAssertTrue(a.buttons["try-demo"].waitForExistence(timeout: 10), "Pair your Mac: the pairing screen")
        shot("demo-15-left")
        a.terminate()
    }

    /// Paired, there is no demo: the board itself, no demo line, no demo's bar.
    func test0b_APairedPhoneHasNoDemo() throws {
        let (_, card) = hub("GET", "/api/phone?code=new")
        let link = (card["app"] as? [String: Any])?["link"] as? String ?? ""
        let a = launch(reset: true)
        XCTAssertTrue(a.buttons["try-demo"].waitForExistence(timeout: 10))
        a.open(URL(string: link)!)
        XCTAssertTrue(a.buttons["pair-confirm"].waitForExistence(timeout: 10), "the link asks first")
        XCTAssertFalse(a.buttons["try-demo"].exists, "no demo line on the Pair question")
        a.buttons["pair-confirm"].tap()
        let next = a.buttons["which-continue"], later = a.buttons["alerts-not-now"]
        _ = until(20) { next.exists || later.exists }
        if next.exists { next.tap(); _ = later.waitForExistence(timeout: 10) }
        if later.exists { later.tap() }
        XCTAssertTrue(shows("recipe-box", timeout: 30), "the board after pairing")
        a.terminate()
        let b = launch(reset: false)
        XCTAssertTrue(shows("recipe-box", timeout: 30), "paired: the board")
        XCTAssertEqual(js("return !document.querySelector('.rv-demo') && !window.ravenryDemo;"), "true", "paired: no demo")
        XCTAssertFalse(b.buttons["try-demo"].exists, "paired: no demo line")
        shot("demo-16-paired")
        b.terminate()
    }

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
        // The typed code's field let go of the keyboard: none over the board (left focused, it began a text
        // session each time the app came back to the front, which stalled the app on an iPad).
        XCTAssertFalse(a.keyboards.firstMatch.exists, "no keyboard over the board after pairing")
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
        // In this device's words (shared/strings device.model.*): "Which iPad is this?" on an iPad.
        let model = pad ? "iPad" : "iPhone"
        XCTAssertTrue(a.staticTexts["Which \(model) is this?"].exists && a.staticTexts["A new \(model)"].exists, "Which \(model) is this?, A new \(model)")
        mark("which: Which \(model) is this? \(a.staticTexts["Which \(model) is this?"].exists)")
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

    // ------------------------------------------------------------ a launch from an alert

    /// Asks tools/ios-e2e.mjs to have iOS show an alert for that checkpoint (`simctl push`, as push will), titled `banner`.
    func pushAlert(_ id: String, kind: String, project: String, banner: String) {
        guard let dir = env["RAVENRY_SIG"] else { return }
        let alert: [String: Any] = ["v": 1, "type": "alert", "id": "cp:\(id)", "kind": kind, "title": banner, "body": "",
                                    "project": ["id": project, "name": project], "checkpoint": ["id": id, "kind": kind]]
        let s = String(decoding: (try? JSONSerialization.data(withJSONObject: alert)) ?? Data(), as: UTF8.self)
        let payload: [String: Any] = ["aps": ["alert": ["title": banner, "body": "Open it in Ravenry."]], "alert": s]
        let u = URL(fileURLWithPath: "\(dir)/push.wait")
        try? JSONSerialization.data(withJSONObject: payload).write(to: u)
        _ = until(10) { !FileManager.default.fileExists(atPath: u.path) }
    }

    /// Asks tools/ios-e2e.mjs to switch the simulator to dark or light (the person's Control Centre).
    func appearance(_ mode: String) {
        guard let dir = env["RAVENRY_SIG"] else { return }
        let u = URL(fileURLWithPath: "\(dir)/appearance.wait")
        try? Data(mode.utf8).write(to: u)
        _ = until(10) { !FileManager.default.fileExists(atPath: u.path) }
    }

    /// Text the app shows anywhere (its own views and the page's), read by accessibility: no script in the page,
    /// since a launch from an alert is iOS's, without the checks' launch settings.
    func appShows(_ a: XCUIApplication, _ text: String) -> Bool {
        a.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch.exists
    }

    /// The app opened from an alert, cold (the app not running: iOS starts it on the
    /// tap, the launch's Ink over it): its checkpoint's screen shows and the launch
    /// ends on it. The Ink held the formed raven and "Reaching your Mac..." for 15 s
    /// over a working screen before (it waited for a sign only the board gave); then
    /// a dark/light switch on that screen, past 12 s, changes nothing else.
    func test9b_ALaunchFromAnAlertEndsOnItsScreen() throws {
        if shotsOnly { return }
        continueAfterFailure = true
        let a = launch(reset: false)
        XCTAssertTrue(shows("recipe-box", timeout: 30), "the board")
        let cases: [(kind: String, project: String, spec: [String: Any], text: String)] = [
            ("pick", "paper-boat", ["kind": "pick", "project": "paper-boat", "title": "Which boat for the cover?",
                                    "variants": [["label": "Sail", "describe": "The boat with its sail up"], ["label": "Oars", "describe": "The boat rowed"]]], "Which boat for the cover?"),
            ("secret", "weather-widget", ["kind": "secret", "project": "weather-widget", "title": "Forecast service key"], "Forecast service key"),
            ("approve", "paper-boat", ["kind": "approve", "project": "paper-boat", "command": "echo \"from the alert: it ran\"", "why": "Opened from its alert."], "from the alert: it ran"),
        ]
        for (n, c) in cases.enumerated() {
            guard let id = newCard(c.spec) else { XCTFail("no \(c.kind) card"); continue }
            // (Only the checks' own launch runs script in the page; later ones are iOS's.)
            if n == 0 { _ = js("if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true;") }
            a.terminate()
            XCTAssertTrue(a.wait(for: .notRunning, timeout: 10), "the app stopped")
            let banner = "Ravenry check \(n + 1): \(c.kind)"
            pushAlert(id, kind: c.kind, project: c.project, banner: banner)
            let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            let note = sb.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", banner)).firstMatch
            XCTAssertTrue(note.waitForExistence(timeout: 15), "iOS shows the \(c.kind)'s alert")
            note.tap()
            XCTAssertTrue(a.wait(for: .runningForeground, timeout: 15), "the alert opens the app")
            let t0 = Date()
            let screen = until(20) { self.appShows(a, c.text) }
            let shownAt = Date().timeIntervalSince(t0)
            // The launch, watched past the 12 s and 15 s the hold had: its words never stay over the screen.
            var holdSeen: [Double] = []
            var gone: Double?
            while Date().timeIntervalSince(t0) < 16 {
                let held = appShows(a, "Reaching your Mac") || appShows(a, "didn't answer")
                let s = Date().timeIntervalSince(t0)
                if held { holdSeen.append(s); gone = nil } else if gone == nil { gone = s }
                if n == 0 && s > 5 && s < 5.6 { shot("alert-launch-pick-5s") }
                Thread.sleep(forTimeInterval: 0.4)
            }
            shot("alert-launch-\(c.kind)")
            let lastHeld = holdSeen.last ?? 0
            mark(String(format: "launch from the %@ alert: its screen %@ at %.1f s; the launch's words last seen at %.1f s (%d times)", c.kind, screen ? "shown" : "NOT shown", shownAt, lastHeld, holdSeen.count))
            XCTAssertTrue(screen, "the \(c.kind)'s own screen shows after its alert opened the app")
            XCTAssertTrue(lastHeld < 6, String(format: "the launch held \"Reaching your Mac...\" over the %@'s screen until %.1f s", c.kind, lastHeld))
            if n == 0 {
                // A dark/light switch on the checkpoint's screen, then past 12 s.
                let other = theme == "dark" ? "light" : "dark"
                appearance(other)
                let t1 = Date()
                var heldAfter = false
                while Date().timeIntervalSince(t1) < 14 {
                    if appShows(a, "Reaching your Mac") || appShows(a, "didn't answer") { heldAfter = true }
                    Thread.sleep(forTimeInterval: 0.5)
                }
                shot("alert-launch-pick-switched")
                let still = appShows(a, c.text)
                appearance(theme)
                mark("pick's screen after a \(other) switch and 14 s: screen \(still), launch words \(heldAfter)")
                XCTAssertTrue(still && !heldAfter, "a dark/light switch on the pick's screen: the screen stays, no launch words")
            }
        }
        // The app in the background (not stopped): a tap on an alert brings it back on that card's screen.
        let title = "Ship the boat from the alert?"
        guard let id = newCard(["kind": "ask", "project": "notes-app", "title": title, "options": ["Ship it", "Not yet"]]) else { XCTFail("no ask card"); return }
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(a.wait(for: .runningBackground, timeout: 10) || a.wait(for: .runningBackgroundSuspended, timeout: 5), "the app in the background")
        let banner = "Ravenry check 4: ask"
        pushAlert(id, kind: "ask", project: "notes-app", banner: banner)
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let note = sb.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", banner)).firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 15), "iOS shows the ask's alert")
        note.tap()
        XCTAssertTrue(a.wait(for: .runningForeground, timeout: 15), "the alert brings the app back")
        let shown = until(15) { self.appShows(a, title) }
        Thread.sleep(forTimeInterval: 3)
        let alive = a.state == .runningForeground
        shot("alert-warm-ask")
        mark("a tap on the ask's alert with the app in the background: its screen \(shown), the app still running \(alive)")
        XCTAssertTrue(shown && alive, "the ask's screen after its alert, with the app running")
    }

    // ------------------------------------------------------------ an alert through APNs (docs/PHONE.md section 4, "apns")

    /// The app gives the Mac its APNs token (a stand-in here: the simulator has no APNs of its own for an
    /// ad hoc build) and its alert key; with the app stopped, a new card goes from the test hub, sealed for
    /// this device, through the real relay to a stand-in APNs that hands it to the simulator (`simctl push`,
    /// tools/ios-e2e.mjs). `simctl push` runs no Notification Service Extension (the simulator's own path,
    /// seen 2026-11-19: no extension process starts), so iOS shows what Apple would have shown before it:
    /// the relay's fixed placeholder, never the card's words. A tap on it opens the app, which opens the
    /// sealed alert itself and lands on the card's own screen. What the extension draws, and the buttons it
    /// registers, are the unit tests' (PushTests: AlertContent.service on the same sealed bytes).
    func test9k_AnAlertThroughAPNsIsSealedAndOpensItsCard() throws {
        if shotsOnly { return }
        continueAfterFailure = true
        guard let sig = env["RAVENRY_SIG"] else { return }
        let a = launch(reset: false, ["RAVENRY_TEST_APNS_TOKEN": String(repeating: "5a", count: 32)])
        XCTAssertTrue(shows("recipe-box", timeout: 30), "the board")
        let target = URL(fileURLWithPath: "\(sig)/apns.target")
        let registered = until(20) { FileManager.default.fileExists(atPath: target.path) }
        let t = (try? Data(contentsOf: target)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        mark("apns target on the Mac: \(registered) \(t)")
        XCTAssertTrue(registered && t["environment"] as? String == "sandbox" && t["keys"] as? Bool == true, "the Mac has the app's apns target (a debug build: sandbox) with its key")
        a.terminate()
        XCTAssertTrue(a.wait(for: .notRunning, timeout: 10), "the app stopped")
        let question = "Ship it through APNs?"
        guard newCard(["kind": "ask", "project": "notes-app", "title": question, "options": ["Ship it", "Not yet"]]) != nil else { XCTFail("no ask card"); return }
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let note = sb.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Open Ravenry to see this alert")).firstMatch
        let shown = note.waitForExistence(timeout: 25)
        let label = shown ? note.label : ""
        shot("apns-alert-sealed")
        mark("the alert through APNs: shown \(shown), \"\(label)\"")
        XCTAssertTrue(shown && !label.contains(question) && !label.contains("notes-app"), "iOS gets the placeholder and sealed bytes only")
        guard shown else { return }
        note.tap()
        XCTAssertTrue(a.wait(for: .runningForeground, timeout: 15), "the alert opens the app")
        let opened = until(20) { self.appShows(a, question) }
        shot("apns-alert-opened")
        mark("the sealed alert's tap: the card's screen \(opened)")
        XCTAssertTrue(opened, "the app opens the sealed alert itself and shows the card's own screen")
    }

    // ------------------------------------------------------------ a card in no project, its videos (the pickvideo round, 2026-11-16)

    /// The video elements a selector finds: each one's time, whether it plays, its frame's state, its width, its source.
    func videos(_ sel: String) -> [[String: Any]] {
        guard let s = js("return [...document.querySelectorAll('\(sel)')].map((v) => ({ t: v.currentTime, paused: v.paused, rs: v.readyState, w: v.videoWidth, src: v.getAttribute('src') || '', err: v.error ? v.error.code : 0 }));"),
              let o = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [[String: Any]] else { return [] }
        return o
    }

    /// The card's row (the wide layout) or chip (the column, an iPhone), shown, with the pane's name.
    func looseCardShown(_ id: String, _ label: String) -> Bool {
        let code = "const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none'; const r = document.querySelector('#list .row[data-id=\"cp:\(id)\"]'), c = document.querySelector('#pchips .pchip[data-id=\"cp:\(id)\"]'); return (vis(r) && r.innerText.includes('Video test')) || (vis(c) && c.innerText.includes('Video test'));"
        let ok = until(20) { self.js(code) == "true" }
        mark("the card in no project, \(label): \(ok); \(jsObject("return { w: innerWidth, row: !!document.querySelector('#list .row[data-id=\"cp:\(id)\"]'), chip: !!document.querySelector('#pchips .pchip[data-id=\"cp:\(id)\"]'), cps: ((window.__rvSnapCps) || null), title: document.title };"))")
        return ok
    }

    /// The pairing for test9d and test9e alone (`--only test9a_PairByTheLinkAlone,test9d_...`): by the link, no
    /// field typed (a typed field's text session, then iOS's alerts ask taking the app away and back, crashed
    /// XCTest's own runtime-issue hook in the app on 2026-11-16, iPad, iOS 18.3), Not now to the alerts.
    func test9a_PairByTheLinkAlone() throws {
        let (_, card) = hub("GET", "/api/phone?code=new")
        let link = (card["app"] as? [String: Any])?["link"] as? String ?? ""
        let a = launch(reset: true)
        XCTAssertTrue(a.buttons["type-instead"].waitForExistence(timeout: 10))
        a.open(URL(string: link)!)
        XCTAssertTrue(a.buttons["pair-confirm"].waitForExistence(timeout: 10), "the link asks first")
        a.buttons["pair-confirm"].tap()
        let next = a.buttons["which-continue"], later = a.buttons["alerts-not-now"]
        _ = until(20) { next.exists || later.exists }
        if next.exists { next.tap(); _ = later.waitForExistence(timeout: 10) }
        if later.exists { later.tap() }
        XCTAssertTrue(shows("recipe-box", timeout: 30), "the board after pairing by the link")
        a.terminate()
    }

    /// A project's picture (a PNG the session showed) opened from its card shows as a picture in the gallery's viewer:
    /// the <img> decoded and on top at the viewer's centre, no video player drawn (on 2026-11-17 an Android phone showed
    /// a dead video over it: the hub's board drew the hidden player, its display rule undoing `hidden`).
    func test9j_AGalleryPictureOpensAsAPicture() throws {
        if shotsOnly { return }
        continueAfterFailure = true
        let a = launch(reset: false)
        XCTAssertTrue(shows("recipe-box", timeout: 30), "the board")
        let opened = until(20) { self.js("const c = document.querySelector('#pchips .pchip[data-id=\"garden-planner\"]'); if (c && c.getAttribute('aria-current') !== 'true') c.click(); const p = document.querySelector('.picard'); const i = p && p.querySelector('img'); if (!p || !i || !i.naturalWidth) return false; p.scrollIntoView({ block: 'center' }); p.click(); const l = document.querySelector('#gl-fs'); return !!l && !l.hidden;") == "true" }
        XCTAssertTrue(opened, "garden-planner's picture card opens the gallery")
        var seen = ""
        let picture = until(15) {
            seen = self.js("const v = document.querySelector('#gl-view'), i = document.querySelector('#gl-im'), vid = document.querySelector('#gl-vid'); if (!v || !i || !i.complete || !i.naturalWidth) return 'loading'; const r = v.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return 'top ' + (t ? (t.id || t.tagName) : 'none') + ', natural ' + i.naturalWidth + 'x' + i.naturalHeight + ', player ' + getComputedStyle(vid).display;") ?? ""
            return seen.contains("top gl-im,") && seen.contains("player none")
        }
        mark("test9j viewer: \(seen)")
        XCTAssertTrue(picture, "the PNG shows as a picture: decoded, on top, no video player drawn (\(seen))")
        shot("gallery-png")
        a.terminate()
    }

    /// A card asked from a pane in no project reaches every layout (the iPad's wide board and its column, an
    /// iPhone), its page opens the pick's screen, and its videos show their first frames and play there, through
    /// the app's shell (a player's parts, 206): A plays inline, a seek plays on, B (a page's video) plays.
    /// Settings' Privacy row hands the privacy page to Safari (Board.swift createWebViewWith: a link that opens a window leaves the app).
    func test9g_PrivacyOpensInSafari() throws {
        if shotsOnly { return }
        let a = launch(reset: false)
        XCTAssertTrue(shows("recipe-box", timeout: 30), "paired, the board")
        // Settings, as a person reaches it: the board's menu, then This phone (the phone board's #/settings).
        XCTAssertTrue(until(10) { js("const b = document.querySelector('#pb-more'); if (!b) return false; b.click(); return true;") == "true" }, "the board's menu")
        XCTAssertTrue(until(10) { js("const b = document.querySelector('#pmenu [data-act=pn-app]'); if (!b) return false; b.click(); return true;") == "true" }, "This phone, in the menu")
        let want = env["RAVENRY_PRIVACY_URL"] ?? ""
        XCTAssertTrue(want.hasPrefix("https://") && want.hasSuffix("/privacy.html"), "the privacy page's address: \(want)")
        XCTAssertTrue(until(15) { js("const r = document.querySelector('a.setr[data-k=privacy]'); if (!r) return null; r.scrollIntoView({ block: 'center' }); return r.getAttribute('href');")?.replacingOccurrences(of: "\\/", with: "/") == "\"\(want)\"" }, "Settings has the Privacy row, a link to the privacy page")
        Thread.sleep(forTimeInterval: 1.0)
        shot("settings-privacy")
        let row = a.webViews.links.matching(NSPredicate(format: "label BEGINSWITH 'Privacy'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the Privacy row, as a person sees it")
        row.tap()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 20), "Safari comes to the front")
        let host = URL(string: want)?.host ?? "?"
        let shown = safari.descendants(matching: .any).matching(NSPredicate(format: "value CONTAINS %@ OR label CONTAINS %@", host, host)).firstMatch
        XCTAssertTrue(shown.waitForExistence(timeout: 20), "Safari shows the privacy page's address (\(host))")
        mark("privacy: Safari in front on \(host)")
        shot("privacy-safari")
        safari.terminate()
    }

    /// The board's Attach on an iPhone (PHONE-038): the web view's own file input (iOS's menu: Photo Library, Take
    /// Photo, Choose File), each file then posted through the shell as on the Mac (POST /api/inbox). A document from
    /// Files (On My iPhone, put there by tools/ios-e2e.mjs) and a photo from the library land in the project's .inbox
    /// byte for byte, each as a chip; a picker cancelled changes nothing, and Attach opens again after.
    func test9h_AttachAFileAndAPhoto() throws {
        if shotsOnly { return }
        executionTimeAllowance = 300
        let a = launch(reset: false)
        XCTAssertTrue(shows("garden-planner", timeout: 30), "paired, the board")
        let (_, st) = hub("GET", "/api/state")
        let folder = ((st["projects"] as? [[String: Any]] ?? []).first { $0["id"] as? String == "garden-planner" }?["folder"] as? String) ?? ""
        XCTAssertFalse(folder.isEmpty, "garden-planner's folder on the Mac")
        let inbox = folder + "/.inbox"
        func inboxNow() -> [String] { ((try? FileManager.default.contentsOfDirectory(atPath: inbox)) ?? []).filter { !$0.hasPrefix(".") }.sorted() }
        func chips() -> [String] {
            guard let s = js("return [...document.querySelectorAll('#chips .chip')].map((e) => e.textContent.trim());"), let d = s.data(using: .utf8) else { return [] }
            return (try? JSONSerialization.jsonObject(with: d) as? [String]) ?? []
        }
        let saved = { (n: Int) in self.until(40) { let c = chips(); return c.count >= n && !c.contains { $0.hasPrefix("Saving ") } } }
        // A tap where the person taps: the label's middle, in the web view (a script's click opens no picker).
        func tapAttach() -> Bool {
            guard let s = js("const e = document.querySelector('#composer label.attach'); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2];"),
                  let d = s.data(using: .utf8), let xy = (try? JSONSerialization.jsonObject(with: d)) as? [Double], xy.count == 2 else { return false }
            a.webViews.firstMatch.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: xy[0], dy: xy[1])).tap()
            return true
        }
        func any(_ format: String) -> XCUIElement { a.descendants(matching: .any).matching(NSPredicate(format: format)).firstMatch }
        XCTAssertTrue(press("garden-planner"), "the chip garden-planner")
        XCTAssertTrue(until(10) { js("return !!document.querySelector('#composer label.attach');") == "true" }, "the message box's Attach")
        let before = inboxNow()

        // 1. A document from Files.
        XCTAssertTrue(tapAttach(), "Attach tapped")
        let choose = any("label BEGINSWITH 'Choose File'")
        XCTAssertTrue(choose.waitForExistence(timeout: 10), "iOS's menu for a file input: Choose File")
        mark("attach menu: \(["Photo Library", "Take Photo", "Take Photo or Video", "Choose File", "Choose Files"].filter { any("label == '\($0)'").exists })")
        shot("attach-menu")
        choose.tap()
        let doc = any("label CONTAINS 'site-notes'")
        if !doc.waitForExistence(timeout: 8) {
            let browse = a.buttons["Browse"]
            if browse.waitForExistence(timeout: 5) { browse.tap(); if !any("label == 'On My iPhone'").waitForExistence(timeout: 3) { browse.tap() } }
            let mine = any("label == 'On My iPhone'")
            if mine.waitForExistence(timeout: 8) { mine.tap() }
        }
        XCTAssertTrue(doc.waitForExistence(timeout: 15), "Files shows site-notes.pdf")
        shot("attach-files")
        doc.tap()
        let open = a.buttons["Open"]
        if open.waitForExistence(timeout: 4) && open.isEnabled { open.tap() }
        XCTAssertTrue(saved(1), "the document's chip in the message box: \(chips())")
        let got = inboxNow().filter { !before.contains($0) }
        let src = env["RAVENRY_ATTACH_DOC"] ?? ""
        let same = got.count == 1 && FileManager.default.contentsEqual(atPath: inbox + "/" + got[0], andPath: src)
        mark("attach doc: \(got), the same bytes as \(src): \(same); chips \(chips())")
        XCTAssertTrue(same, "site-notes.pdf in garden-planner's .inbox, byte for byte: \(got)")
        Thread.sleep(forTimeInterval: 0.6)
        shot("attach-card")

        // 2. Cancel: the picker opened and cancelled changes nothing; Attach opens again after.
        let c0 = chips(), i0 = inboxNow()
        XCTAssertTrue(tapAttach(), "Attach tapped again")
        XCTAssertTrue(choose.waitForExistence(timeout: 10), "the menu again")
        choose.tap()
        let cancel = a.buttons["Cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 10), "the picker's Cancel")
        cancel.tap()
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertEqual(chips(), c0, "a cancelled picker leaves the chips")
        XCTAssertEqual(inboxNow(), i0, "and the .inbox")

        // 3. A photo from the library (the photo picker needs no access to the library).
        XCTAssertTrue(tapAttach(), "Attach after a cancel")
        let lib = any("label == 'Photo Library'")
        XCTAssertTrue(lib.waitForExistence(timeout: 10), "the menu after a cancel: Photo Library")
        lib.tap()
        // The photo picker (out of the app's process): its cells say "Photo, <date>".
        let photo = any("label BEGINSWITH 'Photo,' AND NOT (label CONTAINS ', Photo,')")
        if !photo.waitForExistence(timeout: 20) { mark("photo picker: \(String(a.debugDescription.prefix(6000)))") }
        Thread.sleep(forTimeInterval: 1)
        shot("attach-photos")
        XCTAssertTrue(photo.exists, "the photo picker shows the library's photo")
        mark("photo picked: \(photo.label)")
        photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        for name in ["Add", "Done"] { let b = a.buttons[name]; if b.waitForExistence(timeout: 3) && b.isEnabled { b.tap(); break } }
        XCTAssertTrue(saved(c0.count + 1), "the photo's chip: \(chips())")
        let got3 = inboxNow().filter { !i0.contains($0) }
        let size = got3.first.flatMap { (try? FileManager.default.attributesOfItem(atPath: inbox + "/" + $0))?[.size] as? Int } ?? 0
        let psrc = env["RAVENRY_ATTACH_PHOTO"] ?? ""
        let psame = got3.count == 1 && FileManager.default.contentsEqual(atPath: inbox + "/" + got3[0], andPath: psrc)
        mark("attach photo: \(got3), \(size) bytes, the same bytes as the library's: \(psame); chips \(chips())")
        XCTAssertTrue(got3.count == 1 && size > 0 && psame, "the photo in garden-planner's .inbox, byte for byte: \(got3)")
        Thread.sleep(forTimeInterval: 0.6)
        shot("attach-card-photo")

        // 4. A big file (tools/ios-e2e.mjs --attach-mb N): sent to the shell in parts, it lands byte for byte.
        guard let big = env["RAVENRY_ATTACH_BIG"], !big.isEmpty else { return }
        let name = (big as NSString).lastPathComponent, stem = (name as NSString).deletingPathExtension
        let c4 = chips().count, i4 = inboxNow()
        XCTAssertTrue(tapAttach(), "Attach for the big file")
        XCTAssertTrue(choose.waitForExistence(timeout: 10), "the menu: Choose File")
        choose.tap()
        let bigDoc = any("label CONTAINS '\(stem)'")
        if !bigDoc.waitForExistence(timeout: 8) {
            let browse = a.buttons["Browse"]
            if browse.waitForExistence(timeout: 5) { browse.tap() }
            let mine = any("label == 'On My iPhone'")
            if mine.waitForExistence(timeout: 8) { mine.tap() }
        }
        XCTAssertTrue(bigDoc.waitForExistence(timeout: 15), "Files shows \(name)")
        bigDoc.tap()
        if open.waitForExistence(timeout: 4) && open.isEnabled { open.tap() }
        let t0 = Date()
        XCTAssertTrue(until(120) { let c = chips(); return c.count > c4 && !c.contains { $0.hasPrefix("Saving ") } }, "the big file's chip: \(chips())")
        let got4 = inboxNow().filter { !i4.contains($0) }
        let bsame = got4.count == 1 && FileManager.default.contentsEqual(atPath: inbox + "/" + got4[0], andPath: big)
        mark("attach big: \(got4), the same bytes: \(bsame), \(Int(Date().timeIntervalSince(t0))) s from the pick to its chip")
        XCTAssertTrue(bsame, "\(name) in the .inbox, byte for byte: \(got4)")
        shot("attach-card-big")
    }

    func test9d_ACardInNoProjectAndItsVideos() throws {
        if shotsOnly { return }
        continueAfterFailure = true
        if pad { rotate(.landscapeLeft) }
        let a = launch(reset: false)
        XCTAssertTrue(shows("recipe-box", timeout: 30), "the board")
        guard let id = newCard(["kind": "pickvideo", "name": "Video test"]) else { XCTFail("no card"); return }
        if pad {
            XCTAssertTrue(looseCardShown(id, "sideways, the wide layout"), "the card in no project shows in the wide layout")
            shot("ipad-wide-card-no-project")
            rotate(.portrait)
            XCTAssertTrue(looseCardShown(id, "upright, the column"), "the card in no project shows in the column")
            shot("ipad-column-card-no-project")
        } else {
            XCTAssertTrue(looseCardShown(id, "an iPhone"), "the card in no project shows on an iPhone")
            shot("iphone-card-no-project")
        }
        // Its page: the card; its Compare opens the pick's own screen.
        _ = js("const vis = (x) => !!x && x.getClientRects().length > 0; const r = document.querySelector('#list .row[data-id=\"cp:\(id)\"]'), c = document.querySelector('#pchips .pchip[data-id=\"cp:\(id)\"]'); const e = vis(r) ? r : c; if (e) e.click(); return !!e;")
        let compare = until(15) { self.js("const b = document.querySelector('[data-act=\"cp-open\"][data-cp=\"\(id)\"]'); if (!b || !b.getClientRects().length) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true;") == "true" }
        XCTAssertTrue(compare, "its page shows the card, with Compare")
        // The pick's screen: each video's first frame (a picture drawn once, or the canvas it was drawn on when the
        // page may not read it: WebM through the app's shell, no player of its own).
        var first: [[String: Any]] = []
        let frames = until(40) {
            let s = self.js("return [...document.querySelectorAll('.ptrack .pimg')].filter((x) => x.querySelector('.pk-play')).map((x) => { const i = x.querySelector('img'), c = x.querySelector('canvas[data-frame]'); return { video: !!x.querySelector('video'), w: c ? c.width : i && i.complete ? i.naturalWidth : 0 }; });") ?? "[]"
            first = (try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [[String: Any]]) ?? []
            return first.count == 3 && first.allSatisfy { ($0["video"] as? Bool) == false && ($0["w"] as? Int ?? 0) > 0 }
        }
        mark("first frames on the pick's screen: \(first)")
        XCTAssertTrue(frames, "each video's first frame on the pick's screen")
        Thread.sleep(forTimeInterval: 0.5)
        shot("pick-video-track")
        // A tap on A: the viewer, where it plays inline.
        _ = js("const s = document.querySelector('.ptrack .pimg'); if (s) s.click(); return !!s;")
        var p0: [[String: Any]] = []
        let started = until(20) { p0 = self.videos(".pzv-box video.pzv-vid"); return (p0.first?["t"] as? Double ?? 0) > 0.2 }
        Thread.sleep(forTimeInterval: 1.5)
        let p1 = videos(".pzv-box video.pzv-vid")
        let moved = (p1.first?["t"] as? Double ?? 0) > (p0.first?["t"] as? Double ?? 0) + 0.8 && (p1.first?["paused"] as? Bool) == false
        mark("A in the viewer: \(p0) then \(p1)")
        XCTAssertTrue(started && moved, "A plays inline in the viewer (its time moves on)")
        shot("pick-video-playing")
        // A seek (the scrub bar's job: its parts asked through the app's shell), and it plays on.
        _ = js("const v = document.querySelector('.pzv-box video.pzv-vid'); if (v) v.currentTime = 4.5; return !!v;")
        var sk: [String: Any] = [:]
        let sought = until(10) { sk = self.videos(".pzv-box video.pzv-vid").first ?? [:]; let t = sk["t"] as? Double ?? 0; return t > 4.7 && t < 6 && (sk["paused"] as? Bool) == false }
        mark("a seek to 4.5 s: \(sk)")
        XCTAssertTrue(sought, "a seek, and it plays on")
        // B: the page's video, from the strip.
        _ = js("const t = document.querySelectorAll('.pzv-th')[1]; if (t) t.click(); return !!t;")
        var b0: [[String: Any]] = []
        let bs = until(20) { b0 = self.videos(".pzv-box video.pzv-vid"); return ((b0.first?["src"] as? String) ?? "").hasSuffix("as=video") && (b0.first?["t"] as? Double ?? 0) > 0.2 }
        Thread.sleep(forTimeInterval: 1.2)
        let b1 = videos(".pzv-box video.pzv-vid")
        mark("B, the page's video: \(b0) then \(b1)")
        XCTAssertTrue(bs && (b1.first?["t"] as? Double ?? 0) > (b0.first?["t"] as? Double ?? 0) + 0.6, "B, the page's video, plays")
        a.terminate()
        if pad { rotate(.portrait) }
    }

    /// A pick whose videos this device cannot decode (test9i, PICKVIDEO_CANT=1 with a VP9 or AV1 clip: the iOS
    /// simulator has neither decoder): the track and the viewer show the still that says "This video can't play
    /// here", with no play mark and no player waiting, and the picture between them still shows.
    func test9i_AVideoThatCannotPlayHere() throws {
        if shotsOnly { return }
        guard env["RAVENRY_PICKVIDEO_CANT"] == "1" else { throw XCTSkip("no clips this simulator cannot decode (PICKVIDEO_CANT=1)") }
        continueAfterFailure = true
        let a = launch(reset: false)
        XCTAssertTrue(shows("recipe-box", timeout: 30), "the board")
        guard let id = newCard(["kind": "pickvideo", "name": "Video test"]) else { XCTFail("no card"); return }
        _ = looseCardShown(id, "videos it cannot play")
        _ = js("const vis = (x) => !!x && x.getClientRects().length > 0; const r = document.querySelector('#list .row[data-id=\"cp:\(id)\"]'), c = document.querySelector('#pchips .pchip[data-id=\"cp:\(id)\"]'); const e = vis(r) ? r : c; if (e) e.click(); return !!e;")
        let compare = until(15) { self.js("const b = document.querySelector('[data-act=\"cp-open\"][data-cp=\"\(id)\"]'); if (!b || !b.getClientRects().length) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true;") == "true" }
        XCTAssertTrue(compare, "its page shows the card, with Compare")
        var track = ""
        let stills = until(30) {
            track = self.js("return [...document.querySelectorAll('.ptrack .pimg')].map((s) => { const c = s.querySelector('.pcant'); return c ? 'still: ' + c.textContent + (s.querySelector('.pk-play') ? ' +play' : '') : s.querySelector('img') ? 'picture' : 'none'; }).join(' | ');") ?? ""
            return track.components(separatedBy: "still: This video can't play here").count == 4 && !track.contains("+play") && track.contains("picture")
        }
        mark("test9i track: \(track)")
        XCTAssertTrue(stills, "the track: each video the still that says it can't play here, the picture as it is")
        shot("pick-cant-track")
        _ = js("const s = document.querySelector('.ptrack .pimg'); if (s) s.click(); return !!s;")
        var view = ""
        let viewer = until(15) {
            view = self.js("const c = document.querySelector('.pzv-box .pcant'); return (c ? c.textContent : 'none') + ', players ' + document.querySelectorAll('video.pzv-vid').length;") ?? ""
            return view.contains("This video can't play here, players 0")
        }
        mark("test9i viewer: \(view)")
        XCTAssertTrue(viewer, "the viewer: the still, no player")
        shot("pick-cant-viewer")
        a.terminate()
    }

    /// A pick of two videos (test9f, as on the person's iPad on 2026-11-16: the 30 s and 15 s cuts): one plays at a
    /// time. In the pick's full screen, each change (the strip to the other one, the close, the open again) leaves the
    /// one left paused, its time still, and the one come to playing (its time moves on), five times back and forth.
    func test9f_APicksVideosPlayOneAtATime() throws {
        if shotsOnly { return }
        continueAfterFailure = true
        let a = launch(reset: false)
        XCTAssertTrue(shows("recipe-box", timeout: 30), "the board")
        guard let id = newCard(["kind": "pickvideo", "two": true, "name": "Video test"]) else { XCTFail("no card"); return }
        _ = looseCardShown(id, "two videos")
        _ = js("const vis = (x) => !!x && x.getClientRects().length > 0; const r = document.querySelector('#list .row[data-id=\"cp:\(id)\"]'), c = document.querySelector('#pchips .pchip[data-id=\"cp:\(id)\"]'); const e = vis(r) ? r : c; if (e) e.click(); return !!e;")
        let compare = until(15) { self.js("const b = document.querySelector('[data-act=\"cp-open\"][data-cp=\"\(id)\"]'); if (!b || !b.getClientRects().length) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true;") == "true" }
        XCTAssertTrue(compare, "its page shows the card, with Compare")
        XCTAssertTrue(until(20) { self.js("return document.querySelectorAll('.ptrack .pimg').length === 2;") == "true" }, "the pick's screen, its two videos")
        // Their first frames, pictures with no player of their own.
        var track = ""
        let frames = until(30) { track = self.js("return [...document.querySelectorAll('.ptrack .pimg')].map((s) => { const i = s.querySelector('img'), v = s.querySelector('video'); return v ? 'video' : i && i.complete && i.naturalWidth > 0 ? 'picture ' + i.naturalWidth : 'none'; }).join(', ');") ?? ""; return track.components(separatedBy: "picture ").count == 3 }
        mark("the track's first frames: \(track)")
        XCTAssertTrue(frames, "the track shows each video's first frame as a picture, no player")
        shot("pick-switch-track")
        // Every video element the page makes or plays, kept here to be read (one left behind still playing shows).
        _ = js("""
        if (!window.__pv) {
          window.__pv = new Set();
          const p = HTMLMediaElement.prototype.play;
          HTMLMediaElement.prototype.play = function () { window.__pv.add(this); return p.apply(this, arguments); };
          const scan = () => { for (const v of document.querySelectorAll('video')) window.__pv.add(v); };
          new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
          scan();
        }
        return true;
        """)
        let read = "const cur = document.querySelector('.pzv-box video.pzv-vid'); return [...window.__pv].map((v) => ({ n: ((v.currentSrc || v.getAttribute('src') || '').match(/variants\\/(\\d)/) || [])[1] || '-', t: Math.round(v.currentTime * 100) / 100, paused: v.paused, rs: v.readyState, live: v.isConnected, cur: v === cur, holds: !!v.getAttribute('src') && v.networkState !== 0, err: v.error ? v.error.code : 0 }));"
        func all() -> [[String: Any]] {
            guard let s = js(read), let o = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [[String: Any]] else { return [] }
            return o
        }
        let playing = { (l: [[String: Any]]) in l.filter { ($0["paused"] as? Bool) == false && ($0["n"] as? String) != "-" } }
        /// After a change to variant n: the viewer's video is n and plays on (its time moves on), every other is paused and still.
        func came(_ n: Int, _ label: String) -> Bool {
            let t0 = Date()
            var s0: [[String: Any]] = []
            let started = until(25) { s0 = all(); return s0.contains { ($0["cur"] as? Bool) == true && ($0["n"] as? String) == "\(n)" && ($0["paused"] as? Bool) == false && ($0["t"] as? Double ?? 0) > 0.05 } }
            let wait = Date().timeIntervalSince(t0)
            Thread.sleep(forTimeInterval: 1.5)
            let s1 = all()
            let curT = { (l: [[String: Any]]) in l.first { ($0["cur"] as? Bool) == true }?["t"] as? Double ?? -1 }
            let moved = started && curT(s1) > curT(s0) + 0.7
            // Every other element: paused, its time where it was.
            var still = true
            for (k, e) in s1.enumerated() where (e["cur"] as? Bool) != true {
                if (e["paused"] as? Bool) == false { still = false }
                if k < s0.count, let a0 = s0[k]["t"] as? Double, let a1 = e["t"] as? Double, abs(a1 - a0) > 0.05 { still = false }
            }
            let one = playing(s1).count == 1
            // No other element holds a video (a player left behind loads on, and takes a decoder on a device).
            let holding = s1.filter { ($0["holds"] as? Bool) == true && ($0["n"] as? String) != "-" }.count
            mark("\(label): \(started ? "played after \(String(format: "%.1f", wait)) s" : "NOT playing after \(String(format: "%.1f", wait)) s"), moved \(moved), the others still \(still), playing \(playing(s1).count), holding a video \(holding); \(s1)")
            XCTAssertTrue(started && moved, "\(label): it plays (its time moves on)")
            XCTAssertTrue(still && one, "\(label): the one left is paused, only one plays")
            XCTAssertEqual(holding, 1, "\(label): only the one up close holds a video")
            return started && moved && still && one && holding == 1
        }
        // The full screen on the first, then the strip to the other and back, five times.
        _ = js("const s = document.querySelector('.ptrack .pimg[data-n=\"0\"]'); if (s) s.click(); return !!s;")
        var ok = came(0, "open on the 30 s")
        shot("pick-switch-first")
        for r in 1...5 {
            _ = js("const t = document.querySelectorAll('.pzv-th')[1]; if (t) t.click(); return !!t;")
            ok = came(1, "round \(r): to the 15 s") && ok
            _ = js("const t = document.querySelectorAll('.pzv-th')[0]; if (t) t.click(); return !!t;")
            ok = came(0, "round \(r): back to the 30 s") && ok
        }
        shot("pick-switch-after-five")
        // The full screen closed: nothing plays. Opened again on the other: it plays, alone.
        _ = js("const b = document.querySelector('.pzv-bar .icon-btn'); if (b) b.click(); return !!b;")
        var cl: [[String: Any]] = []
        let quiet = until(5) { cl = all(); return playing(cl).isEmpty && !cl.contains { ($0["holds"] as? Bool) == true && ($0["n"] as? String) != "-" } }
        mark("the full screen closed: playing \(playing(cl).count); \(cl)")
        XCTAssertTrue(quiet, "the full screen closed: no video plays on or is held")
        _ = js("const s = document.querySelector('.ptrack .pimg[data-n=\"1\"]'); if (s) s.click(); return !!s;")
        ok = came(1, "open again on the 15 s") && ok
        _ = js("const b = document.querySelector('.pzv-bar .icon-btn'); if (b) b.click(); return !!b;")
        let quiet2 = until(5) { playing(all()).isEmpty }
        XCTAssertTrue(quiet2, "closed again: no video plays on")
        mark("test9f: \(ok && quiet && quiet2 ? "every change played the one come to and paused the one left" : "FAILED")")
        a.terminate()
    }

    /// A board opened before the Mac's hub updated (test9e): the board files of an older Mac, then a newer
    /// one's swapped over the test hub's (tools/ios-e2e.mjs, a --hub copy), as an update of the Mac does with
    /// the page left open. The page takes the new board at once, with no relaunch: a card in no project, which
    /// only the newer board shows, appears on it.
    func test9e_ABoardOpenedBeforeTheMacUpdated() throws {
        if shotsOnly { return }
        guard let old = env["RAVENRY_BOARD_OLD"], let new = env["RAVENRY_BOARD_NEW"], !old.isEmpty, !new.isEmpty, let sig = env["RAVENRY_SIG"] else { throw XCTSkip("no older and newer board files (RAVENRY_BOARD_OLD, RAVENRY_BOARD_NEW)") }
        continueAfterFailure = true
        let swap = { (dir: String) in
            try? Data(dir.utf8).write(to: URL(fileURLWithPath: "\(sig)/swap.wait"))
            _ = self.until(10) { !FileManager.default.fileExists(atPath: "\(sig)/swap.wait") }
        }
        swap(old)
        if pad { rotate(.landscapeLeft) }
        let a = launch(reset: false)
        XCTAssertTrue(shows("recipe-box", timeout: 30), "the board, the older Mac's")
        _ = js("window.__rvOld = 'page before the update'; return true;")
        guard let id = newCard(["kind": "pickvideo", "name": "Video test"]) else { XCTFail("no card"); return }
        let before = looseCardShown(id, "the older board")
        mark("before the update: the card in no project shown \(before) (the older board has no row for it)")
        swap(new)
        let after = looseCardShown(id, "after the Mac's update, the page left open")
        let reloaded = js("return window.__rvOld || null;") != "\"page before the update\""
        mark("after the update: the card shown \(after), the page loaded again \(reloaded)")
        XCTAssertTrue(after, "after the Mac's update, the open board shows the card in no project with no relaunch")
        shot("after-update-card-no-project")
        a.terminate()
        if pad { rotate(.portrait) }
    }

    // ------------------------------------------------------------ the iPad (C, picked 2026-11-15)

    var pad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    /// A line of script whose answer is an object.
    func jsObject(_ body: String) -> [String: Any] {
        guard let s = js(body), let o = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] else { return [:] }
        return o
    }

    /// The width the board should have in this room (Board.swift BoardController.width).
    func want(_ room: Double, page: Bool = false) -> Double { page ? min(room, 640) : room >= 1000 ? room : min(room, 700) }

    /// Where the board is and how it lays out: the web view's frame on the screen, and what the page draws.
    func layout(_ a: XCUIApplication) -> (x: Double, w: Double, room: Double, page: [String: Any]) {
        let f = a.webViews.firstMatch.frame
        let o = jsObject("""
        const vis = (s) => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden'; };
        return { w: innerWidth, list: vis('#list'), bnav: vis('#bnav'), path: location.pathname, hash: location.hash, same: window.__rvIpad || null };
        """)
        return (Double(f.minX), Double(f.width), Double(a.windows.firstMatch.frame.width), o)
    }

    /// The board in the room it has: the wide layout (the projects' list beside the open project) from 1000 pt, else
    /// the phone board in its column (its bottom bar, no list), centred; `room` names a simulated Split View's.
    @discardableResult
    func layoutIs(_ a: XCUIApplication, _ label: String, room: Double? = nil) -> Bool {
        var L = layout(a)
        let r = room ?? L.room
        let w = want(r)
        _ = until(10) { L = self.layout(a); return abs(L.w - w) < 1 && abs((L.page["w"] as? Double ?? 0) - w) < 1 }
        let wide = w >= 1000
        let x = room != nil ? 0 : ((r - w) / 2).rounded()
        let ok = abs(L.w - w) < 1 && abs(L.x - x) < 1 && abs((L.page["w"] as? Double ?? 0) - w) < 1
            && (L.page["list"] as? Bool) == wide && (L.page["bnav"] as? Bool) == !wide
        mark("layout \(label): room \(r), web view x \(L.x) w \(L.w), page \(L.page); wanted w \(w) x \(x) \(wide ? "wide" : "column"): \(ok)")
        XCTAssertTrue(ok, "\(label): \(wide ? "the board's wide layout" : "the phone board's column") at \(w) of \(r) pt (got x \(L.x) w \(L.w), \(L.page))")
        return ok
    }

    /// The Mac's own controls are not on the iPad: Open in <terminal>, the Mac's notifications bell, its phone button.
    func noMacOnly(_ label: String) {
        let o = jsObject("""
        const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
        const hits = [...document.querySelectorAll('[data-act="open"], #alerts, #phone-anchor, #phone, button')].filter(vis)
          .filter((e) => e.matches('[data-act="open"], #alerts, #phone-anchor, #phone') || /^Open in /.test((e.innerText || '').trim()));
        return { n: hits.length, what: hits.map((e) => e.id || (e.innerText || '').trim()).join(', ') };
        """)
        mark("Mac-only controls \(label): \(o)")
        XCTAssertEqual(o["n"] as? Int, 0, "no Mac-only control (\(label)): \(o["what"] ?? "?")")
    }

    func cp(_ id: String) -> [String: Any]? {
        let (_, j) = hub("GET", "/api/checkpoints?all")
        return (j["checkpoints"] as? [[String: Any]] ?? []).first { $0["id"] as? String == id }
    }

    /// The room of a simulated Split View or Slide Over (the app's debug TestDrive draws the board in it); 0: the whole window.
    func room(_ pt: Int) {
        guard let sig = env["RAVENRY_SIG"] else { return }
        try? Data("\(pt)".utf8).write(to: URL(fileURLWithPath: "\(sig)/drive/room"))
        _ = until(5) { !FileManager.default.fileExists(atPath: "\(sig)/drive/room") }
    }

    func rotate(_ o: UIDeviceOrientation) {
        XCUIDevice.shared.orientation = o
        Thread.sleep(forTimeInterval: 1.5)
    }

    /// The app on an iPad, full screen (C, picked 2026-11-15): the phone board in a centred column upright and in Split
    /// View, the board's wide layout sideways (and on a 13-inch both ways), switched live by a rotation with the
    /// open project and its card kept; cards arriving live, Run with Face ID, a pick opened and zoomed and an
    /// alert's screen in the wide layout; no launch hold in either; none of the Mac's own controls; iPad words.
    func test9c_TheIPadLayoutsFollowTheRoom() throws {
        guard pad else { throw XCTSkip("an iPad's check") }
        continueAfterFailure = true
        rotate(.portrait)
        var a = launch(reset: false)
        XCTAssertTrue(shows("recipe-box", timeout: 30), "the board")
        let upright = layout(a).room
        layoutIs(a, "upright")
        _ = js("window.__rvIpad = 'same page'; return true;")

        // A card arriving live, upright, on the open project.
        let one = newCard(["kind": "approve", "project": "weather-widget", "command": "echo \"ipad one: it ran\"", "why": "A card on the iPad, upright."])
        XCTAssertNotNil(one)
        XCTAssertTrue(onBoard("weather-widget", "ipad one: it ran"), "a card arriving live shows upright")
        noMacOnly("upright")
        if upright < 1000 {
            // The phone board's menu: This iPad (the app's own settings), and the connection chip in its bar.
            let menu = jsObject("const b = document.querySelector('#pb-more'); if (b) b.click(); return { more: !!b };")
            let words = until(5) { self.js("const m = document.querySelector('#pmenu'); return !!m && m.innerText.includes('This iPad');") == "true" }
            mark("upright menu: \(menu), This iPad \(words)")
            XCTAssertTrue(words, "the menu says This iPad")
            _ = js("const s = document.querySelector('#pmenu [data-act=\"pn-menu-close\"]'); if (s) s.click(); return true;")
            XCTAssertEqual(js("const c = document.querySelector('#cx-chip'); return !!c && c.getClientRects().length > 0;"), "true", "the connection chip upright")
        }
        Thread.sleep(forTimeInterval: 1)
        shot("ipad-upright-board")

        // Sideways: the wide layout, live, the same page, the open project and its card kept.
        rotate(.landscapeLeft)
        let side = layout(a).room
        layoutIs(a, "sideways")
        var L = layout(a)
        let kept = (L.page["same"] as? String) == "same page" && (L.page["hash"] as? String) == "#weather-widget"
            && js("return document.body.innerText.includes('ipad one: it ran');") == "true"
        mark("sideways: same page, weather-widget open, its card shown: \(kept) (\(L.page))")
        XCTAssertTrue(kept, "the rotation kept the page, the open project and its card")
        noMacOnly("sideways")
        if side >= 1000 {
            let chip = jsObject("const c = document.querySelector('.mc-top .cx-chip'); return { shown: !!c && c.getClientRects().length > 0, says: c ? c.innerText.trim() : null };")
            mark("the wide layout's connection chip: \(chip)")
            XCTAssertEqual(chip["shown"] as? Bool, true, "the connection chip beside the name in the wide layout")
            let mine = jsObject("const b = document.querySelector('.mc-tools [data-act=\"pn-app\"]'); return { shown: !!b && b.getClientRects().length > 0, label: b ? b.getAttribute('aria-label') : null };")
            mark("the wide layout's This iPad: \(mine)")
            XCTAssertEqual(mine["label"] as? String, "This iPad", "This iPad among the wide layout's tools")
            // New project: the same form as the phone's +.
            let form = until(5) { self.js("const b = document.querySelector('#new-project'); if (b && !document.querySelector('#modal-form')) b.click(); return !!document.querySelector('#modal-form [name=name]');") == "true" }
            _ = js("if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); const x = document.querySelector('#modal-close'); if (x) x.click(); return true;")
            let closed = until(5) { self.js("return !document.querySelector('#modal-form');") == "true" }
            mark("New project in the wide layout: the form \(form), closed \(closed)")
            XCTAssertTrue(form && closed, "New project opens the phone's New project form, and it closes")
        }
        Thread.sleep(forTimeInterval: 1)
        shot("ipad-sideways-board")

        // Back upright: the column again, the same page.
        rotate(.portrait)
        layoutIs(a, "upright again")
        L = layout(a)
        XCTAssertTrue((L.page["same"] as? String) == "same page" && (L.page["hash"] as? String) == "#weather-widget", "upright again: the same page, weather-widget open")
        rotate(.landscapeLeft)
        layoutIs(a, "sideways again")

        // A card arriving live in the wide layout, run there with Face ID.
        guard let two = newCard(["kind": "approve", "project": "weather-widget", "command": "echo \"ipad two: it ran\"", "why": "A card on the iPad, sideways."]) else { XCTFail("no card"); return }
        XCTAssertTrue(onBoard("weather-widget", "ipad two: it ran"), "a card arriving live shows sideways")
        let run = until(10) { self.js("const b = document.querySelector('[data-act=\"cp-run\"][data-cp=\"\(two)\"]'); if (!b || !b.getClientRects().length) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true;") == "true" }
        XCTAssertTrue(run, "Run on the card, sideways")
        // iOS's first ask for Face ID on this install (test4 is the iPhone run's; this run has none before): Allow.
        let sbFace = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for allow in [sbFace.alerts.buttons["Allow"], a.alerts.buttons["Allow"], sbFace.buttons["Allow"]] where allow.waitForExistence(timeout: 2) {
            mark("Face ID's first ask: Allow")
            allow.tap()
            break
        }
        Thread.sleep(forTimeInterval: 1.2)
        shot("ipad-sideways-faceid")
        faceID("match")
        let ran = until(10) { (self.cp(two)?["state"] as? String) != "open" }
        let ans = cp(two)?["answer"] as? [String: Any] ?? [:]
        mark("Run with Face ID sideways: \(cp(two)?["state"] ?? "?") \(ans)")
        XCTAssertTrue(ran && (ans["approved"] as? NSNumber)?.boolValue == true, "Face ID matched, the command approved from the wide layout")

        // A simulated Split View and Slide Over: the column.
        for r in [590, 375] {
            room(r)
            layoutIs(a, "Split View \(r)", room: Double(r))
            if r == 590 { Thread.sleep(forTimeInterval: 1); shot("ipad-split-590") }
        }
        room(0)
        layoutIs(a, "the whole window again")

        // This iPad (the app's own settings) from the wide layout: its page in a centred column of 640.
        if side >= 1000 {
            _ = js("const b = document.querySelector('.mc-tools [data-act=\"pn-app\"]'); if (b) b.click(); return !!b;")
            let settings = until(10) { self.js("return location.pathname.startsWith('/phone/') && document.body.innerText.includes('Paired as');") == "true" }
            Thread.sleep(forTimeInterval: 1)
            let f = a.webViews.firstMatch.frame
            let words = js("return document.body.innerText.includes('sign this iPad out');") == "true"
            mark("This iPad's settings: \(settings), web view x \(f.minX) w \(f.width), iPad words \(words)")
            XCTAssertTrue(settings && abs(Double(f.width) - want(side, page: true)) < 1 && abs(Double(f.minX) - ((side - want(side, page: true)) / 2).rounded()) < 1, "the app's settings in a centred column of 640")
            XCTAssertTrue(words, "the settings say iPad")
            shot("ipad-sideways-settings")
            _ = js("const b = document.querySelector('[aria-label=\"Back\"]'); if (b) b.click(); return !!b;")
            XCTAssertTrue(until(10) { self.js("return location.pathname === '/' && !!document.querySelector('#list');") == "true" }, "back on the board")
        }

        // A pick opened from its card in the wide layout, a picture opened and zoomed by a pinch.
        guard let pick = newCard(["kind": "pick", "project": "paper-boat", "title": "Which boat for the iPad?",
                                  "variants": [["label": "Sail", "describe": "The boat with its sail up"], ["label": "Oars", "describe": "The boat rowed"]]]) else { XCTFail("no pick"); return }
        XCTAssertTrue(onBoard("paper-boat", "Which boat for the iPad?"), "the pick on the board, sideways")
        _ = js("const b = document.querySelector('[data-act=\"cp-open\"][data-cp=\"\(pick)\"]'); if (b) { b.scrollIntoView({ block: 'center' }); b.click(); } return !!b;")
        let opened = until(15) { self.js("return location.pathname.startsWith('/phone/') && !!document.querySelector('img') && document.body.innerText.includes('Which boat for the iPad?');") == "true" }
        Thread.sleep(forTimeInterval: 1.5)
        let pf = a.webViews.firstMatch.frame
        mark("the pick's screen sideways: \(opened), web view x \(pf.minX) w \(pf.width)")
        XCTAssertTrue(opened && abs(Double(pf.width) - want(side, page: true)) < 1, "the pick's own screen in its column")
        shot("ipad-sideways-pick")
        let viewer = until(8) { self.js("if (document.querySelector('.pzv')) return true; const im = [...document.querySelectorAll('img')].find((x) => x.offsetParent !== null && x.getBoundingClientRect().width > 100); if (im) im.click(); return false;") == "true" }
        Thread.sleep(forTimeInterval: 1)
        a.webViews.firstMatch.pinch(withScale: 2.4, velocity: 2)
        Thread.sleep(forTimeInterval: 1)
        let scale = js("const b = document.querySelector('.pzv-box'); const m = b && /scale\\(([\\d.]+)\\)/.exec(b.style.transform || ''); return m ? Number(m[1]) : 1;").flatMap(Double.init) ?? 0
        mark("the pick's viewer sideways: open \(viewer), zoomed to \(scale)")
        XCTAssertTrue(viewer && scale > 1.2, "the picture zoomed by a pinch in the wide layout (scale \(scale))")
        shot("ipad-sideways-pick-zoom")
        a.terminate()

        // An alert tapped with the app stopped, sideways: its screen.
        let title = "Ship the boat from the iPad?"
        if let ask = newCard(["kind": "ask", "project": "notes-app", "title": title, "options": ["Ship it", "Not yet"]]) {
            pushAlert(ask, kind: "ask", project: "notes-app", banner: "Ravenry iPad check: ask")
            let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            let note = sb.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Ravenry iPad check: ask")).firstMatch
            XCTAssertTrue(note.waitForExistence(timeout: 15), "iOS shows the alert")
            note.tap()
            XCTAssertTrue(a.wait(for: .runningForeground, timeout: 15), "the alert opens the app")
            let shown = until(20) { self.appShows(a, title) }
            // (After the launch's Ink, 3.4 s.)
            Thread.sleep(forTimeInterval: 4)
            mark("an alert tapped sideways: its screen \(shown), web view w \(a.webViews.firstMatch.frame.width)")
            XCTAssertTrue(shown, "the alert's own screen, sideways")
            shot("ipad-sideways-alert")
            a.terminate()
        } else { XCTFail("no ask card") }

        // The launch in each layout: the board, never the hold's words (they stayed until 17 s over the wide board before).
        for (o, name) in [(UIDeviceOrientation.landscapeLeft, "sideways"), (.portrait, "upright")] {
            rotate(o)
            a = launch(reset: false, ink: true)
            let t0 = Date()
            var held: [Double] = []
            while Date().timeIntervalSince(t0) < 18 {
                if appShows(a, "Reaching your Mac") || appShows(a, "didn't answer") { held.append(Date().timeIntervalSince(t0)) }
                Thread.sleep(forTimeInterval: 0.4)
            }
            let board = shows("recipe-box", timeout: 5)
            mark(String(format: "launch %@: the hold's words seen %d times, last at %.1f s; the board %@", name, held.count, held.last ?? 0, board ? "shown" : "NOT shown"))
            XCTAssertTrue(held.isEmpty && board, "the launch \(name): no hold over the board (seen \(held.count) times, last at \(held.last ?? 0) s)")
            layoutIs(a, "after the launch \(name)")
            a.terminate()
        }
        rotate(.portrait)
    }
}
