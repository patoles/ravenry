// The web view's width on an iPad (C, picked 2026-11-15: the column
// upright and in Split View, the board's wide layout sideways and on the
// 13-inch; Board.swift BoardController.width). The widths are the screens'
// and Split View's own, in points; the board's phone layout is 700 px and
// narrower (hub/public/app.css).

import XCTest
@testable import Ravenry

final class LayoutTests: XCTestCase {
    func testAnIPhoneKeepsItsWholeWidth() {
        for w: CGFloat in [375, 393, 440] {
            XCTAssertEqual(BoardController.width(of: w, page: false, pad: false), w)
            XCTAssertEqual(BoardController.width(of: w, page: true, pad: false), w)
        }
    }

    func testTheBoardOnAnIPad() {
        // 11-inch upright: the phone board in a column of 700.
        XCTAssertEqual(BoardController.width(of: 834, page: false, pad: true), 700)
        // 11-inch sideways, 13-inch either way: the board's wide layout, the whole width.
        XCTAssertEqual(BoardController.width(of: 1194, page: false, pad: true), 1194)
        XCTAssertEqual(BoardController.width(of: 1032, page: false, pad: true), 1032)
        XCTAssertEqual(BoardController.width(of: 1376, page: false, pad: true), 1376)
        // Split View (two thirds of a 13-inch sideways, a half, a third) and Slide Over: the column.
        XCTAssertEqual(BoardController.width(of: 910, page: false, pad: true), 700)
        XCTAssertEqual(BoardController.width(of: 590, page: false, pad: true), 590)
        XCTAssertEqual(BoardController.width(of: 375, page: false, pad: true), 375)
        XCTAssertEqual(BoardController.width(of: 320, page: false, pad: true), 320)
    }

    func testTheAppsOwnPagesOnAnIPad() {
        XCTAssertEqual(BoardController.width(of: 1194, page: true, pad: true), 640)
        XCTAssertEqual(BoardController.width(of: 834, page: true, pad: true), 640)
        XCTAssertEqual(BoardController.width(of: 590, page: true, pad: true), 590)
    }
}
