/**
 * sidecar-entry.ts —— Swift flavor sidecar 进程入口（design 25
 * §3.1/§3.3/§4.4.2/D2/D8）
 *
 * 进程模型（design 25 §3.1）：Swift 壳 spawn 本进程（node sidecar-entry.ts
 * --user-data-dir <dir> [--dsh-path …] [--web-dist-dir …] [--port N]
 * [--host-graph-dir …] [--host-git-dir …] [--host-archive-dir …]
 * [--host-open-in-dir …]）。
 * - stdout = B 桥协议流（NDJSON，唯一协议写面）；stderr = 日志（D2：入口把
 *   存量 console.* 重定向到 stderr）。
 * - 业务 = shell-core.installIpcHandlers（60/60 注册体，语义与 Electron 版
 *   同一实现）；宿主边沿 = node-edges.ts（HostEdges → edge/notify → Swift）。
 * - 无头 ctx = sidecar-ctx.ts buildHeadlessCtx（C/D/E 组注册体依赖 +
 *   F/G/H/J/K 组注册体依赖 + runtime
 *   控制器族均为真实实现——见 sidecar-ctx.ts 头注释。本文件（装配接线）：
 *   buildHeadlessCtx 增 inputs（--dsh-path → builtinDshWorkspace、host 包源
 *   三目录）；本地 dsh spawn 门（localSpawnGates）原样接入 createControlPlane
 *   （与 main 三闭包语义）；controlPlane.start() 后 bindPlane(cp)（plane
 *   晚绑定：代理注册/会话 refresh/restart 宿主腿/connectionState 投影）→
 *   ready 帧 → runStartupTail()（与 main 同形——refreshRuntimeEvidence
 *   .then(runRuntimeStartup)：本地实例启动/激活由启动事务权威决定
 *   （Electron main 语义同源——渲染器
 *   自动启动 POST 幂等同路径，canStartLocal/canExposeLocal 门控制）。）
 * - 生命周期：SIGTERM/SIGINT/stdin EOF → 优雅回收（quitting 门 + 在飞运行时
 *   事务 abort + cp.stop + ctx 侧 transport/gateway 会话/插件子进程/安装器
 *   回收（dispose——SSH 子进程不孤儿化））→ exit 0；uncaught → stderr + exit 1
 *   （B7 fatal 分级）。回收有 5s 硬顶（D1c：QUIT_CLEANUP_TIMEOUT_MS，与 Swift
 *   侧 terminate 的 5s grace→SIGKILL 对齐）——dispose/cp.stop 挂起时强退，绝不
 *   滞留到被 SIGKILL；强退沿用本次退出路径的文档化退出码（信号/EOF = 0）。
 *   shuttingDown 置位后迟到的入站帧不再受理：以 QUIT_INBOUND_ERROR（与 Electron
 *   trustedIpc 的 app_quitting 围栏逐字同形）拒绝（edge 应答除外——在飞 edge
 *   仍可结算）。
 *
 * Electron-free 不变式：本文件零 electron import（electron-free-gate 面 A）。
 */
