/** Shared inject types for the Git sidebar occupants. */
import type { GitSidebarKey } from '../locales.ts'

export interface WorkspaceGitInjected {
  t: (key: GitSidebarKey) => string
}
