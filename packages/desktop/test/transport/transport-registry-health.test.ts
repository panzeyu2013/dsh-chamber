/**
 * F13：持久化 ssh-instances 注册表的降级信号（transport-manager 只读健康位 →
 * desktop_ssh_instances_health IPC → renderer 剪枝门）。
 *
 * 既有语义（不动）：loadInstances() 遇损坏文件仍 LOUD 抛错，调用方
 * （main.ts / sidecar-ctx.ts）把文件保留为 *.corrupt 后空启动。本测试钉住
 * 新增的只读事实：损坏 → registryDegraded()=true + loadFailure() 原因；
 * 健康（有效文件/纯缺失）→ false；权威 saveInstances() 重建 → 恢复 false；
 * 「第二次启动」形态（live 缺失而 *.corrupt 副本仍在）仍是 unknown，绝不
 * 冒充健康空集。IPC 侧用最小 fake ctx 装配 registerConnectionHandlers，直接
 * 驱动健康通道——载荷只有 {degraded, reason?, rosterIncomplete, droppedCount?}，
 * 不触碰 instances_get 数组。
 *
 * V5-A（行级丢弃）补钉：解析成功但丢弃条目/重复 id 时，磁盘有内容而 roster
 * 只是子集——健康通道报 rosterIncomplete=true（附 droppedCount），合法行仍
 * 在 registry 内；降级态 authoritative 失败不清位不落盘；降级补偿 skip 的
 * warn 文案；ENOENT 无 .corrupt 的复健；authoritative 保存后 incomplete 清零。
 * renderer 侧的剪枝门真值表在 packages/renderer/test/wiring/
 * unread-prune-roster-gate.test.ts（本文件覆盖 producer 与 IPC 面）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTransportManager } from '../../transport-manager.ts'
import { sshProvider } from '../../ssh-provider.ts'
import { saveConnectionTransaction, type SaveConnectionTransactionDeps } from '../../connection-save.ts'
import { IPC_CHANNELS } from '../../ipc-events.ts'
import { registerConnectionHandlers } from '../../shell-ipc-connections.ts'
import type { ShellIpcCtx } from '../../shell-core.ts'
import { silentLogger, tempDir } from '../support/transport-manager-harness.ts'

function makeHealthManager(dir: string, warnings?: string[]) {
  return createTransportManager({
    provider: sshProvider,
    instancesFile: join(dir, 'ssh-instances.json'),
    logger: warnings === undefined
      ? silentLogger
      : { log() {}, warn: message => { warnings.push(message) }, error() {} },
  })
}

/** The health-channel payload shape (V5-A): rosterIncomplete is always
 *  present; droppedCount only alongside it. */
interface HealthProjection {
  degraded: boolean
  reason?: string
  rosterIncomplete?: boolean
  droppedCount?: number
}

/** 最小 fake ctx：registrar 收集 handler；health 通道只读 loadFailure()。 */
function installHealthChannel(manager: ReturnType<typeof createTransportManager>) {
  const handlers = new Map<string, (payload: unknown) => unknown>()
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
        audit: () => {},
      },
    },
    projectInstances: (instances: unknown) => instances,
  } as unknown as ShellIpcCtx
  registerConnectionHandlers(ctx)
  return {
    invokeHealth: async (): Promise<HealthProjection> => {
      const handler = handlers.get(IPC_CHANNELS.SSH_INSTANCES_HEALTH)
      assert.notEqual(handler, undefined, 'desktop_ssh_instances_health must be registered')
      return await handler!(null) as HealthProjection
    },
  }
}

test('a healthy registry (missing file or valid array) is not degraded and the health channel says so', async t => {
  const dir = tempDir(t)
  const manager = makeHealthManager(dir)
  const health = installHealthChannel(manager)
  // 纯缺失（无 .corrupt 副本）= 正常空注册表。
  assert.equal(manager.registryDegraded(), false)
  assert.equal(manager.loadFailure(), null)
  assert.deepEqual(manager.loadInstances(), [])
  assert.deepEqual(await health.invokeHealth(), { degraded: false, rosterIncomplete: false })
  // 有效数组（含合法实例）= 健康。
  writeFileSync(join(dir, 'ssh-instances.json'), JSON.stringify([
    { id: 'ok', label: 'fine', kind: 'dsh', transport: 'ssh', host: 'h.example.com', remotePort: 22 },
  ]))
  assert.deepEqual(manager.loadInstances().map(entry => entry.id), ['ok'])
  assert.equal(manager.registryDegraded(), false)
  assert.deepEqual(await health.invokeHealth(), { degraded: false, rosterIncomplete: false })
})

