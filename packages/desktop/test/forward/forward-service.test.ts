/**
 * remote-forward-service tests (W0/S1, design 28 §6.1/§7).
 *
 * WHAT IS UNDER TEST. The production assembly module, not the manager (that is
 * forward-manager.test.ts) and not the registrar (forward-ipc.test.ts): the
 * source resolver + identity digest, the namespace/ledger stores (fail-closed
 * loads), the startup reaper pass, the ssh child launcher (argv lockstep,
 * askpass env, bounded stderr classification, idempotent stop, start-time
 * refusal and the durable ledger record), the native authorization gate, the
 * openExternal edge, and the shell-ipc-open-in module singleton.
 *
 * EVERY OS EFFECT IS FAKE. No ssh is spawned, no port is bound, no file is
 * written: the spawn/stop/start-time/ports/probe/storage/edges seams are all
 * injected. The real adapters (net bind/connect, /proc, ps, taskkill, the
 * 0600 private-file writer) are NOT exercised here — TODO(S1/W0) on their real
 * platforms, which this tree cannot provide.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createRemoteForwardService } from '../../remote-forward-service.ts'
import type {
  ForwardServiceStorage,
  ForwardSpawn,
  ForwardSpawnOptions,
  ForwardSpawnProcessHandle,
  RemoteForwardService,
  RemoteForwardServiceOptions,
} from '../../remote-forward-service.ts'
import { buildForwardArgs } from '../../remote-forward-args.ts'
import {
  isForwardListResult,
  isForwardOpenResult,
  isForwardRequestResult,
} from '../../../dsh-chamber-wire/src/forward.ts'
import { IPC_CHANNELS } from '../../ipc-events.ts'
import type { ShellIpcCtx } from '../../shell-ipc-ctx.ts'
import type { NotificationSourceToken } from '../../notifications.ts'
import type {
  ForwardChildRecord,
  ForwardChildRegistryStorage,
  ForwardKillOutcome,
  ForwardKillPlan,
  ForwardKiller,
  ForwardProcessProbe,
} from '../../remote-forward-lifecycle.ts'
import type { ForwardNamespaceStorage } from '../../remote-forward-namespace.ts'
import type { TransportInstanceSpec, TransportSpawnLease } from '../../transport-provider.ts'
import type { ForwardListenerProbe, ForwardPortAllocator } from '../../remote-forward-manager.ts'

const SOURCE_ID = 'dsh-web-1'
const FINGERPRINT = 'a'.repeat(64)
const ROTATED_FINGERPRINT = 'b'.repeat(64)
const SSH_SPEC = { host: 'dev.example.com', user: 'root', sshPort: null } as const

/** Settle queued microtasks/macrotasks (setImmediate bridges used by the launcher). */
async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

/** One owner-only JSON file stand-in (both store adapters share the shape). */
class MemoryFile implements ForwardNamespaceStorage, ForwardChildRegistryStorage {
  text: string | null = null
  failRead = false
  failWrite = false
  ownerOk = true

  async read(): Promise<string | null> {
    if (this.failRead) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    return this.text
  }

  async write(text: string): Promise<void> {
    if (this.failWrite) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
    this.text = text
  }

  async verifyOwner(): Promise<boolean> {
    return this.ownerOk
  }
}

/** A child process double: buffered stderr + buffered exit, listeners attach later. */
class FakeChild implements ForwardSpawnProcessHandle {
  readonly pid: number
  readonly exitListeners: Array<(code: number | null, signal: string | null) => void> = []
  readonly errorListeners: Array<(error: Error) => void> = []
  readonly dataListeners: Array<(chunk: unknown) => void> = []
  private pendingExit: { code: number | null; signal: string | null } | null = null
  private pendingStderr = ''
  readonly stderr: { on(event: 'data', listener: (chunk: unknown) => void): unknown }

  constructor(pid: number) {
    this.pid = pid
    this.stderr = {
      on: (_event: 'data', listener: (chunk: unknown) => void): unknown => {
        this.dataListeners.push(listener)
        if (this.pendingStderr !== '') {
          const buffered = this.pendingStderr
          this.pendingStderr = ''
          listener(buffered)
        }
        return this.stderr
      },
    }
  }

  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(
    event: 'exit' | 'error',
    listener: ((code: number | null, signal: string | null) => void) | ((error: Error) => void),
  ): unknown {
    if (event === 'exit') {
      const exitListener = listener as (code: number | null, signal: string | null) => void
      this.exitListeners.push(exitListener)
      if (this.pendingExit !== null) {
        const pending = this.pendingExit
        this.pendingExit = null
        exitListener(pending.code, pending.signal)
      }
      return this
    }
    this.errorListeners.push(listener as (error: Error) => void)
    return this
  }

  kill(): boolean {
    return true
  }

  /** Emit one stderr chunk (buffered until the launcher attaches its listener). */
  writeStderr(text: string): void {
    if (this.dataListeners.length === 0) {
      this.pendingStderr = (this.pendingStderr + text).slice(-8192)
      return
    }
    for (const listener of this.dataListeners) listener(text)
  }

