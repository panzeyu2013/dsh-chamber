/**
 * sidecar-ctx.ts —— Swift flavor sidecar 无头 ctx 装配的 edge 接线。
 *
 * 装配本体（C–K 组注册体依赖、订阅、启动尾部、回收腿）在 host-assembly.ts 的
 * createHostAssembly，与 Electron main 同一实现；本文件只保留 Swift 侧 edge 事实与
 * flavor 差异：
 * - edges 适配（node-edges rendererPush/mainWindowAlive/退役驱逐/showMessage）；
 * - A 组设置副作用叶经 edges.sendEdge await B 桥应答；
 * - 无 safeStorage → 诚实 loud 的 0600 plaintext 回退；打包布局锚点与内嵌 pnpm 入口
 *   解析；update-headless（--native-updater 时交壳内 Sparkle，绝不双源）。
 * Electron-free 不变式：本文件与 host-assembly.ts 均零 electron import。打包路径拼写为
 * Swift 锁步锚点：改这些拼写必须同时改 macos 侧装配与锚点断言。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CHAMBER_SETTINGS, readSettingsFile } from './chamber-settings.ts'
import type { ChamberSettings } from './chamber-settings.ts'
import { describeError } from './describe-error.ts'
import type { ChamberHostPackageDescriptor } from './control-plane-module.ts'
import { createHostAssembly, type HostAssembly, type HostAssemblyEdges, type HostLocalSpawnGates } from './host-assembly.ts'
import { packageDirName } from './host-package-dirs.ts'
import { ARCHIVE_CLEANUP_PACKAGE_NAME, CHAMBER_HOST_PACKAGES, CLIENT_GRAPH_PACKAGE_NAME, GIT_WORKTREE_PACKAGE_NAME } from './plugin-sync.ts'
import { bundledPnpmEntryCandidates, firstExistingPnpmEntry } from './pnpm-launcher.ts'
import { sanitizeErrorText } from './sanitize-error.ts'
import { chamberSettingsFilePath } from './shell-core.ts'
import type { HostMessageOptions, ShellAssemblyCtx } from './shell-core.ts'
import { createHeadlessUpdateController, type NativeUpdaterBridge } from './update-headless.ts'

/** 打包布局：host 包构建产物目录 = `<sidecarDir>/dist/<packageDirName>`。 */
export function packagedHostPackageDir(sidecarDir: string, packageDirName: string): string {
  return path.join(sidecarDir, 'dist', packageDirName)
}

/** 打包布局：内嵌 pnpm 入口 = `<sidecarDir>/pnpm/bin/pnpm.cjs`。 */
export function packagedPnpmEntry(sidecarDir: string): string {
  return path.join(sidecarDir, 'pnpm', 'bin', 'pnpm.cjs')
}

/** 旧装配位：<sidecarDir>/../pnpm/bin/pnpm.cjs（sidecar 装配于 Resources/sidecar/ 时与
 *  Electron extraResources 的 Resources/pnpm 同构）。 */
export function legacyPackagedPnpmEntry(sidecarDir: string): string {
  return path.join(sidecarDir, '..', 'pnpm', 'bin', 'pnpm.cjs')
}

