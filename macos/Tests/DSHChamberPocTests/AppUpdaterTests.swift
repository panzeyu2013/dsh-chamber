//
//  AppUpdaterTests.swift
//  DSHChamberPocTests
//
//  S-01 / 2026-12 裁决「D-1 选 B」：原生壳的应用内更新器（Sparkle 2）装配判据、
//  App 菜单面与两条 edge 腿。GUI/网络腿（真实 appcast、Sparkle 窗口、安装）属实机
//  验收，单测只钉判据与诚实降级。
//
import XCTest
@testable import DSHChamberPoc

final class AppUpdaterTests: XCTestCase {
    func testConfigurationRequiresBothFeedAndPublicKey() {
        XCTAssertNil(AppUpdater.configuration(from: [:]))
        XCTAssertNil(AppUpdater.configuration(from: ["SUFeedURL": "https://x/appcast.xml"]),
                     "只有 feed 不算配置")
        XCTAssertNil(AppUpdater.configuration(from: ["SUPublicEDKey": "abc="]),
                     "只有公钥不算配置")
        XCTAssertNil(AppUpdater.configuration(from: ["SUFeedURL": "", "SUPublicEDKey": "abc="]))
        XCTAssertNil(AppUpdater.configuration(from: ["SUFeedURL": "   ", "SUPublicEDKey": "abc="]),
                     "空白 feed 视为未配置（装配模板的空串占位）")
        XCTAssertNil(AppUpdater.configuration(from: ["SUFeedURL": "https://x/a.xml", "SUPublicEDKey": "  "]))
    }

    func testConfigurationParsesAutomaticChecksAndInterval() {
        let config = AppUpdater.configuration(from: [
            "SUFeedURL": "https://example.com/appcast-swift.xml",
            "SUPublicEDKey": "abc=",
            "SUEnableAutomaticChecks": true,
            "SUScheduledCheckInterval": NSNumber(value: 21600),
        ])
        XCTAssertEqual(config?.feedURL, "https://example.com/appcast-swift.xml")
        XCTAssertEqual(config?.publicKey, "abc=")
        XCTAssertEqual(config?.automaticChecks, true)
        XCTAssertEqual(config?.checkInterval, 21600)
        // 解析缺省仍是 false（键缺失时的防御缺省）；正式装配模板显式声明 true（D9）。
        let bare = AppUpdater.configuration(from: [
            "SUFeedURL": "https://example.com/appcast-swift.xml",
            "SUPublicEDKey": "abc=",
        ])
        XCTAssertEqual(bare?.automaticChecks, false)
        XCTAssertNil(bare?.checkInterval)
    }

    func testUpdaterStaysUnavailableWithoutConfiguration() {
        // 测试宿主 Info.plist 没有 Sparkle 键：装配必须被拒（绝不谎称能更新）。
        XCTAssertFalse(AppUpdater.shared.start(info: [:], startUpdater: false))
        XCTAssertFalse(AppUpdater.shared.isAvailable)
        XCTAssertFalse(AppUpdater.shared.canCheckForUpdates)
        XCTAssertNil(AppUpdater.shared.configuration)
        // 未装配时用户发起检查是 no-op（不得崩溃、不得假装已检查）。
        AppUpdater.shared.checkForUpdates(nil)
    }

