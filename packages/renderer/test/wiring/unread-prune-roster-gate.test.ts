/**
 * F6 回归：App 首帧 durable 剪枝的权威 roster 水合门控。
 * F11 收口（无桥形态）：`window.dshChamber.desktopSsh === undefined` 的浏览器/
 * dev 形态没有远程来源，live={local} 即完整权威集合；旧实现里刷新早退且不置
 * 结算位，门恒关、旧 durable 键永不收敛。现在桥面判定（`bridgeVerdict`：探测中
 * pending / 已 expose present / 预算耗尽无桥 absent）作为门的第二维：**有桥但未
 * 结算仍严格关门**，只有确认无桥才视同结算放行。
 * F13/V5-A 两档否决：`registryDegraded`（整文件加载失败）与 `rosterIncomplete`
 * （解析成功但丢弃条目/重复 id）都是「roster ≠ 磁盘真相」——合法行仍安装，但
 * durable 剪枝门在任一为 true 时都不得放行（V5-A 禁止用部分 roster 结算退役）。
 *
 * 背景（写盘丢失）：App 首帧**同步**从 localStorage 载入通知三表
 * （notifications.v1：notifiedRuns/pending/outcomes），而权威远端 roster 是异步
 * 事实——桥要等 window.dshChamber 暴露，instances_get 还要一次 IPC 往返。未结算前
 * remoteInstances=[]、servers 只含 local，剪枝 effect 以 live={local} 执行 durable
 * 剪枝，会把远端来源的 durable 键当退役来源写盘删除（全部不可恢复）。
 * 完成未读的旧持久面（read 水位 / edge 账本 / v5 影子）已整体退役：官方
 * uiSession.sessionStatus.completionUnread 是唯一权威，App 只补一条内存修正臂。
 *
 * 本文件另承载 design 19 §3.7 的两组新增锁（原 §3.7.1 已并入）：事实健康环（recorder 本体 + 采样接线）与
 * 完成修正臂的接线顺序锁（唯一实体、重入闸、never-throw 出口）。它们与
 * F6/F11/F13/V5-A 同属「durable 通知/诊断接线」面，故未另开文件。
 *
 * 双重证据：
 *   ① wiring 源码锁：durable 剪枝都落在
 *      `if (durableUnreadPruneAllowed(rosterGate.isSettled(), bridgeVerdict,
 *      registryDegraded, rosterIncomplete))` 块内、各有唯一调用点，effect 依赖含
 *      roster + bridgeVerdict + 两个否决位（放行判定翻转那一拍重跑），
 *      且 rosterGate 只在 refreshRemotes 成功 pull 后 settle；无桥判定只在有界探测
 *      预算耗尽后产生，'present'/'pending' 不置 absent。
 *   ② 纯谓词 + 存储假实现：durableUnreadPruneAllowed 的门语义直测；用真实
 *      notification-store / complete-ledger / notification-outbox / source-registry
 *      内核复现「未门控首帧」的写盘丢失，并证明门关时（含一次落盘 + 重载）远端键仍在、
 *      结算后（或无桥形态按 live={local}）才收敛。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import { durableUnreadPruneAllowed, healthProbeUnavailableDiagnostic, rosterIncompleteDiagnostic } from '../../src/app-hooks/use-bridge-subscriptions.ts'
import { createCompleteLedger } from '../../src/complete-ledger.ts'
import { AUTHORITY_LOG_KEY } from '@dsh-chamber/dsh-chamber-client-core/authority-log-store'
import { createFactsHealthRecorder, createFactsStepGuard, type FactsHealthSample } from '../../src/facts-health.ts'
import { LOCAL_INSTANCE_ID } from '../../src/local-instance.ts'
import {
  NOTIFICATIONS_V1_KEY, loadNotifications, saveNotifications,
  type NotificationPayload, type NotificationStorageLike,
} from '../../src/notification-store.ts'
import { NOTIFICATION_OUTBOX_KEY, createNotificationOutbox } from '../../src/notification-outbox.ts'

const APP = readFileSync(fileURLToPath(new URL('../../src/App.tsx', import.meta.url)), 'utf8')

/** 从 marker 起的第一个花括号块（含嵌套）。先 stripComments：注释文本里的花括号
 *  不得参与深度计数（按既有惯例共享实现仍保留字符串/模板字面量；S6 收尾修正）。 */
function bracedBlockFrom(source: string, marker: string): string {
  const text = stripComments(source)
  const start = text.indexOf(marker)
  assert.notEqual(start, -1, 'missing marker: ' + marker)
  const open = text.indexOf('{', start)
  assert.notEqual(open, -1, 'marker has no block: ' + marker)
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  assert.fail('unterminated block for ' + marker)
}

// ── ① wiring 源码锁 ─────────────────────────────────────────────────────────

