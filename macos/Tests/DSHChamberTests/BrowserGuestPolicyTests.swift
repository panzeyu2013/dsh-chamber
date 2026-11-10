//
//  BrowserGuestPolicyTests.swift — 右栏浏览器 v3 纯决策单测（design 28 v3 §4.3/§5）
//
import Foundation
import XCTest
@testable import DSHChamber

final class BrowserGuestPolicyTests: XCTestCase {
    private let origin = "http://127.0.0.1:17520"

    private func outcome(_ raw: String, isMainFrame: Bool = true,
                         shouldPerformDownload: Bool = false, mayForward: Bool = false)
        -> BrowserGuestNavigationOutcome {
        BrowserGuestPolicy.navigationOutcome(url: URL(string: raw), isMainFrame: isMainFrame,
                                             shouldPerformDownload: shouldPerformDownload,
                                             controlPlaneOrigin: origin, mayForward: mayForward)
    }

    func testMainFrameAllowsPlainHttp() {
        XCTAssertEqual(outcome("https://example.com/"), .allow)
        XCTAssertEqual(outcome("http://127.0.0.1:3000/x"), .allow)
        XCTAssertEqual(outcome("http://127.0.0.2:5173/"), .allow)
        XCTAssertEqual(outcome("http://localhost:8080/"), .allow)
        XCTAssertEqual(outcome("about:blank"), .allow)
    }

    func testMainFrameRejectsAppHostAndCredentialsAndForeignSchemes() {
        XCTAssertEqual(outcome("http://127.0.0.1:17520/"), .cancel(reason: "app-host"))
        XCTAssertEqual(outcome("http://localhost:17520/api"), .cancel(reason: "app-host"))
        XCTAssertEqual(outcome("http://u:p@example.com/"), .cancel(reason: "带凭据 URL"))
        XCTAssertEqual(outcome("file:///etc/passwd"), .cancel(reason: "主 frame 非 http(s)"))
        XCTAssertEqual(outcome("javascript:alert(1)"), .cancel(reason: "主 frame 非 http(s)"))
        XCTAssertEqual(outcome("mailto:a@b.c"), .cancel(reason: "主 frame 非 http(s)"))
        XCTAssertEqual(BrowserGuestPolicy.navigationOutcome(url: nil, isMainFrame: true,
                                                           shouldPerformDownload: false,
                                                           controlPlaneOrigin: origin,
                                                           mayForward: false),
                       .cancel(reason: "无 URL"))
    }

    func testDownloadsAreNeverAllowed() {
        XCTAssertEqual(outcome("https://example.com/a.zip", shouldPerformDownload: true),
                       .cancel(reason: "guest 不支持下载"))
        // response 级不可呈现：由 controller 直接 cancel（policy 只负责 action 级）。
    }

    func testSubframeAllowsBlobAndDataButNotNonWeb() {
        XCTAssertEqual(outcome("https://cdn.example.com/x", isMainFrame: false), .allow)
        XCTAssertEqual(outcome("blob:http://127.0.0.1:17520/abc", isMainFrame: false), .allow)
        XCTAssertEqual(outcome("data:text/html,hi", isMainFrame: false), .allow)
        XCTAssertEqual(outcome("file:///etc/passwd", isMainFrame: false), .cancel(reason: "子帧非 http(s)"))
        // 子帧不参与 forward 协商（§2.10：子帧不可拦）。
        XCTAssertEqual(outcome("http://127.0.0.1:3000/", isMainFrame: false, mayForward: true), .allow)
    }

    func testForwardNeededOnlyForLoopbackOnForwardableSource() {
        XCTAssertEqual(outcome("http://127.0.0.1:3000/", mayForward: true), .forwardNeeded)
        XCTAssertEqual(outcome("http://localhost:3000/", mayForward: true), .forwardNeeded)
        XCTAssertEqual(outcome("http://127.0.0.1:3000/", mayForward: false), .allow)
        XCTAssertEqual(outcome("https://example.com/", mayForward: true), .allow)
        XCTAssertFalse(BrowserGuestPolicy.needsForwardNegotiation(url: URL(string: "https://example.com/"), mayForward: true))
        XCTAssertTrue(BrowserGuestPolicy.needsForwardNegotiation(url: URL(string: "http://127.0.0.1:9/"), mayForward: true))
    }

    func testAppHostDefinitionOnlyBlocksControlPlanePort() {
        XCTAssertTrue(BrowserGuestPolicy.isApplicationHost(URL(string: "http://127.0.0.1:17520/")!, controlPlaneOrigin: origin))
        XCTAssertTrue(BrowserGuestPolicy.isApplicationHost(URL(string: "http://localhost:17520/")!, controlPlaneOrigin: origin))
        XCTAssertFalse(BrowserGuestPolicy.isApplicationHost(URL(string: "http://127.0.0.1:17521/")!, controlPlaneOrigin: origin))
        XCTAssertFalse(BrowserGuestPolicy.isApplicationHost(URL(string: "http://127.0.0.2:17520/")!, controlPlaneOrigin: origin))
        XCTAssertFalse(BrowserGuestPolicy.isApplicationHost(URL(string: "https://example.com:17520/")!, controlPlaneOrigin: origin))
    }

