import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HARVEST_ABANDON_MS,
  HARVEST_DEADLINE_MS,
  HARVEST_MAX_ATTEMPTS,
  HARVEST_RETRY_BACKOFF_MS,
  harvestAbandoned,
  harvestAttemptStarted,
  harvestDeadlinePassed,
  harvestParked,
  harvestParkedRecord,
  harvestPending,
  harvestRetryDue,
  harvestSatisfied,
  pickPrewarmTarget,
  prewarmCandidates,
  shouldReclaimHarvestedShell,
} from '../src/baseline-harvest.ts'
import { BOOT_TIMEOUT_MS } from '../src/boot-budget.ts'
import { readFileSync } from 'node:fs'

// 首屏基线收割账本（src/baseline-harvest.ts 头注）：ready 但从未挂载的来源在
// 后台预热槽里挂一次、拿到首个权威推送即回收。本文件只测纯账本——App 接线
// （挂载/回收/超时清扫/用户点开采用）是 React 组件层，node 直跑不覆盖 DOM。

const NOW = 1_700_000_000_000

test('an unknown source is pending; satisfaction or the attempt ceiling parks it', () => {
  assert.equal(harvestPending(undefined), true)
  assert.equal(harvestPending({ attempts: 0, mountedAt: 0, retryAt: 0, satisfied: false }), true)
  assert.equal(harvestPending({ attempts: HARVEST_MAX_ATTEMPTS, mountedAt: NOW, retryAt: 0, satisfied: false }), false)
  assert.equal(harvestPending({ attempts: 0, mountedAt: 0, retryAt: 0, satisfied: true }), false)
  // The ceiling is inclusive: attempts already spent at the limit never retry.
  assert.equal(harvestPending({ attempts: HARVEST_MAX_ATTEMPTS - 1, mountedAt: NOW, retryAt: NOW, satisfied: false }), true)
})

test('a started attempt counts itself, records the mount, and arms the backoff', () => {
  const first = harvestAttemptStarted(undefined, NOW)
  assert.deepEqual(first, { attempts: 1, mountedAt: NOW, retryAt: NOW + HARVEST_RETRY_BACKOFF_MS, satisfied: false })
  // The backoff is armed at START, so a boot that hangs or fails cannot be
  // retried in a tight loop even before the failure is observed.
  assert.equal(harvestRetryDue(first, NOW + 1), false)
  assert.equal(harvestRetryDue(first, NOW + HARVEST_RETRY_BACKOFF_MS), true)
  assert.equal(harvestRetryDue(undefined, NOW), true)
  const second = harvestAttemptStarted(first, NOW + HARVEST_RETRY_BACKOFF_MS)
  assert.equal(second.attempts, 2)
  assert.equal(second.mountedAt, NOW + HARVEST_RETRY_BACKOFF_MS)
})

test('satisfaction preserves the attempt count and clears the in-flight mount', () => {
  const satisfied = harvestSatisfied({ attempts: 1, mountedAt: NOW, retryAt: NOW + 1, satisfied: false })
  assert.deepEqual(satisfied, { attempts: 1, mountedAt: 0, retryAt: 0, satisfied: true })
  assert.equal(harvestPending(satisfied), false)
  // Satisfying an unknown source is still a valid record (user adoption).
  assert.deepEqual(harvestSatisfied(undefined), { attempts: 0, mountedAt: 0, retryAt: 0, satisfied: true })
})

test('the deadline only fires for an unsatisfied attempt that is still mounted', () => {
  const record = { attempts: 1, mountedAt: NOW, retryAt: NOW + HARVEST_RETRY_BACKOFF_MS, satisfied: false }
  assert.equal(harvestDeadlinePassed(record, NOW + HARVEST_DEADLINE_MS - 1), false)
  assert.equal(harvestDeadlinePassed(record, NOW + HARVEST_DEADLINE_MS), true)
  assert.equal(harvestDeadlinePassed({ ...record, satisfied: true }, NOW + HARVEST_DEADLINE_MS), false)
  // No attempt started yet (mountedAt 0) is never "past deadline".
  assert.equal(harvestDeadlinePassed({ ...record, mountedAt: 0 }, NOW + HARVEST_DEADLINE_MS), false)
  // The deadline must outlast the shell boot budget (imported, not a literal,
  // so the coupling breaks loudly if shell.ts ever changes it), or a
  // slow-but-healthy boot would be reclaimed mid-flight.
  assert.ok(HARVEST_DEADLINE_MS > BOOT_TIMEOUT_MS, 'harvest deadline must exceed the boot budget')
})

