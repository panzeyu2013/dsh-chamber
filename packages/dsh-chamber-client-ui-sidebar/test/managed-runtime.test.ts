import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  fetchManagedRuntimeState,
  MANAGED_RUNTIME_DOWN_STATES,
  MANAGED_RUNTIME_TRANSIENT_STATES,
  managedRuntimeDown,
  managedRuntimeUnusable,
} from '../src/shared/managed-runtime.ts'
import { GATEWAY_RUNTIME_STATUS_KIND } from '../src/shared/gateway-runtime.ts'

// 问题 B（design 17 §2）：gateway 来源的托管 dsh 状态投影。desktop 的 ready
// 只证明 gateway 进程活着，停机窗口必须能被侧栏看见/禁用，而探针缺失时
// 绝不能把健康来源隐藏（fail open）。

const response = (status: number, body: unknown): Response => ({
  status,
  json: async () => body,
}) as unknown as Response

test('only the explicit terminal-down states count as down', () => {
  for (const state of MANAGED_RUNTIME_DOWN_STATES) assert.equal(managedRuntimeDown(state), true)
  // Transient/healthy states must keep the source interactive (rows stay; the
  // existing status dot renders the phase).
  for (const state of ['ready', 'degraded', 'starting', 'restarting', 'idle', 'unknown', '']) {
    assert.equal(managedRuntimeDown(state), false, `${state} must not hide the source`)
  }
  // Missing probes fail open: a proxy failure, an older gateway without the
  // route, or an unmounted tunnel must never masquerade as "managed dsh down".
  for (const state of [undefined, null]) assert.equal(managedRuntimeDown(state), false)
})

test('the probe reads connectionState through the per-instance proxy and never throws', async () => {
  const calls: string[] = []
  const fetchOk = (async (url: string) => {
    calls.push(url)
    return response(200, { kind: GATEWAY_RUNTIME_STATUS_KIND, connectionState: 'stopped', operationError: 'x' })
  }) as unknown as typeof fetch
  assert.equal(await fetchManagedRuntimeState('gateway-a', { fetchImpl: fetchOk }), 'stopped')
  assert.deepEqual(calls, ['/api/i/gateway-a/chamber/runtime/status'])

  // Malformed/absent payload → unknown (never a fabricated state).
  const fetchGarbage = (async () => response(200, { kind: GATEWAY_RUNTIME_STATUS_KIND, connectionState: 42 })) as unknown as typeof fetch
  assert.equal(await fetchManagedRuntimeState('gateway-a', { fetchImpl: fetchGarbage }), null)
  const fetchEmpty = (async () => response(200, null)) as unknown as typeof fetch
  assert.equal(await fetchManagedRuntimeState('gateway-a', { fetchImpl: fetchEmpty }), null)
  // A body that is not JSON at all must not escape as a throw.
  const fetchBadJson = (async () => ({ status: 200, json: async () => { throw new Error('not json') } })) as unknown as typeof fetch
  assert.equal(await fetchManagedRuntimeState('gateway-a', { fetchImpl: fetchBadJson }), null)

  // Non-200 (control plane's explicit 503 for a dead tunnel; 401/404 config
  // errors) → unknown.
  for (const status of [401, 403, 404, 503]) {
    const fetchStatus = (async () => response(status, { error: 'nope' })) as unknown as typeof fetch
    assert.equal(await fetchManagedRuntimeState('gateway-a', { fetchImpl: fetchStatus }), null, `HTTP ${status}`)
  }

  // Transport failure / abort → unknown.
  const fetchThrows = (async () => { throw new Error('network down') }) as unknown as typeof fetch
  assert.equal(await fetchManagedRuntimeState('gateway-a', { fetchImpl: fetchThrows }), null)
  const controller = new AbortController()
  controller.abort()
  const fetchAbort = (async (_url: string, init?: RequestInit) => {
    if (init?.signal?.aborted === true) throw new Error('aborted')
    return response(200, { kind: GATEWAY_RUNTIME_STATUS_KIND, connectionState: 'ready' })
  }) as unknown as typeof fetch
  assert.equal(await fetchManagedRuntimeState('gateway-a', { fetchImpl: fetchAbort, signal: controller.signal }), null)
})