  /** Emit the exit (buffered until the launcher attaches its listener). */
  exit(code: number | null, signal: string | null = null): void {
    if (this.exitListeners.length === 0) {
      this.pendingExit = { code, signal }
      return
    }
    for (const listener of this.exitListeners) listener(code, signal)
  }
}

/** The spawn double: records argv/options, hands out FakeChild instances. */
class FakeSpawn {
  readonly calls: Array<{ command: string; args: string[]; options: ForwardSpawnOptions }> = []
  readonly children: FakeChild[] = []
  nextPid = 4242
  onLaunch: ((child: FakeChild, attempt: number) => void) | null = null

  readonly spawn: ForwardSpawn = (
    command: string,
    args: readonly string[],
    options: ForwardSpawnOptions,
  ): ForwardSpawnProcessHandle => {
    this.calls.push({ command, args: [...args], options })
    const child = new FakeChild(command === 'ssh' ? this.nextPid : 1)
    if (command === 'ssh') {
      this.nextPid += 1
      this.children.push(child)
    }
    if (command === 'ssh') this.onLaunch?.(child, this.children.length)
    return child
  }

  childByPid(pid: number): FakeChild | undefined {
    return this.children.find(child => child.pid === pid)
  }
}

class FakePorts implements ForwardPortAllocator {
  free = true
  nextEphemeral = 40000
  readonly isFreeCalls: Array<{ host: string; port: number }> = []

  async isFree(host: string, port: number): Promise<boolean> {
    this.isFreeCalls.push({ host, port })
    return this.free
  }

  async ephemeral(_host: string): Promise<number> {
    const port = this.nextEphemeral
    this.nextEphemeral += 1
    return port
  }
}

class FakeProbe {
  reachable = false
  calls = 0

  readonly probe: ForwardListenerProbe = async (): Promise<boolean> => {
    this.calls += 1
    return this.reachable
  }
}

function makeInstance(overrides: Partial<TransportInstanceSpec> = {}): TransportInstanceSpec {
  return {
    id: 'web-1',
    label: 'web-1',
    kind: 'dsh',
    transport: 'ssh',
    host: 'dev.example.com',
    user: 'root',
    sshPort: null,
    remotePort: 17520,
    serviceName: null,
    remoteDshHome: null,
    insecureHttp: false,
    ...overrides,
  }
}

interface RecordedLease {
  readonly env: NodeJS.ProcessEnv
  released: number
}

/**
 * The whole seam bundle behind one fake main process: a mutable registry roster,
 * a live fingerprint table, the edges (dialog/open), and the OS doubles.
 */
class Harness {
  readonly spawn = new FakeSpawn()
  readonly ports = new FakePorts()
  readonly probe = new FakeProbe()
  readonly storage: ForwardServiceStorage = { namespace: new MemoryFile(), ledger: new MemoryFile() }
  readonly instances: TransportInstanceSpec[] = [makeInstance()]
  readonly fingerprints = new Map<string, string>()
  readonly tokens = new Map<string, NotificationSourceToken>()
  readonly handlers = new Map<string, (payload: unknown) => Promise<unknown> | unknown>()
  readonly dialogs: unknown[] = []
  readonly openUrls: string[] = []
  readonly stopCalls: Array<{ pid: number; pgid: number | null }> = []
  readonly leases: RecordedLease[] = []
  sourceRetiredListener: ((sourceId: string) => void) | null = null
  dialogResponse = 0
  dialogThrows = false
  onDialog: (() => void) | null = null
  startTimeResult: string | null = 'linux:12345'
  localDshHome: string | null = '/fake-userdata/state/dsh-home'
  clock = { now: 1000 }
  private ids = 0
  private namespaces = 0

  constructor() {
    this.addSource(SOURCE_ID, FINGERPRINT)
  }

  addSource(sourceId: string, fingerprint: string): void {
    this.fingerprints.set(sourceId, fingerprint)
    this.tokens.set(sourceId, Object.freeze({ sourceId, fingerprint, generation: this.tokens.size + 1 }))
  }

  /** Rotate the incarnation: the registrar/source proof stops matching. */
  rotateFingerprint(): void {
    this.addSource(SOURCE_ID, ROTATED_FINGERPRINT)
  }

  /** Retarget the registry entry behind the same id (identity changes). */
  retarget(host: string): void {
    this.instances[0] = makeInstance({ host })
  }

  /** The registry + proof + edges slice the service reads. */
  ctx(): ShellIpcCtx {
    const deps = {
      ipc: {
        handle: (channel: string, handler: (payload: unknown) => Promise<unknown> | unknown): void => {
          this.handlers.set(channel, handler)
        },
      },
      ctx: {
        localDshHome: this.localDshHome ?? undefined,
        transportManager: {
          listInstances: () => this.instances,
          setSourceRetiredListener: (listener: ((sourceId: string) => void) | null): void => {
            this.sourceRetiredListener = listener
          },
        },
      },
      edges: {
        openExternal: async (url: string): Promise<void> => {
          this.openUrls.push(url)
        },
        showMessage: async (options: unknown): Promise<number> => {
          this.dialogs.push(options)
          this.onDialog?.()
          if (this.dialogThrows) throw new Error('dialog unavailable')
          return this.dialogResponse
        },
      },
    }
    const ctx = {
      deps,
      captureVscodeSource: (instanceId: string): NotificationSourceToken | null => {
        const instance = this.instances.find(candidate => candidate.id === instanceId)
        if (instance === undefined) return null
        return this.tokens.get(instance.kind + '-' + instance.id) ?? null
      },
      matchesNotificationSource: (sourceId: string, fingerprint: string): boolean =>
        this.fingerprints.get(sourceId) === fingerprint,
      ownsNotificationSource: (token: NotificationSourceToken): boolean =>
        this.tokens.get(token.sourceId) === token,
    }
    return ctx as unknown as ShellIpcCtx
  }

