/**
 * sidecar-stdio.test.ts —— W-13：B 桥 stdio 冒烟（假 Swift 驱动真 sidecar）
 *
 * design 25 §4.4.2/D2/D8；companion W-11/12/13。用 node:test 直接 spawn
 * packages/desktop/sidecar-entry.ts（真实 shell-core 60/60 注册体 + 无头 ctx +
 * node-edges），以 NDJSON 协议驱动：
 *  1. ready 帧（最小化 {port, shellVersion}，D8）；
 *  2. info 真实载荷（controlPlaneUrl/platform/flavor 面）；
 *  3. settings-set → notify rendererPush{channel:'dsh-chamber:settings-changed'}
 *     —— 8 push 事件面的代表采样（真实处理器 → node-edges → 协议 notify）；
 *  4. 代表通道均应答（ok 或 loud 'sidecar-ctx-unavailable:*'，绝无挂起）；
 *  5. 未知通道 loud；
 *  6. SIGTERM 优雅退出（exit 0）。
 * 环境：node 路径 env NODE_BIN → 缺省 process.execPath（测试进程自身即 node，
 * 保证 CI 恒可真跑；2026-09 审计发现旧缺省指向 /Applications 的 Electron 二进制
 * → 干净 runner 上整组静默通过 = 假绿）。ELECTRON_RUN_AS_NODE=1 对纯 node 无害。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import {
  EXIT_GRACEFUL,
  EXIT_LOCK_CONFLICT,
  EXIT_RUNTIME_CRASH,
  EXIT_STARTUP_FAILURE,
} from './sidecar-exit-codes.ts'
import { MAX_INBOUND_FRAME_BYTES } from './node-edges.ts'

const dir = path.dirname(fileURLToPath(import.meta.url))
const sidecarPath = path.join(dir, 'sidecar-entry.ts')
// D1b 门禁（2026-12 审计）：显式 NODE_BIN（非空）是调用方的配置承诺——不可用
// 必须硬失败；只有隐式缺省（process.execPath）不可用才是环境缺失，允许一行
// loud skip。原实现 existsSync 后整组静默 return：NODE_BIN=/nonexistent/node
// 得到 11 pass / 0 fail / exit 0 的假绿。
const explicitNodeBin = typeof process.env.NODE_BIN === 'string' && process.env.NODE_BIN.length > 0
const nodePath = explicitNodeBin ? (process.env.NODE_BIN as string) : process.execPath
/** 可用 node = 存在的常规文件（目录/缺失都不可用）。 */
function nodeUsable(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}
type NodeGate = 'run' | 'hard-fail' | 'skip'
/** 门禁判定（纯逻辑，测试可直断言；spawn 决策在 before/各用例入口）。 */
function classifyNodeGate(explicit: boolean, usable: boolean): NodeGate {
  if (usable) return 'run'
  return explicit ? 'hard-fail' : 'skip'
}
const nodeAvailable = nodeUsable(nodePath)
const nodeGate = classifyNodeGate(explicitNodeBin, nodeAvailable)
const NODE_GATE_HARD_FAIL = `NODE_BIN 显式提供但不可用：${nodePath}（配置错误必须硬失败，绝不静默 skip）`

interface Driver {
  invoke(method: string, payload: unknown, timeoutMs?: number): Promise<{ ok: boolean; result?: unknown; error?: string }>
  waitNotify(event: string, timeoutMs?: number): Promise<Record<string, unknown>>
  /** 等待 sidecar 向宿主发出的 edge 请求（{edge, payload, edgeId}）——用于断言
   *  入站汇确实到达 core 并驱动宿主腿，而非只停在传输层。 */
  waitEdge(method: string, timeoutMs?: number): Promise<Record<string, unknown>>
  /** P-01 测试注入：向 sidecar stdin 写一行原始字节（不经 NDJSON 组帧），用于
   *  超长行护栏用例。 */
  writeRaw(line: string): void
  /** W-13 ② 采样（P-04 起 sidecar 在 dev 也能解析内建 workspace，启动事务会并行
   *  推 runtime 状态）：在**已缓冲**的 rendererPush 里按 channel 取，绝不与其它
   *  合法 push 的到达次序竞态，也不会在重新挂 waitNotify 的空窗里丢目标 push。 */
  waitRendererPushChannel(channel: string, timeoutMs?: number): Promise<Record<string, unknown>>
  close(): Promise<number | null>
}

