// FrameCodec.swift —— B 桥 NDJSON 帧的编解码（纯函数，可 XCTest 直测）
//
// design 25 §4.4.2（B 桥 Swift ↔ sidecar，本机受信 stdio 通道）与 W-05
// （垂直切片，design 25 §4.4.2）。协议与 sidecar
// 服务端（packages/desktop/sidecar-entry.ts；W-05 桩 sidecar-stub.ts 同帧族，
// 保留为集成测试 fixture）逐字段一致，**字段名勿自行更改**：
//
//   请求   {"id":<Int>, "method":"<string>", "payload":<json|null>}
//   响应   {"id":<Int>, "ok":true,  "result":<json>}
//          {"id":<Int>, "ok":false, "error":"<string>"}
//   事件   {"event":"<string>", "payload":<json|null>}
//
// 传输纪律（design 25 §4.4.2 / D2）：
//   - stdout 是唯一协议流：每帧一行、以 \n 结尾、UTF-8；sidecar 的
//     console.* 已被其入口重定向到 stderr（D2），Swift 侧对 stdout 只做帧
//     处理，解析失败/超长行 = 重定向后仍泄漏的协议违约 → 打印并丢弃
//     （fail-loud，绝不静默继续；见 BridgeClient）。
//   - 单帧上限 4 MiB：`maxFrameBytes` 与 A 桥护栏 TrustGuard.maxMessageBytes
//     同值同源（design 25 §4.4.1 ③「信封结构/尺寸上限（≤4 MiB）」/ §4.4.2
//     「帧长上限」）——本文件自带同值常量而不 import TrustGuard，避免
//     B 桥编解码反向耦合 A 桥文件；两处若需调值必须同步。
//   - id 单调纪律由 BridgeClient 保证（Swift 是客户端、sidecar 是服务端，
//     design 25 §3.1：请求必带自增 id，sidecar 原样 echo；事件帧无 id、
//     sidecar 在 POC 期不发起请求）。本文件只保证“响应必须可配对上 id”。
//   - 帧内 method/event 字符串不校验：语义校验在 sidecar（60 invoke 处理器
//     原样），方法白名单在 A 桥（MessageHandler/TrustGuard，B12），B 桥只做
//     结构解码与尺寸护栏（design 25 §4.4.2 护栏条）。
//   - 容忍度：payload 键缺省与显式 null 一律折叠为 nil（协议两侧同语义）；
//     多余未知键忽略（前瞻兼容 edge:* 等演进）；缺 id / 结构非法 → nil
//     （调用方 loud）。
//
// 纯 Foundation + AnyCodable（无 AppKit/WebKit）；Swift 5 语言模式；macOS 14.4+（支持矩阵下限，见 deviations S-30）。

import Foundation

/// B 桥帧的三元形状（与 sidecar-entry.ts / sidecar-stub.ts 的
/// OutboundFrame/RequestFrame 对应）。
public enum BridgeFrame: Equatable {
    /// Swift → sidecar 的请求（id 单调，由 BridgeClient 分配）。
    case request(id: Int, method: String, payload: AnyCodable?)
    /// sidecar → Swift 的响应（ok=false 时 error 带文案；ok=true 时 result 可
    /// 为 null——本类型里 result 为 nil 即 JSON null 或缺省，容忍两者）。
    case response(id: Int, ok: Bool, result: AnyCodable?, error: String?)
    /// sidecar → Swift 的推送事件（无 id）。
    case event(event: String, payload: AnyCodable?)
}

/// NDJSON 帧编解码：全 static 纯函数，无共享可变状态（线程安全、可测性优先）。
public enum FrameCodec {

    /// 单帧（行）上限：4 MiB。与 TrustGuard.maxMessageBytes 同值同源
    /// （design 25 §4.4.1 ③/§4.4.2；TrustGuard.swift:32）——本文件自带常量，
    /// 不 import TrustGuard 以免 A 桥 → B 桥文件耦合；两处调值必须同步。
    public static let maxFrameBytes = 4 * 1024 * 1024

    // MARK: - 信封（仅 encode 使用；decode 走 classify 的类型判定，字段名以本结构为线格式权威）

    /// 单帧线格式（全部字段可选：解码容忍缺省，编码按帧族只写应写字段）。
    /// 注意 Codable 合成编码对 nil 可选字段自动省略（encodeIfPresent 语义），
    /// 因此显式 null 载荷在组帧时以 `payload ?? .null` 填充（见 encode）。
    private struct Envelope: Codable {
        var id: Int?
        var method: String?
        var payload: AnyCodable?
        var ok: Bool?
        var result: AnyCodable?
        var error: String?
        var event: String?

