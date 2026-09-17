//
//  RendererHangWatchdogTests.swift
//  DSHChamberPocTests
//
//  S-02（2026-12 复裁决）/ S-34（2026-12 双端逐函数核对）：渲染器卡死自愈的
//  纯判据——首载门（didFinish 前只记录不探测）、空闲够久才 ping、连续 3 次超时
//  才重载、任何键鼠输入都清零。
//
import XCTest
@testable import DSHChamberPoc

final class RendererHangWatchdogTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    /// 已过首载门（didFinish）的判定器——既有判定语义测试都以此为前置。
    private func loadedWatchdog(now: Date) -> RendererHangWatchdog {
        var watchdog = RendererHangWatchdog(now: now)
        watchdog.noteFirstLoadFinished()
        return watchdog
    }

    // MARK: - S-34 首载门

    /// 首次成功加载前：即使空闲远超阈值也只记录，不 ping、不重载、不累计 strike。
    func testNoProbeOrReloadBeforeFirstLoadFinishes() {
        var watchdog = RendererHangWatchdog(now: t0)
        XCTAssertFalse(watchdog.loadedOnce)
        XCTAssertEqual(watchdog.tick(now: t0.addingTimeInterval(15)), .nothing)
        XCTAssertEqual(watchdog.tick(now: t0.addingTimeInterval(60)), .nothing)
        XCTAssertEqual(watchdog.strikes, 0, "门关期间绝不累计 strike")
        // 门打开后照常探测（同一时钟继续）。
        watchdog.noteFirstLoadFinished()
        XCTAssertTrue(watchdog.loadedOnce)
        XCTAssertEqual(watchdog.tick(now: t0.addingTimeInterval(61)), .probe)
    }

    /// 门打开前的键鼠输入照常记账：开门后从最后一次输入起算空闲（不打断输入）。
    func testInputBeforeFirstLoadStillFeedsIdleTimer() {
        var watchdog = RendererHangWatchdog(now: t0)
        watchdog.noteUserInput(at: t0.addingTimeInterval(50))
        XCTAssertEqual(watchdog.tick(now: t0.addingTimeInterval(60)), .nothing)
        watchdog.noteFirstLoadFinished()
        XCTAssertEqual(watchdog.tick(now: t0.addingTimeInterval(64)), .nothing,
                       "距最后一次输入仅 14s")
        XCTAssertEqual(watchdog.tick(now: t0.addingTimeInterval(65)), .probe)
    }

    // MARK: - 判定语义（门打开后）

    func testNoProbeWhileUserIsActive() {
        var watchdog = loadedWatchdog(now: t0)
        // 空闲不足 15s：既不 ping 也不重载。
        XCTAssertEqual(watchdog.tick(now: t0.addingTimeInterval(5)), .nothing)
        XCTAssertEqual(watchdog.tick(now: t0.addingTimeInterval(14)), .nothing)
        XCTAssertEqual(watchdog.strikes, 0)
    }

    func testProbesOnlyAfterIdleGraceAndThenRespectsInterval() {
        var watchdog = loadedWatchdog(now: t0)
        XCTAssertEqual(watchdog.tick(now: t0.addingTimeInterval(15)), .probe, "空闲满 15s 才 ping")
        // 在飞期间不重复 ping。
        XCTAssertEqual(watchdog.tick(now: t0.addingTimeInterval(16)), .nothing)
        // ping 正常返回：清零。
        watchdog.noteProbeSucceeded()
        XCTAssertEqual(watchdog.tick(now: t0.addingTimeInterval(17)), .nothing, "距上次 ping 不足 5s")
        XCTAssertEqual(watchdog.tick(now: t0.addingTimeInterval(21)), .probe)
    }

    func testReloadAfterThreeConsecutiveTimeouts() {
        var watchdog = loadedWatchdog(now: t0)
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
        var watchdog = loadedWatchdog(now: t0)
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
        var watchdog = loadedWatchdog(now: t0)
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
