import AppKit

/**
 * 启动失败恢复（C4 启动与修复；升级计划 §12.10 的 Swift 半边）。
 *
 * 与主进程 `startup-error.ts` 的三选恢复同构：致命启动失败（或运行期 fatal）
 * 不再单键呈现后静默 exit(1)，而是给用户三选——退出 / 重启 / 安全模式重启——
 * 默认高亮与 Return/小键盘 Enter/Esc 都落**安全项**（三选 = 第三键，两选 = 重启）；
 * 呈现后进程去向只由用户选择决定。锁冲突（「已在运行」）用两选：安全模式重启救不了
 * 锁冲突（另一实例仍持锁）。
 *
 * 文案源 = 本仓的 `NativeText`（`ShellLocale`/`ShellStrings` 按 design 25 §5.1 不取件）。
 * 安全模式 env 名与 TS 侧 `SAFE_MODE_ENV`、控制面 `safe-mode.ts` 同一字面量。
 */
extension AppDelegate {
    /// 恢复框的选项集（锁冲突两选，其余致命三选）。
    enum RecoveryChoices: Equatable {
        case threeWay
        case twoWay
    }

    /// 恢复框所属阶段：启动期（通常无可用窗口，app-modal）/ 运行期（优先 sheet）。
    enum RecoveryPhase: Equatable {
        case startup
        case runtime

        /// 恢复框标题（复用既有 fatal 文案键，前缀 = 可见应用名）。
        var titleText: String {
            switch self {
            case .startup: return NativeText.format(.fatalStartupFailedTitle, MainWindowController.displayName)
            case .runtime: return NativeText.format(.fatalSidecarAbnormalTitle, MainWindowController.displayName)
            }
        }

        /// 恢复选择那一行的日志标签。
        var logLabel: String {
            switch self {
            case .startup: return "启动"
            case .runtime: return "运行期"
            }
        }
    }

    /// 启动失败恢复动作：退出 / 重启 / 安全模式重启。
    enum StartupRecoveryAction: Equatable {
        case exit
        case restart
        case safeModeRestart
    }

    /// 安全模式 env 名（与 TS 侧 `SAFE_MODE_ENV`、控制面 `safe-mode.ts` 同一字面量）。
    static var safeModeEnvironmentKey: String { "DSH_CHAMBER_SAFE_MODE" }

    /// 安全模式是否生效（只认 "1"，与既有 DSH_CHAMBER_* 开关同契约）。
    static func isSafeModeEnabled(environment: [String: String]) -> Bool {
        environment[safeModeEnvironmentKey] == "1"
    }

    /// S-43 按键纪律：Return（36）/小键盘 Enter（76）/Esc（53）都命中安全项。
    static func startupRecoveryKeyIsSafe(keyCode: UInt16) -> Bool {
        keyCode == 36 || keyCode == 76 || keyCode == 53
    }

    /// 安全项下标（退出=0 / 重启=1 / 安全模式重启=2）——绝不散成魔法数。
    static var recoverySafeButtonIndex: Int { 2 }

    /// 对话框响应 → 动作：未知响应同样落安全项（绝不静默退出）。
    static func startupRecoveryAction(for response: NSApplication.ModalResponse,
                                      choices: RecoveryChoices = .threeWay) -> StartupRecoveryAction {
        if choices == .twoWay { return response == .alertFirstButtonReturn ? .exit : .restart }
        switch response {
        case .alertFirstButtonReturn: return .exit
        case .alertSecondButtonReturn: return .restart
        default: return .safeModeRestart
        }
    }

    /// 恢复框（纯构造，便于用例断言按钮序与默认键）：AppKit 会给首个按钮自动挂
    /// "\r"，显式清掉——蓝色默认高亮与 Enter 都只落安全项。
    static func makeStartupRecoveryAlert(message: String,
                                         phase: RecoveryPhase = .startup,
                                         choices: RecoveryChoices = .threeWay) -> NSAlert {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = phase.titleText
        alert.informativeText = message
        let exitButton = alert.addButton(withTitle: NativeText.string(.recoveryExitButton))
        exitButton.keyEquivalent = ""
        let restartButton = alert.addButton(withTitle: NativeText.string(.recoveryRestartButton))
        restartButton.keyEquivalent = choices == .twoWay ? "\r" : ""
        guard choices == .threeWay else { return alert }
        let safeButton = alert.addButton(withTitle: NativeText.string(.recoverySafeModeRestartButton))
        safeButton.keyEquivalent = "\r"
        return alert
    }

