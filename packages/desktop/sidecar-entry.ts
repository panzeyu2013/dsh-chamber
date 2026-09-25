/**
 * sidecar-entry.ts —— Swift flavor sidecar 进程入口：Swift 壳 spawn 本进程，
 * stdout = B 桥协议流（NDJSON，唯一协议写面），stderr = 日志。业务 =
 * shell-core.installIpcHandlers，宿主边沿 = node-edges.ts，无头 ctx =
 * sidecar-ctx.buildHeadlessCtx；装配 inputs → createControlPlane（与 main 同语义）→
 * start() → bindPlane → ready 帧 → runStartupTail（启动事务权威）。
 * 生命周期：SIGTERM/SIGINT/stdin EOF → 优雅回收（quitting 门 + 在飞事务 abort +
 * cp.stop + dispose，SSH 子进程不孤儿化）→ exit 0；uncaught → exit 1。回收 5s 硬顶
 * 对齐 Swift terminate 的 grace→SIGKILL，绝不滞留到被 SIGKILL。
 * 对齐 Swift terminate 的 grace→SIGKILL，绝不滞留到被 SIGKILL；shuttingDown 后迟到
 * 入站以 QUIT_INBOUND_ERROR（与 app_quitting 围栏同形）拒绝；零 electron import。
 */
// ⚠️ 必须是第一条 import：sidecar-console-redirect 的模块体在任何其它依赖求值前把
// console.log/info/debug 钉到 stderr（stdout 只允许协议写），并取回 safeStringify。
import { safeStringify } from './sidecar-console-redirect.ts'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeQuitRisk, shouldHideToTray } from './chamber-settings.ts'
// control-plane 一律经 facade 取（不要 import 裸包名）：装配态目录没有 node_modules，
// facade 在打包态加载 <sidecar>/dist/control-plane/index.js，裸说明符会 ERR_MODULE_NOT_FOUND。
import {
  createControlPlane,
  isPackagedSidecarRuntime,
  type StateRootLease,
} from './control-plane-module.ts'
import {
  acquireHostRootLease,
  describeHostRootLeaseFailure,
  describeStateRootLeaseError,
} from './host-root-lease.ts'
import {
  drainDeepLinkLaunches,
  enqueueDeepLink,
  applyDebugRuntime,
  installIpcHandlers,
  onRendererLifecycle,
  QUIT_CLEANUP_TIMEOUT_MS,
  resolveSidecarBuiltinDshWorkspace,
  stateRootDir,
  type IpcRegistrar,
  type ShellAssemblyCtx,
} from './shell-core.ts'
import {
  MAX_INBOUND_FRAME_BYTES,
  MAX_PROTOCOL_FRAME_BYTES,
  createNodeEdges,
  HOST_INBOUND,
  QUIT_INBOUND_ERROR,
} from './node-edges.ts'
import { buildHeadlessCtx, settleShutdownLegs, type HeadlessCtxAssembly } from './sidecar-ctx.ts'
import type { HeadlessUpdateController, NativeUpdaterBridge } from './update-headless.ts'
import {
  EXIT_GRACEFUL,
  EXIT_LOCK_CONFLICT,
  EXIT_RUNTIME_CRASH,
  EXIT_STARTUP_FAILURE,
} from './sidecar-exit-codes.ts'

// console→stderr 重定向在文件头第一条 import 的模块体内，先于本文件任何其它依赖求值。

function parseArgs(argv: readonly string[]): {
  userDataDir: string
  dshPath: string | null
  webDistDir: string | null
  hostGraphDir: string | null
  hostGitDir: string | null
  hostArchiveDir: string | null
  hostOpenInDir: string | null
  port: number | null
  /** 原生更新器形态：sparkle = 壳声明了 Sparkle 安装腿；null = 无原生安装腿（dev/dry-run/未配置 feed）。 */
  nativeUpdater: string | null
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
    hostOpenInDir: get('--host-open-in-dir'),
    port: portRaw === null ? null : Number(portRaw),
    nativeUpdater: get('--native-updater'),
  }
}
const args = parseArgs(process.argv.slice(2))
mkdirSync(args.userDataDir, { recursive: true })

