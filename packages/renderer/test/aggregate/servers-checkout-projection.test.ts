/**
 * PR2 Git layout channel (design 08 §3.2-§3.3): the renderer forwards the per-source
 * repo layouts + their monotonic version into \`deriveServerWorkspaces\`, so a
 * worktree created by ANY producer (seed / forge / agent) becomes a checkout row
 * on the next layout publication — without waiting for an unrelated poll, and
 * without re-deriving sources whose layouts did not change.
 *
 * Pinned here:
 *  - the derived checkout row (kind/path/familyMainId/repoKey + placement of the
 *    session that entered the worktree);
 *  - the per-source layout SIGNATURE is the cache key component (a version bump
 *    with unchanged layouts reuses the entry; a layout change re-derives);
 *  - the wiring locks for the subscription + publish gate (hooks cannot run in
 *    this plain-node program).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  clearWorkspaceGitFlags,
  setSourceRepoLayouts,
  type InstanceAggregate,
  type RepoGitLayout,
} from '@dsh-chamber/dsh-chamber-client-core'
import { createServerProjectionCache, deriveServers, type ServerProjectionCache } from '../../src/host/servers.ts'
import type { HealthResponse } from '../../src/api.ts'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const READY_HEALTH = { dsh: { status: 'ready' } } as unknown as HealthResponse
const MAIN_PATH = '/repo/app'
const CHECKOUT_A = `${MAIN_PATH}/.agents/worktrees/feat-a`
const CHECKOUT_B = `${MAIN_PATH}/.agents/worktrees/feat-b`

function layoutEntry(path: string) {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    worktreeId: `wt:${path}`,
    path,
    branch: path.slice(path.lastIndexOf('/') + 1),
    status: 'ready' as const,
    headState: 'branch' as const,
    attention: [],
    dirty: false,
    locked: false,
    head: 'abc123',
  }
}

function layout(paths: string[]): RepoGitLayout[] {
  return [{ repoKey: 'repo-a', mainWorkspaceId: 'w-main', unregistered: paths.map(layoutEntry) }]
}

function aggregate(): InstanceAggregate {
  return {
    state: 'ok', error: null, archiveSetKnown: true, archivedSessionIds: [],
    workspaces: [{ workspaceId: 'w-main', path: MAIN_PATH, title: 'app', sessionIds: ['s1', 's2'], createdAt: '', updatedAt: '' }],
    sessions: [
      { sessionId: 's1', title: 'One', displayTitle: 'One', running: false, blank: false, cwd: MAIN_PATH, updatedAt: 5 },
      { sessionId: 's2', title: 'Two', displayTitle: 'Two', running: false, blank: false, cwd: MAIN_PATH, workingDirectory: CHECKOUT_A, updatedAt: 6 },
    ],
  }
}

/** One stable aggregate object: the cache key compares input IDENTITY, so a fresh
 *  literal per call would always miss and the reuse assertion would be vacuous. */
const AGGREGATE = aggregate()

function derive(version: number, cache?: ServerProjectionCache) {
  return deriveServers(READY_HEALTH, [], [], {}, { local: AGGREGATE }, {}, {}, {}, 'local', {}, {}, {},
    {}, {}, {}, {}, 'zh', {}, cache, undefined, undefined, undefined, version)
}

test('the layout channel surfaces a derived checkout row with the entered session placed', () => {
  setSourceRepoLayouts('local', layout([CHECKOUT_A]))
  try {
    const [server] = derive(1)
    assert.ok(server !== undefined, 'the local source projects')
    const rows = server!.workspaces
    assert.equal(rows[0]?.id, 'w-main', 'the main keeps its position')
    const checkout = rows.find(row => row.kind === 'checkout')
    assert.ok(checkout !== undefined, 'the unregistered worktree became a row')
    assert.equal(checkout!.path, CHECKOUT_A)
    assert.equal(checkout!.familyMainId, 'w-main')
    assert.equal(checkout!.repoKey, 'repo-a')
    assert.deepEqual(checkout!.sessions.map(session => session.id), ['s2'],
      'workingDirectory placement: the entered session rides the checkout row')
    assert.deepEqual(rows[0]?.sessions.map(session => session.id), ['s1'], 'the main keeps only unplaced members')
    assert.deepEqual(rows[0]?.allSessionIds, ['s1', 's2'], 'the main carries the pre-placement order for drag anchors')
  } finally {
    clearWorkspaceGitFlags('local')
  }
})

