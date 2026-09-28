//
//  MainWindowShownGateTests.swift
//  DSHChamberTests
//
//  __host.mainWindowShown 的双边沿去重门（design 25 §5 E6 / §0.1 B9）。
//  core 把该入站事件当作 held-resume/徽标意图的一次「恢复可见」边沿
//  （shell-core.ts handleMainWindowShown），而 AppKit 对同一个恢复动作至少有
//  两条事件腿（窗口 orderOnScreen/deminiaturize 与 NSApplication.didBecomeActive）
//  ——Dock/托盘/通知恢复时两条腿都可能发。门必须保证一个可见周期内只放行一次，
//  且窗口离屏后下一次恢复必须重新放行（否则隐藏期间的 held-resume 永远丢）。
//
import XCTest
@testable import DSHChamber

final class MainWindowShownGateTests: XCTestCase {

    /// Dock 点击已隐藏窗口的常见形态：应用先激活、窗口随即成为 key（didBecomeKey
    /// 是 AppKit 实际提供的窗口恢复通知）——只发一次。
    func testActivationThenWindowKeyEdgeEmitsOnce() {
        var gate = MainWindowShownGate()
        XCTAssertTrue(gate.shouldEmit(), "应用激活腿必须发送")
        XCTAssertFalse(gate.shouldEmit(),
                       "同一可见周期内的窗口在屏腿绝不双发（core 边沿不是事件计数）")
        XCTAssertFalse(gate.shouldEmit(), "重复激活同样不得补发第二次")
    }

    /// 反向次序（窗口先成为 key、应用随后激活）同样只发一次。
    func testWindowKeyEdgeThenActivationEmitsOnce() {
        var gate = MainWindowShownGate()
        XCTAssertTrue(gate.shouldEmit(), "窗口在屏腿必须发送")
        XCTAssertFalse(gate.shouldEmit(), "其后的应用激活腿必须被门吞掉")
    }

    /// 已激活态恢复隐藏/最小化窗口只有窗口一条腿——离屏复位后必须发送。
    func testOffScreenResetsSoAlreadyActiveRestoreStillEmits() {
        var gate = MainWindowShownGate()
        XCTAssertTrue(gate.shouldEmit())      // 之前的可见周期
        gate.windowDidLeaveScreen()           // close-to-hide orderOut / 最小化
        XCTAssertTrue(gate.shouldEmit(),
                      "已激活态经 Dock/托盘/通知恢复隐藏窗口不产生 didBecomeActive——"
                      + "窗口在屏腿必须补上 held-resume 补发")
        // 复位幂等：orderOut 与 miniaturize 两条离屏通知都到也只影响一次状态。
        gate.windowDidLeaveScreen()
        gate.windowDidLeaveScreen()
        XCTAssertTrue(gate.shouldEmit())
    }

    /// 无离屏事件时不能重复放行（门不能退化成恒真——否则每次激活都多发一帧）；
    /// 复位后同样只放行一次。
    func testGateDoesNotLeakWithoutOffScreenEdge() {
        var gate = MainWindowShownGate()
        XCTAssertTrue(gate.shouldEmit())
        for _ in 0..<5 {
            XCTAssertFalse(gate.shouldEmit(), "同一可见周期内后续边沿必须恒定被吞")
        }
        gate.windowDidLeaveScreen()
        XCTAssertTrue(gate.shouldEmit())
        for _ in 0..<5 {
            XCTAssertFalse(gate.shouldEmit(), "复位只重置状态，不得让门恒真")
        }
    }

    /// 接线锁（源文本）：唯一发送点 + 两条恢复腿 + 两条离屏复位 + orderOut
    /// 隐藏入口的显式复位都必须留在源里——删掉任一观察者/钩子时上面的纯值用例
    /// 仍绿，故这里钉住。AppKit 不向 Swift 导出 orderOn/OffScreen 通知
    /// （2026-12 用 swiftc -typecheck 核实），恢复面用 didBecomeKey +
    /// didDeminiaturize，orderOut 型隐藏没有通知可挂，必须由隐藏入口手动复位。
    func testControllerWiresBothEdgesThroughTheSingleSendPoint() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // DSHChamberTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // macos
            .deletingLastPathComponent()   // repo root
        let source = try String(contentsOf: root
            .appendingPathComponent("macos/Sources/DSHChamber/MainWindowController.swift"),
            encoding: .utf8)
        for anchor in ["NSWindow.didBecomeKeyNotification",
                       "NSWindow.didDeminiaturizeNotification",
                       "NSWindow.didMiniaturizeNotification",
                       "NSApplication.didHideNotification",
                       "NSApplication.didBecomeActiveNotification"] {
            XCTAssertTrue(source.contains(anchor), "MainWindowController 必须保留观察者：\(anchor)")
        }
        XCTAssertTrue(source.contains("name: NSApplication.didHideNotification, object: nil)"),
                      "didHide 是应用级通知（object = NSApp）：object 传 window 会成死观察者")
        XCTAssertTrue(source.contains("mainWindowShownGate.shouldEmit()"),
                      "两条恢复腿必须经去重门放行")
        XCTAssertTrue(source.contains("mainWindowShownGate.windowDidLeaveScreen()"),
                      "离屏通知必须复位去重门")
        // 唯一发送点：HostInboundMethod.mainWindowShown 在源文本里只允许出现一次。
        let invokeSites = source.components(separatedBy: "HostInboundMethod.mainWindowShown")
        XCTAssertEqual(invokeSites.count - 1, 1,
                       "mainWindowShown 只允许一个 invoke 发送点（双发风险即在此）")

        // orderOut 型隐藏（关窗 hide-to-tray / 托盘）没有 AppKit 通知：三处
        // hide 分支都必须在 orderOut 前显式复位，否则再次 orderFront 时恢复腿
        // 会被门当成重复而抑制（隐藏期间的 held-resume 永远不补发）。
        let appDelegate = try String(contentsOf: root
            .appendingPathComponent("macos/Sources/DSHChamber/AppDelegate.swift"),
            encoding: .utf8)
        XCTAssertEqual(appDelegate.components(separatedBy: "noteWindowHiddenExplicitly()").count - 1, 3,
                       "三处 orderOut 隐藏分支必须各调一次 noteWindowHiddenExplicitly()")
        XCTAssertEqual(appDelegate.components(separatedBy: "window?.orderOut(nil)").count - 1, 3,
                       "hide-to-tray 的 orderOut 点必须仍是三处（新增隐藏点必须同步复位门）")
    }
}
