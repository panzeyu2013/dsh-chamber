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
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chamberBridge } from '../../dsh-chamber-client-ui-sidebar/src/shared/aggregate-store.ts'

// Test knobs — same module instance shell.ts sees (the loader maps the bare
// specifier to this URL; the relative import resolves to the same file).
import {
  FIBER_STATE,
  __testConfiguredContexts, __testDisposedCount, __testEventLog,
  __testEntryStates, __testOpenedSessions, __testQueueDisposeGate, __testQueueRunGate,
  __testResetConfiguredContexts, __testResetDisposed, __testResetEventLog,
  __testResetLifecycle, __testSetSessionsAvailable, __testSetSessionsListed,
  __testSetSessionsOpenError, __testSetSessionsReadError,
  __testSetSessionsSnapshotError, __testSetLoaderEntries,
  __testSetBootError, __testSetChamberPrefetchError, __testSetModuleSystemError, __testSetRunError,
} from '../test-fixtures/dsh-client-web.mjs'

const shellModule = await import('../src/shell.ts')
const {
  collectFailedEntries,
  disposeAllShells, disposeInstanceShell, INSTANCE_TAIL_WAIT_CAP_MS, openInstanceSession,
  tailWaitRemainingMs,
} = shellModule

const testSourceFingerprint = (instanceId: string): string => instanceId === 'local'
  ? 'local'
  : 'ab'.repeat(32)
const createChamberContextSetup = (instanceId: string, basePath: string, sourceFingerprint = testSourceFingerprint(instanceId)) =>
  shellModule.createChamberContextSetup(instanceId, basePath, sourceFingerprint)
const bootInstanceShell = (
  instanceId: string,
  basePath: string,
  el: HTMLElement,
  onState: Parameters<typeof shellModule.bootInstanceShell>[3],
) => shellModule.bootInstanceShell(instanceId, basePath, el, onState, testSourceFingerprint(instanceId))

// ── Plumbing ───────────────────────────────────────────────────────────────

