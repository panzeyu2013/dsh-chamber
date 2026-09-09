/**
 * update-headless.ts —— Swift flavor（headless sidecar）更新控制器（W-22；
 * design 25 §7「v1 blocked-available 诚实形态」）
 *
 * 形态契约（与 Electron 版 createUpdateController 的差异是**有意且可见**的）：
 * - 消费面零改动：`UpdateController` 接口与 `UpdateState` 七值/字段集不变，
 *   settings-bridge 的 UpdateSection/update-store/update-gate 不感知 flavor；
 * - **真实 check**：用户点「检查更新」→ 有界 GitHub releases 列表 API（≤100、
 *   10s 超时、AbortController）→ `selectLatestReleaseVersion`（draft/prerelease
 *   与 tag 形状严格校验）→ `compareChamberVersions` 比较 → 有更新则
 *   `phase='available'` + `latestVersion` + `releaseUrl`（`releaseUrlFor` 生成、
 *   `isAllowedReleaseUrl` 复核，绝不伪造 URL）；
 * - `installBlockedReason` 恒为 `NATIVE_SHELL_INSTALL_BLOCKED_REASON`
 *   （原生壳无 electron-updater/Squirrel 安装腿）→ UI 的 blocked 行 +
 *   releaseLink 直接诚实呈现（非失败态）；
 * - `download()` / `restartAndInstall()` **核心逻辑层显式拒绝**（不是 UI 隐藏）；
 * - `updateDownloadReady` 恒 false（phase 永不 downloaded）→ before-quit 的
 *   「已下载豁免」自然不适用（与 Electron 的差异已在 design 25 §7 明示）；
 * - `start()` 不排周期检查：v1 blocked-available 下周期出网只产出信息态，
 *   用户主动检查即入口（gateway 侧同样不移植周期检查，语义同向；设计 25 §7
 *   未要求周期检查 parity）。
 *
 * Electron-free：本文件只 import updater.ts 的纯函数（updater.ts 模块加载零
 * electron——electron 只在缺省 seam 内 lazy require）。
 */
import {
  GITHUB_OWNER,
  GITHUB_REPO,
  compareChamberVersions,
  isAllowedReleaseUrl,
  releaseUrlFor,
  sanitizeErrorText,
  type UpdateController,
  type UpdateState,
} from './updater.ts'

/** blocked 原因（design 25 §7 逐字）：Swift 壳不支持自动安装。UI 对已知 reason
 *  有本地化映射（UpdateSection.blockedCopy / updateAvailableBlockedNativeShell）。 */
export const NATIVE_SHELL_INSTALL_BLOCKED_REASON = '原生壳不支持自动安装'
/**
 * feed 条目是否带**可解析版本**（stable 或 beta 形状，不看通道/draft）——
 * 用来区分「本通道暂无发布物」与「feed 形状异常」（三审 #14）。
 */
function hasParseableVersion(candidate: unknown): boolean {
  if (candidate === null || typeof candidate !== 'object') return false
  const record = candidate as { tag_name?: unknown }
  if (typeof record.tag_name !== 'string' || record.tag_name.length > 128) return false
  return STABLE_TAG.test(record.tag_name) || BETA_TAG.test(record.tag_name)
}

