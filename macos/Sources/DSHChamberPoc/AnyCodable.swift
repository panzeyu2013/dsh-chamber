// AnyCodable.swift —— B 桥帧载荷的“任意 JSON”值模型（Swift ↔ sidecar，NDJSON）
//
// design 25 §4.4.2（B 桥信封 {id,method,payload} / {id,ok,result|error} /
// {event,payload} 中 payload/result 字段可以是任意 JSON）与 W-05（垂直切片，
// design 25 §4.4.2：Swift 侧 B 桥客户端原型）。
// 本类型是 FrameCodec（帧编解码）与 A 桥 MessageHandler（web 桥接对象 → payload、
// 页面字面量序列化）共享的载荷契约：
//   - FrameCodec 经本类型的 Codable 编解码信封字段；
//   - MessageHandler 经 `fromJSONObject(_:)` 单遍转换 web 侧对象（Phase 1 C2；
//     旧的 JSONSerialization + JSONDecoder 往返已删除），深度上限见下；
//   - MainWindowController 经 `jsonLiteralText` 单遍写出页面 JS 字面量
//     （Phase 2 C7）。`jsonObject` 仍保留为 JSONSerialization 可写投影，供
//     测试/诊断与兼容使用，但**不再位于页面热路径**。
//
// 存储取舍（与 MessageHandler.swift 的 case 契约对应，勿擅改）：
//   - 数值一律以 Double 承载：JSONDecoder 可无损还原 ≤ 2^53 的整数与常规
//     小数；> 2^53 的整数文本在 JSON 文本 → Double 阶段按 IEEE754 就近取整
//     （与 JS JSON.parse 的双精度行为同族；POC 载荷无此量级，声明为已知
//     边界——id 等整数域字段绝不放入 .number 走 Double）。
//   - `jsonObject` 对整值 Double 还原为 NSNumber(int64) 形态（JSONSerialization
//     因此输出整数文本而非 “3.0”），非整值给 NSNumber(double)——NSNumber 桥接
//     取舍：统一经 NSNumber 让 JSONSerialization/ObjC 面零歧义。
//   - Bool 判别纪律（fromJSONObject）：实测 NSNumber(1) as? Bool 也会成功
//     （Swift 动态转换不区分数值 NSNumber 与布尔桥接），因此一律先经
//     CFTypeID 判定（CFBoolean vs CFNumber，CFNull/CFString/CFArray/
//     CFDictionary 同族）——与 MessageHandler.exactInt（CFGetTypeID(number)
//     != CFBooleanGetTypeID()）的判别法同源，绝不按 as? 链猜类型。
//   - .null 只表示 JSON 字面 null；“payload 键缺省”与“payload:null”在帧层
//     都折叠为 nil 可选字段（FrameCodec/本文件注释声明，协议容忍两者）。
//
// 纯 Foundation（无 AppKit/WebKit）；Swift 5 语言模式；macOS 14.4+（支持矩阵下限，见 deviations S-30）。

import Foundation