        init(id: Int? = nil,
             method: String? = nil,
             payload: AnyCodable? = nil,
             ok: Bool? = nil,
             result: AnyCodable? = nil,
             error: String? = nil,
             event: String? = nil) {
            self.id = id
            self.method = method
            self.payload = payload
            self.ok = ok
            self.result = result
            self.error = error
            self.event = event
        }
    }

    // MARK: - 编码（帧 → 一行 JSON + "\n"）

    /// 把帧编码为一行的字节（JSON + "\n"，UTF-8）。超限抛
    /// FrameCodecError.frameTooLarge；ok=false 但 error 为 nil（无法构成合法
    /// 响应帧）抛 FrameCodecError.responseMissingErrorMessage。
    public static func encode(_ frame: BridgeFrame) throws -> Data {
        let envelope: Envelope
        switch frame {
        case .request(let id, let method, let payload):
            envelope = Envelope(id: id, method: method, payload: payload ?? .null)
        case .response(let id, let ok, let result, let error):
            guard ok || error != nil else {
                throw FrameCodecError.responseMissingErrorMessage(id: id)
            }
            // ok=true 时 result 键恒写（nil 载荷 → JSON null）；ok=false 只写
            // error 键；ok=true 却带 error 的混写帧按“result 优先”收敛。
            envelope = ok
                ? Envelope(id: id, ok: true, result: result ?? .null)
                : Envelope(id: id, ok: false, error: error)
        case .event(let event, let payload):
            envelope = Envelope(payload: payload ?? .null, event: event)
        }
        var data = try JSONEncoder().encode(envelope)
        guard data.count <= maxFrameBytes else {
            throw FrameCodecError.frameTooLarge(byteCount: data.count)
        }
        // 帧以 \n 结尾（行协议；UTF-8 编码下字节数 = data.count 已含校验）。
        data.append(0x0A)
        return data
    }

    // MARK: - 解码（一行 → 帧）