test('a corrupt registry fails loudly, records the degradation, and the health channel reports the reason', async t => {
  const dir = tempDir(t)
  const file = join(dir, 'ssh-instances.json')
  writeFileSync(file, '{not json')
  const manager = makeHealthManager(dir)
  const health = installHealthChannel(manager)
  // 既有损坏语义不动：load 仍 LOUD 抛错（调用方保留 *.corrupt 后空启动）。
  assert.throws(() => manager.loadInstances(), /corrupt/)
  assert.equal(manager.registryDegraded(), true)
  const reason = manager.loadFailure()
  assert.ok(reason !== null && reason.includes('corrupt'), 'the failure text stays diagnosable')
  const projection = await health.invokeHealth()
  assert.equal(projection.degraded, true)
  assert.equal(projection.reason, reason, 'the channel carries the same failure text')
  assert.equal(projection.rosterIncomplete, false, 'a whole-file failure is degraded, not row-level incomplete')
  // 调用方的保留动作（main/sidecar 同源）：rename 为 *.corrupt。
  renameSync(file, `${file}.corrupt`)
  // 「第二次启动」形态：live 缺失但副本仍在 = 内容未知，仍降级，且绝不抛错。
  assert.deepEqual(manager.loadInstances(), [])
  assert.equal(manager.registryDegraded(), true)
  assert.match(manager.loadFailure() ?? '', /corrupt/)
  assert.equal((await health.invokeHealth()).degraded, true)
})

test('an authoritative saveInstances rebuild clears the degradation (health recovers)', async t => {
  const dir = tempDir(t)
  const file = join(dir, 'ssh-instances.json')
  writeFileSync(file, '{not json')
  const manager = makeHealthManager(dir)
  const health = installHealthChannel(manager)
  assert.throws(() => manager.loadInstances(), /corrupt/)
  assert.equal(manager.registryDegraded(), true)
  // 权威重建（save_connection 的持久化腿）后恢复健康。
  assert.deepEqual(
    manager.saveInstances([{ id: 's1', label: 'restored', kind: 'dsh', transport: 'ssh', host: 'h.example.com', remotePort: 22 }]).map(entry => entry.id),
    ['s1'],
  )
  assert.equal(manager.registryDegraded(), false)
  assert.equal(manager.loadFailure(), null)
  assert.deepEqual(await health.invokeHealth(), { degraded: false, rosterIncomplete: false })
})

test('F16/A4+F19: a compensation rollback neither clears the degradation nor restores the live file; only an authoritative rebuild does', async t => {
  const dir = tempDir(t)
  const file = join(dir, 'ssh-instances.json')
  writeFileSync(file, '{not json')
  const manager = makeHealthManager(dir)
  const health = installHealthChannel(manager)
  assert.throws(() => manager.loadInstances(), /corrupt/)
  assert.equal(manager.registryDegraded(), true)
  // Caller's preserve step + "second launch" shape: live missing, sibling there.
  renameSync(file, `${file}.corrupt`)
  assert.deepEqual(manager.loadInstances(), [])
  assert.equal(manager.registryDegraded(), true)
  // A transaction rollback writes the pre-transaction roster — at degraded
  // startup that is the in-memory empty set, not the unknown file contents.
  manager.saveInstances([], 'compensation')
  assert.equal(manager.registryDegraded(), true, 'compensation must NOT clear the degraded gate')
  assert.equal(existsSync(file), false, 'a degraded compensation must not resurrect the live file (F19)')
  assert.match(manager.loadFailure() ?? '', /corrupt/)
  assert.deepEqual(await health.invokeHealth(), { degraded: true, reason: manager.loadFailure(), rosterIncomplete: false })
  // Only the authoritative rebuild is new registry truth.
  manager.saveInstances([{ id: 'restored', label: 'restored', kind: 'dsh', transport: 'ssh', host: 'h.example.com', remotePort: 22 }], 'authoritative')
  assert.equal(manager.registryDegraded(), false)
  assert.equal(manager.loadFailure(), null)
  assert.deepEqual(await health.invokeHealth(), { degraded: false, rosterIncomplete: false })
})

