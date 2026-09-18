//
//  RefreshRatePolicyTests.swift
//  DSHChamberPocTests
//
//  S-48：刷新率折算的纯逻辑门。期望值有两类来源，别混读：
//    ① 实机实测（M5 Pro / 内置 120Hz 屏；design 25 §5.1 / deviations S-48）：
//       WebKit 默认偏好 + 插电 → rAF 60.0fps；关闭偏好 + 插电 → 120.0fps；
//       WebKit 默认偏好 + 低电量模式 → 30.0fps。
//    ② 上游算法/常量推导（AnimationFrameRate.{h,cpp}）：其余用例（100/144/165/240 的
//       整数除法取整、低电量 ×2、SPI 缺失时按 WebKit 默认）是同式推论，不是实测值。
//
import DSHChamberWebKitSupport
import WebKit
import XCTest
@testable import DSHChamberPoc

final class RefreshRatePolicyTests: XCTestCase {

    func testNearestFullSpeedMatchesWebKitAlgorithm() {
        // WebCore/platform/graphics/AnimationFrameRate.{h,cpp}：
        //   nominal <= 60 → nominal；否则 ratio = nominal / 60 是**整数除法**
        //   （两操作数 unsigned），实际恒取 nominal / ratio。
        XCTAssertEqual(RefreshRatePolicy.nearestFullSpeedFramesPerSecond(60), 60)
        XCTAssertEqual(RefreshRatePolicy.nearestFullSpeedFramesPerSecond(120), 60,
                       "120Hz + WebKit 默认偏好 = 60fps（实测值）")
        XCTAssertEqual(RefreshRatePolicy.nearestFullSpeedFramesPerSecond(144), 72)
        XCTAssertEqual(RefreshRatePolicy.nearestFullSpeedFramesPerSecond(240), 60)
        XCTAssertEqual(RefreshRatePolicy.nearestFullSpeedFramesPerSecond(48), 48)
        // 非 60 整数倍屏：上游是整数除法，不是"就近取整"（浮点近似会把 100 算成 50、165 算成 55）
        XCTAssertEqual(RefreshRatePolicy.nearestFullSpeedFramesPerSecond(100), 100)
        XCTAssertEqual(RefreshRatePolicy.nearestFullSpeedFramesPerSecond(165), 82)
    }

    func testDisplayRatePreferenceFollowsPanel() {
        XCTAssertEqual(RefreshRatePolicy.effectiveCeiling(
            displayRefreshRate: 120, lowPowerMode: false, preference: .displayRate), 120,
            "关闭 prefer-60fps 后跟随显示器（实测 120.0fps）")
        XCTAssertEqual(RefreshRatePolicy.effectiveCeiling(
            displayRefreshRate: 60, lowPowerMode: false, preference: .displayRate), 60)
    }

    func testWebKitDefaultPreferenceCapsNearSixty() {
        XCTAssertEqual(RefreshRatePolicy.effectiveCeiling(
            displayRefreshRate: 120, lowPowerMode: false, preference: .nearSixty), 60,
            "未关偏好时 120Hz 屏上 rAF 恒 60fps（实测值）")
        // 该偏好对 61–119Hz（整数商 1）是 no-op：100Hz 屏即使不关偏好也是 100fps，直接钉住。
        XCTAssertEqual(RefreshRatePolicy.effectiveCeiling(
            displayRefreshRate: 100, lowPowerMode: false, preference: .nearSixty), 100,
            "整数商 1：该偏好对 100Hz 类屏不产生限制")
    }

    func testLowPowerModeHalvesTheCeiling() {
        XCTAssertEqual(RefreshRatePolicy.effectiveCeiling(
            displayRefreshRate: 120, lowPowerMode: true, preference: .nearSixty), 30,
            "低电量模式 ×2 帧间隔：WebKit 默认偏好下 60 → 30fps（实测值）")
        XCTAssertEqual(RefreshRatePolicy.effectiveCeiling(
            displayRefreshRate: 120, lowPowerMode: true, preference: .displayRate), 60,
            "关闭偏好后低电量模式回到 60fps")
        // nominal == 60：上游走「15ms / 低电量 30ms」常量分支，fps 域定义即 60 / 30
        // （preferredFramesPerSecond 与 preferredFramesPerSecondFromInterval 都返回这两个
        // 常量），不是 66.7 / 33.3。
        XCTAssertEqual(RefreshRatePolicy.effectiveCeiling(
            displayRefreshRate: 60, lowPowerMode: true, preference: .displayRate), 30)
    }

