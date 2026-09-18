//
//  ChamberResources.swift
//  DSHChamberPoc
//
//  W-24 修正（打包态资源定位）：SwiftPM 为 `.process(...)` 资源生成的
//  `Bundle.module` 访问器只在两处查找资源包——
//    `Bundle.main.bundleURL/<Target>_<Target>.bundle` 与构建目录；
//  而 .app 的 `Bundle.main.bundleURL` 是 **.app 根**，把资源包放那里会被
//  codesign 判为「bundle 根有未密封内容」（实测：
//  `unsealed contents present in the bundle root`），签名失败。因此打包态
//  资源包必须落 `Contents/Resources/`，并由本枚举按候选顺序查找（不再用
//  Bundle.module）：
//    1. `Bundle.main.resourceURL` —— .app 的 Contents/Resources（打包态正解）；
//    2. `Bundle.main.bundleURL` —— `swift run` / 扁平可执行（资源包与二进制同目录）；
//    3. 可执行文件所在目录 —— 兜底（符号链接/自定义布局）。
//  每一层先查 `<base>/<Target>_<Target>.bundle/<name>`（SwiftPM 资源包），
//  再查 `<base>/<name>`（资源被平铺的布局），全部 miss → nil（调用方 loud）。
//

import Foundation

public enum ChamberResources {
    /// SwiftPM 资源包名（target 名重复一次；见 Package.swift target DSHChamberPoc）。
    public static let bundleName = "DSHChamberPoc_DSHChamberPoc.bundle"

    /// 按候选目录顺序定位资源文件（相对路径，如 "bridge-shim.poc.js"）。
    public static func url(forResource name: String) -> URL? {
        for base in searchBases() {
            let packaged = base.appendingPathComponent(bundleName).appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: packaged.path) {
                return packaged
            }
            let flat = base.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: flat.path) {
                return flat
            }
        }
        return nil
    }

    /// 候选根目录（去重、保序）。
    public static func searchBases() -> [URL] {
        var bases: [URL] = []
        func append(_ url: URL?) {
            guard let url else { return }
            if !bases.contains(where: { $0.path == url.path }) {
                bases.append(url)
            }
        }
        append(Bundle.main.resourceURL)
        append(Bundle.main.bundleURL)
        if let executable = Bundle.main.executableURL {
            append(executable.deletingLastPathComponent())
        }
        return bases
    }
}

/// 打包态路径解析（W-24 后续；2026-09 三审收口 #1/#2）。
///
/// 问题：`AppDelegate` 的缺省值原先全部指向 dev（Electron 二进制当 node、按
/// CWD 向上找 dev 脚本（现为 `sidecar-entry.ts`）、userData 落
/// `dsh-chamber-poc-dev`）——Finder
/// 双击 `.app`（CWD=/）时找不到自带 sidecar/node，跨 flavor 目录锁也各锁各的
/// 目录。本枚举把「打包态应使用的路径」收敛为**纯函数**（可单测），由
/// AppDelegate 按 `POC_*` 环境变量优先级消费。
///
/// 装配态布局（design 25 §3.2，`macos/scripts/build-swift-app.mjs`）：
///   <App>/Contents/Resources/sidecar/{node, sidecar.js, dist/, vendor/dsh, pnpm}
///   <App>/Contents/Resources/dist/web/index.html
/// userData 与 Electron 打包实根同根（design 25 §6.1 的「同根」不变量；双 flavor
/// 目录锁据此互斥）。
///
/// **实根拼写（2026-09 GUI 验收实测修正）**：Electron `app.getPath('userData')`
/// = appData + `app.getName()`，而 `app.getName()` 只认 package.json 的**顶层**
/// `productName`，其次 `name`。`packages/desktop/package.json` 的 productName 位于
/// electron-builder 的 `build.productName`（只影响 .app/DMG 名），顶层没有 →
/// 实际取到包名 `@dsh-chamber/desktop`。运行中的打包宿主实证：
/// `--user-data-dir=~/Library/Application Support/@dsh-chamber/desktop`
/// （同源声明见 `packages/desktop/scripts/electron-dev.mjs:14-23`）。
/// 本常量必须与该拼写逐字一致，由 `packages/desktop/chamber-lock.test.ts` 的
/// lockstep 断言（从本文件提取字面量 + 按 `productName ?? name` 推导）钉住。
public enum PackagedLayout {
    /// Electron 打包实根（双 flavor 目录锁据此互斥）。改这里必须同步
    /// `packages/desktop/package.json` 的 identity 推导结论（lockstep 测试会红）。
    public static func userDataDir(home: String) -> String {
        home + "/Library/Application Support/@dsh-chamber/desktop"
    }

    public static func sidecarDir(resourcesDir: String) -> String {
        resourcesDir + "/sidecar"
    }

    public static func sidecarScript(resourcesDir: String) -> String {
        sidecarDir(resourcesDir: resourcesDir) + "/sidecar.js"
    }

    public static func nodeBinary(resourcesDir: String) -> String {
        sidecarDir(resourcesDir: resourcesDir) + "/node"
    }

