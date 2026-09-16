//  AppDelegate.swift —— 应用生命周期与启动装配
//  DSHChamberPoc（macos/ SwiftPM POC 壳）：W-03（design 25 §8.1；
//  todo companion macos-swift-v1 §0.2④）；B 桥接入点对应 W-04 契约
//
//  职责：解析环境（node / sidecar / 控制面 URL）→ 组装 BridgeClient
//  （BridgeClient.swift，W-04 作者实现，见共享契约）→ 启动 sidecar →
//  创建主窗口。关键步骤逐行打印 "[poc] ..." 到 stdout，便于无 GUI 验证。
import AppKit
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate, MainWindowCloseDeciding {

    // MARK: - 常量（缺省值）

    /// 打包态路径解析集中在 `PackagedLayout`（纯函数、可单测）：装配态
    /// node/sidecar/userData/vendor-dsh 都按 `<App>/Contents/Resources/...`
    /// 与 Electron 同根 userData 解析，`POC_*` 环境变量始终优先。
    /// dev 态 sidecar 脚本相对仓库根的位置（自当前工作目录向上查找）。
    /// S12：dev 缺省指向真实 sidecar-entry.ts——poc-sidecar 桩回退整体删除
    /// （桩不开 A 桥 gate、字段形状与 shim 矛盾，是「另一条矛盾路径」）。
    private static let sidecarRelativePath = "packages/desktop/sidecar-entry.ts"
    /// 退出清理硬顶（design 25 §3.3(4)：Swift terminate 超时 = 强制放行退出）。
    /// S6：与 BridgeClient.quitCleanupGracePeriod（SIGTERM 宽限）和 shell-core
    /// 的 QUIT_CLEANUP_TIMEOUT_MS = 5_000 同一预算，单源常量化，拆开不再漂移。
    static let quitCleanupTimeout: TimeInterval = BridgeClient.quitCleanupGracePeriod
    /// 退出/关窗决策请求超时（sidecar 无应答 → 诚实 nil，绝不无限挂起退出）。
    private static let quitFactsTimeout: TimeInterval = 2.0

    // MARK: - 状态

    private var bridge: BridgeClient?
    private var supervisor: SidecarSupervisor?
    private var mainWindowController: MainWindowController?
    /// 深链转发（E13：sidecar 未就绪先缓冲，ready 后按序转交）。
    private lazy var deepLinks = DeepLinkRelay { [weak self] url in
        self?.sendDeepLink(url)
    }
    /// 退出单飞/已确认门（E9/E20；语义照搬 main.ts 三标志）。
    private let quitGate = QuitGate()
    /// 最近一次成功取到的 quitFacts（S3·V9：关窗决策即时可用，不再等 B 桥往返）。
    private var cachedQuitFacts: QuitFacts?
    /// 退出清理是否已启动（幂等；清理完成/超时后 reply 一次）。
    private var quitCleanupStarted = false
    /// 是否在等待 `reply(toApplicationShouldTerminate:)`（每次 .terminateLater 一轮）。
    private var awaitingTerminateReply = false
    /// SIGTERM/SIGINT 的 DispatchSource（必须常驻持有，否则信号监听失效）。
    private var signalSources: [DispatchSourceSignal] = []
    /// 托盘状态项（Electron Tray 对偶：显示窗口 / 退出）。
    private var statusItem: NSStatusItem?
    /// 本壳注册的 URL scheme（Info.plist.template CFBundleURLSchemes 同源）。
    static let deepLinkScheme = "dsh-chamber:"

    // MARK: - NSApplicationDelegate

    func applicationDidFinishLaunching(_ notification: Notification) {
        print("[poc] applicationDidFinishLaunching：开始装配")
        // W-21：通知授权与 delegate 接线（前台展示 + click 回灌；权限拒绝 →
        // 授权结果打印，调度侧以 UNUserNotificationCenter.add 错误 loud——
        // 绝不静默假装成功）。请求失败/拒绝均不阻断装配。
        // 注意：swift run（无 app bundle）下 UNUserNotificationCenter.current()
        // 会崩（bundleProxyForCurrentProcess nil）——以 Bundle.main.bundleIdentifier
        // 是否存在守卫；dev/无 bundle 态跳过通知接线（真机/打包态自动启用）。
        // 二次启动转发的深链接收（S5·F9）：注册必须**早**于取锁（2026-12 审查：
        // 晚注册会给极早的二次实例留一个丢失窗口），且与 argv / application(_:open:)
        // 共用同一条缓冲（顺序与去重由 core 的 enqueueDeepLink 统一负责）。
        // object 校验：只接受本 scheme 的字符串（同用户任意进程都能 post 这条
        // 通知名，未校验就等于把深链注入面开放给本地任意进程）。
        DistributedNotificationCenter.default().addObserver(
            forName: Self.secondaryDeepLinkNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let raw = note.object as? String, raw.hasPrefix(Self.deepLinkScheme + "//") else {
                print("[poc] 丢弃非法二次启动深链通知（非本 scheme）")
                return
            }
            print("[poc] 收到二次启动转发深链 (raw)")
            self?.deepLinks.enqueue(raw)
        }
        if Bundle.main.bundleIdentifier != nil {
            let center = UNUserNotificationCenter.current()
            center.delegate = self
            // 授权时机（2026-12 双端逐函数核对 S3·V1）：Electron 延后到**首次通知**
            // 才向系统申请权限，Swift 此前首启即弹框（用户还没收到任何通知）。
            // 授权请求现在发生在真正调度第一条通知时（SwiftEdgeHostLegs），这里只
            // 接线 delegate（前台展示 + click 回灌）。
            print("[poc] 通知 delegate 已接线（授权在首次通知时请求）")
        } else {
            print("[poc] 无 bundle id（swift run dev 态）——跳过通知授权接线")
        }
        // 打包态判定 + 资源根（PackagedLayout 纯函数解析，见 ChamberResources）。
        let resourcesDir = Bundle.main.resourceURL?.path
        let executablePath = Bundle.main.executableURL?.path ?? CommandLine.arguments.first ?? ""
        let isPackaged = PackagedLayout.isAppBundle(executablePath: executablePath)
        // 2026-12 双端逐函数核对 F13：装配态忽略 POC_* 覆盖。它们只服务 dev/POC；
        // 若在打包 .app 里生效，环境变量即可把壳重定向到任意 node、sidecar 脚本、
        // web dist、userData 或控制面 origin —— 产品边界破口。dev（swift run /
        // 非 .app）路径不受影响。
        let env = isPackaged
            ? ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("POC_") }
            : ProcessInfo.processInfo.environment
        let fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
        let isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
        if isPackaged { print("[poc] 装配态（.app）——按 Contents/Resources 解析缺省路径") }
        // userData 根（与 Electron 打包实根同根）：S2 起无论 sidecar 形状都要
        // 读 chamber-settings.json，故提前解析（lockDir 仍只给真实 sidecar 形状）。
        let stateDir = PackagedLayout.resolveUserData(
            env: env, home: NSHomeDirectory(), isPackaged: isPackaged)
        // 控制面端口缺省（S11）：POC_PORT > DSH_CHAMBER_CP_PORT > dev 空闲退避 /
        // packaged 17500；真实 sidecar 分支里解析后回填（自定义脚本形状不探测，
        // 保持缺省，绝不静默漂移）。
        var resolvedCPPort = env["POC_PORT"] ?? env["DSH_CHAMBER_CP_PORT"]
            ?? (isPackaged ? "17500" : "17520")

        // ① Node 路径（S4）：POC_NODE_BIN（须可执行）→ 装配态自带
        //    <Resources>/sidecar/node（须可执行）→ dev PATH node。皆无 →
        //    fatal（绝不 spawn 裸 node，也绝不拿另一个 app 的 Electron 二进制顶替）。
        let nodePath: String
        do {
            nodePath = try PackagedLayout.resolveNode(
                env: env, resourcesDir: resourcesDir, isPackaged: isPackaged,
                isExecutable: isExecutable)
        } catch let error as PackagedLayout.PathResolutionError {
            fatalStartup(error.message)
        } catch {
            fatalStartup("node 解析失败：\(error.localizedDescription)")
        }
        print("[poc] node = \(nodePath)")

        // ② sidecar 脚本路径（S3）：POC_SIDECAR → 装配态自带
        //    <Resources>/sidecar/sidecar.js → dev 自当前目录向上（≤6 层）查找
        //    sidecar-entry.ts。找不到一律 fatal（绝不 spawn 一个没有脚本的 node）。
        let resolvedSidecar = PackagedLayout.resolveSidecar(
            env: env, resourcesDir: resourcesDir, isPackaged: isPackaged, exists: fileExists)
        guard let sidecarPath = resolvedSidecar ?? Self.findSidecarUpwards(),
              fileExists(sidecarPath) else {
            fatalStartup(Self.missingSidecarMessage(
                isPackaged: isPackaged, resourcesDir: resourcesDir,
                explicitPath: env["POC_SIDECAR"].flatMap { $0.isEmpty ? nil : $0 }))
        }
        print("[poc] sidecar = \(sidecarPath)")
        // 真实 sidecar（dev 的 sidecar-entry.ts / W-23 装配产物的 sidecar.js）
        // 需要参数：--user-data-dir / --web-dist-dir / --port。按脚本名识别并补
        // 默认参数（env 可覆盖：POC_USER_DATA / POC_WEB_DIST / POC_PORT /
        // DSH_CHAMBER_CP_PORT）；形状未识别的自定义 POC_SIDECAR 不注入参数。
        var sidecarArguments: [String] = [sidecarPath]
        /// 目录锁根（W-15：真实 sidecar 形态才取锁——sidecar-entry/sidecar.js
        /// 需要锁与守护；形状未识别的自定义脚本保持直启语义）。
        var lockDir: String?
        /// 装配态 sidecar（W-23 产物 `<Resources>/sidecar/sidecar.js`）：注入
        /// DSH_CHAMBER_SIDECAR_COMPILED=1，让 control-plane-module 走
        /// `<sidecar>/dist/control-plane/index.js` 相对入口（装配目录无
        /// node_modules 树，裸说明符不可解析）。
        var compiledSidecar = false
        do {
            let path = sidecarPath
            let basename = (path as NSString).lastPathComponent
            let isCompiled = basename == "sidecar.js"
            // 形状判定单源 = ControlPlanePort.isRealSidecarScript（与 S11 的
            // --port 注入/空闲探测前置同一判定，测试直测）。
            if ControlPlanePort.isRealSidecarScript(path) {
                compiledSidecar = isCompiled
                let sidecarDir = (path as NSString).deletingLastPathComponent
                let repoRoot = URL(fileURLWithPath: path)
                    .deletingLastPathComponent()  // packages/desktop
                    .deletingLastPathComponent()  // packages
                    .deletingLastPathComponent()  // 仓库根
                    .path
                lockDir = stateDir
                // 装配态 web dist = `<App>/Contents/Resources/dist/web`（W-24 布局；
                // 2026-09 审计发现脚本落位与这里不一致会导致控制面 fatal exit 1）
                // ——按实际候选解析：resourceURL/dist/web → sidecar/dist/web；
                // dev 态 = 仓库 packages/desktop/dist/web。
                let webDir: String
                if let explicit = env["POC_WEB_DIST"], !explicit.isEmpty {
                    webDir = explicit
                } else if isCompiled {
                    let candidates = [
                        resourcesDir.map { PackagedLayout.webDistDir(resourcesDir: $0) },
                        sidecarDir + "/dist/web",
                    ].compactMap { $0 }
                    webDir = candidates.first { FileManager.default.fileExists(atPath: $0 + "/index.html") }
                        ?? candidates[0]
                    if !FileManager.default.fileExists(atPath: webDir + "/index.html") {
                        print("[poc] 警告：装配态 web dist 缺失（候选：\(candidates.joined(separator: ", "))）")
                    }
                } else {
                    webDir = repoRoot + "/packages/desktop/dist/web"
                }
                // sidecar 监听端口必须与控制面 URL 同源（2026-09 二轮：此前
                // 恒 17520，打包态 URL 已改 17500 → 端口错配、白窗）。S11：
                // POC_PORT > DSH_CHAMBER_CP_PORT > dev 空闲端口退避（packaged
                // 固定 17500，不改）；解析结果同时派生控制面 URL。
                let port: String
                do {
                    let resolution = try ControlPlanePort.resolve(
                        env: env, isPackaged: isPackaged,
                        probeDevPort: { ControlPlanePort.probeFreePort(startingAt: $0) })
                    port = String(resolution.port)
                    print("[poc] 控制面端口 = \(port)（\(Self.portSourceLabel(resolution.source))）")
                } catch let error as ControlPlanePort.ResolutionError {
                    fatalStartup(error.message)
                } catch {
                    fatalStartup("控制面端口解析失败：\(error.localizedDescription)")
                }
                resolvedCPPort = port
                sidecarArguments += [
                    "--user-data-dir", stateDir,
                    "--web-dist-dir", webDir,
                    "--port", port,
                ]
                // 可选：POC_DSH_PATH = 可离线运行的 dsh workspace（如
                // <repo>/packages/desktop/vendor/dsh 或打包 Resources/vendor/dsh），
                // 提供后 dev 控制面 pre-spawn 本地 dsh 实例（界面出现本地实例）。
                if let dshPath = PackagedLayout.resolveDshWorkspace(
                    env: env, resourcesDir: resourcesDir, isPackaged: isPackaged, exists: fileExists) {
                    sidecarArguments += ["--dsh-path", dshPath]
                    print("[poc] sidecar 附加 --dsh-path \(dshPath)")
                } else if isPackaged {
                    print("[poc] 警告：装配态未找到内置 dsh 工作区（<Resources>/sidecar/vendor/dsh）——本地实例不可用")
                }
                // 装配态：chamber host 包显式注入（W-23 装配产物
                // <sidecar>/dist/<pkg>/——sidecar-ctx 的 hostPackageSourceDir
                // 在 .app 内向上找不到 `packages/<pkg>`，不注入则三个宿主域
                // 整体缺席并走「构建产物缺失」loud 路径）。
                // 原生更新器声明（S-01 / D-1 选 B）：配好 feed + 公钥的装配才把安装腿
                // 交给壳（sidecar 据此清掉「原生壳不支持自动安装」）；dev/dry-run 不传。
                if AppUpdater.configuration(from: Bundle.main.infoDictionary ?? [:]) != nil {
                    sidecarArguments += ["--native-updater", "sparkle"]
                    print("[poc] sidecar 附加 --native-updater sparkle（Sparkle 已配置）")
                }
                if isCompiled {
                    let hostDirs: [(flag: String, name: String)] = [
                        ("--host-graph-dir", "dsh-chamber-seed-client-graph"),
                        ("--host-git-dir", "dsh-chamber-seed-git-worktree"),
                        ("--host-archive-dir", "dsh-chamber-seed-archive-cleanup"),
                        ("--host-open-in-dir", "dsh-chamber-seed-open-in"),
                    ]
                    var missingHosts: [String] = []
                    for host in hostDirs {
                        let candidate = sidecarDir + "/dist/" + host.name
                        if FileManager.default.fileExists(atPath: candidate + "/package.json") {
                            sidecarArguments += [host.flag, candidate]
                        } else {
                            missingHosts.append(candidate)
                        }
                    }
                    // S2·F12（2026-12 双端逐函数核对）：构建侧已 fail-closed
                    // （build-sidecar 先全量校验再拷贝），运行侧过去只 print 警告
                    // → 手工/损坏装配的 .app 会在缺宿主域的情况下照常启动，用户
                    // 看到的是功能静默缺席。装配态一律 fatal（dev 形状不注入这些
                    // flag，不受影响）。
                    if !missingHosts.isEmpty {
                        fatalStartup("装配态 host 包缺失：\(missingHosts.joined(separator: "、"))"
                            + "——请重新运行 pnpm run build:sidecar 并重装 .app")
                    }
                }
                print("[poc] sidecar 参数：user-data=\(stateDir) web=\(webDir) port=\(port)"
                    + (isCompiled ? "（装配态 W-23 布局）" : "（dev sidecar-entry）"))
            } else {
                print("[poc] 警告：POC_SIDECAR 形状未识别（\(basename)）——不注入锁/守护/端口参数"
                    + "（脚本自身决定协议；控制面 URL 端口保持 \(resolvedCPPort)）")
            }
        }

        // ③ 子进程环境：node 路径 basename 含 "dsh-chamber"（即 Electron 二进制）
        //    时注入 ELECTRON_RUN_AS_NODE=1（写进传给子进程的 process environment）
        var childEnv = env
        if compiledSidecar {
            childEnv["DSH_CHAMBER_SIDECAR_COMPILED"] = "1"
            print("[poc] 注入 DSH_CHAMBER_SIDECAR_COMPILED=1（装配态 control-plane 相对入口）")
        }
        let nodeBasename = (nodePath as NSString).lastPathComponent
        if nodeBasename.contains("dsh-chamber") {
            childEnv["ELECTRON_RUN_AS_NODE"] = "1"
            print("[poc] 注入 ELECTRON_RUN_AS_NODE=1（Electron 二进制当 Node 用）")
        }

        // ④ 控制面 URL：POC_CP_URL 显式覆盖；缺省派生自 resolvedCPPort
        //    （POC_PORT > DSH_CHAMBER_CP_PORT > dev 探测/packaged 缺省，S11）
        //    ——与传给 sidecar 的 --port 必然同源，消除端口错位白窗
        //    （sidecar ready 帧 port 本侧记录于 onReady）。
        guard let rawCPURL = URL(string: env["POC_CP_URL"] ?? "http://127.0.0.1:\(resolvedCPPort)/") else {
            fatalStartup("POC_CP_URL 无法解析为 URL")
        }
        // 壳文档 = 根路径 + 无 query（A 桥信任边界，TrustGuard.isTrustedDocument）。
        // 配置带路径/query（如 /index.html、?fixture=1）时只取 origin 根，否则首载
        // 会被导航护栏拦掉成白窗（2026-09 二审 minor）。
        var cpURL = rawCPURL
        if let origin = MainWindowController.origin(of: rawCPURL),
           !TrustGuard.isTrustedDocument(rawCPURL.absoluteString, expectedOrigin: origin),
           let rootURL = URL(string: origin + "/") {
            print("[poc] 警告：POC_CP_URL 非壳文档（带路径/query）——改用 origin 根 \(rootURL.absoluteString)")
            cpURL = rootURL
        }
        print("[poc] control plane = \(cpURL.absoluteString)")

        // 组装 B 桥：**接线先于 start**（A-3：onReady/onEvent/onNotify 在
        // start 前就位——ready 帧不再被 loud 丢弃；控制器 setupWindow 亦先于
        // start 完成事件接线，消灭起动期事件早丢窗口）。
        let bridge = BridgeClient(nodePath: nodePath, arguments: sidecarArguments, environment: childEnv)
        bridge.onReady = { [weak self] port, shellVersion in
            print("[poc] sidecar ready（port=\(port) shellVersion=\(shellVersion)）")
            // E13：ready 后按序补发冷启动期间缓冲的深链（主线程收敛）；
            // 同时放开 A 桥 origin 门（ready 帧前一律拒绝）。
            DispatchQueue.main.async {
                self?.mainWindowController?.noteSidecarReady()
                self?.handleSidecarReady()
            }
        }
        let controller = MainWindowController(cpURL: cpURL, bridge: bridge)
        controller.closeDelegate = self
        mainWindowController = controller
        // W-19/20 宿主腿接线：canShowUI = **有 app bundle（可呈现 UI/通知）**，
        // 不再以窗口可见性为门（2026-09 模块评审 major：Electron 的通知面没有
        // 可见性门，hide-to-tray 后 orderOut 会让通知被误判 ui-unavailable）。
        // 需要窗口的腿（focusMainWindow/setBadge/setKeepAwake）各自经
        // mainWindowProvider 守卫；headless（swift run 无 bundle）仍诚实降级。
        let legs = SwiftEdgeHostLegs(config: .init(canShowUI: {
            Bundle.main.bundleIdentifier != nil
        }))
        legs.mainWindowProvider = { [weak controller] in controller?.window }
        bridge.edgeHostLegs = legs
        self.bridge = bridge
        // W-15 Supervisor（design 25 §3.3(1)(4)）：真实 sidecar 形态
        // （sidecar.js / sidecar-entry.ts）先取目录锁再 spawn，运行中崩溃按
        // 退避重启（500ms/60s≤3），fatal 分流 NSAlert；形状未识别的自定义
        // POC_SIDECAR 保持直启语义（无锁/无守护，ready 协议由脚本自负）。
        if let lockDir {
            let supervisor = SidecarSupervisor(
                directoryLock: SidecarDirectoryLock(userDataDir: lockDir),
                dependencies: .init(
                    makeSidecar: { bridge },
                    onFatal: { message in
                        DispatchQueue.main.async { Self.presentFatalAlert(message) }
                    },
                    // 三审 #9：进程已死 → 新进程未就绪，深链必须重新缓冲
                    // （否则直通发给未装配的新 sidecar 并丢弃）。
                    onRestartScheduled: { [weak self] attempt, delay in
                        DispatchQueue.main.async {
                            self?.deepLinks.reset()
                            // 新进程未就绪 → A 桥 origin 门重新落闸（否则重启
                            // 窗口内的消息会被当成「已就绪」放行）。
                            self?.mainWindowController?.noteSidecarReady(false)
                            print("[poc] sidecar 重启中（attempt=\(attempt)）——深链转缓冲、A 桥门落闸")
                        }
                    }))
            do {
                try supervisor.start()
            } catch {
                // 二次直接启动（S4·F4，2026-12 双端逐函数核对）：Electron 的
                // requestSingleInstanceLock 失败会**静默激活**已有窗口，Swift 此前
                // 只弹 flock 致命框（用户以为程序坏了）。锁被同一个本壳的另一实例
                // 持有时 → 激活它并安静退出；被别的程序（另一个 flavor/其他进程）
                // 持有时保留原来的致命提示（绝不假装「已激活」）。
                if case .heldByAnotherProcess? = error as? SidecarDirectoryLock.LockError,
                   Self.activateExistingInstance() {
                    // 二次实例的深链不能丢（S5·F9）：Electron 的 second-instance
                    // 事件会把 secondary 的 argv 转发给 primary，Swift 之前只激活
                    // 窗口。这里把 argv 里的 dsh-chamber:// 经本壳私有分布式通知
                    // 交给已运行实例，再安静退出。
                    _ = Self.forwardDeepLinksToRunningInstance(arguments: CommandLine.arguments)
                    exit(0)
                }
                let detail = (error as? SidecarDirectoryLock.LockError)?.description
                    ?? "sidecar 启动失败：\(error.localizedDescription)"
                fatalStartup(detail)
            }
            self.supervisor = supervisor
            print("[poc] bridge 已启动（Supervisor 守护，锁=\(lockDir)/.dsh-chamber.lock）")
        } else {
            do {
                try bridge.start()
            } catch {
                fatalStartup("BridgeClient 启动失败：\(error.localizedDescription)")
            }
            print("[poc] bridge 已启动（自定义 sidecar 形状：无目录锁/无守护）")
        }

        // S2：启动期 chamber-settings reconcile（main.ts:1428-1438 同序）——
        // <userData>/chamber-settings.json 的 keepAwake 经 settings UI 同一个
        // setKeepAwake 宿主腿应用。缺文件 = 默认 off（无日志）；损坏 = loud +
        // 默认。窗口对象此刻已存在，腿的 no-window 守卫可通过。
        StartupSettings.apply(StartupSettings.readKeepAwake(userDataDir: stateDir)) { on in
            legs.respond(method: "setKeepAwake", payload: .object(["on": .bool(on)]))
        }
        // 登录自启每次启动重放（2026-12 双端逐函数核对 S3·D5 / S5·F6）：
        // Electron main.ts:1434-1440 每次都 applyLaunchAtLogin——系统移除登录项
        // （例如 .app 被移动）后 Swift 侧此前永不修复，而设置页仍显示「已开启」。
        // 键缺失/文件损坏 = 不动作（绝不猜一个值去动登录项）。
        if let launchAtLogin = StartupSettings.readLaunchAtLogin(userDataDir: stateDir) {
            legs.respond(method: "setLoginItem", payload: .object(["enabled": .bool(launchAtLogin)]))
            print("[poc] 启动期重放登录自启：enabled=\(launchAtLogin)")
        } else {
            print("[poc] 登录自启设置不可读（损坏）——本次启动不改动登录项")
        }

        // 显示主窗口并激活（页面首载若早于控制面就绪由导航退避重试兜底）
        controller.window?.makeKeyAndOrderFront(nil)
        // 关窗决策缓存失效钩子（2026-12 审查 major）：设置页改「关闭窗口行为」后，
        // 下一次关窗必须用**新**的 quitFacts，而不是缓存里的旧值。
        controller.onSettingsChanged = { [weak self] in
            self?.cachedQuitFacts = nil
            print("[poc] 设置变化 → 关窗决策缓存作废")
        }
        // 关窗决策缓存失效钩子（2026-12 审查 major）：设置页改「关闭窗口行为」后，
        // 下一次关窗必须用**新**的 quitFacts，而不是缓存里的旧值。
        controller.onSettingsChanged = { [weak self] in
            self?.cachedQuitFacts = nil
            print("[poc] 设置变化 → 关窗决策缓存作废")
        }
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
        print("[poc] 主窗口已显示")

        // 应用内更新（S-01 / 裁决 D-1 选 B）：Sparkle 装配必须在 installMainMenu
        // 之前——菜单项按 isAvailable 决定 enable。安装前清理链在此注入。
        AppUpdater.shared.onWillInstall = { [weak self] in
            self?.bridge?.edgeHostLegs?.clearKeepAwake()
            self?.bridge?.edgeHostLegs?.clearBadge()
            self?.mainWindowController?.noteQuitting()
            self?.supervisor?.stop()
        }
        AppUpdater.shared.start()
        // 最小主菜单（WKWebView 文本编辑快捷键路由需要；G2 剪贴板走查预检）
        installMainMenu()
        // 2026-12 双端功能对齐（台账 S3·D12 / S5·F10）：SIGTERM/SIGINT 转入标准退出链
        // （design 25 §3.3(5)；Electron 同场景走 before-quit）。
        installSignalHandlers()
        // 二次启动转发的深链接收已前移到函数开头（S5·F9 审查：注册必须早于取锁，
        // 且要校验 scheme）——此处不再重复注册，否则同一通知会入队两次。
        // argv 冷启动深链（main.ts scanDeepLinkUrls 对偶，台账 S4·F1）：GUI 启动通常走
        // application(_:open:)，但从终端/脚本直接传 URL 时只有 argv。
        enqueueCommandLineDeepLinks()
        // 托盘入口（Electron Tray「显示窗口/退出」对偶，台账 S3·V4 / S4·U3）。
        installStatusItem()
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

    /// macOS 深链入口（design 25 §4.5/E13）：Info.plist CFBundleURLTypes 注册后
    /// 由 LaunchServices 投递（冷启动先于 sidecar ready 到达 → 缓冲，ready 后
    /// 按序转交 B 桥 `__host.deepLink`）。归一化/去重/队列语义在 core
    /// enqueueDeepLink，本层只做「不丢」。
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            print("[poc] 深链到达 \(url.absoluteString)")
            deepLinks.enqueue(url.absoluteString)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        print("[poc] applicationWillTerminate：停止 bridge（Supervisor 回收进程 + 释放目录锁）")
        if let supervisor {
            supervisor.stop()
        } else {
            bridge?.stop()
        }
    }

    // MARK: - 关窗 / 退出链（E1/E9/E20；决策单源在 core，见 __host.quitFacts）

    /// 退出请求（Cmd+Q / NSApp.terminate / close-behavior='quit' 转来）。
    /// 三分支（design 25 §5 E20/§3.3(4)，对照 main.ts before-quit）：
    ///  - 已确认 → 直接进入清理（≤5s 硬顶）；
    ///  - 无需确认（core 决策）→ 置确认位后进入清理；
    ///  - 需确认 → NSAlert「退出/取消」：退出走清理，取消则恢复窗口（绝不无窗滞留）。
    /// 决策请求失败 → 保守取消本次退出（绝不静默放行）。
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitGate.isConfirmed {
            // 已确认分支同样要走 .terminateLater（清理链），必须置位 awaiting——
            // 否则 reply(toApplicationShouldTerminate:) 变 no-op，重入退出时
            // 挂死（2026-09 三审 #10：一审登记为潜伏缺陷）。
            let later = beginTerminationCleanup()
            if later { awaitingTerminateReply = true }
            return later ? .terminateLater : .terminateNow
        }
        guard quitGate.beginDecision() else {
            print("[poc] 退出决策在途，忽略重复退出请求")
            return .terminateCancel
        }
        awaitingTerminateReply = true
        requestQuitFacts(quitRequested: true) { [weak self] facts in
            guard let self else { return }
            self.quitGate.endDecision()
            guard let facts else {
                // 决策不可得（sidecar 无应答/超时/解码失败）：区分「可能有本地
                // 保护内容」与「无内容可保护」——前者诚实取消（保留实例，用户可
                // 重试），后者放行（与 main.ts cp===null 语义同向，避免应用变成
                // 退不掉）。
                let sidecarLive = self.supervisor?.state == .running
                    || self.supervisor?.state == .restarting
                if sidecarLive {
                    print("[poc] 退出决策不可得（sidecar 无应答）：取消本次退出，保留本地实例")
                    self.restoreMainWindow()
                    self.replyTerminate(false)
                } else {
                    print("[poc] 退出决策不可得且 sidecar 未运行：无本地保护内容，放行退出")
                    self.quitGate.markConfirmed()
                    if !self.beginTerminationCleanup() {
                        self.replyTerminate(true)
                    }
                }
                return
            }
            if !facts.quitNeedsConfirm {
                self.quitGate.markConfirmed()
                if !self.beginTerminationCleanup() {
                    self.replyTerminate(true)
                }
                return
            }
            self.presentQuitConfirmation(facts: facts)
        }
        return .terminateLater
    }

    /// 关窗请求（windowShouldClose 委托）：hide-to-tray → orderOut 隐藏
    /// （Dock 常驻恢复入口，绝不销毁）；close-behavior='quit' → 转完整退出链。
    /// 真退出在途放行关闭；决策失败保守隐藏（不关窗、不退出）。
    func handleWindowCloseRequest() -> Bool {
        if quitGate.isConfirmed { return true }
        // S3·V9（2026-12 双端逐函数核对）：有缓存事实时**立即**决策——Electron 的
        // 关窗判定是同步的（设置已在主进程），Swift 此前每次都等一次 B 桥往返
        // （最长 2s 窗口无响应，用户以为卡死）。缓存缺失才走异步请求，并在返回
        // 前顺手刷新缓存（后台，不阻塞本次决策）。
        if let facts = cachedQuitFacts {
            requestQuitFacts(quitRequested: false) { _ in }
            switch QuitCoordinator.closeAction(facts: facts) {
            case .hide:
                print("[poc] 关窗 → 隐藏（缓存事实即时决策，S3·V9）")
                mainWindowController?.window?.orderOut(nil)
            case .terminate:
                print("[poc] 关窗 → 退出（close-behavior='quit'，缓存事实即时决策）")
                NSApp.terminate(nil)
            }
            return false
        }
        guard quitGate.beginDecision() else { return false }
        requestQuitFacts(quitRequested: false) { [weak self] facts in
            guard let self else { return }
            self.quitGate.endDecision()
            guard let facts else {
                print("[poc] 关窗决策获取失败：保守隐藏窗口（不关闭、不退出）")
                self.mainWindowController?.window?.orderOut(nil)
                return
            }
            switch QuitCoordinator.closeAction(facts: facts) {
            case .hide:
                print("[poc] 关窗 → 隐藏（Dock 常驻恢复入口）")
                self.mainWindowController?.window?.orderOut(nil)
            case .terminate:
                print("[poc] 关窗 → 退出（close-behavior='quit'）")
                NSApp.terminate(nil)
            }
        }
        return false
    }

    private func presentQuitConfirmation(facts: QuitFacts) {
        guard quitGate.beginConfirm() else {
            replyTerminate(false)
            return
        }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "退出 dsh-chamber？"
        alert.informativeText = QuitCoordinator.confirmDetail(reasons: facts.quitReasons)
        alert.addButton(withTitle: "退出")
        let cancelButton = alert.addButton(withTitle: "取消")
        // 与 Electron 对齐（main.ts:1064-1066 buttons ['退出','取消'] defaultId: 1
        // cancelId: 1；2026-12 双端逐函数核对 V2）：Enter 命中「取消」这个安全项。
        cancelButton.keyEquivalent = "\r"
        let response = alert.runModal()
        quitGate.endConfirm()
        if response == .alertFirstButtonReturn {
            quitGate.markConfirmed()
            if !beginTerminationCleanup() {
                replyTerminate(true)
            }
            return
        }
        // 取消：本次退出作废，恢复窗口（mac close-behavior='quit' 时窗口可能
        // 已隐藏/关闭——恢复入口绝不少于一个）。
        print("[poc] 退出已取消")
        restoreMainWindow()
        replyTerminate(false)
    }

    /// 退出清理（sidecar 进程回收 + 目录锁释放）。返回 true = 已启动异步清理，
    /// 完成后 reply；false = 无需清理（无 supervisor），调用方直接 reply。
    private func beginTerminationCleanup() -> Bool {
        // E19 偏离 #3：退出清理一开始就抑制渲染恢复（不再排定/执行 reload）。
        mainWindowController?.suppressRendererRecovery()
        // S7：A 桥 app_quitting 门——清理开始后 late invoke 不得再向 shutdown
        // 注入传输/运行时工作（renderer-trust.ts createTrustedIpc 对偶）。
        mainWindowController?.noteQuitting()
        // D13/V5（2026-12 双端逐函数核对）：退出清理显式收回 keep-awake 与 Dock
        // 角标（Electron will-quit 同序）。窗口可能已关闭，故走不经 no-window
        // 守卫的直接清理入口，而不是 A 桥 respond（会被守卫挡掉）。
        bridge?.edgeHostLegs?.clearKeepAwake()
        bridge?.edgeHostLegs?.clearBadge()
        guard supervisor != nil else { return false }
        guard !quitCleanupStarted else { return true }
        quitCleanupStarted = true
        print("[poc] 退出清理：停止 sidecar（≤\(Int(Self.quitCleanupTimeout))s 硬顶）")
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.supervisor?.stop()
            DispatchQueue.main.async { self?.replyTerminate(true) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.quitCleanupTimeout) { [weak self] in
            guard let self, self.awaitingTerminateReply else { return }
            print("[poc] 退出清理超时，强制放行退出（可能有子进程残留）")
            self.replyTerminate(true)
        }
        return true
    }

    /// `reply(toApplicationShouldTerminate:)` 恰一次（每轮 .terminateLater）。
    private func replyTerminate(_ proceed: Bool) {
        guard awaitingTerminateReply else { return }
        awaitingTerminateReply = false
        NSApp.reply(toApplicationShouldTerminate: proceed)
    }

    /// 恢复主窗口（取消退出 / 决策失败时的恢复入口）。
    private func restoreMainWindow() {
        guard let controller = mainWindowController, let window = controller.window else { return }
        window.makeKeyAndOrderFront(nil)
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    /// 请求 core 决策（`__host.quitFacts`；见 node-edges.ts projectQuitFacts）。
    /// macOS Dock 恒为恢复入口 → recoveryAvailable 恒 true（design 14 D1）。
    /// 超时/失败 → nil（调用方按「可能有本地保护内容」分支诚实处理）。
    private func requestQuitFacts(quitRequested: Bool, completion: @escaping (QuitFacts?) -> Void) {
        guard let bridge else {
            completion(nil)
            return
        }
        // 单次完成守卫：Task{@MainActor} 与 main.asyncAfter 同在主线程队列，
        // 先到者胜（Swift 5 模式下闭包捕获可变局部量，无并发写）。
        var finished = false
        let finish: (QuitFacts?) -> Void = { [weak self] facts in
            guard !finished else { return }
            finished = true
            // S3·V9：成功取到的事实留作缓存，供下一次关窗决策即时使用。
            if let facts { self?.cachedQuitFacts = facts }
            completion(facts)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.quitFactsTimeout) {
            if !finished {
                print("[poc] quitFacts 请求超时（\(Self.quitFactsTimeout)s）——按不可得处理")
            }
            finish(nil)
        }
        Task { @MainActor in
            do {
                let result = try await bridge.invoke(
                    method: HostInboundMethod.quitFacts,
                    payload: .object([
                        "quitRequested": .bool(quitRequested),
                        "recoveryAvailable": .bool(true),
                    ]))
                finish(QuitFacts.decode(result))
            } catch {
                print("[poc] quitFacts 请求失败：\(error.localizedDescription)")
                finish(nil)
            }
        }
    }

    // MARK: - 深链与 fatal 辅助

    /// sidecar ready：置位深链转发并按序补发冷启动缓冲。
    private func handleSidecarReady() {
        // 三审 #8：新 sidecar 没有历史事实——清空去重簿记并推全量快照，
        // 否则重启后它长期以「种子事实」运行。
        mainWindowController?.resetHostFactsBookkeeping()
        let flushed = deepLinks.markReady()
        if flushed > 0 {
            print("[poc] ready 后补发深链 \(flushed) 条")
        }
        if deepLinks.droppedCount > 0 {
            print("[poc] 深链缓冲溢出丢弃 \(deepLinks.droppedCount) 条（core 侧队列另有有界语义）")
        }
    }

    /// 深链转交 sidecar（fire-and-forget；失败 loud——core 侧队列不因单条
    /// 失败而阻塞，用户可见动作绝不静默丢弃）。
    private func sendDeepLink(_ raw: String) {
        guard let bridge else { return }
        // S4·F3（2026-12 双端逐函数核对）：退出在途时不再投递深链——bridge 只会以
        // app_quitting 拒绝并 loud，用户动作在这条路径上注定丢失；直接记账跳过。
        if quitGate.isConfirmed {
            print("[poc] 退出在途：深链不再投递（\(raw)）")
            return
        }
        Task { @MainActor in
            do {
                _ = try await bridge.invoke(
                    method: HostInboundMethod.deepLink,
                    payload: .object(["url": .string(raw)]))
            } catch {
                print("[poc] 深链转交失败（\(raw)）：\(error.localizedDescription)")
            }
        }
    }

    /// fatal 分流（Supervisor 不可恢复：锁冲突 / 重启耗尽 / spawn 失败）——
    /// 与 Electron 对齐（main.ts:246-266 fatal = 弹框后 app.exit(1)，2026-12 双端逐
    /// 函数核对 S2·F2）：呈现致命提示后**终止进程**，绝不留一个对着死桥的窗口
    /// （所有 invoke 恒 code 2 的僵尸 UI）。
    ///
    /// 呈现语义（2026-09 GUI 验收修正）：
    /// - **单次呈现门**：同一 fatal 会同时走 Supervisor.onFatal 与本类的
    ///   `fatalStartup`（锁冲突实测连弹两个文案相同的框）——首个呈现后其余丢弃；
    /// - **非阻塞**：有可见窗口时用 sheet（`beginSheetModal`），主线程继续服务
    ///   其余 edge 腿；无窗口才退回 `runModal`（此前恒 `runModal`，与「非阻塞」
    ///   注释不符，且会占用主线程导致 UI 腿 `main-thread-busy`）。
    private static var fatalAlertShown = false

    private static func presentFatalAlert(_ message: String) {
        guard !fatalAlertShown else { return }
        fatalAlertShown = true
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "dsh-chamber sidecar 异常"
        alert.informativeText = message
        if let window = NSApp.windows.first(where: { $0.isVisible }) {
            alert.beginSheetModal(for: window) { _ in exit(1) }
        } else {
            alert.runModal()
            exit(1)
        }
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

    /// 致命启动错误：stderr 一行（无 GUI 可验证）+ 弹窗提示后退出。
    /// 与 `presentFatalAlert` 共用单次呈现门：同一 fatal 已呈现（如 Supervisor
    /// 的锁冲突分流）时不再弹第二个框，但仍按致命路径退出。
    /// 二次启动深链转发通知名（S5·F9；本壳私有，Electron 的 second-instance
    /// 事件对偶）。
    static let secondaryDeepLinkNotification = Notification.Name("com.dshchamber.native.deep-link")

    /// 把 secondary 实例 argv 里的深链交给已运行实例（返回转发条数）。
    /// 只转发本 scheme 的参数（与 S4·F1 同一筛选），不重试、不阻塞。
    static func forwardDeepLinksToRunningInstance(arguments: [String]) -> Int {
        let urls = commandLineDeepLinks(arguments: arguments)
        guard !urls.isEmpty else { return 0 }
        for url in urls {
            DistributedNotificationCenter.default().postNotificationName(
                secondaryDeepLinkNotification, object: url, userInfo: nil, deliverImmediately: true)
        }
        print("[poc] 已向运行中实例转发 \(urls.count) 条深链（S5·F9）")
        return urls.count
    }

    /// 已运行的**同 bundle** 实例：激活其全部窗口并返回 true；没有则 false。
    /// 只用 bundle id 判定，绝不按进程名猜（Electron flavor 的 bundle id 不同，
    /// 因此不会被误激活）。
    static func activateExistingInstance() -> Bool {
        guard let bundleID = Bundle.main.bundleIdentifier else { return false }
        let me = ProcessInfo.processInfo.processIdentifier
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .filter { $0.processIdentifier != me && !$0.isTerminated }
        guard let other = others.first else { return false }
        print("[poc] 已有本壳实例（pid=\(other.processIdentifier)）：激活并安静退出（S4·F4）")
        other.activate(options: [.activateAllWindows])
        return true
    }

    private func fatalStartup(_ message: String) -> Never {
        fputs("[poc] 致命错误：\(message)\n", stderr)
        if !Self.fatalAlertShown {
            Self.fatalAlertShown = true
            let alert = NSAlert()
            alert.alertStyle = .critical
            alert.messageText = "dsh-chamber 启动失败"
            alert.informativeText = message
            alert.runModal()
        }
        exit(1)
    }

    /// 最小主菜单：App（退出）+ 编辑（WebKit 快捷键路由）+ 窗口
    /// （S13：performClose/performMiniaturize，恢复 Cmd+W/Cmd+M——Electron
    /// 默认 macOS Window 菜单对偶，design E3）。抽为静态纯函数便于单测断言
    /// selector（构造 NSMenu 无需 NSApp.run）。
    static func makeMainMenu() -> NSMenu {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        // App 菜单补齐 macOS 标准项（Electron 未自定义 setApplicationMenu，即系统默认
        // 菜单；2026-12 双端逐函数核对 V5/U4 的功能对齐）。
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 dsh-chamber",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                        keyEquivalent: "")
        // 「检查更新…」的 macOS 标准位置（About 之后）。2026-12 裁决 D-1 选 B：
        // 原生壳的安装腿由 Sparkle 承担；未配置 feed/公钥（dev、dry-run）时禁用，
        // 绝不假装能更新。
        let checkForUpdates = NSMenuItem(title: "检查更新…",
                                         action: #selector(AppUpdater.checkForUpdates(_:)),
                                         keyEquivalent: "")
        checkForUpdates.target = AppUpdater.shared
        checkForUpdates.isEnabled = AppUpdater.shared.isAvailable
        appMenu.addItem(checkForUpdates)
        appMenu.addItem(.separator())
        let servicesItem = NSMenuItem(title: "服务", action: nil, keyEquivalent: "")
        servicesItem.submenu = NSMenu(title: "服务")
        appMenu.addItem(servicesItem)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 dsh-chamber",
                        action: #selector(NSApplication.hide(_:)),
                        keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "隐藏其他",
                                         action: #selector(NSApplication.hideOtherApplications(_:)),
                                         keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "显示全部",
                        action: #selector(NSApplication.unhideAllApplications(_:)),
                        keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 dsh-chamber",
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

        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化",
                           action: #selector(NSWindow.performMiniaturize(_:)),
                           keyEquivalent: "m")
        windowMenu.addItem(withTitle: "关闭",
                           action: #selector(NSWindow.performClose(_:)),
                           keyEquivalent: "w")
        windowMenu.addItem(withTitle: "缩放",
                           action: #selector(NSWindow.performZoom(_:)),
                           keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "前置全部窗口",
                           action: #selector(NSApplication.arrangeInFront(_:)),
                           keyEquivalent: "")
        windowMenuItem.submenu = windowMenu
        mainMenu.setSubmenu(windowMenu, for: windowMenuItem)

        return mainMenu
    }

    private func installMainMenu() {
        let menu = Self.makeMainMenu()
        NSApp.mainMenu = menu
        NSApp.windowsMenu = menu.items.first { $0.submenu?.title == "窗口" }?.submenu
        NSApp.servicesMenu = menu.items
            .compactMap({ $0.submenu })
            .flatMap({ $0.items })
            .first(where: { $0.title == "服务" })?.submenu
    }

    /// SIGTERM/SIGINT → NSApp.terminate（走 applicationShouldTerminate 的三分支与
    /// 清理链，绝不绕过退出确认/清理）。先 SIG_IGN 再交给 DispatchSource 是标准做法。
    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler {
                print("[poc] 收到信号 \(sig)：转入标准退出链")
                NSApp.terminate(nil)
            }
            source.resume()
            signalSources.append(source)
        }
    }

    /// argv 冷启动深链：跳过 argv[0] 与非本 scheme 的参数。归一化/去重/排队由 core 的
    /// enqueueDeepLink 负责，本层与 application(_:open:) 共用同一条缓冲（只做不丢）。
    private func enqueueCommandLineDeepLinks() {
        for raw in Self.commandLineDeepLinks(arguments: CommandLine.arguments) {
            print("[poc] 命令行深链 \(raw)")
            deepLinks.enqueue(raw)
        }
    }

    /// argv 深链筛选（纯函数，单测直测）：跳过 argv[0]，只留本 scheme 的参数。
    static func commandLineDeepLinks(arguments: [String]) -> [String] {
        // 前缀与 Electron 对齐（shell-core.ts 的 startsWith('dsh-chamber://')）：
        // 只收完整 scheme 形态，裸 "dsh-chamber:foo" 不再入队（2026-12 审查 nit）。
        arguments.dropFirst().filter { $0.hasPrefix(deepLinkScheme + "//") }
    }

    /// 托盘（Electron Tray 对偶）：状态栏图标 +「显示窗口 / 退出」。关窗隐藏后这是与
    /// Dock 并列的恢复入口（2026-12 双端逐函数核对 V4/U3）。
    private func installStatusItem() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            let icon = NSApp.applicationIconImage
            icon?.size = NSSize(width: 18, height: 18)
            button.image = icon
            button.toolTip = "dsh-chamber"
        }
        let menu = NSMenu()
        let show = NSMenuItem(title: "显示窗口",
                              action: #selector(showMainWindowFromStatusItem(_:)),
                              keyEquivalent: "")
        show.target = self
        menu.addItem(show)
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出 dsh-chamber",
                     action: #selector(NSApplication.terminate(_:)),
                     keyEquivalent: "")
        item.menu = menu
        statusItem = item
    }

    @objc private func showMainWindowFromStatusItem(_ sender: Any?) {
        mainWindowController?.showWindow(nil)
        mainWindowController?.window?.makeKeyAndOrderFront(nil)
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    /// sidecar 缺失的精确 fatal 文案（S3；纯函数单测直测）。explicitPath 非 nil
    /// = POC_SIDECAR 显式指向但文件不存在（绝不 spawn 一个脚本缺失的 node）。
    static func missingSidecarMessage(isPackaged: Bool, resourcesDir: String?,
                                      explicitPath: String? = nil) -> String {
        if let explicitPath, !explicitPath.isEmpty {
            return "POC_SIDECAR 指向的 sidecar 脚本不存在：\(explicitPath)"
        }
        if isPackaged {
            let expected = resourcesDir.map { PackagedLayout.sidecarScript(resourcesDir: $0) }
                ?? "<Resources>/sidecar/sidecar.js（Bundle.main.resourceURL 缺失）"
            return "装配态缺少 sidecar 脚本：\(expected)（POC_SIDECAR 可显式指定）"
        }
        return "dev 态未找到 sidecar 脚本：POC_SIDECAR 未设，且自 "
            + "\(FileManager.default.currentDirectoryPath) 向上 6 层未找到 \(sidecarRelativePath)"
    }

    /// 端口来源日志标签（S11；纯函数单测直测）。
    static func portSourceLabel(_ source: ControlPlanePort.Source) -> String {
        switch source {
        case .envPOC: return "POC_PORT 显式覆盖"
        case .envDSH: return "DSH_CHAMBER_CP_PORT 显式覆盖"
        case .packagedDefault: return "打包默认"
        case .devProbe: return "dev 自动退避（17520 起，首个空闲端口）"
        case .devDefault: return "dev 默认（自定义 sidecar 形状，不探测）"
        }
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
    /// chamber-edge-<壳进程纪年>.<壳内序号>.<notificationId>（SwiftEdgeHostLegs
    /// 调度时命名；**末段才是 sidecar 的 notificationId**，按 `.` 末段解析）。
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
        // 末段 = sidecar 的 notificationId（前两段是壳进程纪年与壳内单调序号；
        // 2026-12 第四轮验证：按首段解析会把纪年当 id，几乎总是回灌失败）。
        guard identifier.hasPrefix("chamber-edge-"),
              let rawID = identifier.split(separator: ".").last,
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
                    method: HostInboundMethod.notifyClicked,
                    payload: .object(["notificationId": .number(Double(notificationId))])
                )
                print("[poc] 通知 click 回灌应答：\(String(describing: outcome))")
            } catch {
                print("[poc] 通知 click 回灌失败：\(error.localizedDescription)")
            }
        }
    }
}
