/**
 * Pure renderer-side roster gating for deep-link activation and notification
 * session opens.
 *
 * The main process validates and launches VS Code before it pushes an intent,
 * but on a cold renderer the first authoritative desktop instances roster can
 * still be in flight. Remote source activation must therefore wait for that
 * roster instead of being mistaken for a removed source. Only the latest
 * pending source matters: view switching is a last-intent-wins operation and
 * the renderer never consumes the path itself.
 */

export interface DeepLinkActivationDecision {
  /** Remote source held until the first authoritative roster settles. */
  pendingSourceId: string | null
  /** Source safe to pass to App.selectView now. */
  activateSourceId: string | null
  /** A source deliberately discarded instead of mounted as a zombie view. */
  discarded: { sourceId: string; reason: 'superseded' | 'missing' } | null
}

/** A committed state edge schedules replay, while the imperative generation
 * ref vetoes a stale passive effect after an event-side invalidation. */
export function canReplayRosterIntents(
  committedRosterSettled: boolean,
  authoritativeGenerationSettled: boolean,
): boolean {
  return committedRosterSettled && authoritativeGenerationSettled
}

/** Shared roster gate for deep-link activation and notification opens. */
export function classifyRosterGatedSource(
  sourceId: string,
  rosterSettled: boolean,
  liveSourceIds: ReadonlySet<string>,
): 'activate' | 'hold' | 'missing' {
  if (sourceId === 'local') return 'activate'
  if (!rosterSettled) return 'hold'
  return liveSourceIds.has(sourceId) ? 'activate' : 'missing'
}

/** Immutable bounded FIFO append used for payload-bearing notification opens. */
export function enqueueBoundedRosterIntent<T>(
  pending: readonly T[],
  intent: T,
  limit: number,
): { pending: T[]; dropped: T | null } {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('pending roster intent limit must be positive')
  if (pending.length < limit) return { pending: [...pending, intent], dropped: null }
  return { pending: [...pending.slice(1), intent], dropped: pending[0] ?? null }
}

/**
 * Page-local serial tail for payload-bearing notification opens. Queue order
 * must cover the asynchronous `sessions.list` wait and the eventual
 * `sessions.open`, not merely the order in which App starts promises: otherwise
 * a later already-visible session can open before an earlier delayed one and
 * then be overwritten by that older click. One failed item is reported and
 * settled locally so it cannot poison the tail for subsequent clicks.
 */
export class SerialIntentRunner<T> {
  #tail: Promise<void> = Promise.resolve()

  enqueue(
    intent: T,
    run: (intent: T) => Promise<void>,
    onError: (error: unknown, intent: T) => void,
  ): Promise<void> {
    const execute = async (): Promise<void> => {
      try {
        await run(intent)
      } catch (error) {
        onError(error, intent)
      }
    }
    const settled = this.#tail.then(execute, execute)
    this.#tail = settled
    return settled
  }
}

/** Exact renderer-local owner for one active source or async request. Object
 * identity is the authority; `serial` exists only for loud diagnostics/tests
 * and is never reused during this registry's lifetime. */
export interface SourceOwnershipToken {
  readonly sourceId: string
  readonly fingerprint: string
  readonly serial: number
}

/**
 * Active-only source ownership. Retiring a source deletes its current entry,
 * so a long-running page does not retain one tombstone per historical id.
 * Re-activation always mints a new frozen object; an old async closure can
 * therefore never regain ownership after remove -> same-id re-add. `renew`
 * additionally supersedes an active owner and is used for latest-request-wins
 * work such as unary aggregate pulls.
 */
export class SourceOwnershipRegistry {
  #nextSerial = 0
  readonly #current = new Map<string, SourceOwnershipToken>()

  constructor(activeSourceIds: Iterable<string> = []) {
    this.activateAll(activeSourceIds)
  }