test('F6 wiring: the durable notification prunes are all inside the roster-settled gate', () => {
  const importAt = APP.indexOf("from './app-hooks/use-bridge-subscriptions.ts'")
  assert.notEqual(importAt, -1, 'App must import the gate predicate next to the hook')
  const gateImport = APP.slice(APP.lastIndexOf('import {', importAt), importAt)
  assert.ok(gateImport.includes('durableUnreadPruneAllowed'), 'the gate predicate comes from the hook module')
  assert.ok(gateImport.includes('useBridgeSubscriptions'), 'the bridge subscription hook comes from the same module')
  assert.ok(gateImport.includes('DesktopBridgeVerdict'), 'the no-bridge verdict type is imported with the predicate')
  assert.equal(APP.split('durableUnreadPruneAllowed(').length - 1, 1, 'one gate call, one expression')
  // abstract 结构：结算位是 rosterGate（host/roster-gate.ts）的同步 isSettled()，不是 state+ref 对。
  const gate = bracedBlockFrom(
    APP,
    'if (durableUnreadPruneAllowed(rosterGate.isSettled(), bridgeVerdict, registryDegraded, rosterIncomplete)) {',
  )
  for (const needle of [
    'completedStore.prune(live)',
    'completeLedgerRef.current.prune(live)',
    'schedulePersistNotificationsRef.current()',
    'notificationOutboxRef.current.pruneSources(live)',
    'pruneSourceLedger(sourceLedger, live)',
    'pruneSourceRecord(factsStore.getSnapshot().session, live)',
  ]) {
    assert.ok(gate.includes(needle), 'the roster gate must contain: ' + needle)
  }
  // 唯一调用点：门控外不得残留未受门的第二份剪枝（否则源码锁被绕过）。
  assert.equal(APP.split('completedStore.prune(live)').length - 1, 1)
  assert.equal(APP.split('completeLedgerRef.current.prune(').length - 1, 1)
  assert.equal(APP.split('notificationOutboxRef.current.pruneSources(').length - 1, 1)
  assert.equal(APP.split('pruneSourceLedger(sourceLedger, live)').length - 1, 1)
  // 放行判定翻转那一拍必须重跑 effect：isSettled() 只供同一次执行读，roster/state 才是重跑信号。
  assert.ok(
    APP.includes('}, [servers, mountedViews, roster, bridgeVerdict, registryDegraded, rosterIncomplete])'),
    'the prune effect must depend on the roster settle signal, the no-bridge verdict AND both veto bits (degraded + incomplete)',
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
  assert.ok(APP.includes('const BRIDGE_PROBE_MS = '))
  assert.ok(APP.includes('const BRIDGE_ABSENT_PROBE_LIMIT = '))
  // 无桥判定不得顺手改权威结算位：preload 迟到的窗口仍走标准 roster 水合。
  assert.equal(APP.split('rosterGate.settle()').length - 1, 1, 'only the authoritative pull settles the roster')
  assert.equal(APP.split('setBridgeVerdict').length - 1, 3, 'pending init + present + absent transitions only')
})

test('F6 wiring: the roster gate settles only on a successful authoritative roster pull', () => {
  assert.equal(APP.split('rosterGate.settle()').length - 1, 1)
  const pull = APP.indexOf('const instances = await ssh.instances_get()')
  const settle = APP.indexOf('rosterGate.settle()')
  const install = APP.indexOf('remotesStore.setInstances(acceptedSpecs)')
  assert.notEqual(pull, -1, 'the authoritative pull must exist')
  assert.notEqual(settle, -1, 'the settle call must exist')
  assert.notEqual(install, -1, 'the roster install must exist')
  assert.ok(settle > pull, 'the gate settles only AFTER the authoritative pull resolves (a rejection leaves it unsettled)')
  assert.ok(install > pull, 'the roster install happens in the same successful path')
  // 失效路径同步开新代：结算前的每一次渲染都必须看到门关。
  assert.ok(APP.includes('invalidateRemoteRoster'), 'the instances-changed invalidation path must exist')
})

// ── ② 纯谓词 + 存储假实现 ────────────────────────────────────────────────────

const REMOTE_SOURCE = 'dsh-remote-a'

function seededPayload(): NotificationPayload {
  return {
    v: 1,
    notifiedRuns: {
      [LOCAL_INSTANCE_ID]: { localSession: 'host:turn%2F10' },
      [REMOTE_SOURCE]: { remoteSession: 'host:turn%2F20' },
    },
    pending: {
      [LOCAL_INSTANCE_ID]: { localSession: { at: 1_000, watermark: 10 } },
      [REMOTE_SOURCE]: { remoteSession: { at: 1_000, watermark: 20 } },
    },
    outcomes: {
      [LOCAL_INSTANCE_ID]: { goalLocal: 10 },
      [REMOTE_SOURCE]: { goalA: 20 },
    },
  }
}

interface FakeStorage extends NotificationStorageLike {
  read(): string
}

/** notifications.v1 落盘的内存假实现（App 的 localStorage 面）。 */
function createFakeStorage(): FakeStorage {
  const map = new Map<string, string>()
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
    read: () => map.get(NOTIFICATIONS_V1_KEY) ?? '',
  }
}

