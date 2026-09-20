import AppKit
import Foundation
import Sparkle

/// 原生壳的应用内更新器（2026-12 裁决 D-1 选 B / 台账 S-01）：Sparkle 2 承担
/// 检查 → 下载 → 重启并安装整条腿。与 Electron flavor 的语义对齐，实现方式换成
/// macOS 的通行方案（Sparkle + appcast + EdDSA 签名）。
///
/// 装配形态：
/// - Info.plist 同时有 SUFeedURL 与 SUPublicEDKey、且 feed 是 https、公钥是
///   base64 的 32 字节 Ed25519 公钥，**并**成功 startUpdater 才视为可用
///   （build-swift-app 在装配期替换这两个占位符；S-38：坏配置在装配期就被折成
///   诚实不可用 + 原因，页面拿到 error 而不是停在 checking）。缺任一（dev /
///   dry-run / 未配密钥）→ 不可用：「检查更新…」菜单项禁用，也绝不向 sidecar
///   谎称能自动安装。
/// - 自动检查开（模板常量 SUEnableAutomaticChecks=true + SUScheduledCheckInterval
///   =21600s，见 Info.plist.template）：每次启动强制一次**后台**检查
///   （checkForUpdatesInBackground，Sparkle 官方推荐的每启动一次补充检查），之后
///   由 Sparkle 的调度器按 6h 间隔（updater.ts CHECK_INTERVAL_MS 同值）继续；
///   ad-hoc / 未配 feed 的装配仍因缺配置而完全不可用，不存在启动即弹窗的竞争。
///   S-37 残余（有意记录，不静默）：Sparkle 把 lastUpdateCheckDate 持久化在
///   user defaults，并在「scheduled 找到更新、展示权归壳（页面投影）」期间保持
///   会话打开——这段会话里 Sparkle 与壳都不再发起新的后台检查，直到用户在
///   Sparkle 标准窗内作出选择或应用重启；下次启动的强制检查因此是唯一保证的
///   恢复点。Electron 的进程内 6h setInterval 没有会话依赖，这是两端节奏语义的
///   唯一剩余差异。
/// - scheduled 更新不弹 Sparkle 标准窗：SPUStandardUserDriverDelegate 把展示权
///   收回本类（supportsGentleScheduledUpdateReminders=true +
///   standardUserDriverShouldHandleShowingScheduledUpdate 返回 false），只把
///   available 相位经 nativeUpdatePhase 投到设置页；用户发起的「检查更新…」
///   （页面按钮 / App 菜单）仍走标准 Sparkle 窗口，与今天完全一致。
/// - 安装前回调：Sparkle 替换 bundle 期间不能留着活着的 sidecar/本地 dsh，故
///   willInstallUpdate 里先跑 onWillInstall（AppDelegate 注入清理链）。
/// - 阶段上报（S-19/S-20）：SPUUpdaterDelegate 回调经 note 投影成页面同款七值
///   阶段，再由 AppDelegate 经冻结线 __host.nativeUpdatePhase
///   {phase, version, error} 交 sidecar（sidecar 映射进 update-state 投影）。
/// - 退出时安装（S-01，2026-12 复核）：**不实现** willInstallUpdateOnQuit——
///   该回调只在 automaticallyDownloadsUpdates=true 的 automatic-update driver 里
///   被调用；Electron 侧是 autoInstallOnAppQuit=true **且 autoDownload=false**
///   （updater.ts:947-948），接线自动下载会引入 Electron 没有的后台自动下载。
///   用户可见的「已下载，退出时安装」仍由 Sparkle 标准 resumable 路径承担：
///   标准窗内下载完成后可选择立即安装/退出时安装，阶段经 didDownloadUpdate →
///   downloaded 投到页面；钩子删除后不再有零调用的潜伏声明。
///
/// 为什么是 appcast，且为什么 feed 指向我们自己的 release 资产：
/// - **协议**：Sparkle 只理解 appcast——一份签名 XML，条目携带版本、最低系统
///   版本与 enclosure（更新包 URL / 长度 / EdDSA 签名）。没有 appcast 就没有
///   Sparkle 能消费的更新描述；GitHub 的 releases API 或 latest-mac.yml 都不是
///   它的协议。页面「检查更新」经冻结边 updateNativeAction kind=check 落到本类
///   checkForUpdates，与 App 菜单「检查更新…」是同一入口、同一 appcast。
/// - **信任锚**：SUPublicEDKey 是内置公钥，appcast 与 enclosure 由发布腿的
///   EdDSA 私钥签名、壳内验签通过才允许安装——feed 被替换或重定向也签不出可
///   安装的包。Developer ID 保护「包能不能运行」，EdDSA 保护「是不是我们的
///   更新」，两者缺一不可。
/// - **自有 release 资产**：feed 指向本仓自己的 release
///   （github.com/panzeyu2013/dsh-chamber/releases/...），不引第三方 host——
///   更新包与 appcast 与代码同源、同 tag 上传（stable =
///   releases/latest/download/appcast-swift.xml；beta 每次覆盖滚动 tag
///   appcast-swift-beta 上的同名 asset，beta.N 因此能发现 beta.N+1），供应链
///   最短；GitHub 只是只读分发面，EdDSA 私钥从不离开发布环境。
final class AppUpdater: NSObject, SPUUpdaterDelegate, SPUStandardUserDriverDelegate, NSMenuItemValidation {

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

