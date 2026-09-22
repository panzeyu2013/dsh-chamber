//
//  WebKitSupportKVCTests.swift
//  DSHChamberTests
//
//  DSHChamberWebKitSupport 的异常安全 KVC BOOL
//  包装 + MainWindowController 的诊断行文案。透明露底走的是 WKWebView 私有键
//  drawsBackground（KVC，不在公开头文件里）；缺该存取器的 OS 上直设会抛
//  NSUnknownKeyException，而 Swift 无法 catch ObjC 异常 ⇒ 进程 abort（实测
//  exit_code=134）。故单测覆盖两条路径：键存在（设置成功 + 回读一致）与键不存在
//  （返回 Unavailable，且测试进程本身不崩就是证据）。
//
import DSHChamberWebKitSupport
import WebKit
import XCTest
@testable import DSHChamber

final class WebKitSupportKVCTests: XCTestCase {

    /// KVC 等价夹具：@objc dynamic 生成与 WKWebView 私有键同形的 getter/setter，
    /// 作为「键存在」路径的可直测替身（WKWebView 的真实类金丝雀见文末）。
    private final class DrawsBackgroundFixture: NSObject {
        @objc dynamic var drawsBackground = true
    }

    /// 「设置调用成功但没生效」的夹具：吞掉写入、回读仍是 true，
    /// 包装必须如实返回 readBackMismatch 而不是假装成功。
    private final class StickyTrueFixture: NSObject {
        @objc dynamic var drawsBackground = true
        override func setValue(_ value: Any?, forKey key: String) {
            // 故意忽略写入：模拟 setter 表面成功、实际未改值。
        }
    }

    /// C 枚举锁步：raw 值 0/1/2（与头文件同源），Swift 直译集合稳定。
    func testCOutcomeEnumRawValuesAreStable() {
        XCTAssertEqual(DSHChamberBoolKVCOutcome.unavailable.rawValue, 0)
        XCTAssertEqual(DSHChamberBoolKVCOutcome.applied.rawValue, 1)
        XCTAssertEqual(DSHChamberBoolKVCOutcome.readBackMismatch.rawValue, 2)
    }

    /// 键存在时设置成功并可读回（false 与 true 都真实落到对象上）。
    func testExistingBoolKeyIsSetAndReadBack() {
        let fixture = DrawsBackgroundFixture()
        XCTAssertTrue(fixture.drawsBackground, "夹具初值")
        XCTAssertEqual(DSHChamberSetBoolValueForKey(fixture, "drawsBackground", false),
                       .applied, "键存在时必须成功")
        XCTAssertFalse(fixture.drawsBackground, "设置必须真实生效（可读回）")
        XCTAssertEqual(DSHChamberSetBoolValueForKey(fixture, "drawsBackground", true),
                       .applied)
        XCTAssertTrue(fixture.drawsBackground)
    }

    /// 键不存在时返回 Unavailable 且**不崩**——若包装不吞异常，
    /// 这里会以 NSUnknownKeyException 直接终止测试进程（exit_code=134 的同一路径）。
    func testMissingKeyReturnsUnavailableWithoutCrashing() {
        let plain = NSObject()
        XCTAssertEqual(DSHChamberSetBoolValueForKey(plain, "drawsBackground", false),
                       .unavailable, "对象没有该键 → 不得抛异常，返回不可用")
        XCTAssertEqual(DSHChamberSetBoolValueForKey(plain, "dshChamberNoSuchKey", true),
                       .unavailable)
        // nil 对象与空键名同样安全（领域包装的最小防御面）。
        XCTAssertEqual(DSHChamberSetBoolValueForKey(nil, "drawsBackground", false),
                       .unavailable)
        XCTAssertEqual(DSHChamberSetBoolValueForKey(plain, "", false), .unavailable)
        XCTAssertEqual(DSHChamberSetDrawsBackground(nil, false), .unavailable)
    }

    /// 写入调用不抛异常但回读与目标不符 → readBackMismatch（如实报出）。
    func testWriteThatDoesNotStickReportsReadBackMismatch() {
        let fixture = StickyTrueFixture()
        XCTAssertEqual(DSHChamberSetBoolValueForKey(fixture, "drawsBackground", false),
                       .readBackMismatch)
        XCTAssertTrue(fixture.drawsBackground, "回读仍是原值")
    }

    /// 三种结果的诊断行非空、同前缀且互不相同（成功/失败都可诊断）。
    func testDrawsBackgroundLogLineCoversEveryOutcome() {
        let lines = [DSHChamberBoolKVCOutcome.applied, .unavailable, .readBackMismatch]
            .map(MainWindowController.drawsBackgroundLogLine)
        for line in lines {
            XCTAssertTrue(line.hasPrefix("[shell] 透明露底："), line)
        }
        XCTAssertEqual(Set(lines).count, lines.count, "三种结果必须可区分")
    }

    /// 真实类金丝雀（本机锁步，与 RefreshRatePolicyTests 的 canary 同范式）：
    /// 两条分支都是硬断言、不 skip——键在就必须设得动；键不在就必须诚实降级且不崩。
    func testDrawsBackgroundCanaryOnRealWKWebView() {
        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        let outcome = DSHChamberSetDrawsBackground(webView, false)
        if outcome == .unavailable {
            print("[T-4] WKWebView drawsBackground 私有键不可用 → 触发退役判据复核"
                  + "（透明露底只走 underPageBackgroundColor）")
            XCTAssertEqual(DSHChamberSetDrawsBackground(webView, true), .unavailable,
                           "缺键时写入必须一致地返回 Unavailable（不得时好时坏）")
        } else {
            XCTAssertEqual(outcome, .applied, "键在就必须真的设得动且回读一致")
            XCTAssertEqual((webView.value(forKey: "drawsBackground") as? NSNumber)?.boolValue,
                           false, "回读必须为 false")
        }
    }
}