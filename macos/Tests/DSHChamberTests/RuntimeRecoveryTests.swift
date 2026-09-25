//
//  RuntimeRecoveryTests.swift
//  DSHChamberTests
//
//  运行期 fatal（sidecar 异常）与启动期共用同一套三选：呈现阶段只改标题/呈现方式，
//  按钮序、按键纪律、响应映射、重启腿判据全部同源。
//
import XCTest
@testable import DSHChamber

final class RuntimeRecoveryTests: XCTestCase {
    func testRuntimeAlertKeepsTheStartupLayoutAndSafeDefault() {
        let startupAlert = AppDelegate.makeStartupRecoveryAlert(message: "m", phase: .startup)
        let runtimeAlert = AppDelegate.makeStartupRecoveryAlert(message: "m", phase: .runtime)
        XCTAssertEqual(startupAlert.buttons.count, runtimeAlert.buttons.count)
        XCTAssertEqual(runtimeAlert.buttons[AppDelegate.recoverySafeButtonIndex].keyEquivalent, "\r")
        XCTAssertNotEqual(startupAlert.messageText, "", "标题绝不能为空")
        XCTAssertNotEqual(runtimeAlert.messageText, "", "标题绝不能为空")
    }

    func testRuntimeDecisionReusesTheStartupResponseMapping() {
        for response: NSApplication.ModalResponse in [.alertFirstButtonReturn, .alertSecondButtonReturn,
                                                      .alertThirdButtonReturn, .abort, .cancel, .stop] {
            XCTAssertEqual(AppDelegate.startupRecoveryAction(for: response),
                           AppDelegate.startupRecoveryAction(for: response, choices: .threeWay))
        }
    }

    func testBothPhasesShareOneThreeChoiceImplementation() throws {
        let source = try RecoveryChoicesTests.appDelegateSource()
        // 唯一实现住在扩展文件（AppDelegate+StartupRecovery.swift），本文件只应有
        // 启动期与运行期两个接线点——绝不复制第二套。
        let occurrences = source.components(separatedBy: "runThreeChoiceRecovery(").count - 1
        XCTAssertEqual(occurrences, 2, "AppDelegate.swift 只保留两个接线点（启动期 + 运行期）")
        XCTAssertTrue(source.contains("Self.runThreeChoiceRecovery(message: message, phase: .startup, choices: choices)"))
        XCTAssertTrue(source.contains("Self.runThreeChoiceRecovery(message: message, phase: .runtime)"))
    }

    func testEveryAsyncFatalEntryClaimsThePresentationGate() throws {
        let source = try RecoveryChoicesTests.appDelegateSource()
        XCTAssertTrue(source.contains("Self.enterRecoveryPresentation(message: message)"),
                      "同步入口经 enterRecoveryPresentation")
    }

    func testGateStaysClaimedAfterThePresenterReturns() {
        let gate = AppDelegate.RecoveryPresentationGate()
        XCTAssertTrue(AppDelegate.enterRecoveryPresentation(message: "a", gate: gate, log: { _ in }, present: {}))
        var presented = 0
        XCTAssertFalse(AppDelegate.enterRecoveryPresentation(message: "b", gate: gate, log: { _ in }, present: { presented += 1 }))
        XCTAssertEqual(presented, 0, "呈现者返回后门不松开：同一 fatal 只呈现一次")
    }

    func testRecoveryPhaseOnlyChangesTheTitle() {
        XCTAssertNotEqual(AppDelegate.RecoveryPhase.startup.titleText,
                          AppDelegate.RecoveryPhase.runtime.titleText)
        XCTAssertEqual(AppDelegate.RecoveryPhase.startup.logLabel, "启动")
        XCTAssertEqual(AppDelegate.RecoveryPhase.runtime.logLabel, "运行期")
    }

    func testCrossLanguageSafeModeLiteralIsShared() throws {
        let swift = try RecoveryChoicesTests.source(named: "AppDelegate+StartupRecovery.swift")
        XCTAssertTrue(swift.contains("DSH_CHAMBER_SAFE_MODE"),
                      "Swift 壳必须与 TS 侧 SAFE_MODE_ENV、控制面 safe-mode.ts 同一字面量")
    }
}