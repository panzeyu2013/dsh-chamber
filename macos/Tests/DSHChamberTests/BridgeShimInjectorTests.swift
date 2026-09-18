//
//  BridgeShimInjectorTests.swift
//  DSHChamberTests
//
//  S-06（2026-12 复裁决）：A 桥内部管路（resolve/emit/rehydrate）不在公开面上，
//  但页面脚本能直接调用它们——注入随机令牌后，伪造原生回执/事件必须先猜中令牌。
//  本文件钉住令牌的生成、注入与 shim 侧校验面。
//
import XCTest
import WebKit
@testable import DSHChamber

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

    // MARK: - P-19：重复注入必须幂等（显式标记，不靠 defineProperty TypeError）

    /// 同一 configuration 二次 install 必须 no-op：只注册一份 user script，
    /// 且带显式标记前缀（shim 侧同一标记保证页面级重放惰性）。
    func testInstallIsIdempotentPerConfiguration() {
        let config = WKWebViewConfiguration()
        XCTAssertFalse(BridgeShimInjector.isInstalled(in: config), "新 configuration 未安装")
        XCTAssertTrue(BridgeShimInjector.install(config: config, source: "var a = 1"))
        XCTAssertEqual(config.userContentController.userScripts.count, 1)
        XCTAssertTrue(BridgeShimInjector.isInstalled(in: config))
        XCTAssertFalse(BridgeShimInjector.install(config: config, source: "var a = 2"),
                       "已安装 → 二次 install 必须 no-op（不依赖 TypeError 兜底）")
        XCTAssertEqual(config.userContentController.userScripts.count, 1,
                       "绝不重复注册（重复的 documentStart 执行会撞非可配置 defineProperty）")
        let script = config.userContentController.userScripts[0]
        XCTAssertEqual(script.source, BridgeShimInjector.installedMarker + "\nvar a = 1")
        XCTAssertEqual(script.injectionTime, .atDocumentStart)
        XCTAssertTrue(script.isForMainFrameOnly, "shim 仅主 frame（S-35 的 blob 子 frame 依据）")
    }

    /// shim 源码面：令牌常量 + 三个内部入口都要求令牌；公开面不含令牌。
    func testShimRequiresTokenOnEveryInternalEntry() throws {
        // 直接读源码树里的 shim（与 SwiftPM resources 打进包的是同一个文件）：
        // `swift test` 下 ChamberResources 的 resourceURL 布局与装配态不同，锁定
        // 源码路径才能稳定断言「提交物」本身。
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // DSHChamberTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // macos
            .appendingPathComponent("Sources/DSHChamber/Resources/bridge-shim.js")
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
        // P-19：页面级重复注入也必须惰性——显式标记位，而不是等非可配置
        // defineProperty 在第二份副本执行时抛 TypeError（公开面 info 水化成功
        // 前不存在，"dshChamber in window" 守卫覆盖不到那个窗口）。
        XCTAssertTrue(shim.contains("__dshChamberShimInstalled"),
                      "shim 必须带显式重复注入标记")
        XCTAssertTrue(shim.contains("if (window.__dshChamberShimInstalled === true) return"),
                      "标记命中即 inert（第二次 documentStart 执行 no-op）")
    }
}
