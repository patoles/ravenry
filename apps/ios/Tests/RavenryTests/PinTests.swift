// TLS that takes only the pinned key (Android PinTest.kt and HubOrderTest.kt).
// The key's checks run on certificates made with openssl (Fixtures: public
// certificates only, their pins computed by openssl when they were made);
// the live cases run against a test hub on 127.0.0.1 when the checks give
// one (tools/ios-e2e.mjs: RAVENRY_TEST_HUB, RAVENRY_TEST_PIN, RAVENRY_TEST_TOKEN),
// and are skipped otherwise.

import XCTest
import Security
@testable import Ravenry

final class PinTests: XCTestCase {
    /// The hub's kind of certificate: self-signed, P-256.
    lazy var hub = cert("hub")
    /// One a public authority signed, as far as a normal client can tell.
    lazy var valid = cert("valid")
    lazy var authority = cert("authority")
    // `openssl x509 -pubkey | openssl pkey -pubin -outform DER | openssl dgst -sha256`, base64url.
    let hubPin = "HeUsQdW9nukFaxot8W-JlMEAczEFqYec5G1Jpzyferk"
    let validPin = "noquwBqtK_6HcZm8XC3Fce5yU3wVguJb-jZgZbqbvYo"

    func cert(_ name: String) -> SecCertificate {
        let u = Bundle(for: PinTests.self).url(forResource: "Fixtures/\(name)", withExtension: "pem")!
        let b64 = try! String(contentsOf: u, encoding: .utf8).split(separator: "\n").filter { !$0.hasPrefix("-----") }.joined()
        return SecCertificateCreateWithData(nil, Data(base64Encoded: b64)! as CFData)!
    }

    func trust(_ chain: [SecCertificate]) -> SecTrust {
        var t: SecTrust?
        SecTrustCreateWithCertificates(chain as CFArray, SecPolicyCreateSSL(true, "localhost" as CFString), &t)
        return t!
    }

    func testThePinIsTheSha256OfTheKeyInfo() {
        XCTAssertEqual(Pins.of(certificate: SecCertificateCopyData(hub) as Data), hubPin)
        XCTAssertEqual(Pins.of(certificate: SecCertificateCopyData(valid) as Data), validPin)
        XCTAssertNil(Pins.of(certificate: Data([0x30, 0x03, 0x02, 0x01, 0x00])))
    }

    func testAcceptsOnlyThePinnedKey() {
        let t = PinnedTrust(pin: hubPin)
        XCTAssertTrue(t.accepts(trust([hub]), host: "127.0.0.1"))
        // A certificate from an authority must not stand in for the pinned key.
        XCTAssertFalse(t.accepts(trust([valid, authority]), host: "localhost"))
        XCTAssertTrue(t.refused("localhost"))
    }

    func testWithNoPinItKeepsTheKeyItSaw() {
        let t = PinnedTrust(pin: nil)
        XCTAssertTrue(t.accepts(trust([hub]), host: "127.0.0.1"))
        XCTAssertEqual(t.seen, hubPin)
        XCTAssertEqual(t.seen?.count, 43)
    }

    // ------------------------------------------------------------ against a test hub

    var env: [String: String] { ProcessInfo.processInfo.environment }

    func live() throws -> (port: Int, pin: String, token: String) {
        guard let h = env["RAVENRY_TEST_HUB"], let port = Int(h.split(separator: ":").last ?? ""), let pin = env["RAVENRY_TEST_PIN"] else {
            throw XCTSkip("no test hub (tools/ios-e2e.mjs gives one)")
        }
        return (port, pin, env["RAVENRY_TEST_TOKEN"] ?? "")
    }

    func testTalksToThePinnedHubWithTheToken() async throws {
        let (port, pin, token) = try live()
        let c = HubClient(hosts: ["127.0.0.1"], port: port, pin: pin, token: token)
        let r = try await c.call("GET", "/api/phone/me")
        XCTAssertEqual(r.status, 200, r.text)
        XCTAssertNotNil((r.json?["device"] as? [String: Any])?["id"])
    }

    func testRefusesAnotherKey() async throws {
        let (port, _, token) = try live()
        let c = HubClient(hosts: ["127.0.0.1"], port: port, pin: hubPin, token: token)
        do { _ = try await c.call("GET", "/api/phone/me"); XCTFail("must refuse") } catch let f as HubFailure { XCTAssertTrue(f.pinRefused) }
    }

    func testTriesTheNextAddressWhenOneIsDown() async throws {
        let (port, pin, token) = try live()
        var remembered: String?
        // 10.255.255.1 never answers; its knock is capped (300 ms here, 1.5 s in the app).
        let c = HubClient(hosts: ["10.255.255.1", "127.0.0.1"], port: port, pin: pin, token: token, homeConnect: 0.3, onHost: { remembered = $0 })
        let t = Date()
        let v1 = try await c.call("GET", "/api/phone/me").status
        XCTAssertEqual(v1, 200)
        XCTAssertLessThan(Date().timeIntervalSince(t), 1.5)
        XCTAssertEqual(remembered, "127.0.0.1")
    }

