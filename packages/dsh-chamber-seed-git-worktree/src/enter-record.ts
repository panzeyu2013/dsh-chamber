/**
 * The official `plugin:worktree/entered` record payload (design 08 §4.2 interop;
 * alpha.1 worktree projection). PURE: no vendor import, so the payload contract is
 * testable without the host runtime; the writer lives in `enter-record-write.ts`.
 *
 * WHY THIS EXISTS: alpha.1 replaced the model's `working_directory` tool with the
 * Host-owned `enter_worktree`/`exit_worktree` pair, and `exit_worktree` only returns
 * a Session to the checkout it came from when the Session log carries an entry
 * record — `exit` scans `plugin:worktree/entered` + `plugin:worktree/created` and
 * fails `WORKTREE_NOT_ENTERED` otherwise (pinned vendor
 * `dsh-experimental-worktree/src/index.ts` exit + `projection.ts` fold). The chamber
 * seed enters a checkout by committing the working directory only, so a Session
 * created in a chamber checkout had no way back (the removed model tool was the
 * last other path; chamber ships no exit UI, design 08 §3.2).
 *
 * ONLY the ENTERED record is written. `plugin:worktree/created` means "this service
 * created the checkout for the Session", and those rows are what upstream's archive
 * cleanup may reclaim — chamber's seed owns its pool and deletions (design 08
 * §1.5), so writing `created` would let upstream delete a chamber-managed tree.
 *
 * SCHEMA: `{ path, branch?, repositoryRoot }`, strict — a record whose payload fails
 * the reader's zod schema is skipped silently, so `branch` is omitted for a detached
 * HEAD. The literal + field names are pinned against the vendored projection by
 * `test/enter-record.test.ts`, so a pin bump that renames the record goes red here.
 */

/** Record type of an existing checkout the Session entered (upstream literal). */
export const ENTERED_RECORD = 'plugin:worktree/entered'

/** The upstream `EnteredWorktree` payload (strict schema; `branch` optional). */
export interface EnteredWorktreeRecord {
  readonly path: string
  readonly branch?: string
  readonly repositoryRoot: string
}

/**
 * Build the entered-record payload for one validated enter.
 * @param path - host-canonical entered checkout path.
 * @param repositoryRoot - the checkout the Session entered FROM (its immutable root).
 * @param branch - the entered checkout's branch; pass `undefined`/empty for a detached HEAD
 *   (the upstream schema requires a non-empty string when the field is present).
 * @returns the strict upstream payload.
 */
export function enteredWorktreeRecord(
  path: string,
  repositoryRoot: string,
  branch?: string,
): EnteredWorktreeRecord {
  return branch === undefined || branch === ''
    ? { path, repositoryRoot }
    : { path, branch, repositoryRoot }
}

/** Maximum remembered (sessionId → last entered path) rows; the guard is per host process. */
export const ENTERED_PATH_MEMORY_LIMIT = 256

/**
 * Remember that this gateway appended the entered record for one session/path.
 * Repeated enters of the SAME path are idempotent; the oldest entry is dropped when the
 * memory exceeds {@link ENTERED_PATH_MEMORY_LIMIT} so a long-lived host cannot grow without
 * bound.
 * @param memory - per-gateway sessionId → path memory (mutated).
 * @param sessionId - the session whose record may be appended.
 * @param path - the canonical entered checkout path.
 * @returns true when the caller should append a NEW entered record.
 */
export function rememberEnteredPath(
  memory: Map<string, string>,
  sessionId: string,
  path: string,
): boolean {
  if (memory.get(sessionId) === path) return false
  memory.set(sessionId, path)
  if (memory.size > ENTERED_PATH_MEMORY_LIMIT) {
    const oldest = memory.keys().next().value
    if (oldest !== undefined) memory.delete(oldest)
  }
  return true
}