test('F16/A4+F19: degraded startup + a failed save transaction stays degraded and leaves the live file absent after the rollback', async t => {
  const dir = tempDir(t)
  const file = join(dir, 'ssh-instances.json')
  writeFileSync(file, '{not json')
  const manager = makeHealthManager(dir)
  const health = installHealthChannel(manager)
  assert.throws(() => manager.loadInstances(), /corrupt/)
  renameSync(file, `${file}.corrupt`)
  assert.deepEqual(manager.loadInstances(), [])
  assert.equal(manager.registryDegraded(), true)

  // The authoritative proposal leg fails (simulated registry write failure);
  // the compensation leg reaches the REAL manager, which is exactly the path
  // that used to clear the gate by writing [] successfully.
  let authoritativeAttempts = 0
  const deps: SaveConnectionTransactionDeps = {
    listInstances: () => manager.listInstances(),
    normalize: input => sshProvider.validateSpec(input),
    saveInstances: (next, provenance = 'authoritative') => {
      if (provenance === 'authoritative') {
        authoritativeAttempts += 1
        throw new Error('simulated registry write failure')
      }
      return manager.saveInstances(next, provenance)
    },
    getSshPassword: () => null,
    getGatewayToken: () => null,
    getGatewayPassword: () => null,
    setSshPassword: () => {},
    setGatewaySecrets: () => {},
    invalidateGatewaySessions: () => {},
    isActive: () => false,
    disconnect: () => {},
    connect: () => {},
  }
  const result = saveConnectionTransaction(deps, {
    previousId: null,
    input: {
      id: 'added', label: 'Added', kind: 'dsh', transport: 'ssh',
      host: 'added.example.com', user: 'alice', sshPort: 22, remotePort: 30800,
    },
    credentials: { sshPassword: 'transient-write-only' },
  })
  assert.equal(result.ok, false)
  assert.equal(authoritativeAttempts, 1)
  assert.equal(result.metadataCommitted, false)
  // F19: the compensation leg is memory-only while degraded — the live file
  // stays absent instead of being resurrected as an authoritative [].
  assert.deepEqual(manager.listInstances(), [])
  assert.equal(existsSync(file), false, 'a degraded compensation must not write the live file')
  assert.equal(existsSync(`${file}.corrupt`), true, 'the preserved copy stays in place')
  // ...yet the health channel must still report the load failure: the rollback
  // is not new registry truth, and [] is not an authoritative empty roster
  // while the preserved .corrupt copy is unknown.
  assert.equal(manager.registryDegraded(), true)
  assert.match(manager.loadFailure() ?? '', /corrupt/)
  assert.deepEqual(await health.invokeHealth(), { degraded: true, reason: manager.loadFailure(), rosterIncomplete: false })
})

test('F16/D4: a successful load of a valid registry after degradation clears the gate', async t => {
  const dir = tempDir(t)
  const file = join(dir, 'ssh-instances.json')
  writeFileSync(file, '{not json')
  const manager = makeHealthManager(dir)
  const health = installHealthChannel(manager)
  assert.throws(() => manager.loadInstances(), /corrupt/)
  renameSync(file, `${file}.corrupt`)
  assert.deepEqual(manager.loadInstances(), [])
  assert.equal(manager.registryDegraded(), true)
  assert.equal((await health.invokeHealth()).degraded, true)
  // Operator restores a valid live registry. The SUCCESS branch of
  // loadInstances() had no pin; it must clear the gate (valid file wins over
  // the stale failure record).
  writeFileSync(file, JSON.stringify([
    { id: 'fresh', label: 'Fresh', kind: 'dsh', transport: 'ssh', host: 'h.example.com', remotePort: 22 },
  ]))
  assert.deepEqual(manager.loadInstances().map(entry => entry.id), ['fresh'])
  assert.equal(manager.registryDegraded(), false)
  assert.equal(manager.loadFailure(), null)
  assert.deepEqual(await health.invokeHealth(), { degraded: false, rosterIncomplete: false })
})

