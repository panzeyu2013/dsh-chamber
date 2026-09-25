//
//  RecoveryChoicesTests.swift
//  DSHChamberTests
//
//  恢复框的选项集（C4 启动与修复）：锁冲突两选（退出/重启），其余致命三选
//  （退出/重启/安全模式重启）；两选的安全项 = 重启，三选 = 第三键。
//
import XCTest
@testable import DSHChamber

final class RecoveryChoicesTests: XCTestCase {
    func testTwoWayAlertHasTwoButtonsAndRestartIsTheSafeItem() {
        let alert = AppDelegate.makeStartupRecoveryAlert(message: "m", choices: .twoWay)
        XCTAssertEqual(alert.buttons.count, 2)
        XCTAssertEqual(alert.buttons[1].keyEquivalent, "\r", "两选的安全项 = 重启（默认高亮与 Esc 都落它）")
        XCTAssertEqual(alert.buttons[0].keyEquivalent, "", "首个按钮绝不持默认键（AppKit 会自动挂 \\r，必须显式清掉）")
    }

    func testThreeWayAlertIsUnchanged() {
        let alert = AppDelegate.makeStartupRecoveryAlert(message: "m")
        XCTAssertEqual(alert.buttons.count, 3)
        XCTAssertEqual(alert.buttons[AppDelegate.recoverySafeButtonIndex].keyEquivalent, "\r")
        XCTAssertEqual(alert.buttons[0].keyEquivalent, "")
        XCTAssertEqual(alert.buttons[1].keyEquivalent, "")
    }

    func testTwoWayResponseMappingLandsOnTheSafeItem() {
        XCTAssertEqual(AppDelegate.startupRecoveryAction(for: .alertFirstButtonReturn, choices: .twoWay), .exit)
        XCTAssertEqual(AppDelegate.startupRecoveryAction(for: .alertSecondButtonReturn, choices: .twoWay), .restart)
        XCTAssertEqual(AppDelegate.startupRecoveryAction(for: .abort, choices: .twoWay), .restart)
        XCTAssertEqual(AppDelegate.startupRecoveryAction(for: .cancel, choices: .twoWay), .restart)
    }

    func testLockConflictSiteUsesTwoWay() throws {
        let source = try Self.appDelegateSource()
        XCTAssertTrue(source.contains("lockError == nil ? .threeWay : .twoWay"),
                      "锁冲突必须走两选（安全模式重启救不了锁冲突）")
    }

    func testSafeResponseDerivesFromButtonCount() {
        let three = AppDelegate.makeStartupRecoveryAlert(message: "m")
        let two = AppDelegate.makeStartupRecoveryAlert(message: "m", choices: .twoWay)
        XCTAssertTrue(three.buttons.count >= 3)
        XCTAssertEqual(two.buttons.count, 2)
        XCTAssertEqual(AppDelegate.recoverySafeButtonIndex, 2, "三选的安全项下标恒为 2（末位）")
    }

    static func appDelegateSource() throws -> String {
        try Self.source(named: "AppDelegate.swift")
    }

    static func source(named name: String) throws -> String {
        let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let url = here.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/DSHChamber/").appendingPathComponent(name)
        return try String(contentsOf: url, encoding: .utf8)
    }
}