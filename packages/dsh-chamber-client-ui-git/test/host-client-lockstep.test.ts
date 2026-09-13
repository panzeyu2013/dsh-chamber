/**
 * HOST ↔ CLIENT LOCKSTEP (cross-package, 2026-09 review items 3 + 4).
 *
 * Both sides were previously tested only against their OWN fixture: this
 * package's `snapshot-facts.test.ts` hand-writes snapshot objects, and the host
 * package's `core.test.ts` mocks host state. A host row field renamed (or a
 * snapshot diagnostic code added) therefore kept both suites green while the
 * real UI silently dropped rows — `normalizeWorktree` fails closed and the row
 * disappears with only an `invalid-worktree` error.
 *
 * This suite closes that gap from the client side: it imports the REAL host
 * core and runs a REAL `GitWorktreeCore.snapshot()` against in-memory host
 * mocks, then feeds that exact response to `normalizeGitSnapshot`.
 *
 * IMPORT STYLE: a RELATIVE path into the host package source
 * (`../../dsh-chamber-seed-git-worktree/src/core.ts`), not a package specifier
 * — the host package publishes only a bundled `dist/index.js` (no `exports` map
 * or type surface for tests), while both sources are plain `.ts` that Node's
 * type stripping loads directly. Consequence: `typecheck:git` type-checks the
 * host core under THIS package's stricter compiler options.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import {
  GitWorktreeCore,
  RETRYABLE_CODES,
  type GitCommandRequest,
  type GitCommandResult,
  type GitRunner,
  type SnapshotResult,
  type SnapshotWorktree,
  type WorktreeFileSystem,
} from '../../dsh-chamber-seed-git-worktree/src/core.ts'
import {
  DETERMINISTIC_GIT_REJECTION_CODES,
  DETERMINISTIC_HOST_RETRYABLE_OVERRIDES,
  GitWorktreeRpcError,
  isAmbiguousGitRpcFailure,
  isDeterministicGitRejection,
} from '../src/shared/git-api.ts'
import { normalizeGitSnapshot } from '../src/shared/snapshot.ts'

const MAIN = '/repos/project'
const COMMON = '/repos/project/.git'
const LINKED = '/repos/feature'
const UNREGISTERED = '/repos/unregistered'
const DETACHED = '/repos/detached'
const MAIN_HEAD = '1'.repeat(40)
const FEATURE_HEAD = '2'.repeat(40)
const UNREGISTERED_HEAD = '3'.repeat(40)
const DETACHED_HEAD = '4'.repeat(40)
/** The linked worktree's admin git dir (`<common>/worktrees/feature`). */
const LINKED_GIT_DIR = '/repos/project/.git/worktrees/feature'
/** Host core source text: the code-vocabulary side of the error-code lockstep. */
const HOST_CORE_SOURCE = readFileSync(
  new URL('../../dsh-chamber-seed-git-worktree/src/core.ts', import.meta.url),
  'utf8',
)

/** The fields the client's `normalizeWorktree` decodes. A host rename of any of
 *  them drops the row (fail-closed) and must fail this suite instead. */
const CLIENT_ROW_FIELDS = [
  'worktreeId', 'path', 'head', 'branch', 'isMain', 'dirty', 'locked', 'status',
  'headState', 'upstream', 'ahead', 'behind', 'attention', 'workspaceId',
  'sessionIds', 'runningSessionIds', 'blockingRunningSessionIds',
]

class MissingPathError extends Error {
  readonly code = 'ENOENT'
}

interface FakeRow {
  path: string
  branch: string | null
  head: string
  dirty?: boolean
  upstream?: string
  ahead?: number
  behind?: number
}