/** 首帧载入形状：通知三表 + live={local}。 */
function loadFirstFrame(storage: FakeStorage) {
  const loaded = loadNotifications(storage)
  return {
    loaded,
    ledger: createCompleteLedger(loaded.notifiedRuns, {
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
  saveNotifications(storage, {
    v: 1,
    notifiedRuns: frame.ledger.notifiedRunTable(),
    pending: frame.ledger.pendingTable(),
    outcomes: frame.ledger.outcomesTable(),
  })
}

function assertRemoteDurableKeysPresent(payload: NotificationPayload, label: string): void {
  assert.notEqual(payload.notifiedRuns[REMOTE_SOURCE], undefined, label + ': notifiedRuns')
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
  storage.setItem(NOTIFICATIONS_V1_KEY, JSON.stringify(seededPayload()))
  const frame = loadFirstFrame(storage)

  // 首帧：权威 roster 未结算 → durable 剪枝整段跳过；即便此刻因其它写点落盘一次，
  // 内存表完整 ⇒ 磁盘完整。
  assert.equal(durableUnreadPruneAllowed(false), false)
  persistFrame(storage, frame)

  const persisted = JSON.parse(storage.read()) as NotificationPayload
  assertRemoteDurableKeysPresent(persisted, 'the closed gate must keep disk keys')
  // 内存权威（App 的 refs/ledger）同样一格不少。
  assert.notEqual(frame.ledger.pendingEntry(REMOTE_SOURCE, 'remoteSession'), undefined, 'ledger pending keeps the remote row')
  assert.equal(frame.ledger.notifiedRun(REMOTE_SOURCE, 'remoteSession'), 'host:turn%2F20')
  assert.equal(frame.ledger.outcomeWatermark(REMOTE_SOURCE, 'goalA'), 20)
  // 重载（崩溃/重启路径）仍恢复远端键：门关时的写盘不丢任何一类。
  assertRemoteDurableKeysPresent(loadNotifications(storage), 'a reload after the closed-gate flush')

  // 结算后（同一 live：权威 roster 里确实没有该来源）才允许收敛。
  assert.equal(durableUnreadPruneAllowed(true), true)
  frame.ledger.prune(frame.live)
  persistFrame(storage, frame)

  const settled = JSON.parse(storage.read()) as NotificationPayload
  assert.equal(settled.notifiedRuns[REMOTE_SOURCE], undefined, 'settled: notifiedRuns pruned')
  assert.equal(settled.pending?.[REMOTE_SOURCE], undefined, 'settled: pending pruned')
  assert.equal(settled.outcomes?.[REMOTE_SOURCE], undefined, 'settled: outcomes pruned')
  assert.notEqual(settled.notifiedRuns[LOCAL_INSTANCE_ID], undefined, 'local notifiedRuns survives both phases')
  assert.notEqual(settled.pending?.[LOCAL_INSTANCE_ID], undefined, 'local pending survives both phases')
  assert.notEqual(settled.outcomes?.[LOCAL_INSTANCE_ID], undefined, 'local outcomes survives both phases')
})

test('F11 storage fake: the no-bridge verdict converges stale remote keys to live={local}', () => {
  const storage = createFakeStorage()
  storage.setItem(NOTIFICATIONS_V1_KEY, JSON.stringify(seededPayload()))
  const frame = loadFirstFrame(storage)

  // 有桥但未结算：F6 门仍关，落盘一次也不得丢远端键。
  assert.equal(durableUnreadPruneAllowed(false, 'present'), false)
  persistFrame(storage, frame)
  assertRemoteDurableKeysPresent(JSON.parse(storage.read()) as NotificationPayload, 'present+unsettled keeps disk keys')

  // 探测预算耗尽判无桥：本形态没有远程来源，live={local} 即权威集合，
  // durable 剪枝收敛（旧实现门恒关，这些键永不收敛）。
  assert.equal(durableUnreadPruneAllowed(false, 'absent'), true)
  frame.ledger.prune(frame.live)
  persistFrame(storage, frame)

  const converged = JSON.parse(storage.read()) as NotificationPayload
  assert.equal(converged.notifiedRuns[REMOTE_SOURCE], undefined, 'no-bridge: notifiedRuns converges')
  assert.equal(converged.pending?.[REMOTE_SOURCE], undefined, 'no-bridge: pending converges')
  assert.equal(converged.outcomes?.[REMOTE_SOURCE], undefined, 'no-bridge: outcomes converges')
  assert.notEqual(converged.notifiedRuns[LOCAL_INSTANCE_ID], undefined, 'local survives the no-bridge convergence')
})

test('F6 storage fake: the native outbox journal converges through the same gate', () => {
  const storage = createFakeStorage()
  const row = {
    sourceId: REMOTE_SOURCE, sourceFingerprint: 'fp', sessionId: 'remoteSession', kind: 'complete',
    watermark: 20, runId: 'host:turn%2F20', attempts: 0, nextAttemptAt: 0, blocked: false,
  }
  storage.setItem(NOTIFICATION_OUTBOX_KEY, JSON.stringify([row]))

  // 门关：App 的同一门控块内才调用 pruneSources；结算前 journal 一行不动。
  assert.equal(durableUnreadPruneAllowed(false, 'present'), false)
  const outbox = createNotificationOutbox(storage)
  assert.equal(outbox.entries().length, 1, 'the closed gate must keep the remote journal row')

  // 门开（权威 roster 结算、来源确实不在 live 里）：退役来源的 journal 行同拍收敛并落盘。
  assert.equal(durableUnreadPruneAllowed(true, 'present'), true)
  outbox.pruneSources(new Set([LOCAL_INSTANCE_ID]))
  assert.equal(outbox.entries().length, 0, 'the settled roster prunes the retired source from the journal')
  assert.deepEqual(JSON.parse(storage.getItem(NOTIFICATION_OUTBOX_KEY)!), [], 'the journal prune is persisted')
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
  assert.ok(!healthToPull.includes('rosterGate.settle()'), 'degraded must never settle the roster')
  assert.ok(!healthToPull.includes('remotesStore.setInstances('), 'degraded must never install the empty roster')
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
  storage.setItem(NOTIFICATIONS_V1_KEY, JSON.stringify(seededPayload()))
  const frame = loadFirstFrame(storage)

  // 损坏注册表 → 空 roster；degraded 门关：即便此刻落盘一次，远端三表完整。
  assert.equal(durableUnreadPruneAllowed(false, 'present', true), false)
  persistFrame(storage, frame)
  assertRemoteDurableKeysPresent(JSON.parse(storage.read()) as NotificationPayload, 'the degraded registry must keep disk keys')
  // 崩溃/重启重载（仍降级）：远端 durable 键一格不少。
  assertRemoteDurableKeysPresent(loadNotifications(storage), 'a reload while degraded restores every remote key')

  // 健康恢复（saveInstances 重建注册表 → health=false）后按权威 roster 收敛。
  assert.equal(durableUnreadPruneAllowed(false, 'present', false), false, 'unsettled after recovery still waits')
  assert.equal(durableUnreadPruneAllowed(true, 'present', false), true, 'the healthy authoritative roster settles')
  frame.ledger.prune(frame.live)
  persistFrame(storage, frame)

  const settled = JSON.parse(storage.read()) as NotificationPayload
  assert.equal(settled.notifiedRuns[REMOTE_SOURCE], undefined, 'recovered + settled: notifiedRuns pruned')
  assert.equal(settled.pending?.[REMOTE_SOURCE], undefined, 'recovered + settled: pending pruned')
  assert.equal(settled.outcomes?.[REMOTE_SOURCE], undefined, 'recovered + settled: outcomes pruned')
  assert.notEqual(settled.notifiedRuns[LOCAL_INSTANCE_ID], undefined, 'local survives both phases')
})

test('V5-A wiring: an incomplete health answer still installs the legal rows and warns once (diagnostic single-source)', () => {
  // 行级丢弃（rosterIncomplete）不是「不结算」：合法行照常安装（连接不能不可
  // 见），剪枝门由第四维否决。源码锁保证 warn 分支既不 return 也不碰结算位。
  const probe = APP.indexOf('await ssh.instances_health()')
  const decide = APP.indexOf('const incomplete = health.rosterIncomplete === true')
  const branch = bracedBlockFrom(APP, 'if (incomplete) {')
  const setFlag = APP.indexOf('setRosterIncomplete(incomplete)')
  const pull = APP.indexOf('const instances = await ssh.instances_get()')
  const install = APP.indexOf('remotesStore.setInstances(acceptedSpecs)')
  assert.ok(probe !== -1 && decide !== -1 && pull !== -1 && install !== -1, 'the incomplete branch and install path must exist')
  assert.ok(decide > probe, 'the incomplete bit is decided from the health probe, before the roster pull')
  assert.ok(setFlag > decide, 'the React state records the health answer')
  assert.ok(pull > setFlag && install > pull, 'the install path still runs AFTER the incomplete branch (no short-circuit)')
  assert.ok(branch.includes('rosterIncompleteDiagnostic(health.droppedCount ?? 0)'), 'the warning reads the single-source diagnostic')
  assert.ok(branch.includes('console.warn('), 'incomplete must warn a diagnosable reason')
  assert.ok(branch.includes('rosterIncompleteWarnedRef.current !== diagnostic'), 'the warning must be once per diagnostic (30s poll must not spam)')
  assert.ok(!branch.includes('return'), 'incomplete must NOT short-circuit — legal rows must still install')
  assert.ok(!branch.includes('rosterGate.settle'), 'settlement is not decided in the warn branch')
  assert.ok(!branch.includes('remotesStore.setInstances('), 'roster installation belongs to the shared path, not the warn branch')
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
  storage.setItem(NOTIFICATIONS_V1_KEY, JSON.stringify(seededPayload()))
  const frame = loadFirstFrame(storage)

  // 行级丢弃 ⇒ rosterIncomplete（即便已结算）：durable 剪枝整段跳过，
  // 落盘一次远端键完整，崩溃/重启重载仍一格不少。
  assert.equal(durableUnreadPruneAllowed(true, 'present', false, true), false)
  persistFrame(storage, frame)
  assertRemoteDurableKeysPresent(JSON.parse(storage.read()) as NotificationPayload, 'an incomplete roster must keep disk keys')
  assertRemoteDurableKeysPresent(loadNotifications(storage), 'a reload while incomplete restores every remote key')

  // 恢复完整（无丢弃 load / authoritative 保存 → health=false）后按权威
  // roster 结算收敛。
  assert.equal(durableUnreadPruneAllowed(true, 'present', false, false), true)
  frame.ledger.prune(frame.live)
  persistFrame(storage, frame)

  const settled = JSON.parse(storage.read()) as NotificationPayload
  assert.equal(settled.notifiedRuns[REMOTE_SOURCE], undefined, 'complete + settled: notifiedRuns pruned')
  assert.equal(settled.pending?.[REMOTE_SOURCE], undefined, 'complete + settled: pending pruned')
  assert.equal(settled.outcomes?.[REMOTE_SOURCE], undefined, 'complete + settled: outcomes pruned')
  assert.notEqual(settled.notifiedRuns[LOCAL_INSTANCE_ID], undefined, 'local survives both phases')
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
  assert.ok(!unavailable.includes('rosterGate.settle()'), 'unavailable must never settle the roster')
  assert.ok(!unavailable.includes('remotesStore.setInstances('), 'unavailable must never install a roster')
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
  storage.setItem(NOTIFICATIONS_V1_KEY, JSON.stringify(seededPayload()))
  const frame = loadFirstFrame(storage)

  // 修复前形状：首帧无条件按 live={local} 剪枝 + schedulePersistNotifications 落盘。
  frame.ledger.prune(frame.live)
  persistFrame(storage, frame)

  const persisted = JSON.parse(storage.read()) as NotificationPayload
  assert.equal(persisted.notifiedRuns[REMOTE_SOURCE], undefined)
  assert.equal(persisted.pending?.[REMOTE_SOURCE], undefined)
  assert.equal(persisted.outcomes?.[REMOTE_SOURCE], undefined)
})

test('facts-health: one breadcrumb per signature change, never-throw on hostile storage', () => {
  const writes: Array<{ key: string; value: string }> = []
  const storage = { getItem: () => null, setItem: (key: string, value: string) => { writes.push({ key, value }) } }
  let at = 1_000
  const recorder = createFactsHealthRecorder(() => (at += 1), storage)
  const sample: FactsHealthSample = {
    ready: false, staleSince: 5, baselines: 0, baselineFailures: 3, baselineResamples: 1,
    baselineFailureReason: 'session/list: timeout after 5000ms',
    reconnects: 2, socketErrors: 0, rows: 0, lastTrustedBaselineAt: null,
  }
  assert.equal(recorder.record('local', sample), true)
  assert.equal(recorder.record('local', { ...sample }), false, '等价状态只留一条证据，不刷环')
  assert.equal(recorder.record('local', { ...sample, ready: true, staleSince: null }), true,
    '可判性变化必须落新条（读环即可还原时间线）')
  assert.equal(writes.length, 2)
  assert.equal(writes[0]!.key, AUTHORITY_LOG_KEY)
  assert.match(writes[0]!.value, /facts-health/)
  assert.match(writes[0]!.value, /timeout after 5000ms/)
  assert.match(writes[0]!.value, /rows=0/)
  assert.match(writes[1]!.value, /ready=1/)
  // 敌意 storage（getItem/setItem 都抛）：诊断绝不打破账本链。
  const hostile = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('quota') },
  }
  const hostileRecorder = createFactsHealthRecorder(() => 1, hostile)
  assert.equal(hostileRecorder.record('local', sample), true)
  hostileRecorder.error('local', 'boom')
})

