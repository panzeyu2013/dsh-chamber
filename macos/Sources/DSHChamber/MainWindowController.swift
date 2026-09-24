//  MainWindowController.swift —— 主窗口：WKWebView 加载控制面 + A 桥接线
//  DSHChamber（macos/ SwiftPM POC 壳）：design 25 §8.1；
//  本文件持有 A/B 桥契约的接线点（ChamberMessageHandler / BridgeShimInjector
//  为 MessageHandler.swift / BridgeShimInjector.swift 中他人实现，见共享契约）
//
//  职责：WKWebView 加载控制面 origin 的壳文档（根路径）；把 bridge-shim.js
//  （ChamberResources 定位的 SwiftPM 资源）注入 WebView；ChamberMessageHandler
//  注册为 "dshChamber" 消息通道并回接 evaluateJavaScript；B 桥 invoke 结果与
//  sidecar notify 帧经 __dshChamberResolve / __dshChamberEmit 回写页面；
//  导航护栏：仅放行**壳文档**（origin 相等 + pathname=/ + 无 query，与 Electron
//  isTrustedRendererUrl 对齐）——同源非壳文档（/api/i/* 代理 HTML）一律取消，
//  其余交给系统打开或一律取消。
//  hostFacts 推送：本控制器是窗口/聚焦/加载事实的唯一事实源——
//  窗口 key/关闭通知与 WKNavigationDelegate 生命周期回调经
//  pushHostFacts 以 __host.hostFacts 推送 sidecar（node-edges.ts 同步门
//  缓存 focused/mainWindowAlive/webViewLoading/webViewContentAlive 刷新，
//  见本文件 hostFacts 段注释），使通知裁决等同步门与 Electron 侧行为一致。
//  notify 消费路由：sidecar 出站 notify 帧（node-edges sendNotify 族
//  ——rendererPush/setBadge/showItemInFolder/retireNotifications）经
//  BridgeClient.onNotify 到本控制器的 notify 路由：rendererPush 解包进页面
//  emit（Electron webContents.send 同语义），setBadge/showItemInFolder 走
//  SwiftEdgeHostLegs 原生腿（守卫同 edge 面、失败 loud），retireNotifications
//  按 NotificationDeliveryRegistry 的 sourceId→identifier 登记表调
//  UNUserNotificationCenter.removeDeliveredNotifications，
//  notifyClicked/未知事件 loud 不处理——路由决策表见文件底部
//  decodeNotify/NotifyRoute（纯逻辑，单测直测）。
import AppKit
import DSHChamberWebKitSupport
import UniformTypeIdentifiers
import UserNotifications
import WebKit

final class MainWindowController: NSWindowController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, NSWindowDelegate {

    // MARK: - 常量

    /// A 桥消息通道名（与 shim 侧约定一致）
    private static let bridgeMessageName = "dshChamber"
    /// POC dev 控制台回传通道名（页面脚本约定；见 setupWindow 注入）
    private static let consoleMessageName = "shellConsole"
    /// A 桥 shim 资源文件名（Resources/ 下，本文件只读取）。
    /// 可见性为 internal：AppDelegate 启动门与单测引用同一拼写。
    static let shimResourceName = "bridge-shim.js"

    /// 本次窗口的原生通道令牌：注入时写进 shim，回执/推送时作为首参
    /// 回传；页面脚本无从得知（内部管路不在公开面上）。
    private let nativeChannelToken = BridgeShimInjector.makeNativeToken()

    /// 令牌的 JS 字符串字面量（十六进制，无需转义）。令牌 init 后不变，用
    /// lazy 缓存（每个 invoke/emit 少一次字符串插值分配；访问恒在主线程）。
    private lazy var nativeTokenLiteral: String = "\"\(nativeChannelToken)\""
    /// 可 invoke 的 method 白名单 = BridgeManifest.invokeChannels 全集
    /// （61/61 真实现都在 sidecar 侧，语义权威与护栏仍在 sidecar/TrustGuard；
    /// readiness/badge 等通道不被 POC 层拒绝）。与桥 shim 暴露面一致性问题：shim
    /// 只暴露其脚本内实现的方法，未暴露方法在页面层即 stub——两处均以 manifest
    /// 为准，全量 shim（chamber-bridge.stub.js）由生成物承载。
    private static let invokeWhitelist: Set<String> = BridgeManifest.invokeChannels
    /// 窗口默认内容尺寸。
    /// 双 flavor 几何折中：这里的尺寸是**内容区**尺寸
    /// （NSWindow(contentRect:) + contentView = webView），而 Electron 侧
    /// BrowserWindow 的 1280x800 是**窗口外框**（main.ts 未设 useContentSize；
    /// Electron 43 只在 use_content_size 为真时才 SetContentSize），其 web 视口
    /// 实为 1280x772——差的 ~28pt 是 macOS 标准标题栏。同一份前端因此在两端
    /// 视口高度差 ~3.6%（侧栏会话列表 / 工作区列的可见高度同步差一档）。
    /// 786 = (800 + 772) / 2：原生视口 1280x786（外框 ~814）对 Electron 的
    /// 772（外框 800）两侧各偏 ~14pt，先收窄差异而不是单侧对齐；单侧对齐
    /// （原生取 772，或 Electron 开 useContentSize 后两端都取 800）仍未裁决。
    /// 本值只影响**高度**；内容列宽等宽度偏好是 per-flavor 页面存储
    /// 不随本值收敛。
    private static let windowSize = NSSize(width: 1280, height: 786)

    /// 原生壳**可见**产品名（dsh-chamber）：
    /// 窗口标题 / 失败说明页 / fatal 提示框共用。不可见名（SwiftPM target/module =
    /// DSHChamber、资源名 bridge-shim.js）保持 DSHChamber 不变；bundle 内可执行名
    /// 与本值同源（dsh-chamber，见 Info.plist.template 与 build-swift-app.mjs 的 EXECUTABLE_NAME）。
    static let displayName = "dsh-chamber"

    /// 首帧/重载底色：与 Electron backgroundColor:#0f1115、前端
    /// packages/renderer/index.html 骨架底色同一 token 值
    /// #0f1115 = rgb(15, 17, 21)。WKWebView 缺省白底在首帧/重载时会白闪。
    static let backgroundRed: CGFloat = 15.0 / 255.0
    static let backgroundGreen: CGFloat = 17.0 / 255.0
    static let backgroundBlue: CGFloat = 21.0 / 255.0
    static var windowBackgroundColor: NSColor {
        NSColor(srgbRed: backgroundRed, green: backgroundGreen,
                blue: backgroundBlue, alpha: 1)
    }

    /// 主题化"露底"色：**无 last-known 事实时**首帧用
    /// 骨架常量——页面自身骨架恒为 #0f1115 且与主题无关（packages/renderer/index.html
    /// 明示「不跟随 prefers-color-scheme：dsh 主题按实例投影、骨架期不可知」），
    /// 此时跟着骨架走才不会反向闪色；**已有 last-known 事实（第二次启动起）**则建窗
    /// 即收敛到页面主题色（见 setupWindow 的 reconcileThemedBackground），否则 ingest
    /// 对同值事实早退，浅色页面会整场会话露深色底。页面事实到达后按页面
    /// 主题换色，缩放/全屏/重载的露底就与页面一致（两个方向都不闪）。
    /// nil（无事实）→ 骨架常量；dark → 骨架常量；light → dsh 浅色内容底（白）。
    static func themedBackgroundColor(pageIsDark: Bool?) -> NSColor {
        guard let pageIsDark, !pageIsDark else { return windowBackgroundColor }
        return .white
    }

    /// 透明露底 KVC 结果的诊断行（纯函数，单测直测）。
    /// drawsBackground 是私有键（公开面只有 underPageBackgroundColor）——包装返回
    /// Unavailable 时保持 WebKit 默认、只靠公开露底色，日志必须能区分三种结果；任何
    /// 分支都只记日志，绝不让进程退出。
    static func drawsBackgroundLogLine(_ outcome: DSHChamberBoolKVCOutcome) -> String {
        switch outcome {
        case .applied:
            return "[shell] 透明露底：drawsBackground=false 已生效（异常安全 KVC 包装）"
        case .unavailable:
            return "[shell] 透明露底：drawsBackground 私有键不可用（本 OS 无对应存取器）"
                + "——保持 WebKit 默认，仅 underPageBackgroundColor 生效"
        case .readBackMismatch:
            return "[shell] 透明露底：drawsBackground=false 写入后回读不一致"
                + "——按未生效记录，继续用 underPageBackgroundColor"
        @unknown default:
            return "[shell] 透明露底：drawsBackground 设置返回未知结果（C 侧新增 case）——保持现状"
        }
    }
    /// B 桥入站保留 method 名（单源 = HostInboundMethod；node-edges.ts 同拼写）。
    private static let hostFactsMethod = HostInboundMethod.hostFacts
    /// renderer 崩溃有界重载策略（design 25 §5 E19；Electron 版 500ms/60s≤3）。
    private let recoveryPolicy = RendererRecoveryPolicy()
    /// 滚动窗口内的重载时间戳（主线程独占）。
    private var recoveryAttempts: [Double] = []
    /// 重载已排定（防同一崩溃回调重入排定）。
    private var recoveryReloadWorkItem: DispatchWorkItem?
    /// 策略在排程时记账；若导航先发生，取消的重载须退还该次预算。
    private var pendingRecoveryAttemptAt: Double?
    /// 让已取消但仍被派发的 work item 无法重载新页面。
    private var recoveryReloadGeneration: UInt64 = 0
    /// 退出中/已开始清理 → 抑制渲染恢复（Electron `reload()` 的 `quitRequested`
    /// 早退）。
    private var recoverySuppressed = false
    /// give-up 的**一次性闸门**。放弃是「这一轮恢复结束」的判断，不是「每次崩溃都
    /// 通报一次」的事件——若每次崩溃都通报，give-up 之后会反复弹模态框。首弹后只写日志，
    /// 直到一次**真正成功的加载**（`didFinish`）把它复位，闸门才重新武装。
    private var recoveryGaveUp = false
    /// 崩溃归因：上次「加载完成」时刻、本次加载窗口内的崩溃次数、以及当前这次
    /// 加载是否由崩溃恢复触发。崩溃集中在加载完成后 20–34s 且大多不留 shell 侧
    /// 痕迹——没有这三个量就无法把
    /// "应用自己回到载入历史"归因到渲染进程重启。
    private var lastLoadFinishedAt: Date?
    private var crashesSinceLoad = 0
    private var recoveringFromCrash = false
    private var lastCrashAt: Date?

    /// 可见页面的 JS/rAF 进度判定器与定时器。
    private var hangWatchdog = RendererHangWatchdog()
    private var hangProbeTimer: Timer?
    /// 自动恢复已放弃（超限后不再重载，只 loud/弹窗一次）。


    // MARK: - 状态

    private let bridge: BridgeClient
    private let cpURL: URL
    /// A 桥 shim 源码（AppDelegate 启动门已 fail-closed 判定非空，
    /// setupWindow 只负责注入）。
    private let shimSource: String
    /// 控制面 origin（scheme://host:port），导航放行与消息护栏共用
    private let cpOrigin: String
    /// sidecar ready 帧已到（A 桥 origin 门在此之前一律拒绝）。
    private var sidecarReady = false
    /// 退出清理已开始（A 桥 app_quitting 门；AppDelegate
    /// beginTerminationCleanup 置位）。置位后全部 invoke 回 app_quitting。
    private var quitting = false
    /// 外链打开预算（镜像 shell-core openExternally：10s/8 次 + 30s 冷却）。
    private var externalBudget = ExternalOpenBudget()

    private var webView: WKWebView!
    private var bridgeHandler: ChamberMessageHandler!
    /// 关窗决策委托（AppDelegate；见 windowShouldClose）。
    weak var closeDelegate: MainWindowCloseDeciding?
    /// 宿主设置变化回调：关窗决策会缓存 quitFacts，设置页改
    /// 「关闭窗口行为」后必须让缓存失效，否则首次关窗仍按旧值决策。
    var onSettingsChanged: (() -> Void)?

    // MARK: - 页面事实（native-shell 本地化/主题跟随的事实载波）

    /// last-known 页面事实（language/dark/revision；init 时从 UserDefaults 恢复）。
    private let pageFactsStore = ShellPageFactsStore(defaults: .standard)
    /// 露底色当前已应用的页面暗色事实（nil = 尚未按事实着色，仍是骨架常量）。
    /// 主线程独占；只由 reconcileThemedBackground 写（幂等对账的状态）。
    private var appliedPageIsDark: Bool?
    /// 页面事实变化接收方（AppDelegate 注册；nil = 当前无人消费）。
    var pageFactsSink: ShellPageFactsSink?
    /// 独立消息通道 ShellPageFactsScript.messageName 的 handler（**不**混进
    /// ChamberMessageHandler 的白名单/origin 就绪门链路）。
    private var pageFactsHandler: ShellPageFactsMessageHandler?
    private var consoleCatcher: ShellConsoleCatcher?
    private var didSnapshot = false
    /// 在途下载占用的目标路径（静默落盘：WebKit 要求目标文件在决策时
    /// 不存在，同一批并发下载因此必须相互避让；完成/失败即释放）。
    private var reservedDownloadPaths: Set<String> = []
    private var downloadDestinations: [ObjectIdentifier: String] = [:]
    private var navRetries = 0
    private var didStartLoading = false
    /// 首载失败退避重试的挂起调度（sidecar fatal / 退出 / 成功时取消）。
    private var navRetryWorkItem: DispatchWorkItem?
    /// sidecar 启动失败的真实原因（supervisor fatal 时经
    /// noteStartupFailure 注入；失败页与日志共用，绝不只剩 WebKit 的 ATS 文案）。
    private var startupFailureMessage: String?
    /// hostFacts 推送簿记：已推送（含推送意图）事实，键 → 布尔。
    /// 仅主线程读写：全部推送调用点都是主线程回调（AppKit 窗口通知 /
    /// WKNavigationDelegate），簿记在事件回调内同步完成（去重判断与推送
    /// 顺序因此与事件顺序一致，见 pushHostFacts 注释）。
    private var lastHostFacts: [String: Bool] = [:]
    /// 关偏好后的实际状态（建 configuration 时确定，此后不变）。
    private var refreshRatePreference: RefreshRatePreference = .unknown
    /// 最近一次刷新率对照日志的**整行文本**（startupLogLine 是纯函数，行相等 ⟺ 全部事实
    /// 相等，所以整行去重天然覆盖新增事实字段）。
    private var lastRefreshRateLogLine: String?

    /// 启动呈现门——首个可呈现内容（didCommit）才允许亮出启动主窗，且只触发一次
    /// （后续重载/重试/失败页后的再次导航不重复呈现）。同一状态机承载失败说明页的
    /// 一次性 about: 导航豁免（见 StartupPresentationGate）。
    private var presentationGate = StartupPresentationGate()
    /// 首个可呈现内容到达回调（AppDelegate 装配期接线 → makeKeyAndOrderFront；
    /// 见 didCommit 与 AppDelegate.presentMainWindow）。窗口在此之前保持隐藏，
    /// 绝不先亮出无内容空窗。
    var onFirstCommittedContent: (() -> Void)?
    /// 文件选择面板呈现器（composer 回形针）。测试经此 seam 注入假体，
    /// 不需要真实 NSOpenPanel / WKOpenPanelParameters 实例（后者无公开构造器）。
    var fileOpenPanelPresenter: FileOpenPanelPresenting = SystemFileOpenPanelPresenter()

    // MARK: - 初始化

