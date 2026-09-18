//
//  PackagedLayoutTests.swift
//  DSHChamberTests
//
//  三审收口 #1/#2：打包态默认路径解析（node / sidecar / userData 同根 /
//  vendor-dsh 工作区）必须是纯函数且可单测——否则「Finder 双击 .app 可用」
//  只能靠手工 env 复现（一审已登记为 major）。
//
import XCTest
@testable import DSHChamber

final class PackagedLayoutTests: XCTestCase {
    private let resources = "/Applications/dsh-chamber.app/Contents/Resources"

    /// #filePath = <repo>/macos/Tests/DSHChamberTests/PackagedLayoutTests.swift
    private func repoRoot() -> URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url
    }

    func testIsAppBundle() {
        XCTAssertTrue(PackagedLayout.isAppBundle(
            executablePath: "/Applications/dsh-chamber.app/Contents/MacOS/dsh-chamber"))
        XCTAssertFalse(PackagedLayout.isAppBundle(executablePath: "/repo/macos/.build/debug/DSHChamber"))
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
            env: ["DSH_CHAMBER_SHELL_NODE_BIN": "/custom/node"], resourcesDir: resources,
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
        // DSH_CHAMBER_SHELL_NODE_BIN 显式但不可执行 → 抛错（不静默回退）
        XCTAssertThrowsError(try PackagedLayout.resolveNode(
            env: ["DSH_CHAMBER_SHELL_NODE_BIN": "/gone/node"], resourcesDir: nil,
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
            env: ["DSH_CHAMBER_SHELL_SIDECAR": "/custom/entry.js"], resourcesDir: resources,
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
            env: ["DSH_CHAMBER_SHELL_USER_DATA": "/custom/ud"], home: "/Users/tester", isPackaged: true), "/custom/ud")
        // 装配态与 Electron 打包实根同根（design 25 §6.1 U1；实根拼写 =
        // appData + `app.getName()`，见 ChamberResources.swift 注释与
        // packages/desktop/chamber-lock.test.ts 的 lockstep 断言）
        XCTAssertEqual(PackagedLayout.resolveUserData(
            env: [:], home: "/Users/tester", isPackaged: true),
            "/Users/tester/Library/Application Support/@dsh-chamber/desktop")
        // dev 保持独立目录（不污染真实 userData）
        XCTAssertEqual(PackagedLayout.resolveUserData(
            env: [:], home: "/Users/tester", isPackaged: false),
            "/Users/tester/Library/Application Support/dsh-chamber-dev")
    }

    func testResolveDshWorkspace() {
        let bundled = resources + "/sidecar/vendor/dsh"
        let exists: (String) -> Bool = { $0 == bundled + "/package.json" }
        XCTAssertEqual(PackagedLayout.resolveDshWorkspace(
            env: ["DSH_CHAMBER_SHELL_DSH_PATH": "/custom/dsh"], resourcesDir: resources,
            isPackaged: true, exists: exists), "/custom/dsh")
        XCTAssertEqual(PackagedLayout.resolveDshWorkspace(
            env: [:], resourcesDir: resources, isPackaged: true, exists: exists), bundled)
        // 缺 package.json（半拷贝/目录存在但空）→ nil，调用方 loud
        XCTAssertNil(PackagedLayout.resolveDshWorkspace(
            env: [:], resourcesDir: resources, isPackaged: true, exists: { _ in false }))
        XCTAssertNil(PackagedLayout.resolveDshWorkspace(
            env: [:], resourcesDir: resources, isPackaged: false, exists: exists))
    }

    /// P-13：`packages/desktop/sidecar-ctx.ts` 的七个具名打包布局助手是 Swift
    /// 装配腿的真正对侧。登记表（P-13）曾声称本文件已有该锁步锚点，实际只锁了
    /// build-swift-app.mjs 的布局形状——本用例补上缺失的一侧：解析 TS 源文本断言
    /// 助手名与路径拼写，并核对 Swift/脚本消费点。任一侧改名或改拼写即红。
    ///
    /// 七个助手（sidecar-ctx.ts）：
    ///   packagedHostPackageDir / packagedPnpmEntry / legacyPackagedPnpmEntry /
    ///   devPnpmEntry / findWorkspaceRoot / resolveHostPackageSourceDir /
    ///   resolvePnpmEntry。
    func testSidecarLayoutHelpersMatchTSAnchors() throws {
        func read(_ relative: String) throws -> String {
            try String(contentsOf: repoRoot().appendingPathComponent(relative), encoding: .utf8)
        }
        let ctx = try read("packages/desktop/sidecar-ctx.ts")

        // ① 名字：七个助手必须仍是导出函数（Swift 与 TS 的共同锚点）。
        for helper in [
            "packagedHostPackageDir",
            "packagedPnpmEntry",
            "legacyPackagedPnpmEntry",
            "devPnpmEntry",
            "findWorkspaceRoot",
            "resolveHostPackageSourceDir",
            "resolvePnpmEntry",
        ] {
            XCTAssertTrue(ctx.contains("export function \(helper)("),
                          "sidecar-ctx.ts 必须保留具名布局助手 export function \(helper)(")
        }

        // ② 路径拼写（与 Swift 常量、装配脚本逐字对应）。
        for anchor in [
            "path.join(sidecarDir, 'dist', packageDirName)",
            "path.join(sidecarDir, 'pnpm', 'bin', 'pnpm.cjs')",
            "path.join(sidecarDir, '..', 'pnpm', 'bin', 'pnpm.cjs')",
            "path.join(moduleDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')",
            "findWorkspaceRoot(startDir: string, maxDepth = 8)",
            "'pnpm-workspace.yaml'",
            "path.join(workspaceRoot, 'packages', packageDir)",
            "return packagedHostPackageDir(moduleDir, packageDir)",
        ] {
            XCTAssertTrue(ctx.contains(anchor), "sidecar-ctx.ts 布局锚点缺失：\(anchor)")
        }

        // ③ 行为：resolvePnpmEntry 的候选顺序 packaged > legacy > dev，全缺回落 dev。
        let resolverStart = try XCTUnwrap(ctx.range(of: "export function resolvePnpmEntry"))
        let resolver = String(ctx[resolverStart.lowerBound...])
        let packaged = try XCTUnwrap(resolver.range(of: "packagedPnpmEntry(moduleDir)"))
        let legacy = try XCTUnwrap(resolver.range(of: "legacyPackagedPnpmEntry(moduleDir)"))
        let dev = try XCTUnwrap(resolver.range(of: "devPnpmEntry(moduleDir)"))
        XCTAssertTrue(packaged.lowerBound < legacy.lowerBound && legacy.lowerBound < dev.lowerBound,
                      "resolvePnpmEntry 的候选顺序必须是 packaged > legacy > dev（dev 同时是回落值）")
        XCTAssertTrue(resolver.contains("?? devPnpmEntry(moduleDir)"),
                      "resolvePnpmEntry 全缺时必须回落到 dev 形状（安装路径 loud 失败的前置）")

        // ④ 消费点：Swift 装配把 host 包注入为 <sidecarDir>/dist/<pkg>（助手①的形状）。
        let appDelegate = try read("macos/Sources/DSHChamber/AppDelegate.swift")
        XCTAssertTrue(appDelegate.contains("let candidate = sidecarDir + \"/dist/\" + host.name"),
                      "AppDelegate 的装配态 host 包路径必须与 packagedHostPackageDir 同形")

        // ⑤ 消费点：build-sidecar 的 sidecarLayout 正是助手②的拼写（装配目录布局单源）。
        let buildSidecar = try read("packages/desktop/scripts/build-sidecar.mjs")
        for anchor in [
            "pnpm: path.join(outDir, 'pnpm')",
            "pnpmEntry: path.join(outDir, 'pnpm', 'bin', 'pnpm.cjs')",
            "hostPackageDist: (name) => path.join(outDir, 'dist', name)",
        ] {
            XCTAssertTrue(buildSidecar.contains(anchor), "build-sidecar.mjs 布局锚点缺失：\(anchor)")
        }
    }
}
