//
//  ShellWindowDrag.swift
//  DSHChamber
//
//  页面窗口 chrome 行 → 原生窗口拖拽（design 25 §5.5）。
//
//  现象：窗口是「隐藏标题栏 + 内容延伸进标题栏」（titlebarAppearsTransparent +
//  fullSizeContentView），红绿灯浮在侧栏带左端，页面按 data-platform=darwin 自己
//  留白——整窗因此没有任何原生可拖区域。`isMovableByWindowBackground` 判定的是
//  **命中视图**的 mouseDownCanMoveWindow，而 WKWebView 恒 false（本机实测：900×600
//  窗 + WKWebView 作 contentView + 该开关为 true，hitTest 命中 WKWebView，其
//  canMove=false；合成 leftMouseDown 后窗口纹丝不动），故隐藏标题栏后整窗无法移动。
//
//  等价面（与 Electron flavor 的 app-region 同义、同一批标记）：页面用
//  `data-window-drag` 标记「窗口 chrome 行」——ui-web base.css 的 app-region 规则读
//  同一批标记，必带清单见 vendor …/dsh-client-ui-theme/tests/app-region-styles.client.spec.ts
//  的 CHROME_ROWS；chamber 侧栏的顶部带与 logo 行同款（SidebarRoot.tsx）。Electron
//  （Chromium）原生消费 -webkit-app-region，WKWebView 不认，故本文件在 documentStart、
//  仅主 frame 注入一段脚本：mousedown 命中标记行且未命中控件时 preventDefault 并经独立
//  消息通道交回壳；壳用**当前鼠标位置**合成 leftMouseDown 事件调 NSWindow.performDrag
//  （AppKit 的窗口拖拽循环接管，直到抬键）。合成事件的位置取窗口坐标系下的当前鼠标
//  点——与真实 mousedown 的 locationInWindow 同口径，起拖瞬间抓取偏移为零，窗口不跳。
//
//  判定三条纪律（与 base.css / window-drag/regions.ts 对齐）：
//   1. 只有标记行是拖拽面：未标记处（正文、滚动区）永不触发；Electron 侧靠几何盒
//      合成，本侧靠 DOM 真实命中，二者要求同一批标记；
//   2. 控件优先：命中控件（button/a/input/… 见 interactiveSelector）一律不拖，点击、
//      文本选择与页签原行为不变；
//   3. 修饰键按下时不拖（⌘/⌃/⌥/⇧ + 拖动留给页面，与 app-region 一致）。
//  与 base.css 的两处已知偏差（有意）：不消费 data-window-drag-recall 脉冲（那是
//  Electron 重采集几何的专用脉冲，本侧不缓存几何、无需重采集）；命中用 DOM 命中而
//  非几何盒序——可见且被按下的那一层决定结果（几何盒序在「后声明的覆盖层压在标记行
//  之下」这类堆叠怪例上与命中不同，此时本侧更贴近用户所见）。
//
//  安全边界：mousedown 是页面事件，本通道**不接受**页面指定「拖哪个窗、挪到哪」——
//  载荷只有 {kind:"drag"}，窗口与位置都取自壳自己的事实（控制器持有的窗、当前鼠标
//  位置）；准入 = 通道名 + 主 frame + 同源文档（与页面事实通道同款门，控制器注入
//  MainWindowController.isSameOriginDocument，本文件不依赖控制器类型）。本通道**不**并入
//  A 桥白名单/就绪门链路：窗口拖拽在 sidecar ready 前就该可用（与页面事实通道同理）。
//
import AppKit
import WebKit

/// 注入脚本的单一真源：通道名、标记属性、控件选择器与源码都从这里取。
/// interactiveSelector 是 TS 侧 INTERACTIVE_SELECTOR 的镜像（逐项锁步，
/// CrossLanguageLockstepTests 读 TS 源文本比对，改一侧必须同步另一侧）。
enum ShellWindowDragScript {

    /// 独立消息通道名（见文件头安全边界）。
    static let messageName = "dshChamberWindowDrag"

    /// 页面标记属性：窗口 chrome 行（与 ui-web `DRAG_MARK` / base.css 的 app-region
    /// 规则同源）。
    static let dragMarkAttribute = "data-window-drag"

    /// 载荷 kind：本通道只有一种请求（开始拖拽），其余一律丢弃。
    static let payloadKind = "drag"

    /// 注入源码里的安装标记（幂等 + 源码锁的锚点）。
    static let installedMarker = "/* dsh-chamber-window-drag-installed */"