    /// - Parameters:
    ///   - cpURL: 控制面 URL（AppDelegate 解析自 DSH_CHAMBER_SHELL_CP_URL；缺省 dev
    ///     127.0.0.1:17520 / 打包 localhost:17500）
    ///   - bridge: B 桥客户端（BridgeClient.swift）
    ///   - shimSource: A 桥 shim 源码（调用方先经
    ///     `shimStartupFailure(source:)` fail-closed 判定，缺失绝不开窗）
    init(cpURL: URL, bridge: BridgeClient, shimSource: String) {
        self.cpURL = cpURL
        self.bridge = bridge
        self.shimSource = shimSource
        self.cpOrigin = Self.origin(of: cpURL) ?? ""
        if self.cpOrigin.isEmpty {
            shellLog("[shell] 警告：控制面 URL 无合法 origin，导航护栏将一律拦截 http(s)")
        }
        super.init(window: nil)
        setupWindow()
        // windowDidLoad 在纯代码（非 nib）窗口下不保证被调用，这里兜底触发一次
        // 首次加载（与 windowDidLoad 的调用共用 didStartLoading 去重）
        startLoadingIfNeeded()
        // S-A：创建后推送一次主窗/web 内容存活事实。此刻 WKWebView 进程全新
        // 未崩 → 与 electron-edges 折算（窗口存在 + 内容未 crashed）同值；
        // 与 sidecar-entry hostFacts 种子（mainWindowAlive/webViewContentAlive
        // 均 true）一致，幂等无害。推送先于任何导航回调（WKWebView 回调在
        // 本 init 返回后的主线程派发），加载完成时 didFinish 会再推 true 收敛。
        pushHostFacts(["mainWindowAlive": true, "webViewContentAlive": true])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("POC 为纯代码构建窗口，不支持 nib/storyboard 初始化")
    }

    deinit {
        hangProbeTimer?.invalidate()
    }

