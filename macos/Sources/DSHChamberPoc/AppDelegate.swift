//  AppDelegate.swift —— 应用生命周期与启动装配
//  DSHChamberPoc（macos/ SwiftPM POC 壳）：W-03（design 25 §8.1；
//  todo companion macos-swift-v1 §0.2④）；B 桥接入点对应 W-04 契约
//
//  职责：解析环境（node / sidecar / 控制面 URL）→ 组装 BridgeClient
//  （BridgeClient.swift，W-04 作者实现，见共享契约）→ 启动 sidecar →
//  创建主窗口。关键步骤逐行打印 "[poc] ..." 到 stdout，便于无 GUI 验证。
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {

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
        let sidecarArguments: [String] = sidecarPath.map { [$0] } ?? []

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
}