  async invoke(channel: string, payload: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (handler === undefined) throw new Error('no handler registered for ' + channel)
    return await handler(payload)
  }

  /** The base service options over the fakes (every test can override one seam). */
  options(overrides: RemoteForwardServiceOptions = {}, useDefaultStop = false): RemoteForwardServiceOptions {
    return {
      storage: this.storage,
      ports: this.ports,
      probe: this.probe.probe,
      spawn: this.spawn.spawn,
      ...(useDefaultStop ? {} : {
        stopProcess: (target: { readonly pid: number; readonly pgid: number | null }): void => {
          this.stopCalls.push({ pid: target.pid, pgid: target.pgid })
          this.spawn.childByPid(target.pid)?.exit(0)
        },
      }),
      startTime: async (): Promise<string | null> => this.startTimeResult,
      authLease: (): TransportSpawnLease => {
        const lease: RecordedLease = {
          env: { SSH_ASKPASS: '/tmp/askpass.sh', SSH_ASKPASS_REQUIRE: 'force' },
          released: 0,
        }
        this.leases.push(lease)
        return { env: lease.env, release: () => { lease.released += 1 } }
      },
      platform: 'linux',
      now: () => this.clock.now,
      mintId: (): string => {
        this.ids += 1
        return 'fwd-' + this.ids.toString(16).padStart(16, '0')
      },
      mintNamespace: (): number => {
        const value = this.namespaces
        this.namespaces += 1
        return value
      },
      probeTimeoutMs: 0,
      probeIntervalMs: 1,
      releaseTimeoutMs: 0,
      reconnect: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
      spawnWindowMs: 0,
      reapOnStart: false,
      ...overrides,
    }
  }

  create(overrides: RemoteForwardServiceOptions = {}, useDefaultStop = false): RemoteForwardService {
    return createRemoteForwardService(this.ctx(), this.options(overrides, useDefaultStop))
  }

  ledgerChildren(): unknown[] {
    const text = (this.storage.ledger as MemoryFile).text
    if (text === null) return []
    const parsed = JSON.parse(text) as { children?: unknown[] }
    return parsed.children ?? []
  }
}

function requestArgs(port = 5173): { sourceId: string; sourceFingerprint: string; port: number } {
  return { sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, port }
}

function listArgs(): { sourceId: string; sourceFingerprint: string } {
  return { sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT }
}

function assertTypedRefusal(result: { ok: boolean; error?: { code: string } }, code: string): void {
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, code)
}

/** The registrar surface a fresh module instance exposes. */
interface FreshRegistrar {
  getOrCreateForwardService(ctx: ShellIpcCtx, options?: RemoteForwardServiceOptions): RemoteForwardService | null
  registerOpenInHandlers(ctx: ShellIpcCtx): void
  disposeForwardService(): Promise<void>
}

/**
 * Import a FRESH module instance of the registrar (a unique query string is a
 * new ESM cache entry), so the module-level singleton can be exercised twice in
 * one process — once for the creation-failure path, once for the successful
 * one. The specifier is a runtime string so the type checker does not try to
 * resolve the query as a file path.
 */
async function importFreshRegistrar(cacheKey: string): Promise<FreshRegistrar> {
  const specifier = '../../shell-ipc-open-in.ts?' + cacheKey
  return await import(specifier) as FreshRegistrar
}

// ---------------------------------------------------------------------------
// 1. Happy path: request -> bound -> list -> openInBrowser -> release -> dispose
// ---------------------------------------------------------------------------

