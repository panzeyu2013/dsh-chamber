/**
 * Desktop notification decision logic (design 19 §3.3) — pure logic, no
 * electron, unit-testable with plain node:test (see notifications.test.ts).
 *
 * The main process (main.ts) is the authority for the decision chain: the
 * renderer only detects session edges and assembles a NotificationRequest,
 * then the desktop shell decides whether a native notification is actually
 * shown (settings from chamber-settings.json, dedupe claim, focus state).
 * The Electron side effects (new Notification / click → window focus /
 * notification-open push) live in main.ts.
 */

import { INSTANCE_ID_PATTERN } from './transport-provider.ts';
import { describeUnknownError } from './deep-link.ts';
import { randomBytes } from 'node:crypto';

/** 通知事件种类（design 19 §3.2）：complete / ask / request + test（设置页测试按钮）。 */
export type NotificationKind = 'complete' | 'ask' | 'request' | 'test';

/** 渲染端组装的通知请求（design 19 §3.3）——纯非秘密投影。 */
export interface NotificationRequest {
  /** 'local' | 'ssh-<id>' */
  sourceId: string
  /** Exact non-secret registry transport identity captured by the producer. */
  sourceFingerprint: string
  sessionId: string
  kind: NotificationKind
  title: string
  body: string
  /** 正在屏幕上查看的会话（渲染端 document.hasFocus 判定，主进程再查一次作为权威）。 */
  requireHidden: boolean
}

/** A native-notification click held until the renderer has installed its
 * listener. Kept separate from NotificationRequest because only the routing
 * coordinates cross back into the renderer. */
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

/** Opaque, non-secret main-process lifecycle proof projected to the renderer.
 * It is intentionally unrelated to reusable registry fields. */
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
 * Main-memory source proof sidecar. A proof survives presentation/service/home
 * edits, but rotates when the renderer lifecycle retires (delete or transport
 * identity edit). Removing an id deletes its entry, so a byte-for-byte same-id
 * re-add still receives a fresh proof. The sidecar is never serialized.
 */
export class NotificationSourceProofs {
  readonly #current = new Map<string, { identity: string; proof: string }>()
  readonly #mint: () => string

  constructor(mint?: () => string) {
    if (mint !== undefined) {
      this.#mint = mint
      return
    }
    // Acquire entropy once before any registry commit can occur. Per-proof
    // generation thereafter cannot fail at a host RNG boundary.
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

/** Main-process source lifecycle authority. A removal or transport-identity
 * edit advances the generation, so native Notification click closures and
 * held opens cannot cross into a same-id replacement. */
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

  /** Test seam for the hard ownership bound: retired unique ids leave no
   * per-id generation tombstone behind. Includes the permanent local source. */
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
 * 裁决链（主进程门禁，design 19 §3.3 顺序）：
 * 1. kind==='test' 直接放行（绕过全部设置门禁——设置页「发送测试通知」）；
 * 2. enabled === false → skip 'disabled'；
 * 3. kind 对应事件开关（complete→onComplete / ask→onAsk / request→onRequest）
 *    关闭 → skip 'kind-off'；
 * 4. requireHidden === true 且窗口聚焦 → skip 'on-screen'（正在查看的会话不打扰）；
 * 5. mode === 'hidden-only' 且窗口聚焦 → skip 'focused-hidden-only'
 *    （'always' 放行聚焦状态）；
 * 6. 否则 'show'。
 * 'test' 不受 requireHidden 影响（绕过全部门禁）。
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
    return { action: 'skip', reason: 'focused-hidden-only' };
  }
  return { action: 'show' };
}

/** 去重 TTL（OpenChamber 同款）：同 key 5s 内只发一次，防事件风暴/双路径重放双发。 */
export const NOTIFICATION_DEDUPE_TTL_MS = 5_000;
export const MAX_NOTIFICATION_CLAIMS = 64;
// A reconnect may legitimately surface several independent sessions at once,
// but native banners cease to be useful well before dozens per second. Eight
// attempts per 5s preserves a modest multi-source burst while bounding a
// compromised same-origin renderer to 1.6 show attempts/second.
export const MAX_NATIVE_NOTIFICATION_SHOWS_PER_WINDOW = 8;
export const NATIVE_NOTIFICATION_RATE_WINDOW_MS = 5_000;
// Native notifications may outlive the rate window. Keep their Electron
// object/OS-listener ownership separately bounded across successive windows.
export const MAX_ACTIVE_NATIVE_NOTIFICATIONS = 16;
export const NATIVE_NOTIFICATION_OUTCOME_TIMEOUT_MS = 5_000;

export interface NotificationClaimToken {
  readonly key: string
  readonly claimedAt: number
}

export type NotificationClaimResult =
  | { accepted: true; token: NotificationClaimToken | null }
  | { accepted: false; reason: 'duplicate' | 'saturated' }

/** A hard-bounded, amortized-O(1) TTL claim table. The chronological queue is
 * compacted at a bounded threshold; no accepted request scans the whole Map. */
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
      // Released/superseded tokens are tombstones. Skip them even before TTL;
      // otherwise one live oldest claim could pin arbitrary churn behind it.
      if (this.#claims.get(oldest.key) !== oldest) {
        this.#head += 1
        continue
      }
      if (now - oldest.claimedAt < this.#ttlMs) break
      this.#claims.delete(oldest.key)
      this.#head += 1
    }
  }

  /** Release is O(1), so middle tombstones can temporarily remain behind a
   * live head. Compact at a fixed threshold: the scan is O(limit) and happens
   * only after O(limit) churn, keeping amortized work O(1) and backing storage
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
    // The opaque source proof is part of event identity: a newly-created
    // same-id host must not inherit an old incarnation's 5s dedupe claim.
    const key = JSON.stringify([request.sourceId, request.sourceFingerprint, request.sessionId, request.kind])
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

  /** O(1) release when native construction/show fails. Object identity—not a
   * millisecond timestamp—prevents a delayed failure from erasing a newer
   * same-key claim minted in the same clock tick. */
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

