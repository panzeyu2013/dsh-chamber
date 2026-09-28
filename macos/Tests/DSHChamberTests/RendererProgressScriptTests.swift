//
//  RendererProgressScriptTests.swift
//  DSHChamberTests
//
//  MainWindowController.rendererProgressScript（可见页面渲染进度探针）在
//  JavaScriptCore 里**直跑 shipped 字面量**——不是文本锁，也不是复制一份脚本：
//  这里的 JSContext 是真实 JS 引擎，桩只提供脚本真正读取的四个全局
//  （document/window/requestAnimationFrame/setTimeout），与 packages/desktop 的
//  node 桩（renderer-frame-watchdog.test.ts）同语义。
//
//  覆盖面：
//   (a) 无注入 → rAF/隐藏语义与改动前逐条一致（含"隐藏丢弃链、可见注入重武装"）；
//   (b) 合法 frame-stop 注入被兑现（计数冻结、不再续链）；非 frame-stop 集合不误停；
//   (c) 敌意注入（getter 抛错 / armed 非函数 / armed() 返回非字符串 / 非对象值）
//       只当"无注入"，绝不从 rAF 回调抛出。
//  (c) 是与 Electron 字面量的**有意分歧**：Electron 版读注入对象没有 try/catch，
//  敌意 getter 会把异常抛出 rAF 回调；本壳按"注入不得反伤探针"加固（见
//  MainWindowController.rendererProgressScript 的注释）。
//
//  不在本文件：WKWebView 集成面（脚本确实经 WKUserScript 注入真实页面）——那属
//  实机/装配面，不在此以假 DOM 冒充。
//
import XCTest
import JavaScriptCore
@testable import DSHChamber

final class RendererProgressScriptTests: XCTestCase {

    /// 最小页面桩：只提供脚本真正读取的全局；frame/timer 队列由测试显式驱动。
    private final class ProbePage {
        let context: JSContext

        init(injection: String? = nil) throws {
            context = try XCTUnwrap(JSContext(), "JavaScriptCore 必须可用")
            context.evaluateScript("""
            var window = {};
            var document = { visibilityState: 'visible' };
            var scheduled = [];
            var timers = [];
            var requestAnimationFrame = function (cb) { scheduled.push(cb); return scheduled.length; };
            var setTimeout = function (cb) { timers.push(cb); return timers.length; };
            """)
            if let injection { context.evaluateScript(injection) }
            XCTAssertNil(context.exception, "页面桩与注入建立不得抛错")
        }

        /// 一次探针注入 = evaluateJavaScript 的等价动作；隐藏文档返回 nil。
        func probe() throws -> Int? {
            context.exception = nil
            let value = context.evaluateScript(MainWindowController.rendererProgressScript)
            XCTAssertNil(context.exception, "探针脚本不得抛错")
            guard let value, !value.isNull, !value.isUndefined else { return nil }
            return Int(value.toInt32())
        }

        func runFrame() {
            context.exception = nil
            context.evaluateScript("scheduled.shift()();")
            XCTAssertNil(context.exception, "帧回调不得抛错")
        }

        func runTimer() {
            context.exception = nil
            context.evaluateScript("timers.shift()();")
            XCTAssertNil(context.exception, "定时器回调不得抛错")
        }

        func setVisibility(_ state: String) {
            context.evaluateScript("document.visibilityState = '\(state)';")
        }

        /// 待续链步数 = 待执行 rAF + 待执行 setTimeout（0 = 链已死，1 = 恰好一条）。
        func pending() -> Int {
            Int(context.evaluateScript("scheduled.length + timers.length").toInt32())
        }
    }

    // MARK: - (a) 无注入：既有语义不得变

    func testNoInjectionKeepsTheExistingLoopAndHiddenSemantics() throws {
        let page = try ProbePage()
        XCTAssertEqual(try page.probe(), 0, "首次注入初始化计数并武装")
        XCTAssertEqual(page.pending(), 1)
        page.runFrame()
        XCTAssertEqual(try page.probe(), 1)
        XCTAssertEqual(page.pending(), 1, "健康循环恒只有一条待续链")

        page.setVisibility("hidden")
        XCTAssertNil(try page.probe(), "隐藏注入 = 显式挂起，不计帧")
        XCTAssertEqual(page.pending(), 1, "已在飞的定时器是唯一残留链")
        page.runTimer()
        XCTAssertEqual(page.pending(), 0, "隐藏到期的定时器丢弃链，不再申请帧")
        XCTAssertNil(try page.probe())
        XCTAssertEqual(page.pending(), 0, "隐藏注入也不武装")

        page.setVisibility("visible")
        XCTAssertEqual(try page.probe(), 1, "可见后的下一次注入重新武装")
        XCTAssertEqual(page.pending(), 1, "恰好一条链")
        page.runFrame()
        XCTAssertEqual(try page.probe(), 2)
        _ = try page.probe()
        XCTAssertEqual(page.pending(), 1, "健康循环上的注入绝不双武装")
    }

    // MARK: - (b) 合法注入

    func testArmedFrameStopInjectionFreezesTheCounter() throws {
        let page = try ProbePage(
            injection: #"window.__dshChamberInjection = { armed: function () { return ['frame-stop']; } };"#)
        XCTAssertEqual(try page.probe(), 0)
        page.runFrame()
        XCTAssertEqual(try page.probe(), 0, "frame-stop 故障必须让计数冻结")
        XCTAssertEqual(page.pending(), 0,
                       "停住的循环不续链（armed 保持 true，与 Electron 同形）")
    }

    func testNonFrameStopArmedSetDoesNotStopTheLoop() throws {
        let page = try ProbePage(
            injection: #"window.__dshChamberInjection = { armed: function () { return ['append-silent']; } };"#)
        XCTAssertEqual(try page.probe(), 0)
        page.runFrame()
        XCTAssertEqual(try page.probe(), 1, "只有 frame-stop 停链")
        XCTAssertEqual(page.pending(), 1)
    }

    // MARK: - (c) 敌意注入不得反伤探针

    func testHostileInjectionsAreTreatedAsNoInjection() throws {
        let hostile = [
            "Object.defineProperty(window, '__dshChamberInjection', "
                + "{ get: function () { throw new Error('hostile getter'); } });",
            "window.__dshChamberInjection = {}; Object.defineProperty(window.__dshChamberInjection, "
                + "'armed', { get: function () { throw new Error('hostile armed getter'); } });",
            "window.__dshChamberInjection = { armed: function () { return 42; } };",
            "window.__dshChamberInjection = { armed: 'not a function' };",
            "window.__dshChamberInjection = 'nope';",
            "window.__dshChamberInjection = 42;",
            "window.__dshChamberInjection = null;",
        ]
        for injection in hostile {
            let page = try ProbePage(injection: injection)
            XCTAssertEqual(try page.probe(), 0, "注入不可信时仍按无注入初始化：\(injection)")
            page.runFrame()
            XCTAssertEqual(try page.probe(), 1, "敌意注入不得打断计数/续链：\(injection)")
            XCTAssertEqual(page.pending(), 1, "恰好一条续链：\(injection)")
        }
    }
}
