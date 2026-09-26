//
//  ShellTrafficLightInset.swift
//  DSHChamber
//
//  窗口 chrome：红绿灯内缩（上游 `titleBarStyle:'hiddenInset'` 的 AppKit 等价面）。
//
//  上游 macOS 窗口是 hiddenInset（Electron `titleBarStyle:'hiddenInset'`）：标题栏隐藏、内容延伸进
//  标题栏，官方桌面把**灯组左上角** pin 在 `trafficLightPosition: {x:16, y:18}`（vendor
//  `apps/desktop/src/main.ts`；ui-sidebar 侧注释同写 "(16, 18)"）。本机 AppKit 灯盒 14×14、
//  中心距 23 ⇒ 对齐上游 pin 后首灯中心 = (16+7, 18+7) = **(23,25)**：y 与页面 chrome 行同为
//  25（ui-sidebar `.topStrip` 的 28px 开关中心、折叠态 `.leadingSeat`、会话标题行同高），
//  且本机更宽的灯距下第三灯右沿 = 16 + 14 + 2×23 = 76 < 88（ui-layout
//  `--dsh-frame-leading-clearance` 里控件起点），不会压到「展开 / 新建」两钮。
//
//  Swift 壳只用 `titlebarAppearsTransparent + fullSizeContentView` 时红绿灯停在 titlebar
//  正中——本机同形窗实测中心 (16,16)、frame (9,9,14,14)、标题栏带 32pt——比页面那条带
//  高 9pt，整条顶部带因此不成一行（参考图里两者同 y）。这里把灯组**整体平移**到页面
//  行：目标 = 首灯中心 (23,25)，保持 AppKit 自己的灯间距与尺寸（跨 macOS 版本自适配，
//  不写死 23/14）。纯函数只算位移（单测直测），副作用只在 `apply(to:)`；调用点 =
//  建窗后、`reapplyNotifications` 里的每次 titlebar 重排（缩放、进出全屏），以及
//  **改标题之后**（标题换值同样重排 titlebar 且不发任何通知，见 MainWindowController
//  的 `setWindowTitle`）。
//
import AppKit

/// 红绿灯内缩目标与实现。
enum ShellTrafficLightInset {
    /// 页面 chrome 行的中心 y（ui-sidebar `.topStrip` 的 28px 开关中心、折叠态
    /// `.leadingSeat`、会话标题行同值；design 05 §2）。
    static let centreY: CGFloat = 25
    /// 首灯中心 x：对齐上游 pin 的灯组左沿 16（`trafficLightPosition.x`）+ 本机灯盒宽的一半。
    static let firstCentreX: CGFloat = 23
    /// 三个标准按钮（组平移；锚点取其中最左那盏，见 `apply`）。
    static let buttonTypes: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]

    /// 需要重做内缩的窗口通知。AppKit 在**任何重排 titlebar 子视图**的时机把标准按钮放回
    /// 默认位置：本机实测 `setFrame` 与 `zoom(_:)` 之后三灯立刻回 (16,16)，把按钮的
    /// `translatesAutoresizingMaskIntoConstraints` 置 true 也挡不住这次重排（实测同样回默认）。
    /// 逐条理由：
    /// - `didResize`：缩放/zoom（实测回默认位），与 `setFrame` 同步投递，纠正落在同一轮布局里，
    ///   不会先显示默认位再跳（探针：连续 resize 与 zoom 后三灯恒在 (23,25)）；
    /// - `didChangeScreen` / `didChangeBackingProperties`：跨屏与 backing 变化（缩放因子/色域）
    ///   会重排 titlebar 并可能重建按钮图像——单屏开发机不可复现，防御性订阅（单次重做 ~0.05ms）；
    /// - `didDeminiaturize`：最小化恢复（程序化 deminiaturize 实测不回默认位，同为防御性）；
    /// - 进出全屏：必然改 frame ⇒ `didResize` 也会发，这两条是第二重保险（处理器另在下一轮
    ///   主循环补一次，见 `windowChromeLayoutDidChange`）。
    /// **标题换值**同样重排且不发任何通知（本机实测），进不了这张表——它由
    /// MainWindowController 的 `setWindowTitle` 在写标题后直接重做内缩。
    static let reapplyNotifications: [Notification.Name] = [
        NSWindow.didResizeNotification,
        NSWindow.didChangeScreenNotification,
        NSWindow.didChangeBackingPropertiesNotification,
        NSWindow.didDeminiaturizeNotification,
        ShellWindowFullscreenMark.enterNotification,
        ShellWindowFullscreenMark.exitNotification,
    ]

    /// 把首灯中心从 `current` 平移到距**窗口上沿**/左沿 `target` 所需的位移（纯函数）。
    /// `superviewIsFlipped` 由调用方读 `NSView.isFlipped`：NSTitlebarView 本机实测**非**
    /// flipped（高 32、y 向上增长、原点在标题栏下沿），故目标 y 要从视图高度折返；flipped
    /// 分支为其它宿主保留。
    static func delta(current: CGPoint, target: CGPoint,
                      superviewIsFlipped: Bool, superviewHeight: CGFloat) -> CGVector {
        let targetY = superviewIsFlipped ? target.y : superviewHeight - target.y
        return CGVector(dx: target.x - current.x, dy: targetY - current.y)
    }

    /// 把窗口三个标准按钮平移到页面 chrome 行；返回是否真的移动过。
    /// 三灯必须同属一个 superview（NSTitlebarView），否则不动——宁可不缩也不错位。
    @discardableResult
    static func apply(to window: NSWindow) -> Bool {
        let buttons = buttonTypes.compactMap { window.standardWindowButton($0) }
        // 锚点 = 最左那盏（本机是 closeButton），不假定 `buttonTypes` 的书写顺序就是视觉
        // 顺序：组平移只依赖「哪盏在最左」，系统若镜像按钮也不会把整组推错方向。
        guard buttons.count == buttonTypes.count,
              let anchor = buttons.min(by: { $0.frame.minX < $1.frame.minX }),
              let superview = anchor.superview,
              buttons.allSatisfy({ $0.superview === superview }) else { return false }
        let current = CGPoint(x: anchor.frame.midX, y: anchor.frame.midY)
        let offset = delta(current: current,
                           target: CGPoint(x: firstCentreX, y: centreY),
                           superviewIsFlipped: superview.isFlipped,
                           superviewHeight: superview.bounds.height)
        guard offset.dx != 0 || offset.dy != 0 else { return false }
        for button in buttons {
            button.setFrameOrigin(NSPoint(x: button.frame.origin.x + offset.dx,
                                          y: button.frame.origin.y + offset.dy))
        }
        return true
    }
}