// 目录锁复验：不二次 flock（Swift 侧持锁），只读锁记录校验父 pid 防双 flavor 并发。
// 记录 pid 是持锁方（Swift 壳），本进程是它 spawn 的子进程 → 正常情形
// record.pid === process.ppid，不是冲突。只有当记录 pid 既非本进程也非父进程且仍存活
// 时才是另一 flavor/实例占用同一 userData → loud exit 3（Supervisor 对 exit 3 不重启）。
// 记录 pid 已死 = 陈旧锁（flock 随进程死亡释放）→ 放行。
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
        // EPERM = 进程存在但无权限发信号 → 仍存活（把任何异常都当已死会误放行另一 flavor 的持有者）。
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

type Handler = (payload: unknown) => unknown | Promise<unknown>
const registry = new Map<string, Handler>()
const ipcRegistrar: IpcRegistrar = {
  handle(channel, handler) {
    registry.set(channel, handler)
  },
}

/** 出站缓冲上限（8 MiB）：process.stdout 队内字节超限即拒发，有 id 时回一帧合法错误——
 * 把无界堆积变成有界 + loud 失败。不用 fs.writeSync：真阻塞 fd 上它停住主线程（SIGTERM /
 * stdin-EOF 处理器与强退定时器都跑不了），O_NONBLOCK 管道上直接抛 EAGAIN；两种失败面都
 * 由非阻塞写 + 有界拒发避免。 */
const MAX_PENDING_STDOUT_BYTES = 8 * 1024 * 1024
/** 单轮排队帧数上限（队内清零后重置）：限制 Node 排队 write request 的常驻开销。 */
const MAX_PENDING_STDOUT_WRITES = 4096
/** 单轮缓冲超限拒发回帧配额（队内清零后重置）：保证回帧本身也有界。 */
let backpressureNotices = 0
/** 自上一轮队内清零以来已入队的帧数（见 MAX_PENDING_STDOUT_WRITES）。 */
let queuedStdoutFrames = 0

// 小错误帧走同一预算（队内字节/排队帧数），超限即 loud 丢弃——合法错误帧不得成为绕过
// 8 MiB / 4096 帧上限的无界通道；背压分支回帧走自己的每轮配额，不重复计预算。
function writeBoundedErrorFrame(id: number, error: string): void {
  const text = JSON.stringify({ id, ok: false, error }) + '\n'
  const pendingBytes = process.stdout.writableLength
  if (pendingBytes > 0
      && (pendingBytes + text.length + 1 > MAX_PENDING_STDOUT_BYTES
          || queuedStdoutFrames >= MAX_PENDING_STDOUT_WRITES)) {
    console.error(`[sidecar] 出站队列已超限，错误帧（${error}）不再排队`)
    return
  }
  if (pendingBytes === 0) {
    queuedStdoutFrames = 0
    backpressureNotices = 0
  }
  queuedStdoutFrames += 1
  process.stdout.write(text)
}

