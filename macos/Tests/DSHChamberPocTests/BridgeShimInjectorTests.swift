//
//  BridgeShimInjectorTests.swift
//  DSHChamberPocTests
//
//  S-06（2026-12 复裁决）：A 桥内部管路（resolve/emit/rehydrate）不在公开面上，
//  但页面脚本能直接调用它们——注入随机令牌后，伪造原生回执/事件必须先猜中令牌。
//  本文件钉住令牌的生成、注入与 shim 侧校验面。
//
import XCTest
@testable import DSHChamberPoc

final class BridgeShimInjectorTests: XCTestCase {

    /// 令牌 = 32 位十六进制（128 位随机），两次生成不相等。
    func testNativeTokenIsRandomHex32() {
        let first = BridgeShimInjector.makeNativeToken()
        let second = BridgeShimInjector.makeNativeToken()
        XCTAssertEqual(first.count, 32)
        XCTAssertTrue(first.allSatisfy { $0.isHexDigit }, "必须是十六进制串：\(first)")
        XCTAssertNotEqual(first, second, "每窗口随机，绝不复用")
    }

    /// 注入替换占位符；产物里不得再出现占位符（fail-closed 的 precondition 面）。
    func testInjectNativeTokenReplacesPlaceholder() {
        let token = BridgeShimInjector.makeNativeToken()
        let source = "var t = '\(BridgeShimInjector.nativeTokenPlaceholder)'"
        let injected = BridgeShimInjector.injectNativeToken(token, into: source)
        XCTAssertEqual(injected, "var t = '\(token)'")
        XCTAssertFalse(injected.contains(BridgeShimInjector.nativeTokenPlaceholder))
    }

    /// shim 源码面：令牌常量 + 三个内部入口都要求令牌；公开面不含令牌。
    func testShimRequiresTokenOnEveryInternalEntry() throws {
        // 直接读源码树里的 shim（与 SwiftPM resources 打进包的是同一个文件）：
        // `swift test` 下 ChamberResources 的 resourceURL 布局与装配态不同，锁定
        // 源码路径才能稳定断言「提交物」本身。
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // DSHChamberPocTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // macos
            .appendingPathComponent("Sources/DSHChamberPoc/Resources/bridge-shim.poc.js")
        guard let shim = try? String(contentsOf: url, encoding: .utf8) else {
            return XCTFail("shim 源码不可读：\(url.path)")
        }
        XCTAssertTrue(shim.contains("var NATIVE_CHANNEL_TOKEN = '\(BridgeShimInjector.nativeTokenPlaceholder)'"),
                      "shim 必须声明令牌占位符")
        XCTAssertTrue(shim.contains("function requireNativeToken(token)"))
        for entry in ["function resolveInvocation(token, id, result, err)",
                      "function emitToListeners(token, event, payload)",
                      "function (token) {"] {
            XCTAssertTrue(shim.contains(entry), "内部入口必须收令牌参数：\(entry)")
        }
        // 三个内部入口各调用一次校验（resolve / emit / rehydrate）。
        let guardCount = shim.components(separatedBy: "requireNativeToken(token)").count - 1
        XCTAssertGreaterThanOrEqual(guardCount, 3, "每个内部入口都要校验（实际 \(guardCount)）")
    }
}