test('an oversized registry records the degradation and still fails loudly', async t => {
  const dir = tempDir(t)
  const file = join(dir, 'ssh-instances.json')
  writeFileSync(file, JSON.stringify(Array.from({ length: 201 }, (_unused, index) => ({
    id: `s${index}`, label: 'x', host: 'h.example.com', remotePort: 22,
  }))))
  const manager = makeHealthManager(dir)
  assert.throws(() => manager.loadInstances(), /limit/)
  assert.equal(manager.registryDegraded(), true)
  assert.match(manager.loadFailure() ?? '', /limit/)
})

test('F19: while degraded the corrupt live file stays byte-identical under a compensation rollback', t => {
  const dir = tempDir(t)
  const file = join(dir, 'ssh-instances.json')
  writeFileSync(file, '{not json')
  const manager = makeHealthManager(dir)
  // The caller's preserve step has NOT run yet: the corrupt live file is in
  // place and the in-memory roster is empty.
  assert.throws(() => manager.loadInstances(), /corrupt/)
  assert.equal(manager.registryDegraded(), true)
  assert.deepEqual(manager.saveInstances([], 'compensation'), [])
  assert.equal(readFileSync(file, 'utf8'), '{not json', 'the corrupt live file must not be overwritten')
  assert.equal(manager.registryDegraded(), true)
})

test('F19: a degraded compensation leaves the live file absent, the restart stays degraded, and only an authoritative rebuild heals it', async t => {
  const dir = tempDir(t)
  const file = join(dir, 'ssh-instances.json')
  const corruptText = '{not json'
  writeFileSync(file, corruptText)
  const manager = makeHealthManager(dir)
  const health = installHealthChannel(manager)
  assert.throws(() => manager.loadInstances(), /corrupt/)
  // The caller's preserve step (main.ts / sidecar-ctx.ts): rename aside, then
  // the follow-up load reads "live missing + .corrupt sibling" = unknown.
  renameSync(file, `${file}.corrupt`)
  assert.deepEqual(manager.loadInstances(), [])
  assert.equal(manager.registryDegraded(), true)
  // The transaction rollback leg while degraded: in-memory rollback accepted,
  // disk untouched.
  assert.deepEqual(manager.saveInstances([], 'compensation'), [])
  assert.deepEqual(manager.listInstances(), [])
  assert.equal(existsSync(file), false, 'the degraded compensation must not create the live file')
  assert.equal(readFileSync(`${file}.corrupt`, 'utf8'), corruptText, 'the preserved copy stays byte-identical')
  assert.equal(manager.registryDegraded(), true)
  assert.deepEqual(await health.invokeHealth(), { degraded: true, reason: manager.loadFailure(), rosterIncomplete: false })
  // Simulated restart: a brand-new manager over the same directory must not
  // read the (still absent) live file as a healthy empty registry.
  const restarted = makeHealthManager(dir)
  const restartedHealth = installHealthChannel(restarted)
  assert.deepEqual(restarted.loadInstances(), [])
  assert.equal(restarted.registryDegraded(), true, 'live missing + .corrupt sibling = unknown, still degraded')
  assert.match(restarted.loadFailure() ?? '', /corrupt/)
  assert.deepEqual(await restartedHealth.invokeHealth(), { degraded: true, reason: restarted.loadFailure(), rosterIncomplete: false })
  // An authoritative rebuild is the only heal: it writes the live file and
  // clears the gate.
  const restored = { id: 'restored', label: 'Restored', kind: 'dsh' as const, transport: 'ssh' as const, host: 'h.example.com', remotePort: 22 }
  assert.deepEqual(restarted.saveInstances([restored]).map(entry => entry.id), ['restored'])
  assert.equal(restarted.registryDegraded(), false)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).map((entry: { id: string }) => entry.id), ['restored'])
  // The launch after that is healthy and carries the complete row.
  const healthy = makeHealthManager(dir)
  const healthyHealth = installHealthChannel(healthy)
  assert.deepEqual(healthy.loadInstances().map(entry => entry.id), ['restored'])
  assert.equal(healthy.registryDegraded(), false)
  assert.equal(healthy.loadFailure(), null)
  assert.deepEqual(await healthyHealth.invokeHealth(), { degraded: false, rosterIncomplete: false })
})