    /// 命中即不拖的控件选择器（镜像 packages/dsh-client-web/src/window-drag/regions.ts
    /// 的 INTERACTIVE_SELECTOR；顺序也锁步，便于逐项比对）。
    static let interactiveSelector: [String] = [
        "button", "a", "input", "select", "textarea", "summary", "[contenteditable='true']",
        "[tabindex]", "[role='dialog']", "[role='alertdialog']", "[role='menu']", "[role='listbox']",
        "[role='tooltip']", "[role='button']", "[role='link']", "[role='tab']", "[role='menuitem']",
        "[role='menuitemcheckbox']", "[role='menuitemradio']", "[role='option']", "[role='checkbox']",
        "[role='radio']", "[role='switch']", "[role='slider']", "[role='combobox']", "[role='textbox']",
    ]

    /// 同一个列表的 JSON 形式：注入源码把它当下发的 JS 数组字面量，脚本再 join 成
    /// `:is(...)` 选择器。走 JSON 而不是手拼字符串，是因为选择器条目里本来就有引号
    /// （`[contenteditable='true']`）——手拼会截断 JS 字符串字面量（本机 JSContext 实测
    /// 得到 SyntaxError，脚本整段失效）。
    static var interactiveSelectorJSON: String {
        guard let data = try? JSONSerialization.data(withJSONObject: interactiveSelector),
              let json = String(data: data, encoding: .utf8) else { return "[]" }
        return json
    }

    /// 注入源码。与 BridgeShimInjector / ShellOverscrollPolicy 同段装配
    /// （configuration 段、必须先于 WKWebView 构造；崩溃/卡死恢复只 reload，注入随每次
    /// 导航生效），documentStart 时 document 里还没有 body，故监听器挂在 document 上
    /// （capture 段：先于页面自己的处理器，命中即 preventDefault + stopPropagation，
    /// 不给页面看到这次按下——与 app-region 的「页面根本不收这次拖动」同义）。
    static var source: String {
        """
        \(installedMarker)
        (function () {
          var CHANNEL = '\(messageName)';
          var MARK = '\(dragMarkAttribute)';
          var DRAG = '[' + MARK + ']';
          var INTERACTIVE = \(interactiveSelectorJSON);
          var NO_DRAG = ':is(' + INTERACTIVE.join(', ') + ')';
          var RECALL = 'data-window-drag-recall';
          // 幂等：同文档重复执行只挂一个监听器（导航会整份重来，这里防的是重注入）。
          if (window.__dshShellWindowDrag === CHANNEL) { return; }
          window.__dshShellWindowDrag = CHANNEL;

          function post() {
            var handlers = window.webkit && window.webkit.messageHandlers;
            if (!handlers || !handlers[CHANNEL]) { return; }
            try { handlers[CHANNEL].postMessage({ kind: '\(payloadKind)' }); } catch (err) {}
          }

          // 与 base.css 的 no-drag 规则同源：控件/raised surface 自身；body 旁的
          // portal 层（body > :not(#root)）；recall 脉冲标记（只需认识它）。
          function isNoDrag(el) {
            if (el.matches(NO_DRAG)) { return true; }
            if (el.hasAttribute(RECALL)) { return true; }
            var parent = el.parentElement;
            return !!(parent && parent === document.body && el.id !== 'root');
          }

          // 最近的匹配者定胜负：DOM 序里后代盒在祖先盒之后且包含祖先盒的点，故
          // 「按下的元素链上第一个匹配者」= base.css 的「最后一个盒决定」。
          // 同一元素同时命中 drag 与 no-drag 时 base.css 的 no-drag 规则靠后，
          // 故先判 no-drag。
          function isDragRow(target) {
            for (var el = target; el && el.nodeType === 1; el = el.parentElement) {
              if (isNoDrag(el)) { return false; }
              if (el.matches(DRAG)) { return true; }
            }
            return false;
          }

          function onMouseDown(event) {
            if (event.button !== 0 || event.defaultPrevented) { return; }
            if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) { return; }
            var target = event.target;
            if (!target || typeof target.matches !== 'function') { return; }
            if (!isDragRow(target)) { return; }
            event.preventDefault();
            event.stopPropagation();
            post();
          }

          document.addEventListener('mousedown', onMouseDown, true);
        })();
        """
    }
}

