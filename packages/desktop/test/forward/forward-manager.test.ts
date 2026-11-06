/**
 * RemoteForwardManager behaviour tests (W0/S1, design 28).
 *
 * The manager is the security control point between a renderer payload and an
 * ssh child, so this suite drives the PUBLIC surface only (request/release/
 * list/openInBrowser/retireSource/stopAll) over injected fakes:
 *   - the rejection matrix (local/http, reserved port, invalid port,
 *     unknown source, disabled browser, per-source/global caps);
 *   - ownership: two sources may share the same port only on different alias
 *     hosts; a released (host,port) pair becomes reusable;
 *   - single-flight + idempotency (one child per (source,targetPort));
 *   - the state machine: bind retry (fresh ephemeral port), auth failure,
 *     bounded reconnect after a bound child dies, terminal error records;
 *   - openInBrowser: main-composed URL (scheme + alias + path, fragment
 *     dropped), honest failures, per-source budget, stale/retarget handling;
 *   - retarget/delete teardown closes children (review I2).
 * Wire guards are exercised on every returned payload so the desktop mirror can
 * never drift from the cross-process contract.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  RemoteForwardManager,
  canForwardTransition,
  evaluateForwardGate,
  evaluateForwardSourceGate,
  forwardOpenUrl,
  normalizeForwardPath,
  FORWARD_ERROR_CODES,
  FORWARD_MAX_GLOBAL,
  FORWARD_MAX_PER_SOURCE,
  FORWARD_OPEN_MAX_PER_WINDOW,
  FORWARD_STATES,
} from '../../remote-forward-manager.ts'
import type {
  ForwardChild,
  ForwardChildExit,
  ForwardChildLauncher,
  ForwardLaunchInput,
  ForwardOpenExternal,
  ForwardPortAllocator,
  ForwardRequestArgs,
  ForwardSource,
  ForwardTimers,
} from '../../remote-forward-manager.ts'
import { ForwardNamespaces } from '../../remote-forward-namespace.ts'
import type { ForwardNamespaceStorage } from '../../remote-forward-namespace.ts'
import { buildForwardArgs } from '../../remote-forward-args.ts'
import {
  isForwardListResult,
  isForwardOpenResult,
  isForwardRequestResult,
} from '../../../dsh-chamber-wire/src/forward.ts'

const SOURCE_ID = 'dsh-web-1'
const FINGERPRINT = 'fp-aaaaaaaa'

class MemoryStorage implements ForwardNamespaceStorage {
  text: string | null = null
  failWrite = false
  async read(): Promise<string | null> {
    return this.text
  }
  async write(text: string): Promise<void> {
    if (this.failWrite) throw new Error('EACCES')
    this.text = text
  }
}

class FakeChild implements ForwardChild {
  readonly exit: Promise<ForwardChildExit>
  stopped = false
  killCalls = 0
  /** v2 release drill: a stubborn child ignores stop() until told otherwise. */
  autoExitOnStop = true
  /** v2 release drill: the SIGKILL escalation may or may not settle the child. */
  killResolves = true
  #resolve!: (exit: ForwardChildExit) => void

  constructor() {
    this.exit = new Promise(resolve => {
      this.#resolve = resolve
    })
  }

  stop(): void {
    this.stopped = true
    if (this.autoExitOnStop) this.#resolve({ code: null, signal: 'SIGTERM', authFailed: false, bindFailed: false })
  }

  kill(): void {
    this.killCalls += 1
    if (this.killResolves) this.#resolve({ code: null, signal: 'SIGKILL', authFailed: false, bindFailed: false })
  }

  fail(exit: Partial<ForwardChildExit> = {}): void {
    this.#resolve({ code: 255, signal: null, authFailed: false, bindFailed: false, ...exit })
  }
}

class FakeLauncher implements ForwardChildLauncher {
  readonly launches: ForwardLaunchInput[] = []
  readonly children: FakeChild[] = []
  onLaunch: ((child: FakeChild, attempt: number) => void) | null = null
  throwOnLaunch = false

  async launch(input: ForwardLaunchInput): Promise<ForwardChild> {
    this.launches.push(input)
    if (this.throwOnLaunch) throw new Error('spawn failed')
    const child = new FakeChild()
    this.children.push(child)
    this.onLaunch?.(child, this.launches.length)
    return child
  }
}

class FakePorts implements ForwardPortAllocator {
  free = true
  nextEphemeral = 40_000
  ephemeralThrows = false
  isFreeCalls: Array<{ host: string; port: number }> = []
  ephemeralCalls: string[] = []

  async isFree(host: string, port: number): Promise<boolean> {
    this.isFreeCalls.push({ host, port })
    return this.free
  }

  async ephemeral(host: string): Promise<number> {
    this.ephemeralCalls.push(host)
    if (this.ephemeralThrows) throw new Error('EADDRNOTAVAIL')
    const port = this.nextEphemeral
    this.nextEphemeral += 1
    return port
  }
}

class FakeOpenExternal implements ForwardOpenExternal {
  readonly urls: string[] = []
  outcome: 'ok' | 'fail' | 'throw' = 'ok'

  async openExternal(url: string): Promise<{ ok: true } | { ok: false; detail: string | null }> {
    this.urls.push(url)
    if (this.outcome === 'throw') throw new Error('no browser')
    return this.outcome === 'ok' ? { ok: true } : { ok: false, detail: 'spawn failed' }
  }
}

interface ManualTask {
  fn: () => void
  ms: number
  cancelled: boolean
}

class ManualTimers implements ForwardTimers {
  readonly tasks: ManualTask[] = []
  setTimeout(fn: () => void, ms: number): unknown {
    const task: ManualTask = { fn, ms, cancelled: false }
    this.tasks.push(task)
    return task
  }
  clearTimeout(handle: unknown): void {
    ;(handle as ManualTask).cancelled = true
  }
  async runAll(): Promise<void> {
    for (;;) {
      const task = this.tasks.find(candidate => !candidate.cancelled)
      if (task === undefined) return
      task.cancelled = true
      task.fn()
      await new Promise(resolve => setImmediate(resolve))
    }
  }
}

function makeSource(overrides: Partial<ForwardSource> = {}): ForwardSource {
  return {
    sourceId: SOURCE_ID,
    fingerprint: FINGERPRINT,
    kind: 'dsh',
    transport: 'ssh',
    ssh: { host: 'dev.example.com', user: 'root', sshPort: null },
    remotePort: 17_520,
    identity: 'ident-0001',
    browserEnabled: true,
    ...overrides,
  }
}

