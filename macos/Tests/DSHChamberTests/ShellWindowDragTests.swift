//
//  ShellWindowDragTests.swift
//  DSHChamberTests
//
//  窗口拖拽通道（ShellWindowDrag）的围栏判定、事件合成与**注入脚本行为**。
//
//  判定收敛为纯函数（outcome / dragEvent），本文件直测真值表；注入脚本是通道里唯一
//  会进页面的东西，故在 JavaScriptCore 里对着最小假 DOM 直接跑它：拖/不拖、
//  preventDefault/stopPropagation、载荷形状、幂等（重复注入只挂一个监听器）都由行为
//  断言，而不是只锁源码字符串——源码锁只保证契约字面量在册（见下方）。
//
import XCTest
import JavaScriptCore
@testable import DSHChamber

final class ShellWindowDragTests: XCTestCase {

    // MARK: - 入站围栏（真值表）

    func testOutcomeTruthTable() {
        let sameOrigin: (String?) -> Bool = { $0 == "https://cp.example/" }
        let admitAll: (String?) -> Bool = { _ in true }

        XCTAssertEqual(outcome(kind: "drag", url: "https://cp.example/", admitted: sameOrigin), .beginDrag)
        // 跨源 / 无 URL / 未装配（expectedOrigin 尚未就绪）/ 载荷不符 / 通道不符 / 子 frame：
        // 静默丢弃（本通道无回执）。
        XCTAssertEqual(outcome(kind: "drag", url: "https://evil.example/", admitted: sameOrigin), .ignore)
        XCTAssertEqual(outcome(kind: "drag", url: nil, admitted: admitAll), .ignore)
        XCTAssertEqual(outcome(kind: "drag", url: "https://cp.example/", admitted: nil), .ignore)
        XCTAssertEqual(outcome(kind: nil, url: "https://cp.example/", admitted: admitAll), .ignore)
        XCTAssertEqual(outcome(kind: "move", url: "https://cp.example/", admitted: admitAll), .ignore)
        XCTAssertEqual(outcome(messageName: "dshChamber", kind: "drag",
                               url: "https://cp.example/", admitted: admitAll), .ignore)
        XCTAssertEqual(outcome(isMainFrame: false, kind: "drag",
                               url: "https://cp.example/", admitted: admitAll), .ignore)
    }

    /// 文档 URL 口径与页面事实通道同款：webView.url（实时）优先，缺席时退回
    /// frameInfo.request.url（依据见 MainWindowController.factsDocumentURL 注记）。
    func testOutcomePrefersLiveWebViewURLAndFallsBackToFrameRequestURL() {
        // 真门（isSameOriginDocument）比 scheme/host/port，不限定 path；这里用前缀谓词
        // 代表「同源但非根路径」的两种情况（pushState 后的 URL、/api/i/* 请求 URL）。
        let sameOrigin: (String?) -> Bool = { $0?.hasPrefix("https://cp.example/") == true }
        XCTAssertEqual(ShellWindowDrag.outcome(messageName: ShellWindowDragScript.messageName,
                                               isMainFrame: true, kind: "drag",
                                               webViewURL: nil,
                                               frameRequestURL: "https://cp.example/x",
                                               admitted: sameOrigin), .beginDrag)
        XCTAssertEqual(ShellWindowDrag.outcome(messageName: ShellWindowDragScript.messageName,
                                               isMainFrame: true, kind: "drag",
                                               webViewURL: "https://cp.example/after-push-state",
                                               frameRequestURL: "https://cp.example/",
                                               admitted: sameOrigin), .beginDrag)
        XCTAssertEqual(ShellWindowDrag.outcome(messageName: ShellWindowDragScript.messageName,
                                               isMainFrame: true, kind: "drag",
                                               webViewURL: nil, frameRequestURL: nil,
                                               admitted: sameOrigin), .ignore)
    }

    private func outcome(messageName: String = ShellWindowDragScript.messageName,
                         isMainFrame: Bool = true, kind: String?, url: String?,
                         admitted: ((String?) -> Bool)?) -> ShellWindowDragOutcome {
        ShellWindowDrag.outcome(messageName: messageName, isMainFrame: isMainFrame, kind: kind,
                                webViewURL: url, frameRequestURL: nil, admitted: admitted)
    }

    // MARK: - 事件合成（接缝：WKScriptMessage/窗口在单测里建不出来，事件本身可以）