    /// 构建 WKWebView（含 A 桥注入与消息通道）与主窗口
    private func setupWindow() {
        let configuration = WKWebViewConfiguration()

        // ProMotion 120Hz（design 25 §5.1）：WKWebView 默认把页面渲染更新
        // 压到「靠近 60fps」（PreferPageRenderingUpdatesNear60FPSEnabled 缺省 true；只在
        // nominal > 60 且整数商 > 1 时才有影响——61–119Hz 屏本就不受限），低电量模式下 WebKit
        // 再把帧间隔 ×2（→30fps）。**必须在下面 WKWebView(frame:configuration:) 之前关掉该偏好**：
        // 页面创建后再改实测不生效（稳态：未换屏/未发生节流原因变化/未重启 WebContent；
        // 同进程内 rAF 仍为 60fps）；实测 60 → 120fps（120Hz 显示器）。
        // 低电量模式的 ×2 是 WebKit 在 WebContent 进程内直读系统状态的系统级策略：应用侧没有
        // 公开开关（私有注入面 _WKProcessPoolConfiguration.injectedBundleURL 所属类自 macOS 12
        // 起 deprecated，属性无单独注解；本壳未采用也未实测）——这里只如实记录折算结果。
        refreshRatePreference = RefreshRatePolicy.apply(to: configuration.preferences)
        // 对照日志**不在这里发**：建窗前没有任何 key window，NSScreen.main 未必是窗口
        // 所在屏（SDK 只承诺 mainScreen = 有 key window 的屏）。统一由
        // logRefreshRateIfChanged() 在建窗后发出，并在换屏/低电量切换时按值补记。

        // A 桥 shim 注入（BridgeShimInjector.install 负责落 WKUserScript）。
        // 资源缺失/为空已在 AppDelegate 启动门 fail-closed（可见错误 +
        // exit(1)，对齐 Electron showErrorBox + app.exit），这里没有
        // 「警告后照常开窗」的 fail-open 分支。
        // 注入前把占位符换成窗口随机令牌（内部管路 resolve/emit/
        // rehydrate 都要带对令牌才生效）；install 幂等。
        BridgeShimInjector.install(
            config: configuration,
            source: BridgeShimInjector.injectNativeToken(nativeChannelToken, into: shimSource))
        shellLog("[shell] A 桥 shim 注入完成（\(Self.shimResourceName)）")

        // 视口越界策略：关闭 macOS WebKit 的根级弹性回弹——指针停在
        // 不可滚动 chrome（顶栏/侧栏头部）上滚动、或滚动器滚到端点后继续滚时，
        // 整页（含 position: fixed 层）会被整体平移再弹回。按 CSS Overscroll
        // Behavior 规范，视口越界效果由根元素的 overscroll-behavior 决定，故由
        // 壳以 WKUserScript（documentStart、仅主 frame）注入根规则，只落文档根、
        // 不给上游滚动容器加 contain（design 25 §5.2；Electron flavor 未同步）。
        // 与 shim 同段：必须在 WKWebView 构造前生效。
        ShellOverscrollPolicy.install(config: configuration)
        shellLog("[shell] 视口越界策略注入完成（\(ShellOverscrollPolicy.rootOverscrollCSS)）")

        // 页面事实载波（本地化/主题跟随）：documentStart、仅主 frame、
        // page world 注入 MutationObserver（html[lang]/内联 color-scheme、
        // body[data-ds-dark-theme]、meta[theme-color]），并注册独立消息通道。
        // 与 shim/overscroll 同段：必须在 WKWebView 构造前注册。
        let pageFactsHandler = ShellPageFactsMessageHandler(controller: self)
        pageFactsHandler.expectedOrigin = { [weak self] in self?.cpOrigin }
        self.pageFactsHandler = pageFactsHandler
        configuration.userContentController.add(pageFactsHandler,
                                                name: ShellPageFactsScript.messageName)
        configuration.userContentController.addUserScript(WKUserScript(
            source: ShellPageFactsScript.source(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        shellLog("[shell] 页面事实载波注入完成（\(ShellPageFactsScript.messageName)）")

        // 消息通道：ChamberMessageHandler 只做护栏与转发
        let handler = ChamberMessageHandler(
            whitelist: Self.invokeWhitelist,
            // ready 帧前 expectedOrigin = nil → 一律拒绝（design 25 §4.4.1
            // 第 2 条「port 只在 ready 帧后放开」）。
            expectedOrigin: { [weak self] in
                guard let self, self.sidecarReady else { return nil }
                return self.cpOrigin
            },
            // 退出清理开始后 late invoke 回 app_quitting（renderer-trust
            // createTrustedIpc 同码），不向 shutdown 注入传输/运行时工作。
            isQuitting: { [weak self] in self?.quitting ?? false },
            onInvoke: { [weak self] documentId, id, method, payload in
                self?.handleInvoke(documentId: documentId, id: id, method: method, payload: payload)
            }
        )
        handler.evaluateJavaScript = { [weak self] script in
            self?.evaluateJS(script)
        }
        // 护栏回执也要带原生通道令牌（与注入 shim 的同一个值）。
        handler.nativeChannelToken = nativeChannelToken
        bridgeHandler = handler
        configuration.userContentController.add(handler, name: Self.bridgeMessageName)

        // POC dev 调试（白屏诊断；仅在 DSH_CHAMBER_SHELL_DEBUG=1 时安装——默认关闭，
        // 发布壳不转发渲染器每一行 console）：页面 JS onerror/
        // unhandledrejection/console.* 经 shellConsole 通道回传 → [shell-web] 打印。
        if ShellDebug.isEnabledCached {
            let consoleCatcher = ShellConsoleCatcher()
            self.consoleCatcher = consoleCatcher
            configuration.userContentController.add(consoleCatcher, name: Self.consoleMessageName)
            let consoleSource = """
            (function () {
              function post(kind, args) {
                try {
                  window.webkit.messageHandlers.shellConsole.postMessage({kind: kind, text: Array.prototype.map.call(args, String).join(' ')});
                } catch (e) {}
              }
              window.addEventListener('error', function (e) {
                post('error', [e.message, ' @ ' + (e.filename || '') + ':' + (e.lineno || '')]);
              });
              window.addEventListener('unhandledrejection', function (e) {
                post('rejection', [String(e && e.reason)]);
              });
              ['log','info','warn','error','debug'].forEach(function (m) {
                var orig = console[m];
                console[m] = function () { post(m, arguments); orig.apply(console, arguments); };
              });
            })();
            """
            configuration.userContentController.addUserScript(WKUserScript(
                source: consoleSource,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
            // DSH_CHAMBER_SHELL_DEBUG 下的帧率观测——rAF 每 2s 回传一行 [shell-fps]，
            // 走既有 shellConsole 通道（[shell-web] 打印）。只活在调试面：
            // 缺省/DSH_CHAMBER_SHELL_DEBUG=0/打包态都不注入。
            let fpsSource = """
            (function () {
              var count = 0, mark = -1, last = 0;
              function sample(ts) {
                // 相邻回调断档（display sleep / App Nap / 调试暂停）会给窗口掺入无帧时间：
                // 丢弃当前窗口并重新锚定。判的是"间隔"而不是"窗口累计"，否则 0.5–2s 的停顿
                // 仍会打出 0.4fps 这类假低值。用 -1 作未初始化哨兵，避免 ts 恰为 0 时误判。
                // 注意语义：回调节奏本身就慢于 500ms 时不会产出 [shell-fps] 行——
                // "没有读数"不等于"rAF 没在跑"，验收须结合可见的渲染表现判断。
                if (last !== 0 && ts - last > 500) { count = 0; mark = -1; }
                last = ts;
                // 首帧只做锚点，不计入窗口——否则首个窗口（以及每次 visibilitychange 复位后的
                // 首窗）会系统性多 1 帧（60→60.5、120→120.5）。
                if (mark < 0) { mark = ts; } else { count++; }
                if (ts - mark >= 2000) {
                  var fps = count * 1000 / (ts - mark);
                  try { window.webkit.messageHandlers.shellConsole.postMessage({ kind: 'log', text: '[shell-fps] ' + fps.toFixed(1) + ' fps' }); } catch (e) {}
                  count = 0; mark = ts;
                }
                requestAnimationFrame(sample);
              }
              // 隐藏/恢复会让下一次采样跨越大段暂停，出现一行假低值——切换时重置。
              document.addEventListener('visibilitychange', function () { count = 0; mark = -1; last = 0; });
              requestAnimationFrame(sample);
            })();
            """
            configuration.userContentController.addUserScript(WKUserScript(
                source: fpsSource,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
            shellLog("[shell] DSH_CHAMBER_SHELL_DEBUG=1：已安装 shellConsole 回传（\(Self.consoleMessageName)）+ 帧率观测")
        }

        // 渲染器卡死自愈（空闲 ping + 有界重载）。
        startHangWatchdog()

        // sidecar 出站 **notify 帧**（{"notify":event,"payload":…}——
        // node-edges 的 sendNotify 族：rendererPush/setBadge/
        // showItemInFolder/retireNotifications）→ 本控制器 notify 路由消费。
        // event 帧族（BridgeClient.onEvent）已无生产接线（sidecar-entry 只发
        // notify；桩 fixture 仅供 BridgeClientStubIntegrationTests），页面下行
        // 唯一入口 = 本 onNotify 路由（双写纪律「乙」）。
        // 线程契约：管道读取线程回调，消费在 routeNotify 内收敛主线程。
        bridge.onNotify = { [weak self] event, payload in
            self?.routeNotify(event: event, payload: payload)
        }

        // WebView
        let webView = WKWebView(frame: NSRect(origin: .zero, size: Self.windowSize),
                                configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // 开发者工具：只在 DEBUG 构建开放（参考独立 Swift 原生壳的通行做法：
        // debug 默认开、release 默认关）。构建期常量，页面或环境变量都打不开。
#if DEBUG
        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }
#endif
        self.webView = webView
        // WKWebView 与窗口共用前端同一底色 token（#0f1115 = rgb(15,17,21)）
        // ——WKWebView 缺省白底会让首帧/重载白闪；drawsBackground=false 让页面
        // 透明区域直接露出窗口底色（亮/暗主题同值，token 常量见文件顶部）。
        webView.underPageBackgroundColor = Self.windowBackgroundColor
        // 公开面只有 underPageBackgroundColor，它只改「露底色」本身；页面未覆盖
        // 区域要透明露出窗口底，必须关 drawsBackground，而它没有公开开关
        // （`responds(to:)` 探不到该访问器，KVC 直设仍有效）。但
        // `drawsBackground` **不在公开头文件**里，私有存取器
        // `_drawsBackground`/`_setDrawsBackground:` 是否存在随 OS 版本而变；Swift
        // 无法 catch ObjC 异常，直设 KVC 在缺该存取器的构建上以 NSUnknownKeyException
        // 直接 abort 进程（实测 exit_code=134）。故走 DSHChamberWebKitSupport 的
        // 异常安全包装（@try/@catch 吞异常、返回设置结果），成功/失败都写 shellLog
        // 可诊断，缺键时保持 WebKit 默认且绝不崩。
        shellLog(Self.drawsBackgroundLogLine(DSHChamberSetDrawsBackground(webView, false)))
        // 恢复本 origin 上次的缩放（Chromium 按 origin 持久化 zoomLevel；
        // WKWebView.pageZoom 每次启动回 100%，这里用 UserDefaults 补齐）。
        webView.pageZoom = ZoomPersistence.load(
            defaults: .standard, key: zoomDefaultsKey, range: Self.zoomRange)

        // 窗口
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: Self.windowSize),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered,
                              defer: false)
        // 可见标题 = dsh-chamber（功能对齐 Electron 的标题冻结行为；不可见
        // target/可执行名保持 DSHChamber）。
        window.title = Self.displayName
        // 窗口底色 = 同一 #0f1115（缩放/全屏露底不白闪）。
        window.backgroundColor = Self.windowBackgroundColor
        window.contentView = webView
        window.center()
        // 关窗决策委托（E1/E20）：windowShouldClose 交给 AppDelegate（隐藏 vs
        // 转入退出链由 core 决策，Swift 只执行）。
        window.delegate = self
        self.window = window

        // 首帧露底色也按 **last-known 页面事实** 收敛——
        // 第二次启动时 store 内已有同值事实（后续 ingest 恒 false），只靠 ingest
        // 的变化分支会让浅色页面整场会话停在骨架深色。建窗收尾立即对账一次
        // （幂等、不记日志；窗口尚未 show，等效于"用 last-known 选初始露底色"，
        // nil → 骨架常量）。
        reconcileThemedBackground(
            desiredPageIsDark: ShellPageFactsStore.lastKnown(in: .standard)?.pageIsDark)

        // hostFacts 事实观察：窗口 key/关闭通知（主线程投递；object 限定
        // 本窗）。选择器观察者不被 center 持有；控制器与应用同生命周期
        // （AppDelegate 强持有到退出），无需 removeObserver。
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(hostFactsWindowDidBecomeKey(_:)),
                           name: NSWindow.didBecomeKeyNotification, object: window)
        center.addObserver(self, selector: #selector(hostFactsWindowDidResignKey(_:)),
                           name: NSWindow.didResignKeyNotification, object: window)
        center.addObserver(self, selector: #selector(hostFactsWindowWillClose(_:)),
                           name: NSWindow.willCloseNotification, object: window)
        // 换屏与低电量模式切换都会改变实际上限（WebKit 侧实时生效），
        // 对照日志按值去重补记（见 logRefreshRateIfChanged）。
        center.addObserver(self, selector: #selector(refreshRateWindowDidChangeScreen(_:)),
                           name: NSWindow.didChangeScreenNotification, object: window)
        // 同屏改刷新率（系统设置/显示器 OSD）不产生 didChangeScreen，只发屏幕参数变化。
        center.addObserver(self, selector: #selector(refreshRateScreenParametersDidChange(_:)),
                           name: NSApplication.didChangeScreenParametersNotification, object: nil)
        // 低电量通知按 SDK 契约在**全局队列**投递（NSProcessInfo.h），处理器自己回主线程：
        // window.screen 与指纹状态都只允许主线程碰。
        center.addObserver(self, selector: #selector(refreshRatePowerStateDidChange(_:)),
                           name: Notification.Name.NSProcessInfoPowerStateDidChange,
                           object: ProcessInfo.processInfo)
        // 验收口径：建窗之后 window.screen 才是可信的「窗口所在屏」；
        // 观察者先注册（避免首记与注册之间的同步窗口漏事件），日志按值去重。
        logRefreshRateIfChanged()
        // macOS 唤醒与窗口/应用显示的事件发送方——
        // 对偶 electron-edges onSystemResume(powerMonitor)/onMainWindowShown
        // （design 25 §5 E6）。didWake → __host.systemResume {timestamp}；
        // didBecomeActive → __host.mainWindowShown（held lastResume 补发点）。
        // 幂等：core 无 held/无待办时均为 no-op。
        // NSWorkspace 的通知必须注册在它自己的
        // 通知中心上（SDK NSWorkspace.h 明示），注册到 NotificationCenter.default
        // 永不触发——__host.systemResume 因此从未发出，core 的立即重连/held
        // 补发（shell-core.ts systemResume 路径）在原生 flavor 全失效。
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(hostWakeUp(_:)),
            name: NSWorkspace.didWakeNotification, object: nil)
        center.addObserver(self, selector: #selector(appDidBecomeActive(_:)),
                           name: NSApplication.didBecomeActiveNotification, object: nil)
    }

    // MARK: - 刷新率对照日志

    /// 刷新率对照日志（design 25 §5.1 的验收唯一口径）：刷新率按**窗口所在屏的当前模式**取，
    /// 低电量模式按当前系统态取；只在指纹变化时各写一行（不刷屏）。
    private func logRefreshRateIfChanged() {
        let refreshRate = currentDisplayRefreshRate()
        let lowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
        // 按**渲染后的日志行**去重：startupLogLine 是纯函数，行相等 ⟺ 全部事实相等，
        // 所以以后新增事实字段不需要记得同步比较逻辑。
        let line = RefreshRatePolicy.startupLogLine(
            preference: refreshRatePreference,
            displayRefreshRate: refreshRate.rate,
            displayRefreshRateIsPanelMaximum: refreshRate.isPanelMaximum,
            lowPowerMode: lowPowerMode)
        guard line != lastRefreshRateLogLine else { return }
        lastRefreshRateLogLine = line
        shellLog(line)
    }

    /// 当前显示模式的刷新率（读数，不是 WebKit 的 nominal 本体）。与 WebKit **同源但不等价**：
    /// WebKit 用 `CVDisplayLinkGetNominalOutputVideoRefreshPeriod`（DisplayLinkMac 取整），
    /// 且只在 display link 初始化时缓存一次（`DisplayLink::displayPropertiesChanged()` 仍是
    /// FIXME 空实现），取不到时回落 60；本函数读 `CGDisplayCopyDisplayMode().refreshRate`
    /// （内置屏上该值可能为 0），取不到回落面板上限并标记 isPanelMaximum = true。
    /// 所以验收一律以 `[shell-fps]` 实测仲裁（见 design 25 §5.1），日志只作对照。
    /// 窗口没有所在屏时返回 (nil, false)。
    private func currentDisplayRefreshRate() -> (rate: Int?, isPanelMaximum: Bool) {
        guard let screen = window?.screen else { return (nil, false) }
        let screenNumber = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        if let screenNumber,
           let mode = CGDisplayCopyDisplayMode(CGDirectDisplayID(truncating: screenNumber)),
           mode.refreshRate > 0 {
            return (Int(mode.refreshRate.rounded()), false)
        }
        return (screen.maximumFramesPerSecond, true)
    }

    /// 窗口换屏（含全屏/在 ProMotion 与外接 60Hz 屏之间移动）：上限变了要重记一行。
    @objc private func refreshRateWindowDidChangeScreen(_ note: Notification) {
        logRefreshRateIfChanged()
    }

    /// 屏幕参数变化（同屏换刷新率/分辨率、显示器插拔）：上限可能已变，按值去重补记。
    /// 与下面换屏回调一样按 AppKit 契约在**主线程**投递（只有低电量那条通知在全局队列，
    /// 需要自己回主线程）。
    @objc private func refreshRateScreenParametersDidChange(_ note: Notification) {
        logRefreshRateIfChanged()
    }

    /// 低电量模式切换：WebKit 侧实时改为帧间隔 ×2，日志必须跟上，否则验收对表失真。
    @objc private func refreshRatePowerStateDidChange(_ note: Notification) {
        // 该通知在**全局队列**投递（NSProcessInfo.h），必须回主线程再读 AppKit / 写主线程状态。
        DispatchQueue.main.async { [weak self] in
            self?.logRefreshRateIfChanged()
        }
    }

    // MARK: - 入站事件发送（唤醒/窗口显示）

    @objc private func hostWakeUp(_ note: Notification) {
        // 这一行**必须落盘**（shellLog = print + append）：Dock 启动的 .app
        // stdout 无处可看，shell.log（即 ShellLog.fileName）里零条唤醒行既不能
        // 证明「发过」也不能证明「没发」，真机验收因此分不开「壳没发」与
        // 「页面没消费」。
        shellLog("[shell] 系统唤醒——发送 __host.systemResume")
        Task { @MainActor in
            do {
                _ = try await bridge.invoke(
                    method: HostInboundMethod.systemResume,
                    payload: .object(["timestamp": .number(Date().timeIntervalSince1970 * 1000)]))
            } catch {
                // 事件边界绝不吞错、绝不崩——失败 loud（同
                // sendRendererLifecycle 风格；core 侧幂等，无需重试）。
                shellLog("[shell] __host.systemResume 发送失败：\(error.localizedDescription)")
            }
        }
    }

    @objc private func appDidBecomeActive(_ note: Notification) {
        // 同样落盘——这是 core held-resume 的补发点，真机取证靠它。
        shellLog("[shell] 应用激活——发送 __host.mainWindowShown")
        Task { @MainActor in
            do {
                _ = try await bridge.invoke(method: HostInboundMethod.mainWindowShown, payload: nil)
            } catch {
                shellLog("[shell] __host.mainWindowShown 发送失败：\(error.localizedDescription)")
            }
        }
    }

    override func windowDidLoad() {
        super.windowDidLoad()
        startLoadingIfNeeded()
    }

    // MARK: - 页面加载

    /// 首次加载控制面（幂等：windowDidLoad / init / noteSidecarReady 都可能触发）。
    /// sidecar ready 前**绝不**发起首载——打包态冷启动时控制面还没监听，抢跑只会
    /// 拿到「连接被拒」的 WebKit/ATS 文案并停在失败页。判定抽成纯函数
    /// （shouldStartFirstLoad，单测直测）。
    /// ready 帧只是 sidecar 协议就绪；首载前还必须先过一次 HTTP 就绪探测
    /// （GET /health 期望 2xx）——探测先行、导航在后（StartupLoadPlan 不变量）。
    private func startLoadingIfNeeded() {
        guard Self.shouldStartFirstLoad(sidecarReady: sidecarReady,
                                        didStartLoading: didStartLoading) else { return }
        didStartLoading = true
        beginHealthProbe()
    }

    /// 首载门（纯逻辑，单测直测）：sidecar ready 且尚未首载才放行。
    static func shouldStartFirstLoad(sidecarReady: Bool, didStartLoading: Bool) -> Bool {
        StartupLoadPlan.firstStep(sidecarReady: sidecarReady,
                                  didStartLoading: didStartLoading) == .probe
    }

    // MARK: - 首载 HTTP 就绪探测（探测先行）

    /// 就绪探测路径（控制面 /health；与 sidecar/control-plane 同一路由）。
    static let healthProbePath = "/health"
    /// 探测超时（秒）：loopback 的 /health 是毫秒级；2s 足够区分「尚未监听」
    /// 与「已监听但不应答」，且单次卡顿只占退避预算的一个节拍。
    static let healthProbeTimeout: TimeInterval = 2.0
    /// 在途探测（退出 / sidecar fatal 时取消）。
    private var healthProbeTask: URLSessionDataTask?

    /// 首载编排（纯逻辑，单测直测——不变量：**探测先行**，导航永不先于探测）。
    struct StartupLoadPlan: Equatable {
        /// 首载入口的第一步。
        enum Step: Equatable {
            /// sidecar 未 ready：等待（绝不导航）。
            case waitForSidecar
            /// 首载已开工（幂等去重）。
            case alreadyStarted
            /// ready 且未开工 → 必须先探测。
            case probe
        }

        /// 探测结果后的动作（复用首载退避预算）。
        enum ProbeOutcome: Equatable {
            case navigate
            case retry(after: TimeInterval)
            case giveUp
        }

        static func firstStep(sidecarReady: Bool, didStartLoading: Bool) -> Step {
            if didStartLoading { return .alreadyStarted }
            return sidecarReady ? .probe : .waitForSidecar
        }

        /// 2xx → navigate；否则按首载退避预算重试/耗尽（sidecar fatal 立即 giveUp）。
        static func outcome(afterProbeReachable reachable: Bool, attempts: Int,
                            sidecarFailed: Bool) -> ProbeOutcome {
            if reachable { return .navigate }
            switch StartupLoadRetry.decision(attempts: attempts, sidecarFailed: sidecarFailed) {
            case .retry(let delay): return .retry(after: delay)
            case .giveUp: return .giveUp
            }
        }
    }

    /// 探测 URL（纯逻辑，单测直测）：控制面 origin 的根路径 + /health。
    static func healthProbeURL(cpURL: URL) -> URL? {
        guard let origin = origin(of: cpURL) else { return nil }
        return URL(string: origin + healthProbePath)
    }

    /// 就绪判据（纯逻辑，单测直测）：HTTP 2xx 才算控制面可达。
    static func isHealthyResponse(statusCode: Int) -> Bool {
        (200..<300).contains(statusCode)
    }

    /// 探测失败的可诊断原因（纯逻辑，单测直测）：NSURLError 带域与码——ATS
    /// 拒绝（NSURLErrorAppTransportSecurityRequiresSecureConnection，-1022）
    /// 等网络层事实进落盘日志与失败页 detail，而不是只有「未就绪」三个字。
    /// 本地化：failure.probeNSURLError（%d = 错误码、%@ = 系统描述）/
    /// failure.probeHTTPStatus（%d = 状态码）/ failure.probeNoResponse；
    /// 非 NSURLError 的 localizedDescription 由系统本地化，原样透出。
    static func healthProbeFailureDetail(statusCode: Int?, error: Error?) -> String {
        if let error {
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain {
                return NativeText.format(.failureProbeNSURLError, Int32(nsError.code),
                                         error.localizedDescription)
            }
            return error.localizedDescription
        }
        if let statusCode {
            return NativeText.format(.failureProbeHTTPStatus, Int32(statusCode))
        }
        return NativeText.string(.failureProbeNoResponse)
    }

    /// 首载第一步：探测（绝不直接导航）。
    private func beginHealthProbe() {
        guard let probeURL = Self.healthProbeURL(cpURL: cpURL) else {
            handleHealthProbeFailure(statusCode: nil, error: nil, probeURL: cpURL)
            return
        }
        shellLog("[shell] 控制面就绪探测先行：GET \(probeURL.absoluteString)")
        var request = URLRequest(url: probeURL)
        request.httpMethod = "GET"
        request.timeoutInterval = Self.healthProbeTimeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let task = URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.healthProbeTask = nil
                let statusCode = (response as? HTTPURLResponse)?.statusCode
                if let statusCode, Self.isHealthyResponse(statusCode: statusCode) {
                    self.loadControlPlaneAfterProbe()
                } else {
                    self.handleHealthProbeFailure(statusCode: statusCode, error: error,
                                                  probeURL: probeURL)
                }
            }
        }
        healthProbeTask = task
        task.resume()
    }

    /// 探测 2xx 后的首载导航（唯一首载导航入口）。
    private func loadControlPlaneAfterProbe() {
        shellLog("[shell] 控制面就绪（GET \(Self.healthProbePath) 2xx），加载控制面 "
            + "\(cpURL.absoluteString)（origin=\(cpOrigin)）")
        // 启动分段（sidecar ready → 控制面就绪 → 首帧）。
        shellLog(ShellPerf.bootLine("controlPlaneReady"))
        webView.load(URLRequest(url: cpURL))
    }

    /// 探测失败 = 「控制面未就绪」的同义事实：走同一退避预算；预算耗尽才
    /// 落失败说明页（原因是探测的真实错误，不是 WebKit 的错误包装）。
    private func handleHealthProbeFailure(statusCode: Int?, error: Error?, probeURL: URL) {
        // sidecar 已 fatal 时权威原因已呈现，晚到的探测失败不覆盖。
        if startupFailureMessage != nil { return }
        let detail = Self.healthProbeFailureDetail(statusCode: statusCode, error: error)
        switch Self.StartupLoadPlan.outcome(afterProbeReachable: false, attempts: navRetries,
                                            sidecarFailed: false) {
        case .navigate:
            return
        case .retry(let delay):
            navRetries += 1
            shellLog("[shell] 控制面未就绪（就绪探测失败 \(detail)），"
                + "\(navRetries)/\(Self.StartupLoadRetry.maxAttempts) 次重试 "
                + "\(String(format: "%.1f", delay))s 后探测 \(probeURL.absoluteString)")
            scheduleNavRetry(probe: true, url: probeURL, after: delay)
        case .giveUp:
            shellLog("[shell] 控制面就绪探测耗尽（\(detail)）：\(probeURL.absoluteString)")
            showLoadFailurePage(in: webView,
                                error: HealthProbeFailureError(detail: detail),
                                exhausted: true)
        }
    }

    /// 就绪探测失败的失败页错误（LocalizedError 直出可诊断原因）。
    /// 本地化：failure.probeFailed（%@ = 已本地化的探测 detail）。
    struct HealthProbeFailureError: LocalizedError {
        let detail: String
        var errorDescription: String? { NativeText.format(.failureProbeFailed, detail) }
    }

    // MARK: - 启动窗口呈现门（绝不先亮无内容空窗）

    /// 启动呈现门（纯逻辑单测直测）：首个可呈现内容才允许亮窗，且只触发一次；
    /// 后续提交（重载/重试/失败页后的再次导航）不重复呈现。
    /// 同一状态机承载失败说明页的一次性 about: 导航豁免：WebKit 实测回调顺序是
    /// decidePolicyFor(about:blank) **先**、didCommit(about:blank) **后**。
    /// 若在 decidePolicyFor 消费豁免，didCommit 就读到 failurePage:false →
    /// isPresentableCommit(about:blank, false) = false → 呈现门永不触发，失败页
    /// 加载进不可见窗口（用户点 Dock 才看见）。因此豁免只在 didCommit 消费；
    /// decidePolicyFor 只做只读放行，didFail* 撤销未落地的豁免（一次性面不放大）。
    struct StartupPresentationGate {
        private(set) var presented = false
        /// 失败说明页导航豁免在途（beginFailurePage → didCommit 消费 / didFail 撤销）。
        private(set) var failurePagePending = false

        /// 失败页导航开始（showLoadFailurePage 在 loadHTMLString 之前置位）。
        mutating func beginFailurePage() {
            failurePagePending = true
        }

        /// decidePolicyFor 的豁免观察（只读，绝不消费——见类型注记的顺序无关性）。
        func allowsFailurePageNavigation() -> Bool {
            failurePagePending
        }

        /// didCommit：消费失败页豁免并裁决本次提交是否呈现主窗（只呈现一次）。
        /// 失败页恒可呈现；WKWebView 初始空文档（url 为 nil / about:blank 且非
        /// 失败页）不算——启动期为此保持隐藏（presented 不被它占掉）。
        mutating func shouldPresentOnCommit(url: String?) -> Bool {
            let failurePage = failurePagePending
            failurePagePending = false
            guard MainWindowController.isPresentableCommit(url: url, failurePage: failurePage),
                  !presented else { return false }
            presented = true
            return true
        }

        /// 失败页导航未落地（didFail/didFailProvisionalNavigation）：撤销豁免，
        /// 绝不让它悬着放行后续 about: 导航（一次性安全面）。
        mutating func noteNavigationFailed() {
            failurePagePending = false
        }
    }

    /// 一次导航提交是否算「可呈现内容」（纯逻辑单测直测）：失败说明页恒算
    /// （about:blank，但由一次性豁免放行）；WKWebView 初始空文档（url 为 nil /
    /// about:blank 且非失败页）不算——启动期为此保持隐藏。
    static func isPresentableCommit(url: String?, failurePage: Bool) -> Bool {
        if failurePage { return true }
        guard let url, !url.isEmpty, url != "about:blank" else { return false }
        return true
    }

    // MARK: - hostFacts 推送（窗口/聚焦/加载事实 → sidecar 同步门缓存）

    /// 推送失败后的意图回滚（纯逻辑，单测直测）：只撤销**本次推送且期间未被
    /// 更新的**键（同键同值才撤），使下一次同类事件重新携带该事实；若期间有
    /// 更新（值已变），保留新意图不撤（避免用旧值覆盖）。
    static func hostFactsRollback(last: [String: Bool], pushed: [String: Bool]) -> [String: Bool] {
        var rolledBack = last
        for (key, value) in pushed where rolledBack[key] == value {
            rolledBack.removeValue(forKey: key)
        }
        return rolledBack
    }

    /// 导航生命周期三态（WKNavigationDelegate 回调映射）。
    enum NavigationOutcome {
        case started
        case finished
        case failed
    }

    /// 导航事实变换（纯逻辑单测直测）：
    ///  - started  → webViewLoading:true；
    ///  - finished → webViewLoading:false + webViewContentAlive:true；
    ///  - failed   → webViewLoading:false（失败无 didFinish，也必须收敛，
    ///    否则 sidecar 侧 webViewLoading 同步门永久为 true，通知打开/深链
    ///    drain 被 hold）。
    static func navigationFacts(for outcome: NavigationOutcome) -> [String: Bool] {
        switch outcome {
        case .started:
            return ["webViewLoading": true]
        case .finished:
            return ["webViewLoading": false, "webViewContentAlive": true]
        case .failed:
            return ["webViewLoading": false]
        }
    }

    /// hostFacts 去重合并（纯逻辑，单测直测——HostFactsDiffTests）。给定
    /// 已推送（含意图）事实 last 与拟推送变化 changes：
    ///   - payload = changes 中与 last 同键异值者（last 无该键视为异值——
    ///     首推必推）；payload 为空 = 无变化，调用方应跳过推送；
    ///   - merged = last 并入 changes 全部键（意图簿记：无论本次推送成败，
    ///     后续事件以此值去重——失败时随后的事实变化事件会携带最新值再推
    ///     收敛，见 pushHostFacts 注释）。
    /// 字典键序不影响 JSON 对象语义（sidecar 侧 handleHostInbound 按键级
    /// 合并：仅 typeof boolean 的键生效）。
    static func hostFactsDiff(last: [String: Bool], changes: [String: Bool])
        -> (payload: [String: Bool], merged: [String: Bool]) {
        var merged = last
        var payload: [String: Bool] = [:]
        for (key, value) in changes {
            merged[key] = value
            if last[key] != value {
                payload[key] = value
            }
        }
        return (payload, merged)
    }

    /// 推送一条 hostFacts 事实变化。幂等：与 lastHostFacts 同键同值 → 跳过
    /// （不产生推送也不刷意图簿记）。发送为 fire-and-forget：
    ///   - 簿记（lastHostFacts = merged）在事件回调内同步完成——全部调用点
    ///     为主线程回调（AppKit 窗口通知 / WKNavigationDelegate），去重与
    ///     事件序一致；
    ///   - 实际发送经 `Task { @MainActor in … }`：@MainActor 任务队 FIFO 且
    ///     invoke 的登记与写帧在任务首个同步段完成（其后挂起等应答），故帧
    ///     写序 = 事件入队序，杜绝并发推送乱序把旧值后写到 sidecar；invoke
    ///     的线程安全由 BridgeClient 保证（与 handleInvoke 同款收敛）；
    ///   - 失败 loud 打印并**回滚本次意图**（`hostFactsRollback`）：启动期首推
    ///     早于 `bridge.start()`（invoke 必抛「未在运行」），不回滚会让去重簿记
    ///     误判已送达——而 sidecar 侧存活事实缺省「未知=不可交付」，rendererPush
    ///     将长期返回 false（通知/深链被 hold）。回滚后下一次同类事件重推；
    ///     ready 时的 `resetHostFactsBookkeeping()` 仍会推全量快照兜底。
    /// sidecar 重启（新进程没有历史事实）→ 清空去重簿记，下一次推送即全量
    /// 快照；否则新 sidecar 会长期以「种子事实」运行。
    /// 快照必须含 focused = window.isKeyWindow 的实时值——否则重启前缓存
    /// 的 focused=false 会粘滞到下一次 key 事件，窗口明明是 key 却推 false。
    func resetHostFactsBookkeeping() {
        lastHostFacts = [:]
        pushHostFacts(Self.resetFacts(isKeyWindow: window?.isKeyWindow ?? false))
    }

    /// sidecar 重启后的全量事实快照（纯逻辑，单测直测）。
    static func resetFacts(isKeyWindow: Bool) -> [String: Bool] {
        ["mainWindowAlive": true, "webViewContentAlive": true, "focused": isKeyWindow]
    }

    private func pushHostFacts(_ changes: [String: Bool]) {
        let (payload, merged) = Self.hostFactsDiff(last: lastHostFacts, changes: changes)
        guard !payload.isEmpty else { return }
        lastHostFacts = merged
        let summary = payload.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: " ")
        shellLog("[shell] hostFacts 推送 \(summary)")
        let object = AnyCodable.object(payload.mapValues { .bool($0) })
        let pushed = payload
        Task { @MainActor in
            do {
                _ = try await bridge.invoke(method: Self.hostFactsMethod, payload: object)
            } catch {
                // 失败必须回滚意图：首推发生在 bridge.start()
                // 之前 → invoke 直接抛「未在运行」；若不回滚，去重簿记会认为该
                // 事实已送达，而 sidecar 侧存活事实缺省为「未知=不可交付」，于是
                // rendererPush 长期返回 false、通知/深链被永久 hold。
                self.lastHostFacts = Self.hostFactsRollback(last: self.lastHostFacts, pushed: pushed)
                shellLog("[shell] hostFacts 推送失败（已回滚意图，等待下次事件重推）：\(error.localizedDescription)")
            }
        }
    }

