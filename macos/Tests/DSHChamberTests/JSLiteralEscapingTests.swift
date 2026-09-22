//
//  JSLiteralEscapingTests.swift
//  DSHChamberTests
//
//  2026-12 单源化：JS 字面量转义的**唯一实现** = AnyCodable 的单遍写出器
//  （AnyCodable.writeJSONString / jsonLiteralText）。两条生产出口都经它：
//    - 页面注入：MainWindowController.jsonLiteral(of:) → __dshChamberResolve /
//      __dshChamberEmit 的 evaluateJavaScript 源码；
//    - A 桥回执：MessageHandler.jsStringLiteral（委托）。
//  旧的 JSONSerialization 出口（MainWindowController.jsonLiteral(_:Any)）与
//  手工转义循环（MessageHandler.jsStringLiteral 原实现）已删除；本文件把
//  转义矩阵与「同源」做成锁，防任何一侧重新长出第二份转义表。
//
import XCTest
@testable import DSHChamber

final class JSLiteralEscapingTests: XCTestCase {

    /// 覆盖：空串 / 引号 / 反斜杠 / 全部短转义 / 其余 C0 / DEL / 行分隔符 /
    /// 多字节 / 代理对（emoji）/ CRLF / 垂直制表 / 高码位。
    private let matrix: [String] = [
        "",
        "plain",
        "a\"b",
        "a\\b",
        "a\nb\tc",
        "\u{08}\u{0C}",
        "\u{01}",
        "\u{0B}",                     // VT：无短转义 → \u000B
        "\u{1F}",
        "\u{7F}",                     // DEL ≥ 0x20：原样保留
        "line1\r\nline2",
        "\u{2028}",
        "\u{2029}",
        "a\u{2028}b\u{2029}c",
        "中文🚀",
        "\"quote\" and \\backslash\\",
        "\u{FFFF}",
        "\u{10FFFF}",
        String(repeating: "\u{00}", count: 3),
    ]

    /// 锁条一：两个出口逐字节同源（单实现）。
    func testBothExitsAreByteIdentical() {
        for value in matrix {
            let receipt = ChamberMessageHandler.jsStringLiteral(value)
            let page = MainWindowController.jsonLiteral(of: .string(value))
            XCTAssertEqual(receipt, page, "回执/页面字面量不同源：\(value.debugDescription)")
        }
    }

    /// 锁条二：字面量是合法 JSON（可回解为原串），且不含任何未转义的
    /// C0 控制字符与 U+2028/U+2029（注入 evaluateJavaScript 的源码安全前提）。
    func testLiteralIsValidJSONAndCarriesNoRawControlOrLineSeparator() throws {
        for value in matrix {
            let literal = AnyCodable.string(value).jsonLiteralText
            XCTAssertTrue(literal.hasPrefix("\""), "字面量必须以引号开始：\(literal)")
            XCTAssertTrue(literal.hasSuffix("\""), "字面量必须以引号结束：\(literal)")
            // A top-level JSON string is a fragment: Foundation only parses it
            // with the explicit opt-in (the first matrix entry is '').
            let decoded = try JSONSerialization.jsonObject(with: Data(literal.utf8), options: [.fragmentsAllowed])
            XCTAssertEqual(decoded as? String, value,
                           "字面量回解不等于原值：\(literal)")
            for scalar in literal.unicodeScalars {
                XCTAssertFalse(scalar.value < 0x20,
                               "未转义控制字符 U+\(String(scalar.value, radix: 16, uppercase: true))：\(literal)")
                XCTAssertFalse(scalar.value == 0x2028 || scalar.value == 0x2029,
                               "未转义行分隔符：\(literal)")
            }
        }
    }

    /// 锁条三：短转义与 \uXXXX 的精确拼写（大写十六进制、四位数），
    /// 防未来换成小写/变长形式导致跨语言断言漂移。
    func testExactEscapeSpelling() {
        XCTAssertEqual(AnyCodable.string("\"\\").jsonLiteralText, "\"\\\"\\\\\"")
        XCTAssertEqual(AnyCodable.string("\u{08}\u{0C}\n\r\t").jsonLiteralText,
                       "\"\\b\\f\\n\\r\\t\"")
        XCTAssertEqual(AnyCodable.string("\u{00}\u{01}\u{1F}").jsonLiteralText,
                       "\"\\u0000\\u0001\\u001F\"")
        XCTAssertEqual(AnyCodable.string("\u{2028}\u{2029}").jsonLiteralText,
                       "\"\\u2028\\u2029\"")
        XCTAssertEqual(AnyCodable.string("\u{7F}\u{80}").jsonLiteralText, "\"\u{7F}\u{80}\"")
    }

    /// 锁条四：对象键走同一转义路径（键也必须是合法 JS 字符串字面量）。
    func testObjectKeysUseTheSameEscaping() {
        XCTAssertEqual(AnyCodable.object(["k\u{2028}": .null]).jsonLiteralText,
                       "{\"k\\u2028\":null}")
        XCTAssertEqual(AnyCodable.object(["a\"b": .bool(true)]).jsonLiteralText,
                       "{\"a\\\"b\":true}")
    }
}
