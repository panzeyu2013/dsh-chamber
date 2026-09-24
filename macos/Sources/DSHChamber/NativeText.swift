//
//  NativeText.swift
//  DSHChamber
//
//  native-shell 本地化席位（macOS 原生壳用户可见文案的键表与取值面）。
//
//  设计要点（与方案一致）：
//   - 键名 = NativeTextKey.rawValue（点分命名空间），按同一张表写
//     Resources/<lang>.lproj/Localizable.strings（zh-Hans / en），键名逐字一致；
//   - 取值顺序：Bundle.main（.app 的 Contents/Resources）→ SwiftPM 资源包
//     （dev swift run / swift test 的 DSHChamber_DSHChamber.bundle，native 扁平
//     与 swiftbuild Contents/Resources 两种形态都查）→ rawValue（键名兜底，
//     资源缺失时页面/菜单会显示点键名而不是谎报翻译）；
//   - 页面语言与系统语言不一致时由 ShellLanguagePolicy 给出 AppleLanguages
//     覆盖值，本文件只负责按当前 bundle 偏好语言取值。
//
//  Key → 使用点：
//   sidecar.lockBusy / sidecar.checkConfig / sidecar.startupExit /
//   sidecar.portInUseSuffix / sidecar.portInUseNoAddress /
//   sidecar.detailSuffix / sidecar.hintSuffix / sidecar.genericSuffix
//     → SidecarStartupFailure（端口占用提示、笼统建议、启动失败模板与标点后缀）
//   supervisor.startupExit / supervisor.startFailure / supervisor.lockBusy /
//   supervisor.crashLoop / supervisor.lifecycleDeferred → SidecarSupervisor（fatal 文案）
//   lock.heldByAnotherProcess / lock.ioFailure / lock.pidUnknown /
//   lock.mkdirFailed / lock.openFailed / lock.notRegularFile /
//   lock.ownerUnexpected / lock.shortWrite / lock.encodeFailed
//     → SidecarDirectoryLock.LockError（目录锁 fatal 描述与 I/O 明细）
//   bridge.lifecycleBusy / bridge.alreadyRunning / bridge.invokeFailed /
//   bridge.pendingAborted / bridge.pendingProcessExited / bridge.stdoutResync /
//   bridge.frameTooLarge / bridge.writeFailed / bridge.responseWithoutError
//     → BridgeClient（生命周期过渡、进程状态、未决请求作废与写帧/违约兜底）
//   frame.tooLarge / frame.responseMissingError → FrameCodec
//     （FrameCodecError.errorDescription：%d 分别为字节上限/实际字节与帧 id）
//   bridge.errorFallback →（当前无代码引用：错误文案走 AnyCodable 字面量
//     出口，恒可序列化）——键表冻结，保留待下一次键表评审再决定删表
//   resources.explicitNodeMissing / resources.packagedNodeMissing /
//   resources.pathNodeMissing → ChamberResources.PathResolutionError（node 解析 fatal）
//   updater.feedMustBeHTTPS / updater.publicKeyInvalid → AppUpdater
//     （装配期配置形状非法；native-updater-misconfigured: 前缀由调用方拼）
//   quit.confirmDetail / quit.reasonsSeparator / quit.unavailable* /
//   quit.waitButton / quit.forceButton → QuitCoordinator（确认正文、不可得框）
//   renderer.crashTitle / renderer.crashDetail → MainWindowController（恢复放弃弹窗）
//   failure.title / failure.heading / failure.cpLabel / failure.sidecarLabel /
//   failure.retryExhausted / failure.shimMissing / failure.probe*
//     → MainWindowController 失败说明页与探测诊断
//   panel.pluginSourceTitle / panel.pluginSourcePrompt / common.ok
//     → SwiftEdgeHostLegs（插件源面板、showMessage 缺省按钮）
//   panel.openFileTitle / panel.openFileOrDirectoryTitle / panel.openFilePrompt
//     → FileOpenPanel（SystemFileOpenPanelPresenter 的 NSOpenPanel 标题与确认
//     按钮；目录请求用 *OrDirectoryTitle）
//   common.listSeparator → AppDelegate（fatal.hostPackagesMissing 的 missingHosts
//     清单）与 MainWindowController（failure.shimMissing 的 searched 目录清单）
//     各自 join 时取用（SwiftEdgeHostLegs 只取 common.ok，不用本键）
//   menu.* / tray.* / fatal.* / quit.confirmTitle / quit.confirmButton /
//   quit.cancelButton → AppDelegate（同一张键表共用）
//
import Foundation

