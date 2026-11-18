// The words when the Mac does not answer (Android ReachTest.kt, case for
// case), the iPhone's own Local Network case, and the order the Mac's
// addresses are tried in (Android HubOrderTest.kt's order cases).

import XCTest
@testable import Ravenry

final class ReachTests: XCTestCase {
    let away = ["192.168.1.20", "ravenry.tail1234.ts.net", "100.64.0.2"]

    func testKnowsTheTailnetsHosts() {
        XCTAssertTrue(Reach.tailnetHost("ravenry.tailabcdef.ts.net"))
        XCTAssertTrue(Reach.tailnetHost("100.64.0.2"))
        XCTAssertTrue(Reach.tailnetHost("100.127.255.1"))
        XCTAssertTrue(Reach.tailnetHost("fd7a:115c:a1e0::1"))
        XCTAssertTrue(Reach.tailnetHost("[fd7a:115c:a1e0:ab12::5]"))
        XCTAssertFalse(Reach.tailnetHost("100.128.0.1"))
        XCTAssertFalse(Reach.tailnetHost("192.168.1.20"))
        XCTAssertFalse(Reach.tailnetHost("10.0.2.2"))
        XCTAssertFalse(Reach.tailnetHost("studio.local"))
    }

    func testTailscaleOffOrMissingWhenOnlyTheTailnetCouldAnswer() {
        XCTAssertEqual(Reach.decide(away, vpnUp: false, tailscaleInstalled: true), Reach.tailscaleOff)
        XCTAssertEqual(Reach.decide(away, vpnUp: false, tailscaleInstalled: false), Reach.tailscaleMissing)
        // Another VPN is up, but the tailnet's name did not resolve: Tailscale is still off.
        XCTAssertEqual(Reach.decide(away, vpnUp: true, tailscaleInstalled: true, tailnetNameUnresolved: true), Reach.tailscaleOff)
    }

    func testTheMacWhenTailscaleIsUpOrNotInTheLink() {
        XCTAssertEqual(Reach.decide(away, vpnUp: true, tailscaleInstalled: true), Reach.macAway)
        XCTAssertEqual(Reach.decide(["192.168.1.20"], vpnUp: false, tailscaleInstalled: false), Reach.macWifi)
    }

    /// iOS keeps an app off the local network until the person allows it (Settings, Privacy, Local Network).
    func testLocalNetworkOffWhenIOSKeptThePhoneOffTheWifi() {
        XCTAssertEqual(Reach.decide(away, vpnUp: false, tailscaleInstalled: true, localNetworkDenied: true), Reach.localNetworkOff)
        XCTAssertEqual(Reach.decide(["192.168.1.20"], vpnUp: true, tailscaleInstalled: true, localNetworkDenied: true), Reach.localNetworkOff)
        // Only tailnet addresses or this phone itself: the local network is not the reason.
        XCTAssertEqual(Reach.decide(["ravenry.tail1234.ts.net"], vpnUp: false, tailscaleInstalled: true, localNetworkDenied: true), Reach.tailscaleOff)
        XCTAssertEqual(Reach.decide(["127.0.0.1"], vpnUp: false, tailscaleInstalled: true, localNetworkDenied: true), Reach.macWifi)
        XCTAssertEqual(Reach.localNetworkOff.reason, "local-network-off")
    }

