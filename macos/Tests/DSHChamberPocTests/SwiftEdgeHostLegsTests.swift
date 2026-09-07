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
}
