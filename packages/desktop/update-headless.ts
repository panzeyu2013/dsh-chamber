/**
 * update-headless.ts —— Swift flavor（headless sidecar）更新控制器
 * （design 25 §7「v1 blocked-available 诚实形态」）
 *
 * 形态契约（与 Electron 版 createUpdateController 的差异是**有意且可见**的）：
 * - 消费面零改动：`UpdateController` 接口与 `UpdateState` 字段集不变
 *   （相位联合含 'installing'——Electron 不产生，Swift 原生安装中
 *   产生），settings-bridge 的 UpdateSection/update-store/update-gate 不感知
 *   flavor；
 * - **真实 check**：用户点「检查更新」→ 有界 GitHub releases 列表 API（≤100、
 *   10s 超时、AbortController；共享实现 update-discovery.ts）→
 *   `selectLatestReleaseVersion`（draft/prerelease 与 tag 形状严格校验，同一共享
 *   选择）→ `compareChamberVersions` 比较 → 有更新则
 *   `phase='available'` + `latestVersion` + `releaseUrl`（`releaseUrlFor` 生成、
 *   `isAllowedReleaseUrl` 复核，绝不伪造 URL）；
 * - `installBlockedReason` 缺省为 `NATIVE_SHELL_INSTALL_BLOCKED_REASON`
 *   （未声明原生安装腿时 UI 的 blocked 行 + releaseLink 诚实呈现）；壳声明
 *   `--native-updater sparkle` 且能力探测可用、或任何 `__host.nativeUpdatePhase`
 *   入站后清空（**绝不把已配置的 Sparkle 降级为 unavailable**）；能力探测
 *   不可用时记录壳给出的**真实原因**（坏 feed / 坏 Ed25519 公钥 / 启动失败），
 *   check 拿壳的 ok:false 落 error 相位——页面绝不停在 checking；
 * - **发现单源**：壳声明原生腿（nativeUpdater 注入）时，「检查更新」
 *   绝不跑 GitHub releases 查询，而是经冻结边 `updateNativeAction kind=check`
 *   交给壳内的 Sparkle（它只认 appcast）；发现的相位由壳经
 *   `__host.nativeUpdatePhase` 推送，本控制器只做投影。未声明原生腿
 *   （dev / dry-run / 未配置密钥）时才走 GitHub 发现——那是该形态唯一的 feed
 *   来源，**不是**对原生腿的回退；声明过原生腿后任何失败都不回退（绝不双源、
 *   绝不给出与 Sparkle 相反的结论）；
 * - 原生腿在场时不排静默定时器（15s 首检 + 6h 周期）：Sparkle 的
 *   `checkForUpdates` 会打开用户发起的标准更新窗口，定时调用等于启动后无故
 *   弹窗——后台发现归 Sparkle 自己的调度器（模板 `SUEnableAutomaticChecks`）；
 * - 原生阶段映射（冻结接口）：`applyNativePhase` 把壳报告的
 *   idle/checking/up-to-date/available/downloading/downloaded/installing/failed
 *   折进同一 UpdateState；downloading/downloaded/installing 与 Electron 的
 *   下载/安装腿同形呈现，failed → error；
 * - `download()` / `restartAndInstall()` 在**无原生安装腿**时核心逻辑层显式
 *   拒绝（不是 UI 隐藏）；原生腿可用时按与 Electron 同形的相位门转发
 *   （downloading/downloaded/installing 在飞 → 拒绝，绝不启动第二次下载/安装）；
 * - `quitFacts.updateDownloadReady` 由本控制器相位推导（downloaded/installing
 *   = before-quit「已下载豁免」等价态，见 sidecar-ctx.quitFacts）；
 * - `start()` 与 Electron updater.ts:1184-1198 **同节奏**：
 *   15s 后一次静默首检、之后每 6h 周期静默检查（两枚定时器 unref，
 *   绝不阻止进程退出；`stop()` 显式停表——sidecar 退出路径调用；start() 幂等，
 *   重复调用不叠加定时器）。每轮失败在 runCheck 内折叠为 error 态 + warn，
 *   定时器回调绝不产生未捕获异常。
 *
 * Electron-free：本文件只 import updater.ts 的纯函数（updater.ts 模块加载零
 * electron——electron 只在缺省 seam 内 lazy require）。
 */
import {
  compareChamberVersions,
  isAllowedReleaseUrl,
  releaseUrlFor,
  sanitizeErrorText,
  type UpdateController,
  type UpdateState,
} from './updater.ts'
import { describeError } from './describe-error.ts'
import type { NativeUpdatePhaseInput } from './node-edges.ts'
import {
  fetchGithubReleases,
  isBoundedReleasesList,
  isParseableReleaseTag,
  selectReleaseCandidate,
} from './update-discovery.ts'