/// 入站判定结果（纯值：单测直测真值表；副作用只在 ShellWindowDrag.beginDrag）。
enum ShellWindowDragOutcome: Equatable {
    /// 准入通过：起原生窗口拖拽。
    case beginDrag
    /// 名称/帧/载荷/文档面任一不过：静默丢弃（本通道无回执）。
    case ignore
}

/// 页面拖拽请求 → 原生窗口拖拽。判定与事件合成都是纯函数，`beginDrag` 是唯一
/// 副作用点（NSWindow.performDrag）。
enum ShellWindowDrag {

    /// 入站围栏（纯函数）。文档 URL 口径与页面事实通道同款：以 webView.url（实时）
    /// 为准，frameInfo.request.url 只在 webView 缺席时兜底（依据见
    /// MainWindowController.factsDocumentURL 注记）；admitted 由控制器注入
    /// isSameOriginDocument，nil/未装配 → 一律不过。
    static func outcome(messageName: String, isMainFrame: Bool, kind: String?,
                        webViewURL: String?, frameRequestURL: String?,
                        admitted: ((String?) -> Bool)?) -> ShellWindowDragOutcome {
        guard messageName == ShellWindowDragScript.messageName else { return .ignore }
        guard isMainFrame else { return .ignore }
        guard kind == ShellWindowDragScript.payloadKind else { return .ignore }
        guard let admitted, let url = webViewURL ?? frameRequestURL else { return .ignore }
        return admitted(url) ? .beginDrag : .ignore
    }

    /// 合成拖动事件（纯函数：只吃窗口号/窗口系坐标/时间戳，WebKit/AppKit 类型在单测里
    /// 建不出来，故接缝取在事件本身上）。位置必须是**窗口坐标系**（见文件头）。
    static func dragEvent(windowNumber: Int, at windowPoint: NSPoint,
                          timestamp: TimeInterval) -> NSEvent? {
        NSEvent.mouseEvent(with: .leftMouseDown,
                           location: windowPoint,
                           modifierFlags: [],
                           timestamp: timestamp,
                           windowNumber: windowNumber,
                           context: nil,
                           eventNumber: 0,
                           clickCount: 1,
                           pressure: 1)
    }

    /// 唯一副作用点：按当前鼠标位置起一次原生窗口拖拽。返回是否真的交给了 AppKit
    /// （不可移动/最小化/合成失败 → false）。`performDrag` 在手指未按下时立即返回
    /// （本机实测：不起拖、不挂起、不挪窗），故「按下与消息到达之间已抬键」不会挂住壳。
    @discardableResult
    static func beginDrag(window: NSWindow,
                          screenPoint: NSPoint = NSEvent.mouseLocation,
                          timestamp: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Bool {
        guard window.isMovable, !window.isMiniaturized else { return false }
        let point = window.convertPoint(fromScreen: screenPoint)
        guard let event = dragEvent(windowNumber: window.windowNumber,
                                    at: point,
                                    timestamp: timestamp) else { return false }
        window.performDrag(with: event)
        return true
    }
}

/// 拖拽通道 handler：独立 WKScriptMessageHandler，只做围栏与转发（判定在
/// ShellWindowDrag.outcome）。回调线程 = 主线程（WKScriptMessageHandler 的到达契约），
/// 故 performDrag 直接在回调里调，无需切线程。
final class ShellWindowDragMessageHandler: NSObject, WKScriptMessageHandler {

    /// 同源文档门（控制器注入 MainWindowController.isSameOriginDocument；nil = 未装配
    /// → 一律不过）。
    var admittedDocument: ((String?) -> Bool)?
    /// 拖拽目标窗口（弱引用经控制器取；nil = 未建窗/已释放）。
    var targetWindow: (() -> NSWindow?)?

    init(admittedDocument: ((String?) -> Bool)? = nil, targetWindow: (() -> NSWindow?)? = nil) {
        self.admittedDocument = admittedDocument
        self.targetWindow = targetWindow
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        // 名称门先行：不匹配的通道连 body/闭包都不求值。
        guard message.name == ShellWindowDragScript.messageName else { return }
        let kind = (message.body as? [String: Any])?["kind"] as? String
        let outcome = ShellWindowDrag.outcome(
            messageName: message.name,
            isMainFrame: message.frameInfo.isMainFrame,
            kind: kind,
            webViewURL: message.webView?.url?.absoluteString,
            frameRequestURL: message.frameInfo.request.url?.absoluteString,
            admitted: admittedDocument)
        guard outcome == .beginDrag else { return }
        guard let window = targetWindow?() else { return }
        ShellWindowDrag.beginDrag(window: window)
    }
}