test('the per-source layout signature invalidates exactly the sources whose layouts changed', () => {
  setSourceRepoLayouts('local', layout([CHECKOUT_A]))
  try {
    const cache = createServerProjectionCache()
    const first = derive(1, cache)[0]!
    const againSameVersion = derive(1, cache)[0]!
    assert.equal(againSameVersion, first, 'same inputs + same version reuse the cached entry')
    const versionOnly = derive(2, cache)[0]!
    assert.equal(versionOnly, first,
      'a version bump without a layout change keeps the entry (the signature is the layout, not the counter)')
    setSourceRepoLayouts('local', layout([CHECKOUT_A, CHECKOUT_B]))
    const changed = derive(3, cache)[0]!
    assert.notEqual(changed, first, 'a new layout re-derives the source')
    assert.equal(changed.workspaces.filter(row => row.kind === 'checkout').length, 2,
      'the second worktree surfaces as a second checkout row')
  } finally {
    clearWorkspaceGitFlags('local')
  }
})

test('without a version the caller gets the pre-PR2 projection (no checkout rows)', () => {
  setSourceRepoLayouts('local', layout([CHECKOUT_A]))
  try {
    const [server] = deriveServers(READY_HEALTH, [], [], {}, { local: aggregate() }, {}, {}, {}, 'local', {},
      {}, {}, {}, {}, {}, {}, 'zh', {})
    assert.equal(server!.workspaces.some(row => row.kind === 'checkout'), false,
      'the layout store is only consulted when the caller passes the channel token')
    assert.deepEqual(server!.workspaces[0]?.sessions.map(session => session.id), ['s1', 's2'],
      'the main row keeps its full membership (nothing was placed)')
  } finally {
    clearWorkspaceGitFlags('local')
  }
})

test('the projection hook subscribes the Git layout version and feeds it to derive + the publish gate', () => {
  const read = (rel: string): string => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'))
  const hook = read('../../src/app-hooks/use-projection-publish.ts')
  const publish = read('../../src/app-hooks/use-server-projection-publish.ts')
  const servers = read('../../src/host/servers.ts')

  assert.match(hook, /useSyncExternalStore\(\s*subscribeWorkspaceGitFlags, getWorkspaceGitFlagsVersion, getWorkspaceGitFlagsVersion,\s*\)/u,
    'the App re-derives on a Git layout publication (external creation must not wait for a poll)')
  assert.match(hook, /echoes\.removal, gitFlagsVersion\)/u, 'the version is the last deriveServers argument')
  assert.match(hook, /projectionCaches, archivedFilters, gitFlagsVersion\]/u, 'and a memo dependency')
  assert.match(hook, /usePublishServerProjection\(servers, projectionCaches, gitFlagsVersion\)/u,
    'the publish gate receives the version too')
  assert.match(publish, /const gate = `\$\{gitFlagsVersion\}\\u0000\$\{signature\}`/u,
    'the gate compares version + content signature')
  assert.match(publish, /rememberServersProjectionSignature\(servers, signature\)/u,
    'the subscriber-facing memory keeps the PLAIN content signature (the shell re-compares it)')
  assert.match(servers, /const repoLayouts: readonly RepoGitLayout\[\] = gitFlagsVersion === undefined \? \[\] : getSourceRepoLayouts\(id\)/u,
    'the layouts are read per source at derive time')
  assert.match(servers, /repoLayoutSignature,/u, 'the layout signature is a per-source cache key component')
  assert.match(servers, /repoLayouts,\n\s*gitFlagsVersion,/u, 'both reach deriveServerWorkspaces (layouts + version)')
})