test('an unknown/future connectionState passes through verbatim (version skew)', async () => {
  // The projection must not classify a state it does not know as down; it
  // surfaces it (the status dot renders status.unknown) and stays fail-open.
  const fetchFuture = (async () => response(200, { kind: GATEWAY_RUNTIME_STATUS_KIND, connectionState: 'quiescing' })) as unknown as typeof fetch
  const state = await fetchManagedRuntimeState('gateway-a', { fetchImpl: fetchFuture })
  assert.equal(state, 'quiescing')
  assert.equal(managedRuntimeDown(state), false)
})

test('an invalid instance id never reaches the network', async () => {
  let called = 0
  const fetchSpy = (async () => { called += 1; return response(200, { kind: GATEWAY_RUNTIME_STATUS_KIND }) }) as unknown as typeof fetch
  assert.equal(await fetchManagedRuntimeState('not-a-gateway-id', { fetchImpl: fetchSpy }), null)
  assert.equal(await fetchManagedRuntimeState('', { fetchImpl: fetchSpy }), null)
  assert.equal(called, 0, 'the canonical runtime path validates the gateway-<id> shape first')
})

// 源码级接线钉子（2026-12 复查 MINOR）：托管停机的**判定事实**必须独立于合并后
// 的 `phase`（两套词表都含 `error`，反推会把隧道失败误诊为托管停机——BLOCKER），
// 且两个消费面都必须只读该事实。
const sidebarRoot = new URL('../', import.meta.url)
const serverSection = readFileSync(new URL('src/client/ServerSection.tsx', sidebarRoot), 'utf8')
const appSource = readFileSync(new URL('../renderer/src/App.tsx', sidebarRoot), 'utf8')