    func testNewWindowOutcome() {
        XCTAssertEqual(BrowserGuestPolicy.newWindowOutcome(url: URL(string: "https://example.com/"),
                                                           method: "GET", controlPlaneOrigin: origin), .openRequested)
        XCTAssertEqual(BrowserGuestPolicy.newWindowOutcome(url: URL(string: "https://example.com/"),
                                                           method: "POST", controlPlaneOrigin: origin), .drop)
        XCTAssertEqual(BrowserGuestPolicy.newWindowOutcome(url: URL(string: "http://127.0.0.1:17520/"),
                                                           method: "GET", controlPlaneOrigin: origin), .drop)
        XCTAssertEqual(BrowserGuestPolicy.newWindowOutcome(url: nil, method: "GET",
                                                           controlPlaneOrigin: origin), .drop)
    }

    func testChallengeOutcome() {
        XCTAssertEqual(BrowserGuestPolicy.challengeOutcome(authenticationMethod: NSURLAuthenticationMethodServerTrust),
                       .performDefaultHandling)
        XCTAssertEqual(BrowserGuestPolicy.challengeOutcome(authenticationMethod: NSURLAuthenticationMethodHTTPBasic),
                       .cancelAuthentication)
        XCTAssertEqual(BrowserGuestPolicy.challengeOutcome(authenticationMethod: NSURLAuthenticationMethodNTLM),
                       .cancelAuthentication)
        XCTAssertEqual(BrowserGuestPolicy.challengeOutcome(authenticationMethod: "unknown"),
                       .cancelAuthentication)
    }

    func testFailureProjectionSkipsCancellation() {
        XCTAssertNil(BrowserGuestPolicy.failureProjection(code: -999, description: "cancelled"))
        XCTAssertEqual(BrowserGuestPolicy.failureProjection(code: -1202, description: "cert"),
                       BrowserGuestFailureProjection(code: -1202, description: "cert"))
        XCTAssertEqual(BrowserGuestPolicy.failureProjection(code: -1004, description: "refused")?.code, -1004)
    }

    func testRectConversionAndClamp() {
        let frame = BrowserGuestFrame(x: 100, y: 50, width: 400, height: 300)
        // D5：points = cssPx * pageZoom（不是折半）。pageZoom 2 + CSS 100 → 200 points。
        XCTAssertEqual(BrowserGuestPolicy.rectInPoints(frame: frame, pageZoom: 2,
                                                       containerSize: CGSize(width: 1280, height: 772)),
                       CGRect(x: 200, y: 100, width: 800, height: 600))
        // pageZoom 2 下 100 CSS px 必须投影成 200 points（D5 的最小回归断言）。
        XCTAssertEqual(BrowserGuestPolicy.rectInPoints(frame: BrowserGuestFrame(x: 100, y: 0,
                                                                                width: 100, height: 100),
                                                       pageZoom: 2,
                                                       containerSize: CGSize(width: 1280, height: 772)).minX,
                       200)
        // 越界裁剪到容器；负原点被裁。
        XCTAssertEqual(BrowserGuestPolicy.rectInPoints(frame: BrowserGuestFrame(x: -10, y: -10, width: 100, height: 100),
                                                       pageZoom: 1,
                                                       containerSize: CGSize(width: 50, height: 50)),
                       CGRect(x: 0, y: 0, width: 50, height: 50))
        // 0 面积 / 非法 zoom → 空 rect（隐藏，不建命中面）。
        XCTAssertEqual(BrowserGuestPolicy.rectInPoints(frame: BrowserGuestFrame(),
                                                       pageZoom: 0,
                                                       containerSize: CGSize(width: 100, height: 100)), .zero)
    }

