/**
 * The ONE notification-run identity resolver (D1/I1).
 *
 * Every consumer that needs to say "this delivery belongs to run X" - the outbox
 * key, the complete ledger, the runtime hooks - calls this function, so a run
 * cannot acquire two ids. Precedence: an explicit run id > the host's turn seq
 * (host family) > the chamber namespace keyed by the observed watermark episode.
 * The two families never compare or merge (see dsh-stream-state/run-id).
 */
import { chamberRunId, hostRunId, parseChamberRunId, type SessionRunId } from '@dsh-chamber/dsh-stream-state'
import { isWatermark } from './watermark.ts'

/** The decoded host key of a `host:<key>` id, or null when it is malformed. */
function hostKey(runId: SessionRunId): string | null {
  if (!runId.startsWith('host:')) return null
  const encoded = runId.slice('host:'.length)
  if (encoded.length === 0) return null
  try {
    const decoded = decodeURIComponent(encoded)
    // Canonical round-trip only: a corrupt `host:%` throws, a non-canonical
    // encoding (`%2f` vs `%2F`) is rejected instead of becoming a second id.
    return encodeURIComponent(decoded) === encoded ? decoded : null
  } catch {
    return null
  }
}

/**
 * The restore boundary for a persisted run identity: a chamber id must parse, a
 * host id must decode canonically, and the v4 sentinel is the one allowed
 * non-run value. Anything else (truncated JSON survivor, hand-edited storage) is
 * rejected at load time so a corrupt string cannot reach the identity table.
 */
export function isSessionRunId(value: unknown): value is SessionRunId {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false
  if (value === LEGACY_NOTIFIED_RUN_ID) return true
  if (value.startsWith('chamber:')) {
    const parts = parseChamberRunId(value)
    if (parts === null || parts.generation < 0 || parts.episode < 0) return false
    // Canonical round-trip per component: `s%31` parses equal to `s1`, so a
    // corrupt stored id could otherwise suppress the live run it looks like.
    return value.slice('chamber:'.length).split(':').every(part => {
      try {
        return encodeURIComponent(decodeURIComponent(part)) === part
      } catch {
        return false
      }
    })
  }
  if (value.startsWith('host:')) return hostKey(value) !== null
  return false
}

/**
 * The v4 migration sentinel stored in the identity table for a session that was
 * already notified before the identity spine existed. It never equals a live run
 * id, so the live identity gate (notifiedRun === runId) lets such a session
 * deliver exactly one notification after the upgrade instead of silently
 * suppressing it; the sentinel is replaced by the live id on that write (or
 * dropped when the session leaves the list).
 */
export const LEGACY_NOTIFIED_RUN_ID = 'legacy:notified'

export interface NotificationIdentityInput {
  readonly sourceFingerprint: string
  readonly sessionId: string
  /** Event kind; ask/request cannot reuse an anonymous identity across events. */
  readonly kind?: 'complete' | 'ask' | 'request'
  readonly runId?: SessionRunId
  readonly completionSeq?: number
  readonly watermark?: number
}

/** 页代判别符：53 位安全整数（21 高位 + 32 低位；`chamberRunId` 以十进制存、`isSessionRunId` 要求
 *  安全非负整数），跨页必不同、页内稳定。墙钟两条都不满足（同毫秒两次加载会撞、NTP 会回拨），故取自
 *  CSPRNG 一次抽取——消费方都在有 `globalThis.crypto` 的宿主（renderer / Node 24 测试），缺失即模块加载
 *  期失败，不做事后兜底。 */
function createPageGeneration(): number {
  const words = new Uint32Array(2)
  globalThis.crypto.getRandomValues(words)
  const high = words[0] ?? 0
  const low = words[1] ?? 0
  const raw = (high % 0x20_0000) * 0x1_0000_0000 + low
  // 0 是水位族的**保留** generation（`isSessionRunId` 只要求安全非负整数；旧的共享常量身份已删）：抽到 0 的概率是
  // 2⁻⁵³，但归一到 1 让「页代 ≥ 1」成为精确性质，而不是一条概率性断言。
  return raw === 0 ? 1 : raw
}