/// 任意 JSON 值的 6 态表示：null / 布尔 / 数值 / 字符串 / 数组 / 对象。
public enum AnyCodable: Codable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([AnyCodable])
    case object([String: AnyCodable])

    // MARK: - Codable（任意 JSON 自解码 / 还原编码）

    /// 任意 JSON → AnyCodable。单值容器按 null → bool → number → string →
    /// array → object 顺序试解：JSONDecoder 对类型是严格的（实测：Bool 拒绝
    /// 数字 token、Int/Double 拒绝 true/false、数组/对象容器互斥），try? 链
    /// 不会错配，末位仍未命中才抛 dataCorrupted（由调用方 loud）。
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
            return
        }
        if let value = try? container.decode(Bool.self) {
            self = .bool(value)
            return
        }
        if let value = try? container.decode(Double.self) {
            self = .number(value)
            return
        }
        if let value = try? container.decode(String.self) {
            self = .string(value)
            return
        }
        if let value = try? container.decode([AnyCodable].self) {
            self = .array(value)
            return
        }
        if let value = try? container.decode([String: AnyCodable].self) {
            self = .object(value)
            return
        }
        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "无法把当前 JSON 值映射到 AnyCodable 的任何 case")
    }

    /// AnyCodable → JSON：与 init(from:) 严格互逆（同单值容器语义）。
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case .bool(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .string(let value):
            try container.encode(value)
        case .array(let values):
            try container.encode(values)
        case .object(let entries):
            try container.encode(entries)
        }
    }

    // MARK: - 规范 JSON 对象（JSONSerialization 可写形态）

    /// 规范 JSON 值：NSNull / Bool / NSNumber / String / [Any] / [String: Any]。
    /// 供测试/诊断与 JSONSerialization 兼容消费；**页面热路径已改走
    /// `jsonLiteralText`**（Phase 2 C7，免掉这棵树的深拷贝）。来自解码的
    /// AnyCodable 不含 NaN/Infinity 等非 JSON 值。
    public var jsonObject: Any {
        switch self {
        case .null:
            return NSNull()
        case .bool(let value):
            return value
        case .number(let value):
            // 整值 Double（含 -0.0）→ NSNumber(int64)，让 JSONSerialization
            // 输出整数形态文本；非整值 / 超出 Int64 域 → NSNumber(double)。
            // 取舍：Int64(exactly:) 对域内整值恒成功（运行时值，非编译期
            // 常量折叠），域外返回 nil 自然落到 double 形态。
            if value.isFinite, value == value.rounded(),
               let integer = Int64(exactly: value) {
                return NSNumber(value: integer)
            }
            return NSNumber(value: value)
        case .string(let value):
            return value
        case .array(let values):
            return values.map { $0.jsonObject }
        case .object(let entries):
            return entries.mapValues { $0.jsonObject }
        }
    }

    // MARK: - 单遍 JS 字面量（Phase 2 C7）

    /// 直接写出 JSON 文本：单遍、无中间对象树。页面字面量出口
    /// （MainWindowController.jsonLiteral(of:)）使用它。
    ///
    /// 同机量级参考（-O，约 800KB result ×60；随机器负载波动）：单遍写出
    /// 524–532ms vs 旧路径（jsonObject 深拷贝 + JSONSerialization）636–654ms vs
    /// JSONEncoder 1360–1393ms——既避免深拷贝的内存峰值，也是三者中最快的
    /// （JSONEncoder 在深层嵌套的 AnyCodable 上反而退化约 2.1×，故不再使用）。
    ///
    /// 契约（AnyCodableTests 钉住，并与旧路径做解析后语义等价断言）：
    ///   - 数字：整值且 Int64 可表示 → 整数文本（与旧行为一致）；0 / -0.0 → "0"
    ///     （旧 jsonObject 的 Int64(exactly:) 折叠同样丢符号）；其余 → Swift 最短
    ///     往返表示（JS 求值后 Number 相同）；非有限 → "null"（旧路径会让
    ///     JSONSerialization 抛 NSException 崩进程，这里诚实降级）。
    ///   - 字符串：JSON 转义集（引号/反斜杠/控制字符）+ U+2028/U+2029（JS 行
    ///     分隔符，避免落进源码字面量时的历史坑）。
    ///   - 对象键序不保证（与 JSONSerialization/JSONEncoder 同）。
    ///   - 递归深度与载荷树同阶：解码侧已由 fromJSONObject 的 512 上限限制，
    ///     sidecar 帧进不来超深树；旧路径的 jsonObject 同样是递归的。
    public var jsonLiteralText: String {
        var out = ""
        out.reserveCapacity(64)
        Self.writeJSON(self, into: &out)
        return out
    }

    private static func writeJSON(_ value: AnyCodable, into out: inout String) {
        switch value {
        case .null:
            out += "null"
        case .bool(let flag):
            out += flag ? "true" : "false"
        case .number(let number):
            if !number.isFinite {
                out += "null"
            } else if number == 0 {
                out += "0"
            } else if number == number.rounded(), let integer = Int64(exactly: number) {
                out += String(integer)
            } else {
                out += String(number)
            }
        case .string(let text):
            writeJSONString(text, into: &out)
        case .array(let values):
            out += "["
            for (index, element) in values.enumerated() {
                if index > 0 { out += "," }
                writeJSON(element, into: &out)
            }
            out += "]"
        case .object(let entries):
            out += "{"
            for (index, entry) in entries.enumerated() {
                if index > 0 { out += "," }
                writeJSONString(entry.key, into: &out)
                out += ":"
                writeJSON(entry.value, into: &out)
            }
            out += "}"
        }
    }

    /// JSON 字符串转义（含 U+2028/U+2029；非 BMP 字符原样保留，UTF-8 直出）。
    private static func writeJSONString(_ string: String, into out: inout String) {
        out += "\""
        for scalar in string.unicodeScalars {
            switch scalar.value {
            case 0x22: out += "\\\""
            case 0x5C: out += "\\\\"
            case 0x08: out += "\\b"
            case 0x09: out += "\\t"
            case 0x0A: out += "\\n"
            case 0x0C: out += "\\f"
            case 0x0D: out += "\\r"
            case 0x00...0x1F, 0x2028, 0x2029:
                let hex = String(scalar.value, radix: 16, uppercase: true)
                out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
            default:
                out.unicodeScalars.append(scalar)
            }
        }
        out += "\""
    }

    // MARK: - 桥接对象 → AnyCodable

    /// JSON 嵌套深度上限（Phase 1 C2）：与 MessageHandler.maxJSONDepth 同值，
    /// 由 AnyCodableTests 的 lockstep 断言钉住。**本文件不 import
    /// MessageHandler**——AnyCodable 是 A/B 桥共享的载荷模型，反向依赖 A 桥
    /// 文件会造成耦合（同 FrameCodec 自带同值常量的纪律，见 FrameCodec.swift）。
    public static let maxJSONDepth = 512

    /// 把 [String: Any] / [Any] / 基础类型（Bool/Int/Double/String 等）/
    /// NSNull 映射为 AnyCodable；遇到非 JSON 可表示值（Date/Data/自定义
    /// NSObject/纯 Swift 非桥接值等）返回 nil——诚实失败，不做静默降级。
    ///
    /// 实现：Swift 标量在 Any 中与 Foundation 容器一样可桥接为 NSObject
    /// （实测 Bool/Int/Double/String 均桥接为 CFBoolean/CFNumber/CFString），
    /// 故统一走 NSObject + CFTypeID 判别——规避 NSNumber 与 Bool 之间的
    /// as? 混淆（NSNumber(1) as? Bool == true）与 NSNumber/Int/Double 的
    /// 双向可转换性，所有数值一律落到 .number(doubleValue)。
    ///
    /// 深度：与 MessageHandler.isJSONSerializableValue 同规——根为 0，超过
    /// maxDepth 立即失败（防 <4MiB 的极深嵌套在递归转换中击穿 Swift 栈）。
    public static func fromJSONObject(_ value: Any,
                                      maxDepth: Int = AnyCodable.maxJSONDepth,
                                      depth: Int = 0) -> AnyCodable? {
        guard depth <= maxDepth else { return nil }
        guard let object = value as? NSObject else { return nil }
        switch CFGetTypeID(object) {
        case CFNullGetTypeID():
            return .null
        case CFBooleanGetTypeID():
            // CFBoolean（JSON true/false 的桥接形态）同时是 NSNumber——
            // 此处已按 CFTypeID 排除数值 NSNumber，boolValue 安全。
            return .bool((object as! NSNumber).boolValue)
        case CFNumberGetTypeID():
            // JSON 文本里的 `-1e400` 会被 JSONSerialization 解析成 -inf；一旦
            // 落进 AnyCodable，下游 `Int(n)`（EdgePayload.int）会直接 trap 崩
            // 进程（2026-09 二轮评审 P3）。非有限值一律拒绝（fail closed）。
            let number = (object as! NSNumber).doubleValue
            guard number.isFinite else { return nil }
            return .number(number)
        case CFStringGetTypeID():
            return .string(object as! String)
        case CFArrayGetTypeID():
            guard let array = object as? [Any] else { return nil }
            var converted: [AnyCodable] = []
            converted.reserveCapacity(array.count)
            for element in array {
                guard let item = fromJSONObject(element, maxDepth: maxDepth,
                                               depth: depth + 1) else { return nil }
                converted.append(item)
            }
            return .array(converted)
        case CFDictionaryGetTypeID():
            // 键非 String 的字典（如 [Int: Any]）不是 JSON 对象 → nil。
            guard let dictionary = object as? [String: Any] else { return nil }
            var converted: [String: AnyCodable] = [:]
            converted.reserveCapacity(dictionary.count)
            for (key, element) in dictionary {
                guard let item = fromJSONObject(element, maxDepth: maxDepth,
                                               depth: depth + 1) else { return nil }
                converted[key] = item
            }
            return .object(converted)
        default:
            // Date/Data/URL/自定义 NSObject 等：非 JSON 可表示 → nil。
            return nil
        }
    }
}