    func testUnknownPreferenceBehavesLikeWebKitDefault() {
        XCTAssertEqual(RefreshRatePolicy.effectiveCeiling(
            displayRefreshRate: 120, lowPowerMode: false, preference: .unknown), 60,
            "SPI 不可用时必须按 WebKit 默认折算，绝不虚报 120")
    }

    func testUnknownDisplayYieldsNilCeiling() {
        XCTAssertNil(RefreshRatePolicy.effectiveCeiling(
            displayRefreshRate: nil, lowPowerMode: false, preference: .displayRate))
        XCTAssertNil(RefreshRatePolicy.effectiveCeiling(
            displayRefreshRate: 0, lowPowerMode: false, preference: .displayRate))
    }

    func testStartupLogLineCarriesAllFacts() {
        let line = RefreshRatePolicy.startupLogLine(
            preference: .displayRate,
            displayRefreshRate: 120,
            displayRefreshRateIsPanelMaximum: false,
            lowPowerMode: false)
        XCTAssertTrue(line.contains("显示器刷新率 120fps"), line)
        XCTAssertTrue(line.contains("已关闭(跟随显示器刷新率)"), line)
        XCTAssertTrue(line.contains("低电量模式=关"), line)
        XCTAssertTrue(line.contains("页面更新上限约 120fps"), line)

        let lpmLine = RefreshRatePolicy.startupLogLine(
            preference: .displayRate,
            displayRefreshRate: 120,
            displayRefreshRateIsPanelMaximum: false,
            lowPowerMode: true)
        XCTAssertTrue(lpmLine.contains("低电量模式=开"), lpmLine)
        XCTAssertTrue(lpmLine.contains("页面更新上限约 60fps"), lpmLine)
        XCTAssertTrue(lpmLine.contains("应用侧不可覆盖"), lpmLine)

        let unknownLine = RefreshRatePolicy.startupLogLine(
            preference: .unknown,
            displayRefreshRate: nil,
            displayRefreshRateIsPanelMaximum: false,
            lowPowerMode: false)
        XCTAssertTrue(unknownLine.contains("SPI 不可用(保持 WebKit 默认)"), unknownLine)
        XCTAssertTrue(unknownLine.contains("显示器刷新率 未知"), unknownLine)

        // 回落分支：值来自面板规格，必须标注「面板上限」，不能冒充当前模式。
        let panelMaximumLine = RefreshRatePolicy.startupLogLine(
            preference: .displayRate,
            displayRefreshRate: 120,
            displayRefreshRateIsPanelMaximum: true,
            lowPowerMode: false)
        XCTAssertTrue(panelMaximumLine.contains("显示器刷新率 120fps（面板上限）"), panelMaximumLine)
        XCTAssertFalse(panelMaximumLine.contains("（当前模式）"), panelMaximumLine)
    }

    /// S-48 锁步门：C 头文件声明 Unknown/NearSixty/DisplayRate = 0/1/2，且必须能被
    /// Swift 直译成同一语义。**改 raw 值或改序**在这里变红；**C 侧新增第 4 个 case 不在这条
    /// 测试的覆盖内**——由编译器穷尽性诊断暴露（见 RefreshRatePreference.init(cValue:)，2026-12
    /// 实测为 warning），所以两处注释是互补的，不要只依赖其一。
    func testCEnumMirrorIsStableAndBridgesEveryCase() {
        XCTAssertEqual(DSHChamberRefreshRatePreference.unknown.rawValue, 0)
        XCTAssertEqual(DSHChamberRefreshRatePreference.nearSixty.rawValue, 1)
        XCTAssertEqual(DSHChamberRefreshRatePreference.displayRate.rawValue, 2)
        XCTAssertEqual(RefreshRatePreference(cValue: .unknown), .unknown)
        XCTAssertEqual(RefreshRatePreference(cValue: .nearSixty), .nearSixty)
        XCTAssertEqual(RefreshRatePreference(cValue: .displayRate), .displayRate)
    }

