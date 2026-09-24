/**
 * F6 回归：App 首帧 durable 未读剪枝的权威 roster 水合门控。
 * F11 收口（无桥形态）：`window.dshChamber.desktopSsh === undefined` 的浏览器/
 * dev 形态没有远程来源，live={local} 即完整权威集合；旧实现里刷新早退且不置
 * 结算位，门恒关、旧 durable 键永不收敛。现在桥面判定（`bridgeVerdict`：探测中
 * pending / 已 expose present / 预算耗尽无桥 absent）作为门的第二维：**有桥但未
 * 结算仍严格关门**，只有确认无桥才视同结算放行。
 * F13/V5-A 两档否决：`registryDegraded`（整文件加载失败）与 `rosterIncomplete`
 * （解析成功但丢弃条目/重复 id）都是「roster ≠ 磁盘真相」——合法行仍安装，但
 * durable 剪枝门在任一为 true 时都不得放行（V5-A 禁止用部分 roster 结算退役）。
 *
 * 背景（写盘丢失）：App 首帧**同步**从 localStorage 载入 read/edge
 * （unread-store）与 notified/pending/outcomes（complete-ledger），而权威远端
 * roster 是异步事实——桥要等 window.dshChamber 暴露，instances_get 还要一次 IPC
 * 往返。未结算前 remoteInstances=[]、servers 只含 local，剪枝 effect 以
 * live={local} 执行四类 durable 剪枝，会把远端来源的 durable 键当退役来源写盘
 * 删除（全部不可恢复）。
 *
 * 双重证据：
 *   ① wiring 源码锁：四类 durable 剪枝都落在
 *      `if (durableUnreadPruneAllowed(remoteRosterSettledRef.current, bridgeVerdict,
 *      registryDegraded, rosterIncomplete))` 块内、各有唯一调用点，effect 依赖含
 *      remoteRosterSettled + bridgeVerdict + 两个否决位（放行判定翻转那一拍重跑），
 *      且该 ref 只在 refreshRemotes 成功结算后置位；无桥判定只在有界探测预算耗尽
 *      后产生，'present'/'pending' 不置 absent。
 *   ② 纯谓词 + 存储假实现：durableUnreadPruneAllowed 的门语义直测；用真实
 *      unread-store / complete-ledger / source-registry 内核复现「未门控首帧」
 *      的写盘丢失，并证明门关时（含一次落盘 + 重载）远端键仍在、结算后（或
 *      无桥形态按 live={local}）才收敛。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { durableUnreadPruneAllowed, healthProbeUnavailableDiagnostic, rosterIncompleteDiagnostic } from '../../src/app-hooks/use-bridge-subscriptions.ts'
import { createCompleteLedger } from '../../src/complete-ledger.ts'
import { LOCAL_INSTANCE_ID } from '../../src/local-instance.ts'
import { pruneSourceRecord } from '../../src/source-registry.ts'
import {
  loadUnread, saveUnread, UNREAD_V2_KEY,
  type UnreadStorageLike, type UnreadV2Payload,
} from '../../src/unread-store.ts'

const APP = readFileSync(fileURLToPath(new URL('../../src/App.tsx', import.meta.url)), 'utf8')

/** 从 marker 起的第一个花括号块（含嵌套；本门控块内字符串/模板无失衡花括号）。 */
function bracedBlockFrom(source: string, marker: string): string {
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, 'missing marker: ' + marker)
  const open = source.indexOf('{', start)
  assert.notEqual(open, -1, 'marker has no block: ' + marker)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  assert.fail('unterminated block for ' + marker)
}

// ── ① wiring 源码锁 ─────────────────────────────────────────────────────────

