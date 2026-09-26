/** Cursor, page, and live-tail coordination over a reconnecting Remote stream. */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteStreamCarrierError, UNREF_SCHEDULER } from './stream-client.ts'
import {
  decideStreamStallAction,
  DEFAULT_STREAM_STALL_TIMING,
  type StreamStallTiming,
} from './stream-stall-policy.ts'
import type {
  RemoteStream,
  RemoteStreamItem,
  RemoteStreamOptions,
} from './remote-stream.ts'
import { LADDER_TABLES, withDeadline } from '@dsh-chamber/dsh-stream-state'

function protocolViolation(message: string): RemoteError<'gateway/internal'> {
  return new RemoteError('gateway/internal', message, {})
}

/** Probe intervals measure elapsed time, never wall-clock adjustments. */
function elapsedClock(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/** Host assistant revision on any page or notification, read structurally: this
 *  base class is generic, so a value without `assistantStream.revision` yields
 *  undefined and the stall probe falls back to the cursor comparison alone. */
function assistantRevisionOf(value: unknown): number | undefined {
  const record = value as { revision?: unknown; assistantStream?: { revision?: unknown } } | null | undefined
  // Pages carry it under assistantStream; a delivered SessionAssistantStreamFrame
  // (the notification payload) carries it at the TOP level. Reading only the page
  // shape made the notification note dead code and left a healthy long stream
  // looking "advanced" on every probe.
  const revision = record?.assistantStream?.revision ?? record?.revision
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0 ? revision : undefined
}

/** Transport-neutral opening snapshot, durable entry, or cursorless notification. */
export type RemoteJournalFrame<Entry, Cursor, Page, Notification = never> =
  | { readonly type: 'opened'; readonly cursor: Cursor; readonly page: Page }
  | { readonly type: 'entry'; readonly entry: Entry }
  | ([Notification] extends [never]
    ? never
    : { readonly type: 'notification'; readonly notification: Notification })

/** One journal-window update or cursorless domain notification. */
export type RemoteJournalChange<Page, Entry, Notification = never> =
  | {
    readonly type: 'replace'
    readonly page: Page
    readonly entries: readonly Entry[]
    readonly hasMore: boolean
  }
  | {
    readonly type: 'prepend'
    readonly page: Page
    readonly entries: readonly Entry[]
    readonly hasMore: boolean
  }
  | { readonly type: 'append'; readonly entry: Entry }
  | ([Notification] extends [never]
    ? never
    : { readonly type: 'notification'; readonly notification: Notification })

type JournalStreamItem<Page, Entry, Cursor, Notification> = RemoteStreamItem<
  RemoteJournalFrame<Entry, Cursor, Page, Notification>
>

/** Gateway capability used to create one reconnecting Remote stream. */
export interface RemoteStreamFactory {
  /** Create one independently cancellable logical stream. */
  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item>
}

/** Domain publication and cursor operations for one addressed journal stream. */
export interface RemoteJournalStreamOptions<Page, Entry, Cursor, Notification = never> {
  readonly name: string
  /** Cursor representing a journal with no entries. */
  readonly emptyCursor: Cursor
  readonly entries: (page: Page) => readonly Entry[]
  readonly hasMore: (page: Page) => boolean
  readonly first: (entry: Entry) => Cursor
  /** Inclusive final cursor, which must not precede the first. */
  readonly last: (entry: Entry) => Cursor
  readonly compare: (left: Cursor, right: Cursor) => number
  /** Test whether the right cursor immediately follows the left cursor. */
  readonly follows: (left: Cursor, right: Cursor) => boolean
  /** Apply one complete journal-window change or cursorless notification. */
  readonly publish: (change: RemoteJournalChange<Page, Entry, Notification>) => void
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  /** chamber patch: silence-watchdog timing override. */
  readonly stall?: Partial<StreamStallTiming>
  /**
   * chamber patch (design 14 §D4): total deadline for ONE `open()` across every
   * physical generation it retries. The carrier's per-episode opening deadline bounds
   * a single attempt only; a host that never answers would otherwise leave the
   * logical open pending forever and the vendor Session latched at `loading`.
   * Expiry rejects with a RemoteError, so the domain face reaches its own `error`
   * state. Defaults to the page's own failing bound
   * ({@link LADDER_TABLES.streamHealth.loadingFailedMs}), keeping both faces in one
   * window.
   */
  readonly openDeadlineMs?: number
  /** Publish a terminal stream, page, or protocol failure after opening. */
  readonly failed: (error: unknown) => void
}

/**
 * Owns snapshot-first opening, ordered live delivery, pagination, and repair. The
 * domain retains its published window during reconnection; a replacement is published
 * only after the opening page reaches the generation's cursor. Notifications never
 * change a cursor and wait behind an in-flight gap repair.
 */
export abstract class RemoteJournalStream<
  Page, Entry, Cursor, PageRequest = void, Notification = never,
> {
  private readonly stream: RemoteStream<RemoteJournalFrame<Entry, Cursor, Page, Notification>>
  private initialRequest!: PageRequest
  private resumeCursor: Cursor | undefined
  private hasResumeCursor = false
  private generation = 0
  private firstCursor: Cursor | undefined
  private lastCursor: Cursor | undefined
  /** Newest host assistant-stream revision observed on ANY published page or
   *  notification. The session journal advances assistant output under its own
   *  revision while the persisted event cursor can stand still (vendor
   *  transport.ts:193). Tracking only openings left a live stream's applied
   *  revision stale, so every probe reported an advance and a healthy long stream
   *  was rebuilt periodically. */
  private lastAssistantRevision: number | undefined
  /** Generation the revision belongs to: a replacement host agent restarts frames at 1. */
  private lastAssistantGeneration: number | undefined
  /** Invalidate page reads that started against a replaced or prepended window. */
  private windowRevision = 0
  private started = false
  private opened = false
  private disposed = false
  private done: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private pendingNext: Promise<IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>> | undefined
  // chamber patch: silence-watchdog state; `lastProgressAt` advances on every
  // published item, so a producing stream never reaches the probe window.
  private readonly stallTiming: StreamStallTiming
  private stallTimer: ReturnType<typeof setInterval> | undefined
  private lastProgressAt: number
  private lastProbeAt: number | undefined
  private lastRestartAt: number | undefined
  private probing = false
  /** Consecutive probes that found no Host advance (widens the probe cadence). */
  private quietProbes = 0
  /** Total deadline for one logical open's first frame (see options). */
  private readonly openDeadlineMs: number

  /** @param remote - Gateway factory for the reconnecting physical-generation stream. */
  protected constructor(
    remote: RemoteStreamFactory,
    private readonly options: RemoteJournalStreamOptions<Page, Entry, Cursor, Notification>,
  ) {
    this.openDeadlineMs = options.openDeadlineMs ?? LADDER_TABLES.streamHealth.loadingFailedMs
    this.stallTiming = { ...DEFAULT_STREAM_STALL_TIMING, ...options.stall }
    this.lastProgressAt = elapsedClock()
    this.stream = remote.$stream<RemoteJournalFrame<Entry, Cursor, Page, Notification>>({
      name: options.name,
      open: signal => this.follow(this.initialRequest, signal),
      ended: accepted => accepted
        ? new RemoteStreamCarrierError(`${options.name} ended without a terminal result`)
        : protocolViolation(
          `${this.hasResumeCursor ? 'resumed ' : ''}${options.name} ended before its opening cursor`,
        ),
      ...(options.carrierFailed === undefined
        ? {}
        : { carrierFailed: options.carrierFailed }),
    })
  }

  /** Open one physical journal generation with a complete current snapshot; the
   *  request is retained for later repair. */
  protected abstract follow(
    request: PageRequest,
    signal: AbortSignal,
  ): AsyncIterable<RemoteJournalFrame<Entry, Cursor, Page, Notification>>

  /** Read one journal page through the addressed domain source; its tail equals
   *  `through` unless the request selects older entries. */
  protected abstract readPage(request: PageRequest, through: Cursor, signal: AbortSignal): Promise<Page>

  /** Derive an unbounded-tail request from the initial page request. */
  protected abstract repairRequest(initial: PageRequest): PageRequest

  /** Cancellation lifetime shared by follow and page calls. */
  get signal(): AbortSignal {
    return this.stream.signal
  }

  /** Establish follow and publish the opening snapshot carried by its first frame. */
  async open(request: PageRequest): Promise<void> {
    if (this.started) throw new Error(`${this.options.name} already opened`)
    this.started = true
    this.initialRequest = request
    const iterator = this.stream[Symbol.asyncIterator]()
    const firstFrame = this.takeNext(iterator)
    try {
      // chamber patch (design 14 §D4): the carrier's opening deadline bounds ONE
      // physical attempt, while the logical open retries generations. Without this
      // total bound a host that never answers leaves this promise pending and the
      // vendor Session latched at 'loading' with no retry lever. Expiry rejects with
      // a RemoteError, so the domain face reaches its own 'error' state; the bound is
      // the page's failing bound, so both faces flip in the same window.
      const bounded = await withDeadline<IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>> | 'expired'>(firstFrame, {
        ms: this.openDeadlineMs,
        onExpire: () => 'expired' as const,
        scheduler: UNREF_SCHEDULER,
      })
      if (bounded.settled === 'deadline') {
        throw protocolViolation(
          `${this.options.name} delivered no opening item within ${String(this.openDeadlineMs)}ms`,
        )
      }
      const first = bounded.value as IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>
      if (first.done) throw protocolViolation(`${this.options.name} ended before its opening cursor`)
      this.replaceGeneration(first.value, false)
      this.opened = true
      this.startStallWatchdog()
      this.done = this.consume(iterator)
    } catch (error) {
      await this.stream.dispose()
      // The losing read settles with the disposed generation; its rejection must
      // never surface as an unhandled rejection.
      void firstFrame.catch(() => undefined)
      throw error
    }
  }

  /** Read and prepend one older page after a successful open. */
  async prepend(request: PageRequest): Promise<void> {
    if (!this.opened || this.disposed) throw new Error(`${this.options.name} is not open`)
    const revision = this.windowRevision
    const readAbort = new AbortController()
    const signal = AbortSignal.any([this.stream.signal, readAbort.signal])
    const reading = this.readPage(request, this.currentCursor(), signal)
    // AbortSignal.timeout alone is not a deadline: a transport that ignores it
    // leaves the awaited promise pending forever. Race the read itself, then
    // discard any late result through the window/lifetime fences below.
    const bounded = await withDeadline(reading, {
      ms: this.stallTiming.readDeadlineMs,
      onExpire: () => {
        readAbort.abort(new Error(`${this.options.name} history read deadline`))
        return undefined as Page
      },
      scheduler: UNREF_SCHEDULER,
    })
    if (bounded.settled === 'deadline') {
      throw protocolViolation(`${this.options.name} history read exceeded ${String(this.stallTiming.readDeadlineMs)}ms`)
    }
    const page = bounded.value as Page
    this.stream.signal.throwIfAborted()
    if (revision !== this.windowRevision) return
    const entries = this.options.entries(page)
    this.assertPage(entries)
    const before = this.firstCursor
    const accepted = before === undefined
      ? [...entries]
      : entries.filter(entry => this.options.compare(this.options.first(entry), before) < 0)
    const tail = accepted.at(-1)
    if (tail !== undefined && before !== undefined
      && !this.options.follows(this.options.last(tail), before)) {
      this.publish({ type: 'prepend', page, entries: [], hasMore: false })
      throw protocolViolation(`${this.options.name} history page is discontinuous`)
    }
    const first = accepted[0]
    if (first !== undefined) this.firstCursor = this.options.first(first)
    this.windowRevision++
    this.publish({
      type: 'prepend',
      page,
      entries: accepted,
      hasMore: this.options.hasMore(page),
    })
  }

  /** Replace the active physical generation while retaining the published window. */
  restart(): void {
    this.stream.restart()
  }

  /** Permanently stop follow, page requests, and the background consumer. */
  dispose(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.disposed = true
    this.stopStallWatchdog()
    const done = this.done
    const closing = (async () => {
      await this.stream.dispose()
      await done
    })()
    this.closing = closing
    return closing
  }

  /** chamber patch: publish one change and mark live progress for the watchdog
   *  (opening windows, appends, prepends and notifications all count). */
  private publish(change: RemoteJournalChange<Page, Entry, Notification>): void {
    if (this.disposed) return
    if (change.type === 'replace' || change.type === 'append') {
      this.lastProgressAt = elapsedClock()
      this.quietProbes = 0
    }
    this.options.publish(change)
    // AFTER the pinned progress/delivery body: every published page advances the
    // applied assistant revision (replace/prepend carry a page; append does not).
    if (change.type === 'replace' || change.type === 'prepend') this.noteAssistantRevision(change.page, this.generation)
  }

  /** chamber patch: arm the silence watchdog once the opening window is published. */
  private startStallWatchdog(): void {
    if (this.stallTimer !== undefined || this.disposed) return
    const timer = setInterval(() => { void this.checkStall() }, this.stallTiming.tickMs)
    // Never keep a Host/Electron process alive just for this watchdog.
    ;(timer as unknown as { unref?: () => void }).unref?.()
    this.stallTimer = timer
  }

  private stopStallWatchdog(): void {
    if (this.stallTimer === undefined) return
    clearInterval(this.stallTimer)
    this.stallTimer = undefined
  }

  /**
   * One watchdog tick. `'probe'` opens a SIBLING follow and reads only its opening
   * cursor: AHEAD of the applied one ⇒ replace the physical generation (the fresh
   * opening is published as a `replace`); EQUAL/absent ⇒ genuine silence, do nothing
   * (no blind restart). A failed probe is "no evidence", never a teardown reason.
   */
  private async checkStall(): Promise<void> {
    if (this.disposed || this.probing) return
    const action = decideStreamStallAction({
      now: elapsedClock(),
      lastProgressAt: this.lastProgressAt,
      lastProbeAt: this.lastProbeAt,
      lastRestartAt: this.lastRestartAt,
      probing: this.probing,
      quietProbes: this.quietProbes,
    }, this.stallTiming)
    if (action !== 'probe') return
    this.probing = true
    this.lastProbeAt = elapsedClock()
    let advanced = false
    try {
      advanced = await this.probeHostAdvance()
    } catch {
      // Diagnostic only: a probe failure never escapes, and counts as "no advance"
      // (a broken probe path must not keep a sibling follow in flight forever).
    } finally {
      this.probing = false
    }
    if (this.disposed) return
    if (advanced) {
      this.lastRestartAt = elapsedClock()
      this.lastProgressAt = elapsedClock()
      this.quietProbes = 0
      this.stream.restart()
      return
    }
    this.quietProbes += 1
  }

  /** Open one sibling follow and report whether its opening cursor is ahead of the applied one. */
  private async probeHostAdvance(): Promise<boolean> {
    const deadline = new AbortController()
    const signal = AbortSignal.any([this.stream.signal, deadline.signal])
    const iterator = this.follow(this.initialRequest, signal)[Symbol.asyncIterator]()
    try {
      // The deadline is the shared primitive: one handle, always cleared, so a probe
      // that answers in time leaves no timer; expiry aborts the sibling follow (the mux
      // sends its cancel frame) and reports "no advance" instead of escaping.
      const raced = await withDeadline<IteratorResult<RemoteJournalFrame<Entry, Cursor, Page, Notification>>>(iterator.next(), {
        ms: this.stallTiming.probeTimeoutMs,
        onExpire: () => {
          deadline.abort(new Error('journal stall probe deadline'))
          return { done: true as const, value: undefined as never }
        },
        scheduler: UNREF_SCHEDULER,
      })
      if (raced.settled === 'deadline' || raced.value === undefined) return false
      const next = raced.value
      // A sibling follow yields RemoteJournalFrame directly, not the RemoteStreamItem wrapper.
      if (next.done || next.value.type !== 'opened') return false
      const applied = this.lastCursor
      if (applied === undefined) return false
      const compared = this.options.compare(next.value.cursor, applied)
      if (compared > 0) return true
      // A cursor BEHIND the applied one is a replacement generation opening earlier:
      // restarting on it trips the resumed-generation guard and kills the journal.
      // The revision arm therefore applies only while the cursor stands still, where
      // the host's assistant stream advances under its own revision.
      if (compared < 0) return false
      const revision = assistantRevisionOf(next.value.page)
      return revision !== undefined && this.lastAssistantRevision !== undefined
        && revision > this.lastAssistantRevision
    } finally {
      deadline.abort(new Error('journal stall probe finished'))
      // Bounded teardown: a follow whose return() ignores the aborted signal must not
      // leave probing=true forever; the abort above already released the host-side follow.
      const closing = Promise.resolve(iterator.return?.(undefined)).then(
        () => undefined,
        () => undefined,
      )
      // Same primitive for the bound: it clears its own unref'd timer.
      await withDeadline(closing, {
        ms: this.stallTiming.probeTimeoutMs,
        onExpire: () => undefined,
        scheduler: UNREF_SCHEDULER,
      })
    }
  }

  private async consume(
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
  ): Promise<void> {
    try {
      while (true) {
        const next = await this.takeNext(iterator)
        if (next.done) return
        const item = next.value
        if (item.generation !== this.generation) {
          this.replaceGeneration(item, true)
          continue
        }
        if (item.value.type === 'opened') {
          throw protocolViolation(`${this.options.name} emitted more than one opening cursor`)
        }
        if (item.value.type === 'notification') {
          this.publishNotification(item.value.notification)
          continue
        }
        await this.acceptEntry(item.value.entry, item, iterator)
      }
    } catch (error) {
      if (!this.disposed) this.options.failed(error)
    }
  }

  private replaceGeneration(
    initial: JournalStreamItem<Page, Entry, Cursor, Notification>,
    resumed: boolean,
  ): void {
    const opening = this.opening(initial, resumed)
    this.replaceFromOpening(opening.page, opening.cursor)
  }

  private opening(
    item: RemoteStreamItem<RemoteJournalFrame<Entry, Cursor, Page, Notification>>,
    resumed: boolean,
  ): { readonly cursor: Cursor; readonly page: Page } {
    if (item.value.type !== 'opened') {
      throw protocolViolation(`${resumed ? 'resumed ' : ''}${this.options.name} emitted an entry before its opening cursor`)
    }
    const cursor = item.value.cursor
    if (resumed && this.lastCursor !== undefined
      && this.options.compare(cursor, this.lastCursor) < 0) {
      throw protocolViolation(
        `${this.options.name} resumed at a cursor behind the last applied entry`,
      )
    }
    this.generation = item.generation
    item.accept()
    return { cursor, page: item.value.page }
  }

  /** Record the newest assistant revision carried by any published value. */
  private noteAssistantRevision(value: unknown, generation: number): void {
    const revision = assistantRevisionOf(value)
    if (revision === undefined) return
    // A replacement host agent restarts frame revision at one: keeping the old peak
    // across generations would disable the revision arm forever.
    if (generation !== this.lastAssistantGeneration) {
      this.lastAssistantGeneration = generation
      this.lastAssistantRevision = revision
      return
    }
    if (this.lastAssistantRevision === undefined || revision > this.lastAssistantRevision) {
      this.lastAssistantRevision = revision
    }
  }

  /** Publish a generation's opening page without issuing a second Remote call. */
  private replaceFromOpening(page: Page, cursor: Cursor): void {
    this.assertPageThrough(page, cursor)
    const entries = [...this.options.entries(page)]
    this.assertPage(entries)
    const first = entries[0]
    this.firstCursor = first === undefined ? undefined : this.options.first(first)
    this.lastCursor = cursor
    this.noteAssistantRevision(page, this.generation)
    this.setResumeCursor(cursor)
    this.windowRevision++
    this.publish({
      type: 'replace',
      page,
      entries,
      hasMore: this.options.hasMore(page),
    })
  }

  private async acceptEntry(
    entry: Entry,
    item: JournalStreamItem<Page, Entry, Cursor, Notification>,
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
  ): Promise<void> {
    const { first, last: cursor } = this.entryRange(entry)
    const last = this.lastCursor as Cursor
    if (this.options.compare(cursor, last) <= 0) return
    if (this.options.compare(first, last) <= 0) {
      throw protocolViolation(`${this.options.name} emitted a partially overlapping entry`)
    }
    if (!this.options.follows(last, first)) {
      const request = this.repairPageRequest()
      const superseded = await this.replaceThrough(
        request,
        cursor,
        item.generation,
        item.signal,
        iterator,
        [entry],
        [],
      )
      if (superseded !== undefined) {
        this.replaceGeneration(superseded, true)
      }
      return
    }
    if (this.firstCursor === undefined) this.firstCursor = first
    this.lastCursor = cursor
    this.setResumeCursor(cursor)
    this.publish({ type: 'append', entry })
  }

  private async replaceThrough(
    request: PageRequest,
    requiredCursor: Cursor,
    generation: number,
    signal: AbortSignal,
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
    queued: Entry[],
    notifications: Notification[],
  ): Promise<JournalStreamItem<Page, Entry, Cursor, Notification> | undefined> {
    let read = await this.readPageWhileFollowing(
      request,
      requiredCursor,
      generation,
      signal,
      iterator,
      queued,
      notifications,
    )
    if (read.type === 'superseded') return read.item
    let page = read.page
    this.assertPageThrough(page, requiredCursor)
    let entries = this.mergeReplacement(page, queued)
    let target = this.maxCursor(requiredCursor, queued)
    if (entries === undefined || this.options.compare(this.tailCursor(entries), target) < 0) {
      read = await this.readPageWhileFollowing(
        this.repairPageRequest(),
        target,
        generation,
        signal,
        iterator,
        queued,
        notifications,
      )
      if (read.type === 'superseded') return read.item
      page = read.page
      this.assertPageThrough(page, target)
      entries = this.mergeReplacement(page, queued)
      target = this.maxCursor(requiredCursor, queued)
    }
    if (entries === undefined || this.options.compare(this.tailCursor(entries), target) < 0) {
      throw protocolViolation(`${this.options.name} page did not reach its opening cursor`)
    }
    const first = entries[0]
    /* v8 ignore next -- a successful positive-cursor replacement page cannot be empty. */
    this.firstCursor = first === undefined ? undefined : this.options.first(first)
    this.lastCursor = this.tailCursor(entries)
    this.setResumeCursor(this.lastCursor)
    this.windowRevision++
    this.publish({
      type: 'replace',
      page,
      entries,
      hasMore: this.options.hasMore(page),
    })
    for (const notification of notifications) {
      this.publishNotification(notification)
    }
    return undefined
  }

  private async readPageWhileFollowing(
    request: PageRequest,
    through: Cursor,
    generation: number,
    signal: AbortSignal,
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
    queued: Entry[],
    notifications: Notification[],
  ): Promise<
    | { readonly type: 'page'; readonly page: Page }
    | { readonly type: 'superseded'; readonly item: JournalStreamItem<Page, Entry, Cursor, Notification> }
  > {
    const page = this.readPage(request, through, signal).then(
      value => ({ type: 'page' as const, value }),
      (error: unknown) => ({ type: 'page-error' as const, error }),
    )
    while (true) {
      const pending = this.nextResult(iterator)
      const next = pending.then(
        value => ({ type: 'next' as const, value }),
        (error: unknown) => ({ type: 'next-error' as const, error }),
      )
      const result = await Promise.race([page, next])
      if (result.type === 'page') {
        signal.throwIfAborted()
        return { type: 'page', page: result.value }
      }
      if (result.type === 'page-error') {
        if (!signal.aborted || this.stream.signal.aborted) throw result.error
        return this.awaitReplacementGeneration(generation, iterator, pending)
      }
      this.releaseNext()
      if (result.type === 'next-error') throw result.error
      if (result.value.done) {
        signal.throwIfAborted()
        throw protocolViolation(`${this.options.name} ended while reading its replacement page`)
      }
      const item = result.value.value
      if (item.generation !== generation) return { type: 'superseded', item }
      if (item.value.type === 'opened') {
        throw protocolViolation(`${this.options.name} emitted more than one opening cursor`)
      }
      if (item.value.type === 'notification') {
        notifications.push(item.value.notification)
        continue
      }
      queued.push(item.value.entry)
    }
  }

  private async awaitReplacementGeneration(
    generation: number,
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
    initial: Promise<IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>>,
  ): Promise<{ readonly type: 'superseded'; readonly item: JournalStreamItem<Page, Entry, Cursor, Notification> }> {
    let pending = initial
    while (true) {
      let next: IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>
      try {
        next = await pending
      } finally {
        this.releaseNext()
      }
      if (next.done) {
        this.stream.signal.throwIfAborted()
        throw protocolViolation(`${this.options.name} ended while replacing an aborted page generation`)
      }
      const item = next.value
      if (item.generation !== generation) return { type: 'superseded', item }
      if (item.value.type === 'opened') {
        throw protocolViolation(`${this.options.name} emitted more than one opening cursor`)
      }
      pending = this.nextResult(iterator)
    }
  }

  private mergeReplacement(page: Page, queued: readonly Entry[]): Entry[] | undefined {
    const entries = [...this.options.entries(page)]
    this.assertPage(entries)
    for (const entry of queued) this.entryRange(entry)
    const sorted = [...queued].sort((left, right) => (
      this.options.compare(this.options.first(left), this.options.first(right))
    ))
    let tail = this.tailCursor(entries)
    for (const entry of sorted) {
      const first = this.options.first(entry)
      const last = this.options.last(entry)
      if (this.options.compare(last, tail) <= 0) continue
      if (this.options.compare(first, tail) <= 0) {
        throw protocolViolation(`${this.options.name} replacement contains a partially overlapping entry`)
      }
      if (!this.options.follows(tail, first)) return undefined
      entries.push(entry)
      tail = last
    }
    return entries
  }

  private maxCursor(cursor: Cursor, entries: readonly Entry[]): Cursor {
    let result = cursor
    for (const entry of entries) {
      const candidate = this.options.last(entry)
      if (this.options.compare(candidate, result) > 0) result = candidate
    }
    return result
  }

  private nextResult(
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
  ): Promise<IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>> {
    this.pendingNext ??= iterator.next()
    return this.pendingNext
  }

  private async takeNext(
    iterator: AsyncIterator<JournalStreamItem<Page, Entry, Cursor, Notification>>,
  ): Promise<IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>>> {
    const pending = this.nextResult(iterator)
    try {
      return await pending
    } finally {
      this.releaseNext()
    }
  }

  private releaseNext(): void {
    this.pendingNext = undefined
  }

  private publishNotification(notification: Notification): void {
    this.noteAssistantRevision(notification, this.generation)
    this.publish({
      type: 'notification',
      notification,
    } as RemoteJournalChange<Page, Entry, Notification>)
  }

  private repairPageRequest(): PageRequest {
    return this.repairRequest(this.initialRequest)
  }

  private setResumeCursor(cursor: Cursor): void {
    this.resumeCursor = cursor
    this.hasResumeCursor = true
  }

  private currentCursor(): Cursor {
    return this.resumeCursor as Cursor
  }

  private tailCursor(entries: readonly Entry[]): Cursor {
    const tail = entries.at(-1)
    return tail === undefined ? this.options.emptyCursor : this.options.last(tail)
  }

  private assertPage(entries: readonly Entry[]): void {
    const iterator = entries[Symbol.iterator]()
    const first = iterator.next()
    if (first.done) return
    let previousRange = this.entryRange(first.value)
    for (const entry of iterator) {
      const range = this.entryRange(entry)
      if (!this.options.follows(previousRange.last, range.first)) {
        throw protocolViolation(`${this.options.name} page contains discontinuous entries`)
      }
      previousRange = range
    }
  }

  private entryRange(entry: Entry): { readonly first: Cursor; readonly last: Cursor } {
    const first = this.options.first(entry)
    const last = this.options.last(entry)
    if (this.options.compare(first, last) > 0) {
      throw protocolViolation(`${this.options.name} entry has an inverted cursor range`)
    }
    return { first, last }
  }

  private assertPageThrough(page: Page, through: Cursor): void {
    const tail = this.tailCursor(this.options.entries(page))
    if (this.options.compare(tail, through) !== 0) {
      throw protocolViolation(`${this.options.name} page did not end at its requested cursor`)
    }
  }
}
