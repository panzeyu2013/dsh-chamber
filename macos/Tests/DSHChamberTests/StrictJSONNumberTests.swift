//
//  StrictJSONNumberTests.swift
//  DSHChamberTests
//
//  严格 JSON 数值/布尔的判定矩阵锁（五处调用点
//  FrameCodec.intValue / BridgeClient.exactInt64 / MessageHandler.exactInt /
//  EdgePayload.int / StartupSettings.isBoolean 共同依赖）。
//  矩阵逐条对齐各实现的既有语义，任何一处域语义漂移都先在本文件变红。
//
import XCTest
@testable import DSHChamber

final class StrictJSONNumberTests: XCTestCase {

    func testBoolDiscriminationRejectsNumbers() {
        XCTAssertEqual(StrictJSONNumber.bool(NSNumber(value: true)), true)
        XCTAssertEqual(StrictJSONNumber.bool(NSNumber(value: false)), false)
        // 数字 1/0 是真值陷阱（NSNumber(1) as? Bool == true）——必须拒绝
        XCTAssertNil(StrictJSONNumber.bool(NSNumber(value: 1)))
        XCTAssertNil(StrictJSONNumber.bool(NSNumber(value: 0)))
        XCTAssertNil(StrictJSONNumber.bool(NSNumber(value: 1.0)))
        XCTAssertNil(StrictJSONNumber.bool("true"))
        XCTAssertNil(StrictJSONNumber.bool(nil))
        // StartupSettings.isBoolean 包装同源
        XCTAssertTrue(StartupSettings.isBoolean(NSNumber(value: true)))
        XCTAssertFalse(StartupSettings.isBoolean(NSNumber(value: 1)))
    }

    func testInt64ExactIntegerStorageIsLossless() {
        XCTAssertEqual(StrictJSONNumber.int64(NSNumber(value: 42), domain: .int64Exact), 42)
        XCTAssertEqual(StrictJSONNumber.int64(NSNumber(value: -42), domain: .int64Exact), -42)
        XCTAssertEqual(StrictJSONNumber.int64(NSNumber(value: Int64.min), domain: .int64Exact),
                       Int64.min)
        XCTAssertEqual(StrictJSONNumber.int64(NSNumber(value: Int.max), domain: .int64Exact),
                       Int64.max)
        // 无符号域外存储绝不回绕（该输入不可能来自 WebKit 桥接，
        // 统一为 fail-closed）
        XCTAssertNil(StrictJSONNumber.int64(NSNumber(value: UInt64.max), domain: .int64Exact))
        XCTAssertNil(StrictJSONNumber.int64(NSNumber(value: UInt64.max), domain: .jsExact))
        // Bool 不是整数
        XCTAssertNil(StrictJSONNumber.int64(NSNumber(value: true), domain: .int64Exact))
        XCTAssertNil(StrictJSONNumber.int64(NSNumber(value: false), domain: .jsExact))
        // 非数字桥接类型
        XCTAssertNil(StrictJSONNumber.int64("1", domain: .int64Exact))
        XCTAssertNil(StrictJSONNumber.int64([1], domain: .int64Exact))
        XCTAssertNil(StrictJSONNumber.int64(nil, domain: .int64Exact))
    }

    func testInt64ExactFloatStorage() {
        XCTAssertEqual(StrictJSONNumber.int64(NSNumber(value: 1.0), domain: .int64Exact), 1)
        XCTAssertEqual(StrictJSONNumber.int64(NSNumber(value: 1e16), domain: .int64Exact),
                       10_000_000_000_000_000)
        XCTAssertNil(StrictJSONNumber.int64(NSNumber(value: 1.5), domain: .int64Exact))
        XCTAssertNil(StrictJSONNumber.int64(NSNumber(value: Double.nan), domain: .int64Exact))
        XCTAssertNil(StrictJSONNumber.int64(NSNumber(value: Double.infinity), domain: .int64Exact))
        XCTAssertNil(StrictJSONNumber.int64(NSNumber(value: -Double.infinity), domain: .int64Exact))
        // 浮点存储恰为 -2^63：只可能来自越界 token 的 Double 舍入 → 拒绝
        XCTAssertNil(StrictJSONNumber.int64(NSNumber(value: -9_223_372_036_854_775_808.0),
                                            domain: .int64Exact))
        // 2^63 浮点 → 域外
        XCTAssertNil(StrictJSONNumber.int64(NSNumber(value: 9_223_372_036_854_775_808.0),
                                            domain: .int64Exact))
    }

    /// 两个域的差异点必须显式存在：JS 精确域（±2^53）拒绝 2^53+2，Int64 精确域接受。
    func testDomainsDifferAboveTwoTo53() {
        let above = NSNumber(value: 9_007_199_254_740_994.0)   // 2^53 + 2（Double 可表示）
        XCTAssertEqual(StrictJSONNumber.int64(above, domain: .int64Exact), 9_007_199_254_740_994)
        XCTAssertNil(StrictJSONNumber.int64(above, domain: .jsExact))
        XCTAssertEqual(
            StrictJSONNumber.int64(NSNumber(value: 9_007_199_254_740_992.0), domain: .jsExact),
            9_007_199_254_740_992, "2^53 恰在 JS 精确域内")
        XCTAssertNil(StrictJSONNumber.int64(NSNumber(value: 1.5), domain: .jsExact))
        XCTAssertNil(StrictJSONNumber.int64(NSNumber(value: Double.nan), domain: .jsExact))
    }

    func testDoubleToIntForAnyCodablePayloads() {
        XCTAssertEqual(StrictJSONNumber.int(7), 7)
        XCTAssertEqual(StrictJSONNumber.int(-0.0), 0)
        XCTAssertNil(StrictJSONNumber.int(7.5))
        XCTAssertNil(StrictJSONNumber.int(.nan))
        XCTAssertNil(StrictJSONNumber.int(.infinity))
        XCTAssertNil(StrictJSONNumber.int(-.infinity))
    }

    /// 调用点同源：三处公开入口对同一输入的判定与 helper 一致。
    func testCallSitesShareTheSameJudgement() {
        // FrameCodec.classify 的 id 域 = int64Exact
        XCTAssertEqual(FrameCodec.classify(jsonObject: ["id": 1e16 as Double, "ok": true]),
                       .response(id: 10_000_000_000_000_000, ok: true, result: nil, error: nil))
        XCTAssertNil(FrameCodec.classify(jsonObject: ["id": NSNumber(value: UInt64.max), "ok": true]))
        XCTAssertNil(FrameCodec.classify(jsonObject: ["id": NSNumber(value: true), "ok": true]))
        // MessageHandler.exactInt 的 id 域 = jsExact
        XCTAssertEqual(ChamberMessageHandler.exactInt(from: NSNumber(value: Int.max)), Int.max)
        XCTAssertNil(ChamberMessageHandler.exactInt(from: NSNumber(value: 9_223_372_036_854_775_808.0)))
        XCTAssertNil(ChamberMessageHandler.exactInt(from: NSNumber(value: true)))
        // EdgePayload.int（AnyCodable Double 承载）
        XCTAssertEqual(EdgePayload.int(.number(3)), 3)
        XCTAssertNil(EdgePayload.int(.number(3.5)))
        XCTAssertNil(EdgePayload.int(.string("3")))
        XCTAssertNil(EdgePayload.int(nil))
    }
}
