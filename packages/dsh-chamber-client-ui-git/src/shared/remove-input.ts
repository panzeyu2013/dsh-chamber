/**
 * Host input for one worktree removal. The `discardChanges` flag is the single
 * wire authorization the host turns into `git worktree remove --force`; it must
 * travel only after the row collected an explicit discard acknowledgement, never
 * as a default.
 */

/** Identity of the worktree a remove request targets. */
export interface RemoveInputTarget {
  readonly repoId: string
  readonly worktreeId: string
  readonly path: string
  readonly branch: string | null
  readonly head: string
}

/**
 * Build the host remove input for one target.
 * @param operationId - idempotency id minted by the coordinator.
 * @param target - fresh row identity (path plus expected repo/worktree/branch/head).
 * @param options - explicit authorizations collected by the remove dialog.
 * @returns the input consumed by `gitWorktreeApi.remove`.
 */
export function unregisteredRemoveInput(
  operationId: string,
  target: RemoveInputTarget,
  options: { deleteBranch?: string; discardChanges?: boolean } = {},
) {
  return {
    operationId,
    path: target.path,
    expected: {
      repoId: target.repoId,
      worktreeId: target.worktreeId,
      branch: target.branch,
      head: target.head,
    },
    ...(options.deleteBranch === undefined ? {} : { deleteBranch: options.deleteBranch }),
    ...(options.discardChanges === true ? { discardChanges: true } : {}),
  }
}
