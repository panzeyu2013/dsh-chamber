//
//  TrustGuardTests.swift — W-04 A 桥传输层护栏（design 25 §4.4.1）
//  纯逻辑单测：origin 精确匹配（fail-closed）、方法白名单、帧尺寸上限。
//
import XCTest
@testable import DSHChamberPoc

final class TrustGuardTests: XCTestCase {
    private let origin = "http://127.0.0.1:17520"

    func testTrustedOriginExact() {
        XCTAssertTrue(TrustGuard.isTrustedOrigin("http://127.0.0.1:17520/", expectedOrigin: origin))
        XCTAssertTrue(TrustGuard.isTrustedOrigin("http://127.0.0.1:17520", expectedOrigin: origin))
        XCTAssertTrue(TrustGuard.isTrustedOrigin("http://127.0.0.1:17520/page?x=1#y", expectedOrigin: origin))
    }

    func testUntrustedOriginsFailClosed() {
        XCTAssertFalse(TrustGuard.isTrustedOrigin(nil, expectedOrigin: origin))
        XCTAssertFalse(TrustGuard.isTrustedOrigin("", expectedOrigin: origin))
        XCTAssertFalse(TrustGuard.isTrustedOrigin("not a url", expectedOrigin: origin))
        // 端口不同
        XCTAssertFalse(TrustGuard.isTrustedOrigin("http://127.0.0.1:17521/", expectedOrigin: origin))
        // scheme 不同
        XCTAssertFalse(TrustGuard.isTrustedOrigin("https://127.0.0.1:17520/", expectedOrigin: origin))
        // host 不同
        XCTAssertFalse(TrustGuard.isTrustedOrigin("http://localhost:17520/", expectedOrigin: origin))
        XCTAssertFalse(TrustGuard.isTrustedOrigin("http://evil.example/", expectedOrigin: origin))
        // 带 userinfo 一律拒绝
        XCTAssertFalse(TrustGuard.isTrustedOrigin("http://u:p@127.0.0.1:17520/", expectedOrigin: origin))
    }

    func testSchemeAndHostCaseNormalization() {
        // 实现按 lowercased 比较 scheme/host → scheme/host 大小写折叠被接受
        XCTAssertTrue(TrustGuard.isTrustedOrigin("HTTP://127.0.0.1:17520/", expectedOrigin: origin))
        XCTAssertTrue(TrustGuard.isTrustedOrigin("http://EXAMPLE.com:1", expectedOrigin: "http://example.com:1"))
        // IPv6 字面量不在 POC 范围：不判真也不崩
        _ = TrustGuard.isTrustedOrigin("http://[::1]:17520/", expectedOrigin: origin)
    }

    /// 2026-09 验收审计 major 收口：A 桥只信任固定壳文档（origin + pathname=="/"
    /// + 无 query），与 Electron isTrustedRendererUrl 逐条对齐——同源非根文档
    /// （如 /api/i/<id>/* 代理回传的远端 HTML）不得继承 shim/IPC 面。
    func testTrustedDocumentIsShellDocumentOnly() {
        XCTAssertTrue(TrustGuard.isTrustedDocument("http://127.0.0.1:17520/", expectedOrigin: origin))
        XCTAssertTrue(TrustGuard.isTrustedDocument("http://127.0.0.1:17520", expectedOrigin: origin))
        // 同源非壳文档 / 带 query / 带 fragment → 拒绝
        XCTAssertFalse(TrustGuard.isTrustedDocument("http://127.0.0.1:17520/api/i/abc/", expectedOrigin: origin))
        XCTAssertFalse(TrustGuard.isTrustedDocument("http://127.0.0.1:17520/page?x=1", expectedOrigin: origin))
        XCTAssertFalse(TrustGuard.isTrustedDocument("http://127.0.0.1:17520/?x=1", expectedOrigin: origin))
        // origin 原语仍应把它们判为同源（两个判定的差异是有意的）
        XCTAssertTrue(TrustGuard.isTrustedOrigin("http://127.0.0.1:17520/page?x=1#y", expectedOrigin: origin))
        XCTAssertFalse(TrustGuard.isTrustedDocument("http://127.0.0.1:17520/page?x=1#y", expectedOrigin: origin))
        // fail-closed 面与 isTrustedOrigin 一致
        XCTAssertFalse(TrustGuard.isTrustedDocument(nil, expectedOrigin: origin))
        XCTAssertFalse(TrustGuard.isTrustedDocument("", expectedOrigin: origin))
        XCTAssertFalse(TrustGuard.isTrustedDocument("not a url", expectedOrigin: origin))
        XCTAssertFalse(TrustGuard.isTrustedDocument("http://127.0.0.1:17521/", expectedOrigin: origin))
        XCTAssertFalse(TrustGuard.isTrustedDocument("https://127.0.0.1:17520/", expectedOrigin: origin))
        XCTAssertFalse(TrustGuard.isTrustedDocument("http://u:p@127.0.0.1:17520/", expectedOrigin: origin))
        // 期望 origin 非 http(s)（如 file://）→ 拒绝
        XCTAssertFalse(TrustGuard.isTrustedDocument("file:///tmp/index.html", expectedOrigin: "file:///tmp"))
    }

