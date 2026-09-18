//
//  NativeIdentityTests.swift
//  DSHChamberPocTests
//
//  T-1（2026-12 用户指令）：可见标识暂时标记为 dsh-chamber——窗口标题、
//  失败说明页文案、About（Info.plist CFBundleName）的锁步断言，防止
//  "poc"/"DSHChamberPoc" 再露到用户可见面；T-4 首帧白闪的底色 token 同处钉住。
//
import XCTest
@testable import DSHChamberPoc

final class NativeIdentityTests: XCTestCase {

    static let displayName = "dsh-chamber"

    private func macosSource(_ relative: String) throws -> String {
        // #filePath = <repo>/macos/Tests/DSHChamberPocTests/NativeIdentityTests.swift
        let macosDir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // DSHChamberPocTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // macos
        return try String(contentsOf: macosDir.appendingPathComponent(relative),
                          encoding: .utf8)
    }

    func testVisibleDisplayNameCarriesTheProductNameWithoutPoc() {
        XCTAssertEqual(MainWindowController.displayName, Self.displayName)
        XCTAssertFalse(MainWindowController.displayName.lowercased().contains("poc"),
                       "可见产品名不得出现 poc")
        XCTAssertFalse(MainWindowController.displayName.contains("DSHChamberPoc"))
    }

    func testWindowTitleIsDisplayNameConstantNotPoc() throws {
        let source = try macosSource("Sources/DSHChamberPoc/MainWindowController.swift")
        XCTAssertTrue(source.contains("window.title = Self.displayName"),
                      "窗口标题必须走 displayName 单源（T-1）")
        XCTAssertFalse(source.contains("window.title = \"dsh-chamber\""),
                       "标题不得再抄一份字面量（单源）")
        XCTAssertFalse(source.contains("window.title = \"dsh-chamber-native\""),
                       "旧标题 dsh-chamber-native 不得回归")
        XCTAssertFalse(source.contains("window.title = \"DSHChamberPoc\""))
    }

    func testFailurePageCopyCarriesNativeNameAndRealReason() {
        let sidecarFailure = "sidecar 启动失败（exit=70）：Error: listen EADDRINUSE: "
            + "address already in use 127.0.0.1:17500。已有另一个 dsh-chamber 实例在运行"
            + "（端口 127.0.0.1:17500 被占用），请先退出它再重试"
        let html = MainWindowController.failurePageHTML(
            hint: "sidecar 启动失败，控制面未能启动。",
            detail: "The resource could not be loaded because the App Transport Security "
                + "policy requires the use of a secure connection.",
            cpURL: "http://127.0.0.1:17500/",
            sidecarFailure: sidecarFailure)
        XCTAssertTrue(html.contains("<title>\(Self.displayName)</title>"),
                      "失败页文档标题必须是可见产品名")
        XCTAssertTrue(html.contains("无法加载 \(Self.displayName) 界面"),
                      "失败页 H2 必须是可见产品名")
        XCTAssertTrue(html.contains("EADDRINUSE") && html.contains("127.0.0.1:17500"),
                      "失败页必须带 sidecar 的真实原因（T-3）")
        XCTAssertFalse(html.lowercased().contains("poc"))
        XCTAssertFalse(html.contains("DSHChamberPoc"))
    }

    func testFailurePageEscapesInjectedText() {
        let html = MainWindowController.failurePageHTML(
            hint: "h",
            detail: "<script>alert(1)</script>",
            cpURL: "http://127.0.0.1:17500/",
            sidecarFailure: "a & b")
        XCTAssertFalse(html.contains("<script>"))
        XCTAssertTrue(html.contains("&lt;script&gt;"))
        XCTAssertTrue(html.contains("a &amp; b"))
    }

    func testInfoPlistTemplateBundleNameMatchesVisibleMarker() throws {
        let xml = try macosSource("Info.plist.template")
        let compact = xml.replacingOccurrences(of: "\\s+", with: " ",
                                               options: .regularExpression)
        XCTAssertTrue(compact.contains("<key>CFBundleName</key> <string>\(Self.displayName)</string>"),
                      "About 面板读 CFBundleName——必须与可见标记同源")
        XCTAssertFalse(compact.contains("<key>CFBundleName</key> <string>DSHChamberPoc</string>"))
    }

    func testWindowAndWebViewUseFrontendBackgroundToken() throws {
        // #0f1115 = rgb(15, 17, 21)：与 Electron backgroundColor 及前端骨架同值。
        XCTAssertEqual(MainWindowController.backgroundRed, 15.0 / 255.0, accuracy: 0.0001)
        XCTAssertEqual(MainWindowController.backgroundGreen, 17.0 / 255.0, accuracy: 0.0001)
        XCTAssertEqual(MainWindowController.backgroundBlue, 21.0 / 255.0, accuracy: 0.0001)
        let color = try XCTUnwrap(MainWindowController.windowBackgroundColor
            .usingColorSpace(.sRGB))
        XCTAssertEqual(color.redComponent, 15.0 / 255.0, accuracy: 0.0001)
        XCTAssertEqual(color.greenComponent, 17.0 / 255.0, accuracy: 0.0001)
        XCTAssertEqual(color.blueComponent, 21.0 / 255.0, accuracy: 0.0001)
        XCTAssertEqual(color.alphaComponent, 1.0, accuracy: 0.0001)

        let source = try macosSource("Sources/DSHChamberPoc/MainWindowController.swift")
        XCTAssertTrue(source.contains("window.backgroundColor = Self.windowBackgroundColor"),
                      "窗口底色必须设（T-4）")
        XCTAssertTrue(source.contains(
            "webView.underPageBackgroundColor = Self.windowBackgroundColor"))
        XCTAssertTrue(source.contains("setDrawsBackground:"),
                      "透明 webview 露出同色窗口底（T-4）")
    }
}