    /// NSWindow.didBecomeKeyNotification：窗口成为 key（启动首显 / 隐藏、
    /// 最小化后恢复 / Dock 重开都会触发）→ focused:true。附带
    /// mainWindowAlive:true：POC 关窗不销毁窗口对象（willClose 已推 false，
    /// 应用仍常驻 Dock），重开即“窗口重新可用于投递”——与 Electron 侧
    /// activate 重建窗口后 mainWindowAlive 恢复 true 同刻收敛；正常 key
    /// 往返（alive 未变）时去重后不产生额外推送。
    @objc private func hostFactsWindowDidBecomeKey(_ notification: Notification) {
        pushHostFacts(["mainWindowAlive": true, "focused": true])
        // 上屏兜底一拍——若首次记录时窗口还不在屏上（screen == nil），
        // 这里补进真实上限；正常路径被整行去重吞掉，不产生重复行。
        logRefreshRateIfChanged()
    }

    /// NSWindow.didResignKeyNotification：窗口失去 key（切走应用 / 隐藏 /
    /// 最小化 / 关窗先于 willClose 都会触发）→ focused:false（electron-edges
    /// isFocused = 可见且聚焦的实时查询的事件化等价）。
    @objc private func hostFactsWindowDidResignKey(_ notification: Notification) {
        pushHostFacts(["focused": false])
    }

    /// NSWindow.willCloseNotification：主窗关闭（隐藏到 Dock 常驻语义，窗口
    /// 对象不销毁）→ mainWindowAlive:false（electron-edges mainWindowAlive =
    /// 窗口存在且未销毁的折算：关窗期间同步门一律不过；Dock 重开后由
    /// hostFactsWindowDidBecomeKey 推回 true）。同时上报 closed 生命周期
    /// （design 25 §5 E19 三事件映射之一：core 复位 ready 位 + in-flight 重排）。
    @objc private func hostFactsWindowWillClose(_ notification: Notification) {
        pushHostFacts(["mainWindowAlive": false])
        sendRendererLifecycle("closed")
    }

    // MARK: - 渲染器生命周期上报（design 25 §4.5/§5 E19）

    /// 上报渲染器生命周期事件给 core（`__host.rendererLifecycle`）。语义单源
    /// 在 core（shell-core.onRendererLifecycle：did-start-loading 复位 ready 位
    /// + in-flight requeue、did-finish-load drain、crashed/closed 立即失效），
    /// Swift 只做事件源，绝不复制状态机。fire-and-forget：失败 loud 不重试
    /// （下一次事件会再报；sidecar 未就绪时帧被 stdin 管道缓冲）。
    private func sendRendererLifecycle(_ event: String) {
        shellLog("[shell] rendererLifecycle 上报 \(event)")
        Task { @MainActor in
            do {
                _ = try await bridge.invoke(
                    method: HostInboundMethod.rendererLifecycle,
                    payload: .object(["event": .string(event)]))
            } catch {
                shellLog("[shell] rendererLifecycle 上报失败（\(event)）：\(error.localizedDescription)")
            }
        }
    }

    // MARK: - B 桥 invoke / sidecar 事件回写页面

    /// web → Swift invoke（经 handler 转发）：调 B 桥后把结果交回页面
    /// Interactive pickers and runtime installs may legitimately take minutes;
    /// every ordinary page invoke has a short deadline and all are bounded.
    private static func invokeDeadline(for method: String) -> TimeInterval {
        if method.hasPrefix("dsh-chamber:runtime-") || method.hasPrefix("dsh-chamber:update-")
            || method.contains("_pick") || method.contains("materialize")
            || method == "desktop_local_plugin_add_file" {
            return 720
        }
        return 45
    }

    private func handleInvoke(documentId: String, id: Int, method: String, payload: AnyCodable?) {
        // 计时戳仅在调试态取（生产零成本，注释与实现一致）。
        let started = ShellDebug.isEnabledCached ? Date() : nil
        if ShellDebug.isEnabledCached {
            shellLog("[shell] invoke #\(id) \(method)")
        }
        Task { @MainActor in
            do {
                let result = try await bridge.invoke(method: method, payload: payload,
                                                     timeout: Self.invokeDeadline(for: method))
                if let started, ShellDebug.isEnabledCached {
                    // 单次 invoke 的端到端耗时（含 B 桥往返与结果编码），
                    // 仅调试态打印。
                    shellLog("[perf] invoke \(method) \(Int((Date().timeIntervalSince(started) * 1000).rounded()))ms")
                }
                let resultJSON = Self.jsonLiteral(of: result)
                evaluateJS("__dshChamberResolve(\(nativeTokenLiteral), \(Self.jsonLiteral(of: .string(documentId))), \(id), \(resultJSON), null)")
            } catch {
                // 失败：__dshChamberResolve(id, null, <errorString>)；errorString
                // 经 JSON 序列化即为合法 JS 字符串字面量。
                // fence 的尺寸门用「安全上界」短路，其成立
                // 依赖 AnyCodable.jsonUpperBoundByteCount ≥ 实际线格式字节（含
                // 「JSONSerialization 不对非 ASCII 转义」这一平台事实，已由
                // AnyCodableTests.upperBound 用例钉住）。若该前提在某平台不成立，
                // 超大信封会改在报文组帧处抛 frameTooLarge——这里把错误码还原为与
                // fence 相同的页面可见字面量，避免退化成不可归因的通用文案
                // （FrameCodec.encode 与 TrustGuard.maxMessageBytes 同值同源）。
                let message: String
                if let frameError = error as? FrameCodecError, case .frameTooLarge = frameError {
                    message = ChamberMessageHandler.codeFrameTooLarge
                } else {
                    message = error.localizedDescription
                }
                // 错误串 → JS 字面量 = AnyCodable 单遍写出器：String 恒可序列化，
                // 故不设三级兜底（含 NativeText.bridgeErrorFallback）——那三级本就
                // 不可达。
                let errorJSON = Self.jsonLiteral(of: .string(message))
                evaluateJS("__dshChamberResolve(\(nativeTokenLiteral), \(Self.jsonLiteral(of: .string(documentId))), \(id), null, \(errorJSON))")
            }
        }
    }

    /// 页面 emit 直写（调用方必须已在主线程）：__dshChamberEmit(eventJSON,
    /// payloadJSON)。两个实参都经 AnyCodable 单遍写出器——String/AnyCodable
    /// 恒可序列化，故不存在「注入残缺 JS」的路径（无可选返回，也无静默失败）。
    private func emitToPage(event: String, payload: AnyCodable?) {
        let eventJSON = Self.jsonLiteral(of: .string(event))
        let payloadJSON = payload.map { Self.jsonLiteral(of: $0) } ?? "null"
        // 这一跳必须可考古：失败（JS 抛错 = 页面根本没收到）落盘，否则
        // 「壳把事件推给页面了吗」只能靠猜；成功不逐条刷日志（emit 是用户可见
        // 事件的低频面，routeNotify 那行已给出 channel）。
        webView.evaluateJavaScript(
            "__dshChamberEmit(\(nativeTokenLiteral), \(eventJSON), \(payloadJSON))"
        ) { _, error in
            if let error {
                shellLog("[shell] 页面 emit 失败 \(event)：\(error.localizedDescription)")
            }
        }
    }

    /// 主线程执行 JS（所有调用点都已收敛到主线程）
    private func evaluateJS(_ script: String) {
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    // MARK: - notify 消费路由

    /// sidecar notify → 消费（路由表与解码见文件底部 decodeNotify/
    /// NotifyRoute——纯逻辑，单测直测；本方法只做执行与 loud）。
    /// 解码在到达线程（管道读取线程）就地完成（纯函数），消费按决策收敛
    /// 主线程（Task { @MainActor }，与页面 emit 同款纪律——宿主腿触碰
    /// NSApp/NSWorkspace/dockTile 必须主线程）。
    private func routeNotify(event: String, payload: AnyCodable?) {
        switch Self.decodeNotify(event: event, payload: payload) {
        case .emitToPage(let channel, let payload):
            // rendererPush 解包：channel/payload 原样进页面（与 electron-edges
            // rendererPush = webContents.send(channel, payload) 同语义）。
            // 壳 → 页面这一跳必须落盘，否则真机上分不开「sidecar 没推」与
            // 「推了但页面没消费」（唤醒链的最后一跳）。
            shellLog("[shell] notify rendererPush → 页面 emit \(channel)")
            if channel == Self.settingsChangedChannel {
                // 设置变了 → 关窗决策缓存作废（缓存必须随设置失效）。
                onSettingsChanged?()
            }
            Task { @MainActor in
                emitToPage(event: channel, payload: payload)
            }
        case .hostLeg(let method, let payload):
            Task { @MainActor in
                guard let legs = bridge.edgeHostLegs else {
                    shellLog("[shell] notify \(method) 消费失败：edgeHostLegs 未接线（loud）")
                    return
                }
                // 与 edge 面同一执行体（respond 内部 performUI + 窗口守卫）：
                // canShowUI/窗口守卫语义一致，无窗/headless → 诚实降级。
                let outcome = legs.respond(method: method, payload: payload)
                if let error = outcome.error {
                    // notify 无回执通道（sidecar fire-and-forget）——失败只能
                    // 本侧 loud（Electron 侧同步 setBadge 失败同样不回执
                    // renderer，见 SwiftEdgeHostLegs.setBadge 注释的 parity 结论）。
                    shellLog("[shell] notify \(method) 消费失败（loud）：\(error)")
                }
            }
        case .retireNotifications(let sourceIds, let notificationIds):
            // Electron 退役语义 = 关闭登记中的活跃原生通知。Swift 侧经
            // NotificationDeliveryRegistry（sourceId→chamber-edge-<id>；identifier
            // 末段 = sidecar notificationId）取回已投递 identifier，调
            // UNUserNotificationCenter.removeDeliveredNotifications 清除 OS 通知
            // 中心存量横幅。逐条 notificationIds 在 sourceIds 为空时同样生效
            // （node-edges 的 >16 淘汰路径）。
            guard let registry = bridge.edgeHostLegs?.notificationRegistry else {
                shellLog("[shell] notify retireNotifications 消费失败：edgeHostLegs 未接线（loud）")
                return
            }
            let identifiers = registry.retire(sourceIds: sourceIds, notificationIds: notificationIds)
            guard !identifiers.isEmpty else {
                shellLog("[shell] notify retireNotifications：无已投递登记（\(sourceIds.count) 个 sourceId、"
                      + "\(notificationIds.count) 个 notificationId，no-op）")
                return
            }
            guard Bundle.main.bundleIdentifier != nil else {
                // 无 bundle（swift run dev）下 UNUserNotificationCenter.current()
                // 会崩（bundleProxyForCurrentProcess nil）——同 AppDelegate 守卫。
                shellLog("[shell] notify retireNotifications：dev 无 bundle 不支持通知中心，"
                      + "\(identifiers.count) 条登记未清除（loud）")
                return
            }
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: identifiers)
            shellLog("[shell] notify retireNotifications：已请求清除 \(identifiers.count) 条已投递通知")
        case .unexpectedClick:
            // notifyClicked 的正常路径是 __host.notifyClicked 入站请求
            // （AppDelegate userNotificationCenter click 回灌），不应经 notify
            // 到达——loud 打印不处理。
            shellLog("[shell] notify notifyClicked 不经 notify 到达（正常 = __host.notifyClicked 请求路径）——忽略（loud）")
        case .malformed(let reason):
            // 未知事件/形状非法：loud 丢弃，绝不伪造成功/猜测。
            shellLog("[shell] notify 拒绝消费（loud）：\(reason)")
        }
    }