test('F6 wiring: the four durable unread prunes are all inside the roster-settled gate', () => {
  const gateImport = APP.match(/import \{[^}]*\} from '\.\/app-hooks\/use-bridge-subscriptions\.ts'/)
  assert.ok(gateImport !== null, 'App must import the gate predicate next to the hook')
  assert.ok(gateImport[0].includes('durableUnreadPruneAllowed'), 'the gate predicate comes from the hook module')
  assert.ok(gateImport[0].includes('useBridgeSubscriptions'), 'the bridge subscription hook comes from the same module')
  assert.ok(gateImport[0].includes('DesktopBridgeVerdict'), 'the no-bridge verdict type is imported with the predicate')
  assert.equal(APP.split('durableUnreadPruneAllowed(').length - 1, 1, 'one gate call, one expression')
  const gate = bracedBlockFrom(
    APP,
    'if (durableUnreadPruneAllowed(remoteRosterSettledRef.current, bridgeVerdict, registryDegraded, rosterIncomplete)) {',
  )
  for (const needle of [
    'setCompletedBySource(prev => pruneSourceRecord(prev, live) ?? prev)',
    'completeLedgerRef.current.prune(live)',
    'schedulePersistUnreadRef.current()',
    'pruneSourceRecord(readMarksRef.current, live)',
    'readMarksRef.current = readMarksNext',
    'pruneSourceRecord(edgeLedgerRef.current, live)',
    'edgeLedgerRef.current = edgeLedgerNext',
  ]) {
    assert.ok(gate.includes(needle), 'the roster gate must contain: ' + needle)
  }
  // 唯一调用点：门控外不得残留未受门的第二份剪枝（否则源码锁被绕过）。
  assert.equal(APP.split('setCompletedBySource(prev => pruneSourceRecord(prev, live) ?? prev)').length - 1, 1)
  assert.equal(APP.split('completeLedgerRef.current.prune(').length - 1, 1)
  assert.equal(APP.split('pruneSourceRecord(readMarksRef.current, live)').length - 1, 1)
  assert.equal(APP.split('pruneSourceRecord(edgeLedgerRef.current, live)').length - 1, 1)
  // 放行判定翻转那一拍必须重跑 effect：ref 只供同一次执行读，state 才是重跑信号。
  assert.ok(
    APP.includes('}, [servers, mountedViews, remoteRosterSettled, bridgeVerdict, registryDegraded, rosterIncomplete])'),
    'the prune effect must depend on remoteRosterSettled, the no-bridge verdict AND both veto bits (degraded + incomplete)',
  )
})

test('F11 wiring: the no-bridge verdict comes only from the bounded probe budget', () => {
  // 形态状态：初值 'pending'（首帧桥必缺席，不能断言无桥）。
  assert.ok(
    APP.includes("const [bridgeVerdict, setBridgeVerdict] = useState<DesktopBridgeVerdict>('pending')"),
    'the verdict starts pending (first frame cannot distinguish a late bridge from no bridge)',
  )
  // 看到 desktopSsh：置 present（有桥 ⇒ 门重新交给 roster 结算）。
  assert.equal(APP.split("setBridgeVerdict('present')").length - 1, 1)
  assert.equal(APP.split('attempts >= BRIDGE_ABSENT_PROBE_LIMIT').length - 1, 1, 'absent only at the bounded budget')
  assert.equal(APP.split("prev === 'present' ? prev : 'absent'").length - 1, 1, 'a seen bridge can never regress to absent')
  // 预算常量：探测节奏与预算都存在（absent 不得由单帧缺席直接产生）。
  assert.match(APP, /const BRIDGE_PROBE_MS = \d+/)
  assert.match(APP, /const BRIDGE_ABSENT_PROBE_LIMIT = \d+/)
  // 无桥判定不得顺手改权威结算位：preload 迟到的窗口仍走标准 roster 水合。
  assert.equal(APP.split('setRemoteRosterSettled(true)').length - 1, 1, 'only the authoritative pull settles the roster')
  assert.equal(APP.split('setBridgeVerdict').length - 1, 3, 'pending init + present + absent transitions only')
})

test('F6 wiring: the settled ref flips only on a successful authoritative roster pull', () => {
  assert.equal(APP.split('remoteRosterSettledRef.current = true').length - 1, 1)
  assert.equal(APP.split('remoteRosterSettledRef.current = false').length - 1, 1)
  const pull = APP.indexOf('const instances = await ssh.instances_get()')
  const settle = APP.indexOf('remoteRosterSettledRef.current = true')
  const install = APP.indexOf('setRemoteInstances(acceptedSpecs)')
  assert.notEqual(pull, -1, 'the authoritative pull must exist')
  assert.notEqual(settle, -1, 'the settle flip must exist')
  assert.notEqual(install, -1, 'the roster install must exist')
  assert.ok(settle > pull, 'settled flips only AFTER the authoritative pull resolves (a rejection leaves it false)')
  assert.ok(install > settle, 'the ref and the React roster state settle in the same successful path')
  // 失效路径同步清 ref：结算前的每一次渲染都必须看到门关。
  assert.ok(APP.includes('invalidateRemoteRoster'), 'the instances-changed invalidation path must exist')
})

// ── ② 纯谓词 + 存储假实现 ────────────────────────────────────────────────────

const REMOTE_SOURCE = 'dsh-remote-a'

