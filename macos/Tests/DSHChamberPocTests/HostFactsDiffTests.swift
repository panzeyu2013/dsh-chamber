//
//  HostFactsDiffTests.swift
//  DSHChamberPocTests
//
//  S-A：MainWindowController.hostFactsDiff 纯逻辑单测（无 GUI——窗口/导航
//  事实推送的接线属实机路径）。断言：hostFacts 事实变化序列仅在键值实际
//  变化时产出推送载荷（幂等去重），且簿记合并 = 已推送（含意图）∪ 变化。
//
import XCTest
@testable import DSHChamberPoc

final class HostFactsDiffTests: XCTestCase {

    /// 模拟调用方（与 pushHostFacts 同款簿记循环）：去重判定 + 空载荷跳过。
    private func feed(_ changes: [String: Bool], last: inout [String: Bool],
                      pushes: inout [[String: Bool]]) {
        let (payload, merged) = MainWindowController.hostFactsDiff(last: last,
                                                                   changes: changes)
        last = merged
        if !payload.isEmpty { pushes.append(payload) }
    }

    func testFirstPushCarriesAllChangedKeys() {
        // last 为空：任何键都是异值（首推必推），payload = changes 全集。
        let (payload, merged) = MainWindowController.hostFactsDiff(
            last: [:],
            changes: ["webViewLoading": true]
        )
        XCTAssertEqual(payload, ["webViewLoading": true])
        XCTAssertEqual(merged, ["webViewLoading": true])
    }

    func testIdenticalRepeatYieldsNoPayload() {
        // 同键同值重复（如窗口反复成为 key / 重复 resign）：payload 为空 =
        // 无需推送；簿记不变。
        var last = ["focused": true]
        let (payload, merged) = MainWindowController.hostFactsDiff(
            last: last,
            changes: ["focused": true]
        )
        XCTAssertTrue(payload.isEmpty)
        XCTAssertEqual(merged, last)
    }

    func testOnlyChangedKeysLandInPayload() {
        // 混合载荷：与 last 同值的键不进 payload（不重复推送），异值键进。
        let last = ["focused": true, "webViewLoading": false]
        let (payload, merged) = MainWindowController.hostFactsDiff(
            last: last,
            changes: ["focused": true, "webViewLoading": true]
        )
        XCTAssertEqual(payload, ["webViewLoading": true])
        XCTAssertEqual(merged, ["focused": true, "webViewLoading": true])
    }

    func testAbsentKeyCountsAsChangeAndIsBookkept() {
        // last 缺键 = 异值：进 payload 且并入 merged（簿记增长，后续同值
        // 事件即被去重）。
        let last = ["focused": true]
        let (payload, merged) = MainWindowController.hostFactsDiff(
            last: last,
            changes: ["focused": true, "webViewLoading": true]
        )
        XCTAssertEqual(payload, ["webViewLoading": true])
        XCTAssertEqual(merged, ["focused": true, "webViewLoading": true])
    }

    func testRealisticLifecycleSequencePushesOnlyOnChange() {
        // 真实事件序列（S-A 推送事件表：启动 → becomeKey → 导航开始 →
        // 加载完成 → 渲染进程终止 → 恢复完成 → resignKey → 关窗 → Dock
        // 重开 becomeKey）：断言仅键值实际变化时推送，且各次载荷正确。
        var last: [String: Bool] = [:]
        var pushes: [[String: Bool]] = []

        // 启动（创建后）：alive 事实首推
        feed(["mainWindowAlive": true, "webViewContentAlive": true],
             last: &last, pushes: &pushes)
        // 窗口成为 key：mainWindowAlive 未变 → 仅 focused 新推
        feed(["mainWindowAlive": true, "focused": true],
             last: &last, pushes: &pushes)
        // 重复 becomeKey（同值）：不推
        feed(["mainWindowAlive": true, "focused": true],
             last: &last, pushes: &pushes)
        // 导航开始
        feed(["webViewLoading": true], last: &last, pushes: &pushes)
        // 加载完成（webViewContentAlive 未变 → 只推 loading:false）
        feed(["webViewLoading": false, "webViewContentAlive": true],
             last: &last, pushes: &pushes)
        // 渲染进程终止
        feed(["webViewContentAlive": false], last: &last, pushes: &pushes)
        // 恢复导航完成（loading:false 未变 → 只推 alive:true）
        feed(["webViewLoading": false, "webViewContentAlive": true],
             last: &last, pushes: &pushes)
        // 窗口失去 key
        feed(["focused": false], last: &last, pushes: &pushes)
        // 重复 resignKey（同值）：不推
        feed(["focused": false], last: &last, pushes: &pushes)
        // 关窗
        feed(["mainWindowAlive": false], last: &last, pushes: &pushes)
        // Dock 重开 becomeKey（alive 回 true + focused）
        feed(["mainWindowAlive": true, "focused": true],
             last: &last, pushes: &pushes)

        XCTAssertEqual(pushes.count, 9, "序列应恰推送 9 次（11 事件，2 次同值重复被去重）")
        XCTAssertEqual(pushes[0], ["mainWindowAlive": true, "webViewContentAlive": true])
        XCTAssertEqual(pushes[1], ["focused": true])
        XCTAssertEqual(pushes[2], ["webViewLoading": true])
        XCTAssertEqual(pushes[3], ["webViewLoading": false])
        XCTAssertEqual(pushes[4], ["webViewContentAlive": false])
        XCTAssertEqual(pushes[5], ["webViewContentAlive": true])
        XCTAssertEqual(pushes[6], ["focused": false])
        XCTAssertEqual(pushes[7], ["mainWindowAlive": false])
        XCTAssertEqual(pushes[8], ["mainWindowAlive": true, "focused": true])
        // 簿记收敛：末态 = 真实世界状态（窗口可用、可见聚焦、内容存活、
        // 无加载在途）
        XCTAssertEqual(last, [
            "mainWindowAlive": true,
            "webViewContentAlive": true,
            "focused": true,
            "webViewLoading": false,
        ])
    }

    func testFailedPushIntentKeepsLaterConvergence() {
        // 意图簿记语义：即使某次推送失败（不重试不回滚），随后同值事件被
        // 去重（不重复轰炸 sidecar）；值再次变化时照常推送收敛。
        var last: [String: Bool] = [:]
        var pushes: [[String: Bool]] = []
        feed(["focused": true], last: &last, pushes: &pushes)   // 假想失败
        feed(["focused": true], last: &last, pushes: &pushes)   // 同值：去重
        feed(["focused": false], last: &last, pushes: &pushes)  // 异值：再推
        XCTAssertEqual(pushes.count, 2)
        XCTAssertEqual(pushes[0], ["focused": true])
        XCTAssertEqual(pushes[1], ["focused": false])
        XCTAssertEqual(last, ["focused": false])
    }
}