    // MARK: - 页面事实（本地化/主题跟随）

    /// 启动早期读取 last-known 页面事实的只读入口（AppDelegate 可先于窗口创建
    /// 调用，例如决定 AppleLanguages 覆盖与初始 NSAppearance；nil = 本机从未
    /// 记录过任何事实）。
    static func lastKnownPageFacts(defaults: UserDefaults = .standard) -> ShellPageFacts? {
        ShellPageFactsStore.lastKnown(in: defaults)
    }

    /// 露底色对账决策（纯函数，单测直测）：desired 与已应用值不同才返回要
    /// 应用的色值；nil = 幂等不动（含双方都是"无事实"）。
    static func themedBackgroundColorToApply(pageIsDark: Bool?,
                                             appliedPageIsDark: Bool?) -> NSColor? {
        guard pageIsDark != appliedPageIsDark else { return nil }
        return themedBackgroundColor(pageIsDark: pageIsDark)
    }

    /// 露底色对账（幂等——记录已应用值，不同才改窗口/WKWebView 的露底色）。
    /// **不**写日志（避免每次 ingest 都刷屏）；appliedPageIsDark 只在这里推进。
    private func reconcileThemedBackground(desiredPageIsDark: Bool?) {
        guard let color = Self.themedBackgroundColorToApply(
            pageIsDark: desiredPageIsDark, appliedPageIsDark: appliedPageIsDark) else {
            return
        }
        webView?.underPageBackgroundColor = color
        window?.backgroundColor = color
        appliedPageIsDark = desiredPageIsDark
    }

    /// 合并一次页面事实上报：有变化才落盘（Store 内）并通知 sink。
    /// 主线程所有（消息回调 / evaluateJavaScript 回调 / 本方法调用点）。
    func ingestPageFacts(_ payload: [String: Any]) {
        let previous = pageFactsStore.current
        // 露底色对账**不能**挂在 ingest 的"变化"分支上——第二次启动时 store 内
        // 已有同值事实，ingest 返回 false，浅色页面会整场会话停在骨架深色。
        // 任何一次 ingest 之后都幂等收敛（与页面事实一致）；该次序抽成静态接缝，
        // 无窗口环境可直测，退回"仅变化时对账"会让 IngestReconcileSeamTests 变红。
        let changed = Self.ingestPageFacts(payload, into: pageFactsStore) { desiredPageIsDark in
            self.reconcileThemedBackground(desiredPageIsDark: desiredPageIsDark)
        }
        guard changed else { return }
        guard let facts = pageFactsStore.current else { return }
        shellLog("[shell] 页面事实更新 lang=\(facts.language.rawValue) "
            + "dark=\(facts.pageIsDark) revision=\(facts.revision)")
        pageFactsSink?.pageFactsDidChange(facts, previous: previous)
    }

    /// ingest 接缝：Store 合并 + **无条件**露底色对账回调，返回 Store 是否产生
    /// 变化。生产路径与单测共用本函数（签名 ingestPageFacts(_:into:reconcile:)，
    /// 与实例版 ingestPageFacts(_:) 共存），故"任何一次 ingest 之后必然对账露底色"
    /// 可直测：把对账挪进 changed 分支或挪到其调用之后，无变化的 ingest 就不再
    /// 触发回调，直测用例即红。
    @discardableResult
    static func ingestPageFacts(_ payload: [String: Any],
                                into store: ShellPageFactsStore,
                                reconcile: (Bool?) -> Void) -> Bool {
        let changed = store.ingest(payload)
        reconcile(store.current?.pageIsDark)
        return changed
    }

    /// 页面事实载波通道的文档面判定（纯函数，单测直测真值表）：只要求
    /// **主 frame + 同源**——url 与 expectedOrigin 都非空，且 scheme/host/port 与
    /// expectedOrigin 完全相同；**不**要求 pathname == "/"、**不**要求无 query。
    ///
    /// 取舍：A 桥保留 TrustGuard.isTrustedDocument
    /// 的严格壳文档判定——它承载 61 个 IPC 方法，同源非壳文档（/api/i/* 代理回传的
    /// 远端 HTML）继承 shim 是真实风险。本通道只携带 lang/dark 两个非敏感事实，且与
    /// A 桥白名单/就绪门完全解耦（事实必须在 sidecar ready 前可用）；页面一旦采用
    /// history.pushState/replaceState（例如把地址改成 /api/i/1 或带 query 的 SPA
    /// 路由），WKWebView 的 webView.url 会随 history API 变化，严格的「壳文档」判定会
    /// 把同一文档判成不可信 → 事实通道静默断掉直到下一次
    /// didFinish 才靠对账恢复。故按同源放宽；主 frame 围栏与导航护栏（同源非壳文档
    /// 的主 frame 导航仍被 cancel）保持失败页/异源文档进不了事实面。
    ///
    /// 同源比较是纯逻辑、绝不按字符串前缀：委托 TrustGuard.isTrustedOrigin
    /// （URLComponents 解析后比较三元组）。边界语义：
    ///   - userinfo（如 `http://evil@127.0.0.1:17520/`）→ 拒绝（同源以无凭据 URL 为前提）；
    ///   - 默认端口折叠：http 的缺省 ≡ :80、https 的缺省 ≡ :443（WHATWG 语义）；
    ///   - host（与 scheme）大小写折叠后比较；
    ///   - IPv6 字面量按 URLComponents 规范化结果比较（URL.host 已去掉方括号，两侧同形）。
    /// about:blank / data: / file: / blob:（无 http(s) scheme+host 三元组）、空 url、
    /// 空 expectedOrigin、跨源（子域 / 不同端口 / 不同 scheme，含 https）一律拒绝。
    static func isSameOriginDocument(url: String?, expectedOrigin: String?) -> Bool {
        guard let url, !url.isEmpty,
              let expectedOrigin, !expectedOrigin.isEmpty else { return false }
        return TrustGuard.isTrustedOrigin(url, expectedOrigin: expectedOrigin)
    }

    /// 事实通道文档 URL 的取值规则（纯函数，单测直测）。
    ///
    /// **webView.url 优先，frameInfo.request.url 仅兜底**：真实 WKWebView 实测，
    /// 同源 blob:/about:srcdoc 子 frame 调 parent.document.write 可以改写主 frame
    /// 文档；改写后 script message 的 frameInfo.request.url 仍是**过期的旧主 frame
    /// URL**（读 frameInfo 的门因此被绕过），而 message.webView.url / location.href /
    /// document.URL 已变成 blob:。A 桥正是读 message.webView?.url
    /// （MessageHandler.fence 的 currentURL），事实通道对齐同一来源；webView 缺席
    /// （进程终止/测试桩）才退回 frameInfo.request.url。
    static func factsDocumentURL(webViewURL: String?, frameRequestURL: String?) -> String? {
        if let webViewURL { return webViewURL }
        return frameRequestURL
    }

    /// didFinish 对账路径的准入判定（纯函数，单测直测真值表）：与观察器路径
    /// ShellPageFactsMessageHandler.accepts 共用 isSameOriginDocument（主 frame 由
    /// 对账路径本身保证：读的是**回调时刻主 frame 的 webView.url**——与观察器
    /// 路径同来源）。失败说明页（loadHTMLString → about:blank）与空 url 一律拒绝。
    static func acceptsReconcile(url: String?, expectedOrigin: String?) -> Bool {
        isSameOriginDocument(url: url, expectedOrigin: expectedOrigin)
    }

    /// didFinish 对账（snapshotSource 与注入脚本同一 dark 判定）。
    ///
    /// 回调必须先过 acceptsReconcile 才 ingest：观察器路径与对账路径共用同一
    /// isSameOriginDocument。失败说明页 about:blank 的 didFinish 若无条件 ingest，
    /// 会把 {lang:"", dark:false} 灌进 Store：空 lang 不构成语言事实（契约），但
    /// dark 变化仍生效 ⇒ 暗系统被判 pageIsDark=false、强制 .aqua 露浅底，且污染
    /// 值落盘成 last-known（下次启动先亮浅色）。失败页/about:blank 静默丢弃（与
    /// 观察器路径的拒绝同语义，不误报成「对账失败」）。「对账失败 loud 但不报警」
    /// 的语义只针对下面的 evaluateJavaScript 错误分支，保持不变。
    private func reconcilePageFacts() {
        webView.evaluateJavaScript(ShellPageFactsScript.snapshotSource()) { [weak self] result, error in
            if let error {
                // 对账失败不致命：MutationObserver 路径仍在，保留 loud 但不报警。
                shellLog("[shell] 页面事实对账失败（保留 MutationObserver 路径）："
                    + "\(error.localizedDescription)")
                return
            }
            guard let self else { return }
            // 判定用回调时刻的 webView.url：evaluateJavaScript 求值的是当时的
            // document，回调时的 URL 才是与其配对的可信文档面。
            guard Self.acceptsReconcile(url: self.webView.url?.absoluteString,
                                        expectedOrigin: self.cpOrigin) else {
                return
            }
            guard let payload = result as? [String: Any] else { return }
            self.ingestPageFacts(payload)
        }
    }

    // MARK: - 工具

    /// 读取 A 桥 shim 源码（ChamberResources：打包态 Contents/Resources、
    /// dev `swift run` 扁平布局都能定位；不用 Bundle.module——见该文件头注释）。
    static func readShimSource() -> String? {
        guard let url = ChamberResources.url(forResource: shimResourceName),
              let source = try? String(contentsOf: url, encoding: .utf8) else {
            return nil
        }
        return source
    }

    /// 启动门（纯函数，单测直测）：shim 源码缺失/为空 → 返回不可启动的
    /// 致命说明（含已查找目录与修复动作）；可用 → nil。
    ///
    /// 对齐 Electron：preload 脚本加载失败会经 dialog.showErrorBox + app.exit(1)
    /// 拒绝开窗（fail-closed）——照常开窗会让用户得到一个没有桥、全部本机能力
    /// 静默缺席的页面。
    /// 本说明是**用户可见**文案——内部资源名（bridge-shim.js）与 SwiftPM
    /// bundle 名只进 shell.log（AppDelegate 调用点显式落盘），这里只列查找
    /// 目录，绝不把 "poc" 露到提示框。
    static func shimStartupFailure(source: String?) -> String? {
        guard let source, !source.isEmpty else {
            var searched: [String] = []
            for base in ChamberResources.searchBases() {
                let path = base.path
                if !searched.contains(path) { searched.append(path) }
            }
            // 本地化：failure.shimMissing（%@ = 已查找目录，按 common.listSeparator
            // 连接；zh「、」/ en「, 」）。
            return NativeText.format(
                .failureShimMissing,
                searched.joined(separator: NativeText.string(.commonListSeparator)))
        }
        return nil
    }

