/** Chamber Git worktree sidebar occupant. Facts/actions stay in shared/coordinator. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only import activates the locale service's Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { gitCoordinator } from '../shared/coordinator.ts'
import { SidebarGitSection } from './SidebarGitSection.tsx'
import type { SidebarGitInjected } from './SidebarGitSection.tsx'
import { en, zh, type GitSidebarKey } from '../locales.ts'

export type { SidebarGitInjected, SidebarGitSectionProps } from './SidebarGitSection.tsx'
export type { GitSidebarKey } from '../locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-chamber.sidebar.git': GitSidebarKey
  }
}

export const GIT_SIDEBAR_SLOT = 'sidebar.git' as const
const NS = 'dsh-chamber.sidebar.git'

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chamber: Git worktree dictionaries')
  // Every N-ctx plugin instance retains the same module-level coordinator;
  // its first/last retain owns the one bridge subscription and poll timer.
  ctx.effect(() => gitCoordinator.attach(), 'dsh-chamber: Git worktree coordinator')

  const t = ctx.locale.bind(NS)
  const chamberInstanceId = (ctx as ClientContext & { chamberInstanceId?: string }).chamberInstanceId
  const injected = (): SidebarGitInjected => ({ t, chamberInstanceId })

  ctx.slots.inject(GIT_SIDEBAR_SLOT, () => ctx.slots.register({
    name: GIT_SIDEBAR_SLOT,
    id: 'worktrees',
    label: () => t('title'),
    inject: injected,
  }, SidebarGitSection))
}
