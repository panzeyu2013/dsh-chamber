//
//  MessageHandlerTests.swift
//  DSHChamberTests
//
//  模块评审 major 收口 + S17：ChamberMessageHandler 是 A 桥四护栏的**唯一执行
//  点**。`didReceive` 需要 WKScriptMessage（WebKit 无公开构造器，frameInfo 不可
//  伪造），因此判定收敛为纯函数 `fence(_:)`，本文件直接驱动该接缝：
//    - fence：接受 + origin 拒绝 + 白名单拒绝 + 信封/尺寸拒绝 + app_quitting
//      （S7）+ 非本通道/子 frame 丢弃；
//    - exactInt：id 整值域（布尔/NaN/±Inf/越界/浮点全部拒绝）
//    - jsStringLiteral：引号/反斜杠/控制字符/Unicode 转义
//  2026-12 审计删除的仅测试函数（anyCodablePayload / isJSONSerializableValue /
//  maxJSONDepth）不再有对应用例；其接受集由 fence + AnyCodableTests 覆盖。
//    - 拒绝码常量：与 design 25 §4.4.1 / renderer-trust 同族字面量
//
import XCTest
@testable import DSHChamber

final class MessageHandlerTests: XCTestCase {

    func testRejectCodesAreStableLiterals() {
        // 这些码是跨语言契约（shim/preload 侧同族命名），改动必须同步文档。
        XCTAssertEqual(ChamberMessageHandler.codeSenderForbidden, "ipc_sender_forbidden")
        XCTAssertEqual(ChamberMessageHandler.codeMethodNotAllowed, "method_not_allowed")
        XCTAssertEqual(ChamberMessageHandler.codeFrameTooLarge, "frame_too_large")
        XCTAssertEqual(ChamberMessageHandler.codeMalformedEnvelope, "malformed_envelope")
        // S7：与 renderer-trust.ts createTrustedIpc 的 error.code 逐字一致。
        XCTAssertEqual(ChamberMessageHandler.codeAppQuitting, "app_quitting")
    }

    // MARK: - S17：入站围栏流水线（didReceive 的纯逻辑接缝）

    private let whitelist: Set<String> = ["dsh-chamber:info", "dsh-chamber:settings-get"]

    private func fenceInput(
        name: String = "dshChamber",
        mainFrame: Bool = true,
        body: Any,
        url: String? = "http://127.0.0.1:17520/",
        origin: String? = "http://127.0.0.1:17520",
        quitting: Bool = false
    ) -> ChamberMessageHandler.FenceInput {
        ChamberMessageHandler.FenceInput(
            messageName: name,
            isMainFrame: mainFrame,
            body: body,
            currentURL: url,
            expectedOrigin: origin,
            isQuitting: quitting,
            whitelist: whitelist)
    }

    private func envelope(id: Any = 1, method: Any = "dsh-chamber:info",
                          payload: Any? = nil) -> [String: Any] {
        var dict: [String: Any] = ["id": id, "method": method]
        if let payload { dict["payload"] = payload }
        return dict
    }

    func testFenceAcceptsTrustedEnvelope() {
        XCTAssertEqual(
            ChamberMessageHandler.fence(fenceInput(body: envelope(id: 7, payload: ["k": "v"]))),
            .accept(id: 7, method: "dsh-chamber:info",
                    payload: .object(["k": .string("v")])))
        // payload 缺省 → nil（无载荷）
        XCTAssertEqual(
            ChamberMessageHandler.fence(fenceInput(body: envelope(id: 8))),
            .accept(id: 8, method: "dsh-chamber:info", payload: nil))
    }

    func testFenceRejectsUntrustedOriginAndReadyGate() {
        XCTAssertEqual(
            ChamberMessageHandler.fence(fenceInput(body: envelope(), url: "http://evil.example/")),
            .reject(id: 1, code: ChamberMessageHandler.codeSenderForbidden))
        XCTAssertEqual(
            ChamberMessageHandler.fence(fenceInput(body: envelope(), origin: nil)),
            .reject(id: 1, code: ChamberMessageHandler.codeNotReady),
            "ready 前 expectedOrigin=nil：一律拒绝，但用可重试的 ipc_not_ready 码（S1·F3）")
        XCTAssertEqual(
            ChamberMessageHandler.fence(fenceInput(
                body: envelope(), url: "http://127.0.0.1:17520/api/i/x")),
            .reject(id: 1, code: ChamberMessageHandler.codeSenderForbidden),
            "同源非壳文档（代理 HTML）也必须拒绝")
        // 不可信来源 + 无法归因 id：仍拒绝但 id=nil（调用方静默丢弃，不注入 JS）
        XCTAssertEqual(
            ChamberMessageHandler.fence(fenceInput(
                body: ["method": "dsh-chamber:info"], url: "http://evil.example/")),
            .reject(id: nil, code: ChamberMessageHandler.codeSenderForbidden))
    }

