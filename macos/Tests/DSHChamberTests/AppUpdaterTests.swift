//
//  AppUpdaterTests.swift
//  DSHChamberTests
//
//  原生壳的应用内更新器（Sparkle 2）装配判据、
//  App 菜单面与两条 edge 腿。GUI/网络腿（真实 appcast、Sparkle 窗口、安装）属实机
//  验收，单测只钉判据与诚实降级。
//
import XCTest
@testable import DSHChamber

final class AppUpdaterTests: XCTestCase {
    /// 增量更新观测面：shell.log 必须记录 Sparkle 实际选择的产物（`*.delta` vs 整包 zip），
    /// 据此可判断「相邻版本走增量、跳版本回退整包」。
    func testDownloadArtifactNameDistinguishesDeltaFromFullArchive() {
        XCTAssertEqual(
            AppUpdater.downloadArtifactName(URL(string: "https://github.com/o/r/releases/download/x/dsh-chamber1.0.0.999999999-0.9.0.999999999.delta")),
            "dsh-chamber1.0.0.999999999-0.9.0.999999999.delta")
        XCTAssertEqual(
            AppUpdater.downloadArtifactName(URL(string: "https://github.com/o/r/releases/latest/download/dsh-chamber-1.0.0-macos-arm64.zip")),
            "dsh-chamber-1.0.0-macos-arm64.zip")
        XCTAssertEqual(
            AppUpdater.downloadArtifactName(URL(string: "https://example.com/a.zip?token=secret#frag")),
            "a.zip", "只记文件名：query/fragment 绝不进日志")
        XCTAssertEqual(AppUpdater.downloadArtifactName(nil), "unknown", "缺 URL 时既不崩也不伪造文件名")
    }