test('a source that spent its budget without a baseline is parked, never warm-prewarmed', () => {
  // Satisfied sources may fall back to ordinary warm prewarm; an exhausted
  // unsatisfied one must not (a third boot + permanent occupation of the
  // single background slot: 2026-12 review MAJOR-2).
  assert.equal(harvestParked(undefined), false)
  assert.equal(harvestParked({ attempts: 0, mountedAt: 0, retryAt: 0, satisfied: false }), false)
  assert.equal(harvestParked({ attempts: HARVEST_MAX_ATTEMPTS, mountedAt: NOW, retryAt: 0, satisfied: false }), true)
  assert.equal(harvestParked({ attempts: HARVEST_MAX_ATTEMPTS, mountedAt: 0, retryAt: 0, satisfied: true }), false)
})

test('eligibility reserves the single slot for baseline recovery while any harvest is pending', () => {
  // A warm shell mounted while a harvest is pending would become autoPrewarmed,
  // and with exactly one hidden shell retention never reclaims it, so
  // `remaining` would be 0 for the rest of the session and every remaining
  // source would stay degraded — one failed source blocking all the others
  // (2026-12 review MAJOR-1). So: harvest ids only, and ALL of them, so a due
  // candidate behind a not-due head is reachable.
  assert.deepEqual(prewarmCandidates(['a'], ['b'], 1), ['a'])
  assert.deepEqual(prewarmCandidates(['a', 'b', 'c'], ['d'], 1), ['a', 'b', 'c'])
  assert.deepEqual(prewarmCandidates([], ['b'], 1), ['b'], 'warm prewarm resumes once no harvest is pending')
  assert.deepEqual(prewarmCandidates([], ['b', 'c'], 1), ['b'])
  assert.deepEqual(prewarmCandidates(['a'], ['b'], 0), [], 'no free slot means nothing is eligible')
})

test('the drain prefers a DUE harvest candidate and skips one inside its backoff', () => {
  const eligible = new Set(['harvest-a', 'harvest-b', 'warm-c'])
  const pending = (id: string): boolean => id.startsWith('harvest')
  const due = (id: string): boolean => id !== 'harvest-a'
  // harvest-a is not due, harvest-b is: the due candidate wins even though a
  // warm shell sits earlier in the queue.
  assert.equal(pickPrewarmTarget(['warm-c', 'harvest-a', 'harvest-b'], eligible, pending, due), 'harvest-b')
  // Nothing due: the slot stays reserved for harvests, so nothing may mount
  // (the warm shell is not eligible while a harvest is pending).
  assert.equal(pickPrewarmTarget(['harvest-a', 'warm-c'], new Set(['harvest-a']), pending, () => false), undefined)
  // No harvest pending at all → the warm candidate mounts.
  assert.equal(pickPrewarmTarget(['warm-c'], new Set(['warm-c']), () => false, () => false), 'warm-c')
  // Ineligible entries are skipped entirely.
  assert.equal(pickPrewarmTarget(['gone', 'warm-c'], eligible, () => false, () => true), 'warm-c')
  assert.equal(pickPrewarmTarget([], eligible, pending, () => true), undefined)
})

