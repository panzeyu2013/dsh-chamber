//  MainWindowController.swift —— 主窗口：WKWebView 加载控制面 + A 桥接线
//  DSHChamberPoc（macos/ SwiftPM POC 壳）：W-03（design 25 §8.1）；
//  本文件持有 W-04 契约的接线点（ChamberMessageHandler / BridgeShimInjector
//  为 MessageHandler.swift / BridgeShimInjector.swift 中他人实现，见共享契约）
//
//  职责：WKWebView 加载控制面 origin 的壳文档（根路径）；把 bridge-shim.poc.js
//  （ChamberResources 定位的 SwiftPM 资源）注入 WebView；ChamberMessageHandler
//  注册为 "dshChamber" 消息通道并回接 evaluateJavaScript；B 桥 invoke 结果与
//  sidecar notify 帧经 __dshChamberResolve / __dshChamberEmit 回写页面；
//  导航护栏：仅放行**壳文档**（origin 相等 + pathname=/ + 无 query，与 Electron
//  isTrustedRendererUrl 对齐）——同源非壳文档（/api/i/* 代理 HTML）一律取消，
//  其余交给系统打开或一律取消。
//  hostFacts 推送（S-A）：本控制器是窗口/聚焦/加载事实的唯一事实源——
//  窗口 key/关闭通知与 WKNavigationDelegate 生命周期回调经
//  pushHostFacts 以 __host.hostFacts 推送 sidecar（node-edges.ts 同步门
//  缓存 focused/mainWindowAlive/webViewLoading/webViewContentAlive 刷新，
//  见本文件 hostFacts 段注释），使通知裁决等同步门与 Electron 侧行为一致。
//  notify 消费路由（S-D）：sidecar 出站 notify 帧（node-edges sendNotify 族
//  ——rendererPush/setBadge/showItemInFolder/retireNotifications）经
//  BridgeClient.onNotify 到本控制器的 notify 路由：rendererPush 解包进页面
//  emit（Electron webContents.send 同语义），setBadge/showItemInFolder 走
//  SwiftEdgeHostLegs 原生腿（守卫同 edge 面、失败 loud），retireNotifications
//  按 NotificationDeliveryRegistry 的 sourceId→identifier 登记表调
//  UNUserNotificationCenter.removeDeliveredNotifications（S8），
//  notifyClicked/未知事件 loud 不处理——路由决策表见文件底部
//  decodeNotify/NotifyRoute（纯逻辑，单测直测）。
import AppKit
import UniformTypeIdentifiers
import UserNotifications
import WebKit

final class MainWindowController: NSWindowController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, NSWindowDelegate {

    // MARK: - 常量

    /// A 桥消息通道名（与 shim 侧约定一致）
    private static let bridgeMessageName = "dshChamber"
    /// POC dev 控制台回传通道名（页面脚本约定；见 setupWindow 注入）
    private static let consoleMessageName = "pocConsole"
    /// A 桥 shim 资源文件名（Resources/ 下，W-04 作者创建，本文件只读取）。
    /// P-18 起可见性放开到 internal：AppDelegate 启动门与单测引用同一拼写。
    static let shimResourceName = "bridge-shim.poc.js"

    /// 本次窗口的原生通道令牌（S-06）：注入时写进 shim，回执/推送时作为首参
    /// 回传；页面脚本无从得知（内部管路不在公开面上）。
    private let nativeChannelToken = BridgeShimInjector.makeNativeToken()

    /// 令牌的 JS 字符串字面量（十六进制，无需转义）。
    private var nativeTokenLiteral: String { "\"\(nativeChannelToken)\"" }
    /// 可 invoke 的 method 白名单：W-04 是最小 7 通道集；W-18 manifest 化后
    /// 扩为 BridgeManifest.invokeChannels 全集（60/60 真实现都在 sidecar 侧，
    /// 语义权威与护栏仍在 sidecar/TrustGuard——readiness/badge 等通道不再
    /// 被 POC 层误拒成 poc-unimplemented）。与桥 shim 暴露面一致性问题：shim
    /// 只暴露其脚本内实现的方法，未暴露方法在页面层即 stub——两处均以
    /// manifest 为准的演进是 M3 全量 shim（chamber-bridge.stub.js）的活。
    private static let invokeWhitelist: Set<String> = BridgeManifest.invokeChannels
    /// 窗口默认内容尺寸
    private static let windowSize = NSSize(width: 1280, height: 800)

    /// 原生壳**可见**产品名（T-1：暂时把 native 标记为 dsh-chamber-native）：
    /// 窗口标题 / 失败说明页 / fatal 提示框共用。不可见名（SwiftPM target、
    /// CFBundleExecutable、资源名 bridge-shim.poc.js）保持 DSHChamberPoc 不变。
    static let displayName = "dsh-chamber-native"

    /// 首帧/重载底色（T-4）：与 Electron backgroundColor:#0f1115、前端
    /// packages/renderer/index.html 骨架底色同一 token 值
    /// #0f1115 = rgb(15, 17, 21)。WKWebView 缺省白底在首帧/重载时会白闪。
    static let backgroundRed: CGFloat = 15.0 / 255.0
    static let backgroundGreen: CGFloat = 17.0 / 255.0
    static let backgroundBlue: CGFloat = 21.0 / 255.0
    static var windowBackgroundColor: NSColor {
        NSColor(srgbRed: backgroundRed, green: backgroundGreen,
                blue: backgroundBlue, alpha: 1)
    }
    /// B 桥入站保留 method 名（单源 = HostInboundMethod；node-edges.ts 同拼写）。
    private static let hostFactsMethod = HostInboundMethod.hostFacts
    /// renderer 崩溃有界重载策略（design 25 §5 E19；Electron 版 500ms/60s≤3）。
    private let recoveryPolicy = RendererRecoveryPolicy()
    /// 滚动窗口内的重载时间戳（主线程独占）。
    private var recoveryAttempts: [Double] = []
    /// 重载已排定（防同一崩溃回调重入排定）。
    private var recoveryReloadWorkItem: DispatchWorkItem?
    /// 退出中/已开始清理 → 抑制渲染恢复（Electron `reload()` 的 `quitRequested`
    /// 早退；2026-09 三审 E19 偏离 #3）。
    private var recoverySuppressed = false

    /// S-02 卡死自愈：空闲 ping 判定器 + 定时器 + 键鼠监听。
    private var hangWatchdog = RendererHangWatchdog(now: Date())
    private var hangProbeTimer: Timer?
    private var userInputMonitor: Any?
    /// 自动恢复已放弃（超限后不再重载，只 loud/弹窗一次）。


    // MARK: - 状态

    private let bridge: BridgeClient
    private let cpURL: URL
    /// A 桥 shim 源码（P-18：AppDelegate 启动门已 fail-closed 判定非空，
    /// setupWindow 只负责注入）。
    private let shimSource: String
    /// 控制面 origin（scheme://host:port），导航放行与消息护栏共用
    private let cpOrigin: String
    /// sidecar ready 帧已到（A 桥 origin 门在此之前一律拒绝）。
    private var sidecarReady = false
    /// 退出清理已开始（S7：A 桥 app_quitting 门；AppDelegate
    /// beginTerminationCleanup 置位）。置位后全部 invoke 回 app_quitting。
    private var quitting = false
    /// 外链打开预算（镜像 shell-core openExternally：10s/8 次 + 30s 冷却）。
    private var externalBudget = ExternalOpenBudget()

    private var webView: WKWebView!
    private var bridgeHandler: ChamberMessageHandler!
    /// 关窗决策委托（AppDelegate；见 windowShouldClose）。
    weak var closeDelegate: MainWindowCloseDeciding?
    /// 宿主设置变化回调（2026-12 审查 major）：关窗决策会缓存 quitFacts，设置页改
    /// 「关闭窗口行为」后必须让缓存失效，否则首次关窗仍按旧值决策。
    var onSettingsChanged: (() -> Void)?
    private var consoleCatcher: POCConsoleCatcher?
    private var didSnapshot = false
    /// 在途下载占用的目标路径（S-26 静默落盘：WebKit 要求目标文件在决策时
    /// 不存在，同一批并发下载因此必须相互避让；完成/失败即释放）。
    private var reservedDownloadPaths: Set<String> = []
    private var downloadDestinations: [ObjectIdentifier: String] = [:]
    private var navRetries = 0
    private var didStartLoading = false
    /// 首载失败退避重试的挂起调度（T-2：sidecar fatal / 退出 / 成功时取消）。
    private var navRetryWorkItem: DispatchWorkItem?
    /// sidecar 启动失败的真实原因（T-3：supervisor fatal 时经
    /// noteStartupFailure 注入；失败页与日志共用，绝不只剩 WebKit 的 ATS 文案）。
    private var startupFailureMessage: String?
    /// hostFacts 推送簿记（S-A）：已推送（含推送意图）事实，键 → 布尔。
    /// 仅主线程读写：全部推送调用点都是主线程回调（AppKit 窗口通知 /
    /// WKNavigationDelegate），簿记在事件回调内同步完成（去重判断与推送
    /// 顺序因此与事件顺序一致，见 pushHostFacts 注释）。
    private var lastHostFacts: [String: Bool] = [:]

