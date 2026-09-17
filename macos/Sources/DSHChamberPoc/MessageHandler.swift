// MessageHandler.swift — A 桥 Swift 端消息处理器（传输层护栏 + invoke 上行 +
// 事件下行出口）
//
// W-04（A 桥雏形，design 25 §4.4.1）/ design 25
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
//     sidecar 的 notify 帧（node-edges sendNotify/rendererPush）→ B 桥
//     BridgeClient.onNotify → MainWindowController.notify 路由解包 →
//     evaluateJS 直写 __dshChamberEmit(event, payload) → web shim 订阅表派发
//     （通道名以 IPC_CHANNELS / 05 §7.4 为权威，manifest 8 push 通道）。
//     本 handler 不参与事件下行（W-04 双写纪律「乙」：事件唯一入口是
//     controller 的 notify 路由；原 emit/onEvent 降级面自 2026-12 审计 S14
//     删除——生产接线从未调用它）。event 帧族仅 W-05 桩 fixture
//     （poc-sidecar.ts / BridgeClientPocStubIntegrationTests）使用，壳内无消费面。
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
// 可测性（S15/S17）：WKScriptMessage 无公开构造器（WebKit 不能伪造
// frameInfo），didReceive 不可在单测驱动；四道护栏 + app_quitting 门收敛到
// 纯函数 fence(_:)（didReceive 只做输入取值与结果执行），origin/白名单/
// 拒绝/app_quitting 路径由 MessageHandlerTests 直接覆盖。

import Foundation
import WebKit

/// A 桥 Swift 端消息处理器：web →（护栏）→ onInvoke 上行；emit 供反向事件
/// 下行。仅传输层护栏，语义校验在 sidecar。
final class ChamberMessageHandler: NSObject, WKScriptMessageHandler {

    // MARK: - 构造参数（共享契约，MainWindowController 按此构造，勿改名）

    /// 方法白名单：MainWindowController 实传 BridgeManifest.invokeChannels
    /// （W-18 生成物，60 invoke 通道；design 25 §4.4.3），其余通道一律
    /// method_not_allowed。事件订阅面（8 push 通道）属 shim 侧 PUSH_EVENTS，
    /// 不经本白名单。
    private let whitelist: Set<String>

    /// 期望控制面 origin 的取回闭包：MainWindowController 在 sidecar ready
    /// 帧前返回 nil → 护栏对全部消息回 ipc_sender_forbidden（design 25
    /// §4.4.1 第 2 条「port 只在 ready 帧后放开」；渲染端按「10×50ms 有界
    /// 重试」自愈），ready / 重启落闸由 noteSidecarReady 驱动。
    private let expectedOrigin: () -> String?

    /// 退出清理是否已开始（S7）：镜像 renderer-trust.ts createTrustedIpc 的
    /// app_quitting 门——before-quit/will-quit teardown 开始后，late invoke
    /// 不得再向 shutdown 注入传输/运行时工作。
    private let isQuitting: () -> Bool

    /// invoke 上行回调（护栏全过后调用）：controller 在此转
    /// BridgeClient.invoke(method:payload:) → sidecar（语义校验在 sidecar）。
    private let onInvoke: (Int, String, AnyCodable?) -> Void

    /// 回写通道：controller 赋入（内部为 WKWebView.evaluateJavaScript，
    /// 主线程调用）。handler 只持闭包不持 webView（add 强持 handler，
    /// 反向强持 webView 会成环；闭包内捕获 controller/webView 应 weak）。
    var evaluateJavaScript: ((String) -> Void)?

    /// 原生通道令牌（S-06）：controller 注入 shim 时使用同一个值，护栏回执必须
    /// 带上它（shim 的 requireNativeToken 校验）。未赋值时拒绝回写并 loud——绝不下发
    /// 一个必然被 shim 抛错的无令牌调用。
    var nativeChannelToken: String?

    /// 最近一次已提交导航（didCommit）的顶层 URL：controller 在导航提交时
    /// 调 noteCommitted(url:) 更新。origin 判定以 message.webView?.url
    /// （实时）优先、此记录兜底（webView 缺省 / 进程终止 / 测试桩），
    /// 二选一实现并注释于 didReceive ②。
    var lastCommittedURL: String?