/** blocked 原因（design 25 §7 逐字）：Swift 壳不支持自动安装。UI 对已知 reason
 *  有本地化映射（UpdateSection.blockedCopy / updateAvailableBlockedNativeShell）。 */
export const NATIVE_SHELL_INSTALL_BLOCKED_REASON = '原生壳不支持自动安装'
/**
 * feed 条目是否带**可解析版本**（stable 或 beta 形状，不看通道/draft）——
 * 用来区分「本通道暂无发布物」与「feed 形状异常」。形状判定来自
 * 共享的 update-discovery.ts（与 updater.ts 的 beta 发现同一套 tag 形状）。
 */
function hasParseableVersion(candidate: unknown): boolean {
  if (candidate === null || typeof candidate !== 'object') return false
  return isParseableReleaseTag((candidate as { tag_name?: unknown }).tag_name)
}

/** 下载拒绝文案（IPC 返回的 error 串；UI 只显示状态行，不显示本串）。 */
export const NATIVE_SHELL_DOWNLOAD_REFUSAL = '原生壳不支持自动安装（请手动下载新版本）'
/** 重启并安装拒绝文案。 */
export const NATIVE_SHELL_RESTART_REFUSAL = '原生壳不支持自动更新安装（请手动下载新版本）'

/** 静默首检延迟（与 Electron updater.ts:651 的 CHECK_DELAY_MS 同值——那边未导出，
 *  这里以等值常量 + 单测锁步，防两端节奏漂移）。 */
export const HEADLESS_CHECK_DELAY_MS = 15_000
/** 周期静默检查间隔（与 Electron updater.ts:653 的 CHECK_INTERVAL_MS 同值 6h）。 */
export const HEADLESS_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * 从 GitHub releases 列表选最新版本（纯函数；feed 数据是不可信输入）。
 * 与 updater.ts 的 beta 发现共用 update-discovery.ts 的候选选择：数组/≤100 条
 * 边界、draft/prerelease 通道匹配、canonical tag 形状、BigInt 最大值。
 * 返回版本号（无前导 v）或 null（无候选）——调用点据此区分「本通道暂无发布物」
 * （up-to-date）与「非空 feed 零可解析版本」（响亮 error），见 runCheck。
 */
