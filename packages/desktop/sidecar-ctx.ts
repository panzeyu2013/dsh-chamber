/**
 * sidecar-ctx.ts —— Swift flavor sidecar 无头 ctx 装配的 **edge 接线**
 * （design 25 §3.1/§4.1）。
 *
 * 装配本体（C/D/E/F/G/H/J/K 组注册体依赖：transportManager / 凭据存储 /
 * gateway 会话 / host 包 seed / runtime 控制器族 / publishRegistryTransition /
 * sm.onStatusChanged·onVerified 订阅 / 本地 spawn 门 / 启动尾部 / 回收腿）已收敛到
 * host-assembly.ts 的 createHostAssembly——与 Electron main **同一实现**
 * （审计 R1/arch-01 P1-1：两 flavor 曾逐字抄两遍）。本文件只保留 Swift 宿主
 * 的 edge 事实与 flavor 差异：
 *  1. edges 适配：node-edges 的 rendererPush / mainWindowAlive /
 *     retireNotificationsForSources / showMessage（NSAlert 按钮序号应答）；
 *  2. A 组设置副作用叶：ctx.setKeepAwake/setLoginItem 经 edges.sendEdge
 *     await B 桥应答（Electron 为同步叶；回应答体 {ok:false,error} 与 transport
 *     失败一律折算失败——applySettingsPatch 的 catch 回滚/不持久化路径同形）；
 *  3. gateway secret store 无 safeStorage（Electron-free）→ 诚实 loud 的 0600
 *     plaintext 回退（design 17 §12/S22，装配体按 crypto undefined 分支）；
 *  4. Swift 打包布局：host 包源目录解析（--host-*-dir 显式参数 > workspace 根 >
 *     <moduleDir>/dist/<pkg>）与内嵌 pnpm 入口（pnpm-launcher 单源选择）；
 *  5. I 组更新控制器 = update-headless（v1 blocked-available 诚实形态；
 *     --native-updater sparkle 时转发壳内 Sparkle，绝不双源发现）；
 *  6. 退出事实：本地 quitting 门 + Sparkle downloaded/installing 豁免判据；
 *  7. settings 加载（keep-awake / 登录自启启动 reconcile 归 Swift 宿主——
 *     settings 只加载不副作用）。
 *
 * Electron-free 不变式：本文件零 electron import（electron-free-gate 面 A 对
 * packages/desktop 顶层源码自动覆盖）；装配体 host-assembly.ts 同样零 electron
 * （面 D 闭包：sidecar-entry → 本文件 → host-assembly）。
 *
 * 打包布局锚点与 host 包源目录解析——具名纯/近纯函数，Swift 布局锁步测试
 * （macos/.../PackagedLayoutTests.swift）读本段源文本与主锚点；调用方只在
 * buildHeadlessCtx 内。路径事实的单源：
 *   - host 包构建产物：<sidecarDir>/dist/<pkg>（Swift AppDelegate 的
 *     sidecarDir + "/dist/" + name；build-sidecar.sidecarLayout().hostPackageDist）；
 *   - 内嵌 pnpm 入口：<sidecarDir>/pnpm/bin/pnpm.cjs（sidecarLayout().pnpmEntry）。
 * 改这些拼写必须同时改 macos/scripts/build-sidecar.mjs 与 Swift 侧锚点断言。
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

/** 旧装配位：`<sidecarDir>/../pnpm/bin/pnpm.cjs`（sidecar 装配于
 *  Resources/sidecar/ 时的 Electron extraResources 同构位 Resources/pnpm）。 */
export function legacyPackagedPnpmEntry(sidecarDir: string): string {
  return path.join(sidecarDir, '..', 'pnpm', 'bin', 'pnpm.cjs')
}

