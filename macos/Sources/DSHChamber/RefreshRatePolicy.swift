//
//  RefreshRatePolicy.swift
//  DSHChamber
//
//  ProMotion / 120Hz 刷新率策略（design 25 §5.1）。两个事实源：
//    - WebKit 偏好 PreferPageRenderingUpdatesNear60FPSEnabled（默认 true）：页面
//      渲染更新「靠近 60fps」而不是显示器刷新率（准确说只在 nominal > 60 时起作用，
//      61–119Hz 屏因整数商为 1 本就不受限）。本壳在用该 configuration 构造
//      WKWebView **之前** 关掉它（DSHChamberWebKitSupport，私有 SPI）。
//    - 低电量模式：WebKit 把半速节流理由（LowPowerMode / NonInteractedCrossOriginFrame /
//      VisuallyIdle / AggressiveThermalMitigation）统一折算为帧间隔 ×2（IntervalThrottlingFactor，
//      见 WebCore/platform/graphics/AnimationFrameRate.cpp）。该状态由 WebContent
//      进程内的 LowPowerModeNotifier 直读系统状态；应用侧没有公开开关，私有注入面
//      （_WKProcessPoolConfiguration.injectedBundleURL；所属类自 macOS 12 起 deprecated，
//      属性本身无单独注解）虽存在但本壳未采用也未实测——本类型只如实折算并写日志，绝不假装消除。
//
//  本文件是纯逻辑（只有 apply(to:) 一处 SPI 桥接）：上限折算与启动日志可单测。
//
import DSHChamberWebKitSupport
import Foundation
import WebKit

/// 页面渲染更新偏好（镜像 C 侧 DSHChamberRefreshRatePreference）。
enum RefreshRatePreference: Equatable {
    /// 已关闭 WebKit 的 prefer-60fps：跟随显示器最大刷新率。
    case displayRate
    /// WebKit 默认：更新靠近 60fps。
    case nearSixty
    /// SPI 不可用（未来 OS 移除该偏好）：行为等同 nearSixty。
    case unknown
}

extension RefreshRatePreference {
    /// C 侧 DSHChamberRefreshRatePreference 的直译：单一事实源是 C 枚举 case，
    /// Swift 侧不手抄 raw 值（raw 值/形状漂移由 RefreshRatePolicyTests 的锁步门钉住）。
    init(cValue: DSHChamberRefreshRatePreference) {
        switch cValue {
        case .unknown: self = .unknown
        case .displayRate: self = .displayRate
        case .nearSixty: self = .nearSixty
        // C 侧将来新增 case 时靠**编译期**暴露：显式 case 之外还缺 case 会得到
        // "switch must be exhaustive … add missing case"（加第 4 个 case 实测为 warning；
        // Swift 6 / warnings-as-errors 下为 error）。运行期不额外报警，未知值静默
        // 映射 .unknown，日志按「SPI 不可用」如实记录。
        @unknown default: self = .unknown
        }
    }
}

enum RefreshRatePolicy {
    /// WebKit FullSpeedFramesPerSecond（AnimationFrameRate.h）。
    static let webKitFullSpeedFramesPerSecond = 60
    /// WebKit IntervalThrottlingFactor（低电量模式等半速节流）。
    static let lowPowerModeIntervalFactor = 2
    /// WebKit framesPerSecondNearestFullSpeed() 的同构移植
    /// （WebCore/platform/graphics/AnimationFrameRate.cpp）。
    static func nearestFullSpeedFramesPerSecond(_ nominalFramesPerSecond: Int) -> Int {
        guard nominalFramesPerSecond > webKitFullSpeedFramesPerSecond else { return nominalFramesPerSecond }
        // **整数除法**：上游两操作数都是 unsigned（AnimationFrameRate.h: FramesPerSecond =
        // unsigned、FullSpeedFramesPerSecond = 60），所以 fullSpeedRatio 恒为整数 ⇒ 上游那个
        // 「ratio - floor(ratio) <= 0.5 ? floorSpeed : ceilSpeed」恒取 floorSpeed。
        // 例：100Hz→100、165Hz→82、120Hz→60、144Hz→72（浮点近似会在 100/165 上算错）。
        let fullSpeedRatio = nominalFramesPerSecond / webKitFullSpeedFramesPerSecond
        return nominalFramesPerSecond / fullSpeedRatio
    }

    /// 页面渲染更新上限（fps）折算，供启动日志与真机验收对照。
    /// nil = 刷新率未知（窗口还没有所在屏）。
    /// 注：上限未知或 == 60 时上游走「15ms / 低电量 30ms」常量分支，其 **fps 域定义就是
    /// 60 / 30**（preferredFramesPerSecond()，以及 preferredFramesPerSecondFromInterval()
    /// 把这两个 interval 归一回 60/30）；15ms/30ms 只是调度松弛量。不要「修正」成
    /// 66.7 / 33.3——那不是 WebKit 的 fps 口径。
    static func effectiveCeiling(displayRefreshRate: Int?,
                                 lowPowerMode: Bool,
                                 preference: RefreshRatePreference) -> Int? {
        guard let display = displayRefreshRate, display > 0 else { return nil }
        let base = preference == .displayRate ? display : nearestFullSpeedFramesPerSecond(display)
        return lowPowerMode ? max(1, base / lowPowerModeIntervalFactor) : base
    }

    /// 关闭 WebKit 的 prefer-60fps 偏好。**必须在 WKWebView 创建前调用**
    /// （页面创建后再改实测不生效）。SPI 缺失时返回 .unknown，不致命。
    static func apply(to preferences: WKPreferences) -> RefreshRatePreference {
        RefreshRatePreference(cValue: DSHChamberPreferDisplayRefreshRate(preferences))
    }

    /// 启动日志：把「显示器刷新率 / 偏好状态 / 低电量模式 / 折算上限」写成一行，
    /// 该行是实机对表的基准（见 design 25 §5.1）。
    static func startupLogLine(preference: RefreshRatePreference,
                               displayRefreshRate: Int?,
                               displayRefreshRateIsPanelMaximum: Bool,
                               lowPowerMode: Bool) -> String {
        let preferenceText: String
        switch preference {
        case .displayRate: preferenceText = "已关闭(跟随显示器刷新率)"
        case .nearSixty: preferenceText = "WebKit 默认(靠近 60fps)"
        case .unknown: preferenceText = "SPI 不可用(保持 WebKit 默认)"
        }
        // 回落取面板上限时必须显式标注，不能写成「当前模式」（SDK: maximumFramesPerSecond
        // 是屏幕支持的最大值，不是当前模式值）。
        let displayText = displayRefreshRate.map {
            "\($0)fps（\(displayRefreshRateIsPanelMaximum ? "面板上限" : "当前模式")）"
        } ?? "未知"
        var line = "[shell] 刷新率：显示器刷新率 \(displayText)；prefer-60fps 偏好=\(preferenceText)；低电量模式=\(lowPowerMode ? "开" : "关")"
        if let ceiling = effectiveCeiling(displayRefreshRate: displayRefreshRate,
                                          lowPowerMode: lowPowerMode,
                                          preference: preference) {
            line += " → 页面更新上限约 \(ceiling)fps"
        }
        if lowPowerMode {
            line += "（低电量模式是系统级策略：WebKit 帧间隔 ×2，应用侧不可覆盖；关闭低电量模式即可恢复显示器刷新率）"
        }
        return line
    }
}
