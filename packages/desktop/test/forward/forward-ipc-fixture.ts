/**
 * Shared harness for the remote-browser forward IPC suites (design 28 §7).
 *
 * NOT a *.test.ts file: the desktop manifest guard judges test files only, and
 * this module exists so forward-ipc / forward-open / forward-log-redaction drive
 * the SAME fake context (the registrar's proof chain is the behaviour under
 * test, not the fixture).
 *
 * The fake mirrors the production seams the registrar actually reads:
 *   - deps.ipc.handle            → the registration table (channel, handler);
 *   - deps.ctx.transportManager  → listInstances() over a mutable roster;
 *   - matchesNotificationSource  → the live fingerprint table;
 *   - captureVscodeSource        → `<kind>-<id>` incarnation capture;
 *   - ownsNotificationSource     → token-identity ownership.
 * `retire()` rotates the incarnation behind the registrar's back (retarget or
 * source replacement during an await), which is exactly what the post-await
 * re-proof must catch.
 */
import type { ShellIpcCtx } from '../../shell-ipc-ctx.ts'
import type { NotificationSourceToken } from '../../notifications.ts'
import { registerForwardHandlers } from '../../shell-ipc-browser.ts'
import type { ForwardIpcService, ForwardLocalFrameState } from '../../shell-ipc-browser.ts'
import type {
  ForwardListArgs,
  ForwardListResult,
  ForwardOpenArgs,
  ForwardOpenResult,
  ForwardRecord,
  ForwardReleaseArgs,
  ForwardReleaseResult,
  ForwardRequestArgs,
  ForwardRequestResult,
} from '../../remote-forward-manager.ts'

/** 64-hex lifecycle proof (the desktop REMOTE_SOURCE_FINGERPRINT_PATTERN shape). */
export const FINGERPRINT = 'a'.repeat(64)
/** Rotated proof used by `retire()` (still valid grammar, no longer matching). */
export const ROTATED_FINGERPRINT = 'b'.repeat(64)
export const SOURCE_ID = 'dsh-web-1'
export const FORWARD_ID = 'fwd-0123456789abcdef'

export interface FakeInstance {
  id: string
  kind: string
  transport: string
}

export type IpcHandler = (payload: unknown) => Promise<unknown> | unknown

/** One valid record (the happy path every negative case mutates). */
export function makeRecord(overrides: Partial<ForwardRecord> = {}): ForwardRecord {
  return {
    id: FORWARD_ID,
    sourceId: SOURCE_ID,
    namespace: 41234,
    aliasHost: '127.0.0.7',
    localPort: 5173,
    scheme: 'http',
    targetHost: '127.0.0.1',
    targetPort: 5173,
    state: 'bound',
    stale: false,
    error: null,
    createdAt: 1,
    updatedAt: 2,
    boundAt: 2,
    ...overrides,
  }
}

/** A registrar context over a mutable fake roster. */
export class ForwardIpcHarness {
  readonly handlers = new Map<string, IpcHandler>()
  instances: FakeInstance[] = [{ id: 'web-1', kind: 'dsh', transport: 'ssh' }]
  readonly fingerprints = new Map<string, string>()
  readonly tokens = new Map<string, NotificationSourceToken>()
  #generation = 0

  constructor() {
    this.addSource(SOURCE_ID, FINGERPRINT)
  }

  /** Install one live source incarnation (fingerprint + captured token). */
  addSource(sourceId: string, fingerprint = FINGERPRINT): void {
    this.fingerprints.set(sourceId, fingerprint)
    this.#generation += 1
    this.tokens.set(sourceId, Object.freeze({ sourceId, fingerprint, generation: this.#generation }))
  }

  /** Rotate the incarnation behind the registrar's back (retarget / replace):
   *  both the fingerprint match and the captured-token ownership stop holding. */
  retire(sourceId: string): void {
    this.addSource(sourceId, ROTATED_FINGERPRINT)
  }

  /** Register the four channels (service null = the not-assembled state). */
  install(service: ForwardIpcService | null, local: ForwardLocalFrameState | null = null): void {
    registerForwardHandlers(this.ctx(), service, local)
  }

  /** Drive one registered handler exactly as the IPC fence would. */
  async invoke(channel: string, payload: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (handler === undefined) throw new Error('no handler registered for ' + channel)
    return await handler(payload)
  }

  /** The structural ShellIpcCtx slice the registrar reads. */
  ctx(): ShellIpcCtx {
    const deps = {
      ipc: {
        handle: (channel: string, handler: IpcHandler): void => {
          this.handlers.set(channel, handler)
        },
      },
      ctx: {
        transportManager: { listInstances: () => this.instances },
      },
    }
    const ctx = {
      deps,
      captureVscodeSource: (instanceId: string): NotificationSourceToken | null => {
        const instance = this.instances.find(candidate => candidate.id === instanceId)
        if (instance === undefined) return null
        return this.tokens.get(`${instance.kind}-${instance.id}`) ?? null
      },
      matchesNotificationSource: (sourceId: string, fingerprint: string): boolean =>
        this.fingerprints.get(sourceId) === fingerprint,
      ownsNotificationSource: (token: NotificationSourceToken): boolean =>
        this.tokens.get(token.sourceId) === token,
    }
    return ctx as unknown as ShellIpcCtx
  }
}

/** A ForwardIpcService double: configurable results, recorded calls, one hook. */
export class FakeForwardService implements ForwardIpcService {
  readonly calls: Array<{ method: string; args: unknown }> = []
  requestResult: ForwardRequestResult = { ok: true, record: makeRecord() }
  releaseResult: ForwardReleaseResult = { ok: true }
  listResult: ForwardListResult = {
    ok: true,
    records: [makeRecord()],
    limits: { perSource: 8, global: 32, perSourceUsed: 1, globalUsed: 1 },
  }
  openResult: ForwardOpenResult = { ok: true }
  /** Runs inside the call, before the result resolves (await-boundary mutation). */
  beforeResolve: (() => void) | null = null

  async request(args: ForwardRequestArgs): Promise<ForwardRequestResult> {
    this.calls.push({ method: 'request', args })
    this.beforeResolve?.()
    return this.requestResult
  }

  async release(args: ForwardReleaseArgs): Promise<ForwardReleaseResult> {
    this.calls.push({ method: 'release', args })
    this.beforeResolve?.()
    return this.releaseResult
  }

  async list(args: ForwardListArgs): Promise<ForwardListResult> {
    this.calls.push({ method: 'list', args })
    this.beforeResolve?.()
    return this.listResult
  }

  async openInBrowser(args: ForwardOpenArgs): Promise<ForwardOpenResult> {
    this.calls.push({ method: 'openInBrowser', args })
    this.beforeResolve?.()
    return this.openResult
  }
}
