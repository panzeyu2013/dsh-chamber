import AppKit
import Foundation
import Sparkle

/// 原生壳的应用内更新器（2026-12 裁决 D-1 选 B / 台账 S-01）：Sparkle 2 承担
/// 检查 → 下载 → 重启并安装整条腿。与 Electron flavor 的语义对齐，实现方式换成
/// macOS 的通行方案（Sparkle + appcast + EdDSA 签名）。
///
/// 装配形态：
/// - Info.plist 同时有 SUFeedURL 与 SUPublicEDKey 才视为可用（build-swift-app 在
///   装配期替换这两个占位符）。缺任一（dev / dry-run / 未配密钥）→ 不可用：
///   「检查更新…」菜单项禁用，也绝不向 sidecar 谎称能自动安装。
/// - 自动检查默认关，由 SUEnableAutomaticChecks 决定：ad-hoc/未发布装配若启动即
///   弹更新窗会与启动期窗口竞争（社区实现踩过），只有配好 appcast 的正式装配才
///   把它写成 true。
/// - 安装前回调：Sparkle 替换 bundle 期间不能留着活着的 sidecar/本地 dsh，故
///   willInstallUpdate 里先跑 onWillInstall（AppDelegate 注入清理链）。
final class AppUpdater: NSObject, SPUUpdaterDelegate {

    static let shared = AppUpdater()

    /// 由 Info.plist 解析出的配置（纯值，单测直测）。
    struct Configuration: Equatable {
        let feedURL: String
        let publicKey: String
        let automaticChecks: Bool
        let checkInterval: TimeInterval?
    }

    /// Info.plist → 配置；缺键 / 空白串 → nil（= 更新不可用）。
    static func configuration(from info: [String: Any]) -> Configuration? {
        guard let feed = (info["SUFeedURL"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines), !feed.isEmpty,
              let key = (info["SUPublicEDKey"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty
        else { return nil }
        return Configuration(
            feedURL: feed,
            publicKey: key,
            automaticChecks: (info["SUEnableAutomaticChecks"] as? Bool) ?? false,
            checkInterval: (info["SUScheduledCheckInterval"] as? NSNumber)?.doubleValue
        )
    }

    /// 安装前清理回调（AppDelegate 注入：停 sidecar、收 keep-awake/角标）。
    var onWillInstall: (() -> Void)?

    private(set) var configuration: Configuration?
    private var controller: SPUStandardUpdaterController?

    /// 更新是否已装配（配置齐 + updater 已起）。
    var isAvailable: Bool { controller != nil }

    /// Sparkle 自己的可用性门（检查中/安装中为 false）——菜单项据此 enable。
    var canCheckForUpdates: Bool { controller?.updater.canCheckForUpdates ?? false }

    private override init() { super.init() }

    /// 装配期启动（applicationDidFinishLaunching 调用；必须主线程）。
    @discardableResult
    func start(info: [String: Any] = Bundle.main.infoDictionary ?? [:],
               startUpdater: Bool = true) -> Bool {
        guard let configuration = Self.configuration(from: info) else {
            print("[poc] Sparkle 更新不可用：Info.plist 缺 SUFeedURL/SUPublicEDKey"
                + "（dev 或未配置密钥的装配）——「检查更新…」保持禁用")
            return false
        }
        let controller = SPUStandardUpdaterController(startingUpdater: false,
                                                     updaterDelegate: self,
                                                     userDriverDelegate: nil)
        controller.updater.automaticallyChecksForUpdates = configuration.automaticChecks
        if let interval = configuration.checkInterval, interval > 0 {
            controller.updater.updateCheckInterval = interval
        }
        if startUpdater { controller.startUpdater() }
        self.controller = controller
        self.configuration = configuration
        print("[poc] Sparkle 更新已装配（feed=\(configuration.feedURL)，"
            + "自动检查=\(configuration.automaticChecks)）")
        return true
    }

    /// 用户发起的检查（App 菜单「检查更新…」；页面更新按钮经 edge 走同一入口）。
    @objc func checkForUpdates(_ sender: Any?) {
        guard let controller else {
            print("[poc] 检查更新被忽略：Sparkle 未装配（缺 feed/公钥）")
            return
        }
        controller.checkForUpdates(sender)
    }

    // MARK: - SPUUpdaterDelegate

    /// Sparkle 替换 bundle 前先停受管进程（安装路径不保证先走我们的退出链）。
    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        print("[poc] Sparkle 即将安装 \(item.displayVersionString)："
            + "先停受管 sidecar / 收 keep-awake 与角标")
        onWillInstall?()
    }
}