    /// 一行 → 帧。容忍 null payload / 缺省字段 / 未知多余键；缺 id 或结构
    /// 非法返回 nil（不抛错——调用方负责 loud 打印并丢弃，见 BridgeClient）。
    ///
    /// Phase 1 C3：本函数与 BridgeClient 的入站单次解析路径共用 `classify`，
    /// 严格性契约集中在那一处（避免两条分类路径漂移）。
    public static func decodeLine(_ line: String) -> BridgeFrame? {
        // 防御性兜底：超长行由调用方先行判定并 loud（通常到不了这里）；
        // 此处再挡一次，避免把 4 MiB+ 字符串喂给解码器。
        guard !isLineTooLong(line),
              let data = line.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return nil
        }
        return classify(jsonObject: object)
    }

    /// 已解析顶层 JSON 对象 → 帧（唯一分类器；BridgeClient 每行只解析一次后
    /// 直接调用本函数，edge/notify 两族的分类只在 classify 归 nil 后接手）。
    ///
    /// 分类规则（确定性，防歧义帧摇摆）：
    ///   - 带 id + method → .request（method 型帧不校验字符串内容，见文件头）；
    ///   - 带 id + ok（Bool）→ .response；ok=false 时 error 缺省 → nil（容忍，
    ///     由调用方给兜底文案）；
    ///   - 带 id 却无 method/ok → nil（不是任何已知帧族）；
    ///   - 无 id + event → .event；event 与 id 同现（协议外混写）按 id 族优先，
    ///     解析不到合法 id 族即 nil；
    ///   - 其余（空行/纯文本/数组顶层等）→ nil。
    ///
    /// 严格性（与旧 JSONDecoder Envelope 解码逐条对齐，FrameCodecTests 钉住）：
    ///   1. 已知键**存在但类型不符** → 整行 nil——绝不忽略该键继续分类，否则
    ///      `{"id":1,"method":5,"ok":true}` 会从"非法行"变成合法 response 窃取
    ///      pending；显式 null 与键缺省同义（可选字段折叠为 nil）；
    ///   2. id 仅接受非布尔 NSNumber：非浮点存储走无损 Int64 桥接（域外无符号
    ///      大整数 → nil）；浮点存储要求精确可表示且排除 -2^63 边界（JSON 数字
    ///      已被 JSONSerialization 归一成 Double、原始 token 不可得——与旧
    ///      JSONDecoder 的极值边界差异见 intValue 注释，已用测试钉住；**不是**
    ///      MessageHandler.exactInt 的 2^53 上限）；
    ///   3. ok 仅接受 CFBoolean（`NSNumber(1) as? Bool == true` 是已知陷阱）。
    static func classify(jsonObject: [String: Any]) -> BridgeFrame? {
        let id = field(jsonObject, "id", intValue)
        let method = field(jsonObject, "method", stringValue)
        let ok = field(jsonObject, "ok", boolValue)
        let event = field(jsonObject, "event", stringValue)
        let error = field(jsonObject, "error", stringValue)
        let payload = field(jsonObject, "payload") { AnyCodable.fromJSONObject($0) }
        let result = field(jsonObject, "result") { AnyCodable.fromJSONObject($0) }

        // 1. 任何已知键的类型不符都毒化整行（与 JSONDecoder 抛错等价）。
        if id.isWrongType || method.isWrongType || ok.isWrongType || event.isWrongType
            || error.isWrongType || payload.isWrongType || result.isWrongType {
            return nil
        }
        if let id = id.value {
            if let method = method.value {
                return .request(id: id, method: method, payload: payload.value)
            }
            if let ok = ok.value {
                return .response(id: id, ok: ok, result: result.value, error: error.value)
            }
            return nil
        }
        if let event = event.value {
            return .event(event: event, payload: payload.value)
        }
        return nil
    }

    /// 三态字段取值：缺省/显式 null → 无值；类型正确 → 值；类型不符 → 违约。
    private enum JSONField<Value> {
        case empty
        case value(Value)
        case wrongType

        var value: Value? {
            if case .value(let value) = self { return value }
            return nil
        }

        var isWrongType: Bool {
            if case .wrongType = self { return true }
            return false
        }
    }

    private static func field<Value>(_ object: [String: Any], _ key: String,
                                     _ convert: (Any) -> Value?) -> JSONField<Value> {
        guard let raw = object[key], !(raw is NSNull) else { return .empty }
        if let value = convert(raw) { return .value(value) }
        return .wrongType
    }

    /// 整数域（id）：非布尔 NSNumber；非浮点存储无损取 Int64（域外无符号大整数
    /// → nil），浮点存储要求精确可表示。
    ///
    /// 与旧 JSONDecoder 的实测差异（独立差分审查确认；影响面有界并已用测试钉住）：
    /// JSONSerialization 已把数字归一成 Double、原始 token 不可得，因此
    ///   - `{"id":9007199254740993e0}` 旧实现按 token 文本给出 …993，本实现给
    ///     Double 舍入后的 …992；
    ///   - `{"id":9223372036854775000.0}` 旧实现接受，本实现因 Double 表示不了
    ///     而拒绝（fail-closed）；
    ///   - 浮点存储恰好落在 -2^63 的字面量（如 `-9223372036854775809` 经 Double
    ///     舍入）本实现**拒绝**——旧实现按 token 文本判越界同样拒绝；整数存储的
    ///     Int64.min 不受影响。
    /// 线上 id 恒为 Swift `allocateID()` 的小整数（pending 只认这些），差异输入
    /// 只会落成「未知 id → loud 丢弃」，不影响配对。
    private static func intValue(_ raw: Any) -> Int? {
        guard let number = raw as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        if !CFNumberIsFloatType(number) {
            guard let value = number as? Int64 else { return nil }
            return Int(value)
        }
        let double = number.doubleValue
        // -2^63 在 Double 里恰好可表示、Int64(exactly:) 会接受；但它只可能来自
        // 越界 token 的舍入（合法 Int64.min 走整数存储），故 fail-closed 拒绝。
        guard double != -9_223_372_036_854_775_808.0 else { return nil }
        guard let value = Int(exactly: double) else { return nil }
        return value
    }

    private static func stringValue(_ raw: Any) -> String? { raw as? String }

    private static func boolValue(_ raw: Any) -> Bool? {
        guard let number = raw as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    /// 行是否超过单帧上限：按 UTF-8 字节数计（帧长上限的计量口径与
    /// TrustGuard.envelopeSizeOK 一致；String.count 是字符数，仅作近似时
    /// 会低估多字节文本，故这里用 utf8.count）。
    public static func isLineTooLong(_ line: String) -> Bool {
        line.utf8.count > maxFrameBytes
    }
}

/// B 桥帧编解码错误（本地错误：调用方编码出不可发送的帧时抛出；非 sidecar
/// 业务拒绝——后者走 BridgeClient 的 NSError code 1）。
public enum FrameCodecError: LocalizedError, Equatable {
    /// 帧超过 maxFrameBytes 上限。
    case frameTooLarge(byteCount: Int)
    /// ok=false 的响应帧必须携带 error 文案（line 协议要求 error:<string>）。
    case responseMissingErrorMessage(id: Int)

    public var errorDescription: String? {
        switch self {
        case .frameTooLarge(let byteCount):
            return NativeText.format(.frameTooLarge, Int32(FrameCodec.maxFrameBytes),
                                     Int32(byteCount))
        case .responseMissingErrorMessage(let id):
            return NativeText.format(.frameResponseMissingError, Int32(id))
        }
    }
}
