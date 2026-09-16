//
//  RendererHangWatchdogTests.swift
//  DSHChamberPocTests
//
//  S-02（2026-12 复裁决）：渲染器卡死自愈的纯判据——空闲够久才 ping、连续 3 次
//  超时才重载、任何键鼠输入都清零。
//
import XCTest
@testable import DSHChamberPoc

final class RendererHangWatchdogTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    func testNoProbeWhileUserIsActive() {
        var watchdog = RendererHangWatchdog(now: t0)
        // 空闲不足 15s：既不 ping 也不重载。
        XCTAssertEqual(watchdog.tick(now: t0.addingTimeInterval(5)), .nothing)
        XCTAssertEqual(watchdog.tick(now: t0.addingTimeInterval(14)), .nothing)
        XCTAssertEqual(watchdog.strikes, 0)
    }

    func testProbesOnlyAfterIdleGraceAndThenRespectsInterval() {
        var watchdog = RendererHangWatchdog(now: t0)
        XCTAssertEqual(watchdog.tick(now: t0.addingTimeInterval(15)), .probe, "空闲满 15s 才 ping")
        // 在飞期间不重复 ping。
        XCTAssertEqual(watchdog.tick(now: t0.addingTimeInterval(16)), .nothing)
        // ping 正常返回：清零。
        watchdog.noteProbeSucceeded()
        XCTAssertEqual(watchdog.tick(now: t0.addingTimeInterval(17)), .nothing, "距上次 ping 不足 5s")
        XCTAssertEqual(watchdog.tick(now: t0.addingTimeInterval(21)), .probe)
    }

    func testReloadAfterThreeConsecutiveTimeouts() {
        var watchdog = RendererHangWatchdog(now: t0)
        var now = t0.addingTimeInterval(15)
        // 第 1 次 ping + 超时 → strike 1。
        XCTAssertEqual(watchdog.tick(now: now), .probe)
        now = now.addingTimeInterval(3)
        XCTAssertEqual(watchdog.tick(now: now), .nothing)
        XCTAssertEqual(watchdog.strikes, 1)
        // 第 2 次。
        now = now.addingTimeInterval(2)
        XCTAssertEqual(watchdog.tick(now: now), .probe)
        now = now.addingTimeInterval(3)
        XCTAssertEqual(watchdog.tick(now: now), .nothing)
        XCTAssertEqual(watchdog.strikes, 2)
        // 第 3 次超时 → 判定卡死并清零计数。
        now = now.addingTimeInterval(2)
        XCTAssertEqual(watchdog.tick(now: now), .probe)
        now = now.addingTimeInterval(3)
        XCTAssertEqual(watchdog.tick(now: now), .reload, "连续 3 次超时 ≈15s+ → 重载")
        XCTAssertEqual(watchdog.strikes, 0)
        XCTAssertEqual(watchdog.tick(now: now.addingTimeInterval(1)), .nothing, "重载后重新计时")
    }

    func testUserInputResetsStrikesAndTimer() {
        var watchdog = RendererHangWatchdog(now: t0)
        var now = t0.addingTimeInterval(15)
        XCTAssertEqual(watchdog.tick(now: now), .probe)
        now = now.addingTimeInterval(3)
        XCTAssertEqual(watchdog.tick(now: now), .nothing)
        XCTAssertEqual(watchdog.strikes, 1)
        // 用户敲了下键盘：strike 清零、空闲计时重来（绝不打断输入）。
        watchdog.noteUserInput(at: now)
        XCTAssertEqual(watchdog.strikes, 0)
        XCTAssertEqual(watchdog.tick(now: now.addingTimeInterval(14)), .nothing)
        XCTAssertEqual(watchdog.tick(now: now.addingTimeInterval(15)), .probe)
    }

    func testHiccupDoesNotAccumulate() {
        var watchdog = RendererHangWatchdog(now: t0)
        var now = t0.addingTimeInterval(15)
        for _ in 0..<2 {
            XCTAssertEqual(watchdog.tick(now: now), .probe)
            now = now.addingTimeInterval(3)
            XCTAssertEqual(watchdog.tick(now: now), .nothing)
            watchdog.noteProbeSucceeded()  // 下一次 ping 成功 → 清零
            now = now.addingTimeInterval(5)
        }
        XCTAssertEqual(watchdog.strikes, 0, "偶发慢响应不得累积成重载")
    }
}