/**
 * 去重 claim（与 OpenChamber 同款）：同 key 在 TTL 内第二次返回 false；
 * TTL 过后恢复可发；不同 key 互不影响。'test' 不走 claim（恒 true——测试按钮
 * 连点每次都应真实显示）。顺手清理过期条目，map 按 TTL 窗口保持有界。
 */
export function claimNotificationDetailed(request: NotificationRequest, now: number = Date.now()): NotificationClaimResult {
  return notificationClaims.claim(request, now)
}

/** Compatibility boolean used by the pure dedupe tests. Main uses the
 * detailed result so saturation is distinguishable and loud. */
export function claimNotification(request: NotificationRequest, now: number = Date.now()): boolean {
  return claimNotificationDetailed(request, now).accepted
}

export function releaseNotificationClaim(token: NotificationClaimToken | null): void {
  notificationClaims.release(token)
}

/** Fixed-cap sliding window shared by all native show attempts, including
 * `kind:'test'`. It uses a bounded chronological array and never scans claims. */
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

export interface NativeNotificationLike {
  on(event: 'show' | 'failed' | 'close', listener: (...args: unknown[]) => void): unknown
  removeListener(event: 'show' | 'failed' | 'close', listener: (...args: unknown[]) => void): unknown
  show(): void
  close(): void
}

/** Electron Notification.show() is void and may emit `failed` later. Settle
 * true only on the native `show` event; synchronous throw, failed, early close
 * and timeout are honest false results and can release the dedupe claim. */
export function showNativeNotificationHonestly(
  notification: NativeNotificationLike,
  timeoutMs = NATIVE_NOTIFICATION_OUTCOME_TIMEOUT_MS,
): Promise<{ shown: true } | { shown: false; error: string }> {
  return new Promise(resolve => {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const cleanup = () => {
      try { notification.removeListener('show', onShow) } catch { /* hostile host adapter */ }
      try { notification.removeListener('failed', onFailed) } catch { /* hostile host adapter */ }
      try { notification.removeListener('close', onClose) } catch { /* hostile host adapter */ }
      if (timer !== null) clearTimeout(timer)
    }
    const settle = (result: { shown: true } | { shown: false; error: string }) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const onShow = () => settle({ shown: true })
    const onFailed = (...args: unknown[]) => {
      const error = args.length >= 2 ? args[1] : args[0]
      settle({ shown: false, error: describeUnknownError(error) })
    }
    const onClose = () => settle({ shown: false, error: 'notification closed before show' })
    try {
      notification.on('show', onShow)
      if (settled) return
      notification.on('failed', onFailed)
      if (settled) return
      notification.on('close', onClose)
      if (settled) return
    } catch (error) {
      settle({ shown: false, error: `notification listener setup failed: ${describeUnknownError(error)}` })
      return
    }
    timer = setTimeout(() => {
      settle({ shown: false, error: 'notification show timed out' })
      try { notification.close() } catch { /* best-effort cancellation */ }
    }, timeoutMs)
    try {
      notification.show()
    } catch (error) {
      settle({ shown: false, error: describeUnknownError(error) })
    }
  })
}

export function shouldFocusApplicationBeforeShowing(platform: string): boolean {
  return platform === 'darwin'
}

/** Exception-safe Electron boolean adapter boundary (focus/support probes). */
export function readNotificationHostBoolean(read: () => unknown):
  | { ok: true; value: boolean }
  | { ok: false; error: string } {
  try {
    const value = read()
    return typeof value === 'boolean'
      ? { ok: true, value }
      : { ok: false, error: 'notification host probe returned a non-boolean value' }
  } catch (error) {
    return { ok: false, error: describeUnknownError(error) }
  }
}

/** 字段长度上限（防异常 title/body 刷屏，design 19 §3.6）。sourceId 另受
 * local | ssh-<registry id> 语义白名单约束。 */
const MAX_SOURCE_ID_LENGTH = 256;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 512;

const NOTIFICATION_KINDS: ReadonlySet<string> = new Set(['complete', 'ask', 'request', 'test']);

/**
 * IPC payload 白名单校验（design 19 §3.6）：sourceId/sessionId/title/body 必须
 * 为非空 string（前三个 ≤256、body ≤512），sourceId 只能是保留的 local 或
 * `ssh-${registryId}`（registryId 复用 INSTANCE_ID_PATTERN），kind 四选一、
 * requireHidden 为 boolean。未知/多余字段忽略（校验只做白名单必要字段，
 * 不做全等断言）。
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
  if (
    record.sourceId !== 'local'
    && (!record.sourceId.startsWith('ssh-') || !INSTANCE_ID_PATTERN.test(record.sourceId.slice(4)))
  ) {
    return { ok: false, error: 'sourceId must be "local" or "ssh-<registry id>"' };
  }
  if (
    typeof record.sourceFingerprint !== 'string'
    || !isValidNotificationSourceFingerprint(record.sourceId, record.sourceFingerprint)
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
  // sessionId 非空要求仅对真实会话事件生效：'test'（设置页测试按钮）没有会话
  // 上下文，允许空串——但 click 处理必须跳过 test 的打开会话路径（main.ts）。
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
  return {
    ok: true,
    request: {
      sourceId: record.sourceId,
      sourceFingerprint: record.sourceFingerprint,
      sessionId: record.sessionId,
      kind: record.kind as NotificationKind,
      title: record.title,
      body: record.body,
      requireHidden: record.requireHidden,
    },
  };
}
