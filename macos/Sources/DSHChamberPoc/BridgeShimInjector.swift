// BridgeShimInjector.swift — A 桥 chamber-bridge.js 注入器（design 25 §4.4.1）
//
// W-04（docs/progress/todo/macos-swift-v1.md §0.2-⑤「A 桥雏形」）/ design 25
// §4.4.1（A 桥 web↔Swift：注入 chamber-bridge.js shim，WKUserScript、
// .page world、documentStart）与 §0.1-B3（渲染器可用性门对偶：shim 挂出即
// 定义完整 API，但 Swift 侧在 ready（origin 门开放）前对全部 invoke 回
// ipc_sender_forbidden，渲染端按既有「10×50ms 有界重试」自愈——即 D1 二选一
// 中的方案②，挂出时机对拍结论由 W-04 登记）。
//
// 调用契约（共享契约，MainWindowController 以
// `BridgeShimInjector.install(config:source:)` 调用，勿改名）：
//   - source：chamber-bridge.js 源码（W-04 注入脚本，4 标量 + 9 面形状、
//     未实现面统一 loud 拒绝 {error:'poc-unimplemented'}）；
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
    static func makeUserScript(source: String) -> WKUserScript {
        WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    /// 安装：把 shim 用户脚本注册进 configuration 的 userContentController。
    /// （消息 handler 本身由 MainWindowController 单独以
    /// `userContentController.add(handler, name: "dshChamber")` 注册，
    /// 本注入器只负责脚本侧，职责单一。）
    static func install(config: WKWebViewConfiguration, source: String) {
        config.userContentController.addUserScript(makeUserScript(source: source))
    }
}