/** In-memory host Git + filesystem, reduced to the read-only snapshot path. */
class FakeHost {
  readonly rows: FakeRow[] = [
    { path: MAIN, branch: 'main', head: MAIN_HEAD },
    { path: LINKED, branch: 'feature', head: FEATURE_HEAD, dirty: true, upstream: 'origin/feature', ahead: 2, behind: 1 },
    { path: UNREGISTERED, branch: 'unreg', head: UNREGISTERED_HEAD },
    { path: DETACHED, branch: null, head: DETACHED_HEAD },
  ]
  readonly workspaces = [
    { workspaceId: 'ws-main', path: MAIN, sessionIds: ['s-running', 's-archived'] },
    { workspaceId: 'ws-feature', path: LINKED, sessionIds: ['s-feature'] },
  ]
  readonly agents = [
    { sessionId: 's-running', status: 'running' as const, cwd: MAIN },
    { sessionId: 's-archived', status: 'running' as const, cwd: MAIN },
    { sessionId: 's-feature', status: 'idle' as const, cwd: LINKED },
  ]
  readonly archived: string[] = ['s-archived']
  readonly existing = new Set<string>([MAIN, COMMON, LINKED, UNREGISTERED, DETACHED])
  /** Paths the filesystem resolves but the registry does not own. */
  readonly unregistered = new Set<string>()
  /** Linked worktree `.git` pointer targets. */
  readonly gitDirs = new Map<string, string>([[LINKED, LINKED_GIT_DIR]])
  /** git-dir state files that mark an in-progress Git operation. */
  readonly gitDirStateFiles = new Map<string, Set<string>>([[LINKED_GIT_DIR, new Set(['MERGE_HEAD'])]])
  readonly branches = new Map<string, string>([['main', MAIN_HEAD], ['feature', FEATURE_HEAD], ['unreg', UNREGISTERED_HEAD]])
  readonly calls: GitCommandRequest[] = []

  readonly fs: WorktreeFileSystem = {
    realpath: async path => {
      if (!this.existing.has(path)) throw new MissingPathError(path)
      return path
    },
    lstat: async path => {
      if (this.gitDirs.has(dirname(path)) && basename(path) === '.git') return { isDirectory: () => false }
      if (!this.existing.has(path)) throw new MissingPathError(path)
      return { isDirectory: () => true }
    },
    mkdir: async () => {},
    exists: async path => {
      if (this.gitDirs.has(dirname(path)) && basename(path) === '.git') return true
      for (const [gitDir, files] of this.gitDirStateFiles) {
        if (path.startsWith(`${gitDir}/`)) return files.has(path.slice(gitDir.length + 1))
      }
      return this.existing.has(path)
    },
    readFile: async path => {
      const gitDir = this.gitDirs.get(dirname(path))
      if (gitDir !== undefined && basename(path) === '.git') return `gitdir: ${gitDir}`
      throw new MissingPathError(path)
    },
  }

  readonly runner: GitRunner = async request => {
    this.calls.push({ ...request, args: [...request.args] })
    const args = request.args
    const row = (path: string): FakeRow | undefined => this.rows.find(candidate => candidate.path === path)
    const result = (exitCode: number, stdout = '', stderr = ''): GitCommandResult => ({ exitCode, stdout, stderr })
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      const found = row(request.cwd)
      return found === undefined ? result(128, '', 'not a git repository') : result(0, `${found.path}\n`)
    }
    if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') {
      return row(request.cwd) === undefined ? result(128, '', 'not a git repository') : result(0, `${COMMON}\n`)
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      const fields: string[] = []
      for (const entry of this.rows) {
        fields.push(`worktree ${entry.path}`, `HEAD ${entry.head}`)
        fields.push(entry.branch === null ? 'detached' : `branch refs/heads/${entry.branch}`)
        fields.push('')
      }
      return result(0, `${fields.join('\0')}\0`)
    }
    if (args[0] === 'status') {
      const entry = row(request.cwd)
      if (entry === undefined) return result(128, '', 'not a git repository')
      const meta: string[] = []
      if ((entry.ahead ?? 0) > 0) meta.push(`ahead ${entry.ahead}`)
      if ((entry.behind ?? 0) > 0) meta.push(`behind ${entry.behind}`)
      const suffix = meta.length === 0 ? '' : ` [${meta.join(', ')}]`
      const name = entry.upstream === undefined ? (entry.branch ?? 'HEAD (no branch)') : `${entry.branch}...${entry.upstream}`
      return result(0, `## ${name}${suffix}\0${entry.dirty === true ? ' M changed.txt\0' : ''}`)
    }
    if (args[0] === 'show-ref' && args[1] === '--heads') {
      const lines = [...this.branches].map(([name, head]) => `${head} refs/heads/${name}`)
      return result(0, lines.length === 0 ? '' : `${lines.join('\n')}\n`)
    }
    throw new Error(`the snapshot lockstep test issued an unexpected Git call: ${args.join(' ')}`)
  }
}

/** Run the REAL host snapshot against the in-memory mocks. */
async function hostSnapshot(host: FakeHost): Promise<SnapshotResult> {
  const core = new GitWorktreeCore({
    source: {
      listWorkspaces: () => host.workspaces.map(workspace => ({ ...workspace, sessionIds: [...workspace.sessionIds] })),
      listAgents: () => host.agents.map(agent => ({ ...agent })),
      listArchivedSessionIds: () => [...host.archived],
    },
    git: host.runner,
    fs: host.fs,
    worktreesRoot: '/worktrees',
  })
  return await core.snapshot()
}