test('an attempt that never settles is abandoned at an absolute cap and parked', () => {
  // A hung loader/fetch leaves the shell booting forever, so the settled-gated
  // deadline can never fire and the single background slot stays wedged. The
  // absolute cap reclaims it AND parks the source so it is not retried into the
  // same wedge (2026-12 review MAJOR-2).
  const record = { attempts: 1, mountedAt: NOW, retryAt: NOW + HARVEST_RETRY_BACKOFF_MS, satisfied: false }
  assert.ok(HARVEST_ABANDON_MS > HARVEST_DEADLINE_MS, 'the abandon cap must exceed the deadline')
  assert.equal(harvestAbandoned(record, NOW + HARVEST_ABANDON_MS - 1), false)
  assert.equal(harvestAbandoned(record, NOW + HARVEST_ABANDON_MS), true)
  assert.equal(harvestAbandoned({ ...record, satisfied: true }, NOW + HARVEST_ABANDON_MS), false)
  assert.equal(harvestAbandoned({ ...record, mountedAt: 0 }, NOW + HARVEST_ABANDON_MS), false)
  const parked = harvestParkedRecord()
  assert.equal(harvestParked(parked), true, 'an abandoned source must not re-enter warm prewarm')
  assert.equal(harvestPending(parked), false, 'an abandoned source must not be retried')
})

test('the last harvested shell is kept warm and yields as soon as another candidate appears', () => {
  // Keeping the last harvested shell saves a boot and keeps its runtime facts
  // live; it must yield the slot the moment another source still needs a
  // baseline, or a later-ready source could never be harvested (review M3/N3).
  const pending = (id: string): boolean => id.startsWith('pending')
  assert.equal(shouldReclaimHarvestedShell(new Set(['self']), 'self', pending), false,
    'no other candidate → keep the shell as the warm shell')
  assert.equal(shouldReclaimHarvestedShell(new Set(['self', 'pending-b']), 'self', pending), true,
    'another candidate pending → yield the slot')
  assert.equal(shouldReclaimHarvestedShell(new Set(['self', 'satisfied-b']), 'self', pending), false,
    'a satisfied sibling is not a candidate')
  assert.equal(shouldReclaimHarvestedShell(new Set(), 'self', pending), false)
})

// ---- 源码级接线钉子（2026-12 复查 MAJOR：纯账本测试无法覆盖 App 侧接线）----
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('the App arms an absolute cap for the in-flight background mount', () => {
  // 只扫 harvestIntentRef 的放弃臂不够：用户点开收割壳会撤销意图、温壳预热从不写
  // 意图——挂死 boot 会永久占住后台槽。该臂必须按挂载时刻独立兜底，并释放同 id
  // boot 尾（否则该源此后每次重挂都卡在 previousInstanceBoot 上）。
  // 放弃臂必须按**每个挂载视图的挂载时刻**判定（只盯 prewarmInflight 会漏掉
  // 用户点开/深链挂载的挂死壳；2026-12 复查 MAJOR），且标记失败时要重新计时，
  // 否则「重试」后同一轮清扫会立刻再次判超时。
  assert.match(appSource, /const viewBootStartedAtRef = useRef<Record<string, number>>\(\{\}\)/,
    'per-view mount stamps are the abandon basis')
  assert.match(appSource, /if \(startedAt === undefined \|\| now - startedAt < HARVEST_ABANDON_MS\) continue/,
    'the sweep must skip views inside the cap')
  assert.match(appSource, /if \(settledViewIds\.has\(id\)\) continue/,
    'only a never-settling mount may be abandoned (a slow healthy boot is judged by the deadline)')
  // 放弃**不能**释放同 id boot 尾：尾是 generation 记录的持有者，提前释放会让
  // 迟到的挂死 boot 与后继代同号并注册覆盖（2026-12 复查 BLOCKER）。正确做法是
  // shell.ts 对"等待上一代"设绝对上限 + producer 注册表的代际栅栏。
  assert.doesNotMatch(appSource, /abandonInstanceBootTail/,
    'the App must not release the boot tail (it owns the generation records)')
  const shellSource = readFileSync(new URL('../src/shell.ts', import.meta.url), 'utf8')
  assert.match(shellSource, /export const INSTANCE_TAIL_WAIT_CAP_MS = BOOT_TIMEOUT_MS \* 2/,
    'shell.ts must bound the same-id predecessor wait')
  assert.match(shellSource, /ctx\.provide\('chamberBootGeneration', bootGeneration\)/,
    'the boot generation must reach the plugin ctx for the producer fence')
  assert.match(appSource, /harvestStateRef\.current\[id\] = harvestParkedRecord\(\)/,
    'the harvest path must park the abandoned source')
  assert.match(appSource, /reclaimView\(id, wasHarvest \? 'harvest' : 'retention'\)/,
    'the warm/user path must reclaim with suppression')
  assert.match(appSource, /markAbandonedShellFailed\(id\)/,
    'an unreclaimable (active/pending) abandoned shell must surface the failure overlay')
  assert.match(appSource, /viewBootStartedAtRef\.current\[id\] = Date\.now\(\)/,
    'marking failed must re-arm the per-view window so a retry gets a fresh budget')
  // 重试复位（idle 状态上报）也必须重新计时，否则在放弃后很久才点重试会立刻再判超时。
  assert.match(appSource,
    /if \(!state\.booted && state\.error === null\) viewBootStartedAtRef\.current\[instanceId\] = Date\.now\(\)/,
    're-entering booting must re-arm the window')
})