function seededPayload(): UnreadV2Payload {
  return {
    v: 2,
    read: {
      [LOCAL_INSTANCE_ID]: { localSession: 10 },
      [REMOTE_SOURCE]: { remoteSession: 20 },
    },
    edge: {
      [LOCAL_INSTANCE_ID]: { localSession: true },
      [REMOTE_SOURCE]: { remoteSession: true },
    },
    notified: {
      [LOCAL_INSTANCE_ID]: { localSession: { complete: 10 } },
      [REMOTE_SOURCE]: { remoteSession: { complete: 20 } },
    },
    pending: { [REMOTE_SOURCE]: { remoteSession: { at: 1_000, watermark: 20 } } },
    outcomes: { [REMOTE_SOURCE]: { goalA: 20 } },
  }
}

interface FakeStorage extends UnreadStorageLike {
  read(): string
}

/** v2 落盘的内存假实现（App 的 localStorage 面）。 */
function createFakeStorage(): FakeStorage {
  const map = new Map<string, string>()
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
    read: () => map.get(UNREAD_V2_KEY) ?? '',
  }
}

/** 首帧载入形状（App L1108–L1133）：read/edge + 三张 durable 表 + live={local}。 */
function loadFirstFrame(storage: FakeStorage) {
  const loaded = loadUnread(storage)
  return {
    loaded,
    readMarks: { ...loaded.read } as Record<string, Record<string, number>>,
    edgeLedger: { ...loaded.edge } as Record<string, Record<string, boolean>>,
    completedBySource: { ...loaded.edge } as Record<string, Record<string, boolean>>,
    ledger: createCompleteLedger(loaded.notified, {
      pending: loaded.pending,
      outcomes: loaded.outcomes,
      now: 2_000,
    }),
    live: new Set([LOCAL_INSTANCE_ID]) as ReadonlySet<string>,
  }
}

function persistFrame(
  storage: FakeStorage,
  frame: ReturnType<typeof loadFirstFrame>,
): void {
  saveUnread(storage, {
    v: 2,
    read: frame.readMarks,
    edge: frame.edgeLedger,
    notified: frame.ledger.notifiedTable(),
    pending: frame.ledger.pendingTable(),
    outcomes: frame.ledger.outcomesTable(),
  })
}

function assertRemoteDurableKeysPresent(payload: UnreadV2Payload, label: string): void {
  assert.notEqual(payload.read[REMOTE_SOURCE], undefined, label + ': read')
  assert.notEqual(payload.edge[REMOTE_SOURCE], undefined, label + ': edge')
  assert.notEqual(payload.notified[REMOTE_SOURCE], undefined, label + ': notified')
  assert.notEqual(payload.pending?.[REMOTE_SOURCE], undefined, label + ': pending')
  assert.notEqual(payload.outcomes?.[REMOTE_SOURCE], undefined, label + ': outcomes')
}

test('F6 pure: the gate is closed until the authoritative roster settles', () => {
  // 缺省 bridgeVerdict 保持旧语义（等价 'present'：假定有桥，只看结算位）。
  assert.equal(durableUnreadPruneAllowed(false), false)
  assert.equal(durableUnreadPruneAllowed(true), true)
  assert.equal(durableUnreadPruneAllowed(false, 'present'), false)
  assert.equal(durableUnreadPruneAllowed(true, 'present'), true)
})

test('F11 pure: a closed roster prunes only in the confirmed no-bridge shape', () => {
  // 探测中（桥可能迟到）→ 保守关门；已结算则 live 必然完整，照常放行。
  assert.equal(durableUnreadPruneAllowed(false, 'pending'), false)
  assert.equal(durableUnreadPruneAllowed(true, 'pending'), true, 'a settled roster is live-complete regardless of the probe')
  // 确认无桥 → 没有远程来源，live={local} 安全，视同结算放行收敛。
  assert.equal(durableUnreadPruneAllowed(false, 'absent'), true)
  assert.equal(durableUnreadPruneAllowed(true, 'absent'), true)
})

