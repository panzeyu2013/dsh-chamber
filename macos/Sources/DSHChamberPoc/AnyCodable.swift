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

    /// JSON 文本长度的**安全上界**（UTF-8 字节）——供尺寸门在序列化之前短路。
    ///
    /// 契约：对任意 value，本属性 ≥ 该值经 JSONSerialization 或本文件写出后的
    /// 实际字节数。据此调用方可用「上界 ≤ 上限 ⇒ 必过」跳过精确序列化；只有
    /// 上界超限时才必须做精确判定——接受集与逐字节判定完全相同（AnyCodableTests
    /// 的 upper-bound 用例钉住该不等式）。
    ///
    /// 推导：字符串无需转义时 ≤ utf8.count + 2（引号）；需要转义时每个 UTF-8
    /// 字节最多产出 6 字节（\u00XX / surrogate pair 形态），故 ≤ 6 x utf8.count + 2；数字取 24
    /// （Double 最长往返表示 + 符号），非有限值写出 null 取 4；true/false/null
    /// 分别 4/5/4；数组/对象为 2 个括号 + 每项（元素或键值对）各放宽 +2。
    var jsonUpperBoundByteCount: Int {
        switch self {
        case .null:
            return 4
        case .bool(let flag):
            return flag ? 4 : 5
        case .number(let number):
            return number.isFinite ? 24 : 4
        case .string(let text):
            let raw = text.utf8.count
            return Self.requiresJSONEscaping(text) ? raw * 6 + 2 : raw + 2
        case .array(let values):
            var total = 2
            for value in values { total += value.jsonUpperBoundByteCount + 2 }
            return total
        case .object(let entries):
            var total = 2
            for (key, value) in entries {
                let keyBytes = key.utf8.count
                total += (Self.requiresJSONEscaping(key) ? keyBytes * 6 + 2 : keyBytes + 2)
                total += value.jsonUpperBoundByteCount + 2
            }
            return total
        }
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

    /// 是否需要 JSON 转义：`"`、`\`、C0 控制字符（< 0x20）或 U+2028/U+2029。
    ///
    /// Phase 3（2026-09-18 实测）：单遍 UTF-8 扫描，供 writeJSONString 的
    /// 「无转义整段直出」快路径与 jsonUpperBoundByteCount 的尺寸门共用。
    /// U+2028/2029 的 UTF-8 编码是三字节序列 E2 80 A8 / E2 80 A9（自同步编码，
    /// 该前缀无歧义），故用两个回看字节识别——只查 `"`/`\`/控制字符会漏掉
    /// 它们（历史上是 JS 字面量的坑，AnyCodableTests 有专例）。
    static func requiresJSONEscaping(_ string: String) -> Bool {
        var prev: UInt8 = 0
        var prev2: UInt8 = 0
        for byte in string.utf8 {
            if byte < 0x20 || byte == 0x22 || byte == 0x5C { return true }
            if (byte == 0xA8 || byte == 0xA9), prev == 0x80, prev2 == 0xE2 { return true }
            prev2 = prev
            prev = byte
        }
        return false
    }

    /// JSON 字符串转义（含 U+2028/U+2029；非 BMP 字符原样保留，UTF-8 直出）。
    ///
    /// Phase 3 / 3b（2026-09-18）：先做一次 requiresJSONEscaping 扫描，整串无需
    /// 转义（ASCII 路径/代码/日志/base64 主体）时**整段直出**；含转义时走下面的
    /// 字节缓冲批量写出。两条路径输出与改动前的逐 scalar 实现**逐字节相同**
    /// （AnyCodableTests 语义用例 + .tmp/perf/swiftbench{4,7,8} 对抗载荷 equal=y）。
    /// 实测（-O，1 MB 级；bench8 = 对改动前基线的加速）：纯 ASCII 10.9x、
    /// 引号每 100 字符 10.1x、转义点在末尾 5.4x、控制字符密布 2.1x、
    /// U+2028/2029 密布 4.1x、CJK+emoji 2.3x。
    private static func writeJSONString(_ string: String, into out: inout String) {
        // 快路径：整串无需转义（ASCII 载荷/路径/base64 主体）→ 整段直出。
        if !requiresJSONEscaping(string) {
            out += "\""
            out += string
            out += "\""
            return
        }
        // 慢路径（Phase 3b）：字节缓冲 + 干净段批量拷贝。
        //
        // 逐 scalar 的 switch+append 在含转义的大载荷上要 ~17.5 ms/MB（每字符
        // 一次 append），是页面结果帧在**主线程**上最大的一笔；本实现把「无转义
        // 的连续字节段」整段拷贝、只在转义点写 2/6 字节，实测（-O，1 MB）：
        //   引号每 100 字符 17.412→1.9 ms（9.1x）、转义点在末尾 18.650→1.5 ms（12.6x）、
        //   控制字符密布 15.475→8.2 ms（1.9x）、U+2028/2029 密布 4.820→3.4 ms（1.4x）、
        //   CJK+emoji 混排 4.135→1.5 ms（2.7x）；纯 ASCII 交给上面的快路径。
        // 语义：与逐 scalar 路径**逐字节一致**（AnyCodableTests 的语义用例 + 
        // .tmp/perf/swiftbench7 的七类对抗载荷 equal=y）。代价是一次 utf8 数组
        // 拷贝与一次 String(decoding:)（4 MiB 载荷下瞬时多几 MB，可接受）。
        let bytes = Array(string.utf8)
        var buffer: [UInt8] = []
        buffer.reserveCapacity(bytes.count + 16)
        buffer.append(0x22)
        let hexDigits = Array("0123456789ABCDEF".utf8)
        var index = 0
        var runStart = 0
        while index < bytes.count {
            let byte = bytes[index]
            var escape: [UInt8]?
            var consumed = 1
            switch byte {
            case 0x22: escape = [0x5C, 0x22]
            case 0x5C: escape = [0x5C, 0x5C]
            case 0x08: escape = [0x5C, 0x62]
            case 0x09: escape = [0x5C, 0x74]
            case 0x0A: escape = [0x5C, 0x6E]
            case 0x0C: escape = [0x5C, 0x66]
            case 0x0D: escape = [0x5C, 0x72]
            default:
                if byte < 0x20 {
                    // \u00XX（大写十六进制，与逐 scalar 路径的 String(radix:16, uppercase:true) 同形）。
                    escape = [0x5C, 0x75, 0x30, 0x30,
                              hexDigits[Int(byte) >> 4], hexDigits[Int(byte) & 0x0F]]
                } else if byte == 0xE2, index + 2 < bytes.count,
                          bytes[index + 1] == 0x80,
                          bytes[index + 2] == 0xA8 || bytes[index + 2] == 0xA9 {
                    // U+2028 / U+2029（E2 80 A8 / A9，自同步编码无歧义）。
                    escape = bytes[index + 2] == 0xA8
                        ? [0x5C, 0x75, 0x32, 0x30, 0x32, 0x38]
                        : [0x5C, 0x75, 0x32, 0x30, 0x32, 0x39]
                    consumed = 3
                }
            }
            if let escape {
                buffer.append(contentsOf: bytes[runStart..<index])
                buffer.append(contentsOf: escape)
                index += consumed
                runStart = index
            } else {
                index += 1
            }
        }
        buffer.append(contentsOf: bytes[runStart..<bytes.count])
        buffer.append(0x22)
        out += String(decoding: buffer, as: UTF8.self)
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