    /// S-42：启动呈现门——首个可呈现内容（didCommit）才允许亮出启动主窗，且只
    /// 触发一次（后续重载/重试/失败页后的再次导航不再重复呈现）。同一状态机承载
    /// S-27 失败说明页的一次性 about: 导航豁免（见 StartupPresentationGate）。
    private var presentationGate = StartupPresentationGate()
    /// S-42：首个可呈现内容到达回调（AppDelegate 装配期接线 → makeKeyAndOrderFront；
    /// 见 didCommit 与 AppDelegate.presentMainWindow）。窗口在此之前保持隐藏，
    /// 绝不先亮出无内容空窗。
    var onFirstCommittedContent: (() -> Void)?
    /// 文件选择面板呈现器（S-25：composer 回形针）。测试经此 seam 注入假体，
    /// 不需要真实 NSOpenPanel / WKOpenPanelParameters 实例（后者无公开构造器）。
    var fileOpenPanelPresenter: FileOpenPanelPresenting = SystemFileOpenPanelPresenter()

    // MARK: - 初始化

    /// - Parameters:
    ///   - cpURL: 控制面 URL（AppDelegate 解析自 POC_CP_URL；缺省 dev
    ///     127.0.0.1:17520 / 打包 localhost:17500，S-45）
    ///   - bridge: B 桥客户端（BridgeClient.swift，W-04 契约）
    ///   - shimSource: A 桥 shim 源码（P-18：调用方先经
    ///     `shimStartupFailure(source:)` fail-closed 判定，缺失绝不开窗）
    init(cpURL: URL, bridge: BridgeClient, shimSource: String) {
        self.cpURL = cpURL
        self.bridge = bridge
        self.shimSource = shimSource
        self.cpOrigin = Self.origin(of: cpURL) ?? ""
        if self.cpOrigin.isEmpty {
            print("[native] 警告：控制面 URL 无合法 origin，导航护栏将一律拦截 http(s)")
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
        if let monitor = userInputMonitor { NSEvent.removeMonitor(monitor) }
    }

    /// 构建 WKWebView（含 A 桥注入与消息通道）与主窗口
    private func setupWindow() {
        let configuration = WKWebViewConfiguration()

        // A 桥 shim 注入（W-04：BridgeShimInjector.install 负责落 WKUserScript）。
        // P-18：资源缺失/为空已在 AppDelegate 启动门 fail-closed（可见错误 +
        // exit(1)，对齐 Electron showErrorBox + app.exit），这里不再有
        // 「警告后照常开窗」的 fail-open 分支。
        // S-06：注入前把占位符换成窗口随机令牌（内部管路 resolve/emit/
        // rehydrate 都要带对令牌才生效）；P-19：install 幂等。
        BridgeShimInjector.install(
            config: configuration,
            source: BridgeShimInjector.injectNativeToken(nativeChannelToken, into: shimSource))
        print("[native] A 桥 shim 注入完成（\(Self.shimResourceName)）")

        // 视口越界策略（2026-12）：关闭 macOS WebKit 的根级弹性回弹——指针停在
        // 不可滚动 chrome（顶栏/侧栏头部）上滚动、或滚动器滚到端点后继续滚时，
        // 整页（含 position: fixed 层）会被整体平移再弹回。按 CSS Overscroll
        // Behavior 规范，视口越界效果由根元素的 overscroll-behavior 决定，故由
        // 壳以 WKUserScript（documentStart、仅主 frame）注入根规则，只落文档根、
        // 不给上游滚动容器加 contain（design 25 §5.1；Electron 未同步见
        // deviations S-48）。与 shim 同段：必须在 WKWebView 构造前生效。
        ShellOverscrollPolicy.install(config: configuration)
        print("[native] 视口越界策略注入完成（\(ShellOverscrollPolicy.rootOverscrollCSS)）")

        // 消息通道：ChamberMessageHandler 只做护栏与转发（W-04 实现）
        let handler = ChamberMessageHandler(
            whitelist: Self.invokeWhitelist,
            // ready 帧前 expectedOrigin = nil → 一律拒绝（design 25 §4.4.1
            // 第 2 条「port 只在 ready 帧后放开」；2026-09 模块评审 minor）。
            expectedOrigin: { [weak self] in
                guard let self, self.sidecarReady else { return nil }
                return self.cpOrigin
            },
            // S7：退出清理开始后 late invoke 回 app_quitting（renderer-trust
            // createTrustedIpc 同码），不再向 shutdown 注入传输/运行时工作。
            isQuitting: { [weak self] in self?.quitting ?? false },
            onInvoke: { [weak self] id, method, payload in
                self?.handleInvoke(id: id, method: method, payload: payload)
            }
        )
        handler.evaluateJavaScript = { [weak self] script in
            self?.evaluateJS(script)
        }
        // S-06：护栏回执也要带原生通道令牌（与注入 shim 的同一个值）。
        handler.nativeChannelToken = nativeChannelToken
        bridgeHandler = handler
        configuration.userContentController.add(handler, name: Self.bridgeMessageName)

        // POC dev 调试（白屏诊断；S14：仅在 POC_DEBUG=1 时安装——默认关闭，
        // 发布壳不转发渲染器每一行 console）：页面 JS onerror/
        // unhandledrejection/console.* 经 pocConsole 通道回传 → [native-web] 打印。
        if POCDebug.isEnabled() {
            let consoleCatcher = POCConsoleCatcher()
            self.consoleCatcher = consoleCatcher
            configuration.userContentController.add(consoleCatcher, name: Self.consoleMessageName)
            let consoleSource = """
            (function () {
              function post(kind, args) {
                try {
                  window.webkit.messageHandlers.pocConsole.postMessage({kind: kind, text: Array.prototype.map.call(args, String).join(' ')});
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
            print("[native] POC_DEBUG=1：已安装 pocConsole 回传（\(Self.consoleMessageName)）")
        }

        // S-02：渲染器卡死自愈（空闲 ping + 有界重载）。
        startHangWatchdog()

        // S-D：sidecar 出站 **notify 帧**（{"notify":event,"payload":…}——
        // node-edges 的 sendNotify 族：rendererPush/setBadge/
        // showItemInFolder/retireNotifications）→ 本控制器 notify 路由消费。
        // event 帧族（BridgeClient.onEvent）已无生产接线（sidecar-entry 只发
        // notify；W-05 桩 fixture 仅供 BridgeClientPocStubIntegrationTests），页面下行
        // 唯一入口 = 本 onNotify 路由（W-04 双写纪律「乙」）。
        // 线程契约：管道读取线程回调，消费在 routeNotify 内收敛主线程。
        bridge.onNotify = { [weak self] event, payload in
            self?.routeNotify(event: event, payload: payload)
        }

        // WebView
        let webView = WKWebView(frame: NSRect(origin: .zero, size: Self.windowSize),
                                configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // 开发者工具：只在 DEBUG 构建开放（2026-12 参考独立 Swift 原生壳的通行做法：
        // debug 默认开、release 默认关）。构建期常量，页面或环境变量都打不开。
#if DEBUG
        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }
#endif
        self.webView = webView
        // T-4：WKWebView 与窗口共用前端同一底色 token（#0f1115 = rgb(15,17,21)）
        // ——WKWebView 缺省白底会让首帧/重载白闪；drawsBackground=false 让页面
        // 透明区域直接露出窗口底色（亮/暗主题同值，token 常量见文件顶部）。
        webView.underPageBackgroundColor = Self.windowBackgroundColor
        if webView.responds(to: NSSelectorFromString("setDrawsBackground:")) {
            webView.setValue(false, forKey: "drawsBackground")
        }
        // A3-3：恢复本 origin 上次的缩放（Chromium 按 origin 持久化 zoomLevel；
        // WKWebView.pageZoom 每次启动回 100%，这里用 UserDefaults 补齐）。
        webView.pageZoom = ZoomPersistence.load(
            defaults: .standard, key: zoomDefaultsKey, range: Self.zoomRange)

        // 窗口
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: Self.windowSize),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered,
                              defer: false)
        // T-1：可见标题 = dsh-chamber-native（功能对齐 Electron 的标题冻结行为；
        // 2026-12 双端逐函数核对 U5/V8；不可见 target/可执行名保持 DSHChamberPoc）。
        window.title = Self.displayName
        // T-4：窗口底色 = 同一 #0f1115（缩放/全屏露底不白闪）。
        window.backgroundColor = Self.windowBackgroundColor
        window.contentView = webView
        window.center()
        // 关窗决策委托（E1/E20）：windowShouldClose 交给 AppDelegate（隐藏 vs
        // 转入退出链由 core 决策，Swift 只执行）。
        window.delegate = self
        self.window = window

        // S-A hostFacts 事实观察：窗口 key/关闭通知（主线程投递；object 限定
        // 本窗）。选择器观察者不被 center 持有；控制器与应用同生命周期
        // （AppDelegate 强持有到退出），无需 removeObserver。
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(hostFactsWindowDidBecomeKey(_:)),
                           name: NSWindow.didBecomeKeyNotification, object: window)
        center.addObserver(self, selector: #selector(hostFactsWindowDidResignKey(_:)),
                           name: NSWindow.didResignKeyNotification, object: window)
        center.addObserver(self, selector: #selector(hostFactsWindowWillClose(_:)),
                           name: NSWindow.willCloseNotification, object: window)
        // A-1/A-2（审计收口）：macOS 唤醒与窗口/应用显示的事件发送方——
        // 对偶 electron-edges onSystemResume(powerMonitor)/onMainWindowShown
        // （design 25 §5 E6）。didWake → __host.systemResume {timestamp}；
        // didBecomeActive → __host.mainWindowShown（held lastResume 补发点）。
        // 幂等：core 无 held/无待办时均为 no-op。
        // 2026-12 双端逐函数核对 D1：NSWorkspace 的通知必须注册在它自己的
        // 通知中心上（SDK NSWorkspace.h 明示），注册到 NotificationCenter.default
        // 永不触发——__host.systemResume 因此从未发出，core 的立即重连/held
        // 补发（shell-core.ts systemResume 路径）在原生 flavor 全失效。
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(hostWakeUp(_:)),
            name: NSWorkspace.didWakeNotification, object: nil)
        center.addObserver(self, selector: #selector(appDidBecomeActive(_:)),
                           name: NSApplication.didBecomeActiveNotification, object: nil)
    }

    // MARK: - A-1/A-2 入站事件发送（唤醒/窗口显示）

    @objc private func hostWakeUp(_ note: Notification) {
        print("[native] 系统唤醒——发送 __host.systemResume")
        Task { @MainActor in
            do {
                _ = try await bridge.invoke(
                    method: HostInboundMethod.systemResume,
                    payload: .object(["timestamp": .number(Date().timeIntervalSince1970 * 1000)]))
            } catch {
                // S10：事件边界绝不吞错、绝不崩——失败 loud（同
                // sendRendererLifecycle 风格；core 侧幂等，无需重试）。
                print("[native] __host.systemResume 发送失败：\(error.localizedDescription)")
            }
        }
    }

    @objc private func appDidBecomeActive(_ note: Notification) {
        print("[native] 应用激活——发送 __host.mainWindowShown")
        Task { @MainActor in
            do {
                _ = try await bridge.invoke(method: HostInboundMethod.mainWindowShown, payload: nil)
            } catch {
                print("[native] __host.mainWindowShown 发送失败：\(error.localizedDescription)")
            }
        }
    }

    override func windowDidLoad() {
        super.windowDidLoad()
        startLoadingIfNeeded()
    }

    // MARK: - 页面加载

    /// 首次加载控制面（幂等：windowDidLoad / init / noteSidecarReady 都可能触发）。
    /// T-2：sidecar ready 前**绝不**发起首载——打包态冷启动时控制面还没监听，
    /// 抢跑只会拿到「连接被拒」的 WebKit/ATS 文案并停在失败页。判定抽成纯函数
    /// （shouldStartFirstLoad，单测直测）。
    /// S-45：ready 帧只是 sidecar 协议就绪；首载前还必须先过一次 HTTP 就绪探测
    /// （GET /health 期望 2xx）——探测先行、导航在后（StartupLoadPlan 不变量）。
    private func startLoadingIfNeeded() {
        guard Self.shouldStartFirstLoad(sidecarReady: sidecarReady,
                                        didStartLoading: didStartLoading) else { return }
        didStartLoading = true
        beginHealthProbe()
    }

    /// T-2 首载门（纯逻辑，单测直测）：sidecar ready 且尚未首载才放行。
    static func shouldStartFirstLoad(sidecarReady: Bool, didStartLoading: Bool) -> Bool {
        StartupLoadPlan.firstStep(sidecarReady: sidecarReady,
                                  didStartLoading: didStartLoading) == .probe
    }

    // MARK: - 首载 HTTP 就绪探测（S-45：探测先行）

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

        /// 探测结果后的动作（复用 T-2 退避预算）。
        enum ProbeOutcome: Equatable {
            case navigate
            case retry(after: TimeInterval)
            case giveUp
        }

        static func firstStep(sidecarReady: Bool, didStartLoading: Bool) -> Step {
            if didStartLoading { return .alreadyStarted }
            return sidecarReady ? .probe : .waitForSidecar
        }

        /// 2xx → navigate；否则按 T-2 退避重试/耗尽（sidecar fatal 立即 giveUp）。
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
    /// 等网络层事实进落盘日志，不再只剩「未就绪」三个字。
    static func healthProbeFailureDetail(statusCode: Int?, error: Error?) -> String {
        if let error {
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain {
                return "NSURLError \(nsError.code)：\(error.localizedDescription)"
            }
            return error.localizedDescription
        }
        if let statusCode { return "HTTP \(statusCode)（期望 2xx）" }
        return "无响应"
    }

    /// 首载第一步：探测（绝不直接导航）。
    private func beginHealthProbe() {
        guard let probeURL = Self.healthProbeURL(cpURL: cpURL) else {
            handleHealthProbeFailure(statusCode: nil, error: nil, probeURL: cpURL)
            return
        }
        shellLog("[native] 控制面就绪探测先行：GET \(probeURL.absoluteString)")
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
        shellLog("[native] 控制面就绪（GET \(Self.healthProbePath) 2xx），加载控制面 "
            + "\(cpURL.absoluteString)（origin=\(cpOrigin)）")
        webView.load(URLRequest(url: cpURL))
    }

    /// 探测失败 = 「控制面未就绪」的同义事实：走 T-2 同一退避预算；预算耗尽才
    /// 落失败说明页（原因是探测的真实错误，不是 WebKit 的错误包装）。
    private func handleHealthProbeFailure(statusCode: Int?, error: Error?, probeURL: URL) {
        // T-3：sidecar 已 fatal 时权威原因已呈现，晚到的探测失败不再覆盖。
        if startupFailureMessage != nil { return }
        let detail = Self.healthProbeFailureDetail(statusCode: statusCode, error: error)
        switch Self.StartupLoadPlan.outcome(afterProbeReachable: false, attempts: navRetries,
                                            sidecarFailed: false) {
        case .navigate:
            return
        case .retry(let delay):
            navRetries += 1
            shellLog("[native] 控制面未就绪（就绪探测失败 \(detail)），"
                + "\(navRetries)/\(Self.StartupLoadRetry.maxAttempts) 次重试 "
                + "\(String(format: "%.1f", delay))s 后探测 \(probeURL.absoluteString)")
            scheduleNavRetry(probe: true, url: probeURL, after: delay)
        case .giveUp:
            shellLog("[native] 控制面就绪探测耗尽（\(detail)）：\(probeURL.absoluteString)")
            showLoadFailurePage(in: webView,
                                error: HealthProbeFailureError(detail: detail),
                                exhausted: true)
        }
    }

    /// 就绪探测失败的失败页错误（LocalizedError 直出可诊断原因）。
    struct HealthProbeFailureError: LocalizedError {
        let detail: String
        var errorDescription: String? { "控制面就绪探测失败：\(detail)" }
    }

    // MARK: - S-42：启动窗口呈现门（绝不先亮无内容空窗）

    /// 启动呈现门（纯逻辑单测直测）：首个可呈现内容才允许亮窗，且只触发一次；
    /// 后续提交（重载/重试/失败页后的再次导航）不再重复呈现。
    /// 同一状态机承载 S-27 失败说明页的一次性 about: 导航豁免——对抗验证回归
    /// （S-42 破坏了 S-27 失败页的呈现）：WebKit 实测回调顺序是
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
        /// 绝不让它悬着放行后续 about: 导航（S-27 一次性安全面）。
        mutating func noteNavigationFailed() {
            failurePagePending = false
        }
    }

    /// 一次导航提交是否算「可呈现内容」（纯逻辑单测直测）：S-27 失败说明页恒算
    /// （about:blank，但由一次性豁免放行）；WKWebView 初始空文档（url 为 nil /
    /// about:blank 且非失败页）不算——启动期为此保持隐藏。
    static func isPresentableCommit(url: String?, failurePage: Bool) -> Bool {
        if failurePage { return true }
        guard let url, !url.isEmpty, url != "about:blank" else { return false }
        return true
    }

    // MARK: - hostFacts 推送（S-A：窗口/聚焦/加载事实 → sidecar 同步门缓存）

    /// hostFacts 去重合并（纯逻辑，单测直测——HostFactsDiffTests）。给定
    /// 已推送（含意图）事实 last 与拟推送变化 changes：
    ///   - payload = changes 中与 last 同键异值者（last 无该键视为异值——
    ///     首推必推）；payload 为空 = 无变化，调用方应跳过推送；
    ///   - merged = last 并入 changes 全部键（意图簿记：无论本次推送成败，
    ///     后续事件以此值去重——失败时随后的事实变化事件会携带最新值再推
    ///     收敛，见 pushHostFacts 注释）。
    /// 字典键序不影响 JSON 对象语义（sidecar 侧 handleHostInbound 按键级
    /// 合并：仅 typeof boolean 的键生效）。
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

    /// 导航事实变换（S-A/S5；纯逻辑单测直测）：
    ///  - started  → webViewLoading:true；
    ///  - finished → webViewLoading:false + webViewContentAlive:true；
    ///  - failed   → webViewLoading:false（S5：失败无 didFinish，也必须收敛，
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
    /// 快照；否则新 sidecar 会长期以「种子事实」运行（2026-09 三审 #8）。
    /// S9：快照必须含 focused = window.isKeyWindow 的实时值——否则重启前缓存
    /// 的 focused=false 会粘滞到下一次 key 事件，窗口明明是 key 却推 false。
    func resetHostFactsBookkeeping() {
        lastHostFacts = [:]
        pushHostFacts(Self.resetFacts(isKeyWindow: window?.isKeyWindow ?? false))
    }

    /// sidecar 重启后的全量事实快照（纯逻辑，单测直测；S9）。
    static func resetFacts(isKeyWindow: Bool) -> [String: Bool] {
        ["mainWindowAlive": true, "webViewContentAlive": true, "focused": isKeyWindow]
    }

    private func pushHostFacts(_ changes: [String: Bool]) {
        let (payload, merged) = Self.hostFactsDiff(last: lastHostFacts, changes: changes)
        guard !payload.isEmpty else { return }
        lastHostFacts = merged
        let summary = payload.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: " ")
        print("[native] hostFacts 推送 \(summary)")
        let object = AnyCodable.object(payload.mapValues { .bool($0) })
        let pushed = payload
        Task { @MainActor in
            do {
                _ = try await bridge.invoke(method: Self.hostFactsMethod, payload: object)
            } catch {
                // 失败必须回滚意图（2026-09 二轮自查）：首推发生在 bridge.start()
                // 之前 → invoke 直接抛「未在运行」；若不回滚，去重簿记会认为该
                // 事实已送达，而 sidecar 侧存活事实缺省为「未知=不可交付」，于是
                // rendererPush 长期返回 false、通知/深链被永久 hold。
                self.lastHostFacts = Self.hostFactsRollback(last: self.lastHostFacts, pushed: pushed)
                print("[native] hostFacts 推送失败（已回滚意图，等待下次事件重推）：\(error.localizedDescription)")
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
        print("[native] rendererLifecycle 上报 \(event)")
        Task { @MainActor in
            do {
                _ = try await bridge.invoke(
                    method: HostInboundMethod.rendererLifecycle,
                    payload: .object(["event": .string(event)]))
            } catch {
                print("[native] rendererLifecycle 上报失败（\(event)）：\(error.localizedDescription)")
            }
        }
    }

    // MARK: - B 桥 invoke / sidecar 事件回写页面

    /// web → Swift invoke（经 handler 转发）：调 B 桥后把结果交回页面
    private func handleInvoke(id: Int, method: String, payload: AnyCodable?) {
        if POCDebug.isEnabled() {
            print("[native] invoke #\(id) \(method)")
        }
        Task { @MainActor in
            do {
                let result = try await bridge.invoke(method: method, payload: payload)
                let resultJSON = Self.jsonLiteral(result.jsonObject) ?? "null"
                evaluateJS("__dshChamberResolve(\(nativeTokenLiteral), \(id), \(resultJSON), null)")
            } catch {
                // 失败：__dshChamberResolve(id, null, <errorString>)；errorString
                // 经 JSON 序列化即为合法 JS 字符串字面量
                let errorJSON = Self.jsonLiteral(error.localizedDescription) ?? "\"bridge error\""
                evaluateJS("__dshChamberResolve(\(nativeTokenLiteral), \(id), null, \(errorJSON))")
            }
        }
    }

    /// 页面 emit 直写（调用方必须已在主线程）：__dshChamberEmit(eventJSON,
    /// payloadJSON)。序列化失败 → loud 打印不注入（绝不注入残缺 JS）。
    private func emitToPage(event: String, payload: AnyCodable?) {
        guard let eventJSON = Self.jsonLiteral(event) else {
            print("[native] 页面 emit 序列化失败：event 不可 JSON 化（丢弃）")
            return
        }
        let payloadJSON: String
        if let payload = payload {
            payloadJSON = Self.jsonLiteral(payload.jsonObject) ?? "null"
        } else {
            payloadJSON = "null"
        }
        evaluateJS("__dshChamberEmit(\(nativeTokenLiteral), \(eventJSON), \(payloadJSON))")
    }

    /// 主线程执行 JS（所有调用点都已收敛到主线程）
    private func evaluateJS(_ script: String) {
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    // MARK: - notify 消费路由（S-D）

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
            print("[native] notify rendererPush → 页面 emit \(channel)")
            if channel == Self.settingsChangedChannel {
                // 设置变了 → 关窗决策缓存作废（S3·V9：缓存必须随设置失效）。
                onSettingsChanged?()
            }
            Task { @MainActor in
                emitToPage(event: channel, payload: payload)
            }
        case .hostLeg(let method, let payload):
            Task { @MainActor in
                guard let legs = bridge.edgeHostLegs else {
                    print("[native] notify \(method) 消费失败：edgeHostLegs 未接线（loud）")
                    return
                }
                // 与 edge 面同一执行体（respond 内部 performUI + 窗口守卫）：
                // canShowUI/窗口守卫语义一致，无窗/headless → 诚实降级。
                let outcome = legs.respond(method: method, payload: payload)
                if let error = outcome.error {
                    // notify 无回执通道（sidecar fire-and-forget）——失败只能
                    // 本侧 loud（Electron 侧同步 setBadge 失败同样不回执
                    // renderer，见 SwiftEdgeHostLegs.setBadge 注释的 parity 结论）。
                    print("[native] notify \(method) 消费失败（loud）：\(error)")
                }
            }
        case .retireNotifications(let sourceIds, let notificationIds):
            // S8/P-07：Electron 退役语义 = 关闭登记中的活跃原生通知。Swift 侧经
            // NotificationDeliveryRegistry（sourceId→chamber-edge-<id>；identifier
            // 末段 = sidecar notificationId）取回已投递 identifier，调
            // UNUserNotificationCenter.removeDeliveredNotifications 清除 OS 通知
            // 中心存量横幅。逐条 notificationIds 在 sourceIds 为空时同样生效
            // （node-edges 的 >16 淘汰路径）。
            guard let registry = bridge.edgeHostLegs?.notificationRegistry else {
                print("[native] notify retireNotifications 消费失败：edgeHostLegs 未接线（loud）")
                return
            }
            let identifiers = registry.retire(sourceIds: sourceIds, notificationIds: notificationIds)
            guard !identifiers.isEmpty else {
                print("[native] notify retireNotifications：无已投递登记（\(sourceIds.count) 个 sourceId、"
                      + "\(notificationIds.count) 个 notificationId，no-op）")
                return
            }
            guard Bundle.main.bundleIdentifier != nil else {
                // 无 bundle（swift run dev）下 UNUserNotificationCenter.current()
                // 会崩（bundleProxyForCurrentProcess nil）——同 AppDelegate 守卫。
                print("[native] notify retireNotifications：dev 无 bundle 不支持通知中心，"
                      + "\(identifiers.count) 条登记未清除（loud）")
                return
            }
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: identifiers)
            print("[native] notify retireNotifications：已请求清除 \(identifiers.count) 条已投递通知")
        case .unexpectedClick:
            // notifyClicked 的正常路径是 __host.notifyClicked 入站请求
            // （AppDelegate userNotificationCenter click 回灌），不应经 notify
            // 到达——loud 打印不处理。
            print("[native] notify notifyClicked 不经 notify 到达（正常 = __host.notifyClicked 请求路径）——忽略（loud）")
        case .malformed(let reason):
            // 未知事件/形状非法：loud 丢弃，绝不伪造成功/猜测。
            print("[native] notify 拒绝消费（loud）：\(reason)")
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

    /// P-18 启动门（纯函数，单测直测）：shim 源码缺失/为空 → 返回不可启动的
    /// 致命说明（含已查找目录与修复动作）；可用 → nil。
    ///
    /// 对齐 Electron：preload 脚本加载失败会经 dialog.showErrorBox + app.exit(1)
    /// 拒绝开窗（fail-closed）；Swift 此前只 print 警告后照常开窗，用户得到
    /// 一个没有桥、全部本机能力静默缺席的页面。
    /// T-1：本说明是**用户可见**文案——内部资源名（bridge-shim.poc.js）与 SwiftPM
    /// bundle 名只进 native-shell.log（AppDelegate 调用点显式落盘），这里只列查找
    /// 目录，绝不把 "poc" 露到提示框。
    static func shimStartupFailure(source: String?) -> String? {
        guard let source, !source.isEmpty else {
            var searched: [String] = []
            for base in ChamberResources.searchBases() {
                let path = base.path
                if !searched.contains(path) { searched.append(path) }
            }
            return "缺少 A 桥 shim 资源：页面无法注入 dshChamber 桥，本机能力全部不可用。"
                + "已在以下目录查找：" + searched.joined(separator: "、") + "。"
                + "请重新运行 pnpm run build:swift-app（dev 用 swift build）后重试。"
        }
        return nil
    }

    /// 由 URL 生成 origin 串 "scheme://host[:port]"（nil：URL 无合法 origin）
    /// 注：POC 用固定 dev 端口 17520，但这里从 POC_CP_URL 解析拼接，避免硬编码
    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(),
              let rawHost = url.host, !rawHost.isEmpty else {
            return nil
        }
        // host 大小写折叠（与 TrustGuard 的判定一致，避免 origin 串因大小写
        // 与浏览器规范化结果不同而在逐字比较处失配）。
        let host = rawHost.lowercased()
        // IPv6 字面量：URL.host 去掉方括号（"::1"），拼回 origin 时必须补回，
        // 否则生成的 origin 串不可解析（2026-09 二审：`http://[::1]:17520` 曾
        // 归到 `http://::1:17520` 导致归一化静默跳过、IPC 全拒）。
        let hostPart = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        var origin = "\(scheme)://\(hostPart)"
        if let port = url.port {
            origin += ":\(port)"
        }
        return origin
    }

    /// 把 Swift 值序列化为合法 JS 字面量（JSON 字符串是 JS 字面量的合法子集；
    /// .fragmentsAllowed 允许顶层为字符串/数字等标量）
    static func jsonLiteral(_ value: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: value,
                                                     options: [.fragmentsAllowed]) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    // MARK: - NSWindowDelegate：关窗决策（E1/E20）

    /// 关窗请求：委托 AppDelegate 走 core 决策（hide-to-tray → orderOut 隐藏；
    /// close-behavior='quit' → NSApp.terminate 完整退出链）。返回 false = 本次
    /// 关闭被接管（AppKit 不销毁窗口）。无委托时放行（保守）。
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        closeDelegate?.handleWindowCloseRequest() ?? true
    }

    // MARK: - WKNavigationDelegate：导航护栏

    /// 导航决策（S-26/S-27/S-35；纯逻辑单测直测）。优先级：
    ///  1. shouldPerformDownload → .download（WebKit 转交 WKDownload 保存，
    ///     **绝不**把响应装进壳 webview——原围栏对此类导航一律 cancel，导致
    ///     session 日志导出静默假成功）；
    ///  2. 首载失败说明页的 about:blank（S-27 一次性放行）；
    ///  3. 壳文档 allow；同源非壳文档 cancel（文档绝不继承 shim/IPC 面）；
    ///     外部 http(s) / mailto 交系统；
    ///  4. S-35：**非主 frame** 的 blob: 放行（随包文档预览插件的
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
            // 折叠判定——静态审查 #11：导航/消息两门行为统一）
            if TrustGuard.isTrustedDocument(url.absoluteString, expectedOrigin: expectedOrigin) {
                return .allow
            }
            // 同源但非壳文档（如 /api/i/<id>/* 代理回传的远端 HTML）：绝不
            // 放行——放行会让该文档继承 shim 与全量 IPC 面（审计 major）。
            // 判定不分 frame：同源非壳文档在任何 frame 都取消。
            if TrustGuard.isTrustedOrigin(url.absoluteString, expectedOrigin: expectedOrigin) {
                return .cancel(reason: "同源非壳文档")
            }
            // 其余 http(s) 外链：交给系统默认浏览器打开
            return .openExternally
        }
        if scheme == "mailto" { return .openExternally }
        if scheme == "blob", !isMainFrame {
            // S-35：文档预览插件的 HTML/PDF/图片走 URL.createObjectURL 的 blob
            // 子 frame（vendor ui-sidebar-documentpreview）。非主 frame 的该文档
            // 拿不到桥：shim 只注入主 frame（BridgeShimInjector.makeUserScript
            // forMainFrameOnly=true），且消息围栏丢弃非主 frame 消息
            // （MessageHandler.fence 的 isMainFrame 门）——因此放行不扩大桥面。
            // 主 frame 的 blob 仍按原围栏取消：壳文档只允许 ready 的 cp origin。
            // about:blank/data: 不在放行之列（预览插件不需要；主 frame 的
            // about:blank 仅经 S-27 失败页一次性门放行）。
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
                                       // S-35：targetFrame 缺省（新窗口等）按主 frame
                                       // 最严围栏处理，绝不因未知而放宽。
                                       isMainFrame: navigationAction.targetFrame?.isMainFrame ?? true) {
        case .allow:
            // S-27/S-42：失败页一次性豁免在这里只**观察**、绝不消费（didCommit
            // 才消费——本回调实测先于 didCommit 到达，消费会让失败页呈现门失效：
            // S-42 回归）。只有 about: 导航能带着豁免走到这里，放行面不放大；
            // blob 子 frame 放行也绝不会吃掉 main frame 的豁免。
            if presentationGate.allowsFailurePageNavigation(),
               (url?.scheme ?? "").lowercased() == "about" {
                print("[native] 放行首载失败说明页（about:blank，一次性门；didCommit 消费）")
            } else {
                print("[native] 放行导航 \(url?.absoluteString ?? "")")
            }
            decisionHandler(.allow)
        case .download:
            // S-26：.download 不装载文档（WKDownload 负责保存）；前端 session
            // 日志导出的 anchor[download] 走这条路，页面仍发布 success。
            shellLog("[native] 导航转下载（不装入壳 webview）\(url?.absoluteString ?? "")")
            decisionHandler(.download)
        case .openExternally:
            print("[native] 外链交给系统打开 \(url?.absoluteString ?? "")")
            if let url { openExternally(url) }
            decisionHandler(.cancel)
        case .cancel(let reason):
            print("[native] 拦截导航（\(reason)）\(url?.absoluteString ?? "")")
            decisionHandler(.cancel)
        }
    }

    /// S-26 响应级下载：MIME 不可呈现（如 application/zip 的 session 导出）
    /// 转下载；能呈现才放行。响应级导航不会是外链——外链在 action 级已转系统。
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if !navigationResponse.canShowMIMEType {
            shellLog("[native] 响应不可呈现 → 转下载 \(navigationResponse.response.url?.absoluteString ?? "")")
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView,
                 navigationAction: WKNavigationAction,
                 didBecome download: WKDownload) {
        download.delegate = self
        shellLog("[native] 导航已转为下载（action 级）")
    }

    func webView(_ webView: WKWebView,
                 navigationResponse: WKNavigationResponse,
                 didBecome download: WKDownload) {
        download.delegate = self
        shellLog("[native] 导航已转为下载（response 级）")
    }

    // MARK: - WKDownloadDelegate（S-26；2026-12 对齐 Electron 默认下载）

    /// 保存目标：**静默落盘到下载目录**，与 Electron 默认下载例程等价——Electron
    /// 全仓无 will-download/setSavePath = Chromium 默认静默写
    /// app.getPath('downloads')，无保存面板、无下载 UI、无用户同意（A1 差异表
    /// S-26）。此前这里弹的是保存面板（单向多出的确认），其注释还谎称它是
    /// Electron 默认下载例程的对偶——那是不存在的对偶，已删除；历史取证见
    /// DownloadDestination.swift 头注释。
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
            shellLog("[native] 下载失败：无法解析/创建下载目录（\(directory?.path ?? "<未知>")）"
                + "——取消下载（诚实失败，绝不静默换路径）")
            completionHandler(nil)
            return
        }
        reservedDownloadPaths.insert(destination.path)
        downloadDestinations[ObjectIdentifier(download)] = destination.path
        shellLog("[native] 下载静默落盘（建议文件名 \(suggestedFilename)）→ \(destination.path)")
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        releaseDownloadReservation(download)
        shellLog("[native] 下载完成")
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        releaseDownloadReservation(download)
        shellLog("[native] 下载失败：\(error.localizedDescription)")
    }

    /// 释放下载预留（完成/失败共用；预留只为同一批并发下载不撞名，与真实文件
    /// 存在性判定并联——绝不影响磁盘上的既有文件）。
    private func releaseDownloadReservation(_ download: WKDownload) {
        if let path = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) {
            reservedDownloadPaths.remove(path)
        }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        // W-04：handler 的 origin 判定以 message.webView?.url 实时值为优先，
        // 本记录（lastCommittedURL）作兜底（进程终止/测试桩场景）
        bridgeHandler.noteCommitted(url: webView.url?.absoluteString)
        // S-42：首个「有内容」的提交才呈现启动主窗——窗口在此之前保持隐藏，
        // 绝不先亮无内容空窗（Electron 在 controlPlane.start() 完成后才
        // createMainWindow 的对偶；S-27 失败说明页同为已提交内容，因此失败
        // 终态仍可见）。失败页豁免在此消费（decidePolicyFor 只观察不消费——
        // 两个回调的真实先后顺序因此都不影响呈现：S-42 回归修复）。
        if presentationGate.shouldPresentOnCommit(url: webView.url?.absoluteString) {
            onFirstCommittedContent?()
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        // S-A：provisional 导航开始（首载 / 退避重试 / 重载统一入口）→
        // webViewLoading:true（electron-edges webViewLoading = isLoading 的
        // 事件化等价；失败路径由 didFail* 推 false 收敛，见 navigationFacts）
        pushHostFacts(Self.navigationFacts(for: .started))
        // E19：导航开始即**取消已排定的崩溃重载**（Electron did-start-loading
        // 里 clearCrashReloadTimer；2026-09 三审 E19 偏离 #2）并上报
        // （core 复位 ready 位 + in-flight 重排）。
        recoveryReloadWorkItem?.cancel()
        recoveryReloadWorkItem = nil
        sendRendererLifecycle("did-start-loading")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        shellLog("[native] 页面加载完成 \(webView.url?.absoluteString ?? "(未知)")")
        // T-2：首载/重载成功 → 重试预算归零（下一次失败从最小退避重新开始）。
        navRetries = 0
        navRetryWorkItem?.cancel()
        navRetryWorkItem = nil
        // S-34：首载成功前卡死探测器不 ping/不重载（Electron loadedOnce 门）——
        // 建窗到控制面就绪之间的白屏加载不得被误判卡死。
        hangWatchdog.noteFirstLoadFinished()
        // S-A：加载完成 → webViewLoading:false + webViewContentAlive:true。
        // 渲染进程终止后的恢复导航成功也在此把 alive 收敛回 true（崩溃回调
        // webViewWebContentProcessDidTerminate 推 false 并触发 E19 有界重载）。
        pushHostFacts(Self.navigationFacts(for: .finished))
        // E19 三事件映射之二：加载完成 = core 的确定性 replay 边（drain 待发
        // 通知点击/深链 intent）。
        sendRendererLifecycle("did-finish-load")
        // POC dev 白屏诊断（S14：仅 POC_DEBUG=1，默认关闭）：延迟数秒后渲染
        // 快照落盘（takeSnapshot 不需要屏幕录制权限；多帧取样便于观察首屏演进）。
        guard POCDebug.isEnabled(), !didSnapshot else { return }
        didSnapshot = true
        let snapshotURL = URL(fileURLWithPath: "/tmp/poc-ui-snapshot.png")
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
                    print("[native] 快照失败（delay=\(delay)）")
                    continue
                }
                do {
                    try png.write(to: snapshotURL)
                    print("[native] 快照已写 \(snapshotURL.path)（delay=\(delay)s）")
                } catch {
                    print("[native] 快照写盘失败：\(error.localizedDescription)")
                }
            }
        }
    }

    func webView(_ webView: WKWebView,
                 didFail navigation: WKNavigation!,
                 withError error: Error) {
        // S5：失败路径必须推 webViewLoading:false（无 didFinish 可收敛；
        // sidecar 侧同步门若保持 true，通知打开/深链 drain 会被永久 hold）。
        pushHostFacts(Self.navigationFacts(for: .failed))
        // S-27/S-42：失败页导航若没有走到提交就失败，一次性豁免没有落地对象——
        // 撤销，绝不让它悬着放行后续 about: 导航（非失败页导航时为 no-op）。
        presentationGate.noteNavigationFailed()
        // S-45：打包态控制面 origin 已是 localhost、ATS 例外用正确键名
        // NSExceptionAllowsInsecureHTTPLoads（旧 NSTemporary... 实测不生效）；
        // 此处保留退避重试——探测已 2xx 而导航仍失败属 WebKit 层事实，错误
        // 原文照旧落盘。
        shellLog("[native] 页面加载失败 \(error.localizedDescription)")
    }

    /// 设置变化 push 通道（与 ipc-events.ts SETTINGS_CHANGED 同字面量）。
    static let settingsChangedChannel = "dsh-chamber:settings-changed"

    /// sidecar 就绪态（AppDelegate 的 bridge.onReady / 重启回调）。
    /// `false` = 新进程未就绪 → A 桥 origin 门落闸（重启窗口不放行）。
    /// S12 起无「免门桩态」：dev/装配侧车恒为 sidecar-entry/sidecar.js，
    /// 就绪只由 ready 帧开启；形状未识别的自定义 POC_SIDECAR 自负 ready 协议。
    func noteSidecarReady(_ ready: Bool = true) {
        sidecarReady = ready
        // ready 帧后让页面重跑一次 info 水化（2026-12 审查 minor）：shim 在
        // documentStart 就定义 surface，若首次 1+10 次水化都在 ready 前被就绪门
        // 拒掉，之前没有任何 re-kick → 版本/平台整会话缺失。
        if ready {
            evaluateJS("window.__dshChamberRehydrateInfo && window.__dshChamberRehydrateInfo(\(nativeTokenLiteral))")
            // T-2：ready 才允许首载（打包态冷启动竞态的根治点；重启后再次
            // ready 也走这里，didStartLoading 去重）。
            startLoadingIfNeeded()
        }
    }

    /// 退出清理已开始（S7）：A 桥 app_quitting 门置位（AppDelegate
    /// beginTerminationCleanup 调用）。置位后 late invoke 一律回 app_quitting。
    func noteQuitting() {
        quitting = true
    }

    /// 退出清理开始 → 抑制渲染恢复并取消已排定重载（AppDelegate 调用）。
    func suppressRendererRecovery() {
        recoverySuppressed = true
        recoveryReloadWorkItem?.cancel()
        recoveryReloadWorkItem = nil
        // T-2：退出在途也不再排定首载退避重试（在途就绪探测同样取消）。
        navRetryWorkItem?.cancel()
        navRetryWorkItem = nil
        healthProbeTask?.cancel()
        healthProbeTask = nil
        hangProbeTimer?.invalidate()
        hangProbeTimer = nil
    }

    // MARK: - 菜单动作：重新加载 / 页面缩放（S-24）

    /// A3-3：本 origin 的缩放持久化键（Chromium per_host_zoom_levels 的按 origin
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
        print("[native] 菜单重新加载")
        webView.reload()
    }

    /// 「强制重新加载」（S-24 残余；Electron 默认菜单 forceReload role 对偶：
    /// reloadIgnoringCache 忽略缓存重新取源）。
    func forceReloadPage() {
        print("[native] 菜单强制重新加载（忽略缓存）")
        _ = webView.reloadFromOrigin()
    }

    func zoomIn() {
        let zoom = Self.steppedZoom(current: webView.pageZoom, direction: 1)
        webView.pageZoom = zoom
        persistPageZoom(zoom)
        shellLog("[native] 菜单放大 → pageZoom=\(zoom)")
    }

    func zoomOut() {
        let zoom = Self.steppedZoom(current: webView.pageZoom, direction: -1)
        webView.pageZoom = zoom
        persistPageZoom(zoom)
        shellLog("[native] 菜单缩小 → pageZoom=\(zoom)")
    }

    func resetPageZoom() {
        webView.pageZoom = 1.0
        persistPageZoom(1.0)
        shellLog("[native] 菜单实际大小 → pageZoom=1.0")
    }

    /// 缩放写回（A3-3；读侧 = setupWindow 的 ZoomPersistence.load）。
    private func persistPageZoom(_ zoom: Double) {
        ZoomPersistence.save(defaults: .standard, key: zoomDefaultsKey,
                             zoom: zoom, range: Self.zoomRange)
    }

    // MARK: - 窗口恢复（S-32：Dock/托盘/取消退出共用）

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

    // MARK: - S-02 渲染器卡死自愈（空闲 ping）

    /// 启动卡死探测：定时器 + 键鼠监听（都在主线程）。
    private func startHangWatchdog() {
        hangProbeTimer?.invalidate()
        let timer = Timer.scheduledTimer(withTimeInterval: RendererHangWatchdog.probeInterval,
                                         repeats: true) { [weak self] _ in
            self?.tickHangWatchdog()
        }
        hangProbeTimer = timer
        // 键鼠活动 = 渲染器服务的是人，不判定卡死。
        userInputMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown,
                       .keyDown, .scrollWheel, .flagsChanged]) { [weak self] event in
            self?.hangWatchdog.noteUserInput(at: Date())
            return event
        }
    }

    /// 一次探测：空闲够久 → ping（3s 无回即记 strike）；连续 3 次 → 有界重载。
    private func tickHangWatchdog() {
        guard !recoverySuppressed, !quitting else { return }
        switch hangWatchdog.tick(now: Date()) {
        case .nothing:
            return
        case .probe:
            webView.evaluateJavaScript("1") { [weak self] _, _ in
                self?.hangWatchdog.noteProbeSucceeded()
            }
        case .reload:
            shellLog("[native] 渲染器疑似卡死（连续 \(RendererHangWatchdog.maxStrikes) 次 ping 超时且用户空闲 ≥\(Int(RendererHangWatchdog.idleGrace))s）→ 有界重载")
            scheduleRecoveryReload(reason: "unresponsive")
        }
    }

    /// 有界重载（崩溃与卡死共用同一份预算；差异只在文案与是否上报 crashed）。
    private func scheduleRecoveryReload(reason: String) {
        guard recoveryReloadWorkItem == nil else { return }
        let now = Date().timeIntervalSince1970
        switch recoveryPolicy.decide(now: now, attempts: &recoveryAttempts) {
        case .reload(let delay, let attempt):
            shellLog("[native] 渲染恢复（\(reason)），\(String(format: "%.2f", delay))s 后重载（\(attempt)/\(recoveryPolicy.maxReloads)）")
            let item = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.recoveryReloadWorkItem = nil
                guard !self.recoverySuppressed else { return }
                self.webView.reload()
            }
            recoveryReloadWorkItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
        case .giveUp(let attempts):
            shellLog("[native] 渲染恢复正常化放弃（\(reason)，\(attempts) 次），本次不重载")
            let alert = NSAlert()
            alert.alertStyle = .critical
            alert.messageText = "dsh-chamber 前端异常"
            alert.informativeText = "前端渲染进程反复无响应/崩溃，已停止自动恢复。请重新启动应用。"
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
        shellLog("[native] Web 内容进程终止（webViewWebContentProcessDidTerminate）")
        // 退出中：不重载、不上报（Electron render-process-gone 在 quitRequested
        // 时直接 return；2026-09 三审 E19 偏离 #3）。
        guard !recoverySuppressed else {
            shellLog("[native] 退出中——抑制渲染恢复")
            return
        }
        pushHostFacts(["webViewContentAlive": false])
        // 崩溃到重载之间没有导航事件（did-start-loading 不触发）——必须显式
        // 上报 crashed，否则 core 会继续向死 frame 推送丢事件。
        sendRendererLifecycle("crashed")

        // 重载走共享的有界恢复策略（不置永久放弃位：滚动窗口自身限制 60s 内 ≤3 次；
        // 2026-09 三审 E19 偏离 #1）。S-02 的卡死腿同用这一份预算。
        scheduleRecoveryReload(reason: "crashed")
    }

    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        // S5：初载失败同样收敛 webViewLoading:false（退避重试会在
        // didStartProvisionalNavigation 再推 true；失败间隙保持 true 会让
        // sidecar 侧的 drain 门被 hold）。
        pushHostFacts(Self.navigationFacts(for: .failed))
        let nsError = error as NSError
        // 取消不是失败：loadHTMLString 替换在途导航（含失败页自身导航）与主动
        // reload 都会以 cancelled 收尾——重试或落失败页只会自扰。**也不得**撤销
        // 失败页豁免：noteStartupFailure 的 loadHTMLString 会取消在途的 cpURL
        // 导航，若这里清掉 pending，随后 about: 失败页会被自家围栏拦掉（S-27）。
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled {
            shellLog("[native] 导航被取消（不重试、不落失败页）：\(error.localizedDescription)")
            return
        }
        // S-27/S-42：失败页导航若在提交前失败，一次性豁免没有落地对象——撤销，
        // 绝不让它悬着放行后续 about: 导航（非失败页导航时为 no-op）。
        presentationGate.noteNavigationFailed()
        // T-3：sidecar 已 fatal 时失败页的权威原因已经在（noteStartupFailure
        // 已呈现）——晚到的 WebKit 错误绝不覆盖它。
        if startupFailureMessage != nil {
            shellLog("[native] 页面加载失败（sidecar 启动失败已呈现为失败页）：\(error.localizedDescription)")
            return
        }
        // T-2：首载只在 sidecar ready 后发起；失败后按退避重试至成功或真正
        // 耗尽（说明页只在耗尽/不可重试时出现），不再「首次失败就停在说明页」。
        guard Self.StartupLoadRetry.isRetryableLoadError(error) else {
            shellLog("[native] 页面加载失败(不可重试) \(error.localizedDescription)")
            showLoadFailurePage(in: webView, error: error, exhausted: false)
            return
        }
        switch Self.StartupLoadRetry.decision(attempts: navRetries,
                                              sidecarFailed: startupFailureMessage != nil) {
        case .retry(let delay):
            let retryURL = webView.url ?? cpURL
            navRetries += 1
            shellLog("[native] 控制面未就绪，\(navRetries)/\(Self.StartupLoadRetry.maxAttempts) 次重试 "
                + "\(String(format: "%.1f", delay))s 后加载 \(retryURL.absoluteString)")
            scheduleNavRetry(url: retryURL, after: delay)
        case .giveUp:
            shellLog("[native] 页面加载失败 重试耗尽：\(error.localizedDescription)")
            showLoadFailurePage(in: webView, error: error, exhausted: true)
        }
    }

    /// T-2：退避重试调度（可取消；退出 / sidecar fatal / 加载成功时取消）。
    /// S-45：probe=true 时重试的是首载前的 /health 探测（而不是导航）。
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

    /// 首载失败的可见错误面（2026-12 双端逐函数核对 S5·U4）：Electron 失败时显示
    /// 浏览器错误页，Swift 侧此前只打印 stderr → 用户面对白屏。这里落一张最小
    /// 说明页（原因 + 控制面地址 + T-3 sidecar 真实原因），绝不自行重开会话。
    private func showLoadFailurePage(in webView: WKWebView, error: Error, exhausted: Bool) {
        let hint: String
        if startupFailureMessage != nil {
            hint = "sidecar 启动失败，控制面未能启动。"
        } else if exhausted {
            hint = "已重试 \(navRetries) 次仍未连上控制面。"
        } else {
            hint = "控制面未能加载。"
        }
        let html = Self.failurePageHTML(hint: hint,
                                        detail: error.localizedDescription,
                                        cpURL: cpURL.absoluteString,
                                        sidecarFailure: startupFailureMessage)
        // S-27/S-42：loadHTMLString(baseURL: nil) 导航到 about:blank，会被自家
        // 围栏 cancel（说明页因此永不显示）——置一次性豁免：decidePolicyFor 只
        // 观察放行、didCommit 消费并触发呈现门（两个回调谁先到都呈现，见
        // StartupPresentationGate 注记）。
        presentationGate.beginFailurePage()
        // 白屏/失败终态在落盘日志里也留一条（含控制面地址与重试耗尽标记；
        // 双击态没有 stdout 可看，这是唯一的本地考古面）。
        shellLog("[native] 落首载失败说明页（exhausted=\(exhausted) "
            + "cp=\(cpURL.absoluteString) error=\(error.localizedDescription)）")
        webView.loadHTMLString(html, baseURL: nil)
    }

    /// 失败说明页 HTML（T-1 文案锁步的纯函数）：可见面恒用 displayName，
    /// 绝不出现 "poc"/"DSHChamberPoc"；sidecar 失败原因（T-3）附加在页面上。
    static func failurePageHTML(hint: String, detail: String, cpURL: String,
                                sidecarFailure: String?) -> String {
        func escape(_ text: String) -> String {
            text.replacingOccurrences(of: "&", with: "&amp;")
                .replacingOccurrences(of: "<", with: "&lt;")
                .replacingOccurrences(of: ">", with: "&gt;")
        }
        var html = """
        <!doctype html><meta charset="utf-8"><title>\(displayName)</title>
        <body style="font-family:-apple-system,system-ui;padding:48px;color:#1d1d1f">
        <h2>无法加载 \(displayName) 界面</h2>
        <p>\(escape(hint))</p>
        <p style="color:#6e6e73">\(escape(detail))</p>
        <p style="color:#6e6e73">控制面地址：\(escape(cpURL))</p>
        """
        if let sidecarFailure, !sidecarFailure.isEmpty, sidecarFailure != detail {
            html += "\n<p>sidecar 启动失败：\(escape(sidecarFailure))</p>"
        }
        html += "\n</body>"
        return html
    }

    /// T-3：sidecar 启动失败（supervisor fatal）→ 记录真实原因（退出码 +
    /// stderr 摘要 + 端口占用提示），停掉首载退避重试并立即呈现失败说明页。
    /// 应用随后仍走既有 fatal 提示框/退出链；本函数保证失败页不是 WebKit 的
    /// ATS 文案，而是 sidecar 的诚实报错（S-27/S-42 呈现门照常生效）。
    func noteStartupFailure(_ message: String) {
        startupFailureMessage = message
        navRetryWorkItem?.cancel()
        navRetryWorkItem = nil
        healthProbeTask?.cancel()
        healthProbeTask = nil
        shellLog("[native] sidecar 启动失败 → 停止首载重试并显示失败页：\(message)")
        showLoadFailurePage(in: webView,
                            error: StartupFailurePageError(message: message),
                            exhausted: true)
    }

    /// 失败页把 sidecar 启动失败当「error」呈现（LocalizedError 直出 message）。
    struct StartupFailurePageError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// T-2：首载失败退避重试策略（纯逻辑单测直测）。首载只在 sidecar ready
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
        // vendor markdown 的外链恒 _blank——2026-09 模块评审 major：原实现
        // 静默丢弃）。
        if navigationAction.targetFrame == nil,
           let url = navigationAction.request.url,
           TrustGuard.isExternalLink(url.absoluteString, expectedOrigin: cpOrigin) {
            print("[native] 新窗外链交系统打开 \(url.absoluteString)")
            openExternally(url)
        } else {
            print("[native] 拒绝新建窗口请求")
        }
        return nil
    }

    // MARK: - WKUIDelegate：文件选择面板（S-25）

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
        print("[native] 文件选择面板：多选=\(request.allowsMultipleSelection) "
            + "目录=\(request.allowsDirectories) 类型数=\(request.allowedContentTypes.count)")
        FileOpenPanel.present(request, presenter: fileOpenPanelPresenter) { urls in
            completionHandler(urls)
        }
    }

    /// 媒体采集权限：默认拒绝（2026-12 双端逐函数核对 S4·F9/S3·D11）。Electron 只
    /// 放行 clipboard-sanitized-write、其余权限请求全拒（main.ts:3832-3834）；WKWebView
    /// 只暴露媒体采集这一类权限回调（macOS 12+），因此这里拒绝摄像头/麦克风/屏幕共享，
    /// 剪贴板与网页 Notification 的等价面登记在台账。
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        print("[native] 拒绝媒体采集权限请求（origin=\(origin.host) type=\(type.rawValue)）")
        decisionHandler(.deny)
    }

    /// S-24：Help 菜单等原生入口复用既有外部打开路径（预算 + NSWorkspace
    /// loud 失败）——页面 window.open 与原生菜单动作共享同一预算纪律，绝不
    /// 绕开预算另开一条（openExternally 保持私有）。
    func openExternalPage(_ url: URL) {
        openExternally(url)
    }

    // MARK: - 私有

    private func openExternally(_ url: URL) {
        // 预算（二轮评审 A-P2）：页面可经 window.open 连续刷外链，超限后
        // 30s 冷却并 loud（与 shell-core 同参数）。
        switch externalBudget.decide(now: Date().timeIntervalSince1970) {
        case .blocked(let remaining):
            print("[native] 外链打开被预算限制（冷却 \(Int(remaining))s）：\(url.absoluteString)")
            return
        case .allow:
            break
        }
        // 打开失败必须 loud（2026-12 双端逐函数核对 S4·F7）：Electron 的
        // openExternal 失败会 reject 并记录；此处此前把错误回调整个吞掉，
        // 用户点了链接没反应且日志无痕。
        if #available(macOS 14.0, *) {
            NSWorkspace.shared.open(url, configuration: NSWorkspace.OpenConfiguration()) { _, error in
                if let error {
                    print("[native] 外链打开失败 \(url.absoluteString)：\(error.localizedDescription)")
                }
            }
        } else if !NSWorkspace.shared.open(url) {
            print("[native] 外链打开失败 \(url.absoluteString)：NSWorkspace.open 返回 false")
        }
    }
}

// MARK: - notify 路由解码（S-D：sidecar 出站 notify 的消费决策，纯值纯逻辑）

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
            // P-07：notificationIds 与 sourceIds 并存；缺省 = []（旧 sidecar
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
final class POCConsoleCatcher: NSObject, WKScriptMessageHandler {
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "pocConsole" else { return }
        if let body = message.body as? [String: Any],
           let kind = body["kind"] as? String,
           let text = body["text"] as? String {
            print("[native-web] \(kind): \(text)")
        } else {
            print("[native-web] raw: \(message.body)")
        }
    }
}