    /// 模态呈现（与退出确认同款本地 keyDown 监视器）：安全键映射到安全项按钮并吞掉事件。
    static func runStartupRecoveryAlert(_ alert: NSAlert) -> NSApplication.ModalResponse {
        let safeResponse: NSApplication.ModalResponse = alert.buttons.count >= 3
            ? .alertThirdButtonReturn
            : .alertSecondButtonReturn
        let monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard Self.startupRecoveryKeyIsSafe(keyCode: event.keyCode) else { return event }
            NSApplication.shared.stopModal(withCode: safeResponse)
            return nil
        }
        defer { if let monitor { NSEvent.removeMonitor(monitor) } }
        return alert.runModal()
    }

    /// 运行期呈现：有可见窗口用 sheet（非阻塞），否则退回同一 app-modal 监视器。
    /// 两种呈现都是完整三选，没有单键降级分支。
    static func runRuntimeRecoveryAlert(_ alert: NSAlert) -> NSApplication.ModalResponse {
        guard let window = NSApp.windows.first(where: { $0.isVisible }) else {
            return Self.runStartupRecoveryAlert(alert)
        }
        let monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard Self.startupRecoveryKeyIsSafe(keyCode: event.keyCode) else { return event }
            alert.buttons[Self.recoverySafeButtonIndex].performClick(nil)
            return nil
        }
        defer { if let monitor { NSEvent.removeMonitor(monitor) } }
        alert.beginSheetModal(for: window) { response in
            NSApplication.shared.stopModal(withCode: response)
        }
        return NSApplication.shared.runModal(for: alert.window)
    }

    /// 单次呈现门：首个进入者呈现，其余只 loud 记录（绝不自行 exit）。
    final class RecoveryPresentationGate {
        static let shared = RecoveryPresentationGate()
        private let lock = NSLock()
        private var claimed = false

        /// 抢单次呈现权；false = 已有呈现者。
        func claim() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            if claimed { return false }
            claimed = true
            return true
        }
    }

    /// 所有致命入口的统一封装：claim → present。claim 失败只 loud 记录并返回 false。
    @discardableResult
    static func enterRecoveryPresentation(message: String,
                                          gate: RecoveryPresentationGate = .shared,
                                          log: (String) -> Void = { shellLog($0) },
                                          present: () -> Void) -> Bool {
        guard gate.claim() else {
            log("[shell] 重复致命事件（恢复框已在呈现/已决策）：只记录，不二次进入 —— \(message)")
            return false
        }
        present()
        return true
    }

    /// spawn 失败的启动 fatal 之前必须先回收局部 supervisor（幂等 stop()：停受管
    /// 进程并释放 flock），再交给 fatal 分流——绝不带锁弹框。
    static func recoverFailedStartup(supervisor: SidecarSupervisor,
                                     stop: (SidecarSupervisor) -> Void = { $0.stop() },
                                     presentFatal: () -> Void) {
        stop(supervisor)
        shellLog("[shell] 启动失败：已先停 supervisor（进程回收、目录锁释放）再进入 fatal 分流")
        presentFatal()
    }

    /// 恢复重启的清理判据：nil 的诚实含义 = 本进程未创建 supervisor（无锁可取）。
    static func canRelaunchAfterCleanup(supervisorState: SidecarSupervisor.State?) -> Bool {
        supervisorState == nil || supervisorState == .stopped
    }

    /// 清理完成/不成立的 loud 文案：把「未取过锁」与「已 stopped（锁已释放）」显式分开。
    static func recoveryCleanupSummary(supervisorState: SidecarSupervisor.State?,
                                       lockRecordPath: String = "") -> String {
        guard let supervisorState else {
            return "[shell] 清理完成：本进程未创建 supervisor（自定义 sidecar 形状，未取过目录锁）——直接重启"
        }
        switch supervisorState {
        case .stopped:
            return "[shell] 清理完成：sidecar=stopped、目录锁已释放（\(lockRecordPath)）"
        default:
            return "[shell] 重启已放弃：sidecar 未停止（state=\(supervisorState)）——目录锁可能仍被持有，绝不带锁重启；按退出处理"
        }
    }

    /// 重启环境：安全模式才注入 env（新实例继承）。
    static func recoveryRelaunchEnvironment(base: [String: String], safeMode: Bool) -> [String: String] {
        var environment = base
        if safeMode { environment[safeModeEnvironmentKey] = "1" }
        return environment
    }

    /// 重启可行性门：必须是 .app 装配且有 bundle id（swift run/dev 不可重启）。
    static func recoveryRelaunchBundleURL(bundleURL: URL, bundleIdentifier: String?) -> URL? {
        guard bundleIdentifier != nil, bundleURL.pathExtension == "app" else { return nil }
        return bundleURL
    }

    /// 三选恢复的唯一呈现 + 执行出口：呈现 → 响应映射 → 动作；重启腿由调用方注入
    /// （先清理再 relaunch 的判据在那边）。
    static func runThreeChoiceRecovery(message: String,
                                       phase: RecoveryPhase,
                                       choices: RecoveryChoices = .threeWay,
                                       relaunch: (Bool) -> Bool) -> Never {
        let response: NSApplication.ModalResponse
        switch phase {
        case .startup:
            response = Self.runStartupRecoveryAlert(
                Self.makeStartupRecoveryAlert(message: message, phase: .startup, choices: choices))
        case .runtime:
            response = Self.runRuntimeRecoveryAlert(
                Self.makeStartupRecoveryAlert(message: message, phase: .runtime))
        }
        let action = Self.startupRecoveryAction(for: response, choices: choices)
        shellLog("[shell] \(phase.logLabel)失败恢复选择：\(action)")
        switch action {
        case .exit:
            exit(1)
        case .restart, .safeModeRestart:
            if relaunch(action == .safeModeRestart) { exit(0) }
            exit(1)
        }
    }
}