//
//  ShellPerfTests.swift
//  DSHChamberTests
//
//  Phase 0（《最终设计方案 v2》）：ShellPerf 的记账与格式化契约。
//
import XCTest
@testable import DSHChamber

final class ShellPerfTests: XCTestCase {

    override func tearDown() {
        ShellPerf.resetForTesting()
        super.tearDown()
    }

    func testMarkProcessStartIsIdempotentAndMsSinceT0() {
        ShellPerf.resetForTesting()
        let first = Date(timeIntervalSince1970: 1_000_000)
        ShellPerf.markProcessStart(first)
        // 幂等：首个时间点生效，后续调用不覆盖
        ShellPerf.markProcessStart(Date(timeIntervalSince1970: 2_000_000))
        XCTAssertEqual(ShellPerf.t0, first)
        XCTAssertEqual(ShellPerf.msSinceT0(now: first), 0)
        XCTAssertEqual(ShellPerf.msSinceT0(now: first.addingTimeInterval(0.25)), 250)
        XCTAssertEqual(ShellPerf.bootLine("configure", now: first.addingTimeInterval(1.5)),
                       "[perf] boot configure +1500ms")
    }

    /// 未 mark 时 t0 退化为首次访问时刻（不崩）；reset 后可重新 mark；取整用
    /// toNearestOrAwayFromZero（0.4ms → 0，0.6ms → 1）。
    func testT0FallbackResetAndRounding() {
        ShellPerf.resetForTesting()
        let fallback = ShellPerf.t0
        XCTAssertLessThan(abs(fallback.timeIntervalSinceNow), 5, "未 mark 时 t0 应为访问时刻")
        XCTAssertGreaterThanOrEqual(ShellPerf.msSinceT0(now: Date().addingTimeInterval(1)), 900)

        ShellPerf.resetForTesting()
        let base = Date(timeIntervalSince1970: 5_000)
        ShellPerf.markProcessStart(base)
        XCTAssertEqual(ShellPerf.t0, base)
        XCTAssertEqual(ShellPerf.msSinceT0(now: base.addingTimeInterval(0.0004)), 0)
        XCTAssertEqual(ShellPerf.msSinceT0(now: base.addingTimeInterval(0.0006)), 1)
    }
}
