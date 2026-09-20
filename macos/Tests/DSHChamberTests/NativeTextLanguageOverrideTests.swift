//
//  NativeTextLanguageOverrideTests.swift
//  DSHChamberTests
//
//  W3 运行期语言覆盖：NativeText.setLanguageOverride 让壳自建文案（菜单/对话框/
//  失败页）随页面语言**即时**跟随——CFBundle 的 preferredLocalizations 是进程
//  启动期缓存，只写 AppleLanguages 不会让运行期取串换语言，故需要显式 .lproj 覆盖。
//
//  纪律：覆盖是进程级静态状态，测试必须自清（tearDown），否则污染同进程的其它用例。
//
import XCTest
@testable import DSHChamber

final class NativeTextLanguageOverrideTests: XCTestCase {

    override func tearDown() {
        NativeText.setLanguageOverride(nil)
        super.tearDown()
    }

    /// 覆盖即可切语言（两个方向的资源都必须随包可解析）。
    func testOverrideSwitchesResolvedCopyImmediately() {
        XCTAssertTrue(NativeText.setLanguageOverride(.zh),
                      "zh-Hans 资源必须可解析（打包态 Contents/Resources 或 SwiftPM 资源包）")
        XCTAssertEqual(NativeText.string(.menuFile), "文件")
        XCTAssertEqual(NativeText.string(.commonOk), "好")

        XCTAssertTrue(NativeText.setLanguageOverride(.en), "en 资源必须可解析")
        XCTAssertEqual(NativeText.string(.menuFile), "File")
        XCTAssertEqual(NativeText.string(.commonOk), "OK")
    }

    /// 清除覆盖后回落 bundle 解析（进程语言由环境决定，故只断言「不是键名」）。
    func testClearingOverrideFallsBackToBundleResolution() {
        XCTAssertTrue(NativeText.setLanguageOverride(.zh))
        XCTAssertEqual(NativeText.string(.menuFile), "文件")
        XCTAssertTrue(NativeText.setLanguageOverride(nil))
        let resolved = NativeText.string(.menuFile)
        XCTAssertTrue(resolved == "文件" || resolved == "File",
                      "清除覆盖后必须回到 bundle 解析，而不是回落键名：\(resolved)")
    }

    /// 占位符仍按 printf 填参（覆盖只换 bundle，不换格式语义）。
    func testOverrideKeepsFormatSemantics() {
        XCTAssertTrue(NativeText.setLanguageOverride(.en))
        XCTAssertEqual(NativeText.format(.menuAboutApp, "dsh-chamber"), "About dsh-chamber")
        XCTAssertTrue(NativeText.setLanguageOverride(.zh))
        XCTAssertEqual(NativeText.format(.menuAboutApp, "dsh-chamber"), "关于 dsh-chamber")
    }
}
