//
//  PageFactsReconcileGuardTests.swift
//  DSHChamberTests
//
//  X1（2026-12 二轮独立复核）+ Z1/Z2（二轮收口）回归：页面事实载波的文档面门
//  只接受「主 frame + 同源」（scheme/host/port 与 expectedOrigin 完全相同），
//  **不**限定 pathname=/ 与 query——页面采用 history.pushState/replaceState 后
//  （url 变为 /api/i/1 等）事实通道不得静默断掉。失败说明页
//  （showLoadFailurePage 的 loadHTMLString(baseURL: nil) → about:blank）与
//  data:/file:/blob:/空 url/跨源一律不得 ingest——否则失败页快照
//  {lang:"", dark:false} 会在暗系统上把 pageIsDark 污染成 false（空 lang 不构成
//  语言事实，但 dark 变化仍生效），强制 .aqua 露浅底并把污染值落盘成 last-known。
//
//  W4a（2026-12 三轮独立复核，真实 WKWebView 实测）：同源 blob:/about:srcdoc 子 frame
//  调 parent.document.write 可改写主 frame 文档；改写后 frameInfo.request.url 仍是
//  过期的旧主 frame URL，而 message.webView.url / location.href / document.URL 已变成
//  blob:。事实通道的 URL 来源因此改为与 A 桥一致：webView.url 优先、frameInfo 仅兜底。
//
import XCTest
@testable import DSHChamber

final class PageFactsReconcileGuardTests: XCTestCase {

    private let origin = "http://127.0.0.1:17520"

