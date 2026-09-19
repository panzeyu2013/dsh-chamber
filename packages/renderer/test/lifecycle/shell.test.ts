/**
 * shell.ts boot-failure tests (05 §4 failure-presentation revision + 2026-08
 * first-boot race fix).
 *
 * The renderer has no install-tree copy of the dsh workspace packages, so
 * `@deepseek-ai/dsh-client-web` is mapped by `scripts/test-shell-loader.mjs`
 * (registered via `--import scripts/test-shell-register.mjs`, see the
 * test:renderer-shell script) to the committed fixture
 * `test-fixtures/dsh-client-web.mjs`, whose AppWebEntry reports a controlled
 * `bootError` through the test knobs. The host-graph channel is stubbed to 503
 * `instance_unavailable` (no bundle preloads, no DOM needed).
 *
 * Covered: the resolved-but-failed boot (run() resolves, bootError set → the
 * chamber sees a failure and disposes the failed entry so a retry re-boots
 * cleanly), the clean settle, and the legacy run()-rejection path.
 *
 * P0 split: shared harness = test/support/shell-harness.ts. Siblings:
 *   - shell-tail-wait-teardown.test.ts (tail-wait cap, teardown barriers)
 *   - session-open-poll.test.ts (openInstanceSession polling/deadline)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chamberBridge } from '../../../dsh-chamber-client-ui-sidebar/src/shared/aggregate-store.ts'
// The settled-boot fact the seam carries (type-only: erased at runtime, so the
// loader hook never sees the specifier). Typing the test's ctx cast from the
// producer's own interface keeps a payload field from drifting out of the test.
import { bootGapSignature, type ShellDegradedFact, type ShellDegradedReport } from '../../src/boot-gap.ts'
import {
  FIBER_STATE,
  __testConfiguredContexts, __testDisposedCount, __testEventLog,
  __testQueueRunGate,
  __testResetConfiguredContexts, __testResetDisposed, __testResetEventLog,
  __testSetBootError, __testSetLoaderEntries, __testSetModuleSystemError,
  __testSetRunError, __testSetSessionsReadError,
  bootInstanceShell, collectFailedEntries, createChamberContextSetup, disposeInstanceShell,
  hostileThrownValue, shellModule, shellTestScope, testSourceFingerprint,
} from '../support/shell-harness.ts'

test('bootInstanceShell: a resolved-but-failed run (bootError set) settles as a failure and disposes the entry', async (t) => {
  shellTestScope(t, { graph: 'unavailable', timers: false, silentConsole: false })
  __testSetBootError('client-modules: require("@deepseek-ai/dsh-client-store") missed the module table')
  const state = await bootInstanceShell('ssh-test-fail-1', '/api/i/ssh-test-fail-1', {} as HTMLElement, () => {})
  assert.equal(state.booted, false)
  assert.equal(state.error, 'client-modules: require("@deepseek-ai/dsh-client-store") missed the module table')
  // The failed entry was disposed: a retry re-boots the container cleanly
  // (no duplicate React root / zombie ctx).
  assert.equal(__testDisposedCount(), 1)
})

test('bootInstanceShell: the failure report names the plugin ids that did not activate (T15)', async (t) => {
  // 2026-09-11 upstream-alignment (T15): upstream's boot page lists one item per
  // failed plugin id (boot-page.ts `Failed to load plugins`) and its post-settle
  // sweep names the same entries. The chamber overlay replaced that in-shell
  // page, so the shell reads the SAME live loader (ctx.loader.entries(), the
  // sweep's own source) before teardown and projects the ids on the ShellState
  // the App already consumes.
  shellTestScope(t, { graph: 'unavailable', timers: false, silentConsole: false })
  __testSetBootError('web boot: 2 entries did not activate\n@deepseek-ai/dsh-client-ui-tool: pending (waiting for service: sidebarRight)')
  __testSetLoaderEntries([
    { options: { name: '@dsh-chamber/app' }, fiber: { state: FIBER_STATE.ACTIVE } },
    { options: { name: '@deepseek-ai/dsh-client-ui-tool' }, fiber: { state: FIBER_STATE.PENDING } },
    // No fiber = the import failed (upstream projects exactly this as a failure).
    { options: { name: '@scope/third-party' } },
    { options: { name: '@scope/third-party' } },
  ])
  const state = await bootInstanceShell('ssh-test-fail-ids', '/api/i/ssh-test-fail-ids', {} as HTMLElement, () => {})
  assert.equal(state.booted, false)
  assert.deepEqual(state.failedEntries,
    ['@deepseek-ai/dsh-client-ui-tool', '@scope/third-party'],
    'the non-active entry ids travel in loader order, deduped')
})

test('bootInstanceShell: a hostile runtimeCtx read never replaces the boot failure report (T15)', async (t) => {
  // The sweep is an external-boundary read: the failure report the shell
  // already holds must survive a throwing runtimeCtx getter (same discipline as
  // describeShellError / the dispatchOpen hostile-read arm) — otherwise the
  // overlay would show the trap's error instead of the boot failure.
  shellTestScope(t, { graph: 'unavailable', timers: false, silentConsole: false })
  __testSetBootError('web boot: 1 entry did not activate')
  __testSetSessionsReadError(new Error('hostile runtimeCtx trap'))
  try {
    const state = await bootInstanceShell('ssh-test-fail-hostile', '/api/i/ssh-test-fail-hostile', {} as HTMLElement, () => {})
    assert.equal(state.booted, false)
    assert.equal(state.error, 'web boot: 1 entry did not activate', 'the boot report survives')
    assert.equal(state.failedEntries, undefined, 'no list is invented when the sweep cannot be read')
  } finally {
    __testSetSessionsReadError(undefined)
  }
})

test('collectFailedEntries mirrors the official sweep and tolerates extra rows', () => {
  // Pure sweep (the boot path above exercises it through the fixture): only
  // non-active entries are reported, tolerated (per-instance extra) rows never
  // fail a boot, and a hostile loader read can never turn a failure report into
  // a second failure.
  const entries = [
    { options: { name: 'a' }, fiber: { state: FIBER_STATE.ACTIVE } },
    { options: { name: 'b' }, fiber: { state: FIBER_STATE.PENDING } },
    { options: { name: 'c' }, fiber: { state: FIBER_STATE.FAILED } },
    { options: { name: 'extra' }, fiber: { state: FIBER_STATE.FAILED } },
    { options: { name: 'd' } },
    { options: { name: 'd' } },
  ]
  assert.deepEqual(
    collectFailedEntries({ loader: { entries: () => entries } }, new Set(['extra'])),
    ['b', 'c', 'd'],
  )
  assert.deepEqual(collectFailedEntries({ loader: { entries: () => entries } }), ['b', 'c', 'extra', 'd'])
  assert.deepEqual(collectFailedEntries(undefined), [])
  assert.deepEqual(collectFailedEntries({}), [])
  assert.deepEqual(collectFailedEntries({ loader: { entries() { throw new Error('hostile loader') } } }), [])
})

test('bootInstanceShell: a clean run settles booted with no error and keeps the entry', async (t) => {
  shellTestScope(t, { graph: 'unavailable', timers: false, silentConsole: false })
  __testResetConfiguredContexts()
  try {
    const state = await bootInstanceShell('ssh-test-clean-2', '/api/i/ssh-test-clean-2', {} as HTMLElement, () => {})
    assert.equal(state.booted, true)
    assert.equal(state.error, null)
    assert.equal(__testDisposedCount(), 0)
    const [facts] = __testConfiguredContexts() as [Record<string, unknown>]
    const { chamberReportBootDegraded, chamberMachineCatalog, ...immutableFacts } = facts
    assert.deepEqual(immutableFacts, {
      chamberInstanceId: 'ssh-test-clean-2',
      chamberBasePath: '/api/i/ssh-test-clean-2',
      chamberSourceFingerprint: testSourceFingerprint('ssh-test-clean-2'),
      chamberTransport: 'ssh',
      // 代际事实（producer 注册表的栅栏输入）。
      chamberBootGeneration: 1,
    })
    // 降级上报缝（2026-09-10）：条目里的必需服务探针经它把「挂载已知不完整」
    // 交给 App（App 据此在该来源 ready 后自动重挂），必须随每个 boot 一起提供。
    assert.equal(typeof chamberReportBootDegraded, 'function')
    // 页级机器目录（design 20 §5）：一次读取、注入每个条目（ssh 来源也一样），
    // 同为运行时面而非每来源事实，因此与降级上报缝一样单独断言。
    const machineCatalog = chamberMachineCatalog as { entries?: unknown; iconUrl?: unknown }
    assert.equal(typeof machineCatalog.entries, 'function', 'every boot hands the entry the page machine catalog')
    assert.equal(typeof machineCatalog.iconUrl, 'function')
  } finally {
    __testResetConfiguredContexts()
  }
})

test('bootInstanceShell: the serving gate is threaded into the host-graph fetch (rows after a wait)', async (t) => {
  // The App injects `waitForServing`; the boot must pass it to collectExtraRows
  // so a source that is still starting (503) is waited for instead of costing
  // the boot its whole profile client-plugin set — and the settle must then be
  // CLEAN (no degrade fact), which is what stops the App from re-booting a
  // healthy mount.
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    calls += 1
    const starting = calls <= 10                      // exhaust the default budget once
    return new Response(JSON.stringify(starting
      ? { code: 'instance_unavailable', error: 'instance not ready' }
      : { rpcId: 'r1', result: { ok: true, value: { rev: 'g', entries: [] } } }), {
      status: starting ? 503 : 200, headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  shellTestScope(t, { graph: 'none', timers: false, silentConsole: false })
  __testResetDisposed(); __testResetConfiguredContexts(); __testSetBootError(undefined); __testSetRunError(undefined)
  const waits: string[] = []
  try {
    const state = await shellModule.bootInstanceShell(
      'ssh-test-gate-8', '/api/i/ssh-test-gate-8', {} as HTMLElement, () => {},
      testSourceFingerprint('ssh-test-gate-8'), 'ssh',
      { waitForServing: async (instanceId) => { waits.push(instanceId); return true } },
    )
    assert.equal(state.booted, true)
    assert.equal(state.degraded, null, 'a boot that got its rows after the wait must not be marked degraded')
    assert.deepEqual(waits, ['ssh-test-gate-8'])
    assert.ok(calls > 10, 'the fetch retried on a fresh budget after the source started serving')
  } finally {
    __testResetConfiguredContexts()
    globalThis.fetch = original
  }
})

test('bootInstanceShell: a graph-less boot keeps its cause over a late lower-priority probe verdict', async (t) => {
  // 2026-09-10（sidebarRight 彻底修复）：取图在启动窗口内拿不到时，boot 仍成功但
  // 必须带上「已知不完整」这个事实（App 据此在来源 ready 后自动重挂）；条目里
  // 5s 必需服务探针的判词晚于 settle：经 onState 补发给**视图**，并经
  // options.onRepublish 投给 **App 镜像**（2026-12 BLOCKER 修复——只发前者时
  // 横幅/侧栏投射/自愈全都收不到，见下方 republished 断言）。2026-12 priority
  // （FIX 6 follow-up）：单槽按 bootGapPriority 比较，settle 的病因压过 5s 探针
  // 的后果；本用例同时钉住「病因撤销后后果才被记录」与两个 sink 的补发。
  shellTestScope(t, { graph: 'unavailable', timers: false, silentConsole: false })
  __testResetConfiguredContexts()
  const states: Array<{ booted: boolean; degraded: { kind: string } | null }> = []
  // 2026-12 BLOCKER fix: the post-settle verdict must reach the APP-owned sink as
  // well, because the `onState` argument above is the view's local setter in
  // production — publishing only through it left the banner, the sidebar/
  // connections projection and the self-heal blind to 2 of the 3 kinds.
  const republished: Array<{ booted: boolean; degraded: { kind: string } | null }> = []
  try {
    const state = await shellModule.bootInstanceShell(
      'ssh-test-degrade-7', '/api/i/ssh-test-degrade-7', {} as HTMLElement,
      (next) => states.push(next as unknown as { booted: boolean; degraded: { kind: string } | null }),
      testSourceFingerprint('ssh-test-degrade-7'), undefined,
      {
        onRepublish: (_id, next) => {
          republished.push(next as unknown as { booted: boolean; degraded: { kind: string } | null })
        },
      },
    )
    assert.equal(state.booted, true)
    assert.equal(state.error, null)
    assert.equal(state.degraded?.kind, 'graph-unavailable')
    const ctx = __testConfiguredContexts().at(-1) as {
      chamberReportBootDegraded?: (report: ShellDegradedReport) => void
    }
    assert.equal(typeof ctx.chamberReportBootDegraded, 'function', 'the entry needs the degrade seam')
    // The probe's verdict names a CONSEQUENCE (a required provider never
    // materialized — the classic ui-chat/sidebarRight case); the settled
    // graph-unavailable fact names its CAUSE (the graph channel never
    // answered). bootGapPriority ranks required-services-missing 0 below
    // graph-unavailable 2, so the symptom must not replace the cause that
    // explains it (shouldReplaceBootGap).
    const settledFact = state.degraded as ShellDegradedFact
    const settledStates = states.length
    const settledRepublishes = republished.length
    ctx.chamberReportBootDegraded?.({
      kind: 'required-services-missing',
      message: 'required extra-row service(s) missing after 5000ms: sidebarRight',
      services: ['sidebarRight'],
      injectedBy: ['@deepseek-ai/dsh-client-ui-chat'],
    })
    assert.equal(states.length, settledStates, 'a suppressed consequence must not republish to the view')
    assert.equal(republished.length, settledRepublishes, 'a suppressed consequence must not reach the App-owned sink')
    // An identical repeat is still suppressed (the same lower-priority kind
    // facing the same recorded cause; message drift is not part of identity).
    ctx.chamberReportBootDegraded?.({
      kind: 'required-services-missing',
      message: 'a re-worded but structurally identical verdict',
      services: ['sidebarRight'],
      injectedBy: ['@deepseek-ai/dsh-client-ui-chat'],
    })
    assert.equal(states.length, settledStates, 'the repeating symptom must stay suppressed')
    assert.equal(republished.length, settledRepublishes)
    // Retracting the recorded cause with its EXACT kind + signature republishes
    // the cleared state on both sinks (bootGapClearMatchesFact). The booted
    // state proves the slot still held graph-unavailable after those
    // suppressed reports: had a consequence replaced it, this retraction would
    // not match and the sinks would stay untouched.
    ctx.chamberReportBootDegraded?.({
      cleared: true,
      kind: 'graph-unavailable',
      signature: bootGapSignature(settledFact),
    })
    assert.equal(states.at(-1)!.booted, true, 'the cause retraction reaches the live holder')
    assert.equal(states.at(-1)!.degraded, null, 'the retraction removes the fact from the view state')
    assert.equal(republished.at(-1)!.degraded, null, '…and from the App mirror')
    // Now nothing outranks the consequence: it is recorded …
    ctx.chamberReportBootDegraded?.({
      kind: 'required-services-missing',
      message: 'required extra-row service(s) missing after 5000ms: sidebarRight',
      services: ['sidebarRight'],
      injectedBy: ['@deepseek-ai/dsh-client-ui-chat'],
    })
    const recorded = states.at(-1)!.degraded as unknown as ShellDegradedFact
    assert.equal(recorded.kind, 'required-services-missing')
    assert.equal(republished.at(-1)?.degraded?.kind, 'required-services-missing')
    assert.deepEqual(recorded.services, ['sidebarRight'], 'the structured services survive the republish (the copy names them)')
    // … and an identical repeat (message drift ignored by the signature) still
    // must not republish.
    const published = states.length
    ctx.chamberReportBootDegraded?.({
      kind: 'required-services-missing',
      message: 'a re-worded but structurally identical verdict',
      services: ['sidebarRight'],
      injectedBy: ['@deepseek-ai/dsh-client-ui-chat'],
    })
    assert.equal(states.length, published, 'an identical fact must not republish')
    // The load-bearing half of the signature change (2026-12 falsification
    // round): the SAME kind with a RICHER payload must republish. A kind-only
    // comparison — the behaviour this change replaced — silently dropped it,
    // which is exactly how the probe's re-armed pass lost its extra service.
    ctx.chamberReportBootDegraded?.({
      kind: 'required-services-missing',
      message: 'the probe re-armed and named one more service',
      services: ['sidebarRight', 'slots'],
      injectedBy: ['@deepseek-ai/dsh-client-ui-chat'],
    })
    assert.equal(states.length, published + 1, 'a richer payload of the same kind must republish')
    assert.deepEqual(
      (states.at(-1)!.degraded as unknown as { services?: readonly string[] }).services,
      ['sidebarRight', 'slots'],
      'the richer verdict must be the recorded one',
    )
    // … while a HIGHER-priority kind replaces the single slot: deferred rank 1
    // outranks the recorded required-services rank 0. Lower kinds could not
    // (both producers stay on console — the bound is registered in STATUS).
    ctx.chamberReportBootDegraded?.({
      kind: 'deferred-registration-failed',
      message: 'deferred plugin registration failed for 1 id(s): ui-tool',
      failedIds: ['ui-tool'],
    })
    assert.equal(
      states.at(-1)!.degraded?.kind,
      'deferred-registration-failed',
      'a higher-priority cause replaces the recorded consequence',
    )
  } finally {
    __testResetConfiguredContexts()
  }
})

test('bootInstanceShell: pre-settle reports are LAST-wins under priority and a retraction clears the settled fact (FIX 1/FIX 3)', async (t) => {
  // A slow boot (cold SSH bundle/extra-row loads) can outlive the probe's 5s
  // timer, so reports arriving BEFORE the settle wait in a per-serial stash. That
  // stash used to keep the FIRST report while the live path keeps the LAST — a
  // 0ms deferred-cluster verdict could shadow the probe's later, richer verdict.
  // 2026-12 priority: the replayed LAST report must ALSO pass
  // shouldReplaceBootGap against the settled graph-unavailable fact, so this
  // test stashes a lower-priority consequence first and a HIGHER-priority cause
  // second (local-graph-not-injected rank 3 > graph-unavailable rank 2): only
  // last-wins + the priority gate together produce that replay. The same seam
  // now also carries the probe's RETRACTION when the missing set empties
  // (FIX 1): the shell must remove the fact it holds, and only when the
  // retraction names exactly that fact.
  shellTestScope(t, { graph: 'unavailable', timers: false, silentConsole: false })
  __testResetConfiguredContexts()
  const gate = __testQueueRunGate('degrade-stash-window')
  const states: Array<{ booted: boolean; degraded: { kind: string } | null }> = []
  const republished: Array<{ booted: boolean; degraded: { kind: string } | null }> = []
  try {
    const boot = shellModule.bootInstanceShell(
      'ssh-test-stash-9', '/api/i/ssh-test-stash-9', {} as HTMLElement,
      (next) => states.push(next as unknown as { booted: boolean; degraded: { kind: string } | null }),
      testSourceFingerprint('ssh-test-stash-9'), undefined,
      {
        onRepublish: (_id, next) => {
          republished.push(next as unknown as { booted: boolean; degraded: { kind: string } | null })
        },
      },
    )
    // The fixture consumes the run gate AFTER configureContext, so the seam is
    // available while the boot is still loading (no holder yet → the stash path).
    await gate.started
    const ctx = __testConfiguredContexts().at(-1) as {
      chamberReportBootDegraded?: (report: unknown) => void
    }
    ctx.chamberReportBootDegraded?.({
      kind: 'required-services-missing',
      message: 'the probe named the real blocker',
      services: ['sidebarRight'],
      injectedBy: ['@deepseek-ai/dsh-client-ui-chat'],
    })
    ctx.chamberReportBootDegraded?.({
      kind: 'local-graph-not-injected',
      message: 'the local graph endpoint answered 404',
    })
    gate.release()
    const state = await boot
    assert.equal(state.booted, true)
    // The returned state is the boot's OWN settled state (the 503 graph fact)…
    assert.equal(state.degraded?.kind, 'graph-unavailable')
    // …while the LAST stashed report is replayed onto the live holder and the
    // App-owned sink (last-wins) AND clears the priority gate: the
    // local-graph-not-injected cause (rank 3) replaces the settled
    // graph-unavailable fact (rank 2). A first-wins stash would replay the
    // lower-priority consequence instead, which shouldReplaceBootGap then
    // suppresses — the replay below is what pins both halves.
    const replayed = states.at(-1)!.degraded as unknown as ShellDegradedFact
    assert.equal(replayed.kind, 'local-graph-not-injected')
    assert.equal(republished.at(-1)?.degraded?.kind, 'local-graph-not-injected')
    // The exact retraction of the replayed cause frees the slot on both sinks
    // (kind + signature); the assertions below then exercise the retraction
    // rules against the consequence recorded in the now-free slot.
    ctx.chamberReportBootDegraded?.({
      cleared: true,
      kind: 'local-graph-not-injected',
      signature: bootGapSignature(replayed),
    })
    assert.equal(states.at(-1)!.degraded, null, 'the exact retraction removes the replayed cause')
    assert.equal(republished.at(-1)!.degraded, null, '…and from the App mirror')
    // With the cause retracted, the probe's consequence is recorded.
    ctx.chamberReportBootDegraded?.({
      kind: 'required-services-missing',
      message: 'the probe named the real blocker',
      services: ['sidebarRight'],
      injectedBy: ['@deepseek-ai/dsh-client-ui-chat'],
    })
    const recorded = states.at(-1)!.degraded as unknown as ShellDegradedFact
    assert.equal(recorded.kind, 'required-services-missing')
    assert.deepEqual(recorded.services, ['sidebarRight'])
    assert.equal(republished.at(-1)?.degraded?.kind, 'required-services-missing')
    // A retraction that names a DIFFERENT payload of the same kind is ignored
    // (message is not part of the identity): a newer/richer verdict must survive
    // a stale retraction of an older set.
    ctx.chamberReportBootDegraded?.({
      cleared: true,
      kind: 'required-services-missing',
      signature: bootGapSignature({
        kind: 'required-services-missing',
        message: 'an older, larger verdict',
        services: ['sidebarRight', 'slots'],
        injectedBy: ['@deepseek-ai/dsh-client-ui-chat'],
      }),
    })
    assert.equal(states.at(-1)!.degraded?.kind, 'required-services-missing', 'a stale retraction changes nothing')
    // A retraction of ANOTHER kind is ignored too, even with a well-formed
    // graph-unavailable signature (the slot is single: one producer's kind must
    // never clear another producer's fact).
    ctx.chamberReportBootDegraded?.({
      cleared: true,
      kind: 'graph-unavailable',
      signature: bootGapSignature({ kind: 'graph-unavailable', message: 'the settled 503 fact' }),
    })
    assert.equal(states.at(-1)!.degraded?.kind, 'required-services-missing')
    // The EXACT retraction clears the fact on both sinks — the false banner goes
    // away instead of living until the next mount.
    ctx.chamberReportBootDegraded?.({
      cleared: true,
      kind: 'required-services-missing',
      signature: bootGapSignature(recorded),
    })
    assert.equal(states.at(-1)!.degraded, null, 'the retraction removes the fact from the view state')
    assert.equal(republished.at(-1)!.degraded, null, '…and from the App mirror')
    // Repeating the same retraction publishes nothing new.
    const published = states.length
    ctx.chamberReportBootDegraded?.({
      cleared: true,
      kind: 'required-services-missing',
      signature: bootGapSignature(recorded),
    })
    assert.equal(states.length, published, 'an already-cleared retraction must not republish')
  } finally {
    __testResetConfiguredContexts()
  }
})

test('createChamberContextSetup: immutable entry facts cannot cross when boots activate out of order', () => {
  const capture = (): { facts: Record<string, unknown>; ctx: { provide(name: string, value?: unknown): () => void } } => {
    const facts: Record<string, unknown> = {}
    return {
      facts,
      ctx: {
        provide(name, value) {
          facts[name] = value
          return () => {}
        },
      },
    }
  }
  const configureA = createChamberContextSetup('ssh-instance-a', '/api/i/ssh-instance-a')
  const configureB = createChamberContextSetup('ssh-instance-b', '/api/i/ssh-instance-b')
  const a = capture()
  const b = capture()

  // Model the original failure window: B starts after the queue timeout, then
  // A resumes late. Each closure must still install only its own facts.
  configureB(b.ctx)
  configureA(a.ctx)
  const entryFacts = (facts: Record<string, unknown>): Record<string, unknown> => ({
    chamberInstanceId: facts.chamberInstanceId,
    chamberBasePath: facts.chamberBasePath,
    chamberSourceFingerprint: facts.chamberSourceFingerprint,
    chamberTransport: facts.chamberTransport,
  })
  assert.deepEqual(entryFacts(a.facts), {
    chamberInstanceId: 'ssh-instance-a',
    chamberBasePath: '/api/i/ssh-instance-a',
    chamberSourceFingerprint: testSourceFingerprint('ssh-instance-a'),
    chamberTransport: 'ssh',
  })
  assert.deepEqual(entryFacts(b.facts), {
    chamberInstanceId: 'ssh-instance-b',
    chamberBasePath: '/api/i/ssh-instance-b',
    chamberSourceFingerprint: testSourceFingerprint('ssh-instance-b'),
    chamberTransport: 'ssh',
  })
  // The machine catalog is a PAGE fact (design 20 §5): "what is installed on
  // this machine" is read once from the LOCAL instance and every entry — a
  // remote-ssh one included — receives the exact same reader, never a copy.
  assert.ok(a.facts.chamberMachineCatalog !== undefined, 'every entry is handed the machine catalog')
  assert.equal(a.facts.chamberMachineCatalog, b.facts.chamberMachineCatalog,
    'two entries share one page-level machine reader')
  // …and the fact set stays exactly these five: the strict whole-object check
  // this replaced must not silently admit a new per-entry fact.
  assert.deepEqual(Object.keys(a.facts).sort(), [
    'chamberBasePath', 'chamberInstanceId', 'chamberMachineCatalog',
    'chamberSourceFingerprint', 'chamberTransport',
  ])
  assert.throws(() => createChamberContextSetup(' ', '/api/i/ '), /empty instance id/)
  for (const sourceId of [
    'remote-1', 'ssh-', 'ssh-local', 'ssh-bad/id', 'ssh-a.b', `ssh-${'a'.repeat(65)}`,
  ]) {
    assert.throws(
      () => createChamberContextSetup(sourceId, `/api/i/${sourceId}`),
      /invalid instance id/,
      `expected ${sourceId} to be rejected`,
    )
  }
  assert.doesNotThrow(() => createChamberContextSetup('local', '/api/i/local'))
  assert.doesNotThrow(() => createChamberContextSetup('ssh-dev_01', '/api/i/ssh-dev_01'))
  assert.doesNotThrow(() => createChamberContextSetup(`ssh-${'a'.repeat(64)}`, `/api/i/ssh-${'a'.repeat(64)}`))
  assert.throws(
    () => createChamberContextSetup('ssh-dev_01', '/api/i/ssh-dev_01', 'A'.repeat(64)),
    /invalid source fingerprint/,
  )
  assert.throws(
    () => createChamberContextSetup('local', '/api/i/local', 'not-local'),
    /invalid source fingerprint/,
  )
  assert.throws(
    () => createChamberContextSetup('ssh-instance-a', '/api/i/ssh-instance-b'),
    /instance\/base-path mismatch/,
  )
})

test('bootInstanceShell: rejects an invalid source before any host-graph request', (t) => {
  let fetched = false
  shellTestScope(t, { graph: 'unavailable', onFetch: () => { fetched = true }, timers: false, silentConsole: false })
  assert.throws(
    () => bootInstanceShell('ssh-local', '/api/i/ssh-local', {} as HTMLElement, () => {}),
    /invalid instance id/,
  )
  assert.equal(fetched, false)
})

test('bootInstanceShell: a throwing run settles as a failure (legacy rejection path) and disposes the entry', async (t) => {
  shellTestScope(t, { graph: 'unavailable', timers: false, silentConsole: false })
  __testSetRunError(new Error('loader exploded'))
  // 2026-09-11 review-fix (finding 4g): this last-resort arm names the failed
  // loader entries too — the same live-loader read the bootError arm performs,
  // taken before teardown and filtered by the same extra-row tolerance set. The
  // ctx is disposed further down in this same arm, so a sweep that ran after
  // teardown (or that was forgotten entirely) shows up here as an empty list.
  __testSetLoaderEntries([
    { options: { name: '@dsh-chamber/app' }, fiber: { state: FIBER_STATE.ACTIVE } },
    { options: { name: '@deepseek-ai/dsh-client-ui-tool' }, fiber: { state: FIBER_STATE.PENDING } },
  ])
  const state = await bootInstanceShell('ssh-test-throw-3', '/api/i/ssh-test-throw-3', {} as HTMLElement, () => {})
  assert.equal(state.booted, false)
  assert.equal(state.error, 'loader exploded')
  assert.deepEqual(state.failedEntries, ['@deepseek-ai/dsh-client-ui-tool'],
    'the rejection arm must list the non-active entries like the bootError arm')
  assert.equal(__testDisposedCount(), 1)
})

test('bootInstanceShell: a hostile thrown value still settles as a contained failure', async (t) => {
  shellTestScope(t, { graph: 'unavailable', timers: false, silentConsole: false })
  const hostile = hostileThrownValue()
  __testSetModuleSystemError(hostile)
  __testSetRunError(hostile)
  const state = await bootInstanceShell(
    'ssh-test-hostile-boot',
    '/api/i/ssh-test-hostile-boot',
    {} as HTMLElement,
    () => {},
  )
  assert.equal(state.booted, false)
  assert.equal(state.error, 'unknown error')
  assert.equal(__testDisposedCount(), 1)
})

test('bootInstanceShell: installs the module system BEFORE any host-graph fetch (first-boot race fix)', async (t) => {
  // The race: an extra bundle's script evaluates at load and registers its
  // factory through the __ModuleLoader__ sink, so the sink must exist before
  // the host-graph channel is even contacted (collectExtraRows's first step is
  // the graph fetch; bundle scripts are only appended after it resolves).
  shellTestScope(t, { graph: 'unavailable', onFetch: () => { __testEventLog().push('fetch') }, timers: false, silentConsole: false })
  __testResetEventLog()
  const state = await bootInstanceShell('ssh-test-order-5', '/api/i/ssh-test-order-5', {} as HTMLElement, () => {})
  assert.equal(state.booted, true)
  // The fixture's ensureWebModuleSystem records 'ensure' synchronously at
  // bootInstanceShell entry; the C3 gate's chamber prefetch fires right
  // after (its event is pushed synchronously); the fetch is
  // collectExtraRows's first step.
  // collectExtraRows now retries the pre-ready 503 on a bounded budget, so
  // the event log carries repeated 'fetch' entries — the invariant under
  // test is the ORDER (module system installed before the FIRST fetch, and
  // the chamber prefetch between the two — C3 gate, 2026-09).
  const events = __testEventLog()
  assert.deepEqual(events.slice(0, 3), ['ensure', 'prefetch:@dsh-chamber/app', 'fetch'])
})

test('bootInstanceShell: a module-system install failure skips the host-graph channel and settles with the same error', async (t) => {
  // Malformed/missing boot manifest: ensureWebModuleSystem throws → the extras
  // preload is skipped (no sink ⇒ no bundle must execute) and run() rethrows
  // the same parse error (simulated here via the run knob with the same text).
  shellTestScope(t, { graph: 'unavailable', onFetch: () => { __testEventLog().push('fetch') }, timers: false, silentConsole: false })
  __testResetEventLog()
  __testSetModuleSystemError(new Error('missing boot manifest'))
  __testSetRunError(new Error('missing boot manifest'))
  const state = await bootInstanceShell('ssh-test-manifest-6', '/api/i/ssh-test-manifest-6', {} as HTMLElement, () => {})
  assert.equal(state.booted, false)
  assert.equal(state.error, 'missing boot manifest')
  // No host-graph fetch at all: with no sink, no bundle may be requested.
  assert.deepEqual(__testEventLog(), ['ensure'])
  // The entry was constructed and disposed via the run()-rejection path.
  assert.equal(__testDisposedCount(), 1)
})

test('bootInstanceShell: a cancelled generation cannot overwrite the retry plugin diagnostic', async (t) => {
  const sourceId = 'ssh-test-diagnostic-generation-7'
  const originalFetch = globalThis.fetch
  shellTestScope(t, { graph: 'none', timers: false }, sourceId)
  let releaseFirst!: () => void
  let calls = 0
  globalThis.fetch = (() => {
    calls += 1
    if (calls === 1) {
      return new Promise<Response>(resolve => {
        releaseFirst = () => resolve(new Response('{}', { status: 404 }))
      })
    }
    return Promise.resolve(new Response(JSON.stringify({
      rpcId: 'retry', result: { ok: true, value: { entries: [] } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
  }) as typeof fetch
  const states: string[] = []
  const unsubscribe = chamberBridge.onPluginDiagnostic((id, diagnostic) => {
    if (id === sourceId && diagnostic !== undefined) states.push(diagnostic.state)
  })
  try {
    const first = bootInstanceShell(sourceId, `/api/i/${sourceId}`, {} as HTMLElement, () => {})
    disposeInstanceShell(sourceId)
    const retry = bootInstanceShell(sourceId, `/api/i/${sourceId}`, {} as HTMLElement, () => {})
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(states, [], 'same-id retry must defer its graph probe until the predecessor settles')
    releaseFirst()
    await Promise.all([first, retry])
    assert.deepEqual(states, ['ok'], 'the cancelled slow boot must not publish its late not-injected state')
  } finally {
    unsubscribe()
    chamberBridge.clearPluginDiagnostic(sourceId)
    globalThis.fetch = originalFetch
  }
})

