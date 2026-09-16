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
 * - `start()` 与 Electron updater.ts:1184-1198 **同节奏**（S5·F3/S6·F2 parity）：
 *   15s 后一次静默首检、之后每 6h 周期静默检查（两枚定时器 unref，
 *   绝不阻止进程退出；`stop()` 显式停表——sidecar 退出路径调用；start() 幂等，
 *   重复调用不叠加定时器）。每轮失败在 runCheck 内折叠为 error 态 + warn，
 *   定时器回调绝不产生未捕获异常。
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
/** 静默首检延迟（与 Electron updater.ts:651 的 CHECK_DELAY_MS 同值——那边未导出，
 *  这里以等值常量 + 单测锁步，防两端节奏漂移）。 */
export const HEADLESS_CHECK_DELAY_MS = 15_000
/** 周期静默检查间隔（与 Electron updater.ts:653 的 CHECK_INTERVAL_MS 同值 6h）。 */
export const HEADLESS_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

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

/** 原生壳更新器桥（2026-12 裁决 D-1 选 B / 台账 S-01）。
 *
 *  Swift flavor 的安装腿由壳内的 Sparkle 承担（appcast + EdDSA + 标准更新窗口）。
 *  壳在 sidecar 启动参数里声明支持（--native-updater sparkle），sidecar 据此把
 *  「下载 / 重启并安装」转发给壳，而不是恒回 blocked；未声明时保持原有
 *  blocked-available 行为（dev / dry-run / 未配置密钥的装配）。
 *
 *  check 走壳自己的 GitHub feed 查询（页面状态行），download/install 走 Sparkle 的
 *  标准窗口——下载与安装在该窗口内是一段连续流程，与 Electron 的三步在用户可见
 *  效果上等价（检查 → 下载 → 重启并安装），实现方式不同。 */
export interface NativeUpdaterBridge {
  /** 壳侧原生更新器是否真的可用（配好 feed + 公钥）。 */
  available(): Promise<boolean>
  /** 触发原生更新流程。download/install 都打开 Sparkle 的标准更新窗口。 */
  trigger(kind: 'download' | 'install'): Promise<{ ok: true } | { ok: false; error: string }>
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
  /** 原生更新器桥（缺省 = 无原生安装腿：保持 blocked-available，见类型注释）。 */
  nativeUpdater?: NativeUpdaterBridge
}

/** headless 控制器的附加停表面（消费面仍按 UpdateController 使用）：`stop()`
 *  清除 `start()` 排定的静默首检 / 周期定时器（sidecar 退出路径调用）。Electron
 *  版无此成员——那边定时器随 Electron 进程退出消亡，无显式停表入口。 */
export interface HeadlessUpdateController extends UpdateController {
  stop(): void
}