test('the managed-runtime probe keeps its foreground cadence and single-flight seam', () => {
  // 探针是问题 B 的整个数据源：删掉轮询/可见性门控会让托管停机重新变成不可见，
  // 而其余门全绿（2026-12 复查 MINOR）。
  assert.match(appSource, /setInterval\(\(\) => \{ void probe\(\) \}, MANAGED_RUNTIME_POLL_MS\)/,
    'the probe must run on the documented foreground cadence')
  assert.match(appSource, /probeManagedRuntimeRef\.current = probe/,
    'the compensation path must be able to await the current probe')
  assert.match(appSource, /if \(inFlight !== null\) return inFlight/,
    'single-flight must JOIN the in-flight probe, not no-op')
  assert.match(appSource, /MANAGED_RUNTIME_PROBE_TIMEOUT_MS/, 'the probe must keep a timeout guard')
})

test('the App excludes managed-down gateways from harvest/prewarm', () => {
  assert.match(appSource,
    /managedRuntimeUnusable\(managedRuntime\[sourceIdForInstance\(instance\)\]\)/,
    'a down/starting managed dsh can never boot a shell — it must not burn attempts/slots')
  assert.match(appSource, /instance\.kind === 'gateway'\s*\n\s*&& managedRuntimeUnusable/,
    'the managed exclusion must stay kind-scoped to gateways')
  assert.match(appSource,
    /const managedDown = kind === 'gateway' && transportUsable && managedRuntimeDown\(runtimeState\)/,
    'the projection must gate the managed fact on a usable transport')
  assert.match(appSource, /const phase = managedDown \|\| managedTransient \? runtimeState! : transportPhase/,
    'both the terminal and the transient managed states must project into phase')
  assert.match(appSource, /const connected = !managedDown && !managedTransient && instanceConnected\(/,
    'connected must fold the managed facts (terminal and transient), which is what makes the two notes mutually exclusive')
})

test('a retried boot gets a fresh container and drops stale settles', () => {
  // 挂死壳的 AppWebEntry 仍持有旧容器：复用同一个 div 会让第二次尝试把新的
  // boot 页/React root 追加进已有 root 的容器（2026-12 复查 MAJOR）。
  const view = readFileSync(new URL('../src/components/InstanceView.tsx', import.meta.url), 'utf8')
  assert.match(view, /<div key=\{retryToken \?\? 0\} ref=\{containerRef\} className="instance-shell" \/>/,
    'each retry must mount into a fresh container element')
  assert.match(view, /if \(!aliveRef\.current \|\| bootToken !== bootTokenRef\.current\) return/,
    'a settle from a superseded attempt must be dropped')
  assert.match(view, /const bootToken = bootTokenRef\.current \+ 1/,
    'each attempt must take a fresh token')
})
