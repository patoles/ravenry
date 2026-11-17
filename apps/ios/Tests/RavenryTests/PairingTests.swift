// The pairing link, the typed code and the check number (Android
// PairingTest.kt, case for case), and the QR path: the simulator has no
// camera, so a code is drawn as a QR picture and read back with the app's
// QR reader before it is parsed.

import XCTest
import CoreImage
import CoreImage.CIFilterBuiltins
@testable import Ravenry

final class PairingTests: XCTestCase {
    let pin = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"

    func testParsesTheLink() throws {
        let l = try PairLink.parse("ravenry://pair?v=1&name=Studio%20Mac&hosts=192.168.1.20,100.101.102.103&port=4601&pin=\(pin)&code=ABCD-EFGH-JKMN-PQRS").get()
        XCTAssertEqual(l.name, "Studio Mac")
        XCTAssertEqual(l.hosts, ["192.168.1.20", "100.101.102.103"])
        XCTAssertEqual(l.port, 4601)
        XCTAssertEqual(l.pin, pin)
        XCTAssertEqual(l.code, "ABCDEFGHJKMNPQRS")
    }

    /// The hub writes its link with URLSearchParams: a space is "+".
    func testReadsTheHubsOwnEncoding() throws {
        let l = try PairLink.parse("ravenry://pair?v=1&name=MacBook+Pro&hosts=127.0.0.1&port=4601&pin=\(pin)&code=ABCDEFGHJKMNPQRS").get()
        XCTAssertEqual(l.name, "MacBook Pro")
    }

    // Away from home (docs/PHONE.md section 2): the Wi-Fi first, then Ravenry's own
    // device on the person's tailnet by its MagicDNS name and its 100.x address.
    func testTakesTheTailnetNameAsAHost() throws {
        let l = try PairLink.parse("ravenry://pair?v=1&name=Studio%20Mac&hosts=192.168.1.20,ravenry.tail1234.ts.net,100.64.0.2&port=4601&pin=\(pin)&code=ABCD-EFGH-JKMN-PQRS").get()
        XCTAssertEqual(l.hosts, ["192.168.1.20", "ravenry.tail1234.ts.net", "100.64.0.2"])
        let c = HubClient(hosts: l.hosts, port: l.port, pin: l.pin, token: nil)
        XCTAssertEqual(c.url("ravenry.tail1234.ts.net", "/api/phone/hello").absoluteString, "https://ravenry.tail1234.ts.net:4601/api/phone/hello")
        XCTAssertEqual(c.url("100.64.0.2", "/api/phone/hello").absoluteString, "https://100.64.0.2:4601/api/phone/hello")
        XCTAssertEqual(c.url("fd7a:115c:a1e0::1", "/x").absoluteString, "https://[fd7a:115c:a1e0::1]:4601/x")
    }

    func testRefusesWhatIsNotALink() {
        func err(_ s: String) -> String { if case .failure(let e) = PairLink.parse(s) { return e.message }; return "" }
        XCTAssertTrue(err("https://example.com/pair").contains("not a Ravenry"))
        XCTAssertTrue(err("ravenry://pair?v=2&hosts=a&port=1&pin=\(pin)&code=ABCDEFGHJKMNPQRS").contains("Update Ravenry"))
        XCTAssertTrue(err("ravenry://pair?hosts=a&port=1&pin=\(pin)&code=ABCDEFGHJKMNPQRS").contains("no version"))
        XCTAssertTrue(err("ravenry://pair?v=1&port=1&pin=\(pin)&code=ABCDEFGHJKMNPQRS").contains("no address"))
        XCTAssertTrue(err("ravenry://pair?v=1&hosts=a&pin=\(pin)&code=ABCDEFGHJKMNPQRS").contains("no port"))
        XCTAssertTrue(err("ravenry://pair?v=1&hosts=a&port=1&code=ABCDEFGHJKMNPQRS").contains("no key"))
        XCTAssertTrue(err("ravenry://pair?v=1&hosts=a&port=1&pin=short&code=ABCDEFGHJKMNPQRS").contains("key"))
        XCTAssertTrue(err("ravenry://pair?v=1&hosts=a&port=1&pin=\(pin)").contains("no code"))
        XCTAssertTrue(err("ravenry://pair?v=1&hosts=a&port=1&pin=\(pin)&code=ABC").contains("code"))
    }