    /// emission 本身也要钉住：否则 helper 还在，证据行却会静默消失。
    func testDownloadLogLineIsTheObservableEvidence() {
        XCTAssertEqual(
            AppUpdater.downloadLogLine(
                version: "0.4.0",
                url: URL(string: "https://github.com/o/r/releases/download/x/dsh-chamber0.4.0.1-0.3.3.1.delta")),
            "[shell] Sparkle 开始下载 0.4.0：dsh-chamber0.4.0.1-0.3.3.1.delta")
        XCTAssertEqual(
            AppUpdater.downloadLogLine(version: "0.4.0", url: URL(string: "https://o/r/dsh-chamber-0.4.0-macos-arm64.zip")),
            "[shell] Sparkle 开始下载 0.4.0：dsh-chamber-0.4.0-macos-arm64.zip")
        XCTAssertEqual(AppUpdater.downloadLogLine(version: "0.4.0", url: nil),
            "[shell] Sparkle 开始下载 0.4.0：unknown")
    }

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
            "SUScheduledCheckInterval": NSNumber(value: 600),
        ])
        XCTAssertEqual(config?.feedURL, "https://example.com/appcast-swift.xml")
        XCTAssertEqual(config?.publicKey, "abc=")
        XCTAssertEqual(config?.automaticChecks, true)
        XCTAssertEqual(config?.checkInterval, 600)
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
        XCTAssertEqual(item?.title, NativeText.string(.menuCheckForUpdates))
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
            // 能力面必须携带诚实原因，sidecar 据此记录真实失败而不是只看到一个 false。
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
        // 未知 kind 也必须诚实拒绝（绝不落回 check）。
        let unknown = legs.respond(method: "updateNativeAction",
                                   payload: .object(["kind": .string("restart")]))
        XCTAssertNil(unknown.result)
        XCTAssertEqual(unknown.error, "native-updater-unknown-kind:restart")
    }

    // MARK: - 配置形状 / 能力诚实化

    /// 坏 feed / 坏 EdDSA 公钥在装配期就被折成诚实不可用（不留到验签才炸、也不
    /// 让页面停在 checking）。
    func testConfigurationShapeValidationRejectsBadFeedAndKey() {
        let goodKey = Data(repeating: 0, count: 32).base64EncodedString()
        func config(_ feed: String, _ key: String) -> AppUpdater.Configuration {
            AppUpdater.Configuration(feedURL: feed, publicKey: key,
                                     automaticChecks: true, checkInterval: 600)
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

    /// 强制启动后台检查的纯决策（自动检查开启 + 真的 startUpdater 才补一次）。
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

    // MARK: - kind 分派 / 菜单实时 enable

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

    /// 菜单 enable 由 NSMenuItemValidation 实时校验（AppDelegate 的构造期
    /// isEnabled 只是初值）；未装配 → 禁用，非本类 action 不干预。
    func testMenuValidationTracksLiveAvailability() {
        let shared: NSObject = AppUpdater.shared
        XCTAssertTrue(shared is NSMenuItemValidation,
                      "target 必须实现 NSMenuItemValidation，NSMenu 才会在每次打开时实时校验")
        let checkItem = NSMenuItem(title: NativeText.string(.menuCheckForUpdates),
                                   action: #selector(AppUpdater.checkForUpdates(_:)),
                                   keyEquivalent: "")
        checkItem.target = AppUpdater.shared
        XCTAssertFalse(AppUpdater.shared.validateMenuItem(checkItem),
                       "未装配 → 实时校验禁用（不再是启动快照）")
        let aboutItem = NSMenuItem(title: NativeText.format(.menuAboutApp, MainWindowController.displayName),
                                   action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                                   keyEquivalent: "")
        XCTAssertTrue(AppUpdater.shared.validateMenuItem(aboutItem),
                      "非本类 action 不干预")
    }

    /// willInstallUpdateOnQuit 零调用（只在
    /// automaticallyDownloadsUpdates 的 automatic-update driver 里被调用）而 Electron
    /// 是 autoDownload=false + autoInstallOnAppQuit=true ⇒ 钩子不接线；
    /// 退出时安装由 Sparkle 标准 resumable 路径承担（见 AppUpdater 头注释）。
    func testQuitInstallHookIsNotWired() {
        XCTAssertFalse(AppUpdater.shared.responds(to: NSSelectorFromString(
            "updater:willInstallUpdateOnQuit:immediateInstallationBlock:")),
            "潜伏钩子已删除——重新接线必须是有意识的决定（并同步 Electron 的自动下载语义）")
    }

    // MARK: - 前台/唤醒 nudge 判据（P03）

    /// nudge 纯判据（与 update-headless.noteActivity 同语义）：相位门 + 距上次
    /// 完成检查满 checkInterval + 60s 合并窗，三个条件都成立才触发。
    func testNudgeBackgroundCheckGatesOnPhaseIntervalAndCoalescingWindow() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        func ago(_ seconds: TimeInterval) -> Date { now.addingTimeInterval(-seconds) }
        // 基态：无相位、从未检查、无 nudge → 触发。
        XCTAssertTrue(AppUpdater.shouldNudgeBackgroundCheck(
            phase: nil, lastCheckDate: nil, checkInterval: 600, lastNudgeAt: nil, now: now))
        // 相位门：在飞/终局相位一律不触发（downloaded 不得被后台检查改回 available）。
        for phase in [NativeUpdatePhase.checking, .downloading, .downloaded, .installing] {
            XCTAssertFalse(AppUpdater.shouldNudgeBackgroundCheck(
                phase: phase, lastCheckDate: nil, checkInterval: 600,
                lastNudgeAt: nil, now: now),
                phase.rawValue + " 不得触发后台检查")
        }
        // 其余相位（idle/available/up-to-date/failed）不拦，只由间隔/合并窗决定。
        for phase in [NativeUpdatePhase.idle, .available, .upToDate, .failed] {
            XCTAssertTrue(AppUpdater.shouldNudgeBackgroundCheck(
                phase: phase, lastCheckDate: nil, checkInterval: 600,
                lastNudgeAt: nil, now: now),
                phase.rawValue + " 可触发（间隔与合并窗均满足）")
        }
        // 间隔门：距上次完成检查 < checkInterval 不触发，满 interval 才触发。
        XCTAssertFalse(AppUpdater.shouldNudgeBackgroundCheck(
            phase: nil, lastCheckDate: ago(599), checkInterval: 600,
            lastNudgeAt: nil, now: now))
        XCTAssertTrue(AppUpdater.shouldNudgeBackgroundCheck(
            phase: nil, lastCheckDate: ago(600), checkInterval: 600,
            lastNudgeAt: nil, now: now))
        // 合并窗：解锁回前台的唤醒+激活两条通知只放行第一次。
        XCTAssertFalse(AppUpdater.shouldNudgeBackgroundCheck(
            phase: nil, lastCheckDate: ago(600), checkInterval: 600,
            lastNudgeAt: ago(59), now: now))
        XCTAssertTrue(AppUpdater.shouldNudgeBackgroundCheck(
            phase: nil, lastCheckDate: ago(600), checkInterval: 600,
            lastNudgeAt: ago(60), now: now))
        // 相位门优先于间隔/合并窗（downloaded 终局即便很久没检查也不触发）。
        XCTAssertFalse(AppUpdater.shouldNudgeBackgroundCheck(
            phase: .downloaded, lastCheckDate: ago(10_000), checkInterval: 600,
            lastNudgeAt: ago(10_000), now: now))
        XCTAssertEqual(AppUpdater.nudgeCoalescingWindow, 60, accuracy: 0.0001,
                       "唤醒/激活合并窗 = 60s（design 25 §7）")
    }

    // MARK: - 安装前显示准备（P20-B）

    /// install 的异步入口在无装配时与 perform 同词表诚实拒绝（绝不假 accepted）。
    func testPerformInstallRefusesWithoutUpdater() async {
        let outcome = await AppUpdater.shared.performInstall()
        XCTAssertEqual(outcome, .refused(reason: "native-updater-unavailable"))
    }

    // MARK: - 原生阶段投影（fake-delegate 假事件覆盖）

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

    // MARK: - 自动检查 = 真 + scheduled 展示归页面

    /// 自动检查是模板常量：build-swift-app 的 renderInfoPlist 只替换
    /// __VERSION__/__BUNDLE_VERSION__/__SPARKLE_*，不写本键，所以直接钉住装配
    /// 输入（Info.plist.template）即为装配产物的真值。
    func testInfoPlistTemplateDeclaresAutomaticChecksAtSixHourCadence() throws {
        // #filePath = macos/Tests/DSHChamberTests/AppUpdaterTests.swift
        let macosDir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // DSHChamberTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // macos
        let data = try Data(contentsOf: macosDir.appendingPathComponent("Info.plist.template"))
        let xml = try XCTUnwrap(String(data: data, encoding: .utf8))
        let compact = xml.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        XCTAssertTrue(compact.contains("<key>SUEnableAutomaticChecks</key> <true/>"),
                      "自动检查必须是模板常量 true（与 Electron 的 600s 基准静默检查对齐）")
        XCTAssertFalse(compact.contains("<key>SUEnableAutomaticChecks</key> <false/>"),
                       "D9 修正后不得回退到「只手动检查」")
        XCTAssertTrue(compact.contains("<key>SUScheduledCheckInterval</key> <integer>600</integer>"),
                      "600s = update-schedule.ts 的基准，与 Electron 同节奏")
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

    /// 就绪注意力判据（上游 update-attention.ts 的等价物，2026-09 跟随上游）：
    /// 只有「已下载待安装」抬注意力（Dock 跳动），其余相位一律不打扰。
    func testUpdateAttentionDecision() {
        XCTAssertTrue(MainWindowController.shouldRaiseUpdateAttention(phase: .downloaded))
        let quiet: [NativeUpdatePhase] = [.idle, .checking, .upToDate, .available, .downloading, .installing, .failed]
        for phase in quiet {
            XCTAssertFalse(MainWindowController.shouldRaiseUpdateAttention(phase: phase),
                           phase.rawValue + " 不得抬注意力")
        }
    }

    // MARK: - 更新通道（v4 纯偏好；契约 §2/§7）

    /// 生效通道单表（v4：**纯用户偏好**，版本后缀不参与；Swift 与 TS
    /// update-headless.resolveEffectiveUpdateChannel 必须同值）。
    func testResolveUpdateChannelTable() {
        func resolve(_ version: String, beta: Bool?, feed: Bool,
                     env: Bool) -> AppUpdater.UpdateChannel {
            _ = version // 版本串不参与 v4 通道判定；保留参数只为保留用例的可读语义
            return AppUpdater.resolveUpdateChannel(betaUpdates: beta,
                                                   betaSubscriptionAvailable: feed, envBeta: env)
        }
        // env 显式 beta：恒最强（通道 URL 对不可用、订阅关闭、任何版本都照样 beta）。
        XCTAssertEqual(resolve("1.2.3", beta: nil, feed: false, env: true), .beta)
        XCTAssertEqual(resolve("1.2.3", beta: false, feed: false, env: true), .beta)
        XCTAssertEqual(resolve("1.2.3-beta.4", beta: false, feed: false, env: true), .beta)
        // 两条通道 URL 可用 + 订阅开启 → beta。
        XCTAssertEqual(resolve("1.2.3", beta: true, feed: true, env: false), .beta)
        XCTAssertEqual(resolve("1.2.3-beta.4", beta: true, feed: true, env: false), .beta)
        // v4 核心：版本后缀**不**决定通道——beta 构建 + 订阅关闭（或缺省）→ stable
        // （开关关闭时只收正式版；该系列 final 发布时仍会被推过来）。
        XCTAssertEqual(resolve("1.2.3-beta.4", beta: false, feed: true, env: false), .stable)
        XCTAssertEqual(resolve("1.2.3-beta.4", beta: nil, feed: true, env: false), .stable)
        XCTAssertEqual(resolve("1.2.3", beta: nil, feed: true, env: false), .stable)
        XCTAssertEqual(resolve("1.2.3", beta: false, feed: true, env: false), .stable)
        // 通道 URL 对不可用：偏好不生效（调用方 loud），任何版本都 stable。
        XCTAssertEqual(resolve("1.2.3", beta: true, feed: false, env: false), .stable)
        XCTAssertEqual(resolve("1.2.3-beta.4", beta: true, feed: false, env: false), .stable)
    }

    /// env 覆盖是精确字面匹配（大小写/空白都不算）。
    func testEnvRequestsBetaIsExactMatch() {
        let envs: [[String: String]] = [
            ["DSH_CHAMBER_UPDATE_CHANNEL": "stable"],
            ["DSH_CHAMBER_UPDATE_CHANNEL": "BETA"],
            ["DSH_CHAMBER_UPDATE_CHANNEL": "beta "],
            ["DSH_CHAMBER_UPDATE_CHANNEL": ""],
            [:],
        ]
        XCTAssertTrue(AppUpdater.envRequestsBeta(["DSH_CHAMBER_UPDATE_CHANNEL": "beta"]))
        for env in envs {
            XCTAssertFalse(AppUpdater.envRequestsBeta(env), "\(env)")
        }
    }

    /// 通道切换可用性 = **两条** URL（stable + beta）成对且形状合法（https + 非空
    /// host）；任一缺失 / 非法都给具体原因（loud 日志、壳→sidecar flag、设置页能力
    /// 门共用同一判据，绝不半配置假可用）。
    func testBetaFeedProblemRequiresUsableFeedURLPair() {
        let key = Data(repeating: 0, count: 32).base64EncodedString()
        func config(stable: String? = nil, beta: String? = nil) -> AppUpdater.Configuration {
            AppUpdater.Configuration(feedURL: "https://example.com/appcast-swift.xml",
                                     publicKey: key, automaticChecks: true,
                                     checkInterval: 600,
                                     stableFeedURL: stable, betaFeedURL: beta)
        }
        let stableURL = "https://github.com/o/r/releases/latest/download/appcast-swift.xml"
        let betaURL = "https://github.com/o/r/releases/download/appcast-swift-beta/appcast-swift-beta.xml"
        XCTAssertEqual(AppUpdater.betaSubscriptionProblem(for: nil),
                       "更新器未装配（native-updater-unavailable）")
        XCTAssertNil(AppUpdater.betaSubscriptionProblem(for: config(stable: stableURL, beta: betaURL)),
                     "两条 URL 都注入且形状合法 → 通道切换可用")
        // 半配置：缺任一条都不可用（旧构建两条都缺同样不可用），原因指向具体键。
        XCTAssertEqual(AppUpdater.betaSubscriptionProblem(for: config(stable: stableURL))?
                           .contains("DSHChamberBetaFeedURL"), true, "只有 stable 时缺 beta")
        XCTAssertEqual(AppUpdater.betaSubscriptionProblem(for: config(beta: betaURL))?
                           .contains("DSHChamberStableFeedURL"), true, "只有 beta 时缺 stable")
        XCTAssertEqual(AppUpdater.betaSubscriptionProblem(for: config())?
                           .contains("成对"), true, "两条都缺（旧构建）同样是不可用")
        // 形状：任一条非 https / 无 host → 具体键的原因（运行期只校验 https/host，
        // 路径形状由装配期 dry-run 保证）。
        XCTAssertEqual(AppUpdater.betaSubscriptionProblem(
            for: config(stable: "http://example.com/appcast-swift.xml", beta: betaURL))?
                           .contains("DSHChamberStableFeedURL"), true)
        XCTAssertEqual(AppUpdater.betaSubscriptionProblem(
            for: config(stable: stableURL, beta: "http://example.com/appcast-swift-beta.xml"))?
                           .contains("DSHChamberBetaFeedURL"), true)
        for bad in ["not a url", "https://", "ftp://example.com/a.xml", ""] {
            XCTAssertNotNil(AppUpdater.betaSubscriptionProblem(for: config(stable: stableURL, beta: bad)), bad)
            XCTAssertNotNil(AppUpdater.betaSubscriptionProblem(for: config(stable: bad, beta: betaURL)), bad)
        }
        // 运行期形状判据单源（与 SUFeedURL 同规）。
        XCTAssertTrue(AppUpdater.isUsableFeedURL(stableURL))
        XCTAssertFalse(AppUpdater.isUsableFeedURL("http://example.com/appcast-swift.xml"))
        XCTAssertFalse(AppUpdater.isUsableFeedURL("not a url"))
    }

    /// 装配输入 → Configuration：两条通道 URL 的 trim / 空串占位 / 非字符串折叠。
    func testConfigurationReadsAndTrimsChannelFeedURLs() {
        var info: [String: Any] = ["SUFeedURL": "https://example.com/appcast-swift.xml",
                                   "SUPublicEDKey": "abc="]
        XCTAssertNil(AppUpdater.configuration(from: info)?.stableFeedURL,
                     "缺键 = 未注入（旧构建）")
        XCTAssertNil(AppUpdater.configuration(from: info)?.betaFeedURL, "缺键 = 未注入")
        info["DSHChamberStableFeedURL"] = "  https://example.com/appcast-swift.xml\n"
        info["DSHChamberBetaFeedURL"] = "  https://example.com/appcast-swift-beta.xml\n"
        let configuration = AppUpdater.configuration(from: info)
        XCTAssertEqual(configuration?.stableFeedURL,
                       "https://example.com/appcast-swift.xml", "trim 后再取")
        XCTAssertEqual(configuration?.betaFeedURL,
                       "https://example.com/appcast-swift-beta.xml", "trim 后再取")
        info["DSHChamberStableFeedURL"] = "   "
        info["DSHChamberBetaFeedURL"] = 42
        XCTAssertNil(AppUpdater.configuration(from: info)?.stableFeedURL,
                     "空白占位 = 未注入（模板空串）")
        XCTAssertNil(AppUpdater.configuration(from: info)?.betaFeedURL, "非字符串 = 未注入")
    }

    /// feed 选择：channel 决定用哪条注入 URL；旧构建 / 未注入 / 形状坏一律回 nil
    /// 走 Info.plist 的 SUFeedURL（绝不把 URL 硬编码进壳）。
    func testResolvedFeedURLSelectsPerChannelAndFallsBackWithoutPair() {
        let key = Data(repeating: 0, count: 32).base64EncodedString()
        let stableURL = "https://example.com/appcast-swift.xml"
        let betaURL = "https://example.com/appcast-swift-beta.xml"
        func config(stable: String?, beta: String?) -> AppUpdater.Configuration {
            AppUpdater.Configuration(feedURL: stableURL, publicKey: key,
                                     automaticChecks: true, checkInterval: nil,
                                     stableFeedURL: stable, betaFeedURL: beta)
        }
        let pair = config(stable: stableURL, beta: betaURL)
        XCTAssertEqual(AppUpdater.resolvedFeedURL(channel: .stable, configuration: pair),
                       stableURL,
                       "stable 通道 → stable URL（beta 构建烤的 SUFeedURL 必须被覆盖）")
        XCTAssertEqual(AppUpdater.resolvedFeedURL(channel: .beta, configuration: pair),
                       betaURL, "beta 通道 → 滚动 beta URL")
        // 旧构建（两条都没注入）：都回 nil 走 SUFeedURL。
        let old = config(stable: nil, beta: nil)
        XCTAssertNil(AppUpdater.resolvedFeedURL(channel: .stable, configuration: old))
        XCTAssertNil(AppUpdater.resolvedFeedURL(channel: .beta, configuration: old))
        // 半配置：stable 通道仍用已注入的 stable URL；beta 通道不可用（回 nil）。
        let onlyStable = config(stable: stableURL, beta: nil)
        XCTAssertEqual(AppUpdater.resolvedFeedURL(channel: .stable, configuration: onlyStable),
                       stableURL)
        XCTAssertNil(AppUpdater.resolvedFeedURL(channel: .beta, configuration: onlyStable))
        // 形状非法：stable 通道回 nil（坏 URL 绝不交给 Sparkle）。
        let badStable = config(stable: "http://example.com/appcast-swift.xml", beta: betaURL)
        XCTAssertNil(AppUpdater.resolvedFeedURL(channel: .stable, configuration: badStable))
        XCTAssertNil(AppUpdater.resolvedFeedURL(channel: .beta, configuration: badStable))
        XCTAssertNil(AppUpdater.resolvedFeedURL(channel: .stable, configuration: nil))
    }

    /// 安装版本读 Info.plist 的 CFBundleShortVersionString；缺键/空白 → "0.0.0"
    /// （v4 起只用于日志/取证，不参与通道判定）。
    func testAppVersionFallsBackToZero() {
        XCTAssertEqual(AppUpdater.appVersion(from: [:]), "0.0.0")
        XCTAssertEqual(AppUpdater.appVersion(from: ["CFBundleShortVersionString": "1.2.3-beta.4"]),
                       "1.2.3-beta.4")
        XCTAssertEqual(AppUpdater.appVersion(from: ["CFBundleShortVersionString": "  \n"]), "0.0.0")
        XCTAssertEqual(AppUpdater.appVersion(from: ["CFBundleShortVersionString": 42]), "0.0.0")
    }

    /// 动态 feed 委托必须以 ObjC selector 暴露给 Sparkle（`feedURLStringForUpdater:`）：
    /// Swift 导入名与选择子一旦错配，上面的纯函数测试全绿而 Sparkle 永远拿不到
    /// 注入的通道 URL——这里按**运行时选择子**钉住接缝（本机无 Swift 工具链时它是
    /// 唯一能证明「委托真的接上」的判据）。
    func testFeedURLStringDelegateIsExposedToObjC() {
        let shared: NSObject = AppUpdater.shared
        XCTAssertTrue(shared.responds(to: NSSelectorFromString("feedURLStringForUpdater:")),
                      "SPUUpdaterDelegate.feedURLStringForUpdater: 的 Swift 实现必须对 ObjC 可见")
    }

    /// 运行期入口在无装配时绝不崩、绝不改通道（loud 拒绝日志由实现打印）。
    func testApplyBetaUpdatesWithoutUpdaterKeepsStableChannel() {
        let updater = AppUpdater.shared
        XCTAssertEqual(updater.channel, .stable)
        updater.applyBetaUpdates(true)
        XCTAssertEqual(updater.channel, .stable, "通道 URL 对不可用时订阅绝不改通道")
        updater.applyBetaUpdates(false)
        XCTAssertEqual(updater.channel, .stable)
    }

    /// 装配输入契约（v4）：模板的**两条**通道 URL 占位符渲染后必须成为
    /// Configuration.stableFeedURL / betaFeedURL，且成对可用——占位符名是壳与
    /// 装配腿（build-swift-app 的 --sparkle-stable-feed / --sparkle-beta-feed）
    /// 之间的文本契约。
    func testInfoPlistTemplateRendersIntoChannelFeedConfiguration() throws {
        var xml = try infoPlistTemplate()
        let publicKey = Data(repeating: 0, count: 32).base64EncodedString()
        let replacements = [
            "__VERSION__": "1.2.3",
            "__BUNDLE_VERSION__": "1.2.3.999999999",
            "__SPARKLE_FEED_URL__": "https://example.com/appcast-swift.xml",
            "__SPARKLE_PUBLIC_ED_KEY__": publicKey,
            "__SPARKLE_STABLE_FEED_URL__": "https://example.com/appcast-swift.xml",
            "__SPARKLE_BETA_FEED_URL__": "https://example.com/appcast-swift-beta.xml",
        ]
        for (placeholder, value) in replacements {
            xml = xml.replacingOccurrences(of: placeholder, with: value)
        }
        let parsed = try PropertyListSerialization.propertyList(from: Data(xml.utf8), format: nil)
        let plist = try XCTUnwrap(parsed as? [String: Any], "渲染后的模板必须是合法 Info.plist")
        let configuration = try XCTUnwrap(AppUpdater.configuration(from: plist))
        XCTAssertEqual(configuration.feedURL, "https://example.com/appcast-swift.xml")
        XCTAssertEqual(configuration.stableFeedURL,
                       "https://example.com/appcast-swift.xml",
                       "模板必须声明 DSHChamberStableFeedURL 占位符 __SPARKLE_STABLE_FEED_URL__")
        XCTAssertEqual(configuration.betaFeedURL,
                       "https://example.com/appcast-swift-beta.xml",
                       "模板必须声明 DSHChamberBetaFeedURL 占位符 __SPARKLE_BETA_FEED_URL__")
        XCTAssertNil(AppUpdater.betaSubscriptionProblem(for: configuration),
                     "渲染后的装配输入必须让通道切换可用（两条 URL 成对）")
        XCTAssertNil(AppUpdater.configurationError(for: configuration),
                     "渲染后的装配输入必须是合法形状")
    }

    /// Info.plist.template 的 UTF-8 文本（#filePath = macos/Tests/DSHChamberTests/…）。
    private func infoPlistTemplate() throws -> String {
        let macosDir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // DSHChamberTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // macos
        let data = try Data(contentsOf: macosDir.appendingPathComponent("Info.plist.template"))
        return try XCTUnwrap(String(data: data, encoding: .utf8))
    }
}
