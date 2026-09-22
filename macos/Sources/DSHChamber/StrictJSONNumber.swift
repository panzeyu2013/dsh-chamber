//
//  StrictJSONNumber.swift
//  DSHChamber
//
//  严格 JSON 数值/布尔取值。
//
//  背景：WebKit / JSONSerialization 把 JSON 数字桥接为 NSNumber，而 NSNumber
//  同时承载 Int64 / Int32 / Double / CFBoolean 多种存储——`as? Bool` 与
//  `as? Int` 都会误判（实测 NSNumber(1) as? Bool == true）。
//  本类型是这组判定的唯一实现。
//
//  「哪种整数域」由调用方显式选择（IntDomain）——A 桥 envelope id 用 JS 精确
//  整数域（±2^53），B 桥帧 id / 出站 edgeId 用 Swift Int64 精确域；两者对
//  整值浮点的接受集不同，绝不能合并成一个隐式缺省。
//
//  纯 Foundation（CFTypeID 家族经 Foundation 再导出），纯函数，无状态。
//

import Foundation

public enum StrictJSONNumber {

    /// 浮点存储（CFNumberIsFloatType == true）的整数域。
    public enum IntDomain {
        /// Swift Int64 精确域：整值浮点接受（含 1e16），非整值/域外拒绝；
        /// 浮点存储恰为 -2^63 时拒绝——它只可能来自越界 token 的 Double 舍入
        /// （合法 Int64.min 走整数存储），fail-closed。B 桥帧 id / 出站 edgeId 用。
        case int64Exact
        /// JS Number 精确整数域（±2^53）：A 桥 envelope id 用（shim 的 id 是
        /// 单调小整数；> 2^53 的双精度路径会丢精度，故按 JS 精确域 fail-closed）。
        case jsExact
    }

    /// 整数取值：**Bool 的 NSNumber 一律拒绝**（JSON true/false 不是整数）。
    ///
    /// 非浮点存储：无损取 Int64（`as? Int64`——域外/无符号越界如 UInt64.max → nil，
    /// 绝不回绕）。
    /// 浮点存储：按 `domain` 判定（见 IntDomain 注释）。
    public static func int64(_ raw: Any?, domain: IntDomain) -> Int64? {
        guard let raw, let number = raw as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        if !CFNumberIsFloatType(number) { return number as? Int64 }
        let double = number.doubleValue
        switch domain {
        case .int64Exact:
            guard double != -9_223_372_036_854_775_808.0 else { return nil }
            return Int64(exactly: double)
        case .jsExact:
            guard double.isFinite, double == double.rounded(),
                  abs(double) <= 9_007_199_254_740_992.0 else { return nil }
            return Int64(exactly: double)
        }
    }

    /// AnyCodable.number（Double 承载）→ Int：有限、整值、Int 域内。
    /// （非有限 Double 的 `Int(exactly:)` 本就返回 nil，这里显式判以防未来实现漂移。）
    public static func int(_ double: Double) -> Int? {
        guard double.isFinite, double == double.rounded() else { return nil }
        return Int(exactly: double)
    }

    /// 严格布尔：只有 CFBoolean 型 NSNumber（JSON true/false 的桥接形态）才算
    /// 布尔，数字 1/0 一律拒绝（防静默当真值）。
    public static func bool(_ raw: Any?) -> Bool? {
        guard let raw, let number = raw as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
}
