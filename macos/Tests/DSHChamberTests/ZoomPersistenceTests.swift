//
//  ZoomPersistenceTests.swift
//  DSHChamberTests
//
//  页面缩放按 origin 持久化（Chromium 的 partition.per_host_zoom_levels
//  对偶）。WKWebView.pageZoom 每次启动回 100%，本文件钉住 UserDefaults 存取、
//  坏值收敛，以及装配恢复/菜单写回的接线（不构造真实 WKWebView）。
//
import XCTest
@testable import DSHChamber

final class ZoomPersistenceTests: XCTestCase {

    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        suiteName = "shell-zoom-tests-\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suiteName)
    }

    func testDefaultsKeyIsOriginScoped() {
        XCTAssertEqual(ZoomPersistence.defaultsKey(cpOrigin: "http://127.0.0.1:17500"),
                       "native-shell.page-zoom.http://127.0.0.1:17500")
        XCTAssertNotEqual(ZoomPersistence.defaultsKey(cpOrigin: "http://127.0.0.1:17500"),
                          ZoomPersistence.defaultsKey(cpOrigin: "http://127.0.0.1:17520"),
                          "不同 origin（端口）必须是不同键，绝不互相串台")
    }

    func testLoadAbsentKeyReturnsOneHundredPercent() {
        let key = ZoomPersistence.defaultsKey(cpOrigin: "http://127.0.0.1:17500")
        XCTAssertEqual(ZoomPersistence.load(defaults: defaults, key: key, range: 0.5...3.0), 1.0)
    }

    func testSaveThenLoadRoundTripsWithinRange() {
        let key = ZoomPersistence.defaultsKey(cpOrigin: "http://127.0.0.1:17500")
        ZoomPersistence.save(defaults: defaults, key: key, zoom: 1.3, range: 0.5...3.0)
        XCTAssertEqual(ZoomPersistence.load(defaults: defaults, key: key, range: 0.5...3.0),
                       1.3, accuracy: 0.0001)
    }

    func testSaveNormalizesAndLoadConvergesBadValues() {
        let key = ZoomPersistence.defaultsKey(cpOrigin: "http://127.0.0.1:17500")
        ZoomPersistence.save(defaults: defaults, key: key, zoom: 99, range: 0.5...3.0)
        XCTAssertEqual(defaults.double(forKey: key), 3.0, "写入前 clamp 到上限")
        ZoomPersistence.save(defaults: defaults, key: key, zoom: .nan, range: 0.5...3.0)
        XCTAssertEqual(defaults.double(forKey: key), 1.0, "非有限值绝不落盘")

        defaults.set(0.01, forKey: key)
        XCTAssertEqual(ZoomPersistence.load(defaults: defaults, key: key, range: 0.5...3.0), 0.5)
        defaults.set("not-a-number", forKey: key)
        XCTAssertEqual(ZoomPersistence.load(defaults: defaults, key: key, range: 0.5...3.0), 1.0,
                       "类型不符 → 回 100%，绝不把坏数据灌进 pageZoom")
    }

    func testNormalizePureFunction() {
        XCTAssertEqual(ZoomPersistence.normalize(.infinity, range: 0.5...3.0), 1.0)
        XCTAssertEqual(ZoomPersistence.normalize(-.infinity, range: 0.5...3.0), 1.0)
        XCTAssertEqual(ZoomPersistence.normalize(2.5, range: 0.5...3.0), 2.5)
        XCTAssertEqual(ZoomPersistence.normalize(0.1, range: 0.5...3.0), 0.5)
    }

    // MARK: - 装配接线（源码锁步；控制器没有纯逻辑构造器可直测）

    func testMainWindowControllerRestoresAtSetupAndPersistsOnMenuActions() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/DSHChamber/MainWindowController.swift")
        let source = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(source.contains("webView.pageZoom = ZoomPersistence.load("),
                      "装配时必须恢复本 origin 的缩放（A3-3）")
        XCTAssertTrue(source.contains("persistPageZoom("),
                      "菜单缩放动作必须写回 UserDefaults")
        XCTAssertTrue(source.contains("ZoomPersistence.save(defaults: .standard"),
                      "写回必须落在标准 UserDefaults（读侧同一介质）")
    }
}
