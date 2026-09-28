//
//  SidecarVersionContractTests.swift
//  DSHChamberTests
//
//  装配态壳版本 == sidecar package.json 版本的 fail-loud 判据（design 25 §3.1
//  ready 帧 shellVersion）。AppDelegate.onReady 只对装配态 sidecar
//  （basename=sidecar.js）启用断言；dev/自定义脚本与壳没有版本同源关系。
//
import XCTest
@testable import DSHChamber

final class SidecarVersionContractTests: XCTestCase {

    func testEqualVersionsPass() {
        XCTAssertNil(SidecarVersionContract.mismatchMessage(shellVersion: "1.2.3",
                                                            sidecarVersion: "1.2.3"))
        XCTAssertNil(SidecarVersionContract.mismatchMessage(shellVersion: "1.2.3-beta.4",
                                                            sidecarVersion: "1.2.3-beta.4"),
                     "beta 后缀也必须逐字相等（beta.4 装进 beta.5 的壳同样不许带病运行）")
    }

    func testMismatchIsReportedWithBothVersions() {
        guard let message = SidecarVersionContract.mismatchMessage(shellVersion: "1.2.3",
                                                                   sidecarVersion: "1.2.2") else {
            return XCTFail("版本不等必须产出 fatal 文案")
        }
        XCTAssertTrue(message.contains("1.2.3") && message.contains("1.2.2"),
                      "文案必须同时带壳与 sidecar 版本，便于定位混合装配：\(message)")
    }

    /// 接线锁：OnReady 必须真的用装配态标志门控并把不一致送 fatalStartup
    /// （纯函数绿但没接线 = 断言等于不存在）。
    func testAppDelegateWiresTheAssertionForCompiledSidecarOnly() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // DSHChamberTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // macos
            .deletingLastPathComponent()   // repo root
        let appDelegate = try String(contentsOf: root
            .appendingPathComponent("macos/Sources/DSHChamber/AppDelegate.swift"),
            encoding: .utf8)
        XCTAssertTrue(appDelegate.contains("let enforceSidecarVersionEquality = compiledSidecar"),
                      "断言必须只对装配态 sidecar（compiledSidecar）启用")
        XCTAssertTrue(appDelegate.contains("if enforceSidecarVersionEquality,")
                      && appDelegate.contains("SidecarVersionContract.mismatchMessage("),
                      "onReady 必须调用版本判据（fail-loud，不得只记日志）")
        XCTAssertTrue(appDelegate.contains("DispatchQueue.main.async { self.fatalStartup(mismatch) }"),
                      "不一致必须经 fatalStartup 可见呈现 + 退出（与端口错配同路）")
    }

    func testDevShellWithoutBundleVersionSkipsAssertion() {
        XCTAssertNil(SidecarVersionContract.mismatchMessage(
            shellVersion: SidecarVersionContract.unknownShellVersion, sidecarVersion: "9.9.9"),
            "dev（swift run 无 Info.plist）壳版本不可得 = 无契约可比，必须跳过而不是误杀")
        XCTAssertNil(SidecarVersionContract.mismatchMessage(shellVersion: "", sidecarVersion: "9.9.9"),
                     "空版本同样视为不可得")
    }
}