/// 壳内建本地化键：rawValue 即 .strings 的键名（冻结键表，不得增删改名）。
public enum NativeTextKey: String, CaseIterable {
    case menuAboutApp = "menu.aboutApp"
    case menuCheckForUpdates = "menu.checkForUpdates"
    case menuServices = "menu.services"
    case menuHideApp = "menu.hideApp"
    case menuHideOthers = "menu.hideOthers"
    case menuShowAll = "menu.showAll"
    case menuQuitApp = "menu.quitApp"
    case menuFile = "menu.file"
    case menuCloseWindow = "menu.closeWindow"
    case menuEdit = "menu.edit"
    case menuUndo = "menu.undo"
    case menuRedo = "menu.redo"
    case menuCut = "menu.cut"
    case menuCopy = "menu.copy"
    case menuPaste = "menu.paste"
    case menuPasteAndMatchStyle = "menu.pasteAndMatchStyle"
    case menuDelete = "menu.delete"
    case menuSelectAll = "menu.selectAll"
    case menuSubstitutions = "menu.substitutions"
    case menuShowSubstitutions = "menu.showSubstitutions"
    case menuSmartQuotes = "menu.smartQuotes"
    case menuSmartDashes = "menu.smartDashes"
    case menuTextReplacement = "menu.textReplacement"
    case menuSpeech = "menu.speech"
    case menuStartSpeaking = "menu.startSpeaking"
    case menuStopSpeaking = "menu.stopSpeaking"
    case menuView = "menu.view"
    case menuReload = "menu.reload"
    case menuForceReload = "menu.forceReload"
    case menuZoomIn = "menu.zoomIn"
    case menuZoomOut = "menu.zoomOut"
    case menuActualSize = "menu.actualSize"
    case menuToggleFullScreen = "menu.toggleFullScreen"
    case menuWindow = "menu.window"
    case menuMinimize = "menu.minimize"
    case menuZoom = "menu.zoom"
    case menuBringAllToFront = "menu.bringAllToFront"
    case menuHelp = "menu.help"
    case menuAppHelp = "menu.appHelp"
    case trayShowWindow = "tray.showWindow"
    case trayQuitApp = "tray.quitApp"
    case quitConfirmTitle = "quit.confirmTitle"
    case quitConfirmDetail = "quit.confirmDetail"
    case quitReasonsSeparator = "quit.reasonsSeparator"
    case quitConfirmButton = "quit.confirmButton"
    case quitCancelButton = "quit.cancelButton"
    case quitUnavailableTitle = "quit.unavailableTitle"
    case quitUnavailableDetail = "quit.unavailableDetail"
    case quitWaitButton = "quit.waitButton"
    case quitForceButton = "quit.forceButton"
    case fatalStartupFailedTitle = "fatal.startupFailedTitle"
    case fatalSidecarAbnormalTitle = "fatal.sidecarAbnormalTitle"
    case fatalNodeResolveFailed = "fatal.nodeResolveFailed"
    case fatalSidecarScriptMissingExplicit = "fatal.sidecarScriptMissingExplicit"
    case fatalSidecarScriptMissingPackaged = "fatal.sidecarScriptMissingPackaged"
    case fatalSidecarScriptMissingDev = "fatal.sidecarScriptMissingDev"
    case fatalHostPackagesMissing = "fatal.hostPackagesMissing"
    case fatalHostPackagesMissingHint = "fatal.hostPackagesMissingHint"
    case fatalCpURLUnparsable = "fatal.cpURLUnparsable"
    case fatalCpURLUnderivable = "fatal.cpURLUnderivable"
    case fatalReadyPortMismatch = "fatal.readyPortMismatch"
    case fatalBridgeStartFailed = "fatal.bridgeStartFailed"
    case fatalSidecarStartFailedDetail = "fatal.sidecarStartFailedDetail"
    case rendererCrashTitle = "renderer.crashTitle"
    case rendererCrashDetail = "renderer.crashDetail"
    case rendererRecovering = "renderer.recovering"
    case sidecarLockBusy = "sidecar.lockBusy"
    case sidecarCheckConfig = "sidecar.checkConfig"
    case sidecarStartupExit = "sidecar.startupExit"
    case sidecarPortInUseSuffix = "sidecar.portInUseSuffix"
    case sidecarPortInUseNoAddress = "sidecar.portInUseNoAddress"
    case sidecarDetailSuffix = "sidecar.detailSuffix"
    case sidecarHintSuffix = "sidecar.hintSuffix"
    case sidecarGenericSuffix = "sidecar.genericSuffix"
    case supervisorStartupExit = "supervisor.startupExit"
    case supervisorStartFailure = "supervisor.startFailure"
    case supervisorLockBusy = "supervisor.lockBusy"
    case supervisorCrashLoop = "supervisor.crashLoop"
    case supervisorLifecycleDeferred = "supervisor.lifecycleDeferred"
    case lockHeldByAnotherProcess = "lock.heldByAnotherProcess"
    case lockIoFailure = "lock.ioFailure"
    case lockPidUnknown = "lock.pidUnknown"
    case lockMkdirFailed = "lock.mkdirFailed"
    case lockOpenFailed = "lock.openFailed"
    case lockNotRegularFile = "lock.notRegularFile"
    case lockOwnerUnexpected = "lock.ownerUnexpected"
    case lockShortWrite = "lock.shortWrite"
    case lockEncodeFailed = "lock.encodeFailed"
    case bridgeLifecycleBusy = "bridge.lifecycleBusy"
    case bridgeAlreadyRunning = "bridge.alreadyRunning"
    case bridgeInvokeFailed = "bridge.invokeFailed"
    case bridgePendingAborted = "bridge.pendingAborted"
    case bridgePendingProcessExited = "bridge.pendingProcessExited"
    case bridgeStdoutResync = "bridge.stdoutResync"
    case bridgeFrameTooLarge = "bridge.frameTooLarge"
    case bridgeWriteFailed = "bridge.writeFailed"
    case bridgeResponseWithoutError = "bridge.responseWithoutError"
    case resourcesExplicitNodeMissing = "resources.explicitNodeMissing"
    case resourcesPackagedNodeMissing = "resources.packagedNodeMissing"
    case resourcesPathNodeMissing = "resources.pathNodeMissing"
    case updaterFeedMustBeHTTPS = "updater.feedMustBeHTTPS"
    case updaterPublicKeyInvalid = "updater.publicKeyInvalid"
    case failureTitle = "failure.title"
    case failureHeading = "failure.heading"
    case failureCpLabel = "failure.cpLabel"
    case failureSidecarLabel = "failure.sidecarLabel"
    case failureRetryExhausted = "failure.retryExhausted"
    case failureShimMissing = "failure.shimMissing"
    case failureProbeFailed = "failure.probeFailed"
    case failureProbeHTTPStatus = "failure.probeHTTPStatus"
    case failureProbeNoResponse = "failure.probeNoResponse"
    case failureProbeNSURLError = "failure.probeNSURLError"
    case panelPluginSourceTitle = "panel.pluginSourceTitle"
    case panelPluginSourcePrompt = "panel.pluginSourcePrompt"
    case commonOk = "common.ok"
    case commonListSeparator = "common.listSeparator"
    case panelOpenFileTitle = "panel.openFileTitle"
    case panelOpenFileOrDirectoryTitle = "panel.openFileOrDirectoryTitle"
    case panelOpenFilePrompt = "panel.openFilePrompt"
    case bridgeErrorFallback = "bridge.errorFallback"
    case frameTooLarge = "frame.tooLarge"
    case frameResponseMissingError = "frame.responseMissingError"
}