test('the REAL host snapshot decodes with ZERO client errors: every row field is in lockstep', async () => {
  const snapshot = await hostSnapshot(new FakeHost())
  // The host source itself is healthy in this scenario — no sourceError, and
  // the only diagnostic is the unregistered row's absent workspace.
  assert.equal(snapshot.sourceError, undefined)
  assert.deepEqual(snapshot.errors, [])
  assert.equal(snapshot.repos.length, 1)

  const normalized = normalizeGitSnapshot(snapshot)
  assert.deepEqual(normalized.errors, [],
    'a host row renaming a client-decoded field (or a new malformed value) would fail closed here instead of silently dropping rows')
  assert.equal(normalized.repos.length, 1)
  const repo = snapshot.repos[0]!
  const decoded = normalized.repos[0]!
  assert.equal(decoded.repoId, repo.repoId)
  assert.equal(decoded.commonDir, repo.commonDir)
  assert.equal(decoded.mainPath, repo.mainPath)
  assert.deepEqual(decoded.branches, repo.branches)
  // Same rows, same order, same identities: nothing was dropped or merged.
  assert.deepEqual(
    decoded.worktrees.map(row => row.worktreeId),
    repo.worktrees.map(row => row.worktreeId),
  )
  assert.equal(decoded.worktrees.length, 4)
  for (const [index, row] of decoded.worktrees.entries()) {
    const hostRow: SnapshotWorktree = repo.worktrees[index]!
    assert.deepEqual(Object.keys(row).sort(), [...CLIENT_ROW_FIELDS].sort(), `row ${index}: the client decodes a different field set`)
    for (const field of CLIENT_ROW_FIELDS) {
      assert.deepEqual(
        (row as unknown as Record<string, unknown>)[field],
        (hostRow as unknown as Record<string, unknown>)[field],
        `row ${index} field '${field}' drifted between host and client`,
      )
    }
  }

  // The rich facts the assertions above rely on really are present (a mock that
  // silently stopped producing them would make the lockstep vacuous).
  const [main, linked, unregistered, detached] = decoded.worktrees
  assert.equal(main!.isMain, true)
  assert.equal(main!.status, 'ready')
  assert.equal(main!.headState, 'branch')
  assert.equal(main!.dirty, false)
  // The archived running session is inert: it stays in runningSessionIds but is
  // NOT in the blocking subset (the client's subset check decodes it above).
  assert.deepEqual(main!.sessionIds, ['s-running', 's-archived'])
  assert.deepEqual(main!.runningSessionIds, ['s-running', 's-archived'])
  assert.deepEqual(main!.blockingRunningSessionIds, ['s-running'])
  assert.equal(linked!.dirty, true)
  assert.equal(linked!.upstream, 'origin/feature')
  assert.equal(linked!.ahead, 2)
  assert.equal(linked!.behind, 1)
  assert.deepEqual(linked!.attention, ['merge'])
  assert.equal(unregistered!.workspaceId, null)
  assert.deepEqual(unregistered!.sessionIds, [])
  assert.equal(detached!.branch, null)
  assert.equal(detached!.headState, 'detached')
})

test('every host snapshot diagnostic decodes verbatim (the per-row drift codes included)', async () => {
  const host = new FakeHost()
  // A vanished worktree row (host `path-unavailable`) plus the two per-row
  // agent drifts (core.ts readSource) — the client must pass all three through
  // instead of rejecting the snapshot or inventing codes.
  host.rows.push({ path: '/repos/vanished', branch: 'gone', head: '5'.repeat(40) })
  host.agents.push({ sessionId: 's-status', status: 'paused' as unknown as 'running', cwd: MAIN })
  host.agents.push({ sessionId: 's-cwd', status: 'running', cwd: 'relative/worktree' })

  const snapshot = await hostSnapshot(host)
  assert.equal(snapshot.sourceError, undefined, 'a drifted agent row must never darken the whole source')
  const codes = snapshot.errors.map(error => error.code)
  assert.ok(codes.includes('path-unavailable'), `the vanished row is a loud per-row diagnostic: ${codes.join(', ')}`)
  assert.ok(codes.includes('agent-status-unknown'), `the status drift is reported: ${codes.join(', ')}`)
  assert.ok(codes.includes('agent-cwd-unknown'), `the cwd drift is reported: ${codes.join(', ')}`)

  const normalized = normalizeGitSnapshot(snapshot)
  assert.deepEqual(
    normalized.errors.map(error => `${error.code}:${error.operation}`),
    snapshot.errors.map(error => `${error.code}:${error.operation}`),
    'the client must decode every host diagnostic 1:1 — never add an invalid-* code of its own',
  )
  assert.deepEqual(
    normalized.repos[0]!.worktrees.map(row => row.worktreeId),
    snapshot.repos[0]!.worktrees.map(row => row.worktreeId),
    'the vanished row still decodes (status missing), so the row set is unchanged',
  )
  assert.equal(
    normalized.repos[0]!.worktrees.find(row => row.path === '/repos/vanished')!.status,
    'missing',
  )
  const vanished = snapshot.repos[0]!.worktrees.find(row => row.path === '/repos/vanished')!
  assert.equal(vanished.workspaceId, null)
})

