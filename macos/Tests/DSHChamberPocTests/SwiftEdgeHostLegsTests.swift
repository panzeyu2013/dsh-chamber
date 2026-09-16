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
        for method in ["focusMainWindow", "showMessage", "openExternal", "openPath",
                       "setLoginItem", "launchApp"] {
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
        for method in ["setBadge", "setKeepAwake", "showItemInFolder", "pickPluginSource", "showError", "launchApp", "showMessage"] {
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

    // MARK: - S-D：setLoginItem 守卫（E14；SMAppService 真机调用属签名实机门禁）

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

    // MARK: - S-D：launchApp appId 映射的守卫/形状分支（成功分支真实拉起属
    // 实机门禁——finder 揭示 / vscode 深链不在此触发系统副作用）

    /// 仅守卫/形状分支可无副作用测试：过窗口守卫后、命中系统副作用之前返回
    /// 错误的分支。NSWindow 只创建不显示（无副作用）。
    private func makeWindowGuardedLegs() -> SwiftEdgeHostLegs {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 10, height: 10),
                              styleMask: [.borderless],
                              backing: .buffered,
                              defer: false)
        let legs = SwiftEdgeHostLegs(config: .init(canShowUI: { true }))
        legs.mainWindowProvider = { window }
        return legs
    }

    func testLaunchAppShapeGuardsAfterWindowGuard() {
        let legs = makeWindowGuardedLegs()
        // 缺 appId / 空 appId → unimplemented 形状错误（回落默认表 loud）。
        let noAppIDPayloads: [AnyCodable?] = [
            nil,
            .object([:]),
            .object(["path": .string("/x")]),
            .object(["appId": .string(""), "path": .string("/x")]),
        ]
        for payload in noAppIDPayloads {
            let outcome = legs.respond(method: "launchApp", payload: payload)
            XCTAssertEqual(outcome.error, "swift-edge-unimplemented:launchApp:app-id-missing",
                           "payload=\(String(describing: payload))")
        }
        // 有 appId 缺 path / 空 path → path-missing。
        let noPathPayloads: [AnyCodable?] = [
            .object(["appId": .string("finder")]),
            .object(["appId": .string("finder"), "path": .string("")]),
        ]
        for payload in noPathPayloads {
            let outcome = legs.respond(method: "launchApp", payload: payload)
            XCTAssertEqual(outcome.error, "swift-edge-unimplemented:launchApp:path-missing",
                           "payload=\(String(describing: payload))")
        }
    }

    func testLaunchAppUnknownAppIdIsLoudNeverGuessed() {
        // 镜像 open-in.ts：未知 appId → loud（绝不按 path 默认打开——
        // 通用 path 打开属 openPath 职责）。
        let legs = makeWindowGuardedLegs()
        for appId in ["cursor", "zzz", "Finder"] {   // 大小写不折叠（白名单精确）
            let outcome = legs.respond(method: "launchApp",
                                       payload: .object(["appId": .string(appId),
                                                         "path": .string("/tmp/x")]))
            XCTAssertEqual(outcome.error,
                           "swift-edge-ui-unavailable:launchApp:unknown-app-id:\(appId)")
        }
    }

    func testLaunchAppVscodeRequiresAbsolutePath() {
        let legs = makeWindowGuardedLegs()
        let outcome = legs.respond(method: "launchApp",
                                   payload: .object(["appId": .string("vscode"),
                                                     "path": .string("relative/path")]))
        XCTAssertEqual(outcome.error,
                       "swift-edge-unimplemented:launchApp:path-not-absolute")
    }

    // MARK: - S-D：vscode://file URL 构造纯逻辑（deep-link.ts 同构锚点）

    func testVscodeFileURLEncodingAnchors() {
        // Electron deep-link.test.ts:606 锚点逐字对照：
        // runVscodeLaunch 对 '/home/user/我的 项目' 产出
        // 'vscode://file/home/user/%E6%88%91%E7%9A%84%20%E9%A1%B9%E7%9B%AE'。
        XCTAssertEqual(SwiftEdgeHostLegs.vscodeFileURL(for: "/home/user/我的 项目")?.absoluteString,
                       "vscode://file/home/user/%E6%88%91%E7%9A%84%20%E9%A1%B9%E7%9B%AE")
        // open-in.test.ts:177 锚点：'/home/user/local-ws' → vscode://file/home/user/local-ws。
        XCTAssertEqual(SwiftEdgeHostLegs.vscodeFileURL(for: "/home/user/local-ws")?.absoluteString,
                       "vscode://file/home/user/local-ws")
        // encodeURIComponent 保留集：-_.!~*'() 与字母数字不转义。
        XCTAssertEqual(SwiftEdgeHostLegs.vscodeFileURL(for: "/a/-_.!~*'() b")?.absoluteString,
                       "vscode://file/a/-_.!~*'()%20b")
        // '#'、'?'、'&'、'%'、'+' 全部编码（encodeRemotePath 同族覆盖）。
        XCTAssertEqual(SwiftEdgeHostLegs.vscodeFileURL(for: "/a/b#c?d&e%f+g")?.absoluteString,
                       "vscode://file/a/b%23c%3Fd%26e%25f%2Bg")
    }

    func testVscodeFileURLRejectsNonAbsolute() {
        XCTAssertNil(SwiftEdgeHostLegs.vscodeFileURL(for: ""))
        XCTAssertNil(SwiftEdgeHostLegs.vscodeFileURL(for: "relative/path"))
        XCTAssertNil(SwiftEdgeHostLegs.vscodeFileURL(for: "~/proj"))
    }

    func testVscodeFileURLPreservesEmptySegmentsAndTrailingSlash() {
        // JS split('/') 保留空段（encodeRemotePath 同款）；'//' 双斜杠保字面。
        XCTAssertEqual(SwiftEdgeHostLegs.vscodeFileURL(for: "//host/share")?.absoluteString,
                       "vscode://file//host/share")
        XCTAssertEqual(SwiftEdgeHostLegs.vscodeFileURL(for: "/trailing/")?.absoluteString,
                       "vscode://file/trailing/")
    }

    // MARK: - S1：交互腿异步应答（10 分钟上限、超时弃权、非交互短界保持）

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
    /// 形态）→ body 派主线程；旧实现会在 1s 处回 main-thread-busy 并丢弃结果。
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

    /// S1：超时后仍在主队列排队的 body 绝不补执行（无双重执行），回执恰一次。
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

    /// 非交互腿保留 1s 短界（S1 明确不把非交互腿一并拉长）。
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

    /// 二轮评审 P3：EdgePayload.int 对非有限/越界值返回 nil，绝不 trap。
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
}
