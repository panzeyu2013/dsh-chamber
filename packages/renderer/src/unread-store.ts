/**
 * 未读 v2 落盘存储。
 *
 * v2 落盘载荷：
 *   - 键：dsh-chamber.unread.v2 = { v:2, read, edge, notified }（见 UnreadV2Payload）；
 *   - read/sourceId/sessionId → host 域读水位（只升不降，max 合并）；
 *   - edge/sourceId/sessionId → true（边沿轨回退账本；重启后立即可渲染未读，不等网络）；
 *   - notified/sourceId/sessionId/kind → 已通知水位（第二入口去重）。
 * 载荷**不得出现 title/cwd/消息内容**（隐私条）——键白名单锁在
 * test/session-state/unread-store.test.ts 里钉住。
 *
 * 存储访问器 lazy + never-throw（照 view-prefs.ts 的形状）：私有模式/配额
 * 失败只降级为内存态，绝不影响本地未读。
 *
 * 单例纪律：N 个 ctx 共享一个 localStorage，逐调用点
 * setItem 会 last-writer-wins 丢标记；App 侧只经本模块的 merge/prune/save
 * 三个可组合步骤写盘（App 持有内存权威，v2 是缓存）。
 *
 * v1（dsh-chamber.unread.v1）在 HEAD **没有任何写入者**，因此 v1→v2 导入是
 * **防御性代码**（仍按「先写后删」顺序实现 + 单测，避免未来中间版本回退时
 * 丢账本），不是迁移承诺。
 *
 * `POST /read` / `/read-all` 的 ack 失败（网络错误 /
 * 5xx）进**有界内存待发表**（UNREAD_PENDING_MAX），facts 源每收到一帧服务端
 * 数据（probe 快照 / SSE sync·增量·心跳）就重放一次；幂等依据（服务端逐条
 * max 合并）写在 createUnreadAckOutbox 头注里。本机内存/落盘仍是权威，
 * 待发表只影响"服务端何时知道"，绝不影响未读判定。
 */

import { createBoundedMap } from './bounded-ledger.ts'
import { isWatermark, maxWatermarkValue } from './watermark.ts'

/** v2 落盘键（唯一被持续写入的未读键）。 */
export const UNREAD_V2_KEY = 'dsh-chamber.unread.v2'
/** 防御性 v1 边沿账本键（HEAD 无写入者；只读一次 + 迁移后删）。 */
export const UNREAD_V1_KEY = 'dsh-chamber.unread.v1'
/** client-install id 键（首启生成一次；重装 = 新 id，旧标记由服务端 TTL 清理）。 */
export const CLIENT_INSTALL_ID_KEY = 'dsh-chamber.client-install-id.v1'
/** 每来源读标记上限（按水位 LRU；K3 有界增长）。 */
export const UNREAD_MAX_SESSIONS_PER_SOURCE = 500
/** client-install id 语法（与 control-plane SESSION_STATE_CLIENT_ID_PATTERN 同形）。 */
export const CLIENT_INSTALL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/

export type UnreadKind = 'complete' | 'ask' | 'request'

export interface UnreadV2Payload {
  v: 2
  /** sourceId → sessionId → host 域读水位。 */
  read: Record<string, Record<string, number>>
  /** sourceId → sessionId → true（边沿轨回退账本 / 上次派生未读投影）。 */
  edge: Record<string, Record<string, boolean>>
  /** sourceId → sessionId → kind → 已通知水位（第二入口去重）。 */
  notified: Record<string, Record<string, Partial<Record<UnreadKind, number>>>>
}

/** Storage 的结构子集（浏览器 localStorage 或测试假实现）。 */
export interface UnreadStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function emptyUnreadPayload(): UnreadV2Payload {
  return { v: 2, read: {}, edge: {}, notified: {} }
}

