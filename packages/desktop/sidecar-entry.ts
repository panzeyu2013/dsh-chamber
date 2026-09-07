/**
 * sidecar-entry.ts —— Swift flavor sidecar 进程入口（W-11/W-12；design 25
 * §3.1/§3.3/§4.4.2/D2/D8）
 *
 * 进程模型（design 25 §3.1）：Swift 壳 spawn 本进程（node sidecar-entry.ts
 * --user-data-dir <dir> [--dsh-path …] [--web-dist-dir …] [--port N]）。
 * - stdout = B 桥协议流（NDJSON，唯一协议写面）；stderr = 日志（D2：入口把
 *   存量 console.* 重定向到 stderr）。
 * - 业务 = shell-core.installIpcHandlers（60/60 注册体，语义与 Electron 版
 *   同一实现）；宿主边沿 = node-edges.ts（HostEdges → edge/notify → Swift）。
 * - 无头 ctx = sidecar-ctx.ts buildHeadlessCtx（W-13 拆分落位；S-C-1 起
 *   C/D/E 组注册体依赖真实化——providers/transportManager/audit/
 *   publishRegistryTransition/confirmRegistryOriginSwitch 与 main.ts 同源
 *   同参装配，见 sidecar-ctx.ts 头注释；其余字段仍 loud stub，S-C-2 范围
 *   清单在该文件尾部）。
 * - control-plane 装配与 main.ts 同参（stateDir/webDistDir/host 包源），
 *   就绪后输出 ready 帧最小化 {port, shellVersion}（D8；其余身份字段走既有
 *   dsh-chamber:info）。
 * - 生命周期：SIGTERM/SIGINT/stdin EOF → 优雅回收（cp.stop + ctx 侧
 *   transport/gateway 会话回收（dispose——SSH 子进程不孤儿化））→ exit 0；
 *   uncaught → stderr + exit 1（B7 fatal 分级）。
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
import { buildHeadlessCtx } from './sidecar-ctx.ts'

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

// S-C-1：无头 ctx 装配拆分至 sidecar-ctx.ts（buildHeadlessCtx——C/D/E 组注册体
// 依赖真实化：providers/transportManager/audit/publishRegistryTransition/
// confirmRegistryOriginSwitch，与 main.ts 同源同参；其余字段 loud stub，S-C-2
// 范围清单见该文件头注释）。edges = 上方 nodeEdges 同一实例（单装配不变式——
// publish push/确认对话框宿主腿与 installIpcHandlers 投递状态机同对象）。
const headless = buildHeadlessCtx(args.userDataDir, nodeEdges)
const ctx: ShellAssemblyCtx = headless.ctx

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
// 4. shell-core 装配（60/60 注册体；installIpcHandlers 恰一次、先于 ready）
// ---------------------------------------------------------------------------
installIpcHandlers({ ipc: ipcRegistrar, edges: nodeEdges, ctx })
console.log('[sidecar] installIpcHandlers 完成：' + registry.size + ' 通道注册')

// ---------------------------------------------------------------------------
// 5. control-plane 装配与 ready 帧
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

async function main(): Promise<void> {
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

  const dshPath = args.dshPath
  const controlPlane = createControlPlane({
    port: args.port ?? 17500,
    stateDir: path.join(args.userDataDir, 'state'),
    webDistDir,
    ...(args.hostGraphDir !== null ? { hostGraphPackageSourceDir: args.hostGraphDir } : {}),
    ...(args.hostGitDir !== null ? { hostGitWorktreePackageSourceDir: args.hostGitDir } : {}),
    ...(args.hostArchiveDir !== null ? { hostArchiveCleanupPackageSourceDir: args.hostArchiveDir } : {}),
    getDshWorkspacePath: () => {
      if (dshPath !== null) return dshPath
      throw new Error('dsh workspace not resolved (--dsh-path 未提供)')
    },
    canStartLocal: () =>
      dshPath !== null ? { ok: true } : { ok: false, reason: '--dsh-path 未提供' },
    canExposeLocal: () => true,
  })

  try {
    await controlPlane.start()
  } catch (err) {
    console.error('[sidecar] 控制面启动失败（fatal）：' + String(err))
    process.exit(1)
  }
  console.log('[sidecar] control plane listening on http://127.0.0.1:' + controlPlane.port)

  // 预启动本地实例（05 §7.5）：缺 --dsh-path 则跳过（非致命，stderr 记录）
  if (dshPath !== null) {
    try {
      await controlPlane.startLocal()
    } catch (err) {
      console.error('[sidecar] pre-spawn 本地实例失败（非致命）：' + String(err))
    }
  }

  const ctxWithUrl = ctx as ShellAssemblyCtx & { hostFacts: { controlPlaneUrl: string } }
  ctxWithUrl.hostFacts.controlPlaneUrl = `http://127.0.0.1:${controlPlane.port}`

  // ready 帧最小化（D8：port + shellVersion；其余身份字段走 dsh-chamber:info）
  writeProtocolLine({ notify: 'ready', payload: { port: controlPlane.port, shellVersion } })

  // 信号/EOF → 优雅退出
  let shuttingDown = false
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.log('[sidecar] 优雅退出中…')
    // S-C-1：C/D/E 组真实化后，回收腿同时关停传输层（SSH 隧道/在途 exec——
    // disposeAsync 等待 SIGKILL 升级，子进程不孤儿化）与 gateway 会话内存。
    try {
      await headless.dispose()
    } catch (err) {
      console.error('[sidecar] ctx 回收失败：' + String(err))
    }
    try {
      await controlPlane.stop()
    } catch (err) {
      console.error('[sidecar] cp.stop 失败：' + String(err))
    }
    process.exit(code)
  }
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(0)
    })
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (line.length === 0) return
  void handleInboundLine(line).catch((err) => {
    console.error('[sidecar] 入站处理异常：' + String(err))
  })
})
rl.on('close', () => {
  console.log('[sidecar] stdin EOF——退出')
  process.exit(0)
})

process.on('uncaughtException', (err) => {
  console.error('[sidecar] uncaughtException（fatal exit 1）：' + String(err))
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[sidecar] unhandledRejection（fatal exit 1）：' + String(reason))
  process.exit(1)
})

void main().catch((err) => {
  console.error('[sidecar] main 启动失败：' + String(err))
  process.exit(1)
})
