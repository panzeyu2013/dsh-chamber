/** Register per-instance host rows as owners of their later package-local chunks. */

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