test('service: request binds through the alias, records the child, opens and releases', async () => {
  const h = new Harness()
  h.probe.reachable = true
  const service = h.create()

  const result = await service.request(requestArgs(5173))
  assert.equal(isForwardRequestResult(result), true)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const record = result.record
  assert.equal(record.state, 'bound')
  assert.equal(record.aliasHost, '127.0.0.2')
  assert.equal(record.namespace, 0)
  assert.equal(record.localPort, 5173)
  assert.equal(record.targetPort, 5173)
  assert.equal(record.stale, false)
  assert.equal(record.error, null)

  // argv is the one ssh discipline, and the spawn is shell-free.
  const sshCall = h.spawn.calls.find(call => call.command === 'ssh')
  assert.ok(sshCall)
  assert.deepEqual(sshCall.args, buildForwardArgs(SSH_SPEC, '127.0.0.2', 5173, 5173))
  assert.equal(sshCall.options.shell, false)
  assert.equal(sshCall.options.detached, true)
  assert.equal(sshCall.options.windowsHide, true)
  assert.deepEqual(sshCall.options.stdio, ['ignore', 'ignore', 'pipe'])
  // One askpass lease per child, delivered through the spawn env.
  assert.equal(h.leases.length, 1)
  assert.equal(sshCall.options.env.SSH_ASKPASS, '/tmp/askpass.sh')
  assert.equal(sshCall.options.env.SSH_ASKPASS_REQUIRE, 'force')

  // Native confirmation happened once (the permission is now remembered).
  assert.equal(h.dialogs.length, 1)
  const dialog = h.dialogs[0] as { message: string; detail: string; defaultId: number; cancelId: number }
  assert.match(dialog.message, /dsh-web-1/)
  assert.match(dialog.message, /5173/)
  assert.match(dialog.detail, /root@dev.example.com/)
  assert.match(dialog.detail, /系统浏览器/)
  assert.match(dialog.detail, /本机任何进程/)
  assert.equal(dialog.defaultId, 1, 'cancel is the default button')
  assert.equal(dialog.cancelId, 1)

  // The durable record was committed before the launch was reported.
  const children = h.ledgerChildren() as Array<Record<string, unknown>>
  assert.equal(children.length, 1)
  assert.equal(children[0].forwardId, record.id)
  assert.equal(children[0].pid, 4242)
  assert.equal(children[0].pgid, 4242)
  assert.equal(children[0].startTime, 'linux:12345')

  const list = await service.list(listArgs())
  assert.equal(isForwardListResult(list), true)
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.equal(list.records.length, 1)
  assert.equal(list.limits.perSourceUsed, 1)
  assert.equal(list.limits.globalUsed, 1)

  const opened = await service.openInBrowser({
    sourceId: SOURCE_ID,
    sourceFingerprint: FINGERPRINT,
    id: record.id,
    path: '/app?x=1#frag',
  })
  assert.equal(isForwardOpenResult(opened), true)
  assert.equal(opened.ok, true)
  assert.deepEqual(h.openUrls, ['http://127.0.0.2:5173/app?x=1'])
  assert.equal(h.dialogs.length, 1, 'an already-enabled source is not re-confirmed')

  const released = await service.release({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: record.id })
  assert.equal(released.ok, true)
  assert.equal(h.stopCalls.length, 1)
  assert.equal(h.stopCalls[0].pgid, 4242)
  await settle()
  assert.equal(h.leases[0].released, 1, 'the askpass lease is released exactly once')
  assert.deepEqual(h.ledgerChildren(), [], 'a normal exit removes the ledger record')

  await service.dispose()
  await service.dispose()
  assert.equal(h.stopCalls.length, 1, 'dispose is idempotent once the record is gone')
})

test('enablement is durable across service instances (same source identity)', async () => {
  const h = new Harness()
  h.probe.reachable = true
  const enabledFile = new MemoryFile()
  const storage = { namespace: h.storage.namespace, ledger: h.storage.ledger, enablement: enabledFile }

  const first = h.create({ storage })
  const firstResult = await first.request(requestArgs(5173))
  assert.equal(firstResult.ok, true)
  assert.equal(h.dialogs.length, 1, 'the first service asks once')
  assert.notEqual(enabledFile.text, null, 'the grant is written before it is reported')
  await first.dispose()

  const second = h.create({ storage })
  const secondResult = await second.request(requestArgs(5173))
  assert.equal(secondResult.ok, true)
  if (firstResult.ok && secondResult.ok) {
    assert.equal(secondResult.record.aliasHost, firstResult.record.aliasHost, 'the namespace/store assignment is durable too')
  }
  assert.equal(h.dialogs.length, 1, 'the second service reads the durable enablement and does not re-ask')
  await second.dispose()
})

test('stores: a corrupt enablement file fails closed before any spawn', async () => {
  const h = new Harness()
  h.probe.reachable = true
  const enablement = new MemoryFile()
  enablement.text = '[]'
  const storage = { namespace: h.storage.namespace, ledger: h.storage.ledger, enablement }
  const service = h.create({ storage })
  const result = await service.request(requestArgs(5173))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'forward_failed')
  assert.match(result.error.detail ?? '', /enablement_store_corrupt/)
  assert.equal(h.spawn.calls.length, 0)
  assert.equal(h.dialogs.length, 0)
  await service.dispose()
})

// ---------------------------------------------------------------------------
// 2. Authorization: cancel/throw refuse, grant is remembered, re-proof wins
// ---------------------------------------------------------------------------

