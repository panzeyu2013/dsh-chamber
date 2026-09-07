// MessageHandler.swift — A 桥 Swift 端消息处理器（传输层护栏 + invoke 上行 +
// 事件下行出口）
//
// W-04（docs/progress/todo/macos-swift-v1.md §0.2-⑤「A 桥雏形」）/ design 25
// §4.4.1（A 桥 web↔Swift）与 §0.1-B3（渲染器可用性门：ready 前期望 origin
// 未开放 → origin 护栏一律拒绝、渲染端有界重试自愈——与 preload「先 info 后
// expose」对偶，D1 二选一取「documentStart 预定义 + 就绪前 reject」）。
//
// 完整消息流（design 25 §3.1 / §4.4.1）：
//
//   web（shim: window.webkit.messageHandlers.dshChamber.postMessage
//         {id, method, payload}）
//     └→ userContentController.add(ChamberMessageHandler, name: "dshChamber")
//         └→ userContentController(_:didReceive:)  ← 本文件
//             传输层护栏（语义校验在 sidecar，design 25 §1.2 目标 4）：
//                1. message.name == "dshChamber" && frameInfo.isMainFrame
//                2. origin === 期望控制面 origin（TrustGuard.isTrustedOrigin；
//                   expectedOrigin() 在 ready 帧前返回 nil → 一律拒绝）
//                3. 信封结构：[String: Any]，含 id: Int、method: String，
//                   payload 可选（AnyCodable）
//                4. 尺寸 ≤ 4 MiB（TrustGuard.envelopeSizeOK）
//                5. method ∈ 白名单（TrustGuard.isAllowedMethod）
//             全过 → onInvoke(id, method, payload)
//         └→ onInvoke → controller → BridgeClient.invoke(method:payload:)
//              → sidecar（60 invoke 处理器语义校验原样，design 25 §3.1）
//             任一不过 → evaluateJavaScript
//             "__dshChamberResolve(id, null, <错误码>)"（错误码与
//             renderer-trust / design 25 §4.4.1 同族：Electron 侧投
//             { code:'ipc_sender_forbidden' }，A 桥版沿用字符串族）
//
//   反向事件（sidecar push → web）：
//     sidecar 事件 → B 桥 → BridgeClient.onEvent(event, payload)
//       → controller 二选一（避免双写 __dshChamberEmit）：
//         甲（推荐，本文件自包含）：controller 把 BridgeClient.onEvent 转接
//             进 handler.emit(event:payload:) —— emit 负责序列化为
//             "__dshChamberEmit(event, payload)" 并交给 evaluateJavaScript，
//             controller 不再自行拼装 __dshChamberEmit；
//         乙：controller 用自己的桥直接写 __dshChamberEmit —— 此时
//             controller 不调用 emit。
//       谁调用谁：事件下行唯一入口是 controller → emit → evaluateJavaScript
//       （谁持有 BridgeClient 谁就是事件源；emit 永不被本 handler 内部触发）。
//       → web shim 订阅表按事件名派发（design 25 §4.4.1 事件面；通道名以
//         IPC_CHANNELS / 05 §7.4 为权威，POC 手写 3 通道）。
//
// 线程与持有关系：
//   - userContentController.add(handler:) 会强持有本对象，因此本对象绝不
//     反向强持有 webView：didReceive 只读 message.webView?.url（weak，可能
//     nil）与 controller 经 noteCommitted(url:) 写入的 lastCommittedURL；
//     evaluateJavaScript 是 controller 赋入的闭包（内部通常 weak 捕获
//     webView），本文件不 import AppKit/WKWebView 回写 API。
//   - didReceive / emit 预期在主线程被调用（WKScriptMessageHandler 回调与
//     WKWebView.evaluateJavaScript 均主线程语义）；controller 侧若从后台
//     线程喂入事件，需自行切主线程再调 emit（赋入方责任，注释声明）。
//
// 可测性：不依赖真实 WKWebView——测试可直接驱动
// userContentController(_:didReceive:)（伪造 WKScriptMessage 子类），或先
// noteCommitted(url:) 再投递 webView == nil 的消息；emit 的 JS 输出经
// evaluateJavaScript 闭包捕获断言。

