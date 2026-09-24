/**
 * Desktop notification decision logic (design 19 §3.3) — pure logic, no
 * electron, plain node tests.
 *
 * The main process is the authority for the decision chain: the renderer only
 * detects session edges and assembles a NotificationRequest, then the shell
 * decides whether a native notification is actually shown (settings from
 * chamber-settings.json, dedupe claim, focus state). The Electron side effects
 * (new Notification / click → window focus / notification-open push) are main.ts.
 */

import { INSTANCE_ID_PATTERN } from './transport-provider.ts';
import { describeUnknownError } from './deep-link.ts';
import { randomBytes } from 'node:crypto';

/** 通知事件种类（design 19 §3.2）：complete / ask / request + test（设置页测试按钮）。 */
export type NotificationKind = 'complete' | 'ask' | 'request' | 'test';

/** 渲染端组装的通知请求（design 19 §3.3）——纯非秘密投影。 */
export interface NotificationRequest {
  /** `local` or canonical `dsh-<id>` / `gateway-<id>`; legacy `ssh-<id>`
   * input is normalized to `dsh-<id>` at the privileged boundary. */
  sourceId: string
  /** Exact non-secret registry transport identity captured by the producer. */
  sourceFingerprint: string
  sessionId: string
  kind: NotificationKind
  title: string
  body: string
  /** 正在屏幕上查看的会话（渲染端 document.hasFocus 判定，主进程再查一次作为权威）。 */
  requireHidden: boolean
  /**
   * 内容水位（来源 host 域毫秒——远端取该来源 host 时钟、本地取本地 dsh host
   * 时钟，**不得**用 renderer 墙钟）：同一次事件的两个通知入口必须传同一水位
   * 函数——complete = `completedAt ?? updatedAt`；ask/request = `updatedAt`。
   * 它是去重身份的第五个分量：同水位 = 同一事件合并成一条横幅，同会话下一次
   * 完成水位不同 = 新事件；缺省序列化为 null（不含水位的四元组身份）。
   */
  watermark?: number
}

/** A native-notification click held until the renderer has installed its
 * listener; only the routing coordinates cross back into the renderer. */
export interface NotificationOpenIntent {
  sourceId: string
  /** Exact source proof captured when the native notification was created. */
  sourceFingerprint: string
  sessionId: string
  /** Main-process-only source incarnation; never projected to the renderer. */
  sourceGeneration: number
}

export interface NotificationSourceDescriptor {
  sourceId: string
  fingerprint: string
}

export interface NotificationSourceToken {
  readonly sourceId: string
  readonly fingerprint: string
  readonly generation: number
}

/** Opaque, non-secret main-process lifecycle proof; intentionally unrelated to reusable registry fields. */
export const REMOTE_SOURCE_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/

export interface NotificationSourceProofInstance {
  id: string
  kind: string
  host: string
  user: string | null
  sshPort: number | null
  remotePort: number
}

export type NotificationSourceProofProjection<T extends NotificationSourceProofInstance> = T & {
  sourceFingerprint: string
}

/**
 * Main-memory source proof sidecar (never serialized): a proof survives
 * presentation/service/home edits but rotates when the renderer lifecycle
 * retires; removing an id deletes its entry, so a same-id re-add re-mints.
 */
export class NotificationSourceProofs {
  readonly #current = new Map<string, { identity: string; proof: string }>()
  readonly #mint: () => string