function startDriver(): Promise<Driver> {
  return new Promise((resolve, reject) => {
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-test-'))
    // DSH_SIDECAR_TEST_NO_UPDATE_CHECK（与 DSH_SIDECAR_TEST_STALL_SHUTDOWN_MS
    // 同纪律）：跳过 15s 首检/6h 周期定时器——本套用例不需要真实出网，也避免
    // 首检改写 update-state 投影（W-22 断 idle）的确定性。
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_SIDECAR_TEST_NO_UPDATE_CHECK: '1' }
    const child: ChildProcessWithoutNullStreams = spawn(nodePath, [sidecarPath, '--user-data-dir', userDataDir, '--port', '17910'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const rl = createInterface({ input: child.stdout })
    let nextId = 1
    const pending = new Map<number, { resolve(v: { ok: boolean; result?: unknown; error?: string }): void }>()
    /** 全部 rendererPush 载荷（顺序保留）——channel 过滤采样读这份缓冲。 */
    const rendererPushes: Record<string, unknown>[] = []
    const notifyWaiters = new Map<string, { resolve(v: Record<string, unknown>): void; timer: NodeJS.Timeout }[]>()
    const edgeWaiters = new Map<string, { resolve(v: Record<string, unknown>): void; timer: NodeJS.Timeout }[]>()
    let closed = false
    rl.on('line', (line) => {
      if (line.length === 0) return
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      if (typeof frame.notify === 'string') {
        if (frame.notify === 'rendererPush') {
          rendererPushes.push((frame.payload ?? {}) as Record<string, unknown>)
        }
        const waiters = notifyWaiters.get(frame.notify) ?? []
        notifyWaiters.delete(frame.notify)
        for (const w of waiters) {
          clearTimeout(w.timer)
          w.resolve((frame.payload ?? {}) as Record<string, unknown>)
        }
        return
      }
      if (typeof frame.edge === 'string') {
        // edge 请求需要宿主应答（否则 sidecar 侧 pendingEdges 悬挂）；测试即宿主，
        // 统一回 {ok:true} 并把帧交给 waitEdge 观察者。
        child.stdin.write(JSON.stringify({ id: frame.edgeId, ok: true, result: null }) + '\n')
        const waiters = edgeWaiters.get(frame.edge) ?? []
        edgeWaiters.delete(frame.edge)
        for (const w of waiters) {
          clearTimeout(w.timer)
          w.resolve((frame.payload ?? {}) as Record<string, unknown>)
        }
        return
      }
      if (typeof frame.id === 'number') {
        const p = pending.get(frame.id)
        if (p !== undefined) {
          pending.delete(frame.id)
          p.resolve({ ok: frame.ok === true, result: frame.result, error: typeof frame.error === 'string' ? frame.error : undefined })
        }
      }
    })
    const driver: Driver = {
      invoke(method, payload, timeoutMs = 4000) {
        return new Promise((resolve, reject) => {
          const id = nextId
          nextId += 1
          const timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error('invoke 超时: ' + method))
          }, timeoutMs)
          pending.set(id, {
            resolve(v) {
              clearTimeout(timer)
              resolve(v)
            },
          })
          child.stdin.write(JSON.stringify({ id, method, payload }) + '\n')
        })
      },
      waitEdge(method, timeoutMs = 4000) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('edge 超时: ' + method)), timeoutMs)
          const list = edgeWaiters.get(method) ?? []
          list.push({ resolve, timer })
          edgeWaiters.set(method, list)
        })
      },
      waitNotify(event, timeoutMs = 4000) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            const list = notifyWaiters.get(event) ?? []
            notifyWaiters.set(
              event,
              list.filter((w) => w.resolve !== waiter.resolve),
            )
            reject(new Error('notify 超时: ' + event))
          }, timeoutMs)
          const waiter = {
            timer,
            resolve(v: Record<string, unknown>) {
              clearTimeout(timer)
              resolve(v)
            },
          }
          const list = notifyWaiters.get(event) ?? []
          list.push(waiter)
          notifyWaiters.set(event, list)
        })
      },
      writeRaw(line) {
        child.stdin.write(line + '\n')
      },
      waitRendererPushChannel(channel, timeoutMs = 4000) {
        const find = () => rendererPushes.find((push) => push.channel === channel)
        const existing = find()
        if (existing !== undefined) return Promise.resolve(existing)
        return new Promise((resolve, reject) => {
          const deadline = Date.now() + timeoutMs
          const tick = (): void => {
            const hit = find()
            if (hit !== undefined) {
              resolve(hit)
              return
            }
            if (Date.now() >= deadline) {
              reject(new Error('rendererPush 超时: ' + channel))
              return
            }
            setTimeout(tick, 5)
          }
          tick()
        })
      },
      close() {
        return new Promise((resolve) => {
          if (closed) return resolve(null)
          closed = true
          const timer = setTimeout(() => {
            child.kill('SIGKILL')
            resolve(null)
          }, 4000)
          child.on('exit', (code) => {
            clearTimeout(timer)
            resolve(code)
          })
          child.kill('SIGTERM')
        })
      },
    }
    child.stderr.on('data', () => {
      /* stderr = 日志通道，测试不消费 */
    })
    child.on('error', (err) => reject(err))
    // 首个 ready 帧即就绪
    driver.waitNotify('ready', 20000).then(
      () => resolve(driver),
      (err) => {
        void driver.close()
        reject(err)
      },
    )
  })
}

let driver: Driver

/** W-15 目录锁复验用：带预置锁记录 spawn 一个 sidecar（不共享 driver 的 userData）。 */
function spawnWithLockRecord(lockPid: number, port: string): {
  ready: Promise<void>
  exit: Promise<number | null>
  stderr: () => string
  kill: (signal: NodeJS.Signals) => void
  /** S2·F11：stdin EOF 正常退出路径（sidecar-entry rl 'close' → EXIT_GRACEFUL）。 */
  closeStdin: () => void
} {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-lock-'))
  writeFileSync(
    path.join(userDataDir, '.dsh-chamber.lock'),
    JSON.stringify({ pid: lockPid, startedAt: Date.now() / 1000, shell: 'test' }),
  )
  const child: ChildProcessWithoutNullStreams = spawn(
    nodePath,
    [sidecarPath, '--user-data-dir', userDataDir, '--port', port],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_SIDECAR_TEST_NO_UPDATE_CHECK: '1' }, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  const ready = new Promise<void>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout })
    const timer = setTimeout(() => reject(new Error('ready 超时（20s）')), 20000)
    rl.on('line', (line) => {
      if (line.length === 0) return
      try {
        const frame = JSON.parse(line) as { notify?: unknown }
        if (frame.notify === 'ready') {
          clearTimeout(timer)
          resolve()
        }
      } catch {
        /* 非协议行忽略 */
      }
    })
    void exit.then((code) => {
      clearTimeout(timer)
      reject(new Error('ready 前退出 code=' + String(code)))
    })
  })
  // 调用方可能只等 exit（冲突用例 ready 必 reject）——先挂空 catch，
  // 避免未 await 的 ready 触发 unhandledRejection。
  void ready.catch(() => {})
  return {
    ready,
    exit,
    stderr: () => stderr,
    kill: (signal) => child.kill(signal),
    closeStdin: () => child.stdin.end(),
  }
}

/** D1c 测试用 harness：可注入 env、可等 stderr 行（确定性进入退出在途窗口）、
 *  观察原始响应帧（含 code 字段）的独立 sidecar。 */
