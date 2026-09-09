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
/// CWD 向上找 `poc-sidecar.ts`、userData 落 `dsh-chamber-poc-dev`）——Finder
/// 双击 `.app`（CWD=/）时找不到自带 sidecar/node，跨 flavor 目录锁也各锁各的
/// 目录。本枚举把「打包态应使用的路径」收敛为**纯函数**（可单测），由
/// AppDelegate 按 `POC_*` 环境变量优先级消费。
///
/// 装配态布局（design 25 §3.2，`macos/scripts/build-swift-app.mjs`）：
///   <App>/Contents/Resources/sidecar/{node, sidecar.js, dist/, vendor/dsh, pnpm}
///   <App>/Contents/Resources/dist/web/index.html
/// userData 与 Electron 打包实根同根（`~/Library/Application Support/dsh-chamber`，
/// Electron `app.getPath('userData')` = appData + productName "dsh-chamber"）。
public enum PackagedLayout {
    /// Electron 打包实根（design 25 §6.1 的「同根」目标；双 flavor 目录锁据此互斥）。
    public static func userDataDir(home: String) -> String {
        home + "/Library/Application Support/dsh-chamber"
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

    /// node 解析：`POC_NODE_BIN` → 打包态自带 `<Resources>/sidecar/node` →
    /// 旧缺省（Electron 二进制，`ELECTRON_RUN_AS_NODE=1` 当 Node 用）。
    /// `exists` 注入以便单测。
    public static func resolveNode(
        env: [String: String],
        resourcesDir: String?,
        isPackaged: Bool,
        exists: (String) -> Bool
    ) -> String {
        if let explicit = env["POC_NODE_BIN"], !explicit.isEmpty { return explicit }
        if isPackaged, let resourcesDir {
            let bundled = nodeBinary(resourcesDir: resourcesDir)
            if exists(bundled) { return bundled }
        }
        return "/Applications/dsh-chamber.app/Contents/MacOS/dsh-chamber"
    }

    /// sidecar 脚本解析：`POC_SIDECAR` → 打包态自带 `<Resources>/sidecar/sidecar.js`
    /// → nil（dev 由调用方向上查找 `poc-sidecar.ts` / `sidecar-entry.ts`）。
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
