import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

test('sidebar owner, Git occupant, and render site use the same sidebar.git key', () => {
  const slots = source('../../dsh-chamber-client-ui-sidebar/src/client/contract/slots.ts')
  const sidebarIndex = source('../../dsh-chamber-client-ui-sidebar/src/client/index.ts')
  const sidebarRoot = source('../../dsh-chamber-client-ui-sidebar/src/client/SidebarRoot.tsx')
  const gitIndex = source('../src/client/index.ts')
  const gitSection = source('../src/client/SidebarGitSection.tsx')

  assert.match(slots, /'sidebar\.git':\s*\{\s*kind:\s*'single';\s*scope:\s*'root';\s*owner:\s*SidebarGitOwnerProps/)
  assert.match(slots, /export interface SidebarGitOwnerProps\s*\{[\s\S]*?wide:\s*boolean/)
  assert.match(sidebarIndex, /'sidebar\.git':\s*\{ kind:\s*'single', scope:\s*'root' \}/)
  assert.match(gitIndex, /GIT_SIDEBAR_SLOT = 'sidebar\.git'/)
  assert.match(gitIndex, /ctx\.slots\.inject\(GIT_SIDEBAR_SLOT/)
  assert.match(gitSection, /if \(!wide\) return null/)

  const region = sidebarRoot.indexOf('className={css.regionArea}')
  const git = sidebarRoot.indexOf('className={css.gitArea}')
  const foot = sidebarRoot.indexOf('className={css.footArea}')
  assert.ok(region >= 0 && git > region && foot > git, 'sidebar.git must render between region and foot')
  assert.match(sidebarRoot, /renderSlot\('sidebar\.git', \{ wide \}\)/)
})
