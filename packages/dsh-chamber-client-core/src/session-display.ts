/**
 * Session display primitives: trailing-segment basename, the display-title
 * ladder and the working-directory projection.
 *
 * PURE + ZERO-IMPORT on purpose: every consumer may value-import this leaf.
 * The wire client (instance-api, which builds unary rows) and the projection
 * layer (derive, which resolves mounted-store titles) must share ONE display
 * rule, and neither module may value-import the other — their remaining edges
 * (derive/aggregate-store ← instance-api types) are type-only.
 */

/**
 * Effective working-directory projection of one session — the alpha.2
 * `workingDirectory` value carried inside the row's projection bag.
 *
 * SPARSE by contract: only a non-empty string is a fact. Absent / null /
 * non-string / '' all mean "not projected", and the checkout placement then
 * falls back to the header `cwd` (a cold summary without the projection must
 * never be moved into a checkout it was not observed in). Lives in this
 * zero-import leaf because BOTH producers need the ONE rule as a VALUE:
 * instance-api builds unary rows from `projections.values` and derive projects
 * the mounted store rows from `projectionValues` — neither may value-import the
 * other.
 * @param projectionValues - the row's projection bag (mounted store) or `projections.values` (unary wire), or undefined.
 * @returns the projected working directory, or undefined when absent.
 */
export function workingDirectoryOf(
  projectionValues: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const value = projectionValues?.workingDirectory
  return typeof value === 'string' && value !== '' ? value : undefined
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
