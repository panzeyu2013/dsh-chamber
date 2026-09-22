//
//  WebPermissionPolicyTests.swift
//  DSHChamberTests
//
//  网页权限口径的锁步断言。Electron 只放行
//  `clipboard-sanitized-write`（`main.ts:3832-3834` 的 setPermissionRequestHandler/
//  setPermissionCheckHandler），其余权限请求全拒；WKWebView 在 macOS 只暴露
//  「媒体采集」这一类权限回调，其余类别没有可编程面——因此两侧有效的权限姿态
//  一致的关键就是：媒体采集必须**拒绝**，而不是弹框或默认放行。本文件把这条
//  钉在源码上（改动该决策即红）。
//
import XCTest
@testable import DSHChamber

final class WebPermissionPolicyTests: XCTestCase {
    private func mainWindowControllerSource() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // DSHChamberTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // macos
            .appendingPathComponent("Sources/DSHChamber/MainWindowController.swift")
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testMediaCaptureIsDeniedLikeElectronsPermissionPolicy() throws {
        let source = try mainWindowControllerSource()
        XCTAssertTrue(source.contains("requestMediaCapturePermissionFor"),
                      "媒体采集回调必须在（WKWebView 唯一暴露的权限面）")
        XCTAssertTrue(source.contains("decisionHandler(.deny)"),
                      "媒体采集必须拒绝（Electron 只放行 clipboard-sanitized-write）")
        XCTAssertTrue(source.contains("main.ts:3832-3834"),
                      "注释必须指回 Electron 的权限策略锚点")
    }
}
