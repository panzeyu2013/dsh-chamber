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