test('service: default storage writes owner-only namespace/ledger/enablement', async () => {
  const h = new Harness()
  h.probe.reachable = true
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-forward-store-'))
  try {
    const service = h.create({ dataDir: dir, storage: undefined })
    const requested = await service.request(requestArgs(5173))
    assert.equal(isForwardRequestResult(requested), true)
    assert.equal(requested.ok, true)
    if (!requested.ok) return
    const names = ['remote-browser-namespaces.json', 'forward-children.json', 'remote-browser-enabled.json'] as const
    for (const name of names) {
      const file = path.join(dir, name)
      assert.equal(statSync(file).mode & 0o777, 0o600, name + ' must be owner-only')
    }
    const enablement = JSON.parse(readFileSync(path.join(dir, 'remote-browser-enabled.json'), 'utf8')) as { version?: unknown; entries?: unknown[] }
    assert.equal(enablement.version, 1)
    assert.equal(enablement.entries?.length, 1)
    const released = await service.release({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: requested.record.id })
    assert.equal(released.ok, true)
    await service.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('authorize: cancel refuses without a spawn, a per-port grant is remembered', async () => {
  const cancel = new Harness()
  cancel.probe.reachable = true
  cancel.dialogResponse = 1
  const refused = await cancel.create().request(requestArgs(5173))
  assert.equal(refused.ok, false)
  if (refused.ok) return
  assert.equal(refused.error.code, 'confirmation_declined')
  assert.equal(cancel.spawn.calls.length, 0, 'no child is spawned before the user agreed')

  const failing = new Harness()
  failing.probe.reachable = true
  failing.dialogThrows = true
  const failed = await failing.create().request(requestArgs(5173))
  assert.equal(failed.ok, false)
  if (failed.ok) return
  assert.equal(failed.error.code, 'confirmation_declined')

  const granted = new Harness()
  granted.probe.reachable = true
  const service = granted.create()
  const first = await service.request(requestArgs(5173))
  assert.equal(first.ok, true)
  const second = await service.request(requestArgs(5174))
  assert.equal(second.ok, true)
  assert.equal(granted.dialogs.length, 2, 'a different target port asks again (D9 per-port key)')
  const third = await service.request(requestArgs(5173))
  assert.equal(third.ok, true)
  assert.equal(granted.dialogs.length, 2, 'the same port is remembered without a second dialog')
})

test('authorize: a source retarget during the dialog never grants access', async () => {
  const h = new Harness()
  h.probe.reachable = true
  // The dialog resolves with "confirm", but the incarnation rotated meanwhile.
  h.onDialog = () => h.rotateFingerprint()
  const result = await h.create().request(requestArgs(5173))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'confirmation_late')
  assert.equal(h.spawn.calls.length, 0)
})

// ---------------------------------------------------------------------------
// 3. Gates: http / local / unknown / reserved ports never spawn
// ---------------------------------------------------------------------------

test('a gateway ssh source resolves and forwards like a dsh source', async () => {
  const h = new Harness()
  h.probe.reachable = true
  h.instances[0] = makeInstance({ id: 'gw-1', kind: 'gateway' })
  h.addSource('gateway-gw-1', FINGERPRINT)
  const service = h.create()
  const result = await service.request({ sourceId: 'gateway-gw-1', sourceFingerprint: FINGERPRINT, port: 5173 })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.record.state, 'bound')
  assert.equal(h.spawn.calls.length, 1)
  const list = await service.list({ sourceId: 'gateway-gw-1', sourceFingerprint: FINGERPRINT })
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.equal(list.records.length, 1)
})

test('gate: http, local, unknown and reserved ports never reach a child', async () => {
  const cases: Array<{
    name: string
    instances?: TransportInstanceSpec[]
    /** Canonical source id of the roster row (kind-id), when it differs. */
    sourceId?: string
    args: ReturnType<typeof requestArgs>
    code: string
  }> = [
    {
      name: 'non-registry kind',
      instances: [makeInstance({ kind: 'local', id: 'local-target' })],
      sourceId: 'local-local-target',
      args: { sourceId: 'local-local-target', sourceFingerprint: FINGERPRINT, port: 5173 },
      code: 'source_not_dsh',
    },
    { name: 'http transport', instances: [makeInstance({ transport: 'http' })], args: requestArgs(), code: 'transport_not_ssh' },
    { name: 'unknown source', instances: [], args: requestArgs(), code: 'source_unknown' },
    { name: 'local source id', instances: [], args: { sourceId: 'local', sourceFingerprint: 'local', port: 5173 }, code: 'source_unknown' },
    { name: 'reserved tunnel port', instances: [makeInstance()], args: requestArgs(17520), code: 'target_port_reserved' },
    { name: 'port zero', instances: [makeInstance()], args: requestArgs(0), code: 'target_port_invalid' },
  ]
  for (const testCase of cases) {
    const h = new Harness()
    h.probe.reachable = true
    if (testCase.instances !== undefined) {
      h.instances.length = 0
      h.instances.push(...testCase.instances)
    }
    if (testCase.sourceId !== undefined) h.addSource(testCase.sourceId, FINGERPRINT)
    const result = await h.create().request(testCase.args)
    assert.equal(result.ok, false, testCase.name)
    if (result.ok) continue
    assert.equal(result.error.code, testCase.code, testCase.name)
    assert.equal(h.spawn.calls.length, 0, testCase.name + ': no spawn')
    assert.equal(h.dialogs.length, 0, testCase.name + ': no dialog')
  }
})

// ---------------------------------------------------------------------------
// 4. Source change (fingerprint) and retarget (identity) behaviour
// ---------------------------------------------------------------------------

test('source proof: a rotated fingerprint makes every call refuse', async () => {
  const h = new Harness()
  h.probe.reachable = true
  const service = h.create()
  const bound = await service.request(requestArgs(5173))
  assert.equal(bound.ok, true)
  h.rotateFingerprint()
  const list = await service.list(listArgs())
  assertTypedRefusal(list, 'source_unknown')
  const again = await service.request(requestArgs(5173))
  assertTypedRefusal(again, 'source_unknown')
})

test('retarget: a new identity closes the old child and rotates the alias + confirmation', async () => {
  const h = new Harness()
  h.probe.reachable = true
  const service = h.create()
  const first = await service.request(requestArgs(5173))
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(first.record.aliasHost, '127.0.0.2')

  h.retarget('other.example.com')
  const second = await service.request(requestArgs(5173))
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.equal(second.record.aliasHost, '127.0.0.3', 'a retarget never reuses the retired alias')
  assert.notEqual(second.record.namespace, first.record.namespace)
  assert.equal(h.stopCalls.length, 1, 'the old host child is closed before the new alias is used')
  assert.equal(h.dialogs.length, 2, 'the new identity must be confirmed again')
  const list = await service.list(listArgs())
  assert.equal(list.ok, true)
  if (!list.ok) return
  const stale = list.records.find(record => record.id === first.record.id)
  assert.equal(stale, undefined, 'the previous identity record is gone')
})

// ---------------------------------------------------------------------------
// 5. Stores fail closed (corrupt namespace / ledger never becomes empty state)
// ---------------------------------------------------------------------------

test('stores: a corrupt namespace file refuses every call with a typed forward_failed', async () => {
  const h = new Harness()
  h.probe.reachable = true
  ;(h.storage.namespace as MemoryFile).text = '{not json'
  const service = h.create()
  const result = await service.request(requestArgs(5173))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'forward_failed')
  assert.match(result.error.detail ?? '', /namespace_store_corrupt/)
  const list = await service.list(listArgs())
  assert.equal(list.ok, false)
  const open = await service.openInBrowser({ ...listArgs(), id: 'fwd-0123456789abcdef', path: '/' })
  assert.equal(open.ok, false)
  assert.equal(h.spawn.calls.length, 0)
  assert.equal(h.dialogs.length, 0)
})