// stdout 协议行写（单线程写原子；绝不允许其他代码写 stdout）。safeStringify 对不可
// JSON 化值的非 JSON 文本会被 Swift 侧当非协议帧丢弃且不结算 → invoke 永久悬挂；这里
// 严格序列化：失败时有 id 回合法错误帧，否则 loud 丢弃，绝不写非协议字节。
function writeProtocolLine(frame: unknown): boolean {
  let line: string | null = null
  try {
    line = JSON.stringify(frame)
  } catch {
    line = null
  }
  if (line === undefined || line === null) {
    const id = (frame as { id?: unknown } | null)?.id
    if (typeof id === 'number') { writeBoundedErrorFrame(id, 'sidecar-frame-not-serializable') }
    console.error('[sidecar] 协议帧不可序列化（已丢弃，绝不写非协议字节）：' + String(safeStringify(frame)))
    return false
  }
  // 出站帧门（同源常量 MAX_PROTOCOL_FRAME_BYTES）：超限帧绝不写出——Swift LineReader 会
  // 溢出重同步，>4 MiB 的结果帧 fail-closed 作废该会话全部未决请求。有 id 回合法错误帧；
  // 无 id 的 edge/notify loud 丢弃（edge 由 node 侧超时兜底；notify 单向、core 不可见）。
  // 快判：UTF-16 单元数 × 4 是 UTF-8 字节上界，≤ MAX/4 必然合规；中间带才算精确字节。
  const lineBytes = line.length * 4 <= MAX_PROTOCOL_FRAME_BYTES
    ? line.length
    : Buffer.byteLength(line, 'utf8')
  if (lineBytes > MAX_PROTOCOL_FRAME_BYTES) {
    const id = (frame as { id?: unknown } | null)?.id
    console.error(
      `[sidecar] 出站帧超过上限（> ${MAX_PROTOCOL_FRAME_BYTES} 字节，实际 ${Buffer.byteLength(line, 'utf8')} 字节）——拒绝发送（出站门）`,
    )
    if (typeof id === 'number') { writeBoundedErrorFrame(id, 'sidecar-frame-too-large') }
    return false
  }
  // 有界背压（非阻塞）：字节（MAX_PENDING_STDOUT_BYTES）+ 排队帧数（MAX_PENDING_STDOUT_WRITES）
  // 双上限。字节上限限制卡住的数据量；帧数上限限制 Node 排队 write request（只限字节时上百万个
  // 1 字节帧仍会让 RSS 线性增长）。任一超限即拒发，拒发回帧自身也有配额；空闲路径免一次扫描。
  const pendingBytes = process.stdout.writableLength
  if (pendingBytes > 0) {
    const exactBytes = Buffer.byteLength(line, 'utf8')
    if (pendingBytes + exactBytes + 1 > MAX_PENDING_STDOUT_BYTES
        || queuedStdoutFrames >= MAX_PENDING_STDOUT_WRITES) {
      const id = (frame as { id?: unknown } | null)?.id
      console.error(
        `[sidecar] 出站缓冲超过上限（队内 ${pendingBytes} 字节 / ${queuedStdoutFrames} 帧；本帧 ${exactBytes} 字节）——拒发（有界背压）`,
      )
      if (typeof id === 'number' && backpressureNotices < 64) {
        backpressureNotices++
        process.stdout.write(
          JSON.stringify({ id, ok: false, error: 'sidecar-frame-backpressure' }) + '\n',
        )
      }
      return false
    }
  } else {
    queuedStdoutFrames = 0        // 队内清零 = 上一轮背压结束：配额与帧计数重置
    backpressureNotices = 0
  }
  queuedStdoutFrames += 1
  process.stdout.write(line + '\n')
  return true
}

const pendingEdges = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
let nextEdgeId = 1
/** edge 往返超时：Swift 不应答时不得永久挂起。交互腿（showMessage
 * 是主线程模态 NSAlert）按 11 分钟上限，非交互腿 30s。Swift 侧交互腿
 * 600s、起点是收到 edge；node 侧起点是发出 edge → 同值必然 node 先超时，用户此后点下的
 * 答案只会被记为迟到应答丢弃。故 node 取 Swift 上限 + 60s 缓冲，只在 Swift 腿整体失联
 * 时自行超时；两侧锁步由 macos CrossLanguageLockstepTests 断言
 * SWIFT_INTERACTIVE_LEG_TIMEOUT_MS === 600_000 且 INTERACTIVE_EDGE_TIMEOUT_MS === 前者 + 60_000。
 * 遗留竞态：Swift 腿在 660s 内仍无应答时 node 仍超时丢弃（双腿双重故障）。 */
