// A video's parts for the board's player (Board.swift MediaBlocks, the
// pickvideo round's fourth part, 2026-11-16): the small parts WebKit's
// player asks for, answered from 512 KB blocks each asked of the hub once,
// byte for byte as the hub would have answered them.

import XCTest
@testable import Ravenry

/// A hub that serves one file in parts, counting what it is asked.
private actor PartHub {
    let file: Data
    var asks: [String] = []
    var whole = false
    init(_ n: Int) { file = Data((0..<n).map { UInt8(truncatingIfNeeded: $0 &* 2654435761 >> 13) }) }
    func serve(_ r: String) -> MediaBlocks.Fetched {
        asks.append(r)
        if whole { return .init(status: 200, data: file, contentRange: nil, type: "video/mp4") }
        guard let (a, b) = MediaBlocks.part(r) else { return .init(status: 400, data: Data(), contentRange: nil, type: nil) }
        if a >= file.count { return .init(status: 416, data: Data(), contentRange: "bytes */\(file.count)", type: "video/mp4") }
        let e = min(b ?? file.count - 1, file.count - 1)
        return .init(status: 206, data: file[a...e], contentRange: "bytes \(a)-\(e)/\(file.count)", type: "video/mp4")
    }
    func setWhole() { whole = true }
}

final class MediaBlocksTests: XCTestCase {
    func testTheRangesAPlayerAsks() {
        XCTAssertTrue(MediaBlocks.part("bytes=0-1")! == (0, 1))
        XCTAssertTrue(MediaBlocks.part("bytes=1007571-1011666")! == (1007571, 1011666))
        XCTAssertTrue(MediaBlocks.part("bytes=200-")! == (200, nil))
        XCTAssertNil(MediaBlocks.part("bytes=-500"))
        XCTAssertNil(MediaBlocks.part("bytes=9-3"))
        XCTAssertNil(MediaBlocks.part("items=0-1"))
    }

    func testSmallPartsComeFromBlocksAskedOnce() async {
        let hub = PartHub(1_300_000)
        let mb = MediaBlocks()
        let fetch: @Sendable (String) async -> MediaBlocks.Fetched? = { await hub.serve($0) }
        // As WebKit's player asked on the simulator: the boxes' heads, then the samples, a few KB each, and across a block's end.
        let parts: [(Int, Int?)] = [(0, 1), (0, 7), (8, 31), (32, 39), (148, 155), (21414, 21421), (100_000, 104_095), (520_000, 530_000), (600_000, 700_000), (1_299_990, nil), (1_048_000, 1_299_999)]
        for (a, b) in parts {
            let got = await mb.answer("/api/checkpoints/c1/variants/0", (a, b), fetch: fetch)
            let e = min(b ?? 1_299_999, 1_299_999)
            XCTAssertEqual(got, .part(hub.file[a...e], from: a, total: 1_300_000, type: "video/mp4"), "bytes \(a)-\(b.map(String.init) ?? "")")
        }
        // Three blocks of 512 KB cover the file: each asked once, whatever the player asked.
        let asks = await hub.asks
        XCTAssertEqual(asks, ["bytes=0-524287", "bytes=524288-1048575", "bytes=1048576-1572863"])
        let n = await mb.asked
        XCTAssertEqual(n, 3)
        // The same parts again (a video come back to): from the blocks kept, nothing asked.
        _ = await mb.answer("/api/checkpoints/c1/variants/0", (0, 7), fetch: fetch)
        let again = await hub.asks.count
        XCTAssertEqual(again, 3)
    }

    func testPastTheEndAndAFileNotInParts() async {
        let hub = PartHub(1000)
        let mb = MediaBlocks()
        let fetch: @Sendable (String) async -> MediaBlocks.Fetched? = { await hub.serve($0) }
        let past = await mb.answer("/v", (600_000, nil), fetch: fetch)
        XCTAssertEqual(past, .outside(total: 1000))
        let whole = PartHub(1000)
        await whole.setWhole()
        let got = await MediaBlocks().answer("/w", (0, 1), fetch: { await whole.serve($0) })
        XCTAssertEqual(got, .passOn)
        let none = await MediaBlocks().answer("/x", (0, 1), fetch: { _ in nil })
        XCTAssertEqual(none, .failed)
    }

    func testTheLeastUsedBlocksGoPastTheBudget() async {
        let hub = PartHub(3 * MediaBlocks.size)
        let mb = MediaBlocks(budget: 2 * MediaBlocks.size)
        let fetch: @Sendable (String) async -> MediaBlocks.Fetched? = { await hub.serve($0) }
        for k in 0..<3 { _ = await mb.answer("/v", (k * MediaBlocks.size, k * MediaBlocks.size + 9), fetch: fetch) }
        // Block 0 went (the least used); 1 and 2 stay.
        _ = await mb.answer("/v", (MediaBlocks.size * 2, MediaBlocks.size * 2 + 9), fetch: fetch)
        let kept = await hub.asks.count
        XCTAssertEqual(kept, 3)
        _ = await mb.answer("/v", (0, 9), fetch: fetch)
        let after = await hub.asks.count
        XCTAssertEqual(after, 4)
    }
}
