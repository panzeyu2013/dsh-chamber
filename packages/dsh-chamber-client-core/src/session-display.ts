/**
 * Session display primitives: trailing-segment basename, the display-title
 * ladder and the active-Schedule projection test.
 *
 * PURE + ZERO-IMPORT on purpose: every consumer may value-import this leaf.
 * The wire client (instance-api, which builds unary rows) and the projection
 * layer (derive, which resolves mounted-store titles) must share ONE display
 * rule, and neither module may value-import the other — their remaining edges
 * (derive/aggregate-store ← instance-api types) are type-only.
 */

/**
 * Active-Schedule fact of one session.
 *
 * Mirrors the official derivation verbatim — upstream reads the session's
 * registered `schedule` projection and asks whether anything is active:
 * `(session.projectionValues?.schedule?.length ?? 0) > 0`
 * (vendor ui-workspace/src/client/tree.ts:161-163, consumed by
 * `{row.hasActiveSchedule && <ActiveScheduleIndicator/>}` at Rows.tsx:468).
 * The value is unknown-typed here (a wire projection bag), so the array test
 * replaces upstream's optional chaining on a typed `readonly ScheduleRecord[]`:
 * absent / not-an-array / empty all mean "no active schedule" — never a claim
 * about the future, only about the projection the list row carried.
 * @param projectionValues - the row's `projectionValues` bag (mounted store) or `projections.values` (unary wire), or undefined.
 * @returns true when the bag carries a non-empty `schedule` array.
 */
export function hasActiveScheduleOf(
  projectionValues: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const schedule = projectionValues?.schedule
  return Array.isArray(schedule) && schedule.length > 0
}

/**
 * Trailing path segment ('' for root); the cwd-derived group title.
 *
 * Lives in this zero-import leaf because BOTH sides need it as a VALUE:
 * instance-api builds unary rows and derive resolves display titles, and the
 * former must never value-import derive (their type-only reverse edges would
 * otherwise become a runtime cycle). Both callers re-export `basenameOf` so
 * existing import sites (workspace-echo.ts) keep working.
 */
export function basenameOf(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '')
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const base = separator === -1 ? trimmed : trimmed.slice(separator + 1)
  return base === '' ? cwd : base
}

/**
 * THE session display-label resolver — one rule, official semantics.
 *
 * Upstream splits the rule across two places: the renderer localizes a blank
 * row (`blank ? t('session.new') : node.title`, vendor ui-workspace
 * rows/Rows.tsx:26-28) and the projection chain is `title ?? basename(cwd) ??
 * id` (`displayTitleOf`, vendor api-session-controller client
 * sessions/service.ts:146-153, applied at :587). The chamber carried only the
 * durable `title` half, so a row whose title the host could not read — a
 * predecessor cache record without a readable title projection — fell through
 * to 「未命名会话」 (`list.unnamed`) even though its official label is the
 * project directory name. This resolver is the missing half.
 *
 * Ordering is the official one with EMPTY treated as absent: durable title,
 * then the canonical cwd's basename, then the raw session id. It never returns
 * an empty string, so an unknown title can never be rendered as the untitled
 * copy again (invariant I3: a label never turns "unknown" into 「未命名」).
 *
 * `displayTitle` is a producer-resolved value that wins when present (the
 * mounted vendor store's `SessionSummary.displayTitle`, or the unary builder's
 * own chain); `cwdBasename` lets a caller that owns the cwd hand in the
 * basename without this module importing instance-api.
 *
 * @param source - candidate label facts; only `sessionId` is required.
 * @returns a non-empty display label.
 */
export function sessionDisplayTitle(source: {
  displayTitle?: string | undefined
  title?: string | undefined
  cwdBasename?: string | undefined
  sessionId: string
}): string {
  const { displayTitle, title, cwdBasename } = source
  // `typeof === 'string'` (not `!== undefined`) because a JSON producer can
  // deliver `null`, which is not a label and must fall through the ladder.
  if (typeof displayTitle === 'string' && displayTitle !== '') return displayTitle
  if (typeof title === 'string' && title !== '') return title
  // A separator-only basename is the ROOT path's spelling ('/' , '///'), where
  // the official `workspaceTitleOf` answers '' and `displayTitleOf` therefore
  // falls through to the session id — never render the raw separators.
  if (typeof cwdBasename === 'string' && cwdBasename !== '' && !/^[/\\]+$/.test(cwdBasename)) {
    return cwdBasename
  }
  return source.sessionId
}