test('completion-arm wiring: the arm step is the one gate-protected, never-throw, memory-only entry', () => {
  const hook = readFileSync(
    fileURLToPath(new URL('../../src/app-hooks/use-notifications.ts', import.meta.url)), 'utf8')
  // 唯一实体：读 facts 通道行 + painted，步进 client-core 的纯规则，写唯一 store。
  const step = bracedBlockFrom(hook, 'const stepArmNow = useCallback(')
  assert.ok(step.includes('factsStore.getSnapshot().runtime[sourceId]'), 'the step reads the facts channel row')
  assert.ok(step.includes('virtualRuntimeReport('), 'a no-ctx source falls back to the facts-only projection')
  assert.match(step, /factsOnly:[^,\n]*virtual !== undefined/,
    'facts-only provenance comes from the virtual projection')
  assert.doesNotMatch(step, /factsOnly:[^,\n]*current === undefined/,
    'provenance must never be inferred from current === undefined')
  assert.ok(step.includes('viewStore.getSnapshot().painted === sourceId'), 'reading is the PAINTED fact, not the bridge selection')
  assert.ok(step.includes('stepCompletionArm('), 'the rule body is the client-core pure step (no second ledger)')
  assert.ok(step.includes('if (!next.changed) return'), 'an equal step is silent')
  assert.ok(step.includes('completedStore.setSource(sourceId, next.arms)'), 'the step writes the one completed store')
  // 重入闸（React #185）：实体只经 createStepGate 补跑，公开入口是 request。
  assert.ok(hook.includes('createStepGate(sourceId => { stepArmGuardedRef.current(sourceId) })'),
    'the rename-detected step gate must wrap the arm entity')
  const entry = bracedBlockFrom(hook, 'const stepCompletionArmFor = useCallback(')
  assert.ok(entry.includes('stepGateRef.current?.request(sourceId)'),
    'the public entry must go through the re-entrancy gate, never call the entity synchronously')
  // never-throw 出口：异常落环 + loud 一次，控制流交给调用方（同 reconcile/apply）。
  assert.ok(hook.includes("factsStepGuard.guard(sourceId, 'completion-arm', () => stepArmNow(sourceId))"),
    'the arm step keeps the one never-throw wrapper')
  // 纯内存：修正臂绝不落盘、绝不从盘播种；官方位只在通道行上。
  assert.ok(!hook.includes('seed('), 'no disk seed may come back')
  assert.ok(!hook.includes('deriveSourceUnread') && !hook.includes('factsBaselineSeed'),
    'the retired unread derivation must not come back')
  assert.ok(!hook.includes('saveUnread') && !hook.includes('loadUnread') && !hook.includes('UNREAD_V4_KEY'),
    'the retired unread journal must not come back')
  // W14 读清边沿：openIntents 里**每个**来源都要步进（非 painted 来源点开 + 壳 boot 失败也消点）。
  assert.ok(hook.includes('const touched = new Set(Object.keys(openIntents))'),
    'every open-intent source enters the step set')
  assert.ok(hook.includes('if (painted !== undefined) touched.add(painted)'),
    'the painted source keeps its step')
  assert.ok(hook.includes('for (const sourceId of touched) stepCompletionArmFor(sourceId)'),
    'the open-intent edge steps every intent source, not only the painted one')
  // reconcile 侧：只有 virtual 批是新壳报（shellReport: true），有壳路径复用当前壳行。
  const reconcile = bracedBlockFrom(hook, 'const reconcileCompletionsNow = useCallback(')
  assert.ok(reconcile.includes('virtualRuntimeReport(snapshot.session[sourceId])'),
    'reconcile reads the same facts-only projection')
  assert.match(reconcile, /virtual === undefined \? \{\} : \{ shellReport: true \}/,
    'only the virtual batch is a NEW shell report')
})

