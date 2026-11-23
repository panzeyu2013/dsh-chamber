/**
 * The alpha.1 `uiSession.sessionStatus` client face this shell consumes.
 *
 * VENDOR CONTRACT (pinned): `dsh-client-ui-session-status` provides the nested
 * Cordis service `uiSession.sessionStatus` (`src/client/index.ts` `inject`
 * carries `'uiSession' + 'remote.sessionStatus'`; the class registers itself as
 * `super(ctx, 'uiSession.sessionStatus')`) and declares the member on
 * `UiSessionService` (`src/client/status.ts`). Its row shape is
 * `{ running, pendingInteraction, completionUnread, completionFailed }`; it also
 * exposes `readingReady` (`HostObservable<boolean>`: the Host reading baseline
 * arrived) and `mark(sessionId, unread)`.
 *
 * WHY A LOCAL FACE INSTEAD OF THE VENDOR TYPE: the repo-level loose vendor union
 * (`types/vendor-modules.d.ts`) declares `@deepseek-ai/cordis` with an index
 * signature, so this package's program sees `ctx.uiSession` as `any`; before
 * alpha.1 the producer carried an inline `as unknown as { sessionStatus: … }`
 * cast. The inject entry below is the runtime requirement — cordis resolves a
 * NESTED service only when the exact name is injected (an un-injected nested get
 * throws `cannot get property "…" without inject`), so the producer declares
 * `'uiSession.sessionStatus'` and reads through this one documented interface.
 * `test/session-state/session-status-consumer.test.ts` pins the inject entry, the
 * field names this face reads against the pinned vendor source, and the absence of
 * the old cast.
 */

/** The nested service name the shell must inject (and the only one it reads here). */
export const SESSION_STATUS_INJECT = 'uiSession.sessionStatus'

/** One row of the official status projection (fields the sidebar consumes). */
export interface SessionStatusRow {
  /** Official live running observation; absent = no observation yet for the row. */
  readonly running?: boolean
  /** Effective pending interaction (approval / plan-review / question kind). */
  readonly pendingInteraction?: { readonly kind?: string }
  /** Official completion-unread bit: the runtime channel's only `completed` source. */
  readonly completionUnread?: boolean
  /** Completion-unread AND the Host observed an execution error (alpha.1). */
  readonly completionFailed?: boolean
}

/** Readable/observable face of the official status projection. */
export interface SessionStatusFace {
  getSnapshot(): ReadonlyMap<string, SessionStatusRow>
  subscribe(listener: () => void): () => void
  /** Whether the Host reading baseline arrived (mark may be sent). */
  readonly readingReady: { getSnapshot(): boolean; subscribe(listener: () => void): () => void }
  /** Mark one Session read (unread=false) or unread through the latest completion known here. */
  mark(sessionId: string, unread: boolean): Promise<void>
}