test('F6 storage fake: the gated first frame writes back every remote durable key intact', () => {
  const storage = createFakeStorage()
  storage.setItem(UNREAD_V2_KEY, JSON.stringify(seededPayload()))
  const frame = loadFirstFrame(storage)

  // 首帧：权威 roster 未结算 → 四类剪枝整段跳过；即便此刻因其它写点落盘一次，
  // 内存表完整 ⇒ 磁盘完整。
  assert.equal(durableUnreadPruneAllowed(false), false)
  persistFrame(storage, frame)

  const persisted = JSON.parse(storage.read()) as UnreadV2Payload
  assertRemoteDurableKeysPresent(persisted, 'the closed gate must keep disk keys')
  // 内存权威（App 的 refs/state）同样一格不少。
  assert.notEqual(frame.readMarks[REMOTE_SOURCE], undefined, 'in-memory read ledger keeps the remote row')
  assert.notEqual(frame.edgeLedger[REMOTE_SOURCE], undefined, 'in-memory edge ledger keeps the remote row')
  assert.notEqual(frame.completedBySource[REMOTE_SOURCE], undefined, 'in-memory completedBySource keeps the remote row')
  assert.notEqual(frame.ledger.pendingEntry(REMOTE_SOURCE, 'remoteSession'), undefined, 'ledger pending keeps the remote row')
  assert.equal(frame.ledger.notifiedWatermark(REMOTE_SOURCE, 'remoteSession', 'complete'), 20)
  assert.equal(frame.ledger.outcomeWatermark(REMOTE_SOURCE, 'goalA'), 20)
  // 重载（崩溃/重启路径）仍恢复远端键：门关时的写盘不丢任何一类。
  assertRemoteDurableKeysPresent(loadUnread(storage), 'a reload after the closed-gate flush')

  // 结算后（同一 live：权威 roster 里确实没有该来源）才允许收敛。
  assert.equal(durableUnreadPruneAllowed(true), true)
  frame.completedBySource = pruneSourceRecord(frame.completedBySource, frame.live) ?? frame.completedBySource
  frame.ledger.prune(frame.live)
  frame.readMarks = pruneSourceRecord(frame.readMarks, frame.live) ?? frame.readMarks
  frame.edgeLedger = pruneSourceRecord(frame.edgeLedger, frame.live) ?? frame.edgeLedger
  persistFrame(storage, frame)

  const settled = JSON.parse(storage.read()) as UnreadV2Payload
  assert.equal(settled.read[REMOTE_SOURCE], undefined, 'settled: read pruned')
  assert.equal(settled.edge[REMOTE_SOURCE], undefined, 'settled: edge pruned')
  assert.equal(settled.notified[REMOTE_SOURCE], undefined, 'settled: notified pruned')
  assert.equal(settled.pending?.[REMOTE_SOURCE], undefined, 'settled: pending pruned')
  assert.equal(settled.outcomes?.[REMOTE_SOURCE], undefined, 'settled: outcomes pruned')
  assert.notEqual(settled.read[LOCAL_INSTANCE_ID], undefined, 'local survives both phases')
  assert.notEqual(settled.edge[LOCAL_INSTANCE_ID], undefined, 'local edge survives both phases')
})

test('F11 storage fake: the no-bridge verdict converges stale remote keys to live={local}', () => {
  const storage = createFakeStorage()
  storage.setItem(UNREAD_V2_KEY, JSON.stringify(seededPayload()))
  const frame = loadFirstFrame(storage)

  // 有桥但未结算：F6 门仍关，落盘一次也不得丢远端键。
  assert.equal(durableUnreadPruneAllowed(false, 'present'), false)
  persistFrame(storage, frame)
  assertRemoteDurableKeysPresent(JSON.parse(storage.read()) as UnreadV2Payload, 'present+unsettled keeps disk keys')

  // 探测预算耗尽判无桥：本形态没有远程来源，live={local} 即权威集合，
  // 四类 disk-seeded 剪枝收敛（旧实现门恒关，这些键永不收敛）。
  assert.equal(durableUnreadPruneAllowed(false, 'absent'), true)
  frame.completedBySource = pruneSourceRecord(frame.completedBySource, frame.live) ?? frame.completedBySource
  frame.ledger.prune(frame.live)
  frame.readMarks = pruneSourceRecord(frame.readMarks, frame.live) ?? frame.readMarks
  frame.edgeLedger = pruneSourceRecord(frame.edgeLedger, frame.live) ?? frame.edgeLedger
  persistFrame(storage, frame)

  const converged = JSON.parse(storage.read()) as UnreadV2Payload
  assert.equal(converged.read[REMOTE_SOURCE], undefined, 'no-bridge: read converges')
  assert.equal(converged.edge[REMOTE_SOURCE], undefined, 'no-bridge: edge converges')
  assert.equal(converged.notified[REMOTE_SOURCE], undefined, 'no-bridge: notified converges')
  assert.equal(converged.pending?.[REMOTE_SOURCE], undefined, 'no-bridge: pending converges')
  assert.equal(converged.outcomes?.[REMOTE_SOURCE], undefined, 'no-bridge: outcomes converges')
  assert.notEqual(converged.read[LOCAL_INSTANCE_ID], undefined, 'local survives the no-bridge convergence')
  assert.notEqual(converged.edge[LOCAL_INSTANCE_ID], undefined, 'local edge survives the no-bridge convergence')
})

