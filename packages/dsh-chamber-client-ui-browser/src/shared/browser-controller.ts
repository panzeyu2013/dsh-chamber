/**
 * Browser forward controller — the tab occurrence's forward lease (design 28
 * §16.5, plan §4.3; L1 pure-model layer).
 *
 * The pane's lifecycle is not the iframe DOM node: vendor ui-sidebar-right
 * aborts the tab occurrence only when the record disappears (tab close, session
 * delete, plugin unload), while switching tabs/sessions merely unmounts the body
 * (design 28 §16.5; `keepMounted: true` keeps it mounted anyway). Binding the SSH
 * forward to the DOM node would re-spawn ssh on every remount, so the binding is:
 *
 *   one tab occurrence = one controller = one renderer-minted `consumer`
 *
 * main keeps a per-record consumer set and closes the listener when the LAST
 * consumer detaches. This controller:
 *   - mints its consumer once (random, never in `list`, not a security boundary —
 *     it is a lifetime identity);
 *   - attach-first: a new address is requested BEFORE the previous record is
 *     detached; a failed attach leaves the old page (and old forward) untouched;
 *   - same-record attach skips the detach (idempotent renew);
 *   - every request carries the consumer, every detach releases only this
 *     consumer;
 *   - dispose/occurrence-abort detaches every record it ever attached;
 *   - late-settle guard: a request that settles AFTER dispose is released
 *     immediately, so a torn-down tab can never leave an orphan listener.
 *
 * Pure: async logic over a structural transport; no DOM, no timers, no Node
 * APIs. The transport is the launcher's local bridge (the renderer adapter's
 * translated `chamberForward` face), but a fake promise is all the tests need.
 */
import {
  FORWARD_CONSUMER_PATTERN,
  isForwardFailureCode,
  parseForwardAck,
  parseForwardRequestResult,
  type ForwardFailureCode,
  type ForwardRecord,
  type ForwardRequestInput,
  type ForwardReleaseInput,
  type ForwardScheme,
} from './forward-bridge.ts'
import type { BrowserSource } from './source.ts'

/** The two calls this controller needs; results are parsed here, never trusted. */
export interface BrowserForwardTransport {
  request(input: ForwardRequestInput): Promise<unknown>
  release(input: ForwardReleaseInput): Promise<unknown>
}

/** One attach attempt (a remote loopback target typed into the address bar). */
export interface ForwardAttachRequest {
  port: number
  scheme: ForwardScheme
  /** Same-origin relative path + query main appends to the composed frame URL. */
  path: string
}

/** Outcome of one attach attempt. */
export type ForwardAttachResult =
  | { readonly ok: true; readonly record: ForwardRecord; readonly frameUrl: string }
  | { readonly ok: false; readonly code: ForwardFailureCode | 'aborted' }

/** Construction inputs for one tab occurrence. */
export interface BrowserForwardControllerOptions {
  readonly source: BrowserSource
  readonly sourceFingerprint: string
  /** The launcher bridge; null on a page without the trusted carrier. */
  readonly transport: BrowserForwardTransport | null
  /** Test seam for the consumer id; defaults to {@link mintForwardConsumer}. */
  readonly mintConsumer?: () => string
}

/**
 * Mint one renderer consumer id: a UUID when the runtime provides one, else 16
 * random bytes as hex. Both spellings satisfy {@link FORWARD_CONSUMER_PATTERN}.
 * The value is a lifetime identity, NOT a secret or a security boundary.
 */
