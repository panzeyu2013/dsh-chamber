//  AppDelegate.swift —— 应用生命周期与启动装配
//  DSHChamberPoc（macos/ SwiftPM POC 壳）：W-03（design 25 §8.1；
//  todo companion macos-swift-v1 §0.2④）；B 桥接入点对应 W-04 契约
//
//  职责：解析环境（node / sidecar / 控制面 URL）→ 组装 BridgeClient
//  （BridgeClient.swift，W-04 作者实现，见共享契约）→ 启动 sidecar →
//  创建主窗口。关键步骤逐行打印 "[poc] ..." 到 stdout，便于无 GUI 验证。
import AppKit
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {

    // MARK: - 常量（缺省值）

    /// 缺省 node：打包态 dsh-chamber 的 Electron 二进制（ELECTRON_RUN_AS_NODE=1 即 Node 24）
    private static let defaultNodePath = "/Applications/dsh-chamber.app/Contents/MacOS/dsh-chamber"
    /// 缺省控制面 URL（dev 态控制面，design 25 §3.3）
    private static let defaultControlPlaneURL = "http://127.0.0.1:17520/"
    /// dev 态 sidecar 脚本相对仓库根的位置（自当前工作目录向上查找）
    private static let sidecarRelativePath = "packages/desktop/poc-sidecar.ts"

    // MARK: - 状态

    private var bridge: BridgeClient?
    private var mainWindowController: MainWindowController?

    // MARK: - NSApplicationDelegate

    func applicationDidFinishLaunching(_ notification: Notification) {
        print("[poc] applicationDidFinishLaunching：开始装配")
        // W-21：通知授权与 delegate 接线（前台展示 + click 回灌；权限拒绝 →
        // 授权结果打印，调度侧以 UNUserNotificationCenter.add 错误 loud——
        // 绝不静默假装成功）。请求失败/拒绝均不阻断装配。
        // 注意：swift run（无 app bundle）下 UNUserNotificationCenter.current()
        // 会崩（bundleProxyForCurrentProcess nil）——以 Bundle.main.bundleIdentifier
        // 是否存在守卫；dev/无 bundle 态跳过通知接线（真机/打包态自动启用）。
        if Bundle.main.bundleIdentifier != nil {
            let center = UNUserNotificationCenter.current()
            center.delegate = self
            center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
                if let error {
                    print("[poc] 通知授权请求错误：\(error.localizedDescription)")
                } else {
                    print("[poc] 通知授权 = \(granted)")
                }
            }
        } else {
            print("[poc] 无 bundle id（swift run dev 态）——跳过通知授权接线")
        }
        let env = ProcessInfo.processInfo.environment

        // ① Node 路径：POC_NODE_BIN，缺省回退打包态 Electron 二进制
        let nodePath = env["POC_NODE_BIN"] ?? Self.defaultNodePath
        print("[poc] node = \(nodePath)")

        // ② sidecar 脚本路径：POC_SIDECAR，缺省自当前目录向上（≤6 层）查找
        let sidecarPath = env["POC_SIDECAR"] ?? Self.findSidecarUpwards()
        if let path = sidecarPath {
            print("[poc] sidecar = \(path)")
        } else {
            print("[poc] sidecar = (未找到：POC_SIDECAR 未设且向上查找 \(Self.sidecarRelativePath) 失败)")
        }
        // sidecar-entry.ts（W-11 真业务 sidecar）需要参数：--user-data-dir /
        // --web-dist-dir / --port。按脚本名识别并补默认参数（env 可覆盖：
        // POC_USER_DATA / POC_WEB_DIST / POC_PORT）；poc-sidecar 桩保持旧
        // 零参语义不变。
        var sidecarArguments: [String] = sidecarPath.map { [$0] } ?? []
        if let path = sidecarPath, (path as NSString).lastPathComponent.contains("sidecar-entry") {
            let repoRoot = URL(fileURLWithPath: path)
                .deletingLastPathComponent()  // packages/desktop
                .deletingLastPathComponent()  // packages
                .deletingLastPathComponent()  // 仓库根
                .path
            let stateDir = env["POC_USER_DATA"]
                ?? NSHomeDirectory() + "/Library/Application Support/dsh-chamber-poc-dev"
            let webDir = env["POC_WEB_DIST"] ?? repoRoot + "/packages/desktop/dist/web"
            let port = env["POC_PORT"] ?? "17520"
            sidecarArguments += [
                "--user-data-dir", stateDir,
                "--web-dist-dir", webDir,
                "--port", port,
            ]
            print("[poc] sidecar-entry 默认参数：user-data=\(stateDir) web=\(webDir) port=\(port)")
        }

        // ③ 子进程环境：node 路径 basename 含 "dsh-chamber"（即 Electron 二进制）
        //    时注入 ELECTRON_RUN_AS_NODE=1（写进传给子进程的 process environment）
        var childEnv = env
        let nodeBasename = (nodePath as NSString).lastPathComponent
        if nodeBasename.contains("dsh-chamber") {
            childEnv["ELECTRON_RUN_AS_NODE"] = "1"
            print("[poc] 注入 ELECTRON_RUN_AS_NODE=1（Electron 二进制当 Node 用）")
        }

        // ④ 控制面 URL：POC_CP_URL，缺省 http://127.0.0.1:17520/
        guard let cpURL = URL(string: env["POC_CP_URL"] ?? Self.defaultControlPlaneURL) ?? URL(string: Self.defaultControlPlaneURL) else {
            fatalStartup("POC_CP_URL 无法解析为 URL")
        }
        print("[poc] control plane = \(cpURL.absoluteString)")

        // 组装 B 桥并启动 sidecar；失败 = 打印 stderr + alert 后退出
        let bridge = BridgeClient(nodePath: nodePath, arguments: sidecarArguments, environment: childEnv)
        do {
            try bridge.start()
        } catch {
            fatalStartup("BridgeClient 启动失败：\(error.localizedDescription)")
        }
        self.bridge = bridge
        print("[poc] bridge 已启动")

        // 主窗口并激活
        let controller = MainWindowController(cpURL: cpURL, bridge: bridge)
        mainWindowController = controller
        // W-19/20 宿主腿接线：legs 以主窗为 UI 上下文（canShowUI = 应用激活态
        // 的窗口存在性）；BridgeClient 默认表在 legs 报 unimplemented/
        // ui-unavailable 前缀时回落（POC 无宿主实现不挂起）。实机 GUI 验收
        // 属 M3 集成硬门禁（SwiftEdgeHostLegs 各腿 TODO 注释）。
        let legs = SwiftEdgeHostLegs(config: .init(canShowUI: { [weak controller] in
            controller?.window?.isVisible == true
        }))
        legs.mainWindowProvider = { [weak controller] in controller?.window }
        bridge.edgeHostLegs = legs
        controller.window?.makeKeyAndOrderFront(nil)
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
        print("[poc] 主窗口已显示")

        // 最小主菜单（WKWebView 文本编辑快捷键路由需要；G2 剪贴板走查预检）
        installMainMenu()
    }

    /// 关闭最后一个窗口不退出（隐藏到 Dock 语义；G5 退出/隐藏走查在 W-07）
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// Dock 点击/重开恢复主窗口（静态审查 #12：关窗后无窗常驻的恢复入口）
    func applicationShouldHandleReopen(_ sender: NSApplication,
                                       hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            mainWindowController?.showWindow(nil)
            mainWindowController?.window?.makeKeyAndOrderFront(nil)
        }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        print("[poc] applicationWillTerminate：停止 bridge")
        bridge?.stop()
    }

    // MARK: - 启动辅助

    /// 自当前工作目录向上（≤6 层）查找 dev 态 sidecar 脚本
    static func findSidecarUpwards(maxLevels: Int = 6) -> String? {
        var dir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        for _ in 0...maxLevels {
            let candidate = dir.appendingPathComponent(sidecarRelativePath)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate.path
            }
            dir = dir.deletingLastPathComponent()
        }
        return nil
    }

    /// 致命启动错误：stderr 一行（无 GUI 可验证）+ 弹窗提示后退出
    private func fatalStartup(_ message: String) -> Never {
        fputs("[poc] 致命错误：\(message)\n", stderr)
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "dsh-chamber POC 启动失败"
        alert.informativeText = message
        alert.runModal()
        exit(1)
    }

    /// 最小主菜单：App 菜单（退出）+ 编辑菜单（WebKit 编辑快捷键路由）
    private func installMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出 dsh-chamber POC",
                        action: #selector(NSApplication.terminate(_:)),
                        keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu

        NSApp.mainMenu = mainMenu
    }

    // MARK: - UNUserNotificationCenterDelegate（W-21）

    /// 前台展示（应用激活时通知仍横幅展示——渲染器不持有原生通知历史）。
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        if #available(macOS 11.0, *) {
            completionHandler([.banner, .sound])
        } else {
            completionHandler([.alert, .sound])
        }
    }

    /// click 回灌（design 25 §5 E4；node-edges clickRoute 语义）：宿主先聚焦
    /// 激活窗口（electron-edges 宿主 click 腿同序），再经保留入站 method
    /// __host.notifyClicked {notificationId} 送回 sidecar——node-edges 命中
    /// 通知 id 的 clickRoute.onActivated（core owns+入队）。identifier 形如
    /// chamber-edge-<notificationId>（SwiftEdgeHostLegs 调度时命名）。
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }
        mainWindowController?.window?.makeKeyAndOrderFront(nil)
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
        let identifier = response.notification.request.identifier
        guard identifier.hasPrefix("chamber-edge-"),
              let rawID = identifier.dropFirst("chamber-edge-".count).split(separator: "-").first,
              let notificationId = Int(rawID) else {
            print("[poc] 通知 click：未知 identifier，跳过回灌（仅聚焦窗口）")
            return
        }
        guard let bridge else {
            print("[poc] 通知 click：bridge 未装配，跳过回灌")
            return
        }
        print("[poc] 通知 click 回灌：notificationId=\(notificationId)")
        Task {
            do {
                let outcome = try await bridge.invoke(
                    method: "__host.notifyClicked",
                    payload: .object(["notificationId": .number(Double(notificationId))])
                )
                print("[poc] 通知 click 回灌应答：\(String(describing: outcome))")
            } catch {
                print("[poc] 通知 click 回灌失败：\(error.localizedDescription)")
            }
        }
    }
}
