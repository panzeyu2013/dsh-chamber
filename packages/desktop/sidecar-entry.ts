/**
 * sidecar-entry.ts —— Swift flavor sidecar 进程入口（W-11/W-12；design 25
 * §3.1/§3.3/§4.4.2/D2/D8）
 *
 * 进程模型（design 25 §3.1）：Swift 壳 spawn 本进程（node sidecar-entry.ts
 * --user-data-dir <dir> [--dsh-path …] [--web-dist-dir …] [--port N]
 * [--host-graph-dir …] [--host-git-dir …] [--host-archive-dir …]）。
 * - stdout = B 桥协议流（NDJSON，唯一协议写面）；stderr = 日志（D2：入口把
 *   存量 console.* 重定向到 stderr）。
 * - 业务 = shell-core.installIpcHandlers（60/60 注册体，语义与 Electron 版
 *   同一实现）；宿主边沿 = node-edges.ts（HostEdges → edge/notify → Swift）。
 * - 无头 ctx = sidecar-ctx.ts buildHeadlessCtx（W-13 拆分落位；S-C-1 起
 *   C/D/E 组注册体依赖真实化；S-C-2 起 F/G/H/J/K 组注册体依赖 + runtime
 *   控制器族全部真实化——见 sidecar-ctx.ts 头注释。本文件（装配接线）：
 *   buildHeadlessCtx 增 inputs（--dsh-path → builtinDshWorkspace、host 包源
 *   三目录）；本地 dsh spawn 门（localSpawnGates）原样接入 createControlPlane
 *   （main 1203-1220 三闭包语义）；controlPlane.start() 后 bindPlane(cp)（plane
 *   晚绑定：代理注册/会话 refresh/restart 宿主腿/connectionState 投影）→
 *   ready 帧 → runStartupTail()（main 3785-3789 同形——refreshRuntimeEvidence
 *   .then(runRuntimeStartup)：本地实例启动/激活由启动事务权威决定，取代
 *   S-C-2 前的无条件 pre-spawn startLocal（Electron main 语义同源——渲染器
 *   自动启动 POST 幂等同路径，canStartLocal/canExposeLocal 门控制）。）
 * - 生命周期：SIGTERM/SIGINT/stdin EOF → 优雅回收（quitting 门 + 在飞运行时
 *   事务 abort + cp.stop + ctx 侧 transport/gateway 会话/插件子进程/安装器
 *   回收（dispose——SSH 子进程不孤儿化））→ exit 0；uncaught → stderr + exit 1
 *   （B7 fatal 分级）。
 *
 * Electron-free 不变式：本文件零 electron import（electron-free-gate 面 A）。
 */
import process from 'node:process'
import { createInterface } from 'node:readline'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeQuitRisk, shouldHideToTray } from './chamber-settings.ts'
// control-plane 一律经 facade 取（**不要** import 裸包名）：装配态（W-23）目录
// 没有 node_modules 树，facade 的 isPackagedSidecarRuntime 分支加载
// `<sidecar>/dist/control-plane/index.js`；裸说明符在打包态 ERR_MODULE_NOT_FOUND
// （2026-09 W-24 实测）。dev/测试态 facade 仍走 workspace 符号链接。
import { createControlPlane, isPackagedSidecarRuntime } from './control-plane-module.ts'
import {
  drainDeepLinkLaunches,
  enqueueDeepLink,
  installIpcHandlers,
  onRendererLifecycle,
  type IpcRegistrar,
  type ShellAssemblyCtx,
} from './shell-core.ts'
import { createNodeEdges, HOST_INBOUND } from './node-edges.ts'
import { buildHeadlessCtx, type HeadlessCtxAssembly } from './sidecar-ctx.ts'
import {
  EXIT_GRACEFUL,
  EXIT_LOCK_CONFLICT,
  EXIT_RUNTIME_CRASH,
  EXIT_STARTUP_FAILURE,
} from './sidecar-exit-codes.ts'