    func testContentRuleListOnlyBlocksControlPlaneOrigin() {
        let json = BrowserGuestContentRules.json(controlPlanePort: 17520)
        // D2：WKContentRuleListStore 只接受顶层 JSON 数组（无 {rules,version} 包装）。
        guard let data = json.data(using: .utf8),
              let rules = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return XCTFail("content rule JSON 顶层必须是数组（D2），实际：\(json.prefix(120))")
        }
        XCTAssertFalse(rules.isEmpty)
        XCTAssertTrue(json.contains(#""type":"block""#))
        XCTAssertTrue(json.contains("17520"))
        XCTAssertFalse(json.contains("17521"))
        // 只出现 loopback 主机与 cp 端口，不出现通配 host（D2 允许 url-filter 用 * 量词，
        // 这里锁的是「host 段不得写成通配」）。
        XCTAssertFalse(json.contains("*://"))
        XCTAssertFalse(json.contains("://*"))
        // 端口非法 → 空数组（不误 block；调用方 fail-closed）。
        let empty = BrowserGuestContentRules.json(controlPlanePort: 0)
        guard let emptyData = empty.data(using: .utf8),
              let emptyRules = try? JSONSerialization.jsonObject(with: emptyData) as? [Any] else {
            return XCTFail("端口非法的 JSON 必须是可解析的顶层数组，实际：\(empty)")
        }
        XCTAssertTrue(emptyRules.isEmpty, "端口非法必须输出空 JSON 数组，实际：\(empty)")
    }
}

// MARK: - E4b 收敛项（R4/R7/W-20）

extension BrowserGuestPolicyTests {
    func testForwardAliasHostRange() {
        XCTAssertTrue(BrowserGuestPolicy.isForwardAliasHost("127.0.0.2"))
        XCTAssertTrue(BrowserGuestPolicy.isForwardAliasHost("127.0.0.254"))
        XCTAssertFalse(BrowserGuestPolicy.isForwardAliasHost("127.0.0.1"))
        XCTAssertFalse(BrowserGuestPolicy.isForwardAliasHost("127.0.0.0"))
        XCTAssertFalse(BrowserGuestPolicy.isForwardAliasHost("127.0.0.255"))
        XCTAssertFalse(BrowserGuestPolicy.isForwardAliasHost("127.0.1.2"))
        XCTAssertFalse(BrowserGuestPolicy.isForwardAliasHost("localhost"))
        XCTAssertFalse(BrowserGuestPolicy.isForwardAliasHost(nil))
    }

