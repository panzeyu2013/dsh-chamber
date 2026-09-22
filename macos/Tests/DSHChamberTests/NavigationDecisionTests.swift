//
//  NavigationDecisionTests.swift
//  DSHChamberTests
//
//  导航围栏的纯决策面——download（session 日志导出）优先于取消、
//  首载失败说明页的 about:blank 一次性放行、壳文档/同源非壳文档/外链三分类。
//
import XCTest
@testable import DSHChamber

final class NavigationDecisionTests: XCTestCase {
    private let origin = "http://127.0.0.1:17500"

    private func decide(_ raw: String,
                        shouldPerformDownload: Bool = false,
                        failurePagePending: Bool = false,
                        isMainFrame: Bool = true) -> MainWindowController.NavigationDecision {
        MainWindowController.navigationDecision(url: URL(string: raw),
                                                shouldPerformDownload: shouldPerformDownload,
                                                failurePagePending: failurePagePending,
                                                expectedOrigin: origin,
                                                isMainFrame: isMainFrame)
    }

    /// shouldPerformDownload 在围栏之前判定——同源非壳文档（session 导出
    /// /api/session.export?…）为 .download（不装入 webview）。
    func testShouldPerformDownloadBecomesDownload() {
        XCTAssertEqual(decide("http://127.0.0.1:17500/api/session.export?sessionId=x",
                              shouldPerformDownload: true), .download)
    }

    /// download 优先于自身围栏：同源非壳文档 / 外部 http(s) / 非 http scheme
    /// （blob 等）都转下载，绝不当文档装载。
    func testDownloadWinsForEveryOriginClass() {
        XCTAssertEqual(decide("http://127.0.0.1:17500/index.html", shouldPerformDownload: true),
                       .download, "壳文档 URL 带 download 属性也走下载")
        XCTAssertEqual(decide("https://evil.example/file.zip", shouldPerformDownload: true),
                       .download, "外链下载静默落盘下载目录（不装载、不开浏览器；与 Electron 默认下载同向）")
        XCTAssertEqual(decide("blob:http://127.0.0.1:17500/abc", shouldPerformDownload: true),
                       .download, "blob URL 导出（如有）同样转下载")
    }

    /// 失败说明页 loadHTMLString(baseURL:nil) 的 about:blank 一次性放行；
    /// 无标志时 about: 仍被拦截。
    func testFailurePageAboutBlankAllowedOnce() {
        XCTAssertEqual(decide("about:blank", failurePagePending: true), .allow)
        XCTAssertEqual(decide("about:blank", failurePagePending: false),
                       .cancel(reason: "非 http(s) scheme"))
    }

    /// 失败页门不放大到别的 scheme。
    func testFailurePageGateDoesNotAllowOtherSchemes() {
        XCTAssertEqual(decide("data:text/html,hi", failurePagePending: true),
                       .cancel(reason: "非 http(s) scheme"))
    }

    /// 壳文档放行 / 同源非壳文档取消 / 外部外链交系统 / mailto 交系统。
    func testOriginFenceCategories() {
        XCTAssertEqual(decide("http://127.0.0.1:17500/"), .allow)
        XCTAssertEqual(decide("HTTP://127.0.0.1:17500/"), .allow, "scheme 大小写不敏感")
        XCTAssertEqual(decide("http://127.0.0.1:17500/api/i/local/index.html"),
                       .cancel(reason: "同源非壳文档"))
        XCTAssertEqual(decide("https://example.com/docs"), .openExternally)
        XCTAssertEqual(decide("mailto:a@b.c"), .openExternally)
        XCTAssertEqual(decide("custom://x"), .cancel(reason: "非 http(s) scheme"))
    }

    func testMissingURLIsCancelled() {
        XCTAssertEqual(MainWindowController.navigationDecision(
            url: nil, shouldPerformDownload: false, failurePagePending: false,
            expectedOrigin: origin), .cancel(reason: "无 URL"))
    }

    // MARK: - blob 子 frame（文档预览）放行，主 frame 围栏不变

    /// shim 用户脚本仅主 frame（BridgeShimInjector.makeUserScript
    /// forMainFrameOnly=true），且消息围栏丢弃非主 frame 消息
    /// （MessageHandler.fence 的 isMainFrame 门）——因此随包文档预览插件的
    /// blob 子 frame（HTML/PDF/图片经 URL.createObjectURL）可以放行：该文档
    /// 拿不到桥。主 frame 的 blob 仍按原围栏取消。
    func testBlobSubframeAllowedButBlobMainFrameCancelled() {
        XCTAssertEqual(decide("blob:http://127.0.0.1:17500/abc", isMainFrame: false), .allow,
                       "文档预览的 blob 子 frame 必须放行（S-35）")
        XCTAssertEqual(decide("blob:http://127.0.0.1:17500/abc", isMainFrame: true),
                       .cancel(reason: "非 http(s) scheme"),
                       "blob 主 frame 仍必须取消（壳文档只允许 cp origin）")
        // targetFrame 未知（nil → 调用方按主 frame 最严处理）：保持取消。
        XCTAssertEqual(decide("blob:http://127.0.0.1:17500/abc"),
                       .cancel(reason: "非 http(s) scheme"),
                       "默认 isMainFrame=true = 未知按主 frame 最严围栏")
    }

    /// 预览插件只用 blob（vendor ui-sidebar-documentpreview：iframe src=blob、
    /// asset 经 blob 子资源）；about:blank/data: 不在放行之列——子 frame 一律
    /// 取消，主 frame 的 about:blank 仅经失败说明页的一次性门。
    func testNonBlobOpaqueSchemesStayCancelledInSubframes() {
        XCTAssertEqual(decide("data:text/html,hi", isMainFrame: false),
                       .cancel(reason: "非 http(s) scheme"))
        XCTAssertEqual(decide("about:blank", isMainFrame: false),
                       .cancel(reason: "非 http(s) scheme"))
        XCTAssertEqual(decide("about:blank", failurePagePending: true, isMainFrame: false), .allow,
                       "S-27 失败页一次性门与 frame 无关（about: 主 frame 加载说明页）")
    }

    /// 安全关键回归：同源非壳文档在任何 frame 都取消（绝不因是子 frame
    /// 而继承桥面）；外链在任何 frame 都交系统打开。
    func testSameOriginNonShellDocumentCancelledInEveryFrame() {
        let proxyHTML = "http://127.0.0.1:17500/api/i/local/index.html"
        XCTAssertEqual(decide(proxyHTML, isMainFrame: true), .cancel(reason: "同源非壳文档"))
        XCTAssertEqual(decide(proxyHTML, isMainFrame: false), .cancel(reason: "同源非壳文档"))

        XCTAssertEqual(decide("https://example.com/docs", isMainFrame: true), .openExternally)
        XCTAssertEqual(decide("https://example.com/docs", isMainFrame: false), .openExternally)
        XCTAssertEqual(decide("mailto:a@b.c", isMainFrame: false), .openExternally)
    }
}