import Foundation
import WebKit

/// A 桥 Swift 端消息处理器：web →（护栏）→ onInvoke 上行；emit 供反向事件
/// 下行。仅传输层护栏，语义校验在 sidecar。
final class ChamberMessageHandler: NSObject, WKScriptMessageHandler {

    // MARK: - 构造参数（共享契约，MainWindowController 按此构造，勿改名）

    /// 方法白名单：POC 手写 3 通道（info / desktop_ssh_instances_get /
    /// desktop_ssh_status_changed 订阅面），其余通道一律 method_not_allowed；
    /// M2 manifest 化后以 BridgeManifest 生成为准（design 25 §4.4.3）。
    private let whitelist: Set<String>

    /// 期望控制面 origin 的取回闭包：controller 在收到 sidecar ready 帧
    /// （origin 门开放）前返回 nil → origin 护栏对全部消息回
    /// ipc_sender_forbidden，渲染端按既有「10×50ms 有界重试」自愈
    /// （design 25 §4.4.1 第 2 条「port 只在 ready 帧后放开」+ §0.1-B3
    /// 「就绪握手『返回 false → 渲染端有界重试』语义保留」）。
    private let expectedOrigin: () -> String?

    /// invoke 上行回调（护栏全过后调用）：controller 在此转
    /// BridgeClient.invoke(method:payload:) → sidecar（语义校验在 sidecar）。
    private let onInvoke: (Int, String, AnyCodable?) -> Void

    /// 事件下行降级回调：emit() 在 evaluateJavaScript 尚未赋入（controller
    /// 未就绪 / 纯测试环境）时，把事件原样经此交回 controller（缓冲至 ready
    /// 后重放或记录），避免就绪前事件静默丢失——§0.1-B3 渲染器可用性门的
    /// 事件面对偶。正常情况下（evaluateJavaScript 已赋入）不会被调用。
    /// 谁调用谁：emit →（evaluateJavaScript 就绪 ? 直写 web : onEvent）。
    private let onEvent: (String, AnyCodable?) -> Void

    /// 回写通道：controller 赋入（内部为 WKWebView.evaluateJavaScript，
    /// 主线程调用）。handler 只持闭包不持 webView（add 强持 handler，
    /// 反向强持 webView 会成环；闭包内捕获 controller/webView 应 weak）。
    var evaluateJavaScript: ((String) -> Void)?

    /// 最近一次已提交导航（didCommit）的顶层 URL：controller 在导航提交时
    /// 调 noteCommitted(url:) 更新。origin 判定以 message.webView?.url
    /// （实时）优先、此记录兜底（webView 缺省 / 进程终止 / 测试桩），
    /// 二选一实现并注释于 didReceive ②。
    var lastCommittedURL: String?

    // MARK: - 初始化

    init(whitelist: Set<String>,
         expectedOrigin: @escaping () -> String?,
         onInvoke: @escaping (Int, String, AnyCodable?) -> Void,
         onEvent: @escaping (String, AnyCodable?) -> Void) {
        self.whitelist = whitelist
        self.expectedOrigin = expectedOrigin
        self.onInvoke = onInvoke
        self.onEvent = onEvent
        super.init()
    }

