/** Register/unregister per-instance host rows as owners of their later package-local chunks. */

import type { BootModuleRow, ClientModuleSystem } from '@deepseek-ai/dsh-client-modules/client'

type ChunkOwnerRegistry = Map<string, BootModuleRow>

/**
 * The upstream module system resolves `require.async('./chunk.js')` against its
 * private boot-row index. Chamber extra rows arrive after page boot and are
 * preloaded per source, so enroll their descriptors before any entry can ask
 * for a package-local chunk. Keep this single adapter at the fork boundary;
 * if upstream changes the index representation, fail before an interactive
 * feature reaches a blank chunk-error state.
 */
export function registerExtraChunkOwners(
  modules: ClientModuleSystem,
  rows: readonly BootModuleRow[] | undefined,
): readonly string[] {
  if (rows === undefined || rows.length === 0) return []
  const registry = (modules as unknown as { graphRows?: unknown }).graphRows
  if (!(registry instanceof Map)) {
    throw new Error('dsh-client-web: upstream module system no longer exposes the boot-row chunk-owner index')
  }
  const graphRows = registry as ChunkOwnerRegistry
  const added: string[] = []
  for (const row of rows) {
    if (graphRows.has(row.id)) continue
    graphRows.set(row.id, { ...row, initialUrl: row.initialUrl || row.url })
    added.push(row.id)
  }
  return added
}

/**
 * The symmetric UNDO of {@link registerExtraChunkOwners}: a live-synced row that
 * leaves the instance's graph must stop owning chunks, or a row that later
 * `require()`s the removed id resolves it through a resurrected dependency and
 * executes an uninstalled plugin's bundle. Same fork-boundary guard as the
 * register half: a changed index representation throws across this boundary. The
 * live callers keep the DELETE best-effort (a throw is warned and the stale owner
 * stays page-level), while the register half's throw becomes a named boot fact —
 * so a fork break is loud on the add path, quiet on the remove path.
 * @returns the ids actually removed (an id with no owner is skipped).
 */
export function removeExtraChunkOwners(
  modules: ClientModuleSystem,
  ids: Iterable<string>,
): readonly string[] {
  const registry = (modules as unknown as { graphRows?: unknown }).graphRows
  if (!(registry instanceof Map)) {
    throw new Error('dsh-client-web: upstream module system no longer exposes the boot-row chunk-owner index')
  }
  const graphRows = registry as ChunkOwnerRegistry
  const removed: string[] = []
  for (const id of ids) {
    if (!graphRows.delete(id)) continue
    removed.push(id)
  }
  return removed
}