/** 浏览器 localStorage 的安全访问器；不可用时 undefined（降级为纯内存）。 */
export function browserUnreadStorage(): UnreadStorageLike | undefined {
  try {
    const storage = globalThis.localStorage
    if (storage === undefined || storage === null) return undefined
    if (typeof storage.getItem !== 'function') return undefined
    return storage
  } catch {
    return undefined
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function warn(message: string, error?: unknown): void {
  console.warn('[unread] ' + message, error ?? '')
}

// ── 解析 / 清洗 ─────────────────────────────────────────────────────────────

/** 宽松清洗：只留下合法键值，剥掉坏项（不整包丢弃）。 */
export function sanitizeUnreadPayload(value: unknown): UnreadV2Payload {
  const payload = emptyUnreadPayload()
  if (!isPlainRecord(value)) return payload
  const read = isPlainRecord(value.read) ? value.read : {}
  for (const [sourceId, marks] of Object.entries(read)) {
    if (!isPlainRecord(marks)) continue
    const table: Record<string, number> = {}
    for (const [sessionId, mark] of Object.entries(marks)) {
      if (isWatermark(mark)) table[sessionId] = mark
    }
    if (Object.keys(table).length > 0) payload.read[sourceId] = table
  }
  const edge = isPlainRecord(value.edge) ? value.edge : {}
  for (const [sourceId, sessions] of Object.entries(edge)) {
    if (!isPlainRecord(sessions)) continue
    const table: Record<string, boolean> = {}
    for (const [sessionId, armed] of Object.entries(sessions)) {
      if (armed === true) table[sessionId] = true
    }
    if (Object.keys(table).length > 0) payload.edge[sourceId] = table
  }
  const notified = isPlainRecord(value.notified) ? value.notified : {}
  for (const [sourceId, sessions] of Object.entries(notified)) {
    if (!isPlainRecord(sessions)) continue
    const table: Record<string, Partial<Record<UnreadKind, number>>> = {}
    for (const [sessionId, kinds] of Object.entries(sessions)) {
      if (!isPlainRecord(kinds)) continue
      const row: Partial<Record<UnreadKind, number>> = {}
      for (const kind of ['complete', 'ask', 'request'] as const) {
        if (isWatermark(kinds[kind])) row[kind] = kinds[kind]
      }
      if (Object.keys(row).length > 0) table[sessionId] = row
    }
    if (Object.keys(table).length > 0) payload.notified[sourceId] = table
  }
  return payload
}

/** 防御性 v1 导入：v1 = { sourceId: { sessionId: true } }（边沿账本）。 */
function payloadFromV1(raw: string | null): UnreadV2Payload {
  const payload = emptyUnreadPayload()
  if (raw === null || raw === '') return payload
  try {
    const value: unknown = JSON.parse(raw)
    if (!isPlainRecord(value)) return payload
    for (const [sourceId, sessions] of Object.entries(value)) {
      if (!isPlainRecord(sessions)) continue
      const table: Record<string, boolean> = {}
      for (const [sessionId, armed] of Object.entries(sessions)) {
        if (armed === true) table[sessionId] = true
      }
      if (Object.keys(table).length > 0) payload.edge[sourceId] = table
    }
  } catch {
    return payload
  }
  return payload
}

/** 剪除空表（序列化前调用；保证载荷最小、无噪声键）。 */
export function pruneEmptyUnreadTables(payload: UnreadV2Payload): UnreadV2Payload {
  const next = emptyUnreadPayload()
  for (const [sourceId, table] of Object.entries(payload.read)) {
    if (Object.keys(table).length > 0) next.read[sourceId] = table
  }
  for (const [sourceId, table] of Object.entries(payload.edge)) {
    if (Object.keys(table).length > 0) next.edge[sourceId] = table
  }
  for (const [sourceId, table] of Object.entries(payload.notified)) {
    if (Object.keys(table).length > 0) next.notified[sourceId] = table
  }
  return next
}

/**
 * 有界化（K3，按水位 LRU）：每来源 read 只保留水位最高的 maxPerSource 条；
 * edge/notified 与 read 同界（先保留 read 里出现的会话，再按插入序补足）。
 * 返回新对象（调用方负责写盘）。
 */
export function pruneUnreadPayload(payload: UnreadV2Payload, maxPerSource = UNREAD_MAX_SESSIONS_PER_SOURCE): UnreadV2Payload {
  if (maxPerSource <= 0) return emptyUnreadPayload()
  const next = emptyUnreadPayload()
  for (const [sourceId, table] of Object.entries(payload.read)) {
    const entries = Object.entries(table)
    if (entries.length <= maxPerSource) {
      next.read[sourceId] = { ...table }
      continue
    }
    entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    const kept: Record<string, number> = {}
    for (const [sessionId, mark] of entries.slice(0, maxPerSource)) kept[sessionId] = mark
    next.read[sourceId] = kept
  }
  for (const [sourceId, table] of Object.entries(payload.edge)) {
    const read = next.read[sourceId] ?? {}
    const keys = Object.keys(table)
    const kept: Record<string, boolean> = {}
    for (const sessionId of keys) {
      if (Object.prototype.hasOwnProperty.call(read, sessionId)) kept[sessionId] = true
      if (Object.keys(kept).length >= maxPerSource) break
    }
    for (const sessionId of keys) {
      if (Object.keys(kept).length >= maxPerSource) break
      if (kept[sessionId] === true) continue
      kept[sessionId] = true
    }
    if (Object.keys(kept).length > 0) next.edge[sourceId] = kept
  }
  for (const [sourceId, table] of Object.entries(payload.notified)) {
    const read = next.read[sourceId] ?? {}
    const keys = Object.keys(table)
    const kept: Record<string, Partial<Record<UnreadKind, number>>> = {}
    for (const sessionId of keys) {
      if (Object.prototype.hasOwnProperty.call(read, sessionId)) kept[sessionId] = table[sessionId]
      if (Object.keys(kept).length >= maxPerSource) break
    }
    for (const sessionId of keys) {
      if (Object.keys(kept).length >= maxPerSource) break
      if (kept[sessionId] !== undefined) continue
      kept[sessionId] = table[sessionId]
    }
    if (Object.keys(kept).length > 0) next.notified[sourceId] = kept
  }
  return next
}

// ── 载入 / 保存（先写后删是 v1 迁移的契约） ─────────────────────────────────

/**
 * 载入 v2：
 *   1. v2 可解析且 v===2 ⇒ 逐字段清洗（坏字段就地剥掉），顺手清掉残留 v1；
 *   2. v2 缺失/整包损坏 ⇒ 若 v1 存在则防御性导入（只含 edge），**先写 v2 再删 v1**
 *      （写失败保留 v1，下次再试——不许先删后写）；
 *   3. 都没有 ⇒ 空载荷。
 */
export function loadUnread(storage: UnreadStorageLike | undefined): UnreadV2Payload {
  if (storage === undefined) return emptyUnreadPayload()
  let raw2: string | null = null
  try {
    raw2 = storage.getItem(UNREAD_V2_KEY)
  } catch {
    raw2 = null
  }
  if (raw2 !== null && raw2 !== '') {
    try {
      const value: unknown = JSON.parse(raw2)
      if (isPlainRecord(value) && value.v === 2) {
        try { storage.removeItem(UNREAD_V1_KEY) } catch { /* defensive v1 leftover */ }
        return sanitizeUnreadPayload(value)
      }
    } catch {
      // 整包坏 = v2 缺失：继续走 v1 防御性导入。
    }
  }
  let raw1: string | null = null
  try {
    raw1 = storage.getItem(UNREAD_V1_KEY)
  } catch {
    raw1 = null
  }
  const imported = payloadFromV1(raw1)
  if (raw1 !== null && raw1 !== '') {
    // 顺序是契约：先写后删。写失败必须原样保留 v1（下次再试）。
    try {
      storage.setItem(UNREAD_V2_KEY, JSON.stringify(pruneUnreadPayload(imported)))
      storage.removeItem(UNREAD_V1_KEY)
    } catch (error) {
      warn('v1 → v2 import failed; keeping v1 for a later attempt', error)
    }
  }
  return imported
}

/** 写盘（剪空表 + 有界化）；返回是否成功。never-throw。 */
export function saveUnread(storage: UnreadStorageLike | undefined, payload: UnreadV2Payload): boolean {
  if (storage === undefined) return false
  try {
    storage.setItem(UNREAD_V2_KEY, JSON.stringify(pruneUnreadPayload(pruneEmptyUnreadTables(payload))))
    return true
  } catch (error) {
    warn('cannot persist unread v2', error)
    return false
  }
}

// ── 单调合并 / 推进 ─────────────────────────────────────────────────────────

/**
 * 逐会话 max 合并（只升不降）。remote 缺席/坏值不改变本地；
 * 比较只用 host 域整数水位，客户端墙钟永不参与。
 */
export function mergeReadMarks(
  local: Readonly<Record<string, number>>,
  remote: Readonly<Record<string, number>> | undefined,
): Record<string, number> {
  if (remote === undefined) return local as Record<string, number>
  let changed = false
  const next: Record<string, number> = { ...local }
  for (const [sessionId, mark] of Object.entries(remote)) {
    if (!isWatermark(mark)) continue
    const current = next[sessionId]
    if (current === undefined || mark > current) {
      next[sessionId] = mark
      changed = true
    }
  }
  return changed ? next : (local as Record<string, number>)
}

/** 读标记推进（单调、0/undefined 安全、严格 >）。 */
export function advanceReadMark(current: number | undefined, watermark: number | undefined): number | undefined {
  if (!isWatermark(watermark) || watermark === 0) return current
  if (current === undefined || watermark > current) return watermark
  return current
}

/** 每会话内容水位 = max(updatedAt, completedAt)；返回全表最大（read-all 的 through）。 */
export function maxWatermark(
  rows: Readonly<Record<string, { updatedAt?: number; completedAt?: number | null }>>,
): number {
  let max = 0
  for (const row of Object.values(rows)) {
    const watermark = maxWatermarkValue(row.updatedAt, row.completedAt)
    if (watermark > max) max = watermark
  }
  return max
}

// ── client-install id ───────────────────────────────────────────────────────

interface CryptoLike {
  randomUUID?: () => string
  getRandomValues?: (array: Uint8Array) => Uint8Array
}

/** 生成一次安装 id：randomUUID → getRandomValues hex → Math.random 拼装 + warn。 */
export function createClientInstallId(cryptoImpl?: CryptoLike): string {
  const cryptoValue = cryptoImpl ?? (globalThis.crypto as CryptoLike | undefined)
  try {
    const uuid = cryptoValue?.randomUUID?.()
    if (typeof uuid === 'string' && CLIENT_INSTALL_ID_PATTERN.test(uuid)) return uuid
  } catch { /* fall through */ }
  try {
    if (cryptoValue?.getRandomValues !== undefined) {
      const bytes = cryptoValue.getRandomValues(new Uint8Array(16))
      let hex = ''
      for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
      if (CLIENT_INSTALL_ID_PATTERN.test(hex)) return hex
    }
  } catch { /* fall through */ }
  warn('crypto unavailable; falling back to Math.random for the client-install id')
  let fallback = ''
  for (let index = 0; index < 32; index += 1) fallback += Math.floor(Math.random() * 16).toString(16)
  return fallback
}

/** 读取或首启生成并落盘 client-install id；写失败只降级为内存态。 */
export function loadClientInstallId(
  storage: UnreadStorageLike | undefined,
  create: () => string = createClientInstallId,
): string {
  if (storage !== undefined) {
    try {
      const raw = storage.getItem(CLIENT_INSTALL_ID_KEY)
      if (raw !== null && raw !== '') {
        const value: unknown = JSON.parse(raw)
        if (isPlainRecord(value) && typeof value.id === 'string' && CLIENT_INSTALL_ID_PATTERN.test(value.id)) {
          return value.id
        }
      }
    } catch {
      // 坏载荷 → 重新生成。
    }
  }
  const id = create()
  if (storage !== undefined) {
    try {
      storage.setItem(CLIENT_INSTALL_ID_KEY, JSON.stringify({ v: 1, id, createdAt: Date.now() }))
    } catch (error) {
      warn('cannot persist the client-install id; staying in-memory', error)
    }
  }
  return id
}

// ── 上行 ack（POST /read、/read-all；只发 max，失败进有界待发表） ──────────

/**
 * 待发 ack 队列上限（条目数；最坏内存 = 上限 × 单条 {clientId, sessionId, 水位}，
 * 不含任何会话内容）。为什么必须有界：离线 / 跨端竞态 / 网关重启期间每一次读
 * 推进都会产生一条 ack，不设界就是一个无界内存增长点。
 *
 * 淘汰策略（先合并、后 FIFO）：
 *   1. **同键合并**：键 = sourceId + 方法 + sessionId（read-all 无 sessionId）。
 *      同一键再次入队只保留水位更高的那条：服务端本身就是单调 max 合并
 *      （见 createUnreadAckOutbox 的幂等依据），更低的旧值被新值支配，
 *      因此合并不丢任何服务端可观察的信息；
 *   2. **FIFO 淘汰**：合并后仍超上限时，从**最久入队**的键开始丢，并报诊断。
 *      丢掉的只是"某会话某时刻的水位"：本机内存/落盘仍是权威，下次该会话读
 *      推进会重新入队。这是「内存有界优先于严格送达」的显式取舍，不是静默丢账。
 */
export const UNREAD_PENDING_MAX = 64

/** 上行方法；与 session-facts-source 的两条 ack 路由一一对应。 */
export type UnreadAckMethod = 'read' | 'read-all'

/** 一条待发 ack：url 与 payload 原样保存，重放与首次上行逐字节相同。 */
export interface UnreadAckRequest {
  /** 来源（归属 + 队列键的一半；facts 源每来源一个 outbox）。 */
  sourceId: string
  method: UnreadAckMethod
  url: string
  payload: Readonly<Record<string, unknown>>
  /** 队列身份（同键合并 / 出队核对）。 */
  key: string
  /** 水位（read 的 readThrough / read-all 的 through）；同键比较与出队核对。 */
  watermark: number
}

/**
 * 单次上行结果：
 *   - `ok`：2xx（服务端已 max 合并；重复投递是 no-op）；
 *   - `retryable`：网络错误 / 5xx / 408 / 429——通道问题，重放有意义；
 *   - `permanent`：其余非 2xx（400/404/405/413…）——网关校验拒绝或路由不存在，
 *     重放不可能成功，出队并报诊断，避免毒条目永久占一个队位。
 */
export type UnreadAckOutcome = 'ok' | 'retryable' | 'permanent'

export interface UnreadAckSendResult {
  outcome: UnreadAckOutcome
  status: number | null
  error?: unknown
}

/** 幂等 max 上行（单发；never-throw）：POST JSON，same-origin，no-store。 */
export async function sendUnreadRequest(
  fetchImpl: typeof fetch,
  url: string,
  payload: Record<string, unknown>,
): Promise<UnreadAckSendResult> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(payload),
    })
    if (response.ok === true) return { outcome: 'ok', status: response.status }
    const retryable = response.status >= 500 || response.status === 408 || response.status === 429
    return { outcome: retryable ? 'retryable' : 'permanent', status: response.status }
  } catch (error) {
    return { outcome: 'retryable', status: null, error }
  }
}