    func testDragEventIsAWindowCoordinateLeftMouseDown() throws {
        let event = try XCTUnwrap(ShellWindowDrag.dragEvent(windowNumber: 42,
                                                            at: NSPoint(x: 10, y: 20),
                                                            timestamp: 7))
        XCTAssertEqual(event.type, .leftMouseDown)
        XCTAssertEqual(event.windowNumber, 42)
        // 位置是**窗口坐标系**：起拖瞬间抓取偏移为零，窗口不跳（文件头）。
        XCTAssertEqual(event.locationInWindow, NSPoint(x: 10, y: 20))
        XCTAssertEqual(event.clickCount, 1)
        XCTAssertEqual(event.pressure, 1)
        XCTAssertEqual(event.modifierFlags.intersection(.deviceIndependentFlagsMask), [])
    }

    // MARK: - 注入源码锁（契约字面量必须在册）

    func testScriptSourceCarriesTheChannelContract() {
        let source = ShellWindowDragScript.source
        XCTAssertEqual(source, ShellWindowDragScript.source, "source 每次必须返回同一文本（纯函数）")
        XCTAssertTrue(source.hasPrefix(ShellWindowDragScript.installedMarker),
                      "安装标记必须在首行（幂等锚点）")
        XCTAssertTrue(source.contains("'\(ShellWindowDragScript.messageName)'"))
        XCTAssertTrue(source.contains("'\(ShellWindowDragScript.payloadKind)'"))
        XCTAssertTrue(source.contains("'\(ShellWindowDragScript.dragMarkAttribute)'"))
        XCTAssertTrue(source.contains("var INTERACTIVE = \(ShellWindowDragScript.interactiveSelectorJSON);"),
                      "控件选择器必须以 JSON 数组下发（手拼引号会截断 JS 字符串，见 interactiveSelectorJSON）")
        XCTAssertTrue(source.contains("var NO_DRAG = ':is(' + INTERACTIVE.join(', ') + ')';"),
                      ":is(...) 必须在脚本里由同一份列表拼出")
        // 选择器条目里带引号（[contenteditable='true']）是**必须**走 JSON 下发的原因：
        // 手拼的 JS 字符串会在该条目处被截断（本机 JSContext 实测 SyntaxError，整段脚本失效）。
        XCTAssertTrue(ShellWindowDragScript.interactiveSelectorJSON.contains("\"[contenteditable='true']\""),
                      "JSON 形式必须原样保住带引号的选择器条目")
        XCTAssertTrue(source.contains("\"[contenteditable='true']\""),
                      "带引号条目必须出现在注入源码里")
        XCTAssertTrue(source.contains("document.addEventListener('mousedown', onMouseDown, true)"),
                      "必须 capture 段监听：先于页面处理器 preventDefault + stopPropagation")
        XCTAssertTrue(source.contains("'data-window-drag-recall'"),
                      "recall 脉冲只需认识：壳不缓存几何，不做重采集")
        XCTAssertFalse(source.contains("__INTERPOLATE__"), "不得留下未替换占位符")
    }

    // MARK: - 注入脚本行为（JavaScriptCore + 最小假 DOM）

    /// 脚本只读 window/document 与元素链上的 matches/hasAttribute/parentElement/id/
    /// nodeType，故最小假 DOM 足够。断言「谁被拖、谁被放行」：标记行内的非控件面可拖且
    /// 事件被吞；控件、未标记面、修饰键、非左键、已被按下的默认行为、recall 标记一律
    /// 原样放行（不改页面的点击/焦点/选择语义）。
    func testScriptDecisionAgainstAFakeDOM() throws {
        let context = try XCTUnwrap(JSContext())
        context.evaluateScript(fakeDOMSource())
        context.evaluateScript(ShellWindowDragScript.source)
        // 幂等：导航重注入/重复执行不得挂第二个监听器（否则一次按下会起两次拖拽）。
        context.evaluateScript(ShellWindowDragScript.source)
        let json = try XCTUnwrap(context.evaluateScript("JSON.stringify(runScenarios())")?.toString())
        let data = try XCTUnwrap(json.data(using: .utf8))
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        XCTAssertEqual(rows.count, expectedScenarios.count, "场景数必须与预期表一致")
        for row in rows {
            let name = row["name"] as? String ?? "<unnamed>"
            let detail = row["detail"] as? String ?? ""
            XCTAssertTrue(expectedScenarios.contains(name), "未在预期表里的场景：\(name)")
            XCTAssertEqual(row["ok"] as? Bool, true, "场景失败：\(name)（\(detail)）")
        }
        for name in expectedScenarios where !rows.contains(where: { $0["name"] as? String == name }) {
            XCTFail("预期场景缺跑：\(name)")
        }
    }