/// 壳内建本地化取值面。
public enum NativeText {

    /// 缺值哨兵：Bundle.localizedString 在缺键时原样返回 value 参数，故用
    /// 不可能出现在 .strings 里的 NUL 前缀串区分「缺键」与「翻译值恰好为空」。
    private static let missingValue = "\u{0}__dsh-chamber-native-text-missing__"

    /// 取一条本地化文案；语言覆盖包 → Bundle.main → SwiftPM 资源包 → rawValue（键名）。
    public static func string(_ key: NativeTextKey) -> String {
        if let bundle = currentLanguageOverrideBundle(), let value = lookup(key, in: bundle) {
            return value
        }
        for bundle in cachedCandidateBundles {
            if let value = lookup(key, in: bundle) { return value }
        }
        return key.rawValue
    }

    /// 运行期语言覆盖：页面事实驱动，nil = 跟随进程/bundle 解析。
    ///
    /// 为什么需要它：CFBundle 的 preferredLocalizations 在
    /// **进程启动期**解析并缓存，只改本 app 域的 `AppleLanguages`（进程级杠杆）不会让
    /// 运行期取串换语言。要让壳自建文案（菜单/托盘/对话框/失败页）随页面语言**即时**
    /// 跟随，必须显式加载目标语言的 `.lproj` 并优先从它取值；进程级面（系统框架、
    /// WebKit 右键菜单、Sparkle 标准窗）仍只能下次启动生效。
    /// 线程纪律：该静态状态由 `languageOverrideLock`
    /// 保护——写入在主线程（菜单构造与 AppDelegate 的事实回调），但读取可能发生在
    /// BridgeClient 的 readabilityHandler/terminationHandler 线程：
    /// `NativeText.string/format` 会经 SidecarSupervisor 的 markFatal 等 fatal
    /// 文案路径被那些线程调用，所以这里**不是**"只在主线程读写"。
    private static let languageOverrideLock = NSLock()
    private static var languageOverrideBundleStorage: Bundle?