// ⚠️ 必须是**第一条** import（D2）：sidecar-console-redirect.ts 的模块体
// 在任何其它依赖求值之前把 console.log/info/debug 钉到 stderr（stdout 只允许
// 协议写）。本 import 同时取回协议行序列化用的 safeStringify（单一实现）。
import { safeStringify } from './sidecar-console-redirect.ts'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeQuitRisk, shouldHideToTray } from './chamber-settings.ts'
// control-plane 一律经 facade 取（**不要** import 裸包名）：装配态目录
// 没有 node_modules 树，facade 的 isPackagedSidecarRuntime 分支加载
// `<sidecar>/dist/control-plane/index.js`；裸说明符在打包态 ERR_MODULE_NOT_FOUND。
// dev/测试态 facade 仍走 workspace 符号链接。
import { createControlPlane, isPackagedSidecarRuntime } from './control-plane-module.ts'
import {
  drainDeepLinkLaunches,
  enqueueDeepLink,
  installIpcHandlers,
  onRendererLifecycle,
  QUIT_CLEANUP_TIMEOUT_MS,
  resolveSidecarBuiltinDshWorkspace,
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

// console→stderr 重定向（D2）位于文件头第一条 import 的
// sidecar-console-redirect.ts 模块体内——先于本文件任何其它依赖求值。

// 1. 参数与环境解析
function parseArgs(argv: readonly string[]): {
  userDataDir: string
  dshPath: string | null
  webDistDir: string | null
  hostGraphDir: string | null
  hostGitDir: string | null
  hostArchiveDir: string | null
  hostOpenInDir: string | null
  port: number | null
  /** 原生更新器形态：'sparkle' = 壳声明了 Sparkle 安装腿；
   *  null = 无原生安装腿（dev / dry-run / 未配置 feed 的装配）。 */
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

// 2. 目录锁复验（design 25 §6.3 B2：不二次 flock——Swift 侧持锁；本进程只读
//    锁记录校验**父 pid**，防双 flavor 并发）。
//    语义（关键）：记录里的 pid 是**持锁方**（Swift 壳）的 pid，而本进程是它
//    直接 spawn 的子进程 → 正常情形 `record.pid === process.ppid`，属「我方的
//    父进程持锁」，**不是**冲突。只有记录 pid 既不是本进程也不是父进程、且仍
//    存活时，才是「另一 flavor/实例正占用同一 userData」→ loud exit 3
//    （Supervisor 对 exit 3 走 fatal 不重启，见 SidecarSupervisor）。
//    记录 pid 已死 = 陈旧锁（flock 随进程死亡释放，内核已无持有者）→ 放行。
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
        // EPERM = 进程存在但无权限发信号 → 仍然存活（把任何异常都当已死
        // 会误放行另一 flavor 的持有者）。
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

// 3. B 桥协议服务端（stdin 入站；stdout 唯一协议写面）
type Handler = (payload: unknown) => unknown | Promise<unknown>
const registry = new Map<string, Handler>()
const ipcRegistrar: IpcRegistrar = {
  handle(channel, handler) {
    registry.set(channel, handler)
  },
}

/** 出站缓冲上限（8 MiB）：process.stdout 的队内字节超过它即**拒发**并在有 id 时回
 *  一帧合法错误——把「无界堆积」变成「有界 + loud 失败」。
 *
 *  为什么不用阻塞写（fs.writeSync）：在真阻塞 fd 上它会停住主线程（SIGTERM / stdin-EOF
 *  处理器与内部强退定时器都跑不了，宿主 stop() 先摘 stdout 读端再 SIGTERM 时只能等到
 *  被 SIGKILL，本地 dsh/ssh 子进程清理（D1c）永不执行）；在 Node 的 O_NONBLOCK
 *  stdout 管道上它直接抛 EAGAIN（未捕获即 exit 1）。两种失败面都由非阻塞写 + 有界拒发
 *  避免。 */
const MAX_PENDING_STDOUT_BYTES = 8 * 1024 * 1024
/** 单轮排队的帧数上限（队内清零后重置）：限制 Node 排队 write request 的常驻开销。 */
const MAX_PENDING_STDOUT_WRITES = 4096
/** 单轮「缓冲超限」的拒发回帧配额（队内清零后重置）：保证回帧本身也有界。 */
let backpressureNotices = 0
/** 自上一轮队内清零以来已入队的帧数（见 MAX_PENDING_STDOUT_WRITES）。 */
let queuedStdoutFrames = 0

/** 小错误帧的有界写：与正文走**同一预算**（队内字节 / 排队帧数），超限即 loud 丢弃——
 *  「合法错误帧」不得成为绕过 8 MiB / 4096 帧上限的无界排队通道。
 *  背压分支的回帧走自己的每轮配额（backpressureNotices），不在此重复计预算。 */
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

/** stdout 协议行写（单线程下写原子；绝不允许其他代码写 stdout）。
 *  safeStringify 对不可 JSON 化值（BigInt/循环引用）兜底返回
 *  的是**非 JSON 文本**，写成进程间协议行后 Swift 侧按「非协议帧」丢弃且**不结算**
 *  pending → 那次 invoke 永久悬挂。这里严格序列化：失败时若帧里有 id，就回一帧
 *  合法错误（调用方据此 reject），否则丢掉并 loud（绝不写非协议字节）。 */
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
  // 出站帧门（与入站同源常量 MAX_PROTOCOL_FRAME_BYTES）：超限帧
  // 绝不写出去——Swift 侧 LineReader 会先溢出重同步，>4 MiB 的结果帧因此会 fail-closed
  // 作废该会话全部未决请求。有 id 的帧回一帧合法错误（调用方 promise 正常 reject）；
  // 无 id 的 edge/notify 帧 loud 丢弃：edge 由 node 侧超时兜底（非交互腿 30s、
  // showMessage/pickPluginSource 等交互腿 660s），notify 是单向的、丢弃后 core 不可见
  // （≤4 MiB 载荷不可达，此处为 fail-closed 的已知代价）。
  // 快判：UTF-16 单元数 × 4 是 UTF-8 字节数的上界 → ≤ MAX/4 时
  // 必然合规，免掉每帧一次 O(n) 字节扫描；中间带才算精确字节数（与 Swift
  // line.utf8.count 同口径）。
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
  // 有界背压（非阻塞）：**字节 + 排队帧数双上限**。
  //   - 字节上限 MAX_PENDING_STDOUT_BYTES：限制卡住的数据量；
  //   - 帧数上限 MAX_PENDING_STDOUT_WRITES：限制 Node 的排队 write request（每请求
  //     ~数百字节常驻内存；只限字节时「上百万个 1 字节帧」仍会让 RSS 线性增长）。
  // 任一超限即拒发；拒发回帧自身也有配额（否则每个被拒帧以 ~61B 反噬预算）。
  // 空闲路径（队内 0 字节）免一次 O(n) 字节扫描，并重置本轮配额与帧计数。
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
/** edge 往返超时：Swift 不应答时不得永久挂起。
 *  **交互腿豁免**：showMessage / pickPluginSource 是主线程
 *  模态（NSAlert / NSOpenPanel），用户思考/浏览可能远超 30s——按 11 分钟上限，
 *  超时才 loud 失败。
 *  Swift 侧交互腿上限同为 600s，但起点是「收到 edge」
 *  （SwiftEdgeHostLegs.swift:209 interactiveLegTimeout / :582 performInteractiveUI），
 *  node 侧起点是「发出 edge」→ 两侧同值时 node 必然先超时，用户此后点下的模态
 *  答案到达时只被记为「迟到的 edge 应答」丢弃（sidecar-entry.ts 入站分派）。
 *  故 node 侧取 Swift 上限 + 60s 缓冲：Swift 的 600s 有界应答（ok /
 *  swift-edge-ui-unavailable:…:main-thread-busy）恒先于 node 超时到达，node
 *  只在 Swift 腿整体失联（进程挂死/管道断开）时才自行超时。
 *  失败面（写清，不假装已消除）：① 放宽只是把竞态窗口推后 60s——Swift 腿在
 *  600s+60s 内仍无应答时 node 仍超时丢弃（600s 已由 Swift 弃权位兜住，属双腿
 *  双重故障）；② 两侧锁步断言（macos CrossLanguageLockstepTests
 *  `testInteractiveEdgeTimeoutMatchesSidecarEntry` 断言 SWIFT_INTERACTIVE_LEG_TIMEOUT_MS
 *  = 600_000 且 INTERACTIVE_EDGE_TIMEOUT_MS = 前者 + 60_000）。 */
const EDGE_TIMEOUT_MS = 30_000
/** Swift 侧交互腿上限镜像（SwiftEdgeHostLegs.interactiveLegTimeout = 600s）。 */
const SWIFT_INTERACTIVE_LEG_TIMEOUT_MS = 600_000
/** node 侧交互腿等待上限 = Swift 上限 + 60s 缓冲。 */
const INTERACTIVE_EDGE_TIMEOUT_MS = SWIFT_INTERACTIVE_LEG_TIMEOUT_MS + 60_000
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
      // 拒发（超限/背压/不可序列化）必须让本次 edge **立即**失败：edge 帧只有
      // edgeId、没有 id，写不出「可判定失败帧」，否则调用方只能等 30s/660s 超时。
      // 在 node 内直接结算自己的 pendingEdges，无协议往返。
      if (!writeProtocolLine({ edge: method, payload, edgeId }) && pendingEdges.delete(edgeId)) {
        clearTimeout(timer)        // 显式取消超时兜底（delete 已使回调 no-op，这里避免悬挂定时器）
        reject(new Error(`host edge 帧被拒发（出站门/有界背压）：${method}`))
      }
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
  // 原生更新阶段入站（冻结接口）：Swift 壳的 Sparkle 状态
  // （__host.nativeUpdatePhase）→ headless 更新控制器（同一 UpdateState 投影 →
  // 既有 update-state push 消费面）。装配尚未完成前的入站 loud 拒绝（绝不静默
  // 丢弃一个用户可见的更新阶段）；控制器单源，Swift 侧不复制投影逻辑。
  nativeUpdatePhase(input) {
    const controller = headless?.ctx.updateController as HeadlessUpdateController | undefined
    if (controller === undefined) {
      throw new Error('sidecar-edges:native-update-phase-before-ctx-ready')
    }
    controller.applyNativePhase(input)
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
  // D1c：退出在途（dispose/cp.stop 已开始）——不再受理任何新入站工作，以与
  // Electron trustedIpc 退出围栏（renderer-trust.ts）逐字同形的错误拒绝
  // （'app is quitting' + 'app_quitting'）。edge 应答不是新工作，仍走下方分派
  // 让在飞 edge 结算（dispose 可能在等它）。
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
      // __host.systemResume 是**双腿**消费点——core 回灌（handleHostInbound
      // 内 onSystemResume → shell-core handleSystemResume 的 held/push 状态机）之外，
      // 装配侧补 Electron powerMonitor 第二条监听等价的「唤醒 → 重探陈旧 transport」
      // （main 同接线）。重探叶自带早退
      // （装配前/退出在途/只碰 error/degraded 非终态），失败 loud 且绝不反噬本帧。
      if (method === HOST_INBOUND.systemResume) {
        // 入站本身留一行（sidecar-console-redirect 把
        // console.* 统一写 stderr → <userData>/logs/sidecar.log）。否则真机上只有
        // Swift 侧「发了」的一行，分不清「壳没发」与「页面没消费」。
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

// 4. 装配启动（async bootstrap）：无头 ctx →
//    shell-core 60/60 注册体（installIpcHandlers 恰一次、先于 ready）→
//    control-plane 装配（本地 spawn 门 = headless.localSpawnGates——与 main
//    同语义）→ bindPlane（plane 晚绑定）→ ready 帧 → 启动尾部。
const moduleDir = path.dirname(fileURLToPath(import.meta.url))
/** Electron-free sidecar 的内建 dsh 工作区——显式 --dsh-path 优先；
 *  打包形态恒不探测仓库（装配总是显式携带路径）；dev 形态按
 *  main.ts 同一候选顺序回退 <repoRoot>/ref-dsh → <moduleDir>/vendor/dsh
 *  （共享 helper resolveSidecarBuiltinDshWorkspace，两侧不可能漂移）。 */
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
let shuttingDown = false
/** 更新检查定时器的测试注入门（与 DSH_SIDECAR_TEST_STALL_SHUTDOWN_MS 同纪律：
 *  仅 dev/测试态生效、装配态忽略）。sidecar-stdio 的 spawn 用例不需要真实出网，
 *  也避免 15s 首检改变 update-state 投影的确定性。 */
const TEST_NO_UPDATE_CHECK_ENV = 'DSH_SIDECAR_TEST_NO_UPDATE_CHECK'

async function boot(): Promise<void> {
  // 无头 ctx（async：启动前导 reaps 本地插件写进程账目；edges =
  // 上方 nodeEdges 同一实例——单装配不变式，publish push/确认对话框/设置
  // 副作用宿主腿与 installIpcHandlers 投递状态机同对象）。
/** 原生更新器桥：壳在 argv 里声明 --native-updater sparkle
 *  时，把「下载 / 重启并安装」转成 edge 调用交给壳内的 Sparkle；能力探测失败一律
 *  回 false（保持 blocked-available），绝不假装能安装。 */
const nativeUpdater: NativeUpdaterBridge | undefined = args.nativeUpdater === 'sparkle'
  ? {
      async available() {
        // 壳回报 available + error（坏 feed/密钥 / 未启动）；error 供
        // 页面相位走诚实失败态，而不是永远停在 checking。
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
  // 默认 headless.localSpawnGates（runtime 启动门/事务 workspace 权威，
  // main 同语义——全新 profile 离线时探针失败而阻塞，与 Electron 一致）；
  // DSH_SIDECAR_LEGACY_START=1 时用旧 dev 快捷门（直读 --dsh-path、无探针），
  // 供离线 dev 循环（POC dev；不进入任何产品路径）。
  // 打包态拒绝 legacy 快捷门：它会绕过
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
    stateDir: path.join(args.userDataDir, 'state'),
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

  // plane 晚绑定（代理注册/会话 refresh/restart 宿主腿/connectionState
  // 投影/onLocalStateChange 订阅）→ 启动尾部（refreshRuntimeEvidence + 运行时
  // 启动事务——本地实例起动由事务权威决定（main 同源））。
  headless.bindPlane(controlPlane)

  const ctxWithUrl = ctx as ShellAssemblyCtx & { hostFacts: { controlPlaneUrl: string } }
  ctxWithUrl.hostFacts.controlPlaneUrl = `http://127.0.0.1:${controlPlane.port}`

  // ready 帧最小化（D8：port + shellVersion；其余身份字段走 dsh-chamber:info）
  writeProtocolLine({ notify: 'ready', payload: { port: controlPlane.port, shellVersion } })

  // I 组更新控制器 start（main.ts 同序——订阅已在
  // installIpcHandlers 内注册，start 只排定 15s 静默首检与 6h 周期，绝不阻塞）。
  // 测试注入门见 TEST_NO_UPDATE_CHECK_ENV：产品/装配态一律走真实节奏。
  if (process.env[TEST_NO_UPDATE_CHECK_ENV] === '1' && !isPackagedSidecarRuntime()) {
    console.log(`[sidecar] ${TEST_NO_UPDATE_CHECK_ENV}=1——跳过更新检查定时器（测试注入）`)
  } else {
    headless.ctx.updateController.start()
  }

  // 启动尾部（与 main 同形——内部已含 catch 折叠与门/投影处理，绝不
  // 使 ready 帧延迟：尾部在 ready 之后异步执行）。legacy 快捷路径：直接
  // pre-spawn（dev 行为；无探针、离线可用）。
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
    // 用 then(ok, err) 而非 finally：runStartupTail 内部已 catch（不会 reject），
    // 但若将来改变，`.finally` 的派生 promise 会变成未处理拒绝并命中本文件的
    // unhandledRejection→exit 1；then 的第二参保证「无论成败都 drain 且不产生
    // 未处理拒绝」，失败仍 loud。
    void headless.runStartupTail().then(
      () => drainDeepLinkLaunches(),
      (error) => {
        console.error('[sidecar] 启动尾部异常（drain 仍执行）：' + String(error))
        drainDeepLinkLaunches()
      },
    )

    // 启动事务在两个 flavor 上是同一
    // 权威（main.ts refreshRuntimeEvidence().then(runRuntimeStartup) 同序；事务
    // 内 startAndProbeWorkspace 已调用 startLocal）。
    // 一条只按 connectionState 判定的定时强制拉起会绕过 runtime 启动门
    // （canStartLocal/runtimeStartBlocked），此处不实现。
    // dev 无 --dsh-path 的场景由上方 dev 内建工作区回退覆盖。
  }
}

/** D1c 测试注入（与 DSH_SIDECAR_LEGACY_START 同纪律）：非装配态下人为拖慢
 *  退出清理，供 sidecar-stdio.test.ts 确定性覆盖「退出在途帧拒绝」与「5s 硬顶
 *  强退」。产品路径不设置该变量；装配态一律忽略（退出行为不接受运行时开关）。 */
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

/** 退出清理硬顶（见 shutdown 头注释）：必须早于宿主 5s SIGKILL grace。 */
const QUIT_CLEANUP_DEADLINE_MS = QUIT_CLEANUP_TIMEOUT_MS - 500

/** D1c 测试注入（与 DSH_SIDECAR_TEST_STALL_SHUTDOWN_MS 同纪律）：非装配态下
 *  缩短退出清理硬顶，使测试能在毫秒级验证「硬顶先于注入挂起、先于宿主 grace」
 *  的次序；产品路径不设置该变量，装配态一律忽略并使用生产常量。 */
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

/** 优雅退出（信号/EOF 共用）：quitting 门 → ctx 侧回收（transport/插件子进程/
 *  安装器/runtime 事务 abort/gateway 会话/session refresh——dispose 内序与
 *  main will-quit 同源）→ cp.stop（本地 dsh 子进程不孤儿化）→ exit code。
 *  D1c：整条清理链有硬顶——挂起的 dispose/cp.stop 不得让进程滞留到被外部
 *  SIGKILL 才消失；超时 loud 强退，沿用本次退出路径的文档化退出码（信号/EOF =
 *  EXIT_GRACEFUL=0，Supervisor 不得把清理超时误判为崩溃重启）。
 *  两条腿**并行**等待（settleShutdownLegs，allSettled 语义——见
 *  sidecar-ctx 的 helper 与 main.ts 同形），4.5s 硬顶内两条腿都已启动。
 *  硬顶取 QUIT_CLEANUP_DEADLINE_MS = QUIT_CLEANUP_TIMEOUT_MS - 500ms：宿主
 *  （Swift BridgeClient 的 terminate→SIGKILL grace，与 QUIT_CLEANUP_TIMEOUT_MS
 *  同为 5s）从同一 SIGTERM 起算，两侧同为 5s 时 SIGKILL 会先到、内部硬顶形同
 *  虚设，留 500ms 余量保证内部强退先发生。 */
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  const cleanupDeadlineMs = quitCleanupDeadlineMs()
  // 更新控制器停表：定时器已 unref（不阻止退出），退出路径再显式
  // 停掉——清理收尾期间绝不再发起网络检查。控制器契约面只保证 UpdateController，
  // stop 是 headless 附加成员（见 update-headless.ts）。
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
    // dispose 与 cp.stop **并行**（allSettled 语义）：串行（先
    // await dispose 再 await cp.stop）会把退出耗时变成两者之和，cp.stop
    // （本地 dsh/ssh 子进程回收腿）可能在 4.5s 内部硬顶到点前还没启动就被
    // process.exit 强退，留下孤儿进程。Electron main will-quit 即单个
    // Promise.allSettled（与 main 同形）；两腿各自 loud、互不阻断，
    // 失败不改写本次退出路径的文档化退出码。
    await settleShutdownLegs(
      [
        { label: 'ctx 回收失败', run: () => headless?.dispose() },
        { label: 'cp.stop 失败', run: () => controlPlaneInstance?.stop() },
      ],
      (label, err) => {
        console.error(`[sidecar] ${label}：` + String(err))
      },
    )
  })()
  let deadlineTimer: NodeJS.Timeout | undefined
  const completed = await Promise.race([
    // cleanup 内部已 catch 全部失败，不会 reject（Promise.race 的 reject 分支
    // 会成为 unhandledRejection 并命中 exit 1，绝不能到达）。
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
  console.error(`[sidecar] boot 失败（fatal exit ${EXIT_STARTUP_FAILURE}）：` + String(err))
  process.exit(EXIT_STARTUP_FAILURE)
})

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (line.length === 0) return
  // 入站帧字节上限（与 Swift FrameCodec.maxFrameBytes 4 MiB 锁步，跨语言
  // 锁步测试读同一个常量）。超限行**绝不进 JSON.parse**（内存/CPU 放大面），
  // 也绝不猜测帧内容——loud 记账后丢弃该行并继续服务（镜像 Swift 接收侧
  // BridgeClient 对超长行的「丢弃该帧 + fail pending + 继续」语义；单条超限帧
  // 不得杀死一个健康会话）。readline 仍会缓冲整行，本门约束的是解析与回显面。
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