    /// 由 URL 生成 origin 串 "scheme://host[:port]"（nil：URL 无合法 origin）
    /// 注：POC 用固定 dev 端口 17520，但这里从 DSH_CHAMBER_SHELL_CP_URL 解析拼接，避免硬编码
    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(),
              let rawHost = url.host, !rawHost.isEmpty else {
            return nil
        }
        // host 大小写折叠（与 TrustGuard 的判定一致，避免 origin 串因大小写
        // 与浏览器规范化结果不同而在逐字比较处失配）。
        let host = rawHost.lowercased()
        // IPv6 字面量：URL.host 去掉方括号（"::1"），拼回 origin 时必须补回，
        // 否则生成的 origin 串不可解析（`http://[::1]:17520` 会被归到
        // `http://::1:17520`，导致归一化静默跳过、IPC 全拒）。
        let hostPart = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        var origin = "\(scheme)://\(hostPart)"
        if let port = url.port {
            origin += ":\(port)"
        }
        return origin
    }

    /// **页面 JS 字面量的唯一出口**：AnyCodable → 单遍写出
    /// （AnyCodable.jsonLiteralText），免去把整棵载荷物化成 [String: Any] 树的
    /// 深拷贝，也不经 JSONEncoder（实测在深树上慢 2.1×）。
    /// JSON 文本是 JS 字面量的合法子集；无失败路径（非有限数值降级为 null），
    /// 故返回非可选。A 桥回执用的 MessageHandler.jsStringLiteral 委托同一实现。
    static func jsonLiteral(of value: AnyCodable) -> String {
        value.jsonLiteralText
    }

    // MARK: - NSWindowDelegate：关窗决策（E1/E20）

    /// 关窗请求：委托 AppDelegate 走 core 决策（hide-to-tray → orderOut 隐藏；
    /// close-behavior='quit' → NSApp.terminate 完整退出链）。返回 false = 本次
    /// 关闭被接管（AppKit 不销毁窗口）。无委托时放行（保守）。
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        closeDelegate?.handleWindowCloseRequest() ?? true
    }

    // MARK: - WKNavigationDelegate：导航护栏

    /// 导航决策（纯逻辑单测直测）。优先级：
    ///  1. shouldPerformDownload → .download（WebKit 转交 WKDownload 保存，
    ///     **绝不**把响应装进壳 webview——对此类导航 cancel 会让
    ///     session 日志导出静默假成功）；
    ///  2. 首载失败说明页的 about:blank（一次性放行）；
    ///  3. 壳文档 allow；同源非壳文档 cancel（文档绝不继承 shim/IPC 面）；
    ///     外部 http(s) / mailto 交系统；
    ///  4. **非主 frame** 的 blob: 放行（随包文档预览插件的
    ///     HTML/PDF/图片经 URL.createObjectURL 子 frame 呈现）；主 frame 的
    ///     blob 与其余 scheme 一律 cancel（主 frame 围栏不变）。
    enum NavigationDecision: Equatable {
        case allow
        case download
        case openExternally
        case cancel(reason: String)
    }

    /// - Parameter isMainFrame: 目标 frame 是否主 frame（默认 true = 未知/
    ///   无 targetFrame 时按最严的主 frame 围栏处理）。
    static func navigationDecision(url: URL?,
                                   shouldPerformDownload: Bool,
                                   failurePagePending: Bool,
                                   expectedOrigin: String,
                                   isMainFrame: Bool = true) -> NavigationDecision {
        guard let url else { return .cancel(reason: "无 URL") }
        if shouldPerformDownload { return .download }
        let scheme = (url.scheme ?? "").lowercased()
        if failurePagePending, scheme == "about" { return .allow }
        if scheme == "http" || scheme == "https" {
            // 目标是 cp origin 的 http(s)：放行（与 TrustGuard 同款大小写
            // 折叠判定——导航/消息两门行为统一）
            if TrustGuard.isTrustedDocument(url.absoluteString, expectedOrigin: expectedOrigin) {
                return .allow
            }
            // 同源但非壳文档（如 /api/i/<id>/* 代理回传的远端 HTML）：绝不
            // 放行——放行会让该文档继承 shim 与全量 IPC 面。
            // 判定不分 frame：同源非壳文档在任何 frame 都取消。
            if TrustGuard.isTrustedOrigin(url.absoluteString, expectedOrigin: expectedOrigin) {
                return .cancel(reason: "同源非壳文档")
            }
            // 其余 http(s) 外链：交给系统默认浏览器打开
            return .openExternally
        }
        if scheme == "mailto" { return .openExternally }
        if scheme == "blob", !isMainFrame {
            // 文档预览插件的 HTML/PDF/图片走 URL.createObjectURL 的 blob
            // 子 frame（vendor ui-sidebar-documentpreview）。非主 frame 的该文档
            // 拿不到桥：shim 只注入主 frame（BridgeShimInjector.makeUserScript
            // forMainFrameOnly=true），且消息围栏丢弃非主 frame 消息
            // （MessageHandler.fence 的 isMainFrame 门）——因此放行不扩大桥面。
            // 主 frame 的 blob 仍按主 frame 围栏取消：壳文档只允许 ready 的 cp origin。
            // about:blank/data: 不在放行之列（预览插件不需要；主 frame 的
            // about:blank 仅经失败页一次性门放行）。
            return .allow
        }
        return .cancel(reason: "非 http(s) scheme")
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        switch Self.navigationDecision(url: url,
                                       shouldPerformDownload: navigationAction.shouldPerformDownload,
                                       failurePagePending: presentationGate.allowsFailurePageNavigation(),
                                       expectedOrigin: cpOrigin,
                                       // targetFrame 缺省（新窗口等）按主 frame
                                       // 最严围栏处理，绝不因未知而放宽。
                                       isMainFrame: navigationAction.targetFrame?.isMainFrame ?? true) {
        case .allow:
            // 失败页一次性豁免在这里只**观察**、绝不消费（didCommit 才消费——
            // 本回调实测先于 didCommit 到达，消费会让失败页呈现门失效）。只有
            // about: 导航能带着豁免走到这里，放行面不放大；blob 子 frame 放行
            // 也绝不会吃掉 main frame 的豁免。
            if presentationGate.allowsFailurePageNavigation(),
               (url?.scheme ?? "").lowercased() == "about" {
                shellLog("[shell] 放行首载失败说明页（about:blank，一次性门；didCommit 消费）")
            } else {
                shellLog("[shell] 放行导航 \(url?.absoluteString ?? "")")
            }
            decisionHandler(.allow)
        case .download:
            // .download 不装载文档（WKDownload 负责保存）；前端 session
            // 日志导出的 anchor[download] 走这条路，页面仍发布 success。
            shellLog("[shell] 导航转下载（不装入壳 webview）\(url?.absoluteString ?? "")")
            decisionHandler(.download)
        case .openExternally:
            shellLog("[shell] 外链交给系统打开 \(url?.absoluteString ?? "")")
            if let url { openExternally(url) }
            decisionHandler(.cancel)
        case .cancel(let reason):
            shellLog("[shell] 拦截导航（\(reason)）\(url?.absoluteString ?? "")")
            decisionHandler(.cancel)
        }
    }

    /// 响应级下载：MIME 不可呈现（如 application/zip 的 session 导出）
    /// 转下载；能呈现才放行。响应级导航不会是外链——外链在 action 级已转系统。
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if !navigationResponse.canShowMIMEType {
            shellLog("[shell] 响应不可呈现 → 转下载 \(navigationResponse.response.url?.absoluteString ?? "")")
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView,
                 navigationAction: WKNavigationAction,
                 didBecome download: WKDownload) {
        download.delegate = self
        shellLog("[shell] 导航已转为下载（action 级）")
    }

    func webView(_ webView: WKWebView,
                 navigationResponse: WKNavigationResponse,
                 didBecome download: WKDownload) {
        download.delegate = self
        shellLog("[shell] 导航已转为下载（response 级）")
    }

    // MARK: - WKDownloadDelegate（对齐 Electron 默认下载）

    /// 保存目标：**静默落盘到下载目录**，与 Electron 默认下载例程等价——Electron
    /// 全仓无 will-download/setSavePath = Chromium 默认静默写
    /// app.getPath('downloads')，无保存面板、无下载 UI、无用户同意。
    /// 保存面板是单向多出的确认，不是 Electron 默认下载例程的对偶；
    /// 目标路径规则见 DownloadDestination.swift 头注释。
    ///
    /// WebKit 契约（WKDownloadDelegate.h）：目标必须是**已存在且可写目录里不存在
    /// 的文件** → 按 Chromium 的 " (n)" 规则去重（DownloadDestination），目录缺失
    /// 则创建。解析/创建失败 → completionHandler(nil)（WebKit 取消下载）+ 落盘
    /// 日志诚实上报；在途下载的文件名同时记入预留集合，防同批并发撞名。
    func download(_ download: WKDownload,
                  decideDestinationUsing response: URLResponse,
                  suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let directory = DownloadDestination.defaultDirectory()
        let destination = DownloadDestination.destination(
            directory: directory,
            suggestedFilename: suggestedFilename,
            exists: { [weak self] path in
                self?.reservedDownloadPaths.contains(path) ?? false
                    || FileManager.default.fileExists(atPath: path)
            })
        guard let destination else {
            shellLog("[shell] 下载失败：无法解析/创建下载目录（\(directory?.path ?? "<未知>")）"
                + "——取消下载（诚实失败，绝不静默换路径）")
            completionHandler(nil)
            return
        }
        reservedDownloadPaths.insert(destination.path)
        downloadDestinations[ObjectIdentifier(download)] = destination.path
        shellLog("[shell] 下载静默落盘（建议文件名 \(suggestedFilename)）→ \(destination.path)")
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        releaseDownloadReservation(download)
        shellLog("[shell] 下载完成")
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        releaseDownloadReservation(download)
        shellLog("[shell] 下载失败：\(error.localizedDescription)")
    }

    /// 释放下载预留（完成/失败共用；预留只为同一批并发下载不撞名，与真实文件
    /// 存在性判定并联——绝不影响磁盘上的既有文件）。
    private func releaseDownloadReservation(_ download: WKDownload) {
        if let path = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) {
            reservedDownloadPaths.remove(path)
        }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        // handler 的 origin 判定以 message.webView?.url 实时值为优先，
        // 本记录（lastCommittedURL）作兜底（进程终止/测试桩场景）
        bridgeHandler.noteCommitted(url: webView.url?.absoluteString)
        // 首个「有内容」的提交才呈现启动主窗——窗口在此之前保持隐藏，绝不先亮
        // 无内容空窗（Electron 在 controlPlane.start() 完成后才 createMainWindow
        // 的对偶；失败说明页同为已提交内容，因此失败终态仍可见）。失败页豁免在
        // 此消费（decidePolicyFor 只观察不消费——两个回调的真实先后顺序因此都
        // 不影响呈现）。
        if presentationGate.shouldPresentOnCommit(url: webView.url?.absoluteString) {
            // 启动 → 首个可呈现提交（主窗呈现触发点）的耗时。
            shellLog(ShellPerf.bootLine("firstFrame \(webView.url?.absoluteString ?? "(未知)")"))
            onFirstCommittedContent?()
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        hangWatchdog.reset()
        // provisional 导航开始（首载 / 退避重试 / 重载统一入口）→
        // webViewLoading:true（electron-edges webViewLoading = isLoading 的
        // 事件化等价；失败路径由 didFail* 推 false 收敛，见 navigationFacts）
        pushHostFacts(Self.navigationFacts(for: .started))
        // 导航开始即**取消已排定的崩溃重载**（Electron did-start-loading 里
        // clearCrashReloadTimer）并上报（core 复位 ready 位 + in-flight 重排）。
        cancelPendingRecoveryReload()
        sendRendererLifecycle("did-start-loading")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        shellLog("[shell] 页面加载完成 \(webView.url?.absoluteString ?? "(未知)")")
        window?.title = Self.displayName
        // 崩溃归因：记录本次加载完成时刻；若这次加载来自崩溃恢复，落地耗时是
        // "崩溃→重载→可用"这段用户可见空窗的直接量度。
        let previousLoad = lastLoadFinishedAt
        lastLoadFinishedAt = Date()
        // 一次真正成功的加载结束放弃态（give-up 闸门重新武装）。这是闸门的
        // "生命周期"落点——不是超时、不是重试计数，而是"页面确实活了"。
        if recoveryGaveUp {
            recoveryGaveUp = false
            shellLog("[shell] 渲染恢复放弃态已随加载完成复位")
        }
        if recoveringFromCrash {
            let recoveredAfter = lastCrashAt.map { Date().timeIntervalSince($0) } ?? -1
            let sincePrevious = previousLoad.map { Date().timeIntervalSince($0) } ?? -1
            shellLog(String(format: "[shell] 渲染恢复落地（崩溃后 %.2fs 重载完成，距上次加载完成 %.2fs，本窗口崩溃 %d 次）",
                            recoveredAfter, sincePrevious, crashesSinceLoad))
            recoveringFromCrash = false
            crashesSinceLoad = 0
        }
        // 首载/重载成功 → 重试预算归零（下一次失败从最小退避重新开始）。
        navRetries = 0
        navRetryWorkItem?.cancel()
        navRetryWorkItem = nil
        // 首载成功前卡死探测器不 ping/不重载（Electron loadedOnce 门）——
        // 建窗到控制面就绪之间的白屏加载不得被误判卡死。
        hangWatchdog.noteFirstLoadFinished()
        // 加载完成 → webViewLoading:false + webViewContentAlive:true。
        // 渲染进程终止后的恢复导航成功也在此把 alive 收敛回 true（崩溃回调
        // webViewWebContentProcessDidTerminate 推 false 并触发 E19 有界重载）。
        pushHostFacts(Self.navigationFacts(for: .finished))
        // E19 三事件映射之二：加载完成 = core 的确定性 replay 边（drain 待发
        // 通知点击/深链 intent）。
        sendRendererLifecycle("did-finish-load")
        // 页面事实对账：MutationObserver 首次上报可能早于 lang/body 落定，
        // didFinish 时按与注入脚本相同的判定再拉一次（ingest 幂等，无变化
        // 不打扰 sink）。
        reconcilePageFacts()
        // POC dev 白屏诊断（仅 DSH_CHAMBER_SHELL_DEBUG=1，默认关闭）：延迟数秒后渲染
        // 快照落盘（takeSnapshot 不需要屏幕录制权限；多帧取样便于观察首屏演进）。
        guard ShellDebug.isEnabledCached, !didSnapshot else { return }
        didSnapshot = true
        let snapshotURL = URL(fileURLWithPath: "/tmp/dsh-chamber-ui-snapshot.png")
        Task { @MainActor in
            for delay in [4.0, 12.0] {
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                let config = WKSnapshotConfiguration()
                config.rect = webView.bounds
                let image = try? await webView.takeSnapshot(configuration: config)
                guard let image,
                      let tiff = image.tiffRepresentation,
                      let rep = NSBitmapImageRep(data: tiff),
                      let png = rep.representation(using: .png, properties: [:]) else {
                    shellLog("[shell] 快照失败（delay=\(delay)）")
                    continue
                }
                do {
                    try png.write(to: snapshotURL)
                    shellLog("[shell] 快照已写 \(snapshotURL.path)（delay=\(delay)s）")
                } catch {
                    shellLog("[shell] 快照写盘失败：\(error.localizedDescription)")
                }
            }
        }
    }

    func webView(_ webView: WKWebView,
                 didFail navigation: WKNavigation!,
                 withError error: Error) {
        window?.title = Self.displayName
        // 失败路径必须推 webViewLoading:false（无 didFinish 可收敛；
        // sidecar 侧同步门若保持 true，通知打开/深链 drain 会被永久 hold）。
        pushHostFacts(Self.navigationFacts(for: .failed))
        // 失败页导航若没有走到提交就失败，一次性豁免没有落地对象——
        // 撤销，绝不让它悬着放行后续 about: 导航（非失败页导航时为 no-op）。
        presentationGate.noteNavigationFailed()
        // 打包态控制面 origin 已是 localhost，ATS 例外用正确键名
        // NSExceptionAllowsInsecureHTTPLoads；此处保留退避重试——探测已 2xx 而
        // 导航仍失败属 WebKit 层事实，错误原文照旧落盘。
        shellLog("[shell] 页面加载失败 \(error.localizedDescription)")
    }

    /// 设置变化 push 通道（与 ipc-events.ts SETTINGS_CHANGED 同字面量）。
    static let settingsChangedChannel = "dsh-chamber:settings-changed"

    /// sidecar 就绪态（AppDelegate 的 bridge.onReady / 重启回调）。
    /// `false` = 新进程未就绪 → A 桥 origin 门落闸（重启窗口不放行）。
    /// 无「免门桩态」：dev/装配侧车恒为 sidecar-entry/sidecar.js，
    /// 就绪只由 ready 帧开启；形状未识别的自定义 DSH_CHAMBER_SHELL_SIDECAR 自负 ready 协议。
    func noteSidecarReady(_ ready: Bool = true) {
        sidecarReady = ready
        if !ready {
            evaluateJS("window.__dshChamberBridgeReset && window.__dshChamberBridgeReset(\(nativeTokenLiteral))")
        }
        // ready 帧后让页面重跑一次 info 水化：shim 在 documentStart 就定义
        // surface，若首次 1+10 次水化都在 ready 前被就绪门拒掉，没有 re-kick
        // 就会让版本/平台整会话缺失。
        if ready {
            evaluateJS("window.__dshChamberRehydrateInfo && window.__dshChamberRehydrateInfo(\(nativeTokenLiteral))")
            evaluateJS("window.__dshChamberSidecarReady && window.__dshChamberSidecarReady(\(nativeTokenLiteral))")
            // ready 才允许首载（打包态冷启动竞态的根治点；重启后再次
            // ready 也走这里，didStartLoading 去重）。
            startLoadingIfNeeded()
        }
    }

    /// 退出清理已开始：A 桥 app_quitting 门置位（AppDelegate
    /// beginTerminationCleanup 调用）。置位后 late invoke 一律回 app_quitting。
    func noteQuitting() {
        quitting = true
    }

    /// 退出清理开始 → 抑制渲染恢复并取消已排定重载（AppDelegate 调用）。
    func suppressRendererRecovery() {
        recoverySuppressed = true
        cancelPendingRecoveryReload()
        // 退出在途也不排定首载退避重试（在途就绪探测同样取消）。
        navRetryWorkItem?.cancel()
        navRetryWorkItem = nil
        healthProbeTask?.cancel()
        healthProbeTask = nil
        hangProbeTimer?.invalidate()
        hangProbeTimer = nil
    }

    // MARK: - 菜单动作：重新加载 / 页面缩放

    /// 本 origin 的缩放持久化键（Chromium per_host_zoom_levels 的按 origin
    /// 语义；读写见 ZoomPersistence 与 setupWindow/zoomIn/zoomOut/resetPageZoom）。
    private var zoomDefaultsKey: String { ZoomPersistence.defaultsKey(cpOrigin: cpOrigin) }

    /// 页面缩放步进（Electron 默认 View 菜单 role 对偶；WKWebView.pageZoom 是倍率）。
    static let zoomStep = 0.1
    /// pageZoom 上下限（Electron zoomLevel ±0.5 的可见等价区间，绝不无限缩放）。
    static let zoomRange: ClosedRange<Double> = 0.5...3.0

    /// 缩放决策（纯逻辑单测直测）：clamp 到 zoomRange；非有限值回落 1.0。
    static func steppedZoom(current: Double, direction: Double) -> Double {
        guard current.isFinite else { return 1.0 }
        return min(max(current + direction * zoomStep, zoomRange.lowerBound), zoomRange.upperBound)
    }

    func reloadPage() {
        shellLog("[shell] 菜单重新加载")
        webView.reload()
    }

    /// 「强制重新加载」（Electron 默认菜单 forceReload role 对偶：
    /// reloadIgnoringCache 忽略缓存重新取源）。
    func forceReloadPage() {
        shellLog("[shell] 菜单强制重新加载（忽略缓存）")
        _ = webView.reloadFromOrigin()
    }

    func zoomIn() {
        let zoom = Self.steppedZoom(current: webView.pageZoom, direction: 1)
        webView.pageZoom = zoom
        persistPageZoom(zoom)
        shellLog("[shell] 菜单放大 → pageZoom=\(zoom)")
    }

    func zoomOut() {
        let zoom = Self.steppedZoom(current: webView.pageZoom, direction: -1)
        webView.pageZoom = zoom
        persistPageZoom(zoom)
        shellLog("[shell] 菜单缩小 → pageZoom=\(zoom)")
    }

    func resetPageZoom() {
        webView.pageZoom = 1.0
        persistPageZoom(1.0)
        shellLog("[shell] 菜单实际大小 → pageZoom=1.0")
    }

    /// 缩放写回（读侧 = setupWindow 的 ZoomPersistence.load）。
    private func persistPageZoom(_ zoom: Double) {
        ZoomPersistence.save(defaults: .standard, key: zoomDefaultsKey,
                             zoom: zoom, range: Self.zoomRange)
    }

    // MARK: - 窗口恢复（Dock/托盘/取消退出共用）

    /// 恢复动作序列（纯值单测直测）：最小化窗口必须先 deminiaturize——
    /// makeKeyAndOrderFront 对最小化窗口不解除最小化（Electron isMinimized →
    /// restore()+show()+focus() 对偶）。
    enum RestoreAction: Equatable {
        case deminiaturize
        case makeKeyAndOrderFront
    }

    static func restoreActions(isMiniaturized: Bool) -> [RestoreAction] {
        isMiniaturized ? [.deminiaturize, .makeKeyAndOrderFront] : [.makeKeyAndOrderFront]
    }

    /// 执行恢复序列（window == nil → 无动作）。
    static func restoreWindow(_ window: NSWindow?) {
        guard let window else { return }
        for action in restoreActions(isMiniaturized: window.isMiniaturized) {
            switch action {
            case .deminiaturize: window.deminiaturize(nil)
            case .makeKeyAndOrderFront: window.makeKeyAndOrderFront(nil)
            }
        }
    }

    // MARK: - 可见页面渲染进度探测

    /// JS 求值确认事件循环能应答，rAF 计数确认可见页面仍在调度帧。
    /// 静态 DOM 也会驱动这个主动 rAF 心跳；每帧后延迟约 1s 再申请下一帧，
    /// 避免在与既有 JSC 崩溃相关的 rAF 路径上常驻高频循环。
    /// 隐藏页面不作为故障证据。
    private static let rendererProgressScript = """
    (function () {
      if (document.visibilityState !== 'visible') return null;
      var name = '__dshChamberFrameProgress';
      if (!window[name]) {
        var state = { frames: 0 };
        Object.defineProperty(window, name, { value: state });
        function frame() {
          state.frames += 1;
          setTimeout(function () { requestAnimationFrame(frame); }, 1000);
        }
        requestAnimationFrame(frame);
      }
      return window[name].frames;
    })()
    """

    /// 一秒 tick 使单次探针的三秒超时按真实期限生效。
    private func startHangWatchdog() {
        hangProbeTimer?.invalidate()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            self?.tickHangWatchdog()
        }
        // Keep sampling during mouse tracking and scroll interactions too.
        RunLoop.main.add(timer, forMode: .common)
        hangProbeTimer = timer
    }

    /// 活动且未被完全遮挡的窗口持续采样。WebKit 可以节流被其他本应用
    /// 窗口遮挡的页面，即使 document.visibilityState 仍为 visible；导航、
    /// 后台、遮挡或恢复在途均不累计故障证据。
    private func tickHangWatchdog() {
        guard !recoverySuppressed, !quitting, !recoveryGaveUp else { return }
        guard NSApp.isActive, window?.isVisible == true,
              window?.isMiniaturized == false,
              window?.occlusionState.contains(.visible) == true,
              !webView.isLoading,
              recoveryReloadWorkItem == nil else {
            hangWatchdog.reset()
            return
        }
        switch hangWatchdog.tick(now: ProcessInfo.processInfo.systemUptime) {
        case .nothing:
            return
        case .probe(let id):
            let probeStartedAt = ProcessInfo.processInfo.systemUptime
            webView.evaluateJavaScript(Self.rendererProgressScript) { [weak self] result, error in
                guard let self else { return }
                guard self.hangWatchdog.activeProbeID == id else { return }
                guard !self.recoverySuppressed, !self.quitting else { return }
                guard NSApp.isActive, self.window?.isVisible == true,
                      self.window?.isMiniaturized == false,
                      self.window?.occlusionState.contains(.visible) == true,
                      !self.webView.isLoading else {
                    self.hangWatchdog.reset()
                    return
                }
                let action: RendererHangWatchdog.Action
                if error == nil, let frames = result as? Int {
                    // 主进程 → JS 线程 → 主进程的往返（单调时钟）：JS 线程被长任务
                    // 占住时 rAF 仍可能推进，超预算即输入阻塞证据（阈值 = 共享表
                    // scheduleProbe.inputBlockRttMs，见 RendererHangWatchdog）。
                    let rtt = ProcessInfo.processInfo.systemUptime - probeStartedAt
                    action = self.hangWatchdog.noteProbeSucceeded(id: id, frameCount: frames, rtt: rtt)
                } else if error == nil, result == nil || result is NSNull {
                    // WebKit may suppress rAF in a document it marks hidden.
                    self.hangWatchdog.reset()
                    return
                } else {
                    action = self.hangWatchdog.noteProbeFailed(id: id)
                }
                switch action {
                case .reload:
                    shellLog("[shell] 可见页面 JS/rAF 连续无进度或 JS 线程连续延迟 \(RendererHangWatchdog.maxStrikes) 次 → 有界重载")
                    self.scheduleRecoveryReload(reason: "unresponsive")
                case .inputBlock(let rtt):
                    // 与 Electron main.ts 的 input-block 证据行同向：单次只记录并计数，
                    // 连续超预算才在第三次走同一条有界重载道。
                    shellLog("[shell] 可见页面 JS 线程延迟证据：探针往返 \(String(format: "%.3f", rtt))s 超预算 \(RendererHangWatchdog.inputBlockRtt)s")
                case .nothing, .probe(_):
                    break
                }
            }
        case .reload:
            shellLog("[shell] 可见页面 JS 探针连续 \(RendererHangWatchdog.maxStrikes) 次超时 → 有界重载")
            scheduleRecoveryReload(reason: "unresponsive")
        case .inputBlock(_):
            // tick 只发探针或按超时升级；RTT 判定在回包回调里，不会从这里返回。
            return
        }
    }

    /// 有界重载（崩溃与卡死共用同一份预算；差异只在文案与是否上报 crashed）。
    private func cancelPendingRecoveryReload() {
        guard let item = recoveryReloadWorkItem else { return }
        item.cancel()
        recoveryReloadWorkItem = nil
        recoveryReloadGeneration &+= 1
        if let attemptAt = pendingRecoveryAttemptAt,
           let index = recoveryAttempts.lastIndex(of: attemptAt) {
            recoveryAttempts.remove(at: index)
        }
        pendingRecoveryAttemptAt = nil
    }

    private func scheduleRecoveryReload(reason: String) {
        guard recoveryReloadWorkItem == nil else { return }
        hangWatchdog.reset()
        let now = Date().timeIntervalSince1970
        switch recoveryPolicy.decide(now: now, attempts: &recoveryAttempts) {
        case .reload(let delay, let attempt):
            pendingRecoveryAttemptAt = now
            recoveryReloadGeneration &+= 1
            let generation = recoveryReloadGeneration
            shellLog("[shell] 渲染恢复（\(reason)），\(String(format: "%.2f", delay))s 后重载（\(attempt)/\(recoveryPolicy.maxReloads)）")
            window?.title = Self.displayName + " — " + NativeText.string(.rendererRecovering)
            let item = DispatchWorkItem { [weak self] in
                guard let self else { return }
                guard self.recoveryReloadGeneration == generation,
                      self.recoveryReloadWorkItem != nil else { return }
                self.recoveryReloadWorkItem = nil
                self.pendingRecoveryAttemptAt = nil
                guard !self.recoverySuppressed else { return }
                self.webView.reload()
            }
            recoveryReloadWorkItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
        case .giveUp(let attempts):
            guard !recoveryGaveUp else {
                shellLog("[shell] 渲染恢复已在放弃态（\(reason)，\(attempts) 次），不再重复通报")
                return
            }
            recoveryGaveUp = true
            shellLog("[shell] 渲染恢复正常化放弃（\(reason)，\(attempts) 次），本次不重载")
            window?.title = Self.displayName + " — " + NativeText.string(.rendererCrashTitle)
            let alert = NSAlert()
            alert.alertStyle = .critical
            alert.messageText = NativeText.string(.rendererCrashTitle)
            alert.informativeText = NativeText.string(.rendererCrashDetail)
            alert.runModal()
        }
    }

    /// WKWebView 渲染进程终止（崩溃/被系统回收；Electron render-process-gone
    /// 对应）→ webViewContentAlive:false（内容已死——通知/深链投递门即刻不
    /// 过，绝不向死 frame 推送）+ crashed 上报 + **有界自动重载**
    /// （design 25 §5 E19 / main.ts installRendererRecovery:605-700 同参数：
    /// 500ms 延迟、60s 滚动窗口内至多 3 次；超限弹 NSAlert 并停止自动恢复）。
    /// 恢复导航成功由 didFinish 推回 alive:true 并 drain。
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        hangWatchdog.reset()
        crashesSinceLoad += 1
        let now = Date()
        let sinceLoad = lastLoadFinishedAt.map { now.timeIntervalSince($0) }
        lastCrashAt = now
        recoveringFromCrash = true
        // 归因行：距上次加载完成的秒数 + 本窗口第几次崩溃。崩溃集中在
        // boot 窗口（21–34s），因此这句是"是不是同一个形态"的第一判据。
        shellLog("[shell] Web 内容进程终止（webViewWebContentProcessDidTerminate）——"
                 + RendererCrashAttribution.describe(secondsSinceLoad: sinceLoad, ordinal: crashesSinceLoad))
        // 退出中：不重载、不上报（Electron render-process-gone 在 quitRequested
        // 时直接 return）。
        guard !recoverySuppressed else {
            shellLog("[shell] 退出中——抑制渲染恢复")
            return
        }
        pushHostFacts(["webViewContentAlive": false])
        // 崩溃到重载之间没有导航事件（did-start-loading 不触发）——必须显式
        // 上报 crashed，否则 core 会继续向死 frame 推送丢事件。
        sendRendererLifecycle("crashed")

        // 重载走共享的有界恢复策略（不置永久放弃位：滚动窗口自身限制 60s 内 ≤3 次）。
        // 卡死腿同用这一份预算。
        scheduleRecoveryReload(reason: "crashed")
    }

    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        // 初载失败同样收敛 webViewLoading:false（退避重试会在
        // didStartProvisionalNavigation 再推 true；失败间隙保持 true 会让
        // sidecar 侧的 drain 门被 hold）。
        pushHostFacts(Self.navigationFacts(for: .failed))
        let nsError = error as NSError
        // 取消不是失败：loadHTMLString 替换在途导航（含失败页自身导航）与主动
        // reload 都会以 cancelled 收尾——重试或落失败页只会自扰。**也不得**撤销
        // 失败页豁免：noteStartupFailure 的 loadHTMLString 会取消在途的 cpURL
        // 导航，若这里清掉 pending，随后 about: 失败页会被自家围栏拦掉。
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled {
            shellLog("[shell] 导航被取消（不重试、不落失败页）：\(error.localizedDescription)")
            return
        }
        // 失败页导航若在提交前失败，一次性豁免没有落地对象——撤销，
        // 绝不让它悬着放行后续 about: 导航（非失败页导航时为 no-op）。
        presentationGate.noteNavigationFailed()
        // sidecar 已 fatal 时失败页的权威原因已经在（noteStartupFailure
        // 已呈现）——晚到的 WebKit 错误绝不覆盖它。
        if startupFailureMessage != nil {
            shellLog("[shell] 页面加载失败（sidecar 启动失败已呈现为失败页）：\(error.localizedDescription)")
            return
        }
        // 首载只在 sidecar ready 后发起；失败后按退避重试至成功或真正耗尽
        // （说明页只在耗尽/不可重试时出现），不会「首次失败就停在说明页」。
        guard Self.StartupLoadRetry.isRetryableLoadError(error) else {
            shellLog("[shell] 页面加载失败(不可重试) \(error.localizedDescription)")
            showLoadFailurePage(in: webView, error: error, exhausted: false)
            return
        }
        switch Self.StartupLoadRetry.decision(attempts: navRetries,
                                              sidecarFailed: startupFailureMessage != nil) {
        case .retry(let delay):
            let retryURL = webView.url ?? cpURL
            navRetries += 1
            shellLog("[shell] 控制面未就绪，\(navRetries)/\(Self.StartupLoadRetry.maxAttempts) 次重试 "
                + "\(String(format: "%.1f", delay))s 后加载 \(retryURL.absoluteString)")
            scheduleNavRetry(url: retryURL, after: delay)
        case .giveUp:
            shellLog("[shell] 页面加载失败 重试耗尽：\(error.localizedDescription)")
            showLoadFailurePage(in: webView, error: error, exhausted: true)
        }
    }

    /// 退避重试调度（可取消；退出 / sidecar fatal / 加载成功时取消）。
    /// probe=true 时重试的是首载前的 /health 探测（而不是导航）。
    private func scheduleNavRetry(probe: Bool = false, url: URL, after delay: TimeInterval) {
        navRetryWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.navRetryWorkItem = nil
            guard !self.quitting else { return }
            if probe {
                self.beginHealthProbe()
            } else {
                self.webView.load(URLRequest(url: url))
            }
        }
        navRetryWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    /// 首载失败的可见错误面：Electron 失败时显示浏览器错误页；只打印 stderr
    /// 会让用户面对白屏。这里落一张最小说明页（原因 + 控制面地址 + sidecar
    /// 真实原因），绝不自行重开会话。
    private func showLoadFailurePage(in webView: WKWebView, error: Error, exhausted: Bool) {
        // 提示句：failure.title 即通用状态句；sidecar 分支用 failure.sidecarLabel
        // 组合出「sidecar 启动失败：<状态>」；耗尽分支用 failure.retryExhausted
        // （%d = 已重试次数），绝不手拼 ASCII "(N)" 后缀。
        let statusLine = NativeText.string(.failureTitle)
        let hint: String
        if startupFailureMessage != nil {
            hint = NativeText.format(.failureSidecarLabel, statusLine)
        } else if exhausted {
            hint = NativeText.format(.failureRetryExhausted, Int32(navRetries))
        } else {
            hint = statusLine
        }
        let html = Self.failurePageHTML(hint: hint,
                                        detail: error.localizedDescription,
                                        cpURL: cpURL.absoluteString,
                                        sidecarFailure: startupFailureMessage)
        // loadHTMLString(baseURL: nil) 导航到 about:blank，会被自家
        // 围栏 cancel（说明页因此永不显示）——置一次性豁免：decidePolicyFor 只
        // 观察放行、didCommit 消费并触发呈现门（两个回调谁先到都呈现，见
        // StartupPresentationGate 注记）。
        presentationGate.beginFailurePage()
        // 白屏/失败终态在落盘日志里也留一条（含控制面地址与重试耗尽标记；
        // 双击态没有 stdout 可看，这是唯一的本地考古面）。
        shellLog("[shell] 落首载失败说明页（exhausted=\(exhausted) "
            + "cp=\(cpURL.absoluteString) error=\(error.localizedDescription)）")
        webView.loadHTMLString(html, baseURL: nil)
    }

    /// 失败说明页 HTML（文案锁步的纯函数）：可见面恒用 displayName，
    /// 绝不出现 "poc"/"DSHChamber"；sidecar 失败原因附加在页面上。
    static func failurePageHTML(hint: String, detail: String, cpURL: String,
                                sidecarFailure: String?) -> String {
        func escape(_ text: String) -> String {
            text.replacingOccurrences(of: "&", with: "&amp;")
                .replacingOccurrences(of: "<", with: "&lt;")
                .replacingOccurrences(of: ">", with: "&gt;")
        }
        // 文案全部走 NativeText（键表见 NativeText.swift；%@ 由调用方以
        // NativeText.format 传入）：
        //   <title>              = displayName（产品名；ShellIdentityTests 钉住）
        //   failure.heading      = 「无法加载 %@ 界面」（%@ = displayName）
        //   failure.cpLabel      = 「控制面地址：%@」（%@ = 已转义地址）
        //   failure.sidecarLabel = 「sidecar 启动失败：%@」（%@ = 已转义原因）
        // 主题：补 <meta name="color-scheme" content="light dark"> 与
        // @media (prefers-color-scheme: dark) 两条分支——浅色仍用原
        // #1d1d1f/#6e6e73，深色用等价的浅色文字配方；不硬编码内联颜色。
        var html = """
        <!doctype html><meta charset="utf-8"><title>\(displayName)</title>
        <meta name="color-scheme" content="light dark">
        <style>
          :root { --dsh-failure-fg: #1d1d1f; --dsh-failure-muted: #6e6e73; }
          @media (prefers-color-scheme: dark) {
            :root { --dsh-failure-fg: #f5f5f7; --dsh-failure-muted: #a1a1a6; }
          }
          body { font-family:-apple-system,system-ui; padding:48px; color:var(--dsh-failure-fg); }
          .dsh-failure-muted { color:var(--dsh-failure-muted); }
        </style>
        <body>
        <h2>\(NativeText.format(.failureHeading, displayName))</h2>
        <p>\(escape(hint))</p>
        <p class="dsh-failure-muted">\(escape(detail))</p>
        <p class="dsh-failure-muted">\(NativeText.format(.failureCpLabel, escape(cpURL)))</p>
        """
        if let sidecarFailure, !sidecarFailure.isEmpty, sidecarFailure != detail {
            html += "\n<p>\(NativeText.format(.failureSidecarLabel, escape(sidecarFailure)))</p>"
        }
        html += "\n</body>"
        return html
    }

    /// sidecar 启动失败（supervisor fatal）→ 记录真实原因（退出码 + stderr
    /// 摘要 + 端口占用提示），停掉首载退避重试并立即呈现失败说明页。应用随后仍走
    /// 既有 fatal 提示框/退出链；本函数保证失败页不是 WebKit 的 ATS 文案，而是
    /// sidecar 的诚实报错（呈现门照常生效）。
    func noteStartupFailure(_ message: String) {
        startupFailureMessage = message
        navRetryWorkItem?.cancel()
        navRetryWorkItem = nil
        healthProbeTask?.cancel()
        healthProbeTask = nil
        shellLog("[shell] sidecar 启动失败 → 停止首载重试并显示失败页：\(message)")
        showLoadFailurePage(in: webView,
                            error: StartupFailurePageError(message: message),
                            exhausted: true)
    }

    /// 失败页把 sidecar 启动失败当「error」呈现（LocalizedError 直出 message）。
    struct StartupFailurePageError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// 首载失败退避重试策略（纯逻辑单测直测）。首载只在 sidecar ready
    /// 后发起；失败后指数退避（baseDelay 起、maxDelay 封顶）重试至多
    /// maxAttempts 次——说明页只在真正耗尽或 sidecar 已 fatal 时出现
    /// （sidecar fatal 由 noteStartupFailure 立即呈现真实原因，不等耗尽）。
    struct StartupLoadRetry: Equatable {
        /// 重试次数上限（0.5 + 1 + 2×8 = 17.5s 退避窗口后才落说明页）。
        static let maxAttempts = 10
        static let baseDelay: TimeInterval = 0.5
        static let maxDelay: TimeInterval = 2.0

        enum Decision: Equatable {
            case retry(after: TimeInterval)
            case giveUp
        }

        /// 第 attempt 次重试前的退避（1 起；2 的幂，封顶 maxDelay）。
        static func delay(forAttempt attempt: Int) -> TimeInterval {
            guard attempt > 0 else { return 0 }
            let raw = baseDelay * pow(2, Double(attempt - 1))
            return min(raw, maxDelay)
        }

        /// 决策：sidecar 已 fatal 或预算耗尽 → giveUp；否则退避重试。
        static func decision(attempts: Int, sidecarFailed: Bool) -> Decision {
            if sidecarFailed { return .giveUp }
            guard attempts < maxAttempts else { return .giveUp }
            return .retry(after: delay(forAttempt: attempts + 1))
        }

        /// 可重试的导航错误：NSURLErrorDomain 的失败都属「控制面暂时不可达」
        /// ——连接被拒、超时、以及 WebKit 把连接被拒包装成的 ATS 文案
        /// （NSURLErrorAppTransportSecurityRequiresSecureConnection）都是同一
        /// 事实的不同包装；取消不是失败。非 NSURLErrorDomain → 不重试（真实
        /// 实现错误，重试无意义）。
        static func isRetryableLoadError(_ error: Error) -> Bool {
            let nsError = error as NSError
            guard nsError.domain == NSURLErrorDomain else { return false }
            return nsError.code != NSURLErrorCancelled
        }
    }

    // MARK: - WKUIDelegate：禁新窗口

    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        // 一律不开新窗；但 target=_blank 的**外链**必须先交系统打开再拒绝
        // （Electron main.ts setWindowOpenHandler 先 openExternally 再 deny；
        // vendor markdown 的外链恒 _blank，静默丢弃会让点击无反应）。
        if navigationAction.targetFrame == nil,
           let url = navigationAction.request.url,
           TrustGuard.isExternalLink(url.absoluteString, expectedOrigin: cpOrigin) {
            shellLog("[shell] 新窗外链交系统打开 \(url.absoluteString)")
            openExternally(url)
        } else {
            shellLog("[shell] 拒绝新建窗口请求")
        }
        return nil
    }

    // MARK: - WKUIDelegate：文件选择面板

    /// composer 回形针（input type=file）：不实现本回调时 WebKit 在 macOS 视同
    /// 用户取消（WKUIDelegate.h:291-295）。参数投影 → 呈现 seam（真机 NSOpenPanel /
    /// 单测假体）→ 回执选中 URL；取消回空数组（任务约定）。
    func webView(_ webView: WKWebView,
                 runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let request = FileOpenPanelRequest.make(
            allowsMultipleSelection: parameters.allowsMultipleSelection,
            allowsDirectories: parameters.allowsDirectories,
            allowedContentTypes: Self.allowedContentTypes(of: parameters))
        shellLog("[shell] 文件选择面板：多选=\(request.allowsMultipleSelection) "
            + "目录=\(request.allowsDirectories) 类型数=\(request.allowedContentTypes.count)")
        FileOpenPanel.present(request, presenter: fileOpenPanelPresenter) { urls in
            completionHandler(urls)
        }
    }

    /// 媒体采集权限：默认拒绝。Electron 只放行 clipboard-sanitized-write、
    /// 其余权限请求全拒（main.ts:3832-3834）；WKWebView 只暴露媒体采集这一类
    /// 权限回调（macOS 12+），因此这里拒绝摄像头/麦克风/屏幕共享，剪贴板与网页
    /// Notification 的等价面登记在台账。
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        shellLog("[shell] 拒绝媒体采集权限请求（origin=\(origin.host) type=\(type.rawValue)）")
        decisionHandler(.deny)
    }

    /// Help 菜单等原生入口复用既有外部打开路径（预算 + NSWorkspace
    /// loud 失败）——页面 window.open 与原生菜单动作共享同一预算纪律，绝不
    /// 绕开预算另开一条（openExternally 保持私有）。
    func openExternalPage(_ url: URL) {
        openExternally(url)
    }

    // MARK: - 私有

    private func openExternally(_ url: URL) {
        // 预算：页面可经 window.open 连续刷外链，超限后
        // 30s 冷却并 loud（与 shell-core 同参数）。
        switch externalBudget.decide(now: Date().timeIntervalSince1970) {
        case .blocked(let remaining):
            shellLog("[shell] 外链打开被预算限制（冷却 \(Int(remaining))s）：\(url.absoluteString)")
            return
        case .allow:
            break
        }
        // 打开失败必须 loud：Electron 的 openExternal 失败会 reject 并记录；
        // 把错误回调整个吞掉会让用户点了链接没反应且日志无痕。
        if #available(macOS 14.0, *) {
            NSWorkspace.shared.open(url, configuration: NSWorkspace.OpenConfiguration()) { _, error in
                if let error {
                    shellLog("[shell] 外链打开失败 \(url.absoluteString)：\(error.localizedDescription)")
                }
            }
        } else if !NSWorkspace.shared.open(url) {
            shellLog("[shell] 外链打开失败 \(url.absoluteString)：NSWorkspace.open 返回 false")
        }
    }
}

