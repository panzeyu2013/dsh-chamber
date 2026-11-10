//
//  BrowserIPC.swift — 右栏浏览器 v3 的 Swift-only `browser` 桥面（design 28 v3 §3/§7）
//
//  通道名是本文件常量（Swift 侧单源）；**生成物单源是 E1**：bridge-swift-only-additions.json
//  的登记 + bridge-manifest.json/BridgeManifest.swift/bridge-shim.js 的重生成由 E1 负责，
//  两边名字必须逐字一致（本文件即 E4 对 E1 的契约输入）：
//    invoke（6）：acquire/release/navigate/command/frame/keymap
//    push  （4）：state/openRequested/input/forward-needed
//  故 A 桥计数 64 invoke、13 push、合计 77 通道（design 28 §3 单源）。
//
//  router 只做「解码 → registry 调用 → 编码回执」；护栏（主帧/壳文档/尺寸/白名单/quoting）
//  由既有 ChamberMessageHandler.fence 完成。
//

import Foundation

/// `browser` 命名空间的通道名与载荷编解码。
enum BrowserIPCChannel {
    static let acquire = "dsh-chamber:browser-acquire"
    static let release = "dsh-chamber:browser-release"
    static let navigate = "dsh-chamber:browser-navigate"
    static let command = "dsh-chamber:browser-command"
    static let frame = "dsh-chamber:browser-frame"
    static let keymap = "dsh-chamber:browser-keymap"
    static let state = "dsh-chamber:browser-state"
    static let openRequested = "dsh-chamber:browser-open-requested"
    static let input = "dsh-chamber:browser-input"
    static let forwardNeeded = "dsh-chamber:browser-forward-needed"

    /// invoke 白名单集合（E1 生成 manifest 时必须与 BridgeManifest.invokeChannels 取并集）。
    static let invokeChannels: Set<String> = [acquire, release, navigate, command, frame, keymap]
    /// push 集合（E1 同批并入 push 面）。
    static let pushChannels: Set<String> = [state, openRequested, input, forwardNeeded]
}

/// 载荷编解码（AnyCodable 单源；解码失败 = invalid payload，一律 fail-closed）。
enum BrowserIPCPayload {
    static func object(_ value: AnyCodable?) -> [String: AnyCodable]? {
        guard case .object(let fields) = value else { return nil }
        return fields
    }

    static func string(_ value: AnyCodable?) -> String? {
        guard case .string(let text) = value else { return nil }
        return text
    }

    static func bool(_ value: AnyCodable?) -> Bool? {
        guard case .bool(let flag) = value else { return nil }
        return flag
    }

    /// 推送字段截断（m2：按 **UTF-16 code unit** 计数，与 renderer 侧 JS String.length
    /// 的上限判定一致；按 Character 计数时 astral/组合字符会让 JS length 超限、整条
    /// state push 被 renderer 丢弃）。截断点不劈开代理对 ⇒ 结果 utf16.count ≤ limit。
    static func truncated(_ text: String, limit: Int) -> String {
        guard limit > 0, text.utf16.count > limit else { return text }
        var result = ""
        var used = 0
        for character in text {
            let units = character.utf16.count
            if used + units > limit { break }
            result.append(character)
            used += units
        }
        return result
    }

    static func double(_ value: AnyCodable?) -> Double? {
        guard case .number(let number) = value else { return nil }
        return number
    }

    /// 严格整数（D16 收敛：forward record 的 localPort 必须是整数，绝不能把
    /// 51234.9 截断成 51234 后当作合法端口）。
    static func int(_ value: AnyCodable?) -> Int? {
        guard let number = double(value), number.isFinite,
              number == number.rounded(), abs(number) <= 9_007_199_254_740_992 else { return nil }
        return Int(number)
    }

    /// frame 对象：{x,y,width,height}，全部有限且非负宽高。
    static func frame(_ value: AnyCodable?) -> BrowserGuestFrame? {
        guard let fields = object(value),
              let x = double(fields["x"]), let y = double(fields["y"]),
              let width = double(fields["width"]), let height = double(fields["height"]),
              x.isFinite, y.isFinite, width.isFinite, height.isFinite,
              width >= 0, height >= 0, width <= 32_768, height <= 32_768 else { return nil }
        return BrowserGuestFrame(x: CGFloat(x), y: CGFloat(y),
                                 width: CGFloat(width), height: CGFloat(height))
    }