export interface UnreadAckOutboxOptions {
  fetchImpl: typeof fetch
  /** 队列上限（条目数）；默认 UNREAD_PENDING_MAX；测试注入小值。0 = 关闭队列。 */
  maxPending?: number
  /** 未确认 / 永久拒绝 / 溢出淘汰的诊断出口（warn 语义由调用方决定）。 */
  onError?: (error: unknown) => void
}

export interface UnreadAckOutbox {
  /** 上行一次：先入队（未确认 = 待发），2xx 后出队；同步返回、绝不抛。 */
  post(sourceId: string, method: UnreadAckMethod, url: string, payload: Record<string, unknown>): void
  /** 通道恢复钩子：FIFO 重放待发表；单飞（在途时返回同一 promise，绝不 reject）。 */
  replay(): Promise<number>
  /** 待发条目数（诊断/测试）。 */
  size(): number
  /** 待发表快照（副本；诊断/测试）。 */
  pending(): readonly UnreadAckRequest[]
}

/**
 * 有界待发 ack 队列（客户端待发请求的失败重放）。
 *
 * **重放为什么幂等安全**（可核对的服务端依据，全部在仓内）：
 *   - `POST /read` → `mergeReadMark(existing, incoming) = max(existing, incoming)`
 *     （packages/control-plane/src/session-state-protocol.ts 的 mergeReadMark；
 *     gateway store.markRead 逐字使用它——同值重复写入返回 changed:false，
 *     会话不在服务端行表里也只回 200 + stored:false，不报错）；
 *   - `POST /read-all` → 源级 floor 同样 max 合并（protocol 的
 *     SESSION_STATE_READ_ALL_PATH 注释；gateway markAllRead 用 mergeReadMark，
 *     `next === readFloor` 直接返回 changed:false）；
 *   - 上界仍由服务端 host 时钟 clamp（clampReadThrough），重放旧值不会把未来读掉；
 *   - 因此"重发同一水位 / 重发落后的水位"在任何顺序 / 任何次数下都不改变服务端
 *     结果；队列可以放心地重复投递直到 2xx 出队。
 *
 * 出队用**对象身份**核对：发送/重放在途时同键可能已被更高水位替换（读水位只升
 * 不降），此时删除会丢新值，所以只在队列里仍是本次发送的那个对象时出队。
 * 入队先于发送（乐观入队）：在途请求即使丢失，条目仍在待发表里等下一次恢复信号。
 */