interface Harness {
  manager: RemoteForwardManager
  storage: MemoryStorage
  namespaces: ForwardNamespaces
  ports: FakePorts
  launcher: FakeLauncher
  openExternal: FakeOpenExternal
  sources: Map<string, ForwardSource>
  clock: { now: number }
  timers: ManualTimers | null
  authorize: Array<{ sourceId: string; targetPort: number; grant: boolean }>
  grant: { value: boolean }
}

function harness(overrides: {
  probe?: () => boolean
  probeTimeoutMs?: number
  reconnect?: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number }
  timers?: ManualTimers
  clock?: { now: number }
  withAuthorize?: boolean
  spawnWindowMs?: number
  onAuthorize?: () => void
  releaseTimeoutMs?: number
  embedding?: { readonly enabled: boolean; readonly reason?: string }
} = {}): Harness {
  const storage = new MemoryStorage()
  const clock = overrides.clock ?? { now: 1_000 }
  const timers = overrides.timers ?? null
  const namespaces = new ForwardNamespaces({
    storage,
    now: () => clock.now,
    // First namespace is 0 => preferred alias 127.0.0.2 (deterministic vectors).
    mintNamespace: (() => {
      let next = -1
      return () => {
        next += 1
        return next
      }
    })(),
  })
  const sources = new Map<string, ForwardSource>()
  const ports = new FakePorts()
  const launcher = new FakeLauncher()
  const openExternal = new FakeOpenExternal()
  const authorize: Array<{ sourceId: string; targetPort: number; grant: boolean }> = []
  const grant = { value: true }
  let probeState = overrides.probe ?? (() => true)
  let sequence = 0
  const manager = new RemoteForwardManager({
    sources: {
      resolve(sourceId, fingerprint) {
        const source = sources.get(sourceId)
        if (source === undefined || source.fingerprint !== fingerprint) return null
        return source
      },
    },
    namespaces,
    ports,
    probe: async () => probeState(),
    launcher,
    openExternal,
    authorize: overrides.withAuthorize === false
      ? undefined
      : async (source, request) => {
          authorize.push({ sourceId: source.sourceId, targetPort: request.targetPort, grant: grant.value })
          overrides.onAuthorize?.()
          return grant.value
        },
    now: () => clock.now,
    mintId: () => {
      sequence += 1
      return 'fwd-' + sequence.toString(16).padStart(16, '0')
    },
    timers: timers ?? undefined,
    probeTimeoutMs: overrides.probeTimeoutMs ?? 0,
    probeIntervalMs: 1,
    reconnect: overrides.reconnect ?? { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    spawnWindowMs: overrides.spawnWindowMs ?? 0,
    ...(overrides.releaseTimeoutMs === undefined ? {} : { releaseTimeoutMs: overrides.releaseTimeoutMs }),
    ...(overrides.embedding === undefined ? {} : { embedding: overrides.embedding }),
  })
  return { manager, storage, namespaces, ports, launcher, openExternal, sources, clock, timers, authorize, grant }
}

function install(h: Harness, source: ForwardSource = makeSource()): ForwardSource {
  h.sources.set(source.sourceId, source)
  return source
}

async function settle(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

function requestArgs(port: number, overrides: Partial<ForwardRequestArgs> = {}): ForwardRequestArgs {
  return { sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, port, ...overrides }
}

/** Every code path must produce a code from the closed table. */
function assertTypedFailure(result: { ok: boolean; error?: { code: string } }, code: string): void {
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, code)
  assert.ok((FORWARD_ERROR_CODES as readonly string[]).includes(code), 'code outside the closed table: ' + code)
}

test('happy path: bound record, same-port allocation, argv, wire guards', async () => {
  const h = harness()
  const source = install(h)
  const result = await h.manager.request(requestArgs(5173))
  assert.equal(result.ok, true)
  assert.equal(isForwardRequestResult(result), true)
  if (!result.ok) return
  assert.equal(result.record.state, 'bound')
  assert.equal(result.record.aliasHost, '127.0.0.2')
  assert.equal(result.record.localPort, 5173)
  assert.equal(result.record.targetPort, 5173)
  assert.equal(result.record.scheme, 'http')
  assert.equal(result.record.targetHost, '127.0.0.1')
  assert.equal(result.record.stale, false)
  assert.equal(result.record.error, null)
  assert.equal(result.record.boundAt, 1_000)
  assert.equal(h.launcher.launches.length, 1)
  assert.deepEqual(
    [...h.launcher.launches[0].argv],
    buildForwardArgs(source.ssh, '127.0.0.2', 5173, 5173),
  )
  assert.equal(h.ports.isFreeCalls[0].host, '127.0.0.2')

  const list = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(isForwardListResult(list), true)
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.equal(list.records.length, 1)
  assert.equal(list.limits.perSourceUsed, 1)
  assert.equal(list.limits.globalUsed, 1)
  assert.equal(list.limits.perSource, FORWARD_MAX_PER_SOURCE)
  assert.equal(list.limits.global, FORWARD_MAX_GLOBAL)
})

test('a gateway source forwards over its ssh tunnel (same manager path, gateway id)', async () => {
  const h = harness()
  const source = install(h, makeSource({ sourceId: 'gateway-gw-1', kind: 'gateway' }))
  const result = await h.manager.request({
    sourceId: 'gateway-gw-1',
    sourceFingerprint: FINGERPRINT,
    port: 5173,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.record.state, 'bound')
  assert.equal(result.record.namespace, 0)
  assert.equal(h.launcher.launches.length, 1)
  assert.deepEqual(
    [...h.launcher.launches[0].argv],
    buildForwardArgs(source.ssh, '127.0.0.2', 5173, 5173),
  )
  const list = await h.manager.list({ sourceId: 'gateway-gw-1', sourceFingerprint: FINGERPRINT })
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.equal(list.records.length, 1)
  assert.equal(list.records[0].sourceId, 'gateway-gw-1')
})

test('gate matrix: local/http/unknown/reserved/invalid ports never spawn', async () => {
  const cases: Array<{ name: string; source?: ForwardSource; port: number; code: string }> = [
    { name: 'unknown source', source: undefined, port: 5173, code: 'source_unknown' },
    { name: 'non-registry kind', source: makeSource({ kind: 'local' }), port: 5173, code: 'source_not_dsh' },
    { name: 'http transport', source: makeSource({ transport: 'http' }), port: 5173, code: 'transport_not_ssh' },
    { name: 'port 0', port: 0, code: 'target_port_invalid' },
    { name: 'port 65536', port: 65_536, code: 'target_port_invalid' },
    { name: 'fractional port', port: 1024.5, code: 'target_port_invalid' },
    { name: 'NaN port', port: Number.NaN, code: 'target_port_invalid' },
    { name: 'reserved tunnel port', source: makeSource(), port: 17_520, code: 'target_port_reserved' },
  ]
  for (const testCase of cases) {
    const h = harness()
    if (testCase.source !== undefined) install(h, testCase.source)
    const sourceFingerprint = testCase.source?.fingerprint ?? FINGERPRINT
    const result = await h.manager.request({ sourceId: SOURCE_ID, sourceFingerprint, port: testCase.port })
    assertTypedFailure(result, testCase.code)
    assert.equal(h.launcher.launches.length, 0, testCase.name)
    assert.equal(h.ports.isFreeCalls.length, 0, testCase.name)
  }
})

test('source gate helpers are pure and share the vector table', () => {
  assert.equal(evaluateForwardSourceGate(makeSource()), null)
  assert.equal(evaluateForwardSourceGate(makeSource({ kind: 'gateway' })), null, 'gateway+ssh forwards')
  assert.equal(evaluateForwardSourceGate(makeSource({ kind: 'local' }))?.code, 'source_not_dsh')
  assert.equal(evaluateForwardSourceGate(makeSource({ transport: 'http' }))?.code, 'transport_not_ssh')
  assert.equal(evaluateForwardGate(makeSource(), 5173), null)
  assert.equal(evaluateForwardGate(makeSource(), 17_520)?.code, 'target_port_reserved')
  assert.equal(evaluateForwardGate(makeSource(), 0)?.code, 'target_port_invalid')
})

test('https is preserved end to end (never downgraded by the manager)', async () => {
  const h = harness()
  install(h)
  const result = await h.manager.request(requestArgs(8443, { scheme: 'https' }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.record.scheme, 'https')
  const open = await h.manager.openInBrowser({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: result.record.id })
  assert.equal(open.ok, true)
  assert.deepEqual(h.openExternal.urls, ['https://127.0.0.2:8443/'])
})

test('an invalid scheme is refused before allocation', async () => {
  const h = harness()
  install(h)
  // Deliberately outside ForwardScheme: the guard must reject at runtime even
  // when a caller defeats the type. The cast is the test fixture, not the API.
  const result = await h.manager.request(requestArgs(5173, { scheme: 'ftp' as never }))
  assertTypedFailure(result, 'scheme_invalid')
  assert.equal(h.launcher.launches.length, 0)
})

test('disabled browser: no authorize seam => browser_disabled; decline => confirmation_declined', async () => {
  const off = harness({ withAuthorize: false })
  install(off, makeSource({ browserEnabled: false }))
  const denied = await off.manager.request(requestArgs(5173))
  assertTypedFailure(denied, 'browser_disabled')
  assert.equal(off.launcher.launches.length, 0)

  const declining = harness()
  install(declining, makeSource({ browserEnabled: false }))
  declining.grant.value = false
  const declined = await declining.manager.request(requestArgs(5173))
  assertTypedFailure(declined, 'confirmation_declined')
  assert.deepEqual(declining.authorize, [{ sourceId: SOURCE_ID, targetPort: 5173, grant: false }])
  assert.equal(declining.launcher.launches.length, 0)

  const granting = harness()
  install(granting, makeSource({ browserEnabled: false }))
  const granted = await granting.manager.request(requestArgs(5173))
  assert.equal(granted.ok, true)
  assert.deepEqual(granting.authorize, [{ sourceId: SOURCE_ID, targetPort: 5173, grant: true }])
})

test('a source identity change during the dialog is confirmation_late and spawns nothing', async () => {
  const h = harness({
    onAuthorize: () => {
      const source = h.sources.get(SOURCE_ID)
      if (source !== undefined) h.sources.set(SOURCE_ID, { ...source, identity: 'ident-0002' })
    },
  })
  install(h, makeSource({ browserEnabled: false }))
  const result = await h.manager.request(requestArgs(5173))
  assertTypedFailure(result, 'confirmation_late')
  assert.equal(h.launcher.launches.length, 0, 'the stale source never reaches argv/spawn')
})

test('per-port confirmation: a different target port asks again, the same port is reused', async () => {
  const h = harness()
  install(h, makeSource({ browserEnabled: false }))
  const first = await h.manager.request(requestArgs(5173))
  assert.equal(first.ok, true)
  const second = await h.manager.request(requestArgs(5174))
  assert.equal(second.ok, true)
  assert.equal(h.authorize.length, 2, 'D9 keys the confirmation by namespace + targetPort')
  const third = await h.manager.request(requestArgs(5173))
  assert.equal(third.ok, true)
  assert.equal(h.authorize.length, 2, 'an active same-port request is idempotent, not re-confirmed')
})

test('spawn throttle waits one window per source before a second child', async () => {
  const h = harness({ spawnWindowMs: 40 })
  install(h)
  const started = Date.now()
  const first = await h.manager.request(requestArgs(5173))
  const second = await h.manager.request(requestArgs(5174))
  assert.equal(first.ok && second.ok, true)
  assert.equal(h.launcher.launches.length, 2)
  assert.ok(Date.now() - started >= 30, 'the second spawn waited for the 1/2s window')
})

test('three auth failures put the source in a 60s rate-limit cooldown', async () => {
  const h = harness({ probe: () => false, probeTimeoutMs: 100 })
  install(h, makeSource({ browserEnabled: true }))
  h.launcher.onLaunch = (child) => {
    child.fail({ authFailed: true })
  }
  for (const port of [5173, 5174, 5175]) {
    const result = await h.manager.request(requestArgs(port))
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.record.error?.code, 'auth_failed')
  }
  assert.equal(h.launcher.launches.length, 3)
  const blocked = await h.manager.request(requestArgs(5176))
  assert.equal(blocked.ok, true)
  if (blocked.ok) {
    assert.equal(blocked.record.state, 'error')
    assert.equal(blocked.record.error?.code, 'rate_limited')
  }
  assert.equal(h.launcher.launches.length, 3, 'the cooldown prevents a fourth ssh spawn')
})

test('idempotent: a repeated request returns the same record and spawns once', async () => {
  const h = harness()
  install(h)
  const first = await h.manager.request(requestArgs(5173))
  const second = await h.manager.request(requestArgs(5173))
  assert.equal(first.ok && second.ok, true)
  if (!first.ok || !second.ok) return
  assert.equal(first.record.id, second.record.id)
  assert.equal(h.launcher.launches.length, 1)
})

test('single-flight: concurrent identical requests converge on one child', async () => {
  const h = harness()
  install(h)
  const [left, right] = await Promise.all([
    h.manager.request(requestArgs(5173)),
    h.manager.request(requestArgs(5173)),
  ])
  assert.equal(left.ok && right.ok, true)
  if (!left.ok || !right.ok) return
  assert.equal(left.record.id, right.record.id)
  assert.equal(h.launcher.launches.length, 1)
})

test('per-source cap: eight live forwards, the ninth is refused', async () => {
  const h = harness()
  install(h)
  for (let index = 0; index < FORWARD_MAX_PER_SOURCE; index += 1) {
    const result = await h.manager.request(requestArgs(5000 + index))
    assert.equal(result.ok, true, 'forward ' + String(index))
  }
  const ninth = await h.manager.request(requestArgs(5100))
  assertTypedFailure(ninth, 'too_many_for_source')
  assert.equal(h.launcher.launches.length, FORWARD_MAX_PER_SOURCE)
})

test('global cap: thirty-two live forwards, the thirty-third source is refused', async () => {
  const h = harness()
  const perSource = FORWARD_MAX_PER_SOURCE
  const fullSources = Math.ceil(FORWARD_MAX_GLOBAL / perSource)
  const sources = fullSources + 1
  const fingerprintOf = (index: number) => 'fp-' + String(index).padStart(8, '0')
  for (let sourceIndex = 0; sourceIndex < sources; sourceIndex += 1) {
    install(h, makeSource({ sourceId: 'dsh-g' + String(sourceIndex), fingerprint: fingerprintOf(sourceIndex) }))
  }
  let spawned = 0
  for (let sourceIndex = 0; sourceIndex < fullSources; sourceIndex += 1) {
    for (let index = 0; index < perSource; index += 1) {
      const result = await h.manager.request({
        sourceId: 'dsh-g' + String(sourceIndex),
        sourceFingerprint: fingerprintOf(sourceIndex),
        port: 5000 + index,
      })
      assert.equal(result.ok, true)
      spawned += 1
    }
  }
  assert.equal(spawned, FORWARD_MAX_GLOBAL)
  // The extra source has no per-source usage, so the refusal is provably global.
  const overflow = await h.manager.request({
    sourceId: 'dsh-g' + String(fullSources),
    sourceFingerprint: fingerprintOf(fullSources),
    port: 5999,
  })
  assertTypedFailure(overflow, 'too_many_global')
})

test('two sources may share a port only on different alias hosts (global ownership)', async () => {
  const h = harness()
  install(h, makeSource({ sourceId: 'dsh-a', fingerprint: 'fp-aaaaaaaa' }))
  install(h, makeSource({ sourceId: 'dsh-b', fingerprint: 'fp-bbbbbbbb', identity: 'ident-0002' }))
  const a = await h.manager.request({ sourceId: 'dsh-a', sourceFingerprint: 'fp-aaaaaaaa', port: 5173 })
  const b = await h.manager.request({ sourceId: 'dsh-b', sourceFingerprint: 'fp-bbbbbbbb', port: 5173 })
  assert.equal(a.ok && b.ok, true)
  if (!a.ok || !b.ok) return
  assert.equal(a.record.localPort, 5173)
  assert.equal(b.record.localPort, 5173)
  assert.notEqual(a.record.aliasHost, b.record.aliasHost)
})

test('target port below 1024 always gets an ephemeral local port', async () => {
  const h = harness()
  install(h)
  const result = await h.manager.request(requestArgs(80))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.record.localPort, 40_000)
  assert.equal(result.record.targetPort, 80)
  assert.equal(h.ports.ephemeralCalls.length, 1)
  assert.equal(h.launcher.launches[0].argv[h.launcher.launches[0].argv.indexOf('-L') + 1], '127.0.0.2:40000:127.0.0.1:80')
})

test('a lost bind race re-allocates an ephemeral port and retries (not a reconnect)', async () => {
  const h = harness({ probe: (() => {
    let calls = 0
    return () => {
      calls += 1
      return calls > 1
    }
  })() })
  install(h)
  const result = await h.manager.request(requestArgs(5173))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.record.state, 'bound')
  assert.equal(result.record.localPort, 40_000)
  assert.equal(h.launcher.launches.length, 2)
  assert.equal(h.ports.ephemeralCalls.length, 1)
  // The first child was stopped before the retry.
  assert.equal(h.launcher.children[0].stopped, true)
})