    /// acquire 载荷：{tabId, sessionId, sourceId, sourceFingerprint, workspaceKey, frame, visible, occluded}
    static func acquireRequest(_ value: AnyCodable?) -> BrowserGuestAcquireRequest? {
        guard let fields = object(value),
              let tabId = string(fields["tabId"]), !tabId.isEmpty,
              let sessionId = string(fields["sessionId"]), !sessionId.isEmpty,
              let sourceId = string(fields["sourceId"]), !sourceId.isEmpty,
              let fingerprint = string(fields["sourceFingerprint"]), !fingerprint.isEmpty,
              let workspaceKey = string(fields["workspaceKey"]), !workspaceKey.isEmpty,
              workspaceKey.count <= 4096,
              let frame = frame(fields["frame"]),
              let visible = bool(fields["visible"] ?? .bool(true)),
              let occluded = bool(fields["occluded"] ?? .bool(false)) else { return nil }
        return BrowserGuestAcquireRequest(tabId: tabId, sessionId: sessionId,
                                          sourceId: sourceId, sourceFingerprint: fingerprint,
                                          workspaceKey: workspaceKey, frame: frame,
                                          visible: visible, occluded: occluded)
    }

    /// navigate 载荷：{target:{kind:"direct",url}|{kind:"forward",recordId,path|url}}
    static func navigateTarget(_ value: AnyCodable?) -> BrowserGuestTarget? {
        guard let fields = object(value), let kind = string(fields["kind"]) else { return nil }
        switch kind {
        case "direct":
            guard let raw = string(fields["url"]), let url = URL(string: raw),
                  let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
                  url.host != nil, !BrowserGuestPolicy.carriesCredentials(url) else { return nil }
            return .direct(url)
        case "forward":
            // P0（FW1）：renderer 只发 {recordId, path}；URL 由 main 用 forward record 合成。
            // 这里**不接受**任何 url 字段（旧契约已退役；多给 url 视为非法载荷）。
            guard let recordId = string(fields["recordId"]), (1...128).contains(recordId.count),
                  fields["url"] == nil,
                  let path = BrowserGuestForwardTarget.normalizePath(string(fields["path"])) else { return nil }
            return .forward(recordId: recordId, path: path)
        default:
            return nil
        }
    }

    /// keymap 载荷：{tabId, lease, combos:[{code,primary,alt,shift,control}]}。
    /// lease 必填（P1：keymap 越租——必须能对回该 document 的租约）；combos ≤256，code 形态受限。
    static func keymap(_ value: AnyCodable?) -> (tabId: String, lease: String, combos: [BrowserKeyboardCombo])? {
        guard let fields = object(value), let tabId = string(fields["tabId"]), !tabId.isEmpty,
              let lease = string(fields["lease"]), !lease.isEmpty,
              case .array(let raw) = fields["combos"], raw.count <= 256 else { return nil }
        var combos: [BrowserKeyboardCombo] = []
        for item in raw {
            guard let entry = object(item), let code = string(entry["code"]), isValidComboCode(code) else { return nil }
            combos.append(BrowserKeyboardCombo(code: code,
                                               primary: bool(entry["primary"] ?? .bool(false)) ?? false,
                                               alt: bool(entry["alt"] ?? .bool(false)) ?? false,
                                               shift: bool(entry["shift"] ?? .bool(false)) ?? false,
                                               control: bool(entry["control"] ?? .bool(false)) ?? false))
        }
        return (tabId, lease, combos)
    }

