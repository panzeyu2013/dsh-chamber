/**
 * 未读派生仪表（W0）。
 *
 * WHY：未读面长期空账（载荷 `read/edge` 为空）而页面外看不到任何判定输入。每次派生的
 * 分支、行数、**最大行水位**、行样本、读表规模、播种读数与结果计数必须成为机内可读证据，
 * 否则「水位为什么是 0」只能靠读代码推断。
 *
 * 边界：只读旁路——没有调用方依赖返回值，不参与任何判定/投递；有界环（默认 12 条）只存
 * 计数与 id，不存正文；发布为**函数视图**的只读全局，供仪器/CDP 直接读。
 */
import { createBoundedList } from './bounded-ledger.ts'
import { reconcileUnreadShadowOnLoad, type UnreadStorageLike, type UnreadV4Payload } from './unread-store.ts'

/** 行样本：只留水位相关字段，用于在页面里直接确认「水位为什么是 0」。 */
export interface UnreadRowSample {
  sessionId: string
  running: boolean
  updatedAt: number
  completedAt: number | null
  completedAtDomain: 'host' | 'observer' | null | undefined
}

/** 行形状的窄化读面（facts 行与 mux 行都被它接受）。 */
export interface UnreadRowLike {
  running?: boolean
  updatedAt?: number
  completedAt?: number | null
  completedAtDomain?: 'host' | 'observer' | null
}

/**
 * W1 定案判词：把「水位为什么没变成未读」压成一个可读结论——读数即定案，不再靠读代码推断。
 * - no-verified-facts：本拍 facts 不可判（等首个可用批），读数不结论；
 * - m1-zero-watermark：行水位全 0 ⇒ 来源侧没有可用水位（M1，修水位来源）；
 * - m2-seed-not-consumed：有水位但**本化身的基线镜像从未落地** ⇒ 写入路径问题（M2，修 seed/read 路径）；
 * - read-marks-only：已消费但未读仍 0 且读表非空 ⇒ 全被读标记吸收（核对读标记语义）；
 * - all-rows-unread：未读数 == 行数（**全表武装**）⇒ 读水位地板从未落地/读路径从不吸收，
 *   这正是「Dock 数字非常大」的形状（实测 123 行全未读 + `read:{}`）；
 * - ok：本拍水位已消费，未读计数即为真实结果。
 */
export type UnreadVerdict =
  | 'no-verified-facts'
  | 'm1-zero-watermark'
  | 'm2-seed-not-consumed'
  | 'read-marks-only'
  | 'all-rows-unread'
  | 'ok'

/** 判词只读下列输入（与派生同一拍），不参与任何判定。 */
export function unreadVerdict(input: {
  factsVerified: boolean
  maxWatermark: number
  seed: { through: number; consumed: boolean }
  unread: number
  readMarks: number
  rows: number
}): UnreadVerdict {
  if (!input.factsVerified) return 'no-verified-facts'
  if (input.maxWatermark <= 0) return 'm1-zero-watermark'
  if (!input.seed.consumed) return 'm2-seed-not-consumed'
  if (input.rows > 0 && input.unread === input.rows) return 'all-rows-unread'
  if (input.unread === 0 && input.readMarks > 0) return 'read-marks-only'
  return 'ok'
}

/** 一次未读派生的输入面 + 结果面（全部可读计数）。 */
export interface UnreadDeriveRecord {
  at: number
  sourceId: string
  /** facts = facts 行可判；channel = 只有运行时通道；freeze = 两者都缺席（冻结上一拍）。 */
  branch: 'facts' | 'channel' | 'freeze'
  factsVerified: boolean
  rows: number
  maxWatermark: number
  sample: readonly UnreadRowSample[]
  readMarks: number
  /** W1 M2 读数：派生重入闸计数（coalesced > 0 = 实机存在重入环且被闸吸收）。 */
  gate?: { runs: number; coalesced: number; deferrals: number }
  /** 播种读数：through = 输入行最大水位，consumed = 本化身的基线镜像是否已落地（本拍或此前拍），keepUnread = 保护集规模。 */
  seed: { through: number; consumed: boolean; keepUnread: number }
  unread: number
  running: number
  changed: boolean
  /** W1 判词（record 时由 unreadVerdict 计算，调用方不传）。 */
  verdict: UnreadVerdict
}