test('three lost bind races end in local_bind_failed (terminal, resources released)', async () => {
  const h = harness({ probe: () => false })
  install(h)
  const result = await h.manager.request(requestArgs(5173))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.record.state, 'error')
  assert.equal(result.record.error?.code, 'local_bind_failed')
  assert.equal(h.launcher.launches.length, 3)
  const list = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.equal(list.limits.perSourceUsed, 0, 'an error record never holds a slot')
  assert.equal(list.records[0].state, 'error')
})

test('auth failure before bind is terminal and does not retry', async () => {
  const h = harness({ probe: () => false, probeTimeoutMs: 50 })
  install(h)
  h.launcher.onLaunch = child => child.fail({ authFailed: true })
  const result = await h.manager.request(requestArgs(5173))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.record.state, 'error')
  assert.equal(result.record.error?.code, 'auth_failed')
  assert.equal(h.launcher.launches.length, 1)
})

test('a bound child dying reconnects within the budget', async () => {
  const timers = new ManualTimers()
  const h = harness({ timers, reconnect: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } })
  install(h)
  const result = await h.manager.request(requestArgs(5173))
  assert.equal(result.ok, true)
  if (!result.ok) return

  h.launcher.children[0].fail()
  await settle()
  const list = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.equal(list.records[0].state, 'reconnecting')
  assert.equal(list.records[0].stale, true)

  await timers.runAll()
  await settle()
  assert.equal(h.launcher.launches.length, 2)
  const rebound = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(rebound.ok, true)
  if (!rebound.ok) return
  assert.equal(rebound.records[0].state, 'bound')
  assert.equal(rebound.records[0].stale, false)
})

