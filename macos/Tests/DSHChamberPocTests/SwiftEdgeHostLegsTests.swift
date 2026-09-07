//
//  SwiftEdgeHostLegsTests.swift
//  DSHChamberPocTests
//
//  W-19/20：SwiftEdgeHostLegs 纯逻辑单测（无 GUI 分支——GUI 腿属 M3 集成
//  + 实机硬门禁，见 SwiftEdgeHostLegs.swift 各腿 TODO 注释）。
//
import XCTest
@testable import DSHChamberPoc

final class SwiftEdgeHostLegsTests: XCTestCase {
    func testUnknownMethodReportsUnimplemented() {
        let legs = SwiftEdgeHostLegs()
        let outcome = legs.respond(method: "zzz.unknown", payload: nil)
        XCTAssertNil(outcome.result)
        XCTAssertEqual(outcome.error, "swift-edge-unimplemented:zzz.unknown")
    }

    func testHeadlessUIAvailableLegsDegradeHonestly() {
        // canShowUI=false：UI 腿一律 ui-unavailable（绝不静默假装成功）。
        let legs = SwiftEdgeHostLegs(config: .init(canShowUI: { false }))
        for method in ["focusMainWindow", "showMessage", "openExternal", "openPath"] {
            let outcome = legs.respond(method: method, payload: nil)
            XCTAssertNotNil(outcome.error, method)
            XCTAssertTrue(
                outcome.error?.hasPrefix(SwiftEdgeHostLegs.uiUnavailablePrefix) ?? false,
                "\(method) 应报 ui-unavailable（实际 \(outcome.error ?? "nil")）"
            )
        }
    }

    func testNotYetImplementedLegsReportUnimplemented() {
        let legs = SwiftEdgeHostLegs(config: .init(canShowUI: { true }))
        for method in [
            "setLoginItem", "showError", "launchApp", "retireNotifications",
        ] {
            let outcome = legs.respond(method: method, payload: nil)
            XCTAssertEqual(outcome.error, "swift-edge-unimplemented:\(method)")
        }
        // showNativeNotification 的同步路径只服务 UI 不可用降级；UI 可用时真实
        // 调度走 respondAsync（canHandleAsync）——同步面显式指引。
        let asyncOnly = legs.respond(method: "showNativeNotification", payload: nil)
        XCTAssertEqual(
            asyncOnly.error,
            "swift-edge-unimplemented:showNativeNotification:use-async-leg"
        )
    }

    func testWindowGuardedLegsRequireMainWindow() {
        // canShowUI=true 但未接主窗：窗口守卫腿一律 no-window 诚实降级
        // （headless 测试绝不触发 NSWorkspace/NSApp/ProcessInfo 副作用）。
        let legs = SwiftEdgeHostLegs(config: .init(canShowUI: { true }))
        for method in ["setBadge", "setKeepAwake", "showItemInFolder", "pickPluginSource"] {
            let outcome = legs.respond(method: method, payload: nil)
            XCTAssertTrue(
                outcome.error?.hasPrefix(SwiftEdgeHostLegs.uiUnavailablePrefix) ?? false,
                "\(method) 应报 ui-unavailable（实际 \(outcome.error ?? "nil")）"
            )
            XCTAssertTrue(outcome.error?.contains("no-window") ?? false, method)
        }
    }

    func testNotificationSyncPathDegradesWhenUIUnavailable() {
        let legs = SwiftEdgeHostLegs(config: .init(canShowUI: { false }))
        let outcome = legs.respond(method: "showNativeNotification", payload: nil)
        XCTAssertTrue(
            outcome.error?.hasPrefix(SwiftEdgeHostLegs.uiUnavailablePrefix) ?? false,
            "UI 不可用时通知腿必须诚实降级（实际 \(outcome.error ?? "nil")）"
        )
        XCTAssertFalse(legs.canHandleAsync(method: "showNativeNotification"))
    }

    func testOpenExternalExtractsURLAndFailsWithoutPayload() throws {
        let legs = SwiftEdgeHostLegs(config: .init(canShowUI: { true }))
        // 无窗口提供者 → no-window 诚实错误（不真正 open——headless 测试不得
        // 触发 NSWorkspace 副作用）。
        let bad = legs.respond(method: "openExternal", payload: .object(["url": .string("https://example.com")]))
        XCTAssertTrue(bad.error?.contains("no-window") ?? false)
        // 载荷缺 url → 提取失败回落 unimplemented 文案前缀（BridgeClient 会
        // 继续回落默认表——不挂起）。
        let malformed = legs.respond(method: "openExternal", payload: nil)
        XCTAssertTrue(malformed.error?.hasPrefix(SwiftEdgeHostLegs.unimplementedPrefix) ?? false)
        XCTAssertTrue(legs.respond(method: "openExternal", payload: .object([:])).error != nil)
    }

    func testPendingAlertQueuePureLogic() {
        let queue = PendingAlertQueue()
        let token = queue.expect()
        XCTAssertNil(queue.takeResult(token: token), "未完成前取结果应为 nil")
        queue.complete(token: token, buttonIndex: 1)
        XCTAssertEqual(queue.takeResult(token: token), 1)
        XCTAssertNil(queue.takeResult(token: token), "取出后应为 nil")
        queue.complete(token: token, buttonIndex: 2)  // 幂等 no-op
        XCTAssertNil(queue.takeResult(token: token))
    }

    func testShowMessageHeadlessDegradesAndUIQueueCancelFallback() {
        // canShowUI=true 但无宿主消费：立即以 cancelId（默认 0）结算并登记
        // pending（M3 接线点注释语义）。
        let legs = SwiftEdgeHostLegs(config: .init(canShowUI: { true }))
        let outcome = legs.respond(method: "showMessage", payload: nil)
        XCTAssertEqual(outcome.result, .number(0))
        XCTAssertNil(outcome.error)
    }
}