function spawnInjectable(extraEnv: Record<string, string>, port: string): {
  ready: Promise<void>
  invoke(method: string, payload: unknown, timeoutMs?: number): Promise<{ ok: boolean; result?: unknown; error?: string; code?: string }>
  waitStderr(pattern: RegExp, timeoutMs?: number): Promise<void>
  /** P-01 测试注入：向 stdin 写一行原始字节（不经 NDJSON 组帧）。 */
  writeRaw(line: string): void
  exit: Promise<number | null>
  stderr: () => string
  kill: (signal: NodeJS.Signals) => void
} {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-d1c-'))
  const child: ChildProcessWithoutNullStreams = spawn(
    nodePath,
    [sidecarPath, '--user-data-dir', userDataDir, '--port', port],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_SIDECAR_TEST_NO_UPDATE_CHECK: '1', ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  const pending = new Map<number, (frame: { ok: boolean; result?: unknown; error?: string; code?: string }) => void>()
  let nextId = 1
  let readyResolve: (() => void) | null = null
  let readyTimer: NodeJS.Timeout | undefined
  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    if (line.length === 0) return
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (frame.notify === 'ready') {
      readyResolve?.()
      return
    }
    if (typeof frame.id === 'number') {
      const settle = pending.get(frame.id)
      if (settle !== undefined) {
        pending.delete(frame.id)
        settle({
          ok: frame.ok === true,
          result: frame.result,
          error: typeof frame.error === 'string' ? frame.error : undefined,
          code: typeof frame.code === 'string' ? frame.code : undefined,
        })
      }
    }
  })
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = () => {
      if (readyTimer !== undefined) clearTimeout(readyTimer)
      resolve()
    }
    readyTimer = setTimeout(() => reject(new Error('ready 超时（20s）')), 20000)
    void exit.then(() => reject(new Error('ready 前退出')))
  })
  void ready.catch(() => {})
  return {
    ready,
    invoke(method, payload, timeoutMs = 4000) {
      return new Promise((resolve, reject) => {
        const id = nextId
        nextId += 1
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error('invoke 超时: ' + method))
        }, timeoutMs)
        pending.set(id, (frame) => {
          clearTimeout(timer)
          resolve(frame)
        })
        child.stdin.write(JSON.stringify({ id, method, payload }) + '\n')
      })
    },
    writeRaw(line) {
      child.stdin.write(line + '\n')
    },
    waitStderr(pattern, timeoutMs = 4000) {
      if (pattern.test(stderr)) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        const onData = (): void => {
          if (!pattern.test(stderr)) return
          clearTimeout(timer)
          child.stderr.off('data', onData)
          resolve()
        }
        const timer = setTimeout(() => {
          child.stderr.off('data', onData)
          reject(new Error('stderr 未匹配 ' + String(pattern) + '（尾部：' + stderr.slice(-400) + '）'))
        }, timeoutMs)
        child.stderr.on('data', onData)
      })
    },
    exit,
    stderr: () => stderr,
    kill: (signal) => child.kill(signal),
  }
}

before(async () => {
  // 显式 NODE_BIN 不可用 = 硬失败：before 抛错 → 整组用例失败（exit 非 0），
  // 绝不能像原实现那样静默 skip 出假绿。
  if (nodeGate === 'hard-fail') throw new Error(NODE_GATE_HARD_FAIL)
  if (nodeGate === 'skip') return
  driver = await startDriver()
})
after(async () => {
  if (nodeGate !== 'run') return
  await driver.close()
})

test('D1b 门禁：显式 NODE_BIN 不可用 = 硬失败；隐式缺 node = 一行 loud skip', (t) => {
  // 判定分支断言（与运行环境无关，两分支都必须可复现）。
  assert.equal(classifyNodeGate(true, false), 'hard-fail', '显式提供但不可用 = 配置错误，必须硬失败')
  assert.equal(classifyNodeGate(false, false), 'skip', '隐式缺省不可用 = 环境缺失，一行 loud skip')
  assert.equal(classifyNodeGate(true, true), 'run')
  assert.equal(classifyNodeGate(false, true), 'run')
  if (nodeGate === 'skip') {
    // 隐式 node 缺失：唯一一条 loud skip（其余用例仍走各自的早退），绝不静默绿。
    t.skip('隐式运行时 process.execPath 不可用——整组 skip（未显式提供 NODE_BIN）')
  }
})

test('W-13 ① info 真实载荷', async () => {
  if (!nodeAvailable) return
  const r = await driver.invoke('dsh-chamber:info', null)
  assert.equal(r.ok, true)
  const result = r.result as Record<string, unknown>
  assert.equal(typeof result.controlPlaneUrl, 'string')
  // 平台断言必须跟随运行平台（2026-09 模块评审 major #2：硬写 darwin 会让
  // ubuntu 腿的 test:desktop 直接红）。
  assert.equal(result.platform, process.platform)
  assert.equal(typeof result.version, 'string')
})

test('W-13 ② settings-set → rendererPush 推送采样', async () => {
  if (!nodeAvailable) return
  // P-04 起 dev sidecar 也会解析出内建 dsh workspace，启动事务与 settings-set
  // 并行推 runtime 状态——按 channel 从缓冲里取 settings-changed，断言本用例
  // 驱动的这次推送，而非「注册后第一个 push 恰好是它」的时序假设。
  const notifyP = driver.waitRendererPushChannel('dsh-chamber:settings-changed', 5000)
  const r = await driver.invoke('dsh-chamber:settings-set', {
    patch: { windowCloseBehavior: 'hide-to-tray' },
  })
  assert.equal(r.ok, true)
  const push = await notifyP
  assert.equal((push as { channel?: unknown }).channel, 'dsh-chamber:settings-changed')
})

test('W-13 ③ 代表通道逐条具体形状（三审 #12：不再「ok 或任意 error」弱断言）', async () => {
  if (!nodeAvailable) return
  // 无头 ctx 下这些通道有确定形状：绝不允许「任何非空 error 都算过」——
  // 那会让整组通道报错也通过（一审 tests-gates 登记的弱断言）。
  const settings = await driver.invoke('dsh-chamber:settings-get', null, 4000)
  assert.ok(settings.ok, `settings-get 应成功：${JSON.stringify(settings)}`)
  const settingsResult = settings.result as { settings?: unknown; supported?: unknown }
  assert.equal(typeof settingsResult.settings, 'object', 'settings-get 应返回 {settings,supported}')
  assert.equal(typeof settingsResult.supported, 'object')

  const instances = await driver.invoke('desktop_ssh_instances_get', null, 4000)
  assert.equal(instances.ok, true)
  assert.equal(Array.isArray(instances.result), true)
  assert.equal((instances.result as unknown[]).length, 0, '空 userData 下无实例')

  const runtime = await driver.invoke('dsh-chamber:runtime-state', null, 4000)
  assert.equal(runtime.ok, true)
  assert.equal(typeof (runtime.result as Record<string, unknown>).phase, 'string')

  const update = await driver.invoke('dsh-chamber:update-state', null, 4000)
  assert.equal(update.ok, true)
  const updateState = update.result as Record<string, unknown>
  assert.equal(typeof updateState.phase, 'string')
  assert.equal(typeof updateState.channel, 'string')
  assert.equal(updateState.downloadPercent, null, 'v1 无下载腿：下载进度恒 null')

  const sshConfig = await driver.invoke('desktop_ssh_config_list', null, 4000)
  assert.equal(sshConfig.ok, true)
  assert.equal(Array.isArray((sshConfig.result as Record<string, unknown>).hosts), true)

  const pluginList = await driver.invoke('desktop_local_plugin_list', null, 4000)
  assert.equal(pluginList.ok, true)
  assert.equal('ok' in (pluginList.result as Record<string, unknown>), true)

  // 需要载荷的通道：缺载荷必须 loud（绝不静默空成功）。
  const status = await driver.invoke('desktop_ssh_status', null, 4000)
  assert.equal(status.ok, false)
  assert.equal(typeof status.error === 'string' && status.error.length > 0, true)
})