// ---------------------------------------------------------------------------
// 0. console 重定向（D2）：stdout 只允许协议写——console.log/info/debug 全部
//    转 stderr（带 [sidecar-console] 前缀）；warn/error 原样走 stderr。
// ---------------------------------------------------------------------------
const stderrLine = (prefix: string, args: unknown[]): void => {
  process.stderr.write(
    `[sidecar] ${prefix} ${args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ')}\n`,
  )
}
function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}
const originalWarn = console.warn.bind(console)
const originalError = console.error.bind(console)
console.log = (...args: unknown[]) => stderrLine('console:', args)
console.info = (...args: unknown[]) => stderrLine('console:', args)
console.debug = (...args: unknown[]) => stderrLine('console:', args)
console.warn = (...args: unknown[]) => originalWarn(...args)
console.error = (...args: unknown[]) => originalError(...args)

// ---------------------------------------------------------------------------
// 1. 参数与环境解析
// ---------------------------------------------------------------------------
function parseArgs(argv: readonly string[]): {
  userDataDir: string
  dshPath: string | null
  webDistDir: string | null
  hostGraphDir: string | null
  hostGitDir: string | null
  hostArchiveDir: string | null
  port: number | null
} {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] ?? null : null
  }
  const userDataDir = get('--user-data-dir')
  if (userDataDir === null || userDataDir.length === 0) {
    throw new Error('sidecar-entry: --user-data-dir <dir> 必填')
  }
  const portRaw = get('--port') ?? process.env.DSH_CHAMBER_CP_PORT ?? null
  return {
    userDataDir,
    dshPath: get('--dsh-path'),
    webDistDir: get('--web-dist-dir'),
    hostGraphDir: get('--host-graph-dir'),
    hostGitDir: get('--host-git-dir'),
    hostArchiveDir: get('--host-archive-dir'),
    port: portRaw === null ? null : Number(portRaw),
  }
}
const args = parseArgs(process.argv.slice(2))
mkdirSync(args.userDataDir, { recursive: true })

// ---------------------------------------------------------------------------
// 2. 目录锁复验（design 25 §6.3 B2：不二次 flock——Swift 侧持锁；本进程只读
//    锁记录校验**父 pid**，防双 flavor 并发）。
//
//    语义（关键）：记录里的 pid 是**持锁方**（Swift 壳）的 pid，而本进程是它
//    直接 spawn 的子进程 → 正常情形 `record.pid === process.ppid`，属「我方的
//    父进程持锁」，**不是**冲突。只有记录 pid 既不是本进程也不是父进程、且仍
//    存活时，才是「另一 flavor/实例正占用同一 userData」→ loud exit 3
//    （Supervisor 对 exit 3 走 fatal 不重启，见 SidecarSupervisor）。
//    记录 pid 已死 = 陈旧锁（flock 随进程死亡释放，内核已无持有者）→ 放行。
// ---------------------------------------------------------------------------
const lockFile = path.join(args.userDataDir, '.dsh-chamber.lock')
if (existsSync(lockFile)) {
  try {
    const record = JSON.parse(readFileSync(lockFile, 'utf8')) as { pid?: number }
    const recordedPid = record.pid
    const isSelf = recordedPid === process.pid
    const isParent = recordedPid === process.ppid
    if (typeof recordedPid === 'number' && recordedPid > 0 && !isSelf && !isParent) {
      let alive = false
      try {
        process.kill(recordedPid, 0)
        alive = true
      } catch (err) {
        // EPERM = 进程存在但无权限发信号 → 仍然存活（2026-09 模块评审 low #5：
        // 原实现把任何异常都当已死，会误放行另一 flavor 的持有者）。
        alive = (err as NodeJS.ErrnoException).code === 'EPERM'
      }
      if (alive) {
        console.error(`[sidecar] 目录锁被占用（pid=${recordedPid}，本进程 ppid=${process.ppid}）——另一 flavor/实例正在使用 ${args.userDataDir}，退出`)
        process.exit(EXIT_LOCK_CONFLICT)
      }
    }
  } catch (err) {
    console.error('[sidecar] 锁文件解析失败（忽略，Swift 侧持锁）：' + String(err))
  }
}