    func testContentRuleObjectsShape() {
        let base = BrowserGuestContentRules.ruleObjects(controlPlanePort: 17520)
        let ssh = BrowserGuestContentRules.ruleObjects(controlPlanePort: 17520,
                                                       blocksDirectLoopback: true)
        // D2 重写了 scheme/端口边界/loopbackRange 的 pattern 拆法 → 不按条数硬编码，
        // 只断言语义：base 全含 cp 端口；ssh 额外含任意端口规则（数量必须更多）。
        XCTAssertFalse(base.isEmpty)
        XCTAssertGreaterThan(ssh.count, base.count)
        XCTAssertFalse(BrowserGuestContentRules.loopbackRangePatterns.isEmpty)
        XCTAssertFalse(BrowserGuestContentRules.loopbackSecondOctetPatterns.isEmpty)
        for rule in base {
            guard let trigger = rule["trigger"] as? [String: Any],
                  let action = rule["action"] as? [String: Any] else {
                return XCTFail("rule must carry trigger/action objects")
            }
            XCTAssertEqual(action["type"] as? String, "block")
            let filter = trigger["url-filter"] as? String ?? ""
            XCTAssertTrue(filter.contains("17520"))
            XCTAssertFalse(filter.contains("17521"))
        }
        XCTAssertTrue(BrowserGuestContentRules.ruleObjects(controlPlanePort: 0).isEmpty)
        // D2：WKContentRuleList 的 url-filter 只允许 WebKit 接受的子集——出现 | 或 {m,n}
        // 会让整份规则编译失败（App 启动即 fail-closed 不可用）。
        for filter in filters(base) + filters(ssh) {
            XCTAssertFalse(filter.contains("|"), "url-filter 不得含 |（D2）：\(filter)")
            XCTAssertFalse(filter.contains("{"), "url-filter 不得含 {m,n}（D2）：\(filter)")
            XCTAssertFalse(filter.contains("}"), "url-filter 不得含 {m,n}（D2）：\(filter)")
        }
        // host 片段本身（拼接进 url-filter）同样禁止 alternation/量词花括号。
        for pattern in BrowserGuestContentRules.loopbackHostPatterns
            + BrowserGuestContentRules.loopbackRangePatterns
            + BrowserGuestContentRules.loopbackSecondOctetPatterns {
            XCTAssertFalse(pattern.contains("|"), "host pattern 不得含 |（D2）：\(pattern)")
            XCTAssertFalse(pattern.contains("{"), "host pattern 不得含 {（D2）：\(pattern)")
        }
        // JSONSerialization 生成的文本必须可解析回同一结构（R4：不手写转义）。
        let text = BrowserGuestContentRules.json(controlPlanePort: 17520,
                                                 blocksDirectLoopback: true)
        guard let data = text.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return XCTFail("content rule JSON 顶层必须是数组（D2）")
        }
        XCTAssertEqual(parsed.count, ssh.count)
        XCTAssertFalse(text.contains(#""version""#), "D2：不得再有 {rules,version} 包装")
    }

    func testRectAuditAlignedAndMismatch() {
        let placeholder = BrowserGuestFrame(x: 200, y: 100, width: 600, height: 400)
        let aligned = BrowserGuestRectAudit.make(placeholderCss: placeholder, pageZoom: 1,
                                                 guest: CGRect(x: 200, y: 100, width: 600, height: 400),
                                                 containerSize: CGSize(width: 1280, height: 772),
                                                 visible: true, occluded: false)
        XCTAssertTrue(aligned.isAligned)
        XCTAssertEqual(aligned.delta, .zero)
        XCTAssertTrue(aligned.debugLine.contains("[shell][browser-guest][rect-debug]"))
        XCTAssertTrue(aligned.debugLine.contains("aligned=true"))

        // 1pt 内视为对齐；1.5pt 判失败（W-20 判据 ≤1px）。
        let within = BrowserGuestRectAudit.make(placeholderCss: placeholder, pageZoom: 1,
                                                guest: CGRect(x: 201, y: 100, width: 600, height: 400),
                                                containerSize: CGSize(width: 1280, height: 772),
                                                visible: true, occluded: false)
        XCTAssertTrue(within.isAligned)
        let drifted = BrowserGuestRectAudit.make(placeholderCss: placeholder, pageZoom: 1,
                                                 guest: CGRect(x: 201.5, y: 100, width: 600, height: 400),
                                                 containerSize: CGSize(width: 1280, height: 772),
                                                 visible: true, occluded: false)
        XCTAssertFalse(drifted.isAligned)
        XCTAssertTrue(drifted.debugLine.contains("aligned=false"))
    }

    func testRectAuditUsesPageZoomNotRendererClaim() {
        // D5：points = CSS px * pageZoom。占位 CSS (100,50,300,200) + pageZoom 2
        // → 期望 points (200,100,600,400)（旧实现折半会得到 (50,25,150,100)）。
        let audit = BrowserGuestRectAudit.make(placeholderCss: BrowserGuestFrame(x: 100, y: 50,
                                                                                  width: 300, height: 200),
                                               pageZoom: 2,
                                               guest: CGRect(x: 200, y: 100, width: 600, height: 400),
                                               containerSize: CGSize(width: 1280, height: 772),
                                               visible: false, occluded: true)
        XCTAssertEqual(audit.placeholder, CGRect(x: 200, y: 100, width: 600, height: 400),
                       "rect-audit 的占位换算必须与 rectInPoints 同源（pageZoom 乘法）")
        XCTAssertTrue(audit.isAligned)
        XCTAssertTrue(audit.debugLine.contains("pageZoom=2.00"))
        XCTAssertTrue(audit.debugLine.contains("visible=false"))
        XCTAssertTrue(audit.debugLine.contains("occluded=true"))
    }
}


// MARK: - FW1 收敛（P0 forward 合成 / P0-2 alias 短路 / input 形状 / keymap 形态）

extension BrowserGuestPolicyTests {
    func testForwardAliasNavigationIsAllowedNotNegotiated() {
        // P0-2：alias 段必须是 allow（否则 cancel→forward-needed→只能 direct→再 cancel 死环）。
        XCTAssertEqual(outcome("http://127.0.0.7:3000/", mayForward: true), .allow)
        XCTAssertEqual(outcome("http://127.0.0.254:5173/x", mayForward: true), .allow)
        // 真远端 loopback 才协商。
        XCTAssertEqual(outcome("http://127.0.0.1:3000/", mayForward: true), .forwardNeeded)
        XCTAssertEqual(outcome("http://localhost:3000/", mayForward: true), .forwardNeeded)
        XCTAssertFalse(BrowserGuestPolicy.needsForwardNegotiation(url: URL(string: "http://127.0.0.7:3000/"), mayForward: true))
        XCTAssertTrue(BrowserGuestPolicy.needsForwardNegotiation(url: URL(string: "http://localhost:3000/"), mayForward: true))
        // direct 目标（registry 路径）永不出 forwardNeeded：policy 只用于导航门，direct 走 allow。
    }

    func testForwardTargetHostExcludesAlias() {
        XCTAssertTrue(BrowserGuestPolicy.isForwardTargetHost("127.0.0.1"))
        XCTAssertTrue(BrowserGuestPolicy.isForwardTargetHost("localhost"))
        XCTAssertTrue(BrowserGuestPolicy.isForwardTargetHost("::1"))
        // D6：IPv6 / IPv4-mapped 归一后才判定 forward 目标。
        XCTAssertTrue(BrowserGuestPolicy.isForwardTargetHost("[::1]"))
        XCTAssertTrue(BrowserGuestPolicy.isForwardTargetHost("[0:0:0:0:0:0:0:1]"))
        XCTAssertTrue(BrowserGuestPolicy.isForwardTargetHost("[::ffff:7f00:1]"))
        XCTAssertFalse(BrowserGuestPolicy.isForwardTargetHost("127.0.0.2"))
        XCTAssertFalse(BrowserGuestPolicy.isForwardTargetHost("127.0.0.99"))
        XCTAssertFalse(BrowserGuestPolicy.isForwardTargetHost("example.com"))
    }