const EDGE_TIMEOUT_MS = 30_000
/** Swift 侧交互腿上限镜像（SwiftEdgeHostLegs.interactiveLegTimeout = 600s）。 */
const SWIFT_INTERACTIVE_LEG_TIMEOUT_MS = 600_000
/** node 侧交互腿等待上限 = Swift 上限 + 60s 缓冲。 */
const INTERACTIVE_EDGE_TIMEOUT_MS = SWIFT_INTERACTIVE_LEG_TIMEOUT_MS + 60_000
const INTERACTIVE_EDGE_METHODS = new Set(['showMessage'])

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
      // 拒发（超限/背压/不可序列化）必须让本次 edge 立即失败：edge 帧只有 edgeId 没有 id，
      // 写不出可判定失败帧 → 在 node 内直接结算自己的 pendingEdges，无协议往返。
      if (!writeProtocolLine({ edge: method, payload, edgeId }) && pendingEdges.delete(edgeId)) {
        clearTimeout(timer)        // 显式取消超时兜底（delete 已使回调 no-op，这里避免悬挂定时器）
        reject(new Error(`host edge 帧被拒发（出站门/有界背压）：${method}`))
      }
    })
  },
  sendNotify(event, payload) {
    writeProtocolLine({ notify: event, payload })
  },
  // 入站汇：Swift 深链与渲染器生命周期事件经 __host.deepLink / __host.rendererLifecycle
  // 原样进 core 权威状态机（归一化去重/队列；ready 位复位 + in-flight requeue/drain）。
  onDeepLink(url) {
    enqueueDeepLink(url)
  },
  onRendererLifecycle(event) {
    onRendererLifecycle(event)
  },
  // 关窗/退出决策投影：事实取自无头 ctx（chamber settings 实时 holder +
  // LOCAL_RUNNING_STATES × localProcessAlive），决策由 chamber-settings 两个纯函数合成。
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
  // 原生更新阶段入站：__host.nativeUpdatePhase → headless 更新控制器（同一 UpdateState
  // 投影）。装配完成前 loud 拒绝，绝不静默丢弃用户可见阶段；控制器单源。
  nativeUpdatePhase(input) {
    const controller = headless?.ctx.updateController as HeadlessUpdateController | undefined
    if (controller === undefined) {
      throw new Error('sidecar-edges:native-update-phase-before-ctx-ready')
    }
    controller.applyNativePhase(input)
  },
  // 调试模式启动期回读：Swift 在启动 reconcile 里按持久值应用 isInspectable 后报回。
  // 装配前到达 = loud 拒绝（丢掉它设置页整场只显示「未知」）；装配后写入 core holder 并推一次设置。
  debugModeApplied(input) {
    if (!applyDebugRuntime(input)) {
      throw new Error('sidecar-edges:debug-mode-before-ctx-ready')
    }
  },
  hostFacts: {
    trayAvailable: true, // mac Dock 常驻（design 14 D1）
    isPackaged: true,
    mainWindowAlive: true,
    webViewContentAlive: true,
  },
})