    func testASignedOutAnswerSignsOut() async throws {
        let (port, pin, _) = try live()
        let out = expectation(description: "signed out")
        let c = HubClient(hosts: ["127.0.0.1"], port: port, pin: pin, token: "not-a-token-of-this-hub-0000000000000000000")
        c.onSignedOut = { out.fulfill() }
        let v2 = try await c.call("GET", "/api/phone/me").status
        XCTAssertEqual(v2, 401)
        await fulfillment(of: [out], timeout: 2)
    }

    /// Wi-Fi first (HubOrderTest): one hub answers for both a "home" and a "tailnet" name.
    func client(_ hosts: [String], _ whereTo: Ref, port: Int, pin: String, token: String) -> HubClient {
        let c = HubClient(hosts: hosts, port: port, pin: pin, token: token, homeConnect: 0.3)
        c.resolve = { whereTo.map[$0] ?? $0 }
        return c
    }
    final class Ref { var map: [String: String] = [:] }
    let home = "studio.home.arpa", tail = "ravenry.tail0000.ts.net"

    func testBothAnswerAndTheLastWasTailscale_itGoesHome() async throws {
        let (port, pin, token) = try live()
        let w = Ref(); w.map = [home: "127.0.0.1", tail: "127.0.0.1"]
        let c = client([tail, home], w, port: port, pin: pin, token: token)
        let v3 = try await c.call("GET", "/api/phone/me").status
        XCTAssertEqual(v3, 200)
        XCTAssertEqual(c.host, home)
        XCTAssertEqual(Reach.via(c.host, c.allHosts), "wifi")
        let v4 = try await c.probe().host
        XCTAssertEqual(v4, home)
    }

    func testHomeDoesNotAnswer_tailscale_andTheNextRequestsDoNotWaitOnHome() async throws {
        let (port, pin, token) = try live()
        let w = Ref(); w.map = [home: "127.0.0.1", tail: "127.0.0.1"]
        let c = client([home, tail], w, port: port, pin: pin, token: token)
        _ = try await c.call("GET", "/api/phone/me")
        w.map[home] = "10.255.255.1"
        c.networkChanged()
        let t = Date()
        let v5 = try await c.call("GET", "/api/phone/me").status
        XCTAssertEqual(v5, 200)
        let first = Date().timeIntervalSince(t)
        XCTAssertEqual(c.host, tail)
        XCTAssertLessThan(first, 1.0)
        var next: [Double] = []
        for _ in 0..<5 { let s = Date(); _ = try await c.call("GET", "/api/phone/me"); next.append(Date().timeIntervalSince(s)) }
        print("home a black hole: first request \(Int(first * 1000)) ms (through Tailscale), next \(next.map { Int($0 * 1000) }) ms")
        XCTAssertTrue(next.allSatisfy { $0 < 0.25 }, "\(next)")
        XCTAssertEqual(c.route.order(), [tail, home])
    }

    func testTheCheckTriesHomeFirstEveryTime_comingHomeSwitchesBack() async throws {
        let (port, pin, token) = try live()
        let w = Ref(); w.map = [home: "127.0.0.1", tail: "127.0.0.1"]
        let c = client([home, tail], w, port: port, pin: pin, token: token)
        let v6 = try await c.probe().host
        XCTAssertEqual(v6, home)
        // Leaving: the next check goes through Tailscale.
        w.map[home] = "10.255.255.1"; c.networkChanged()
        let v7 = try await c.probe().host
        XCTAssertEqual(v7, tail)
        XCTAssertEqual(Reach.via(c.host, c.allHosts), "tailscale")
        _ = try await c.call("GET", "/api/phone/me")
        XCTAssertEqual(c.host, tail)
        // Coming home: within one check, home again, and the requests follow.
        w.map[home] = "127.0.0.1"
        let v8 = try await c.probe().host
        XCTAssertEqual(v8, home)
        XCTAssertEqual(Reach.via(c.host, c.allHosts), "wifi")
        _ = try await c.call("GET", "/api/phone/me")
        XCTAssertEqual(c.host, home)
    }

    func testTheStreamOpensAtHomeWhenHomeAnswers() async throws {
        let (port, pin, token) = try live()
        let w = Ref(); w.map = [home: "127.0.0.1", tail: "127.0.0.1"]
        let c = client([tail, home], w, port: port, pin: pin, token: token)
        let up = expectation(description: "link up")
        up.assertForOverFulfill = false
        let s = c.events("/api/events", onEvent: { _, _ in }, link: { ok, _ in if ok { up.fulfill() } })
        await fulfillment(of: [up], timeout: 8)
        s.close()
        XCTAssertEqual(c.host, home)
    }
}
