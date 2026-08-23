import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { renameSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  GitFeatureError,
  MAX_CONCURRENT_GIT_PROCESSES,
  createWorktree,
  decodeWorkspaceCreateValue,
  deleteWorktree,
  runGit,
  sanitizedGitEnvironment,
} from '../src/features/git.ts'

function rpcFetch(handler: (method: string, payload: any) => any): typeof globalThis.fetch {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    const result = handler(request.method, request.payload)
    return new Response(JSON.stringify({
      type: 'server-response',
      rpcId: request.rpcId,
      result,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

async function makeRepo(prefix: string): Promise<{ root: string; repo: string }> {
  const rawRoot = await mkdtemp(join(tmpdir(), prefix))
  const root = await realpath(rawRoot)
  const repo = join(root, 'repo')
  await mkdir(repo)
  execFileSync('git', ['init', repo], { stdio: 'ignore' })
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'gateway-test@example.invalid'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Gateway Test'])
  await writeFile(join(repo, 'README.md'), 'baseline\n')
  execFileSync('git', ['-C', repo, 'add', 'README.md'])
  execFileSync('git', ['-C', repo, 'commit', '-m', 'baseline'], { stdio: 'ignore' })
  return { root, repo }
}

test('workspace.create decoder consumes value.workspace.workspaceId and created', () => {
  assert.deepEqual(
    decodeWorkspaceCreateValue({
      workspace: { workspaceId: 'ws-2', path: '/srv/project-feature' },
      created: true,
    }, '/srv/project-feature'),
    { workspaceId: 'ws-2', path: '/srv/project-feature', created: true },
  )
  assert.throws(
    () => decodeWorkspaceCreateValue({ id: 'confused-top-level-id', created: true }, '/srv/project-feature'),
    (error: unknown) => error instanceof GitFeatureError && error.code === 'workspace_create_failed',
  )
})

test('git child environment drops gateway secrets and enforces timeout/concurrency caps', async () => {
  const sanitized = sanitizedGitEnvironment({
    DSH_GATEWAY_PASSWORD: 'secret',
    DSH_GATEWAY_TOKEN: 'token',
    GIT_DIR: '/attacker/repo/.git',
    git_work_tree: '/attacker/repo',
    GIT_COMMON_DIR: '/attacker/repo/.git',
    GIT_INDEX_FILE: '/attacker/repo/.git/index',
    GIT_OBJECT_DIRECTORY: '/attacker/repo/.git/objects',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.bare',
    GIT_CONFIG_VALUE_0: 'true',
    PATH: '/bin',
  })
  assert.equal(sanitized.DSH_GATEWAY_TOKEN, undefined)
  assert.equal(sanitized.GIT_DIR, undefined)
  assert.equal(sanitized.git_work_tree, undefined)
  assert.equal(sanitized.GIT_COMMON_DIR, undefined)
  assert.equal(sanitized.GIT_INDEX_FILE, undefined)
  assert.equal(sanitized.GIT_OBJECT_DIRECTORY, undefined)
  assert.equal(sanitized.GIT_CONFIG_COUNT, undefined)
  assert.equal(sanitized.GIT_CONFIG_KEY_0, undefined)
  assert.equal(sanitized.GIT_CONFIG_VALUE_0, undefined)
  assert.equal(sanitized.GIT_TERMINAL_PROMPT, '0')

  const rawRoot = await mkdtemp(join(tmpdir(), 'gateway-git-runner-'))
  const root = await realpath(rawRoot)
  const bin = join(root, 'bin')
  await mkdir(bin)
  const fakeGit = join(bin, 'git')
  await writeFile(fakeGit, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({password: process.env.DSH_GATEWAY_PASSWORD ?? null, token: process.env.DSH_GATEWAY_TOKEN ?? null}))
setTimeout(() => process.exit(0), Number(process.argv[2] ?? 0))
`)
  await chmod(fakeGit, 0o755)

  const oldPath = process.env.PATH
  const oldPassword = process.env.DSH_GATEWAY_PASSWORD
  const oldToken = process.env.DSH_GATEWAY_TOKEN
  process.env.PATH = `${bin}:${oldPath ?? ''}`
  process.env.DSH_GATEWAY_PASSWORD = 'must-not-leak'
  process.env.DSH_GATEWAY_TOKEN = 'must-not-leak'
  try {
    // Process startup can be slow on a loaded CI host; this assertion is about
    // environment sanitization, not the timeout boundary exercised below.
    const clean = await runGit(['0'], root, { timeoutMs: 5_000 })
    assert.deepEqual(JSON.parse(clean.stdout), { password: null, token: null })

    await assert.rejects(
      runGit(['5000'], root, { timeoutMs: 40 }),
      (error: unknown) => error instanceof GitFeatureError && error.code === 'git_timeout',
    )

    const active = Array.from({ length: MAX_CONCURRENT_GIT_PROCESSES }, () => runGit(['5000'], root, { timeoutMs: 80 }))
    await assert.rejects(
      runGit(['0'], root, { timeoutMs: 5_000 }),
      (error: unknown) => error instanceof GitFeatureError && error.code === 'git_busy',
    )
    const outcomes = await Promise.allSettled(active)
    assert.equal(outcomes.every(outcome => outcome.status === 'rejected'
      && outcome.reason instanceof GitFeatureError && outcome.reason.code === 'git_timeout'), true)
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    if (oldPassword === undefined) delete process.env.DSH_GATEWAY_PASSWORD
    else process.env.DSH_GATEWAY_PASSWORD = oldPassword
    if (oldToken === undefined) delete process.env.DSH_GATEWAY_TOKEN
    else process.env.DSH_GATEWAY_TOKEN = oldToken
    await rm(root, { recursive: true, force: true })
  }
})

test('git -C authority ignores poisoned process GIT_DIR and GIT_WORK_TREE', async () => {
  const first = await makeRepo('gateway-git-env-first-')
  const second = await makeRepo('gateway-git-env-second-')
  const previousDir = process.env.GIT_DIR
  const previousWorkTree = process.env.GIT_WORK_TREE
  process.env.GIT_DIR = join(second.repo, '.git')
  process.env.GIT_WORK_TREE = second.repo
  try {
    const result = await runGit([
      '-C', first.repo, 'rev-parse', '--show-toplevel', '--absolute-git-dir',
    ], first.repo)
    assert.equal(result.code, 0)
    const [topLevel, gitDir] = result.stdout.split(/\r?\n/)
    assert.equal(topLevel, first.repo)
    assert.equal(gitDir, await realpath(join(first.repo, '.git')))
  } finally {
    if (previousDir === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = previousDir
    if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE
    else process.env.GIT_WORK_TREE = previousWorkTree
    await rm(first.root, { recursive: true, force: true })
    await rm(second.root, { recursive: true, force: true })
  }
})

test('create rejects repositories and targets outside live workspace authority', async () => {
  const first = await makeRepo('gateway-authority-a-')
  const second = await makeRepo('gateway-authority-b-')
  const originalFetch = globalThis.fetch
  globalThis.fetch = rpcFetch(method => {
    assert.equal(method, 'workspace.list')
    return { ok: true, value: { items: [{ workspaceId: 'ws-main', path: first.repo }] } }
  })
  try {
    await assert.rejects(createWorktree({
      dshBaseUrl: 'http://127.0.0.1:12345',
      repo: second.repo,
      branch: 'feature/confused',
      newPath: join(second.root, 'feature-confused'),
    }), (error: unknown) => error instanceof GitFeatureError && error.code === 'repo_not_allowed')

    await assert.rejects(createWorktree({
      dshBaseUrl: 'http://127.0.0.1:12345',
      repo: first.repo,
      branch: 'feature/outside',
      newPath: join(second.root, 'outside-authority'),
    }), (error: unknown) => error instanceof GitFeatureError && error.code === 'invalid_target')

    const link = join(first.root, 'feature-link')
    await symlink(second.repo, link)
    await assert.rejects(createWorktree({
      dshBaseUrl: 'http://127.0.0.1:12345',
      repo: first.repo,
      branch: 'feature/link',
      newPath: link,
    }), (error: unknown) => error instanceof GitFeatureError && error.code === 'target_exists')
  } finally {
    globalThis.fetch = originalFetch
    await rm(first.root, { recursive: true, force: true })
    await rm(second.root, { recursive: true, force: true })
  }
})

test('create revalidates repo and target workspace authority immediately before git add', async () => {
  const fixture = await makeRepo('gateway-create-recheck-')
  const originalFetch = globalThis.fetch
  const cases = [
    { name: 'repo-lost', branch: 'feature/repo-lost', code: 'repo_not_allowed' },
    { name: 'target-reoccupied', branch: 'feature/target-reoccupied', code: 'target_exists' },
  ] as const
  try {
    for (const scenario of cases) {
      const target = join(fixture.root, scenario.name)
      let listCalls = 0
      globalThis.fetch = rpcFetch(method => {
        assert.equal(method, 'workspace.list')
        listCalls += 1
        if (listCalls === 1) {
          return { ok: true, value: { items: [{ workspaceId: 'ws-main', path: fixture.repo }] } }
        }
        if (scenario.name === 'repo-lost') return { ok: true, value: { items: [] } }
        return { ok: true, value: { items: [
          { workspaceId: 'ws-main', path: fixture.repo },
          { workspaceId: 'ws-new-owner', path: target },
        ] } }
      })
      await assert.rejects(createWorktree({
        dshBaseUrl: 'http://127.0.0.1:12345',
        repo: fixture.repo,
        branch: scenario.branch,
        newPath: target,
      }), (error: unknown) => error instanceof GitFeatureError && error.code === scenario.code)
      assert.equal(listCalls, 2)
      await assert.rejects(realpath(target), { code: 'ENOENT' })
      assert.equal(execFileSync('git', ['-C', fixture.repo, 'branch', '--list', scenario.branch], { encoding: 'utf8' }).trim(), '')
    }
  } finally {
    globalThis.fetch = originalFetch
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('session failure compensates only a correlated workspace created by this call', async () => {
  const fixture = await makeRepo('gateway-compensation-')
  const originalFetch = globalThis.fetch
  let workspaceCreated = false
  let workspaceDeleteCalls = 0
  let liveWorkspacePath: string | null = null
  let target = join(fixture.root, 'feature-reused')
  globalThis.fetch = rpcFetch((method, payload) => {
    if (method === 'workspace.list') {
      return { ok: true, value: { items: [
        { workspaceId: 'ws-main', path: fixture.repo },
        ...(liveWorkspacePath === null ? [] : [{ workspaceId: 'ws-feature', path: liveWorkspacePath }]),
      ] } }
    }
    if (method === 'workspace.create') {
      liveWorkspacePath = payload.path
      return { ok: true, value: { workspace: { workspaceId: 'ws-feature', path: payload.path }, created: workspaceCreated } }
    }
    if (method === 'session.create') {
      return { ok: false, error: { code: 'session-failed', message: 'synthetic failure' } }
    }
    if (method === 'session.list') {
      return { ok: true, value: { items: [] } }
    }
    if (method === 'workspace.delete') {
      workspaceDeleteCalls += 1
      liveWorkspacePath = null
      return { ok: true, value: { deleted: true } }
    }
    throw new Error(`unexpected ${method}`)
  })
  try {
    await assert.rejects(createWorktree({
      dshBaseUrl: 'http://127.0.0.1:12345', repo: fixture.repo, branch: 'feature/reused', newPath: target,
    }), (error: unknown) => error instanceof GitFeatureError && error.code === 'workspace_create_failed')
    assert.equal(workspaceDeleteCalls, 0)
    await assert.rejects(realpath(target), { code: 'ENOENT' })
    assert.equal(workspaceDeleteCalls, 0, 'created:false never authorizes deleting the pre-existing workspace row')
    assert.doesNotThrow(() => execFileSync('git', ['-C', fixture.repo, 'rev-parse', '--verify', 'refs/heads/feature/reused'], { stdio: 'ignore' }))

    workspaceCreated = true
    target = join(fixture.root, 'feature-owned')
    await assert.rejects(createWorktree({
      dshBaseUrl: 'http://127.0.0.1:12345', repo: fixture.repo, branch: 'feature/owned', newPath: target,
    }), (error: unknown) => error instanceof GitFeatureError && error.code === 'session_create_failed')
    assert.equal(workspaceDeleteCalls, 1)
    await assert.rejects(realpath(target), { code: 'ENOENT' })
    assert.doesNotThrow(() => execFileSync('git', ['-C', fixture.repo, 'rev-parse', '--verify', 'refs/heads/feature/owned'], { stdio: 'ignore' }))
  } finally {
    globalThis.fetch = originalFetch
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('session compensation preserves a path reoccupied after workspace deletion', async () => {
  const fixture = await makeRepo('gateway-compensation-reoccupied-')
  const target = join(fixture.root, 'feature-compensation-reoccupied')
  const originalFetch = globalThis.fetch
  let listCalls = 0
  globalThis.fetch = rpcFetch((method, payload) => {
    if (method === 'workspace.list') {
      listCalls += 1
      return { ok: true, value: { items: [
        { workspaceId: 'ws-main', path: fixture.repo },
        ...(listCalls > 2 ? [{ workspaceId: 'ws-new-owner', path: target }] : []),
      ] } }
    }
    if (method === 'workspace.create') {
      return { ok: true, value: { workspace: { workspaceId: 'ws-owned', path: payload.path }, created: true } }
    }
    if (method === 'session.create') {
      return { ok: false, error: { code: 'session-failed', message: 'synthetic failure' } }
    }
    if (method === 'session.list') return { ok: true, value: { items: [] } }
    if (method === 'workspace.delete') return { ok: true, value: { deleted: true } }
    throw new Error(`unexpected ${method}`)
  })
  try {
    await assert.rejects(
      createWorktree({
        dshBaseUrl: 'http://127.0.0.1:12345', repo: fixture.repo,
        branch: 'feature/compensation-reoccupied', newPath: target,
      }),
      (error: unknown) => error instanceof GitFeatureError
        && error.code === 'session_create_failed'
        && error.recovery?.state === 'deleting',
    )
    assert.equal(await realpath(target), target)
  } finally {
    globalThis.fetch = originalFetch
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('ambiguous workspace.create failure persists an unverified recovery and preserves the path', async () => {
  const fixture = await makeRepo('gateway-ambiguous-')
  const target = join(fixture.root, 'feature-ambiguous')
  const originalFetch = globalThis.fetch
  let listCalls = 0
  globalThis.fetch = rpcFetch(method => {
    if (method === 'workspace.list') {
      listCalls += 1
      return { ok: true, value: { items: [
        { workspaceId: 'ws-main', path: fixture.repo },
        // Calls 1-2 are the initial and mutation-adjacent authority proofs;
        // only the post-error reconciliation observes the possibly committed row.
        ...(listCalls > 2 ? [{ workspaceId: 'ws-ambiguous', path: target }] : []),
      ] } }
    }
    if (method === 'workspace.create') {
      throw new TypeError('response lost after possible commit')
    }
    throw new Error(`unexpected ${method}`)
  })
  try {
    await assert.rejects(createWorktree({
      dshBaseUrl: 'http://127.0.0.1:12345', repo: fixture.repo, branch: 'feature/ambiguous', newPath: target,
    }), (error: unknown) => error instanceof GitFeatureError
      && error.code === 'workspace_create_ambiguous'
      && error.recovery?.workspaceId === 'ws-ambiguous'
      && error.recovery.ownership === 'unverified')
    assert.equal(await realpath(target), target)
  } finally {
    globalThis.fetch = originalFetch
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('ambiguous session.create preserves the owned workspace and Git path for recovery', async () => {
  const fixture = await makeRepo('gateway-session-ambiguous-')
  const target = join(fixture.root, 'feature-session-ambiguous')
  const originalFetch = globalThis.fetch
  let workspaceDeleteCalls = 0
  globalThis.fetch = rpcFetch((method, payload) => {
    if (method === 'workspace.list') {
      return { ok: true, value: { items: [{ workspaceId: 'ws-main', path: fixture.repo }] } }
    }
    if (method === 'workspace.create') {
      return { ok: true, value: { workspace: { workspaceId: 'ws-session-ambiguous', path: payload.path }, created: true } }
    }
    if (method === 'session.create') throw new TypeError('response lost after possible commit')
    if (method === 'workspace.delete') {
      workspaceDeleteCalls += 1
      return { ok: true, value: { deleted: true } }
    }
    throw new Error(`unexpected ${method}`)
  })
  try {
    await assert.rejects(createWorktree({
      dshBaseUrl: 'http://127.0.0.1:12345', repo: fixture.repo,
      branch: 'feature/session-ambiguous', newPath: target,
    }), (error: unknown) => error instanceof GitFeatureError
      && error.code === 'session_create_ambiguous'
      && error.recovery?.ownership === 'owned'
      && error.recovery.state === 'failed')
    assert.equal(workspaceDeleteCalls, 0)
    assert.equal(await realpath(target), target)
    assert.doesNotThrow(() => execFileSync('git', [
      '-C', fixture.repo, 'rev-parse', '--verify', 'refs/heads/feature/session-ambiguous',
    ], { stdio: 'ignore' }))
  } finally {
    globalThis.fetch = originalFetch
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('session business failure does not remove Git when workspace.delete is not confirmed', async () => {
  const fixture = await makeRepo('gateway-session-delete-fail-')
  const target = join(fixture.root, 'feature-session-delete-fail')
  const originalFetch = globalThis.fetch
  globalThis.fetch = rpcFetch((method, payload) => {
    if (method === 'workspace.list') {
      return { ok: true, value: { items: [{ workspaceId: 'ws-main', path: fixture.repo }] } }
    }
    if (method === 'workspace.create') {
      return { ok: true, value: { workspace: { workspaceId: 'ws-delete-fail', path: payload.path }, created: true } }
    }
    if (method === 'session.create') {
      return { ok: false, error: { code: 'session-failed', message: 'synthetic failure' } }
    }
    if (method === 'session.list') return { ok: true, value: { items: [] } }
    if (method === 'workspace.delete') {
      return { ok: false, error: { code: 'temporary', message: 'not committed' } }
    }
    throw new Error(`unexpected ${method}`)
  })
  try {
    await assert.rejects(createWorktree({
      dshBaseUrl: 'http://127.0.0.1:12345', repo: fixture.repo,
      branch: 'feature/session-delete-fail', newPath: target,
    }), (error: unknown) => error instanceof GitFeatureError
      && error.code === 'session_create_failed'
      && error.recovery?.state === 'deleting')
    assert.equal(await realpath(target), target)
  } finally {
    globalThis.fetch = originalFetch
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('delete fails closed while a live session uses the canonical or symlinked worktree path', async () => {
  const fixture = await makeRepo('gateway-delete-live-')
  const target = join(fixture.root, 'feature-delete-live')
  const alias = join(fixture.root, 'feature-delete-alias')
  execFileSync('git', ['-C', fixture.repo, 'worktree', 'add', '-b', 'feature/delete-live', target], { stdio: 'ignore' })
  await symlink(target, alias)
  const originalFetch = globalThis.fetch
  let running = true
  let deleteCalls = 0
  globalThis.fetch = rpcFetch(method => {
    if (method === 'workspace.list') {
      return { ok: true, value: { items: [
        { workspaceId: 'ws-main', path: fixture.repo },
        { workspaceId: 'ws-live', path: target },
      ] } }
    }
    if (method === 'session.list') {
      return { ok: true, value: { items: [{ sessionId: 'session-live', running, cwd: alias }] } }
    }
    if (method === 'workspace.delete') {
      deleteCalls += 1
      return { ok: true, value: { deleted: true } }
    }
    throw new Error(`unexpected ${method}`)
  })
  const input = {
    dshBaseUrl: 'http://127.0.0.1:12345', workspaceId: 'ws-live', sessionId: 'session-record',
    repo: fixture.repo, path: target, branch: 'feature/delete-live',
  }
  try {
    await assert.rejects(deleteWorktree(input),
      (error: unknown) => error instanceof GitFeatureError && error.code === 'worktree_in_use')
    assert.equal(await realpath(target), target)
    assert.equal(deleteCalls, 0)

    running = false
    await deleteWorktree(input)
    await assert.rejects(realpath(target), { code: 'ENOENT' })
    assert.equal(deleteCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('delete saga resumes workspace.delete after Git was already removed', async () => {
  const fixture = await makeRepo('gateway-delete-resume-')
  const target = join(fixture.root, 'feature-delete-resume')
  execFileSync('git', ['-C', fixture.repo, 'worktree', 'add', '-b', 'feature/delete-resume', target], { stdio: 'ignore' })
  const originalFetch = globalThis.fetch
  let deleteCalls = 0
  globalThis.fetch = rpcFetch(method => {
    if (method === 'workspace.list') {
      return { ok: true, value: { items: [
        { workspaceId: 'ws-main', path: fixture.repo },
        { workspaceId: 'ws-feature', path: target },
      ] } }
    }
    if (method === 'workspace.delete') {
      deleteCalls += 1
      return deleteCalls === 1
        ? { ok: false, error: { code: 'temporary', message: 'try again' } }
        : { ok: true, value: { deleted: true } }
    }
    if (method === 'session.list') return { ok: true, value: { items: [] } }
    throw new Error(`unexpected ${method}`)
  })
  const input = {
    dshBaseUrl: 'http://127.0.0.1:12345', workspaceId: 'ws-feature', repo: fixture.repo,
    path: target, branch: 'feature/delete-resume',
  }
  try {
    await assert.rejects(deleteWorktree(input),
      (error: unknown) => error instanceof GitFeatureError && error.code === 'workspace_delete_failed')
    await assert.rejects(realpath(target), { code: 'ENOENT' })

    await deleteWorktree({ ...input, resumeAfterGitRemoval: true })
    assert.equal(deleteCalls, 2)
  } finally {
    globalThis.fetch = originalFetch
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('delete resume refuses a surviving Git path after workspace authority disappeared', async () => {
  const fixture = await makeRepo('gateway-delete-committed-')
  const target = join(fixture.root, 'feature-delete-committed')
  execFileSync('git', ['-C', fixture.repo, 'worktree', 'add', '-b', 'feature/delete-committed', target], { stdio: 'ignore' })
  const originalFetch = globalThis.fetch
  globalThis.fetch = rpcFetch(method => {
    if (method === 'workspace.list') {
      return { ok: true, value: { items: [{ workspaceId: 'ws-main', path: fixture.repo }] } }
    }
    if (method === 'session.list') return { ok: true, value: { items: [] } }
    throw new Error(`workspace.delete must not replay after its committed row disappeared: ${method}`)
  })
  try {
    await assert.rejects(
      deleteWorktree({
        dshBaseUrl: 'http://127.0.0.1:12345', workspaceId: 'ws-feature', repo: fixture.repo,
        path: target, branch: 'feature/delete-committed', resumeAfterGitRemoval: true,
      }),
      (error: unknown) => error instanceof GitFeatureError && error.code === 'worktree_not_allowed',
    )
    assert.equal(await realpath(target), target)
  } finally {
    globalThis.fetch = originalFetch
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('delete resume converges when both workspace authority and Git path are already gone', async () => {
  const fixture = await makeRepo('gateway-delete-converged-')
  const target = join(fixture.root, 'feature-delete-converged')
  const originalFetch = globalThis.fetch
  globalThis.fetch = rpcFetch(method => {
    if (method === 'workspace.list') {
      return { ok: true, value: { items: [{ workspaceId: 'ws-main', path: fixture.repo }] } }
    }
    throw new Error(`fully converged delete must not replay an RPC: ${method}`)
  })
  try {
    await deleteWorktree({
      dshBaseUrl: 'http://127.0.0.1:12345', workspaceId: 'ws-feature', repo: fixture.repo,
      path: target, branch: 'feature/delete-converged', resumeAfterGitRemoval: true,
    })
  } finally {
    globalThis.fetch = originalFetch
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('delete revalidates main-checkout repository authority immediately before Git removal', async () => {
  const fixture = await makeRepo('gateway-delete-repo-swap-')
  const target = join(fixture.root, 'feature-delete-repo-swap')
  const otherMain = join(fixture.root, 'other-main')
  const replacement = join(fixture.root, 'replacement-linked')
  const oldRepo = join(fixture.root, 'old-repo')
  execFileSync('git', ['-C', fixture.repo, 'worktree', 'add', '-b', 'feature/delete-repo-swap', target], { stdio: 'ignore' })
  execFileSync('git', ['init', otherMain], { stdio: 'ignore' })
  execFileSync('git', ['-C', otherMain, 'config', 'user.email', 'gateway-test@example.invalid'])
  execFileSync('git', ['-C', otherMain, 'config', 'user.name', 'Gateway Test'])
  await writeFile(join(otherMain, 'README.md'), 'replacement\n')
  execFileSync('git', ['-C', otherMain, 'add', 'README.md'])
  execFileSync('git', ['-C', otherMain, 'commit', '-m', 'replacement'], { stdio: 'ignore' })
  execFileSync('git', ['-C', otherMain, 'worktree', 'add', '-b', 'replacement/linked', replacement], { stdio: 'ignore' })

  const originalFetch = globalThis.fetch
  let listCalls = 0
  globalThis.fetch = rpcFetch(method => {
    if (method === 'workspace.list') {
      listCalls += 1
      if (listCalls === 2) {
        renameSync(fixture.repo, oldRepo)
        renameSync(replacement, fixture.repo)
      }
      return { ok: true, value: { items: [
        { workspaceId: 'ws-main', path: fixture.repo },
        { workspaceId: 'ws-feature', path: target },
      ] } }
    }
    if (method === 'session.list') return { ok: true, value: { items: [] } }
    throw new Error(`unexpected ${method}`)
  })
  try {
    await assert.rejects(
      deleteWorktree({
        dshBaseUrl: 'http://127.0.0.1:12345', workspaceId: 'ws-feature', repo: fixture.repo,
        path: target, branch: 'feature/delete-repo-swap',
      }),
      (error: unknown) => error instanceof GitFeatureError && error.code === 'repo_not_allowed',
    )
    assert.equal(await realpath(target), target)
  } finally {
    globalThis.fetch = originalFetch
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('delete resume refuses a target reoccupied by another workspace id or alias', async () => {
  const fixture = await makeRepo('gateway-delete-reoccupied-')
  const target = join(fixture.root, 'feature-delete-reoccupied')
  const alias = join(fixture.root, 'feature-delete-reoccupied-alias')
  execFileSync('git', ['-C', fixture.repo, 'worktree', 'add', '-b', 'feature/delete-reoccupied', target], { stdio: 'ignore' })
  await symlink(target, alias)
  const originalFetch = globalThis.fetch
  let occupyingPath = target
  let sessionCalls = 0
  let deleteCalls = 0
  globalThis.fetch = rpcFetch(method => {
    if (method === 'workspace.list') {
      return { ok: true, value: { items: [
        { workspaceId: 'ws-main', path: fixture.repo },
        { workspaceId: 'ws-new-owner', path: occupyingPath },
      ] } }
    }
    if (method === 'session.list') {
      sessionCalls += 1
      return { ok: true, value: { items: [] } }
    }
    if (method === 'workspace.delete') {
      deleteCalls += 1
      return { ok: true, value: { deleted: true } }
    }
    throw new Error(`unexpected ${method}`)
  })
  const input = {
    dshBaseUrl: 'http://127.0.0.1:12345', workspaceId: 'ws-old-owner', repo: fixture.repo,
    path: target, branch: 'feature/delete-reoccupied', resumeAfterGitRemoval: true,
  }
  try {
    await assert.rejects(deleteWorktree(input),
      (error: unknown) => error instanceof GitFeatureError && error.code === 'worktree_not_allowed')
    assert.equal(await realpath(target), target)

    occupyingPath = alias
    await assert.rejects(deleteWorktree(input),
      (error: unknown) => error instanceof GitFeatureError && error.code === 'worktree_not_allowed')
    assert.equal(await realpath(target), target)
    assert.equal(sessionCalls, 0)
    assert.equal(deleteCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
    await rm(fixture.root, { recursive: true, force: true })
  }
})