    /// controller 在导航提交（didCommit，design 25 §4.5 三事件映射的提交点）
    /// 时调用：记录主 frame 当前 URL 供 origin 判定兜底。
    func noteCommitted(url: String?) {
        lastCommittedURL = url
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        // ① 通道名 + 主 frame。WKScriptMessage 只可能来自注册了本 handler
        //    的 content controller 所属 webView（design 25 §4.4.1 第 1 条
        //    「主 frame」；对应 Electron 侧 event.senderFrame ===
        //    webContents.mainFrame，renderer-trust.ts 同族）。子 frame /
        //    未知通道一律静默不处理（不是我们的信封，无 Promise 可归因）。
        guard message.name == "dshChamber", message.frameInfo.isMainFrame else { return }

        // ② origin 护栏（design 25 §4.4.1 第 2 条）。当前顶层 URL 取法二选一
        //    的实现：优先 message.webView?.url（真实加载场景的实时值；该
        //    属性本身 weak），缺失时回退 noteCommitted 的 lastCommittedURL
        //    （进程终止后、纯测试桩等无 webView 场景）——本 handler 不持有
        //    webView 强引用，只依赖这两处取当前值。
        let currentURL = message.webView?.url?.absoluteString ?? lastCommittedURL
        guard let expected = expectedOrigin(),
              TrustGuard.isTrustedOrigin(currentURL, expectedOrigin: expected) else {
            // 不信任来源页：无 shim 的 Promise 归因保证；仅当信封仍能解析出
            // id 时回执（错误码同族 renderer-trust {code:'ipc_sender_forbidden'}）。
            // 此时 evaluateJavaScript 的目标页 = 消息来源页，回执只含固定错误
            // 码字符串，不含任何载荷/内部信息（对不可信页面无信息泄漏面）。
            rejectIfAddressable(message.body, code: Self.codeSenderForbidden)
            return
        }

        // ③ 信封结构：必须是 [String: Any]，含 id: Int、method: String，
        //    payload 可选（JSONSerialization 读桥接对象；id 需整值——JS 数字
        //    桥接为 NSNumber，用 exactInt 做整值/布尔/越界校验）。
        guard let envelope = message.body as? [String: Any],
              let id = Self.exactInt(from: envelope["id"]),
              let method = envelope["method"] as? String else {
            rejectIfAddressable(message.body, code: Self.codeMalformedEnvelope)
            return
        }

        // ④ 尺寸上限（design 25 §4.4.1 ③「≤4 MiB」）：对 message.body 整体
        //    做一次 JSON 序列化，用序列化文本计量字节（TrustGuard.envelopeSizeOK
        //    按 body.utf8.count）。postMessage 的 WebKit 序列化 ≈ JSON，键序/
        //    空白差异属 POC 近似（W-04 声明）。
        //    先做 ③b 有限性扫描再序列化：JSONSerialization 遇到 NaN/±Infinity
        //    抛的是 NSException 而非 NSError（try? 拦不住，直接崩进程）——JS
        //    侧的 NaN/Infinity 经桥接可成为 NSNumber(NaN)，故任何序列化之前
        //    必须先递归确认信封可无异常 JSON 化；不过 → 信封不合法（NaN/
        //    Infinity 本就无 JSON 表示，sidecar JSON 语义层也无法消费）。
        guard Self.isJSONSerializableValue(envelope) else {
            reject(id: id, code: Self.codeMalformedEnvelope)
            return
        }
        guard let envelopeData = try? JSONSerialization.data(withJSONObject: envelope) else {
            reject(id: id, code: Self.codeMalformedEnvelope)
            return
        }
        guard TrustGuard.envelopeSizeOK(String(decoding: envelopeData, as: UTF8.self)) else {
            reject(id: id, code: Self.codeFrameTooLarge)
            return
        }

        // ⑤ 方法白名单（design 25 §4.4.1 ③「method ∈ manifest 白名单」）。
        guard TrustGuard.isAllowedMethod(method, whitelist: whitelist) else {
            reject(id: id, code: Self.codeMethodNotAllowed)
            return
        }

        // ⑥ payload → AnyCodable：payload 键缺省 → nil（无载荷）；键存在
        //    （含显式 null）→ JSON 往返转换，失败视为信封不合法（传输层
        //    无法忠实表达，语义层本应拿到合法 JSON payload）。
        let payload: AnyCodable?
        if let rawPayload = envelope["payload"] {
            guard let converted = Self.anyCodablePayload(from: rawPayload) else {
                reject(id: id, code: Self.codeMalformedEnvelope)
                return
            }
            payload = converted
        } else {
            payload = nil
        }

        // 全过 → invoke 上行（controller → BridgeClient → sidecar；
        // 结果回写 __dshChamberResolve 属 controller/桥的职责，不在本文件）。
        onInvoke(id, method, payload)
    }

