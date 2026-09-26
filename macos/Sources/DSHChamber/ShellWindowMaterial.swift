//
//  ShellWindowMaterial.swift
//  DSHChamber
//
//  窗口 chrome：侧栏材质（上游 Electron `vibrancy: 'sidebar'` 的 AppKit 等价面）。
//
//  上游 macOS 窗口**背后是材质**：ui-web base.css 在 `html[data-platform='darwin']` 下把
//  html/body 的背景设为透明（"the window's sidebar vibrancy shows only through a
//  transparent page background"），ui-layout 的窗格只染半透明层，材质因此透出。Swift 壳
//  此前没有材质腿：窗口是不透明主题色，页面透明区域露出的是那层色（本机登记的取舍）。
//
//  这里装上游同形的面：`material = .sidebar`（Chromium 的 `sidebar` vibrancy 就是它）、
//  `blendingMode = .behindWindow`（采样窗后桌面 = 真正的 vibrancy）、`state = .active`
//  （上游 `visualEffectState: 'active'`，vendor `apps/desktop/src/main.ts` 明确拒用
//  followWindow："'followWindow' washes the sidebar out behind an unfocused window"；
//  AppKit 的默认值**正是** followsWindowActiveState（NSVisualEffectView.h：Defaults to
//  NSVisualEffectStateFollowsWindowActiveState）＝上游拒用的那个形态，所以这里必须显式写
//  .active——删掉它等于退回被拒的观感）；窗口必须不透明关掉且底色清空，否则材质采样到的是
//  窗口自己的色。最小化/隐藏期间的兜底见 applyBackdrop（上游 deminiaturize 重挂间隙的等价面）。
//
//  露底色判定在 `underPageColor(usesTransparentPage:themed:)`：**它只看 WebKit 是否真能透明**
//  ——`drawsBackground` 是私有键、随 OS 版本可能
//  不可用（见 MainWindowController 的异常安全包装），不可用时 WebKit 不透明绘制，页面透明
//  区画的就是露底色，只有这时它必须保持主题化不透明色（首帧/重载不白闪）。
//
import AppKit
import WebKit

/// 侧栏材质面：安装与露底色决策。
enum ShellWindowMaterial {
    /// 装入窗口：内容视图换成「材质 + 页面」容器，窗口转非不透明、底色清空。
    /// 唯一调用点是建窗一次；容器尺寸由窗口驱动（contentView 的 frame 由窗口设，容器
    /// 不需要 autoresizingMask），页面视图靠自己的 mask 跟随容器。
    /// - Returns: 材质视图（调用方的句柄：最小化/隐藏兜底要切它的 `isHidden`）。
    static func install(in window: NSWindow, webView: WKWebView) -> NSVisualEffectView {
        let container = NSView(frame: webView.frame)
        let effect = NSVisualEffectView(frame: container.bounds)
        effect.autoresizingMask = [.width, .height]
        effect.material = .sidebar
        effect.blendingMode = .behindWindow
        effect.state = .active
        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        container.addSubview(effect)
        container.addSubview(webView)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.contentView = container
        return effect
    }

    /// 上游 `chromeFallbackFill()`：dark #1b1b1c / light #f9fafb（＝侧栏填充同 token）。
    /// nil（尚无页面事实）按骨架期的深色处理，与 `themedBackgroundColor` 同约定。
    static func fallbackFill(pageIsDark: Bool?) -> NSColor {
        pageIsDark == true || pageIsDark == nil
            ? NSColor(srgbRed: 27 / 255, green: 27 / 255, blue: 28 / 255, alpha: 1)
            : NSColor(srgbRed: 249 / 255, green: 250 / 255, blue: 251 / 255, alpha: 1)
    }

    /// 最小化 / 隐藏期间的后备背板（上游 darwin `applyBackdrop` 的 AppKit 等价面）。
    /// 上游在 minimize/hide/restore/show 上切 `setVibrancy(null)` + 不透明底再切回，盖住
    /// electron#25368（deminiaturize 后材质重挂晚，透明窗把桌面漏进侧栏）的间隙；本壳材质是
    /// contentView 的常驻子视图（探针：最小化后仍在层级里、hidden=false），这条是对上游同形
    /// 面的防御：抑制期材质不画 + 窗口转不透明兜底色，恢复期材质重画 + 窗口回 clear，
    /// isHidden 的 true→false 等价于上游 null→'sidebar' 的强制重挂。
    static func applyBackdrop(suppressed: Bool, effect: NSVisualEffectView, window: NSWindow,
                              pageIsDark: Bool?) {
        effect.isHidden = suppressed
        window.backgroundColor = suppressed ? fallbackFill(pageIsDark: pageIsDark) : .clear
    }

    /// "露底色"：只有 WebKit **真能透明**（私有键 `drawsBackground` 生效）时 clear，否则
    /// 保持主题色——WebKit 不透明绘制时，页面透明区画的就是它（首帧/重载不白闪）。
    /// 窗口底不在这里：它是材质面的事（`install` 置 clear、`applyBackdrop` 在抑制期置兜底色）。
    static func underPageColor(usesTransparentPage: Bool, themed: NSColor) -> NSColor {
        usesTransparentPage ? .clear : themed
    }
}