    /// 源码锁步用（与 ShellLogTests.source 同形）。
    private func source(_ relative: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent(relative)
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// 真值表（X1 对账路径 acceptsReconcile）：放行 = 同源根路径、authority-only、
    /// 带 query、hash、/api/i/1（pushState 场景）、host 大小写/默认端口/IPv6 等价；
    /// 拒绝 = about:blank、data:/file:/blob:、空 url、空 expectedOrigin、不同端口、
    /// 不同 host、子域、https、userinfo。
    func testAcceptsReconcileTruthTable() {
        // —— 放行：同源（path/query/fragment 均不参与判定）——
        XCTAssertTrue(MainWindowController.acceptsReconcile(
            url: "http://127.0.0.1:17520/", expectedOrigin: origin))
        // URLComponents 对 authority-only URL 给空 path，与根路径等价。
        XCTAssertTrue(MainWindowController.acceptsReconcile(
            url: "http://127.0.0.1:17520", expectedOrigin: origin))
        // 同源带 query：本通道不再要求壳文档的「无 query」。
        XCTAssertTrue(MainWindowController.acceptsReconcile(
            url: "http://127.0.0.1:17520/?x=1", expectedOrigin: origin))
        XCTAssertTrue(MainWindowController.acceptsReconcile(
            url: "http://127.0.0.1:17520/?x=1#y", expectedOrigin: origin))
        // hash 路由。
        XCTAssertTrue(MainWindowController.acceptsReconcile(
            url: "http://127.0.0.1:17520/#/settings", expectedOrigin: origin))
        // pushState/replaceState 场景（二轮实测：frameInfo.request.url 随 history API
        // 变化；旧壳文档门在此静默断链）。
        XCTAssertTrue(MainWindowController.acceptsReconcile(
            url: "http://127.0.0.1:17520/api/i/1", expectedOrigin: origin))
        XCTAssertTrue(MainWindowController.acceptsReconcile(
            url: "http://127.0.0.1:17520/api/i/1?tab=x#top", expectedOrigin: origin))
        // host/scheme 大小写折叠后比较（URLComponents 解析，非字符串前缀）。
        XCTAssertTrue(MainWindowController.acceptsReconcile(
            url: "http://LOCALHOST:17520/api/i/1", expectedOrigin: "HTTP://LocalHost:17520"))
        // 默认端口折叠（WHATWG：http 缺省 ≡ :80），且 path 任意。
        XCTAssertTrue(MainWindowController.acceptsReconcile(
            url: "http://127.0.0.1:80/api/i/1", expectedOrigin: "http://127.0.0.1"))
        XCTAssertTrue(MainWindowController.acceptsReconcile(
            url: "http://127.0.0.1/", expectedOrigin: "http://127.0.0.1:80"))
        // IPv6 字面量（URL.host 去掉方括号，两侧同形比较）。
        XCTAssertTrue(MainWindowController.acceptsReconcile(
            url: "http://[::1]:17520/api/i/1?x=1", expectedOrigin: "http://[::1]:17520"))

        // —— 拒绝：失败页与无效 url ——
        XCTAssertFalse(MainWindowController.acceptsReconcile(
            url: "about:blank", expectedOrigin: origin))
        XCTAssertFalse(MainWindowController.acceptsReconcile(url: nil, expectedOrigin: origin))
        XCTAssertFalse(MainWindowController.acceptsReconcile(url: "", expectedOrigin: origin))
        XCTAssertFalse(MainWindowController.acceptsReconcile(
            url: "not a url", expectedOrigin: origin))

        // —— 拒绝：无 http(s) scheme+host 三元组的其它 scheme ——
        XCTAssertFalse(MainWindowController.acceptsReconcile(
            url: "data:text/html;base64,PGh0bWw+", expectedOrigin: origin))
        XCTAssertFalse(MainWindowController.acceptsReconcile(
            url: "file:///Users/x/index.html", expectedOrigin: origin))
        XCTAssertFalse(MainWindowController.acceptsReconcile(
            url: "blob:http://127.0.0.1:17520/0f1e", expectedOrigin: origin))

        // —— 拒绝：跨源（端口 / host / 子域 / https）——
        XCTAssertFalse(MainWindowController.acceptsReconcile(
            url: "http://127.0.0.1:17521/", expectedOrigin: origin))
        XCTAssertFalse(MainWindowController.acceptsReconcile(
            url: "http://localhost:17520/", expectedOrigin: origin))
        XCTAssertFalse(MainWindowController.acceptsReconcile(
            url: "http://sub.127.0.0.1:17520/", expectedOrigin: origin))
        XCTAssertFalse(MainWindowController.acceptsReconcile(
            url: "https://127.0.0.1:17520/", expectedOrigin: origin))
        XCTAssertFalse(MainWindowController.acceptsReconcile(
            url: "http://127.0.0.1:17520/", expectedOrigin: "https://127.0.0.1:17520"))
        // userinfo：同源以无凭据 URL 为前提，一律拒绝。
        XCTAssertFalse(MainWindowController.acceptsReconcile(
            url: "http://evil@127.0.0.1:17520/api/i/1", expectedOrigin: origin))
        XCTAssertFalse(MainWindowController.acceptsReconcile(
            url: "http://evil:pass@127.0.0.1:17520/", expectedOrigin: origin))

        // —— 拒绝：expectedOrigin 缺失/为空（cpOrigin 解析失败）→ fail closed ——
        XCTAssertFalse(MainWindowController.acceptsReconcile(
            url: "http://127.0.0.1:17520/", expectedOrigin: nil))
        XCTAssertFalse(MainWindowController.acceptsReconcile(
            url: "http://127.0.0.1:17520/", expectedOrigin: ""))
        XCTAssertFalse(MainWindowController.acceptsReconcile(url: nil, expectedOrigin: nil))
    }

    /// 「为什么门必须在 ingest 前拦截」的 Store 契约锁步：失败页快照即使到达
    /// Store 也有真实副作用——空 lang 保留语言事实，dark:false 却会改写主题
    /// 事实并触发落盘（正是 X1 的暗系统污染路径）。
    func testFailurePageSnapshotWouldPolluteDarkFactIfIngested() {
        let suiteName = "PageFactsReconcileGuardTests"
        let suite = UserDefaults(suiteName: suiteName)!
        suite.removePersistentDomain(forName: suiteName)
        defer { suite.removePersistentDomain(forName: suiteName) }
        let store = ShellPageFactsStore(defaults: suite)
        XCTAssertTrue(store.ingest(["lang": "zh", "dark": true, "revision": 1]))
        // 失败页/about:blank 快照：lang 空 → 语言事实保留 zh；
        // dark false → 主题事实被改写（因此必须在 ingest 前被 acceptsReconcile 拦下）。
        XCTAssertTrue(store.ingest(["lang": "", "dark": false, "revision": 0]))
        XCTAssertEqual(store.current?.language, .zh)
        XCTAssertEqual(store.current?.pageIsDark, false)
    }

    /// Z1 锁步：失败页 url（loadHTMLString(baseURL: nil) → about:blank）在两条路径
    /// 上都被门拒绝，因此对账回调/消息回调都在 ingest 之前返回——失败页事实绝不
    /// 会触及 Store（与上面的真实副作用测试成对：一条证「进了会污染」，一条证
    /// 「根本进不去」）。
    func testFailurePageUrlIsRejectedByBothGates() {
        XCTAssertFalse(MainWindowController.acceptsReconcile(
            url: "about:blank", expectedOrigin: origin))
        XCTAssertFalse(ShellPageFactsMessageHandler.accepts(
            messageName: ShellPageFactsScript.messageName, isMainFrame: true,
            url: "about:blank", expectedOrigin: origin))
    }

    /// W4a（2026-12 三轮独立复核，真实 WKWebView 实测）：同源 blob:/about:srcdoc 子 frame
    /// 调 parent.document.write 改写主 frame 文档后，script message 的
    /// frameInfo.request.url 仍是**过期的旧主 frame URL**，而 webView.url / location.href /
    /// document.URL 已变成 blob:。门必须以 webView.url 为准——两者值不同时，陈旧 frameInfo
    /// 说了不算（若以 frameInfo 为准，本用例的 blob: 改写会被放行）。
    func testHandlerPrefersWebViewURLOverStaleFrameRequestURL() {
        let name = ShellPageFactsScript.messageName
        let staleShellURL = "http://127.0.0.1:17520/"

        // ① 改写场景：frameInfo 仍是旧壳 URL（看起来可信），webView.url 已成 blob: → 拒。
        XCTAssertFalse(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true,
            webViewURL: "blob:http://127.0.0.1:17520/0f1e",
            frameRequestURL: staleShellURL,
            expectedOrigin: origin))

        // ② 取值规则：webView.url 非 nil 即唯一来源，frameInfo 不参与判定。
        XCTAssertEqual(MainWindowController.factsDocumentURL(
            webViewURL: staleShellURL, frameRequestURL: "http://169.254.169.254/latest"),
                       staleShellURL)
        XCTAssertTrue(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true,
            webViewURL: staleShellURL,
            frameRequestURL: "http://169.254.169.254/latest",
            expectedOrigin: origin))

