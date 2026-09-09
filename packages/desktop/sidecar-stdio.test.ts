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
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import {
  EXIT_GRACEFUL,
  EXIT_LOCK_CONFLICT,
  EXIT_RUNTIME_CRASH,
  EXIT_STARTUP_FAILURE,
} from './sidecar-exit-codes.ts'

const dir = path.dirname(fileURLToPath(import.meta.url))
const sidecarPath = path.join(dir, 'sidecar-entry.ts')
const nodePath = process.env.NODE_BIN ?? process.execPath

interface Driver {
  invoke(method: string, payload: unknown, timeoutMs?: number): Promise<{ ok: boolean; result?: unknown; error?: string }>
  waitNotify(event: string, timeoutMs?: number): Promise<Record<string, unknown>>
  /** 等待 sidecar 向宿主发出的 edge 请求（{edge, payload, edgeId}）——用于断言
   *  入站汇确实到达 core 并驱动宿主腿，而非只停在传输层。 */
  waitEdge(method: string, timeoutMs?: number): Promise<Record<string, unknown>>
  close(): Promise<number | null>
}

function startDriver(): Promise<Driver> {
  return new Promise((resolve, reject) => {
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-test-'))
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    const child: ChildProcessWithoutNullStreams = spawn(nodePath, [sidecarPath, '--user-data-dir', userDataDir, '--port', '17910'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const rl = createInterface({ input: child.stdout })
    let nextId = 1
    const pending = new Map<number, { resolve(v: { ok: boolean; result?: unknown; error?: string }): void }>()
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
const nodeAvailable = existsSync(nodePath)

/** W-15 目录锁复验用：带预置锁记录 spawn 一个 sidecar（不共享 driver 的 userData）。 */
function spawnWithLockRecord(lockPid: number, port: string): {
  ready: Promise<void>
  exit: Promise<number | null>
  stderr: () => string
  kill: (signal: NodeJS.Signals) => void
} {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-lock-'))
  writeFileSync(
    path.join(userDataDir, '.dsh-chamber.lock'),
    JSON.stringify({ pid: lockPid, startedAt: Date.now() / 1000, shell: 'test' }),
  )
  const child: ChildProcessWithoutNullStreams = spawn(
    nodePath,
    [sidecarPath, '--user-data-dir', userDataDir, '--port', port],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] },
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
  return { ready, exit, stderr: () => stderr, kill: (signal) => child.kill(signal) }
}

before(async () => {
  if (!nodeAvailable) return
  driver = await startDriver()
})
after(async () => {
  if (!nodeAvailable) return
  await driver.close()
})

test('sidecar stdio：环境缺 node 时整组 skip', (t) => {
  if (!nodeAvailable) t.skip('NODE_BIN 与 process.execPath 均不可用')
})

test('W-13 ① info 真实载荷', async () => {
  if (!nodeAvailable) return
  const r = await driver.invoke('dsh-chamber:info', null)
  assert.equal(r.ok, true)
  const result = r.result as Record<string, unknown>
  assert.equal(typeof result.controlPlaneUrl, 'string')
  assert.equal(result.platform, 'darwin')
  assert.equal(typeof result.version, 'string')
})

test('W-13 ② settings-set → rendererPush 推送采样', async () => {
  if (!nodeAvailable) return
  const notifyP = driver.waitNotify('rendererPush')
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

test('W-13 ⑤ SIGTERM 优雅退出 exit 0', async () => {
  if (!nodeAvailable) return
  const code = await driver.close()
  assert.equal(code, 0)
})

// 三审 #7：退出码分级常量必须互异且与 Supervisor 分级一致（70=启动失败、
// 3=锁冲突、1=运行期崩溃、0=优雅停止）。常量是 sidecar-entry 的导出单源。
test('退出码分级常量（0/3/70/1）', () => {
  const codes = [EXIT_GRACEFUL, EXIT_LOCK_CONFLICT, EXIT_STARTUP_FAILURE, EXIT_RUNTIME_CRASH]
  assert.deepEqual(codes, [0, 3, 70, 1])
  assert.equal(new Set(codes).size, codes.length, '退出码不得重复')
})