    // MARK: - 初始化

    init(whitelist: Set<String>,
         expectedOrigin: @escaping () -> String?,
         isQuitting: @escaping () -> Bool,
         onInvoke: @escaping (Int, String, AnyCodable?) -> Void) {
        self.whitelist = whitelist
        self.expectedOrigin = expectedOrigin
        self.isQuitting = isQuitting
        self.onInvoke = onInvoke
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
        // S17：判定全部收敛到纯函数 fence（WKScriptMessage 不可构造的替代
        // 接缝）；本回调只做输入取值（实时 URL 优先、noteCommitted 兜底——
        // 进程终止后/测试桩无 webView 时用后者）与结果执行。
        let decision = Self.fence(FenceInput(
            messageName: message.name,
            isMainFrame: message.frameInfo.isMainFrame,
            body: message.body,
            currentURL: message.webView?.url?.absoluteString ?? lastCommittedURL,
            expectedOrigin: expectedOrigin(),
            isQuitting: isQuitting(),
            whitelist: whitelist
        ))
        switch decision {
        case .accept(let id, let method, let payload):
            // 全过 → invoke 上行（controller → BridgeClient → sidecar；
            // 结果回写 __dshChamberResolve 属 controller/桥的职责，不在本文件）。
            onInvoke(id, method, payload)
        case .reject(let id, let code):
            // 仅当信封可解析出合法 id 时回执（否则无 Promise 可归因——静默
            // 丢弃，不向页面注入无法归因的 JS）。
            guard let id else { return }
            reject(id: id, code: code)
        case .drop:
            return
        }
    }

    // MARK: - 入站围栏（S17：didReceive 的纯逻辑接缝）

    /// 围栏输入（把判定与 WKScriptMessage 解耦）。
    struct FenceInput {
        var messageName: String
        var isMainFrame: Bool
        var body: Any
        var currentURL: String?
        var expectedOrigin: String?
        var isQuitting: Bool
        var whitelist: Set<String>
    }

    /// 围栏判定结果。
    enum FenceDecision: Equatable {
        /// 全过：controller 上行 invoke。
        case accept(id: Int, method: String, payload: AnyCodable?)
        /// 拒绝并回执（id == nil = 无法归因 → 调用方静默丢弃）。
        case reject(id: Int?, code: String)
        /// 非本通道 / 非主 frame：不是我们的信封，静默。
        case drop
    }

