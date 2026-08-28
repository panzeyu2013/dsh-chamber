/** Registers the chamber sidebar shell (design 05 §2) into the layout-owned slot. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { indexSubagentDescendants } from '@deepseek-ai/dsh-client-runtime/client'
import type { ObservableSnapshot, SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SidebarRootInjected } from './contract/slots.ts'
import { SidebarRoot } from './SidebarRoot.tsx'
import { en, zh, type SidebarKey } from './locales.ts'
import { chamberBridge } from '../shared/aggregate-store.ts'
import {
  dshVersionFromHostDescription,
  instanceSnapshotSignature,
  projectInstanceSnapshot,
  projectRuntimeFacts,
} from '../shared/derive.ts'

export type {
  SidebarFooterActionOwnerProps, SidebarRootComponentProps, SidebarRootInjected,
  SidebarSectionOwnerProps, SidebarSettingsOwnerProps, SidebarWorkspaceGitOwnerProps,
} from './contract/slots.ts'
export type { SidebarKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sidebar shell controls copy. */
    sidebar: SidebarKey
  }
}

/** Dictionary namespace owned by this plugin (shell controls copy). */
const NS = 'sidebar'

/** Services required by the sidebar plugin. */
export const inject = ['slots', 'layout', 'sessions', 'workspaces', 'locale', 'connection']

/**
 * Registers the sidebar shell and its service callbacks. The hole
 * declarations match the official shell (ui-settings / footer actions render
 * in the foot; `sidebar.workspaces` stays declared so ui-workspace's
 * registration does not fail — the chamber shell renders its own multi-source
 * list in the region instead, 05 §2).
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chamber: sidebar dictionaries')

  const injectProps = (): SidebarRootInjected => ({
    // The shell's New Session button rides the runtime's shared action
    // (current Session Workspace, then recent Workspace) — of THIS ctx, so it
    // always acts on the current source.
    startSession: (workspaceId) => { ctx.workspaces.startSession(workspaceId) },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    // chamber patch (05 §4): the renderer shell sets the per-boot instance id
    // through the chamber knob while the boot owns the base-path window knob.
    chamberInstanceId: (ctx as any).chamberInstanceId as string | undefined,
    // chamber (05 §4): the in-app directory-browser dialog copy — the browse
    // directory-picker package (mounted in every boot) owns this namespace.
    directoryBrowserT: ctx.locale.bind('directory-browser'),
  })
  ctx.effect(
    () => ctx.slots.register({
      name: 'sidebar',
      locale: NS,
      children: {
        'sidebar.workspaces': { kind: 'single', scope: 'root' },
        // chamber (08 §11): the per-workspace Git hole. The slot-level inject
        // factory is git-agnostic (closes over only the sidebar-owned
        // occurrence context); the chamber Git plugin consumes the bound
        // `useWorkspaceGitContext` hook.
        'sidebar.workspace.git': {
          kind: 'single',
          scope: 'root',
          inject: {
            hooks: {
              workspaceGitContext: (
                _standard: object,
                context: { sourceId: string; workspaceId: string; repoKey?: string },
              ) => () => ({ sourceId: context.sourceId, workspaceId: context.workspaceId, repoKey: context.repoKey }),
            },
          },
        },
        'sidebar.settings': { kind: 'single', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
      },
      inject: injectProps,
    }, SidebarRoot),
    'dsh-chamber: sidebar slot registration',
  )

  // chamber patch (06 §4.3/§4.5): the runtime-facts channel's producer end.
  // Every boot is its own ctx with its own sessions store, so this plugin —
  // mounted in every ctx — reports THIS instance's runtime facts (current
  // session, pending interactions, completions, every session's live
  // `running` bit, and per-parent RUNNING subagent counts from the vendor
  // lineage index) to the chamber bridge. The App layer merges the report
  // into the multi-source projection (server.runtime) and derives the
  // completed-but-unread dots itself (it owns the active view and every open
  // request — see App.tsx); the sidebar renders dots/highlights from the
  // projection for every source. The component no longer subscribes to the
  // store itself; boot frames before the first report simply render no
  // highlight (06 §4.3). zustand subscribe does not fire on mount, so the
  // snapshot is reported immediately. This producer keeps NO state of its own
  // — the report is a pure pass-through of the source's own list snapshot,
  // and the subagent counts reuse the vendor's indexSubagentDescendants
  // verbatim (runningCount per parent through uninterrupted subagent-origin
  // lineage — the same number the official ui-workspace tree renders, so the
  // subagent-live ring semantics can never drift from the official UI).
  ctx.effect(() => {
    const chamberInstanceId = (ctx as any).chamberInstanceId as string | undefined
    if (chamberInstanceId === undefined) return () => {}
    const sessionsList = (ctx.sessions as unknown as { list: ObservableSnapshot<SessionListState> }).list
    const workspacesList = (ctx.workspaces as unknown as { list: ObservableSnapshot<WorkspaceListState> }).list
    const snapshotProducer = chamberBridge.registerInstanceSnapshotProducer(chamberInstanceId)
    const hostProducer = chamberBridge.registerInstanceHostProducer(chamberInstanceId)
    const hostDescription = (ctx as unknown as {
      connection: {
        hostDescription: {
          getSnapshot(): unknown
          subscribe(listener: () => void): () => void
        }
      }
    }).connection.hostDescription
    let snapshotSignature = ''
    let snapshotQueued = false
    let disposed = false

    const syncSnapshot = (): void => {
      snapshotQueued = false
      if (disposed) return
      const projected = projectInstanceSnapshot(workspacesList.getSnapshot(), sessionsList.getSnapshot())
      if (projected === undefined) {
        snapshotSignature = ''
        snapshotProducer.report(undefined)
        return
      }
      const nextSignature = instanceSnapshotSignature(projected)
      if (nextSignature === snapshotSignature) return
      snapshotSignature = nextSignature
      snapshotProducer.report(projected)
    }
    const queueSnapshot = (): void => {
      if (snapshotQueued) return
      snapshotQueued = true
      queueMicrotask(syncSnapshot)
    }
    const sync = (): void => {
      const snapshot = sessionsList.getSnapshot()
      // 06 §4.5: per-parent RUNNING subagent descendant counts (sparse — only
      // parents with at least one running descendant appear).
      const subagentRunning = new Map<string, number>()
      for (const [parentId, summary] of indexSubagentDescendants(snapshot.byId)) {
        if (summary.runningCount > 0) subagentRunning.set(parentId, summary.runningCount)
      }
      chamberBridge.reportInstanceRuntime(chamberInstanceId, projectRuntimeFacts(snapshot, subagentRunning))
      queueSnapshot()
    }
    const syncHost = (): void => {
      const dshVersion = dshVersionFromHostDescription(hostDescription.getSnapshot())
      hostProducer.report(dshVersion === undefined ? undefined : { dshVersion })
    }
    sync()
    syncHost()
    queueSnapshot()
    const unsubscribeSessions = sessionsList.subscribe(sync)
    const unsubscribeWorkspaces = workspacesList.subscribe(queueSnapshot)
    const unsubscribeHost = hostDescription.subscribe(syncHost)
    return () => {
      disposed = true
      unsubscribeSessions()
      unsubscribeWorkspaces()
      unsubscribeHost()
      snapshotProducer.clear()
      hostProducer.clear()
      chamberBridge.clearInstanceRuntime(chamberInstanceId)
    }
  }, 'dsh-chamber: sidebar runtime facts report')
}