test('the sidebar consumes the dedicated managed-down fact, never the merged phase', () => {
  assert.match(serverSection, /server\.managedRuntimeDown === true/,
    'the note/header must gate on the dedicated fact')
  assert.doesNotMatch(serverSection, /managedRuntimeDown\(server\.phase\)/,
    're-classifying the merged phase would misdiagnose a transport error as a stopped managed dsh')
  assert.match(serverSection, /sourceHeaderActivatable\(/,
    'a managed-down source header must stop being an activation affordance')
  assert.match(serverSection, /server\.connected && search\?\.expanded === true/,
    'the search capsule must be gated on connected (otherwise it is a keyboard dead end)')
})

test('the App publishes the fact only while the transport is usable', () => {
  assert.match(appSource, /const managedDown = kind === 'gateway' && transportUsable && managedRuntimeDown\(runtimeState\)/,
    'the projection must gate the managed fact on a usable transport')
  assert.match(appSource, /\.\.\.\(managedDown \? \{ managedRuntimeDown: true \} : \{\}\)/,
    'the aggregate must carry the dedicated field')
  assert.match(appSource, /const phase = managedDown \|\| managedTransient \? runtimeState! : transportPhase/,
    'starting/restarting must project into phase so the dot does not claim ready')
  assert.match(appSource, /managedRuntimeUnusable\(managedRuntime\[/,
    'harvest/prewarm must skip both terminal and transient managed states')
})

test('the baseline-pending note is gated on the aggregate facts, not on the phase', () => {
  // 降级列表的诚实标注（2026-12 复查 MAJOR）：门条件必须是
  // connected && aggregateReady && archiveSetKnown !== true（unary 兜底视图的
  // 三态），否则要么不显示、要么把真实列表也标注成降级。
  assert.match(serverSection,
    /server\.connected && server\.aggregateReady === true && server\.archiveSetKnown !== true/,
    'the degraded-list note must key off the aggregate tri-state')
  assert.match(serverSection, /t\('source\.baselinePending'\)/, 'the note text must come from the dictionary')
})

test('the sidebar renders ONE persistent live region per source', () => {
  // 插入即带内容的 role="status" 不会被 AT 播报；两条说明也必须互斥（managedDown
  // ⇒ connected=false，所以同一时刻至多一条）——单一常驻区域 + 换文本才是正确形态。
  assert.match(serverSection, /const sourceNote = server\.managedRuntimeDown === true/,
    'the note text must be derived once')
  assert.match(serverSection, /<div id=\{sourceNoteId\} className=\{cc\.sourceNote\} role="status" aria-live="polite">/,
    'one persistent polite live region per source')
  assert.match(serverSection, /aria-label=\{noteCarriesPhase \? undefined : t\(sourceStatusLabelKey\(server\)\)\}/,
    'the status dot must not double-announce a phase the note already carries')
  assert.match(serverSection, /aria-describedby=\{!headerActivatable && sourceNote !== '' \? sourceNoteId : undefined\}/,
    'the non-interactive header must describe itself through the note, not a dead aria-label')
})

test('the header stops being an activation affordance only for managed-down sources', () => {
  assert.match(serverSection, /return server\.id !== chamberInstanceId && !managedUnusable/,
    'the activation affordance must be dropped exactly for unusable managed sources')
  assert.match(serverSection, /return t\('source\.managedStarting', \{ state: t\(sourceStatusLabelKey\(server\)\) \}\)/,
    'the header title must not promise a switch that is a no-op')
  assert.match(serverSection, /if \(headerActivatable\) chamberBridge\.requestActivateSource\(server\.id\)/,
    'the click handler must respect the affordance')
  assert.match(serverSection, /if \(!headerActivatable\) return/, 'the key handler must respect the affordance')
})

test('managedRuntimeUnusable covers terminal and transient states only', () => {
  // 收割/预热门控用这个谓词：漏掉瞬态会拿 503 白烧一次尝试（只有 2 次），
  // 把 null/'' 当不可用则会隐藏健康来源（2026-12 复查 MINOR）。
  for (const state of MANAGED_RUNTIME_DOWN_STATES) {
    assert.equal(managedRuntimeUnusable(state), true, state)
  }
  for (const state of MANAGED_RUNTIME_TRANSIENT_STATES) {
    assert.equal(managedRuntimeUnusable(state), true, state)
  }
  for (const state of ['ready', 'degraded', 'unknown', '', null, undefined]) {
    assert.equal(managedRuntimeUnusable(state), false, String(state))
  }
  // 终态判定保持独立语义（UI 的 phase/文案仍用它）。
  assert.equal(managedRuntimeDown('starting'), false)
  assert.equal(managedRuntimeDown('restarting'), false)
})

test('the source note id is per-shell and its empty state stays a live region', () => {
  // 同一来源在每个已挂载壳的侧栏里各有一份 DOM：id 必须按壳限定，否则
  // aria-describedby 可能解析到另一份（隐藏壳）的同名节点（2026-12 复查 MINOR）。
  assert.match(serverSection, /chamber-source-note-\$\{chamberInstanceId \?\? 'unknown'\}-\$\{server\.id\}/,
    'the note id must be qualified by the shell instance id')
  const css = readFileSync(new URL('src/client/sidebar-chamber.module.css', sidebarRoot), 'utf8')
  assert.match(css, /\.sourceNote:empty \{\s*padding: 0;\s*line-height: 0;\s*\}/,
    'the empty live region must collapse to zero height')
  assert.doesNotMatch(css, /\.sourceNote:empty \{[^}]*display:\s*none/,
    'display:none would take the live region out of the accessibility tree')
})

test('the transient managed state gets its own honest note and the dot keeps its phase', () => {
  // 瞬态（starting/restarting）会把 connected 折叠为 false ⇒ 会话子树隐藏；
  // 没有说明行就是"整组凭空消失"（2026-12 复查 MINOR）。
  assert.match(serverSection, /const managedTransient = server\.kind === 'gateway'\s*\n\s*&& \(server\.phase === 'starting' \|\| server\.phase === 'restarting'\)/,
    'the transient note must be kind-scoped (local /health shares the vocabulary)')
  assert.match(serverSection, /const managedUnusable = server\.managedRuntimeDown === true/,
    'the transient state must also stop promising an activation that 503s')
  assert.match(serverSection, /t\('source\.managedStarting', \{ state: t\(sourceStatusLabelKey\(server\)\) \}\)/,
    'the transient note must use the dictionary key and carry the state word')
  assert.match(serverSection, /const noteCarriesPhase = sourceNote !== ''/,
    'a note must take the live-region role from the dot (one live region per source)')
  assert.match(serverSection, /role=\{sourceNote === '' \? 'status' : undefined\}/,
    'the dot must yield the live-region role to any note')
  assert.match(serverSection, /aria-label=\{noteCarriesPhase \? undefined : t\(sourceStatusLabelKey\(server\)\)\}/,
    'the dot must keep announcing the phase when the note does not carry it')
  assert.match(serverSection, /capsuleHeldFocus\.current && server\.connected !== true/,
    'the focus hand-back must key on the connection fact (the search state is pruned on disconnect)')
})