    /// 组合键 code 形态：DOM KeyboardEvent.code 白名单形状（字母命名或 KeyX/DigitN/Fn/Arrow…），
    /// 长度 ≤64、仅 ASCII 字母数字，杜绝注入/超长表。
    static func isValidComboCode(_ code: String) -> Bool {
        guard (1...64).contains(code.count) else { return false }
        return code.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) }
    }

    /// 成功回执。
    static func ok(_ extra: [String: AnyCodable] = [:]) -> AnyCodable {
        .object(["ok": .bool(true)].merging(extra) { _, new in new })
    }

    /// browser-state 推送载荷（地址恒 observed，无 unknown 态）。
    static func statePayload(_ state: BrowserGuestStatePayload) -> AnyCodable {
        var fields: [String: AnyCodable] = [
            "tabId": .string(state.tabId),
            "lease": .string(state.lease),
            "address": .string("observed"),
            "canGoBack": .bool(state.canGoBack),
            "canGoForward": .bool(state.canGoForward),
            "loading": .bool(state.loading)
        ]
        // INC-02/R-08：nil 不发 .null（renderer 侧 url/title 是可缺省字段，.null 会破坏
        // 「地址恒 observed」的字符串契约）——省略键。
        // 状态 push 的长度上限（远端页面可让 url/title 任意长）：url ≤4096、title ≤512。
        if let url = state.url { fields["url"] = .string(truncated(url, limit: 4096)) }
        if let title = state.title { fields["title"] = .string(truncated(title, limit: 512)) }
        if let error = state.error {
            fields["error"] = .object(["code": .number(Double(error.code)),
                                       "description": .string(error.description)])
        } else {
            fields["error"] = .null
        }
        return .object(fields)
    }

    /// browser-input 推送载荷（V3-C P0/P1：design 28:89 的 modifiers 是**字符串数组**，
    /// 不是 5 个布尔——renderer BrowserBridge.ts 消费 modifiers: string[]）。
    /// 映射：primary → "meta"（⌘）；alt → "alt"；shift → "shift"；control → "control"
    /// （INC-01/RT-02：canonical 修饰名不是 "ctrl"）。repeat 作为可选额外键保留。
    /// D12：lease 可选（Swift 发放的活动租约）；renderer 用 lease 精确定位该 tab 的
    /// 占位元素（旧 shim/无租约时省略键，renderer 回退按 tabId 查找）。
    static func inputPayload(tabId: String, lease: String?, stroke: BrowserKeyStroke) -> AnyCodable {
        var modifiers: [AnyCodable] = []
        if stroke.primary { modifiers.append(.string("meta")) }
        if stroke.alt { modifiers.append(.string("alt")) }
        if stroke.shift { modifiers.append(.string("shift")) }
        if stroke.control { modifiers.append(.string("control")) }
        var fields: [String: AnyCodable] = ["tabId": .string(tabId),
                                            "code": .string(stroke.code),
                                            "modifiers": .array(modifiers),
                                            "repeat": .bool(stroke.isRepeat)]
        if let lease, !lease.isEmpty { fields["lease"] = .string(lease) }
        return .object(fields)
    }

    /// browser-forward-needed 推送载荷（main 在 guest 内主 frame 命中 loopback 时请求 renderer 走 forward 面）。
    static func forwardNeededPayload(tabId: String, lease: String, url: String) -> AnyCodable {
        .object(["tabId": .string(tabId), "lease": .string(lease), "url": .string(url)])
    }

    /// browser-open-requested 推送载荷。
    /// RT-11：载荷加 lease（契约增量，docs 批同步 design 28 §3）。
    static func openRequestedPayload(tabId: String, lease: String, url: String) -> AnyCodable {
        .object(["tabId": .string(tabId), "lease": .string(lease), "url": .string(url)])
    }
}

// MARK: - router（A 桥 invoke 的 Swift 侧分派）

/// browser invoke 的失败类型（A 桥错误串的唯一来源）。协议内失败沿用
/// BrowserGuestFailure 的既有错误码；白名单外/未知 method 保留 method_not_allowed
/// 语义（与 MessageHandler 的拒绝码逐字一致、shim 侧 ERROR_TEXT_BY_CODE 已知码）。
enum BrowserIPCDispatchError: Error, Equatable {
    case protocolFailure(BrowserGuestFailure)
    case methodNotAllowed

    /// renderer 收到的错误串（shim errorFromRejection 按已知码投影文案）。
    var code: String {
        switch self {
        case .protocolFailure(let failure): return failure.rawValue
        case .methodNotAllowed: return "method_not_allowed"
        }
    }
}

/// `browser` 命名空间的 registrar：只做「解码 → registry → 编码回执」。
/// 护栏（主帧/壳文档/尺寸/白名单/quitting）由 ChamberMessageHandler.fence 已完成，
/// 本 router 额外承担「lease 归属 + URL 复核」的失败即拒绝（design 28:69 信任规则）。
@MainActor
final class BrowserIPCRouter {
    private let registry: BrowserGuestRegistry
    private let keyboard: KeyboardBridge
    private let pageZoom: () -> CGFloat

    init(registry: BrowserGuestRegistry, keyboard: KeyboardBridge, pageZoom: @escaping () -> CGFloat) {
        self.registry = registry
        self.keyboard = keyboard
        self.pageZoom = pageZoom
    }

    /// 是否由本 router 处理（E1 的 manifest 白名单必须含同一集合）。
    func handles(_ method: String) -> Bool {
        BrowserIPCChannel.invokeChannels.contains(method)
    }