    func testIPv6LoopbackNavigationGoesForwardAndAppHost() {
        // D6：主 frame 命中 loopback 非 alias 且可转发 → forwardNeeded；覆盖 ::1 与
        // 全展开 IPv6 写法。不可转发来源仍 allow（design §2.4）。
        XCTAssertEqual(outcome("http://[::1]:3000/", mayForward: true), .forwardNeeded)
        XCTAssertEqual(outcome("http://[0:0:0:0:0:0:0:1]:3000/", mayForward: true), .forwardNeeded)
        XCTAssertEqual(outcome("http://[::1]:3000/", mayForward: false), .allow)
        XCTAssertTrue(BrowserGuestPolicy.needsForwardNegotiation(
            url: URL(string: "http://[::1]:3000/"), mayForward: true))
        XCTAssertFalse(BrowserGuestPolicy.needsForwardNegotiation(
            url: URL(string: "http://[::1]:3000/"), mayForward: false))
        // app-host 门同样覆盖 IPv6 loopback（cp 端口拒绝）。
        XCTAssertEqual(outcome("http://[::1]:17520/"), .cancel(reason: "app-host"))
        XCTAssertTrue(BrowserGuestPolicy.isApplicationHost(
            URL(string: "http://[::1]:17520/")!, controlPlaneOrigin: origin))
    }

    func testForwardPathNormalization() {
        XCTAssertEqual(BrowserGuestForwardTarget.normalizePath(nil), "/")
        XCTAssertEqual(BrowserGuestForwardTarget.normalizePath(""), "/")
        XCTAssertEqual(BrowserGuestForwardTarget.normalizePath("/api/x?q=1"), "/api/x?q=1")
        // 合法百分号转义与编码后的 UTF-8 path 通过。
        XCTAssertEqual(BrowserGuestForwardTarget.normalizePath("/a%20b"), "/a%20b")
        XCTAssertEqual(BrowserGuestForwardTarget.normalizePath("/%E4%BD%A0"), "/%E4%BD%A0")
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("//evil.example/x"))
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("https://evil.example/x"))
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("api/x"))
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("/a b"))
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("/a\\b"))
        // D3：fragment 不送远端 → # 一律拒绝（含 query 段里的 #）。
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("/a#b"))
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("/a?b#c"))
        // D3：非 ASCII 裸字符拒绝（必须 percent-encoded）。
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("/你好"))
        // D3：所有 % 必须是 %HH（两位 hex）——畸形转义不得进 composedURL。
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("/%zz"))
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("/100%"))
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("/a?q=%zz"))
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("/a%2"))
        // D3：控制字符拒绝。
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("/a\nb"))
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("/a\u{7f}b"))
    }

    func testForwardURLCompositionOnlyFromRecord() {
        let record = BrowserGuestForwardRecord(id: "fwd-1", sourceId: "dsh-a", fingerprint: "fp",
                                               scheme: "http", aliasHost: "127.0.0.7", localPort: 51234)
        XCTAssertEqual(BrowserGuestForwardTarget.composedURL(record: record, path: "/api")?.absoluteString,
                       "http://127.0.0.7:51234/api")
        XCTAssertEqual(BrowserGuestForwardTarget.composedURL(record: record, path: nil)?.absoluteString,
                       "http://127.0.0.7:51234/")
        // query 原样保留为 query（不被当成 path 转义）。
        XCTAssertEqual(BrowserGuestForwardTarget.composedURL(record: record, path: "/api?q=1")?.absoluteString,
                       "http://127.0.0.7:51234/api?q=1")
        // 非法 record：127.0.0.1 alias / 坏 scheme / 坏端口 → nil（绝不回退 renderer URL）。
        XCTAssertNil(BrowserGuestForwardTarget.composedURL(
            record: BrowserGuestForwardRecord(id: "f", sourceId: "s", fingerprint: nil,
                                              scheme: "http", aliasHost: "127.0.0.1", localPort: 3000), path: "/"))
        XCTAssertNil(BrowserGuestForwardTarget.composedURL(
            record: BrowserGuestForwardRecord(id: "f", sourceId: "s", fingerprint: nil,
                                              scheme: "file", aliasHost: "127.0.0.7", localPort: 3000), path: "/"))
        XCTAssertNil(BrowserGuestForwardTarget.composedURL(
            record: BrowserGuestForwardRecord(id: "f", sourceId: "s", fingerprint: nil,
                                              scheme: "http", aliasHost: "127.0.0.7", localPort: 0), path: "/"))
    }
}


