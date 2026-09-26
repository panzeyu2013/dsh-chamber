//
//  ShellWindowChromeTests.swift
//  DSHChamberTests
//
//  窗口 chrome 三个上游等价面的纯函数面（design 25 §5.6）：红绿灯内缩
//  （`titleBarStyle:'hiddenInset'` + `trafficLightPosition:{x:16,y:18}`）、全屏标记
//  （preload 的 `html[data-fullscreen]`）、侧栏材质（`vibrancy:'sidebar'`）。
//
//  这里只锁目标值与写出的表达式；副作用（改按钮 frame、evaluateJavaScript、装视图）与
//  接线由 ShellIdentityTests 的源码锁负责，真机观感由实机验收负责。
//
import XCTest
@testable import DSHChamber

final class ShellWindowChromeTests: XCTestCase {

    // MARK: - 红绿灯内缩（H1）

    func testTrafficLightTargetsMatchTheUpstreamPinAndThePageChromeRow() {
        XCTAssertEqual(ShellTrafficLightInset.centreY, 25, accuracy: 0.0001,
                       "页面 chrome 行中心 y 25（.topStrip 的 28px 开关 / .leadingSeat / 标题行同值），"
                       + "也等于上游 pin 的 y18 + 灯盒半高 7")
        XCTAssertEqual(ShellTrafficLightInset.firstCentreX, 23, accuracy: 0.0001,
                       "上游 trafficLightPosition.x=16（灯组左沿）+ 本机灯盒宽的一半 7")
        XCTAssertEqual(ShellTrafficLightInset.buttonTypes,
                       [.closeButton, .miniaturizeButton, .zoomButton],
                       "三盏都要缩（最左那盏是平移锚点，书写顺序不参与几何）")
    }

    func testRealAppKitDeltaMovesTheDefaultRowOntoTheUpstreamPin() {
        // 本机同形窗实测：NSTitlebarView **非** flipped（高 32）、按钮 frame (9,9,14,14)
        // → 中心 (16,16)；目标 (23,25) 在视图坐标里折返为 y=7。
        let target = CGPoint(x: ShellTrafficLightInset.firstCentreX,
                             y: ShellTrafficLightInset.centreY)
        let delta = ShellTrafficLightInset.delta(current: CGPoint(x: 16, y: 16), target: target,
                                                 superviewIsFlipped: false, superviewHeight: 32)
        XCTAssertEqual(delta.dx, 7, accuracy: 0.0001)
        XCTAssertEqual(delta.dy, 32 - 25 - 16, accuracy: 0.0001,
                       "非 flipped：距上沿 25 = 视图坐标 7，位移 = 7-16 = -9（向窗口下方）")
    }

    func testFlippedDeltaUsesTheTargetDirectly() {
        let target = CGPoint(x: ShellTrafficLightInset.firstCentreX,
                             y: ShellTrafficLightInset.centreY)
        let delta = ShellTrafficLightInset.delta(current: CGPoint(x: 16, y: 16), target: target,
                                                 superviewIsFlipped: true, superviewHeight: 32)
        XCTAssertEqual(delta.dx, 7, accuracy: 0.0001)
        XCTAssertEqual(delta.dy, 9, accuracy: 0.0001, "flipped：目标 y 就是距上沿的距离")
    }

    // MARK: - 全屏标记（H2）

    func testMarkValueOnlyAnswersTheTwoWindowNotifications() {
        XCTAssertEqual(ShellWindowFullscreenMark.markValue(
            for: ShellWindowFullscreenMark.enterNotification), true)
        XCTAssertEqual(ShellWindowFullscreenMark.markValue(
            for: ShellWindowFullscreenMark.exitNotification), false)
        XCTAssertNil(ShellWindowFullscreenMark.markValue(for: NSWindow.didBecomeKeyNotification),
                     "其它窗口通知不得写全屏标记")
    }

    func testFullscreenNotificationConstantsAreTheWindowOnes() {
        XCTAssertEqual(ShellWindowFullscreenMark.enterNotification, NSWindow.didEnterFullScreenNotification)
        XCTAssertEqual(ShellWindowFullscreenMark.exitNotification, NSWindow.didExitFullScreenNotification)
    }

    func testIsFullscreenReadsTheStyleMask() {
        XCTAssertTrue(ShellWindowFullscreenMark.isFullscreen([.titled, .fullScreen]))
        XCTAssertFalse(ShellWindowFullscreenMark.isFullscreen([.titled, .resizable]))
        XCTAssertFalse(ShellWindowFullscreenMark.isFullscreen([]))
    }

    func testScriptIsTheUpstreamDatasetToggle() {
        // 上游 preload-platform.ts:29-30：进全屏 dataset.fullscreen = 'true'，退出 delete。
        XCTAssertEqual(ShellWindowFullscreenMark.script(fullscreen: true),
                       "document.documentElement.dataset.fullscreen = 'true'")
        XCTAssertEqual(ShellWindowFullscreenMark.script(fullscreen: false),
                       "delete document.documentElement.dataset.fullscreen")
    }

    func testReapplyNotificationsCoverEveryNotifiableRelayout() {
        // 标题换值同样重排（本机实测：换值即回 (16,16)）且**不发任何通知**，进不了这张表，
        // 由 MainWindowController.setWindowTitle 兜住（源码锁见 ShellIdentityTests）。
        XCTAssertEqual(ShellTrafficLightInset.reapplyNotifications,
                       [NSWindow.didResizeNotification,
                        NSWindow.didChangeScreenNotification,
                        NSWindow.didChangeBackingPropertiesNotification,
                        NSWindow.didDeminiaturizeNotification,
                        NSWindow.didEnterFullScreenNotification,
                        NSWindow.didExitFullScreenNotification],
                       "缩放（实测）+ 跨屏/backing/最小化恢复（防御性）+ 进出全屏，都要重做内缩")
    }

    // MARK: - 侧栏材质（H3）

    func testUnderPageColorFollowsTheWebViewTransparency() {
        let themed = NSColor(srgbRed: 0.1, green: 0.2, blue: 0.3, alpha: 1)
        XCTAssertEqual(ShellWindowMaterial.underPageColor(usesTransparentPage: true, themed: themed), .clear,
                       "WebKit 真能透明时露底色必须 clear（页面透明区露出窗后材质）")
        XCTAssertEqual(ShellWindowMaterial.underPageColor(usesTransparentPage: false, themed: themed), themed,
                       "WebKit 不透明绘制时露底色保持主题色（首帧/重载不白闪）")
    }

    func testFallbackFillIsTheUpstreamChromeFill() {
        // 上游 chromeFallbackFill()：dark #1b1b1c / light #f9fafb（＝侧栏填充同 token）。
        let dark = ShellWindowMaterial.fallbackFill(pageIsDark: true)
        XCTAssertEqual(dark, NSColor(srgbRed: 27 / 255, green: 27 / 255, blue: 28 / 255, alpha: 1),
                       "最小化/隐藏兜底底：深色 = 上游 #1b1b1c")
        XCTAssertEqual(ShellWindowMaterial.fallbackFill(pageIsDark: nil), dark,
                       "尚无页面事实按骨架期深色处理（与 themedBackgroundColor 同约定）")
        XCTAssertEqual(ShellWindowMaterial.fallbackFill(pageIsDark: false),
                       NSColor(srgbRed: 249 / 255, green: 250 / 255, blue: 251 / 255, alpha: 1),
                       "最小化/隐藏兜底底：浅色 = 上游 #f9fafb")
    }
}