    /// 锁内读取当前覆盖包快照（Bundle 本身不可变，取到引用即可安全使用）。
    private static func currentLanguageOverrideBundle() -> Bundle? {
        languageOverrideLock.lock()
        defer { languageOverrideLock.unlock() }
        return languageOverrideBundleStorage
    }

    /// 设置/清除运行期语言覆盖（锁内写；读侧配对 `currentLanguageOverrideBundle`）。
    /// - Returns: 是否解析到目标语言的资源包；false = 资源缺失（回落原链），
    ///   绝不假装翻译成功。
    @discardableResult
    public static func setLanguageOverride(_ language: ShellPageLanguage?) -> Bool {
        guard let language else {
            languageOverrideLock.lock()
            languageOverrideBundleStorage = nil
            languageOverrideLock.unlock()
            return true
        }
        let bundle = localizationBundle(for: language)
        languageOverrideLock.lock()
        languageOverrideBundleStorage = bundle
        languageOverrideLock.unlock()
        return bundle != nil
    }

    /// 目标语言的 `.lproj`（打包态 Contents/Resources 与 dev/test 的 SwiftPM
    /// 资源包两种形态都查）。目录名不硬编码：唯一入口 =
    /// ShellPageLanguage.localizationIdentifier（与 Info.plist 的
    /// CFBundleLocalizations 同源，zh → zh-Hans）。
    private static func localizationBundle(for language: ShellPageLanguage) -> Bundle? {
        let identifier = language.localizationIdentifier
        for root in cachedCandidateBundles {
            if let path = root.path(forResource: identifier, ofType: "lproj"),
               let bundle = Bundle(path: path) {
                return bundle
            }
            // `path(forResource:)` 大小写敏感，而 native 后端的 SwiftPM 会把目录名
            // 整段小写（实测 `zh-hans.lproj`；swiftbuild 后端是 `zh-Hans.lproj`）
            // ⇒ 再按文件系统枚举做大小写不敏感匹配，并按主语言子标签族内回退。
            if let bundle = localizedDirectoryBundle(in: root, matching: identifier) {
                return bundle
            }
        }
        return nil
    }

    /// 在一个 bundle 的资源根目录里按 identifier 找目标语言 `.lproj`。
    /// 根覆盖两种后端形态（扁平包自身 / `Contents/Resources`），先做大小写不敏感
    /// 的全名匹配，再按主语言子标签回退（`zh-Hans` 命中 `zh` / `zh-CN` 等命名）。
    private static func localizedDirectoryBundle(in bundle: Bundle, matching identifier: String) -> Bundle? {
        var roots: [String] = []
        func addRoot(_ path: String?) {
            guard let path, !roots.contains(path) else { return }
            roots.append(path)
        }
        addRoot(bundle.bundlePath)
        addRoot(bundle.resourceURL?.path)
        addRoot(bundle.bundlePath + "/Contents/Resources")

        let wanted = normalizedLocalizationName(identifier)
        let primary = wanted.split(separator: "-").first.map(String.init) ?? wanted
        for root in roots {
            guard let entries = try? FileManager.default.contentsOfDirectory(atPath: root) else { continue }
            let candidates = entries
                .filter { $0.lowercased().hasSuffix(".lproj") }
                .map { (entry: $0, name: normalizedLocalizationName(String($0.dropLast(6)))) }
            let match = candidates.first { $0.name == wanted }
                ?? candidates.first { $0.name.split(separator: "-").first.map(String.init) == primary }
            if let match, let bundle = Bundle(path: root + "/" + match.entry) {
                return bundle
            }
        }
        return nil
    }