test('F19 regression: a non-degraded compensation still persists the pre-transaction snapshot back to disk', async t => {
  const dir = tempDir(t)
  const file = join(dir, 'ssh-instances.json')
  const keep = { id: 'keep', label: 'Keep', kind: 'dsh' as const, transport: 'ssh' as const, host: 'keep.example.com', remotePort: 22 }
  writeFileSync(file, JSON.stringify([keep]))
  const manager = makeHealthManager(dir)
  assert.deepEqual(manager.loadInstances().map(entry => entry.id), ['keep'])
  assert.equal(manager.registryDegraded(), false)
  // A transaction whose authoritative leg persisted (and updated the in-memory
  // roster) and THEN threw: the compensation leg must restore the snapshot on
  // disk, not only in memory.
  let authoritativeCalls = 0
  const deps: SaveConnectionTransactionDeps = {
    listInstances: () => manager.listInstances(),
    normalize: input => sshProvider.validateSpec(input),
    saveInstances: (next, provenance = 'authoritative') => {
      const saved = manager.saveInstances(next, provenance)
      if (provenance === 'authoritative') {
        authoritativeCalls += 1
        throw new Error('simulated registry failure after commit')
      }
      return saved
    },
    getSshPassword: () => null,
    getGatewayToken: () => null,
    getGatewayPassword: () => null,
    setSshPassword: () => {},
    setGatewaySecrets: () => {},
    invalidateGatewaySessions: () => {},
    isActive: () => false,
    disconnect: () => {},
    connect: () => {},
  }
  const result = saveConnectionTransaction(deps, {
    previousId: null,
    input: {
      id: 'added', label: 'Added', kind: 'dsh', transport: 'ssh',
      host: 'added.example.com', user: 'alice', sshPort: 22, remotePort: 30800,
    },
    credentials: {},
  })
  assert.equal(result.ok, false)
  assert.equal(authoritativeCalls, 1)
  assert.deepEqual(manager.listInstances().map(entry => entry.id), ['keep'])
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).map((entry: { id: string }) => entry.id), ['keep'],
    'a healthy rollback must still persist the before snapshot (F19 regression)')
  assert.equal(manager.registryDegraded(), false)
})

// ── V5-A：行级丢弃（rosterIncomplete）的 producer + IPC 面 ─────────────────────

test('V5-A: a non-array JSON registry fails loudly and reports degraded (never an empty roster)', async t => {
  const dir = tempDir(t)
  const file = join(dir, 'ssh-instances.json')
  writeFileSync(file, JSON.stringify({ id: 'not-an-array' }))
  const manager = makeHealthManager(dir)
  const health = installHealthChannel(manager)
  assert.throws(() => manager.loadInstances(), /does not contain an array/)
  assert.equal(manager.registryDegraded(), true)
  assert.equal(manager.registryIncomplete(), false, 'the whole-file rejection is degraded, not row-level incomplete')
  assert.equal(manager.loadDroppedCount(), 0)
  const projection = await health.invokeHealth()
  assert.equal(projection.degraded, true)
  assert.match(projection.reason ?? '', /array/, 'the reason names the non-array shape')
  assert.equal(projection.rosterIncomplete, false)
  assert.equal(projection.droppedCount, undefined, 'no count without the incomplete bit')
})

