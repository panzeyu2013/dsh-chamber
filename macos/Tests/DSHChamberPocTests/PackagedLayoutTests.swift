//
//  PackagedLayoutTests.swift
//  DSHChamberPocTests
//
//  三审收口 #1/#2：打包态默认路径解析（node / sidecar / userData 同根 /
//  vendor-dsh 工作区）必须是纯函数且可单测——否则「Finder 双击 .app 可用」
//  只能靠手工 env 复现（一审已登记为 major）。
//
import XCTest
@testable import DSHChamberPoc

final class PackagedLayoutTests: XCTestCase {
    private let resources = "/Applications/dsh-chamber-native.app/Contents/Resources"

    func testIsAppBundle() {
        XCTAssertTrue(PackagedLayout.isAppBundle(
            executablePath: "/Applications/dsh-chamber-native.app/Contents/MacOS/DSHChamberPoc"))
        XCTAssertFalse(PackagedLayout.isAppBundle(executablePath: "/repo/macos/.build/debug/DSHChamberPoc"))
        XCTAssertFalse(PackagedLayout.isAppBundle(executablePath: ""))
    }

    func testLayoutPathsMatchBuildScript() {
        XCTAssertEqual(PackagedLayout.sidecarDir(resourcesDir: resources), resources + "/sidecar")
        XCTAssertEqual(PackagedLayout.sidecarScript(resourcesDir: resources), resources + "/sidecar/sidecar.js")
        XCTAssertEqual(PackagedLayout.nodeBinary(resourcesDir: resources), resources + "/sidecar/node")
        XCTAssertEqual(PackagedLayout.dshWorkspace(resourcesDir: resources), resources + "/sidecar/vendor/dsh")
        XCTAssertEqual(PackagedLayout.webDistDir(resourcesDir: resources), resources + "/dist/web")
        XCTAssertEqual(PackagedLayout.userDataDir(home: "/Users/tester"),
                       "/Users/tester/Library/Application Support/dsh-chamber")
    }

    func testResolveNode() {
        let bundled = resources + "/sidecar/node"
        let exists: (String) -> Bool = { $0 == bundled }
        // env 优先
        XCTAssertEqual(PackagedLayout.resolveNode(
            env: ["POC_NODE_BIN": "/custom/node"], resourcesDir: resources,
            isPackaged: true, exists: exists), "/custom/node")
        // 装配态自带 node
        XCTAssertEqual(PackagedLayout.resolveNode(
            env: [:], resourcesDir: resources, isPackaged: true, exists: exists), bundled)
        // 装配态但缺 node → 旧缺省（Electron 二进制当 Node）
        XCTAssertEqual(PackagedLayout.resolveNode(
            env: [:], resourcesDir: resources, isPackaged: true, exists: { _ in false }),
            "/Applications/dsh-chamber.app/Contents/MacOS/dsh-chamber")
        // dev 态不解析装配路径
        XCTAssertEqual(PackagedLayout.resolveNode(
            env: [:], resourcesDir: resources, isPackaged: false, exists: exists),
            "/Applications/dsh-chamber.app/Contents/MacOS/dsh-chamber")
        // resourcesDir 缺失不崩
        XCTAssertEqual(PackagedLayout.resolveNode(
            env: [:], resourcesDir: nil, isPackaged: true, exists: { _ in true }),
            "/Applications/dsh-chamber.app/Contents/MacOS/dsh-chamber")
    }

    func testResolveSidecar() {
        let bundled = resources + "/sidecar/sidecar.js"
        let exists: (String) -> Bool = { $0 == bundled }
        XCTAssertEqual(PackagedLayout.resolveSidecar(
            env: ["POC_SIDECAR": "/custom/entry.js"], resourcesDir: resources,
            isPackaged: true, exists: exists), "/custom/entry.js")
        XCTAssertEqual(PackagedLayout.resolveSidecar(
            env: [:], resourcesDir: resources, isPackaged: true, exists: exists), bundled)
        XCTAssertNil(PackagedLayout.resolveSidecar(
            env: [:], resourcesDir: resources, isPackaged: true, exists: { _ in false }))
        // dev 态返回 nil，调用方回退向上查找 poc-sidecar.ts / sidecar-entry.ts
        XCTAssertNil(PackagedLayout.resolveSidecar(
            env: [:], resourcesDir: resources, isPackaged: false, exists: exists))
    }

    func testResolveUserData() {
        XCTAssertEqual(PackagedLayout.resolveUserData(
            env: ["POC_USER_DATA": "/custom/ud"], home: "/Users/tester", isPackaged: true), "/custom/ud")
        // 装配态与 Electron 打包实根同根（design 25 §6.1 U1）
        XCTAssertEqual(PackagedLayout.resolveUserData(
            env: [:], home: "/Users/tester", isPackaged: true),
            "/Users/tester/Library/Application Support/dsh-chamber")
        // dev 保持独立目录（不污染真实 userData）
        XCTAssertEqual(PackagedLayout.resolveUserData(
            env: [:], home: "/Users/tester", isPackaged: false),
            "/Users/tester/Library/Application Support/dsh-chamber-poc-dev")
    }

    func testResolveDshWorkspace() {
        let bundled = resources + "/sidecar/vendor/dsh"
        let exists: (String) -> Bool = { $0 == bundled + "/package.json" }
        XCTAssertEqual(PackagedLayout.resolveDshWorkspace(
            env: ["POC_DSH_PATH": "/custom/dsh"], resourcesDir: resources,
            isPackaged: true, exists: exists), "/custom/dsh")
        XCTAssertEqual(PackagedLayout.resolveDshWorkspace(
            env: [:], resourcesDir: resources, isPackaged: true, exists: exists), bundled)
        // 缺 package.json（半拷贝/目录存在但空）→ nil，调用方 loud
        XCTAssertNil(PackagedLayout.resolveDshWorkspace(
            env: [:], resourcesDir: resources, isPackaged: true, exists: { _ in false }))
        XCTAssertNil(PackagedLayout.resolveDshWorkspace(
            env: [:], resourcesDir: resources, isPackaged: false, exists: exists))
    }
}
