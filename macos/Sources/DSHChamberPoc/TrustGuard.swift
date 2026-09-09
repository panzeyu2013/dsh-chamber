// TrustGuard.swift — A 桥传输层信任护栏（纯函数工具，全 static，可测性优先）
//
// W-04（docs/progress/todo/macos-swift-v1.md §0.2-⑤「A 桥雏形」）/ design 25
// §4.4.1（A 桥 web↔Swift：Swift 端 WKScriptMessageHandler 的传输层护栏）与
// §0.1-B3（渲染器可用性门：就绪前期望 origin 未开放 → 一律拒绝、渲染端有界
// 重试语义保留——本工具不感知就绪态，就绪门由 MessageHandler 的
// expectedOrigin() 闭包体现）。
//
// 传输层护栏只做这四件事（design 25 §4.4.1）：
//   ① 主 frame 判定 —— 不在本文件：WKScriptMessageHandler 回调天然保证
//      sender 为注册了该 handler 的 userContentController 所属 webView，
//      主 frame 限定在 MessageHandler 内用 message.frameInfo.isMainFrame 完成
//      （对应 Electron 侧 event.senderFrame === webContents.mainFrame，
//      renderer-trust.ts 同族语义）；
//   ② origin 判定 —— isTrustedOrigin()（design 25 §4.4.1 第 2 条：origin ===
//      当前控制面 origin；期望 origin 只在 ready 帧后放开）；
//   ③ 信封尺寸上限 —— envelopeSizeOK()，≤ 4 MiB（design 25 §4.4.1 第 3 条）；
//   ④ 方法白名单 —— isAllowedMethod()（design 25 §4.4.1 第 3 条：method ∈
//      manifest 白名单）。
// 语义校验（payload schema、来源指纹、generation、ACK 队列……）全部留在
// sidecar 原处理器（design 25 §1.2 目标 4「信任模型不弱化：B 桥语义校验仍
// 发生在 sidecar，Swift 只做传输层护栏」/ §4.4.1 结尾注）。
//
// 纯 Swift（仅 import Foundation，无 AppKit/WebKit），便于 XCTest 直测。

import Foundation

/// A 桥传输层信任护栏：无状态纯函数集（全 static），不依赖任何 UI/WebKit 类型。
enum TrustGuard {

    /// 信封尺寸上限：4 MiB（design 25 §4.4.1 ③「信封结构/尺寸上限（≤4 MiB）」）。
    static let maxMessageBytes = 4 * 1024 * 1024

    /// origin 判定：把 urlString 解析为 URLComponents，与期望 origin 按
    /// `scheme://host:port` 精确比较（path/query/fragment 不参与——POC 按
    /// design 25 §4.4.1 第 2 条「origin === 当前控制面 origin」字面执行；
    /// 对拍：Electron 侧 isTrustedRendererUrl 还限定 pathname == "/" 且无
    /// query（renderer-trust.ts），若 M2/M3 控制面 origin 下出现可注入文档
    /// 面（如 /api/i/* 远端 HTML 直开主 frame）需在此补同款判定）。
    ///
    /// 规则：
    /// - urlString 为 nil / 解析失败 / 缺 scheme 或 host → false（fail closed）；
    /// - host 大小写规范化（lowercased）后比较；
    /// - port 仅按"显式端口"比较：页面与期望 origin 同为本地 http 且端口显式
    ///   （dev 17520 / 打包 17500），80/443 默认端口折叠不处理（POC 无此
    ///   场景，注释见 design 25 §3.3 端口裁决）；
    /// - userinfo 存在（如 `http://evil@127.0.0.1:17520/`）→ false：scheme/
    ///   host/port 三元的"同源等价"以无凭据 URL 为前提，POC 从紧拒绝。
    static func isTrustedOrigin(_ urlString: String?, expectedOrigin: String) -> Bool {
        guard let urlString, !urlString.isEmpty,
              let actual = URLComponents(string: urlString),
              let expected = URLComponents(string: expectedOrigin),
              let actualScheme = actual.scheme?.lowercased(),
              let expectedScheme = expected.scheme?.lowercased(),
              let actualHost = actual.host?.lowercased(),
              let expectedHost = expected.host?.lowercased() else {
            return false
        }
        // 两侧都不得带 userinfo（原先只查 actual——expectedOrigin 若含 userinfo
        // 会被接受，与「同源以无凭据 URL 为前提」矛盾；2026-09 三审边界收口）。
        guard actual.user == nil, expected.user == nil else { return false }
        // 默认端口折叠：与 WHATWG URL 的 origin 等价语义对齐
        // （`http://h:80` ≡ `http://h`、`https://h:443` ≡ `https://h`；
        // 2026-09 三审：原实现按字面 port 比较，会误拒同源默认端口写法）。
        return actualScheme == expectedScheme
            && actualHost == expectedHost
            && effectivePort(scheme: actualScheme, port: actual.port)
                == effectivePort(scheme: expectedScheme, port: expected.port)
    }