test('W-13 ④ 未知通道 loud', async () => {
  if (!nodeAvailable) return
  const r = await driver.invoke('zzz.definitely-unknown', null)
  assert.equal(r.ok, false)
  assert.equal(r.error, 'sidecar-unknown-channel')
})

test('W-13 ⑥ 保留入站：__host.deepLink / __host.rendererLifecycle 分派到 core', async () => {
  if (!nodeAvailable) return
  // design 25 §4.5/§5 E19：Swift application(_:open:) → core enqueueDeepLink；
  // 渲染器三事件映射 → core onRendererLifecycle。传输层应答 ok 即证明
  // sidecar-entry 的汇接线就位（语义在 core，其单测在 node-edges.test.ts）。
  // 三审 #11：不只断传输层 ok——深链必须真的进 core 的消费循环并驱动宿主腿。
  // 用一个**不在注册表里的 ssh 实例 id**：core 解析成功 → 入队 → drain →
  // runVscodeLaunch 返回 `instance not found` → core 走 showError 宿主腿。
  // 观测到该 edge 请求即证明「传输 → core 解析/入队/消费 → 宿主腿」全链到位
  // （且不依赖本机是否装 VS Code，无副作用）。
  const showError = driver.waitEdge('showError', 8000)
  const deepLink = await driver.invoke('__host.deepLink', {
    url: 'dsh-chamber://open-vscode?instance=missing-instance&path=%2Ftmp%2Fprobe',
  })
  assert.deepEqual(deepLink, { ok: true, result: undefined, error: undefined })
  const edgePayload = await showError
  assert.equal(edgePayload.title, '打开 VS Code 失败', '深链应到达 core 并由 core 触发宿主腿')
  assert.match(String(edgePayload.detail), /instance not found: missing-instance/)
  for (const event of ['did-start-loading', 'did-finish-load', 'crashed', 'closed']) {
    const r = await driver.invoke('__host.rendererLifecycle', { event })
    assert.equal(r.ok, true, `事件 ${event} 应被接受（实际 ${JSON.stringify(r)}）`)
  }
  const bad = await driver.invoke('__host.rendererLifecycle', { event: 'zzz' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'sidecar-edges:unknown-renderer-lifecycle:zzz')
})

test('W-15 目录锁复验：记录 pid == 父 pid（Swift 壳持锁）→ 正常启动', async () => {
  if (!nodeAvailable) return
  // 本测试进程即被 spawn 的 sidecar 的父进程 → 预置记录 pid = process.pid，
  // 等价于「Swift 壳先持锁再 spawn」的形态；sidecar 必须视为我方父进程，放行。
  const harness = spawnWithLockRecord(process.pid, '17921')
  await harness.ready
  harness.kill('SIGTERM')
  assert.equal(await harness.exit, 0)
})

test('W-15 目录锁复验：记录 pid 为其他存活进程 → loud exit 3', async () => {
  if (!nodeAvailable) return
  // 同用户的无关存活进程（非本进程、非 sidecar 父进程）→ 判为另一实例占用。
  const squatter = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
  try {
    const harness = spawnWithLockRecord(squatter.pid ?? 1, '17922')
    assert.equal(await harness.exit, 3)
    assert.match(harness.stderr(), /目录锁被占用/)
  } finally {
    squatter.kill('SIGKILL')
  }
})

test('W-13 ⑦ 保留入站：__host.quitFacts 返回 core 决策（E1/E9/E20）', async () => {
  if (!nodeAvailable) return
  // 默认设置（windowCloseBehavior='hide-to-tray'、quitConfirmation=true、
  // 无本地实例在跑）→ hideOnClose true、无需确认。
  const dflt = await driver.invoke('__host.quitFacts', {
    quitRequested: false,
    recoveryAvailable: true,
  })
  assert.equal(dflt.ok, true)
  assert.deepEqual(dflt.result, { hideOnClose: true, quitNeedsConfirm: false, quitReasons: [] })
  // 切到 close-behavior='quit' + 关闭确认开关 → 决策随之翻转（事实源 = core）。
  const set = await driver.invoke('dsh-chamber:settings-set', {
    patch: { windowCloseBehavior: 'quit', quitConfirmation: false },
  })
  assert.equal(set.ok, true)
  const changed = await driver.invoke('__host.quitFacts', {
    quitRequested: false,
    recoveryAvailable: true,
  })
  assert.deepEqual(changed.result, { hideOnClose: false, quitNeedsConfirm: false, quitReasons: [] })
  // 入参非法 → loud（绝不静默给默认决策）。
  const bad = await driver.invoke('__host.quitFacts', { quitRequested: 'yes', recoveryAvailable: true })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'sidecar-edges:quit-facts-invalid-input')
})