// MARK: - R3 收敛（RT-01 非规范 host / RT-07 长度 cap）

extension BrowserGuestPolicyTests {
    func testCanonicalHostNormalizesLegacyForms() {
        XCTAssertEqual(BrowserGuestPolicy.canonicalHost("127.0.0.1."), "127.0.0.1")
        XCTAssertEqual(BrowserGuestPolicy.canonicalHost("127.1"), "127.0.0.1")
        XCTAssertEqual(BrowserGuestPolicy.canonicalHost("2130706433"), "127.0.0.1")
        XCTAssertEqual(BrowserGuestPolicy.canonicalHost("0x7f000001"), "127.0.0.1")
        XCTAssertEqual(BrowserGuestPolicy.canonicalHost("[::ffff:127.0.0.1]"), "127.0.0.1")
        XCTAssertEqual(BrowserGuestPolicy.canonicalHost("LOCALHOST"), "localhost")
        XCTAssertEqual(BrowserGuestPolicy.canonicalHost("::1"), "::1")
        // D6：IPv6 loopback / IPv4-mapped 归一。URL.host 已去方括号，但 payload 可带。
        XCTAssertEqual(BrowserGuestPolicy.canonicalHost("[::1]"), "::1")
        XCTAssertEqual(BrowserGuestPolicy.canonicalHost("[0:0:0:0:0:0:0:1]"), "::1")
        XCTAssertEqual(BrowserGuestPolicy.canonicalHost("[::ffff:7f00:1]"), "127.0.0.1")
        XCTAssertEqual(BrowserGuestPolicy.canonicalHost("::ffff:7f00:1"), "127.0.0.1")
        XCTAssertNil(BrowserGuestPolicy.canonicalHost(""))
        // W-17 负例：非规范写法不得绕过 app-host/loopback 判定。
        XCTAssertTrue(BrowserGuestPolicy.isLoopbackHost("127.1"))
        XCTAssertTrue(BrowserGuestPolicy.isLoopbackHost("2130706433"))
        XCTAssertTrue(BrowserGuestPolicy.isLoopbackHost("0x7f000001"))
        XCTAssertTrue(BrowserGuestPolicy.isLoopbackHost("[::ffff:127.0.0.1]"))
        XCTAssertTrue(BrowserGuestPolicy.isLoopbackHost("[::ffff:7f00:1]"))
        XCTAssertTrue(BrowserGuestPolicy.isLoopbackHost("[0:0:0:0:0:0:0:1]"))
    }

    func testForwardTargetPathCapIs4096Bytes() {
        // D3/design §3：path 上限 4096 **字节**（含 query；不再用旧的 8KB）。
        let maxPath = "/" + String(repeating: "a", count: 4095)   // 4096 bytes
        XCTAssertEqual(BrowserGuestForwardTarget.normalizePath(maxPath)?.utf8.count, 4096)
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("/" + String(repeating: "a", count: 4096)),
                     "4097 字节必须拒绝")
        // query 计入同一上限（normalizePath 的输入 = path + "?" + query）。
        let maxWithQuery = "/a?q=" + String(repeating: "b", count: 4096 - 5)
        XCTAssertEqual(BrowserGuestForwardTarget.normalizePath(maxWithQuery)?.utf8.count, 4096)
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath(maxWithQuery + "b"), "含 query 超 4096 字节必须拒绝")
    }
}

// MARK: - R4：content rule 双变体状态机（首启 / 单变体失败 / 超时重试）

final class BrowserGuestContentRuleGateTests: XCTestCase {
    func testFirstStartWaitsForBothVariants() {
        var gate = BrowserGuestContentRuleGate()
        XCTAssertEqual(gate.availability(mayForward: false), .waiting)
        XCTAssertEqual(gate.availability(mayForward: true), .waiting)
        // ssh 不得在 base 就绪前启动。
        XCTAssertNil(gate.begin(.ssh))
        guard let baseToken = gate.begin(.base) else { return XCTFail("base 必须可启动") }
        XCTAssertNil(gate.begin(.base))   // 已在编译：幂等 no-op
        XCTAssertEqual(gate.availability(mayForward: false), .waiting)
        XCTAssertEqual(gate.availability(mayForward: true), .waiting)
        XCTAssertEqual(gate.finish(.base, token: baseToken, success: true), .ready)
        // 首启关键断言（R3A-1）：base ready 不得让 ssh 来源提前放行。
        XCTAssertEqual(gate.availability(mayForward: false), .ready)
        XCTAssertEqual(gate.availability(mayForward: true), .waiting)
        XCTAssertEqual(gate.pendingVariant(mayForward: true), BrowserGuestContentRuleVariant.ssh)
        guard let sshToken = gate.begin(.ssh) else { return XCTFail("base ready 后 ssh 必须可启动") }
        XCTAssertEqual(gate.finish(.ssh, token: sshToken, success: true), .ready)
        XCTAssertEqual(gate.availability(mayForward: true), .ready)
    }