    func testMainMenuCarriesCheckForUpdatesItem() {
        let menu = AppDelegate.makeMainMenu()
        let appItems = menu.items.first?.submenu?.items ?? []
        let item = appItems.first { $0.action == #selector(AppUpdater.checkForUpdates(_:)) }
        XCTAssertNotNil(item, "App 菜单需有「检查更新…」（macOS 标准位置：关于之后）")
        XCTAssertEqual(item?.title, "检查更新…")
        XCTAssertFalse(item?.isEnabled ?? true, "未配置 feed/公钥时必须禁用")
        let aboutIndex = appItems.firstIndex { $0.action == #selector(NSApplication.orderFrontStandardAboutPanel(_:)) }
        let updateIndex = appItems.firstIndex(of: item ?? NSMenuItem())
        if let aboutIndex, let updateIndex {
            XCTAssertLessThan(aboutIndex, updateIndex, "「检查更新…」在「关于」之后")
        }
    }

    func testUpdateEdgeLegsReportCapabilityAndRefuseWithoutUpdater() {
        let legs = SwiftEdgeHostLegs()
        let capability = legs.respond(method: "updateNativeCapability", payload: nil)
        XCTAssertNil(capability.error)
        if case .object(let dict)? = capability.result, case .bool(let available)? = dict["available"] {
            XCTAssertFalse(available,
                           "未装配 → sidecar 必须看到 available=false（保持 blocked-available）")
            // S-38：能力面必须携带诚实原因，sidecar 据此记录真实失败而不是只看到一个 false。
            XCTAssertEqual(dict["error"], .string("native-updater-unavailable"))
        } else {
            XCTFail("updateNativeCapability 必须回 {available: bool}（实际 \(String(describing: capability.result))）")
        }

        for kind in ["check", "download", "install"] {
            let action = legs.respond(method: "updateNativeAction",
                                      payload: .object(["kind": .string(kind)]))
            XCTAssertNil(action.result)
            XCTAssertEqual(action.error, "native-updater-unavailable",
                           "无更新器时 kind=\(kind) 必须拿显式错误，不得假成功")
        }
        // S-39：未知 kind 也必须诚实拒绝（绝不落回 check）。
        let unknown = legs.respond(method: "updateNativeAction",
                                   payload: .object(["kind": .string("restart")]))
        XCTAssertNil(unknown.result)
        XCTAssertEqual(unknown.error, "native-updater-unknown-kind:restart")
    }

    // MARK: - S-38 配置形状 / 能力诚实化

    /// 坏 feed / 坏 EdDSA 公钥在装配期就被折成诚实不可用（不留到验签才炸、也不
    /// 让页面停在 checking）。
    func testConfigurationShapeValidationRejectsBadFeedAndKey() {
        let goodKey = Data(repeating: 0, count: 32).base64EncodedString()
        func config(_ feed: String, _ key: String) -> AppUpdater.Configuration {
            AppUpdater.Configuration(feedURL: feed, publicKey: key,
                                     automaticChecks: true, checkInterval: 21600)
        }
        XCTAssertNil(AppUpdater.configurationError(
            for: config("https://example.com/appcast-swift.xml", goodKey)))
        XCTAssertNotNil(AppUpdater.configurationError(
            for: config("http://example.com/appcast-swift.xml", goodKey)),
            "Sparkle/ATS 拒绝明文 feed")
        XCTAssertNotNil(AppUpdater.configurationError(for: config("not a url", goodKey)))
        XCTAssertNotNil(AppUpdater.configurationError(
            for: config("https://example.com/appcast-swift.xml", "abc=")),
            "Ed25519 公钥不是 3 字节")
        XCTAssertNotNil(AppUpdater.configurationError(
            for: config("https://example.com/appcast-swift.xml",
                        Data(repeating: 0, count: 31).base64EncodedString())),
            "31 字节不是合法 Ed25519 公钥")
        XCTAssertNotNil(AppUpdater.configurationError(
            for: config("https://example.com/appcast-swift.xml", "!!! not base64 !!!")))
    }

    /// S-37：强制启动后台检查的纯决策（自动检查开启 + 真的 startUpdater 才补一次）。
    func testForcedLaunchBackgroundCheckDecision() {
        let key = Data(repeating: 0, count: 32).base64EncodedString()
        let automatic = AppUpdater.Configuration(feedURL: "https://x/appcast-swift.xml",
                                                 publicKey: key, automaticChecks: true, checkInterval: nil)
        let manual = AppUpdater.Configuration(feedURL: "https://x/appcast-swift.xml",
                                              publicKey: key, automaticChecks: false, checkInterval: nil)
        XCTAssertTrue(AppUpdater.shouldForceLaunchBackgroundCheck(configuration: automatic, startUpdater: true))
        XCTAssertFalse(AppUpdater.shouldForceLaunchBackgroundCheck(configuration: manual, startUpdater: true),
                       "只手动检查的装配不得被强制后台首检")
        XCTAssertFalse(AppUpdater.shouldForceLaunchBackgroundCheck(configuration: nil, startUpdater: true))
        XCTAssertFalse(AppUpdater.shouldForceLaunchBackgroundCheck(configuration: automatic, startUpdater: false))
    }

    // MARK: - S-39 kind 分派 / 菜单实时 enable / S-01 钩子退役

    /// kind 分派与诚实拒绝：未装配时三种 kind 都拒绝并携带真实原因。
    func testNativeActionKindsAndRefusalsAreHonest() {
        XCTAssertEqual(AppUpdater.NativeUpdateActionKind(rawValue: "check"), .check)
        XCTAssertEqual(AppUpdater.NativeUpdateActionKind(rawValue: "download"), .download)
        XCTAssertEqual(AppUpdater.NativeUpdateActionKind(rawValue: "install"), .install)
        XCTAssertNil(AppUpdater.NativeUpdateActionKind(rawValue: "restart"))
        XCTAssertEqual(AppUpdater.shared.unavailableReason, "native-updater-unavailable")
        for kind in AppUpdater.NativeUpdateActionKind.allCases {
            XCTAssertEqual(AppUpdater.shared.perform(kind),
                           .refused(reason: "native-updater-unavailable"),
                           "kind=\(kind.rawValue) 未装配时必须拒绝（绝不假 accepted）")
        }
        let capability = AppUpdater.shared.capability
        XCTAssertFalse(capability.available)
        XCTAssertEqual(capability.error, "native-updater-unavailable")
    }

    /// S-39：菜单 enable 由 NSMenuItemValidation 实时校验（AppDelegate 的构造期
    /// isEnabled 只是初值）；未装配 → 禁用，非本类 action 不干预。
    func testMenuValidationTracksLiveAvailability() {
        let shared: NSObject = AppUpdater.shared
        XCTAssertTrue(shared is NSMenuItemValidation,
                      "target 必须实现 NSMenuItemValidation，NSMenu 才会在每次打开时实时校验")
        let checkItem = NSMenuItem(title: "检查更新…",
                                   action: #selector(AppUpdater.checkForUpdates(_:)),
                                   keyEquivalent: "")
        checkItem.target = AppUpdater.shared
        XCTAssertFalse(AppUpdater.shared.validateMenuItem(checkItem),
                       "未装配 → 实时校验禁用（不再是启动快照）")
        let aboutItem = NSMenuItem(title: "关于",
                                   action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                                   keyEquivalent: "")
        XCTAssertTrue(AppUpdater.shared.validateMenuItem(aboutItem),
                      "非本类 action 不干预")
    }

    /// S-01（2026-12 复核）：willInstallUpdateOnQuit 零调用（只在
    /// automaticallyDownloadsUpdates 的 automatic-update driver 里被调用）而 Electron
    /// 是 autoDownload=false + autoInstallOnAppQuit=true ⇒ 钩子删除，不再留潜伏声明；
    /// 退出时安装由 Sparkle 标准 resumable 路径承担（见 AppUpdater 头注释）。
    func testQuitInstallHookIsNotWired() {
        XCTAssertFalse(AppUpdater.shared.responds(to: NSSelectorFromString(
            "updater:willInstallUpdateOnQuit:immediateInstallationBlock:")),
            "潜伏钩子已删除——重新接线必须是有意识的决定（并同步 Electron 的自动下载语义）")
    }

    // MARK: - S-19/S-20：原生阶段投影（fake-delegate 假事件覆盖）

    func testProjectorMapsDelegateEventsToPagePhases() {
        var projector = NativeUpdatePhaseProjector()
        XCTAssertEqual(projector.apply(.checkStarted),
                       NativeUpdatePhaseReport(phase: .checking, version: nil, error: nil))
        XCTAssertEqual(projector.apply(.validUpdate(version: "1.2.3")),
                       NativeUpdatePhaseReport(phase: .available, version: "1.2.3", error: nil))
        XCTAssertEqual(projector.apply(.downloadWillStart(version: "1.2.3")),
                       NativeUpdatePhaseReport(phase: .downloading, version: "1.2.3", error: nil))
        XCTAssertEqual(projector.apply(.downloadFinished(version: "1.2.3")),
                       NativeUpdatePhaseReport(phase: .downloaded, version: "1.2.3", error: nil))
        XCTAssertEqual(projector.apply(.installWillStart(version: "1.2.3")),
                       NativeUpdatePhaseReport(phase: .installing, version: "1.2.3", error: nil))
    }

    func testProjectorUpToDateAndFailureCarryError() {
        var projector = NativeUpdatePhaseProjector()
        XCTAssertEqual(projector.apply(.noUpdate),
                       NativeUpdatePhaseReport(phase: .upToDate, version: nil, error: nil))
        XCTAssertEqual(projector.apply(.downloadWillStart(version: "9.9.9")),
                       NativeUpdatePhaseReport(phase: .downloading, version: "9.9.9", error: nil))
        XCTAssertEqual(projector.apply(.downloadFailed(error: "boom")),
                       NativeUpdatePhaseReport(phase: .failed, version: "9.9.9", error: "boom"),
                       "下载失败保留已知版本号")
        XCTAssertEqual(projector.apply(.checkFailed(error: "feed down")),
                       NativeUpdatePhaseReport(phase: .failed, version: nil, error: "feed down"))
        XCTAssertEqual(projector.apply(.downloadCancelled),
                       NativeUpdatePhaseReport(phase: .available, version: nil, error: nil),
                       "取消下载回到 available，不是 failed")
    }

    /// 去重：Sparkle 的 didAbortWithError 与 didFinishUpdateCycle 可能对同一次
    /// 失败各回调一次，页面不得收到重复阶段。
    func testProjectorDeduplicatesRepeatedPhase() {
        var projector = NativeUpdatePhaseProjector()
        XCTAssertNotNil(projector.apply(.checkStarted))
        XCTAssertNil(projector.apply(.checkStarted), "同相位重复不上行")
        XCTAssertNotNil(projector.apply(.checkFailed(error: "x")))
        XCTAssertNil(projector.apply(.checkFailed(error: "x")), "同 failed+文案重复不上行")
    }

    /// 冻结线 payload/phase 逐字断言（node-edges HOST_INBOUND 的配对线名）。
    func testFrozenWireShapeAndNames() {
        XCTAssertEqual(HostInboundMethod.nativeUpdatePhase, "__host.nativeUpdatePhase")
        XCTAssertEqual(NativeUpdatePhase.upToDate.rawValue, "up-to-date",
                       "页面 UpdateState.phase 的连字符拼写")
        let report = NativeUpdatePhaseReport(phase: .available, version: "1.0.0", error: nil)
        guard case .object(let dict) = report.payload else {
            return XCTFail("payload 必须为 JSON 对象，实际：\(report.payload)")
        }
        XCTAssertEqual(dict["phase"], .string("available"))
        XCTAssertEqual(dict["version"], .string("1.0.0"))
        XCTAssertEqual(dict["error"], .null, "缺省 error 显式写 null")
        let failed = NativeUpdatePhaseReport(phase: .failed, version: nil, error: "boom")
        guard case .object(let failedDict) = failed.payload else {
            return XCTFail("failed payload 必须为 JSON 对象")
        }
        XCTAssertEqual(failedDict["version"], .null)
        XCTAssertEqual(failedDict["error"], .string("boom"))
    }

    /// AppUpdater.note（delegate 回调的公共入口）→ onPhase 上行（fake-delegate）。
    func testAppUpdaterNoteForwardsChangedReportsToOnPhase() {
        let updater = AppUpdater.shared
        updater.resetPhaseProjectionForTesting()
        defer {
            updater.onPhase = nil
            updater.resetPhaseProjectionForTesting()
        }
        var received: [NativeUpdatePhaseReport] = []
        updater.onPhase = { received.append($0) }
        updater.note(.checkStarted)
        updater.note(.checkStarted)                 // 去重：不上行
        updater.note(.validUpdate(version: "3.1.4"))
        updater.note(.downloadWillStart(version: "3.1.4"))
        XCTAssertEqual(received.map { $0.phase }, [.checking, .available, .downloading])
        XCTAssertEqual(received[1].version, "3.1.4")
        XCTAssertEqual(received[2].version, "3.1.4")
    }

    // MARK: - D9 / S-21 parity：自动检查 = 真 + scheduled 展示归页面

    /// 自动检查是模板常量：build-swift-app 的 renderInfoPlist 只替换
    /// __VERSION__/__BUNDLE_VERSION__/__SPARKLE_*，不写本键，所以直接钉住装配
    /// 输入（Info.plist.template）即为装配产物的真值。
    func testInfoPlistTemplateDeclaresAutomaticChecksAtSixHourCadence() throws {
        // #filePath = macos/Tests/DSHChamberPocTests/AppUpdaterTests.swift
        let macosDir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // DSHChamberPocTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // macos
        let data = try Data(contentsOf: macosDir.appendingPathComponent("Info.plist.template"))
        let xml = try XCTUnwrap(String(data: data, encoding: .utf8))
        let compact = xml.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        XCTAssertTrue(compact.contains("<key>SUEnableAutomaticChecks</key> <true/>"),
                      "自动检查必须是模板常量 true（与 Electron 的 6h 静默后台检查对齐）")
        XCTAssertFalse(compact.contains("<key>SUEnableAutomaticChecks</key> <false/>"),
                       "D9 修正后不得回退到「只手动检查」")
        XCTAssertTrue(compact.contains("<key>SUScheduledCheckInterval</key> <integer>21600</integer>"),
                      "6h = 21600s，与 Electron CHECK_INTERVAL_MS 同节奏")
    }

    /// scheduled vs user-initiated 展示决策（fake seam，不构造真实 SUAppcastItem、
    /// 不发网络请求）：scheduled 抑制标准窗且只投影 available；用户发起走标准窗。
    func testScheduledUpdateSuppressesStandardWindowAndProjectsPhase() {
        XCTAssertTrue(AppUpdater.shared.supportsGentleScheduledUpdateReminders,
                      "声明 gentle reminders，scheduled 展示权才归壳而非后台弹窗")
        // Sparkle 完全按 respondsToSelector: 决策（SPUStandardUserDriver.m）——两个
        // ObjC 回调与属性必须真的对 ObjC 运行时可见，否则上面的纯逻辑形同虚设。
        let shared: NSObject = AppUpdater.shared
        XCTAssertTrue(shared.responds(to: NSSelectorFromString("supportsGentleScheduledUpdateReminders")))
        XCTAssertTrue(shared.responds(to: NSSelectorFromString(
            "standardUserDriverShouldHandleShowingScheduledUpdate:andInImmediateFocus:")))
        XCTAssertTrue(shared.responds(to: NSSelectorFromString(
            "standardUserDriverWillHandleShowingUpdate:forUpdate:state:")))
        XCTAssertFalse(AppUpdater.shouldHandleShowingScheduledUpdate(immediateFocus: true))
        XCTAssertFalse(AppUpdater.shouldHandleShowingScheduledUpdate(immediateFocus: false))

        // 决策表：只有 scheduled + Sparkle 交还我们时才是页面投影。
        XCTAssertEqual(StandardUpdatePresentation.decide(handleShowingUpdate: false, userInitiated: false),
                       .pageProjection)
        XCTAssertEqual(StandardUpdatePresentation.decide(handleShowingUpdate: true, userInitiated: true),
                       .standardWindow)
        XCTAssertEqual(StandardUpdatePresentation.decide(handleShowingUpdate: true, userInitiated: false),
                       .standardWindow)

        let updater = AppUpdater.shared
        updater.resetPhaseProjectionForTesting()
        defer {
            updater.onPhase = nil
            updater.resetPhaseProjectionForTesting()
        }
        var received: [NativeUpdatePhaseReport] = []
        updater.onPhase = { received.append($0) }

        // scheduled 接管：不弹窗，只上报 available（页面是展示面）。
        XCTAssertEqual(updater.presentStandardUpdate(handleShowingUpdate: false,
                                                     userInitiated: false,
                                                     version: "9.9.9"),
                       .pageProjection)
        XCTAssertEqual(received.map { $0.phase }, [.available])
        XCTAssertEqual(received.first?.version, "9.9.9")

        // 用户发起：标准窗路径不改页面上报序列（didFindValidUpdate 已上报）。
        XCTAssertEqual(updater.presentStandardUpdate(handleShowingUpdate: true,
                                                     userInitiated: true,
                                                     version: "9.9.9"),
                       .standardWindow)
        XCTAssertEqual(received.count, 1, "用户发起路径不追加阶段")
    }
}