    /// `.lproj` 目录名归一：小写、`_` → `-`（CFBundle 对 `zh_CN` 的兼容拼写）。
    private static func normalizedLocalizationName(_ name: String) -> String {
        name.lowercased().replacingOccurrences(of: "_", with: "-")
    }

    /// 取一条本地化文案并按 printf 规则填参（占位符契约写在各调用点注释里）。
    public static func format(_ key: NativeTextKey, _ args: CVarArg...) -> String {
        String(format: string(key), arguments: args)
    }

    /// Bundle(for:) 锚点：swift test 下 Bundle.main 可能是 xctest 工具进程本身
    /// （工具链/usr/bin），而本类所在镜像所属的 *.xctest bundle 才是携带
    /// SwiftPM 资源包的容器（Bundle(for:) 按镜像路径反查）。
    private final class BundleToken {}

    /// 候选 bundle（保序、去重）：主 bundle 与模块镜像 bundle 优先，其次所有
    /// 候选根目录下的 SwiftPM 资源包（DSHChamber_DSHChamber.bundle 的
    /// native 扁平形态与 swiftbuild Contents/Resources 形态）。
    ///
    /// 资源包定位**不**用 Bundle.module（装配态 .app 的 Bundle.main.bundleURL
    /// 是 .app 根，Bundle.module 的候选面覆盖不到 Contents/Resources；且其
    /// 找不到资源时会 fatalError）——与 ChamberResources 同一纪律。
    /// 候选 bundle 列表（进程内固定：Bundle.main / 镜像 bundle / 资源包路径都在
    /// 启动期就位）——**只解析一次**。实测（swiftc -O，10k 次 string(.menuFile)）：
    /// 每次重算 ≈70.9µs（其中 `exists + Bundle(url:)` 占 84%），缓存后 ≈0.5µs；
    /// 43 个菜单项取串从 ≈2.6ms 降到 ≈0.02ms。不缓存的唯一好处是"运行期凭空出现
    /// 资源包也能被发现"，而签名 .app 与构建产物都不存在这种路径。
    private static let cachedCandidateBundles: [Bundle] = candidateBundles()

    private static func candidateBundles() -> [Bundle] {
        var bundles: [Bundle] = []
        var seenBundles = Set<String>()
        func append(_ bundle: Bundle?) {
            guard let bundle, seenBundles.insert(bundle.bundlePath).inserted else { return }
            bundles.append(bundle)
        }
        append(Bundle.main)
        append(Bundle(for: BundleToken.self))

        var bases: [URL] = []
        var seenBases = Set<String>()
        func addBase(_ url: URL?) {
            guard let url, seenBases.insert(url.path).inserted else { return }
            bases.append(url)
        }
        // 每个已识别 bundle 的 resourceURL/bundleURL 下都可能嵌着资源包
        // （swift test：DSHChamberTests.xctest/Contents/Resources/…）。
        for bundle in bundles {
            addBase(bundle.resourceURL)
            addBase(bundle.bundleURL)
            // 构建产物目录：native 后端（旧工具链的默认，CI runner 走这条）把资源包
            // 放在 `*.xctest` 的**同级**目录（`.build/<triple>/release/DSHChamber_DSHChamber.bundle`），
            // 而 swiftbuild 后端（Swift 6.4+）把它嵌进 `*.xctest/Contents/Resources`。
            // 只加 bundleURL 自身会让 native 形态在 `swift test` 下整个解析不到资源
            // （断言真实文案的用例回落键名）。
            addBase(bundle.bundleURL.deletingLastPathComponent())
        }
        for base in ChamberResources.searchBases() { addBase(base) }
        if let executable = Bundle.main.executableURL {
            let dir = executable.deletingLastPathComponent()
            addBase(dir)
            addBase(dir.deletingLastPathComponent())
        }
        for base in bases {
            let root = base.appendingPathComponent(ChamberResources.bundleName)
            let candidates = [
                root,
                root.appendingPathComponent("Contents").appendingPathComponent("Resources"),
            ]
            for candidate in candidates
            where FileManager.default.fileExists(atPath: candidate.path) {
                append(Bundle(url: candidate))
            }
        }
        return bundles
    }

    /// 单个 bundle 内按「Localizable.strings」表取值；缺键 → nil。
    private static func lookup(_ key: NativeTextKey, in bundle: Bundle) -> String? {
        let value = bundle.localizedString(forKey: key.rawValue,
                                           value: missingValue,
                                           table: nil)
        return value == missingValue ? nil : value
    }
}
