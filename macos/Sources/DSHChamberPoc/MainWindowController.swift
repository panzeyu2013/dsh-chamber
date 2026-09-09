//  MainWindowController.swift —— 主窗口：WKWebView 加载控制面 + A 桥接线
//  DSHChamberPoc（macos/ SwiftPM POC 壳）：W-03（design 25 §8.1）；
//  本文件持有 W-04 契约的接线点（ChamberMessageHandler / BridgeShimInjector
//  为 MessageHandler.swift / BridgeShimInjector.swift 中他人实现，见共享契约）
//
//  职责：WKWebView 加载控制面 origin 的壳文档（根路径）；把 bridge-shim.poc.js
//  （ChamberResources 定位的 SwiftPM 资源）注入 WebView；ChamberMessageHandler
//  注册为 "dshChamber" 消息通道并回接 evaluateJavaScript；B 桥 invoke 结果与
//  sidecar 事件经 __dshChamberResolve / __dshChamberEmit 回写页面；
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
//  如实 no-op（无登记表），notifyClicked/未知事件 loud 不处理——路由决策表
//  见文件底部 decodeNotify/NotifyRoute（纯逻辑，单测直测）。
import AppKit
import WebKit

final class MainWindowController: NSWindowController, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {

    // MARK: - 常量

    /// A 桥消息通道名（与 shim 侧约定一致）
    private static let bridgeMessageName = "dshChamber"
    /// POC dev 控制台回传通道名（页面脚本约定；见 setupWindow 注入）
    private static let consoleMessageName = "pocConsole"
    /// A 桥 shim 资源文件名（Resources/ 下，W-04 作者创建，本文件只读取）
    private static let shimResourceName = "bridge-shim.poc.js"
    /// 可 invoke 的 method 白名单：W-04 是最小 7 通道集；W-18 manifest 化后
    /// 扩为 BridgeManifest.invokeChannels 全集（60/60 真实现都在 sidecar 侧，
    /// 语义权威与护栏仍在 sidecar/TrustGuard——readiness/badge 等通道不再
    /// 被 POC 层误拒成 poc-unimplemented）。与桥 shim 暴露面一致性问题：shim
    /// 只暴露其脚本内实现的方法，未暴露方法在页面层即 stub——两处均以
    /// manifest 为准的演进是 M3 全量 shim（chamber-bridge.stub.js）的活。
    private static let invokeWhitelist: Set<String> = BridgeManifest.invokeChannels
    /// 窗口默认内容尺寸
    private static let windowSize = NSSize(width: 1280, height: 800)
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
    /// 自动恢复已放弃（超限后不再重载，只 loud/弹窗一次）。


    // MARK: - 状态

    private let bridge: BridgeClient
    private let cpURL: URL
    /// 控制面 origin（scheme://host:port），导航放行与消息护栏共用
    private let cpOrigin: String
    /// sidecar ready 帧已到（A 桥 origin 门在此之前一律拒绝）。
    private var sidecarReady = false

    private var webView: WKWebView!
    private var bridgeHandler: ChamberMessageHandler!
    /// 关窗决策委托（AppDelegate；见 windowShouldClose）。
    weak var closeDelegate: MainWindowCloseDeciding?
    private var consoleCatcher: POCConsoleCatcher?
    private var didSnapshot = false
    private var navRetries = 0
    private var didStartLoading = false
    /// hostFacts 推送簿记（S-A）：已推送（含推送意图）事实，键 → 布尔。
    /// 仅主线程读写：全部推送调用点都是主线程回调（AppKit 窗口通知 /
    /// WKNavigationDelegate），簿记在事件回调内同步完成（去重判断与推送
    /// 顺序因此与事件顺序一致，见 pushHostFacts 注释）。
    private var lastHostFacts: [String: Bool] = [:]

    // MARK: - 初始化