    // MARK: - 事件下行出口（反向事件：sidecar → BridgeClient.onEvent → controller → 本方法 → web）

    /// 把原生事件序列化为 `__dshChamberEmit(event, payload)` 调用串交给
    /// evaluateJavaScript（design 25 §4.4.1 事件面；shim 按订阅表派发）。
    ///
    /// 双写纪律：controller 的 BridgeClient.onEvent 事件源与本方法二选一
    /// 接线——甲：controller 把 onEvent 事件转接进本方法（推荐，序列化唯一
    /// 出口）；乙：controller 自备桥直写 __dshChamberEmit（此时不得再调
    /// emit）。同一事件绝不允许两条路径各发一次。
    ///
    /// evaluateJavaScript 未赋入（controller 未 ready / 纯测试）时，事件
    /// 原样经构造时 onEvent 回调交回 controller（可缓冲至 ready 后重放），
    /// 不静默丢失（§0.1-B3 事件面对偶）。
    func emit(event: String, payload: AnyCodable?) {
        let eventLiteral = Self.jsStringLiteral(event)
        let payloadLiteral = Self.jsPayloadLiteral(payload) ?? "null"
        let js = "__dshChamberEmit(\(eventLiteral), \(payloadLiteral));"
        if let evaluateJavaScript {
            evaluateJavaScript(js)
        } else {
            onEvent(event, payload)
        }
    }

    // MARK: - 回执与私有工具

    /// 错误码（A 桥版，与 renderer-trust / design 25 §4.4.1 拒绝语义同族：
    /// Electron 侧为 { code: 'ipc_sender_forbidden' } 等，web 侧 shim 据码
    /// reject Promise，UI 按既有错误投影呈现——loud，绝不静默吞错）。
    private static let codeSenderForbidden = "ipc_sender_forbidden"   // origin / 主 frame 信任失败
    private static let codeMethodNotAllowed = "method_not_allowed"    // method ∉ 白名单
    private static let codeFrameTooLarge = "frame_too_large"          // 信封 > 4 MiB
    private static let codeMalformedEnvelope = "malformed_envelope"   // 结构/JSON 表示不合法

    /// 护栏不过 → 经 evaluateJavaScript 回 `__dshChamberResolve(id, null, 码)`。
    private func reject(id: Int, code: String) {
        evaluateJavaScript?("__dshChamberResolve(\(id), null, \(Self.jsStringLiteral(code)));")
    }

    /// 仅当信封可解析出合法 id 时回执（否则无 Promise 可归因——静默丢弃并
    /// 注释声明，不向页面注入无法归因的 JS）。
    private func rejectIfAddressable(_ body: Any, code: String) {
        guard let dict = body as? [String: Any], let id = Self.exactInt(from: dict["id"]) else { return }
        reject(id: id, code: code)
    }