    func testSingleVariantFailureDoesNotDisableTheOther() {
        var gate = BrowserGuestContentRuleGate()
        guard let baseToken = gate.begin(.base) else { return XCTFail("base 必须可启动") }
        _ = gate.finish(.base, token: baseToken, success: true)
        guard let first = gate.begin(.ssh) else { return XCTFail("ssh 必须可启动") }
        XCTAssertEqual(gate.finish(.ssh, token: first, success: false), .retry)
        XCTAssertEqual(gate.availability(mayForward: false), .ready)
        XCTAssertEqual(gate.availability(mayForward: true), .waiting)
        // ssh 第二次失败 → 终态；local 仍可用（P2-D：单变体失败不放大为全局不可用）。
        guard let second = gate.begin(.ssh) else { return XCTFail("ssh 必须可重试一次") }
        XCTAssertEqual(gate.finish(.ssh, token: second, success: false), .failed)
        XCTAssertEqual(gate.attempts(.ssh), 2)
        XCTAssertEqual(gate.availability(mayForward: false), .ready)
        XCTAssertEqual(gate.availability(mayForward: true), .unavailable)
    }

    func testBaseFailureFailsBothVariants() {
        var gate = BrowserGuestContentRuleGate()
        guard let first = gate.begin(.base) else { return XCTFail("base 必须可启动") }
        XCTAssertEqual(gate.finish(.base, token: first, success: false), .retry)
        XCTAssertEqual(gate.availability(mayForward: false), .waiting)
        guard let second = gate.begin(.base) else { return XCTFail("base 必须可重试一次") }
        XCTAssertEqual(gate.finish(.base, token: second, success: false), .failed)
        gate.failDependents()
        XCTAssertEqual(gate.phase(.ssh), .failed)
        XCTAssertEqual(gate.availability(mayForward: false), .unavailable)
        XCTAssertEqual(gate.availability(mayForward: true), .unavailable)
    }

    func testTimeoutRetriesOnceThenFailsAndIgnoresLateCallback() {
        var gate = BrowserGuestContentRuleGate()
        guard let first = gate.begin(.base) else { return XCTFail("base 必须可启动") }
        // 超时与编译失败共用 finish(success:false) 路径（P2-E）。
        XCTAssertEqual(gate.finish(.base, token: first, success: false), .retry)
        guard let second = gate.begin(.base) else { return XCTFail("超时后必须重试一次") }
        XCTAssertNotEqual(first, second)
        // 旧编译回调在超时后才到达：不得复活/影响新一次。
        XCTAssertEqual(gate.finish(.base, token: first, success: true), .stale)
        XCTAssertEqual(gate.phase(.base), .compiling)
        XCTAssertEqual(gate.finish(.base, token: second, success: false), .failed)
        XCTAssertEqual(gate.availability(mayForward: false), .unavailable)
        XCTAssertEqual(gate.attempts(.base), 2)
    }
}

// MARK: - R4：legacy loopback 规则形态（P1-B）与 identifier 内容哈希（P2-F）

extension BrowserGuestPolicyTests {
    private func filters(_ rules: [[String: Any]]) -> [String] {
        rules.compactMap { rule in
            (rule["trigger"] as? [String: Any])?["url-filter"] as? String
        }
    }

    private func matches(_ filters: [String], _ url: String) -> Bool {
        let range = NSRange(url.startIndex..<url.endIndex, in: url)
        return filters.contains { filter in
            guard let regex = try? NSRegularExpression(pattern: filter,
                                                       options: [.caseInsensitive]) else { return false }
            return regex.firstMatch(in: url, options: [], range: range) != nil
        }
    }