    func testReadsATypedCodeKindly() throws {
        XCTAssertEqual(PairLink.normalizeCode("abcd-efgh ijkm-opqr"), "ABCDEFGH1JKM0PQR")
        XCTAssertNil(PairLink.normalizeCode("ABCD-EFGH-JKMN-PQRU"))
        let t = try PairLink.typed(address: "192.168.1.20:4700", code: "ABCD-EFGH-JKMN-PQRS").get()
        XCTAssertEqual(t.port, 4700); XCTAssertEqual(t.hosts, ["192.168.1.20"]); XCTAssertNil(t.pin)
        XCTAssertEqual(try PairLink.typed(address: "mac.local", code: "ABCDEFGHJKMNPQRS").get().port, 4601)
        XCTAssertEqual(try PairLink.typed(address: "https://mac.local/", code: "ABCDEFGHJKMNPQRS").get().hosts, ["mac.local"])
        if case .failure(let e) = PairLink.typed(address: "", code: "ABCDEFGHJKMNPQRS") { XCTAssertEqual(e.message, "Type the computer's address.") } else { XCTFail() }
        if case .failure(let e) = PairLink.typed(address: "mac:port", code: "ABCDEFGHJKMNPQRS") { XCTAssertEqual(e.message, "That port is not a number.") } else { XCTFail() }
    }

    func testTheCheckNumberIsTheFirstFiveBytesModuloATrillion() {
        var a = Data(count: 32); for i in 0..<5 { a[i] = UInt8(i + 1) }
        // 0x0102030405 = 4328719365
        XCTAssertEqual(Pins.checkNumber(Pins.b64u(a)), "004328 719365")
        var b = Data(count: 32); for i in 0..<5 { b[i] = 0xFF }
        // 0xFFFFFFFFFF = 1099511627775, modulo 10^12
        XCTAssertEqual(Pins.checkNumber(Pins.b64u(b)), "099511 627775")
        // The hub's own case (hub/tools/phone-app-test.mjs).
        XCTAssertEqual(Pins.checkNumber(Pins.b64u(Data([0, 0, 0, 1, 0, 9, 9]))), "000000 000256")
    }

    func testTheMacAsAPersonNamesIt() {
        XCTAssertEqual(MacName.say("owners-macbook-pro-1"), "MacBook Pro")
        XCTAssertEqual(MacName.say("Owners-MacBook-Pro.local"), "MacBook Pro")
        XCTAssertEqual(MacName.say("users-mac-mini-2"), "Mac mini")
        XCTAssertEqual(MacName.say("studio"), "studio")
        XCTAssertEqual(MacName.say("Test hub"), "Test hub")
        XCTAssertEqual(MacName.say(nil), "your Mac")
    }

    /// The QR path: the Mac's code as a picture, read by the app's QR reader, parsed as the camera's would be.
    func testAQrCodeReadsBackAsTheLink() throws {
        let link = ProcessInfo.processInfo.environment["RAVENRY_TEST_LINK"]
            ?? "ravenry://pair?v=1&name=MacBook+Pro&hosts=192.168.1.20%2Cravenry.tail1234.ts.net&port=4601&pin=\(pin)&code=K7QM2XDP9WRT4HNB"
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(link.utf8)
        f.correctionLevel = "M"
        let img = f.outputImage!.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        // A quiet zone around it, as the Mac's card has.
        let framed = img.transformed(by: CGAffineTransform(translationX: 40, y: 40)).composited(over: CIImage(color: .white).cropped(to: img.extent.insetBy(dx: -40, dy: -40).offsetBy(dx: 40, dy: 40)))
        let cg = CIContext().createCGImage(framed, from: framed.extent)!
        let read = QR.decode(cg)
        XCTAssertEqual(read, [link])
        let l = try PairLink.parse(read[0]).get()
        XCTAssertEqual(l.pin?.count, 43)
        XCTAssertEqual(l.code.count, 16)
    }
}