test('facts-only wiring: clearing runtime facts on notReady withdraws the source in the same tick (ctx → virtual)', () => {
  const aggregate = readFileSync(
    fileURLToPath(new URL('../../src/app-hooks/use-aggregate-refresh.ts', import.meta.url)), 'utf8')
  const poll = bracedBlockFrom(aggregate, 'const pollAggregates = useCallback(')
  assert.ok(poll.includes('factsStore.setRuntime(prev => {'), 'the notReady branch still clears runtime facts')
  assert.ok(poll.includes('const retired = notReady.filter(id => runtimeBefore[id] !== undefined)'),
    'only sources that actually lost runtime facts are withdrawn')
  assert.ok(poll.includes('for (const id of retired) withdrawSourceRef.current(id)'),
    'the same tick withdraws the arm memory / observation state')
  assert.ok(aggregate.includes('const withdrawSourceRef = useRef<(sourceId: string) => void>(() => {})'),
    'a no-op ref until App fills it after useNotifications')
  assert.match(APP, /withdrawSourceRef\.current = withdrawSource/,
    'App must fill the late-bound withdraw entry')
})

test('source retirement wiring: the gateway facts teardown drops the facts row and withdraws in the same tick (S2)', () => {
  const lifecycle = readFileSync(
    fileURLToPath(new URL('../../src/app-hooks/use-session-facts-lifecycle.ts', import.meta.url)), 'utf8')
  const teardown = bracedBlockFrom(lifecycle, 'sessionFactsTeardownRef.current.set(sourceId, () => {')
  assert.ok(teardown.includes('factsStore.dropSession(sourceId)'),
    'the gateway facts teardown owns the facts-row drop (retireSources calls it directly)')
  assert.ok(teardown.includes('withdrawSource(sourceId)'),
    'the same teardown withdraws the arm memory / observation state')
  // retireSources 是与 lifecycle effect 的 wanted 收敛并行的第二条路径（源码内有唯一调用点）。
  const retires = bracedBlockFrom(APP, 'const retireSources = useCallback(')
  assert.ok(retires.includes('sessionFactsTeardownRef.current.get(sourceId)?.()'),
    'retireSources must reach the teardown (same-id fingerprint replacement)')
  // mux 观察者 teardown 保持不 drop（既有不对称）：stop() 先发布「保留最后一批行 +
  // degraded/unavailable/stale」的退役快照（design 19 §3.5），行的最终删除由 App 注册表
  // 收敛的 pruneSourceRecord(factsStore.session, live) 承担——这里 drop 会把旧化身最后一批
  // 行误当权威空集。
  const muxTeardown = bracedBlockFrom(lifecycle, 'sourceMuxTeardownRef.current.set(sourceId, () => {')
  assert.ok(!muxTeardown.includes('dropSession'),
    'the mux observer keeps its own convergence path (no factsStore drop in its teardown)')
  // 单点删除：lifecycle effect 的「不再需要」分支不得再内联第二处 drop。
  assert.equal(stripComments(lifecycle).split('factsStore.dropSession(').length - 1, 1,
    'exactly one factsStore.dropSession call site in the lifecycle hook')
})