    /// 配置的静态校验（S-38；纯函数，单测直测）：feed 必须 https（Sparkle/ATS 拒绝
    /// 明文），公钥必须是 base64 的 32 字节（Ed25519 公钥长度）。Sparkle 自己的
    /// 配置检查只覆盖 feed/XPC 服务，密钥错误要等下载验签才炸——壳在装配期就把它
    /// 变成诚实不可用 + 原因，页面因此不会停在 checking。
    static func configurationError(for configuration: Configuration) -> String? {
        guard let url = URL(string: configuration.feedURL),
              url.scheme?.lowercased() == "https",
              url.host?.isEmpty == false
        else {
            // 本地化：updater.feedMustBeHTTPS（%@ = 当前 feed）；reason 追加在
            // native-updater-misconfigured: 前缀之后（前缀是页面侧机器可读协议，不动）。
            return NativeText.format(.updaterFeedMustBeHTTPS, configuration.feedURL)
        }
        guard let key = Data(base64Encoded: configuration.publicKey), key.count == 32 else {
            // 本地化：updater.publicKeyInvalid（同上，经能力面/相位回页面）。
            return NativeText.string(.updaterPublicKeyInvalid)
        }
        return nil
    }

    /// S-37：是否在 startUpdater 之后强制一次后台检查（每启动一次）——Electron
    /// 每次启动 15s 后静默首检，Sparkle 的持久化 lastUpdateCheckDate 会在「距上次
    /// < 6h」时跳过，因此壳补一次显式后台检查（官方推荐：仅在自动检查开启时、紧跟
    /// startUpdater 调用）。纯函数，单测直测。
    static func shouldForceLaunchBackgroundCheck(configuration: Configuration?, startUpdater: Bool) -> Bool {
        startUpdater && (configuration?.automaticChecks ?? false)
    }

    /// 原生更新动作的 kind（P-15/S-39 冻结语义）：check = 用户发起的检查；
    /// download/install = 把 Sparkle 标准更新窗口带到前台（下载/安装都在该窗口内
    /// 完成）。Sparkle 2 没有「只下载某个已发现更新」的公开 API——checkForUpdates
    /// 的公开语义恰是「显示/聚焦当前更新，或开始一次新检查」（SPUUpdater.h:99-105），
    /// 因此 download 与 install 都走同一入口，区别在用户在标准窗里按哪个按钮。
    enum NativeUpdateActionKind: String, CaseIterable {
        case check
        case download
        case install
    }

    /// 动作回执（S-38/S-39：拒绝必须携带真实原因，绝不假 ok:true）。
    enum NativeUpdateActionOutcome: Equatable {
        case accepted
        case refused(reason: String)
    }

    /// 不可用原因（能力面与动作拒绝共用；S-38）。已启动的更新器为 nil。
    var unavailableReason: String {
        if let availabilityError { return "native-updater-misconfigured:\(availabilityError)" }
        if controller == nil { return "native-updater-unavailable" }
        return "native-updater-not-started"
    }

