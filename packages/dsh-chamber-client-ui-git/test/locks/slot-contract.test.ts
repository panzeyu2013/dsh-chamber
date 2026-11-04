import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

/** The sidebar shell sources that mount the git seat (layout-agnostic: the
 *  render may live in either file). */
function sidebarMountSources(): string[] {
  return [
    source('../../../dsh-chamber-client-ui-sidebar/src/client/SidebarRoot.tsx'),
    source('../../../dsh-chamber-client-ui-sidebar/src/client/ServerSection.tsx'),
  ]
}

test('the per-workspace Git seat is declared in the SlotMap, declared in the sidebar children table, and registered by the plugin', () => {
  const slots = source('../../../dsh-chamber-client-ui-sidebar/src/client/contract/slots.ts')
  const sidebarIndex = source('../../../dsh-chamber-client-ui-sidebar/src/client/index.ts')
  const mountSources = sidebarMountSources()
  const mountCombined = mountSources.join('\n')
  const gitIndex = source('../../src/client/index.ts')
  const gitLine = source('../../src/client/SidebarWorkspaceGitLine.tsx')

  // SlotMap: the occurrence context (a named interface since PR2) + the slot-inject
  // factory type. The context must carry the frozen reachable identities: the
  // source, the row (workspace id; `''` for source scope), the repository key and
  // the DERIVED checkout occurrence of a `kind:'checkout'` row.
  assert.match(slots, /'sidebar\.workspace\.git':\s*\{[\s\S]*?hookContext:\s*SidebarWorkspaceGitContext/)
  assert.match(slots, /inject:\s*\{\s*hooks:\s*\{\s*workspaceGitContext:/)
  const contextStart = slots.indexOf('export interface SidebarWorkspaceGitContext {')
  assert.notEqual(contextStart, -1, 'the sidebar declares the occurrence context interface')
  const contextType = slots.slice(contextStart)
  assert.match(contextType, /sourceId:\s*string/)
  assert.match(contextType, /workspaceId:\s*string/)
  assert.match(contextType, /repoKey\?:\s*string/)
  assert.match(contextType, /checkout\?:\s*\{\s*path:\s*string;\s*branch:\s*string(?:\s*\|\s*null)?;\s*title:\s*string\s*\}/,
    'a derived checkout row carries { path, branch, title }')
  // The sidebar's runtime children table must declare the seat (a missing
  // declaration silently stops the plugin's inject from ever registering).
  assert.match(sidebarIndex, /'sidebar\.workspace\.git':\s*\{\s*kind:\s*'single',\s*scope:\s*'root',\s*inject:\s*\{\s*hooks:/)
  // The hook factory must hand the SAME occurrence context back (identity, not a
  // rebuilt subset) — that is what carries the derived checkout fields through.
  assert.match(sidebarIndex, /workspaceGitContext:\s*\(\s*_standard:\s*object,\s*context:\s*SidebarWorkspaceGitContext,?\s*\)\s*=>\s*\(\)\s*=>\s*context/)
  // Render sites (SidebarRoot or ServerSection): source-level
  // alert (workspaceId '') + per-workspace occupant rendered INSIDE the
  // workspace header row (before rowActions — OpenChamber-style, the row
  // itself is the git surface).
  assert.match(mountCombined, /renderWorkspaceGit\('sidebar\.workspace\.git', \{ wide \}, \{\s*hookContext:\s*\{\s*sourceId:\s*server\.id,\s*workspaceId:\s*''/)
  assert.match(mountCombined, /renderWorkspaceGit\('sidebar\.workspace\.git', \{ wide \}, \{\s*hookContext:\s*\{\s*sourceId:\s*server\.id,\s*workspaceId:\s*workspace\.id/)
  // The per-workspace occupant (workspaceId: workspace.id) must sit after
  // the workspace title and before (left of) the row actions cluster. The
  // legacy repo-scoped unregistered mounts are gone (PR3) — locate the
  // workspace-scoped call specifically, in whichever file owns it.
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
