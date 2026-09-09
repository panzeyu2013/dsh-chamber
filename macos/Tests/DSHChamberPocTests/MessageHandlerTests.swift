//
//  MessageHandlerTests.swift
//  DSHChamberPocTests
//
//  模块评审 major 收口：ChamberMessageHandler 是 A 桥四护栏的**唯一执行点**，此前
//  13 个测试文件里零覆盖。`didReceive` 需要 WKScriptMessage（WebKit 无公开
//  构造器，frameInfo 不可伪造），因此本文件直接测**纯函数判定层**：
//    - exactInt：id 整值域（布尔/NaN/±Inf/越界/浮点全部拒绝）
//    - isJSONSerializableValue：NaN/±Infinity/深度上限/fail-closed
//    - jsStringLiteral：引号/反斜杠/控制字符/Unicode 转义
//    - jsPayloadLiteral：载荷 JSON 文本（含剥壳数组）
//    - 拒绝码常量：与 design 25 §4.4.1 / renderer-trust 同族字面量
//
import XCTest
@testable import DSHChamberPoc

final class MessageHandlerTests: XCTestCase {

    func testRejectCodesAreStableLiterals() {
        // 这些码是跨语言契约（shim/preload 侧同族命名），改动必须同步文档。
        XCTAssertEqual(ChamberMessageHandler.codeSenderForbidden, "ipc_sender_forbidden")
        XCTAssertEqual(ChamberMessageHandler.codeMethodNotAllowed, "method_not_allowed")
        XCTAssertEqual(ChamberMessageHandler.codeFrameTooLarge, "frame_too_large")
        XCTAssertEqual(ChamberMessageHandler.codeMalformedEnvelope, "malformed_envelope")
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

    func testJSONSerializableValueRejectsNonFiniteAndDeepNesting() {
        XCTAssertTrue(ChamberMessageHandler.isJSONSerializableValue(NSNull()))
        XCTAssertTrue(ChamberMessageHandler.isJSONSerializableValue("text"))
        XCTAssertTrue(ChamberMessageHandler.isJSONSerializableValue(NSNumber(value: 1.25)))
        XCTAssertTrue(ChamberMessageHandler.isJSONSerializableValue(NSNumber(value: true)))
        XCTAssertTrue(ChamberMessageHandler.isJSONSerializableValue([1, "a", NSNull()]))
        XCTAssertTrue(ChamberMessageHandler.isJSONSerializableValue(["k": [1, 2]]))
        // NaN/±Infinity 是 JSON 表示之外的值（JSONSerialization 抛 NSException）
        XCTAssertFalse(ChamberMessageHandler.isJSONSerializableValue(NSNumber(value: Double.nan)))
        XCTAssertFalse(ChamberMessageHandler.isJSONSerializableValue(NSNumber(value: Double.infinity)))
        XCTAssertFalse(ChamberMessageHandler.isJSONSerializableValue(["k": NSNumber(value: -Double.infinity)]))
        // 非 JSON 桥接类型 fail-closed
        XCTAssertFalse(ChamberMessageHandler.isJSONSerializableValue(Date()))
        XCTAssertFalse(ChamberMessageHandler.isJSONSerializableValue(NSObject()))
        // 深度上限：超限拒绝（防 <4MiB 极深信封击穿栈）
        var nested: Any = "leaf"
        for _ in 0...(ChamberMessageHandler.maxJSONDepth + 2) {
            nested = [nested]
        }
        XCTAssertFalse(ChamberMessageHandler.isJSONSerializableValue(nested))
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

    func testJSPayloadLiteralStripsArrayWrapper() {
        XCTAssertNil(ChamberMessageHandler.jsPayloadLiteral(nil))
        XCTAssertEqual(ChamberMessageHandler.jsPayloadLiteral(.string("x")), "\"x\"")
        XCTAssertEqual(ChamberMessageHandler.jsPayloadLiteral(.number(3)), "3")
        XCTAssertEqual(ChamberMessageHandler.jsPayloadLiteral(.null), "null")
        XCTAssertEqual(ChamberMessageHandler.jsPayloadLiteral(.object(["a": .bool(true)])), "{\"a\":true}")
        XCTAssertEqual(ChamberMessageHandler.jsPayloadLiteral(.array([.number(1), .number(2)])), "[1,2]")
    }

    func testAnyCodablePayloadRoundTrip() {
        XCTAssertNil(ChamberMessageHandler.anyCodablePayload(from: Date()))
        XCTAssertEqual(ChamberMessageHandler.anyCodablePayload(from: "s"), .string("s"))
        XCTAssertEqual(ChamberMessageHandler.anyCodablePayload(from: NSNumber(value: 7)), .number(7))
        XCTAssertEqual(ChamberMessageHandler.anyCodablePayload(from: ["k": "v"]), .object(["k": .string("v")]))
        XCTAssertEqual(ChamberMessageHandler.anyCodablePayload(from: [1, 2]), .array([.number(1), .number(2)]))
        // NaN 不是 JSON 值 → nil（与 isJSONSerializableValue 同向）
        XCTAssertNil(ChamberMessageHandler.anyCodablePayload(from: NSNumber(value: Double.nan)))
    }
}
