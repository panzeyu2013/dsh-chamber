//
//  AnyCodableTests.swift — W-05 AnyCodable（B 桥载荷载体，design 25 §4.4.2）
//  纯逻辑单测：JSON 往返互逆、jsonObject 桥接、fromJSONObject 判别。
//
import XCTest
@testable import DSHChamberPoc

final class AnyCodableTests: XCTestCase {
    private func decodeJSON<T: Decodable>(_ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
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

    func testJsonObjectBridging() throws {
        let value: AnyCodable = try decodeJSON(#"{"i":1,"f":1.5,"b":true,"n":null,"arr":[2]}"#)
        guard let obj = value.jsonObject as? [String: Any] else { return XCTFail("object 桥接失败") }
        XCTAssertEqual(obj["i"] as? Int, 1)        // 整值还原
        XCTAssertEqual(obj["f"] as? Double, 1.5)
        XCTAssertEqual(obj["b"] as? Bool, true)
        XCTAssertTrue(obj["n"] is NSNull)
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
        // 整值 Double 经 JSONEncoder → 数字 token；jsonObject 应还原为 Int 语义
        let value = AnyCodable.number(7)
        let data = try JSONEncoder().encode(value)
        let round: AnyCodable = try JSONDecoder().decode(AnyCodable.self, from: data)
        guard case .number(let d) = round else { return XCTFail("number case 丢失") }
        XCTAssertEqual(Int(d), 7)
        let obj = round.jsonObject
        XCTAssertEqual((obj as? NSNumber)?.int64Value, 7)
    }
}
