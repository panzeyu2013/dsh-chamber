/**
 * update-discovery.ts —— GitHub Releases 发现与候选选择的单一实现
 * （electron-free：updater.ts（Electron/electron-updater 面）与
 * update-headless.ts（Swift sidecar 面）共用）。
 *
 * 审计项 2：这一发现 + 选择逻辑此前在两个消费面各写一遍
 * （updater.ts 的 resolveGithubBetaFeed/betaReleaseDownloadBase 与
 * update-headless.ts 的 RELEASES_URL/selectLatestReleaseVersion），边界与语义
 * 必须锁步而不是靠两份实现碰巧一致：
 * - 有界列表查询唯一实现：URL 由仓库常量推导、per_page=100、Accept 头、
 *   AbortController 超时、非 2xx 响亮错误；
 * - 候选选择唯一实现：draft/prerelease 与通道精确匹配、canonical tag 形状、
 *   BigInt 四元组取最大（beta 号用 BigInt 是 updater.ts 既有的精确语义——
 *   Number 在 >2^53 的 beta 号上会失去精度）；
 * - 形状边界唯一实现：isBoundedReleasesList（非数组/超 100 条）与
 *   isParseableReleaseTag（stable/beta 形状，不看通道/draft）。
 *
 * 两个调用方只保留各自的错误形态差异：updater 的 beta wrapper 在无候选时
 * 响亮抛错；headless 选择器返回 null，并由调用点区分「本通道暂无发布物」
 * （up-to-date）与「非空 feed 零可解析版本」（响亮 error）。
 *
 * 本模块不得 import electron（electron-free-gate.test.ts 面 A）。
 */

/** The update feed repository (release.yml uploads the same repo's artifacts). */
export const GITHUB_OWNER = 'panzeyu2013'
export const GITHUB_REPO = 'dsh-chamber'

/** 有界 releases 列表端点：单页、per_page=100（两条消费面唯一的 feed 来源）。 */
export const GITHUB_RELEASES_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=100`

/** 列表响应条目上限（形状边界；>100 = 形态异常，绝不当「已是最新」）。 */
export const RELEASES_MAX_ENTRIES = 100

/** tag_name 长度上限（两条消费面共同的防御边界）。 */
const MAX_TAG_LENGTH = 128

/** 响应必须是数组且 ≤100 条（与 per_page 同一上限）。 */
export function isBoundedReleasesList(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length <= RELEASES_MAX_ENTRIES
}

/** Canonical release tag shapes (leading `v`; the feed is untrusted input). */
export const STABLE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const BETA_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/

/** feed 条目是否带**可解析版本**（stable 或 beta 形状，不看通道/draft）——
 *  调用点用它区分「本通道暂无发布物」与「feed 形状异常」（三审 #14 的响亮
 *  error 判据）。 */
export function isParseableReleaseTag(tag: unknown): boolean {
  if (typeof tag !== 'string' || tag.length > MAX_TAG_LENGTH) return false
  return STABLE_TAG_PATTERN.test(tag) || BETA_TAG_PATTERN.test(tag)
}

export type ReleaseChannel = 'stable' | 'beta'

/** 通道候选：exact tag（含前导 v）与不带 v 的版本号。 */
export interface ReleaseCandidate {
  tag: string
  version: string
}

/** 四元组：stable 的 beta 位恒为 0n——通道过滤保证同一通道内不会跨后缀比较，
 *  逐位比较即等价于「stable > 同 base 的 beta（若混入）」+ 数字 beta 号比较。 */
type VersionParts = readonly [bigint, bigint, bigint, bigint]

function tagVersionParts(tag: string, pattern: RegExp): VersionParts | null {
  const match = pattern.exec(tag)
  if (match === null) return null
  return [
    BigInt(match[1]),
    BigInt(match[2]),
    BigInt(match[3]),
    match[4] === undefined ? 0n : BigInt(match[4]),
  ]
}

function compareVersionParts(left: VersionParts, right: VersionParts): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return 0
}

/**
 * 从 GitHub releases 列表选**本通道**最大候选（纯函数；feed 数据不可信）：
 * - 响应必须是数组且 ≤100 条（与 per_page 同界；非数组/超界 → null，绝不猜）；
 * - `draft === false` 且 `prerelease` 与 channel 精确匹配（stable 要 false，
 *   beta 要 true——稳定版不会被 beta 通道选中，反之亦然）；
 * - tag 形状严格：stable `vX.Y.Z` / beta `vX.Y.Z-beta.N`；
 * - 逐条 BigInt 四元组取最大；不可解析的条目跳过（绝不猜测）。
 * 返回 exact tag + 版本号（无前导 v）或 null（无候选）。
 */
export function selectReleaseCandidate(releases: unknown, channel: ReleaseChannel): ReleaseCandidate | null {
  if (!isBoundedReleasesList(releases)) return null
  const pattern = channel === 'beta' ? BETA_TAG_PATTERN : STABLE_TAG_PATTERN
  let selected: { tag: string; version: string; parts: VersionParts } | null = null
  for (const candidate of releases) {
    if (candidate === null || typeof candidate !== 'object') continue
    const record = candidate as { tag_name?: unknown; draft?: unknown; prerelease?: unknown }
    if (record.draft !== false || record.prerelease !== (channel === 'beta')) continue
    if (typeof record.tag_name !== 'string' || record.tag_name.length > MAX_TAG_LENGTH) continue
    const parts = tagVersionParts(record.tag_name, pattern)
    if (parts === null) continue
    if (selected === null || compareVersionParts(parts, selected.parts) > 0) {
      selected = { tag: record.tag_name, version: record.tag_name.slice(1), parts }
    }
  }
  return selected === null ? null : { tag: selected.tag, version: selected.version }
}

/** 精确 tag 的下载基址（exact-tag 路径，绝不含 `latest`）。 */
export function releaseDownloadBase(tag: string): string {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${encodeURIComponent(tag)}/`
}

/** 有界列表查询的调用方文案（两个消费面的错误串各自保持原有措辞）。 */
export interface GithubReleasesFetchOptions {
  /** AbortController 超时（缺省 10s）。 */
  timeoutMs?: number
  /** 没有可用 fetch 时的错误串。 */
  unavailableMessage?: string
  /** 非 2xx 的错误前缀（实际抛出 `${failureLabel} (HTTP ${status})`）。 */
  failureLabel?: string
}

/**
 * 有界 GitHub releases 列表查询（唯一实现）：Accept 头 + AbortController
 * 超时（timer unref，绝不阻止进程退出），非 2xx 响亮错误；返回已解析 JSON，
 * 形状由调用方经 isBoundedReleasesList / 选择函数校验。
 */
export async function fetchGithubReleases(
  request: typeof fetch,
  {
    timeoutMs = 10_000,
    unavailableMessage = 'update discovery is unavailable',
    failureLabel = 'update discovery failed',
  }: GithubReleasesFetchOptions = {},
): Promise<unknown> {
  if (typeof request !== 'function') throw new Error(unavailableMessage)
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  timer.unref?.()
  try {
    const response = await request(GITHUB_RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: abort.signal,
    })
    if (!response.ok) throw new Error(`${failureLabel} (HTTP ${response.status})`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}
