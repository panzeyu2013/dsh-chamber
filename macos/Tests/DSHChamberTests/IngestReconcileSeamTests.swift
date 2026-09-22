//
//  IngestReconcileSeamTests.swift
//  DSHChamberTests
//
//  「ingest 之后必然对账露底色」的可直测接缝。
//  露底色对账不能挂在 ingest 的「有变化」分支上——第二次启动时 store 内已
//  有同值事实，ingest 返回 false；若对账只在变化分支内发生，浅色页面会整场会话停在
//  骨架深色。本文件直测
//  MainWindowController.ingestPageFacts(_:into:reconcile:) 的调用次序：
//  把对账退回「仅变化时」会让第一条测试观察到 0 次回调 → 红。
//
import XCTest
@testable import DSHChamber

final class IngestReconcileSeamTests: XCTestCase {

    private func makeDefaults(_ suffix: String) -> (UserDefaults, String) {
        let name = "IngestReconcileSeamTests.\(suffix).\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return (defaults, name)
    }

    /// 无变化的 ingest 也必须对账一次（早退点）。
    /// 「仅变化时对账」→ 第二次调用观察到 0 次回调 → 本测试红。
    func testReconcileRunsAfterEveryIngestEvenWhenStoreUnchanged() {
        let (defaults, name) = makeDefaults(#function)
        defer { defaults.removePersistentDomain(forName: name) }
        let store = ShellPageFactsStore(defaults: defaults)
        var reconciled: [Bool?] = []

        let firstChanged = MainWindowController.ingestPageFacts(
            ["lang": "en", "dark": false, "revision": 1],
            into: store) { reconciled.append($0) }
        XCTAssertTrue(firstChanged, "首次上报必须产生变化")
        XCTAssertEqual(reconciled.count, 1)
        XCTAssertEqual(reconciled[0], false)

        // 同值再上报：Store 无变化（若在此早退就会跳过对账）。
        let secondChanged = MainWindowController.ingestPageFacts(
            ["lang": "en", "dark": false, "revision": 1],
            into: store) { reconciled.append($0) }
        XCTAssertFalse(secondChanged, "同值上报不得产生变化")
        XCTAssertEqual(reconciled.count, 2,
                       "对账必须与 changed 解耦：第二次（无变化）ingest 之后也必须对账露底色（F1）")
        XCTAssertEqual(reconciled.last ?? true, false, "对账拿到的是 store 当前事实（浅色）")
    }

    /// 等价端到端（第二次启动）：持久化同值事实 + applied=nil 起步，无变化 ingest
    /// 之后露底色必须从骨架深色收敛到浅色（白）。与 reconcileThemedBackground 的
    /// applied 推进状态机同型；退回「仅变化时对账」时 applied 停在 nil → 红。
    func testUnchangedSecondLaunchIngestConvergesToLightBackground() throws {
        let (defaults, name) = makeDefaults(#function)
        defer { defaults.removePersistentDomain(forName: name) }
        let firstLaunch = ShellPageFactsStore(defaults: defaults)
        XCTAssertTrue(MainWindowController.ingestPageFacts(
            ["lang": "en", "dark": false, "revision": 1],
            into: firstLaunch) { _ in })

        // 第二次启动：store 载入同一份持久化事实，同值上报返回 false。
        let secondLaunch = ShellPageFactsStore(defaults: defaults)
        XCTAssertEqual(secondLaunch.current?.pageIsDark, false)
        var appliedPageIsDark: Bool?
        var appliedColor: NSColor?
        let changed = MainWindowController.ingestPageFacts(
            ["lang": "en", "dark": false, "revision": 1],
            into: secondLaunch) { desiredPageIsDark in
                guard let color = MainWindowController.themedBackgroundColorToApply(
                    pageIsDark: desiredPageIsDark,
                    appliedPageIsDark: appliedPageIsDark) else { return }
                appliedColor = color
                appliedPageIsDark = desiredPageIsDark
            }
        XCTAssertFalse(changed)
        XCTAssertEqual(appliedPageIsDark, false, "无变化 ingest 也必须推进 applied 状态")
        let applied = try XCTUnwrap(appliedColor)
        let color = try XCTUnwrap(applied.usingColorSpace(.sRGB))
        XCTAssertEqual(color.redComponent, 1.0, accuracy: 0.001, "浅色页面露白底")
        XCTAssertEqual(color.greenComponent, 1.0, accuracy: 0.001)
        XCTAssertEqual(color.blueComponent, 1.0, accuracy: 0.001)
    }
}