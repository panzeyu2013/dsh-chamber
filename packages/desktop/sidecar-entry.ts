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
import { createControlPlane } from '@dsh-chamber/control-plane'
import { installIpcHandlers, type IpcRegistrar, type ShellAssemblyCtx } from './shell-core.ts'
import { createNodeEdges, HOST_INBOUND } from './node-edges.ts'
import { buildHeadlessCtx, type HeadlessCtxAssembly } from './sidecar-ctx.ts'

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
//    锁记录校验父 pid，防双 flavor 并发）。
// ---------------------------------------------------------------------------
const lockFile = path.join(args.userDataDir, '.dsh-chamber.lock')
if (existsSync(lockFile)) {
  try {
    const record = JSON.parse(readFileSync(lockFile, 'utf8')) as { pid?: number }
    if (typeof record.pid === 'number' && record.pid > 0 && record.pid !== process.pid) {
      let alive = false
      try {
        process.kill(record.pid, 0)
        alive = true
      } catch {
        alive = false
      }
      if (alive) {
        console.error(`[sidecar] 目录锁被占用（pid=${record.pid}）——另一 flavor 正在使用 ${args.userDataDir}，退出`)
        process.exit(3)
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

const nodeEdges = createNodeEdges({
  sendEdge(method, payload) {
    return new Promise<unknown>((resolve, reject) => {
      const edgeId = nextEdgeId
      nextEdgeId += 1
      pendingEdges.set(edgeId, { resolve, reject })
      writeProtocolLine({ edge: method, payload, edgeId })
    })
  },
  sendNotify(event, payload) {
    writeProtocolLine({ notify: event, payload })
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
      writeProtocolLine({ id, ok: outcome.ok, error: outcome.error })
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
  const legacyStart = process.env.DSH_SIDECAR_LEGACY_START === '1'
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
    process.exit(1)
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
  } else {
    void headless.runStartupTail()

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
  console.error('[sidecar] boot 失败（fatal exit 1）：' + String(err))
  process.exit(1)
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
  void shutdown(0)
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(0)
  })
}

process.on('uncaughtException', (err) => {
  console.error('[sidecar] uncaughtException（fatal exit 1）：' + String(err))
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[sidecar] unhandledRejection（fatal exit 1）：' + String(reason))
  process.exit(1)
})