test('F13 wiring: the registry-degraded probe gates the settle, recovers, and warns once', () => {
  // state 与 warn-once ref 存在（degraded 位是剪枝 effect 的重跑依赖）。
  assert.ok(
    APP.includes('const [registryDegraded, setRegistryDegraded] = useState(false)'),
    'the degraded bit must be React state (effect re-runs when it flips)',
  )
  assert.equal(APP.split('registryDegradedWarnedRef').length - 1, 3, 'one warn-once ref: declaration + guard + write')
  // 健康探针必须存在且先于权威 roster 读取（空 roster 在被信任之前先看健康位）。
  assert.equal(APP.split('await ssh.instances_health()').length - 1, 1, 'one health probe in refreshRemotes')
  const health = APP.indexOf('await ssh.instances_health()')
  const pull = APP.indexOf('const instances = await ssh.instances_get()')
  assert.ok(health !== -1 && pull !== -1 && health < pull, 'the health probe must precede the roster pull')
  const healthToPull = APP.slice(health, pull)
  // degraded：不安装 roster、不结算、置 state + warn（按 reason 去重 = 只喊一次）。
  assert.ok(healthToPull.includes('if (health.degraded === true)'), 'the degraded branch must exist')
  assert.ok(healthToPull.includes('setRegistryDegraded(true)'), 'degraded must raise the gate bit')
  assert.ok(healthToPull.includes('registryDegradedWarnedRef.current !== reason'), 'the warning must be once per reason')
  assert.ok(healthToPull.includes('console.warn('), 'degraded must warn a diagnosable reason')
  assert.ok(healthToPull.includes('return false'), 'degraded must return unsettled')
  assert.ok(!healthToPull.includes('setRemoteRosterSettled(true)'), 'degraded must never settle the roster')
  assert.ok(!healthToPull.includes('setRemoteInstances('), 'degraded must never install the empty roster')
  // 健康：清位后走原有结算路径（settle 仍在成功 pull 之后，见 F6 测试）。
  assert.ok(APP.includes('setRegistryDegraded(false)'), 'a healthy probe clears the gate bit')
  assert.equal(APP.split('setRegistryDegraded(false)').length - 1, 1)
  assert.equal(APP.split('setRegistryDegraded(true)').length - 1, 1)
})

test('F13 pure: the gate never opens while the registry is degraded', () => {
  // degraded 优先：空/缺行 roster 任何组合都不得剪枝（含无桥形态与陈旧的结算位）。
  assert.equal(durableUnreadPruneAllowed(false, 'present', true), false)
  assert.equal(durableUnreadPruneAllowed(false, 'pending', true), false)
  assert.equal(durableUnreadPruneAllowed(false, 'absent', true), false, 'degraded overrides even the no-bridge shape')
  assert.equal(durableUnreadPruneAllowed(true, 'present', true), false, 'degraded wins over a stale settle bit')
  // 健康（缺省 false）保持既有语义：只有结算或无桥才放行。
  assert.equal(durableUnreadPruneAllowed(false, 'present', false), false)
  assert.equal(durableUnreadPruneAllowed(true, 'present', false), true)
  assert.equal(durableUnreadPruneAllowed(false, 'absent', false), true)
  assert.equal(durableUnreadPruneAllowed(false), false, 'the default stays the old present+unsettled shape')
})

