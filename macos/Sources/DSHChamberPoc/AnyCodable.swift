// AnyCodable.swift —— B 桥帧载荷的“任意 JSON”值模型（Swift ↔ sidecar，NDJSON）
//
// design 25 §4.4.2（B 桥信封 {id,method,payload} / {id,ok,result|error} /
// {event,payload} 中 payload/result 字段可以是任意 JSON）与 W-05（垂直切片，
// docs/progress/todo/macos-swift-v1.md §0.2-⑥：Swift 侧 B 桥客户端原型）。
// 本类型是 FrameCodec（帧编解码）与 A 桥 MessageHandler（JS 字面量序列化、
// web 桥接对象 → payload）共享的载荷契约：
//   - FrameCodec 经本类型的 Codable 编解码信封字段；
//   - MessageHandler 经 `var jsonObject` 把载荷规范化为 JSONSerialization
//     可写对象，并用 JSONDecoder 按 Codable 契约把 web 侧对象解码进来
//     （“若 FrameCodec 后续提供 fromJSONObject 便利构造，本函数是唯一替换
//     点”——见 MessageHandler.anyCodablePayload 注释）；
//   - 其余作者（MessageHandler 等）需要 [String:Any]/[Any]/基础类型/NSNull
//     → AnyCodable 直转时，用 `fromJSONObject(_:)`（本文件实现，静态方法）。
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
// 纯 Foundation（无 AppKit/WebKit）；Swift 5 语言模式；macOS 13+。

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

    /// 规范 JSON 值：NSNull / Bool / NSNumber / String / [Any] / [String: Any]
    /// ——MessageHandler/MainWindowController 的 JS 字面量序列化（JSONSerialization）
    /// 直接消费本属性。来自解码的 AnyCodable 不含 NaN/Infinity 等非 JSON 值。
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

    // MARK: - 桥接对象 → AnyCodable

    /// 把 [String: Any] / [Any] / 基础类型（Bool/Int/Double/String 等）/
    /// NSNull 映射为 AnyCodable；遇到非 JSON 可表示值（Date/Data/自定义
    /// NSObject/纯 Swift 非桥接值等）返回 nil——诚实失败，不做静默降级。
    ///
    /// 实现：Swift 标量在 Any 中与 Foundation 容器一样可桥接为 NSObject
    /// （实测 Bool/Int/Double/String 均桥接为 CFBoolean/CFNumber/CFString），
    /// 故统一走 NSObject + CFTypeID 判别——规避 NSNumber 与 Bool 之间的
    /// as? 混淆（NSNumber(1) as? Bool == true）与 NSNumber/Int/Double 的
    /// 双向可转换性，所有数值一律落到 .number(doubleValue)。
    public static func fromJSONObject(_ value: Any) -> AnyCodable? {
        guard let object = value as? NSObject else { return nil }
        switch CFGetTypeID(object) {
        case CFNullGetTypeID():
            return .null
        case CFBooleanGetTypeID():
            // CFBoolean（JSON true/false 的桥接形态）同时是 NSNumber——
            // 此处已按 CFTypeID 排除数值 NSNumber，boolValue 安全。
            return .bool((object as! NSNumber).boolValue)
        case CFNumberGetTypeID():
            return .number((object as! NSNumber).doubleValue)
        case CFStringGetTypeID():
            return .string(object as! String)
        case CFArrayGetTypeID():
            guard let array = object as? [Any] else { return nil }
            var converted: [AnyCodable] = []
            converted.reserveCapacity(array.count)
            for element in array {
                guard let item = fromJSONObject(element) else { return nil }
                converted.append(item)
            }
            return .array(converted)
        case CFDictionaryGetTypeID():
            // 键非 String 的字典（如 [Int: Any]）不是 JSON 对象 → nil。
            guard let dictionary = object as? [String: Any] else { return nil }
            var converted: [String: AnyCodable] = [:]
            converted.reserveCapacity(dictionary.count)
            for (key, element) in dictionary {
                guard let item = fromJSONObject(element) else { return nil }
                converted[key] = item
            }
            return .object(converted)
        default:
            // Date/Data/URL/自定义 NSObject 等：非 JSON 可表示 → nil。
            return nil
        }
    }
}