test('a successful rebind resets the reconnect budget (v2: a later outage gets a full budget)', async () => {
  const timers = new ManualTimers()
  const h = harness({ timers, reconnect: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } })
  install(h)
  await h.manager.request(requestArgs(5173))

  // First outage: the single attempt is spent on a successful rebind.
  h.launcher.children[0].fail()
  await settle()
  await timers.runAll()
  await settle()
  assert.equal(h.launcher.launches.length, 2)
  let list = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.ok(list.ok)
  if (!list.ok) return
  assert.equal(list.records[0].state, 'bound')

  // Second outage in the SAME record: the budget must have been reset on the
  // successful bind, so this is a reconnect again instead of a terminal error.
  h.launcher.children[1].fail()
  await settle()
  list = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.ok(list.ok)
  if (!list.ok) return
  assert.equal(list.records[0].state, 'reconnecting')

  await timers.runAll()
  await settle()
  assert.equal(h.launcher.launches.length, 3)
  list = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.ok(list.ok)
  if (!list.ok) return
  assert.equal(list.records[0].state, 'bound')
})

test('reconnect budget exhaustion is still terminal (no unbounded retry)', async () => {
  const timers = new ManualTimers()
  const h = harness({ timers, reconnect: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } })
  install(h)
  // Every relaunch dies before it can bind, so no successful bind resets the budget.
  h.launcher.onLaunch = (child, attempt) => {
    if (attempt > 1) child.fail()
  }
  await h.manager.request(requestArgs(5173))
  h.launcher.children[0].fail()
  await settle()
  await timers.runAll()
  await settle()
  const list = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.equal(list.records[0].state, 'error')
  assert.equal(list.records[0].error?.code, 'forward_failed')
  assert.equal(h.launcher.launches.length, 2, 'no unbounded retry after the budget')
})