test('F13 storage fake: a degraded registry keeps every remote durable key across a reload', () => {
  const storage = createFakeStorage()
  storage.setItem(UNREAD_V2_KEY, JSON.stringify(seededPayload()))
  const frame = loadFirstFrame(storage)

  // 损坏注册表 → 空 roster；degraded 门关：即便此刻落盘一次，四类远端键完整。
  assert.equal(durableUnreadPruneAllowed(false, 'present', true), false)
  persistFrame(storage, frame)
  assertRemoteDurableKeysPresent(JSON.parse(storage.read()) as UnreadV2Payload, 'the degraded registry must keep disk keys')
  // 崩溃/重启重载（仍降级）：远端 durable 键一格不少。
  assertRemoteDurableKeysPresent(loadUnread(storage), 'a reload while degraded restores every remote key')

  // 健康恢复（saveInstances 重建注册表 → health=false）后按权威 roster 收敛。
  assert.equal(durableUnreadPruneAllowed(false, 'present', false), false, 'unsettled after recovery still waits')
  assert.equal(durableUnreadPruneAllowed(true, 'present', false), true, 'the healthy authoritative roster settles')
  frame.completedBySource = pruneSourceRecord(frame.completedBySource, frame.live) ?? frame.completedBySource
  frame.ledger.prune(frame.live)
  frame.readMarks = pruneSourceRecord(frame.readMarks, frame.live) ?? frame.readMarks
  frame.edgeLedger = pruneSourceRecord(frame.edgeLedger, frame.live) ?? frame.edgeLedger
  persistFrame(storage, frame)

  const settled = JSON.parse(storage.read()) as UnreadV2Payload
  assert.equal(settled.read[REMOTE_SOURCE], undefined, 'recovered + settled: read pruned')
  assert.equal(settled.edge[REMOTE_SOURCE], undefined, 'recovered + settled: edge pruned')
  assert.equal(settled.notified[REMOTE_SOURCE], undefined, 'recovered + settled: notified pruned')
  assert.equal(settled.pending?.[REMOTE_SOURCE], undefined, 'recovered + settled: pending pruned')
  assert.equal(settled.outcomes?.[REMOTE_SOURCE], undefined, 'recovered + settled: outcomes pruned')
  assert.notEqual(settled.read[LOCAL_INSTANCE_ID], undefined, 'local survives both phases')
})

test('V5-A wiring: an incomplete health answer still installs the legal rows and warns once (diagnostic single-source)', () => {
  // 行级丢弃（rosterIncomplete）不是「不结算」：合法行照常安装（连接不能不可
  // 见），剪枝门由第四维否决。源码锁保证 warn 分支既不 return 也不碰结算位。
  const probe = APP.indexOf('await ssh.instances_health()')
  const decide = APP.indexOf('const incomplete = health.rosterIncomplete === true')
  const branch = bracedBlockFrom(APP, 'if (incomplete) {')
  const setFlag = APP.indexOf('setRosterIncomplete(incomplete)')
  const pull = APP.indexOf('const instances = await ssh.instances_get()')
  const install = APP.indexOf('setRemoteInstances(acceptedSpecs)')
  assert.ok(probe !== -1 && decide !== -1 && pull !== -1 && install !== -1, 'the incomplete branch and install path must exist')
  assert.ok(decide > probe, 'the incomplete bit is decided from the health probe, before the roster pull')
  assert.ok(setFlag > decide, 'the React state records the health answer')
  assert.ok(pull > setFlag && install > pull, 'the install path still runs AFTER the incomplete branch (no short-circuit)')
  assert.ok(branch.includes('rosterIncompleteDiagnostic(health.droppedCount ?? 0)'), 'the warning reads the single-source diagnostic')
  assert.ok(branch.includes('console.warn('), 'incomplete must warn a diagnosable reason')
  assert.ok(branch.includes('rosterIncompleteWarnedRef.current !== diagnostic'), 'the warning must be once per diagnostic (30s poll must not spam)')
  assert.ok(!branch.includes('return'), 'incomplete must NOT short-circuit — legal rows must still install')
  assert.ok(!branch.includes('setRemoteRosterSettled'), 'settlement is not decided in the warn branch')
  assert.ok(!branch.includes('setRemoteInstances('), 'roster installation belongs to the shared path, not the warn branch')
  // state 是剪枝 effect 的重跑依赖；warn-once ref 一个，声明 + 守卫 + 写入。
  assert.ok(
    APP.includes('const [rosterIncomplete, setRosterIncomplete] = useState(false)'),
    'the incomplete bit must be React state (effect re-runs when it flips)',
  )
  assert.equal(APP.split('rosterIncompleteWarnedRef').length - 1, 3, 'one warn-once ref: declaration + guard + write')
  assert.equal(APP.split('await ssh.instances_health()').length - 1, 1, 'still one health probe per pull')
})

