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
 * The remove options one unregistered row authorizes: the discard flag rides only
 * after the matching acknowledgement (dirty or submodule), and the branch-deletion
 * string only after the explicit "also delete the local branch" acknowledgement —
 * neither is a default.
 * @param discard - the user authorized the force/discard path (dirty row or a
 *   host `worktree-submodules` refusal re-armed the acknowledgement).
 * @param deleteBranch - the checked-out branch to delete after a successful
 *   removal (null/undefined = keep the branch, the default).
 * @returns the options consumed by `removeUnregisteredWorktree`.
 */
export function unregisteredRemoveOptions(
  discard: boolean,
  deleteBranch?: string | null,
): { discardChanges?: true; deleteBranch?: string } {
  return {
    ...(discard ? { discardChanges: true as const } : {}),
    ...(deleteBranch === undefined || deleteBranch === null || deleteBranch === '' ? {} : { deleteBranch }),
  }
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