test('auth failure after bound is terminal (no reconnect loop)', async () => {
  const timers = new ManualTimers()
  const h = harness({ timers })
  install(h)
  const result = await h.manager.request(requestArgs(5173))
  assert.equal(result.ok, true)
  if (!result.ok) return
  h.launcher.children[0].fail({ authFailed: true })
  await settle()
  const list = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.equal(list.records[0].state, 'error')
  assert.equal(list.records[0].error?.code, 'auth_failed')
  assert.equal(h.launcher.launches.length, 1)
})

test('openInBrowser: main composes the URL, drops the fragment and reports ok', async () => {
  const h = harness()
  install(h)
  const result = await h.manager.request(requestArgs(5173))
  assert.equal(result.ok, true)
  if (!result.ok) return
  const open = await h.manager.openInBrowser({
    sourceId: SOURCE_ID,
    sourceFingerprint: FINGERPRINT,
    id: result.record.id,
    path: '/app?x=1#section',
  })
  assert.equal(open.ok, true)
  assert.equal(isForwardOpenResult(open), true)
  assert.deepEqual(h.openExternal.urls, ['http://127.0.0.2:5173/app?x=1'])
  assert.equal(forwardOpenUrl(result.record, '/app'), 'http://127.0.0.2:5173/app')
})

test('openInBrowser refuses non-bound / unknown / stale records', async () => {
  const h = harness()
  install(h)
  const result = await h.manager.request(requestArgs(5173))
  assert.equal(result.ok, true)
  if (!result.ok) return

  assertTypedFailure(await h.manager.openInBrowser({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: 'fwd-ffffffffffffffff' }), 'forward_not_found')

  install(h, makeSource({ fingerprint: 'fp-bbbbbbbb', identity: 'ident-0002' }))
  assertTypedFailure(await h.manager.openInBrowser({ sourceId: SOURCE_ID, sourceFingerprint: 'fp-bbbbbbbb', id: result.record.id }), 'forward_stale')
  assert.equal(h.openExternal.urls.length, 0)
})

test('openInBrowser refusal matrix: state, path and browser failures', async () => {
  const failing = harness()
  install(failing)
  const bound = await failing.manager.request(requestArgs(5173))
  assert.equal(bound.ok, true)
  if (!bound.ok) return

  for (const path of ['//evil.com/x', 'mailto:dev@example.com', '/a%0d%0ab', 42, 'http://127.0.0.1:9/x', 'x'.repeat(2049)]) {
    const result = await failing.manager.openInBrowser({
      sourceId: SOURCE_ID,
      sourceFingerprint: FINGERPRINT,
      id: bound.record.id,
      path: path as string,
    })
    assertTypedFailure(result, 'invalid_path')
  }
  assert.equal(failing.openExternal.urls.length, 0, 'invalid paths never reach the OS')

  failing.openExternal.outcome = 'fail'
  assertTypedFailure(await failing.manager.openInBrowser({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: bound.record.id }), 'open_failed')
  failing.openExternal.outcome = 'throw'
  assertTypedFailure(await failing.manager.openInBrowser({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: bound.record.id }), 'open_failed')

  const notBound = harness()
  install(notBound)
  const failingChild = await notBound.manager.request(requestArgs(5173))
  assert.equal(failingChild.ok, true)
  if (!failingChild.ok) return
  notBound.launcher.children[0].fail({ authFailed: true })
  await settle()
  assertTypedFailure(await notBound.manager.openInBrowser({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: failingChild.record.id }), 'forward_not_bound')
})

test('openInBrowser re-proves the source after its dialog', async () => {
  const h = harness({
    onAuthorize: () => {
      const source = h.sources.get(SOURCE_ID)
      if (source !== undefined) h.sources.set(SOURCE_ID, { ...source, identity: 'ident-0002' })
    },
  })
  install(h, makeSource({ browserEnabled: true }))
  const requested = await h.manager.request(requestArgs(5173))
  assert.equal(requested.ok, true)
  if (!requested.ok) return
  const source = h.sources.get(SOURCE_ID)!
  h.sources.set(SOURCE_ID, { ...source, browserEnabled: false })
  const opened = await h.manager.openInBrowser({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: requested.record.id })
  assertTypedFailure(opened, 'confirmation_late')
  assert.deepEqual(h.openExternal.urls, [], 'the stale source never reaches the OS open')
})

test('openInBrowser has a per-source budget, independent of other sources', async () => {
  const clock = { now: 1_000 }
  const h = harness({ clock })
  install(h)
  const result = await h.manager.request(requestArgs(5173))
  assert.equal(result.ok, true)
  if (!result.ok) return
  for (let index = 0; index < FORWARD_OPEN_MAX_PER_WINDOW; index += 1) {
    const open = await h.manager.openInBrowser({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: result.record.id })
    assert.equal(open.ok, true, 'open ' + String(index))
  }
  assertTypedFailure(await h.manager.openInBrowser({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: result.record.id }), 'rate_limited')
  clock.now += 60_001
  const restored = await h.manager.openInBrowser({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: result.record.id })
  assert.equal(restored.ok, true)
})