    /// origin(of:) 的 origin 串构造（归一化与 cpOrigin 共用）：IPv6 必须补回
    /// 方括号（2026-09 二审：`[::1]` 曾生成 `http://::1:17520` 不可解析）。
    func testOriginStringConstruction() {
        XCTAssertEqual(MainWindowController.origin(of: URL(string: "http://127.0.0.1:17520/")!),
                       "http://127.0.0.1:17520")
        XCTAssertEqual(MainWindowController.origin(of: URL(string: "https://Example.COM")!),
                       "https://example.com")
        XCTAssertEqual(MainWindowController.origin(of: URL(string: "http://[::1]:17520/")!),
                       "http://[::1]:17520")
        XCTAssertNil(MainWindowController.origin(of: URL(string: "file:///tmp/x")!))
        // 补回括号后，IPv6 origin 与 URL 往返可解析（归一化路径不会静默跳过）。
        let ipv6 = MainWindowController.origin(of: URL(string: "http://[::1]:17520/api")!)
        XCTAssertNotNil(URL(string: (ipv6 ?? "") + "/"))
        XCTAssertTrue(TrustGuard.isTrustedDocument("http://[::1]:17520/", expectedOrigin: ipv6 ?? ""))
    }

    /// 三审边界：默认端口折叠（http:80 / https:443）与 expectedOrigin 的
    /// userinfo 拒绝——两者都要与 WHATWG origin 等价语义对齐。
    func testDefaultPortFoldingAndExpectedUserinfo() {
        XCTAssertTrue(TrustGuard.isTrustedOrigin("http://example.com:80/", expectedOrigin: "http://example.com"))
        XCTAssertTrue(TrustGuard.isTrustedOrigin("http://example.com/", expectedOrigin: "http://example.com:80"))
        XCTAssertTrue(TrustGuard.isTrustedOrigin("https://example.com:443/", expectedOrigin: "https://example.com"))
        XCTAssertFalse(TrustGuard.isTrustedOrigin("http://example.com:443/", expectedOrigin: "http://example.com"))
        XCTAssertFalse(TrustGuard.isTrustedOrigin("http://example.com:81/", expectedOrigin: "http://example.com"))
        // expectedOrigin 带 userinfo → 一律拒绝（fail-closed）。
        XCTAssertFalse(TrustGuard.isTrustedOrigin("http://u:p@example.com/", expectedOrigin: "http://u:p@example.com"))
        XCTAssertFalse(TrustGuard.isTrustedDocument("http://u:p@example.com/", expectedOrigin: "http://u:p@example.com"))
        // 非 http(s) scheme 缺省端口为 nil，不折叠。
        XCTAssertEqual(TrustGuard.effectivePort(scheme: "http", port: nil), 80)
        XCTAssertEqual(TrustGuard.effectivePort(scheme: "https", port: nil), 443)
        XCTAssertNil(TrustGuard.effectivePort(scheme: "ws", port: nil))
        XCTAssertEqual(TrustGuard.effectivePort(scheme: "http", port: 8080), 8080)
    }

    /// 新窗外链判定（镜像 renderer-trust.ts isExternalLinkUrl）：只有 http(s)
    /// 与 mailto 交系统；同源 http(s) 不算外链；其他 scheme 一律拒绝。
    func testExternalLinkPredicate() {
        XCTAssertTrue(TrustGuard.isExternalLink("https://example.com/x", expectedOrigin: origin))
        XCTAssertTrue(TrustGuard.isExternalLink("http://example.com/", expectedOrigin: origin))
        XCTAssertTrue(TrustGuard.isExternalLink("mailto:a@b.com", expectedOrigin: origin))
        // 同源 http(s) 不算外链（在浏览器里只会得到无 shim 的重复壳）
        XCTAssertFalse(TrustGuard.isExternalLink("http://127.0.0.1:17520/page", expectedOrigin: origin))
        // 其他 scheme 与不可解析值
        XCTAssertFalse(TrustGuard.isExternalLink("file:///etc/passwd", expectedOrigin: origin))
        XCTAssertFalse(TrustGuard.isExternalLink("javascript:alert(1)", expectedOrigin: origin))
        XCTAssertFalse(TrustGuard.isExternalLink("data:text/html,x", expectedOrigin: origin))
        XCTAssertFalse(TrustGuard.isExternalLink("dsh-chamber://open-vscode", expectedOrigin: origin))
        XCTAssertFalse(TrustGuard.isExternalLink("mailto:", expectedOrigin: origin))
        XCTAssertFalse(TrustGuard.isExternalLink(nil, expectedOrigin: origin))
        XCTAssertFalse(TrustGuard.isExternalLink("", expectedOrigin: origin))
        XCTAssertFalse(TrustGuard.isExternalLink("not a url", expectedOrigin: origin))
        // 无期望 origin 时 http(s) 一律视为外链
        XCTAssertTrue(TrustGuard.isExternalLink("http://127.0.0.1:17520/", expectedOrigin: nil))
    }

    func testMethodWhitelist() {
        let wl: Set<String> = ["dsh-chamber:info", "desktop_ssh_instances_get"]
        XCTAssertTrue(TrustGuard.isAllowedMethod("dsh-chamber:info", whitelist: wl))
        XCTAssertFalse(TrustGuard.isAllowedMethod("dsh-chamber:runtime-install", whitelist: wl))
        XCTAssertFalse(TrustGuard.isAllowedMethod("", whitelist: wl))
    }

    func testEnvelopeSizeLimit() {
        XCTAssertFalse(TrustGuard.envelopeSizeOK(String(repeating: "a", count: TrustGuard.maxMessageBytes + 1)))
        XCTAssertTrue(TrustGuard.envelopeSizeOK(String(repeating: "a", count: 16)))
        // 多字节字符按字节计
        XCTAssertTrue(TrustGuard.envelopeSizeOK(String(repeating: "中", count: TrustGuard.maxMessageBytes / 3)))
        XCTAssertFalse(TrustGuard.envelopeSizeOK(String(repeating: "中", count: TrustGuard.maxMessageBytes)))
    }
}