test('W-22 更新控制器：真实态 + blocked-available 契约', async () => {
  if (!nodeAvailable) return
  // Swift flavor 用 update-headless.ts 的真实控制器（W-22）：初始 idle +
  // installBlockedReason = 原生壳 reason（不是 loud stub）；download/restart
  // 在核心层显式拒绝（不依赖 UI 隐藏）。
  const state = await driver.invoke('dsh-chamber:update-state', null)
  assert.equal(state.ok, true)
  const projection = state.result as Record<string, unknown>
  assert.equal(projection.phase, 'idle')
  assert.equal(projection.installBlockedReason, '原生壳不支持自动安装')
  assert.equal(typeof projection.currentVersion, 'string')
  assert.equal(projection.releaseUrl, null)
  const download = await driver.invoke('dsh-chamber:update-download', null)
  assert.equal(download.ok, true, 'IPC 面恒 ok（控制器返回 {ok:false,error} 投影）')
  assert.deepEqual(download.result, { ok: false, error: 'no update available' })
  const restart = await driver.invoke('dsh-chamber:update-restart', null)
  assert.deepEqual(restart.result, { ok: false, error: '原生壳不支持自动更新安装（请手动下载新版本）' })
})

test('S-19/S-21 __host.nativeUpdatePhase：Sparkle 阶段进同一 update-state 投影并推送', async () => {
  if (!nodeAvailable) return
  // 先挂 push 观察（rendererPush 是更新状态的唯一页面来源），再发入站帧；其间的
  // 其他 rendererPush（runtime 状态一类）按 channel/phase 过滤。
  const pushP = (async (): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 5000
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('未等到 downloading 的 update-state push')
      const push = await driver.waitNotify('rendererPush', remaining)
      if (push.channel !== 'dsh-chamber:update-state-changed') continue
      const payload = push.payload as Record<string, unknown>
      if (payload.phase === 'downloading') return payload
    }
  })()
  const routed = await driver.invoke('__host.nativeUpdatePhase', {
    phase: 'downloading',
    version: '0.3.0',
    error: null,
  })
  assert.deepEqual(routed, { ok: true, result: undefined, error: undefined })
  const pushed = await pushP
  assert.equal(pushed.downloadPercent, null, '原生下载无百分比 → null')
  assert.equal(pushed.installBlockedReason, null, '原生阶段绝不把已配置的 Sparkle 降级为 unavailable')
  const state = await driver.invoke('dsh-chamber:update-state', null)
  const projection = state.result as Record<string, unknown>
  assert.equal(projection.phase, 'downloading')
  assert.equal(projection.installBlockedReason, null)
  // 非法载荷 loud（node-edges 校验在真实 sidecar 入口生效，不静默丢弃）。
  const bad = await driver.invoke('__host.nativeUpdatePhase', { phase: 'zzz', version: null, error: null })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'sidecar-edges:native-update-phase-invalid-phase:zzz')
  // 失败阶段 → error + 文案进投影（页面与 Sparkle 窗同结论）。
  const failed = await driver.invoke('__host.nativeUpdatePhase', { phase: 'failed', version: null, error: 'sparkle boom' })
  assert.equal(failed.ok, true)
  const after = await driver.invoke('dsh-chamber:update-state', null)
  const failedState = after.result as Record<string, unknown>
  assert.equal(failedState.phase, 'error')
  assert.equal(failedState.error, 'sparkle boom')
})

test('S3·D2 __host.systemResume 入站：core 回灌 + 装配侧重探双腿，恒 ok 不挂起', async () => {
  if (!nodeAvailable) return
  // sidecar-entry 的入站分派在 handleHostInbound（core 回灌）之后调用装配侧
  // reconnectStaleTransports 叶（main powerMonitor 第二条监听对偶）。本用例
  // 证明双腿接线后帧仍按普通 host method 结算（无实例/未绑定 plane 时叶 no-op）。
  const r = await driver.invoke('__host.systemResume', { timestamp: Date.now() })
  assert.deepEqual(r, { ok: true, result: undefined, error: undefined })
})

test('W-13 ⑤ SIGTERM 优雅退出 exit 0', async () => {
  if (!nodeAvailable) return
  const code = await driver.close()
  assert.equal(code, 0)
})