/** 入站分派：edge 应答 → host 保留 method → 51 invoke 通道注册表。 */
async function handleInboundLine(line: string): Promise<void> {
  let frame: Record<string, unknown>
  try {
    frame = JSON.parse(line) as Record<string, unknown>
  } catch {
    console.error('[sidecar] 非协议帧（丢弃，fail-loud）：' + line.slice(0, 200))
    return
  }
  // 退出在途（dispose/cp.stop 已开始）：不再受理新入站工作，以与 Electron trustedIpc 退出
  // 围栏逐字同形的错误拒绝。edge 应答不是新工作，仍走下方分派让在飞 edge 结算。
  if (shuttingDown && typeof frame.edgeId !== 'number') {
    if (typeof frame.id === 'number') {
      writeProtocolLine({ id: frame.id, ok: false, ...QUIT_INBOUND_ERROR })
    } else {
      console.error('[sidecar] 退出在途：丢弃无 id 入站帧：' + line.slice(0, 200))
    }
    return
  }
  if (typeof frame.edgeId === 'number') {
    const pending = pendingEdges.get(frame.edgeId)
    if (pending !== undefined) {
      pendingEdges.delete(frame.edgeId)
      if (frame.ok === true) pending.resolve(frame.result ?? null)
      else pending.reject(new Error(typeof frame.error === 'string' ? frame.error : 'edge-failed'))
    } else {
      // 迟到应答（已超时/已作废）：必须 loud——静默丢弃会让用户操作结果无声消失。
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
      // __host.systemResume 是双腿消费点：core 回灌（onSystemResume → held/push 状态机）之外，
      // 装配侧补唤醒后重探陈旧 transport（叶自带早退，失败 loud 且绝不反噬本帧）。
      if (method === HOST_INBOUND.systemResume) {
        // 入站本身留一行（console.* 统一写 <userData>/logs/sidecar.log），否则真机上分不清
        // 「壳没发」与「页面没消费」。
        console.info('[sidecar] __host.systemResume 入站：core 回灌 + 陈旧 transport 重探')
        try {
          headless?.reconnectStaleTransports()
        } catch (error) {
          console.error('[sidecar] 唤醒重探异常：' + String(error))
        }
      }
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

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
/** 内建 dsh 工作区：显式 --dsh-path 优先；打包形态恒不探测仓库；dev 形态按 main.ts
 * 候选顺序回退（共享 resolveSidecarBuiltinDshWorkspace，两侧不可能漂移）。 */
const dshPath = resolveSidecarBuiltinDshWorkspace({
  explicit: args.dshPath,
  packaged: isPackagedSidecarRuntime(),
  packageDir: moduleDir,
})
if (args.dshPath === null && dshPath !== null) {
  console.log('[sidecar] dev 内建 dsh 工作区回退：' + dshPath)
}
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
/** <userData> host-root 租约（R2 §3.6 L2）：boot 首段取得，两条写者腿静止后释放。 */
let hostRootLease: StateRootLease | null = null
let shuttingDown = false
/** 更新检查定时器的测试注入门（与 DSH_SIDECAR_TEST_STALL_SHUTDOWN_MS 同纪律；仅 dev/测试态
 * 生效、装配态忽略）：spawn 用例不需要真实出网，也避免 15s 首检改变 update-state 投影的确定性。 */
const TEST_NO_UPDATE_CHECK_ENV = 'DSH_SIDECAR_TEST_NO_UPDATE_CHECK'

async function boot(): Promise<void> {
  // host-root 租约（scope host-root，与 plane 自取的 state-root 不同文件）：<userData> 的
  // registry/凭据/runtime 树写者身份，先于 buildHeadlessCtx 的装配写入与 createControlPlane
  // 构造。冲突/不可读 = 另一写者占用 → 可诊断 stderr（state_root_locked + holder pid/flavor
  // + root）+ EXIT_STARTUP_FAILURE=70 退出（Supervisor 视作 fatal，不重启）。
  try {
    hostRootLease = acquireHostRootLease(args.userDataDir, 'sidecar')
  } catch (error) {
    console.error('[sidecar] ' + describeHostRootLeaseFailure(error))
    process.exit(EXIT_STARTUP_FAILURE)
  }

  // 无头 ctx（async：启动前导 reap 本地插件写进程账目；edges = 上方 nodeEdges 同一实例——
  // 单装配不变式，publish/确认对话框/设置副作用与 installIpcHandlers 投递状态机同对象）。
/** 原生更新器桥：壳声明 --native-updater sparkle 时把「下载 / 重启并安装」转成 edge
 * 交给壳内 Sparkle；能力探测失败一律 false（保持 blocked-available），绝不假装能安装。 */
const nativeUpdater: NativeUpdaterBridge | undefined = args.nativeUpdater === 'sparkle'
  ? {
      async available() {
        // 壳回报 available + error（坏 feed/密钥/未启动）；error 供页面走诚实失败态，而不是永远停在 checking。
        const reply = await nodeEdges.sendEdge('updateNativeCapability', null) as { available?: unknown, error?: unknown } | null
        return {
          available: reply?.available === true,
          error: typeof reply?.error === 'string' && reply.error.length > 0 ? reply.error : null,
        }
      },
      async trigger(kind) {
        const reply = await nodeEdges.sendEdge('updateNativeAction', { kind }) as { ok?: unknown; error?: unknown } | null
        if (reply?.ok === true) return { ok: true as const }
        const error = typeof reply?.error === 'string' ? reply.error : 'native updater refused'
        return { ok: false as const, error }
      },
    }
  : undefined

  headless = await buildHeadlessCtx(args.userDataDir, nodeEdges, {
    builtinDshWorkspace: dshPath,
    chamberVersion: shellVersion,
    hostPackageDirs: {
      graph: args.hostGraphDir,
      git: args.hostGitDir,
      archive: args.hostArchiveDir,
      openIn: args.hostOpenInDir,
    },
    nativeUpdater,
  })
  ctx = headless.ctx

  // shell-core 装配（61/61 注册体；installIpcHandlers 恰一次、先于 ready——invoke 只在 ready 帧后到达）。
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

  // control-plane 装配与 main.ts 同参（stateDir/webDistDir/host 包源）；默认 spawn 门 =
  // headless.localSpawnGates（runtime 启动门/事务 workspace 权威；全新 profile 离线时探针
  // 阻塞，与 Electron 一致）。DSH_SIDECAR_LEGACY_START=1 时用旧 dev 快捷门（直读 --dsh-path、
  // 无探针）仅供离线 dev；打包态拒绝它（会绕过 runtime 启动门，而入口就在产品装配里）。
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
          if (dshPath !== null) return dshPath
          throw new Error('dsh workspace not resolved (--dsh-path 未提供)')
        },
        canStartLocal: () =>
          dshPath !== null
            ? { ok: true }
            : { ok: false, reason: '--dsh-path 未提供' },
        canExposeLocal: () => true,
      }
    : (headless!.localSpawnGates as unknown as SpawnGateShape)
  const controlPlane = createControlPlane({
    port: args.port ?? 17500,
    stateDir: stateRootDir(args.userDataDir),
    // 租约记录的诊断 flavor：冲突方读到 sidecar 而不是笼统的 control-plane。
    stateWriter: 'sidecar',
    webDistDir,
    ...(args.hostGraphDir !== null ? { hostGraphPackageSourceDir: args.hostGraphDir } : {}),
    ...(args.hostGitDir !== null ? { hostGitWorktreePackageSourceDir: args.hostGitDir } : {}),
    ...(args.hostArchiveDir !== null ? { hostArchiveCleanupPackageSourceDir: args.hostArchiveDir } : {}),
    // open-in 是 localOnly 行：只喂本地播种（远端 seed 表永不携带它）。
    ...(args.hostOpenInDir !== null ? { hostOpenInPackageSourceDir: args.hostOpenInDir } : {}),
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

  // plane 晚绑定（代理注册/会话 refresh/restart 宿主腿/connectionState 投影/
  // onLocalStateChange 订阅）→ 启动尾部（refreshRuntimeEvidence + 运行时启动事务）。
  headless.bindPlane(controlPlane)

  const ctxWithUrl = ctx as ShellAssemblyCtx & { hostFacts: { controlPlaneUrl: string } }
  ctxWithUrl.hostFacts.controlPlaneUrl = `http://127.0.0.1:${controlPlane.port}`

  // ready 帧最小化（D8：port + shellVersion；其余身份字段走 dsh-chamber:info）
  writeProtocolLine({ notify: 'ready', payload: { port: controlPlane.port, shellVersion } })

  // I 组更新控制器 start（订阅已在 installIpcHandlers 内注册，start 只排定 15s 静默首检与
  // 6h 周期，绝不阻塞）；产品/装配态一律走真实节奏，只有测试注入门可改。
  if (process.env[TEST_NO_UPDATE_CHECK_ENV] === '1' && !isPackagedSidecarRuntime()) {
    console.log(`[sidecar] ${TEST_NO_UPDATE_CHECK_ENV}=1——跳过更新检查定时器（测试注入）`)
  } else {
    headless.ctx.updateController.start()
  }

  // 启动尾部（内部已含 catch 折叠与门/投影处理，绝不使 ready 帧延迟）；legacy 快捷路径
  // 直接 pre-spawn（dev 行为，无探针、离线可用）。
  if (legacyStart) {
    if (dshPath !== null) {
      try {
        await controlPlane.startLocal()
      } catch (err) {
        console.error('[sidecar] pre-spawn（legacy）失败：' + String(err))
      }
    }
    // legacy 路径无启动尾部，但冷启动深链同样需要消费（与另一分支对齐）。
    drainDeepLinkLaunches()
  } else {
    // 用 then(ok, err) 而非 finally：runStartupTail 内部已 catch，但若将来改变，finally 的
    // 派生 promise 会变未处理拒绝并命中本文件的 unhandledRejection→exit 1；失败仍 loud。
    void headless.runStartupTail().then(
      () => drainDeepLinkLaunches(),
      (error) => {
        console.error('[sidecar] 启动尾部异常（drain 仍执行）：' + String(error))
        drainDeepLinkLaunches()
      },
    )

    // 启动事务在两个 flavor 上是同一权威（main.ts refreshRuntimeEvidence().then(runRuntimeStartup)
    // 同序；事务内已调用 startLocal）。只按 connectionState 判定的定时强制拉起会绕过 runtime
    // 启动门（canStartLocal/runtimeStartBlocked），此处不实现。dev 无 --dsh-path 由上方回退覆盖。
  }
}

/** D1c 测试注入（非装配态）：人为拖慢退出清理，供确定性覆盖「退出在途帧拒绝」与「5s
 * 硬顶强退」。产品路径不设置；装配态忽略（退出行为不接受运行时开关）。 */
const TEST_SHUTDOWN_STALL_ENV = 'DSH_SIDECAR_TEST_STALL_SHUTDOWN_MS'
function shutdownStallMs(): number {
  const raw = process.env[TEST_SHUTDOWN_STALL_ENV]
  if (raw === undefined || raw.length === 0) return 0
  if (isPackagedSidecarRuntime()) {
    console.error(`[sidecar] ${TEST_SHUTDOWN_STALL_ENV} 在装配态被忽略（测试注入仅限 dev/测试）`)
    return 0
  }
  const ms = Number(raw)
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}

/** 退出清理硬顶：必须早于宿主 5s SIGKILL grace。 */
const QUIT_CLEANUP_DEADLINE_MS = QUIT_CLEANUP_TIMEOUT_MS - 500

/** D1c 测试注入（非装配态）：缩短退出清理硬顶，使测试能验证「硬顶先于注入挂起、先于
 * 宿主 grace」的次序；产品路径不设置，装配态忽略并使用生产常量。 */
const TEST_QUIT_CLEANUP_ENV = 'DSH_SIDECAR_TEST_QUIT_CLEANUP_MS'
function quitCleanupDeadlineMs(): number {
  const raw = process.env[TEST_QUIT_CLEANUP_ENV]
  if (raw === undefined || raw.length === 0) return QUIT_CLEANUP_DEADLINE_MS
  if (isPackagedSidecarRuntime()) {
    console.error(`[sidecar] ${TEST_QUIT_CLEANUP_ENV} 在装配态被忽略（测试注入仅限 dev/测试）`)
    return QUIT_CLEANUP_DEADLINE_MS
  }
  const ms = Number(raw)
  return Number.isFinite(ms) && ms > 0 ? ms : QUIT_CLEANUP_DEADLINE_MS
}

/** 优雅退出（信号/EOF 共用）：quitting 门 → ctx 侧回收（transport/插件子进程/安装器/
 * runtime 事务 abort/gateway 会话/session refresh，dispose 内序与 main will-quit 同源）→
 * cp.stop（本地 dsh 子进程不孤儿化）→ exit code。整条链有硬顶：挂起的 dispose/cp.stop
 * 不得让进程滞留到被外部 SIGKILL；超时 loud 强退并沿用本次退出路径的退出码（信号/EOF = 0，
 * Supervisor 不得把清理超时误判为崩溃重启）。两条腿并行等待（allSettled 语义），硬顶取
 * QUIT_CLEANUP_DEADLINE_MS = QUIT_CLEANUP_TIMEOUT_MS - 500ms：宿主从同一 SIGTERM 起算 5s
 * grace→SIGKILL，两侧同为 5s 时 SIGKILL 会先到，留 500ms 保证内部强退先发生。 */
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  const cleanupDeadlineMs = quitCleanupDeadlineMs()
  // 更新控制器停表：定时器已 unref，退出路径再显式停掉，清理收尾期间绝不再发起网络检查；
  // stop 是 headless 附加成员（控制器契约面只保证 UpdateController）。
  try {
    (ctx?.updateController as HeadlessUpdateController | undefined)?.stop()
  } catch (error) {
    console.error('[sidecar] 更新控制器停表失败：' + String(error))
  }
  console.log('[sidecar] 优雅退出中…')
  const cleanup = (async (): Promise<void> => {
    const stallMs = shutdownStallMs()
    if (stallMs > 0) {
      console.error(`[sidecar] 测试注入：退出清理人为挂起 ${stallMs}ms（${TEST_SHUTDOWN_STALL_ENV}）`)
      await new Promise<void>((resolve) => setTimeout(resolve, stallMs))
    }
    // dispose 与 cp.stop 并行（allSettled）：串行会把退出耗时变成两者之和，cp.stop（本地
    // dsh/ssh 子进程回收腿）可能在硬顶到点前还没启动就被强退，留下孤儿进程。Electron main
    // will-quit 即单个 Promise.allSettled；两腿各自 loud、互不阻断，失败不改写退出码。
    await settleShutdownLegs(
      [
        { label: 'ctx 回收失败', run: () => headless?.dispose() },
        { label: 'cp.stop 失败', run: () => controlPlaneInstance?.stop() },
      ],
      (label, err) => {
        console.error(`[sidecar] ${label}：` + String(err))
      },
    )
    // 两条写者腿都静止后才释放 host-root 租约（先 dispose/cp.stop 再放租约，与 main quit 序
    // 同义）；释放失败 loud 但绝不改写退出码，退出时租约模块的 exit listener 仍会兜底。
    try {
      hostRootLease?.release()
      hostRootLease = null
    } catch (err) {
      console.error('[sidecar] host-root 租约释放失败：' + String(err))
    }
  })()
  let deadlineTimer: NodeJS.Timeout | undefined
  const completed = await Promise.race([
    // cleanup 内部已 catch 全部失败、不会 reject（Promise.race 的 reject 分支会成为未处理拒绝并命中 exit 1）。
    cleanup.then(() => true as const),
    new Promise<false>((resolve) => {
      deadlineTimer = setTimeout(() => resolve(false), cleanupDeadlineMs)
    }),
  ])
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
  if (!completed) {
    console.error(
      `[sidecar] 退出清理超时（${cleanupDeadlineMs}ms，宿主 ${QUIT_CLEANUP_TIMEOUT_MS}ms 前留 500ms 余量），强制退出（code=${code}；可能有子进程残留）`,
    )
  }
  process.exit(code)
}

void boot().catch((err) => {
  // 租约错误带机器可读 code（state_root_locked 等）+ root + holder pid/flavor；其余沿用
  // String(err)。释放 best-effort：绝不因释放异常改写 fatal 退出码。
  const detail = describeStateRootLeaseError(err) ?? String(err)
  console.error(`[sidecar] boot 失败（fatal exit ${EXIT_STARTUP_FAILURE}）：` + detail)
  try { hostRootLease?.release() } catch { /* exit listener 兜底 */ }
  process.exit(EXIT_STARTUP_FAILURE)
})

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (line.length === 0) return
  // 入站帧字节上限（与 Swift FrameCodec.maxFrameBytes 4 MiB 锁步，测试读同一常量）。超限行
  // 绝不进 JSON.parse（内存/CPU 放大面），loud 记账后丢弃该行并继续服务（镜像 Swift 接收侧
  // 「丢弃该帧 + fail pending + 继续」；单条超限帧不得杀死健康会话）。readline 仍缓冲整行，
  // 本门约束的是解析与回显面。
  const lineBytes = Buffer.byteLength(line, 'utf8')
  if (lineBytes > MAX_INBOUND_FRAME_BYTES) {
    console.error(
      `[sidecar] 入站帧超过上限（> ${MAX_INBOUND_FRAME_BYTES} 字节，实际 ${lineBytes} 字节）——拒绝且不解析（P-01）`,
    )
    return
  }
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
