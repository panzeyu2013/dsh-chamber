//
//  BrowserGuestContentRuleCompileTests.swift — content rule 必须被真 WebKit 接受
//  （design 28 v3 §5；decisions D2）
//
//  为什么必须真编译：WKContentRuleListStore 的 url-filter 是受限正则子集（不允许 | 与
//  {m,n} 等）。文本断言只能证明我们没写那些字符，**不能证明 WebKit 真接受**——编译失败
//  = 两份规则都不可用 = guest 启动即 fail-closed（App 里永远看不到浏览器）。
//
//  存储选择：默认 store 在无 app bundle 的进程里可能报 WKErrorDomain 6（命令行实测）；
//  这里用文件后备 store（WKContentRuleListStore(url:)，reviewer/实现方均实测可编译），
//  每个测试一个唯一临时目录，随测试删。异步等待编译回调。
//
import WebKit
import XCTest
@testable import DSHChamber

final class BrowserGuestContentRuleCompileTests: XCTestCase {
    /// 文件后备 store：每个用例独立临时目录（不依赖 app bundle 的默认 store）。
    private func makeStore() throws -> WKContentRuleListStore {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("chamber-content-rule-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return try XCTUnwrap(WKContentRuleListStore(url: directory),
                             "WKContentRuleListStore(url:) 初始化失败：\(directory.path)")
    }

    /// base（local 来源）与 ssh（mayForward 来源）两个变体都必须编译成功。
    func testBothVariantsCompileOnRealWebKitStore() throws {
        let store = try makeStore()
        let variants: [(String, String)] = [
            ("base", BrowserGuestContentRules.json(controlPlanePort: 17520,
                                                   blocksDirectLoopback: false)),
            ("ssh", BrowserGuestContentRules.json(controlPlanePort: 17520,
                                                  blocksDirectLoopback: true)),
        ]
        var waits: [XCTestExpectation] = []
        for (variant, json) in variants {
            let identifier = "chamber-test-guest-apphost-\(variant)-\(UUID().uuidString)"
            let compiled = expectation(description: "WKContentRuleList 编译（\(variant)）")
            waits.append(compiled)
            store.compileContentRuleList(forIdentifier: identifier,
                                         encodedContentRuleList: json) { list, error in
                if let error {
                    XCTFail("\(variant) 变体被 WebKit 拒绝：\(error.localizedDescription)")
                } else {
                    XCTAssertNotNil(list, "\(variant) 变体编译结果必须是 WKContentRuleList")
                }
                compiled.fulfill()
            }
        }
        wait(for: waits, timeout: 20)
    }

    /// 端口非法 → "[]"：空数组不是可安装的规则列表（WebKit 编译会失败），所以这里只锁
    /// 输出文本（registry 正常端口恒非空，不会把空表送 WebKit）；不把「编译失败」当契约测。
    func testInvalidPortProducesEmptyJSONText() {
        XCTAssertEqual(BrowserGuestContentRules.json(controlPlanePort: 0), "[]")
        XCTAssertTrue(BrowserGuestContentRules.ruleObjects(controlPlanePort: 0).isEmpty)
    }
}