// MARK: - notify 路由解码（sidecar 出站 notify 的消费决策，纯值纯逻辑）

/// 事件名与 node-edges.ts 的 sendNotify 出站拼写逐字对应（权威形状 =
/// node-edges.ts / BridgeClientEdgeIntegrationTests 的 notify 载荷断言）：
///   rendererPush {channel, payload} / setBadge {count} /
///   showItemInFolder {path} / retireNotifications {sourceIds} /
///   notifyClicked（正常应走 __host.notifyClicked 入站请求，不经 notify）。
enum NotifyRoute: Equatable {
    /// rendererPush 解包结果：页面 emit(channel, payload)（channel/payload
    /// 原样透传，绝不改写——与 electron-edges rendererPush 到 preload 的
    /// 推送语义一致）。
    case emitToPage(channel: String, payload: AnyCodable?)
    /// 原生宿主腿执行（method + 形状校验后的原载荷；执行经
    /// SwiftEdgeHostLegs.respond——守卫语义与 edge 面一致）。
    case hostLeg(method: String, payload: AnyCodable?)
    /// retireNotifications：退役来源集/逐条 notificationId 经登记表解析为
    /// 已投递 identifier，宿主腿调 removeDeliveredNotifications 清除。
    /// sourceIds 空数组合法（node-edges 的 >16 淘汰只带 notificationIds）；
    /// notificationIds 缺省 = []（旧 sidecar 形状向后兼容）。
    case retireNotifications(sourceIds: [String], notificationIds: [Int])
    /// notifyClicked 经 notify 出现（不应发生；正常路径为入站请求）。
    case unexpectedClick
    /// 未知事件 / 载荷形状非法：loud 丢弃（含原因，绝不伪造/猜测）。
    case malformed(reason: String)
}

