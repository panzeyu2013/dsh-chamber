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
        // pageZoom 2：CSS px 折半 → points。
        XCTAssertEqual(BrowserGuestPolicy.rectInPoints(frame: frame, pageZoom: 2,
                                                       containerSize: CGSize(width: 1280, height: 772)),
                       CGRect(x: 50, y: 25, width: 200, height: 150))
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
        XCTAssertTrue(json.contains(#""type":"block""#))
        XCTAssertTrue(json.contains("17520"))
        XCTAssertFalse(json.contains("17521"))
        // 只出现 loopback 主机与 cp 端口，不出现通配 host。
        XCTAssertFalse(json.contains("*"))
        XCTAssertEqual(BrowserGuestContentRules.json(controlPlanePort: 0), #"{"rules":[],"version":1}"#)
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
        // 每条主机形态 × http(s)/ws(s) 两 scheme；ssh 变体 = base + 任意端口两份。
        let hostCount = BrowserGuestContentRules.loopbackHostPatterns.count
        XCTAssertEqual(base.count, hostCount * 2)
        XCTAssertEqual(ssh.count,
                       base.count + (hostCount + BrowserGuestContentRules.loopbackRangePatterns.count) * 2)
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
        // JSONSerialization 生成的文本必须可解析回同一结构（R4：不手写转义）。
        let text = BrowserGuestContentRules.json(controlPlanePort: 17520,
                                                 blocksDirectLoopback: true)
        guard let data = text.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return XCTFail("content rule JSON must be valid JSON")
        }
        XCTAssertEqual((parsed["rules"] as? [[String: Any]])?.count, ssh.count)
        XCTAssertEqual(parsed["version"] as? Int, 1)
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
        // 占位 CSS 200,100,600,400 + pageZoom 2 → 期望 points 100,50,300,200。
        let audit = BrowserGuestRectAudit.make(placeholderCss: BrowserGuestFrame(x: 200, y: 100,
                                                                                  width: 600, height: 400),
                                               pageZoom: 2,
                                               guest: CGRect(x: 100, y: 50, width: 300, height: 200),
                                               containerSize: CGSize(width: 1280, height: 772),
                                               visible: false, occluded: true)
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
        XCTAssertFalse(BrowserGuestPolicy.isForwardTargetHost("127.0.0.2"))
        XCTAssertFalse(BrowserGuestPolicy.isForwardTargetHost("127.0.0.99"))
        XCTAssertFalse(BrowserGuestPolicy.isForwardTargetHost("example.com"))
    }

    func testForwardPathNormalization() {
        XCTAssertEqual(BrowserGuestForwardTarget.normalizePath(nil), "/")
        XCTAssertEqual(BrowserGuestForwardTarget.normalizePath(""), "/")
        XCTAssertEqual(BrowserGuestForwardTarget.normalizePath("/api/x?q=1"), "/api/x?q=1")
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("//evil.example/x"))
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("https://evil.example/x"))
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("api/x"))
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("/a b"))
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("/a\\b"))
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
        XCTAssertNil(BrowserGuestPolicy.canonicalHost(""))
        // W-17 负例：非规范写法不得绕过 app-host/loopback 判定。
        XCTAssertTrue(BrowserGuestPolicy.isLoopbackHost("127.1"))
        XCTAssertTrue(BrowserGuestPolicy.isLoopbackHost("2130706433"))
        XCTAssertTrue(BrowserGuestPolicy.isLoopbackHost("0x7f000001"))
        XCTAssertTrue(BrowserGuestPolicy.isLoopbackHost("[::ffff:127.0.0.1]"))
    }

    func testForwardTargetCapLengths() {
        XCTAssertNil(BrowserGuestForwardTarget.normalizePath("/" + String(repeating: "a", count: 8 * 1024 + 1)))
        XCTAssertEqual(BrowserGuestForwardTarget.normalizePath("/" + String(repeating: "a", count: 8 * 1024))?.count, 8 * 1024 + 1)
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
                    "http://[::1]:17520/", "http://[::ffff:127.0.0.1]:17520/"] {
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
                    "wss://[::ffff:7f00:1]:3000/", "https://localhost:8443/"] {
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


