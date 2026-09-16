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

    // MARK: - retireNotifications（S8：登记表 → 已投递 identifier 清除）

    func testRetireNotificationsDecodesSourceIds() {
        XCTAssertEqual(MainWindowController.decodeNotify(
            event: "retireNotifications",
            payload: .object(["sourceIds": .array([.string("local"), .string("ssh-web-1")])])),
            .retireNotifications(sourceIds: ["local", "ssh-web-1"]))
        XCTAssertEqual(MainWindowController.decodeNotify(
            event: "retireNotifications",
            payload: .object(["sourceIds": .array([])])),
            .retireNotifications(sourceIds: []),
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

    // MARK: - NotificationDeliveryRegistry（S8：有界 sourceId→identifier 登记表）

    func testRegistryRetiresOnlyRequestedSources() {
        let registry = NotificationDeliveryRegistry()
        _ = registry.beginDelivery(sourceId: "local", identifier: "chamber-edge-1")
        _ = registry.beginDelivery(sourceId: "local", identifier: "chamber-edge-2")
        _ = registry.beginDelivery(sourceId: "ssh-web-1", identifier: "chamber-edge-3")
        XCTAssertEqual(registry.trackedCount, 3)
        XCTAssertEqual(registry.sourceCount, 2)
        XCTAssertFalse(registry.finishDelivery(sourceId: "local", identifier: "chamber-edge-1", delivered: true),
                       "未被退役的投递完成不需要立即清除")
        // 未登记来源幂等跳过；请求来源的全部 identifier 按 FIFO 返回并从表移除。
        XCTAssertEqual(registry.retire(sourceIds: ["ssh-web-1", "unknown"]), ["chamber-edge-3"])
        XCTAssertEqual(registry.retire(sourceIds: ["ssh-web-1"]), [])
        XCTAssertEqual(registry.retire(sourceIds: ["local"]), ["chamber-edge-1", "chamber-edge-2"])
        XCTAssertEqual(registry.trackedCount, 0)
        XCTAssertEqual(registry.sourceCount, 0)
    }

    /// S8：sourceId 缺省/null（unknown-source）仍投递但不登记——无法归属退役集。
    func testRegistryIgnoresUnknownSourceAndDuplicateIdentifier() {
        let registry = NotificationDeliveryRegistry()
        XCTAssertFalse(registry.beginDelivery(sourceId: nil, identifier: "chamber-edge-1"))
        XCTAssertFalse(registry.beginDelivery(sourceId: "", identifier: "chamber-edge-2"))
        _ = registry.beginDelivery(sourceId: "local", identifier: "chamber-edge-3")
        _ = registry.beginDelivery(sourceId: "local", identifier: "chamber-edge-3")
        XCTAssertEqual(registry.trackedCount, 1, "unknown-source 不登记；同 identifier 幂等")
        XCTAssertEqual(registry.retire(sourceIds: ["local"]), ["chamber-edge-3"])
    }

    /// 2026-12 验证轮：退役与投递之间没有原子点——调度前登记 + 投递完成回执
    /// 必须覆盖「add 完成前就被退役」的窗口，否则该来源的横幅永远留在通知中心。
    func testRegistryCoversRetireRacingInFlightDelivery() {
        let registry = NotificationDeliveryRegistry()
        XCTAssertTrue(registry.beginDelivery(sourceId: "local", identifier: "chamber-edge-9"))
        // 退役端在 add 完成前到达：必须能拿到在途 identifier。
        XCTAssertEqual(registry.retire(sourceIds: ["local"]), ["chamber-edge-9"])
        // 投递随后完成：必须返回 true，调用方据此立即 removeDeliveredNotifications。
        XCTAssertTrue(registry.finishDelivery(sourceId: "local", identifier: "chamber-edge-9", delivered: true))
        XCTAssertFalse(registry.finishDelivery(sourceId: "local", identifier: "chamber-edge-9", delivered: true),
                       "同一 identifier 的退役记忆只报告一次（幂等收口）")
        // 投递失败路径：撤下登记，退役端此后取不到它（没有可清横幅）。
        XCTAssertTrue(registry.beginDelivery(sourceId: "local", identifier: "chamber-edge-10"))
        XCTAssertFalse(registry.finishDelivery(sourceId: "local", identifier: "chamber-edge-10", delivered: false))
        XCTAssertEqual(registry.retire(sourceIds: ["local"]), [])
        // 退役记忆有界（FIFO），不得无界增长。
        for index in 0..<(NotificationDeliveryRegistry.maxRetiredIdentifiers + 4) {
            let source = "s\(index)"
            _ = registry.beginDelivery(sourceId: source, identifier: "chamber-edge-x\(index)")
            _ = registry.retire(sourceIds: [source])
        }
        XCTAssertFalse(registry.wasRetiredDuringDelivery(sourceId: "local", identifier: "chamber-edge-9"),
                       "退役记忆必须按 FIFO 有界淘汰")
        // 已完成投递不进入退役记忆：identifier 跨 sidecar 重启会重用
        // （node-edges 的 nextNotificationId 每进程重置为 1），若把已完成的
        // 退役也记住，重用 identifier 的新横幅会在落地后被立即误删
        // （2026-12 第二轮验证缺陷）。
        let reused = NotificationDeliveryRegistry()
        XCTAssertTrue(reused.beginDelivery(sourceId: "local", identifier: "chamber-edge-1"))
        XCTAssertFalse(reused.finishDelivery(sourceId: "local", identifier: "chamber-edge-1", delivered: true))
        XCTAssertEqual(reused.retire(sourceIds: ["local"]), ["chamber-edge-1"])
        XCTAssertTrue(reused.beginDelivery(sourceId: "local", identifier: "chamber-edge-1"))
        XCTAssertFalse(reused.finishDelivery(sourceId: "local", identifier: "chamber-edge-1", delivered: true),
                       "重用 identifier 的新投递不得因上一次（已完成的）退役而被立即清除")
    }

    /// S14：登记表有界（满员按插入序淘汰最旧）。
    func testRegistryIsBounded() {
        let registry = NotificationDeliveryRegistry()
        let capacity = NotificationDeliveryRegistry.maxTrackedDeliveries
        for index in 0..<(capacity + 2) {
            _ = registry.beginDelivery(sourceId: "local", identifier: "chamber-edge-\(index)")
        }
        XCTAssertEqual(registry.trackedCount, capacity)
        // 最旧两条已被淘汰：退役只能取回仍在窗口内的 identifier。
        XCTAssertEqual(registry.retire(sourceIds: ["local"]),
                       (2..<(capacity + 2)).map { "chamber-edge-\($0)" })
    }


    /// 2026-12 第三轮验证：插入序必须按 (sourceId, identifier) 成对删除。只按
    /// identifier 删时，跨来源重用 identifier（sidecar 重启后计数重置）会误删
    /// 别来源仍在册的槽位——16 条上限名存实亡。
    func testRegistryRetireEvictsOnlyItsOwnInsertionSlots() {
        let registry = NotificationDeliveryRegistry()
        XCTAssertTrue(registry.beginDelivery(sourceId: "A", identifier: "chamber-edge-1"))
        XCTAssertTrue(registry.beginDelivery(sourceId: "B", identifier: "chamber-edge-1"))
        XCTAssertEqual(registry.retire(sourceIds: ["A"]), ["chamber-edge-1"])
        XCTAssertEqual(registry.trackedCount, 1, "只应删掉 A 自己的插入序槽位")
        XCTAssertEqual(registry.sourceCount, 1, "B 仍应在册")
        XCTAssertEqual(registry.retire(sourceIds: ["B"]), ["chamber-edge-1"])
        XCTAssertEqual(registry.trackedCount, 0)
    }

    /// 2026-12 第三/四轮验证：投递标识 = chamber-edge-<纪年>-<壳内单调序号>-
    /// <sidecar notificationId>。序号不随 sidecar 重启重置，因此重启前后的横幅
    /// 在通知中心绝不同名；**末段恒为 sidecar 的 notificationId**，click 回灌按
    /// 末段解析（第四轮验证的回归：按首段解析会把纪年当 id）。
    func testNotificationDispatchIdentifierIsEpochAndSequenceScoped() {
        let dispatch = NotificationDispatch.decode(.object([
            "notificationId": .number(1), "spec": .object([:]),
        ]))
        guard let dispatch else { return XCTFail("载荷必须能解码") }
        let first = dispatch.identifier(sequence: 1)
        let second = dispatch.identifier(sequence: 2)
        XCTAssertNotEqual(first, second, "壳内序号必须进标识（sidecar 重启后计数重置）")
        XCTAssertTrue(first.hasPrefix("chamber-edge-"))
        XCTAssertEqual(first.split(separator: ".").last, "1", "末段必须是 sidecar 的 notificationId")
        XCTAssertEqual(Int(first.split(separator: ".").last ?? ""), 1, "click 回灌按 . 末段解析")
        XCTAssertNotEqual(Int(first.split(separator: ".").first ?? ""), 1,
                          "首段是纪年，绝不能当 notificationId 用（第四轮验证回归）")
        // 同一 (纪年, 序号) 稳定可复现（诊断/退役登记依赖同一拼写）。
        XCTAssertEqual(dispatch.identifier(sequence: 1), first)
    }

    // MARK: - NotificationDispatch（S8：载荷解析 + sourceId/silent）

    func testNotificationDispatchDecodesSourceIdAndSilent() {
        XCTAssertEqual(NotificationDispatch.decode(.object([
            "notificationId": .number(7),
            "sourceId": .string("local"),
            "spec": .object(["title": .string("T"), "body": .string("B"), "silent": .bool(true)]),
        ])), NotificationDispatch(notificationId: 7, sourceId: "local",
                                   title: "T", body: "B", silent: true))
        XCTAssertEqual(NotificationDispatch.decode(.object([
            "notificationId": .number(8),
            "spec": .object(["message": .string("M")]),
        ])), NotificationDispatch(notificationId: 8, sourceId: nil,
                                   title: "", body: "M", silent: false),
        "缺 sourceId/silent → unknown-source + 默认声音")
        // 显式 null sourceId 同样按 unknown-source。
        XCTAssertNil(NotificationDispatch.decode(.object([
            "notificationId": .number(9), "sourceId": .null, "spec": .object([:]),
        ]))?.sourceId)
        // notificationId 缺省沿用既有容错（-1，identifier 仍有稳定形状）；identifier
        // 为 chamber-edge-<纪年>-<壳内序号>-<notificationId>，只固定前缀与末段。
        let fallbackIdentifier = NotificationDispatch.decode(.object(["spec": .object([:])]))?
            .identifier(sequence: 1)
        XCTAssertTrue(fallbackIdentifier?.hasPrefix("chamber-edge-") == true)
        // 分隔符用 '.'：负值（-1 容错）在 '-' 分隔下会被拆成正数 1。
        XCTAssertEqual(fallbackIdentifier?.split(separator: ".").last, "-1",
                       "缺省 notificationId 容错 -1 必须完整保留在 identifier 末段")
        XCTAssertEqual(Int(fallbackIdentifier?.split(separator: ".").last ?? ""), -1,
                       "click 回灌必须解析出 -1（而不是被 '-' 拆成正数）")
        XCTAssertNil(NotificationDispatch.decode(nil), "顶层非对象 → nil（调用方 loud 拒绝）")
        XCTAssertNil(NotificationDispatch.decode(.string("nope")))
    }
}
