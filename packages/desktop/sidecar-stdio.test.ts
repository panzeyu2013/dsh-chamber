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
 * 环境：node 路径 env NODE_BIN → 缺省 /Applications/dsh-chamber.app（Electron
 * as node，ELECTRON_RUN_AS_NODE=1）→ 不存在则整文件 skip（CI 无 GUI 侧）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const dir = path.dirname(fileURLToPath(import.meta.url))
const sidecarPath = path.join(dir, 'sidecar-entry.ts')
const nodePath =
  process.env.NODE_BIN ?? '/Applications/dsh-chamber.app/Contents/MacOS/dsh-chamber'

interface Driver {
  invoke(method: string, payload: unknown, timeoutMs?: number): Promise<{ ok: boolean; result?: unknown; error?: string }>
  waitNotify(event: string, timeoutMs?: number): Promise<Record<string, unknown>>
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

before(async () => {
  if (!nodeAvailable) return
  driver = await startDriver()
})
after(async () => {
  if (!nodeAvailable) return
  await driver.close()
})

test('sidecar stdio：环境缺 node 时整组 skip', (t) => {
  if (!nodeAvailable) t.skip('NODE_BIN 与缺省 Electron-as-node 路径均不可用')
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

test('W-13 ③ 代表通道均应答（ok 或 loud ctx-unavailable）', async () => {
  if (!nodeAvailable) return
  const channels = [
    'dsh-chamber:settings-get',
    'desktop_ssh_instances_get',
    'desktop_ssh_status',
    'dsh-chamber:runtime-state',
    'dsh-chamber:update-state',
    'desktop_ssh_config_list',
    'desktop_local_plugin_list',
  ]
  for (const ch of channels) {
    const r = await driver.invoke(ch, null, 4000)
    // loud 判据：ok，或错误串非空（sidecar-ctx-unavailable:* / 参数校验 /
    // 解构类 loud 错误均可——核心要求是绝无挂起、绝不静默空成功）
    assert.equal(
      r.ok || (typeof r.error === 'string' && r.error.length > 0),
      true,
      `通道 ${ch} 应 ok 或 loud 错误（实际 ${JSON.stringify(r)}）`,
    )
  }
})

test('W-13 ④ 未知通道 loud', async () => {
  if (!nodeAvailable) return
  const r = await driver.invoke('zzz.definitely-unknown', null)
  assert.equal(r.ok, false)
  assert.equal(r.error, 'sidecar-unknown-channel')
})

test('W-13 ⑤ SIGTERM 优雅退出 exit 0', async () => {
  if (!nodeAvailable) return
  const code = await driver.close()
  assert.equal(code, 0)
})