  constructor(mint?: () => string) {
    if (mint !== undefined) {
      this.#mint = mint
      return
    }
    // Acquire entropy once before any registry commit: per-proof minting thereafter cannot fail at a host RNG boundary.
    const namespace = randomBytes(24).toString('hex')
    let generation = 0n
    this.#mint = () => {
      generation += 1n
      return `${namespace}${generation.toString(16).padStart(16, '0')}`
    }
  }

  replaceRemoteInstances<T extends NotificationSourceProofInstance>(
    next: readonly T[],
  ): Array<NotificationSourceProofProjection<T>> {
    const nextSourceIds = new Set(next.map(instance => `${instance.kind}-${instance.id}`))
    for (const sourceId of this.#current.keys()) {
      if (!nextSourceIds.has(sourceId)) this.#current.delete(sourceId)
    }
    return next.map(instance => {
      const sourceId = `${instance.kind}-${instance.id}`
      const identity = JSON.stringify([
        instance.kind,
        instance.host,
        instance.user,
        instance.sshPort,
        instance.remotePort,
      ])
      let current = this.#current.get(sourceId)
      if (current === undefined || current.identity !== identity) {
        const proof = this.#mint()
        if (!REMOTE_SOURCE_FINGERPRINT_PATTERN.test(proof)) {
          throw new Error('source proof mint returned an invalid value')
        }
        current = { identity, proof }
        this.#current.set(sourceId, current)
      }
      return { ...instance, sourceFingerprint: current.proof }
    })
  }

  get activeCount(): number {
    return this.#current.size
  }
}

/** Main-process source lifecycle authority: a removal or transport-identity edit
 * advances the generation, so click closures cannot cross into a same-id replacement. */
export class NotificationSourceIncarnations {
  readonly #current = new Map<string, { fingerprint: string; token: NotificationSourceToken }>()
  #nextGeneration = 1

  constructor() {
    this.#activate('local', 'local')
  }

