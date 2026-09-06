import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

/** The sidebar shell sources that mount the git seat (layout-agnostic: the
 *  per-source subtree was extracted from SidebarRoot into ServerSection). */
function sidebarMountSources(): string[] {
  return [
    source('../../dsh-chamber-client-ui-sidebar/src/client/SidebarRoot.tsx'),
    source('../../dsh-chamber-client-ui-sidebar/src/client/ServerSection.tsx'),
  ]
}

test('the standalone sidebar.git panel seat is removed (features deferred to a future phase)', () => {
  const slots = source('../../dsh-chamber-client-ui-sidebar/src/client/contract/slots.ts')
  const mountSources = sidebarMountSources()
  const gitIndex = source('../src/client/index.ts')

  assert.ok(!slots.includes("'sidebar.git'"), 'sidebar.git seat must be removed from slots.ts')
  for (const mountSource of mountSources) {
    assert.ok(!mountSource.includes('css.gitArea'), 'sidebar.git render site must be removed')
    assert.ok(!mountSource.includes("renderSlot('sidebar.git'"), 'sidebar.git renderSlot must be removed')
  }
  assert.ok(!gitIndex.includes('GIT_SIDEBAR_SLOT'), 'the git plugin must not register sidebar.git')
  assert.ok(!gitIndex.includes('SidebarGitSection'), 'the panel component must be gone from the plugin entry')
})

test('the per-workspace Git seat is declared in the SlotMap, declared in the sidebar children table, and registered by the plugin', () => {
  const slots = source('../../dsh-chamber-client-ui-sidebar/src/client/contract/slots.ts')
  const sidebarIndex = source('../../dsh-chamber-client-ui-sidebar/src/client/index.ts')
  const mountSources = sidebarMountSources()
  const mountCombined = mountSources.join('\n')
  const gitIndex = source('../src/client/index.ts')
  const gitLine = source('../src/client/SidebarWorkspaceGitLine.tsx')

  // SlotMap: hookContext + slot-inject factory type.
  assert.match(slots, /'sidebar\.workspace\.git':\s*\{[\s\S]*?hookContext:\s*\{\s*sourceId:\s*string;\s*workspaceId:\s*string(?:;\s*repoKey\?:\s*string)?\s*\}/)
  assert.match(slots, /inject:\s*\{\s*hooks:\s*\{\s*workspaceGitContext:/)
  // The sidebar's runtime children table must declare the seat (a missing
  // declaration silently stops the plugin's inject from ever registering —
  // the P0 regression this test guards).
  assert.match(sidebarIndex, /'sidebar\.workspace\.git':\s*\{\s*kind:\s*'single',\s*scope:\s*'root',\s*inject:\s*\{\s*hooks:\s*\{\s*workspaceGitContext:/)
  assert.ok(!sidebarIndex.includes("'sidebar.git'"), 'sidebar children must not declare the removed panel seat')
  // Render sites (SidebarRoot or the extracted ServerSection): source-level
  // alert (workspaceId '') + per-workspace occupant rendered INSIDE the
  // workspace header row (before rowActions — OpenChamber-style, the row
  // itself is the git surface).
  assert.match(mountCombined, /renderWorkspaceGit\('sidebar\.workspace\.git', \{ wide \}, \{\s*hookContext:\s*\{\s*sourceId:\s*server\.id,\s*workspaceId:\s*''/)
  assert.match(mountCombined, /renderWorkspaceGit\('sidebar\.workspace\.git', \{ wide \}, \{\s*hookContext:\s*\{\s*sourceId:\s*server\.id,\s*workspaceId:\s*workspace\.id/)
  // The per-workspace occupant (workspaceId: workspace.id) must sit after
  // the workspace title and before (left of) the row actions cluster. The
  // repo-scoped unregistered mounts render LATER (after the list) — locate
  // the workspace-scoped call specifically, in whichever file owns it.
  const workspaceMount = mountSources.find(mount =>
    mount.includes('hookContext: { sourceId: server.id, workspaceId: workspace.id },'))
  assert.ok(workspaceMount !== undefined, 'the per-workspace occupant render exists')
  const workspaceRender = workspaceMount!.indexOf('hookContext: { sourceId: server.id, workspaceId: workspace.id },')
  assert.ok(workspaceMount!.indexOf('workspaceTitle') < workspaceRender, 'the occupant renders after the workspace title')
  assert.ok(workspaceRender < workspaceMount!.indexOf('cc.rowActions'), 'the git occupant must render before (left of) the row actions')
  // Plugin registration: the entry inject must NOT carry the hooks factory
  // (entry injects bind hooks as observables — the factory belongs to the
  // slot inject, provided by the sidebar).
  assert.match(gitIndex, /GIT_WORKSPACE_SLOT = 'sidebar\.workspace\.git'/)
  assert.match(gitIndex, /ctx\.slots\.inject\(GIT_WORKSPACE_SLOT/)
  assert.ok(!gitIndex.includes('workspaceGitContext'), 'the hooks factory must live in the slot inject, not the entry inject')
  // The occupant consumes the bound context hook and matches by workspaceId.
  assert.match(gitLine, /useWorkspaceGitContext/)
  assert.match(gitLine, /context\.workspaceId === ''/)
  assert.match(gitLine, /gitFactsForWorkspace\(snapshot, context\.workspaceId\)/)
})