    func testContentRuleLegacyLoopbackForms() {
        let base = filters(BrowserGuestContentRules.ruleObjects(controlPlanePort: 17520))
        for url in ["http://127.0.0.1:17520/", "http://127.1:17520/", "http://127.0.1:17520/",
                    "http://127.0.0.1.:17520/", "http://127.0.0.01:17520/",
                    "http://2130706433:17520/", "http://0x7f000001:17520/",
                    "http://0x7f.1:17520/", "http://0x7f.0.0.1:17520/",
                    "http://017700000001:17520/",
                    "https://localhost:17520/x", "wss://localhost.:17520/",
                    "http://[::1]:17520/", "http://[::ffff:127.0.0.1]:17520/",
                    // D2/D6：IPv6 loopback 展开写法也必须拦截。
                    "http://[0:0:0:0:0:0:0:1]:17520/", "http://[::ffff:7f00:1]:17520/"] {
            XCTAssertTrue(matches(base, url), "base 必须拦截 \(url)")
        }
        XCTAssertFalse(matches(base, "http://127.0.0.1:17521/"))
        XCTAssertFalse(matches(base, "http://127.0.0.7:17520/"))   // forward alias 放行
        XCTAssertFalse(matches(base, "https://example.com/"))

        let ssh = filters(BrowserGuestContentRules.ruleObjects(controlPlanePort: 17520,
                                                               blocksDirectLoopback: true))
        for url in ["http://127.0.0.1:3000/", "http://127.0.0.01:3000/", "http://127.1:3000/",
                    "http://127.0.1.1:3000/", "http://127.1.2.3:3000/",
                    "http://2130706433:3000/", "http://0x7f000001:3000/",
                    "http://0x7f.1:3000/", "http://[::1]:3000/",
                    "wss://[::ffff:7f00:1]:3000/", "https://localhost:8443/",
                    // D2：127/8 非 alias 的两端也必须在 ssh 变体命中。
                    "http://127.0.0.0:3000/", "http://127.0.0.255:3000/",
                    // D6：IPv6 loopback 展开写法（任意端口）。
                    "http://[0:0:0:0:0:0:0:1]:3000/",
                    "http://[::ffff:7f00:1]:3000/"] {
            XCTAssertTrue(matches(ssh, url), "ssh 变体必须拦截 \(url)")
        }
        // alias 段 127.0.0.2–254 必须保持放行（forward 依赖）。
        XCTAssertFalse(matches(ssh, "http://127.0.0.7:51234/x"))
        XCTAssertFalse(matches(ssh, "http://127.0.0.254:51234/"))
        XCTAssertFalse(matches(ssh, "https://example.com/"))
    }

    func testContentRuleIdentifierIsDeterministicAndContentAddressed() {
        let first = BrowserGuestContentRules.identifier(controlPlanePort: 17520,
                                                        blocksDirectLoopback: false)
        let again = BrowserGuestContentRules.identifier(controlPlanePort: 17520,
                                                        blocksDirectLoopback: false)
        XCTAssertEqual(first, again)   // 确定性：不得用每进程随机化的 Hasher
        XCTAssertTrue(first.hasPrefix("chamber-guest-apphost-v1-17520-f0-"))
        XCTAssertNotEqual(first, BrowserGuestContentRules.identifier(controlPlanePort: 17520,
                                                                     blocksDirectLoopback: true))
        XCTAssertNotEqual(first, BrowserGuestContentRules.identifier(controlPlanePort: 17521,
                                                                     blocksDirectLoopback: false))
        // FNV-1a 64 对 "abc" 的已知值（钉住实现；不是安全哈希）。
        XCTAssertEqual(BrowserGuestContentRules.contentDigest("abc"), "e71fa2190541574b")
    }
}

// MARK: - R4：来源退役 push 载荷解析（P1-C，复用既有 desktop_ssh_instances_changed）

final class BrowserGuestSourceRetirementTests: XCTestCase {
    func testInstancesChangedPayloadMapsToGuestSourceIds() {
        let payload: AnyCodable = .object([
            "removedIds": .array([.string("abc")]),
            "retiredIds": .array([.string("abc"), .string("def")])
        ])
        XCTAssertEqual(BrowserGuestSourceRetirement.sourceIds(from: payload),
                       ["dsh-abc", "gateway-abc", "dsh-def", "gateway-def"])
        // 只有 removedIds 的旧形状同样消费。
        XCTAssertEqual(BrowserGuestSourceRetirement.sourceIds(
            from: .object(["removedIds": .array([.string("xyz")])])),
                       ["dsh-xyz", "gateway-xyz"])
        // 复用既有 push 通道（在生成 manifest 的 push 面内，不新增 A 桥通道）。
        XCTAssertTrue(BridgeManifest.pushChannels.contains(
            BrowserGuestSourceRetirement.instancesChangedChannel))
    }

    func testInvalidRetirementPayloadsAreDropped() {
        XCTAssertEqual(BrowserGuestSourceRetirement.sourceIds(from: nil), [])
        XCTAssertEqual(BrowserGuestSourceRetirement.sourceIds(from: .object([:])), [])
        XCTAssertEqual(BrowserGuestSourceRetirement.sourceIds(from: .object([
            "retiredIds": .array([.string("local"), .string("bad id"), .number(1), .string("")])
        ])), [])
        XCTAssertEqual(BrowserGuestSourceRetirement.sourceIds(from: .object([
            "retiredIds": .string("abc")
        ])), [])
        XCTAssertFalse(BrowserGuestSourceRetirement.isInstanceId(String(repeating: "a", count: 65)))
        XCTAssertFalse(BrowserGuestSourceRetirement.isInstanceId("a.b"))
        XCTAssertTrue(BrowserGuestSourceRetirement.isInstanceId("a_B-9"))
    }
}


