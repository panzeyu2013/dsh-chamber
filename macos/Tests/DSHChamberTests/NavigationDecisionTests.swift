//
//  NavigationDecisionTests.swift
//  DSHChamberTests
//
//  导航围栏的纯决策面——download（session 日志导出）优先于取消、首载失败说明页
//  的 about:blank 一次性放行、主 frame 的壳文档/同源非壳文档/外链三分类。
//  v2 §16.11（上游 ui-sidebar-browser iframe 对齐）在此之上把右栏浏览器 iframe 的
//  子 frame 分支放宽为「任意 http(s)」：
//    - 子 frame 的 http(s) 任意 host allow（含 https、公网、RFC1918、IPv6 字面量、
//      localhost/alias、同源非壳文档与壳文档 URL——iframe 里拿不到桥，见下）；
//    - 仍拒 credentials URL（userinfo）与非 web scheme（file:/javascript:/data:/
//      chrome:/ftp:/mailto:/自定义 scheme）；
//    - blob: 与 about:blank/about:srcdoc 子 frame 放行（文档预览/上游 iframe 初始
//      文档），子 frame 下载（action 级 shouldPerformDownload 与不可呈现响应）照旧
//      cancel（上游 sandbox 无 allow-downloads，下载/弹窗 deny 面不随放宽改变）；
//    - **主 frame 真值表不变**：壳文档 allow、同源非壳文档 cancel、其余 http(s)
//      交系统、非 web scheme cancel。
//  桥面不因 iframe 放宽而扩大：shim 只注入主 frame（BridgeShimInjector
//  forMainFrameOnly=true），消息围栏丢弃非主 frame 消息（MessageHandler.fence
//  的 isMainFrame 门），所以同源非壳文档在 iframe 里同样继承不到 shim/IPC。
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
    /// （blob 等）都转下载，绝不当文档装载。这是**主 frame** 的真值表。
    func testDownloadWinsForEveryOriginClass() {
        XCTAssertEqual(decide("http://127.0.0.1:17500/index.html", shouldPerformDownload: true),
                       .download, "壳文档 URL 带 download 属性也走下载")
        XCTAssertEqual(decide("https://evil.example/file.zip", shouldPerformDownload: true),
                       .download, "外链下载静默落盘下载目录（不装载、不开浏览器；与 Electron 默认下载同向）")
        XCTAssertEqual(decide("blob:http://127.0.0.1:17500/abc", shouldPerformDownload: true),
                       .download, "blob URL 导出（如有）同样转下载")
    }

    /// v2：子 frame 下载在主进程取消（design 28 §16.11）——右栏 iframe 采用上游
    /// sandbox（无 allow-downloads），绝不让远端页面的下载静默落盘（v1 行为）。
    func testSubframeDownloadIsCancelled() {
        let reason = "子 frame 下载"
        XCTAssertEqual(decide("http://127.0.0.1:17500/api/session.export?sessionId=x",
                              shouldPerformDownload: true, isMainFrame: false),
                       .cancel(reason: reason))
        XCTAssertEqual(decide("https://example.com/file.zip",
                              shouldPerformDownload: true, isMainFrame: false),
                       .cancel(reason: reason))
        XCTAssertEqual(decide("blob:http://127.0.0.1:17500/abc",
                              shouldPerformDownload: true, isMainFrame: false),
                       .cancel(reason: reason))
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

    /// 主 frame 的三分类：壳文档放行 / 同源非壳文档取消 / 其余 http(s) 交系统；
    /// mailto 交系统，非 http(s)/非 mailto cancel。
    func testMainFrameOriginFenceCategories() {
        XCTAssertEqual(decide("http://127.0.0.1:17500/"), .allow)
        XCTAssertEqual(decide("HTTP://127.0.0.1:17500/"), .allow, "scheme 大小写不敏感")
        XCTAssertEqual(decide("http://127.0.0.1:17500/api/i/local/index.html"),
                       .cancel(reason: "同源非壳文档"))
        XCTAssertEqual(decide("http://127.0.0.1:17500/?q=1"),
                       .cancel(reason: "同源非壳文档"), "同源带 query 同属非壳文档")
        XCTAssertEqual(decide("https://example.com/docs"), .openExternally)
        XCTAssertEqual(decide("http://127.0.0.2:5173/"), .openExternally,
                       "主 frame 导航到 alias host 维持 v1 外链语义")
        XCTAssertEqual(decide("mailto:a@b.c"), .openExternally)
        XCTAssertEqual(decide("custom://x"), .cancel(reason: "非 http(s) scheme"))
    }

    func testMissingURLIsCancelled() {
        XCTAssertEqual(MainWindowController.navigationDecision(
            url: nil, shouldPerformDownload: false, failurePagePending: false,
            expectedOrigin: origin), .cancel(reason: "无 URL"))
    }

    // MARK: - v2 §16.11：子 frame = 任意 http(s)

    /// 子 frame 的 http(s) 任意 host 放行：公网 https、任意端口/路径/query、
    /// RFC1918、IPv6 字面量、localhost/alias 均不再需要白名单（上游
    /// ui-sidebar-browser 的 iframe 就是用来浏览 web 的）。
    func testSubframeAllowsAnyHttpHost() {
        let allowed = [
            "https://example.com/",
            "https://example.com:8443/a?b=1#frag",
            "http://example.com/docs",
            "http://192.168.1.2/",
            "http://10.0.0.2:8080/remote",
            "http://[::1]:3000/",
            "http://127.0.0.1:3000/",
            "http://localhost:5173/",
            "https://127.0.0.254:443/",
            "http://127.0.0.2:5173/index.html",
        ]
        for raw in allowed {
            XCTAssertEqual(decide(raw, isMainFrame: false), .allow,
                           "右栏 iframe 必须放行任意 http(s)（\(raw)）")
        }
    }

    /// 子 frame 同源 URL 也不再按 origin 收紧——§16.11 覆盖 §16.8 的「任何 frame
    /// cancel」以对齐 Electron `isAllowedBrowserFrameUrl`（任意 http(s)）；桥面安全
    /// 由「shim 只注主 frame + 消息围栏丢弃非主 frame」保证，不依赖这条 origin 规则。
    /// 服务端的 frame-ancestors 'none'/XFO DENY 仍在响应侧兜底应用自身文档。
    func testSubframeAllowsSameOriginDocumentsWithoutBridge() {
        let proxyHTML = "http://127.0.0.1:17500/api/i/local/index.html"
        XCTAssertEqual(decide(proxyHTML, isMainFrame: false), .allow,
                       "iframe 里的同源非壳文档拿不到桥（shim/围栏均主 frame 限定）")
        XCTAssertEqual(decide("http://127.0.0.1:17500/", isMainFrame: false), .allow,
                       "壳文档 URL 在 iframe 里也只是普通 http(s) 页面")
        // 主 frame 的安全面不变：同源非壳文档仍然 cancel（绝不让主文档继承 shim）。
        XCTAssertEqual(decide(proxyHTML, isMainFrame: true), .cancel(reason: "同源非壳文档"))
        XCTAssertEqual(decide("http://127.0.0.1:17500/", isMainFrame: true), .allow,
                       "主 frame 壳文档仍放行")
    }

    /// 子 frame 仍拒 credentials（userinfo）——与 Electron isAllowedBrowserFrameUrl 的
    /// username/password 判定同义：壳从不构造或接受凭据型 frame target。
    func testSubframeRejectsCredentialedURLs() {
        let reason = "子 frame 带凭据 URL"
        let rejected = [
            "http://user:pass@127.0.0.1:5173/",
            "https://user@example.com/",
            "https://:pass@example.com/",
            "http://user:pass@example.com:8443/x",
        ]
        for raw in rejected {
            XCTAssertEqual(decide(raw, isMainFrame: false), .cancel(reason: reason),
                           "带凭据 URL 必须拒绝（\(raw)）")
        }
        XCTAssertTrue(MainWindowController.browserFrameURLCarriesCredentials(
            URL(string: "https://user@example.com/")!))
        XCTAssertFalse(MainWindowController.browserFrameURLCarriesCredentials(
            URL(string: "https://example.com/")!))
    }

    /// 子 frame 的非 web scheme 拒绝（与 Electron 子 frame 门「仍拒非 web scheme」
    /// 同义）：file:/javascript:/data:/chrome:/ftp:/mailto:/自定义 scheme。
    func testSubframeRejectsNonWebSchemes() {
        let reason = "非 http(s) scheme"
        for raw in ["file:///etc/passwd", "javascript:alert(1)",
                    "data:text/html,hi", "chrome://settings",
                    "ftp://example.com/", "mailto:a@b.c", "custom://x"] {
            guard URL(string: raw) != nil else {
                XCTFail("测试用例 URL 无法解析：\(raw)")
                continue
            }
            XCTAssertEqual(decide(raw, isMainFrame: false), .cancel(reason: reason),
                           "非 web scheme 子 frame 必须拒绝（\(raw)）")
        }
        // 主 frame 对应真值表不变：mailto 交系统、其余非 web scheme cancel。
        XCTAssertEqual(decide("mailto:a@b.c", isMainFrame: true), .openExternally)
        XCTAssertEqual(decide("file:///etc/passwd", isMainFrame: true),
                       .cancel(reason: reason))
    }

    /// blob: 与 about:blank/about:srcdoc 子 frame 保留放行（文档预览与上游 iframe
    /// 初始文档）；其余 about:（如 about:config）仍取消；主 frame 的 blob/about: 仍
    /// 按主 frame 围栏取消（about:blank 只经失败说明页门）。
    func testSubframeBlobAndAboutCarriersAllowed() {
        XCTAssertEqual(decide("about:blank", isMainFrame: false), .allow,
                       "空 iframe 的初始文档必须放行")
        XCTAssertEqual(decide("about:blank#frag", isMainFrame: false), .allow)
        XCTAssertEqual(decide("about:srcdoc", isMainFrame: false), .allow,
                       "<iframe srcdoc> 的文档 URL（与 Electron about 分支一致）")
        XCTAssertEqual(decide("about:config", isMainFrame: false),
                       .cancel(reason: "非 http(s) scheme"))
        XCTAssertEqual(decide("blob:http://127.0.0.1:17500/abc", isMainFrame: false), .allow,
                       "文档预览的 blob 子 frame 必须放行（S-35）")
        XCTAssertEqual(decide("blob:https://example.com/uuid", isMainFrame: false), .allow,
                       "浏览器 iframe 里的 blob 页面同样放行")
        // 主 frame 围栏不变。
        XCTAssertEqual(decide("blob:http://127.0.0.1:17500/abc", isMainFrame: true),
                       .cancel(reason: "非 http(s) scheme"))
        XCTAssertEqual(decide("about:blank", isMainFrame: true),
                       .cancel(reason: "非 http(s) scheme"))
        // targetFrame 未知（nil → 调用方按主 frame 最严处理）：保持取消。
        XCTAssertEqual(decide("blob:http://127.0.0.1:17500/abc"),
                       .cancel(reason: "非 http(s) scheme"),
                       "默认 isMainFrame=true = 未知按主 frame 最严围栏")
    }

    // MARK: - 响应级与 target=_blank（v2；下载/弹窗 deny 面不随 iframe 放宽）

    /// 响应级下载：主 frame 不可呈现响应转下载（session 导出等）；子 frame 一律
    /// cancel（design 28 §16.11——iframe 内的下载不静默落盘）。
    func testNavigationResponseDecision() {
        XCTAssertEqual(MainWindowController.navigationResponseDecision(
            canShowMIMEType: true, isForMainFrame: true), .allow)
        XCTAssertEqual(MainWindowController.navigationResponseDecision(
            canShowMIMEType: true, isForMainFrame: false), .allow)
        XCTAssertEqual(MainWindowController.navigationResponseDecision(
            canShowMIMEType: false, isForMainFrame: true), .download)
        XCTAssertEqual(MainWindowController.navigationResponseDecision(
            canShowMIMEType: false, isForMainFrame: false), .cancel(reason: "子 frame 下载"))
    }

    /// target=_blank 外链腿（design 28 §16.11：弹窗 deny 面不变）：只有主文档发起
    /// 的外链才交系统打开；子 frame 的新窗请求一律拒绝。
    func testNewWindowExternalOpenOnlyFromMainDocument() {
        XCTAssertTrue(MainWindowController.shouldOpenNewWindowExternally(
            url: "https://example.com/", sourceIsMainFrame: true, expectedOrigin: origin))
        XCTAssertTrue(MainWindowController.shouldOpenNewWindowExternally(
            url: "mailto:a@b.c", sourceIsMainFrame: true, expectedOrigin: origin))
        XCTAssertFalse(MainWindowController.shouldOpenNewWindowExternally(
            url: "http://127.0.0.1:17500/", sourceIsMainFrame: true, expectedOrigin: origin),
            "同源 URL 不是外链（不重复开浏览器）")
        XCTAssertFalse(MainWindowController.shouldOpenNewWindowExternally(
            url: "custom://x", sourceIsMainFrame: true, expectedOrigin: origin))
        XCTAssertFalse(MainWindowController.shouldOpenNewWindowExternally(
            url: nil, sourceIsMainFrame: true, expectedOrigin: origin))
        XCTAssertFalse(MainWindowController.shouldOpenNewWindowExternally(
            url: "https://example.com/", sourceIsMainFrame: false, expectedOrigin: origin),
            "子 frame 不得打开系统浏览器（弹窗 deny 面不变）")
        XCTAssertFalse(MainWindowController.shouldOpenNewWindowExternally(
            url: "mailto:a@b.c", sourceIsMainFrame: false, expectedOrigin: origin),
            "子 frame 不得触发系统邮件客户端")
    }
}