    public static func dshWorkspace(resourcesDir: String) -> String {
        sidecarDir(resourcesDir: resourcesDir) + "/vendor/dsh"
    }

    public static func webDistDir(resourcesDir: String) -> String {
        resourcesDir + "/dist/web"
    }

    /// 是否为 .app 装配态（可执行文件位于 `<X>.app/Contents/MacOS/` 之下）。
    public static func isAppBundle(executablePath: String) -> Bool {
        executablePath.contains(".app/Contents/MacOS/")
    }

    /// 路径解析失败（S3/S4）：缺 node/sidecar 一律 fatal（调用方 fatalStartup），
    /// 绝不 spawn 裸 node 或另一个 app 的 Electron 二进制。
    public enum PathResolutionError: Error, Equatable {
        case explicitNodeMissing(path: String)
        case packagedNodeMissing(path: String)
        case pathNodeMissing

        public var message: String {
            switch self {
            case .explicitNodeMissing(let path):
                return "POC_NODE_BIN 指向的 node 不存在或不可执行：\(path)"
            case .packagedNodeMissing(let path):
                return "装配态缺少自带 node（不可执行）：\(path)"
            case .pathNodeMissing:
                return "dev 态 PATH 中找不到可执行的 node（可设 POC_NODE_BIN 显式指定）"
            }
        }
    }

    /// node 解析（S4）：`POC_NODE_BIN`（显式，须可执行）→ 装配态自带
    /// `<Resources>/sidecar/node`（须可执行）→ dev 从 PATH 找 node（逐目录
    /// 检查可执行）→ 皆无 → 抛错。旧「Electron 二进制当 Node」缺省已删除：
    /// 那是另一个 app 的二进制（/Applications/dsh-chamber-electron.app/…），缺自带
    /// node 时绝不能拿它顶替（审计 major fail-open）。`isExecutable` 注入
    /// 以便单测。
    public static func resolveNode(
        env: [String: String],
        resourcesDir: String?,
        isPackaged: Bool,
        isExecutable: (String) -> Bool
    ) throws -> String {
        if let explicit = env["POC_NODE_BIN"], !explicit.isEmpty {
            guard isExecutable(explicit) else {
                throw PathResolutionError.explicitNodeMissing(path: explicit)
            }
            return explicit
        }
        if isPackaged {
            guard let resourcesDir else {
                throw PathResolutionError.packagedNodeMissing(
                    path: "<Resources>/sidecar/node（Bundle.main.resourceURL 缺失）")
            }
            let bundled = nodeBinary(resourcesDir: resourcesDir)
            guard isExecutable(bundled) else {
                throw PathResolutionError.packagedNodeMissing(path: bundled)
            }
            return bundled
        }
        guard let pathNode = resolvePathNode(env: env, isExecutable: isExecutable) else {
            throw PathResolutionError.pathNodeMissing
        }
        return pathNode
    }

    /// dev 态 PATH node 解析（纯函数：按 PATH 目录序找 `<dir>/node` 可执行）。
    public static func resolvePathNode(env: [String: String],
                                       isExecutable: (String) -> Bool) -> String? {
        let configured = env["PATH"] ?? ""
        let path = configured.isEmpty
            ? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            : configured
        for entry in path.split(separator: ":") where !entry.isEmpty {
            let candidate = String(entry) + "/node"
            if isExecutable(candidate) { return candidate }
        }
        return nil
    }

    /// sidecar 脚本解析：`POC_SIDECAR` → 打包态自带 `<Resources>/sidecar/sidecar.js`
    /// → nil（dev 由调用方向上查找 `sidecar-entry.ts`；S12 起无 poc 桩回退）。
    public static func resolveSidecar(
        env: [String: String],
        resourcesDir: String?,
        isPackaged: Bool,
        exists: (String) -> Bool
    ) -> String? {
        if let explicit = env["POC_SIDECAR"], !explicit.isEmpty { return explicit }
        if isPackaged, let resourcesDir {
            let bundled = sidecarScript(resourcesDir: resourcesDir)
            if exists(bundled) { return bundled }
        }
        return nil
    }

    /// userData 解析：`POC_USER_DATA` → 打包态同根 → dev 目录。
    public static func resolveUserData(
        env: [String: String],
        home: String,
        isPackaged: Bool
    ) -> String {
        if let explicit = env["POC_USER_DATA"], !explicit.isEmpty { return explicit }
        return isPackaged ? userDataDir(home: home) : home + "/Library/Application Support/dsh-chamber-poc-dev"
    }

    /// 内置 dsh 工作区解析：`POC_DSH_PATH` → 打包态 `<Resources>/sidecar/vendor/dsh`
    /// → nil（dev 由调用方按仓库候选查找）。
    public static func resolveDshWorkspace(
        env: [String: String],
        resourcesDir: String?,
        isPackaged: Bool,
        exists: (String) -> Bool
    ) -> String? {
        if let explicit = env["POC_DSH_PATH"], !explicit.isEmpty { return explicit }
        if isPackaged, let resourcesDir {
            let bundled = dshWorkspace(resourcesDir: resourcesDir)
            if exists(bundled + "/package.json") { return bundled }
        }
        return nil
    }
}