test('V5-A: row-level drops mark the roster incomplete while every valid row stays installed', async t => {
  const dir = tempDir(t)
  const file = join(dir, 'ssh-instances.json')
  const warnings: string[] = []
  writeFileSync(file, JSON.stringify([
    { id: 'ok', label: 'fine', kind: 'dsh', transport: 'ssh', host: 'h.example.com', remotePort: 22 },
    { id: 'bad id', label: 'x', host: 'h.example.com', remotePort: 22 },
    null,
    { id: 'ok', label: 'duplicate', kind: 'dsh', transport: 'ssh', host: 'h2.example.com', remotePort: 22 },
  ]))
  const manager = makeHealthManager(dir, warnings)
  const health = installHealthChannel(manager)
  assert.deepEqual(manager.loadInstances().map(entry => entry.id), ['ok'],
    'legal rows install; the dropped invalid/duplicate rows do not')
  assert.equal(manager.registryDegraded(), false, 'a partial parse is NOT a load failure')
  assert.equal(manager.loadFailure(), null)
  assert.equal(manager.registryIncomplete(), true)
  assert.equal(manager.loadDroppedCount(), 3, 'two invalid entries + one duplicate id')
  assert.ok(warnings.some(line => /dropped 2 invalid instance/.test(line)), 'the per-entry drop stays loud')
  assert.ok(warnings.some(line => /dropped 1 duplicate id/.test(line)), 'the duplicate drop stays loud')
  assert.deepEqual(await health.invokeHealth(), {
    degraded: false,
    rosterIncomplete: true,
    droppedCount: 3,
  })
})

test('V5-A: a drop-free load and an authoritative save both clear rosterIncomplete', async t => {
  const dir = tempDir(t)
  const file = join(dir, 'ssh-instances.json')
  const valid = [{ id: 'ok', label: 'fine', kind: 'dsh', transport: 'ssh', host: 'h.example.com', remotePort: 22 }]
  writeFileSync(file, JSON.stringify([
    ...valid,
    { id: 'bad id', label: 'x', host: 'h.example.com', remotePort: 22 },
  ]))
  const manager = makeHealthManager(dir)
  const health = installHealthChannel(manager)
  assert.deepEqual(manager.loadInstances().map(entry => entry.id), ['ok'])
  assert.equal(manager.registryIncomplete(), true)
  assert.equal(manager.loadDroppedCount(), 1)
  // (a) A later drop-free successful load (operator fixed the file / a newer
  // writer rewrote it) clears the bit.
  writeFileSync(file, JSON.stringify(valid))
  assert.deepEqual(manager.loadInstances().map(entry => entry.id), ['ok'])
  assert.equal(manager.registryIncomplete(), false)
  assert.equal(manager.loadDroppedCount(), 0)
  assert.deepEqual(await health.invokeHealth(), { degraded: false, rosterIncomplete: false })
  // (b) A partial file again, then an AUTHORITATIVE save rebuilding the file.
  writeFileSync(file, JSON.stringify([
    ...valid,
    { id: 'also bad', label: 'x', host: 'h.example.com', remotePort: 22 },
  ]))
  assert.deepEqual(manager.loadInstances().map(entry => entry.id), ['ok'])
  assert.equal(manager.registryIncomplete(), true)
  assert.deepEqual(manager.saveInstances(valid).map(entry => entry.id), ['ok'])
  assert.equal(manager.registryIncomplete(), false, 'an authoritative rebuild is new registry truth')
  assert.equal(manager.loadDroppedCount(), 0)
  assert.equal(manager.registryDegraded(), false)
  assert.deepEqual(await health.invokeHealth(), { degraded: false, rosterIncomplete: false })
  assert.deepEqual(
    JSON.parse(readFileSync(file, 'utf8')).map((entry: { id: string }) => entry.id),
    ['ok'],
    'the authoritative save rewrote the complete roster',
  )
})

test('V5-A: an incomplete roster skips the compensation disk write and stays incomplete (warn pinned)', async t => {
  const dir = tempDir(t)
  const file = join(dir, 'ssh-instances.json')
  const original = JSON.stringify([
    { id: 'ok', label: 'fine', kind: 'dsh', transport: 'ssh', host: 'h.example.com', remotePort: 22 },
    { id: 'bad id', label: 'x', host: 'h.example.com', remotePort: 22 },
  ])
  writeFileSync(file, original)
  const warnings: string[] = []
  const manager = makeHealthManager(dir, warnings)
  const health = installHealthChannel(manager)
  assert.deepEqual(manager.loadInstances().map(entry => entry.id), ['ok'])
  assert.equal(manager.registryIncomplete(), true)
  // The transaction rollback leg: memory rollback accepted, disk untouched
  // (rewriting the partial in-memory snapshot would make the next launch read
  // a partial file as a complete roster).
  assert.deepEqual(manager.saveInstances([], 'compensation'), [])
  assert.equal(manager.registryIncomplete(), true, 'compensation must NOT clear the incomplete bit')
  assert.equal(manager.registryDegraded(), false)
  assert.equal(readFileSync(file, 'utf8'), original, 'the partial live file must stay byte-identical')
  const skip = warnings.find(line => line.includes('compensation write'))
  assert.ok(skip !== undefined, 'the skip must be loud, never silent')
  assert.match(skip!, /registry roster is incomplete/)
  assert.match(skip!, /incomplete gate stays closed/)
  assert.deepEqual(await health.invokeHealth(), { degraded: false, rosterIncomplete: true, droppedCount: 1 })
})

