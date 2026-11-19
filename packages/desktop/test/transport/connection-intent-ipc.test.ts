/**
 * D1（intent 逐行化）：显式连接/断开的 IPC 组合点（shell-ipc-connections.ts）在 partial
 * roster 下当次生效。最小 fake ShellIpcCtx（同 transport-registry-health.test.ts 的 registrar
 * 形状）+ registerConnectionHandlers 直接驱动 SSH_CONNECT / SSH_DISCONNECT：
 *
 * ① partial roster（行级丢弃 ⇒ 名册健康门关闭）时意图 **0 次写**，但内存意图照常生效——
 *    显式连接清掉陈旧的本会话抑制、通过 canAttempt 并当次 spawn（audit 报 volatile 未落盘）；
 * ② 显式断开先停传输（立即可见 idle）再记内存意图；内部 connect 经 canAttempt 门无法复活
 *    已显式断开的行；两次动作都不写盘（文件逐字节不变）。
 *
 * 负向对照（未修复代码）：① 停在 idle + spawn=0 + 抑制未清；② 内存不记 s2、内部 connect 复活。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTransportManager } from '../../transport-manager.ts'
import { sshProvider } from '../../ssh-provider.ts'
import { registerConnectionHandlers } from '../../shell-ipc-connections.ts'
import { IPC_CHANNELS } from '../../ipc-events.ts'
import type { ShellIpcCtx } from '../../shell-core.ts'
import { FakeChild, silentLogger, tempDir } from '../support/transport-manager-harness.ts'

/** Poll instead of a fixed sleep: spawn/probe hand-offs in this fake are async. */
async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

const SESSION = 'app-session-aaaa0000'
const baseRow = { kind: 'dsh', transport: 'ssh', serviceName: null, remoteDshHome: null, insecureHttp: false }

/** 最小 fake ctx：registrar 收集 handler；audit 收集事件（与 health 测试同形状）。 */
function installHandlers(manager: ReturnType<typeof createTransportManager>) {
  const handlers = new Map<string, (payload: unknown) => unknown>()
  const audits: Array<{ event: string; detail?: string }> = []
  const ctx = {
    deps: {
      ipc: {
        handle: (channel: string, handler: (payload: unknown) => unknown) => {
          handlers.set(channel, handler)
        },
      },
      ctx: {
        transportManager: manager,
        gatewaySessions: null,
        publishRegistryTransition: () => [],
        audit: (event: { event: string; detail?: string }) => { audits.push(event) },
      },
    },
    projectInstances: (instances: unknown) => instances,
  } as unknown as ShellIpcCtx
  registerConnectionHandlers(ctx)
  const invoke = (channel: string, payload: unknown): unknown => {
    const handler = handlers.get(channel)
    assert.notEqual(handler, undefined, 'handler registered: ' + channel)
    return handler!(payload)
  }
  return { invoke, audits }
}

function setup() {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  // partial roster：两行合法（s1 带本会话断开意图、s2 干净）+ 一行会被 validateSpec 丢弃的坏行。
  writeFileSync(file, JSON.stringify([
    { ...baseRow, id: 's1', label: 'home', host: 'home.example.com', user: 'alice', sshPort: 22, remotePort: 2222, dshChamber: { manualDisconnectSessionId: SESSION } },
    { ...baseRow, id: 's2', label: 'lab', host: 'lab.example.com', user: 'bob', sshPort: 22, remotePort: 3080 },
    { id: 'bad id', label: 'x', host: 'h.example.com', remotePort: 22 },
  ]))
  const spawns: FakeChild[] = []
  let manager: ReturnType<typeof createTransportManager>
  manager = createTransportManager({
    provider: { ...sshProvider, transportSocketPath: () => null },
    spawnFn: () => { const child = new FakeChild(); spawns.push(child); return child },
    instancesFile: file,
    logger: silentLogger,
    portProbe: async () => false,
    allocatePort: async () => 43210,
    connectionIntent: { appSessionId: SESSION },
    // 生产 host-assembly 同款内部门：连接意图抑制集是唯一事实源。
    canAttempt: id => !manager.connectionIntents().suppressed.has(id),
    options: { readyTimeoutMs: 40, probeIntervalMs: 5, retryBaseMs: 5, retryMaxMs: 10, maxRetryAttempts: 1, disconnectGraceMs: 20 },
  })
  manager.loadInstances()
  return { manager, file, spawns, ...installHandlers(manager), cleanup: () => manager.dispose() }
}

test('partial roster: explicit connect clears the suppressed intent in memory, passes canAttempt, writes nothing', async () => {
  const h = setup()
  try {
    assert.equal(h.manager.registryIncomplete(), true, 'the fixture is a partial roster (bad row dropped)')
    assert.deepEqual([...h.manager.connectionIntents().suppressed], ['s1'], 'the current-session intent was loaded')
    const before = readFileSync(h.file, 'utf8')
    const result = h.invoke(IPC_CHANNELS.SSH_CONNECT, { id: 's1' }) as { phase?: string }
    assert.equal(result.phase, 'connecting', 'the explicit connect takes effect in this pass')
    assert.deepEqual([...h.manager.connectionIntents().suppressed], [], 'the stale suppression is cleared in memory')
    await waitUntil(() => h.spawns.length === 1)
    assert.equal(h.spawns.length, 1, 'the explicit connect passes canAttempt and spawns')
    assert.equal(readFileSync(h.file, 'utf8'), before, 'the closed health gate writes nothing (bytes identical)')
    assert.ok(h.audits.some(entry => entry.event === 'connection_intent_persist_failed'),
      'the zero-write clear is reported on the audit channel (volatile, never blocking the action)')
  } finally {
    h.cleanup()
  }
})

test('partial roster: explicit disconnect stops the transport, remembers it in memory, writes nothing', async () => {
  const h = setup()
  try {
    assert.equal(h.manager.registryIncomplete(), true, 'the fixture is a partial roster (bad row dropped)')
    // 先显式连上 s2（同样当次生效），再验证显式断开的顺序与抑制。
    h.invoke(IPC_CHANNELS.SSH_CONNECT, { id: 's2' })
    await waitUntil(() => h.spawns.length === 1)
    assert.equal(h.spawns.length, 1, 'the row is live before the disconnect')
    const before = readFileSync(h.file, 'utf8')
    const result = h.invoke(IPC_CHANNELS.SSH_DISCONNECT, { id: 's2' }) as { phase?: string }
    assert.equal(result.phase, 'idle', 'the transport stops immediately')
    assert.deepEqual([...h.manager.connectionIntents().suppressed].sort(), ['s1', 's2'],
      'the explicit disconnect is remembered in memory under the closed gate')
    assert.equal(readFileSync(h.file, 'utf8'), before, 'the closed health gate writes nothing (bytes identical)')
    assert.ok(h.audits.some(entry => entry.event === 'connection_intent_persist_failed'),
      'the zero-write disconnect is reported on the audit channel')
    // 内部入口经 canAttempt 门：已显式断开的行绝不被自动路径复活。
    h.manager.connect('s2')
    assert.equal(h.manager.status('s2')?.phase, 'idle', 'an internal connect can never resurrect an explicitly disconnected row')
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(h.spawns.length, 1, 'no late spawn after the explicit disconnect (grace covers the retry window)')
  } finally {
    h.cleanup()
  }
})
