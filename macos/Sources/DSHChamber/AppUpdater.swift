import AppKit
import Foundation
import Sparkle

/// 原生壳的应用内更新器：Sparkle 2 承担
/// 检查 → 下载 → 重启并安装整条腿。与 Electron flavor 的语义对齐，实现方式换成
/// macOS 的通行方案（Sparkle + appcast + EdDSA 签名）。
///
/// 装配形态：
/// - Info.plist 同时有 SUFeedURL 与 SUPublicEDKey、且 feed 是 https、公钥是
///   base64 的 32 字节 Ed25519 公钥，**并**成功 startUpdater 才视为可用
///   （build-swift-app 在装配期替换这两个占位符；坏配置在装配期就被折成
///   诚实不可用 + 原因，页面拿到 error 而不是停在 checking）。缺任一（dev /
///   dry-run / 未配密钥）→ 不可用：「检查更新…」菜单项禁用，也绝不向 sidecar
///   谎称能自动安装。
/// - 自动检查开（模板常量 SUEnableAutomaticChecks=true + SUScheduledCheckInterval
///   =600s，见 Info.plist.template）：每次启动强制一次**后台**检查
///   （checkForUpdatesInBackground，Sparkle 官方推荐的每启动一次补充检查），之后
///   由 Sparkle 的调度器按 600s 基准间隔（update-schedule.ts 同源）继续；
///   ad-hoc / 未配 feed 的装配仍因缺配置而完全不可用，不存在启动即弹窗的竞争。
///   残余（有意记录，不静默）：Sparkle 把 lastUpdateCheckDate 持久化在
///   user defaults，并在「scheduled 找到更新、展示权归壳（页面投影）」期间保持
///   会话打开——这段会话里 Sparkle 与壳都不再发起新的后台检查，直到用户在
///   Sparkle 标准窗内作出选择或应用重启；下次启动的强制检查因此是唯一保证的
///   恢复点。Electron 的进程内自排程（update-schedule.ts）没有会话依赖，这是两端节奏语义的
///   唯一剩余差异。
/// - scheduled 更新不弹 Sparkle 标准窗：SPUStandardUserDriverDelegate 把展示权
///   收回本类（supportsGentleScheduledUpdateReminders=true +
///   standardUserDriverShouldHandleShowingScheduledUpdate 返回 false），只把
///   available 相位经 nativeUpdatePhase 投到设置页；用户发起的「检查更新…」
///   （页面按钮 / App 菜单）仍走标准 Sparkle 窗口。
/// - 安装前回调：Sparkle 替换 bundle 期间不能留着活着的 sidecar/本地 dsh，故
///   willInstallUpdate 里先跑 onWillInstall（AppDelegate 注入清理链）。
/// - 安装前**显示**准备（P20-B）：设置行/页面的「重启并安装」先经
///   performInstall 等主窗退出全屏（≤5s，FullscreenPreparation），确认面不在
///   全屏 Space 里弹出；超时以稳定码 fullscreen-timeout 拒绝并可重试。App 菜单
///   与 scheduled 的标准窗路径不经过该准备（残余登记 design 25 §7）。
/// - 前台/唤醒 nudge（P03）：hostWakeUp / appDidBecomeActive 各调一次
///   nudgeBackgroundCheck——复用 noteActivity 判据（相位门 + lastUpdateCheckDate
///   满 checkInterval + 60s 合并窗）补一次 checkForUpdatesInBackground；周期与
///   退避仍归 Sparkle 调度器，壳不新增定时器。
/// - 阶段上报：SPUUpdaterDelegate 回调经 note 投影成页面同款七值
///   阶段，再由 AppDelegate 经冻结线 __host.nativeUpdatePhase
///   {phase, version, error} 交 sidecar（sidecar 映射进 update-state 投影）。
/// - 退出时安装：**不实现** willInstallUpdateOnQuit——
///   该回调只在 automaticallyDownloadsUpdates=true 的 automatic-update driver 里
///   被调用；Electron 侧是 autoInstallOnAppQuit=true **且 autoDownload=false**
///   （updater.ts:947-948），接线自动下载会引入 Electron 没有的后台自动下载。
///   用户可见的「已下载，退出时安装」仍由 Sparkle 标准 resumable 路径承担：
///   标准窗内下载完成后可选择立即安装/退出时安装，阶段经 didDownloadUpdate →
///   downloaded 投到页面。
/// - 更新通道 = **纯用户偏好**（v4，无版本后缀项）：Info.plist 的两条通道 URL
///   （stable appcast + 滚动 beta appcast）由 build-swift-app 的
///   --sparkle-stable-feed / --sparkle-beta-feed **成对**注入到所有 native 构建
///   （含 beta 构建）。生效通道 = env DSH_CHAMBER_UPDATE_CHANNEL=beta，或（设置页
///   订阅 betaUpdates === true 且两条通道 URL 可用）→ beta，否则 stable；版本后缀
///   不参与——beta 构建默认也走 stable 通道（开关关闭时只收正式版，该系列 final
///   发布时仍会被推过来）。feedURLString 按通道返回对应 URL：stable 通道回
///   DSHChamberStableFeedURL（beta 构建烤的 SUFeedURL 是 beta appcast，必须显式
///   换回稳定 feed），两条 URL 都缺失的旧构建回 nil 走 SUFeedURL。
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
        /// stable 通道 feed（Info.plist 的 DSHChamberStableFeedURL，构建期由
        /// build-swift-app --sparkle-stable-feed 注入）。beta 构建的 SUFeedURL 烤的
        /// 是 beta appcast，stable 通道必须显式换回该 URL；缺键 / 空白占位 = 未注入
        /// （旧构建），此时 stable 通道走 SUFeedURL。
        let stableFeedURL: String?
        /// beta 通道 feed（Info.plist 的 DSHChamberBetaFeedURL，构建期由
        /// build-swift-app --sparkle-beta-feed 注入；缺键 / 空白占位 = 未注入）。
        /// 两条 URL **成对**注入才有运行期通道切换（判据见 betaSubscriptionProblem）。
        let betaFeedURL: String?

        /// 显式 init 只为给两条通道 URL 缺省值 nil：既有纯值构造（测试 / 未来的
        /// 装配输入）不必知道通道切换面的存在。
        init(feedURL: String,
             publicKey: String,
             automaticChecks: Bool,
             checkInterval: TimeInterval?,
             stableFeedURL: String? = nil,
             betaFeedURL: String? = nil) {
            self.feedURL = feedURL
            self.publicKey = publicKey
            self.automaticChecks = automaticChecks
            self.checkInterval = checkInterval
            self.stableFeedURL = stableFeedURL
            self.betaFeedURL = betaFeedURL
        }
    }

    /// Info.plist → 配置；缺键 / 空白串 → nil（= 更新不可用）。
    static func configuration(from info: [String: Any]) -> Configuration? {
        guard let feed = (info["SUFeedURL"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines), !feed.isEmpty,
              let key = (info["SUPublicEDKey"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty
        else { return nil }
        // 两条通道 URL 是**成对**的可选注入面：模板的空串占位 / 缺键都读作「未注入」。
        // 成对判定（含形状）归 betaSubscriptionProblem——解析层只做 trim + 空串折叠，绝不
        // 在这里预判通道可用性。
        func channelFeed(_ key: String) -> String? {
            let raw = (info[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return raw?.isEmpty == false ? raw : nil
        }
        return Configuration(
            feedURL: feed,
            publicKey: key,
            automaticChecks: (info["SUEnableAutomaticChecks"] as? Bool) ?? false,
            checkInterval: (info["SUScheduledCheckInterval"] as? NSNumber)?.doubleValue,
            stableFeedURL: channelFeed("DSHChamberStableFeedURL"),
            betaFeedURL: channelFeed("DSHChamberBetaFeedURL")
        )
    }

    /// 配置的静态校验（纯函数，单测直测）：feed 必须 https（Sparkle/ATS 拒绝
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

    /// 是否在 startUpdater 之后强制一次后台检查（每启动一次）——Electron
    /// 每次启动 15s 后静默首检，Sparkle 的持久化 lastUpdateCheckDate 会在「距上次
    /// < 6h」时跳过，因此壳补一次显式后台检查（官方推荐：仅在自动检查开启时、紧跟
    /// startUpdater 调用）。纯函数，单测直测。
    static func shouldForceLaunchBackgroundCheck(configuration: Configuration?, startUpdater: Bool) -> Bool {
        startUpdater && (configuration?.automaticChecks ?? false)
    }

    // MARK: - 更新通道（v4 纯偏好单表，与 TS update-headless 同值）

    /// 生效更新通道（值类型；Sparkle 的 feed 选择面）。
    enum UpdateChannel: String, Equatable {
        case stable
        case beta
    }

    /// env 显式 beta 覆盖（`DSH_CHAMBER_UPDATE_CHANNEL === 'beta'`，精确匹配；
    /// 纯函数，单测直测）。
    static func envRequestsBeta(_ environment: [String: String]) -> Bool {
        environment["DSH_CHAMBER_UPDATE_CHANNEL"] == "beta"
    }

    /// 生效通道（v4 = **纯用户偏好**，契约 §2 的唯一表；纯函数，单测直测；与 TS
    /// update-headless.resolveEffectiveUpdateChannel 同值）：
    /// 1. env 显式 beta —— 恒最强、只加不减；
    /// 2. 两条通道 URL 可用 且 设置页订阅 betaUpdates === true → beta；
    /// 3. 其余 stable。**版本后缀不参与**：beta 构建默认也走 stable 通道（开关关闭
    ///    时只收正式版，该系列 final 发布时仍会被推过来）。与 TS
    ///    update-headless.resolveEffectiveUpdateChannel 的入参集合一致（无版本参数）。
    static func resolveUpdateChannel(betaUpdates: Bool?,
                                     betaSubscriptionAvailable: Bool,
                                     envBeta: Bool) -> UpdateChannel {
        if envBeta { return .beta }
        return (betaSubscriptionAvailable && betaUpdates == true) ? .beta : .stable
    }

    /// 通道切换是否可用（纯函数，单测直测）：两条通道 URL（stable + beta）**都**
    /// 注入且形状合法才算可用；nil = 可切换；非 nil = 不可用的**真实原因**（loud
    /// 日志、壳→sidecar flag 与设置页能力门共用同一个判据）。
    ///
    /// 运行期只校验 https + 非空 host；「stable 必须是 releases/latest/download/
    /// appcast-swift.xml、beta 必须是滚动 tag 路径」属于装配期契约，由
    /// build-swift-app 的 dry-run 校验（壳只校验自己会信的形态，坏形状折成切换
    /// 不可用，绝不把更新面一起关掉）。
    static func betaSubscriptionProblem(for configuration: Configuration?) -> String? {
        guard let configuration else {
            return "更新器未装配（native-updater-unavailable）"
        }
        guard let stableFeedURL = configuration.stableFeedURL else {
            return "装配未注入 DSHChamberStableFeedURL（两条通道 URL 必须成对注入）"
        }
        guard let betaFeedURL = configuration.betaFeedURL else {
            return "装配未注入 DSHChamberBetaFeedURL（两条通道 URL 必须成对注入）"
        }
        guard isUsableFeedURL(stableFeedURL) else {
            return "DSHChamberStableFeedURL 形状非法（\(stableFeedURL)）"
        }
        guard isUsableFeedURL(betaFeedURL) else {
            return "DSHChamberBetaFeedURL 形状非法（\(betaFeedURL)）"
        }
        return nil
    }

    /// 通道 feed 的运行期形状判据（与 SUFeedURL 同规）：https + 非空 host。纯函数。
    static func isUsableFeedURL(_ raw: String) -> Bool {
        guard let url = URL(string: raw),
              url.scheme?.lowercased() == "https",
              url.host?.isEmpty == false
        else { return false }
        return true
    }

    /// 当前安装版本（Info.plist 的 CFBundleShortVersionString；缺键 / 空白 →
    /// "0.0.0"）。纯函数，单测直测；v4 起只用于日志/取证，不参与通道判定。
    static func appVersion(from info: [String: Any]) -> String {
        guard let raw = info["CFBundleShortVersionString"] as? String else { return "0.0.0" }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "0.0.0" : trimmed
    }

    /// feed 选择决策（纯函数，单测直测；SPUUpdaterDelegate
    /// `feedURLString(for:)` 只转调本函数）：
    /// - stable 通道 且 stable URL 已注入且形状合法 → stable URL（beta 构建烤的
    ///   SUFeedURL 是 beta appcast，必须显式换回稳定 feed）；
    /// - beta 通道 且 通道 URL 对可用 → beta URL；
    /// - 其余 nil = 走 Info.plist 的 SUFeedURL（旧构建 / 未注入 / 形状坏）。
    static func resolvedFeedURL(channel: UpdateChannel,
                                configuration: Configuration?) -> String? {
        guard let configuration else { return nil }
        switch channel {
        case .stable:
            guard let stableFeedURL = configuration.stableFeedURL,
                  isUsableFeedURL(stableFeedURL) else { return nil }
            return stableFeedURL
        case .beta:
            guard betaSubscriptionProblem(for: configuration) == nil else { return nil }
            return configuration.betaFeedURL
        }
    }

    /// 原生更新动作的 kind（冻结语义）：check = 用户发起的检查；
    /// download/install = 把 Sparkle 标准更新窗口带到前台（下载/安装都在该窗口内
    /// 完成）。Sparkle 2 没有「只下载某个已发现更新」的公开 API——checkForUpdates
    /// 的公开语义恰是「显示/聚焦当前更新，或开始一次新检查」（SPUUpdater.h:99-105），
    /// 因此 download 与 install 都走同一入口，区别在用户在标准窗里按哪个按钮。
    enum NativeUpdateActionKind: String, CaseIterable {
        case check
        case download
        case install
    }

    /// 动作回执（拒绝必须携带真实原因，绝不假 ok:true）。
    enum NativeUpdateActionOutcome: Equatable {
        case accepted
        case refused(reason: String)
    }

    /// 更新可用性的**单一显式判据**（P1.3，台账 §8.a）——上游 `isPackaged && app-update.yml`
    /// 的等价物：装配期事实按顺序判定，任一不过就返回**具体**原因词；能力面、动作拒绝与
    /// 页面显示共用这一份判断，绝不各自判断。腿与上游的对应：`configuration` 非空 ≡
    /// app-update.yml 存在；形状校验 ≡ yml 可读；`started` ≡ updater 真的完成启动
    /// （Sparkle 特有；上游在读了 yml 之后才暴露失败，我们把它提前成显式一律失败）。
    /// 返回值沿用既有词表，消费面（sidecar capability / 动作拒绝 / 页面）零改动。
    static func availabilityRefusal(configuration: Configuration?,
                                    startError: String?,
                                    started: Bool) -> String? {
        if let startError { return "native-updater-misconfigured:\(startError)" }
        guard let configuration else { return "native-updater-unavailable" }
        if let shapeError = configurationError(for: configuration) {
            return "native-updater-misconfigured:\(shapeError)"
        }
        if !started { return "native-updater-unavailable" }
        return nil
    }

    /// 不可用原因（能力面与动作拒绝共用；S-38）。可用时为 nil。
    var unavailableReason: String {
        Self.availabilityRefusal(configuration: configuration,
                                 startError: availabilityError,
                                 started: controller != nil) ?? "native-updater-unavailable"
    }

    /// 能力面：available=false 时携带诚实原因（配置错误/未装配），sidecar
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

    /// 当前生效更新通道（start 落初值；applyBetaUpdates 重算；能力面之外只影响
    /// Sparkle 的 feed 选择，单测可读）。
    private(set) var channel: UpdateChannel = .stable

    /// 当前安装版本（start 从 Info.plist 的 CFBundleShortVersionString 取；
    /// applyBetaUpdates 重算通道时据此判「beta 构建」；缺省 "0.0.0"）。
    private(set) var appVersion: String = "0.0.0"

    /// 装配/启动失败的真实原因：配置形状非法或 startUpdater 抛错时非 nil，
    /// isAvailable 随之为 false，能力面与动作拒绝都携带它。
    private(set) var availabilityError: String?

    /// 更新是否已装配**并真的启动**（配置齐 + 形状合法 + startUpdater 成功）。
    /// 只看 controller != nil 会漏掉 startUpdater 失败（或坏 EdDSA 公钥）：那种情况下
    /// 仍报 available=true，页面 check 被忙门静默吞掉后停在 checking。
    var isAvailable: Bool {
        Self.availabilityRefusal(configuration: configuration,
                                 startError: availabilityError,
                                 started: controller != nil) == nil
    }

    /// Sparkle 自己的可用性门（检查中/安装中为 false）——菜单项据此 enable。
    var canCheckForUpdates: Bool { controller?.updater.canCheckForUpdates ?? false }

    private override init() { super.init() }

    /// 装配期启动（applicationDidFinishLaunching 调用；必须主线程）。
    /// betaUpdates = 启动期从 chamber-settings.json 读到的订阅偏好（缺省 false =
    /// 未订阅 / 文件缺失或损坏——损坏由调用方 loud 记录，本层按未订阅处理）。
    @discardableResult
    func start(info: [String: Any] = Bundle.main.infoDictionary ?? [:],
               startUpdater: Bool = true,
               betaUpdates: Bool = false) -> Bool {
        guard let configuration = Self.configuration(from: info) else {
            shellLog("[shell] Sparkle 更新不可用：Info.plist 缺 SUFeedURL/SUPublicEDKey"
                + "（dev 或未配置密钥的装配）——「检查更新…」保持禁用")
            return false
        }
        // 形状校验先于启动。坏配置绝不进入「已装配」态——诚实不可用 +
        // 原因（能力面携带），页面 check 拿 error 而不是停在 checking。
        if let error = Self.configurationError(for: configuration) {
            availabilityError = error
            shellLog("[shell] Sparkle 更新不可用：配置错误——\(error)")
            return false
        }
        // 生效通道在 startUpdater 之前落状态：Sparkle 的 feedURLString 委托可能在
        // 启动 / 首个周期里被询问，晚赋值会让第一次检查仍打 SUFeedURL（订阅失效
        // 一次）。通道 URL 对不可用时 resolve 恒 stable（订阅不生效，下面 loud）。
        let version = Self.appVersion(from: info)
        let subscriptionProblem = Self.betaSubscriptionProblem(for: configuration)
        let channel = Self.resolveUpdateChannel(
            betaUpdates: betaUpdates,
            betaSubscriptionAvailable: subscriptionProblem == nil,
            envBeta: Self.envRequestsBeta(ProcessInfo.processInfo.environment))
        self.configuration = configuration
        self.appVersion = version
        self.channel = channel
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
            // 拿不到原因、页面也永远不会收到诚实失败。这里拿到错误即降级。
            do {
                // Swift 导入把 SPUUpdater.startUpdater(error:) 重命名为 start()（throws）。
                try controller.updater.start()
            } catch {
                availabilityError = error.localizedDescription
                // 回滚装配态：启动失败绝不留下「配置已装配」的形状（与既有语义
                // 一致——失败后 configuration 仍为 nil）。
                self.configuration = nil
                shellLog("[shell] Sparkle 启动失败（绝不谎报可用）：\(error.localizedDescription)")
                return false
            }
        }
        self.controller = controller
        availabilityError = nil
        shellLog("[shell] Sparkle 更新已装配（feed=\(configuration.feedURL)，"
            + "自动检查=\(configuration.automaticChecks)）")
        shellLog("[shell] Sparkle 更新通道=\(channel.rawValue)（betaUpdates=\(betaUpdates)）"
            + (subscriptionProblem.map { "——通道切换不可用：\($0)" } ?? ""))
        if betaUpdates, let subscriptionProblem {
            shellLog("[shell] 警告：已订阅预览版更新，但本构建的通道 URL 对不可用"
                + "（\(subscriptionProblem)）——按稳定通道处理")
        }
        if Self.shouldForceLaunchBackgroundCheck(configuration: configuration, startUpdater: startUpdater) {
            // 每启动一次的后台检查（不弹窗）。放在下一个 runloop 周期，让
            // startUpdater 排定的 startUpdateCycle 先跑：它按持久化的
            // lastUpdateCheckDate 可能已经发起检查或排了 600s 定时器，这里再补一次
            // 显式后台检查（Sparkle 自带 session/driver 门，重复调用只会响亮跳过）。
            DispatchQueue.main.async { [weak controller] in
                controller?.updater.checkForUpdatesInBackground()
            }
        }
        return true
    }

    /// 设置页「接收预览版（beta）更新」的运行期生效入口（settings-changed 钩子
    /// 重读 chamber-settings.json 后调用）。重算生效通道；只有通道**变化**才动
    /// Sparkle：空闲期立即发起一次**后台**检查（不弹标准窗、不降级），忙态
    /// （检查/下载/安装中）重置周期让下一次调度按新 feed 重新开始。
    /// enabled 但本构建的通道 URL 对不可用 → 响亮拒绝（绝不假装切换）。
    func applyBetaUpdates(_ enabled: Bool) {
        let problem = Self.betaSubscriptionProblem(for: configuration)
        if enabled, let problem {
            shellLog("[shell] 警告：拒绝订阅预览版更新——本构建的通道 URL 对不可用（\(problem)）")
        }
        let next = Self.resolveUpdateChannel(
            betaUpdates: enabled,
            betaSubscriptionAvailable: problem == nil,
            envBeta: Self.envRequestsBeta(ProcessInfo.processInfo.environment))
        guard next != channel else { return }
        channel = next
        shellLog("[shell] Sparkle 更新通道=\(next.rawValue)（betaUpdates=\(enabled)）"
            + (problem.map { "——通道切换不可用：\($0)" } ?? ""))
        guard let controller else { return }
        if controller.updater.canCheckForUpdates {
            controller.updater.checkForUpdatesInBackground()
        } else {
            // Sparkle 官方建议在更新器设置变化后重置周期（不重入进行中的会话）。
            controller.updater.resetUpdateCycle()
        }
    }

    /// 用户发起的检查（App 菜单「检查更新…」；页面更新按钮经 edge 走同一入口）。
    /// 返回真实回执——拒绝带原因；AppKit action 面只记录日志。
    @objc func checkForUpdates(_ sender: Any?) {
        if case .refused(let reason) = perform(.check) {
            shellLog("[shell] 检查更新被拒绝：\(reason)")
        }
    }

    /// kind 分派（纯入口，单测直测拒绝路径）：
    /// - check：冻结语义——绝不重入 Sparkle 忙态，不启动第二条检查/
    ///   下载，先投 checking 相位；
    /// - download/install：Sparkle 没有「只下载指定已发现更新」的公开 API，公开入口
    ///   checkForUpdates 的语义就是「显示/聚焦当前更新或开始新检查」——把标准更新
    ///   窗口带到前台，下载/安装由窗口内的按钮与真实回调驱动；壳**不合成**假相位。
    /// 不可用/忙都返回 .refused(原因)，绝不回假 ok:true 或静默 no-op。
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

    // MARK: - 前台/唤醒 nudge（P03）与安装前显示准备（P20-B）

    /// 唤醒与激活两次 nudge 的合并窗（秒）：解锁回前台通常同时产生
    /// didWake + didBecomeActive 两条通知，不合并会连发两次后台检查
    /// （与 Electron/headless 的 noteActivity 一次性语义对齐）。
    static let nudgeCoalescingWindow: TimeInterval = 60

    /// 最近一次 nudge 触发时刻（只服务合并窗；nudge 只在主线程调用）。
    private var lastNudgeAt: Date?

    /// nudge 的纯判据（单测直测；与 update-headless.noteActivity 同语义）：
    /// - 相位 ∈ {checking, downloading, downloaded, installing} → false
    ///   （在飞会话不得打断；downloaded 是该版本终局，后台检查绝不能把它改回
    ///   available——与 updater.ts 的 final-state 纪律同向）；
    /// - 距上次**完成**检查 < checkInterval（缺省 600s）→ false
    ///   （Sparkle 自己的调度器才是周期权威，这里只补一次即时性）；
    /// - 距上次 nudge < nudgeCoalescingWindow → false（唤醒+激活合并）。
    static func shouldNudgeBackgroundCheck(phase: NativeUpdatePhase?,
                                           lastCheckDate: Date?,
                                           checkInterval: TimeInterval,
                                           lastNudgeAt: Date?,
                                           now: Date) -> Bool {
        if let phase,
           [NativeUpdatePhase.checking, .downloading, .downloaded, .installing].contains(phase) {
            return false
        }
        if let lastCheckDate, now.timeIntervalSince(lastCheckDate) < max(checkInterval, 0) {
            return false
        }
        if let lastNudgeAt, now.timeIntervalSince(lastNudgeAt) < nudgeCoalescingWindow {
            return false
        }
        return true
    }

    /// 前台/唤醒的静默检查 nudge（design 25 §7）：把 Electron/headless 的
    /// noteActivity 判据搬到 Sparkle 上——两个调用点 = MainWindowController 的
    /// hostWakeUp 与 appDidBecomeActive。**不改周期/退避**（周期归 Sparkle
    /// 调度器，S-21）；只补「用户刚回到壳」这一刻的即时性，判据见纯函数。
    func nudgeBackgroundCheck() {
        guard isAvailable, let controller, controller.updater.canCheckForUpdates else { return }
        let now = Date()
        let interval = configuration?.checkInterval ?? 600
        guard Self.shouldNudgeBackgroundCheck(phase: phaseProjector.lastReport?.phase,
                                              lastCheckDate: controller.updater.lastUpdateCheckDate,
                                              checkInterval: interval,
                                              lastNudgeAt: lastNudgeAt,
                                              now: now) else { return }
        lastNudgeAt = now
        let phase = phaseProjector.lastReport?.phase.rawValue ?? "nil"
        let lastCheck = controller.updater.lastUpdateCheckDate?.description ?? "nil"
        // interval 原样打印（不转 Int）：坏 plist 的 NaN/±inf 不能在这里 trap。
        shellLog("[shell] 前台/唤醒触发静默检查（P03）：phase=\(phase)"
            + " lastCheck=\(lastCheck) interval=\(interval)s")
        controller.updater.checkForUpdatesInBackground()
    }

    /// 安装前的显示准备闭包（P20-B：AppDelegate 注入；默认 nil = 不准备）。
    /// 返回 nil = 可以继续安装；非 nil = 稳定错误码（"fullscreen-timeout"）。
    /// 标注 @MainActor：闭包要碰主窗 / NSWindow，由 performInstall 在
    /// MainActor 任务里 await（Swift 5 模式下非隔离 async 函数也可等待它）。
    var prepareInstallForDisplay: (@MainActor () async -> String?)?

    /// kind=install 的异步入口（P20-B）：5s 等窗口退全屏只能在主线程异步等，
    /// 同步 respond 会把 BridgeClient 读线程卡在等待上，故由 SwiftEdgeHostLegs
    /// 的 canHandleAsync/respondAsync 把 install 分流到这里。判据与 perform 一致：
    /// 不可用/忙都显式拒绝；准备超时同样拒绝（绝不假 ok:true）。顺序 =
    /// 忙门 → await 准备 → 再忙门（5s 内 Sparkle 可能已进入新会话）→
    /// accepted + checkForUpdates（= perform(.install) 的既有入口，零新通道）。
    /// P20-B 单飞：两次「重启并安装」并发（页面+菜单/重复点击）只做一次全屏准备与一次
    /// Sparkle 入口，后到者按忙拒绝（与既有 canCheckForUpdates 忙门同一语义）。
    private var installPreparationInFlight = false

    func performInstall() async -> NativeUpdateActionOutcome {
        guard isAvailable, let controller else {
            return .refused(reason: unavailableReason)
        }
        guard !installPreparationInFlight else {
            return .refused(reason: "native-updater-busy")
        }
        installPreparationInFlight = true
        defer { installPreparationInFlight = false }
        guard controller.updater.canCheckForUpdates else {
            return .refused(reason: "native-updater-busy")
        }
        if let prepare = prepareInstallForDisplay, let reason = await prepare() {
            shellLog("[shell] 原生更新安装被拒绝：显示准备失败（\(reason)）")
            return .refused(reason: reason)
        }
        guard controller.updater.canCheckForUpdates else {
            return .refused(reason: "native-updater-busy")
        }
        shellLog("[shell] 原生更新动作：install（显示准备完成，交给 Sparkle 标准窗口）")
        controller.checkForUpdates(nil)
        return .accepted
    }

    // MARK: - NSMenuItemValidation（菜单 enable 实时跟随 canCheckForUpdates）

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
    ///
    /// B4 迟到事件对齐 E：检查被停滞判定之后，被放弃的那次检查的迟到结果
    /// （available / up-to-date / failed）一律抑制到下一次 `.checkStarted`——
    /// 否则页面刚看到的 failed 会被后台仍在飞的旧检查改回去。迟到**下载完成**
    /// 不被抑制：E 的语义是「接受这次成功，不隐藏真实结果」（updater.ts
    /// `update-downloaded` 分支），S 保持同向并 loud 记录。
    func note(_ event: NativeUpdateEvent) {
        if suppressAbandonedCheckResults {
            switch event {
            case .checkStarted:
                suppressAbandonedCheckResults = false
            case .validUpdate, .noUpdate, .checkFailed:
                shellLog("[shell] 已判定停滞的检查的迟到结果被抑制（B4，对齐 E）：\(event)")
                return
            default:
                break
            }
        }
        guard let report = phaseProjector.apply(event) else { return }
        if let stalled = stalledVerdictPhase {
            stalledVerdictPhase = nil
            shellLog("[shell] 更新停滞判定（\(stalled.rawValue)）之后收到迟到相位 "
                + "\(report.phase.rawValue)——接受真实结果（E 同向：不隐藏真实成功）")
        }
        let version = report.version ?? "nil"
        let error = report.error ?? "nil"
        shellLog("[shell] nativeUpdatePhase \(report.phase.rawValue) version=\(version) error=\(error)")
        onPhase?(report)
        armStallWatchdog(phase: report.phase)
    }

    /// 静默看门狗（P0.1，台账 §8.a）：Sparkle 的检查/下载若长时间不产生任何相位
    /// 变化，页面不再无限停在 checking/downloading——超时投一次 failed（原因词与
    /// S-38 同表）。每次相位变化都重置；deadline 可注入供单测。
    ///
    /// B4（2026-12 审查方向 B）：下载与检查用**不同**的 deadline。Sparkle 没有
    /// 下载进度回调（SPUUpdaterDelegate 只有 willDownloadUpdate / didDownloadUpdate /
    /// 失败），进入 `.downloading` 之后到落地前不再有任何相位变化，共用 60s 会把
    /// 任何稍慢的正常下载误杀成 `native-update-stalled:downloading`。E 的 60s 是
    /// **字节 idle**（download-progress 每次抵达都重置 lastDownloadProgressAt，用例
    /// 钉「有进展不误杀」）；S 看不到字节，下载侧只能给「最大完成期限」。
    var stallWatchdogMs: Int = 60_000

    /// 下载相位的独立 deadline（B4）：30min 只兜住「永远不落地」的悬挂下载，不参与
    /// E 式 idle 判定——「S 看不到下载进度」是登记在案的语义差异（design 25 §7、
    /// STATUS「更新链的节奏/取证/注意力」）。
    var downloadStallWatchdogMs: Int = 30 * 60_000

    private var stallWatchdog: DispatchWorkItem?

    /// 已投过停滞判定的相位（B4）：迟到的真实相位据此 loud 记录并撤回判定（见 note）。
    private var stalledVerdictPhase: NativeUpdatePhase?

    /// 检查被判定停滞之后，这一次检查的迟到结果一律抑制（B4，对齐 E 的
    /// `ignoreAbandonedCheckEvents`：超时检查的迟到事件不得把终局 failed 改回去）；
    /// 新一次 `.checkStarted` 复位。迟到**下载完成**不属于此列（E 明确接受真实成功）。
    private var suppressAbandonedCheckResults = false

    private func armStallWatchdog(phase: NativeUpdatePhase) {
        stallWatchdog?.cancel()
        stallWatchdog = nil
        let deadlineMs: Int
        switch phase {
        case .checking: deadlineMs = stallWatchdogMs
        case .downloading: deadlineMs = downloadStallWatchdogMs
        default: return
        }
        let stalledPhase = phase
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.phaseProjector.lastReport?.phase == stalledPhase else { return }
            shellLog("[shell] 更新相位停滞：\(stalledPhase.rawValue) 超过 \(deadlineMs)ms 无变化——投 failed")
            let reason = "native-update-stalled:\(stalledPhase.rawValue)"
            self.note(stalledPhase == .checking ? .checkFailed(error: reason) : .downloadFailed(error: reason))
            // 判定投递之后才登记：note() 里那次 failed 上报不算「迟到相位」。
            self.stalledVerdictPhase = stalledPhase
            if stalledPhase == .checking { self.suppressAbandonedCheckResults = true }
        }
        stallWatchdog = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(deadlineMs), execute: work)
    }

    /// 单测复位投影器/看门狗状态（@testable 可见；生产无调用点）。
    func resetPhaseProjectionForTesting() {
        phaseProjector = NativeUpdatePhaseProjector()
        stalledVerdictPhase = nil
        suppressAbandonedCheckResults = false
        stallWatchdog?.cancel()
        stallWatchdog = nil
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
    /// - 用户发起（userInitiated）→ 标准 Sparkle 窗；
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

    /// Sparkle 询问本次检查用哪条 feed（动态 feed URL 的官方入口）：按生效通道返回
    /// 注入的通道 URL（stable → DSHChamberStableFeedURL、beta → DSHChamberBetaFeedURL）；
    /// 未注入 / 形状坏 / 旧构建 → nil = 用 Info.plist 的 SUFeedURL。
    func feedURLString(for updater: SPUUpdater) -> String? {
        Self.resolvedFeedURL(channel: channel, configuration: configuration)
    }

    /// Sparkle **实际选择**的下载产物名：命中增量包时是 `*.delta`，回退整包时是 zip。
    /// 单独成函数以便单测钉住观测面。
    static func downloadArtifactName(_ url: URL?) -> String {
        url?.lastPathComponent ?? "unknown"
    }

    /// shell.log 那行「Sparkle 开始下载 <版本>：<产物名>」的完整文本——单测直接钉住，
    /// 避免 helper 留着而 emission 被删（观测证据静默消失）。
    static func downloadLogLine(version: String, url: URL?) -> String {
        "[shell] Sparkle 开始下载 \(version)：\(downloadArtifactName(url))"
    }

    /// 找到有效更新：phase=available（页面显示版本与「更新」按钮）。
    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        note(.validUpdate(version: item.displayVersionString))
    }

    /// 无新版本：phase=up-to-date（绝不停在 checking）。
    func updaterDidNotFindUpdate(_ updater: SPUUpdater, error: Error) {
        note(.noUpdate)
    }

    /// 下载开始 / 完成 / 失败 / 用户取消。
    func updater(_ updater: SPUUpdater,
                 willDownloadUpdate item: SUAppcastItem,
                 with request: NSMutableURLRequest) {
        // 可观测性：这里能看到 Sparkle **实际选择**的产物——命中 delta
        // 时 URL 是 *.delta，否则回退整包 zip。只写壳日志，不进冻结线。
        shellLog(Self.downloadLogLine(version: item.displayVersionString, url: request.url))
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

// MARK: - 原生更新阶段（冻结线 __host.nativeUpdatePhase 的值域）

/// 原生更新阶段（与页面 UpdateState.phase 的 UI 可见值一致，rawValue 即
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