    /// 分派一次 invoke；失败返回类型化错误（renderer reject Promise；code 转 A 桥错误串）。
    func dispatch(method: String, payload: AnyCodable?, documentId: String) async -> Result<AnyCodable, BrowserIPCDispatchError> {
        switch method {
        case BrowserIPCChannel.acquire:
            guard let request = BrowserIPCPayload.acquireRequest(payload) else {
                return .failure(.protocolFailure(.invalidPayload))
            }
            switch await registry.acquire(request, documentId: documentId) {
            case .success(let lease): return .success(BrowserIPCPayload.ok(["lease": .string(lease)]))
            case .failure(let failure): return .failure(.protocolFailure(failure))
            }
        case BrowserIPCChannel.release:
            guard let fields = BrowserIPCPayload.object(payload),
                  let tabId = BrowserIPCPayload.string(fields["tabId"]),
                  let lease = BrowserIPCPayload.string(fields["lease"]) else {
                return .failure(.protocolFailure(.invalidPayload))
            }
            switch registry.release(tabId: tabId, lease: lease, documentId: documentId) {
            case .success: return .success(BrowserIPCPayload.ok())
            case .failure(let failure): return .failure(.protocolFailure(failure))
            }
        case BrowserIPCChannel.navigate:
            guard let fields = BrowserIPCPayload.object(payload),
                  let tabId = BrowserIPCPayload.string(fields["tabId"]),
                  let lease = BrowserIPCPayload.string(fields["lease"]),
                  let target = BrowserIPCPayload.navigateTarget(fields["target"]) else {
                return .failure(.protocolFailure(.invalidPayload))
            }
            switch await registry.navigate(tabId: tabId, lease: lease, documentId: documentId,
                                           target: target) {
            case .success: return .success(BrowserIPCPayload.ok())
            case .failure(let failure): return .failure(.protocolFailure(failure))
            }
        case BrowserIPCChannel.command:
            guard let fields = BrowserIPCPayload.object(payload),
                  let tabId = BrowserIPCPayload.string(fields["tabId"]),
                  let lease = BrowserIPCPayload.string(fields["lease"]),
                  let raw = BrowserIPCPayload.string(fields["command"]),
                  let command = BrowserGuestCommand(rawValue: raw) else {
                return .failure(.protocolFailure(.invalidPayload))
            }
            switch registry.command(tabId: tabId, lease: lease, documentId: documentId, command: command) {
            case .success: return .success(BrowserIPCPayload.ok())
            case .failure(let failure): return .failure(.protocolFailure(failure))
            }
        case BrowserIPCChannel.frame:
            guard let fields = BrowserIPCPayload.object(payload),
                  let tabId = BrowserIPCPayload.string(fields["tabId"]),
                  let lease = BrowserIPCPayload.string(fields["lease"]) else {
                return .failure(.protocolFailure(.invalidPayload))
            }
            // 键存在但值非法 → invalidPayload（不得静默当作缺省轴——那会把坏载荷
            // 当成「未更新」，掩盖 renderer 契约漂移；缺键才是可选轴）。
            let frame: BrowserGuestFrame?
            if let rawFrame = fields["frame"] {
                guard let decoded = BrowserIPCPayload.frame(rawFrame) else {
                    return .failure(.protocolFailure(.invalidPayload))
                }
                frame = decoded
            } else {
                frame = nil
            }
            let visible: Bool?
            if let rawVisible = fields["visible"] {
                guard let decoded = BrowserIPCPayload.bool(rawVisible) else {
                    return .failure(.protocolFailure(.invalidPayload))
                }
                visible = decoded
            } else {
                visible = nil
            }
            let occluded: Bool?
            if let rawOccluded = fields["occluded"] {
                guard let decoded = BrowserIPCPayload.bool(rawOccluded) else {
                    return .failure(.protocolFailure(.invalidPayload))
                }
                occluded = decoded
            } else {
                occluded = nil
            }
            switch registry.frame(tabId: tabId, lease: lease, documentId: documentId, frame: frame,
                                  pageZoom: pageZoom(), visible: visible, occluded: occluded) {
            case .success: return .success(BrowserIPCPayload.ok())
            case .failure(let failure): return .failure(.protocolFailure(failure))
            }
        case BrowserIPCChannel.keymap:
            guard let decoded = BrowserIPCPayload.keymap(payload) else {
                return .failure(.protocolFailure(.invalidPayload))
            }
            // FW1 ②：keymap 越租必须拒绝（lease 对回本 document + tab）。
            switch registry.authorizeKeymap(tabId: decoded.tabId, lease: decoded.lease,
                                            documentId: documentId) {
            case .failure(let failure):
                shellLog("[shell][browser-guest] keymap 拒绝（越租）tab=\(decoded.tabId) lease=\(decoded.lease)")
                return .failure(.protocolFailure(failure))
            case .success:
                keyboard.setKeymap(tabId: decoded.tabId, combos: decoded.combos)
                return .success(BrowserIPCPayload.ok())
            }
        default:
            return .failure(.methodNotAllowed)
        }
    }
}

