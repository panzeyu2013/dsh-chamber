/**
 * 页代 token（v5 §3.5，R2-E）：区分「同页 reload」与「新进程/新窗口」。
 *
 * WHY：localStorage 的 pending 是跨启动 durable 的，但 reload 与新进程在
 * localStorage 里同形，无法判别。sessionStorage 的生命周期恰好对齐「页会话」：
 * 同 tab reload 保留，新进程/新窗口为空——因此首帧写入一个随机 token，加载时
 * 读到同 token = reload（保留 pending/outcomes），读不到 = fresh（丢弃 pending
 * 并 loud；notified/outcomes 仍 durable）。
 *
 * 本模块 only 判定 + 读写 token，不做 pending 处置：处置在
 * complete-ledger.createCompleteLedger({ boot })。
 *
 * never-throw：sessionStorage 在私有模式/配额/被禁用时可能抛，此时降级为
 * 内存 token 并判 fresh（宁可多丢一次 pending，不可打断启动）。
 */

/** sessionStorage 页代 token 键。 */
export const BOOT_TOKEN_KEY = 'dsh-chamber.boot-token.v1'

/** Storage 的结构子集（浏览器 sessionStorage 或测试假实现）。 */
export interface BootTokenStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** same = 同页 reload；fresh = 新进程/新窗口（或 storage 不可用）。 */
export type BootVerdict = 'same' | 'fresh'

export interface BootTokenReading {
  token: string
  verdict: BootVerdict
}

interface CryptoLike {
  randomUUID?: () => string
  getRandomValues?: (array: Uint8Array) => Uint8Array
}

/** 合法 token：非空字符串（上限防御性截断判定，不臆造内容）。 */
export function isBootToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

/** 生成一次性页代 token：randomUUID → getRandomValues hex → Math.random 兜底。 */
export function createBootToken(cryptoImpl?: CryptoLike): string {
  const cryptoValue = cryptoImpl ?? (globalThis.crypto as CryptoLike | undefined)
  try {
    const uuid = cryptoValue?.randomUUID?.()
    if (isBootToken(uuid)) return uuid
  } catch { /* fall through */ }
  try {
    if (cryptoValue?.getRandomValues !== undefined) {
      const bytes = cryptoValue.getRandomValues(new Uint8Array(16))
      let hex = ''
      for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
      if (isBootToken(hex)) return hex
    }
  } catch { /* fall through */ }
  let fallback = ''
  for (let index = 0; index < 32; index += 1) fallback += Math.floor(Math.random() * 16).toString(16)
  return fallback
}

/** 浏览器 sessionStorage 的安全访问器；不可用时 undefined。 */
export function browserBootTokenStorage(): BootTokenStorageLike | undefined {
  try {
    const storage = globalThis.sessionStorage
    if (storage === undefined || storage === null) return undefined
    if (typeof storage.getItem !== 'function') return undefined
    return storage
  } catch {
    return undefined
  }
}

/**
 * 加载页代 token：
 *   - 已有合法 token ⇒ { token, verdict: 'same' }（reload；保留 pending）；
 *   - 缺失/坏值/storage 不可用 ⇒ 生成并尽力落盘；verdict 'fresh'（丢弃 pending）。
 */
export function loadBootToken(
  storage: BootTokenStorageLike | undefined,
  create: () => string = createBootToken,
): BootTokenReading {
  if (storage !== undefined) {
    try {
      const raw = storage.getItem(BOOT_TOKEN_KEY)
      if (isBootToken(raw)) return { token: raw, verdict: 'same' }
    } catch {
      // 读失败按 fresh 处理：宁可丢 pending，不得启动失败。
    }
  }
  const token = create()
  if (storage !== undefined) {
    try {
      storage.setItem(BOOT_TOKEN_KEY, token)
    } catch {
      // 写失败降级为内存 token；本次判 fresh（下次启动同样读不到）。
    }
  }
  return { token, verdict: 'fresh' }
}