export function mintForwardConsumer(): string {
  const api = (globalThis as {
    crypto?: {
      randomUUID?: () => string
      getRandomValues?: (array: Uint8Array) => Uint8Array
    }
  }).crypto
  if (api !== undefined && typeof api.randomUUID === 'function') {
    const id = api.randomUUID()
    if (FORWARD_CONSUMER_PATTERN.test(id)) return id
  }
  const bytes = new Uint8Array(16)
  if (api !== undefined && typeof api.getRandomValues === 'function') {
    api.getRandomValues(bytes)
  } else {
    // The consumer is not a capability: a weak fallback still yields a unique
    // lifetime id, it just is not unguessable (and does not need to be).
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** True when this occurrence still holds the record (and its listener). */
export class BrowserForwardController {
  /** The renderer-minted lifetime identity every call carries. */
  readonly consumer: string
  /** Construction inputs (source, boot proof, transport, test seams). */
  private readonly options: BrowserForwardControllerOptions
  /** recordId → consumer (one consumer today; the map is the contract's shape). */
  private readonly attached = new Map<string, string>()
  private current: string | null = null
  private disposed = false

  constructor(options: BrowserForwardControllerOptions) {
    this.options = options
    this.consumer = (options.mintConsumer ?? mintForwardConsumer)()
    if (!FORWARD_CONSUMER_PATTERN.test(this.consumer)) {
      throw new RangeError('forward consumer does not match the wire grammar')
    }
  }

  /** The record this occurrence currently displays, or null. */
  get currentRecordId(): string | null {
    return this.current
  }

  /** Record ids this occurrence holds (for diagnostics/tests). */
  get attachedRecordIds(): string[] {
    return [...this.attached.keys()]
  }

  /** True after dispose/occurrence abort; later attaches are refused. */
  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * Attach a remote loopback target, attach-first.
   *
   * @param request - the validated remote port/scheme/path.
   * @returns the bound record + main-composed frame URL, or a failure code
   *   (`aborted` when this occurrence disposed while the request was in flight).
   */
  async attach(request: ForwardAttachRequest): Promise<ForwardAttachResult> {
    if (this.disposed) return { ok: false, code: 'aborted' }
    const transport = this.options.transport
    if (transport === null) return { ok: false, code: 'unavailable' }
    if (!this.options.source.mayForward) return { ok: false, code: 'forbidden-source' }

    let response: unknown
    try {
      response = await transport.request({
        sourceId: this.options.source.sourceId,
        sourceFingerprint: this.options.sourceFingerprint,
        port: request.port,
        scheme: request.scheme,
        consumer: this.consumer,
        path: request.path,
      })
    } catch {
      return { ok: false, code: 'unavailable' }
    }
    const projected = parseForwardRequestResult(response)

    // Late-settle guard: the occurrence ended while main was still binding.
    // Release the claim main may have just created; the old record is gone with
    // the occurrence, so there is nothing to keep.
    if (this.disposed) {
      if (projected.ok) void this.releaseClaim(projected.record.id, this.consumer)
      return { ok: false, code: 'aborted' }
    }
    if (!projected.ok) return { ok: false, code: projected.code }

    const record = projected.record
    const frameUrl = projected.frameUrl
    // A record that never reached `bound`, or came without a composed URL, is a
    // failed attach: release its claim so it cannot linger, and keep the old page.
    if (record.state !== 'bound' || frameUrl === undefined) {
      void this.releaseClaim(record.id, this.consumer)
      return {
        ok: false,
        code: isForwardFailureCode(record.error) ? record.error : 'unknown',
      }
    }

    // Attach-first: only now is the previous record released (a failed request
    // above left it — and its page — untouched).
    const previous = this.current
    this.attached.set(record.id, this.consumer)
    this.current = record.id
    if (previous !== null && previous !== record.id) await this.releaseRecord(previous)
    return { ok: true, record, frameUrl }
  }

  /**
   * Detach the current record (close button / target cleared) without ending
   * the occurrence: another tab holding the same record keeps its listener.
   *
   * @returns the failure code, or null when detached/not attached.
   */
  async detachCurrent(): Promise<ForwardFailureCode | null> {
    const recordId = this.current
    if (recordId === null) return null
    return this.releaseRecord(recordId)
  }

  /**
   * Detach one record by id (also used by attach-first and the late-settle guard).
   *
   * @param recordId - main-minted record id.
   * @returns the failure code, or null when this occurrence held nothing.
   */
  async detach(recordId: string): Promise<ForwardFailureCode | null> {
    return this.releaseRecord(recordId)
  }

  /**
   * End the occurrence: detach every held record. Idempotent; repeated calls
   * join the same cleanup. Called by the tab-occurrence abort listener, the
   * unmount cleanup and the plugin scope disposal.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const ids = [...this.attached.keys()]
    await Promise.all(ids.map((recordId) => this.releaseRecord(recordId)))
  }

  /** Release one held record and forget it; never throws. */
  private async releaseRecord(recordId: string): Promise<ForwardFailureCode | null> {
    const consumer = this.attached.get(recordId)
    if (consumer === undefined) return null
    this.attached.delete(recordId)
    if (this.current === recordId) this.current = null
    return this.releaseClaim(recordId, consumer)
  }

  /**
   * Send one consumer-scoped release. Used both for held records and for a
   * claim main created during an attach that this pane refuses to hold (failed
   * target, late settle after dispose) — main must not keep a listener whose
   * only consumer this occurrence already dropped.
   */
  private async releaseClaim(recordId: string, consumer: string): Promise<ForwardFailureCode | null> {
    const transport = this.options.transport
    if (transport === null) return null
    try {
      const projected = parseForwardAck(await transport.release({
        sourceId: this.options.source.sourceId,
        sourceFingerprint: this.options.sourceFingerprint,
        id: recordId,
        consumer,
      }))
      return projected.ok ? null : projected.code
    } catch {
      // The bridge died with the occurrence; main's renderer-lifecycle revoke
      // (and the startup reaper) own the remaining listener, not this pane.
      return 'unavailable'
    }
  }
}
