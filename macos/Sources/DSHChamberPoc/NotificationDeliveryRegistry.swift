//
//  NotificationDeliveryRegistry.swift
//  DSHChamberPoc
//
//  S8（2026-12 审计）：原生通知退役登记表。Swift flavor 此前把
//  retireNotifications 当 no-op（无 sourceId→identifier 映射），侧车退役来源时
//  OS 通知中心里的存量横幅永远清不掉。本类型保存「已投递通知」的
//  sourceId → identifier 映射（identifier 由 SwiftEdgeHostLegs 按
//  chamber-edge-<纪年>.<壳内序号>.<notificationId> 命名），退役通知到达时由宿主腿
//  UNUserNotificationCenter.removeDeliveredNotifications(withIdentifiers:) 清除。
//
//  语义对齐 node-edges/electron-edges（2026-12 第二轮验证收口）：identifier 由
//  node-edges 的 nextNotificationId 生成，而该计数器**每个 sidecar 进程都从 1
//  重置**——supervisor 在同一 app 进程内重启 sidecar 时 identifier 会重用。因此
//  退役记忆只承载「retire 时仍在途」的投递（按 sourceId+identifier 成对记忆，
//  完成回执即消费），已完成的退役绝不记忆，避免把重用 identifier 的新横幅当成
//  旧的在途条目而立即删除。
//
//  语义对齐 node-edges/electron-edges：
//  - sourceId 缺省/null = unknown-source：仍投递，但无法归属退役集 → 不登记
//    （node-edges 的 clickRoutes 同样只登记有 token 的通知）；
//  - 登记表必须有界（S14）：长期运行的壳会持续投递通知，登记表按插入序
//    淘汰最旧（与 electron-edges 活跃通知上限同向；退役已淘汰条目为
//    best-effort，OS 侧横幅不再有登记可清）。
//
//  线程：SwiftEdgeHostLegs 在 UNUserNotificationCenter.add 完成回调（任意
//  队列）登记，notify 消费线程读取/退役 → 全部经 NSLock。
//
import Foundation

/// 已投递原生通知的 sourceId → identifier 登记表（线程安全，有界）。
public final class NotificationDeliveryRegistry {
    /// 登记上限：与 electron-edges 的 MAX_ACTIVE_NATIVE_NOTIFICATIONS 同量级
    /// （16）；超出按插入序淘汰最旧一条（退役集丢失为 best-effort，OS 横幅
    /// 不再有登记可清——与 electron-edges 淘汰最旧活跃通知同向）。
    public static let maxTrackedDeliveries = 16

    /// 退役记忆上限（仅承载在途竞态；完成回执即消费）。有界 FIFO 防无界增长。
    public static let maxRetiredIdentifiers = 64
    /// 在途投递上限（begin 无 finish 的异常路径下防无界增长）。
    public static let maxPendingDeliveries = 64

    private let lock = NSLock()
    /// sourceId → 该来源已投递的 identifier 集（保序：登记序）。
    private var identifiersBySource: [String: [String]] = [:]
    /// 全量登记序（满员淘汰最旧用）。
    private var insertionOrder: [(sourceId: String, identifier: String)] = []
    /// 在途投递（已 begin、未 finish）的 sourceId+identifier 复合键。
    private var pendingIdentifiers: [String] = []
    /// 退役时仍在途的投递复合键（完成回执据此立即清除横幅，消费一次即移除）。
    private var retiredIdentifiers: [String] = []

    public init() {}

    /// 壳进程内单调的投递序号（sidecar 的 notificationId 会随其重启重置，序号
    /// 不会）——OS 标识里带上它，重启前后的横幅在通知中心绝不同名。
    private var identifierSequence = 0

    public func nextIdentifierSequence() -> Int {
        lock.lock()
        defer { lock.unlock() }
        identifierSequence += 1
        return identifierSequence
    }