    /// 场景表（与 fakeDOMSource 里的 record(...) 一一对应；数量/名字两边都锁，防漏跑）。
    private let expectedScenarios = [
        "标记行内的非控件子节点 → 拖",
        "标记行内的控件 → 不拖",
        "标记行内 raised surface 的孙节点 → 不拖",
        "未标记的普通元素 → 不拖",
        "对话框内的标记行（后代盒在后，胜出）→ 拖",
        "#root 本身 → 不拖",
        "body 旁的 portal 层本身 → 不拖",
        "portal 层内的标记行 → 拖",
        "修饰键按下 → 不拖",
        "非左键 → 不拖",
        "已被页面 preventDefault → 不拖",
        "recall 标记元素 → 不拖",
        "非元素目标 → 不拖且不抛",
    ]

    private func fakeDOMSource() -> String {
        """
        var posted = [];
        var listener = null;
        var docBody = fakeEl({ id: 'body' });
        var document = {
          body: docBody,
          addEventListener: function (type, fn, capture) {
            if (type === 'mousedown' && capture === true) { listener = fn; }
          }
        };
        var window = {
          webkit: {
            messageHandlers: {
              '\(ShellWindowDragScript.messageName)': {
                postMessage: function (payload) { posted.push(payload); }
              }
            }
          }
        };
        function fakeEl(o) {
          o = o || {};
          var el = {
            nodeType: 1,
            id: o.id || '',
            parentElement: o.parent || null,
            drag: !!o.drag,
            nodrag: !!o.nodrag,
            recall: !!o.recall,
            matches: function (sel) {
              // 脚本只问这两个选择器：标记属性与 :is(控件选择器串)。
              if (sel === '[data-window-drag]') { return this.drag; }
              if (sel.indexOf(':is(') === 0) { return this.nodrag; }
              return false;
            },
            hasAttribute: function (name) {
              return name === 'data-window-drag-recall' ? this.recall : false;
            }
          };
          return el;
        }
        function press(target, o) {
          o = o || {};
          var ev = {
            button: o.button === undefined ? 0 : o.button,
            defaultPrevented: !!o.defaultPrevented,
            metaKey: !!o.metaKey,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: target,
            prevented: false,
            stopped: false,
            preventDefault: function () { this.prevented = true; },
            stopPropagation: function () { this.stopped = true; }
          };
          listener(ev);
          return ev;
        }
        function runScenarios() {
          var out = [];
          function record(name, expectDrag, target, o) {
            posted.length = 0;
            var ev = press(target, o);
            var dragged = posted.length === 1 && posted[0] && posted[0].kind === 'drag';
            var ok = dragged === expectDrag && (expectDrag
              ? (ev.prevented === true && ev.stopped === true)
              : (ev.prevented === false && ev.stopped === false));
            out.push({ name: name, ok: ok,
                       detail: 'posted=' + posted.length + ' prevented=' + ev.prevented
                             + ' stopped=' + ev.stopped });
          }
          var strip = fakeEl({ drag: true });
          var titleText = fakeEl({ parent: strip });
          var toggleButton = fakeEl({ parent: strip, nodrag: true });
          var raisedInsideRow = fakeEl({ parent: fakeEl({ parent: strip, nodrag: true }) });
          var plain = fakeEl({});
          var dialog = fakeEl({ nodrag: true });
          var rowInDialog = fakeEl({ drag: true, parent: dialog });
          var root = fakeEl({ id: 'root', parent: docBody });
          var portal = fakeEl({ id: 'portal', parent: docBody });
          var rowInPortal = fakeEl({ drag: true, parent: portal });
          var recallEl = fakeEl({ recall: true });

          record('标记行内的非控件子节点 → 拖', true, titleText);
          record('标记行内的控件 → 不拖', false, toggleButton);
          record('标记行内 raised surface 的孙节点 → 不拖', false, raisedInsideRow);
          record('未标记的普通元素 → 不拖', false, plain);
          record('对话框内的标记行（后代盒在后，胜出）→ 拖', true, rowInDialog);
          record('#root 本身 → 不拖', false, root);
          record('body 旁的 portal 层本身 → 不拖', false, portal);
          record('portal 层内的标记行 → 拖', true, rowInPortal);
          record('修饰键按下 → 不拖', false, titleText, { metaKey: true });
          record('非左键 → 不拖', false, titleText, { button: 2 });
          record('已被页面 preventDefault → 不拖', false, titleText, { defaultPrevented: true });
          record('recall 标记元素 → 不拖', false, recallEl);
          record('非元素目标 → 不拖且不抛', false, { nodeType: 3 });
          return out;
        }
        """
    }
}