export function selectLatestReleaseVersion(
  releases: unknown,
  channel: 'stable' | 'beta',
): string | null {
  return selectReleaseCandidate(releases, channel)?.version ?? null
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

/** 原生壳更新器桥。
 *
 *  Swift flavor 的安装腿由壳内的 Sparkle 承担（appcast + EdDSA + 标准更新窗口）。
 *  壳在 sidecar 启动参数里声明支持（--native-updater sparkle），sidecar 据此把
 *  「下载 / 重启并安装」转发给壳，而不是恒回 blocked；未声明时保持
 *  blocked-available 行为（dev / dry-run / 未配置密钥的装配）。
 *
 *  check 也归壳（发现单源）：冻结边 `updateNativeAction kind=check` →
 *  Sparkle 的 `checkForUpdates`（appcast + EdDSA），相位经
 *  `__host.nativeUpdatePhase` 回来；download/install 走 Sparkle 的标准更新窗口
 *  ——下载与安装在该窗口内是一段连续流程，与 Electron 的三步在用户可见效果上
 *  等价（检查 → 下载 → 重启并安装），实现方式不同。 */
export interface NativeUpdaterBridge {
  /** 壳侧原生更新器能力：available=false 时 error 是**真实原因**
   *  （未装配 / 坏 feed / 坏 Ed25519 公钥 / startUpdater 失败），控制器记录它并
   *  保持 blocked-available；随后的 check 拿壳的 ok:false 落 error 相位。 */
  available(): Promise<{ available: boolean; error?: string | null }>
  /** 触发原生更新流程。check = Sparkle 检查（appcast 单源）；download/install
   *  都打开 Sparkle 的标准更新窗口。 */
  trigger(kind: 'check' | 'download' | 'install'): Promise<{ ok: true } | { ok: false; error: string }>
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
  /** 原生（Sparkle）阶段入站投影（冻结接口）——见实现注释。 */
  applyNativePhase(input: NativeUpdatePhaseInput): void
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
      // 也不能把 IPC 变成 reject（sidecar ctx 的缺失成员 stub 在该路径抛出，
      // UPDATE_CHECK 会永久失效）。失败响亮记日志，控制流继续。
      try {
        listener(state)
      } catch (error) {
        try {
          deps.logger.error('[updater-headless] state listener failed:', describeError(error))
        } catch { /* logging boundary */ }
      }
    }
  }

  async function runCheck(): Promise<void> {
    if (checking) return
    // 下载/安装流程在飞时绝不重查（安装中重查会把正在安装的相位打回 checking）。
    if (state.phase === 'downloading' || state.phase === 'downloaded' || state.phase === 'installing') return
    checking = true
    try {
      setState({ phase: 'checking', error: null })
      // 发现单源：原生腿已声明 → 发现交壳的 Sparkle（appcast），恰发一次
      // 冻结边 updateNativeAction kind=check；终态由壳的
      // __host.nativeUpdatePhase 推送决定（本函数只把 checking 先呈现给页面）。
      // 绝不出网跑 GitHub releases 查询：两源会给出相反结论。
      if (deps.nativeUpdater !== undefined) {
        const result = await deps.nativeUpdater.trigger('check')
        if (!result.ok) {
          // 壳拒绝（缺 feed/公钥/忙）也不回退 GitHub——声明过原生腿后，
          // 单源优先于「至少查点什么」；页面拿诚实错误而不是相反结论。
          deps.logger.warn('[updater-headless] 原生检查被拒绝（绝不回退 GitHub 发现）：', result.error)
          setState({
            phase: 'error',
            latestVersion: null,
            downloadPercent: null,
            releaseUrl: null,
            error: sanitizeErrorText(result.error),
          })
        }
        return
      }
      // 有界查询为共享实现（update-discovery.ts）；两侧错误串保持本 flavor 原样。
      const releases = await fetchGithubReleases(request, {
        timeoutMs,
        unavailableMessage: 'update check is unavailable (no fetch)',
        failureLabel: 'update check failed',
      })
      // 响应形状不可信：非数组/超界是 feed 故障（loud error），绝不当「已是最新」
      // （proxy honesty——空成功必须与真无更新区分）。
      if (!isBoundedReleasesList(releases)) {
        throw new Error('invalid GitHub releases response')
      }
      const latest = selectLatestReleaseVersion(releases, channel)
      if (latest === null) {
        // 区分「本通道暂无发布物」与「feed 形状异常」——
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
      const message = describeError(error)
      deps.logger.warn('[updater-headless] check failed:', message)
      setState({ phase: 'error', latestVersion: null, downloadPercent: null, releaseUrl: null, error: sanitizeErrorText(message) })
    } finally {
      checking = false
    }
  }

  /**
   * 原生更新阶段入站投影（冻结接口）：Swift 壳报告 Sparkle 状态，
   * 本控制器把它映射进**同一个** UpdateState 投影（消费面零改动：
   * settings-bridge 的 UpdateSection/update-store/update-gate 不感知 flavor，
   * push 仍走 shell-core 的 updater.subscribe → rendererPush）。
   *
   * 映射（原生相位 → UpdateState 相位）：
   *   idle/checking/up-to-date/available/downloading/downloaded → 同名相位；
   *   installing → 'installing'（Electron 不产生；页面显示「正在安装更新…」，
   *     不提供第二次安装入口）；failed → 'error'（error 文案为原生失败串）。
   *
   * 冻结语义：
   *   - **绝不降级为 unavailable**：任何原生阶段都证明 Sparkle 已配置并工作，
   *     installBlockedReason 一律清空（启动期能力探测失败/未返回时页面也不会
   *     显示「原生壳不支持自动安装」）。
   *   - **绝不启动第二次下载**：download()/restartAndInstallAsync() 只在相位
   *     允许时转发壳（见下方门）；本函数不改 latestVersion 之外的下载意图。
   */
  function applyNativePhase(input: NativeUpdatePhaseInput): void {
    // 每个原生阶段都清 blocked reason（上方冻结语义）。
    const base = { installBlockedReason: null } as const
    switch (input.phase) {
      case 'idle':
        setState({ ...base, phase: 'idle', error: null, downloadPercent: null })
        return
      case 'checking':
        setState({ ...base, phase: 'checking', error: null })
        return
      case 'up-to-date':
        setState({
          ...base,
          phase: 'up-to-date',
          latestVersion: null,
          downloadPercent: null,
          releaseUrl: null,
          error: null,
        })
        return
      case 'available': {
        // releaseUrl 只信白名单生成（与真实 check 同一约束，绝不透传原生串）。
        const candidate = input.version === null ? null : releaseUrlFor(input.version)
        const releaseUrl = candidate !== null && isAllowedReleaseUrl(candidate) ? candidate : null
        setState({
          ...base,
          phase: 'available',
          latestVersion: input.version,
          downloadPercent: null,
          releaseUrl,
          error: null,
        })
        return
      }
      case 'downloading':
        // Sparkle 不逐条上报百分比（冻结载荷无 percent 字段）→ null；页面用
        // 不定量文案，绝不显示假的 0%。
        setState({ ...base, phase: 'downloading', downloadPercent: null, error: null })
        return
      case 'downloaded':
        setState({
          ...base,
          phase: 'downloaded',
          latestVersion: input.version ?? state.latestVersion,
          downloadPercent: 100,
          error: null,
        })
        return
      case 'installing':
        setState({
          ...base,
          phase: 'installing',
          latestVersion: input.version ?? state.latestVersion,
          downloadPercent: 100,
          error: null,
        })
        return
      case 'failed':
        setState({
          ...base,
          phase: 'error',
          // 下载失败保留已知版本（Electron 同语义：latestVersion 非 null =
          // 「更新下载失败」+ 重试行）；检查失败（无版本）→「无法检查更新」。
          latestVersion: input.version ?? state.latestVersion,
          downloadPercent: null,
          // 原生失败串不可信：sanitize（路径脱敏）+ 512 字符上限，绝不让一条
          // 异常载荷把渲染器投影无界放大。
          error: sanitizeErrorText((input.error ?? 'native updater failed').slice(0, 512)),
        })
        return
    }
  }

  return {
    state: () => ({ ...state }),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start() {
      // 原生更新器能力探测：壳声明了 --native-updater 才探测；
      // 可用就摘掉 installBlockedReason（页面更新区从「原生壳不支持自动安装」变成
      // 可执行的「更新」按钮），不可用/探测失败保持原样并 loud。
      void (async () => {
        if (deps.nativeUpdater === undefined) return
        try {
          const reply = await deps.nativeUpdater.available()
          const available = reply.available
          const reason = reply.error ?? null
          if (available) {
            setState({ installBlockedReason: null })
            deps.logger.log('[updater-headless] 原生更新器（Sparkle）可用：安装腿交给壳，installBlockedReason 已清空')
          } else {
            // 壳给出的不可用原因必须被记录（坏密钥/坏 feed/启动失败），不能
            // 只剩一个没有理由的 false；check 被壳拒绝时页面拿到同一原因的 error 相位。
            deps.logger.warn('[updater-headless] 壳声明了原生更新器但当前不可用（保持 blocked-available）：'
              + (reason ?? '壳未提供原因（缺 feed/公钥）'))
          }
        } catch (error) {
          const message = describeError(error)
          deps.logger.warn('[updater-headless] 原生更新器能力探测失败（保持 blocked-available）：' + message)
        }
      })()
      // 原生腿在场 → 发现/静默节奏完全归壳（Sparkle 的 appcast 单源）。
      // 这里绝不排 GitHub 定时器：既避免双源，也避免定时调用 Sparkle 的
      // checkForUpdates（那是用户发起窗口，会无故弹窗）；后台发现归 Sparkle
      // 自己的调度器（模板 SUEnableAutomaticChecks）。
      if (deps.nativeUpdater !== undefined) {
        deps.logger.log('[updater-headless] 原生更新器已声明：sidecar 不排静默检查（发现单源 = 壳内 Sparkle appcast）')
        return
      }
      // 与 Electron updater.ts:1184-1197 同节奏：15s 静默首检 +
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
    applyNativePhase,
    async checkNow() {
      // 与 Electron 同契约：返回值恒 {ok:true}，渲染器以 update-state 推送
      // 判定实际结果（checking/available/up-to-date/error）。原生腿在场时
      // runCheck 走冻结边 kind=check，返回值同样不携带真实结果——
      // 页面只认壳推送的相位。
      await runCheck()
      return { ok: true }
    },
    async download() {
      // 原生更新器可用时：打开 Sparkle 的标准更新窗口（下载+安装是其连续流程）。
      // 冻结语义「绝不启动第二次下载」：只有真正存在可下载更新（available，或
      // error+latestVersion 的下载重试）才转发；downloading/downloaded/installing
      // 在飞 → 明确拒绝；idle/checking/up-to-date → no update available。
      // 与 Electron download() 的门（latestVersion/相位/blocked reason）同形。
      if (state.installBlockedReason === null && deps.nativeUpdater !== undefined) {
        if (state.phase === 'downloading' || state.phase === 'downloaded' || state.phase === 'installing') {
          return { ok: false, error: 'download already in progress' }
        }
        if (state.latestVersion === null || (state.phase !== 'available' && state.phase !== 'error')) {
          return { ok: false, error: 'no update available' }
        }
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
      // 门与 Electron restartAndInstall() 同形：仅 downloaded + 无阻塞才转发；
      // downloading/installing（安装/下载在飞）明确拒绝，绝不二次触发安装。
      if (state.installBlockedReason === null && deps.nativeUpdater !== undefined) {
        if (state.phase === 'downloading' || state.phase === 'installing') {
          return { ok: false as const, error: 'restart already in progress' }
        }
        if (state.phase === 'downloaded') {
          return deps.nativeUpdater.trigger('install')
        }
      }
      return { ok: false as const, error: NATIVE_SHELL_RESTART_REFUSAL }
    },
  }
}