test('V5-A pure: an incomplete roster vetoes pruning at the degraded rank', () => {
  // 结算位/桥面判定成立也照样否决：行级丢弃时 roster 只是磁盘内容的子集。
  assert.equal(durableUnreadPruneAllowed(true, 'present', false, true), false, 'incomplete wins over a settled roster')
  assert.equal(durableUnreadPruneAllowed(false, 'pending', false, true), false)
  assert.equal(durableUnreadPruneAllowed(false, 'absent', false, true), false, 'incomplete overrides even the no-bridge shape')
  assert.equal(durableUnreadPruneAllowed(true, 'absent', false, true), false)
  // 两档同真：按未知处理，仍否决。
  assert.equal(durableUnreadPruneAllowed(true, 'present', true, true), false)
  // 恢复完整（false）后回到既有真值表。
  assert.equal(durableUnreadPruneAllowed(true, 'present', false, false), true)
  assert.equal(durableUnreadPruneAllowed(false, 'absent', false, false), true)
  assert.equal(durableUnreadPruneAllowed(false, 'present', false, false), false)
  assert.equal(durableUnreadPruneAllowed(false), false, 'the default keeps the old present+unsettled shape')
})

test('V5-A pure: the roster-incomplete diagnostic is single-source and distinct from degraded', () => {
  const diagnostic = rosterIncompleteDiagnostic(3)
  assert.match(diagnostic, /roster incomplete/)
  assert.match(diagnostic, /3 persisted instance row/)
  assert.match(diagnostic, /invalid or duplicate/)
  assert.equal(diagnostic, rosterIncompleteDiagnostic(3), 'deterministic: the warn-once dedupe reads this text')
  assert.notEqual(diagnostic, rosterIncompleteDiagnostic(0), 'a different drop count is a different diagnostic')
  assert.doesNotMatch(diagnostic, /degraded/, 'an incomplete roster is not folded into the degraded diagnostic')
  assert.match(healthProbeUnavailableDiagnostic('missing-method'), /health unavailable/)
})

test('V5-A wiring: the incomplete bit comes only from the health probe and clears on a complete answer', () => {
  // 唯一写点：探针分支里的 setRosterIncomplete(incomplete)（state 初值 false）。
  assert.equal(APP.split('setRosterIncomplete(').length - 1, 1, 'one writer for the incomplete bit')
  // 健康（缺省/完整）应答把位清零：refreshRemotes 的同一分支无条件写入。
  const branch = APP.slice(
    APP.indexOf('const incomplete = health.rosterIncomplete === true'),
    APP.indexOf('const instances = await ssh.instances_get()'),
  )
  assert.ok(branch.includes('health.rosterIncomplete === true'), 'only an explicit true flips the bit on')
  assert.ok(branch.includes('setRosterIncomplete(incomplete)'), 'the same expression clears it when complete again')
  // 降级分支不安装 roster，也不得借道 incomplete 位（两个否决位保持独立来源）。
  const degraded = APP.slice(
    APP.indexOf('if (health.degraded === true)'),
    APP.indexOf('setRegistryDegraded(false)'),
  )
  assert.ok(!degraded.includes('setRosterIncomplete('), 'the degraded branch must not touch the incomplete bit')
})

test('V5-A storage fake: an incomplete roster keeps every remote durable key across a reload, then converges when complete', () => {
  const storage = createFakeStorage()
  storage.setItem(UNREAD_V2_KEY, JSON.stringify(seededPayload()))
  const frame = loadFirstFrame(storage)

  // 行级丢弃 ⇒ rosterIncomplete（即便已结算）：四类 durable 剪枝整段跳过，
  // 落盘一次远端键完整，崩溃/重启重载仍一格不少。
  assert.equal(durableUnreadPruneAllowed(true, 'present', false, true), false)
  persistFrame(storage, frame)
  assertRemoteDurableKeysPresent(JSON.parse(storage.read()) as UnreadV2Payload, 'an incomplete roster must keep disk keys')
  assertRemoteDurableKeysPresent(loadUnread(storage), 'a reload while incomplete restores every remote key')

  // 恢复完整（无丢弃 load / authoritative 保存 → health=false）后按权威
  // roster 结算收敛。
  assert.equal(durableUnreadPruneAllowed(true, 'present', false, false), true)
  frame.completedBySource = pruneSourceRecord(frame.completedBySource, frame.live) ?? frame.completedBySource
  frame.ledger.prune(frame.live)
  frame.readMarks = pruneSourceRecord(frame.readMarks, frame.live) ?? frame.readMarks
  frame.edgeLedger = pruneSourceRecord(frame.edgeLedger, frame.live) ?? frame.edgeLedger
  persistFrame(storage, frame)

  const settled = JSON.parse(storage.read()) as UnreadV2Payload
  assert.equal(settled.read[REMOTE_SOURCE], undefined, 'complete + settled: read pruned')
  assert.equal(settled.edge[REMOTE_SOURCE], undefined, 'complete + settled: edge pruned')
  assert.equal(settled.notified[REMOTE_SOURCE], undefined, 'complete + settled: notified pruned')
  assert.equal(settled.pending?.[REMOTE_SOURCE], undefined, 'complete + settled: pending pruned')
  assert.equal(settled.outcomes?.[REMOTE_SOURCE], undefined, 'complete + settled: outcomes pruned')
  assert.notEqual(settled.read[LOCAL_INSTANCE_ID], undefined, 'local survives both phases')
})