// ---------------------------------------------------------------------------
// 3. B 桥协议服务端（stdin 入站；stdout 唯一协议写面）
// ---------------------------------------------------------------------------
type Handler = (payload: unknown) => unknown | Promise<unknown>
const registry = new Map<string, Handler>()
const ipcRegistrar: IpcRegistrar = {
  handle(channel, handler) {
    registry.set(channel, handler)
  },
}

/** stdout 协议行写（单线程下写原子；绝不允许其他代码写 stdout）。 */
function writeProtocolLine(frame: unknown): void {
  process.stdout.write(safeStringify(frame) + '\n')
}

const pendingEdges = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
let nextEdgeId = 1
/** edge 往返超时（2026-09 模块评审 low #6）：Swift 不应答时不得永久挂起。
 *  **交互腿豁免**（二轮评审 medium）：showMessage / pickPluginSource 是主线程
 *  模态（NSAlert / NSOpenPanel），用户思考/浏览可能远超 30s——按 10 分钟上限，
 *  超时才 loud 失败。 */
const EDGE_TIMEOUT_MS = 30_000
const INTERACTIVE_EDGE_TIMEOUT_MS = 600_000
const INTERACTIVE_EDGE_METHODS = new Set(['showMessage', 'pickPluginSource'])

const nodeEdges = createNodeEdges({
  sendEdge(method, payload) {
    return new Promise<unknown>((resolve, reject) => {
      const edgeId = nextEdgeId
      nextEdgeId += 1
      const timeoutMs = INTERACTIVE_EDGE_METHODS.has(method)
        ? INTERACTIVE_EDGE_TIMEOUT_MS
        : EDGE_TIMEOUT_MS
      const timer = setTimeout(() => {
        if (!pendingEdges.has(edgeId)) return
        pendingEdges.delete(edgeId)
        reject(new Error(`host edge 应答超时（${timeoutMs}ms）：${method}`))
      }, timeoutMs)
      timer.unref?.()
      pendingEdges.set(edgeId, {
        resolve(v) { clearTimeout(timer); resolve(v) },
        reject(e) { clearTimeout(timer); reject(e) },
      })
      writeProtocolLine({ edge: method, payload, edgeId })
    })
  },
  sendNotify(event, payload) {
    writeProtocolLine({ notify: event, payload })
  },
  // 入站汇（design 25 §4.5/§5 E19）：Swift 深链与渲染器生命周期事件经 B 桥
  // __host.deepLink / __host.rendererLifecycle 到达，原样进 core 权威状态机
  // （enqueueDeepLink 归一化去重/队列；onRendererLifecycle ready 位复位 +
  // in-flight requeue/drain）——语义单源，Swift 侧不复制。
  onDeepLink(url) {
    enqueueDeepLink(url)
  },
  onRendererLifecycle(event) {
    onRendererLifecycle(event)
  },
  // 关窗/退出决策投影（E1/E9/E20）：事实取自无头 ctx（chamber settings 实时
  // holder + LOCAL_RUNNING_STATES × localProcessAlive），决策由 chamber-settings
  // 两个纯函数合成——与 Electron main.ts before-quit / close 分支同一语义源，
  // Swift 侧不复制决策逻辑。
  projectQuitFacts(input) {
    if (headless === null) {
      throw new Error('sidecar-edges:quit-facts-before-ctx-ready')
    }
    const facts = headless.quitFacts()
    const hideOnClose = shouldHideToTray(
      facts.windowCloseBehavior,
      input.recoveryAvailable,
      input.quitRequested,
    )
    const risk = computeQuitRisk({
      quitConfirmation: facts.quitConfirmation,
      localRunning: facts.localRunning,
      updateDownloadReady: facts.updateDownloadReady,
    })
    return {
      hideOnClose,
      quitNeedsConfirm: risk.needsConfirm,
      quitReasons: risk.reasons,
    }
  },
  hostFacts: {
    trayAvailable: true, // mac Dock 常驻（design 14 D1）
    isPackaged: true,
    mainWindowAlive: true,
    webViewContentAlive: true,
  },
})