test('stores: a corrupt or unreadable child ledger refuses every call', async () => {
  const corrupt = new Harness()
  corrupt.probe.reachable = true
  ;(corrupt.storage.ledger as MemoryFile).text = '{"version":1,"children":"nope"}'
  const result = await corrupt.create().request(requestArgs(5173))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'forward_failed')
  assert.match(result.error.detail ?? '', /child_registry_corrupt/)
  assert.equal(corrupt.spawn.calls.length, 0)

  const unreadable = new Harness()
  unreadable.probe.reachable = true
  ;(unreadable.storage.ledger as MemoryFile).failRead = true
  const failed = await unreadable.create().request(requestArgs(5173))
  assert.equal(failed.ok, false)
  if (failed.ok) return
  assert.match(failed.error.detail ?? '', /child_registry_unavailable/)
  assert.equal(unreadable.spawn.calls.length, 0)
})

// ---------------------------------------------------------------------------
// 6. Child launcher: exit classification, start-time refusal, idempotent stop
// ---------------------------------------------------------------------------

test('launcher: ssh auth failure is classified as auth_failed and keeps the record visible', async () => {
  const h = new Harness()
  h.probe.reachable = false
  h.spawn.onLaunch = (child) => {
    child.writeStderr('root@dev.example.com: Permission denied (publickey).\n')
    child.exit(255)
  }
  const service = h.create({ probeTimeoutMs: 200 })
  const result = await service.request(requestArgs(5173))
  assert.equal(result.ok, true, 'a failed start still returns the displayable record')
  if (!result.ok) return
  assert.equal(result.record.state, 'error')
  assert.equal(result.record.error?.code, 'auth_failed')
  const list = await service.list(listArgs())
  assert.equal(list.ok, true)
  if (!list.ok) return
  assert.equal(list.records[0].state, 'error')
  assert.equal(list.records[0].error?.code, 'auth_failed')
  assert.equal(h.spawn.calls.filter(call => call.command === 'ssh').length, 1)
})

test('launcher: a local bind failure reallocates a fresh ephemeral port', async () => {
  const h = new Harness()
  h.probe.reachable = false
  h.ports.free = false
  h.spawn.onLaunch = (child, attempt) => {
    if (attempt === 1) {
      child.writeStderr('bind [127.0.0.2]:40000: Address already in use\nCould not request local forwarding.\n')
      child.exit(255)
      return
    }
    h.probe.reachable = true
  }
  const service = h.create({ probeTimeoutMs: 200 })
  const result = await service.request(requestArgs(5173))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.record.state, 'bound')
  assert.equal(result.record.localPort, 40001, 'the lost-bind retry never reuses the same port')
  const sshCalls = h.spawn.calls.filter(call => call.command === 'ssh')
  assert.equal(sshCalls.length, 2)
  assert.notEqual(sshCalls[0].args, sshCalls[1].args)
})