test('S2·F8 stdout 纪律：重定向模块是 sidecar-entry 第一条 import，且先于依赖求值生效', () => {
  // 结构性锁步：第一条 import 必须是只做重定向的模块（原实现把重定向写在
  // import 之后——先于它求值的依赖模块会把日志写进协议流 stdout）。
  const entry = readFileSync(sidecarPath, 'utf8')
  const firstImport = entry.split('\n').find((line) => /^import\b/.test(line))
  assert.match(firstImport ?? '', /from '\.\/sidecar-console-redirect\.ts'/)

  // 行为证明：先 import 重定向模块、再 import 一个顶层 console.log 的模块——
  // 该输出必须落 stderr，stdout 保持空（协议流零污染）。
  const fixture = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-redirect-'))
  try {
    const dep = path.join(fixture, 'dep.mjs')
    writeFileSync(dep, "console.log('top-level-dep-log')\n")
    const redirect = pathToFileURL(path.join(dir, 'sidecar-console-redirect.ts')).href
    const code = `import ${JSON.stringify(redirect)}\nimport ${JSON.stringify(pathToFileURL(dep).href)}\n`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
    assert.equal(result.status, 0, '重定向夹具必须正常退出：' + String(result.stderr))
    assert.equal(result.stdout, '', 'stdout 必须为空（只有 writeProtocolLine 可写协议流）')
    assert.match(result.stderr, /top-level-dep-log/, '依赖模块顶层日志必须落 stderr')
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('S3·D2 唤醒重探叶：只连 error/degraded 非终态；idle/ready/终态/quit 在途不动', async () => {
  const { reconnectStaleTransports } = await import('./sidecar-ctx.ts')
  type ReconnectSm = Parameters<typeof reconnectStaleTransports>[0]
  const statuses: Record<string, { phase: string; requiresUserAction: boolean }> = {
    idle: { phase: 'idle', requiresUserAction: false },
    err: { phase: 'error', requiresUserAction: false },
    degraded: { phase: 'degraded', requiresUserAction: false },
    terminal: { phase: 'error', requiresUserAction: true },
    ready: { phase: 'ready', requiresUserAction: false },
  }
  const connectCalls: string[] = []
  const warnings: string[] = []
  const sm = {
    listInstances: () => Object.keys(statuses).map((id) => ({ id })),
    status: (id: string) => statuses[id] ?? null,
    connect: (id: string) => {
      // connect 抛错路径（degraded）：只 loud，绝不反噬唤醒帧。
      if (id === 'degraded') throw new Error('connect boom')
      connectCalls.push(id)
      return null
    },
  } as unknown as ReconnectSm
  reconnectStaleTransports(sm, () => false, (message) => { warnings.push(message) })
  assert.deepEqual(connectCalls, ['err'], '只重探 error/degraded 且非终态；idle/ready/requiresUserAction 一律不碰')
  assert.equal(warnings.length, 1, '单实例 connect 抛错只 loud（degraded 的抛错已计）')

  const quitCalls: string[] = []
  const quittingSm = {
    listInstances: () => [{ id: 'err' }],
    status: () => ({ phase: 'error', requiresUserAction: false }),
    connect: (id: string) => { quitCalls.push(id); return null },
  } as unknown as ReconnectSm
  reconnectStaleTransports(quittingSm, () => true, () => { throw new Error('quit 在途绝不重探') })
  assert.deepEqual(quitCalls, [], 'quit 在途必须早退（dispose 后不得 spawn 新传输）')

  assert.doesNotThrow(() => reconnectStaleTransports(null, () => false, () => { throw new Error('no-op') }))
})

test('D1c 退出在途：入站帧以 app_quitting 拒绝 + 清理硬顶（早于宿主 SIGKILL grace）强退', async () => {
  if (!nodeAvailable) return
  // 清理注入挂起 8s（> 硬顶 4.5s = QUIT_CLEANUP_TIMEOUT_MS 5s 留 500ms 余量，
  // 保证先于宿主 SIGKILL grace）：进程只能由内部硬顶强退，
  // 绝不可能等到清理完成——这正是「不退到被 SIGKILL」要证明的行为。
  const stallMs = 8000
  const harness = spawnInjectable({ DSH_SIDECAR_TEST_STALL_SHUTDOWN_MS: String(stallMs) }, '17924')
  await harness.ready
  const startedAt = Date.now()
  harness.kill('SIGTERM')
  // 等挂起日志（shuttingDown 已置位、清理尚未完成）再发帧：确定性落在退出
  // 在途窗口内，不赌信号与 stdin 读的事件顺序。
  await harness.waitStderr(/退出清理人为挂起/, 5000)
  const rejected = await harness.invoke('dsh-chamber:info', null, 4000)
  assert.equal(rejected.ok, false, '退出在途不得再受理新工作')
  assert.equal(rejected.error, 'app is quitting', '与 Electron trustedIpc 的 app_quitting 同文案')
  assert.equal(rejected.code, 'app_quitting', '与 Electron trustedIpc 的 app_quitting 同 code')
  const rejectedAgain = await harness.invoke('dsh-chamber:info', null, 4000)
  assert.equal(rejectedAgain.error, 'app is quitting', '退出在途拒绝是持续门，不是一次性')
  assert.equal(rejectedAgain.code, 'app_quitting')
  const code = await harness.exit
  const elapsed = Date.now() - startedAt
  assert.equal(code, EXIT_GRACEFUL, '硬顶强退沿用信号/EOF 路径的文档化退出码（Supervisor 不得误判崩溃）')
  assert.match(harness.stderr(), /退出清理超时/, '硬顶强退必须 loud（stderr 超时日志）')
  assert.ok(elapsed >= 4000, `硬顶应在 ~4.5s（QUIT_CLEANUP_TIMEOUT_MS 留 500ms 余量）触发，实际 ${elapsed}ms`)
  // 硬顶必须早于宿主 5s SIGKILL grace：上界取 5000 而不是 stallMs（2026-12
  // 验证轮：原上界 8000 允许 [5000,8000) 的宽限，正是会被宿主先杀死的区间）。
  assert.ok(elapsed < 5000, `硬顶必须早于宿主 5s grace（实际 ${elapsed}ms）`)
  assert.ok(elapsed < stallMs, `不得等清理完成（${stallMs}ms），实际 ${elapsed}ms`)
})

// 三审 #7：退出码分级常量必须互异且与 Supervisor 分级一致（70=启动失败、
// 3=锁冲突、1=运行期崩溃、0=优雅停止）。常量是 sidecar-entry 的导出单源。
test('退出码分级常量（0/3/70/1）', () => {
  const codes = [EXIT_GRACEFUL, EXIT_LOCK_CONFLICT, EXIT_STARTUP_FAILURE, EXIT_RUNTIME_CRASH]
  assert.deepEqual(codes, [0, 3, 70, 1])
  assert.equal(new Set(codes).size, codes.length, '退出码不得重复')
})

// ---------------------------------------------------------------------------
// S2·F13 退出清理并行（本次批次）
// ---------------------------------------------------------------------------
test('S2·F13 settleShutdownLegs：两条腿同时启动（并行非串行）、单腿失败只 loud 不阻断', async () => {
  const { settleShutdownLegs } = await import('./sidecar-ctx.ts')
  const events: string[] = []
  const legErrors: Array<{ label: string; message: string }> = []
  let releaseDispose!: () => void
  const disposeGate = new Promise<void>((resolve) => { releaseDispose = resolve })
  await settleShutdownLegs(
    [
      {
        label: 'ctx 回收失败',
        run: async () => {
          events.push('dispose:start')
          await disposeGate
          events.push('dispose:end')
          throw new Error('dispose boom')
        },
      },
      {
        label: 'cp.stop 失败',
        run: async () => {
          events.push('stop:start')
          releaseDispose()
          events.push('stop:end')
        },
      },
    ],
    (label, error) => legErrors.push({ label, message: String(error) }),
  )
  // 串行实现（await dispose → await stop）会永远卡在 disposeGate 上、到不了
  // stop:start；事件序证明 cp.stop 在 dispose 仍挂起时已启动（并行 allSettled），
  // 且 dispose 失败只 loud（onLegError）、不 reject、不阻断 cp.stop。
  assert.deepEqual(events, ['dispose:start', 'stop:start', 'stop:end', 'dispose:end'])
  assert.deepEqual(legErrors, [{ label: 'ctx 回收失败', message: 'Error: dispose boom' }])
  // 未装配腿（undefined：headless/controlPlane 尚未创建）必须安全结算。
  await settleShutdownLegs(
    [{ label: 'ctx 回收失败', run: () => undefined }],
    () => { throw new Error('无失败腿时不得调用 onLegError') },
  )
})

test('S2·F13 接线锁步：dispose 与 cp.stop 在同一 settleShutdownLegs 内，无串行残留', () => {
  const entry = readFileSync(sidecarPath, 'utf8')
  const start = entry.indexOf('await settleShutdownLegs(')
  assert.ok(start >= 0, 'shutdown 清理必须经 settleShutdownLegs 编排（并行 allSettled 语义）')
  // 切片到调用结束（'])'）：固定 500 字符窗口会随代码增长静默失效——本批次实测该块已
  // 长于 500 字符（第八轮排查：断言仍命中纯属位置巧合，属「假绿通道」类问题）。
  const callEnd = entry.indexOf('])', start)
  assert.ok(callEnd > start, 'settleShutdownLegs 调用必须以 ]) 结束（否则切片无意义）')
  const block = entry.slice(start, callEnd + 2)
  assert.ok(block.length > 500, '切片必须覆盖整段编排（防止退回固定窗口）')
  assert.match(block, /headless\?\.dispose\(\)/, 'dispose 腿在并行编排内')
  assert.match(block, /controlPlaneInstance\?\.stop\(\)/, 'cp.stop 腿在并行编排内')
  assert.doesNotMatch(entry, /await headless\?\.dispose\(\)/, '不得回退为「先 await dispose」的串行形态（S2·F13 原缺陷）')
})

// ---------------------------------------------------------------------------
// S2·F4 交互腿超时锁步（本次批次）
// ---------------------------------------------------------------------------
test('S2·F4 交互腿超时锁步：node 侧 = Swift 600s + 60s 缓冲（node 后超时）', () => {
  const entry = readFileSync(sidecarPath, 'utf8')
  const swiftMatch = /const SWIFT_INTERACTIVE_LEG_TIMEOUT_MS = ([\d_]+)/.exec(entry)
  const nodeMatch = /const INTERACTIVE_EDGE_TIMEOUT_MS = SWIFT_INTERACTIVE_LEG_TIMEOUT_MS \+ ([\d_]+)/.exec(entry)
  assert.ok(swiftMatch !== null && nodeMatch !== null, '常量形状必须可锁步（见 sidecar-entry.ts S2·F4 注释）')
  const swiftMs = Number(swiftMatch[1].replaceAll('_', ''))
  const bufferMs = Number(nodeMatch[1].replaceAll('_', ''))
  assert.equal(swiftMs, 600_000, 'Swift 侧保持 600s（SwiftEdgeHostLegs.interactiveLegTimeout）')
  assert.equal(swiftMs + bufferMs, 660_000, 'node 侧 660s = Swift 600s + 60s（裁决 D4 选项 B）')
  assert.ok(swiftMs + bufferMs > swiftMs, 'node 侧必须严格大于 Swift 侧（node 起点更早，同值必然先超时丢答案）')
  // 本批只放宽交互腿上限：非交互预算与交互腿集合都不变。
  assert.match(entry, /const EDGE_TIMEOUT_MS = 30_000/)
  assert.match(entry, /const INTERACTIVE_EDGE_METHODS = new Set\(\['showMessage', 'pickPluginSource'\]\)/)
})

// ---------------------------------------------------------------------------
// S2·F11 非崩溃退出（本次批次：Node 侧契约半面）
// ---------------------------------------------------------------------------
test('S2·F11 正常退出码面：stdin EOF 与 SIGTERM 同为 EXIT_GRACEFUL=0（不得表现为崩溃 1）', async () => {
  if (!nodeAvailable) return
  // Node 侧唯一能保证的契约半面：信号/EOF 正常退出恒以 0 面世，绝不以运行期
  // 崩溃码 1 出现——Swift Supervisor 的 60s 退避配额只应累计「非零/崩溃」退出。
  // 另一半（SidecarSupervisor 不把 exit 0/3/70 计入 attempts）在 macos/ 源内
  // （SidecarSupervisor.swift:400-402 decide 先于退出码分级），不在本批写入范围；
  // 证据与建议补丁见交付说明。
  const harness = spawnWithLockRecord(process.pid, '17926')
  await harness.ready
  harness.closeStdin()
  assert.equal(await harness.exit, EXIT_GRACEFUL, 'stdin EOF 必须走文档化优雅退出码 0')
  assert.match(harness.stderr(), /stdin EOF/)
})

// ---------------------------------------------------------------------------
// P-01 入站帧长度上限（本次批次）
// ---------------------------------------------------------------------------
test('P-01 入站帧 >4MiB 被 loud 拒绝且不解析；会话继续服务（镜像 Swift 接收侧）', async () => {
  if (!nodeAvailable) return
  const harness = spawnInjectable({}, '17931')
  await harness.ready
  try {
    const oversized = JSON.stringify({
      id: 4242,
      method: 'dsh-chamber:info',
      payload: { big: 'x'.repeat(MAX_INBOUND_FRAME_BYTES) },
    })
    assert.ok(
      Buffer.byteLength(oversized, 'utf8') > MAX_INBOUND_FRAME_BYTES,
      '夹具行必须超过上限（JSON 组帧开销也计入）',
    )
    harness.writeRaw(oversized)
    await harness.waitStderr(/入站帧超过上限/, 8000)
    // 超长行只丢那一行：同一进程随后仍正常应答（绝不一帧杀死健康会话）。
    const info = await harness.invoke('dsh-chamber:info', null, 4000)
    assert.equal(info.ok, true, '超长帧后会话必须继续服务')
    assert.equal(typeof (info.result as Record<string, unknown>).controlPlaneUrl, 'string')
  } finally {
    harness.kill('SIGTERM')
    await harness.exit
  }
})

test('P-01 跨语言锁步：TS 入站帧上限 = Swift FrameCodec.maxFrameBytes（4 MiB，按 UTF-8 字节）', () => {
  const swiftPath = path.join(dir, '..', '..', 'macos', 'Sources', 'DSHChamber', 'FrameCodec.swift')
  const swift = readFileSync(swiftPath, 'utf8')
  const match = /public static let maxFrameBytes = ([0-9_]+) \* ([0-9_]+) \* ([0-9_]+)/.exec(swift)
  assert.ok(match !== null, 'FrameCodec.swift 的 maxFrameBytes 拼写必须可锁步（见 CrossLanguageLockstepTests.swift）')
  const swiftBytes = Number(match[1]!.replaceAll('_', ''))
    * Number(match[2]!.replaceAll('_', ''))
    * Number(match[3]!.replaceAll('_', ''))
  assert.equal(MAX_INBOUND_FRAME_BYTES, swiftBytes, 'TS 侧常量必须与 Swift FrameCodec.maxFrameBytes 逐值一致')
  assert.equal(swiftBytes, 4 * 1024 * 1024, 'Swift 侧常量必须仍是 4 MiB（护栏不允许被悄悄放宽）')
  const entry = readFileSync(sidecarPath, 'utf8')
  assert.match(entry, /lineBytes > MAX_INBOUND_FRAME_BYTES/, 'sidecar-entry 入站门必须读同一常量')
  assert.match(entry, /Buffer\.byteLength\(line, 'utf8'\)/, '门必须按 UTF-8 字节数判定（与 Swift line.utf8.count 同口径）')
})

test('P-03 桌面 TS 入口必须能被 Node 类型擦除真实解析（node --check 对 ESM .ts 是空操作）', async () => {
  // 2026-12 第七轮验证 BUG：`node --check foo.ts` 对 ESM .ts **静默 no-op**（unclosed 括号
  // 也返回 0），曾让 sidecar-entry.ts 带着多余 `}` 交付（sidecar 永远起不来而全套 Swift
  // 用例照绿）。这里用 stripTypeScriptTypes 做真解析，并对「多一个 }」做反证自检。
  const { stripTypeScriptTypes } = await import('node:module')
  for (const file of ['sidecar-entry.ts', 'sidecar-console-redirect.ts', 'node-edges.ts']) {
    const source = readFileSync(path.join(dir, file), 'utf8')
    assert.doesNotThrow(() => stripTypeScriptTypes(source), `${file} 必须语法可解析（类型擦除）`)
  }
  const entrySource = readFileSync(sidecarPath, 'utf8')
  assert.throws(
    () => stripTypeScriptTypes(`${entrySource}\n}\n`),
    '反证：多一个顶层 } 必须被解析器抓住（否则本门是假绿）',
  )
})

test('P-02 跨语言锁步：出站帧上限与入站同源常量（writeProtocolLine 必须读它）', () => {
  const edges = readFileSync(path.join(dir, 'node-edges.ts'), 'utf8')
  assert.match(
    edges,
    /export const MAX_PROTOCOL_FRAME_BYTES = 4 \* 1024 \* 1024/,
    'node-edges 必须有单一协议帧上限常量（4 MiB，双向）',
  )
  assert.match(
    edges,
    /export const MAX_INBOUND_FRAME_BYTES = MAX_PROTOCOL_FRAME_BYTES/,
    '入站别名必须与协议常量同源（不得各自写字面量）',
  )
  const entry = readFileSync(sidecarPath, 'utf8')
  // 收紧到 writeProtocolLine 函数体（第三轮审查：整文件正则会命中文件任意位置）。
  const start = entry.indexOf('function writeProtocolLine(')
  assert.ok(start !== -1, 'sidecar-entry 必须保留 writeProtocolLine')
  const end = entry.indexOf('\n}\n', start)
  assert.ok(end !== -1, 'writeProtocolLine 必须以顶层 } 结束')
  const body = entry.slice(start, end)
  assert.match(body, /lineBytes > MAX_PROTOCOL_FRAME_BYTES/, '出站门必须读同一常量（函数体内）')
  assert.match(
    body,
    /line\.length \* 4 <= MAX_PROTOCOL_FRAME_BYTES/,
    '快判谓词必须钉死（UTF-16 单元 ×4 是 UTF-8 字节上界；谓词写反会放过超限帧）',
  )
  assert.match(body, /Buffer\.byteLength\(line, 'utf8'\)/, '中间带必须按精确 UTF-8 字节判定')
  assert.match(body, /sidecar-frame-too-large/, '有 id 的超限帧必须回合法错误帧（调用方 promise reject）')
  // 第五轮验证后补齐：有界写（非阻塞 + 双上限）与 edge 可判定失败，此前只有行为探针、无套内锚点。
  assert.match(
    entry,
    /const MAX_PENDING_STDOUT_BYTES = 8 \* 1024 \* 1024/,
    '出站写必须有界（8 MiB 队内字节上限，绝不无界堆积）',
  )
  assert.match(
    entry,
    /const MAX_PENDING_STDOUT_WRITES = 4096/,
    '出站写必须同时限排队帧数（Node 排队 write request 的常驻开销）',
  )
  assert.match(body, /process\.stdout\.writableLength/, '有界判定必须读队内未写出字节数')
  assert.match(body, /sidecar-frame-backpressure/, '缓冲超限必须回可判定失败帧（有 id）')
  assert.match(body, /sidecar-frame-not-serializable/, '不可序列化帧必须回可判定失败帧（有 id）')
  // 反空洞（第八轮排查）：只匹配 return false 字面量会被别处两条 return false 满足，
  // 拒发分支改成 return true 也能过。这里要求「拒发区域之后必须紧跟 return false」+
  // 「返回面结构正确（≥2 个 false、≥1 个 true）」。
  const rejectAt = body.indexOf('sidecar-frame-backpressure')
  assert.ok(rejectAt >= 0, '背压拒发分支必须存在')
  assert.match(
    body.slice(rejectAt, rejectAt + 400),
    /return false/,
    '背压拒发分支必须真实返回 false（谎报成功不得通过）',
  )
  // TS 7：无捕获组的全局 match() 会把元素类型推成 never（.includes('return true')
  // 因此报 TS2345）。显式标注回 string[]，语义不变。
  const returns: string[] = body.match(/\breturn (?:true|false)\b/g) ?? []
  assert.ok(
    returns.filter((value) => value === 'return false').length >= 2,
    '拒发路径至少两条 return false（超限 / 不可序列化）',
  )
  assert.ok(returns.includes('return true'), '正常路径必须返回 true')
  assert.match(
    entry,
    /if \(!writeProtocolLine\(\{ edge: method, payload, edgeId \}\) && pendingEdges\.delete\(edgeId\)\)/,
    'edge 帧被拒发必须立即结算自己的 promise（否则只能等 30s/660s 超时）',
  )
})