    /// 复合键：sourceId 与 identifier 用不可能出现在两者中的分隔符连接，避免
    /// 跨来源的 identifier 重用串味。
    static func deliveryKey(sourceId: String, identifier: String) -> String {
        sourceId + "\u{1F}" + identifier
    }

    /// 调度前登记（**先于** UNUserNotificationCenter.add）：退役与投递竞争时
    /// 退役端能看到 identifier 并返回它，投递完成回调再由 finishDelivery 决定
    /// 是否立即移除（2026-12 验证轮：只在 add 完成回调里登记会漏掉这个窗口，
    /// 被退役来源的横幅会留在通知中心）。sourceId 为空/缺省（unknown-source）
    /// → 不登记（无法归属退役集）；identifier 已登记 → 幂等。
    @discardableResult
    public func beginDelivery(sourceId: String?, identifier: String) -> Bool {
        guard let sourceId, !sourceId.isEmpty, !identifier.isEmpty else { return false }
        lock.lock()
        defer { lock.unlock() }
        var ids = identifiersBySource[sourceId] ?? []
        if !ids.contains(identifier) {
            ids.append(identifier)
            identifiersBySource[sourceId] = ids
            insertionOrder.append((sourceId: sourceId, identifier: identifier))
        }
        if insertionOrder.count > Self.maxTrackedDeliveries {
            let evicted = insertionOrder.removeFirst()
            if var remaining = identifiersBySource[evicted.sourceId] {
                remaining.removeAll { $0 == evicted.identifier }
                if remaining.isEmpty {
                    identifiersBySource.removeValue(forKey: evicted.sourceId)
                } else {
                    identifiersBySource[evicted.sourceId] = remaining
                }
            }
        }
        // 在途记录（有界）：只有它会在 retire 时进入退役记忆。
        let deliveryKey = Self.deliveryKey(sourceId: sourceId, identifier: identifier)
        if !pendingIdentifiers.contains(deliveryKey) {
            pendingIdentifiers.append(deliveryKey)
            if pendingIdentifiers.count > Self.maxPendingDeliveries {
                pendingIdentifiers.removeFirst(pendingIdentifiers.count - Self.maxPendingDeliveries)
            }
        }
        return true
    }

    /// 投递结束：失败 → 撤下登记（没有可退役的横幅）；成功 → 若该 identifier
    /// 在在途期间已被退役，返回 true（调用方必须立即 removeDeliveredNotifications，
    /// 否则横幅留在通知中心）。
    public func finishDelivery(sourceId: String?, identifier: String, delivered: Bool) -> Bool {
        guard let sourceId, !sourceId.isEmpty, !identifier.isEmpty else { return false }
        lock.lock()
        defer { lock.unlock() }
        let deliveryKey = Self.deliveryKey(sourceId: sourceId, identifier: identifier)
        pendingIdentifiers.removeAll { $0 == deliveryKey }
        if !delivered {
            removeLocked(sourceId: sourceId, identifier: identifier)
            // 投递失败：该 identifier 没有落地横幅，清掉可能存在的在途退役记忆
            // （否则一次未落地的竞态会消费掉后续重用 identifier 的回执）。
            retiredIdentifiers.removeAll { $0 == deliveryKey }
            return false
        }
        // 记忆按次消费：一次投递只报告一次「在途被退役」，避免同一 identifier
        // 反复触发清除，也让 FIFO 记忆只承载尚未收口的在途竞态。
        guard let index = retiredIdentifiers.firstIndex(of: deliveryKey) else { return false }
        retiredIdentifiers.remove(at: index)
        return true
    }

    private func removeLocked(sourceId: String, identifier: String) {
        if var remaining = identifiersBySource[sourceId] {
            remaining.removeAll { $0 == identifier }
            if remaining.isEmpty {
                identifiersBySource.removeValue(forKey: sourceId)
            } else {
                identifiersBySource[sourceId] = remaining
            }
        }
        insertionOrder.removeAll { $0.sourceId == sourceId && $0.identifier == identifier }
    }

