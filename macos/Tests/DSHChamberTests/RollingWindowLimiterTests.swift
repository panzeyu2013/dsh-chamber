//
//  RollingWindowLimiterTests.swift
//  DSHChamberTests
//
//  2026-12 单源化：滚动窗口限流器的判定语义锁（三处调用点
//  ExternalOpenBudget / SidecarRestartPolicy / RendererRecoveryPolicy 共同依赖）。
//  这里钉住的是**迁移前逐条实现**的行为，故任何一处语义漂移都会先在本文件变红。
//
import XCTest
@testable import DSHChamber

final class RollingWindowLimiterTests: XCTestCase {

    func testAllowsUpToLimitThenDeniesWithoutConsumingQuota() {
        var limiter = RollingWindowLimiter(window: 60, limit: 3)
        XCTAssertEqual(limiter.record(now: 0), .allow(count: 1))
        XCTAssertEqual(limiter.record(now: 1), .allow(count: 2))
        XCTAssertEqual(limiter.record(now: 2), .allow(count: 3))
        // 第 4 次拒绝且不记账（拒绝不占配额——原三处实现的共同语义）
        XCTAssertEqual(limiter.record(now: 3), .deny(count: 3))
        XCTAssertEqual(limiter.events, [0, 1, 2])
        // 窗口内仍拒绝（limit 未被拒绝放大）
        XCTAssertEqual(limiter.record(now: 4), .deny(count: 3))
    }

    func testWindowExpiryReleasesQuota() {
        var limiter = RollingWindowLimiter(window: 10, limit: 3)
        _ = limiter.record(now: 0)
        _ = limiter.record(now: 1)
        _ = limiter.record(now: 2)
        XCTAssertEqual(limiter.record(now: 3), .deny(count: 3))
        // now = 11：t=0 已出窗（11 - 0 = 11 ≥ 10），t=1 恰在边界（11 - 1 = 10 ≥ 10）
        // 同样出窗；只有 t=2 保留 → 计数 1，放行为第 2 次。
        XCTAssertEqual(limiter.record(now: 11), .allow(count: 2))
        XCTAssertEqual(limiter.events, [2, 11])
    }

    /// 边界：淘汰判据是 `now - t < window`（严格小于）——差值恰为 window 时淘汰，
    /// 差值为 window - ε 时保留。原三处实现同式。
    func testWindowBoundaryIsStrictlyLessThan() {
        var limiter = RollingWindowLimiter(window: 10, limit: 1, events: [0])
        XCTAssertEqual(limiter.record(now: 10), .allow(count: 1),
                       "差值恰为窗口 → 旧记录淘汰，放行")
        var kept = RollingWindowLimiter(window: 10, limit: 1, events: [0.000001])
        XCTAssertEqual(kept.record(now: 10), .deny(count: 1),
                       "差值严格小于窗口 → 旧记录保留，拒绝")
    }

    /// 时间回拨（now 小于既有记录）时差值 < window 恒成立 → 旧记录保留。
    /// ExternalOpenBudgetTests 的「decide(now: 100) 后 decide(now: 99) 仍放行」
    /// 依赖该行为，此处显式钉住。
    func testClockGoingBackwardsKeepsEvents() {
        var limiter = RollingWindowLimiter(window: 10, limit: 2)
        XCTAssertEqual(limiter.record(now: 100), .allow(count: 1))
        XCTAssertEqual(limiter.record(now: 99), .allow(count: 2))
        XCTAssertEqual(limiter.record(now: 98), .deny(count: 2))
    }

    func testResetClearsWindow() {
        var limiter = RollingWindowLimiter(window: 60, limit: 1)
        _ = limiter.record(now: 0)
        XCTAssertEqual(limiter.record(now: 1), .deny(count: 1))
        limiter.reset()
        XCTAssertEqual(limiter.count, 0)
        XCTAssertEqual(limiter.record(now: 1), .allow(count: 1))
    }

    /// inout 便捷入口 = 策略层（RendererRecoveryPolicy/SidecarRestartPolicy）的既有
    /// 契约：判定后数组被回写；拒绝时保留**已淘汰后的**窗口记录（调用方 giveUp 的
    /// attempts 计数即来自它）。
    func testInoutDecideWritesBackFilteredEvents() {
        var events: [Double] = [0, 1, 2]
        XCTAssertEqual(
            RollingWindowLimiter.decide(window: 60, limit: 3, now: 3, events: &events),
            .deny(count: 3))
        XCTAssertEqual(events, [0, 1, 2], "拒绝时数组保持淘汰后的记录，不追加本次")
        XCTAssertEqual(
            RollingWindowLimiter.decide(window: 60, limit: 3, now: 61, events: &events),
            .allow(count: 2), "t=0/1 出窗（差值 ≥ 60），t=2 保留，本次计入 → 2")
        XCTAssertEqual(events, [2, 61])
    }

    /// 防御性边界：limit ≤ 0 恒拒绝（迁移前三处不会传入，保持一致以便策略层
    /// 参数校验缺失时仍 fail-closed）。
    func testNonPositiveLimitAlwaysDenies() {
        var limiter = RollingWindowLimiter(window: 10, limit: 0)
        XCTAssertEqual(limiter.record(now: 0), .deny(count: 0))
        XCTAssertEqual(limiter.events, [])
    }

    /// 三处调用点的窗口/上限缺省值锁（改缺省即改产品行为，必须显式意识到）。
    func testPolicyDefaultsRouteThroughSameSemantics() {
        let budget = ExternalOpenBudget()
        XCTAssertEqual([budget.window, budget.cooldown], [10, 30])
        XCTAssertEqual(budget.maxOpens, 8)

        let renderer = RendererRecoveryPolicy()
        var rendererAttempts: [Double] = []
        XCTAssertEqual(renderer.decide(now: 0, attempts: &rendererAttempts),
                       .reload(after: 0.5, attempt: 1))
        XCTAssertEqual(renderer.window, 60)
        XCTAssertEqual(renderer.maxReloads, 3)

        let sidecar = SidecarRestartPolicy()
        var sidecarAttempts: [Double] = []
        XCTAssertEqual(sidecar.decide(now: 0, attempts: &sidecarAttempts),
                       .restart(after: 0.5, attempt: 1))
        XCTAssertEqual(sidecar.window, 60)
        XCTAssertEqual(sidecar.maxRestarts, 3)
    }
}