test('release closes the child, removes the record and frees the (host,port) pair', async () => {
  const h = harness()
  install(h)
  const first = await h.manager.request(requestArgs(5173))
  assert.equal(first.ok, true)
  if (!first.ok) return
  const released = await h.manager.release({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: first.record.id })
  assert.deepEqual(released, { ok: true })
  assert.equal(h.launcher.children[0].stopped, true)
  const list = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.deepEqual(list.records, [])
  assert.equal(list.limits.perSourceUsed, 0)

  const second = await h.manager.request(requestArgs(5173))
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.equal(second.record.localPort, 5173, 'the released same-port pair is reusable')
})

test('release refuses an id that belongs to another source', async () => {
  const h = harness()
  install(h, makeSource({ sourceId: 'dsh-a', fingerprint: 'fp-aaaaaaaa' }))
  install(h, makeSource({ sourceId: 'dsh-b', fingerprint: 'fp-bbbbbbbb', identity: 'ident-0002' }))
  const result = await h.manager.request({ sourceId: 'dsh-a', sourceFingerprint: 'fp-aaaaaaaa', port: 5173 })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const released = await h.manager.release({ sourceId: 'dsh-b', sourceFingerprint: 'fp-bbbbbbbb', id: result.record.id })
  assertTypedFailure(released, 'forward_not_found')
})

test('retarget closes the old forwards and rotates the alias (review I2)', async () => {
  const h = harness()
  install(h)
  const first = await h.manager.request(requestArgs(5173))
  assert.equal(first.ok, true)
  if (!first.ok) return

  install(h, makeSource({ fingerprint: 'fp-bbbbbbbb', identity: 'ident-0002', ssh: { host: 'new.example.com', user: 'root', sshPort: null } }))
  const second = await h.manager.request({ sourceId: SOURCE_ID, sourceFingerprint: 'fp-bbbbbbbb', port: 5173 })
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.equal(h.launcher.children[0].stopped, true, 'the old host tunnel is gone')
  assert.notEqual(second.record.aliasHost, first.record.aliasHost)
  assert.notEqual(second.record.namespace, first.record.namespace)
  const list = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: 'fp-bbbbbbbb' })
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.equal(list.records.length, 1)
  assert.equal(list.records[0].id, second.record.id)
})

test('retireSource closes every forward and retires the alias', async () => {
  const h = harness()
  install(h)
  await h.manager.request(requestArgs(5173))
  await h.manager.request(requestArgs(5174))
  const retired = await h.manager.retireSource(SOURCE_ID)
  assert.deepEqual(retired, { released: 2, namespaceRetired: true })
  assert.equal(h.launcher.children.every(child => child.stopped), true)
  const list = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.deepEqual(list.records, [])
})

test('a source removed while its forward is starting leaves no listener behind', async () => {
  const h = harness()
  install(h)
  // Remove the source while #start owns the await (the child is already spawning):
  // retireSource can only close the records that existed when it ran.
  h.launcher.onLaunch = () => { h.sources.delete(SOURCE_ID) }
  const result = await h.manager.request(requestArgs(5173))
  assertTypedFailure(result, 'source_changed')
  assert.equal(h.launcher.children.length, 1)
  assert.equal(h.launcher.children[0].stopped, true, 'the late-created listener must be closed')
})

test('stopAll closes everything (app exit)', async () => {
  const h = harness()
  install(h)
  install(h, makeSource({ sourceId: 'dsh-b', fingerprint: 'fp-bbbbbbbb', identity: 'ident-0002' }))
  await h.manager.request({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, port: 5173 })
  await h.manager.request({ sourceId: 'dsh-b', sourceFingerprint: 'fp-bbbbbbbb', port: 5173 })
  await h.manager.stopAll()
  assert.equal(h.launcher.children.every(child => child.stopped), true)
  const list = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.deepEqual(list.records, [])
})

test('stopAll closes every live record, not only the first', async () => {
  const h = harness()
  install(h)
  for (const port of [5173, 5174, 5175, 5176]) {
    const result = await h.manager.request(requestArgs(port))
    assert.equal(result.ok, true)
  }
  assert.equal(h.launcher.launches.length, 4)
  await h.manager.stopAll()
  assert.equal(h.launcher.children.every(child => child.stopped), true)
  const listed = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(listed.ok, true)
  if (listed.ok) assert.deepEqual(listed.records, [])
})

test('list/open reject a stale fingerprint', async () => {
  const h = harness()
  install(h)
  assertTypedFailure(await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: 'fp-zzzzzzzz' }), 'source_unknown')
  assertTypedFailure(await h.manager.openInBrowser({ sourceId: SOURCE_ID, sourceFingerprint: 'fp-zzzzzzzz', id: 'fwd-ffffffffffffffff' }), 'source_unknown')
})

test('normalizeForwardPath is a same-origin normalizer, not a string prefix check', () => {
  const accepted: Array<[unknown, string]> = [
    [undefined, '/'],
    [null, '/'],
    ['', '/'],
    ['/', '/'],
    ['/a//b', '/a//b'],
    ['a/b', '/a/b'],
    ['/app?x=1#frag', '/app?x=1'],
    ['/a?x=1&y=2', '/a?x=1&y=2'],
  ]
  for (const [raw, expected] of accepted) {
    assert.deepEqual(normalizeForwardPath(raw), { ok: true, path: expected }, String(raw))
  }
  for (const raw of ['//evil.com/x', 'http://evil.com/x', 'https://127.0.0.1:5173/x', 'mailto:a@b', 'javascript:alert(1)', '/a%0d%0ab', '/a\u0000b', 42, {}, 'x'.repeat(2049)]) {
    assert.deepEqual(normalizeForwardPath(raw), { ok: false }, String(raw))
  }
})

test('allocation failures are typed refusals and leave no record/ownership behind', async () => {
  const exhausted = harness()
  exhausted.ports.ephemeralThrows = true
  install(exhausted)
  const noPort = await exhausted.manager.request(requestArgs(80))
  assertTypedFailure(noPort, 'port_exhausted')
  assert.equal(exhausted.launcher.launches.length, 0)
  const empty = await exhausted.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(empty.ok, true)
  if (!empty.ok) return
  assert.deepEqual(empty.records, [])

  const brokenStore = harness()
  brokenStore.storage.failWrite = true
  install(brokenStore)
  const noNamespace = await brokenStore.manager.request(requestArgs(5173))
  assertTypedFailure(noNamespace, 'namespace_unavailable')
  assert.equal(brokenStore.launcher.launches.length, 0)
})

