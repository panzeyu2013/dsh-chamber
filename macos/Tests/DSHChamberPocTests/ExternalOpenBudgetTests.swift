//
//  ExternalOpenBudgetTests.swift
//  DSHChamberPocTests
//
//  二轮评审 A-P2：外链打开预算（10s/8 次 + 30s 冷却，镜像 shell-core）。
//
import XCTest
@testable import DSHChamberPoc

final class ExternalOpenBudgetTests: XCTestCase {
    func testAllowsUpToEightInWindow() {
        var budget = ExternalOpenBudget()
        for index in 0..<8 {
            XCTAssertEqual(budget.decide(now: Double(index) * 0.1), .allow, "第 \(index + 1) 次应放行")
        }
        // 第 9 次超限 → 冷却 30s
        XCTAssertEqual(budget.decide(now: 0.9), .blocked(cooldownRemaining: 30))
        // 冷却期内一律拒绝（剩余时间递减）
        guard case .blocked(let remaining) = budget.decide(now: 10.0) else {
            return XCTFail("冷却期内应拒绝")
        }
        XCTAssertEqual(remaining, 20.9, accuracy: 0.001)
    }

    func testWindowSlides() {
        var budget = ExternalOpenBudget()
        for index in 0..<8 {
            XCTAssertEqual(budget.decide(now: Double(index)), .allow)
        }
        // 11s 后窗口滑出（0..7 的计数全部过期）→ 重新允许
        XCTAssertEqual(budget.decide(now: 11), .allow)
    }

    func testCooldownExpiresAndRecounts() {
        var budget = ExternalOpenBudget()
        for index in 0..<8 {
            _ = budget.decide(now: Double(index))
        }
        _ = budget.decide(now: 8) // 触发冷却，blockedUntil = 38
        XCTAssertEqual(budget.decide(now: 37), .blocked(cooldownRemaining: 1))
        XCTAssertEqual(budget.decide(now: 39), .allow, "冷却结束后重新计数")
    }

    func testNegativeElapsedIsSafe() {
        var budget = ExternalOpenBudget()
        XCTAssertEqual(budget.decide(now: 100), .allow)
        // 时间回拨（单调钟不可得时的极端情形）：不崩、不放行超限
        XCTAssertEqual(budget.decide(now: 99), .allow)
    }
}
