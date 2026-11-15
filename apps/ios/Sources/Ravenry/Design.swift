// The colours and words every client shares (shared/README.md), read from
// the app's copies of shared/tokens/tokens.json and shared/strings/en.json:
// never typed again here.

import SwiftUI
import UIKit

enum Shared {
    static let tokens: [String: Any] = {
        guard let u = Bundle.main.url(forResource: "tokens", withExtension: "json"), let d = try? Data(contentsOf: u),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
        return o
    }()

    static let words: [String: Any] = {
        guard let u = Bundle.main.url(forResource: "en", withExtension: "json"), let d = try? Data(contentsOf: u),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
        return o
    }()

    /// A shared word (shared/README.md's Swift reader): the key itself when the file has none.
    static func t(_ key: String, _ vars: [String: String] = [:]) -> String {
        guard key != "$comment", let s = words[key] as? String else { return key }
        return vars.reduce(s) { $0.replacingOccurrences(of: "{\($1.key)}", with: $1.value) }
    }

    /// A colour token, "#RRGGBB" or "rgba(r,g,b,a)", of dark or light.
    static func color(_ key: String, dark: Bool) -> UIColor {
        let c = ((tokens["color"] as? [String: Any])?[dark ? "dark" : "light"] as? [String: Any])?[key] as? String ?? "#FF00FF"
        return parse(c)
    }

    static func parse(_ s: String) -> UIColor {
        if s.hasPrefix("#"), s.count == 7, let v = UInt32(s.dropFirst(), radix: 16) {
            return UIColor(red: CGFloat(v >> 16 & 255) / 255, green: CGFloat(v >> 8 & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
        }
        let n = s.drop { $0 != "(" }.dropFirst().prefix { $0 != ")" }.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        if n.count >= 3 { return UIColor(red: n[0] / 255, green: n[1] / 255, blue: n[2] / 255, alpha: n.count > 3 ? n[3] : 1) }
        return .magenta
    }

    /// A colour that follows the phone's dark or light.
    static func dynamic(_ key: String) -> UIColor {
        UIColor { $0.userInterfaceStyle == .dark ? color(key, dark: true) : color(key, dark: false) }
    }
}

/// This device in the shared words (shared/strings device.*): "phone" and
/// "iPhone" on an iPhone, "iPad" on an iPad, where the app runs full screen
/// (C, picked 2026-11-15).
enum Device {
    /// Read first at the app's start, on the main thread (AppDelegate).
    static let pad = UIDevice.current.userInterfaceIdiom == .pad
    /// For the page's hello: "ipad" or "iphone".
    static var form: String { pad ? "ipad" : "iphone" }
    /// In a sentence: "this phone", "this iPad".
    static var word: String { Shared.t(pad ? "device.word.ipad" : "device.word.phone") }
    /// The model: "Which iPhone is this?", "Which iPad is this?".
    static var model: String { Shared.t(pad ? "device.model.ipad" : "device.model.iphone") }
}

/// The pairing screens' palette (round 1's drawings, from the tokens): the window,
/// a raised surface (the dark card, the light sheet), text, the states.
struct T {
    let dark: Bool
    private func c(_ k: String) -> Color { Color(Shared.color(k, dark: dark)) }
    var win: Color { c("win") }
    var card: Color { c(dark ? "card" : "sheet") }
    var tx: Color { c("tx") }
    var tx2: Color { c("tx2") }
    var tx3: Color { c("tx3") }
    var work: Color { c("work") }
    var line: Color { c("sep") }
    var you: Color { c("you") }
    var ok: Color { c("ok") }
    var bad: Color { c("bad") }
}