test('a launcher that throws ends in forward_failed without leaking a slot', async () => {
  const h = harness()
  install(h)
  h.launcher.throwOnLaunch = true
  const result = await h.manager.request(requestArgs(5173))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.record.state, 'error')
  assert.equal(result.record.error?.code, 'forward_failed')
  const list = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.equal(list.limits.perSourceUsed, 0)
  h.launcher.throwOnLaunch = false
  const retried = await h.manager.request(requestArgs(5173))
  assert.equal(retried.ok, true)
  if (!retried.ok) return
  assert.equal(retried.record.state, 'bound')
})

test('a registry host the argv builder refuses fails the record, not the process', async () => {
  const h = harness()
  install(h, makeSource({ ssh: { host: 'bad host', user: 'root', sshPort: null } }))
  const result = await h.manager.request(requestArgs(5173))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.record.state, 'error')
  assert.equal(result.record.error?.code, 'forward_failed')
  assert.equal(h.launcher.launches.length, 0)
})

test('the transition table is total and documents every state', () => {
  assert.deepEqual([...FORWARD_STATES], ['requested', 'starting', 'bound', 'reconnecting', 'closing', 'closed', 'error'])
  assert.equal(canForwardTransition('requested', 'starting'), true)
  assert.equal(canForwardTransition('starting', 'bound'), true)
  assert.equal(canForwardTransition('bound', 'reconnecting'), true)
  assert.equal(canForwardTransition('closing', 'closed'), true)
  assert.equal(canForwardTransition('bound', 'starting'), false)
  assert.equal(canForwardTransition('closed', 'bound'), false)
})

// ---------------------------------------------------------------------------
// v2: consumer refcount, revoke, frameUrl, release hardening, frameError
// ---------------------------------------------------------------------------

const CONSUMER_A = 'consumer-aaaaaaa1'
const CONSUMER_B = 'consumer-bbbbbbb2'

function releaseArgs(id: string, consumer?: string): { sourceId: string; sourceFingerprint: string; id: string; consumer?: string } {
  return { sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id, ...(consumer === undefined ? {} : { consumer }) }
}

test('v2: an attached bound request carries the main-composed frameUrl (path normalized)', async () => {
  const h = harness()
  install(h)
  const result = await h.manager.request(requestArgs(5173, { consumer: CONSUMER_A, path: '/app?x=1#frag' }))
  assert.equal(result.ok, true)
  assert.equal(isForwardRequestResult(result), true)
  if (!result.ok) return
  // Main composes scheme://alias:localPort + normalized path; the fragment is dropped.
  assert.equal(result.frameUrl, 'http://127.0.0.2:5173/app?x=1')

  const pinned = await h.manager.request(requestArgs(5173))
  assert.equal(pinned.ok, true)
  if (!pinned.ok) return
  assert.equal(pinned.frameUrl, undefined, 'a pinned (no consumer) request carries no frameUrl')
  assert.equal(h.launcher.launches.length, 1, 'the pinned request attached to the same listener')
})

test('v2: two consumers share one listener; only the last detach closes it', async () => {
  const h = harness()
  install(h)
  const first = await h.manager.request(requestArgs(5173, { consumer: CONSUMER_A }))
  assert.equal(first.ok, true)
  if (!first.ok) return
  const shared = await h.manager.request(requestArgs(5173, { consumer: CONSUMER_B }))
  assert.equal(shared.ok, true)
  if (!shared.ok) return
  assert.equal(shared.record.id, first.record.id, 'attach-first reuses the record')
  assert.equal(h.launcher.launches.length, 1)
  const child = h.launcher.children[0]

  // A refresh of the same consumer is idempotent.
  await h.manager.request(requestArgs(5173, { consumer: CONSUMER_A }))

  const detachA = await h.manager.release(releaseArgs(first.record.id, CONSUMER_A))
  assert.deepEqual(detachA, { ok: true })
  assert.equal(child.stopped, false, 'one live consumer keeps the listener')
  const list = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.equal(list.records.length, 1)
  assert.equal(list.records[0].state, 'bound')

  // Detaching an already-detached consumer is a no-op success.
  assert.deepEqual(await h.manager.release(releaseArgs(first.record.id, CONSUMER_A)), { ok: true })
  assert.equal(child.stopped, false)

  assert.deepEqual(await h.manager.release(releaseArgs(first.record.id, CONSUMER_B)), { ok: true })
  assert.equal(child.stopped, true)
  assert.equal((await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })).ok, true)
  const gone = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.ok(gone.ok)
  if (!gone.ok) return
  assert.equal(gone.records.length, 0, 'the last consumer detach removed the record')
})

test('v2: a force-close drops every consumer and a detach of the gone record is idempotent', async () => {
  const h = harness()
  install(h)
  const created = await h.manager.request(requestArgs(5173, { consumer: CONSUMER_A }))
  assert.equal(created.ok, true)
  if (!created.ok) return
  await h.manager.request(requestArgs(5173, { consumer: CONSUMER_B }))

  assert.deepEqual(await h.manager.release(releaseArgs(created.record.id)), { ok: true })
  assert.equal(h.launcher.children[0].stopped, true)
  // Both consumers were discarded with the record; late detaches stay successful.
  assert.deepEqual(await h.manager.release(releaseArgs(created.record.id, CONSUMER_A)), { ok: true })
  assert.deepEqual(await h.manager.release(releaseArgs(created.record.id, CONSUMER_B)), { ok: true })
  // A v1 force-close of an unknown id keeps the honest refusal.
  assertTypedFailure(await h.manager.release(releaseArgs(created.record.id)), 'forward_not_found')
})

test('v2: the idempotency key includes the scheme (http and https never share a child)', async () => {
  const h = harness()
  install(h)
  const http = await h.manager.request(requestArgs(5173, { consumer: CONSUMER_A }))
  const https = await h.manager.request(requestArgs(5173, { consumer: CONSUMER_B, scheme: 'https' }))
  assert.equal(http.ok && https.ok, true)
  if (!http.ok || !https.ok) return
  assert.notEqual(https.record.id, http.record.id)
  assert.equal(https.record.scheme, 'https')
  assert.equal(h.launcher.launches.length, 2)
  assert.equal(https.frameUrl, 'https://127.0.0.2:40000/', 'the https frame URL keeps its scheme')
})

