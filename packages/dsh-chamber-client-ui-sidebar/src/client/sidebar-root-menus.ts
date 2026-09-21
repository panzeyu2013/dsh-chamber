/**
 * Per-row/source menu state and the inline-rename machine (extracted verbatim
 * from SidebarRoot, 2026-12 split): the kebab-menu registry, the dedicated
 * sort-menu id, the armed rename target and its commit.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { chamberBridge, type ChamberServerAggregate } from '../shared/aggregate-store.ts'
import { getInstanceClient, renameSession } from '../shared/instance-api.ts'
import { getSearchStates, subscribeSearch } from '../shared/search-state.ts'
import { renameWorkspaceForSource } from '../shared/workspace-mutations.ts'
import type { RenameTarget } from './sidebar-context.ts'
import type { RunAction } from './sidebar-root-actions.ts'

export function useSidebarMenus({ servers, runAction }: {
  servers: readonly ChamberServerAggregate[]
  runAction: RunAction
}) {
  // Hover-action state: the inline rename target, the per-row failure text,
  // the open kebab menus (keyed by workspace/session), and the add-workspace
  // directory-browser dialog (target source + whether the workspace.create
  // confirm is in flight — the dialog's busy freeze).
  const [renaming, setRenaming] = useState<RenameTarget | null>(null)

  const [menuOpen, setMenuOpen] = useState<Record<string, boolean>>({})
  const toggleMenu = (key: string): void => {
    setMenuOpen(prev => ({ ...prev, [key]: prev[key] !== true }))
  }
  const closeMenu = (key: string): void => {
    setMenuOpen(prev => {
      if (prev[key] !== true) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  // Sort menu open state — DEDICATED (sourceId | null) instead of a
  // `menuOpen` key: a `${sourceId}/…`-shaped key would collide with a real
  // workspace's key (workspace ids are wire directory names — one could be
  // literally `sort`), cross-opening the workspace kebab and the sort menu.
  // A separate state also allows only ONE sort menu across sources.
  const [sortMenuOpen, setSortMenuOpen] = useState<string | null>(null)
  // chamber (06 §3.1): close the sort menu when its source can no longer
  // render the anchor (source vanished, disconnected, or a snapshot-fetch
  // error with no open search capsule) — otherwise the state leaks and the
  // menu pops open unprompted on reconnect. Runs shell-wide because the
  // per-source sections are UNMOUNTED on the rail (collapsed): a disconnect
  // while collapsed must still close the menu id.
  const searchStates = useSyncExternalStore(subscribeSearch, getSearchStates, getSearchStates)
  useEffect(() => {
    if (sortMenuOpen === null) return
    const server = servers.find(candidate => candidate.id === sortMenuOpen)
    if (server === undefined) {
      setSortMenuOpen(null)
      return
    }
    const search = searchStates.get(sortMenuOpen)
    if (!server.connected || (server.aggregateError !== undefined && search?.expanded !== true)) {
      setSortMenuOpen(null)
    }
  }, [servers, sortMenuOpen, searchStates])

  // chamber (行内重命名): a rename armed on a row that leaves the projection
  // (workspace deleted by another ctx, source snapshot dropped / disconnect,
  // …) must not stay armed invisibly — it would re-materialize the stale
  // form (with its typed text) when the id reappears. Mirrors the sort-menu
  // cleanup above: drop the target once its row no longer exists.
  useEffect(() => {
    if (renaming === null) return
    const server = servers.find(candidate => candidate.id === renaming.sourceId)
    const alive = server !== undefined && (renaming.kind === 'workspace'
      ? server.workspaces.some(workspace => workspace.id === renaming.id)
      : server.workspaces.some(workspace => workspace.sessions.some(session => session.id === renaming.id)))
    if (!alive) setRenaming(null)
  }, [servers, renaming])

  const commitRename = (): void => {
    if (renaming === null) return
    const target = renaming
    setRenaming(null)
    runAction(`${target.sourceId}/${target.kind}/${target.id}/rename`, async () => {
      const client = getInstanceClient(target.sourceId)
      if (target.kind === 'session') await renameSession(client, target.id, target.value)
      // chamber (2026-09-11 review S3 / 2026-12 收口, design 05 §2.2.1): the
      // PATCH half of the workspace echo — an echo row's title is
      // `basenameOf(path)`, so on a source whose shell is not mounted the rename
      // used to look like a no-op until the mount push arrived. Published by the
      // single funnel together with the wire call.
      else await renameWorkspaceForSource(target.sourceId, target.id, target.value)
      chamberBridge.requestRefresh(target.sourceId)
    })
  }
  return {
    renaming, setRenaming, menuOpen, toggleMenu, closeMenu, sortMenuOpen, setSortMenuOpen, commitRename,
  }
}
