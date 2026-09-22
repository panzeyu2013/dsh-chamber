//
//  EdgeReplyGuard.swift
//  DSHChamber
//
//  edge 应答「恰好一次」守卫：有界 FIFO，满员淘汰最旧一个 id——长会话
//  （edgeId 单调递增）下内存有界。窗口外重复应答不被识别为重复，但 sidecar 侧
//  pendingEdges 首次应答即出表，窗口外重复本就无对端可伤（协议违约，非正确性
//  依赖）。
//
import Foundation

/// 有界 edgeId 应答守卫（值类型；调用方持锁使用）。
struct BoundedEdgeReplyGuard {
    /// 窗口容量（默认 4096：长会话内存有界，重复应答的识别窗口足够大）。
    let capacity: Int
    private var seen: Set<Int64> = []
    private var order: [Int64] = []

    init(capacity: Int = 4096) {
        precondition(capacity > 0, "capacity 必须为正")
        self.capacity = capacity
    }

    /// 窗口内是否已应答（只读）。
    func contains(_ edgeId: Int64) -> Bool { seen.contains(edgeId) }

    /// 首次插入 → true；窗口内已存在 → false。
    mutating func firstInsert(_ edgeId: Int64) -> Bool {
        guard !seen.contains(edgeId) else { return false }
        seen.insert(edgeId)
        order.append(edgeId)
        if order.count > capacity {
            seen.remove(order.removeFirst())
        }
        return true
    }

    /// 撤销一次插入（写失败回滚：见 BridgeClient.sendEdgeReply——若守卫不回滚，
    /// 「先烧号后写失败」会把一次可重试的应答永久记成重复，对端只能等超时）。
    mutating func remove(_ edgeId: Int64) {
        guard seen.remove(edgeId) != nil else { return }
        if let index = order.firstIndex(of: edgeId) {
            order.remove(at: index)
        }
    }

    mutating func removeAll() {
        seen.removeAll()
        order.removeAll()
    }

    /// 当前窗口内条目数（诊断/测试）。
    var count: Int { seen.count }
}