test('withdrawSource wiring: one withdrawal entity, provenance-scoped (C1) and deduped onto the bridge path (S6)', () => {
  const hook = readFileSync(
    fileURLToPath(new URL('../../src/app-hooks/use-notifications.ts', import.meta.url)), 'utf8')
  const body = bracedBlockFrom(hook, 'const withdrawSource = useCallback(')
  for (const needle of [
    'delete prevRunningRef.current[sourceId]',
    'completionObservationRef.current.delete(sourceId)',
    'completeLedgerRef.current.withdraw(sourceId)',
    'persistCompletionLedger(true)',
    'stepCompletionArmFor(sourceId)',
  ]) {
    assert.ok(body.includes(needle), 'the one withdrawal entity must keep: ' + needle)
  }
  // 臂冻结：撤回不得直接写 completedStore（清除只由步进按规则做）。
  assert.ok(!body.includes('completedStore'), 'withdrawal freezes the arm, it never clears it directly')
  // C1 分域：'shell' 分支只清壳轨（shellSeeded + 每会话壳位）、保留 prevRunning（窗口内
  // 虚拟接管按 facts 逐行边沿武装蓝点）与账本守卫（同一完成不得二次通知）。
  assert.ok(body.includes("if (scope === 'shell')"), 'the entity must branch on the withdrawal scope')
  const shellScope = bracedBlockFrom(hook, "if (scope === 'shell')")
  assert.ok(shellScope.includes('withdrawShellTrack('), 'shell scope resets the shell observation track')
  assert.ok(shellScope.includes('stepCompletionArmFor(sourceId)'), 'the arm re-steps under virtual provenance')
  for (const forbidden of [
    'delete prevRunningRef.current[sourceId]',
    'completionObservationRef.current.delete(sourceId)',
    'completeLedgerRef.current.withdraw(sourceId)',
  ]) {
    assert.ok(!shellScope.includes(forbidden), 'shell scope must NOT do: ' + forbidden)
  }
  assert.ok(hook.includes('withdrawShellTrack,') || hook.includes('withdrawShellTrack\n'),
    'the shell-scope helper comes from the observation module (single entity)')
  const observation = readFileSync(
    fileURLToPath(new URL('../../src/completion-observation.ts', import.meta.url)), 'utf8')
  assert.match(observation, /export function withdrawShellTrack\(state: SourceObservationState\): void \{/,
    'the observation module owns the shell-scope semantics')
  // 桥面 report === undefined 的五连内联复制已删：只剩 'shell' 分域调用（setRuntime 删除仍在前面）。
  const bridge = readFileSync(
    fileURLToPath(new URL('../../src/app-hooks/use-bridge-subscriptions.ts', import.meta.url)), 'utf8')
  const handler = bracedBlockFrom(bridge, 'const handleRuntimeReport: RuntimeReportListener =')
  assert.ok(handler.includes("withdrawSource(sourceId, 'shell')"),
    'the bridge path calls the one entity with the shell provenance')
  assert.ok(!handler.includes('withdrawSource(sourceId)\n'), 'the bridge path must not fall back to the all-scope call')
  assert.ok(!handler.includes('delete prevRunningRef.current[sourceId]'),
    'the five inline withdrawal statements must not come back')
  assert.ok(!handler.includes('completeLedgerRef.current.withdraw(sourceId)'))
  assert.ok(handler.includes('factsStore.setRuntime(prev => {'),
    'the runtime-facts deletion still happens first, in the same handler')
  // 事实载体真正换代的三个调用点仍走整代撤回（缺省 scope）——分域不得被接错侧。
  const lifecycle = readFileSync(
    fileURLToPath(new URL('../../src/app-hooks/use-session-facts-lifecycle.ts', import.meta.url)), 'utf8')
  assert.equal(lifecycle.split('withdrawSource(sourceId)').length - 1, 2,
    'gateway facts teardown + mux observer teardown keep the all-scope withdrawal')
  const aggregate = readFileSync(
    fileURLToPath(new URL('../../src/app-hooks/use-aggregate-refresh.ts', import.meta.url)), 'utf8')
  assert.ok(aggregate.includes('withdrawSourceRef.current(id)'), 'aggregate notReady keeps the all-scope withdrawal')
})

test('R2 wiring: the facts row hint reaches the shared bounded wave through its one entry (S6)', () => {
  const lifecycle = readFileSync(
    fileURLToPath(new URL('../../src/app-hooks/use-session-facts-lifecycle.ts', import.meta.url)), 'utf8')
  const hint = bracedBlockFrom(lifecycle, 'const requestFactsRefresh = useCallback(')
  assert.ok(hint.includes('refreshAggregateRef.current(sourceId)'),
    'the hint goes through the late-bound ref (the lifecycle effect builds it once)')
  assert.ok(!hint.includes('refreshAggregate('), 'never a bare pull that bypasses the shared cap')
  const aggregate = readFileSync(
    fileURLToPath(new URL('../../src/app-hooks/use-aggregate-refresh.ts', import.meta.url)), 'utf8')
  assert.ok(aggregate.includes('refreshAggregateRef.current = (sourceId: string): void => { runBoundedAggregateWave([sourceId]) }'),
    'the ref IS the bounded wave entry (queue dedupe + shared 4-pull cap)')
  assert.equal(stripComments(aggregate).split('runBoundedAggregateWave([sourceId])').length - 1, 1,
    'exactly one row-hint wave call site')
})

test('facts-health sampling wiring: every observer snapshot reaches the ring recorder', () => {
  const hook = readFileSync(
    fileURLToPath(new URL('../../src/app-hooks/use-session-facts-lifecycle.ts', import.meta.url)), 'utf8')
  // 唯一取样点：观察者快照 → applySessionFacts → sampleFactsHealth → recorder。删掉/断链任一环，
  // 这条锁必须红（它是「观察者一直不可判」落成盘上时间线的唯一通路）。
  const observer = bracedBlockFrom(hook, 'createSourceMuxFacts({')
  assert.ok(observer.includes('onSnapshot: snapshot => {'), 'the mux snapshot callback must exist')
  assert.ok(observer.includes('applySessionFacts(sourceId, snapshot)'), 'the same tick feeds the decision surface')
  assert.ok(observer.includes('sampleFactsHealth()'), 'the same tick feeds the health ring')
  const sample = bracedBlockFrom(hook, 'const sampleFactsHealth = (): void =>')
  assert.ok(sample.includes('created!.status()'), 'the sample reads the observer status')
  assert.ok(sample.includes('factsHealthRef.current?.record(sourceId, {'), 'the sample lands in the one recorder')
  // 采样字段与 FactsHealthSample 对齐：时点进 detail（状态进签名由 recorder 负责）。
  assert.ok(sample.includes('lastTrustedBaselineAt: status.lastTrustedBaselineAt'))
  assert.ok(!sample.includes('edges: status.edges'), 'the retired edge readback must not come back')
})

test('never-throw wiring: reconcile / apply / arm and every facts listener boundary is guarded', () => {
  const hook = readFileSync(
    fileURLToPath(new URL('../../src/app-hooks/use-notifications.ts', import.meta.url)), 'utf8')
  const bridge = readFileSync(
    fileURLToPath(new URL('../../src/app-hooks/use-bridge-subscriptions.ts', import.meta.url)), 'utf8')
  const lifecycle = readFileSync(
    fileURLToPath(new URL('../../src/app-hooks/use-session-facts-lifecycle.ts', import.meta.url)), 'utf8')
  const health = readFileSync(
    fileURLToPath(new URL('../../src/facts-health.ts', import.meta.url)), 'utf8')

  // ① 完成修正臂：公开入口过重入闸，闸的 step 内是统一包装，实体裸奔。
  assert.ok(bracedBlockFrom(hook, 'const stepCompletionArmFor = useCallback(')
    .includes('stepGateRef.current?.request(sourceId)'),
  'the arm entry must go through the re-entrancy gate (React #185)')
  assert.ok(hook.includes("factsStepGuard.guard(sourceId, 'completion-arm', () => stepArmNow(sourceId))"),
    'the gate step is still the one never-throw wrapper')
  // ② 收敛与 facts 应用：实体与 never-throw 出口分离，对外（listener）只暴露出口。
  assert.ok(hook.includes('const reconcileCompletionsNow = useCallback('))
  assert.ok(bracedBlockFrom(hook, 'const reconcileCompletions = useCallback(')
    .includes("factsStepGuard.guard(sourceId, 'reconcile-completions'"))
  assert.ok(hook.includes('const applySessionFactsNow = useCallback('))
  assert.ok(bracedBlockFrom(hook, 'const applySessionFacts = useCallback(')
    .includes("factsStepGuard.guard(sourceId, 'apply-session-facts'"))
  assert.ok(hook.includes('guardStep: factsStepGuard'), 'the hook exposes the one guard to the bridge')
  // ③ runtime 上报：桥的 listener body 是 guarded 的本地实现。
  assert.ok(bridge.includes('const handleRuntimeReport: RuntimeReportListener ='))
  assert.ok(bridge.includes("guardStep.guard(sourceId, 'runtime-report', () => handleRuntimeReport(sourceId, report, sourceFingerprint))"))
  // ④ 事实源 listener 注册边界：emit 环看不到 chamber listener 抛错（SSE/WS 泵不被 listener 打死）。
  //    gateway 事实源 listener 的唯一边界是它调用的 apply-session-facts（②，同一 recorder）；
  //    facts-row-hint 与 mux-snapshot 各自包住裸实现（后者还含无第二道 guard 的 sampleFactsHealth）。
  assert.ok(lifecycle.includes('factsStepGuardRef.current ??= createFactsStepGuard(factsHealthRef.current)'))
  assert.ok(!lifecycle.includes("'facts-snapshot'"),
    'gateway 事实源 listener 不得再叠第二道 guard：apply-session-facts 已是它的边界')
  for (const step of ['facts-row-hint', 'mux-snapshot']) {
    assert.ok(lifecycle.includes("factsStepGuard.guard(sourceId, '" + step + "'"),
      'guarded listener boundary: ' + step)
  }
  // ⑤ 策略本体：try/catch → 环 + loud 一次/来源/步骤（错误记账只有这一条出口）。
  const guardFactory = bracedBlockFrom(health, 'export function createFactsStepGuard(')
  assert.ok(guardFactory.includes('return run()'), 'the guard body runs the step')
  assert.ok(guardFactory.includes('catch (error)') && guardFactory.includes('report(sourceId, step, error)'),
    'a throwing step is reported, never swallowed silently')
  assert.ok(guardFactory.includes("recorder.error(sourceId, step + ': ' + message)"))
  assert.ok(guardFactory.includes("const key = sourceId + '|' + step"))
  assert.ok(guardFactory.includes("warn('[facts] "))
  // ⑥ 每步骤恰好一个包装：同一异常路径不得有两层。包装入口自身不带 try/catch（死层），
  //    实体（…Now / handler / stepArmNow）裸奔且不包第二道 guard；绑定 sourceId 的 .guard() 调用点每步骤恰好一个。
  const stepOwners = [
    ['completion-arm', hook], ['reconcile-completions', hook], ['apply-session-facts', hook],
    ['runtime-report', bridge],
    ['facts-row-hint', lifecycle], ['mux-snapshot', lifecycle],
  ]
  for (const [step, text] of stepOwners) {
    // 语义计数：绑定 sourceId 与步骤名的 .guard() 调用点恰好一个（不数注释/文案里的字面量）。
    // 计数前剥注释（共享实现保留字符串/模板字面量）：注释里出现 needle 不再被误计。
    const source = stripComments(text)
    const needle = "guard(sourceId, '" + step + "'"
    assert.equal(source.split(needle).length - 1, 1, '每步骤恰好一个 guard 调用点: ' + step)
  }
  for (const marker of [
    'stepArmGuardedRef.current = (sourceId: string): void => {',
    'const reconcileCompletions = useCallback(',
    'const applySessionFacts = useCallback(',
  ]) {
    assert.ok(!bracedBlockFrom(hook, marker).includes('try {'), '包装入口不得自带 try/catch 死层: ' + marker)
  }
  for (const marker of [
    'const stepArmNow = useCallback(',
    'const reconcileCompletionsNow = useCallback(',
    'const applySessionFactsNow = useCallback(',
  ]) {
    const entity = bracedBlockFrom(hook, marker)
    assert.ok(!entity.includes('try {'), '实体不得自带 try/catch 死层: ' + marker)
    assert.ok(!entity.includes('.guard('), '实体不得再包一层 guard: ' + marker)
  }
  const runtimeReportHandler = bracedBlockFrom(bridge, 'const handleRuntimeReport: RuntimeReportListener =')
  assert.ok(!runtimeReportHandler.includes('try {'), 'handler 裸奔：包装只在注册边界')
  assert.ok(!runtimeReportHandler.includes('.guard('), 'handler 自身不得再包一层 guard')
})

test('facts step guard: a throwing step lands in the ring and warns once per source+step (never-throw)', () => {
  const ring: Array<{ sourceId: string; message: string }> = []
  const warnings: string[] = []
  const guard = createFactsStepGuard(
    { error: (sourceId, message) => { ring.push({ sourceId, message }) } },
    message => { warnings.push(message) },
  )
  const boom = (): void => { throw new Error('boom') }
  assert.equal(guard.guard('dsh-a', 'completion-arm', boom), undefined)
  assert.equal(guard.guard('dsh-a', 'completion-arm', boom), undefined)
  assert.deepEqual(ring.map(entry => entry.message), ['completion-arm: boom', 'completion-arm: boom'],
    '每次异常都记账（环内去重由 recorder 负责）')
  assert.deepEqual(warnings, ['[facts] completion-arm 失败（保持上一拍）：'], 'console 每来源+步骤只 loud 一次')
  guard.guard('dsh-a', 'apply-session-facts', boom)
  guard.guard('dsh-b', 'completion-arm', boom)
  assert.equal(warnings.length, 3, '不同来源/步骤各有一次 loud')
  // 成功步骤原样返回；同一来源+步骤的再次异常复用同一条 loud 与环写入路径。
  assert.equal(guard.guard('dsh-a', 'completion-arm', () => 7), 7)
  assert.equal(guard.guard('dsh-a', 'completion-arm', boom), undefined)
  assert.equal(warnings.length, 3, '已 loud 过的来源+步骤不再喊')
  assert.equal(ring.at(-1)?.message, 'completion-arm: boom')
})
