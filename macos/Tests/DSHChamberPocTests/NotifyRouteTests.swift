//
//  NotifyRouteTests.swift
//  DSHChamberPocTests
//
//  S-D：sidecar 出站 notify 消费路由的纯逻辑单测（MainWindowController.
//  decodeNotify —— 只测解码/分发决策，不触 AppKit/UI；宿主腿执行与 GUI 侧
//  消费属实机门禁）。载荷形状断言以 node-edges.ts sendNotify 出站族与
//  BridgeClientEdgeIntegrationTests 的 notify 载荷断言为权威。
//
import XCTest
@testable import DSHChamberPoc

final class NotifyRouteTests: XCTestCase {

    // MARK: - rendererPush 解包（形状 + 原样透传）

    func testRendererPushUnwrapsChannelAndPayload() {
        let inner = AnyCodable.object(["settings": .object(["quitConfirmation": .bool(false)])])
        let decision = MainWindowController.decodeNotify(
            event: "rendererPush",
            payload: .object(["channel": .string("dsh-chamber:settings-changed"),
                              "payload": inner])
        )
        XCTAssertEqual(decision,
                       .emitToPage(channel: "dsh-chamber:settings-changed", payload: inner),
                       "rendererPush 应解包为 (channel, payload) 原样透传")
    }

    func testRendererPushScalarInnerPayloadIsTransparent() {
        // payload 可为任意 JSON 值（node-edges jsonSafe 后仍可为标量）——原样。
        let decision = MainWindowController.decodeNotify(
            event: "rendererPush",
            payload: .object(["channel": .string("dsh-chamber:system-resume"),
                              "payload": .number(1234.0)])
        )
        XCTAssertEqual(decision,
                       .emitToPage(channel: "dsh-chamber:system-resume",
                                   payload: .number(1234.0)))
    }

    func testRendererPushPayloadKeyMissingMeansNullEmit() {
        let decision = MainWindowController.decodeNotify(
            event: "rendererPush",
            payload: .object(["channel": .string("dsh-chamber:settings-changed")])
        )
        XCTAssertEqual(decision,
                       .emitToPage(channel: "dsh-chamber:settings-changed", payload: nil),
                       "payload 键缺省 → emit null（不拒绝）")
    }

    func testRendererPushRejectsMalformedShapes() {
        // 非对象顶层 / 缺 channel / channel 非字符串 / 空 channel → loud 丢弃。
        let cases: [(String, AnyCodable?)] = [
            ("rendererPush", nil),
            ("rendererPush", .string("裸字符串")),
            ("rendererPush", .object(["payload": .bool(true)])),
            ("rendererPush", .object(["channel": .number(7.0), "payload": .null])),
            ("rendererPush", .object(["channel": .string("")])),
        ]
        for (event, payload) in cases {
            let decision = MainWindowController.decodeNotify(event: event, payload: payload)
            guard case .malformed = decision else {
                XCTFail("应拒绝 malformed（event=\(event) payload=\(String(describing: payload))），实际 \(decision)")
                continue
            }
        }
    }

    // MARK: - setBadge（值域过滤 → 原生腿）

    func testSetBadgeValidCountsRouteToHostLeg() {
        for count: Double in [0, 1, 9999] {
            let payload = AnyCodable.object(["count": .number(count)])
            XCTAssertEqual(MainWindowController.decodeNotify(event: "setBadge", payload: payload),
                           .hostLeg(method: "setBadge", payload: payload),
                           "非负整 count 应走宿主腿（count=\(count)）")
        }
    }

    func testSetBadgeRejectsInvalidCounts() {
        let cases: [AnyCodable?] = [
            nil,
            .object([:]),
            .object(["count": .number(-1)]),
            .object(["count": .number(3.5)]),
            .object(["count": .string("3")]),
            .object(["count": .bool(true)]),
            .object(["count": .null]),
        ]
        for payload in cases {
            let decision = MainWindowController.decodeNotify(event: "setBadge", payload: payload)
            guard case .malformed = decision else {
                XCTFail("setBadge 非法 count 应 malformed（payload=\(String(describing: payload))），实际 \(decision)")
                continue
            }
        }
    }

    // MARK: - showItemInFolder（形状 → 原生腿）

    func testShowItemInFolderRoutesValidPath() {
        let payload = AnyCodable.object(["path": .string("/Users/x/proj/notes.md")])
        XCTAssertEqual(MainWindowController.decodeNotify(event: "showItemInFolder", payload: payload),
                       .hostLeg(method: "showItemInFolder", payload: payload))
    }

    func testShowItemInFolderRejectsMalformed() {
        let cases: [AnyCodable?] = [
            nil,
            .object([:]),                                          // 缺 path
            .object(["path": .string("")]),                        // 空 path
            .object(["path": .number(7.0)]),                       // 非字符串
            .object(["path": .null]),
        ]
        for payload in cases {
            let decision = MainWindowController.decodeNotify(event: "showItemInFolder", payload: payload)
            guard case .malformed = decision else {
                XCTFail("showItemInFolder 非法载荷应 malformed（payload=\(String(describing: payload))），实际 \(decision)")
                continue
            }
        }
    }

    // MARK: - retireNotifications（POC 无登记表 → 诚实 no-op 决策）

    func testRetireNotificationsNoopDecision() {
        XCTAssertEqual(MainWindowController.decodeNotify(
            event: "retireNotifications",
            payload: .object(["sourceIds": .array([.string("local"), .string("ssh-web-1")])])),
            .retireNoop(sourceIdCount: 2))
        XCTAssertEqual(MainWindowController.decodeNotify(
            event: "retireNotifications",
            payload: .object(["sourceIds": .array([])])),
            .retireNoop(sourceIdCount: 0),
            "空 sourceIds 合法（退役空集 = no-op）")
    }

    func testRetireNotificationsRejectsMalformed() {
        let cases: [AnyCodable?] = [
            nil,
            .object([:]),                                            // 缺 sourceIds
            .object(["sourceIds": .string("local")]),                // 非数组
            .object(["sourceIds": .array([.number(1.0)])]),          // 非字符串元素
            .object(["sourceIds": .array([.string("local"), .null])]),
        ]
        for payload in cases {
            let decision = MainWindowController.decodeNotify(event: "retireNotifications", payload: payload)
            guard case .malformed = decision else {
                XCTFail("retireNotifications 非法载荷应 malformed（payload=\(String(describing: payload))），实际 \(decision)")
                continue
            }
        }
    }

    // MARK: - notifyClicked / 未知事件

    func testNotifyClickedIsUnexpected() {
        XCTAssertEqual(MainWindowController.decodeNotify(event: "notifyClicked", payload: nil),
                       .unexpectedClick,
                       "notifyClicked 正常经 __host.notifyClicked 请求路径，经 notify 出现 → 不处理")
    }

    func testUnknownEventIsMalformed() {
        for event in ["zzz.unknown", "rendererpush", "setBadge ", ""] {
            let decision = MainWindowController.decodeNotify(event: event, payload: nil)
            guard case .malformed(let reason) = decision else {
                XCTFail("未知/拼写不符事件应 malformed（event=\(event)），实际 \(decision)")
                continue
            }
            XCTAssertTrue(reason.contains(event) || event.isEmpty, "malformed 原因应含事件名（\(reason)）")
        }
    }
}