        // ③ webView 缺席（进程终止/测试桩）才退回 frameInfo.request.url 兜底。
        XCTAssertNil(MainWindowController.factsDocumentURL(
            webViewURL: nil, frameRequestURL: nil))
        XCTAssertTrue(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true,
            webViewURL: nil, frameRequestURL: staleShellURL, expectedOrigin: origin))

        // ④ webView.url = 失败页 about:blank，frameInfo 残留旧壳 URL → 仍拒（fail closed）。
        XCTAssertFalse(ShellPageFactsMessageHandler.accepts(
            messageName: name, isMainFrame: true,
            webViewURL: "about:blank", frameRequestURL: staleShellURL,
            expectedOrigin: origin))
    }

    /// W4a 迁移的 pushState 回归锁步：URL 来源换成 webView.url 后，同源非根路径
    /// （/api/i/1?x=1#f）仍放行——旧壳文档门（要求 pathname=/ 且无 query）在此
    /// 静默断链的正是这条。
    func testPushStateSameOriginNonRootURLStillAcceptedFromWebViewURL() {
        XCTAssertTrue(ShellPageFactsMessageHandler.accepts(
            messageName: ShellPageFactsScript.messageName, isMainFrame: true,
            webViewURL: "http://127.0.0.1:17520/api/i/1?x=1#f",
            frameRequestURL: "http://127.0.0.1:17520/",
            expectedOrigin: origin))
        // 对账路径同 URL 同结果（两路共用 isSameOriginDocument）。
        XCTAssertTrue(MainWindowController.acceptsReconcile(
            url: "http://127.0.0.1:17520/api/i/1?x=1#f", expectedOrigin: origin))
    }

    /// W4a 接线锁步（纯函数用例证明判定，本条证明生产 handler 真的把 webView.url
    /// 作为主来源传入）：旧顺序（frameInfo.request.url 优先）必须已被移除。
    func testHandlerProductionPathWiresWebViewURLFirst() throws {
        let controllerSource = try source("Sources/DSHChamber/MainWindowController.swift")
        XCTAssertTrue(controllerSource.contains(
            "webViewURL: message.webView?.url?.absoluteString"),
            "生产 handler 必须以 message.webView?.url 为主来源")
        XCTAssertTrue(controllerSource.contains(
            "frameRequestURL: message.frameInfo.request.url?.absoluteString"),
            "frameInfo.request.url 只能作兜底来源传入")
        XCTAssertFalse(controllerSource.contains(
            "let url = message.frameInfo.request.url?.absoluteString"),
            "旧顺序（frameInfo 优先）必须已被移除")
    }

    /// Z2：lang 的纯防御上限——阈值是**字面量 256**，超界字符串一律忽略、保留
    /// 旧值、不构成事实；合法长标签（BCP-47 全形态）与边界值语义不变。
    /// 第三轮 review 修正：旧用例的边界从常量自身导出（maxLangLength ± 1），把常量
    /// 改成 8 仍绿——阈值与"合法标签不被误伤"现在都用字面量钉住。
    func testStoreIgnoresOverlongLang() {
        // 阈值钉死：任何合法标签（如 zh-Hant-TW，10 字符）都远在界内。
        // 若确有理由调整阈值，必须同时改本字面量并在此说明——有意变更会被强制同步。
        XCTAssertEqual(ShellPageFactsStore.maxLangLength, 256,
                       "maxLangLength 的设计值是 256（Z2）；改阈值必须同步本断言与注释")

        let suiteName = "PageFactsReconcileGuardTests.langCap"
        let freshSuiteName = "PageFactsReconcileGuardTests.langCap.fresh"
        let suite = UserDefaults(suiteName: suiteName)!
        let freshSuite = UserDefaults(suiteName: freshSuiteName)!
        suite.removePersistentDomain(forName: suiteName)
        freshSuite.removePersistentDomain(forName: freshSuiteName)
        defer {
            suite.removePersistentDomain(forName: suiteName)
            freshSuite.removePersistentDomain(forName: freshSuiteName)
        }

        let store = ShellPageFactsStore(defaults: suite)
        XCTAssertTrue(store.ingest(["lang": "en", "dark": true, "revision": 1]))
        XCTAssertEqual(store.current?.language, .en)

        // 合法长标签（zh-Hant-TW，10 字符）必须被接受并解析为 zh：阈值只作防御闸，
        // 绝不误伤真实标签（阈值被改小到标签长度以内时这里就红）。
        XCTAssertTrue(store.ingest(["lang": "zh-Hant-TW", "dark": true, "revision": 2]),
                      "界内合法标签不得被忽略")
        XCTAssertEqual(store.current?.language, .zh)
        XCTAssertEqual(store.current?.revision, 2)

        // 边界：恰好 256（字面量阈值）仍在界内 → 按非 zh 族解析为 en。
        XCTAssertTrue(store.ingest(["lang": String(repeating: "e", count: 256),
                                    "dark": true, "revision": 3]),
                      "恰好 256 字符仍在界内")
        XCTAssertEqual(store.current?.language, .en)
        XCTAssertEqual(store.current?.revision, 3)

        // 超界 1 字符（257）→ 忽略：语言事实保留 en，整条上报不产生事实变化。
        XCTAssertFalse(store.ingest(["lang": String(repeating: "x", count: 257),
                                     "dark": true, "revision": 4]))
        XCTAssertEqual(store.current?.language, .en)
        XCTAssertEqual(store.current?.revision, 3)

        // 安全审查实测可抵达的 5 MiB lang 同样忽略（不构成事实、不崩）。
        let huge = String(repeating: "a", count: 5 * 1024 * 1024)
        XCTAssertFalse(store.ingest(["lang": huge, "dark": true, "revision": 5]))
        XCTAssertEqual(store.current?.language, .en)
        XCTAssertEqual(store.current?.pageIsDark, true)
        XCTAssertEqual(store.current?.revision, 3)

        // 无旧值时超长 lang 也不得凭空造出语言事实（只有 dark 不足以构成整条事实）。
        let fresh = ShellPageFactsStore(defaults: freshSuite)
        XCTAssertFalse(fresh.ingest(["lang": huge, "dark": false, "revision": 1]))
        XCTAssertNil(fresh.current)
    }
}