/** 入站分派：edge 应答 → host 保留 method → 60 通道注册表。 */
async function handleInboundLine(line: string): Promise<void> {
  let frame: Record<string, unknown>
  try {
    frame = JSON.parse(line) as Record<string, unknown>
  } catch {
    console.error('[sidecar] 非协议帧（丢弃，fail-loud）：' + line.slice(0, 200))
    return
  }
  if (typeof frame.edgeId === 'number') {
    const pending = pendingEdges.get(frame.edgeId)
    if (pending !== undefined) {
      pendingEdges.delete(frame.edgeId)
      if (frame.ok === true) pending.resolve(frame.result ?? null)
      else pending.reject(new Error(typeof frame.error === 'string' ? frame.error : 'edge-failed'))
    } else {
      // 迟到应答（已超时/已作废）：原实现静默丢弃，用户操作结果无声消失。
      console.error(`[sidecar] 迟到的 edge 应答（edgeId=${frame.edgeId}，已超时或已取消）：ok=${frame.ok === true}`)
    }
    return
  }
  if (typeof frame.id !== 'number' || typeof frame.method !== 'string') {
    console.error('[sidecar] 缺 id/method 的入站帧（丢弃）：' + line.slice(0, 200))
    return
  }
  const { id, method, payload } = frame
  const hostInbound = Object.values(HOST_INBOUND).includes(method as (typeof HOST_INBOUND)[keyof typeof HOST_INBOUND])
  try {
    if (hostInbound) {
      const outcome = nodeEdges.handleHostInbound(method, payload ?? null)
      writeProtocolLine({
        id,
        ok: outcome.ok,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.result === undefined ? {} : { result: outcome.result }),
      })
      return
    }
    const handler = registry.get(method)
    if (handler === undefined) {
      writeProtocolLine({ id, ok: false, error: 'sidecar-unknown-channel' })
      return
    }
    const result = await handler(payload ?? null)
    writeProtocolLine({ id, ok: true, result: result ?? null })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    writeProtocolLine({ id, ok: false, error: message.replace(/\n/g, ' ') })
  }
}

