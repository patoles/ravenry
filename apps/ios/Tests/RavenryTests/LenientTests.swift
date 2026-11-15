// JSON as the hub writes it, read in the app (Core.swift Lenient). JavaScript
// writes half of an emoji alone as \udXXX when the hub cuts a string by
// length (an idea's name at 80 characters, a line at 200), and reads it back;
// Foundation refuses the whole text. The board's own messages are read by the
// page (Board.swift post), and what the app reads itself goes through Lenient.

import XCTest
@testable import Ravenry

final class LenientTests: XCTestCase {
    /// What the hub's JSON.stringify writes for "Trail map " and half of U+1F5FA.
    let cut = #"{"name":"Trail map \ud83d","stage":"spark"}"#

    func testFoundationRefusesWhatJavaScriptWrites() {
        XCTAssertNil(try? JSONSerialization.jsonObject(with: Data(cut.utf8)), "the reason Lenient exists")
    }

    func testReadsHalfAnEmojiAsTheReplacementSign() {
        let o = Lenient.object(cut)
        XCTAssertEqual(o?["name"] as? String, "Trail map \u{FFFD}")
        XCTAssertEqual(o?["stage"] as? String, "spark")
        XCTAssertEqual(Lenient.object(#"{"a":"\udc00x"}"#)?["a"] as? String, "\u{FFFD}x", "a low half alone")
    }

    func testKeepsWholePairsEscapesAndBackslashes() {
        XCTAssertEqual(Lenient.object(#"{"a":"🗺"}"#)?["a"] as? String, "\u{1F5FA}")
        XCTAssertEqual(Lenient.object(#"{"a":"\\ud83d"}"#)?["a"] as? String, #"\ud83d"#, "an escaped backslash, then letters")
        XCTAssertEqual(Lenient.object(#"{"a":"\\\ud83d"}"#)?["a"] as? String, "\\\u{FFFD}")
        XCTAssertEqual(Lenient.object(#"{"a":"café \"x\"  "}"#)?["a"] as? String, "caf\u{e9} \"x\" \u{2028}")
        XCTAssertNil(Lenient.object("not json"))
    }
}