test('v2: revokeAttached closes consumer-held records only, pinned records stay', async () => {
  const h = harness()
  install(h)
  // Pinned (system-browser leg): no consumer, must survive a renderer revoke.
  const pinned = await h.manager.request(requestArgs(5173))
  assert.equal(pinned.ok, true)
  const attached = await h.manager.request(requestArgs(8080, { consumer: CONSUMER_A }))
  assert.equal(attached.ok, true)
  if (!pinned.ok || !attached.ok) return

  assert.equal(await h.manager.revokeAttached(), 1)
  assert.equal(h.launcher.children[1].stopped, true)
  assert.equal(h.launcher.children[0].stopped, false)
  const list = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.deepEqual(list.records.map(record => record.id), [pinned.record.id])
  // Revoke is idempotent.
  assert.equal(await h.manager.revokeAttached(), 0)
})

test('v2: a revoke during the native confirmation wins over the in-flight create', async () => {
  let revokeCount = 0
  // The dialog is the long await the revokeGeneration guard protects: a
  // renderer reload while it is open must leave no listener behind.
  const h = harness({
    withAuthorize: true,
    onAuthorize: () => {
      void h.manager.revokeAttached().then(count => { revokeCount += count })
    },
  })
  install(h, makeSource({ browserEnabled: false }))
  const result = await h.manager.request(requestArgs(5173, { consumer: CONSUMER_A }))
  assertTypedFailure(result, 'forward_stale')
  assert.equal(h.launcher.launches.length, 0)
  await settle()
  assert.equal(revokeCount, 0, 'no consumer-held record existed when the dialog opened')
})

test('v2: preferredLocalPort reuses the bound port when the same target is reopened', async () => {
  const h = harness()
  install(h)
  const first = await h.manager.request(requestArgs(80, { consumer: CONSUMER_A }))
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(first.record.localPort, 40_000, 'a privileged target gets an ephemeral local port')
  await h.manager.release(releaseArgs(first.record.id, CONSUMER_A))
  assert.equal(h.ports.ephemeralCalls.length, 1)

  const reopened = await h.manager.request(requestArgs(80, { consumer: CONSUMER_B }))
  assert.equal(reopened.ok, true)
  if (!reopened.ok) return
  assert.equal(reopened.record.localPort, 40_000, 'the earlier local port is preferred')
  assert.equal(h.ports.ephemeralCalls.length, 1, 'no new ephemeral allocation')
})

test('v2: release escalates to SIGKILL and keeps a release_timeout record for retry', async () => {
  const timers = new ManualTimers()
  const h = harness({ timers, releaseTimeoutMs: 2_000 })
  install(h)
  const created = await h.manager.request(requestArgs(5173, { consumer: CONSUMER_A }))
  assert.equal(created.ok, true)
  if (!created.ok) return
  const child = h.launcher.children[0]
  child.autoExitOnStop = false
  child.killResolves = false

  const releasing = h.manager.release(releaseArgs(created.record.id, CONSUMER_A))
  await settle()
  await timers.runAll()
  const result = await releasing
  assertTypedFailure(result, 'release_timeout')
  assert.equal(child.killCalls, 1, 'the graceful stop was escalated once')

  const list = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.equal(list.records.length, 1, 'the unproven-dead record is kept')
  assert.equal(list.records[0].state, 'error')
  assert.equal(list.records[0].error?.code, 'release_timeout')

  // The child finally exits: the late-exit watcher forgets the record.
  child.fail()
  await settle()
  const after = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(after.ok, true)
  if (!after.ok) return
  assert.equal(after.records.length, 0)
})

test('v2: a release retry on a release_timeout record closes once the child exits', async () => {
  const timers = new ManualTimers()
  const h = harness({ timers, releaseTimeoutMs: 500 })
  install(h)
  const created = await h.manager.request(requestArgs(5173))
  assert.equal(created.ok, true)
  if (!created.ok) return
  const child = h.launcher.children[0]
  child.autoExitOnStop = false
  child.killResolves = false

  const first = h.manager.release(releaseArgs(created.record.id))
  await settle()
  await timers.runAll()
  assertTypedFailure(await first, 'release_timeout')

  const retry = h.manager.release(releaseArgs(created.record.id))
  await settle()
  child.fail() // the second attempt observes the exit
  const result = await retry
  assert.deepEqual(result, { ok: true })
  const list = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.equal(list.records.length, 0)
})

test('v2: frameError projection patches by alias origin and clears on rebind', async () => {
  const h = harness()
  install(h)
  const created = await h.manager.request(requestArgs(5173, { consumer: CONSUMER_A }))
  assert.equal(created.ok, true)
  if (!created.ok) return

  assert.equal(h.manager.noteFrameErrorForUrl('http://127.0.0.2:5173/app', 'blocked_by_response'), 1)
  const list = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.equal(list.records[0].frameError, 'blocked_by_response')
  assert.equal(isForwardListResult(list), true, 'the wire guard accepts frameError')

  assert.equal(h.manager.noteFrameErrorForUrl('http://127.0.0.9:5173/app', 'load_failed'), 0)
  assert.equal(h.manager.noteFrameErrorForUrl('not a url', 'load_failed'), 0)
  // Runtime guard matrix: a forged code reaches the manager as never-typed input.
  assert.equal(h.manager.noteFrameErrorForUrl('http://127.0.0.2:5173/', 'not-a-code' as never), 0)
  assert.equal(h.manager.noteFrameErrorForUrl('http://127.0.0.2:5173/', null), 1)
  const cleared = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(cleared.ok, true)
  if (!cleared.ok) return
  assert.equal(cleared.records[0].frameError, null)
})

test('v2: list carries the embedding capability (default enabled, rollback visible)', async () => {
  const h = harness()
  install(h)
  await h.manager.request(requestArgs(5173))
  const enabled = await h.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(enabled.ok, true)
  if (!enabled.ok) return
  assert.deepEqual(enabled.embedding, { enabled: true })

  const rolled = harness({ embedding: { enabled: false, reason: 'emergency_rollback' } })
  install(rolled)
  await rolled.manager.request(requestArgs(5173))
  const disabled = await rolled.manager.list({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT })
  assert.equal(disabled.ok, true)
  if (!disabled.ok) return
  assert.deepEqual(disabled.embedding, { enabled: false, reason: 'emergency_rollback' })
})