/** record 的入参 = 判词之外的记录面。 */
export type UnreadDeriveRecordInput = Omit<UnreadDeriveRecord, 'verdict'>

export interface UnreadInstrument {
  record(entry: UnreadDeriveRecordInput): void
  entries(): readonly UnreadDeriveRecord[]
  last(): UnreadDeriveRecord | undefined
  clear(): void
}

/** 行样本：按水位降序取 top-N（同水位按会话 id 定序）——榜首就是最大水位的持有者。 */
export function sampleUnreadRows(
  rows: Readonly<Record<string, UnreadRowLike>> | undefined,
  limit = 3,
): UnreadRowSample[] {
  if (rows === undefined || limit <= 0) return []
  return Object.keys(rows)
    .map(sessionId => ({ sessionId, row: rows[sessionId] }))
    .filter((item): item is { sessionId: string; row: UnreadRowLike } => item.row !== undefined)
    .sort((left, right) => {
      const watermark = (right.row.updatedAt ?? 0) - (left.row.updatedAt ?? 0)
      return watermark !== 0 ? watermark : (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0)
    })
    .slice(0, limit)
    .map(({ sessionId, row }) => ({
      sessionId,
      running: row.running === true,
      updatedAt: row.updatedAt ?? 0,
      completedAt: row.completedAt ?? null,
      completedAtDomain: row.completedAtDomain,
    }))
}

/**
 * W3 影子等价性报告（先锁）：每次影子写之后由调用方记录一条——`ok=false` 说明 v5 形状此刻
 * 复现不了 v4 的未读/已读/身份（净化拒绝或有界裁剪），**不得**切换权威。只读旁路。
 */
export interface UnreadShadowReport {
  at: number
  /** 产生报告的时机：write = 影子写后读回对账；startup = 载入时 v4/v5 对账（捕捉漂移）。 */
  phase: 'write' | 'startup'
  written: boolean
  ok: boolean
  differences: readonly string[]
}

let shadowReport: UnreadShadowReport | null = null

export function recordUnreadShadowReport(report: Omit<UnreadShadowReport, 'at'>): void {
  shadowReport = { at: Date.now(), ...report }
}

export function unreadShadowReport(): UnreadShadowReport | null {
  return shadowReport
}

/**
 * 启动期影子对账的组合入口（W3）：载入时读盘比对 v4/v5，**只报告、不改判定**（权威仍是 v4），
 * 差异文本有界（≤8 条，见 `reconcileUnreadShadowOnLoad`）；无影子可对账时静默。行为与原内联块
 * 逐字等价——下沉只为不让容器文件（god-file 棘轮）继续长行。
 */
export function reportUnreadShadowParityOnLoad(
  storage: UnreadStorageLike | undefined,
  v4: UnreadV4Payload,
): void {
  const parity = reconcileUnreadShadowOnLoad(storage, v4)
  if (parity === null) return
  recordUnreadShadowReport({ phase: 'startup', written: true, ok: parity.ok, differences: parity.differences })
  if (!parity.ok) console.warn('[renderer] unread v5 shadow drifted from v4 (authority stays v4):', parity.differences)
}

export function createUnreadInstrument(limit = 12): UnreadInstrument {
  const ring = createBoundedList<UnreadDeriveRecord>(limit)
  return {
    record(entry) { ring.push({ ...entry, verdict: unreadVerdict(entry) }) },
    entries: () => ring.toArray(),
    last() {
      const items = ring.toArray()
      return items[items.length - 1]
    },
    clear: () => { ring.clear() },
  }
}

/** 进程级单例（页面级；只读仪表）。 */
export const unreadInstrument = createUnreadInstrument()

/** 幂等挂全局（函数视图，不产生周期性对象；已存在则不覆盖，避免热重载后环成孤儿）。 */
export function publishUnreadInstrument(target: unknown = globalThis): void {
  const host = target as { __dshChamberUnread?: unknown }
  if (host.__dshChamberUnread !== undefined) return
  host.__dshChamberUnread = {
    entries: () => unreadInstrument.entries(),
    last: () => unreadInstrument.last(),
    shadow: () => unreadShadowReport(),
    clear: () => { unreadInstrument.clear() },
  }
}
