//
//  AnyCodableTests.swift — AnyCodable（B 桥载荷载体，design 25 §4.4.2）
//  纯逻辑单测：JSON 往返互逆、jsonLiteralText 语义、fromJSONObject 判别。
//  测试侧保留 legacyJSONObject
//  基线以维持"单遍写出 == 老 JSONSerialization 口径"的等价断言。
//
import XCTest
@testable import DSHChamber

final class AnyCodableTests: XCTestCase {
    private func decodeJSON<T: Decodable>(_ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    /// 测试侧 legacy 基线：`AnyCodable.jsonObject` 的逐字复刻
    /// （JSONSerialization 可写投影：整值 Double → NSNumber(int64)，非整值 →
    /// NSNumber(double)，容器递归）。这里只为单遍写出器
    /// 的"解析后语义等价"断言保留一个老口径参照物。
    private func legacyJSONObject(_ value: AnyCodable) -> Any {
        switch value {
        case .null:
            return NSNull()
        case .bool(let flag):
            return flag
        case .number(let number):
            if number.isFinite, number == number.rounded(),
               let integer = Int64(exactly: number) {
                return NSNumber(value: integer)
            }
            return NSNumber(value: number)
        case .string(let text):
            return text
        case .array(let values):
            return values.map { legacyJSONObject($0) }
        case .object(let entries):
            return entries.mapValues { legacyJSONObject($0) }
        }
    }

    func testJSONRoundtripNested() throws {
        let json = #"{"a":1,"b":true,"c":null,"d":[1.5,"s",false],"e":{"nested":{"x":"y"}}}"#
        let value: AnyCodable = try decodeJSON(json)
        let encoded = try JSONEncoder().encode(value)
        let reparsed = try JSONSerialization.jsonObject(with: encoded)
        let original = try JSONSerialization.jsonObject(with: Data(json.utf8))
        XCTAssertEqual(reparsed as? NSObject, original as? NSObject)
    }

    func testScalarTopLevels() throws {
        XCTAssertEqual(try decodeJSON("42") as AnyCodable, .number(42))
        XCTAssertEqual(try decodeJSON(#""hi""#) as AnyCodable, .string("hi"))
        XCTAssertEqual(try decodeJSON("true") as AnyCodable, .bool(true))
        XCTAssertEqual(try decodeJSON("null") as AnyCodable, .null)
        XCTAssertEqual(try decodeJSON("[1,2]") as AnyCodable, .array([.number(1), .number(2)]))
    }

    func testFromJSONObjectDiscrimination() {
        // NSNumber(1) as? Bool 在 Swift 中为 true——必须按 CFTypeID 判别（A3 平台坑）
        XCTAssertEqual(AnyCodable.fromJSONObject(NSNumber(value: 1)), .number(1))
        XCTAssertEqual(AnyCodable.fromJSONObject(NSNumber(value: true)), .bool(true))
        XCTAssertEqual(AnyCodable.fromJSONObject("s" as NSString), .string("s"))
        XCTAssertEqual(AnyCodable.fromJSONObject(NSNull()), .null)
        XCTAssertEqual(AnyCodable.fromJSONObject([1, "a"] as NSArray),
                       .array([.number(1), .string("a")]))
        XCTAssertEqual(AnyCodable.fromJSONObject(["k": 2] as NSDictionary), .object(["k": .number(2)]))
        XCTAssertNil(AnyCodable.fromJSONObject(Date()))
        // Swift 原生桥接
        XCTAssertEqual(AnyCodable.fromJSONObject(["k": true]), .object(["k": .bool(true)]))
    }

    func testNumberIntegralRestore() throws {
        // 整值 Double 经 JSONEncoder → 数字 token；legacy 基线应还原为 Int 语义
        let value = AnyCodable.number(7)
        let data = try JSONEncoder().encode(value)
        let round: AnyCodable = try JSONDecoder().decode(AnyCodable.self, from: data)
        guard case .number(let d) = round else { return XCTFail("number case 丢失") }
        XCTAssertEqual(Int(d), 7)
        let obj = legacyJSONObject(round)
        XCTAssertEqual((obj as? NSNumber)?.int64Value, 7)
    }

    /// JSON 桥接的非有限数值必须被拒绝（否则下游 Int(n) trap）。
    func testFromJSONObjectRejectsNonFiniteNumbers() {
        XCTAssertNil(AnyCodable.fromJSONObject(NSNumber(value: Double.infinity)))
        XCTAssertNil(AnyCodable.fromJSONObject(NSNumber(value: -Double.infinity)))
        XCTAssertNil(AnyCodable.fromJSONObject(NSNumber(value: Double.nan)))
        XCTAssertEqual(AnyCodable.fromJSONObject(NSNumber(value: 1.5)), .number(1.5))
        // 嵌套同样拒绝
        XCTAssertNil(AnyCodable.fromJSONObject(["k": NSNumber(value: Double.infinity)]))
        XCTAssertNil(AnyCodable.fromJSONObject([NSNumber(value: Double.nan)]))
    }

    /// 深度门单源 = AnyCodable.maxJSONDepth（A 桥
    /// fence 与 B 桥解码共用）。
    /// 边界断言保留。
    func testDepthLimitBoundary() {
        var allowed: Any = "leaf"
        for _ in 0..<AnyCodable.maxJSONDepth { allowed = [allowed] }
        XCTAssertNotNil(AnyCodable.fromJSONObject(allowed), "深度 = 上限的嵌套必须可转换")
        var tooDeep: Any = "leaf"
        for _ in 0...AnyCodable.maxJSONDepth { tooDeep = [tooDeep] }
        XCTAssertNil(AnyCodable.fromJSONObject(tooDeep), "超过上限一层即拒绝（fail closed）")
    }

    /// 页面字面量走单遍写出器——-0.0 折叠为 "0"（与旧
    /// legacy 基线路径逐字一致）；B 桥出帧（request）的 JSONEncoder 往返保持既有行为。
    func testJsonLiteralTextSemantics() throws {
        XCTAssertEqual(AnyCodable.null.jsonLiteralText, "null")
        XCTAssertEqual(AnyCodable.bool(true).jsonLiteralText, "true")
        XCTAssertEqual(AnyCodable.number(-0.0).jsonLiteralText, "0")
        XCTAssertEqual(AnyCodable.number(3.0).jsonLiteralText, "3")
        XCTAssertEqual(AnyCodable.number(0.1).jsonLiteralText, "0.1")
        XCTAssertEqual(AnyCodable.number(1e18).jsonLiteralText, "1000000000000000000")
        XCTAssertEqual(AnyCodable.number(1e21).jsonLiteralText, "1e+21")
        XCTAssertEqual(AnyCodable.number(.nan).jsonLiteralText, "null",
                       "非有限值诚实降级（旧路径 JSONSerialization 会抛 NSException 崩进程）")
        XCTAssertEqual(AnyCodable.string("a\"b\\c/d").jsonLiteralText, "\"a\\\"b\\\\c/d\"")
        XCTAssertEqual(AnyCodable.string("中文🚀").jsonLiteralText, "\"中文🚀\"")
        XCTAssertEqual(AnyCodable.string("\u{2028}x").jsonLiteralText, "\"\\u2028x\"")
        XCTAssertEqual(AnyCodable.string("\u{01}").jsonLiteralText, "\"\\u0001\"")
        XCTAssertEqual(AnyCodable.array([.number(1), .bool(true), .null]).jsonLiteralText,
                       "[1,true,null]")
        XCTAssertEqual(AnyCodable.object(["k": .array([.number(1)])]).jsonLiteralText,
                       "{\"k\":[1]}")
        // 空容器与嵌套 -0 的边界
        XCTAssertEqual(AnyCodable.array([]).jsonLiteralText, "[]")
        XCTAssertEqual(AnyCodable.object([:]).jsonLiteralText, "{}")
        XCTAssertEqual(AnyCodable.array([.object(["z": .number(-0.0)])]).jsonLiteralText, "[{\"z\":0}]")
        // B 桥出帧（FrameCodec.encode → JSONEncoder）输出 -0
        XCTAssertEqual(String(data: try JSONEncoder().encode(AnyCodable.number(-0.0)), encoding: .utf8), "-0")
    }

    /// 单遍写出与 legacy 基线（jsonObject + JSONSerialization）解析后语义等价。
    func testJsonLiteralTextMatchesLegacySerialization() throws {
        let values: [AnyCodable] = [
            .null, .bool(false), .number(0), .number(-0.0), .number(0.1), .number(1e18), .number(1e21),
            .string("a\"b\\c/d"), .string("中文🚀"), .string("\u{2028}\u{0001}"),
            .array([.null, .bool(true), .number(2.5), .string("x")]),
            .object(["k": .array([.object(["n": .number(1)])]), "e": .string("🚀")]),
        ]
        for value in values {
            let legacyData = try JSONSerialization.data(withJSONObject: legacyJSONObject(value),
                                                        options: [.fragmentsAllowed])
            let legacy = try JSONSerialization.jsonObject(with: legacyData, options: [.fragmentsAllowed])
            let custom = try JSONSerialization.jsonObject(with: Data(value.jsonLiteralText.utf8),
                                                          options: [.fragmentsAllowed])
            XCTAssertEqual(legacy as? NSObject, custom as? NSObject,
                           "语义不等价：\(value) legacy=\(String(decoding: legacyData, as: UTF8.self)) custom=\(value.jsonLiteralText)")
        }
    }

    /// 尺寸门的安全上界——`jsonUpperBoundByteCount` 必须
    /// 恒 ≥ 实际序列化字节数（单遍写出与 JSONSerialization 两条口径）。
    /// 该不等式是 MessageHandler ⑤「上界 ≤ 上限 ⇒ 必过」短路的唯一前提。
    func testJsonUpperBoundCoversActualSerialization() throws {
        // 非有限值单独走字面量口径：legacy 基线会把它们交给 JSONSerialization，
        // 后者对 NaN/±Infinity 抛 **不可捕获的 NSException**（try? 拦不住，上面
        // testJsonLiteralTextSemantics 的注释与 fence ⑤ 的可表示性前置同因），
        // 故不进下面那条 legacy 比较。
        for nonFinite in [AnyCodable.number(.nan), .number(.infinity), .number(-.infinity)] {
            XCTAssertGreaterThanOrEqual(nonFinite.jsonUpperBoundByteCount,
                                        nonFinite.jsonLiteralText.utf8.count,
                                        "上界小于单遍写出实际长度：\(nonFinite)")
        }
        let values: [AnyCodable] = [
            .null, .bool(true), .bool(false), .number(0), .number(-0.0),
            .number(1e21), .number(-1.7976931348623157e308),
            .string(""),
            .string(String(repeating: "a", count: 100_000)),
            .string(String(repeating: "\u{01}", count: 1_000)),
            .string(String(repeating: "中", count: 10_000)),
            .string("\u{2028}\u{2029}\"\\"),
            .array([.string(String(repeating: "x", count: 5_000)), .number(1e21)]),
            .object(["k\u{2028}": .array([.null, .bool(true)]), "s": .string("中文🚀")]),
        ]
        for value in values {
            let literal = value.jsonLiteralText.utf8.count
            XCTAssertGreaterThanOrEqual(value.jsonUpperBoundByteCount, literal,
                                        "上界小于单遍写出实际长度：\(value)")
            // 非有限值经 legacy 基线会让 JSONSerialization 抛异常（try? 拦下）→ 跳过该口径。
            if let legacy = try? JSONSerialization.data(withJSONObject: legacyJSONObject(value),
                                                        options: [.fragmentsAllowed]) {
                XCTAssertGreaterThanOrEqual(value.jsonUpperBoundByteCount, legacy.count,
                                            "上界小于 JSONSerialization 实际长度：\(value)")
            }
        }
    }
}
