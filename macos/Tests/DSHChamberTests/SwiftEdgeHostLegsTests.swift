//
//  SwiftEdgeHostLegsTests.swift
//  DSHChamberTests
//
//  SwiftEdgeHostLegs 纯逻辑单测（无 GUI 分支——GUI 腿属集成
//  + 实机硬门禁，见 SwiftEdgeHostLegs.swift 各腿 TODO 注释）。
//
import XCTest
import UserNotifications
@testable import DSHChamber

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
        for method in ["focusMainWindow", "showMessage", "openExternal", "openPath",
                       "setLoginItem"] {
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
            // edge 面退役腿：node-edges 的退役经 notify 发送（不经 edge）——
            // 消费在 MainWindowController 的 notify 路由（POC 无登记表 → 诚实
            // no-op）；edge 面保持 unimplemented（回落默认表 loud）。
            "retireNotifications",
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
        for method in ["setBadge", "setKeepAwake", "showItemInFolder", "showError", "showMessage"] {
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


    func testShowMessageRequiresMainWindow() {
        // canShowUI=true 但未接主窗：模态 alert 腿诚实降级（绝不无窗弹窗）。
        let legs = SwiftEdgeHostLegs(config: .init(canShowUI: { true }))
        let outcome = legs.respond(method: "showMessage", payload: nil)
        XCTAssertTrue(
            outcome.error?.hasPrefix(SwiftEdgeHostLegs.uiUnavailablePrefix) ?? false,
            "showMessage 无窗必须诚实降级（实际 \(outcome.error ?? "nil")）"
        )
    }

    // MARK: - setLoginItem 守卫（SMAppService 真机调用不在单测范围）

    func testSetLoginItemDegradesWhenUnbundled() {
        // canShowUI=true + isAppBundled=false（swift run dev 态等价）：无 bundle
        // → ui-unavailable:setLoginItem:no-bundle 诚实错误（绝不碰
        // ServiceManagement——SMAppService.mainApp 需 Info.plist 注册）。
        // setLoginItem 无需窗口（Electron setLoginItemSettings 无窗照常）——
        // 未接主窗也应先报 no-bundle。
        let legs = SwiftEdgeHostLegs(config: .init(canShowUI: { true },
                                                   isAppBundled: { false }))
        let outcome = legs.respond(method: "setLoginItem",
                                   payload: .object(["enabled": .bool(true)]))
        XCTAssertEqual(outcome.error,
                       "swift-edge-ui-unavailable:setLoginItem:no-bundle")
        let outcome2 = legs.respond(method: "setLoginItem",
                                    payload: .object(["enabled": .bool(false)]))
        XCTAssertEqual(outcome2.error,
                       "swift-edge-ui-unavailable:setLoginItem:no-bundle",
                       "禁用方向同样无 bundle 守卫（对称诚实）")
    }

    func testSetLoginItemHeadlessAndPayloadShapes() {
        // canShowUI=false → ui-unavailable（performUI 先于 bundle/其它守卫）。
        let headless = SwiftEdgeHostLegs(config: .init(canShowUI: { false },
                                                       isAppBundled: { true }))
        let headlessOutcome = headless.respond(method: "setLoginItem",
                                               payload: .object(["enabled": .bool(true)]))
        XCTAssertEqual(headlessOutcome.error,
                       "swift-edge-ui-unavailable:setLoginItem")
        // enabled 缺省/非布尔 → 按 false（清除方向）处理（EdgePayload.bool
        // 缺省语义，与既有腿一致）；bundle 守卫先拦 —— 此处只验证 no-bundle
        // 不因载荷形状改变而旁路。
        let unbundled = SwiftEdgeHostLegs(config: .init(canShowUI: { true },
                                                        isAppBundled: { false }))
        let payloads: [AnyCodable?] = [nil, .object([:]), .object(["enabled": .string("yes")])]
        for payload in payloads {
            let outcome = unbundled.respond(method: "setLoginItem", payload: payload)
            XCTAssertEqual(outcome.error, "swift-edge-ui-unavailable:setLoginItem:no-bundle")
        }
    }

    // MARK: - launchApp 叶（与 Electron 对称）

    /// Electron 侧从未实现 launchApp（`electron-edges.ts:59`「moves with its first
    /// consumer」），core 也零调用点；Swift 侧同样不实现。未知方法一律诚实回落 unimplemented，两端能力面
    /// 因此一致（本地 open 由实例内 host 包负责，壳只执行 openExternal）。
    func testLaunchAppIsUnimplementedLikeElectron() {
        let legs = SwiftEdgeHostLegs(config: .init(canShowUI: { true }))
        let outcome = legs.respond(method: "launchApp",
                                   payload: .object(["appId": .string("vscode"),
                                                     "path": .string("/tmp")]))
        XCTAssertNil(outcome.result)
        XCTAssertEqual(outcome.error, "swift-edge-unimplemented:launchApp")
    }
    // MARK: - 交互腿异步应答（10 分钟上限、超时弃权、非交互短界保持）

    /// 跨线程单值盒（回执在后台/主线程写，断言线程读）。
    private final class SyncBox<T> {
        private let lock = NSLock()
        private var storage: T?
        func set(_ value: T) {
            lock.lock()
            storage = value
            lock.unlock()
        }
        var value: T? {
            lock.lock()
            defer { lock.unlock() }
            return storage
        }
    }

    /// 主线程泵 RunLoop 直到条件满足或 deadline（body 异步派到主线程时驱动它）。
    private func pumpMainRunLoop(until deadline: Date, condition: () -> Bool) -> Bool {
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return condition()
    }

    /// 交互腿（showMessage）不得在旧 1s 上限处失败：慢 body（1.5s）的结果必须
    /// 在模态完成时交付。调用形态 = 后台线程（BridgeClient 管道读取线程的真实
    /// 形态）→ body 派主线程；不得在 1s 处回 main-thread-busy 并丢弃结果。
    func testInteractiveLegNotFailedAtOneSecondAndDeliversResult() {
        let legs = SwiftEdgeHostLegs(config: .init(
            canShowUI: { true },
            uiLegBodyOverride: { method, _ in
                XCTAssertEqual(method, "showMessage")
                Thread.sleep(forTimeInterval: 1.5)
                return (.number(1), nil)
            }))
        let box = SyncBox<(AnyCodable?, String?, Date)>()
        let start = Date()
        DispatchQueue.global().async {
            legs.respondAsync(method: "showMessage",
                              payload: .object(["message": .string("x")])) { result, error in
                box.set((result, error, Date()))
            }
        }
        XCTAssertTrue(pumpMainRunLoop(until: start.addingTimeInterval(5.0),
                                      condition: { box.value != nil }),
                      "交互腿结果未在 5s 内交付")
        guard let outcome = box.value else { return }
        XCTAssertNil(outcome.1, "不得在 1s 处失败（旧实现回 main-thread-busy，模态结果被丢弃）")
        XCTAssertEqual(outcome.0, .number(1), "模态完成后的结果必须交付")
        XCTAssertGreaterThanOrEqual(outcome.2.timeIntervalSince(start), 1.0,
                                   "结果在慢 body（1.5s）完成时才交付：证明未被 1s 上限截断")
    }

    /// 超时后仍在主队列排队的 body 绝不补执行（无双重执行），回执恰一次。
    func testInteractiveTimeoutNeverExecutesQueuedBodyLater() {
        let box = SyncBox<(AnyCodable?, String?)>()
        var bodyRan = false
        let legs = SwiftEdgeHostLegs(config: .init(
            canShowUI: { true },
            uiLegBodyOverride: { _, _ in
                bodyRan = true
                return (nil, nil)
            }))
        // 主线程刻意不泵 RunLoop：body 保持排队，50ms 后注入超时。
        DispatchQueue.global().async {
            legs.performInteractiveUI(method: "showMessage", payload: nil, timeout: 0.05) { result, error in
                box.set((result, error))
            }
        }
        let deadline = Date().addingTimeInterval(2.0)
        while box.value == nil && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.02)
        }
        XCTAssertEqual(box.value?.1, "swift-edge-ui-unavailable:showMessage:main-thread-busy")
        XCTAssertFalse(bodyRan, "超时回执时 body 尚未执行")
        // 放行主队列：已排定 body 必须见弃权位退出，绝不补执行。
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        XCTAssertFalse(bodyRan, "超时后 body 不得再执行（不得双执行）")
        XCTAssertEqual(box.value?.1, "swift-edge-ui-unavailable:showMessage:main-thread-busy",
                       "超时回执恰一次（body 弃权不覆盖）")
    }

    /// 非交互腿保留 1s 短界（不与交互腿一并拉长）。
    func testNonInteractiveLegKeepsShortBound() {
        let legs = SwiftEdgeHostLegs(config: .init(canShowUI: { true }))
        let box = SyncBox<(AnyCodable?, String?)>()
        var bodyRan = false
        DispatchQueue.global().async {
            let outcome = legs.performUI(method: "setBadge", body: {
                bodyRan = true
                return (nil, nil)
            })
            box.set(outcome)
        }
        // 主线程刻意忙 >1s（阻塞主队列、不泵 RunLoop）→ 1s 有界等待必须超时。
        Thread.sleep(forTimeInterval: 1.3)
        let deadline = Date().addingTimeInterval(2.0)
        while box.value == nil && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.02)
        }
        XCTAssertEqual(box.value?.1, "swift-edge-ui-unavailable:setBadge:main-thread-busy")
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        XCTAssertFalse(bodyRan, "超时后 body 也不得补执行（同一弃权位）")
    }

    /// EdgePayload.int 对非有限/越界值返回 nil，绝不 trap。
    func testEdgePayloadIntDoesNotTrap() {
        XCTAssertEqual(EdgePayload.int(.number(3)), 3)
        XCTAssertEqual(EdgePayload.int(.number(-2)), -2)
        XCTAssertNil(EdgePayload.int(.number(Double.nan)))
        XCTAssertNil(EdgePayload.int(.number(Double.infinity)))
        XCTAssertNil(EdgePayload.int(.number(-Double.infinity)))
        XCTAssertNil(EdgePayload.int(.number(1e30)))
        XCTAssertNil(EdgePayload.int(.string("3")))
        XCTAssertNil(EdgePayload.int(AnyCodable?.none))
    }

    // MARK: - 通知腿的诚实回执（授权先查 + 有界 add + {shown:false,error}）

    /// 测试假体：授权状态/请求/投递全部可控，add 可挂起（验证超时）或立即完成。
    private final class FakeNotificationCenter: EdgeNotificationCenter {
        var status: EdgeNotificationAuthorization = .authorized
        var granted = true
        var requestError: Error?
        var addError: Error?
        /// true = add 立即回调；false = 挂起，由 completePendingAdd 释放。
        var completeAddImmediately = true
        private(set) var addRequests: [UNNotificationRequest] = []
        private(set) var removedIdentifierBatches: [[String]] = []
        private(set) var requestAuthorizationCount = 0
        private var pendingAddCompletion: ((Error?) -> Void)?

        func authorizationStatus(_ completion: @escaping (EdgeNotificationAuthorization) -> Void) {
            completion(status)
        }

        func requestAuthorization(_ completion: @escaping (Bool, Error?) -> Void) {
            requestAuthorizationCount += 1
            completion(granted, requestError)
        }

        func add(_ request: UNNotificationRequest, completion: @escaping (Error?) -> Void) {
            addRequests.append(request)
            if completeAddImmediately {
                completion(addError)
            } else {
                pendingAddCompletion = completion
            }
        }

        func removeDeliveredNotifications(withIdentifiers identifiers: [String]) {
            removedIdentifierBatches.append(identifiers)
        }

        func completePendingAdd(error: Error? = nil) {
            pendingAddCompletion?(error)
            pendingAddCompletion = nil
        }
    }

    private final class ReplyCounter {
        private let lock = NSLock()
        private var count = 0
        func increment() { lock.lock(); count += 1; lock.unlock() }
        var value: Int { lock.lock(); defer { lock.unlock() }; return count }
    }

    private func notificationPayload(notificationId: Int = 1,
                                     sourceId: String? = "local") -> AnyCodable {
        var dict: [String: AnyCodable] = [
            "notificationId": .number(Double(notificationId)),
            "spec": .object(["title": .string("T"), "body": .string("B")]),
        ]
        if let sourceId { dict["sourceId"] = .string(sourceId) }
        return .object(dict)
    }

    /// 投递并等待首个回执（回执可能在任意队列异步到达）。
    @discardableResult
    private func deliverNotification(
        _ legs: SwiftEdgeHostLegs,
        payload: AnyCodable,
        counter: ReplyCounter? = nil
    ) -> (result: AnyCodable?, error: String?) {
        let box = SyncBox<(AnyCodable?, String?)>()
        legs.respondAsync(method: "showNativeNotification", payload: payload) { result, error in
            counter?.increment()
            box.set((result, error))
        }
        let deadline = Date().addingTimeInterval(5.0)
        while box.value == nil && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.01)
        }
        return box.value ?? (nil, "no-reply")
    }

    /// 授权 granted + add 成功 → 显式 {shown:true}（绝不依赖旧协议的 null）。
    func testNotificationAddCompletedRepliesShownTrue() {
        let center = FakeNotificationCenter()
        let legs = SwiftEdgeHostLegs(config: .init(canShowUI: { true },
                                                   notificationCenter: { center }))
        let reply = deliverNotification(legs, payload: notificationPayload())
        XCTAssertEqual(reply.result, .object(["shown": .bool(true)]))
        XCTAssertNil(reply.error)
        XCTAssertEqual(center.addRequests.count, 1)
        XCTAssertTrue(center.addRequests[0].identifier.hasPrefix("chamber-edge-"),
                      "identifier 必须进 OS 标识（P-07 逐条退役依赖末段 id）")
        XCTAssertEqual(legs.notificationRegistry.trackedCount, 1,
                       "成功后保留登记（供来源/逐条退役）")
    }

    /// 授权 denied：先查状态、绝不 add、回 {shown:false,error}（core 释放去重
    /// claim），并撤下调度前登记（没有可退役横幅）。
    func testNotificationDeniedRepliesShownFalseWithoutAdd() {
        let center = FakeNotificationCenter()
        center.status = .denied
        let legs = SwiftEdgeHostLegs(config: .init(canShowUI: { true },
                                                   notificationCenter: { center }))
        let reply = deliverNotification(legs, payload: notificationPayload())
        guard case .object(let fields)? = reply.result,
              case .bool(false)? = fields["shown"] else {
            return XCTFail("denied 必须回 {shown:false}（实际 \(String(describing: reply.result))）")
        }
        XCTAssertTrue((EdgePayload.string(fields["error"]) ?? "").contains("not-authorized"))
        XCTAssertTrue(center.addRequests.isEmpty, "denied 不得触碰 add")
        XCTAssertEqual(center.requestAuthorizationCount, 0, "已 denied 不重复请求授权")
        XCTAssertEqual(legs.notificationRegistry.trackedCount, 0, "失败撤下登记")
    }

    /// notDetermined：先申请一次；拒绝 → {shown:false,error}；批准 → add 并 shown:true。
    func testNotificationNotDeterminedRequestsAuthorizationFirst() {
        let deniedCenter = FakeNotificationCenter()
        deniedCenter.status = .notDetermined
        deniedCenter.granted = false
        let deniedLegs = SwiftEdgeHostLegs(config: .init(canShowUI: { true },
                                                         notificationCenter: { deniedCenter }))
        let deniedReply = deliverNotification(deniedLegs, payload: notificationPayload())
        XCTAssertEqual(deniedCenter.requestAuthorizationCount, 1)
        XCTAssertTrue(deniedCenter.addRequests.isEmpty, "未授权不得 add")
        // 失败回执携带 failureClass（notifications.ts 的
        // interpretNativeNotificationReply 据 permanent/retryable 决定去重
        // claim 的释放/重试语义）；denied 是终态 → permanent。
        XCTAssertEqual(deniedReply.result,
                       .object(["shown": .bool(false),
                                "error": .string("swift-edge-notification-not-authorized:denied"),
                                "failureClass": .string("permanent")]))

        let grantedCenter = FakeNotificationCenter()
        grantedCenter.status = .notDetermined
        grantedCenter.granted = true
        let grantedLegs = SwiftEdgeHostLegs(config: .init(canShowUI: { true },
                                                          notificationCenter: { grantedCenter }))
        let grantedReply = deliverNotification(grantedLegs, payload: notificationPayload())
        XCTAssertEqual(grantedCenter.requestAuthorizationCount, 1)
        XCTAssertEqual(grantedCenter.addRequests.count, 1)
        XCTAssertEqual(grantedReply.result, .object(["shown": .bool(true)]))
    }

    /// add 错误：回 {shown:false,error}（含原始描述），绝不上报 shown:true。
    func testNotificationAddErrorRepliesShownFalse() {
        let center = FakeNotificationCenter()
        center.addError = NSError(domain: "test", code: 1,
                                  userInfo: [NSLocalizedDescriptionKey: "boom"])
        let legs = SwiftEdgeHostLegs(config: .init(canShowUI: { true },
                                                   notificationCenter: { center }))
        let reply = deliverNotification(legs, payload: notificationPayload())
        guard case .object(let fields)? = reply.result,
              case .bool(false)? = fields["shown"] else {
            return XCTFail("add 错误必须回 {shown:false}（实际 \(String(describing: reply.result))）")
        }
        XCTAssertTrue((EdgePayload.string(fields["error"]) ?? "").contains("schedule-failed"))
        XCTAssertTrue((EdgePayload.string(fields["error"]) ?? "").contains("boom"))
        XCTAssertEqual(legs.notificationRegistry.trackedCount, 0)
    }

    /// 有界超时：add 不回调 → 5s 上限（测试缩短）先回 {shown:false,error}，恰
    /// 一次；超时后 add 晚到的成功横幅必须立即清除，绝不补发 shown:true。
    func testNotificationAddTimeoutRepliesShownFalseOnceAndClearsLateBanner() {
        let center = FakeNotificationCenter()
        center.completeAddImmediately = false
        let legs = SwiftEdgeHostLegs(config: .init(
            canShowUI: { true },
            notificationCenter: { center },
            notificationAddTimeout: 0.05))
        let counter = ReplyCounter()
        let reply = deliverNotification(legs, payload: notificationPayload(), counter: counter)
        guard case .object(let fields)? = reply.result,
              case .bool(false)? = fields["shown"] else {
            return XCTFail("超时必须回 {shown:false}（实际 \(String(describing: reply.result))）")
        }
        XCTAssertTrue((EdgePayload.string(fields["error"]) ?? "").contains("timeout"))
        // 超时后 add 才完成：横幅落地 → 立即清除；回执仍恰一次。
        center.completePendingAdd()
        Thread.sleep(forTimeInterval: 0.1)
        XCTAssertEqual(counter.value, 1, "超时后晚到的完成不得补发第二个回执")
        XCTAssertEqual(center.removedIdentifierBatches,
                       [[center.addRequests[0].identifier]],
                       "晚到的成功横幅必须按 identifier 立即清除")
    }

    /// 超时回执后，未完成的投递仍留在登记表：随后按来源退役仍能取到它并清除。
    func testNotificationTimeoutKeepsRegistryEntryForRetirement() {
        let center = FakeNotificationCenter()
        center.completeAddImmediately = false
        let legs = SwiftEdgeHostLegs(config: .init(
            canShowUI: { true },
            notificationCenter: { center },
            notificationAddTimeout: 0.05))
        _ = deliverNotification(legs, payload: notificationPayload(sourceId: "local"))
        XCTAssertEqual(legs.notificationRegistry.trackedCount, 1,
                       "超时不是投递失败（add 可能仍在途）：登记留给退役端")
        XCTAssertEqual(legs.notificationRegistry.retire(sourceIds: ["local"]).count, 1)
    }
}
