//
//  RendererHangWatchdogTests.swift
//  DSHChamberTests
//
import XCTest
@testable import DSHChamber

final class RendererHangWatchdogTests: XCTestCase {
    private let t0: TimeInterval = 1_000_000

    func testFirstLoadGateAndContinuousVisibleProbes() {
        var watchdog = RendererHangWatchdog()
        XCTAssertEqual(watchdog.tick(now: t0 + 60), .nothing)
        watchdog.noteFirstLoadFinished()
        XCTAssertEqual(watchdog.tick(now: t0 + 61), .probe(1))
        XCTAssertEqual(watchdog.noteProbeSucceeded(id: 1, frameCount: 0), .nothing)
        XCTAssertEqual(watchdog.tick(now: t0 + 65), .nothing)
        XCTAssertEqual(watchdog.tick(now: t0 + 66), .probe(2))
    }

    func testFrameProgressClearsStallsAndStaticFrameCounterReloads() {
        var watchdog = RendererHangWatchdog()
        watchdog.noteFirstLoadFinished()
        for (second, frame) in [(0.0, 0), (5.0, 0), (10.0, 1),
                                (15.0, 1), (20.0, 1), (25.0, 1)].enumerated() {
            let id = UInt64(second + 1)
            XCTAssertEqual(watchdog.tick(now: t0 + frame.0), .probe(id))
            let outcome = watchdog.noteProbeSucceeded(id: id, frameCount: frame.1)
            XCTAssertEqual(outcome, id == 6 ? .reload : .nothing)
        }
    }

    func testThreeTimeoutsAndLateCallbackCannotClearEvidence() {
        var watchdog = RendererHangWatchdog()
        watchdog.noteFirstLoadFinished()
        for index in 0..<3 {
            let start = t0 + Double(index) * 5
            let id = UInt64(index + 1)
            XCTAssertEqual(watchdog.tick(now: start), .probe(id))
            XCTAssertEqual(watchdog.tick(now: start + 3),
                           index == 2 ? .reload : .nothing)
            XCTAssertEqual(watchdog.noteProbeSucceeded(id: id, frameCount: 100), .nothing)
            XCTAssertEqual(watchdog.strikes, index == 2 ? 0 : index + 1)
        }
    }

    func testNavigationResetInvalidatesOldProbe() {
        var watchdog = RendererHangWatchdog()
        watchdog.noteFirstLoadFinished()
        XCTAssertEqual(watchdog.tick(now: t0), .probe(1))
        watchdog.reset()
        XCTAssertEqual(watchdog.noteProbeFailed(id: 1), .nothing)
        XCTAssertEqual(watchdog.tick(now: t0 + 1), .probe(2))
        XCTAssertEqual(watchdog.strikes, 0)
    }

    // MARK: - 输入阻塞往返（Electron main.ts 的 inputBlockRttMs 腿）

    /// 超预算的往返是输入阻塞证据，不是帧 strike；但帧计数照样算进度
    /// （Electron RendererFrameWatchdog.succeeded 同序：先记进度再判预算）。
    func testSlowRoundTripIsInputBlockEvidenceNotAFrameStrike() {
        var watchdog = RendererHangWatchdog()
        watchdog.noteFirstLoadFinished()
        XCTAssertEqual(watchdog.tick(now: t0), .probe(1))
        let slow = RendererHangWatchdog.inputBlockRtt + 0.5
        XCTAssertEqual(watchdog.noteProbeSucceeded(id: 1, frameCount: 10, rtt: slow),
                       .inputBlock(rtt: slow))
        XCTAssertEqual(watchdog.strikes, 0, "超预算是输入阻塞证据，不是帧 strike")
        XCTAssertEqual(watchdog.inputBlockStrikes, 1)
        // 帧计数仍然是进度：下一次静止样本才是第一次帧 strike。
        XCTAssertEqual(watchdog.tick(now: t0 + 5), .probe(2))
        XCTAssertEqual(watchdog.noteProbeSucceeded(id: 2, frameCount: 10), .nothing)
        XCTAssertEqual(watchdog.strikes, 1)
    }

    /// 连续三次超预算 → 同一个 strike 上界触发有界重载，并清空证据窗口。
    func testThreeOverBudgetRoundTripsReloadAtTheFrameStrikeBound() {
        var watchdog = RendererHangWatchdog()
        watchdog.noteFirstLoadFinished()
        let slow = RendererHangWatchdog.inputBlockRtt + 0.5
        var outcomes: [RendererHangWatchdog.Action] = []
        for index in 0..<RendererHangWatchdog.maxStrikes {
            let id = UInt64(index + 1)
            XCTAssertEqual(watchdog.tick(now: t0 + Double(index) * 5), .probe(id))
            outcomes.append(watchdog.noteProbeSucceeded(id: id, frameCount: index + 1, rtt: slow))
        }
        XCTAssertEqual(outcomes, [.inputBlock(rtt: slow), .inputBlock(rtt: slow), .reload])
        XCTAssertEqual(watchdog.inputBlockStrikes, 0, "升级重载后证据窗口归零")
        XCTAssertEqual(watchdog.strikes, 0)
    }

    /// 一次健康往返清空输入阻塞连击；其后重新从 1 计数。
    func testHealthyRoundTripClearsTheInputBlockStreak() {
        var watchdog = RendererHangWatchdog()
        watchdog.noteFirstLoadFinished()
        let slow = RendererHangWatchdog.inputBlockRtt + 0.5
        var at = t0
        var frames = 0
        for index in 0..<(RendererHangWatchdog.maxStrikes - 1) {
            let id = UInt64(index + 1)
            XCTAssertEqual(watchdog.tick(now: at), .probe(id))
            frames += 1
            XCTAssertEqual(watchdog.noteProbeSucceeded(id: id, frameCount: frames, rtt: slow),
                           .inputBlock(rtt: slow))
            at += 5
        }
        let healthyID = UInt64(RendererHangWatchdog.maxStrikes)
        XCTAssertEqual(watchdog.tick(now: at), .probe(healthyID))
        frames += 1
        XCTAssertEqual(watchdog.noteProbeSucceeded(id: healthyID, frameCount: frames, rtt: 0.001), .nothing)
        XCTAssertEqual(watchdog.inputBlockStrikes, 0, "健康往返清空输入阻塞连击")
        at += 5
        let nextID = healthyID + 1
        XCTAssertEqual(watchdog.tick(now: at), .probe(nextID))
        frames += 1
        XCTAssertEqual(watchdog.noteProbeSucceeded(id: nextID, frameCount: frames, rtt: slow),
                       .inputBlock(rtt: slow), "健康样本后连击窗口重开")
        XCTAssertEqual(watchdog.inputBlockStrikes, 1)
    }
}