    /// 能力面（S-38）：available=false 时携带诚实原因（配置错误/未装配），sidecar
    /// 据此保持 blocked 并记录真实原因；页面 check 拿 ok:false 落 error 相位。
    var capability: (available: Bool, error: String?) {
        (isAvailable, isAvailable ? nil : unavailableReason)
    }

    /// 安装前清理回调（AppDelegate 注入：停 sidecar、收 keep-awake/角标）。
    var onWillInstall: (() -> Void)?

    /// 阶段上报出口（AppDelegate 注入：经 __host.nativeUpdatePhase 交 sidecar）。
    /// 只在 note 判定相位确有变化时调用（去重，见 NativeUpdatePhaseProjector）。
    var onPhase: ((NativeUpdatePhaseReport) -> Void)?

    private(set) var configuration: Configuration?
    private var controller: SPUStandardUpdaterController?
    private var phaseProjector = NativeUpdatePhaseProjector()

    /// 装配/启动失败的真实原因（S-38）：配置形状非法或 startUpdater 抛错时非 nil，
    /// isAvailable 随之为 false，能力面与动作拒绝都携带它。
    private(set) var availabilityError: String?

    /// 更新是否已装配**并真的启动**（配置齐 + 形状合法 + startUpdater 成功）。
    /// 旧实现只看 controller != nil：startUpdater 失败（或坏 EdDSA 公钥）时仍报
    /// available=true，页面 check 被忙门静默吞掉后停在 checking（S-38）。
    var isAvailable: Bool { controller != nil && availabilityError == nil }

    /// Sparkle 自己的可用性门（检查中/安装中为 false）——菜单项据此 enable。
    var canCheckForUpdates: Bool { controller?.updater.canCheckForUpdates ?? false }

    private override init() { super.init() }

    /// 装配期启动（applicationDidFinishLaunching 调用；必须主线程）。
    @discardableResult
    func start(info: [String: Any] = Bundle.main.infoDictionary ?? [:],
               startUpdater: Bool = true) -> Bool {
        guard let configuration = Self.configuration(from: info) else {
            shellLog("[shell] Sparkle 更新不可用：Info.plist 缺 SUFeedURL/SUPublicEDKey"
                + "（dev 或未配置密钥的装配）——「检查更新…」保持禁用")
            return false
        }
        // S-38：形状校验先于启动。坏配置绝不进入「已装配」态——诚实不可用 +
        // 原因（能力面携带），页面 check 拿 error 而不是停在 checking。
        if let error = Self.configurationError(for: configuration) {
            availabilityError = error
            shellLog("[shell] Sparkle 更新不可用：配置错误——\(error)")
            return false
        }
        let controller = SPUStandardUpdaterController(startingUpdater: false,
                                                     updaterDelegate: self,
                                                     userDriverDelegate: self)
        controller.updater.automaticallyChecksForUpdates = configuration.automaticChecks
        if let interval = configuration.checkInterval, interval > 0 {
            controller.updater.updateCheckInterval = interval
        }
        if startUpdater {
            // 直接调 SPUUpdater.startUpdater(error) 而不是 controller.startUpdater()：
            // 后者吞掉错误并弹 Sparkle 自己的 misconfiguration 告警（数秒后），壳
            // 拿不到原因、页面也永远不会收到诚实失败（S-38）。这里拿到错误即降级。
            do {
                // Swift 导入把 SPUUpdater.startUpdater(error:) 重命名为 start()（throws）。
                try controller.updater.start()
            } catch {
                availabilityError = error.localizedDescription
                shellLog("[shell] Sparkle 启动失败（绝不谎报可用）：\(error.localizedDescription)")
                return false
            }
        }
        self.controller = controller
        self.configuration = configuration
        availabilityError = nil
        shellLog("[shell] Sparkle 更新已装配（feed=\(configuration.feedURL)，"
            + "自动检查=\(configuration.automaticChecks)）")
        if Self.shouldForceLaunchBackgroundCheck(configuration: configuration, startUpdater: startUpdater) {
            // S-37：每启动一次的后台检查（不弹窗）。放在下一个 runloop 周期，让
            // startUpdater 排定的 startUpdateCycle 先跑：它按持久化的
            // lastUpdateCheckDate 可能已经发起检查或排了 6h 定时器，这里再补一次
            // 显式后台检查（Sparkle 自带 session/driver 门，重复调用只会响亮跳过）。
            DispatchQueue.main.async { [weak controller] in
                controller?.updater.checkForUpdatesInBackground()
            }
        }
        return true
    }