    /// 整值字段校验：JS 数字桥接为 NSNumber，仅接受非布尔、整值且在 Int
    /// 安全域内的 id（shim 的 id 为单调计数器，POC 内不越界；WebKit 对整值
    /// JS 数字常以 int64 存储直通，> 2^53 的双精度路径会丢精度——如未来 id
    /// 源变为大整数，需按 CFNumber 存储类型重做严格解析）。
    private static func exactInt(from value: Any?) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let d = number.doubleValue
        guard d == d.rounded(),
              d >= -9_223_372_036_854_775_808.0,   // -2^63（Double(Int.min)，可精确表示）
              d < 9_223_372_036_854_775_808.0 else { return nil }  // 2^63 之上 Int 溢出
        return Int(truncating: number)
    }

    /// 桥接 payload（[String: Any] / [Any] / 基础类型 / NSNull）→ AnyCodable。
    ///
    /// 不做 AnyCodable case 的手工映射：case 布局（number 的存储类型等）属
    /// FrameCodec.swift（他人实现）的内部契约，本文件不修改它——payload 先
    /// 经 JSONSerialization 规范成 JSON，再用 JSONDecoder 按 AnyCodable 的
    /// Codable 契约解码（包装成单元素数组以兼容 JSONSerialization 顶层
    /// 片段限制）。若 FrameCodec 后续提供 init?(jsonObject:)/from(any:) 之类
    /// 便利构造，本函数是唯一替换点（调用方语义不变）。
    private static func anyCodablePayload(from raw: Any) -> AnyCodable? {
        do {
            let data = try JSONSerialization.data(withJSONObject: [raw])
            let boxed = try JSONDecoder().decode([AnyCodable].self, from: data)
            return boxed.first
        } catch {
            return nil
        }
    }

    /// AnyCodable → JS 值字面量（JSON 文本）：经公开契约 `var jsonObject: Any`
    /// 取规范对象后 JSON 序列化。jsonObject 若含 NaN/∞（如直接手工构造的
    /// AnyCodable），先经 isJSONSerializableValue 拒绝，避免 JSONSerialization
    /// 抛 NSException（try? 拦不住）；失败返回 nil（调用方降级为 null）。
    private static func jsPayloadLiteral(_ payload: AnyCodable?) -> String? {
        guard let payload else { return nil }
        let object = payload.jsonObject
        guard Self.isJSONSerializableValue(object) else { return nil }
        guard let data = try? JSONSerialization.data(withJSONObject: [object]),
              let text = String(data: data, encoding: .utf8) else { return nil }
        // 剥掉包装数组的首尾括号（data 形如 '[' + 载荷JSON + ']'，剥取即原
        // 载荷 JSON 文本——内层转义不受影响）。
        return String(text.dropFirst().dropLast())
    }

    /// 递归确认值可被 JSONSerialization 无异常序列化。桥接/原生值只可能是
    /// NSNull/String/NSNumber/NSArray/[String:Any] 或其 Swift 原生等价物；
    /// 其余类型一律 false（fail closed）。NSNumber 需额外检查有限性——
    /// JSONSerialization 对 NaN/±Infinity 抛 NSException（非 NSError），
    /// 任何 try? 序列化之前必须先过此扫描（见 didReceive ④ 注释）。
    private static func isJSONSerializableValue(_ value: Any) -> Bool {
        if value is NSNull || value is String { return true }
        if let number = value as? NSNumber {
            // JS 布尔桥接为 CFBoolean，属合法 JSON；非有限浮点拒绝。
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return true }
            return number.doubleValue.isFinite
        }
        if let array = value as? [Any] {
            return array.allSatisfy { isJSONSerializableValue($0) }
        }
        if let dictionary = value as? [String: Any] {
            return dictionary.values.allSatisfy { isJSONSerializableValue($0) }
        }
        return false
    }

    /// JS 字符串字面量：手工转义（JSON 转义集 ⊂ JS 字符串转义，控制字符
    /// \uXXXX），不依赖顶层片段序列化的可用性。
    private static func jsStringLiteral(_ string: String) -> String {
        var literal = "\""
        for scalar in string.unicodeScalars {
            switch scalar.value {
            case 0x22: literal += "\\\""
            case 0x5C: literal += "\\\\"
            case 0x08: literal += "\\b"
            case 0x09: literal += "\\t"
            case 0x0A: literal += "\\n"
            case 0x0C: literal += "\\f"
            case 0x0D: literal += "\\r"
            case 0x00...0x1F:
                literal += String(format: "\\u%04X", scalar.value)
            default:
                literal.unicodeScalars.append(scalar)
            }
        }
        literal += "\""
        return literal
    }
}