    func testFenceRejectsAfterQuittingStarts() {
        // S7：镜像 renderer-trust.ts createTrustedIpc——origin 通过后、信封/
        // 白名单之前回 app_quitting，late invoke 不得再注入传输/运行时工作。
        XCTAssertEqual(
            ChamberMessageHandler.fence(fenceInput(body: envelope(), quitting: true)),
            .reject(id: 1, code: ChamberMessageHandler.codeAppQuitting))
        // origin 仍优先：不可信页面不会因 quitting 拿到 app_quitting 回执。
        XCTAssertEqual(
            ChamberMessageHandler.fence(fenceInput(
                body: envelope(), url: "http://evil.example/", quitting: true)),
            .reject(id: 1, code: ChamberMessageHandler.codeSenderForbidden))
    }

    func testFenceRejectsMalformedAndDisallowed() {
        XCTAssertEqual(ChamberMessageHandler.fence(fenceInput(body: "not-an-envelope")),
                       .reject(id: nil, code: ChamberMessageHandler.codeMalformedEnvelope))
        XCTAssertEqual(ChamberMessageHandler.fence(fenceInput(body: envelope(method: 7))),
                       .reject(id: 1, code: ChamberMessageHandler.codeMalformedEnvelope))
        XCTAssertEqual(ChamberMessageHandler.fence(fenceInput(body: envelope(id: true))),
                       .reject(id: nil, code: ChamberMessageHandler.codeMalformedEnvelope))
        XCTAssertEqual(ChamberMessageHandler.fence(fenceInput(body: envelope(method: "zzz"))),
                       .reject(id: 1, code: ChamberMessageHandler.codeMethodNotAllowed))
        // NaN 载荷无 JSON 表示 → malformed（不得让 JSONSerialization 抛 NSException）
        XCTAssertEqual(
            ChamberMessageHandler.fence(fenceInput(
                body: envelope(payload: NSNumber(value: Double.nan)))),
            .reject(id: 1, code: ChamberMessageHandler.codeMalformedEnvelope))
    }

    /// Phase 1 C2：走完整 fence 的深嵌套 payload。注意 envelope 根占深度 0，
    /// payload 从 1 起，故经 fence 的 payload 深度上限是 maxJSONDepth - 1
    /// （fail-closed 偏严无害）；深度门单源 = AnyCodable.maxJSONDepth
    /// （MessageHandler.maxJSONDepth 随仅测试函数于 2026-12 审计删除）。
    func testFenceRejectsDeeplyNestedPayload() {
        var rejected: Any = "leaf"
        for _ in 0..<AnyCodable.maxJSONDepth { rejected = [rejected] }
        XCTAssertEqual(
            ChamberMessageHandler.fence(fenceInput(body: envelope(payload: rejected))),
            .reject(id: 1, code: ChamberMessageHandler.codeMalformedEnvelope))
        // 边界内（payload 上限 = maxJSONDepth - 1）仍接受，避免把上限写死在过严一侧
        var allowed: Any = "leaf"
        for _ in 0..<(AnyCodable.maxJSONDepth - 1) { allowed = [allowed] }
        guard case .accept(_, _, .some) = ChamberMessageHandler.fence(
            fenceInput(body: envelope(payload: allowed))) else {
            return XCTFail("深度 = 上限的 payload 必须通过 fence")
        }
    }

    func testFenceRejectsOversizeEnvelope() {
        let oversized = String(repeating: "a", count: TrustGuard.maxMessageBytes + 1)
        XCTAssertEqual(
            ChamberMessageHandler.fence(fenceInput(body: envelope(payload: oversized))),
            .reject(id: 1, code: ChamberMessageHandler.codeFrameTooLarge))
    }