    /// 用户发起的检查（App 菜单「检查更新…」；页面更新按钮经 edge 走同一入口）。
    /// 返回真实回执（S-38/S-39）——拒绝带原因；AppKit action 面只记录日志。
    @objc func checkForUpdates(_ sender: Any?) {
        if case .refused(let reason) = perform(.check) {
            shellLog("[shell] 检查更新被拒绝：\(reason)")
        }
    }

    /// kind 分派（P-15/S-39；纯入口，单测直测拒绝路径）：
    /// - check：冻结语义（S-19/S-20）——绝不重入 Sparkle 忙态，不启动第二条检查/
    ///   下载，先投 checking 相位；
    /// - download/install：Sparkle 没有「只下载指定已发现更新」的公开 API，公开入口
    ///   checkForUpdates 的语义就是「显示/聚焦当前更新或开始新检查」——把标准更新
    ///   窗口带到前台，下载/安装由窗口内的按钮与真实回调驱动；壳**不合成**假相位。
    /// 不可用/忙都返回 .refused(原因)，绝不回假 ok:true（旧实现恒 ok:true + 静默
    /// no-op）。
    @discardableResult
    func perform(_ kind: NativeUpdateActionKind) -> NativeUpdateActionOutcome {
        guard isAvailable, let controller else {
            return .refused(reason: unavailableReason)
        }
        // Sparkle 自己就是忙态门（检查中/下载中/安装中不接受新会话）。
        guard controller.updater.canCheckForUpdates else {
            return .refused(reason: "native-updater-busy")
        }
        if kind == .check { note(.checkStarted) }
        shellLog("[shell] 原生更新动作：\(kind.rawValue)（交给 Sparkle 标准窗口）")
        controller.checkForUpdates(nil)
        return .accepted
    }

    // MARK: - NSMenuItemValidation（S-39：菜单 enable 实时跟随 canCheckForUpdates）

