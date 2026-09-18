//  ShellOverscrollPolicy.swift —— 主窗 WebView 的视口越界策略（design 25 §5.2）
//
//  现象：macOS WebKit 在**视口层**实现"橡皮筋"（overscroll）效果。指针停在不可
//  滚动的 chrome（顶栏、侧栏头部）上滚动，或某个滚动器滚到端点后继续滚，越界量
//  落在视口，整页（含 position: fixed 层）被整体平移再弹回——用户可感的"固定区
//  跟着整页动"。
//
//  控制点：按 CSS Overscroll Behavior 规范，**视口的越界效果由根元素的
//  overscroll-behavior 决定**：none 关闭视口自身的越界效果与向视口外链接，不影响
//  文档内部的链式滚动，也不改任何滚动容器的滚动范围。因此策略只落文档根
//  （html/body），不逐个给滚动容器加 contain——后者要按上游类名改上游的滚动语义，
//  属对上游的破坏性变更（design 25 §5.2 的 Rejected alternatives）。
//
//  投递：由原生壳以 WKUserScript（公开 API）在 documentStart、仅主 frame 注入一条
//  <style>，与 BridgeShimInjector 同一装配段（configuration 段，必须先于 WKWebView
//  构造；崩溃/卡死恢复只 reload，注入随每次导航生效）。Electron flavor 未同步，
//  双 flavor 差异登记见 docs/progress/deviations.md S-50。
//
//  单一真源：规则文本、标记属性、注入源码都从这里取；测试
//  （ShellOverscrollPolicyTests）钉住注入契约与"范围只到文档根"这条不变量。

import WebKit

/// 视口越界策略注入工具：把根级 overscroll-behavior 规则作为用户脚本注册到
/// WKWebViewConfiguration。
enum ShellOverscrollPolicy {

    /// 根级越界规则：选择器只指向文档根，不触碰页面/上游的任何滚动容器。
    /// !important 的作用边界（2026-12 对抗复核修正）：它压过页面的普通声明，但
    /// 页面若在根上再声明同属性的 !important（同特异性、文档序靠后）或在根元素
    /// 上设内联 !important，仍可翻转——当前上游没有任何根级声明（全仓扫描 0
    /// 命中），这是理论边界而非现状；author 源内也没有手段挡住页面 JS 主动改。
    /// html 是规范的视口传播源；body 只对"body 自身成为滚动容器"的页面生效
    /// （那时它同样不该把越界链到视口），故一并声明。
    static let rootOverscrollCSS = "html, body { overscroll-behavior: none !important; }"

    /// 注入样式元素的标记属性/值：实机自检（打包态一条 JS）与单测据此断言策略
    /// 在册，而不是靠"看起来不弹了"。
    static let styleElementAttribute = "data-dsh-shell-overscroll"
    static let styleElementMarkerValue = "none"

    /// 已安装标记（与 BridgeShimInjector 同款幂等纪律）：WKUserContentController
    /// 没有 stored property，userScripts 是唯一可检查的既有注册面。
    static let installedMarker = "/* dsh-chamber-overscroll-policy-installed */"

    /// 注入源码。本机实测 documentStart 时序：readyState=loading、documentElement
    /// 已存在、head 尚不存在。落点**始终优先 documentElement**（即使 head 已存在
    /// 也不落 head，保住"页面重写 head 也删不掉"的免疫；本机时 head 本就不存在，
    /// 复核装置已验证两种时序下都生效）；两者都取不到时挂一次 DOMContentLoaded
    /// 再落，是 DOM 就绪防护而非第二套行为。已有标记则不重复插入（重载/二次执行
    /// 幂等）。
    static let source: String = """
    (function () {
      var CSS = '\(rootOverscrollCSS)';
      var MARKER = '\(styleElementAttribute)';
      var VALUE = '\(styleElementMarkerValue)';
      function apply() {
        if (document.querySelector('style[' + MARKER + ']')) { return; }
        var host = document.documentElement || document.head;
        if (!host) { document.addEventListener('DOMContentLoaded', apply, { once: true }); return; }
        var style = document.createElement('style');
        style.setAttribute(MARKER, VALUE);
        style.textContent = CSS;
        host.appendChild(style);
      }
      apply();
    })();
    """

    /// 由策略源码构造用户脚本：documentStart 注入、仅主 frame（iframe 子文档
    /// 保持自己的越界行为；视口效果本就只属于主文档）。
    static func makeUserScript() -> WKUserScript {
        WKUserScript(source: installedMarker + "\n" + source,
                     injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    /// 该 configuration 是否已注册过本策略（幂等判据）。
    static func isInstalled(in config: WKWebViewConfiguration) -> Bool {
        config.userContentController.userScripts.contains {
            $0.source.hasPrefix(installedMarker)
        }
    }

    /// 安装：把策略用户脚本注册进 configuration 的 userContentController。
    /// **幂等**：已安装 → no-op（返回 false），绝不重复注册。
    @discardableResult
    static func install(config: WKWebViewConfiguration) -> Bool {
        guard !isInstalled(in: config) else { return false }
        config.userContentController.addUserScript(makeUserScript())
        return true
    }
}
