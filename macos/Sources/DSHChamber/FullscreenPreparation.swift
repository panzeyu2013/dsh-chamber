//
//  FullscreenPreparation.swift
//  DSHChamber
//
//  更新安装前的显示准备（P20-B，design 25 §7 / §4.5 update-window）：
//  安装确认面出现在 macOS 全屏 Space 时用户可能看不到它。官方 Electron 腿在
//  **展示安装确认之前**先请求窗口退出全屏并最多等 5s（update-window.ts 的
//  FULLSCREEN_EXIT_TIMEOUT_MS = 5000；main.ts 在 prepareDesktopUpdateWindow 之后
//  才展示安装确认）。本壳在设置行/页面的「重启并安装」路径上做同一件事：
//   - 无主窗 / 非全屏 → nil（无需准备，照常安装）；
//   - 全屏 → 观察 NSWindow.didExitFullScreenNotification + toggleFullScreen，
//     最多等 timeout；超时 → "fullscreen-timeout"（稳定错误码：页面据此显示
//     「退出全屏超时」并保留重试；W3 的 UpdateSection 以**逐字相等**识别该
//     字面量，两端不得加前缀或改大小写）；
//   - 等待期窗口销毁（willClose）→ nil（没有可退的全屏面，安装照常继续）。
//
//  残余（登记 design 25 §7 / STATUS）：App 菜单「检查更新…」与 scheduled
//  reminder 的 Sparkle 标准窗路径不经过本准备（方案 B 只覆盖设置行/页面
//  restartAndInstall 路径）；「全屏点重启并安装」的时序与 ≤5s 退全屏属真机
//  验收（本机无 swiftc/display → NOT RUN）。
//
//  纯判定（needsFullScreenExit）与 timeout 常量可单测直测；等待器
//  不构造真实 NSWindow（xctest 进程里 AppKit 未初始化，真实窗口不可造）。
//
import AppKit

/// 更新安装前的全屏退出准备（纯判定 + 有界等待）。
enum FullscreenPreparation {
    /// 退出全屏的等待上限（与官方 update-window.ts 的 FULLSCREEN_EXIT_TIMEOUT_MS 同值）。
    static let timeout: TimeInterval = 5.0

    /// 超时的稳定错误码：逐字 "fullscreen-timeout"（沿用上游同名拒绝码命名；
    /// 页面 UpdateSection 逐字比较，绝不加前缀或改大小写）。
    static let timeoutErrorCode = "fullscreen-timeout"

    /// 等待结果（纯值；单测只钉映射，流程由真机验收）。
    enum Outcome: Equatable {
        /// 窗口已退出全屏。
        case exited
        /// 等待期窗口销毁：没有可退的全屏面。
        case windowGone
        /// timeout 内仍未退出全屏。
        case timedOut
    }

    /// 纯判定：需要先退出全屏吗（无窗 / 非全屏 → 否）。
    /// 全屏判据单源 = ShellWindowFullscreenMark.isFullscreen（与写
    /// html[data-fullscreen] 的判据同一份），绝不另写一套 styleMask 位判定。
    static func needsFullScreenExit(_ styleMask: NSWindow.StyleMask?) -> Bool {
        guard let styleMask else { return false }
        return ShellWindowFullscreenMark.isFullscreen(styleMask)
    }

    /// 安装前准备（MainActor async）：返回 nil = 可以继续安装；非 nil = 拒绝安装
    /// 的原因码。必须在主线程执行（toggleFullScreen 与通知观察都是主线程语义）。
    @MainActor
    static func prepareForInstall(window: NSWindow?,
                                  timeout: TimeInterval = FullscreenPreparation.timeout)
        async -> String? {
        guard let window, needsFullScreenExit(window.styleMask) else { return nil }
        shellLog("[shell] 更新安装前退出全屏（最多等 \(Int(timeout))s，P20-B）")
        let outcome = await waitForExit(window: window, timeout: timeout)
        switch outcome {
        case .exited:
            shellLog("[shell] 全屏已退出——继续安装更新")
            return nil
        case .windowGone:
            shellLog("[shell] 等待退全屏期间窗口销毁——无全屏面可退，继续安装更新")
            return nil
        case .timedOut:
            shellLog("[shell] 退出全屏超时（\(Int(timeout))s）——拒绝安装更新（\(timeoutErrorCode)）")
            return timeoutErrorCode
        }
    }

    /// 观察退出通知并 toggle，返回首个结算的结果（三条到达路径都在主队列串行）。
    @MainActor
    private static func waitForExit(window: NSWindow,
                                    timeout: TimeInterval) async -> Outcome {
        await withCheckedContinuation { continuation in
            let waiter = FullScreenExitWaiter(timeout: timeout) { outcome in
                continuation.resume(returning: outcome)
            }
            waiter.start(window: window)
        }
    }
}

/// 恰一次结算的等待器（主线程所有：通知投递到主队列，超时也排主队列）。
/// 观察块与超时 work item 都强引用本对象（NotificationCenter 持观察块、
/// DispatchQueue 持 work item），因此等待期间对象不会在异步帧之间被释放；
/// 结算时注销全部观察者，迟到的超时块见 finished 直接退出。
private final class FullScreenExitWaiter {
    private var observers: [NSObjectProtocol] = []
    private var finished = false
    private let timeout: TimeInterval
    private let completion: (FullscreenPreparation.Outcome) -> Void

    init(timeout: TimeInterval,
         completion: @escaping (FullscreenPreparation.Outcome) -> Void) {
        self.timeout = timeout
        self.completion = completion
    }

    /// 先注册观察者再发起退出（避免 toggle 与通知之间的同步窗口漏事件）。
    func start(window: NSWindow) {
        let center = NotificationCenter.default
        // object 限定本窗：别的窗口退全屏与本等待无关。
        observers.append(center.addObserver(
            forName: ShellWindowFullscreenMark.exitNotification, object: window, queue: .main
        ) { [self] _ in
            self.finish(.exited)
        })
        observers.append(center.addObserver(
            forName: NSWindow.willCloseNotification, object: window, queue: .main
        ) { [self] _ in
            self.finish(.windowGone)
        })
        // 超时兜底排主队列：与两个观察者在同一队列上串行，finished 门保证恰一次。
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [self] in
            self.finish(.timedOut)
        }
        if !ShellWindowFullscreenMark.isFullscreen(window.styleMask) {
            // 观察者注册前窗口已经退出（极快切换）：直接结算，不重复 toggle。
            finish(.exited)
            return
        }
        window.toggleFullScreen(nil)
    }

    private func finish(_ outcome: FullscreenPreparation.Outcome) {
        guard !finished else { return }
        finished = true
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        completion(outcome)
    }
}