test('launcher: an unprovable start time refuses to forward and stops the child', async () => {
  const h = new Harness()
  h.probe.reachable = true
  h.startTimeResult = null
  const service = h.create()
  const result = await service.request(requestArgs(5173))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.record.state, 'error')
  assert.equal(result.record.error?.code, 'forward_failed')
  assert.equal(h.stopCalls.length, 1, 'the unprovable child is stopped')
  assert.deepEqual(h.ledgerChildren(), [], 'an unprovable child is never recorded as a killable leftover')
  assert.equal(h.leases[0].released, 1)
})

test('launcher: stop passes an isAlive guard that closes after the child exits', async () => {
  const h = new Harness()
  h.probe.reachable = true
  let isAlive: (() => boolean) | null = null
  const service = h.create({
    stopProcess: (target, alive): void => {
      isAlive = alive ?? null
      h.spawn.childByPid(target.pid)?.exit(0)
    },
  })
  const requested = await service.request(requestArgs(5173))
  assert.equal(requested.ok, true)
  if (!requested.ok) return
  const released = await service.release({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: requested.record.id })
  assert.equal(released.ok, true)
  const alive = isAlive as (() => boolean) | null
  assert.ok(alive !== null, 'the stop seam receives the live predicate')
  assert.equal(alive(), true, 'the child is live when stop is requested')
  await settle()
  assert.equal(alive(), false, 'after exit the late-SIGKILL guard is closed')
  await service.dispose()
})

test('launcher: stop is idempotent across failure, release and dispose', async () => {
  const h = new Harness()
  h.probe.reachable = false
  h.spawn.onLaunch = (child) => {
    child.writeStderr('Permission denied (publickey).\n')
    child.exit(255)
  }
  const service = h.create({ probeTimeoutMs: 200 })
  const result = await service.request(requestArgs(5173))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(h.stopCalls.length, 1)
  // Releasing the failed record must not stop the same child a second time.
  const released = await service.release({ ...listArgs(), id: result.record.id })
  assert.equal(released.ok, true)
  await service.dispose()
  assert.equal(h.stopCalls.length, 1)
})

test('launcher: win32 uses detached:false, a null pgid and taskkill /T /F', async () => {
  const h = new Harness()
  h.probe.reachable = true
  // No stopProcess override: the platform default runs through the same fake spawn.
  const service = h.create({ platform: 'win32' }, true)
  const result = await service.request(requestArgs(5173))
  assert.equal(result.ok, true)
  if (!result.ok) return
  const sshCall = h.spawn.calls.find(call => call.command === 'ssh')
  assert.ok(sshCall)
  assert.equal(sshCall.options.detached, false)
  const children = h.ledgerChildren() as Array<Record<string, unknown>>
  assert.equal(children[0].pgid, null)
  await service.release({ ...listArgs(), id: result.record.id })
  const taskkill = h.spawn.calls.find(call => call.command === 'taskkill')
  assert.ok(taskkill, 'a win32 stop goes through taskkill')
  assert.deepEqual(taskkill.args, ['/PID', '4242', '/T', '/F'])
})

// ---------------------------------------------------------------------------
// 7. Startup reaper: prove identity or kill nothing
// ---------------------------------------------------------------------------

function seedLedger(h: Harness): ForwardChildRecord {
  const record: ForwardChildRecord = {
    forwardId: 'fwd-0123456789abcdef',
    sourceId: SOURCE_ID,
    pid: 777,
    startTime: 'linux:9',
    argv: buildForwardArgs(SSH_SPEC, '127.0.0.2', 40000, 5173),
    pgid: 777,
    localHost: '127.0.0.2',
    localPort: 40000,
    targetPort: 5173,
    recordedAt: 1,
  }
  ;(h.storage.ledger as MemoryFile).text = JSON.stringify({ version: 1, children: [record] })
  return record
}

test('reaper: a proven leftover is killed and forgotten at startup', async () => {
  const h = new Harness()
  h.probe.reachable = true
  const record = seedLedger(h)
  const killed: ForwardKillPlan[] = []
  const killer: ForwardKiller = {
    async kill(plan: ForwardKillPlan): Promise<ForwardKillOutcome> {
      killed.push(plan)
      return 'killed'
    },
  }
  const probe: ForwardProcessProbe = {
    async inspect(pid: number) {
      return { pid, startTime: 'linux:9', argv: [...record.argv] }
    },
  }
  const service = h.create({ reapOnStart: true, processProbe: probe, killer })
  const list = await service.list(listArgs())
  assert.equal(list.ok, true, 'a reaped ledger still serves forwards')
  assert.deepEqual(killed, [{ pid: 777, pgid: 777 }])
  assert.deepEqual(h.ledgerChildren(), [])
})