test('F16 wiring: an unavailable health probe is diagnosed and never settles the roster', () => {
  // 缺失方法 / invoke 抛错都不得折叠成「健康」：两分支都在探针前/探针处
  // fail-closed（不安装 roster、不置结算位、不动 degraded 位）。
  const guard = APP.indexOf("if (typeof ssh.instances_health !== 'function')")
  const probe = APP.indexOf('await ssh.instances_health()')
  const seqAfterProbe = APP.indexOf('if (remoteRosterRefreshSeqRef.current !== seq) return false', probe)
  assert.notEqual(guard, -1, 'the missing-method guard must exist')
  assert.notEqual(probe, -1, 'the health probe must exist')
  assert.notEqual(seqAfterProbe, -1, 'the post-probe sequence check must exist')
  assert.ok(guard < probe, 'the missing-method guard must precede the probe')
  const unavailable = APP.slice(guard, seqAfterProbe)
  assert.ok(unavailable.includes("warnHealthProbeUnavailable('missing-method')"), 'a missing method warns specifically')
  assert.ok(unavailable.includes("warnHealthProbeUnavailable('invoke-failed')"), 'a rejected invoke warns specifically')
  assert.ok(unavailable.includes('try {') && unavailable.includes('catch {'), 'the probe has its own catch')
  assert.ok(!unavailable.includes('setRemoteRosterSettled(true)'), 'unavailable must never settle the roster')
  assert.ok(!unavailable.includes('setRemoteInstances('), 'unavailable must never install a roster')
  assert.ok(!unavailable.includes('setRegistryDegraded('), 'unavailable is not "registry degraded" — it must not flip that bit either')
  // warn-once：一个 ref，声明 + 守卫 + 写入。
  assert.equal(APP.split('healthUnavailableWarnedRef').length - 1, 3, 'one warn-once ref: declaration + guard + write')
  // 诊断文案单源（实现读取纯函数，不复制字面量）。
  assert.ok(APP.includes('healthProbeUnavailableDiagnostic(kind)'), 'the warn callback must use the single-source diagnostic')
})

test('F16 pure: unavailable health diagnostics distinguish a missing method from a rejected invoke', () => {
  const missing = healthProbeUnavailableDiagnostic('missing-method')
  const failed = healthProbeUnavailableDiagnostic('invoke-failed')
  assert.match(missing, /health unavailable/)
  assert.match(failed, /health unavailable/)
  assert.match(missing, /not exposed/, 'the missing method names the old bridge shape')
  assert.match(failed, /rejected/, 'the rejected probe names the invoke failure')
  assert.notEqual(missing, failed, 'the two unavailability shapes stay separately diagnosable')
  assert.doesNotMatch(missing, /degraded/, 'an unavailable probe is never reported as a degraded registry')
  assert.doesNotMatch(failed, /degraded/, 'an unavailable probe is never reported as a degraded registry')
})

test('F6 storage fake: the ungated first frame is the documented disk-loss regression', () => {
  const storage = createFakeStorage()
  storage.setItem(UNREAD_V2_KEY, JSON.stringify(seededPayload()))
  const frame = loadFirstFrame(storage)

  // 修复前形状：首帧无条件按 live={local} 剪枝 + schedulePersistUnread 落盘。
  frame.completedBySource = pruneSourceRecord(frame.completedBySource, frame.live) ?? frame.completedBySource
  frame.ledger.prune(frame.live)
  frame.readMarks = pruneSourceRecord(frame.readMarks, frame.live) ?? frame.readMarks
  frame.edgeLedger = pruneSourceRecord(frame.edgeLedger, frame.live) ?? frame.edgeLedger
  persistFrame(storage, frame)

  const persisted = JSON.parse(storage.read()) as UnreadV2Payload
  assert.equal(persisted.read[REMOTE_SOURCE], undefined)
  assert.equal(persisted.edge[REMOTE_SOURCE], undefined)
  assert.equal(persisted.notified[REMOTE_SOURCE], undefined)
  assert.equal(persisted.pending?.[REMOTE_SOURCE], undefined)
  assert.equal(persisted.outcomes?.[REMOTE_SOURCE], undefined)
})
