/**
 * Shared transport-manager test harness: the silent logger, the status projection type without a URL
 * leak, the fake ssh child, the manager factory (temporary instances file, fake port probe, injected
 * timings), the askpass-env provider fixture, the shared EXEC_INSTANCE and the ready-then-drop driver.
 * Bare helper file — never registered in scripts/test.mjs.
 */

import type { TestContext } from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import { createTransportManager } from '../../transport-manager.ts'
import type { TransportManagerOptions } from '../../transport-manager.ts'
import type { TransportInstanceInput, TransportInstanceSpec, TransportKind, TransportProvider, TransportStatusProjection, TransportVerifyResult, SpawnedProcess } from '../../transport-provider.ts'
import { sshProvider } from '../../ssh-provider.ts'

export const silentLogger = { log() {}, warn() {}, error() {} }

/**
 * The status projection plus an optional transport-url field: the tests
 * assert the projection never carries a transport URL (design 05 §8 security
 * invariant).
 */
export type StatusWithNoUrlLeak = TransportStatusProjection & { localUrl?: unknown }

/** A fake child_process handle: emits exit/error, records kill calls. */
export class FakeChild extends EventEmitter implements SpawnedProcess {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { write(chunk: string | Buffer): unknown; end(): unknown } | null
  killCalls: string[]
  exitCode: number | null
  signalCode: NodeJS.Signals | null

  constructor() {
    super()
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.stdin = { write: () => true, end: () => {} }
    this.killCalls = []
    this.exitCode = null
    this.signalCode = null
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killCalls.push(signal)
    return true
  }

  /** Test helper: simulate the ssh process exiting (null code = signal death). */
  simulateExit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }

  /** Test helper: emit a spawn error (e.g. the ssh binary is missing). */
  simulateSpawnError(error: Error) {
    this.emit('error', error)
  }

  /** Test helper: write one stderr line. */
  stderrWrite(text: string) {
    this.stderr.emit('data', Buffer.from(text))
  }
}

export function makeManager(t: TestContext, overrides: {
  options?: TransportManagerOptions
  instances?: TransportInstanceInput[]
  random?: () => number
  provider?: TransportProvider
  verifyProbe?: (spec: TransportInstanceSpec, endpoint: { host: string; port: number }) => Promise<TransportVerifyResult>
  allocatePort?: () => Promise<number>
  logger?: { log?(message: string): void; warn?(message: string): void; error?(message: string): void }
  spawnFn?: (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess
  includeDefault?: boolean
} = {}) {
  const spawnCalls: Array<{ command: string; args: readonly string[]; options: SpawnOptions; child: FakeChild }> = []
  const children: FakeChild[] = []
  const spawnTimes: number[] = []
  let probeOk = false
  const instancesFile = join(tempDir(t), 'ssh-instances.json')
  const manager = createTransportManager({
    provider: overrides.provider ?? sshProvider,
    spawnFn: (command, args, options) => {
      if (overrides.spawnFn !== undefined) return overrides.spawnFn(command, args, options)
      const child = new FakeChild()
      spawnCalls.push({ command, args, options, child })
      children.push(child)
      spawnTimes.push(Date.now())
      return child
    },
    instancesFile,
    logger: overrides.logger ?? silentLogger,
    portProbe: async () => probeOk,
    // Fake the provider's own endpoint verification when it has one (the
    // real ssh provider would open a real HTTP connection to the fake
    // tunnel port); providers without verifyUp keep the skip path.
    verifyProbe: overrides.verifyProbe
      ?? ((overrides.provider === undefined || overrides.provider.verifyUp !== undefined)
        ? async () => ({ ok: true })
        : undefined),
    allocatePort: overrides.allocatePort ?? (async () => 43123),
    random: overrides.random,
    options: {
      readyTimeoutMs: 100,
      probeIntervalMs: 5,
      retryBaseMs: 10,
      retryMaxMs: 40,
      maxRetryAttempts: 3,
      disconnectGraceMs: 50,
      ...overrides.options,
    },
  })
  /** Fixture completion: kind+transport are required inputs since the pre-v2
   *  normalization was removed; the harness fixtures are local-dsh-over-ssh. */
  const completeInstance = (input: TransportInstanceInput): TransportInstanceInput => ({
    ...input,
    ...(input.kind === undefined ? { kind: 'dsh' as TransportKind } : {}),
    ...(input.transport === undefined ? { transport: 'ssh' as const } : {}),
  })
  manager.saveInstances([
    ...(overrides.includeDefault === false
      ? []
      : [completeInstance({ id: 's1', label: 'home-server', host: 'home.example.com', user: 'alice', remotePort: 2222 })]),
    ...(overrides.instances ?? []).map(completeInstance),
  ])
  // Dispose after the test: ready-state heartbeat / reconnect timers are
  // unref'd, but a disposed manager cannot keep probing or emitting into
  // later tests of the suite.
  t?.after?.(() => { manager.dispose() })
  return {
    manager,
    spawnCalls,
    children,
    spawnTimes,
    instancesFile,
    setProbe: (ok: boolean) => {
      probeOk = ok
    },
  }
}

/** The manager bundle makeManager returns (for helper signatures). */
export type ManagerHarness = ReturnType<typeof makeManager>

/** A second instance with a managed systemd service, for the exec tests. */
export const EXEC_INSTANCE: TransportInstanceInput = {
  id: 's2', label: 'lab-server', host: 'lab.example.com', user: 'bob', remotePort: 3080, serviceName: 'dsh-chamber',
}

/** Drive s1 to ready, drop its first tunnel and wait for the retry spawn. */
export async function readyThenDrop(harness: ManagerHarness, drop: (child: FakeChild) => void = child => child.simulateExit(0)) {
  harness.setProbe(true)
  harness.manager.connect('s1')
  await waitFor(() => harness.manager.status('s1')!.phase === 'ready')
  harness.setProbe(false)
  drop(harness.children[0])
  await waitFor(() => harness.spawnCalls.length === 2, 3000, 'retry spawn')
}

export function tempDir(t?: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-manager-'))
  t?.after?.(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(5)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** A tunnel provider whose buildStartEnv injects an askpass-style env. */
export const fakeEnvProvider: TransportProvider = {
  validateSpec(input: unknown): TransportInstanceSpec | null {
    if (input === null || typeof input !== 'object') return null
    const record = input as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.label !== 'string'
      || typeof record.host !== 'string' || typeof record.remotePort !== 'number') return null
    if (record.kind !== 'dsh' && record.kind !== 'ssh') return null
    if (record.transport !== 'ssh') return null
    return {
      id: record.id,
      label: record.label,
      kind: 'dsh',
      transport: 'ssh',
      host: record.host,
      user: null,
      sshPort: null,
      remotePort: record.remotePort,
      serviceName: null,
      remoteDshHome: null,
      insecureHttp: false,
    }
  },
  buildStartArgs: (spec, localPort) => ['-N', '-L', `${localPort}:127.0.0.1:${spec.remotePort}`, spec.host],
  buildStartEnv: spec => ({
    env: { SSH_ASKPASS: `/tmp/askpass-${spec.id}`, SSH_ASKPASS_REQUIRE: 'force' },
    release() {},
  }),
  classifyStderr: line => ({ log: line, terminalAuth: false, enoent: false }),
}