    /// 有效端口（缺省按 scheme 折叠为 80/443；其它 scheme 缺省为 nil）。
    static func effectivePort(scheme: String, port: Int?) -> Int? {
        if let port { return port }
        switch scheme {
        case "http": return 80
        case "https": return 443
        default: return nil
        }
    }

    /// 文档面判定（2026-09 验收审计 major 收口）：A 桥只信任**固定壳文档**——
    /// 与 Electron `isTrustedRendererUrl`（renderer-trust.ts:20-30）逐条对齐：
    /// 期望 origin 必须 http(s)、origin 相等、`pathname == "/"`、无 query。
    /// 原因：控制面同一 origin 下还透传远端实例响应（`/api/i/<id>/*`），
    /// 仅 origin 相等会让被代理的远端 HTML 继承 shim 与全部 60 个 IPC 通道。
    /// 消息护栏与导航护栏都改用本判定（isTrustedOrigin 保留为 origin 原语）。
    static func isTrustedDocument(_ urlString: String?, expectedOrigin: String) -> Bool {
        guard let urlString, !urlString.isEmpty,
              let actual = URLComponents(string: urlString),
              let expected = URLComponents(string: expectedOrigin),
              let expectedScheme = expected.scheme?.lowercased(),
              expectedScheme == "http" || expectedScheme == "https" else {
            return false
        }
        guard isTrustedOrigin(urlString, expectedOrigin: expectedOrigin) else { return false }
        // 与 WHATWG URL 对齐：无路径的 authority-only URL（`http://h:p`）pathname
        // 等价于 "/"（URLComponents 给空串，Electron `new URL(...).pathname` 给 "/"）。
        let path = actual.path
        return (path.isEmpty || path == "/") && (actual.query ?? "").isEmpty
    }

    /// 可交 OS 默认处理器打开的外链（镜像 renderer-trust.ts `isExternalLinkUrl`）：
    /// 仅 http(s)（默认浏览器）与 mailto（邮件客户端）；其他 scheme 一律拒绝。
    /// 给出 expectedOrigin 时同源 http(s) 不算外链（同源在浏览器里只会得到
    /// 无 shim 的重复壳）。`mailto:` 无 origin 概念，恒为外链。
    static func isExternalLink(_ urlString: String?, expectedOrigin: String?) -> Bool {
        guard let urlString, !urlString.isEmpty,
              let actual = URLComponents(string: urlString),
              let scheme = actual.scheme?.lowercased() else {
            return false
        }
        if scheme == "mailto" {
            return !actual.path.isEmpty
        }
        guard scheme == "http" || scheme == "https" else { return false }
        guard let expectedOrigin else { return true }
        return !isTrustedOrigin(urlString, expectedOrigin: expectedOrigin)
    }

    /// 方法白名单判定：精确匹配（通道名均为小写下划线命名空间，大小写不
    /// 规范化；manifest 化后通道名以 ipc-events.ts IPC_CHANNELS 为权威，
    /// design 25 §4.4.3）。
    static func isAllowedMethod(_ method: String, whitelist: Set<String>) -> Bool {
        whitelist.contains(method)
    }

    /// 信封尺寸判定：按 UTF-8 字节数计 ≤ maxMessageBytes（design 25 §4.4.1 ③）。
    /// 入参为 message.body 的一次 JSON 序列化文本（近似线上信封，POC 声明见
    /// MessageHandler ④），故按 body.utf8.count 精确计量。
    static func envelopeSizeOK(_ body: String) -> Bool {
        body.utf8.count <= maxMessageBytes
    }
}