test('reaper: an unprovable identity or untrusted ownership kills nothing', async () => {
  const unprovable = new Harness()
  unprovable.probe.reachable = true
  seedLedger(unprovable)
  const killed: ForwardKillPlan[] = []
  const killer: ForwardKiller = {
    async kill(plan: ForwardKillPlan): Promise<ForwardKillOutcome> {
      killed.push(plan)
      return 'killed'
    },
  }
  const probe: ForwardProcessProbe = {
    async inspect(): Promise<never> {
      throw new Error('cannot prove argv on this platform')
    },
  }
  const service = unprovable.create({ reapOnStart: true, processProbe: probe, killer })
  const list = await service.list(listArgs())
  assert.equal(list.ok, true)
  assert.deepEqual(killed, [], 'no kill without proof')
  assert.equal(unprovable.ledgerChildren().length, 1, 'the record survives for the next start')

  const untrusted = new Harness()
  untrusted.probe.reachable = true
  seedLedger(untrusted)
  ;(untrusted.storage.ledger as MemoryFile).ownerOk = false
  const secondKills: ForwardKillPlan[] = []
  const secondKiller: ForwardKiller = {
    async kill(plan: ForwardKillPlan): Promise<ForwardKillOutcome> {
      secondKills.push(plan)
      return 'killed'
    },
  }
  const secondProbe: ForwardProcessProbe = {
    async inspect(pid: number) {
      return { pid, startTime: 'linux:9', argv: buildForwardArgs(SSH_SPEC, '127.0.0.2', 40000, 5173) }
    },
  }
  const second = untrusted.create({ reapOnStart: true, processProbe: secondProbe, killer: secondKiller })
  const secondList = await second.list(listArgs())
  assert.equal(secondList.ok, true)
  assert.deepEqual(secondKills, [], 'an untrusted ledger file authorizes no kill')
  assert.equal(untrusted.ledgerChildren().length, 1)
})

// ---------------------------------------------------------------------------
// 8. shell-ipc-open-in: creation failure stays null, the singleton is reused
// ---------------------------------------------------------------------------

test('shell-ipc-open-in: a construction failure stays null and answers not-assembled', async () => {
  // A fresh module instance so this case cannot reuse the singleton below.
  const fresh = await importFreshRegistrar('creation-failure')
  const h = new Harness()
  h.localDshHome = null
  assert.throws(() => createRemoteForwardService(h.ctx(), {}), /localDshHome/)
  const service = fresh.getOrCreateForwardService(h.ctx())
  assert.equal(service, null)
  fresh.registerOpenInHandlers(h.ctx())
  const result = await h.invoke(IPC_CHANNELS.FORWARD_LIST, listArgs()) as { ok: boolean; error?: { code: string; detail?: string } }
  assertTypedRefusal(result, 'forward_failed')
  assert.equal(result.error?.detail, 'forward ipc service is not assembled')
})

test('shell-ipc-open-in: a source retirement event stops its forwards', async () => {
  const fresh = await importFreshRegistrar('retire-hook')
  const h = new Harness()
  h.probe.reachable = true
  const service = fresh.getOrCreateForwardService(h.ctx(), h.options())
  assert.notEqual(service, null)
  const requested = await service!.request(requestArgs(5173))
  assert.equal(requested.ok, true)
  assert.ok(h.sourceRetiredListener !== null, 'the registrar registered the transport retirement hook')
  h.sourceRetiredListener!(SOURCE_ID)
  await settle()
  assert.equal(h.stopCalls.length, 1, 'retiring the source stopped the live child')
  const listed = await service!.list(listArgs())
  assert.equal(listed.ok, true)
  if (listed.ok) assert.deepEqual(listed.records, [], 'no forward survives source deletion')
  await fresh.disposeForwardService()
})

test('shell-ipc-open-in: disposeForwardService stops the live children once', async () => {
  const fresh = await importFreshRegistrar('dispose')
  const h = new Harness()
  h.probe.reachable = true
  const service = fresh.getOrCreateForwardService(h.ctx(), h.options())
  assert.notEqual(service, null)
  const requested = await service!.request(requestArgs(5173))
  assert.equal(isForwardRequestResult(requested), true)
  assert.equal(requested.ok, true)
  await fresh.disposeForwardService()
  assert.equal(h.stopCalls.length, 1, 'the quit leg stops the live child')
  await fresh.disposeForwardService()
  assert.equal(h.stopCalls.length, 1, 'the quit leg is idempotent')
})

test('shell-ipc-open-in: one service per process, wired to the four channels', async () => {
  const fresh = await importFreshRegistrar('singleton')
  const h = new Harness()
  h.probe.reachable = true
  const created = fresh.getOrCreateForwardService(h.ctx(), h.options())
  assert.notEqual(created, null, 'the assembly produces a real service')
  assert.equal(fresh.getOrCreateForwardService(h.ctx(), h.options()), created, 'the second call reuses the same instance')

  fresh.registerOpenInHandlers(h.ctx())
  assert.ok(h.handlers.has(IPC_CHANNELS.FORWARD_REQUEST))
  assert.ok(h.handlers.has(IPC_CHANNELS.FORWARD_RELEASE))
  assert.ok(h.handlers.has(IPC_CHANNELS.FORWARD_LIST))
  assert.ok(h.handlers.has(IPC_CHANNELS.FORWARD_OPEN_IN_BROWSER))

  const listed = await h.invoke(IPC_CHANNELS.FORWARD_LIST, listArgs())
  assert.equal(isForwardListResult(listed), true)
  assert.equal((listed as { ok: boolean }).ok, true, 'the registrar holds the assembled service, not null')

  const requested = await h.invoke(IPC_CHANNELS.FORWARD_REQUEST, requestArgs(5173))
  assert.equal(isForwardRequestResult(requested), true)
  assert.equal((requested as { ok: boolean }).ok, true)
})