    /// - Parameters:
    ///   - cpURL: 控制面 URL（AppDelegate 解析自 POC_CP_URL，缺省 127.0.0.1:17520）
    ///   - bridge: B 桥客户端（BridgeClient.swift，W-04 契约）
    init(cpURL: URL, bridge: BridgeClient) {
        self.cpURL = cpURL
        self.bridge = bridge
        self.cpOrigin = Self.origin(of: cpURL) ?? ""
        if self.cpOrigin.isEmpty {
            print("[poc] 警告：控制面 URL 无合法 origin，导航护栏将一律拦截 http(s)")
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

    /// 构建 WKWebView（含 A 桥注入与消息通道）与主窗口
    private func setupWindow() {
        let configuration = WKWebViewConfiguration()

        // A 桥 shim 注入（W-04：BridgeShimInjector.install 负责落 WKUserScript）
        if let shimSource = Self.readShimSource() {
            BridgeShimInjector.install(config: configuration, source: shimSource)
            print("[poc] A 桥 shim 注入完成（\(Self.shimResourceName)）")
        } else {
            print("[poc] 警告：资源中找不到 \(Self.shimResourceName)，跳过 shim 注入")
        }

        // 消息通道：ChamberMessageHandler 只做护栏与转发（W-04 实现）
        let handler = ChamberMessageHandler(
            whitelist: Self.invokeWhitelist,
            // ready 帧前 expectedOrigin = nil → 一律拒绝（design 25 §4.4.1
            // 第 2 条「port 只在 ready 帧后放开」；2026-09 模块评审 minor）。
            expectedOrigin: { [weak self] in
                guard let self, self.sidecarReady else { return nil }
                return self.cpOrigin
            },
            onInvoke: { [weak self] id, method, payload in
                self?.handleInvoke(id: id, method: method, payload: payload)
            },
            onEvent: { [weak self] event, payload in
                self?.handleEvent(event: event, payload: payload)
            }
        )
        handler.evaluateJavaScript = { [weak self] script in
            self?.evaluateJS(script)
        }
        bridgeHandler = handler
        configuration.userContentController.add(handler, name: Self.bridgeMessageName)

        // POC dev 调试（白屏诊断）：web 控制台/错误回传 → [poc-web] 打印。
        // 页面 JS onerror/unhandledrejection/console.* 经 pocConsole 通道回传；
        // 打包/发布不需要移除（仅额外打印，无副作用）。
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

        // 事件下行接线（W-04 MessageHandler 双写纪律「乙」）：sidecar 事件唯一
        // 入口 = BridgeClient.onEvent → 本控制器直写 __dshChamberEmit；本控制器
        // 不调用 handler.emit（避免同事件双写）。构造参数 onEvent 只是 emit 在
        // evaluateJavaScript 未就绪时的降级路径，语义同一。事件可能来自 B 桥
        // 后台队列：handleEvent 内部经 Task { @MainActor } 收敛到主线程。
        bridge.onEvent = { [weak self] event, payload in
            self?.handleEvent(event: event, payload: payload)
        }
        // S-D：sidecar 出站 **notify 帧**（{"notify":event,"payload":…}——
        // node-edges 的 sendNotify 族：rendererPush/setBadge/
        // showItemInFolder/retireNotifications）→ 本控制器 notify 路由消费
        // （与 onEvent 的 event 帧族是两条独立帧族，B 桥线协议两侧都发——
        // 本文件「事件下行接线」注释的 onEvent 只覆盖 event 帧族；notify 帧
        // 族在 BridgeClient.dispatchOutboundFrame 走 onNotify，此前无人接线
        // → 全部 loud 丢弃，rendererPush 等从未进页面。S-D 在此接线：
        // routeNotify 解码 → rendererPush 解包进页面 emit / 原生腿分流）。
        // 线程契约与 onEvent 相同：管道读取线程回调，消费在 routeNotify 内
        // 收敛主线程。
        bridge.onNotify = { [weak self] event, payload in
            self?.routeNotify(event: event, payload: payload)
        }

        // WebView
        let webView = WKWebView(frame: NSRect(origin: .zero, size: Self.windowSize),
                                configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        self.webView = webView

        // 窗口
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: Self.windowSize),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered,
                              defer: false)
        window.title = "dsh-chamber POC"
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
        center.addObserver(self, selector: #selector(hostWakeUp(_:)),
                           name: NSWorkspace.didWakeNotification, object: nil)
        center.addObserver(self, selector: #selector(appDidBecomeActive(_:)),
                           name: NSApplication.didBecomeActiveNotification, object: nil)
    }

    // MARK: - A-1/A-2 入站事件发送（唤醒/窗口显示）

    @objc private func hostWakeUp(_ note: Notification) {
        print("[poc] 系统唤醒——发送 __host.systemResume")
        Task { @MainActor in
            try? await bridge.invoke(
                method: HostInboundMethod.systemResume,
                payload: .object(["timestamp": .number(Date().timeIntervalSince1970 * 1000)])
            )
        }
    }

    @objc private func appDidBecomeActive(_ note: Notification) {
        print("[poc] 应用激活——发送 __host.mainWindowShown")
        Task { @MainActor in
            _ = try? await bridge.invoke(method: HostInboundMethod.mainWindowShown, payload: nil)
        }
    }

    override func windowDidLoad() {
        super.windowDidLoad()
        startLoadingIfNeeded()
    }

    // MARK: - 页面加载

    /// 首次加载控制面（幂等：windowDidLoad 与 init 兜底都可能触发）
    private func startLoadingIfNeeded() {
        guard !didStartLoading else { return }
        didStartLoading = true
        print("[poc] 加载控制面 \(cpURL.absoluteString)（origin=\(cpOrigin)）")
        webView.load(URLRequest(url: cpURL))
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
    ///     的线程安全由 BridgeClient 保证（与 onEvent/handleInvoke 同款收敛）；
    ///   - 失败 loud 打印「[poc] hostFacts 推送失败」，不重试、不回滚意图
    ///     簿记：sidecar 缓存按键合并、只接受布尔，随后的同类事实变化事件
    ///     会携带最新值再推（启动期推送先于 sidecar 就绪时被其 stdin 管道
    ///     缓冲，实际几乎不失败——sidecar 模块求值完成后即处理）。
    /// sidecar 重启（新进程没有历史事实）→ 清空去重簿记，下一次推送即全量
    /// 快照；否则新 sidecar 会长期以「种子事实」运行（2026-09 三审 #8）。
    func resetHostFactsBookkeeping() {
        lastHostFacts = [:]
        pushHostFacts(["mainWindowAlive": true, "webViewContentAlive": true])
    }

    private func pushHostFacts(_ changes: [String: Bool]) {
        let (payload, merged) = Self.hostFactsDiff(last: lastHostFacts, changes: changes)
        guard !payload.isEmpty else { return }
        lastHostFacts = merged
        let summary = payload.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: " ")
        print("[poc] hostFacts 推送 \(summary)")
        let object = AnyCodable.object(payload.mapValues { .bool($0) })
        Task { @MainActor in
            do {
                _ = try await bridge.invoke(method: Self.hostFactsMethod, payload: object)
            } catch {
                print("[poc] hostFacts 推送失败：\(error.localizedDescription)")
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
        print("[poc] rendererLifecycle 上报 \(event)")
        Task { @MainActor in
            do {
                _ = try await bridge.invoke(
                    method: HostInboundMethod.rendererLifecycle,
                    payload: .object(["event": .string(event)]))
            } catch {
                print("[poc] rendererLifecycle 上报失败（\(event)）：\(error.localizedDescription)")
            }
        }
    }

    // MARK: - B 桥 invoke / sidecar 事件回写页面

    /// web → Swift invoke（经 handler 转发）：调 B 桥后把结果交回页面
    private func handleInvoke(id: Int, method: String, payload: AnyCodable?) {
        print("[poc] invoke #\(id) \(method)")
        Task { @MainActor in
            do {
                let result = try await bridge.invoke(method: method, payload: payload)
                let resultJSON = Self.jsonLiteral(result.jsonObject) ?? "null"
                evaluateJS("__dshChamberResolve(\(id), \(resultJSON), null)")
            } catch {
                // 失败：__dshChamberResolve(id, null, <errorString>)；errorString
                // 经 JSON 序列化即为合法 JS 字符串字面量
                let errorJSON = Self.jsonLiteral(error.localizedDescription) ?? "\"bridge error\""
                evaluateJS("__dshChamberResolve(\(id), null, \(errorJSON))")
            }
        }
    }

    /// sidecar 事件（event 帧族）→ 页面 __dshChamberEmit。
    /// 事件源两条路径殊途同归：① 本控制器把 BridgeClient.onEvent 直接喂进来
    /// （W-04「乙」，主线）；② handler.emit 在 evaluateJavaScript 未赋入时的
    /// 构造 onEvent 降级（POC 中 evaluateJavaScript 恒已赋入，实际不触发）；
    /// ③（S-D）notify 路由的 rendererPush 解包后同样落 emitToPage——event 帧
    /// 族与 notify 帧族两路殊途同归到同一页面 emit 面（双写纪律不变：同一
    /// 事件只经一条路径发一次）。事件可能来自 B 桥后台队列：本方法经
    /// Task { @MainActor } 收敛到主线程再 emit。
    private func handleEvent(event: String, payload: AnyCodable?) {
        print("[poc] 事件 \(event)")
        Task { @MainActor in
            emitToPage(event: event, payload: payload)
        }
    }

    /// 页面 emit 直写（调用方必须已在主线程）：__dshChamberEmit(eventJSON,
    /// payloadJSON)。序列化失败 → loud 打印不注入（绝不注入残缺 JS）。
    private func emitToPage(event: String, payload: AnyCodable?) {
        guard let eventJSON = Self.jsonLiteral(event) else {
            print("[poc] 页面 emit 序列化失败：event 不可 JSON 化（丢弃）")
            return
        }
        let payloadJSON: String
        if let payload = payload {
            payloadJSON = Self.jsonLiteral(payload.jsonObject) ?? "null"
        } else {
            payloadJSON = "null"
        }
        evaluateJS("__dshChamberEmit(\(eventJSON), \(payloadJSON))")
    }

    /// 主线程执行 JS（所有调用点都已收敛到主线程）
    private func evaluateJS(_ script: String) {
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    // MARK: - notify 消费路由（S-D）

    /// sidecar notify → 消费（路由表与解码见文件底部 decodeNotify/
    /// NotifyRoute——纯逻辑，单测直测；本方法只做执行与 loud）。
    /// 解码在到达线程（管道读取线程）就地完成（纯函数），消费按决策收敛
    /// 主线程（Task { @MainActor }，与 handleEvent 同款纪律——宿主腿触碰
    /// NSApp/NSWorkspace/dockTile 必须主线程）。
    private func routeNotify(event: String, payload: AnyCodable?) {
        switch Self.decodeNotify(event: event, payload: payload) {
        case .emitToPage(let channel, let payload):
            // rendererPush 解包：channel/payload 原样进页面（与 electron-edges
            // rendererPush = webContents.send(channel, payload) 同语义）。
            print("[poc] notify rendererPush → 页面 emit \(channel)")
            Task { @MainActor in
                emitToPage(event: channel, payload: payload)
            }
        case .hostLeg(let method, let payload):
            Task { @MainActor in
                guard let legs = bridge.edgeHostLegs else {
                    print("[poc] notify \(method) 消费失败：edgeHostLegs 未接线（loud）")
                    return
                }
                // 与 edge 面同一执行体（respond 内部 performUI + 窗口守卫）：
                // canShowUI/窗口守卫语义一致，无窗/headless → 诚实降级。
                let outcome = legs.respond(method: method, payload: payload)
                if let error = outcome.error {
                    // notify 无回执通道（sidecar fire-and-forget）——失败只能
                    // 本侧 loud（Electron 侧同步 setBadge 失败同样不回执
                    // renderer，见 SwiftEdgeHostLegs.setBadge 注释的 parity 结论）。
                    print("[poc] notify \(method) 消费失败（loud）：\(error)")
                }
            }
        case .retireNoop(let count):
            // Electron 退役语义 = 关闭登记中的活跃原生通知；Swift 侧撤销已
            // 展示通知 = UNUserNotificationCenter.removeDeliveredNotifications
            // (identifiers)，需 sourceId→identifier 登记表——POC 未跟踪已展示
            // 通知（edge 调度以 chamber-edge-<notificationId> 命名、无 sourceId
            // 映射），如实 no-op 并 loud（未来登记表落地后在此改接 remove）。
            print("[poc] notify retireNotifications：无 sourceId→identifier 登记表，no-op（\(count) 个 sourceId）")
        case .unexpectedClick:
            // notifyClicked 的正常路径是 __host.notifyClicked 入站请求
            // （AppDelegate userNotificationCenter click 回灌），不应经 notify
            // 到达——loud 打印不处理。
            print("[poc] notify notifyClicked 不经 notify 到达（正常 = __host.notifyClicked 请求路径）——忽略（loud）")
        case .malformed(let reason):
            // 未知事件/形状非法：loud 丢弃，绝不伪造成功/猜测。
            print("[poc] notify 拒绝消费（loud）：\(reason)")
        }
    }

    // MARK: - 工具

    /// 读取 A 桥 shim 源码（ChamberResources：打包态 Contents/Resources、
    /// dev `swift run` 扁平布局都能定位；不用 Bundle.module——见该文件头注释）。
    private static func readShimSource() -> String? {
        guard let url = ChamberResources.url(forResource: shimResourceName),
              let source = try? String(contentsOf: url, encoding: .utf8) else {
            return nil
        }
        return source
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

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let scheme = (url.scheme ?? "").lowercased()
        if scheme == "http" || scheme == "https" {
            // 目标是 cp origin 的 http(s)：放行（与 TrustGuard 同款大小写
            // 折叠判定——静态审查 #11：导航/消息两门行为统一）
            if TrustGuard.isTrustedDocument(url.absoluteString, expectedOrigin: cpOrigin) {
                print("[poc] 放行导航 \(url.absoluteString)")
                decisionHandler(.allow)
                return
            }
            if TrustGuard.isTrustedOrigin(url.absoluteString, expectedOrigin: cpOrigin) {
                // 同源但非壳文档（如 /api/i/<id>/* 代理回传的远端 HTML）：绝不
                // 放行——放行会让该文档继承 shim 与全量 IPC 面（审计 major）。
                print("[poc] 拦截同源非壳文档导航 \(url.absoluteString)")
                decisionHandler(.cancel)
                return
            }
            // 其余 http(s) 外链：交给系统默认浏览器打开
            print("[poc] 外链交给系统打开 \(url.absoluteString)")
            openExternally(url)
            decisionHandler(.cancel)
        } else if scheme == "mailto" {
            print("[poc] mailto 交给系统打开 \(url.absoluteString)")
            openExternally(url)
            decisionHandler(.cancel)
        } else {
            // 其余一律取消（自定义 scheme / about: / data: 等）
            print("[poc] 拦截导航 \(url.absoluteString)")
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        // W-04：handler 的 origin 判定以 message.webView?.url 实时值为优先，
        // 本记录（lastCommittedURL）作兜底（进程终止/测试桩场景）
        bridgeHandler.noteCommitted(url: webView.url?.absoluteString)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        // S-A：provisional 导航开始（首载 / 退避重试 / 重载统一入口）→
        // webViewLoading:true（electron-edges webViewLoading = isLoading 的
        // 事件化等价；加载失败无 didFinish 时保持 true，成功/重载后收敛）
        pushHostFacts(["webViewLoading": true])
        // E19：导航开始即**取消已排定的崩溃重载**（Electron did-start-loading
        // 里 clearCrashReloadTimer；2026-09 三审 E19 偏离 #2）并上报
        // （core 复位 ready 位 + in-flight 重排）。
        recoveryReloadWorkItem?.cancel()
        recoveryReloadWorkItem = nil
        sendRendererLifecycle("did-start-loading")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        print("[poc] 页面加载完成 \(webView.url?.absoluteString ?? "(未知)")")
        // S-A：加载完成 → webViewLoading:false + webViewContentAlive:true。
        // 渲染进程终止后的恢复导航成功也在此把 alive 收敛回 true（崩溃回调
        // webViewWebContentProcessDidTerminate 推 false 并触发 E19 有界重载）。
        pushHostFacts(["webViewLoading": false, "webViewContentAlive": true])
        // E19 三事件映射之二：加载完成 = core 的确定性 replay 边（drain 待发
        // 通知点击/深链 intent）。
        sendRendererLifecycle("did-finish-load")
        // POC dev 白屏诊断：延迟数秒后渲染快照落盘（takeSnapshot 不需要屏幕
        // 录制权限；多帧取样便于观察首屏演进）。
        guard !didSnapshot else { return }
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
                    print("[poc] 快照失败（delay=\(delay)）")
                    continue
                }
                do {
                    try png.write(to: snapshotURL)
                    print("[poc] 快照已写 \(snapshotURL.path)（delay=\(delay)s）")
                } catch {
                    print("[poc] 快照写盘失败：\(error.localizedDescription)")
                }
            }
        }
    }

    func webView(_ webView: WKWebView,
                 didFail navigation: WKNavigation!,
                 withError error: Error) {
        // 注：若 http:// 字面 IP 被 ATS 拦截，可 -Xlinker -sectcreate __TEXT
        // __info_plist 注入 NSAllowsLocalNetworking，或改用 localhost（§0.2④）
        print("[poc] 页面加载失败 \(error.localizedDescription)")
    }

    /// sidecar ready（AppDelegate 的 bridge.onReady）→ 放开 A 桥 origin 门。
    func noteSidecarReady() {
        sidecarReady = true
    }

    /// 退出清理开始 → 抑制渲染恢复并取消已排定重载（AppDelegate 调用）。
    func suppressRendererRecovery() {
        recoverySuppressed = true
        recoveryReloadWorkItem?.cancel()
        recoveryReloadWorkItem = nil
    }

    /// WKWebView 渲染进程终止（崩溃/被系统回收；Electron render-process-gone
    /// 对应）→ webViewContentAlive:false（内容已死——通知/深链投递门即刻不
    /// 过，绝不向死 frame 推送）+ crashed 上报 + **有界自动重载**
    /// （design 25 §5 E19 / main.ts installRendererRecovery:605-700 同参数：
    /// 500ms 延迟、60s 滚动窗口内至多 3 次；超限弹 NSAlert 并停止自动恢复）。
    /// 恢复导航成功由 didFinish 推回 alive:true 并 drain。
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        print("[poc] Web 内容进程终止（webViewWebContentProcessDidTerminate）")
        // 退出中：不重载、不上报（Electron render-process-gone 在 quitRequested
        // 时直接 return；2026-09 三审 E19 偏离 #3）。
        guard !recoverySuppressed else {
            print("[poc] 退出中——抑制渲染恢复")
            return
        }
        pushHostFacts(["webViewContentAlive": false])
        // 崩溃到重载之间没有导航事件（did-start-loading 不触发）——必须显式
        // 上报 crashed，否则 core 会继续向死 frame 推送丢事件。
        sendRendererLifecycle("crashed")

        guard recoveryReloadWorkItem == nil else { return }
        let now = Date().timeIntervalSince1970
        switch recoveryPolicy.decide(now: now, attempts: &recoveryAttempts) {
        case .reload(let delay, let attempt):
            print("[poc] 渲染进程异常，\(String(format: "%.2f", delay))s 后重载（\(attempt)/\(recoveryPolicy.maxReloads)）")
            let item = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.recoveryReloadWorkItem = nil
                guard !self.recoverySuppressed else { return }
                self.webView.reload()
            }
            recoveryReloadWorkItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
        case .giveUp(let attempts):
            // 不置永久放弃位（Electron 语义：窗口外的下次崩溃重新计数——滚动
            // 窗口自身限制 60s 内 ≤3 次；2026-09 三审 E19 偏离 #1）。
            print("[poc] 渲染进程反复异常退出（\(attempts) 次），本次不重载")
            let alert = NSAlert()
            alert.alertStyle = .critical
            alert.messageText = "dsh-chamber 前端异常"
            alert.informativeText = "前端渲染进程反复崩溃，已停止自动恢复。请重新启动应用。"
            alert.runModal()
        }
    }

    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        // POC dev 竞态兜底：控制面起动晚于首载（sidecar 就绪需 1~2s）——
        // 初次连不上时按退避重试；上限 25 次后放弃（loud）。
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain,
           nsError.code == NSURLErrorCannotConnectToHost || nsError.code == NSURLErrorNotConnectedToInternet {
            guard navRetries < 25 else {
                print("[poc] 页面加载失败(初试) 重试耗尽：\(error.localizedDescription)")
                return
            }
            let retryURL = webView.url ?? cpURL
            navRetries += 1
            print("[poc] 控制面未就绪，\(navRetries)/25 次重试 0.5s 后加载 \(retryURL.absoluteString)")
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 500_000_000)
                webView.load(URLRequest(url: retryURL))
            }
            return
        }
        print("[poc] 页面加载失败(初试) \(error.localizedDescription)")
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
            print("[poc] 新窗外链交系统打开 \(url.absoluteString)")
            openExternally(url)
        } else {
            print("[poc] 拒绝新建窗口请求")
        }
        return nil
    }

    // MARK: - 私有

    private func openExternally(_ url: URL) {
        if #available(macOS 14.0, *) {
            NSWorkspace.shared.open(url, configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
        } else {
            NSWorkspace.shared.open(url)
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
    /// retireNotifications：POC 无 sourceId→identifier 登记表 → 诚实 no-op
    /// （sourceIdCount = 载荷中来源数，仅作 loud 上下文）。
    case retireNoop(sourceIdCount: Int)
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
            var count = 0
            for item in items {
                if case .string = item {
                    count += 1
                } else {
                    return .malformed(reason: "retireNotifications sourceIds 含非字符串元素（丢弃）")
                }
            }
            return .retireNoop(sourceIdCount: count)
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
            print("[poc-web] \(kind): \(text)")
        } else {
            print("[poc-web] raw: \(message.body)")
        }
    }
}