/** dev 位：`<moduleDir>/node_modules/pnpm/bin/pnpm.cjs`（pinned dep）。 */
export function devPnpmEntry(moduleDir: string): string {
  return path.join(moduleDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
}

/** 检索根：自 startDir 向上第一个含 pnpm-workspace.yaml 的目录——host 包源探测必须
 *  限定在 workspace 根（祖先链上的同名 packages/<pkg>/package.json 不得成为 seed 源）。
 *  找不到 → null。 */
export function findWorkspaceRoot(startDir: string, maxDepth = 8): string | null {
  let candidate = startDir
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (existsSync(path.join(candidate, 'pnpm-workspace.yaml'))) return candidate
    const parent = path.dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  return null
}

/** host 包源目录解析：显式 CLI 目录 > workspace 根 packages/<dir>（package.json 存在）
 *  > 打包布局 <moduleDir>/dist/<dir>。返回值不保证存在——seed 侧按存在性 loud 过滤。 */
export function resolveHostPackageSourceDir(
  packageDir: string,
  explicit: string | null,
  moduleDir: string,
): string {
  if (explicit !== null) return explicit
  const workspaceRoot = findWorkspaceRoot(moduleDir)
  if (workspaceRoot !== null) {
    const probe = path.join(workspaceRoot, 'packages', packageDir)
    if (existsSync(path.join(probe, 'package.json'))) return probe
  }
  return packagedHostPackageDir(moduleDir, packageDir)
}

/** pnpm 入口解析：装配位 > 旧装配位 > dev node_modules；全缺保留 dev 形状（安装路径
 *  loud 失败）。候选集/顺序单源在 pnpm-launcher，本函数只提供本 flavor 的三条布局
 *  拼写（Swift 锁步锚点）。 */
export function resolvePnpmEntry(moduleDir: string): string {
  const candidates = bundledPnpmEntryCandidates({
    platform: process.platform,
    moduleDir,
    assemblyEntry: packagedPnpmEntry(moduleDir),
    legacyAssemblyEntry: legacyPackagedPnpmEntry(moduleDir),
  })
  return firstExistingPnpmEntry(candidates, existsSync) ?? devPnpmEntry(moduleDir)
}

/** publish/confirm 等真实叶所需的宿主边沿子集（node-edges 实现）：sidecar-entry 把同一
 *  edges 实例传给 buildHeadlessCtx 与 installIpcHandlers（单装配不变式，与 core 投递
 *  状态机同对象、同事实缓存）。A 组设置副作用叶经 sendEdge await B 桥应答。 */
export interface HeadlessCtxEdges {
  rendererPush(channel: string, payload: unknown): boolean
  mainWindowAlive(): boolean
  retireNotificationsForSources(retiredSourceIds: ReadonlySet<string>): number
  showMessage(opts: HostMessageOptions): Promise<number>
  /** B 桥异步 edge 请求面（node-edges 公开 sendEdge 转发；同一实例注入）：resolve =
   *  宿主应答 ok，reject = transport ok:false / leg 错误（Error.message = Swift legs
   *  错误串）。A 组设置副作用叶 await 本面——leg 失败不得 fire-and-forget，失败回滚
   *  语义与 Electron 同步叶一致。 */
  sendEdge(method: string, payload: unknown): Promise<unknown>
}

/** Swift flavor 宿主输入（sidecar-entry 装配接线注入）。 */
export interface HeadlessCtxInputs {
  /** 内建 dsh workspace（--dsh-path；打包 = Resources/vendor/dsh，dev = repo ref-dsh
   *  等位）——启动事务 builtin 分支与 bundled 版本解析共用。 */
  builtinDshWorkspace: string | null
/** 当前 chamber 版本（shellVersion）——更新控制器 currentVersion / 通道判定输入。 */
  chamberVersion?: string
  /** chamber host 包源目录（--host-*-dir；null = 缺省解析）。openIn 只喂本地控制面播种
   *  （localOnly 行），不进远端 seed 数组。 */
  hostPackageDirs: {
    graph: string | null
    git: string | null
    archive: string | null
    openIn: string | null
  }
  /** 原生更新器桥。缺省 = 无原生安装腿：更新控制器保持 blocked-available，且只有此时
   *  check 走 GitHub releases 发现（声明了原生腿就交壳的 Sparkle appcast，绝不双源）。 */
  nativeUpdater?: NativeUpdaterBridge | null
}

/**
 * Swift flavor 的 host 包源目录映射（键 = 注册表包名）：CHAMBER_HOST_PACKAGES 中每个
 * **非 localOnly** 行必须有一个显式目录解析分支（--host-graph-dir / --host-git-dir /
 * --host-archive-dir），否则 throw——缺键会在远端 seed 与 gateway 上传被静默跳过，绝不
 * 接受；localOnly 行（open-in）不进远端 seed 表，因此不在这里建键。
 *
 * 返回目录不保证存在：包未构建时由 seed 侧 existsSync 判定跳过——「没有 sourceDir 键」
 * 是接线缺陷（fail-loud），与「未构建」是两件事。
 */
export function chamberHostSourceDirsFor(
  dirs: HeadlessCtxInputs['hostPackageDirs'],
  moduleDir: string,
  registry: readonly ChamberHostPackageDescriptor[] = CHAMBER_HOST_PACKAGES,
): Record<string, string> {
  const explicitByPackageName: Readonly<Record<string, string | null>> = {
    [CLIENT_GRAPH_PACKAGE_NAME]: dirs.graph,
    [GIT_WORKTREE_PACKAGE_NAME]: dirs.git,
    [ARCHIVE_CLEANUP_PACKAGE_NAME]: dirs.archive,
  }
  const sourceDirs: Record<string, string> = {}
  for (const descriptor of registry) {
    if (descriptor.localOnly === true) continue
    if (!Object.hasOwn(explicitByPackageName, descriptor.insert.name)) {
      throw new Error(
        `chamber host 包 '${descriptor.insert.name}' (insert id '${descriptor.insert.id}', `
        + `probe '${descriptor.probe.method}') 在注册表里非 localOnly，但 sidecar 源目录映射缺少 sourceDir 键 `
        + `'${descriptor.insert.name}'：远端 seed 与 gateway 上传都会跳过该域。请在 chamberHostSourceDirsFor `
        + '登记该域（--host-<domain>-dir 输入或等价缺省解析）',
      )
    }
    sourceDirs[descriptor.insert.name] = resolveHostPackageSourceDir(
      packageDirName(descriptor.insert.name),
      explicitByPackageName[descriptor.insert.name] ?? null,
      moduleDir,
    )
  }
  return sourceDirs
}

/** 本地 dsh spawn 门（装配体 HostLocalSpawnGates 同一形状——main 三闭包语义）。 */
export type HeadlessLocalSpawnGates = HostLocalSpawnGates

/** buildHeadlessCtx 装配结果（ctx + 回收腿 + plane 晚绑定面 + 启动尾部；与 Electron main 共用同一形状）。 */
export type HeadlessCtxAssembly = HostAssembly

/**
 * 退出清理并行编排：dispose 与 cp.stop 两条腿同时启动、一起等待（allSettled——任一腿
 * 失败只 loud，不阻断另一条腿、不改变调用方/退出码语义）。串行会把退出耗时变成两者
 * 之和，cp.stop 可能还没开始就撞 4.5s 内部硬顶，留下孤儿进程。
 *
 * legs.map 在等待任何一条结算之前已同步启动每条腿（async IIFE 首个 await 之前的
 * run() 立即执行）；allSettled 只负责收尾。本函数从不 reject。
 */
export async function settleShutdownLegs(
  legs: ReadonlyArray<{ label: string; run: () => Promise<unknown> | undefined }>,
  onLegError: (label: string, error: unknown) => void,
): Promise<void> {
  await Promise.allSettled(
    legs.map(async ({ label, run }) => {
      try {
        await run()
      } catch (error) {
        onLegError(label, error)
      }
    }),
  )
}

/**
 * 装配 Swift flavor 无头 ctx（装配本体在 host-assembly.createHostAssembly；本函数只解析
 * flavor edge 事实并注入；装配前导 reaps 本地插件写进程账目）。
 */
export async function buildHeadlessCtx(
  userDataDir: string,
  edges: HeadlessCtxEdges,
  inputs: Partial<HeadlessCtxInputs> = {},
): Promise<HeadlessCtxAssembly> {
  // <userData>/state 的派生与创建不在本文件：state 根是 control-plane 的租约对象，唯一拼写点是 shell-core.stateRootDir()。
  const settingsPath = chamberSettingsFilePath(userDataDir)

  // shell 版本事实与 shell-core/main 同源（sibling package.json）——override/activation journal 的 shellVersion 判别必须一致。
  const shellVersion = ((): string => {
    try {
      const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string }
      return pkg.version ?? 'unknown'
    } catch {
      return 'unknown'
    }
  })()
  const builtinDshWorkspace = inputs.builtinDshWorkspace ?? null
  /** chamber 版本（控制器 currentVersion / 通道判定；unknown 时版本比较恒「不可比较」→ loud error，绝不静默）。 */
  const chamberVersion = inputs.chamberVersion ?? 'unknown'

  // chamber settings：启动加载 + 损坏 loud——readSettingsFile 保留 *.corrupt 并返回
  // notice，绝不静默假默认；notice 与 Electron main 同路径 console.error（丢弃 notice
  // 等于设置被静默重置）。try/catch 只做防御，绝不静默。
  let settings: ChamberSettings = DEFAULT_CHAMBER_SETTINGS
  try {
    const loaded = readSettingsFile(settingsPath)
    if (loaded.notice !== null) console.error(`[sidecar] ${loaded.notice}`)
    settings = loaded.settings
  } catch (error) {
    console.error('[sidecar] chamber settings 读取异常（回退默认值）：' + sanitizeErrorText(describeError(error)))
  }
  // keep-awake / 登录自启的启动 reconcile 归 Swift 宿主；本 flavor 只转发 ctx 两叶
  // （async，await B 桥应答），settings 加载本身无 side-effect。

  // F 组：host 包源目录（显式 CLI 参数优先；缺省 = resolveHostPackageSourceDir：
  // workspace 根 → 打包锚点）。映射登记与缺项 loud 判定单源在 chamberHostSourceDirsFor
  // （非 localOnly 注册表行缺解析分支直接 throw，绝不静默少 seed 一个域）。
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const hostPackageSourceDirs = chamberHostSourceDirsFor(
    inputs.hostPackageDirs ?? { graph: null, git: null, archive: null, openIn: null },
    moduleDir,
  )

  // pnpm 入口解析（装配体注入；候选拼写/顺序单源在 pnpm-launcher）。
  const pnpmEntry = resolvePnpmEntry(moduleDir)

  // I 组更新控制器（v1 blocked-available 诚实形态，update-headless.ts）：发现单源——
  // 声明 nativeUpdater 时 check 经冻结边交壳内 Sparkle（相位经 __host.nativeUpdatePhase
  // 回来），绝不同时跑 GitHub releases 查询或排静默定时器；未声明原生腿才走 GitHub
  // 发现 + installBlockedReason 恒「原生壳不支持自动安装」。
  const updateController = createHeadlessUpdateController({
    version: chamberVersion,
    nativeUpdater: inputs.nativeUpdater ?? undefined,
    logger: {
      log: (...args: unknown[]) => console.log('[updater-headless]', ...args),
      warn: (...args: unknown[]) => console.warn('[updater-headless]', ...args),
      error: (...args: unknown[]) => console.error('[updater-headless]', ...args),
    },
  })

  let quittingRequested = false
  const hostEdges: HostAssemblyEdges = {
    rendererPush: (channel, payload) => edges.rendererPush(channel, payload),
    mainWindowAlive: () => edges.mainWindowAlive(),
    retireNotificationsForSources: retiredSourceIds => edges.retireNotificationsForSources(retiredSourceIds),
    showNativeMessage: opts => edges.showMessage(opts),
  }

  const assembly = await createHostAssembly({
    logTag: '[sidecar]',
    userDataDir,
    shellVersion,
    builtinDshWorkspace,
    edges: hostEdges,
    settings: {
      current: () => settings,
      commit: next => { settings = next },
    },
    // A 组设置副作用叶：两叶 async，await edges.sendEdge 的 B 桥应答。失败语义与
    // Electron 同步叶逐字一致——同步 throw 与 leg reject 同走 applySettingsPatch 的
    // catch 回滚/不持久化；{ok:false,error} 与 Electron 同一形状（诚实错误串原样）。
    setKeepAwake: async (enabled: boolean): Promise<void> => {
      try {
        // 应答体 {ok:false,error} 或 transport 失败 → throw，触发 applySettingsPatch 的 catch 回滚。
        const answer = await edges.sendEdge('setKeepAwake', { on: enabled })
        if (answer !== null && typeof answer === 'object') {
          const mapped = answer as { ok?: unknown; error?: unknown }
          if (mapped.ok === false || typeof mapped.error === 'string') {
            throw new Error(typeof mapped.error === 'string' ? mapped.error : 'setKeepAwake edge failed')
          }
        }
      } catch (error) {
        const detail = describeError(error)
        console.error(`[sidecar] keep-awake host leg failed: ${detail}`)
        throw error
      }
    },
    setLoginItem: async (
      enabled: boolean,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      // await B 桥应答后折算 {ok:true}|{ok:false,error}：transport 失败与应答体失败一律
      // 映射 {ok:false,error}，走 loud 返回 + keepAwake 回滚 + 不持久化（与 Electron 同形）。
      try {
        const answer = await edges.sendEdge('setLoginItem', { enabled })
        if (answer !== null && typeof answer === 'object') {
          const mapped = answer as { ok?: unknown; error?: unknown }
          if (mapped.ok === false || typeof mapped.error === 'string') {
            const detail = typeof mapped.error === 'string' ? mapped.error : 'setLoginItem edge failed'
            console.error(`[sidecar] login-item host leg failed: ${detail}`)
            return { ok: false, error: detail }
          }
        }
        return { ok: true }
      } catch (error) {
        const detail = describeError(error)
        console.error(`[sidecar] login-item host leg failed: ${detail}`)
        return { ok: false, error: detail }
      }
    },
    isQuitting: () => quittingRequested,
    markQuitting: () => { quittingRequested = true },
    hostFacts: { flavor: 'swift', trayPresent: () => true },
    // 无 safeStorage 适配器 → 0600 plaintext 回退 + loud 注册（Swift 非 win32，
    // windowsRefusePlaintext 判据不触发）。
    hostPackageSourceDirs,
    pnpmEntry,
    updateController,
    // 更新退出腿回撤叶：Swift v1 blocked-available 从不武装（无 quitAndInstall 腿），显式惰性 no-op。
    disarmUpdaterQuit: (_reason: string) => {},
    // 原生 Sparkle 的 downloaded/installing 等价于 Electron 的「更新已下载豁免」——退出
    // 确认不得拦下即将安装的重启；无原生安装腿时相位永不到 downloaded，恒 false。
    updateQuitExempt: () => {
      const phase = updateController.state().phase
      return phase === 'downloaded' || phase === 'installing'
    },
    // 装配形态：--dsh-path = <sidecar>/vendor/dsh（随包拷贝 package.json + pnpm-lock.yaml
    // + pnpm-workspace.yaml），与 Electron 的 vendor/dsh 同一锚。dev 若指向源码线
    // ref-dsh，其锁文件带 opt-in 段会被 F 信任判据拒绝 ⇒ familyNames=null ⇒ 官方 scope
    // 安装一律拒：有意的 fail-closed，不是路径错误。
    pinnedRuntimeLockfilePath: () => {
      if (builtinDshWorkspace === null) return null
      const candidate = path.join(builtinDshWorkspace, 'pnpm-lock.yaml')
      return existsSync(candidate) ? candidate : null
    },
    // 无内建树时启动事务终态恒「无法确认内建版本 → blocked」，发布无紧急性：延迟一个
    // 静默窗再跑，避免 ready 后首屏采样窗内的 RUNTIME_STATE_CHANGED push 竞态（采样以
    // 「注册后第一个 push」为判据）；有内建树不延迟，本地实例起动与 Electron 同序。
    missingBuiltinStartupTailDelayMs: 1500,
  })

  /** 递归 stub：调用即抛 + 任意成员访问返回同款 stub——只覆盖未来接口新增而未接线的
   *  成员；缺字段调用 loud，绝不静默 undefined 崩溃。 */
  const methodStub = (prefix: string): ((..._args: never[]) => never) =>
    new Proxy(
      function stub(): never {
        throw new Error('sidecar-ctx-unavailable:' + prefix)
      },
      {
        get(target, key) {
          const own = Reflect.get(target, key)
          if (own !== undefined) return own
          if (key === 'apply' || key === 'bind' || key === 'call') {
            return Function.prototype[key as 'apply' | 'bind' | 'call']
          }
          if (typeof key === 'string') return methodStub(prefix + '.' + key)
          return undefined
        },
      },
    ) as ((..._args: never[]) => never)
  const ctx = new Proxy(assembly.ctx as object, {
    get(target: Record<string, unknown>, key: string | symbol) {
      if (typeof key === 'symbol') return undefined
      if (key in target) return target[key]
      return methodStub(String(key))
    },
  }) as unknown as ShellAssemblyCtx

  return { ...assembly, ctx }
}