/** dev 位：`<moduleDir>/node_modules/pnpm/bin/pnpm.cjs`（pinned dep）。 */
export function devPnpmEntry(moduleDir: string): string {
  return path.join(moduleDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
}

/** 检索根：自 startDir 向上第一个含 `pnpm-workspace.yaml` 的目录——
 *  host 包源目录探测必须限定在 workspace 根，祖先链上任意同名
 *  `packages/<pkg>/package.json` 不得成为 seed 源。找不到 → null。 */
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

/** host 包源目录解析：显式 CLI 目录 > workspace 根
 *  `packages/<dir>`（且 package.json 存在）> 打包布局 `<moduleDir>/dist/<dir>`。
 *  返回值不保证存在——seed 侧按存在性 loud 过滤（与 main.ts 同向）。 */
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

/** pnpm 入口解析：装配位 > 旧装配位 > dev node_modules；全缺失时保留 dev 形状
 *  （安装路径上的 loud 失败与 main 缺 artifact 的 loud 语义同向）。候选集/顺序的
 *  唯一实现在 pnpm-launcher（bundledPnpmEntryCandidates + firstExistingPnpmEntry），
 *  本函数只提供本 flavor 的三条布局拼写（Swift 锁步锚点）。 */
export function resolvePnpmEntry(moduleDir: string): string {
  const candidates = bundledPnpmEntryCandidates({
    platform: process.platform,
    moduleDir,
    assemblyEntry: packagedPnpmEntry(moduleDir),
    legacyAssemblyEntry: legacyPackagedPnpmEntry(moduleDir),
  })
  return firstExistingPnpmEntry(candidates, existsSync) ?? devPnpmEntry(moduleDir)
}

/** publish/confirm 等真实叶所需的宿主边沿子集（node-edges 实现——sidecar-entry
 *  把同一 edges 实例传给 buildHeadlessCtx 与 installIpcHandlers：单装配不变式，
 *  push/确认对话框宿主腿与 core 投递状态机同对象、同事实缓存）。A 组设置副作用叶经
 *  sendEdge（node-edges 公开转发 → B 桥 edge 'setKeepAwake'/'setLoginItem'，
 *  Swift 侧 legs）await 应答（见下方 sendEdge 注释与 buildHeadlessCtx 两叶）。 */
export interface HeadlessCtxEdges {
  rendererPush(channel: string, payload: unknown): boolean
  mainWindowAlive(): boolean
  retireNotificationsForSources(retiredSourceIds: ReadonlySet<string>): number
  showMessage(opts: HostMessageOptions): Promise<number>
  /** B 桥异步 edge 请求面（node-edges 公开 sendEdge 转发——sidecar-entry
   *  用同一实例注入；edgeId 关联在实现侧）：resolve = 宿主应答 ok
   *  （frame.ok:true 的 result），reject = transport ok:false / leg 错误
   *  （sidecar-entry 应答分派折算；Error.message = Swift legs 错误串）。A 组
   *  设置副作用叶 await 本面应答——leg 失败不得 fire-and-forget，失败回滚
   *  语义与 Electron 同步叶一致。 */
  sendEdge(method: string, payload: unknown): Promise<unknown>
}

/** Swift flavor 宿主输入（sidecar-entry 装配接线注入）。 */
export interface HeadlessCtxInputs {
  /** 内建 dsh workspace（sidecar-entry --dsh-path；打包 = Resources/vendor/dsh，
   *  dev = repo ref-dsh 等位）——启动事务的 builtin 分支与 bundled 版本解析共用。 */
  builtinDshWorkspace: string | null
  /** 当前 chamber 版本（sidecar-entry 读 packages/desktop/package.json 的
   *  shellVersion）——Swift flavor 更新控制器的 currentVersion / 通道判定输入。 */
  chamberVersion?: string
  /** chamber host 包源目录（sidecar-entry --host-graph-dir/--host-git-dir/
   *  --host-archive-dir/--host-open-in-dir；打包 Resources 布局由 Swift 侧
   *  传参——null = 用缺省解析（见 resolveHostPackageSourceDir 注释）。openIn 只喂
   *  本地控制面播种（localOnly 行），不进远端 seed 数组。 */
  hostPackageDirs: {
    graph: string | null
    git: string | null
    archive: string | null
    openIn: string | null
  }
  /** 原生更新器桥（sidecar-entry 按 --native-updater 构造）。
   *  缺省 = 无原生安装腿：更新控制器保持 blocked-available，且只有此时 check 才走
   *  GitHub releases 发现（声明了原生腿就交壳的 Sparkle appcast，绝不双源）。 */
  nativeUpdater?: NativeUpdaterBridge | null
}

/**
 * Swift flavor 的 host 包源目录映射（键 = 注册表包名）。注册表驱动：遍历
 * CHAMBER_HOST_PACKAGES，每个**非 localOnly** 行必须有一个显式目录解析分支
 * （--host-graph-dir / --host-git-dir / --host-archive-dir），否则 throw——
 * 该域会在远端 seed 与 gateway 上传被静默跳过，绝不接受。localOnly 行
 * （open-in）不进远端 seed 表（sidecar-entry 把 --host-open-in-dir 直接喂本地
 * 控制面播种），因此不在这里建键。
 *
 * 返回目录不保证存在：包确实未构建时由 seed 侧
 * builtChamberHostPackageSeeds 的 dist/index.js existsSync 判定跳过——「没有
 * sourceDir 键」与「未构建」是两件事，前者是接线缺陷（与本地控制面 seed 的
 * fail-loud 对齐）。
 * @param dirs - 显式 CLI 目录（null = 走 resolveHostPackageSourceDir 缺省布局）。
 * @param moduleDir - 本模块目录（打包锚点 <moduleDir>/dist/<pkg> 的基准）。
 * @param registry - 权威注册表（可注入：单测用合成行验证缺键即 throw）。
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

/** buildHeadlessCtx 的装配结果（ctx + 回收腿 + plane 晚绑定面 + 启动尾部；
 *  与 Electron main 共用 host-assembly.HostAssembly 同一形状）。 */
export type HeadlessCtxAssembly = HostAssembly

/**
 * 退出清理并行编排：把 dispose 与 cp.stop 两条腿**同时启动**、一起等待
 * （allSettled 语义——任一腿失败只 loud，不阻断另一条腿、不改变调用方/退出码
 * 语义）。与 Electron main will-quit 的单个 Promise.allSettled 同形：串行的
 * `await dispose` → `await cp.stop` 会把
 * 退出耗时变成两者之和，cp.stop（本地 dsh/ssh 子进程回收腿）可能还没开始就撞
 * 4.5s 内部硬顶（QUIT_CLEANUP_DEADLINE_MS），留下孤儿进程。
 *
 * 启动语义：`legs.map(...)` 同步为每条腿建立 promise（async IIFE 体内首个
 * await 之前的 `run()` 立即执行），因此**所有腿都在等待任何一条结算之前已经
 * 启动**——这正是并行与串行的分界；`allSettled` 只负责收尾等待。
 *
 * @param legs 有序腿表（label 只用于失败日志，保持两条腿各自的既有文案）
 * @param onLegError 单腿失败 loud 腿（本函数从不 reject：失败只经它上报）
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
 * 装配 Swift flavor 无头 ctx（agent：装配本体在 host-assembly.createHostAssembly；
 * 本函数只解析 flavor edge 事实并注入）。async：装配前导 reaps 本地插件写进程账目
 * （装配体内完成）。
 */
export async function buildHeadlessCtx(
  userDataDir: string,
  edges: HeadlessCtxEdges,
  inputs: Partial<HeadlessCtxInputs> = {},
): Promise<HeadlessCtxAssembly> {
  // <userData>/state 的派生与创建都不在本文件：state 根是 control-plane 的
  // 租约对象（createControlPlane 构造期 ensurePrivateDirectoryNoFollow），
  // 唯一拼写点是 shell-core.stateRootDir()（sidecar-entry 传参）。
  const settingsPath = chamberSettingsFilePath(userDataDir)

  // shell 版本事实：与 shell-core/main 同源（sibling package.json）——
  // override/activation journal 的 shellVersion 判别必须与 core 读到的版本一致。
  const shellVersion = ((): string => {
    try {
      const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string }
      return pkg.version ?? 'unknown'
    } catch {
      return 'unknown'
    }
  })()
  const builtinDshWorkspace = inputs.builtinDshWorkspace ?? null
  /** chamber 版本（更新控制器 currentVersion / 通道判定；缺省 unknown 时
   *  check 仍可用，只是版本比较恒判「不可比较」→ loud error，绝不静默）。 */
  const chamberVersion = inputs.chamberVersion ?? 'unknown'

  // chamber settings（design 14 D7）：启动加载 + 损坏 loud——readSettingsFile
  // 自身保留 *.corrupt 并返回 notice，绝不静默假默认；notice 与 Electron main
  // 同路径 console.error（notice 绝不丢弃——否则设置被静默重置为默认而 stderr
  // 无任何解释）；读取异常同样 loud 回退（readSettingsFile 按契约恒返回 notice
  // 而非抛错，这里只做防御，绝不静默）。
  let settings: ChamberSettings = DEFAULT_CHAMBER_SETTINGS
  try {
    const loaded = readSettingsFile(settingsPath)
    if (loaded.notice !== null) console.error(`[sidecar] ${loaded.notice}`)
    settings = loaded.settings
  } catch (error) {
    console.error('[sidecar] chamber settings 读取异常（回退默认值）：' + sanitizeErrorText(describeError(error)))
  }
  // keep-awake / 登录自启启动 reconcile 在 Electron 为宿主腿
  // （setKeepAwakeActive/applyLaunchAtLogin，同步应用加载值）。Swift flavor：
  // 宿主腿经 ctx.setKeepAwake/setLoginItem 真实转发（下方两叶——async 叶，await
  // B 桥应答）；启动期 reconcile 归 Swift 宿主（Swift 起壳时按自身设置面应用），
  // settings 加载本身不 side-effect。

  // —— F 组：chamber host 包源目录（显式 CLI 参数优先；缺省 = 具名
  // resolveHostPackageSourceDir：workspace 根检索（限定含 pnpm-workspace.yaml
  // 的根）→ 打包锚点 <moduleDir>/dist/<pkg>（与 Swift AppDelegate /
  // build-sidecar.sidecarLayout 同拼写）。映射登记与缺项 loud 判定单源化在
  // chamberHostSourceDirsFor：非 localOnly 注册表行缺解析分支直接 throw，
  // 绝不静默少 seed 一个域。
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const hostPackageSourceDirs = chamberHostSourceDirsFor(
    inputs.hostPackageDirs ?? { graph: null, git: null, archive: null, openIn: null },
    moduleDir,
  )

  // pnpm 入口解析（装配体注入；候选拼写/顺序单源在 pnpm-launcher）。
  const pnpmEntry = resolvePnpmEntry(moduleDir)

  // I 组更新控制器（design 25 §7「v1 blocked-available 诚实形态」）：Swift flavor
  // 用 update-headless.ts 的纯 Node 控制器。发现单源：inputs.nativeUpdater 在场
  // （壳声明 --native-updater sparkle）时 check 经冻结边 updateNativeAction kind=check
  // 交壳内 Sparkle（appcast 单源），相位经 __host.nativeUpdatePhase 回来；sidecar
  // 绝不再跑 GitHub releases 查询、也不排静默检查定时器；未声明原生腿时（dev /
  // dry-run / 未配置密钥）才走 GitHub 发现 + installBlockedReason 恒为「原生壳不支持
  // 自动安装」。契约零改动（UpdateState 七值/字段集不变）。
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
    // A 组设置副作用叶——Electron 的 shellCtx
    // setKeepAwake: enabled => setKeepAwakeActive(enabled) /
    // setLoginItem: enabled => applyLaunchAtLogin(enabled) 的 Swift flavor
    // 同形：两叶 async，await 注入 edges.sendEdge 的 B 桥应答。失败语义与 Electron
    // 同步叶逐字一致——Electron setKeepAwakeActive 同步失败 throw（applySettingsPatch
    // catch 回滚）与 Swift leg 失败 reject 同一条路径；Electron applyLaunchAtLogin
    // 失败 {ok:false,error} 与 Swift leg 失败 {ok:false,error} 同形（leg 诚实错误串
    // 原样进 {error} → loud 返回 + keepAwake 回滚 + 绝不持久化）。
    setKeepAwake: async (enabled: boolean): Promise<void> => {
      try {
        // 应答 ok（transport resolve）→ resolve；应答体携带 {ok:false,error} 或
        // transport 层失败（ok:false → sendEdge reject）→ throw（触发
        // applySettingsPatch 的 catch 回滚路径，与 Electron 同步失败同形）。
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
      // await B 桥应答后折算 {ok:true}|{ok:false,error}：transport 层失败
      // （sendEdge reject——Swift legs no-bundle/unavailable/apply-failed 等诚实错误串）
      // 与应答体 {ok:false,error} 一律映射 {ok:false,error}——applySettingsPatch 的
      // loud 返回路径（+ keepAwake 回滚 + 不持久化），与 Electron applyLaunchAtLogin
      // 失败 {error} 同形，绝不静默。
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
    // 无 Electron safeStorage 适配器 → 装配体走 plaintext 回退分支（下方
    // host-assembly 的 windowsRefusePlaintext 判据 = win32 && crypto undefined；
    // Swift flavor 非 win32 ⇒ 0600 plaintext + loud 注册，design 17 §12/S22）。
    hostPackageSourceDirs,
    pnpmEntry,
    updateController,
    // 更新退出腿回撤叶：Swift v1 blocked-available 从不武装（无 quitAndInstall 腿），
    // 这里是显式惰性 no-op（装配体把缺省叶接入 core 的 I 组状态订阅）。
    disarmUpdaterQuit: (_reason: string) => {},
    // updateDownloadReady：原生 Sparkle 阶段经 __host.nativeUpdatePhase 进同一个更新
    // 投影后，downloaded/installing 就是 Electron before-quit 的「更新已下载豁免」
    // 等价态——退出确认不得拦下即将安装的重启。无原生安装腿时相位永不到 downloaded，
    // 恒 false（原语义不变）。
    updateQuitExempt: () => {
      const phase = updateController.state().phase
      return phase === 'downloaded' || phase === 'installing'
    },
    // 装配形态：--dsh-path = <sidecar>/vendor/dsh（build-sidecar 随包拷贝
    // package.json + pnpm-lock.yaml + pnpm-workspace.yaml），与 Electron 的
    // <resources|pkgDir>/vendor/dsh/pnpm-lock.yaml 是同一份锚。dev 形态：runbook 把
    // DSH_CHAMBER_DSH_PATH 指向 packages/desktop/vendor/dsh（同一锚）；若有人把它指向
    // 源码线 ref-dsh，该树的锁文件带 opt-in 段会被 F 信任判据拒绝 ⇒ familyNames=null
    // ⇒ 官方 scope 安装一律拒（保守降级、绝不按另一条线误判），这是有意的 fail-closed
    // 行为而非路径错误。
    pinnedRuntimeLockfilePath: () => {
      if (builtinDshWorkspace === null) return null
      const candidate = path.join(builtinDshWorkspace, 'pnpm-lock.yaml')
      return existsSync(candidate) ? candidate : null
    },
    // 无内建 dsh 树（--dsh-path 缺省）时，启动事务的终态恒为「无法确认内建版本 →
    // blocked」，其发布无紧急性：延迟一个静默窗再跑，使 ready 后的首屏/门禁采样窗口内
    // 不存在 RUNTIME_STATE_CHANGED push 竞态（rendererPush 采样以「注册后第一个 push」
    // 为判据）；有内建树（真实 product 路径）不延迟——本地实例起动与 Electron 同序
    // 不引入额外时延。
    missingBuiltinStartupTailDelayMs: 1500,
  })

  /** 递归 stub：可调用（调用即抛）+ 任意成员访问返回同款 stub（供
   *  installIpcHandlers 顶部解构对象字段/方法后、在 handler 运行时才调用
   *  的形态）；装配体已提供全部 ShellAssemblyCtx 成员，本兜底只覆盖未来接口
   *  新增而未接线的成员——缺字段调用即 loud，绝不静默 undefined 崩溃。 */
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