    /// Phase 3（2026-09-18）：尺寸门的**安全上界短路**不得改变接受集——对若干
    /// 边界载荷，fence 的 accept/reject 必须与「精确 JSONSerialization 计量」
    /// 逐条一致（覆盖短路接受、短路回退、转义密集与多字节字符四类）。
    func testFenceSizeDecisionMatchesExactSerialization() {
        let payloads: [Any] = [
            String(repeating: "a", count: 200_000),                     // 上界在上限内 → 短路接受
            String(repeating: "中", count: 200_000),                     // 上界 6x 超限 → 回退精确
            String(repeating: "\u{01}", count: 200_000),                 // 转义密集
            String(repeating: "a", count: TrustGuard.maxMessageBytes),    // 精确超限 → 拒绝
        ]
        for payload in payloads {
            let body = envelope(payload: payload)
            let exactOK = (try? JSONSerialization.data(withJSONObject: body))
                .map { TrustGuard.envelopeSizeOK($0) } ?? false
            switch ChamberMessageHandler.fence(fenceInput(body: body)) {
            case .accept:
                XCTAssertTrue(exactOK, "精确计量超限却被接受（载荷 (payload.utf8.count) 字节）")
            case .reject(let id, let code):
                XCTAssertEqual(code, ChamberMessageHandler.codeFrameTooLarge)
                XCTAssertEqual(id, 1)
                XCTAssertFalse(exactOK, "精确计量在限内却被拒（载荷 (payload.utf8.count) 字节）")
            case .drop:
                XCTFail("受信信封必须是 accept/reject")
            }
        }
    }

    func testFenceDropsNonChamberChannelAndChildFrame() {
        XCTAssertEqual(
            ChamberMessageHandler.fence(fenceInput(name: "shellConsole", body: envelope())), .drop)
        XCTAssertEqual(
            ChamberMessageHandler.fence(fenceInput(mainFrame: false, body: envelope())), .drop)
    }

    func testExactIntAcceptsIntegralNumbersOnly() {
        XCTAssertEqual(ChamberMessageHandler.exactInt(from: NSNumber(value: 1)), 1)
        XCTAssertEqual(ChamberMessageHandler.exactInt(from: NSNumber(value: 0)), 0)
        XCTAssertEqual(ChamberMessageHandler.exactInt(from: NSNumber(value: -42)), -42)
        XCTAssertEqual(ChamberMessageHandler.exactInt(from: NSNumber(value: Int.max)), Int.max)
        // 布尔桥接为 CFBoolean：不是 id
        XCTAssertNil(ChamberMessageHandler.exactInt(from: NSNumber(value: true)))
        XCTAssertNil(ChamberMessageHandler.exactInt(from: NSNumber(value: false)))
        // 浮点/非有限
        XCTAssertNil(ChamberMessageHandler.exactInt(from: NSNumber(value: 1.5)))
        XCTAssertNil(ChamberMessageHandler.exactInt(from: NSNumber(value: Double.nan)))
        XCTAssertNil(ChamberMessageHandler.exactInt(from: NSNumber(value: Double.infinity)))
        XCTAssertNil(ChamberMessageHandler.exactInt(from: NSNumber(value: -Double.infinity)))
        // 越界（2^63 之上 Int 溢出）
        XCTAssertNil(ChamberMessageHandler.exactInt(from: NSNumber(value: 9_223_372_036_854_775_808.0)))
        // 非数字
        XCTAssertNil(ChamberMessageHandler.exactInt(from: "1"))
        XCTAssertNil(ChamberMessageHandler.exactInt(from: nil))
        XCTAssertNil(ChamberMessageHandler.exactInt(from: [1]))
    }

    func testJSStringLiteralEscapes() {
        XCTAssertEqual(ChamberMessageHandler.jsStringLiteral("plain"), "\"plain\"")
        XCTAssertEqual(ChamberMessageHandler.jsStringLiteral("a\"b"), "\"a\\\"b\"")
        XCTAssertEqual(ChamberMessageHandler.jsStringLiteral("a\\b"), "\"a\\\\b\"")
        XCTAssertEqual(ChamberMessageHandler.jsStringLiteral("a\nb\tc"), "\"a\\nb\\tc\"")
        XCTAssertEqual(ChamberMessageHandler.jsStringLiteral("\u{08}\u{0C}"), "\"\\b\\f\"")
        // 控制字符转 \uXXXX；不可直接落进 JS 字面量
        let literal = ChamberMessageHandler.jsStringLiteral("\u{01}")
        XCTAssertEqual(literal, "\"\\u0001\"")
        XCTAssertFalse(literal.contains("\u{01}"))
        // 非 ASCII 原样保留（JS 字符串允许）
        XCTAssertEqual(ChamberMessageHandler.jsStringLiteral("中文"), "\"中文\"")
    }
}