// ---------------------------------------------------------------------------
// 4. 装配启动（async bootstrap）：无头 ctx（S-C-1/S-C-2 真实化装配）→
//    shell-core 60/60 注册体（installIpcHandlers 恰一次、先于 ready）→
//    control-plane 装配（本地 spawn 门 = headless.localSpawnGates——main
//    1203-1220 同语义）→ bindPlane（plane 晚绑定）→ ready 帧 → 启动尾部。
// ---------------------------------------------------------------------------
const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const shellVersion = ((): string => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(moduleDir, 'package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

let headless: HeadlessCtxAssembly | null = null
let ctx: ShellAssemblyCtx | null = null
let controlPlaneInstance: Awaited<ReturnType<typeof createControlPlane>> | null = null
let shuttingDown = false
/** pre-spawn 回退幂等门（W-13 补；见 main() 内注释） */
let startLocalAttempted = false

async function boot(): Promise<void> {
  // S-C-1/S-C-2 无头 ctx（async：启动前导 reaps 本地插件写进程账目；edges =
  // 上方 nodeEdges 同一实例——单装配不变式，publish push/确认对话框/设置
  // 副作用宿主腿与 installIpcHandlers 投递状态机同对象）。
  headless = await buildHeadlessCtx(args.userDataDir, nodeEdges, {
    builtinDshWorkspace: args.dshPath,
    chamberVersion: shellVersion,
    hostPackageDirs: {
      graph: args.hostGraphDir,
      git: args.hostGitDir,
      archive: args.hostArchiveDir,
    },
  })
  ctx = headless.ctx

  // shell-core 装配（60/60 注册体；installIpcHandlers 恰一次、先于 ready——
  // invoke 只能在 ready 帧之后到达，注册先于任何入站业务调用）。
  installIpcHandlers({ ipc: ipcRegistrar, edges: nodeEdges, ctx: headless.ctx })
  console.log('[sidecar] installIpcHandlers 完成：' + registry.size + ' 通道注册')

  let webDistDir = args.webDistDir
  if (webDistDir === null) {
    // 兜底：临时最小静态目录（仅保证 cp 起动；真实 UI dist 由打包/参数提供）
    webDistDir = path.join(args.userDataDir, '.sidecar-web-stub')
    mkdirSync(webDistDir, { recursive: true })
    if (!existsSync(path.join(webDistDir, 'index.html'))) {
      appendFileSync(path.join(webDistDir, 'index.html'), '<!doctype html><title>sidecar stub</title>')
    }
    console.error('[sidecar] 警告：未提供 --web-dist-dir，控制面静态伺服使用临时 stub（非真实 UI）')
  }

  // control-plane 装配与 main.ts 同参（stateDir/webDistDir/host 包源）；本地
  // dsh spawn 门（getDshWorkspacePath/canStartLocal/canExposeLocal）：
  // 默认 headless.localSpawnGates（S-C-2：runtime 启动门/事务 workspace 权威，
  // main 同语义——全新 profile 离线时探针失败而阻塞，与 Electron 一致）；
  // DSH_SIDECAR_LEGACY_START=1 时用旧 dev 快捷门（直读 --dsh-path、无探针），
  // 供离线 dev 循环（POC dev；不进入任何产品路径）。
  // 打包态拒绝 legacy 快捷门（2026-09 模块评审 medium #3）：它会绕过
  // runtime 启动门（canStartLocal 恒 ok / 无探针），而入口就在产品装配里。
  const legacyStart = process.env.DSH_SIDECAR_LEGACY_START === '1'
  if (legacyStart && isPackagedSidecarRuntime()) {
    console.error('[sidecar] DSH_SIDECAR_LEGACY_START 在装配态被拒绝（绕过启动门，仅限 dev 循环）')
    process.exit(EXIT_STARTUP_FAILURE)
  }
  type SpawnGateShape = {
    getDshWorkspacePath(): string
    canStartLocal(): { ok: true } | { ok: false; reason: string }
    canExposeLocal(): boolean
  }
  const spawnGates: SpawnGateShape = legacyStart
    ? {
        getDshWorkspacePath: () => {
          if (args.dshPath !== null) return args.dshPath
          throw new Error('dsh workspace not resolved (--dsh-path 未提供)')
        },
        canStartLocal: () =>
          args.dshPath !== null
            ? { ok: true }
            : { ok: false, reason: '--dsh-path 未提供' },
        canExposeLocal: () => true,
      }
    : (headless!.localSpawnGates as unknown as SpawnGateShape)
  const controlPlane = createControlPlane({
    port: args.port ?? 17500,
    stateDir: path.join(args.userDataDir, 'state'),
    webDistDir,
    ...(args.hostGraphDir !== null ? { hostGraphPackageSourceDir: args.hostGraphDir } : {}),
    ...(args.hostGitDir !== null ? { hostGitWorktreePackageSourceDir: args.hostGitDir } : {}),
    ...(args.hostArchiveDir !== null ? { hostArchiveCleanupPackageSourceDir: args.hostArchiveDir } : {}),
    getDshWorkspacePath: () => spawnGates.getDshWorkspacePath(),
    canStartLocal: () => spawnGates.canStartLocal(),
    canExposeLocal: () => spawnGates.canExposeLocal(),
  })

  try {
    await controlPlane.start()
  } catch (err) {
    console.error('[sidecar] 控制面启动失败（fatal）：' + String(err))
    process.exit(EXIT_STARTUP_FAILURE)
  }
  console.log('[sidecar] control plane listening on http://127.0.0.1:' + controlPlane.port)
  controlPlaneInstance = controlPlane

  // S-C-2：plane 晚绑定（代理注册/会话 refresh/restart 宿主腿/connectionState
  // 投影/onLocalStateChange 订阅）→ 启动尾部（refreshRuntimeEvidence + 运行时
  // 启动事务——本地实例起动由事务权威决定（main 同源），取代旧无条件 pre-spawn）。
  headless.bindPlane(controlPlane)

  const ctxWithUrl = ctx as ShellAssemblyCtx & { hostFacts: { controlPlaneUrl: string } }
  ctxWithUrl.hostFacts.controlPlaneUrl = `http://127.0.0.1:${controlPlane.port}`

  // ready 帧最小化（D8：port + shellVersion；其余身份字段走 dsh-chamber:info）
  writeProtocolLine({ notify: 'ready', payload: { port: controlPlane.port, shellVersion } })

  // 启动尾部（main 3785-3789 同形——内部已含 catch 折叠与门/投影处理，绝不
  // 使 ready 帧延迟：尾部在 ready 之后异步执行）。legacy 快捷路径：直接
  // pre-spawn（早前已验证的 dev 行为；无探针、离线可用）。
  if (legacyStart) {
    if (args.dshPath !== null) {
      try {
        await controlPlane.startLocal()
      } catch (err) {
        console.error('[sidecar] pre-spawn（legacy）失败：' + String(err))
      }
    }
    // legacy 路径无启动尾部，但冷启动深链同样需要消费（与另一分支对齐；
    // 2026-09 二审：原实现只在非 legacy 分支 drain）。
    drainDeepLinkLaunches()
  } else {
    // 用 then(ok, err) 而非 finally：runStartupTail 内部已 catch（不会 reject），
    // 但若将来改变，`.finally` 的派生 promise 会变成未处理拒绝并命中本文件的
    // unhandledRejection→exit 1；then 的第二参保证「无论成败都 drain 且不产生
    // 未处理拒绝」，失败仍 loud（2026-09 二审 info）。
    void headless.runStartupTail().then(
      () => drainDeepLinkLaunches(),
      (error) => {
        console.error('[sidecar] 启动尾部异常（drain 仍执行）：' + String(error))
        drainDeepLinkLaunches()
      },
    )

    // W-13 补（dev 观察实证）：启动事务只做探针拉起、探针进程退出后未驻留本地
    // 实例（connectionState 回到 stopped）——5s/12s 两拍回退为直接 pre-spawn
    // （幂等：已 attempt 或状态非 stopped 即跳过；与事务串行化由 cp startLocal
    // 单飞语义兜住）。
    if (args.dshPath !== null) {
      const maybeStartLocal = async (): Promise<void> => {
        if (startLocalAttempted) return
        try {
          if (controlPlane.connectionState !== 'ready' && controlPlane.connectionState !== 'starting') {
            startLocalAttempted = true
            console.log('[sidecar] 启动事务未驻留本地实例——直接 pre-spawn 回退')
            await controlPlane.startLocal()
          }
        } catch (err) {
          console.error('[sidecar] pre-spawn 回退失败：' + String(err))
        }
      }
      setTimeout(() => void maybeStartLocal(), 5000).unref?.()
      setTimeout(() => void maybeStartLocal(), 12000).unref?.()
    }
  }
}

/** 优雅退出（信号/EOF 共用）：quitting 门 → ctx 侧回收（transport/插件子进程/
 *  安装器/runtime 事务 abort/gateway 会话/session refresh——dispose 内序与
 *  main will-quit 同源）→ cp.stop（本地 dsh 子进程不孤儿化）→ exit code。 */
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log('[sidecar] 优雅退出中…')
  try {
    await headless?.dispose()
  } catch (err) {
    console.error('[sidecar] ctx 回收失败：' + String(err))
  }
  try {
    await controlPlaneInstance?.stop()
  } catch (err) {
    console.error('[sidecar] cp.stop 失败：' + String(err))
  }
  process.exit(code)
}

void boot().catch((err) => {
  console.error(`[sidecar] boot 失败（fatal exit ${EXIT_STARTUP_FAILURE}）：` + String(err))
  process.exit(EXIT_STARTUP_FAILURE)
})

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (line.length === 0) return
  void handleInboundLine(line).catch((err) => {
    console.error('[sidecar] 入站处理异常：' + String(err))
  })
})
rl.on('close', () => {
  console.log('[sidecar] stdin EOF——退出')
  void shutdown(EXIT_GRACEFUL)
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(EXIT_GRACEFUL)
  })
}

process.on('uncaughtException', (err) => {
  console.error(`[sidecar] uncaughtException（fatal exit ${EXIT_RUNTIME_CRASH}）：` + String(err))
  process.exit(EXIT_RUNTIME_CRASH)
})
process.on('unhandledRejection', (reason) => {
  console.error(`[sidecar] unhandledRejection（fatal exit ${EXIT_RUNTIME_CRASH}）：` + String(reason))
  process.exit(EXIT_RUNTIME_CRASH)
})