export function createUnreadAckOutbox(options: UnreadAckOutboxOptions): UnreadAckOutbox {
  const requested = options.maxPending
  const maxPending = requested === undefined || !Number.isSafeInteger(requested)
    ? UNREAD_PENDING_MAX
    : Math.max(0, requested)
  /**
   * 有界内核：Map 迭代序 = 入队序；同键覆盖走 delete+set ⇒ 该键
   * 移到队尾（最近更新），FIFO 淘汰优先丢最久没更新的键；淘汰经 onEvict 报诊断。
   */
  const entries = createBoundedMap<UnreadAckRequest>({
    limit: maxPending,
    replace: (previous, next) => next.watermark > previous.watermark,
    onEvict: key => report(new Error('unread ack pending queue overflow (max ' + String(maxPending) + '); dropped ' + key)),
  })
  let replaying: Promise<number> | null = null

  /** 诊断回调不得反过来打断队列：吞掉回调自身的异常。 */
  const report = (error: unknown): void => {
    try {
      options.onError?.(error)
    } catch {
      /* diagnostics are best-effort */
    }
  }

  const watermarkOf = (method: UnreadAckMethod, payload: Readonly<Record<string, unknown>>): number => {
    const value = method === 'read' ? payload.readThrough : payload.through
    return isWatermark(value) ? value : 0
  }

  const keyOf = (
    sourceId: string,
    method: UnreadAckMethod,
    payload: Readonly<Record<string, unknown>>,
  ): string => {
    const sessionId = method === 'read' && typeof payload.sessionId === 'string' ? payload.sessionId : ''
    return sourceId + '\u0000' + method + '\u0000' + sessionId
  }

  const enqueue = (request: UnreadAckRequest): void => {
    // 同键只保留更高水位（内核 replace 裁决）：max 服务端下旧值被支配，合并是安全的。
    entries.set(request.key, request)
  }

  const settle = (
    request: UnreadAckRequest,
    outcome: UnreadAckOutcome,
    status: number | null,
    error?: unknown,
  ): void => {
    if (entries.get(request.key) === request) {
      if (outcome === 'ok' || outcome === 'permanent') entries.delete(request.key)
    }
    if (outcome === 'ok') return
    if (outcome === 'permanent') {
      report(error ?? new Error('read ack rejected with HTTP ' + String(status)))
      return
    }
    // retryable：条目已在队列里（入队先于发送），只报诊断，等下一次恢复信号。
    report(error ?? new Error('read ack answered ' + String(status)))
  }

  return {
    post(sourceId, method, url, payload) {
      const request: UnreadAckRequest = {
        sourceId,
        method,
        url,
        payload: { ...payload },
        key: keyOf(sourceId, method, payload),
        watermark: watermarkOf(method, payload),
      }
      enqueue(request)
      void sendUnreadRequest(options.fetchImpl, url, request.payload).then(
        result => settle(request, result.outcome, result.status, result.error),
        // sendUnreadRequest 自身 never-throw；这一路只是极防御（诊断回调等）。
        error => settle(request, 'retryable', null, error),
      )
    },
    replay() {
      if (replaying !== null) return replaying
      if (entries.size() === 0) return Promise.resolve(0)
      const run = (async (): Promise<number> => {
        let delivered = 0
        // 快照迭代：重放期间新入队的条目留给下一次恢复信号，绝不为清空而自旋
        // （通道仍坏时自旋只会在坏通道上打转）。
        for (const request of [...entries.values()]) {
          if (entries.get(request.key) !== request) continue
          const result = await sendUnreadRequest(options.fetchImpl, request.url, { ...request.payload })
          if (result.outcome === 'ok') delivered += 1
          settle(request, result.outcome, result.status, result.error)
        }
        return delivered
      })()
      const tracked = run.then(
        delivered => { replaying = null; return delivered },
        error => { replaying = null; report(error); return 0 },
      )
      replaying = tracked
      return tracked
    },
    size() { return entries.size() },
    pending() {
      return [...entries.values()].map(entry => ({ ...entry, payload: { ...entry.payload } }))
    },
  }
}
