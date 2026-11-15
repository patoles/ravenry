// The board's live screen changes every second, so the app is never idle
// and XCUITest, which waits for an idle app before each step, would wait
// on every query. For these checks only, its wait is turned off: each step
// waits for its own element instead (waitForExistence).

import Foundation
import ObjectiveC

enum Quiet {
    static func off() {
        guard let cls = NSClassFromString("XCUIApplicationProcess") else { return }
        let two: @convention(block) (AnyObject, Bool, Bool) -> Void = { _, _, _ in }
        let three: @convention(block) (AnyObject, Bool, AnyObject?, Bool) -> Void = { _, _, _, _ in }
        if let m = class_getInstanceMethod(cls, NSSelectorFromString("waitForQuiescenceIncludingAnimationsIdle:isPreEvent:")) {
            method_setImplementation(m, imp_implementationWithBlock(two))
        }
        if let m = class_getInstanceMethod(cls, NSSelectorFromString("waitForQuiescenceIncludingAnimationsIdle:usingActivity:isPreEvent:")) {
            method_setImplementation(m, imp_implementationWithBlock(three))
        }
    }
}