/** Host-graph channel resolves 503 instance_unavailable (expected pre-ready; no bundle preloads). */
function stubUnavailableGraph(onFetch?: () => void): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    onFetch?.()
    return new Response(
      JSON.stringify({ code: 'instance_unavailable', error: 'instance not ready' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/** Host graph is ready immediately with no extra plugin rows. */
function stubReadyGraph(onFetch?: (url: string) => void): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input) => {
    onFetch?.(String(input))
    return new Response(JSON.stringify({
      rpcId: 'shell-generation-test',
      result: { ok: true, value: { rev: 'empty', entries: [] } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/** Mirror the browser's `window === globalThis` relationship for renderer code. */
function stubWindow(): () => void {
  const g = globalThis as Record<string, unknown>
  const original = g.window
  g.window = globalThis
  return () => {
    if (original === undefined) delete g.window
    else g.window = original
  }
}

/** Thrown value whose Error test and String conversion both throw. This is a
 * realistic hostile plugin/runtime boundary: catch blocks must not assume the
 * caught value is safely inspectable. */
function hostileThrownValue(): unknown {
  return new Proxy(Object.create(null) as object, {
    getPrototypeOf() {
      throw new Error('hostile getPrototypeOf trap')
    },
    get(_target, property) {
      if (property === Symbol.toPrimitive || property === 'toString' || property === 'valueOf') {
        throw new Error('hostile string conversion trap')
      }
      return undefined
    },
  })
}

test('bootInstanceShell: a resolved-but-failed run (bootError set) settles as a failure and disposes the entry', async () => {
  const restoreFetch = stubUnavailableGraph()
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testSetBootError('client-modules: require("@deepseek-ai/dsh-client-store") missed the module table')
  __testSetRunError(undefined)
  try {
    const state = await bootInstanceShell('ssh-test-fail-1', '/api/i/ssh-test-fail-1', {} as HTMLElement, () => {})
    assert.equal(state.booted, false)
    assert.equal(state.error, 'client-modules: require("@deepseek-ai/dsh-client-store") missed the module table')
    // The failed entry was disposed: a retry re-boots the container cleanly
    // (no duplicate React root / zombie ctx).
    assert.equal(__testDisposedCount(), 1)
  } finally {
    __testSetBootError(undefined)
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: the failure report names the plugin ids that did not activate (T15)', async () => {
  // 2026-09-11 upstream-alignment (T15): upstream's boot page lists one item per
  // failed plugin id (boot-page.ts `Failed to load plugins`) and its post-settle
  // sweep names the same entries. The chamber overlay replaced that in-shell
  // page, so the shell reads the SAME live loader (ctx.loader.entries(), the
  // sweep's own source) before teardown and projects the ids on the ShellState
  // the App already consumes.
  const restoreFetch = stubUnavailableGraph()
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testSetBootError('web boot: 2 entries did not activate\n@deepseek-ai/dsh-client-ui-tool: pending (waiting for service: sidebarRight)')
  __testSetRunError(undefined)
  __testSetLoaderEntries([
    { options: { name: '@dsh-chamber/app' }, fiber: { state: FIBER_STATE.ACTIVE } },
    { options: { name: '@deepseek-ai/dsh-client-ui-tool' }, fiber: { state: FIBER_STATE.PENDING } },
    // No fiber = the import failed (upstream projects exactly this as a failure).
    { options: { name: '@scope/third-party' } },
    { options: { name: '@scope/third-party' } },
  ])
  try {
    const state = await bootInstanceShell('ssh-test-fail-ids', '/api/i/ssh-test-fail-ids', {} as HTMLElement, () => {})
    assert.equal(state.booted, false)
    assert.deepEqual(state.failedEntries,
      ['@deepseek-ai/dsh-client-ui-tool', '@scope/third-party'],
      'the non-active entry ids travel in loader order, deduped')
  } finally {
    __testSetLoaderEntries(undefined)
    __testSetBootError(undefined)
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: a hostile runtimeCtx read never replaces the boot failure report (T15)', async () => {
  // The sweep is an external-boundary read: the failure report the shell
  // already holds must survive a throwing runtimeCtx getter (same discipline as
  // describeShellError / the dispatchOpen hostile-read arm) — otherwise the
  // overlay would show the trap's error instead of the boot failure.
  const restoreFetch = stubUnavailableGraph()
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testSetBootError('web boot: 1 entry did not activate')
  __testSetRunError(undefined)
  __testSetSessionsReadError(new Error('hostile runtimeCtx trap'))
  try {
    const state = await bootInstanceShell('ssh-test-fail-hostile', '/api/i/ssh-test-fail-hostile', {} as HTMLElement, () => {})
    assert.equal(state.booted, false)
    assert.equal(state.error, 'web boot: 1 entry did not activate', 'the boot report survives')
    assert.equal(state.failedEntries, undefined, 'no list is invented when the sweep cannot be read')
  } finally {
    __testSetSessionsReadError(undefined)
    __testSetLoaderEntries(undefined)
    __testSetBootError(undefined)
    restoreFetch()
    restoreWindow()
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

test('bootInstanceShell: a clean run settles booted with no error and keeps the entry', async () => {
  const restoreFetch = stubUnavailableGraph()
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testResetConfiguredContexts()
  __testSetBootError(undefined)
  __testSetRunError(undefined)
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
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: the serving gate is threaded into the host-graph fetch (rows after a wait)', async () => {
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
  const restoreWindow = stubWindow()
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
    restoreWindow()
  }
})

test('bootInstanceShell: a graph-less boot settles degraded and republishes a late probe verdict', async () => {
  // 2026-09-10（sidebarRight 彻底修复）：取图在启动窗口内拿不到时，boot 仍成功但
  // 必须带上「已知不完整」这个事实（App 据此在来源 ready 后自动重挂）；条目里
  // 5s 必需服务探针的判词晚于 settle，经同一条 onState 缝补发。
  const restoreFetch = stubUnavailableGraph()
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testResetConfiguredContexts()
  __testSetBootError(undefined)
  __testSetRunError(undefined)
  const states: Array<{ booted: boolean; degraded: { kind: string } | null }> = []
  try {
    const state = await bootInstanceShell(
      'ssh-test-degrade-7', '/api/i/ssh-test-degrade-7', {} as HTMLElement,
      (next) => states.push(next as unknown as { booted: boolean; degraded: { kind: string } | null }),
    )
    assert.equal(state.booted, true)
    assert.equal(state.error, null)
    assert.equal(state.degraded?.kind, 'graph-unavailable')
    const ctx = __testConfiguredContexts().at(-1) as { chamberReportBootDegraded?: (message: string) => void }
    assert.equal(typeof ctx.chamberReportBootDegraded, 'function', 'the entry needs the degrade seam')
    ctx.chamberReportBootDegraded?.('required extra-row service(s) missing after 5000ms: sidebarRight')
    const last = states.at(-1)!
    assert.equal(last.booted, true)
    assert.equal(last.degraded?.kind, 'required-services-missing')
  } finally {
    __testResetConfiguredContexts()
    restoreFetch()
    restoreWindow()
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

test('bootInstanceShell: rejects an invalid source before any host-graph request', () => {
  let fetched = false
  const restoreFetch = stubUnavailableGraph(() => { fetched = true })
  try {
    assert.throws(
      () => bootInstanceShell('ssh-local', '/api/i/ssh-local', {} as HTMLElement, () => {}),
      /invalid instance id/,
    )
    assert.equal(fetched, false)
  } finally {
    restoreFetch()
  }
})

test('bootInstanceShell: a throwing run settles as a failure (legacy rejection path) and disposes the entry', async () => {
  const restoreFetch = stubUnavailableGraph()
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testSetBootError(undefined)
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
  try {
    const state = await bootInstanceShell('ssh-test-throw-3', '/api/i/ssh-test-throw-3', {} as HTMLElement, () => {})
    assert.equal(state.booted, false)
    assert.equal(state.error, 'loader exploded')
    assert.deepEqual(state.failedEntries, ['@deepseek-ai/dsh-client-ui-tool'],
      'the rejection arm must list the non-active entries like the bootError arm')
    assert.equal(__testDisposedCount(), 1)
  } finally {
    __testSetLoaderEntries(undefined)
    __testSetRunError(undefined)
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: a hostile thrown value still settles as a contained failure', async () => {
  const restoreFetch = stubUnavailableGraph()
  const restoreWindow = stubWindow()
  const hostile = hostileThrownValue()
  __testResetDisposed()
  __testSetBootError(undefined)
  __testSetModuleSystemError(hostile)
  __testSetRunError(hostile)
  try {
    const state = await bootInstanceShell(
      'ssh-test-hostile-boot',
      '/api/i/ssh-test-hostile-boot',
      {} as HTMLElement,
      () => {},
    )
    assert.equal(state.booted, false)
    assert.equal(state.error, 'unknown error')
    assert.equal(__testDisposedCount(), 1)
  } finally {
    __testSetModuleSystemError(undefined)
    __testSetRunError(undefined)
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: installs the module system BEFORE any host-graph fetch (first-boot race fix)', async () => {
  // The race: an extra bundle's script evaluates at load and registers its
  // factory through the __ModuleLoader__ sink, so the sink must exist before
  // the host-graph channel is even contacted (collectExtraRows's first step is
  // the graph fetch; bundle scripts are only appended after it resolves).
  const restoreFetch = stubUnavailableGraph(() => { __testEventLog().push('fetch') })
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testResetEventLog()
  __testSetBootError(undefined)
  __testSetRunError(undefined)
  __testSetModuleSystemError(undefined)
  try {
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
  } finally {
    __testResetEventLog()
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: a module-system install failure skips the host-graph channel and settles with the same error', async () => {
  // Malformed/missing boot manifest: ensureWebModuleSystem throws → the extras
  // preload is skipped (no sink ⇒ no bundle must execute) and run() rethrows
  // the same parse error (simulated here via the run knob with the same text).
  const restoreFetch = stubUnavailableGraph(() => { __testEventLog().push('fetch') })
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testResetEventLog()
  __testSetBootError(undefined)
  __testSetModuleSystemError(new Error('missing boot manifest'))
  __testSetRunError(new Error('missing boot manifest'))
  try {
    const state = await bootInstanceShell('ssh-test-manifest-6', '/api/i/ssh-test-manifest-6', {} as HTMLElement, () => {})
    assert.equal(state.booted, false)
    assert.equal(state.error, 'missing boot manifest')
    // No host-graph fetch at all: with no sink, no bundle may be requested.
    assert.deepEqual(__testEventLog(), ['ensure'])
    // The entry was constructed and disposed via the run()-rejection path.
    assert.equal(__testDisposedCount(), 1)
  } finally {
    __testSetModuleSystemError(undefined)
    __testSetRunError(undefined)
    __testResetEventLog()
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: a cancelled generation cannot overwrite the retry plugin diagnostic', async () => {
  const sourceId = 'ssh-test-diagnostic-generation-7'
  const originalFetch = globalThis.fetch
  const originalConsoleError = console.error
  const restoreWindow = stubWindow()
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
  console.error = () => {}
  __testSetBootError(undefined)
  __testSetRunError(undefined)
  __testSetModuleSystemError(undefined)
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
    disposeInstanceShell(sourceId)
    globalThis.fetch = originalFetch
    console.error = originalConsoleError
    restoreWindow()
  }
})

test('bootInstanceShell: a never-settling same-id predecessor stops pinning the id at the wait cap', async (t) => {
  // 2026-12 复查 BLOCKER：严格同 id 尾必须保留（它是 generation 记录的持有者），
  // 但"等待上一代"必须有绝对上限——否则一个 entry.run() 永不 settle 的 boot 会让
  // 该源此后每次重挂都卡住。上限 = 两个 boot 预算，低于 App 的放弃上限。
  const instanceId = 'ssh-test-tail-cap-9'
  __testResetLifecycle()
  const gen1Gate = __testQueueRunGate('gen1')
  const restoreFetch = stubReadyGraph(() => undefined)
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  let gen1Boot: ReturnType<typeof bootInstanceShell> | undefined
  let gen2Boot: ReturnType<typeof bootInstanceShell> | undefined
  let gen2Gate: ReturnType<typeof __testQueueRunGate> | undefined
  t.mock.timers.enable({ apis: ['setTimeout'] })
  console.error = () => {}
  try {
    gen1Boot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    await gen1Gate.started

    gen2Gate = __testQueueRunGate('gen2')
    gen2Boot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    await Promise.resolve()
    // 上限之前：后继代仍严格等前代（不抢注册/teardown）。
    t.mock.timers.tick(INSTANCE_TAIL_WAIT_CAP_MS - 1)
    await Promise.resolve()
    // 上限到点：后继代放行，且迟到注册的前代被 generation 判为 superseded。
    t.mock.timers.tick(1)
    await gen2Gate.started
    assert.equal(__testEntryStates().filter(entry => entry.label === 'gen2').length, 1)
    gen2Gate.release()
    const gen2State = await gen2Boot
    assert.equal(gen2State.booted, true)

    // 迟到后继：同 id 尾已在上一代 settle 后释放，它必须立刻入队。
    // 绝对截止（共享，而非每个后继各等一个上限）由纯函数 tailWaitRemainingMs 单测
    // 钉住——时间敏感的一体化断言在这里观察不到（2026-12 复查 MINOR）。
    const lateGate = __testQueueRunGate('late')
    const lateBoot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    await lateGate.started
    lateGate.release()
    const lateState = await lateBoot
    assert.equal(lateState.booted, true, 'a late successor joins without a fresh full cap')

    // 前代最终 settle 时不得覆盖后继（generation 阈值）。
    gen1Gate.release()
    const gen1State = await gen1Boot
    assert.equal(gen1State.booted, false)
    assert.match(gen1State.error ?? '', /superseded/)
    // 每个新代都会退役上一代（同 id 前驱），最终只有最新一代存活。
    assert.deepEqual(__testEntryStates(), [
      { label: 'gen1', disposed: true },
      { label: 'gen2', disposed: true },
      { label: 'late', disposed: false },
    ])
  } finally {
    gen1Gate.release()
    gen2Gate?.release()
    restoreFetch()
    restoreWindow()
    console.error = originalConsoleError
    disposeAllShells()
    __testResetLifecycle()
  }
})

test('tailWaitRemainingMs: all successors share one absolute deadline', () => {
  // 2026-12 复查 MINOR：时间敏感的一体化断言观察不到"共享截止"，这里用纯函数钉住
  // 语义——已过期的截止必须立刻放行（0），未给截止才退回一个完整上限。
  assert.equal(tailWaitRemainingMs(undefined, 1_000), INSTANCE_TAIL_WAIT_CAP_MS)
  assert.equal(tailWaitRemainingMs(1_000 + INSTANCE_TAIL_WAIT_CAP_MS, 1_000), INSTANCE_TAIL_WAIT_CAP_MS)
  assert.equal(tailWaitRemainingMs(1_000 + INSTANCE_TAIL_WAIT_CAP_MS - 1, 1_000), INSTANCE_TAIL_WAIT_CAP_MS - 1)
  assert.equal(tailWaitRemainingMs(1_000, 1_000), 0, 'an expired deadline joins immediately')
  assert.equal(tailWaitRemainingMs(500, 1_000), 0, 'a long-expired deadline joins immediately')
})

test('bootInstanceShell: timeout releases a different id while same-id gen2 waits for gen1 teardown', async (t) => {
  const instanceId = 'ssh-test-same-id-late-settle-8'
  const otherId = 'ssh-test-timeout-other-id-8'
  const graphFetches: string[] = []
  const restoreFetch = stubReadyGraph(url => { graphFetches.push(url) })
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  __testResetLifecycle()
  const gen1Gate = __testQueueRunGate('gen1')
  let gen1Boot: ReturnType<typeof bootInstanceShell> | undefined
  let gen2Boot: ReturnType<typeof bootInstanceShell> | undefined
  let otherBoot: ReturnType<typeof bootInstanceShell> | undefined
  let otherGate: ReturnType<typeof __testQueueRunGate> | undefined
  let gen2Gate: ReturnType<typeof __testQueueRunGate> | undefined
  let gen1DisposeGate: ReturnType<typeof __testQueueDisposeGate> | undefined
  t.mock.timers.enable({ apis: ['setTimeout'] })
  console.error = () => {}
  __testResetDisposed()
  __testSetBootError(undefined)
  __testSetRunError(undefined)
  __testSetModuleSystemError(undefined)
  try {
    gen1Boot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    await gen1Gate.started

    // Registry removal cancels gen1 while it is hung. Re-adding the same id
    // creates gen2, but it must remain behind gen1's strict per-id tail.
    disposeInstanceShell(instanceId)
    gen2Boot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    await Promise.resolve()
    assert.equal(
      graphFetches.filter(url => url.includes(`/api/i/${instanceId}/`)).length,
      1,
      'same-id gen2 must not start graph/bundle preloading while gen1 owns the instance tail',
    )

    // A different id queues after gen2. Because gen2 does not claim a global
    // slot while waiting on its same-id predecessor, gen1's 60s timeout must
    // release this unrelated boot immediately.
    otherGate = __testQueueRunGate('other-id')
    otherBoot = bootInstanceShell(otherId, `/api/i/${otherId}`, {} as HTMLElement, () => {})
    t.mock.timers.tick(60_000)
    await Promise.resolve()
    await otherGate.started
    assert.equal(graphFetches.filter(url => url.includes(`/api/i/${instanceId}/`)).length, 1)
    assert.equal(graphFetches.filter(url => url.includes(`/api/i/${otherId}/`)).length, 1)
    assert.deepEqual(__testEntryStates(), [
      { label: 'gen1', disposed: false },
      { label: 'other-id', disposed: false },
    ])
    otherGate.release()
    const otherState = await otherBoot
    assert.equal(otherState.booted, true)

    // Even after the timeout, gen2 must not construct until gen1 settles AND
    // its async disposer completes. This removes both producer registration
    // inversion and two-React-roots-on-one-container races at the source.
    gen1DisposeGate = __testQueueDisposeGate()
    gen2Gate = __testQueueRunGate('gen2')
    gen1Gate.release()
    assert.equal(await gen1DisposeGate.started, 'gen1')
    await Promise.resolve()
    assert.deepEqual(__testEntryStates(), [
      { label: 'gen1', disposed: true },
      { label: 'other-id', disposed: false },
    ])
    gen1DisposeGate.release()
    const gen1State = await gen1Boot
    assert.equal(gen1State.booted, false)
    assert.match(gen1State.error ?? '', /shell boot superseded by generation 2/)
    await gen2Gate.started
    assert.equal(
      graphFetches.filter(url => url.includes(`/api/i/${instanceId}/`)).length,
      2,
      'gen2 may preload only after gen1 settle and teardown release its strict tail',
    )
    assert.deepEqual(__testEntryStates(), [
      { label: 'gen1', disposed: true },
      { label: 'other-id', disposed: false },
      { label: 'gen2', disposed: false },
    ])
    assert.equal(__testDisposedCount(), 1)
    gen2Gate.release()
    const gen2State = await gen2Boot
    assert.equal(gen2State.booted, true)
    await openInstanceSession(instanceId, 'after-gen2')
    assert.deepEqual(__testOpenedSessions(), [
      { label: 'gen2', sessionId: 'after-gen2' },
    ])

    // The replacement remains the one live holder until the registry removes
    // it; final disposal releases that resource as well.
    disposeInstanceShell(instanceId)
    assert.deepEqual(__testEntryStates(), [
      { label: 'gen1', disposed: true },
      { label: 'other-id', disposed: false },
      { label: 'gen2', disposed: true },
    ])
    assert.equal(__testDisposedCount(), 2)
    disposeInstanceShell(otherId)
    assert.equal(__testDisposedCount(), 3)
  } finally {
    gen1Gate.release()
    otherGate?.release()
    gen2Gate?.release()
    gen1DisposeGate?.release()
    await Promise.allSettled([
      ...(gen1Boot === undefined ? [] : [gen1Boot]),
      ...(gen2Boot === undefined ? [] : [gen2Boot]),
      ...(otherBoot === undefined ? [] : [otherBoot]),
    ])
    disposeInstanceShell(instanceId)
    disposeInstanceShell(otherId)
    __testResetLifecycle()
    t.mock.timers.reset()
    console.error = originalConsoleError
    restoreFetch()
    restoreWindow()
  }
})

test('disposeInstanceShell: a live holder records and cancels a newer same-id queued generation', async () => {
  const instanceId = 'ssh-test-live-holder-cancels-inflight-9'
  const blockerId = 'ssh-test-live-holder-blocker-9'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  __testResetLifecycle()
  __testResetDisposed()
  __testSetBootError(undefined)
  __testSetRunError(undefined)
  __testSetModuleSystemError(undefined)
  console.error = () => {}
  let blockerGate: ReturnType<typeof __testQueueRunGate> | undefined
  let blockerBoot: ReturnType<typeof bootInstanceShell> | undefined
  let gen2Boot: ReturnType<typeof bootInstanceShell> | undefined
  try {
    const gen1State = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(gen1State.booted, true)

    // Hold the page-global queue on another source so gen2 has acquired its
    // generation number but has not yet retired the still-live gen1 holder.
    blockerGate = __testQueueRunGate('other-source-blocker')
    blockerBoot = bootInstanceShell(blockerId, `/api/i/${blockerId}`, {} as HTMLElement, () => {})
    await blockerGate.started
    gen2Boot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    // A holder exists (gen1), while bootGenerations already points at queued
    // gen2. The disposal threshold must record gen2 before releasing gen1.
    disposeInstanceShell(instanceId)
    blockerGate.release()
    const blockerState = await blockerBoot
    assert.equal(blockerState.booted, true)
    const gen2State = await gen2Boot
    assert.equal(gen2State.booted, false)
    assert.equal(gen2State.error, 'shell disposed (instance left ready)')
    assert.deepEqual(__testEntryStates(), [
      { label: 'entry-1', disposed: true },
      { label: 'other-source-blocker', disposed: false },
    ])
    assert.equal(__testDisposedCount(), 1)
  } finally {
    blockerGate?.release()
    if (blockerBoot !== undefined) await blockerBoot
    if (gen2Boot !== undefined) await gen2Boot
    disposeInstanceShell(instanceId)
    disposeInstanceShell(blockerId)
    __testResetLifecycle()
    console.error = originalConsoleError
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: registering a newer same-id generation awaits displaced-holder teardown', async () => {
  const instanceId = 'ssh-test-same-id-holder-replacement-10'
  const graphFetches: string[] = []
  const restoreFetch = stubReadyGraph(url => { graphFetches.push(url) })
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  __testResetDisposed()
  __testSetBootError(undefined)
  __testSetRunError(undefined)
  __testSetModuleSystemError(undefined)
  const disposeGate = __testQueueDisposeGate()
  let gen2Boot: ReturnType<typeof bootInstanceShell> | undefined
  try {
    const gen1State = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(gen1State.booted, true)
    gen2Boot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(await disposeGate.started, 'entry-1')
    await Promise.resolve()
    assert.deepEqual(__testEntryStates(), [
      { label: 'entry-1', disposed: true },
    ], 'gen2 must not even be constructed while gen1 teardown is pending')
    assert.equal(
      graphFetches.filter(url => url.includes(`/api/i/${instanceId}/`)).length,
      1,
      'gen2 must not start graph/bundle preloading before the displaced holder tears down',
    )

    disposeGate.release()
    const gen2State = await gen2Boot
    assert.equal(gen2State.booted, true)
    assert.equal(graphFetches.filter(url => url.includes(`/api/i/${instanceId}/`)).length, 2)
    assert.deepEqual(__testEntryStates(), [
      { label: 'entry-1', disposed: true },
      { label: 'entry-2', disposed: false },
    ])
    assert.equal(__testDisposedCount(), 1)
    await openInstanceSession(instanceId, 'new-holder-session')
    assert.deepEqual(__testOpenedSessions(), [
      { label: 'entry-2', sessionId: 'new-holder-session' },
    ])

    disposeInstanceShell(instanceId)
    assert.deepEqual(__testEntryStates(), [
      { label: 'entry-1', disposed: true },
      { label: 'entry-2', disposed: true },
    ])
    assert.equal(__testDisposedCount(), 2)
  } finally {
    disposeGate.release()
    if (gen2Boot !== undefined) await gen2Boot
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: remove then re-add awaits the removed holder async teardown', async () => {
  const instanceId = 'ssh-test-remove-readd-teardown-10b'
  const graphFetches: string[] = []
  const restoreFetch = stubReadyGraph(url => { graphFetches.push(url) })
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  const disposeGate = __testQueueDisposeGate()
  let gen2Boot: ReturnType<typeof bootInstanceShell> | undefined
  try {
    const gen1State = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(gen1State.booted, true)
    disposeInstanceShell(instanceId)
    assert.equal(await disposeGate.started, 'entry-1')

    gen2Boot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    let gen2Settled = false
    void gen2Boot.then(() => { gen2Settled = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(gen2Settled, false)
    assert.deepEqual(__testEntryStates(), [
      { label: 'entry-1', disposed: true },
    ])
    assert.equal(
      graphFetches.filter(url => url.includes(`/api/i/${instanceId}/`)).length,
      1,
      're-added generation must not preload while the removed holder is still disposing',
    )

    disposeGate.release()
    const gen2State = await gen2Boot
    assert.equal(gen2State.booted, true)
    assert.equal(graphFetches.filter(url => url.includes(`/api/i/${instanceId}/`)).length, 2)
    assert.deepEqual(__testEntryStates(), [
      { label: 'entry-1', disposed: true },
      { label: 'entry-2', disposed: false },
    ])
  } finally {
    disposeGate.release()
    if (gen2Boot !== undefined) await gen2Boot
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: one source teardown barrier does not block a different source', async () => {
  const blockedId = 'ssh-test-teardown-isolation-a'
  const otherId = 'ssh-test-teardown-isolation-b'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  const disposeGate = __testQueueDisposeGate()
  try {
    const first = await bootInstanceShell(blockedId, `/api/i/${blockedId}`, {} as HTMLElement, () => {})
    assert.equal(first.booted, true)
    disposeInstanceShell(blockedId)
    assert.equal(await disposeGate.started, 'entry-1')

    // blockedId's disposer is still pending; otherId owns a distinct barrier.
    const other = await bootInstanceShell(otherId, `/api/i/${otherId}`, {} as HTMLElement, () => {})
    assert.equal(other.booted, true)
    assert.deepEqual(__testEntryStates(), [
      { label: 'entry-1', disposed: true },
      { label: 'entry-2', disposed: false },
    ])
  } finally {
    disposeGate.release()
    disposeInstanceShell(blockedId)
    disposeInstanceShell(otherId)
    __testResetLifecycle()
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: async teardown rejection is loud but cannot wedge same-id re-add', async () => {
  const instanceId = 'ssh-test-teardown-rejection-contained'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  const errors: unknown[][] = []
  __testResetLifecycle()
  const disposeGate = __testQueueDisposeGate()
  console.error = (...args: unknown[]) => { errors.push(args) }
  let readd: ReturnType<typeof bootInstanceShell> | undefined
  try {
    const first = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(first.booted, true)
    disposeInstanceShell(instanceId)
    assert.equal(await disposeGate.started, 'entry-1')

    readd = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    disposeGate.fail(new Error('fixture dispose exploded'))
    const second = await readd
    assert.equal(second.booted, true)
    assert.ok(errors.some(args => String(args[0]).includes('async dispose') && String(args[1]).includes('fixture dispose exploded')))
  } finally {
    disposeGate.release()
    if (readd !== undefined) await readd
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    console.error = originalConsoleError
    restoreFetch()
    restoreWindow()
  }
})

test('shell lifecycle owners are reclaimed after churn without an old cleanup erasing a same-id re-add', async () => {
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  const waitForOwnerCounts = async (bootGenerations: number, cancelledBoots: number): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const counts = shellModule.__testShellLifecycleOwnerCounts()
      if (counts.bootGenerations === bootGenerations && counts.cancelledBoots === cancelledBoots) return
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    assert.deepEqual(shellModule.__testShellLifecycleOwnerCounts(), { bootGenerations, cancelledBoots })
  }
  const instanceId = 'ssh-test-owner-readd'
  let disposeGate: ReturnType<typeof __testQueueDisposeGate> | undefined
  let replacement: ReturnType<typeof bootInstanceShell> | undefined
  try {
    // Clear holders intentionally retained by earlier shell tests, then pin
    // the storage seam at an empty baseline before exercising reclamation.
    disposeAllShells()
    await waitForOwnerCounts(0, 0)
    disposeGate = __testQueueDisposeGate()

    const first = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(first.booted, true)
    assert.deepEqual(shellModule.__testShellLifecycleOwnerCounts(), { bootGenerations: 1, cancelledBoots: 0 })

    disposeInstanceShell(instanceId)
    assert.equal(await disposeGate.started, 'entry-1')
    replacement = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(
      shellModule.__testShellLifecycleOwnerCounts(),
      { bootGenerations: 1, cancelledBoots: 1 },
      'the old teardown cleanup must retain the current same-id generation and its cancellation barrier',
    )

    disposeGate.release()
    const second = await replacement
    assert.equal(second.booted, true)
    assert.deepEqual(
      shellModule.__testShellLifecycleOwnerCounts(),
      { bootGenerations: 1, cancelledBoots: 0 },
      'the replacement remains owned while its entry is live',
    )
    disposeInstanceShell(instanceId)
    await waitForOwnerCounts(0, 0)

    for (let index = 0; index < 64; index += 1) {
      const churnId = `ssh-test-owner-churn-${index}`
      const state = await bootInstanceShell(churnId, `/api/i/${churnId}`, {} as HTMLElement, () => {})
      assert.equal(state.booted, true)
      disposeInstanceShell(churnId)
    }
    await waitForOwnerCounts(0, 0)
  } finally {
    disposeGate?.release()
    if (replacement !== undefined) await replacement
    disposeInstanceShell(instanceId)
    disposeAllShells()
    __testResetLifecycle()
    restoreFetch()
    restoreWindow()
  }
})

test('openInstanceSession: dispose immediately cancels an active list poll and it can never open later', async (t) => {
  const instanceId = 'ssh-test-dispatch-dispose-11'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    const state = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(state.booted, true)
    __testSetSessionsListed(false)
    const opening = openInstanceSession(instanceId, 'appears-after-dispose')
    const rejected = assert.rejects(opening, /shell disposed/)

    disposeInstanceShell(instanceId)
    await rejected
    __testSetSessionsListed(true)
    t.mock.timers.tick(4_000)
    await Promise.resolve()
    assert.deepEqual(__testOpenedSessions(), [])
  } finally {
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    t.mock.timers.reset()
    restoreFetch()
    restoreWindow()
  }
})

test('openInstanceSession: same-id replacement cancels the old holder poll while the new holder still opens', async (t) => {
  const instanceId = 'ssh-test-dispatch-replacement-12'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    const gen1State = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(gen1State.booted, true)
    __testSetSessionsListed(false)
    const oldOpening = openInstanceSession(instanceId, 'old-holder-session')
    const oldRejected = assert.rejects(oldOpening, /shell replaced by a newer generation/)

    const gen2State = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(gen2State.booted, true)
    await oldRejected

    __testSetSessionsListed(true)
    await openInstanceSession(instanceId, 'new-holder-session')
    t.mock.timers.tick(4_000)
    await Promise.resolve()
    assert.deepEqual(__testOpenedSessions(), [
      { label: 'entry-2', sessionId: 'new-holder-session' },
    ])
  } finally {
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    t.mock.timers.reset()
    restoreFetch()
    restoreWindow()
  }
})

test('openInstanceSession: hostile delayed list/open throws reject instead of stranding the poll', async (t) => {
  const instanceId = 'ssh-test-dispatch-hostile-error'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    const state = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(state.booted, true)

    // First attempt schedules the 400ms poll. The external snapshot then throws
    // from the timer callback with a value that cannot itself be inspected.
    __testSetSessionsListed(false)
    const snapshotOpening = openInstanceSession(instanceId, 'snapshot-hostile')
    const snapshotRejected = assert.rejects(snapshotOpening, /unknown error/)
    __testSetSessionsSnapshotError(hostileThrownValue())
    t.mock.timers.tick(400)
    await snapshotRejected

    // Exercise the independent irreversible open boundary on a later timer
    // attempt; it must reject and clean up the holder-owned cancel handle too.
    __testSetSessionsSnapshotError(undefined)
    __testSetSessionsListed(false)
    const openOpening = openInstanceSession(instanceId, 'open-hostile')
    const openRejected = assert.rejects(openOpening, /unknown error/)
    __testSetSessionsListed(true)
    __testSetSessionsOpenError(hostileThrownValue())
    t.mock.timers.tick(400)
    await openRejected
    assert.deepEqual(__testOpenedSessions(), [])
  } finally {
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    t.mock.timers.reset()
    restoreFetch()
    restoreWindow()
  }
})

test('disposeAllShells: active holder pollers reject and cannot reach sessions.open later', async (t) => {
  const instanceId = 'ssh-test-dispatch-dispose-all-13'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    const state = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(state.booted, true)
    __testSetSessionsListed(false)
    const opening = openInstanceSession(instanceId, 'appears-after-dispose-all')
    const rejected = assert.rejects(opening, /all shells disposed/)

    disposeAllShells()
    await rejected
    __testSetSessionsListed(true)
    t.mock.timers.tick(4_000)
    await Promise.resolve()
    assert.deepEqual(__testOpenedSessions(), [])
  } finally {
    disposeAllShells()
    __testResetLifecycle()
    t.mock.timers.reset()
    restoreFetch()
    restoreWindow()
  }
})

test('openInstanceSession: a late boot flush keeps the original 68s total deadline', async (t) => {
  const instanceId = 'ssh-test-queued-total-deadline-14'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  __testResetLifecycle()
  __testSetSessionsListed(false)
  const runGate = __testQueueRunGate('late-boot')
  let boot: ReturnType<typeof bootInstanceShell> | undefined
  let opening: Promise<void> | undefined
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  console.error = () => {}
  try {
    opening = openInstanceSession(instanceId, 'never-listed-before-total-deadline')
    let settled = false
    void opening.then(() => { settled = true }, () => { settled = true })
    const rejected = assert.rejects(opening, /等待超时/)

    boot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    await runGate.started
    t.mock.timers.tick(67_900)
    runGate.release()
    const state = await boot
    assert.equal(state.booted, true)
    await Promise.resolve()
    assert.equal(settled, false)

    // Only 100ms remains from the enqueue-time 68s budget. flush must not
    // grant a new 8s window (nor even one full 400ms retry interval).
    t.mock.timers.tick(99)
    await Promise.resolve()
    assert.equal(settled, false)
    t.mock.timers.tick(1)
    await rejected
    assert.equal(settled, true)
    assert.deepEqual(__testOpenedSessions(), [])
  } finally {
    runGate.release()
    if (boot !== undefined) await boot
    disposeInstanceShell(instanceId)
    if (opening !== undefined) await Promise.allSettled([opening])
    __testResetLifecycle()
    t.mock.timers.reset()
    console.error = originalConsoleError
    restoreFetch()
    restoreWindow()
  }
})

test('openInstanceSession: a direct dispatch whose sessions service registers after the first attempt still opens', async (t) => {
  const instanceId = 'ssh-test-service-late-direct'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  __testSetSessionsAvailable(false)
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    const state = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(state.booted, true)
    // The holder exists but the runtime sessions service is not registered
    // yet (boot settle waits only on root fibers). The open must stay pending
    // and poll, never fail on the first attempt.
    const opening = openInstanceSession(instanceId, 'late-service-session')
    let settled = false
    void opening.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    assert.equal(settled, false)

    __testSetSessionsAvailable(true)
    t.mock.timers.tick(400)
    await opening
    assert.deepEqual(__testOpenedSessions(), [
      { label: 'entry-1', sessionId: 'late-service-session' },
    ])
  } finally {
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    t.mock.timers.reset()
    restoreFetch()
    restoreWindow()
  }
})

test('openInstanceSession: a queued open flushed before the sessions service registers polls instead of failing instantly', async (t) => {
  const instanceId = 'ssh-test-service-late-flush'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  __testResetLifecycle()
  __testSetSessionsAvailable(false)
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  console.error = () => {}
  let boot: ReturnType<typeof bootInstanceShell> | undefined
  let opening: Promise<void> | undefined
  try {
    // Cold-shell click: the open is queued while the boot is still gated, so
    // the flush (right after entries.set) is the first dispatch attempt.
    const runGate = __testQueueRunGate('slow-boot')
    opening = openInstanceSession(instanceId, 'flushed-before-service')
    let settled = false
    void opening.then(() => { settled = true }, () => { settled = true })
    boot = bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    await runGate.started
    runGate.release()
    const state = await boot
    assert.equal(state.booted, true)
    await Promise.resolve()
    assert.equal(settled, false)

    __testSetSessionsAvailable(true)
    t.mock.timers.tick(400)
    await opening
    assert.equal(settled, true)
    assert.deepEqual(__testOpenedSessions(), [
      { label: 'slow-boot', sessionId: 'flushed-before-service' },
    ])
  } finally {
    if (boot !== undefined) await Promise.allSettled([boot])
    disposeInstanceShell(instanceId)
    if (opening !== undefined) await Promise.allSettled([opening])
    __testResetLifecycle()
    t.mock.timers.reset()
    console.error = originalConsoleError
    restoreFetch()
    restoreWindow()
  }
})

test('openInstanceSession: a sessions service that never registers fails loud at the deadline with the boot-readiness report', async (t) => {
  const instanceId = 'ssh-test-service-never-ready'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  __testResetLifecycle()
  __testSetSessionsAvailable(false)
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  console.error = () => {}
  try {
    const state = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(state.booted, true)
    const opening = openInstanceSession(instanceId, 'never-ready-session')
    const rejected = assert.rejects(opening, /boot 未完全就绪/)
    let settled = false
    void opening.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    // Pins the fail-fast removal: pre-fix code rejected synchronously here,
    // so `settled` would already be true with the same terminal message.
    assert.equal(settled, false)

    // Still polling halfway through the 8s budget — the failure must land on
    // the dispatch's own deadline, not on the first attempt.
    t.mock.timers.tick(4_000)
    await Promise.resolve()
    assert.equal(settled, false)
    t.mock.timers.tick(4_001)
    await rejected
    assert.equal(settled, true)
    assert.deepEqual(__testOpenedSessions(), [])
  } finally {
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    t.mock.timers.reset()
    console.error = originalConsoleError
    restoreFetch()
    restoreWindow()
  }
})

test('openInstanceSession: disposing while the sessions service is still absent cancels the wait and nothing opens later', async (t) => {
  const instanceId = 'ssh-test-service-dispose-wait'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  __testSetSessionsAvailable(false)
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    const state = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(state.booted, true)
    const opening = openInstanceSession(instanceId, 'disposed-while-waiting')
    const rejected = assert.rejects(opening, /shell disposed/)

    disposeInstanceShell(instanceId)
    await rejected
    // The cancelled poller must not survive the holder: even a service that
    // arrives later must never reach sessions.open for the disposed shell.
    __testSetSessionsAvailable(true)
    t.mock.timers.tick(4_000)
    await Promise.resolve()
    assert.deepEqual(__testOpenedSessions(), [])
  } finally {
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    t.mock.timers.reset()
    restoreFetch()
    restoreWindow()
  }
})

test('openInstanceSession: a throwing runtimeCtx read fails loud instantly (distinct from the transient undefined arm)', async (t) => {
  const instanceId = 'ssh-test-service-read-hostile'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  __testResetLifecycle()
  __testSetSessionsReadError(hostileThrownValue())
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  console.error = () => {}
  try {
    const state = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(state.booted, true)
    // A throwing read is terminal on the first attempt (never-throw
    // descriptor); only an UNDEFINED read is the transient poll state.
    const opening = openInstanceSession(instanceId, 'read-hostile-session')
    const rejected = assert.rejects(opening, /unknown error/)
    await Promise.resolve()
    await rejected
    t.mock.timers.tick(4_000)
    await Promise.resolve()
    assert.deepEqual(__testOpenedSessions(), [])
  } finally {
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    t.mock.timers.reset()
    console.error = originalConsoleError
    restoreFetch()
    restoreWindow()
  }
})

test('openInstanceSession: a service that arrives after the first attempt but never lists the session reports 等待超时 at the deadline', async (t) => {
  const instanceId = 'ssh-test-service-late-never-listed'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  __testResetLifecycle()
  __testSetSessionsAvailable(false)
  __testSetSessionsListed(false)
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  console.error = () => {}
  try {
    const state = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(state.booted, true)
    const opening = openInstanceSession(instanceId, 'late-service-never-listed')
    const rejected = assert.rejects(opening, /等待超时/)

    // Attempt 1 saw no service; from attempt 2 on the service exists (so the
    // boot-readiness report must NOT fire) but the session never surfaces.
    __testSetSessionsAvailable(true)
    t.mock.timers.tick(8_001)
    await rejected
    assert.deepEqual(__testOpenedSessions(), [])
  } finally {
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    t.mock.timers.reset()
    console.error = originalConsoleError
    restoreFetch()
    restoreWindow()
  }
})

// ── C3 gate (2026-09 性能审计): the chamber prefetch must fire before the
// extra-row channel is consulted, and its failure is swallowed by the shell
// gate (the loud path is run()'s create-side import; a boot with no extra
// rows never even reaches the gate's await). The fixture now returns the
// module-system face (manifest + prefetch) so these paths are exercised for
// real instead of degrading through a swallowed TypeError.
test('C3 gate: chamber prefetch fires after the module system install and before the boot settles', async () => {
  const instanceId = 'local'
  const restoreFetch = stubReadyGraph()
  __testResetEventLog()
  __testResetLifecycle()
  try {
    const state = await bootInstanceShell(instanceId, '/api/i/local', {} as HTMLElement, () => {})
    assert.equal(state.booted, true)
    const log = __testEventLog()
    assert.ok(log.includes('ensure'), `module system installed first (log: ${log.join(',')})`)
    const prefetchAt = log.indexOf('prefetch:@dsh-chamber/app')
    assert.ok(prefetchAt !== -1, `chamber prefetch fired (log: ${log.join(',')})`)
    assert.ok(prefetchAt > log.indexOf('ensure'), 'prefetch strictly after the module-system install')
  } finally {
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    __testResetEventLog()
    restoreFetch()
  }
})

test('C3 gate: a chamber prefetch rejection is swallowed — the boot still settles (loud owned by create-side import)', async () => {
  const instanceId = 'local'
  const restoreFetch = stubReadyGraph()
  const originalConsoleError = console.error
  console.error = () => {}
  __testResetEventLog()
  __testResetLifecycle()
  try {
    __testSetChamberPrefetchError(new Error('chamber bundle load failed'))
    const state = await bootInstanceShell(instanceId, '/api/i/local', {} as HTMLElement, () => {})
    assert.equal(state.booted, true)
    assert.ok(__testEventLog().includes('prefetch:@dsh-chamber/app'))
  } finally {
    disposeInstanceShell(instanceId)
    __testSetChamberPrefetchError(undefined)
    __testResetLifecycle()
    __testResetEventLog()
    console.error = originalConsoleError
    restoreFetch()
  }
})

test('openInstanceSession: a request superseded by a newer one on the same source resolves quietly and never opens', async (t) => {
  // 2026-12 (design 05 §2.2 revision): per-source open requests are a
  // last-intent-wins stream, and the queued (cold-boot) path is where they can
  // actually race: both clicks land in the pending queue, the settle flush then
  // walks them in FIFO order. The boot-ctx early-open arm has already opened the
  // LATEST intent during boot, so dispatching the abandoned older request would
  // visibly flip the shell back (Y→X→Y). The dispatcher must drop it: resolve
  // quietly (it is not a failure — the row error surface belongs to the newest
  // request) and never call sessions.open for it.
  const instanceId = 'ssh-test-superseded-open'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    // Two clicks on a source that is still booting: both are queued.
    const stale = openInstanceSession(instanceId, 'session-X')
    const fresh = openInstanceSession(instanceId, 'session-Y')
    const state = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(state.booted, true)
    await Promise.all([stale, fresh])
    // The flush dispatches the queue in order; X must be skipped and Y opened.
    // The extra tick proves no stray poller re-opens the abandoned session later.
    t.mock.timers.tick(1_000)
    assert.deepEqual(
      __testOpenedSessions(),
      [{ label: 'entry-1', sessionId: 'session-Y' }],
      'the superseded request must resolve without ever touching the runtime',
    )

    // A repeat of the CURRENT session stays openable (idempotent re-open): the
    // supersession check compares against the last request, not against an
    // "already opened once" marker.
    await openInstanceSession(instanceId, 'session-Y')
    assert.deepEqual(__testOpenedSessions(), [
      { label: 'entry-1', sessionId: 'session-Y' },
      { label: 'entry-1', sessionId: 'session-Y' },
    ])

    // With no newer request in play, a pre-boot queued open still dispatches:
    // the check must never swallow the FIRST request of a source.
    const third = openInstanceSession(instanceId, 'session-Z')
    await third
    assert.deepEqual(__testOpenedSessions().at(-1), { label: 'entry-1', sessionId: 'session-Z' })
  } finally {
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    t.mock.timers.reset()
    restoreFetch()
    restoreWindow()
  }
})

test('openInstanceSession: the supersede record is PER SOURCE — an open on another source never swallows this one', async (t) => {
  // 2026-09-11 review F4(a): the supersede rule is "last intent wins WITHIN one
  // source" (design 05 §2.2 revision). A single page-wide "last requested
  // session" would make two different servers interfere: clicking a session on B
  // while A's cold-boot open is still queued would drop A's request silently at
  // its flush (no error, no row report — the user's click just does nothing).
  // Both requests are queued BEFORE either source boots, so the flush order is
  // the only thing the dispatcher sees and the cross-source mistake is visible.
  const sourceA = 'ssh-test-supersede-per-source-a'
  const sourceB = 'ssh-test-supersede-per-source-b'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    const openA = openInstanceSession(sourceA, 'session-AX')
    const openB = openInstanceSession(sourceB, 'session-BY')
    const stateA = await bootInstanceShell(sourceA, `/api/i/${sourceA}`, {} as HTMLElement, () => {})
    const stateB = await bootInstanceShell(sourceB, `/api/i/${sourceB}`, {} as HTMLElement, () => {})
    assert.equal(stateA.booted, true)
    assert.equal(stateB.booted, true)
    await Promise.all([openA, openB])
    t.mock.timers.tick(1_000)
    assert.deepEqual(
      __testOpenedSessions(),
      [
        { label: 'entry-1', sessionId: 'session-AX' },
        { label: 'entry-2', sessionId: 'session-BY' },
      ],
      'each source must open its OWN requested session; a shared record would drop A as "superseded" by B',
    )
  } finally {
    disposeInstanceShell(sourceA)
    disposeInstanceShell(sourceB)
    __testResetLifecycle()
    t.mock.timers.reset()
    restoreFetch()
    restoreWindow()
  }
})

test('openInstanceSession: the request record is dropped for a same-id re-add — the new incarnation is never judged superseded', async (t) => {
  // 2026-09-11 review F4(b): this is the invariant disposeInstanceShell's own
  // comment states ("a same-id re-add is a new generation, and its first open
  // must not be judged as superseded by the previous incarnation's last
  // request").
  //
  // The record is asserted DIRECTLY (`__testLastRequestedSession`), because the
  // behavior alone cannot see it: every dispatch follows the write of its own
  // request, so the re-added source's first open overwrites the leftover record
  // before the supersede check can compare it. A behavioral-only version of this
  // test passes with the retirement deleted (mutation-verified 2026-09-11) — it
  // would be a lock that proves nothing. The user-visible half (the re-added
  // source's first open still reaches the runtime) is asserted too.
  const instanceId = 'ssh-test-supersede-readd'
  const restoreFetch = stubReadyGraph()
  const restoreWindow = stubWindow()
  __testResetLifecycle()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    const first = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(first.booted, true)
    await openInstanceSession(instanceId, 'session-X')
    assert.equal(
      shellModule.__testLastRequestedSession(instanceId),
      'session-X',
      'a live shell records the session it was asked to open',
    )
    assert.deepEqual(__testOpenedSessions(), [{ label: 'entry-1', sessionId: 'session-X' }])

    // The source leaves the registry and comes back under the SAME id.
    disposeInstanceShell(instanceId)
    assert.equal(
      shellModule.__testLastRequestedSession(instanceId),
      undefined,
      'the record retires with the source — the new incarnation must not inherit the old request',
    )
    const second = await bootInstanceShell(instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {})
    assert.equal(second.booted, true)
    await openInstanceSession(instanceId, 'session-Y')
    assert.deepEqual(
      __testOpenedSessions(),
      [
        { label: 'entry-1', sessionId: 'session-X' },
        { label: 'entry-2', sessionId: 'session-Y' },
      ],
      'the re-added source’s first open must reach the runtime, never be judged against the previous incarnation',
    )
  } finally {
    disposeInstanceShell(instanceId)
    __testResetLifecycle()
    t.mock.timers.reset()
    restoreFetch()
    restoreWindow()
  }
})
