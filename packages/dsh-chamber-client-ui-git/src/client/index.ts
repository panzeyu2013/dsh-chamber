/** Chamber Git worktree client plugin: the per-workspace sidebar occupant. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only import activates the locale service's Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { gitCoordinator } from '../shared/coordinator.ts'
import { SidebarWorkspaceGitLine } from './SidebarWorkspaceGitLine.tsx'
import type { SidebarWorkspaceGitInjected } from './SidebarWorkspaceGitLine.tsx'
import { en, zh, type GitSidebarKey } from '../locales.ts'

export type {
  SidebarWorkspaceGitInjected, SidebarWorkspaceGitLineProps, WorkspaceGitContext,
} from './SidebarWorkspaceGitLine.tsx'
export type { GitSidebarKey } from '../locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-chamber.sidebar.git': GitSidebarKey
  }
}

export const GIT_WORKSPACE_SLOT = 'sidebar.workspace.git' as const
const NS = 'dsh-chamber.sidebar.git'

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chamber: Git worktree dictionaries')
  // Every N-ctx plugin instance retains the same module-level coordinator;
  // its first/last retain owns the one bridge subscription and poll timer.
  ctx.effect(() => gitCoordinator.attach(), 'dsh-chamber: Git worktree coordinator')

  const t = ctx.locale.bind(NS)

  // Per-workspace occupant (design 08 §11): the sidebar renders this seat
  // once per source (workspaceId '' = source alert strip) and once per
  // workspace group; the occurrence context arrives through the slot-inject
  // `useWorkspaceGitContext` hook (factory owned by the sidebar, git-agnostic).
  const workspaceInjected = (): SidebarWorkspaceGitInjected => ({ t })
  ctx.slots.inject(GIT_WORKSPACE_SLOT, () => ctx.slots.register({
    name: GIT_WORKSPACE_SLOT,
    id: 'workspace-git',
    label: () => t('title'),
    inject: workspaceInjected,
  }, SidebarWorkspaceGitLine))
}