    /// 退役给定来源集合（旧调用面）：等价于无逐条 notificationId 的合并退役。
    public func retire(sourceIds: [String]) -> [String] {
        retire(sourceIds: sourceIds, notificationIds: [])
    }

    /// 退役：整源（sourceIds）+ 逐条（notificationIds = sidecar 的
    /// notificationId，P-07）合并，返回需要从通知中心移除的 identifier
    /// （FIFO 序，去重）。未登记来源/未投递 id 静默跳过（幂等）。
    ///
    /// notificationId → 本壳 identifier 的映射：identifier 末段恒为 sidecar
    /// notificationId（见 NotificationDispatch.identifier），按末段整值比较；
    /// 即使 sourceIds 为空（node-edges 的 >16 淘汰路径逐条下发）也精确清除。
    public func retire(sourceIds: [String], notificationIds: [Int]) -> [String] {
        lock.lock()
        defer { lock.unlock() }
        var removed: [String] = []
        var removedPairs = Set<String>()

        // ① 逐条 id 的候选先按插入序快照（identifier 末段 = notificationId）。
        var requestedByNotificationId: [(sourceId: String, identifier: String)] = []
        if !notificationIds.isEmpty {
            let wanted = Set(notificationIds)
            for entry in insertionOrder {
                guard let last = entry.identifier.split(separator: ".").last,
                      let id = Int(last), wanted.contains(id) else { continue }
                requestedByNotificationId.append(entry)
            }
        }

        // ② 整源退役：移除该来源全部 identifier，并记录在途退役记忆。
        for sourceId in sourceIds {
            guard let ids = identifiersBySource.removeValue(forKey: sourceId) else { continue }
            for identifier in ids {
                let pair = Self.deliveryKey(sourceId: sourceId, identifier: identifier)
                guard removedPairs.insert(pair).inserted else { continue }
                removed.append(identifier)
                // 只有在途条目才进退役记忆：已完成投递的 identifier 不记，避免
                // 跨 sidecar 重启的 identifier 重用误删新横幅（见文件头注记）。
                if pendingIdentifiers.contains(pair) {
                    retiredIdentifiers.append(pair)
                }
            }
        }

        // ③ 逐条退役：与整源结果去重（两字段并存时同一 identifier 只返回一次）。
        for entry in requestedByNotificationId {
            let pair = Self.deliveryKey(sourceId: entry.sourceId, identifier: entry.identifier)
            guard removedPairs.insert(pair).inserted else { continue }
            removeLocked(sourceId: entry.sourceId, identifier: entry.identifier)
            removed.append(entry.identifier)
            if pendingIdentifiers.contains(pair) {
                retiredIdentifiers.append(pair)
            }
        }

        if !removed.isEmpty {
            // 按 (sourceId, identifier) 成对删除：identifier 会跨 sidecar 重启
            // 重用，只按 identifier 删会误删别的来源仍在册的插入序槽位，令 16 条
            // 上限名存实亡（2026-12 第三轮验证）。
            insertionOrder.removeAll { removedPairs.contains(Self.deliveryKey(sourceId: $0.sourceId, identifier: $0.identifier)) }
            if retiredIdentifiers.count > Self.maxRetiredIdentifiers {
                retiredIdentifiers.removeFirst(retiredIdentifiers.count - Self.maxRetiredIdentifiers)
            }
        }
        return removed
    }

    /// 该（sourceId, identifier）是否在在途期间被退役（诊断/测试）。
    public func wasRetiredDuringDelivery(sourceId: String, identifier: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return retiredIdentifiers.contains(Self.deliveryKey(sourceId: sourceId, identifier: identifier))
    }

    /// 当前登记的通知数（诊断/测试；不含已被淘汰条目）。
    public var trackedCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return insertionOrder.count
    }

    /// 当前登记来源数（诊断/测试）。
    public var sourceCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return identifiersBySource.count
    }
}
