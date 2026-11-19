// Alerts through APNs (docs/PHONE.md section 4, "apns"): the device opens
// what the hub sealed (Sources/Shared/PushCrypto.swift), with CryptoKit.
// Two known answers: RFC 8291's own example (section 5), and a message the
// hub's encrypt (hub/server/push.mjs) sealed for a fixed key, with accents
// and an emoji. Then the buttons each kind of alert gets
// (Sources/Shared/AlertContent.swift), what the Notification Service
// Extension draws for what APNs brings (`AlertContent.service`: `simctl
// push` does not run an extension, so it is driven here), and the alerts'
// key in the Keychain.

import XCTest
import CryptoKit
import UserNotifications
@testable import Ravenry

final class PushTests: XCTestCase {
    func key(_ b64u: String) -> P256.KeyAgreement.PrivateKey { try! P256.KeyAgreement.PrivateKey(rawRepresentation: Data(b64u: b64u)!) }

    func testRfc8291Example() throws {
        let ua = key("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")
        let auth = Data(b64u: "BTBZMqHH6r4Tts7J_aSIgg")!
        let body = Data(b64u: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")!
        let plain = try PushCrypto.open(body, key: ua, auth: auth)
        XCTAssertEqual(String(decoding: plain, as: UTF8.self), "When I grow up, I want to be a watermelon")
    }

    /// Sealed by the hub's own encrypt (node, hub/server/push.mjs) for this key.
    func testTheHubsSealedAlert() throws {
        let ua = key(fixtureKey)
        XCTAssertEqual(ua.publicKey.x963Representation.b64u, "BMtdi7-tVNpP7-QXFRHciUCVzSPs6HcUSdHNVcoapjOfRVh-_q-lGce6MIr-MQKMbEwBUuKrWQxCvT17loV_UAo")
        let auth = Data(b64u: "ABEiM0RVZneImaq7zN3u_w")!
        let body = Data(b64u: "_ty6mHZUMhABI0VniavN7wAAEABBBLWhBLbKrfoVpvues5OSNyhNQE6dlIa3BkEUV6FvEuhKGLvr2X5SWGcHVEK9Uw6k0p7nrYc6gqYugEvjwI40ydalr6HnwaJFUh8IeNhYvq5rVmt5Cl1r3v1BWMmOK3P9GhM8Aj0FCy6YBjxKHV6mtlAFngyVbS3_vX2Q4UAGvGvHpq3fwMi3-3odSqLJp8_TwtNtACGFjE9lxL0VEWS1jAAPhNwj0yasqy6rB1rXrvsfgZtazIoy_syGUST81lnA-37mGLnv7xzcEnESV4r2GU8g1Yq4HJYkp7BBwBzxvZIodMT4PFmffyOcKGJX3TrLZ7z65Of192nAbCq6OuXjCennd3Doez8PnMQJ1BLKic-j7xbH5MDKPOezn8EYF4jB_2C27m0kEObgKzBlin_AnTqxqa3ENGMlj6d8as-3Taf-6PSbs4qqt51aPQieg_W5hHvMzQrcGvc9YPhSlDzSE1qy4SL673wb370NSjQ2J36V9uFY")!
        let plain = try PushCrypto.open(body, key: ua, auth: auth)
        let m = try XCTUnwrap((try JSONSerialization.jsonObject(with: plain)) as? [String: Any])
        XCTAssertEqual(m["title"] as? String, "notes-app asks")
        XCTAssertEqual(m["body"] as? String, "Ship the beta to the testers? Été 🚀")
        // The wrong key, or a changed byte, opens nothing.
        XCTAssertThrowsError(try PushCrypto.open(body, key: P256.KeyAgreement.PrivateKey(), auth: auth))
        var bad = body; bad[bad.count - 20] ^= 1
        XCTAssertThrowsError(try PushCrypto.open(bad, key: ua, auth: auth))
        XCTAssertThrowsError(try PushCrypto.open(body.prefix(90), key: ua, auth: auth))
    }

    func ids(_ m: [String: Any]) -> [String] { AlertContent.actions(m).map { $0.identifier } }
    func opts(_ m: [String: Any], _ id: String) -> UNNotificationActionOptions { AlertContent.actions(m).first { $0.identifier == id }!.options }

    func testTheButtonsOfEachKind() {
        let ask: [String: Any] = ["kind": "ask", "actions": [["id": "choice:0", "label": "Ship it"], ["id": "choice:1", "label": "Not yet"]], "reply": ["action": "text", "label": "Answer", "hint": "Answer in your own words"]]
        XCTAssertEqual(ids(ask), ["choice:0", "choice:1", "reply"])
        XCTAssertEqual(opts(ask, "choice:0"), [.authenticationRequired], "an answer: unlocked first, no app")
        XCTAssertTrue(AlertContent.actions(ask).last is UNTextInputNotificationAction)
        let approve: [String: Any] = ["kind": "approve", "actions": [["id": "run", "label": "Run", "biometric": true], ["id": "refuse", "label": "Refuse"], ["id": "open", "label": "Open"]]]
        XCTAssertEqual(ids(approve), ["run", "refuse", "open"])
        XCTAssertEqual(opts(approve, "run"), [.foreground, .authenticationRequired], "Run opens the app, which asks for Face ID")
        XCTAssertEqual(opts(approve, "refuse"), [.destructive, .authenticationRequired])
        XCTAssertEqual(opts(approve, "open"), [.foreground])
        let drive: [String: Any] = ["kind": "drive", "actions": [["id": "allow:once", "label": "Allow once", "biometric": true], ["id": "allow:session", "label": "This session", "biometric": true], ["id": "refuse", "label": "Refuse"]]]
        XCTAssertEqual(opts(drive, "allow:session"), [.foreground, .authenticationRequired])
        let pick: [String: Any] = ["kind": "pick", "actions": [["id": "pick:0", "label": "A"], ["id": "pick:1", "label": "B"]]]
        XCTAssertEqual(AlertContent.actions(pick).map { $0.title }, ["Compare", "Not now"], "a pick: Compare and Not now, whatever it lists")
        let secret: [String: Any] = ["kind": "secret", "actions": [["id": "open", "label": "Type it"], ["id": "decline", "label": "Not now"]], "reply": ["action": "text", "label": "Answer"]]
        XCTAssertEqual(ids(secret), ["open", "decline"], "a secret never has a reply line")
        let long: [String: Any] = ["kind": "ask", "actions": [["id": "choice:0", "label": String(repeating: "x", count: 90)]]]
        XCTAssertEqual(AlertContent.actions(long)[0].title.count, AlertContent.maxLabel)
        XCTAssertNotEqual(AlertContent.categoryId(AlertContent.actions(ask)), AlertContent.categoryId(AlertContent.actions(approve)))
        XCTAssertEqual(AlertContent.categoryId(AlertContent.actions(ask)), AlertContent.categoryId(AlertContent.actions(ask)))
        XCTAssertTrue(AlertContent.actions(["kind": "test", "actions": []]).isEmpty)
    }

    func testTheWords() {
        let c = UNMutableNotificationContent()
        AlertContent.fill(c, ["id": "cp:x", "title": "notes-app asks", "body": "Ship it?", "detail": NSNull(), "project": ["id": "notes-app"]])
        XCTAssertEqual(c.title, "notes-app asks")
        XCTAssertEqual(c.body, "Ship it?", "a null detail is never the word null")
        XCTAssertEqual(c.threadIdentifier, "notes-app")
        XCTAssertNotNil(c.userInfo["alert"] as? String)
    }

    let fixtureKey = "yfKh0Ljn9qXEs6KRgPfm1cSzopGPfm1cSzopGAf25dQ"
    let fixtureAuth = "ABEiM0RVZneImaq7zN3u_w"
    let fixtureBody = "_ty6mHZUMhABI0VniavN7wAAEABBBLWhBLbKrfoVpvues5OSNyhNQE6dlIa3BkEUV6FvEuhKGLvr2X5SWGcHVEK9Uw6k0p7nrYc6gqYugEvjwI40ydalr6HnwaJFUh8IeNhYvq5rVmt5Cl1r3v1BWMmOK3P9GhM8Aj0FCy6YBjxKHV6mtlAFngyVbS3_vX2Q4UAGvGvHpq3fwMi3-3odSqLJp8_TwtNtACGFjE9lxL0VEWS1jAAPhNwj0yasqy6rB1rXrvsfgZtazIoy_syGUST81lnA-37mGLnv7xzcEnESV4r2GU8g1Yq4HJYkp7BBwBzxvZIodMT4PFmffyOcKGJX3TrLZ7z65Of192nAbCq6OuXjCennd3Doez8PnMQJ1BLKic-j7xbH5MDKPOezn8EYF4jB_2C27m0kEObgKzBlin_AnTqxqa3ENGMlj6d8as-3Taf-6PSbs4qqt51aPQieg_W5hHvMzQrcGvc9YPhSlDzSE1qy4SL673wb370NSjQ2J36V9uFY"

    func serviced(_ info: [AnyHashable: Any]) -> UNNotificationContent? {
        let c = UNMutableNotificationContent()
        c.title = "Ravenry"; c.body = "Open Ravenry to see this alert."
        c.userInfo = info
        let got = expectation(description: "the extension's answer")
        var out: UNNotificationContent?
        AlertContent.service(c) { out = $0; got.fulfill() }
        wait(for: [got], timeout: 5)
        return out
    }

    /// What APNs brings, as the relay sends it, drawn as the hub's alert with its buttons.
    func testTheExtensionDrawsTheSealedAlert() throws {
        PushKeys.store(key(fixtureKey), auth: Data(b64u: fixtureAuth)!)
        defer { PushKeys.wipe() }
        let c = try XCTUnwrap(serviced(["aps": ["mutable-content": 1], "e": fixtureBody]))
        XCTAssertEqual(c.title, "notes-app asks")
        XCTAssertEqual(c.body, "Ship the beta to the testers? Été 🚀")
        XCTAssertTrue(c.categoryIdentifier.hasPrefix("a."), c.categoryIdentifier)
        let m = AlertContent.alertOf(c.userInfo)
        XCTAssertEqual(m?["id"] as? String, "cp:c7k2m9qx")
        let registered = expectation(description: "its category")
        var acts: [String] = []
        UNUserNotificationCenter.current().getNotificationCategories { cats in
            acts = cats.first { $0.identifier == c.categoryIdentifier }?.actions.map { $0.identifier } ?? []
            registered.fulfill()
        }
        wait(for: [registered], timeout: 5)
        XCTAssertEqual(acts, ["choice:0", "choice:1", "reply"], "its buttons are registered before it shows")
        // A tap on one still sealed (the extension out of time) opens the same alert.
        XCTAssertEqual(AlertContent.alertOf(["e": fixtureBody])?["id"] as? String, "cp:c7k2m9qx")
    }

    /// Bytes not made for this device, or no key: nothing drawn, the placeholder stays.
    func testTheExtensionLeavesThePlaceholder() {
        PushKeys.store(P256.KeyAgreement.PrivateKey(), auth: Data(repeating: 7, count: 16))
        defer { PushKeys.wipe() }
        XCTAssertNil(serviced(["e": fixtureBody]))
        XCTAssertNil(serviced(["e": "not sealed"]))
        XCTAssertNil(serviced([:]))
    }

    /// The alerts' key: made once, the same after, its public half 65 bytes.
    func testTheKeyIsKept() throws {
        PushKeys.wipe()
        let a = try XCTUnwrap(PushKeys.make())
        let b = try XCTUnwrap(PushKeys.make())
        XCTAssertEqual(a.key.rawRepresentation, b.key.rawRepresentation)
        XCTAssertEqual(a.auth.count, 16)
        let p = PushKeys.publicParts(a)
        XCTAssertEqual(Data(b64u: p.p256dh)?.count, 65)
        XCTAssertEqual(Data(b64u: p.p256dh)?.first, 4)
        XCTAssertEqual(Data(b64u: p.auth), a.auth)
        PushKeys.wipe()
    }
}