    /// 围栏流水线（纯函数，顺序与拒绝语义 = 原 didReceive）：
    ///   ① 通道名 + 主 frame（对应 Electron event.senderFrame ===
    ///      webContents.mainFrame，renderer-trust.ts 同族）；
    ///   ② origin 文档信任（ready 前 expectedOrigin == nil → 一律
    ///      ipc_sender_forbidden）；
    ///   ③ app_quitting 门（S7：镜像 renderer-trust.ts createTrustedIpc——
    ///      sender 校验后、handler 前；退出清理开始后 late invoke 不得再向
    ///      shutdown 注入传输/运行时工作）；
    ///   ④ 信封结构（[String: Any] + id 整值 + method 字符串）；
    ///   ⑤ 尺寸上限（≤4 MiB）：先做有限性/深度扫描再 JSON 序列化——
    ///      JSONSerialization 遇 NaN/±Infinity 抛 NSException（try? 拦不住），
    ///      必须先判可序列化；
    ///   ⑥ 方法白名单；⑦ payload → AnyCodable（失败 = 信封不合法）。
    static func fence(_ input: FenceInput) -> FenceDecision {
        guard input.messageName == "dshChamber", input.isMainFrame else { return .drop }
        let envelope = input.body as? [String: Any]
        let addressableID = envelope.flatMap { Self.exactInt(from: $0["id"]) }
        guard let expected = input.expectedOrigin else {
            // 就绪门与信任拒绝分开编码（2026-12 双端逐函数核对 S1·F3）：sidecar
            // 尚未 ready / 重启落闸期间 expectedOrigin 恒 nil，此时回
            // ipc_not_ready，渲染端可据此重试；把「未就绪」混进永久性的
            // sender-forbidden 会让一次失败被当成不可恢复（update-store 曾因此
            // 整会话 latch）。
            // 排序是**有意**的（2026-12 审查）：expectedOrigin 为 nil 时没有可比较
            // 的可信 origin，无法先做信任判定；此分支只在「sidecar 未就绪」这个
            // 短暂窗口成立，且它不授予任何能力（只是可重试状态码）——M5 起 shim
            // 也只在 info 成功后暴露公开面，正常启动序不会走到这里。
            return .reject(id: addressableID, code: Self.codeNotReady)
        }
        guard TrustGuard.isTrustedDocument(input.currentURL, expectedOrigin: expected) else {
            return .reject(id: addressableID, code: Self.codeSenderForbidden)
        }
        if input.isQuitting {
            return .reject(id: addressableID, code: Self.codeAppQuitting)
        }
        guard let envelope, let id = addressableID, let method = envelope["method"] as? String else {
            return .reject(id: addressableID, code: Self.codeMalformedEnvelope)
        }
        guard Self.isJSONSerializableValue(envelope) else {
            return .reject(id: id, code: Self.codeMalformedEnvelope)
        }
        guard let envelopeData = try? JSONSerialization.data(withJSONObject: envelope) else {
            return .reject(id: id, code: Self.codeMalformedEnvelope)
        }
        guard TrustGuard.envelopeSizeOK(String(decoding: envelopeData, as: UTF8.self)) else {
            return .reject(id: id, code: Self.codeFrameTooLarge)
        }
        guard TrustGuard.isAllowedMethod(method, whitelist: input.whitelist) else {
            return .reject(id: id, code: Self.codeMethodNotAllowed)
        }
        let payload: AnyCodable?
        if let rawPayload = envelope["payload"] {
            guard let converted = Self.anyCodablePayload(from: rawPayload) else {
                return .reject(id: id, code: Self.codeMalformedEnvelope)
            }
            payload = converted
        } else {
            payload = nil
        }
        return .accept(id: id, method: method, payload: payload)
    }

    // MARK: - 回执与私有工具

    /// 错误码（A 桥版，与 renderer-trust / design 25 §4.4.1 拒绝语义同族：
    /// Electron 侧为 { code: 'ipc_sender_forbidden' } 等，web 侧 shim 据码
    /// reject Promise，UI 按既有错误投影呈现——loud，绝不静默吞错）。
    static let codeSenderForbidden = "ipc_sender_forbidden"   // origin / 主 frame 信任失败
    /// 就绪门（S1·F3）：expectedOrigin 为 nil（sidecar 未 ready / 重启落闸）。
    /// 与信任拒绝分开编码——渲染端可安全重试，不是「这个发送方永远非法」。
    static let codeNotReady = "ipc_not_ready"
    static let codeMethodNotAllowed = "method_not_allowed"    // method ∉ 白名单
    static let codeFrameTooLarge = "frame_too_large"          // 信封 > 4 MiB
    static let codeMalformedEnvelope = "malformed_envelope"   // 结构/JSON 表示不合法
    /// 退出清理已开始（S7）：与 renderer-trust.ts createTrustedIpc 的
    /// error.code = 'app_quitting'（Error('app is quitting')）同码同语义；
    /// A 桥回执通道只传错误码字符串（与 ipc_sender_forbidden 同款编码）。
    static let codeAppQuitting = "app_quitting"

    /// 护栏不过 → 经 evaluateJavaScript 回 `__dshChamberResolve(id, null, 码)`。
    private func reject(id: Int, code: String) {
        guard let token = nativeChannelToken else {
            shellLog("[native] 原生通道令牌未注入，无法回执 \(code)（S-06）")
            return
        }
        evaluateJavaScript?("__dshChamberResolve(\(Self.jsStringLiteral(token)), \(id), null, "
            + "\(Self.jsStringLiteral(code)));")
    }