    /// 真实 SPI 路径的金丝雀。**不能用 XCTSkip**：scripts/gates/run-swift-tests.mjs 把任何
    /// skip 判为整条 macOS 腿失败（G2：XCTSkip 计数必须为 0），退役信号会被误报成门禁违规。
    /// 因此这里两条分支都是硬断言：SPI 在就必须关得动；SPI 不在就断言"诚实降级"语义成立，
    /// 并打印显式信号要求复核 S-48 退役判据。两条分支 skipped 都为 0。
    /// 排查提示：若在受管（MDM/配置描述文件）机器上此测试变红，先看是不是策略把该 WebKit
    /// feature 锁成开启——那时"SPI 在但关不动"并非本仓回归。
    func testApplyReportsDisplayRateWhenSPIAvailable() {
        let applied = RefreshRatePolicy.apply(to: WKPreferences())
        if applied == .unknown {
            // 区分两种原因：真 SPI 缺失（未来 OS 移除该偏好）vs SPI 仍在但 key/调用坏了
            // ——后者是本次改动的回归，必须硬红，不能按"退役"放过。
            let spiPresent = WKPreferences.responds(to: NSSelectorFromString("_features"))
            XCTAssertFalse(spiPresent,
                           "SPI 仍在却读不到偏好：这是 feature key 或调用路径的回归，不是 OS 变更")
            print("[S-48] WebKit SPI 不可用 → 触发退役判据复核（见 deviations S-48）")
            XCTAssertEqual(RefreshRatePolicy.effectiveCeiling(
                displayRefreshRate: 120, lowPowerMode: false, preference: .unknown), 60,
                "SPI 缺失时必须按 WebKit 默认降级（120Hz 屏 → 60fps 上限）")
        } else {
            XCTAssertEqual(applied, .displayRate, "SPI 在就必须真的关得动该偏好")
        }
    }

    // MARK: - S-48 接线锁步（仿 NativeShellLogTests：直接读源码断言）

    /// 硬时序不变量：关偏好必须发生在构造 WKWebView 之前（建页后再改实测不生效）。
    /// 顺序被挪动时这里变红——注释不会响，这个断言会。
    func testRefreshRatePreferenceIsAppliedBeforeWebViewCreation() throws {
        // 去掉注释行再断言（2026-12 独立复核发现）：被注释掉的 apply 调用会让
        // 「出现 + 顺序」两条断言在策略实际被停用时仍然全绿。
        let controller = try source("Sources/DSHChamberPoc/MainWindowController.swift")
            .split(separator: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
        let applyIndex = try XCTUnwrap(
            controller.range(of: "RefreshRatePolicy.apply(to: configuration.preferences)")?.lowerBound,
            "MainWindowController 必须调用 RefreshRatePolicy.apply(to: configuration.preferences)")
        // 锚在真正的构造语句上（"WKWebView(frame:" 也出现在装配注释里，
        // 用注释匹配会让这条断言失效）。
        let webViewIndex = try XCTUnwrap(
            controller.range(of: "let webView = WKWebView(frame:")?.lowerBound,
            "MainWindowController 必须构造 WKWebView(frame:configuration:)")
        XCTAssertLessThan(applyIndex, webViewIndex,
                          "S-48：关偏好必须在建 WKWebView 之前（建页后再改不生效）")
        // 只有一处 apply：多处时上面的"首个匹配"顺序断言会漏掉后来者。
        XCTAssertEqual(controller.components(separatedBy: "RefreshRatePolicy.apply(to:").count, 2,
                       "只应存在一处 RefreshRatePolicy.apply(to:) 调用点")
    }

    /// S-48 打包面锁步：C support target 必须保持静态——一旦声明 type: .dynamic，可执行会多出
    /// 一个需随包嵌入并签名的 dylib，而 macos/scripts 的装配断言不覆盖这种漂移。
    func testWebKitSupportTargetStaysStatic() throws {
        let package = try source("Package.swift")
        XCTAssertTrue(package.contains("name: \"DSHChamberWebKitSupport\""),
                      "Package.swift 里找不到 DSHChamberWebKitSupport target")
        // 去掉注释行再断言：SwiftPM 允许参数乱序，只截 anchor 之后一段会漏掉写在前面的
        // type: .dynamic；而 Package.swift 的说明注释里正好也提到这个词。
        let code = package.split(separator: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
        XCTAssertFalse(code.contains("type: .dynamic"),
                       "本包不应有 dynamic target——DSHChamberWebKitSupport 必须静态链入；"
                       + "若将来确实需要 dynamic，请把本断言收紧到该 target 的声明块并说明装配改动")
    }

    private func source(_ relative: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent(relative)
        return try String(contentsOf: url, encoding: .utf8)
    }
}