/** 下载拒绝文案（IPC 返回的 error 串；UI 只显示状态行，不显示本串）。 */
export const NATIVE_SHELL_DOWNLOAD_REFUSAL = '原生壳不支持自动安装（请手动下载新版本）'
/** 重启并安装拒绝文案。 */
export const NATIVE_SHELL_RESTART_REFUSAL = '原生壳不支持自动更新安装（请手动下载新版本）'

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const BETA_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/
const RELEASES_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=100`

/**
 * 从 GitHub releases 列表选最新版本（纯函数；feed 数据是不可信输入）：
 * - 响应必须是数组且 ≤100 条（与 resolveGithubBetaFeed 同界）；
 * - `draft === false` 且 `prerelease` 与 channel 精确匹配（stable 要 false，
 *   beta 要 true——稳定版不会被 beta 通道选中，反之亦然）；
 * - tag 形状严格（stable `vX.Y.Z` / beta `vX.Y.Z-beta.N`，前导 v 去掉）；
 * - 逐条经 `compareChamberVersions` 取最大；不可比较的条目跳过（绝不猜测）。
 * 返回版本号（无前导 v）或 null（无候选）。
 */
export function selectLatestReleaseVersion(
  releases: unknown,
  channel: 'stable' | 'beta',
): string | null {
  if (!Array.isArray(releases) || releases.length > 100) return null
  const pattern = channel === 'beta' ? BETA_TAG : STABLE_TAG
  let best: string | null = null
  for (const candidate of releases as unknown[]) {
    if (candidate === null || typeof candidate !== 'object') continue
    const record = candidate as { tag_name?: unknown; draft?: unknown; prerelease?: unknown }
    if (record.draft !== false || record.prerelease !== (channel === 'beta')) continue
    if (typeof record.tag_name !== 'string' || record.tag_name.length > 128) continue
    if (!pattern.test(record.tag_name)) continue
    const version = record.tag_name.slice(1)
    if (best === null) {
      best = version
      continue
    }
    const comparison = compareChamberVersions(version, best)
    if (comparison !== null && comparison > 0) best = version
  }
  return best
}

/** 通道判定（与 updater.ts resolveChannel 同语义：内建 beta 版本或显式
 *  DSH_CHAMBER_UPDATE_CHANNEL=beta）。 */
export function resolveHeadlessChannel(
  version: string,
  env: Record<string, string | undefined> = process.env,
): 'stable' | 'beta' {
  return /^\d+\.\d+\.\d+-beta\.(0|[1-9]\d*)$/.test(version) || env.DSH_CHAMBER_UPDATE_CHANNEL === 'beta'
    ? 'beta'
    : 'stable'
}

export interface HeadlessUpdateControllerDeps {
  /** 当前 chamber 版本（sidecar 读 packages/desktop/package.json）。 */
  version: string
  logger: { log: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
  /** 注入的 fetch（测试用假响应；缺省 = 全局 fetch）。 */
  request?: typeof fetch
  /** 通道覆盖（缺省按 version/env 推导）。 */
  channel?: 'stable' | 'beta'
  /** 单次检查超时（缺省 10s，与 resolveGithubBetaFeed 同值）。 */
  timeoutMs?: number
}

/** 构造 Swift flavor 更新控制器（UpdateController 契约，无 Electron 依赖）。 */
export function createHeadlessUpdateController(deps: HeadlessUpdateControllerDeps): UpdateController {
  const request = deps.request ?? globalThis.fetch
  const channel = deps.channel ?? resolveHeadlessChannel(deps.version)
  const timeoutMs = deps.timeoutMs ?? 10_000
  const listeners = new Set<(state: UpdateState) => void>()
  let checking = false
  let state: UpdateState = {
    phase: 'idle',
    currentVersion: deps.version,
    latestVersion: null,
    channel,
    downloadPercent: null,
    releaseUrl: null,
    installBlockedReason: NATIVE_SHELL_INSTALL_BLOCKED_REASON,
    error: null,
  }

  function setState(patch: Partial<UpdateState>): void {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  async function runCheck(): Promise<void> {
    if (checking) return
    if (state.phase === 'downloading' || state.phase === 'downloaded') return
    checking = true
    setState({ phase: 'checking', error: null })
    try {
      if (typeof request !== 'function') throw new Error('update check is unavailable (no fetch)')
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), timeoutMs)
      timer.unref?.()
      let releases: unknown
      try {
        const response = await request(RELEASES_URL, {
          headers: { Accept: 'application/vnd.github+json' },
          signal: abort.signal,
        })
        if (!response.ok) throw new Error(`update check failed (HTTP ${response.status})`)
        releases = await response.json()
      } finally {
        clearTimeout(timer)
      }
      // 响应形状不可信：非数组/超界是 feed 故障（loud error），绝不当「已是最新」
      // （proxy honesty——空成功必须与真无更新区分）。
      if (!Array.isArray(releases) || releases.length > 100) {
        throw new Error('invalid GitHub releases response')
      }
      const latest = selectLatestReleaseVersion(releases, channel)
      if (latest === null) {
        // 三审 #14：区分「本通道暂无发布物」与「feed 形状异常」——
        //   * feed 里存在**可解析版本**的条目（如全是 beta / 全是 draft）：
        //     本通道确实还没有可升级的发布物 → up-to-date（诚实）；
        //   * feed 非空但**一个可解析版本都没有**（tag 形状全坏）→ 响亮 error，
        //     绝不伪装「已是最新」。
        const parseable = releases.some((entry) => hasParseableVersion(entry))
        if (releases.length > 0 && !parseable) {
          throw new Error('no usable release in the GitHub releases feed')
        }
        setState({ phase: 'up-to-date', latestVersion: null, downloadPercent: null, releaseUrl: null, error: null })
        return
      }
      const comparison = compareChamberVersions(latest, deps.version)
      if (comparison === null) throw new Error(`uncomparable release version: ${latest}`)
      if (comparison <= 0) {
        setState({ phase: 'up-to-date', latestVersion: null, downloadPercent: null, releaseUrl: null, error: null })
        return
      }
      const releaseUrl = releaseUrlFor(latest)
      if (releaseUrl === null || !isAllowedReleaseUrl(releaseUrl)) {
        throw new Error('release page url rejected by allowlist')
      }
      setState({ phase: 'available', latestVersion: latest, downloadPercent: null, releaseUrl, error: null })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.logger.warn('[updater-headless] check failed:', message)
      setState({ phase: 'error', latestVersion: null, downloadPercent: null, releaseUrl: null, error: sanitizeErrorText(message) })
    } finally {
      checking = false
    }
  }

  return {
    state: () => ({ ...state }),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start() {
      deps.logger.log('[updater-headless] 周期检查未启用（v1 blocked-available：仅用户主动「检查更新」触发）')
    },
    async checkNow() {
      // 与 Electron 同契约：返回值恒 {ok:true}，渲染器以 update-state 推送
      // 判定实际结果（checking/available/up-to-date/error）。
      await runCheck()
      return { ok: true }
    },
    async download() {
      if (state.latestVersion === null || (state.phase !== 'available' && state.phase !== 'error')) {
        return { ok: false, error: 'no update available' }
      }
      return { ok: false, error: NATIVE_SHELL_DOWNLOAD_REFUSAL }
    },
    restartAndInstall() {
      return { ok: false, error: NATIVE_SHELL_RESTART_REFUSAL }
    },
  }
}
