//
//  FullscreenPreparationTests.swift
//  DSHChamberTests
//
//  更新安装前全屏准备（P20-B）的纯判定与超时映射单测。真实窗口/toggleFullScreen/
//  退全屏通知时序属真机验收（本机无 swiftc/display → 整套 NOT RUN）。这里钉住：
//  全屏判据复用 ShellWindowFullscreenMark（不复制 styleMask 判定）、稳定码字面量
//  "fullscreen-timeout"（页面 UpdateSection 逐字比较）与「无窗 = 无需准备」。
//
import XCTest
@testable import DSHChamber

final class FullscreenPreparationTests: XCTestCase {

    /// 等待上限 = 官方 update-window.ts 的 FULLSCREEN_EXIT_TIMEOUT_MS = 5000。
    func testTimeoutMatchesTheUpstreamFiveSeconds() {
        XCTAssertEqual(FullscreenPreparation.timeout, 5.0, accuracy: 0.0001)
    }

    /// 稳定错误码必须逐字 "fullscreen-timeout"：W3 的 UpdateSection 以字符串相等
    /// 识别它（显示「退出全屏超时」+ 保留重试），任何前缀/大小写变化都会静默退回
    /// 通用拒绝文案。
    func testTimeoutErrorCodeIsTheStableLiteral() {
        XCTAssertEqual(FullscreenPreparation.timeoutErrorCode, "fullscreen-timeout")
        XCTAssertEqual(FullscreenPreparation.timeout, 5.0, accuracy: 0.0001,
                       "稳定码只在 5s 上限超时时使用（映射在 prepareForInstall 的 .timedOut 分支）")
    }

    /// 全屏判据：无窗 / 非全屏 → 不准备；全屏 → 准备。判据单源 =
    /// ShellWindowFullscreenMark.isFullscreen（与写 html[data-fullscreen] 同一份）。
    func testNeedsFullScreenExitOnlyForFullScreenWindows() {
        XCTAssertFalse(FullscreenPreparation.needsFullScreenExit(nil), "无窗 = 无全屏面可退")
        XCTAssertFalse(FullscreenPreparation.needsFullScreenExit([]))
        XCTAssertFalse(FullscreenPreparation.needsFullScreenExit([.titled, .closable, .resizable]))
        XCTAssertTrue(FullscreenPreparation.needsFullScreenExit([.fullScreen]))
        XCTAssertTrue(FullscreenPreparation.needsFullScreenExit([.titled, .resizable, .fullScreen]))
        let masks: [NSWindow.StyleMask] = [
            [], [.titled], [.titled, .resizable],
            [.fullScreen], [.titled, .resizable, .fullScreen],
        ]
        for mask in masks {
            XCTAssertEqual(FullscreenPreparation.needsFullScreenExit(mask),
                           ShellWindowFullscreenMark.isFullscreen(mask),
                           "全屏判据必须与 ShellWindowFullscreenMark 同源（不复制 styleMask 判定）")
        }
    }

    /// 无主窗直接放行（async 面）：不构造真实 NSWindow，只覆盖 guard 早退。
    @MainActor
    func testPrepareWithoutWindowProceeds() async {
        let code = await FullscreenPreparation.prepareForInstall(window: nil)
        XCTAssertNil(code, "无窗 = 无需准备（nil 表示可以继续安装）")
    }
}