  #mint(sourceId: string, fingerprint: string): SourceOwnershipToken {
    this.#nextSerial += 1
    const token = Object.freeze({ sourceId, fingerprint, serial: this.#nextSerial })
    this.#current.set(sourceId, token)
    return token
  }

  /** Preserve the current incarnation when the same authoritative roster row
   * is observed again; mint only for a genuinely new/re-added active source. */
  activate(sourceId: string, fingerprint: string = sourceId): SourceOwnershipToken {
    const current = this.#current.get(sourceId)
    return current?.fingerprint === fingerprint ? current : this.#mint(sourceId, fingerprint)
  }

  activateAll(sourceIds: Iterable<string>): void {
    for (const sourceId of sourceIds) this.activate(sourceId)
  }

  /** Start a new latest-owner epoch even while the source remains active. */
  renew(sourceId: string): SourceOwnershipToken {
    return this.#mint(sourceId, sourceId)
  }

  capture(sourceId: string): SourceOwnershipToken | null {
    return this.#current.get(sourceId) ?? null
  }

  owns(token: SourceOwnershipToken | null): boolean {
    return token !== null && this.#current.get(token.sourceId) === token
  }

  retire(sourceIds: Iterable<string>): void {
    for (const sourceId of sourceIds) this.#current.delete(sourceId)
  }

  get size(): number {
    return this.#current.size
  }
}

export interface AuthoritativeSourceFingerprint {
  sourceId: string
  fingerprint: string
}

/** Derive lifecycle retirements from an authoritative roster snapshot itself.
 * The desktop push is the earliest signal, but it is not the sole authority:
 * if that event is lost or sanitized, a later snapshot whose same id carries
 * a different transport fingerprint must still synchronously retire the old
 * shell before the replacement owner is activated. Sources without a current
 * owner are initial/re-added rows and need only activation. */
export function authoritativeSourceRetirements(
  previousLiveSourceIds: ReadonlySet<string>,
  owners: SourceOwnershipRegistry,
  nextSources: readonly AuthoritativeSourceFingerprint[],
): Set<string> {
  const nextSourceIds = new Set(nextSources.map(source => source.sourceId))
  const retired = new Set(
    [...previousLiveSourceIds].filter(sourceId => !nextSourceIds.has(sourceId)),
  )
  for (const source of nextSources) {
    const current = owners.capture(source.sourceId)
    if (current !== null && current.fingerprint !== source.fingerprint) retired.add(source.sourceId)
  }
  return retired
}

/** Validate the authoritative, non-persistent lifecycle proof minted by main.
 * Remote proofs are opaque 64-character lowercase hex values. The renderer
 * never derives or repairs them from editable transport fields: missing or
 * malformed authority fails closed. */
export function parseAuthoritativeSourceFingerprint(sourceId: string, value: unknown): string | null {
  if (sourceId === 'local') return value === 'local' ? 'local' : null
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null
}

/** A main→renderer delivery may already be inside Electron's IPC pipe when a
 * source is retired and re-added under the same id. Require the proof captured
 * by main to match the renderer's current authoritative owner before any view
 * activation or session-open side effect. */
export function deliveryMatchesCurrentSource(
  owners: SourceOwnershipRegistry,
  sourceId: string,
  sourceFingerprint: unknown,
): boolean {
  const fingerprint = parseAuthoritativeSourceFingerprint(sourceId, sourceFingerprint)
  if (fingerprint === null) return false
  return owners.capture(sourceId)?.fingerprint === fingerprint
}

export interface RendererDeliveryCoordinates {
  deliveryId: number
  attempt: number
}

/**
 * Commit one main→renderer delivery with a bounded retry budget. IPC invoke
 * can reject transiently while the window is otherwise still alive; a single
 * fire-and-forget ACK would leave main's retained item in-flight forever and
 * eventually saturate the handoff queue. `false` is terminal because it means
 * this exact attempt is stale and a replacement renderer owns a newer one.
 */
export async function acknowledgeRendererDelivery(
  delivery: RendererDeliveryCoordinates,
  acknowledge: (deliveryId: number, attempt: number) => Promise<boolean>,
  options: {
    maxAttempts?: number
    retryDelayMs?: number
    wait?: (delayMs: number) => Promise<void>
  } = {},
): Promise<boolean> {
  if (!Number.isSafeInteger(delivery.deliveryId) || delivery.deliveryId < 1
    || !Number.isSafeInteger(delivery.attempt) || delivery.attempt < 1) {
    throw new TypeError('invalid renderer delivery coordinates')
  }
  const maxAttempts = options.maxAttempts ?? 5
  const retryDelayMs = options.retryDelayMs ?? 500
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('delivery ACK attempts must be a positive integer')
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new RangeError('delivery ACK retry delay must be non-negative')
  }
  const wait = options.wait ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)))
  let lastError: unknown = new Error('delivery ACK failed')
  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    try {
      return await acknowledge(delivery.deliveryId, delivery.attempt)
    } catch (error) {
      lastError = error
      if (attemptIndex + 1 < maxAttempts) await wait(retryDelayMs)
    }
  }
  throw lastError
}

/** Install the authoritative roster change listener before taking the initial
 * snapshot. Snapshot-before-listener has a lost-update window: a registry
 * mutation after instances_get resolves but before subscription leaves the
 * renderer's "settled" source set stale until the periodic poll. The same
 * refresh callback handles both the initial pull and every later event. */
export function subscribeRosterBeforeRefresh(
  subscribe: (onChanged: () => void) => () => void,
  refresh: () => void,
): () => void {
  const unsubscribe = subscribe(refresh)
  refresh()
  return unsubscribe
}

/** Route one newly received activation intent. */
export function routeDeepLinkActivation(
  sourceId: string,
  rosterSettled: boolean,
  liveSourceIds: ReadonlySet<string>,
  pendingSourceId: string | null,
): DeepLinkActivationDecision {
  const classification = classifyRosterGatedSource(sourceId, rosterSettled, liveSourceIds)
  // Any safely activatable source wins now. In particular, local never waits
  // for the SSH roster. The newer intent supersedes an older held remote.
  if (classification === 'activate') {
    return {
      pendingSourceId: null,
      activateSourceId: sourceId,
      discarded: pendingSourceId === null
        ? null
        : { sourceId: pendingSourceId, reason: 'superseded' },
    }
  }

  if (classification === 'hold') {
    return {
      pendingSourceId: sourceId,
      activateSourceId: null,
      discarded: pendingSourceId === null || pendingSourceId === sourceId
        ? null
        : { sourceId: pendingSourceId, reason: 'superseded' },
    }
  }

  return {
    pendingSourceId: null,
    activateSourceId: null,
    discarded: { sourceId, reason: 'missing' },
  }
}

/** Resolve the single held remote after an authoritative roster succeeds. */
export function settlePendingDeepLinkActivation(
  pendingSourceId: string | null,
  liveSourceIds: ReadonlySet<string>,
): DeepLinkActivationDecision {
  if (pendingSourceId === null) {
    return { pendingSourceId: null, activateSourceId: null, discarded: null }
  }
  if (classifyRosterGatedSource(pendingSourceId, true, liveSourceIds) === 'activate') {
    return { pendingSourceId: null, activateSourceId: pendingSourceId, discarded: null }
  }
  return {
    pendingSourceId: null,
    activateSourceId: null,
    discarded: { sourceId: pendingSourceId, reason: 'missing' },
  }
}
