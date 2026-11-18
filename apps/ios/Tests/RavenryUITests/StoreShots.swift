// The App Store's screenshots (docs/store/apple/screenshots), taken from the
// demo: this test opens it ("Try the demo", the alerts allowed first) and
// then does what tools/store-shots.mjs asks, one file at a time, until it
// says done. The board itself is driven by script in its page (the debug
// build's TestDrive), the pictures by `simctl io screenshot`; only what
// needs iOS itself (an alert's long press, an iPad turned) is done here.
// Runs only with RAVENRY_STORE_SHOTS=1: in every other run it passes at once.

import XCTest

final class StoreShots: XCTestCase {
    let env = ProcessInfo.processInfo.environment

    override class func setUp() { super.setUp(); Quiet.off() }

    func testTheDemoForTheStore() throws {
        guard env["RAVENRY_STORE_SHOTS"] == "1", let sig = env["RAVENRY_SIG"] else { return }
        executionTimeAllowance = 900
        let fm = FileManager.default
        try? fm.createDirectory(atPath: "\(sig)/drive", withIntermediateDirectories: true)
        let a = XCUIApplication()
        a.launchEnvironment["RAVENRY_TEST_DRIVE"] = "\(sig)/drive"
        a.launchEnvironment["RAVENRY_RESET"] = "1"
        a.launchEnvironment["RAVENRY_REDUCE_MOTION"] = "1"
        a.launchEnvironment["RAVENRY_TEST_ASK_ALERTS"] = "1"
        a.launch()
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if sb.buttons["Allow"].waitForExistence(timeout: 8) { sb.buttons["Allow"].tap() }
        XCTAssertTrue(a.buttons["try-demo"].waitForExistence(timeout: 10), "the pairing screen's demo line")
        a.buttons["try-demo"].tap()
        try? Data().write(to: URL(fileURLWithPath: "\(sig)/ready"))

        // One command a file: "\(sig)/cmd" holds it, "\(sig)/ack" says it is done.
        let end = Date().addingTimeInterval(840)
        while Date() < end {
            guard let cmd = try? String(contentsOfFile: "\(sig)/cmd", encoding: .utf8) else { Thread.sleep(forTimeInterval: 0.2); continue }
            try? fm.removeItem(atPath: "\(sig)/cmd")
            let w = cmd.split(separator: " ").map(String.init)
            var ack = "ok"
            switch w.first ?? "" {
            case "done":
                try? Data(ack.utf8).write(to: URL(fileURLWithPath: "\(sig)/ack"))
                a.terminate()
                return
            case "banner":
                // The alert that came while the board is open: its buttons, as a long press shows them.
                let banner = sb.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", w.dropFirst().joined(separator: " "))).firstMatch
                if banner.waitForExistence(timeout: 15) { banner.press(forDuration: 1.2); ack = sb.buttons.count > 0 ? "ok" : "no buttons" } else { ack = "no banner" }
            case "front":
                a.activate()
            case "sideways":
                XCUIDevice.shared.orientation = .landscapeLeft
            case "upright":
                XCUIDevice.shared.orientation = .portrait
            default:
                ack = "unknown: \(cmd)"
            }
            try? Data(ack.utf8).write(to: URL(fileURLWithPath: "\(sig)/ack"))
        }
        XCTFail("tools/store-shots.mjs never said done")
    }
}