test('V5-A/F19: while degraded, a failing authoritative save (invalid or oversized) neither clears the gate nor writes the live file', async t => {
  const dir = tempDir(t)
  const file = join(dir, 'ssh-instances.json')
  writeFileSync(file, '{not json')
  const manager = makeHealthManager(dir)
  const health = installHealthChannel(manager)
  assert.throws(() => manager.loadInstances(), /corrupt/)
  renameSync(file, `${file}.corrupt`)
  assert.deepEqual(manager.loadInstances(), [])
  assert.equal(manager.registryDegraded(), true)
  // An invalid authoritative proposal rejects before persistence.
  assert.throws(() => manager.saveInstances([{ id: 'bad id', label: 'x', host: 'h.example.com', remotePort: 22 }]), /invalid/)
  assert.equal(manager.registryDegraded(), true, 'a rejected proposal must not clear the degraded gate')
  assert.equal(existsSync(file), false, 'a rejected proposal must not create the live file')
  // An over-limit authoritative proposal rejects before persistence too.
  assert.throws(() => manager.saveInstances(Array.from({ length: 201 }, (_unused, index) => ({
    id: `s${index}`, label: 'x', host: 'h.example.com', remotePort: 22,
  }))), /limit/)
  assert.equal(manager.registryDegraded(), true)
  assert.equal(existsSync(file), false)
  assert.deepEqual(await health.invokeHealth(), { degraded: true, reason: manager.loadFailure(), rosterIncomplete: false })
})

test('V5-A: a missing live file WITHOUT the preserved .corrupt sibling clears a prior degradation', async t => {
  const dir = tempDir(t)
  const file = join(dir, 'ssh-instances.json')
  writeFileSync(file, '{not json')
  const manager = makeHealthManager(dir)
  const health = installHealthChannel(manager)
  assert.throws(() => manager.loadInstances(), /corrupt/)
  renameSync(file, `${file}.corrupt`)
  assert.deepEqual(manager.loadInstances(), [])
  assert.equal(manager.registryDegraded(), true)
  // Operator discards the preserved copy (accepts the loss): the next load is a
  // plain missing-file empty registry — drop-free, so it heals the gate.
  rmSync(`${file}.corrupt`)
  assert.deepEqual(manager.loadInstances(), [])
  assert.equal(manager.registryDegraded(), false)
  assert.equal(manager.loadFailure(), null)
  assert.equal(manager.registryIncomplete(), false)
  assert.deepEqual(await health.invokeHealth(), { degraded: false, rosterIncomplete: false })
})

test('F19/V5-A: the degraded compensation skip is loud and names the closed gate (warn text pinned)', async t => {
  const dir = tempDir(t)
  const file = join(dir, 'ssh-instances.json')
  writeFileSync(file, '{not json')
  const warnings: string[] = []
  const manager = makeHealthManager(dir, warnings)
  assert.throws(() => manager.loadInstances(), /corrupt/)
  renameSync(file, `${file}.corrupt`)
  assert.deepEqual(manager.loadInstances(), [])
  assert.equal(manager.registryDegraded(), true)
  assert.deepEqual(manager.saveInstances([], 'compensation'), [])
  const skip = warnings.find(line => line.includes('compensation write'))
  assert.ok(skip !== undefined, 'the degraded compensation skip must be loud')
  assert.match(skip!, /registry load is degraded/)
  assert.match(skip!, /degraded gate stays closed/)
  assert.equal(existsSync(file), false, 'no live file may be resurrected')
})