extension MainWindowController {
    /// notify 事件 → 消费决策（decodeOnly，不触 AppKit/UI 状态——路由消费在
    /// routeNotify，主线程收敛）。值域过滤纪律：形状不符即 .malformed（loud
    /// 丢弃），绝不部分消费、绝不默认猜测、绝不伪造成功。
    static func decodeNotify(event: String, payload: AnyCodable?) -> NotifyRoute {
        let dict: [String: AnyCodable]
        if case .object(let entries)? = payload {
            dict = entries
        } else {
            dict = [:]
        }
        switch event {
        case "rendererPush":
            guard let channel = EdgePayload.string(dict["channel"]), !channel.isEmpty else {
                return .malformed(reason: "rendererPush 载荷缺 channel 或非字符串（丢弃）")
            }
            // payload 键缺省 → nil（emit null）；存在（含显式 null）→ 原样。
            return .emitToPage(channel: channel, payload: dict["payload"])
        case "setBadge":
            guard let value = dict["count"] else {
                return .malformed(reason: "setBadge 载荷缺 count（丢弃）")
            }
            // 值域：非负整数（core 裁决后 0…9999；小数/负值/非数值 = 协议
            // 异常 → loud 丢弃；0 = 清除由腿执行）。
            guard case .number(let number) = value,
                  let count = Int(exactly: number),
                  count >= 0 else {
                return .malformed(reason: "setBadge count 非非负整数值（丢弃）")
            }
            return .hostLeg(method: "setBadge", payload: payload)
        case "showItemInFolder":
            guard let path = EdgePayload.string(dict["path"]), !path.isEmpty else {
                return .malformed(reason: "showItemInFolder 载荷缺 path 或非字符串（丢弃）")
            }
            return .hostLeg(method: "showItemInFolder", payload: payload)
        case "retireNotifications":
            guard let list = dict["sourceIds"] else {
                return .malformed(reason: "retireNotifications 载荷缺 sourceIds（丢弃）")
            }
            guard case .array(let items) = list else {
                return .malformed(reason: "retireNotifications sourceIds 非数组（丢弃）")
            }
            var sourceIds: [String] = []
            for item in items {
                if case .string(let sourceId) = item {
                    sourceIds.append(sourceId)
                } else {
                    return .malformed(reason: "retireNotifications sourceIds 含非字符串元素（丢弃）")
                }
            }
            // notificationIds 与 sourceIds 并存；缺省 = []（旧 sidecar
            // 形状仍可消费）。存在时逐元素必须是整数——形状非法即 loud 丢弃，
            // 绝不部分消费。
            var notificationIds: [Int] = []
            if let rawIds = dict["notificationIds"] {
                guard case .array(let idItems) = rawIds else {
                    return .malformed(reason: "retireNotifications notificationIds 非数组（丢弃）")
                }
                for item in idItems {
                    guard case .number(let number) = item, let id = Int(exactly: number) else {
                        return .malformed(reason: "retireNotifications notificationIds 含非整数元素（丢弃）")
                    }
                    notificationIds.append(id)
                }
            }
            return .retireNotifications(sourceIds: sourceIds, notificationIds: notificationIds)
        case "notifyClicked":
            return .unexpectedClick
        default:
            return .malformed(reason: "未知 notify 事件「\(event)」（丢弃）")
        }
    }
}


/// POC dev 控制台回传（白屏诊断；setupWindow 注入页面脚本 → 本类打印）。
final class ShellConsoleCatcher: NSObject, WKScriptMessageHandler {
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "shellConsole" else { return }
        if let body = message.body as? [String: Any],
           let kind = body["kind"] as? String,
           let text = body["text"] as? String {
            shellLog("[shell-web] \(kind): \(text)")
        } else {
            shellLog("[shell-web] raw: \(message.body)")
        }
    }
}

/// 页面事实通道 handler：独立 WKScriptMessageHandler，**绝不**混进
/// ChamberMessageHandler 的白名单/origin 就绪门判定链——它承载本地化/主题
/// 跟随所需的 DOM 事实，必须在 sidecar ready 前就可用。
///
/// 护栏：主 frame + 同源文档面
/// （MainWindowController.isSameOriginDocument；scheme/host/port 与 expectedOrigin
/// 完全相同，**不**限定 pathname=/、**不**限定无 query——pushState/replaceState 后
/// webView.url 会变化）；URL 来源以 message.webView?.url 为准（frameInfo.request.url
/// 只在 webView 缺席时兜底，实测证据见 MainWindowController.factsDocumentURL）。
/// 判定不过一律丢弃（本通道无回执，静默即丢弃）。与 A 桥的严格壳文档判定故意不同，
/// 取舍见 MainWindowController.acceptsReconcile 的注记。
/// 回调线程 = 主线程（WKScriptMessageHandler 的到达契约）。
final class ShellPageFactsMessageHandler: NSObject, WKScriptMessageHandler {
    /// 事实消费方（MainWindowController；弱引用避免环）。
    weak var controller: MainWindowController?
    /// 当前控制面 origin（nil = 尚未装配 → 判定不过）。
    var expectedOrigin: (() -> String?)?

    init(controller: MainWindowController) {
        self.controller = controller
    }

    /// 准入判定（纯函数，单测直测真值表）：名称相等 + 主 frame + 同源文档面
    /// （MainWindowController.isSameOriginDocument）。放行 = 同源根路径 / 带 query /
    /// 同源 /api/i/*（pushState 场景）/ hash；拒绝 = about:blank、data:/file:/blob:、
    /// 空 url、空 expectedOrigin、跨源（不同端口 / 不同 host / 子域 / https / userinfo）。
    /// 文档面判定与对账路径 acceptsReconcile 共用同一实现，避免两处门漂移。
    /// 本重载显式传「已解析的文档 URL」；生产路径用下面的双来源重载。
    static func accepts(messageName: String, isMainFrame: Bool,
                        url: String?, expectedOrigin: String?) -> Bool {
        guard messageName == ShellPageFactsScript.messageName else { return false }
        guard isMainFrame else { return false }
        return MainWindowController.isSameOriginDocument(url: url, expectedOrigin: expectedOrigin)
    }

    /// 双来源重载（纯函数，单测直测「frameInfo 陈旧 URL 与 webView.url 不同时
    /// 以 webView.url 为准」）：先把两个来源收敛成文档 URL（factsDocumentURL），
    /// 再走与上面完全相同的名称/主 frame/同源判定。
    static func accepts(messageName: String, isMainFrame: Bool,
                        webViewURL: String?, frameRequestURL: String?,
                        expectedOrigin: String?) -> Bool {
        accepts(messageName: messageName, isMainFrame: isMainFrame,
                url: MainWindowController.factsDocumentURL(webViewURL: webViewURL,
                                                           frameRequestURL: frameRequestURL),
                expectedOrigin: expectedOrigin)
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        // 名称/主 frame 门先行：不匹配的通道连
        // expectedOrigin 闭包都不求值。
        guard message.name == ShellPageFactsScript.messageName else { return }
        guard message.frameInfo.isMainFrame else { return }
        // URL 以 message.webView?.url（实时，与 A 桥同来源）为准；
        // frameInfo.request.url 只作 webView 缺席时的兜底。
        guard Self.accepts(messageName: message.name,
                           isMainFrame: message.frameInfo.isMainFrame,
                           webViewURL: message.webView?.url?.absoluteString,
                           frameRequestURL: message.frameInfo.request.url?.absoluteString,
                           expectedOrigin: expectedOrigin?()) else {
            return
        }
        guard let payload = message.body as? [String: Any] else { return }
        controller?.ingestPageFacts(payload)
    }
}