    /// AppDelegate 构造菜单时按 isAvailable 设过一次 isEnabled——那只是初值：
    /// NSMenu 的自动校验在每次打开菜单时调用本方法（target 实现 NSMenuItemValidation），
    /// 「检查更新…」因此随 Sparkle 的实时可用性（检查/下载/安装中为 false）变化，
    /// 而不是启动快照。非本类 action 的菜单项不归本类管（true = 不干预）。
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard menuItem.action == #selector(Self.checkForUpdates(_:)) else { return true }
        return isAvailable && canCheckForUpdates
    }

    // MARK: - 阶段投影（fake-delegate 单测入口）

    /// SPUUpdaterDelegate 回调（或单测假事件）→ 页面同款阶段。
    func note(_ event: NativeUpdateEvent) {
        guard let report = phaseProjector.apply(event) else { return }
        let version = report.version ?? "nil"
        let error = report.error ?? "nil"
        shellLog("[shell] nativeUpdatePhase \(report.phase.rawValue) version=\(version) error=\(error)")
        onPhase?(report)
    }

    /// 单测复位投影器（@testable 可见；生产无调用点）。
    func resetPhaseProjectionForTesting() {
        phaseProjector = NativeUpdatePhaseProjector()
    }

    // MARK: - SPUStandardUserDriverDelegate（scheduled 展示归原生壳）

    /// 声明支持 gentle scheduled reminders（Sparkle 据此不再告警「后台应用没有
    /// gentle reminder」；展示权仍由下面两个回调决定）。
    var supportsGentleScheduledUpdateReminders: Bool { true }

    /// scheduled 更新的展示权恒 false：不使用 Sparkle 标准窗，交本类把 available
    /// 相位投到设置页。纯函数接缝——单测不构造 SUAppcastItem 也能钉住该决策。
    /// （immediateFocus 只是 Sparkle 对展示时机的提示；页面展示与时机无关。）
    static func shouldHandleShowingScheduledUpdate(immediateFocus: Bool) -> Bool { false }

    /// 应用展示决策（协议回调与单测共用，不碰 Sparkle 对象）：
    /// - 用户发起（userInitiated）→ 标准 Sparkle 窗（今天的行为不变）；
    /// - scheduled 且我们接管（handleShowingUpdate=false）→ 页面投影，绝不弹窗。
    @discardableResult
    func presentStandardUpdate(handleShowingUpdate: Bool,
                               userInitiated: Bool,
                               version: String) -> StandardUpdatePresentation {
        let presentation = StandardUpdatePresentation.decide(handleShowingUpdate: handleShowingUpdate,
                                                             userInitiated: userInitiated)
        switch presentation {
        case .standardWindow:
            // didFindValidUpdate 已把 available 投到页面；标准窗路径不追加阶段。
            shellLog("[shell] Sparkle 标准更新窗口：update=\(version) userInitiated=\(userInitiated)")
        case .pageProjection:
            shellLog("[shell] scheduled 更新由原生壳展示（不弹 Sparkle 窗）："
                + "update=\(version) → nativeUpdatePhase")
            note(.validUpdate(version: version))
        }
        return presentation
    }

    /// Sparkle 询问 scheduled 更新是否由标准 driver 展示 → 我们接管（false）。
    func standardUserDriverShouldHandleShowingScheduledUpdate(_ update: SUAppcastItem,
                                                              andInImmediateFocus immediateFocus: Bool) -> Bool {
        let handle = Self.shouldHandleShowingScheduledUpdate(immediateFocus: immediateFocus)
        shellLog("[shell] Sparkle 询问 scheduled 更新展示权（immediateFocus=\(immediateFocus)）"
            + " → \(handle ? "标准窗" : "原生壳接管（页面投影）")")
        return handle
    }

    /// Sparkle 通知展示归属：scheduled 我们接管时投影页面；用户发起走标准窗。
    func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool,
                                                   forUpdate update: SUAppcastItem,
                                                   state: SPUUserUpdateState) {
        presentStandardUpdate(handleShowingUpdate: handleShowingUpdate,
                              userInitiated: state.userInitiated,
                              version: update.displayVersionString)
    }

    // MARK: - SPUUpdaterDelegate

    /// 找到有效更新：phase=available（页面显示版本与「更新」按钮）。
    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        note(.validUpdate(version: item.displayVersionString))
    }

    /// 无新版本：phase=up-to-date（绝不停在 checking）。
    func updaterDidNotFindUpdate(_ updater: SPUUpdater, error: Error) {
        note(.noUpdate)
    }

    /// 下载开始 / 完成 / 失败 / 用户取消（S-19：原实现让下载阶段对页面不可见）。
    func updater(_ updater: SPUUpdater,
                 willDownloadUpdate item: SUAppcastItem,
                 with request: NSMutableURLRequest) {
        note(.downloadWillStart(version: item.displayVersionString))
    }

    func updater(_ updater: SPUUpdater, didDownloadUpdate item: SUAppcastItem) {
        note(.downloadFinished(version: item.displayVersionString))
    }

    func updater(_ updater: SPUUpdater,
                 failedToDownloadUpdate item: SUAppcastItem,
                 error: Error) {
        note(.downloadFailed(error: error.localizedDescription))
    }

    func userDidCancelDownload(_ updater: SPUUpdater) {
        note(.downloadCancelled)
    }

    /// Sparkle 替换 bundle 前先停受管进程（安装路径不保证先走我们的退出链）。
    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        note(.installWillStart(version: item.displayVersionString))
        shellLog("[shell] Sparkle 即将安装 \(item.displayVersionString)："
            + "先停受管 sidecar / 收 keep-awake 与角标")
        onWillInstall?()
    }

    /// 检查周期中止：无更新错误 → up-to-date；其余 → failed（带文案）。
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        handleUpdateAbort(error)
    }

    func updater(_ updater: SPUUpdater,
                 didFinishUpdateCycleFor updateCheck: SPUUpdateCheck,
                 error: Error?) {
        if let error {
            handleUpdateAbort(error)
            return
        }
        // 周期正常结束仍停在 checking（既无 didFind 也无 didNotFind）→ 收敛
        // up-to-date，绝不让页面永久停在 checking。
        if phaseProjector.lastReport?.phase == .checking {
            note(.noUpdate)
        }
    }

    private func handleUpdateAbort(_ error: Error) {
        let nsError = error as NSError
        if nsError.domain == SUSparkleErrorDomain,
           nsError.code == Int(SUError.noUpdateError.rawValue) {
            note(.noUpdate)
            return
        }
        note(.checkFailed(error: error.localizedDescription))
    }
}