/** 构造 Swift flavor 更新控制器（UpdateController 契约，无 Electron 依赖）。 */
export function createHeadlessUpdateController(deps: HeadlessUpdateControllerDeps): HeadlessUpdateController {
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

  // start() 排定的两枚定时器（stop()/首检到点清引用；句柄本身上了 unref）。
  let initialTimer: ReturnType<typeof setTimeout> | null = null
  let intervalTimer: ReturnType<typeof setInterval> | null = null
  function stopTimers(): void {
    if (initialTimer !== null) {
      clearTimeout(initialTimer)
      initialTimer = null
    }
    if (intervalTimer !== null) {
      clearInterval(intervalTimer)
      intervalTimer = null
    }
  }

  function setState(patch: Partial<UpdateState>): void {
    state = { ...state, ...patch }
    for (const listener of listeners) {
      // 推送腿（宿主 subscribe 回调）抛错绝不能反噬控制器：既不能让 checking 卡死，
      // 也不能把 IPC 变成 reject（2026-12 审查：sidecar ctx 的缺失成员 stub 曾在
      // 该路径抛出，UPDATE_CHECK 因此永久失效）。失败响亮记日志，控制流继续。
      try {
        listener(state)
      } catch (error) {
        try {
          deps.logger.error('[updater-headless] state listener failed:', error instanceof Error ? error.message : String(error))
        } catch { /* logging boundary */ }
      }
    }
  }

  async function runCheck(): Promise<void> {
    if (checking) return
    if (state.phase === 'downloading' || state.phase === 'downloaded') return
    checking = true
    try {
      setState({ phase: 'checking', error: null })
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
      // 原生更新器能力探测（S-01 / D-1 选 B）：壳声明了 --native-updater 才探测；
      // 可用就摘掉 installBlockedReason（页面更新区从「原生壳不支持自动安装」变成
      // 可执行的「更新」按钮），不可用/探测失败保持原样并 loud。
      void (async () => {
        if (deps.nativeUpdater === undefined) return
        try {
          const available = await deps.nativeUpdater.available()
          if (available) {
            setState({ installBlockedReason: null })
            deps.logger.log('[updater-headless] 原生更新器（Sparkle）可用：安装腿交给壳，installBlockedReason 已清空')
          } else {
            deps.logger.log('[updater-headless] 壳声明了原生更新器但当前不可用（缺 feed/公钥）：保持 blocked-available')
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          deps.logger.warn('[updater-headless] 原生更新器能力探测失败（保持 blocked-available）：' + message)
        }
      })()
      // 与 Electron updater.ts:1184-1197 同节奏（S5·F3/S6·F2）：15s 静默首检 +
      // 每 6h 周期检查。幂等：重复调用不叠加定时器。unref 保证定时器绝不阻止
      // 进程退出（sidecar 退出路径另有显式 stop()）。
      if (initialTimer !== null || intervalTimer !== null) return
      initialTimer = setTimeout(() => {
        initialTimer = null
        // runCheck 内部 catch 全部失败并落 error 态（绝不 reject）——void 安全。
        void runCheck()
      }, HEADLESS_CHECK_DELAY_MS)
      initialTimer.unref?.()
      intervalTimer = setInterval(() => void runCheck(), HEADLESS_CHECK_INTERVAL_MS)
      intervalTimer.unref?.()
      deps.logger.log(
        `[updater-headless] 更新检查已启动（channel=${channel}，${HEADLESS_CHECK_DELAY_MS / 1000}s 后首次检查，之后每 ${HEADLESS_CHECK_INTERVAL_MS / 3_600_000}h）`,
      )
    },
    stop() {
      stopTimers()
    },
    async checkNow() {
      // 与 Electron 同契约：返回值恒 {ok:true}，渲染器以 update-state 推送
      // 判定实际结果（checking/available/up-to-date/error）。
      await runCheck()
      return { ok: true }
    },
    async download() {
      // 原生更新器可用时：打开 Sparkle 的标准更新窗口（下载+安装是其连续流程）。
      if (state.installBlockedReason === null && deps.nativeUpdater !== undefined) {
        return deps.nativeUpdater.trigger('download')
      }
      if (state.latestVersion === null || (state.phase !== 'available' && state.phase !== 'error')) {
        return { ok: false, error: 'no update available' }
      }
      return { ok: false, error: NATIVE_SHELL_DOWNLOAD_REFUSAL }
    },
    restartAndInstall() {
      // 同步面保持「无原生腿」的拒绝语义（Electron 契约不变）。
      return { ok: false, error: NATIVE_SHELL_RESTART_REFUSAL }
    },
    async restartAndInstallAsync() {
      // 原生更新器可用时：Sparkle 标准窗口的「Install and Relaunch」即本方法语义
      // （壳在 willInstallUpdate 里先停受管 sidecar，再替换 bundle 并重启）。
      if (state.installBlockedReason === null && deps.nativeUpdater !== undefined) {
        return deps.nativeUpdater.trigger('install')
      }
      return { ok: false as const, error: NATIVE_SHELL_RESTART_REFUSAL }
    },
  }
}