  #activate(sourceId: string, fingerprint: string): void {
    const token = Object.freeze({ sourceId, fingerprint, generation: this.#nextGeneration })
    this.#nextGeneration += 1
    this.#current.set(sourceId, { fingerprint, token })
  }

  replaceRemoteSources(next: readonly NotificationSourceDescriptor[]): string[] {
    const nextById = new Map(next.map(source => [source.sourceId, source.fingerprint]))
    const retired: string[] = []
    for (const [sourceId, current] of this.#current) {
      if (sourceId === 'local') continue
      const nextFingerprint = nextById.get(sourceId)
      if (nextFingerprint === undefined || nextFingerprint !== current.fingerprint) {
        this.#current.delete(sourceId)
        retired.push(sourceId)
      }
    }
    for (const { sourceId, fingerprint } of next) {
      if (sourceId === 'local') continue
      if (!this.#current.has(sourceId)) this.#activate(sourceId, fingerprint)
    }
    return retired
  }

  capture(sourceId: string): NotificationSourceToken | null {
    const current = this.#current.get(sourceId)
    return current?.token ?? null
  }

  owns(token: NotificationSourceToken): boolean {
    return this.#current.get(token.sourceId)?.token === token
  }

  matches(sourceId: string, fingerprint: string): boolean {
    return this.#current.get(sourceId)?.fingerprint === fingerprint
  }

  /** Hard ownership bound: retired unique ids leave no per-id generation tombstone (includes the permanent local source). */
  get activeCount(): number {
    return this.#current.size
  }
}

export function isValidNotificationSourceFingerprint(sourceId: string, fingerprint: string): boolean {
  return sourceId === 'local'
    ? fingerprint === 'local'
    : REMOTE_SOURCE_FINGERPRINT_PATTERN.test(fingerprint)
}

export const MAX_PENDING_NOTIFICATION_OPENS = 64

/** 通知裁决所用设置子集——从 ChamberSettings.notifications 解耦（测试友好）。 */
export interface NotificationSettingsLike {
  enabled: boolean
  mode: 'hidden-only' | 'always'
  onComplete: boolean
  onAsk: boolean
  onRequest: boolean
}

/**
 * 裁决链（主进程门禁，design 19 §3.3 顺序）：'test' 全部放行 → enabled=false
 * → 'disabled' → kind 开关关闭 → 'kind-off' → requireHidden 且窗口聚焦
 * → 'on-screen' → mode='hidden-only' 且窗口聚焦 → 'focused-hidden-only'
 * → 否则 'show'。'test' 不受 requireHidden 影响。
 *
 * 信任切分：主进程 anyWindowFocused 只回答「是否有窗口聚焦」，不知道用户正在
 * 查看哪个会话——会话级焦点只有渲染端可见，因此 'always' 模式下「正在查看的
 * 会话不打扰」完全依赖渲染端上报的 requireHidden；'hidden-only' 模式下两者
 * 叠加。
 */
export function decideNotification(input: {
  request: NotificationRequest
  settings: NotificationSettingsLike
  anyWindowFocused: boolean
}): { action: 'show' } | { action: 'skip'; reason: string } {
  const { request, settings, anyWindowFocused } = input;
  if (request.kind === 'test') return { action: 'show' };
  if (!settings.enabled) return { action: 'skip', reason: 'disabled' };
  const kindSwitch: Record<'complete' | 'ask' | 'request', boolean> = {
    complete: settings.onComplete,
    ask: settings.onAsk,
    request: settings.onRequest,
  };
  if (!kindSwitch[request.kind]) return { action: 'skip', reason: 'kind-off' };
  if (request.requireHidden && anyWindowFocused) return { action: 'skip', reason: 'on-screen' };
  if (settings.mode === 'hidden-only' && anyWindowFocused) {
    // 'always' 放行聚焦状态：聚焦豁免（被查看会话不打扰）完全依赖渲染端
    // requireHidden，主进程 isAnyWindowFocused 不参与（信任切分见上）。
    return { action: 'skip', reason: 'focused-hidden-only' };
  }
  return { action: 'show' };
}

/** 去重 TTL（OpenChamber 同款）：同 key 5s 内只发一次，防事件风暴/双路径重放双发。 */
export const NOTIFICATION_DEDUPE_TTL_MS = 5_000;
export const MAX_NOTIFICATION_CLAIMS = 64;
// A reconnect may legitimately surface several independent sessions at once,
// but native banners stop being useful well before dozens per second: eight
// attempts per 5s bounds a compromised same-origin renderer to 1.6/s.
export const MAX_NATIVE_NOTIFICATION_SHOWS_PER_WINDOW = 8;
export const NATIVE_NOTIFICATION_RATE_WINDOW_MS = 5_000;
// Native notifications outlive the rate window; their Electron object/OS-listener ownership is bounded separately.
export const MAX_ACTIVE_NATIVE_NOTIFICATIONS = 16;
export const NATIVE_NOTIFICATION_OUTCOME_TIMEOUT_MS = 5_000;

export interface NotificationClaimToken {
  readonly key: string
  readonly claimedAt: number
}

export type NotificationClaimResult =
  | { accepted: true; token: NotificationClaimToken | null }
  | { accepted: false; reason: 'duplicate' | 'saturated' }

/** Hard-bounded, amortized-O(1) TTL claim table: the chronological queue is compacted at a bounded threshold and no accept scans the whole Map. */
export class NotificationClaimWindow {
  readonly #limit: number
  readonly #ttlMs: number
  readonly #claims = new Map<string, NotificationClaimToken>()
  #order: NotificationClaimToken[] = []
  #head = 0

  constructor(limit = MAX_NOTIFICATION_CLAIMS, ttlMs = NOTIFICATION_DEDUPE_TTL_MS) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('notification claim limit must be a positive integer')
    if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new RangeError('notification claim TTL must be positive')
    this.#limit = limit
    this.#ttlMs = ttlMs
  }

  #prune(now: number): void {
    while (this.#head < this.#order.length) {
      const oldest = this.#order[this.#head]
      // Released/superseded tokens are tombstones: skip them even before TTL, or one live oldest claim pins arbitrary churn behind it.
      if (this.#claims.get(oldest.key) !== oldest) {
        this.#head += 1
        continue
      }
      if (now - oldest.claimedAt < this.#ttlMs) break
      this.#claims.delete(oldest.key)
      this.#head += 1
    }
  }

  /** Release is O(1), so middle tombstones can linger behind a live head. The
   * fixed compaction threshold keeps the scan amortized O(1) and backing storage
   * below 2*limit between calls. */
  #compactIfNeeded(): void {
    if (this.#order.length < this.#limit * 2 && this.#head < this.#limit) return
    this.#order = this.#order
      .slice(this.#head)
      .filter(token => this.#claims.get(token.key) === token)
    this.#head = 0
  }

  claim(request: NotificationRequest, now: number = Date.now()): NotificationClaimResult {
    if (request.kind === 'test') return { accepted: true, token: null }
    this.#prune(now)
    // Identity = sourceId + source proof + sessionId + kind + watermark: a
    // newly-created same-id host must not inherit an old incarnation's dedupe
    // claim, the two entries (shell channel / gateway facts) collapse to one
    // banner on the same completion, and ask/complete at one watermark must not
    // swallow each other. An omitted watermark serializes as `null`.
    const key = JSON.stringify([
      request.sourceId,
      request.sourceFingerprint,
      request.sessionId,
      request.kind,
      request.watermark ?? null,
    ])
    const existing = this.#claims.get(key)
    if (existing !== undefined && now - existing.claimedAt < this.#ttlMs) {
      return { accepted: false, reason: 'duplicate' }
    }
    if (this.#claims.size >= this.#limit) return { accepted: false, reason: 'saturated' }
    const token = Object.freeze({ key, claimedAt: now })
    this.#claims.set(key, token)
    this.#order.push(token)
    this.#compactIfNeeded()
    return { accepted: true, token }
  }

  /** O(1) release when native construction/show fails. Object identity — not a
   * timestamp — stops a delayed failure erasing a newer same-key claim. */
  release(token: NotificationClaimToken | null): void {
    if (token === null || this.#claims.get(token.key) !== token) return
    this.#claims.delete(token.key)
  }

  get size(): number {
    return this.#claims.size
  }

  /** Testable storage invariant; includes bounded tombstones awaiting prune. */
  get backingCount(): number {
    return this.#order.length
  }
}

const notificationClaims = new NotificationClaimWindow();

/** 去重 claim（同 OpenChamber）：同 key 在 TTL 内第二次返回 false，TTL 过后恢复；'test' 不走 claim（恒 true）。 */
export function claimNotificationDetailed(request: NotificationRequest, now: number = Date.now()): NotificationClaimResult {
  return notificationClaims.claim(request, now)
}

export function releaseNotificationClaim(token: NotificationClaimToken | null): void {
  notificationClaims.release(token)
}

/** Fixed-cap sliding window shared by all native show attempts including 'test'; bounded chronological array, never scans. */
export class BoundedRateLimiter {
  readonly #limit: number
  readonly #windowMs: number
  #timestamps: number[] = []
  #head = 0

  constructor(limit = MAX_NATIVE_NOTIFICATION_SHOWS_PER_WINDOW, windowMs = NATIVE_NOTIFICATION_RATE_WINDOW_MS) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('rate limit must be a positive integer')
    if (!Number.isFinite(windowMs) || windowMs < 1) throw new RangeError('rate window must be positive')
    this.#limit = limit
    this.#windowMs = windowMs
  }

  tryAcquire(now: number = Date.now()): boolean {
    while (this.#head < this.#timestamps.length && now - this.#timestamps[this.#head] >= this.#windowMs) this.#head += 1
    if (this.#timestamps.length - this.#head >= this.#limit) return false
    this.#timestamps.push(now)
    if (this.#head >= this.#limit) {
      this.#timestamps = this.#timestamps.slice(this.#head)
      this.#head = 0
    }
    return true
  }

  get size(): number {
    return this.#timestamps.length - this.#head
  }
}

/**
 * 活跃原生通知的有界登记（design 19 §3.3 项 7）：上界约束的是为保住 click 监听
 * 而持有的存活引用/OS 监听器，不是投递配额。满员不拒发——macOS 横幅进入通知
 * 中心后不触发 close，拒发会让存量横幅永久卡死通知流；改为按插入序淘汰最旧一条
 * 交调用方退役，硬上界不变，仅最旧条目的 click 随之失效。
 */
export class BoundedActiveNotifications<T> {
  readonly #limit: number
  readonly #current = new Map<T, NotificationSourceToken | null>()

  constructor(limit = MAX_ACTIVE_NATIVE_NOTIFICATIONS) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('active notification limit must be a positive integer')
    }
    this.#limit = limit
  }

  /** 登记一条活跃通知；满员先按插入序淘汰最旧一条并返回它（调用方负责退役）
   *  ——永不因满员拒发；同一 item 重复登记 no-op（返回 null）。 */
  add(item: T, token: NotificationSourceToken | null): T | null {
    if (this.#current.has(item)) return null
    let evicted: T | null = null
    if (this.#current.size >= this.#limit) {
      const oldest = this.#current.keys().next()
      if (oldest.done !== true) {
        evicted = oldest.value
        this.#current.delete(evicted)
      }
    }
    this.#current.set(item, token)
    return evicted
  }

  delete(item: T): void {
    this.#current.delete(item)
  }

  has(item: T): boolean {
    return this.#current.has(item)
  }

  /** 存活条目（插入序）。调用方可边迭代边 delete（Map 迭代语义安全）。 */
  entries(): IterableIterator<[T, NotificationSourceToken | null]> {
    return this.#current.entries()
  }

  get size(): number {
    return this.#current.size
  }
}

export interface NativeNotificationLike {
  on(event: 'show' | 'failed' | 'close', listener: (...args: unknown[]) => void): unknown
  removeListener(event: 'show' | 'failed' | 'close', listener: (...args: unknown[]) => void): unknown
  show(): void
  close(): void
}

/** The machine-readable half of an honest-show failure: only `failed` (OS
 *  scheduling error) and `timed-out` are host-platform evidence; `threw`/
 *  `closed` are local artifacts and must never be described as an OS refusal. */
export type NativeNotificationFailureReason = 'threw' | 'failed' | 'closed' | 'timed-out'

export interface NativeNotificationFailure {
  shown: false
  error: string
  reason: NativeNotificationFailureReason
}

/** Electron Notification.show() is void and may emit `failed` later. Settle
 * true only on the native `show` event; synchronous throw, failed, early close
 * and timeout are honest false results and can release the dedupe claim. */
export function showNativeNotificationHonestly(
  notification: NativeNotificationLike,
  timeoutMs = NATIVE_NOTIFICATION_OUTCOME_TIMEOUT_MS,
): Promise<{ shown: true } | NativeNotificationFailure> {
  return new Promise(resolve => {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const cleanup = () => {
      try { notification.removeListener('show', onShow) } catch { /* hostile host adapter */ }
      try { notification.removeListener('failed', onFailed) } catch { /* hostile host adapter */ }
      try { notification.removeListener('close', onClose) } catch { /* hostile host adapter */ }
      if (timer !== null) clearTimeout(timer)
    }
    const settle = (result: { shown: true } | NativeNotificationFailure) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const onShow = () => settle({ shown: true })
    const onFailed = (...args: unknown[]) => {
      const error = args.length >= 2 ? args[1] : args[0]
      settle({ shown: false, error: describeUnknownError(error), reason: 'failed' })
    }
    const onClose = () => settle({ shown: false, error: 'notification closed before show', reason: 'closed' })
    try {
      notification.on('show', onShow)
      if (settled) return
      notification.on('failed', onFailed)
      if (settled) return
      notification.on('close', onClose)
      if (settled) return
    } catch (error) {
      settle({ shown: false, error: `notification listener setup failed: ${describeUnknownError(error)}`, reason: 'threw' })
      return
    }
    timer = setTimeout(() => {
      settle({ shown: false, error: 'notification show timed out', reason: 'timed-out' })
      try { notification.close() } catch { /* best-effort cancellation */ }
    }, timeoutMs)
    try {
      notification.show()
    } catch (error) {
      settle({ shown: false, error: describeUnknownError(error), reason: 'threw' })
    }
  })
}

/**
 * macOS 授权状态在 Electron 侧只经通知投递的 completion handler 回话（error →
 * failed 事件，成功 → show 事件），没有查询/申请 API。因此「OS 明确拒绝投递」
 * 与「限时内无回执」只能表述为「可能未授权 / 可能被系统抑制」并保留 OS 原文，
 * 绝不冒充已授权。非 darwin 原样返回（Windows 的 failed 是投递错误）。
 */
export function describeNativeNotificationFailure(
  platform: string,
  reason: NativeNotificationFailureReason | undefined,
  detail: string,
): string {
  const text = detail.trim() === '' ? 'no detail' : detail
  if (platform !== 'darwin') return text
  if (reason === 'failed') {
    return `macOS refused to deliver the notification (notification authorization may be denied — check System Settings > Notifications): ${text}`
  }
  if (reason === 'timed-out') {
    return `macOS did not confirm notification delivery within the bounded window (authorization may be denied, or Focus/Do Not Disturb suppresses banners): ${text}`
  }
  return text
}

/** 把 Swift 宿主腿的 showNativeNotification 应答折成 honest-show 结果：
 *  `null`/`undefined`（旧线协议，edge ok 即已调度）→ shown:true；`{shown:true}`
 *  → 成功；`{shown:false,error?}` → false，core 据此释放 5s 去重 claim，不把
 *  「edge 传输成功」当「横幅已显示」；其他形状（数组/数字/无 shown）不予采信
 *  → shown:false。Swift 侧须在授权检查失败/调度超时时回 {shown:false,error}。 */
export function interpretNativeNotificationReply(
  reply: unknown,
): { shown: true } | { shown: false; error: string } {
  if (reply === null || reply === undefined) return { shown: true };
  if (typeof reply === 'object' && !Array.isArray(reply)) {
    const record = reply as { shown?: unknown; error?: unknown };
    if (record.shown === true) return { shown: true };
    if (record.shown === false) {
      return {
        shown: false,
        error: typeof record.error === 'string' && record.error.length > 0
          ? record.error
          : 'native notification was not shown',
      };
    }
  }
  return { shown: false, error: 'native notification leg returned an unrecognized outcome' };
}

export function shouldFocusApplicationBeforeShowing(platform: string): boolean {
  return platform === 'darwin'
}

/** 字段长度上限（防异常 title/body 刷屏）：sourceId 另受 local | dsh-<id> |
 *  gateway-<id>（及 legacy ssh- alias）语义白名单约束。 */
const MAX_SOURCE_ID_LENGTH = 256;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 512;

const NOTIFICATION_KINDS: ReadonlySet<string> = new Set(['complete', 'ask', 'request', 'test']);

/** Normalize the one documented v1 alias before lifecycle-proof lookup:
 *  `ssh-<id>` can only name the canonical dsh target for the same validated
 *  registry id; new/future prefixes remain fail-closed. */
function canonicalNotificationSourceId(sourceId: string): string | null {
  if (sourceId === 'local') return sourceId;
  for (const prefix of ['dsh-', 'gateway-'] as const) {
    if (!sourceId.startsWith(prefix)) continue;
    const rawId = sourceId.slice(prefix.length);
    return INSTANCE_ID_PATTERN.test(rawId) ? sourceId : null;
  }
  if (sourceId.startsWith('ssh-')) {
    const rawId = sourceId.slice(4);
    return INSTANCE_ID_PATTERN.test(rawId) ? `dsh-${rawId}` : null;
  }
  return null;
}

/**
 * IPC payload 白名单校验：sourceId/sessionId/title/body 为非空 string（前三个
 * ≤256、body ≤512），sourceId 只能是 local 或 canonical `dsh-<id>` /
 * `gateway-<id>`（`ssh-<id>` 规范化为 `dsh-<id>`）；kind 四选一、requireHidden
 * 为 boolean；watermark 为非负安全整数且缺省保持字段缺席（校验后的 request 与
 * 缺省输入逐字段一致）；未知/多余字段忽略。
 */
export function validateNotificationRequest(
  raw: unknown,
): { ok: true; request: NotificationRequest } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'notification payload must be an object' };
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.sourceId !== 'string' || record.sourceId === '') {
    return { ok: false, error: 'sourceId must be a non-empty string' };
  }
  if (record.sourceId.length > MAX_SOURCE_ID_LENGTH) {
    return { ok: false, error: `sourceId is too long (max ${MAX_SOURCE_ID_LENGTH})` };
  }
  const sourceId = canonicalNotificationSourceId(record.sourceId);
  if (sourceId === null) {
    return { ok: false, error: 'sourceId must be "local", "dsh-<registry id>", or "gateway-<registry id>"' };
  }
  if (
    typeof record.sourceFingerprint !== 'string'
    || !isValidNotificationSourceFingerprint(sourceId, record.sourceFingerprint)
  ) {
    return { ok: false, error: 'sourceFingerprint must be "local" for local or a 64-character lowercase hex remote proof' };
  }
  if (typeof record.sessionId !== 'string') {
    return { ok: false, error: 'sessionId must be a string' };
  }
  if (record.sessionId.length > MAX_SESSION_ID_LENGTH) {
    return { ok: false, error: `sessionId is too long (max ${MAX_SESSION_ID_LENGTH})` };
  }
  if (typeof record.kind !== 'string' || !NOTIFICATION_KINDS.has(record.kind)) {
    return { ok: false, error: 'kind must be one of "complete" | "ask" | "request" | "test"' };
  }
  // sessionId 非空仅对真实会话事件生效：'test' 没有会话上下文，允许空串（click 处理必须跳过 test 的打开会话路径）。
  if (record.sessionId === '' && record.kind !== 'test') {
    return { ok: false, error: 'sessionId must be a non-empty string' };
  }
  if (typeof record.title !== 'string' || record.title === '') {
    return { ok: false, error: 'title must be a non-empty string' };
  }
  if (record.title.length > MAX_TITLE_LENGTH) {
    return { ok: false, error: `title is too long (max ${MAX_TITLE_LENGTH})` };
  }
  if (typeof record.body !== 'string' || record.body === '') {
    return { ok: false, error: 'body must be a non-empty string' };
  }
  if (record.body.length > MAX_BODY_LENGTH) {
    return { ok: false, error: `body is too long (max ${MAX_BODY_LENGTH})` };
  }
  if (typeof record.requireHidden !== 'boolean') {
    return { ok: false, error: 'requireHidden must be a boolean' };
  }
  // 可选内容水位：必须是非负安全整数（结构化克隆可携带 NaN/Infinity/分数/
  // 字符串，一律响亮拒绝——水位进去重身份，悄悄归一反而造出假事件）。
  let watermark: number | undefined;
  if (record.watermark !== undefined) {
    if (
      typeof record.watermark !== 'number'
      || !Number.isSafeInteger(record.watermark)
      || record.watermark < 0
    ) {
      return { ok: false, error: 'watermark must be a non-negative safe integer when present' };
    }
    watermark = record.watermark;
  }
  return {
    ok: true,
    request: {
      sourceId,
      sourceFingerprint: record.sourceFingerprint,
      sessionId: record.sessionId,
      kind: record.kind as NotificationKind,
      title: record.title,
      body: record.body,
      requireHidden: record.requireHidden,
      ...(watermark === undefined ? {} : { watermark }),
    },
  };
}