    func testNeverAHostInTheWords() throws {
        let re = try NSRegularExpression(pattern: #"\d+\.\d+|ts\.net|:\d"#)
        for w in [Reach.tailscaleOff, Reach.tailscaleMissing, Reach.macAway, Reach.macWifi, Reach.localNetworkOff] {
            XCTAssertNil(re.firstMatch(in: w.words, range: NSRange(w.words.startIndex..., in: w.words)), w.words)
            XCTAssertFalse(w.words.contains("\u{2014}"), "no em dash: \(w.words)")
        }
        // This device in the shared words: "phone" on an iPhone, "iPad" on an iPad.
        XCTAssertEqual(Reach.tailscaleOff.words, "Tailscale is off on this \(Device.pad ? "iPad" : "phone"). Turn it on, then try again.")
    }

    func testSkipsTailnetHostsWithNoVpn() {
        let c = HubClient(hosts: away, port: 4601, pin: nil, token: nil, skip: { Reach.tailnetHost($0) })
        XCTAssertEqual(c.route.order(), ["192.168.1.20"])
        let none = HubClient(hosts: ["ravenry.tail1234.ts.net"], port: 4601, pin: nil, token: nil, skip: { Reach.tailnetHost($0) })
        XCTAssertEqual(none.route.order(), [])
    }

    /// The path the chip names (docs/PHONE.md, The connection).
    func testThePathAHostIs() {
        let hosts = ["192.168.1.20", "ravenry.tail1234.ts.net", "100.101.102.103", "studio.tail1234.ts.net", "100.90.1.2"]
        XCTAssertEqual(Reach.via("192.168.1.20", hosts), "wifi")
        XCTAssertEqual(Reach.via("10.0.2.2", hosts), "wifi")
        XCTAssertEqual(Reach.via("ravenry.tail1234.ts.net", hosts), "tailscale")
        XCTAssertEqual(Reach.via("100.101.102.103", hosts), "tailscale")
        XCTAssertEqual(Reach.via("studio.tail1234.ts.net", hosts), "tailscale-mac")
        XCTAssertEqual(Reach.via("100.90.1.2", hosts), "tailscale-mac")
        XCTAssertEqual(Reach.via("127.0.0.1", hosts), "local")
    }

    // ------------------------------------------------------------ Wi-Fi first (HubOrderTest)

    let tail = "ravenry.tail0000.ts.net"

    func testTheOrderIsHomeThenTailscaleTheLastThatAnsweredFirstWithinEach() {
        // Paired away from home: the tailnet name answered last.
        let c = Route([tail, "100.64.0.2", "192.168.1.36", "10.0.0.5"])
        XCTAssertEqual(c.order(), ["192.168.1.36", "10.0.0.5", tail, "100.64.0.2"])
        XCTAssertEqual(c.order(), c.order(check: true))
        // The second home address answered last: it goes first among the home ones.
        let d = Route(["10.0.0.5", "192.168.1.36", tail])
        XCTAssertEqual(d.order(), ["10.0.0.5", "192.168.1.36", tail])
        // Tailscale off: the tailnet hosts are left out, the home ones stay.
        let e = Route([tail, "192.168.1.36"], skip: { Reach.tailnetHost($0) })
        XCTAssertEqual(e.order(), ["192.168.1.36"])
    }

    func testAHomeAddressThatDidNotAnswerGoesAfterTailscaleUntilItAnswersOrTheNetworkChanges() {
        var told: [String] = []
        let r = Route(["192.168.1.36", tail], onHost: { told.append($0) })
        r.failed("192.168.1.36")
        XCTAssertEqual(r.order(), [tail, "192.168.1.36"])
        // The 30 s check tries home first every time.
        XCTAssertEqual(r.order(check: true), ["192.168.1.36", tail])
        r.answered(tail)
        XCTAssertEqual(told, [tail])
        // Coming home: it answers, it goes first again.
        r.answered("192.168.1.36")
        XCTAssertEqual(r.order(), ["192.168.1.36", tail])
        // A network change gives every home address its first try again.
        r.failed("192.168.1.36")
        r.networkChanged()
        XCTAssertEqual(r.order(), ["192.168.1.36", tail])
        // A tailnet host that fails is never put last: it is all there is away from home.
        r.failed(tail)
        XCTAssertEqual(r.order(), ["192.168.1.36", tail])
    }

    // ------------------------------------------------------------ the Mac at a new address (Nearby; Android HubOrderTest)

    let saved = "192.168.1.36", now = "192.168.1.22"
    let id = Pins.hubId("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")

    /// What Bonjour finds on a home Wi-Fi: another Mac, one with no id, and his, with addresses Nearby must not take.
    var onTheWifi: [Nearby.Service] {
        [Nearby.Service(id: "someone-elses-mac", addresses: ["192.168.1.50"]),
         Nearby.Service(id: nil, addresses: ["192.168.1.51"]),
         Nearby.Service(id: id, addresses: [now, "fe80::1", "100.64.0.9", now])]
    }

    func testOnlyTheMacWithThePairedIdIsTaken() {
        XCTAssertEqual(Nearby.matching(onTheWifi, id: id), [now])
        XCTAssertEqual(Nearby.matching(Array(onTheWifi.prefix(2)), id: id), [])
    }

    func testSavedFails_theFoundAddressBeforeTailscale_andItIsKept() async {
        var told: [String] = []
        let r = Route([saved, tail], onHost: { told.append($0) })
        var tried: [String] = [], looks = 0
        let got: String? = await Route.round(r.order(), isTailnet: r.isTailnet, find: { _ in looks += 1; return Nearby.matching(self.onTheWifi, id: self.id) }) { h in
            tried.append(h)
            if h == self.now { r.answered(h); return h }
            r.failed(h); return nil
        }
        XCTAssertEqual(got, now)
        // Saved first, then the found address; Tailscale never tried.
        XCTAssertEqual(tried, [saved, now])
        XCTAssertEqual(looks, 1)
        XCTAssertEqual(r.host, now)
        XCTAssertEqual(told, [now])
        XCTAssertEqual(Reach.via(r.host, r.hosts), "wifi")
        // The next round goes straight there.
        XCTAssertEqual(r.order().first, now)
        // The next start too: lastHost first (HubClient.of).
        let p = Paired(hubName: "Mac", hosts: [saved, tail], port: 4601, pin: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", token: "t", deviceId: "d", deviceName: "phone", lastHost: told.last)
        XCTAssertEqual(HubClient.of(p).route.order().first, now)
    }

    func testSavedAnswers_noLook() async {
        let r = Route([saved, tail])
        var looks = 0
        let got: String? = await Route.round(r.order(), isTailnet: r.isTailnet, find: { _ in looks += 1; return [self.now] }) { $0 == self.saved ? $0 : nil }
        XCTAssertEqual(got, saved)
        XCTAssertEqual(looks, 0)
    }

    /// A tester's phone: Tailscale off, so the tailnet hosts are left out; the look comes at the end.
    func testTailscaleOff_theFoundAddressStill() async {
        let r = Route([saved, tail], skip: { Reach.tailnetHost($0) })
        var tried: [String] = []
        let got: String? = await Route.round(r.order(), isTailnet: r.isTailnet, find: { _ in Nearby.matching(self.onTheWifi, id: self.id) }) { h in tried.append(h); return h == self.now ? h : nil }
        XCTAssertEqual(got, now)
        XCTAssertEqual(tried, [saved, now])
    }

    /// A found address that answers with another key (the pin refused): not the Mac, Tailscale next.
    func testAFoundAddressWithAnotherKeyIsRefused() async {
        let r = Route([saved, tail])
        var tried: [String] = []
        let got: String? = await Route.round(r.order(), isTailnet: r.isTailnet, find: { _ in [self.now] }) { h in tried.append(h); return h == self.tail ? h : nil }
        XCTAssertEqual(got, tail)
        XCTAssertEqual(tried, [saved, now, tail])
        XCTAssertFalse(r.hosts.contains(now))
    }

    func testTheLookWaitsAMinuteWhenNothingIsFound_andANetworkChangeLooksAgain() async {
        var n = 0
        let l = Looks { n += 1; return [] }
        _ = await l.get(); _ = await l.get(); _ = await l.get()
        XCTAssertEqual(n, 1)
        await l.reset()
        _ = await l.get()
        XCTAssertEqual(n, 2)
    }
}
