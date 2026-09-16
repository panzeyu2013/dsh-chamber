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

    /// #filePath = <repo>/macos/Tests/DSHChamberPocTests/PackagedLayoutTests.swift
    private func repoRoot() -> URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url
    }

    func testIsAppBundle() {
        XCTAssertTrue(PackagedLayout.isAppBundle(
            executablePath: "/Applications/dsh-chamber-native.app/Contents/MacOS/DSHChamberPoc"))
        XCTAssertFalse(PackagedLayout.isAppBundle(executablePath: "/repo/macos/.build/debug/DSHChamberPoc"))
        XCTAssertFalse(PackagedLayout.isAppBundle(executablePath: ""))
    }

    /// S15：读 macos/scripts/build-swift-app.mjs 的 appLayout 源文本核对，而不是
    /// 复述路径——脚本改布局而 Swift 常量没跟上时必须红（原测试名不副实）。
    func testLayoutPathsMatchBuildScript() throws {
        let script = try String(
            contentsOf: repoRoot().appendingPathComponent("macos/scripts/build-swift-app.mjs"),
            encoding: .utf8)
        for anchor in [
            "sidecarDir: path.join(resourcesDir, 'sidecar')",
            "webDist: path.join(resourcesDir, 'dist', 'web')",
            "path.join(layout.sidecarDir, 'sidecar.js')",
            "vendor/dsh",
        ] {
            XCTAssertTrue(script.contains(anchor),
                          "build-swift-app.mjs 应含布局锚点（脚本即路径权威）：\(anchor)")
        }
        XCTAssertEqual(PackagedLayout.sidecarDir(resourcesDir: resources), resources + "/sidecar")
        XCTAssertEqual(PackagedLayout.sidecarScript(resourcesDir: resources), resources + "/sidecar/sidecar.js")
        XCTAssertEqual(PackagedLayout.nodeBinary(resourcesDir: resources), resources + "/sidecar/node")
        XCTAssertEqual(PackagedLayout.dshWorkspace(resourcesDir: resources), resources + "/sidecar/vendor/dsh")
        XCTAssertEqual(PackagedLayout.webDistDir(resourcesDir: resources), resources + "/dist/web")
        XCTAssertEqual(PackagedLayout.userDataDir(home: "/Users/tester"),
                       "/Users/tester/Library/Application Support/@dsh-chamber/desktop")
    }

    /// S4：node 解析不再有「另一个 app 的 Electron 二进制」fail-open 缺省——
    /// 每一层都要求可执行，否则抛精确错误（调用方 fatalStartup）。
    func testResolveNode() {
        let bundled = resources + "/sidecar/node"
        // env 优先（显式路径须可执行）
        XCTAssertEqual(try? PackagedLayout.resolveNode(
            env: ["POC_NODE_BIN": "/custom/node"], resourcesDir: resources,
            isPackaged: true, isExecutable: { $0 == "/custom/node" }), "/custom/node")
        // 装配态自带 node
        XCTAssertEqual(try? PackagedLayout.resolveNode(
            env: [:], resourcesDir: resources, isPackaged: true,
            isExecutable: { $0 == bundled }), bundled)
        // 装配态但缺 node → 抛错（绝不回落 Electron 二进制）
        XCTAssertThrowsError(try PackagedLayout.resolveNode(
            env: [:], resourcesDir: resources, isPackaged: true,
            isExecutable: { _ in false })) { error in
            XCTAssertEqual(error as? PackagedLayout.PathResolutionError,
                           .packagedNodeMissing(path: bundled))
        }
        // resourcesDir 缺失同样致命
        XCTAssertThrowsError(try PackagedLayout.resolveNode(
            env: [:], resourcesDir: nil, isPackaged: true, isExecutable: { _ in true }))
        // dev：PATH 中首个可执行 node
        XCTAssertEqual(try? PackagedLayout.resolveNode(
            env: ["PATH": "/opt/bin:/usr/local/bin"], resourcesDir: resources,
            isPackaged: false, isExecutable: { $0 == "/usr/local/bin/node" }),
            "/usr/local/bin/node")
        // dev 无 PATH node → 抛错
        XCTAssertThrowsError(try PackagedLayout.resolveNode(
            env: ["PATH": "/opt/bin"], resourcesDir: resources,
            isPackaged: false, isExecutable: { _ in false })) { error in
            XCTAssertEqual(error as? PackagedLayout.PathResolutionError, .pathNodeMissing)
        }
        // POC_NODE_BIN 显式但不可执行 → 抛错（不静默回退）
        XCTAssertThrowsError(try PackagedLayout.resolveNode(
            env: ["POC_NODE_BIN": "/gone/node"], resourcesDir: nil,
            isPackaged: false, isExecutable: { _ in false })) { error in
            XCTAssertEqual(error as? PackagedLayout.PathResolutionError,
                           .explicitNodeMissing(path: "/gone/node"))
        }
    }

    /// dev PATH node 解析（S4 纯函数面）。
    func testResolvePathNode() {
        XCTAssertEqual(PackagedLayout.resolvePathNode(
            env: ["PATH": "/a:/b"], isExecutable: { $0 == "/b/node" }), "/b/node")
        XCTAssertNil(PackagedLayout.resolvePathNode(
            env: ["PATH": "/a::/b"], isExecutable: { _ in false }))
        XCTAssertEqual(PackagedLayout.resolvePathNode(
            env: ["PATH": ""], isExecutable: { $0 == "/usr/local/bin/node" }),
            "/usr/local/bin/node", "PATH 空串 → 系统缺省目录序列")
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
        // dev 态返回 nil，调用方回退向上查找 sidecar-entry.ts（S12）
        XCTAssertNil(PackagedLayout.resolveSidecar(
            env: [:], resourcesDir: resources, isPackaged: false, exists: exists))
    }

    func testResolveUserData() {
        XCTAssertEqual(PackagedLayout.resolveUserData(
            env: ["POC_USER_DATA": "/custom/ud"], home: "/Users/tester", isPackaged: true), "/custom/ud")
        // 装配态与 Electron 打包实根同根（design 25 §6.1 U1；实根拼写 =
        // appData + `app.getName()`，见 ChamberResources.swift 注释与
        // packages/desktop/chamber-lock.test.ts 的 lockstep 断言）
        XCTAssertEqual(PackagedLayout.resolveUserData(
            env: [:], home: "/Users/tester", isPackaged: true),
            "/Users/tester/Library/Application Support/@dsh-chamber/desktop")
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