test('error-code lockstep: the client deterministic set covers every host classification without an undeclared overlap', () => {
  // (1) NO UNDECLARED OVERLAP. A code the host serializes as retryable: true
  // must not be silently overridden by the client's static list; the two
  // deliberate overrides are declared in git-api.ts and must be exactly the
  // whole overlap (a new host-retryable code that lands in the client set, or a
  // declared override that stops being retryable, fails here).
  const overlap = [...DETERMINISTIC_GIT_REJECTION_CODES].filter(code => RETRYABLE_CODES.has(code)).sort()
  assert.deepEqual(overlap, [...DETERMINISTIC_HOST_RETRYABLE_OVERRIDES].sort(),
    'the host-retryable ∩ client-deterministic overlap must stay explicit and documented')
  for (const code of DETERMINISTIC_HOST_RETRYABLE_OVERRIDES) {
    assert.ok(RETRYABLE_CODES.has(code), `declared override '${code}' is not host-retryable any more`)
    assert.ok(DETERMINISTIC_GIT_REJECTION_CODES.has(code), `declared override '${code}' is not client-deterministic any more`)
  }

  // (2) DIRECTION: every OTHER host-retryable code must be read by the client as
  // "outcome unverified" (ambiguous) and never as a deterministic refusal. This
  // is the direction that matters for recovery policy: the client must not
  // discard a host signal that a mutation MAY have committed.
  for (const code of RETRYABLE_CODES) {
    const error = new GitWorktreeRpcError(code, 'host failure', undefined, true)
    assert.equal(isAmbiguousGitRpcFailure(error), true, `host-retryable '${code}' must stay ambiguous`)
    if (DETERMINISTIC_HOST_RETRYABLE_OVERRIDES.has(code)) {
      assert.equal(isDeterministicGitRejection(error), true, `declared override '${code}' must stay deterministic`)
    } else {
      assert.equal(isDeterministicGitRejection(error), false,
        `host-retryable '${code}' must NOT be a client deterministic rejection`)
    }
  }

  // (3) COVERAGE: every code the client names must exist in the host source
  // (a client-side rename, or a host code retired without the client being
  // updated, fails here). The host's explicitly-classified pre-mutation
  // refusals (an explicit `retryable: false`, core.ts commitBoundRemove) must
  // always be covered by the client's deterministic set.
  const hostSourceCodes = new Set(
    Array.from(HOST_CORE_SOURCE.matchAll(/'([a-z][a-z0-9]*(?:[-/][a-z0-9]+)*)'/gu), match => match[1]!),
  )
  for (const code of DETERMINISTIC_GIT_REJECTION_CODES) {
    assert.ok(hostSourceCodes.has(code), `client-deterministic '${code}' does not exist in the host core source`)
  }
  for (const code of HOST_EXPLICIT_PRE_MUTATION_CODES) {
    assert.equal(
      isDeterministicGitRejection(new GitWorktreeRpcError(code, 'refused')),
      true,
      `host-proven pre-mutation refusal '${code}' must be a client deterministic rejection`,
    )
  }
})

/** Host codes emitted with an explicit `retryable: false` (core.ts: the typed
 *  submodule gate, plus the commitBoundRemove reclassification). The client must
 *  classify each one deterministically; the reclassification path reuses the
 *  inner error's code and is covered by the flag, not by this list. */
const HOST_EXPLICIT_PRE_MUTATION_CODES = ['worktree-submodules']
