//  MainWindowController.swift —— 主窗口：WKWebView 加载控制面 + A 桥接线
//  DSHChamberPoc（macos/ SwiftPM POC 壳）：W-03（design 25 §8.1）；
//  本文件持有 W-04 契约的接线点（ChamberMessageHandler / BridgeShimInjector
//  为 MessageHandler.swift / BridgeShimInjector.swift 中他人实现，见共享契约）
//
//  职责：WKWebView 加载控制面 origin；把 bridge-shim.poc.js（Bundle.module
//  资源，W-04 作者创建）注入 WebView；ChamberMessageHandler 注册为
//  "dshChamber" 消息通道并回接 evaluateJavaScript；B 桥 invoke 结果与
//  sidecar 事件经 __dshChamberResolve / __dshChamberEmit 回写页面；
//  导航护栏：仅放行 cp origin 的 http(s)，其余交给系统打开或一律取消。
import AppKit
import WebKit

final class MainWindowController: NSWindowController, WKNavigationDelegate, WKUIDelegate {

    // MARK: - 常量

    /// A 桥消息通道名（与 shim 侧约定一致）
    private static let bridgeMessageName = "dshChamber"
    /// A 桥 shim 资源文件名（Resources/ 下，W-04 作者创建，本文件只读取）
    private static let shimResourceName = "bridge-shim.poc.js"
    /// 可 invoke 的 method 白名单（W-04：A 桥护栏雏形的最小桌面通道集）
    private static let invokeWhitelist: Set<String> = [
        "dsh-chamber:info",
        "desktop_ssh_instances_get",
        "desktop_ssh_connect",
        "desktop_ssh_disconnect",
        "desktop_ssh_status",
        "dsh-chamber:settings-get",
        "dsh-chamber:settings-set",
    ]
    /// 窗口默认内容尺寸
    private static let windowSize = NSSize(width: 1280, height: 800)

    // MARK: - 状态

    private let bridge: BridgeClient
    private let cpURL: URL
    /// 控制面 origin（scheme://host:port），导航放行与消息护栏共用
    private let cpOrigin: String

    private var webView: WKWebView!
    private var bridgeHandler: ChamberMessageHandler!
    private var didStartLoading = false

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
            print("[poc] 警告：Bundle.module 中找不到 \(Self.shimResourceName)，跳过 shim 注入")
        }

        // 消息通道：ChamberMessageHandler 只做护栏与转发（W-04 实现）
        let handler = ChamberMessageHandler(
            whitelist: Self.invokeWhitelist,
            expectedOrigin: { [weak self] in self?.cpOrigin },
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

        // 事件下行接线（W-04 MessageHandler 双写纪律「乙」）：sidecar 事件唯一
        // 入口 = BridgeClient.onEvent → 本控制器直写 __dshChamberEmit；本控制器
        // 不调用 handler.emit（避免同事件双写）。构造参数 onEvent 只是 emit 在
        // evaluateJavaScript 未就绪时的降级路径，语义同一。事件可能来自 B 桥
        // 后台队列：handleEvent 内部经 Task { @MainActor } 收敛到主线程。
        bridge.onEvent = { [weak self] event, payload in
            self?.handleEvent(event: event, payload: payload)
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
        self.window = window
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

    /// sidecar 事件 → 页面 __dshChamberEmit(eventJSON, payloadJSON)。
    /// 事件源两条路径殊途同归：① 本控制器把 BridgeClient.onEvent 直接喂进来
    /// （W-04「乙」，主线）；② handler.emit 在 evaluateJavaScript 未赋入时的
    /// 构造 onEvent 降级（POC 中 evaluateJavaScript 恒已赋入，实际不触发）。
    private func handleEvent(event: String, payload: AnyCodable?) {
        print("[poc] 事件 \(event)")
        Task { @MainActor in
            guard let eventJSON = Self.jsonLiteral(event) else { return }
            let payloadJSON: String
            if let payload = payload {
                payloadJSON = Self.jsonLiteral(payload.jsonObject) ?? "null"
            } else {
                payloadJSON = "null"
            }
            evaluateJS("__dshChamberEmit(\(eventJSON), \(payloadJSON))")
        }
    }

    /// 主线程执行 JS（所有调用点都已收敛到主线程）
    private func evaluateJS(_ script: String) {
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    // MARK: - 工具

    /// 读取 A 桥 shim 源码（Bundle.module：SwiftPM 为 .process 资源生成的访问器）
    private static func readShimSource() -> String? {
        guard let url = Bundle.module.url(forResource: shimResourceName, withExtension: nil),
              let source = try? String(contentsOf: url, encoding: .utf8) else {
            return nil
        }
        return source
    }

    /// 由 URL 生成 origin 串 "scheme://host[:port]"（nil：URL 无合法 origin）
    /// 注：POC 用固定 dev 端口 17520，但这里从 POC_CP_URL 解析拼接，避免硬编码
    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(),
              let host = url.host, !host.isEmpty else {
            return nil
        }
        var origin = "\(scheme)://\(host)"
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
            if TrustGuard.isTrustedOrigin(url.absoluteString, expectedOrigin: cpOrigin) {
                print("[poc] 放行导航 \(url.absoluteString)")
                decisionHandler(.allow)
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

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        print("[poc] 页面加载完成 \(webView.url?.absoluteString ?? "(未知)")")
    }

    func webView(_ webView: WKWebView,
                 didFail navigation: WKNavigation!,
                 withError error: Error) {
        // 注：若 http:// 字面 IP 被 ATS 拦截，可 -Xlinker -sectcreate __TEXT
        // __info_plist 注入 NSAllowsLocalNetworking，或改用 localhost（§0.2④）
        print("[poc] 页面加载失败 \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        print("[poc] 页面加载失败(初试) \(error.localizedDescription)")
    }

    // MARK: - WKUIDelegate：禁新窗口

    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        // 一律不开新窗：target=_blank 等走导航护栏/外链处理
        print("[poc] 拒绝新建窗口请求")
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
