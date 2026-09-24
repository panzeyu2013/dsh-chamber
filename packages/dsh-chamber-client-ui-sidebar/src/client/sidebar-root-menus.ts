/** Per-row/source menu state and inline-rename machine: the kebab-menu registry,
 *  the dedicated sort-menu id, the armed rename target and its commit. */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { chamberBridge, type ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { getInstanceClient, renameSession } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import { getSearchStates, subscribeSearch } from '@dsh-chamber/dsh-chamber-client-core/search-state'
import { renameWorkspaceForSource } from '@dsh-chamber/dsh-chamber-client-core/workspace-mutations'
import type { RenameTarget } from './sidebar-context.ts'
import type { RunAction } from './sidebar-root-actions.ts'

export function useSidebarMenus({ servers, runAction }: {
  servers: readonly ChamberServerAggregate[]
  runAction: RunAction
}) {
  // Hover-action state: the inline rename target and the open kebab menus (keyed by workspace/session).
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

  // Sort menu open state — DEDICATED (sourceId | null), not a `menuOpen` key: a
  // `${sourceId}/…` key could collide with a real workspace's key (workspace ids are
  // wire directory names — one could be literally `sort`); it also allows only ONE sort menu.
  const [sortMenuOpen, setSortMenuOpen] = useState<string | null>(null)
  // Close the sort menu when its source can no longer render the anchor (source
  // vanished, disconnected, or a snapshot error with no open search capsule), or the
  // state leaks and the menu pops open unprompted on reconnect. Shell-wide, because
  // the per-source sections are UNMOUNTED on the collapsed rail.
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

  // A rename armed on a row that leaves the projection (workspace deleted elsewhere,
  // source snapshot dropped / disconnect) must not stay armed invisibly — it would
  // re-materialize the stale form (with its typed text) when the id reappears.
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
      // The PATCH half of the workspace echo: an echo row's title is `basenameOf(path)`,
      // so on a source whose shell is not mounted the rename looks like a no-op until
      // the mount push arrives; published by the single funnel with the wire call.
      else await renameWorkspaceForSource(target.sourceId, target.id, target.value)
      chamberBridge.requestRefresh(target.sourceId)
    })
  }
  return {
    renaming, setRenaming, menuOpen, toggleMenu, closeMenu, sortMenuOpen, setSortMenuOpen, commitRename,
  }
}
