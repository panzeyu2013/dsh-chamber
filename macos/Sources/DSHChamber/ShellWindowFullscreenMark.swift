//
//  ShellWindowFullscreenMark.swift
//  DSHChamber
//
//  窗口 chrome：全屏状态镜像（上游 preload 的 `html[data-fullscreen]`）。
//
//  上游页面在 `[data-platform='darwin'][data-fullscreen]` 下把红绿灯那条带让给座位：
//  ui-layout 的 `--dsh-frame-leading-clearance` 从 160 收到 84、`.leadingSeat` 左移到
//  12px，ui-sidebar 的 `.topStrip` 改成左对齐（灯没了，开关让位）。这些规则只在**壳把
//  窗口全屏状态写到 html 上**时生效；上游由 Electron preload 打标，Swift 壳此前没有
//  等价面（页面样式表自认"今天不生效"）——全屏时页面仍按有灯留白，座位因此错位。
//
//  这里只有三件纯事：通知名 → 标记值、样式掩码 → 是否全屏、以及一行幂等属性写入。
//  写入形态与上游 preload 逐字同形（`dataset.fullscreen = 'true'` / `delete`，见 vendor
//  `apps/desktop/src/preload-platform.ts`）；每次页面装载完成重放一次（导航重置
//  document），进出全屏各写一次。
//
import AppKit

/// 全屏状态标记（属性名与上游 preload 同拼写）。
enum ShellWindowFullscreenMark {
    /// 进/出全屏通知（object 限定本窗）。
    static let enterNotification = NSWindow.didEnterFullScreenNotification
    static let exitNotification = NSWindow.didExitFullScreenNotification

    /// 通知名 → 标记值；非本对通知返回 nil（不写）。
    static func markValue(for notificationName: Notification.Name) -> Bool? {
        if notificationName == enterNotification { return true }
        if notificationName == exitNotification { return false }
        return nil
    }

    /// 样式掩码 → 是否全屏（装载完成时按窗口当前状态重放）。
    static func isFullscreen(_ mask: NSWindow.StyleMask) -> Bool {
        mask.contains(.fullScreen)
    }

    /// 幂等写入表达式（无回执；document 尚未就绪时静默无效，装载完成会重放）。
    /// 与上游 preload 同形：进全屏写 `'true'`，退出删键（CSS 只判存在，值形状照抄）。
    static func script(fullscreen: Bool) -> String {
        fullscreen
            ? "document.documentElement.dataset.fullscreen = 'true'"
            : "delete document.documentElement.dataset.fullscreen"
    }
}
