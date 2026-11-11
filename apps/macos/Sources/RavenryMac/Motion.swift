// Reduced motion (A11Y-010): macOS's Accessibility > Display > Reduce motion,
// read at each use (the person can turn it on while the app runs). One place
// every animation asks: the tab strip's tabs sliding into place, the
// filmstrip's play, Ink's launch animation (Ink.swift). Under it a tab takes
// its place at once, and the filmstrip's play holds each frame at least half
// a second, never flickering through frames 60 ms apart; a press still plays.
//
// RAVENRY_MAC_REDUCE_MOTION=1 (or 0) stands in for the system's switch in a
// check, and `test` sets it for a self-test; a release drops the variable
// (Gate.swift).

import AppKit

enum Motion {
    /// A self-test's answer, over the system's.
    static var test: Bool?

    static var reduced: Bool {
        if let t = test { return t }
        if let v = ProcessInfo.processInfo.environment["RAVENRY_MAC_REDUCE_MOTION"], !v.isEmpty { return v == "1" }
        return NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    /// The shortest a frame of the filmstrip's play is held, in seconds.
    static var shortestFrame: Double { reduced ? 0.5 : 0.06 }
}