const PAGE_GENERATION = createPageGeneration()
/** 页内事件计数：与页代一起保证同页两次 ask 是两个身份。 */
let localEventSequence = 0

/**
 * 身份**来源**（只读诊断，W2 读数面）：identity 由哪条分支产出，便于把「幻影通知 / 静默漏发」
 * 直接归因到分支——`host-turn` = 宿主事件 id（目标形态）；`event-nonce` = 无 host 域判别符时的
 * 页内事件计数 + CSPRNG 页代（ask/request 与无锚完成共用同一形状，时钟已移除）；
 * `watermark` = 用提示水位当 episode；`run-id` = 调用方已持有的运行身份（回执/重放路径原样回写）。
 *
 * 已移除 `constant`：无判别符时的"同会话共享常量身份"会让两次物理完成共用一个 outbox key 与
 * 一条 durable receipt，第二条被宿主按"已显示"静默吞掉——这是漏发，不是去重。
 */
export type NotificationIdentitySource = 'run-id' | 'host-turn' | 'event-nonce' | 'watermark'

export function notificationIdentityOf(
  input: NotificationIdentityInput,
): { runId: SessionRunId; source: NotificationIdentitySource } {
  if (input.runId !== undefined && input.runId.length > 0) return { runId: input.runId, source: 'run-id' }
  if (typeof input.completionSeq === 'number' && Number.isSafeInteger(input.completionSeq)
      && input.completionSeq >= 0) {
    return { runId: hostRunId('turn/' + String(input.completionSeq)), source: 'host-turn' }
  }
  // A question/approval is a NEW event every time, never a re-observation. The
  // content watermark (last user prompt) does NOT advance for a second approval or
  // question in the same run, so using it as the episode made two real prompts share
  // one outbox key and one durable receipt: the second was silently dropped. Ask and
  // request therefore get the per-event nonce unconditionally.
  if (input.kind === 'ask' || input.kind === 'request') {
    localEventSequence += 1
    return {
      runId: chamberRunId({
        sourceFingerprint: input.sourceFingerprint,
        generation: PAGE_GENERATION,
        sessionId: input.sessionId,
        episode: localEventSequence,
      }),
      source: 'event-nonce',
    }
  }
  if (isWatermark(input.watermark)) {
    return {
      runId: chamberRunId({
        sourceFingerprint: input.sourceFingerprint,
        generation: 0,
        sessionId: input.sessionId,
        episode: input.watermark,
      }),
      source: 'watermark',
    }
  }
  // 无任何 host 域判别符（既无调用方身份，也无 seq / 水位 episode）。此处**不得**退化成
  // 「同会话共享一个常量身份」：常量下两次物理完成共用一个 outbox key 与一条 durable
  // receipt，宿主对第二条回 `shown:true` 而**不显示**——静默漏发。ask/request 早在同一分支
  // 上踩到过这个形状（注释见上），完成同样适用：唯一性优先于跨通道可去重，两次无锚完成
  // 最多各发一条，绝不互相吞。有锚的完成不走这里——宿主 turn/end 的 seq 在 host-turn 分支
  // 产出与 facts 通道同值的稳定身份，跨通道幂等由身份相等保证。
  localEventSequence += 1
  return {
    runId: chamberRunId({
      sourceFingerprint: input.sourceFingerprint,
      generation: PAGE_GENERATION,
      sessionId: input.sessionId,
      episode: localEventSequence,
    }),
    source: 'event-nonce',
  }
}

/** 兼容包装：只取身份字符串（行为与分支顺序与 {@link notificationIdentityOf} 逐字一致）。 */
export function notificationRunId(input: NotificationIdentityInput): SessionRunId {
  return notificationIdentityOf(input).runId
}