    /// 整值字段校验：JS 数字桥接为 NSNumber，仅接受非布尔、整值且在 Int
    /// 安全域内的 id（shim 的 id 为单调计数器，POC 内不越界；WebKit 对整值
    /// JS 数字常以 int64 存储直通，> 2^53 的双精度路径会丢精度——如未来 id
    /// 源变为大整数，需按 CFNumber 存储类型重做严格解析）。
    static func exactInt(from value: Any?) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        // 整型存储的 NSNumber（WebKit 对整值 JS 数字常走 int64 直通）：
        // 直接取 int64——原实现统一走 double，会把 Int.max 判成 2^63 而误拒
        // （2026-09 模块评审补测发现）。
        if !CFNumberIsFloatType(number) {
            return Int(number.int64Value)
        }
        // 浮点存储：只接受整值且在 2^53 内（JS Number 的精确整数域）。
        let d = number.doubleValue
        guard d.isFinite, d == d.rounded(), abs(d) <= 9_007_199_254_740_992.0 else { return nil }
        return Int(d)
    }

    /// 桥接 payload（[String: Any] / [Any] / 基础类型 / NSNull）→ AnyCodable。
    ///
    /// 不做 AnyCodable case 的手工映射：case 布局（number 的存储类型等）属
    /// FrameCodec.swift（他人实现）的内部契约，本文件不修改它——payload 先
    /// 经 JSONSerialization 规范成 JSON，再用 JSONDecoder 按 AnyCodable 的
    /// Codable 契约解码（包装成单元素数组以兼容 JSONSerialization 顶层
    /// 片段限制）。若 FrameCodec 后续提供 init?(jsonObject:)/from(any:) 之类
    /// 便利构造，本函数是唯一替换点（调用方语义不变）。
    static func anyCodablePayload(from raw: Any) -> AnyCodable? {
        // 预扫描：JSONSerialization 对 Date/NaN 等非法值抛的是 NSException
        // （Swift 无法 catch，直接崩进程）——任何序列化之前必须先判可序列化
        // （2026-09 模块评审补测发现：原实现只在 didReceive ④ 前置扫描，
        // 直调本函数会崩）。
        guard Self.isJSONSerializableValue(raw) else { return nil }
        do {
            let data = try JSONSerialization.data(withJSONObject: [raw])
            let boxed = try JSONDecoder().decode([AnyCodable].self, from: data)
            return boxed.first
        } catch {
            return nil
        }
    }

    /// JSON 嵌套深度上限：防受信页面构造 <4MiB 的极深嵌套信封在预扫描阶段
    /// 击穿 Swift 栈（静态审查 #4；超限按 malformed_envelope 拒绝）。
    static let maxJSONDepth = 512

    /// 递归确认值可被 JSONSerialization 无异常序列化。桥接/原生值只可能是
    /// NSNull/String/NSNumber/NSArray/[String:Any] 或其 Swift 原生等价物；
    /// 其余类型一律 false（fail closed）。NSNumber 需额外检查有限性——
    /// JSONSerialization 对 NaN/±Infinity 抛 NSException（非 NSError），
    /// 任何 try? 序列化之前必须先过此扫描（见 fence ⑤ 注释）。
    static func isJSONSerializableValue(_ value: Any, depth: Int = 0) -> Bool {
        if depth > maxJSONDepth { return false }
        if value is NSNull || value is String { return true }
        if let number = value as? NSNumber {
            // JS 布尔桥接为 CFBoolean，属合法 JSON；非有限浮点拒绝。
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return true }
            return number.doubleValue.isFinite
        }
        if let array = value as? [Any] {
            return array.allSatisfy { isJSONSerializableValue($0, depth: depth + 1) }
        }
        if let dictionary = value as? [String: Any] {
            return dictionary.values.allSatisfy { isJSONSerializableValue($0, depth: depth + 1) }
        }
        return false
    }

    /// JS 字符串字面量：手工转义（JSON 转义集 ⊂ JS 字符串转义，控制字符
    /// \uXXXX），不依赖顶层片段序列化的可用性。
    static func jsStringLiteral(_ string: String) -> String {
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
            case 0x00...0x1F, 0x2028, 0x2029:
                literal += String(format: "\\u%04X", scalar.value)
            default:
                literal.unicodeScalars.append(scalar)
            }
        }
        literal += "\""
        return literal
    }
}
