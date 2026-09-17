// BridgeShimInjector.swift — A 桥 chamber-bridge.js 注入器（design 25 §4.4.1）
//
// W-04（A 桥雏形，design 25 §4.4.1）/ design 25
// §4.4.1（A 桥 web↔Swift：注入 chamber-bridge.js shim，WKUserScript、
// .page world、documentStart）。D2 修正（2026-12 审计）：shim 不是「挂出即
// 定义完整 API」——公开面 dshChamber 只在 info 成功后（真实标量）或 1+10 次
// 全败后（四个标量 null，见 T-12 / preload.cts:923-940）暴露一次；Swift 侧
// 在 ready（origin 门开放）前对全部 invoke 回 ipc_not_ready，渲染端按自己的
// surface 缺失重试链自愈（shim 自身的 info 链是 1+10 次、50ms 间隔，不是
// 「10×50ms」）。
//
// 调用契约（共享契约，MainWindowController 以
// `BridgeShimInjector.install(config:source:)` 调用，勿改名）：
//   - source：chamber-bridge.js 源码（S-B 全表面：4 标量 + 9 命名空间 +
//     59 invoke-backed 方法；文件内零 poc-unimplemented 兜底，错误如实上抛）；
//   - install 必须在用该 configuration 构造 WKWebView 之前调用（user
//     script 随 configuration 生效于首次导航）。

import WebKit

/// A 桥 shim 注入工具：把 chamber-bridge.js 作为用户脚本注册到
/// WKWebViewConfiguration。
enum BridgeShimInjector {

    /// 由 shim 源码构造用户脚本：documentStart 注入、仅主 frame。
    ///
    /// contentWorld 取默认 page world（本构造器无 world 参数的版本即 page
    /// world）：shim 与页面共享同一 JS 上下文，靠 Object.defineProperty
    /// 非可配置挂载防页面覆盖（design 25 §4.4.1「防护」条）——POC 从简。
    /// M2/M3 再评估 .defaultClient（WKContentWorld.defaultClient，macOS 11+）
    /// 的隔离语义：design 25 §4.4.1 注明 .page world、documentStart，而 D1
    /// 对拍项（挂出时机二选一：Swift ready 后注入 vs documentStart 预定义
    /// 统一 reject）在 POC 取后者；若正式实现引入隔离 world，需同步重验
    /// __dshChamberResolve/__dshChamberEmit 的注入可达性与 hydration 对拍
    /// （renderer 的 bridge-hydration「surface 缺失 + 100ms×20 快速链」自愈
    /// 语义不变）。
    /// 原生通道令牌占位符（S-06，与 shim 里 NATIVE_CHANNEL_TOKEN 的字面量一致）：
    /// 安装前必须用 `injectNativeToken` 换成窗口随机值。
    static let nativeTokenPlaceholder = "__DSH_CHAMBER_NATIVE_TOKEN__"

    /// 每次窗口创建时生成的原生通道令牌：32 位十六进制（128 位随机）。只注入
    /// shim、只在 Swift 侧留存——页面脚本无法得知，从而无法伪造原生回执/事件。
    static func makeNativeToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        for index in bytes.indices { bytes[index] = UInt8.random(in: 0...255) }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// 把占位符替换为令牌（fail-closed：替换后仍含占位符说明注入失败）。
    static func injectNativeToken(_ token: String, into source: String) -> String {
        let injected = source.replacingOccurrences(of: nativeTokenPlaceholder, with: token)
        precondition(!injected.contains(nativeTokenPlaceholder),
                     "shim 源码仍含原生通道令牌占位符：token 注入失败会退化为可伪造")
        return injected
    }

    /// 已安装标记（P-19）：注入源码以此为前缀，install 据此幂等——显式标记，
    /// 而不是依赖 shim 内非可配置 defineProperty 在第二份副本执行时抛
    /// TypeError（公开面 info 水化成功前不存在，"dshChamber in window" 守卫
    /// 覆盖不到那个窗口）。WKUserContentController 无 stored property，
    /// `userScripts` 是唯一可检查的既有注册面。
    static let installedMarker = "/* dsh-chamber-bridge-shim-installed */"

    static func makeUserScript(source: String) -> WKUserScript {
        WKUserScript(source: installedMarker + "\n" + source,
                     injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    /// 该 configuration 是否已注册过本注入器的 shim（P-19）。
    static func isInstalled(in config: WKWebViewConfiguration) -> Bool {
        config.userContentController.userScripts.contains {
            $0.source.hasPrefix(installedMarker)
        }
    }

    /// 安装：把 shim 用户脚本注册进 configuration 的 userContentController。
    /// **幂等**（P-19）：已安装 → no-op（返回 false），绝不重复注册——重复的
    /// documentStart 执行会撞 shim 的非可配置 defineProperty。
    /// （消息 handler 本身由 MainWindowController 单独以
    /// `userContentController.add(handler, name: "dshChamber")` 注册，
    /// 本注入器只负责脚本侧，职责单一。）
    @discardableResult
    static func install(config: WKWebViewConfiguration, source: String) -> Bool {
        guard !isInstalled(in: config) else { return false }
        config.userContentController.addUserScript(makeUserScript(source: source))
        return true
    }
}