/// 标准更新展示决策（scheduled vs user-initiated；纯值接缝，单测直测）。
enum StandardUpdatePresentation: Equatable {
    /// Sparkle 标准更新窗口（用户发起的检查恒走此路）。
    case standardWindow
    /// 原生壳接管展示：不弹窗，只把 available 相位投到设置页。
    case pageProjection

    /// 决策：用户发起 → 标准窗；scheduled 且 Sparkle 自称展示（handle=true）→
    /// 标准窗；scheduled 且交还我们（handle=false）→ 页面投影。
    static func decide(handleShowingUpdate: Bool, userInitiated: Bool) -> StandardUpdatePresentation {
        if userInitiated { return .standardWindow }
        return handleShowingUpdate ? .standardWindow : .pageProjection
    }
}

// MARK: - 原生更新阶段（S-19/S-20：冻结线 __host.nativeUpdatePhase 的值域）

/// 原生更新阶段（S-19；与页面 UpdateState.phase 的 UI 可见值一致，rawValue 即
/// 冻结线 payload 的 phase 字符串，含连字符的 up-to-date）。
enum NativeUpdatePhase: String, Equatable {
    case idle
    case checking
    case upToDate = "up-to-date"
    case available
    case downloading
    case downloaded
    case installing
    case failed
}

/// 一次阶段上报 = 冻结 payload {phase, version, error}（version/error 缺省 null）。
struct NativeUpdatePhaseReport: Equatable {
    let phase: NativeUpdatePhase
    let version: String?
    let error: String?

    var payload: AnyCodable {
        .object([
            "phase": .string(phase.rawValue),
            "version": version.map { .string($0) } ?? .null,
            "error": error.map { .string($0) } ?? .null,
        ])
    }
}

/// SPUUpdaterDelegate 回调 → 阶段投影的纯值事件（fake-delegate 单测入口：
/// AppUpdaterTests 不经真实 Sparkle 回调，直接喂这些事件断言阶段序列）。
enum NativeUpdateEvent: Equatable {
    case checkStarted
    case validUpdate(version: String)
    case noUpdate
    case downloadWillStart(version: String)
    case downloadFinished(version: String)
    case installWillStart(version: String)
    case downloadCancelled
    case downloadFailed(error: String)
    case checkFailed(error: String)
}

/// 阶段投影器（纯逻辑，单测直测）：apply 返回 nil = 与上次完全相同的上报
/// （去重——Sparkle 的 didAbortWithError 与 didFinishUpdateCycle 可能对同一次
/// 失败各回调一次，页面不应收到重复阶段）。
struct NativeUpdatePhaseProjector {
    private(set) var lastReport: NativeUpdatePhaseReport?

    mutating func apply(_ event: NativeUpdateEvent) -> NativeUpdatePhaseReport? {
        let next: NativeUpdatePhaseReport
        switch event {
        case .checkStarted:
            next = NativeUpdatePhaseReport(phase: .checking, version: nil, error: nil)
        case .validUpdate(let version):
            next = NativeUpdatePhaseReport(phase: .available, version: version, error: nil)
        case .noUpdate:
            next = NativeUpdatePhaseReport(phase: .upToDate, version: nil, error: nil)
        case .downloadWillStart(let version):
            next = NativeUpdatePhaseReport(phase: .downloading, version: version, error: nil)
        case .downloadFinished(let version):
            next = NativeUpdatePhaseReport(phase: .downloaded, version: version, error: nil)
        case .installWillStart(let version):
            next = NativeUpdatePhaseReport(phase: .installing, version: version, error: nil)
        case .downloadCancelled:
            // 取消下载不是失败：更新仍可用（保留已知版本）。
            next = NativeUpdatePhaseReport(phase: .available,
                                           version: lastReport?.version, error: nil)
        case .downloadFailed(let error):
            next = NativeUpdatePhaseReport(phase: .failed,
                                           version: lastReport?.version, error: error)
        case .checkFailed(let error):
            next = NativeUpdatePhaseReport(phase: .failed, version: nil, error: error)
        }
        guard next != lastReport else { return nil }
        lastReport = next
        return next
    }
}
