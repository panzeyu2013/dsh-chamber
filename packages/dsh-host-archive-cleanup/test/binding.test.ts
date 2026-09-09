/** Real-binding tests (design 24 §10/§14 + security/perf review 2026-12):
 *  `src/binding.ts` is decorator-free, so the ACTUAL factory and gate run
 *  under node:test against in-memory service fakes + a real temp filesystem
 *  for the locate/remove content leg. The gateway class (index.ts) keeps TS
 *  decorators and is exercised by typecheck + M4 gateway-boot E2E. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertHostSurface,
  makeHostBinding,
  RunGate,
  BUSY_MESSAGE,
  headerToState,
  type HostCtxServices,
} from '../src/binding.ts'
import { ArchiveCleanupCore, ArchiveCleanupError } from '../src/core.ts'

function header(id: string, extra: Partial<{ cwd: string; parentSession: string; origin: 'subagent' }> = {}) {
  return { id, ...extra }
}

interface RegistryFake {
  archived: string[]
  workspaces: { id: string }[]
  setStateCalls: { state: unknown; chained: boolean }[]
  chainCalls: number
  failNextSetState?: boolean
}

function makeCtx(overrides: Partial<HostCtxServices> = {}, registry?: RegistryFake): HostCtxServices {
  return {
    sessionQuery: {
      listSessions: async () => [],
    },
    sessionPersistence: {
      list: async () => [],
      locate: () => undefined,
    },
    ...(registry === undefined ? {} : {
      workspaceRegistry: {
        get archivedSessionIds() { return registry.archived },
        list: () => registry.workspaces,
        setState: async (state: unknown) => {
          if (registry.failNextSetState === true) {
            registry.failNextSetState = false
            throw new Error('fake: setState failed')
          }
          registry.setStateCalls.push({ state, chained: false })
          const s = state as { workspaceIds: string[]; archivedSessionIds: string[] }
          registry.archived = [...s.archivedSessionIds]
        },
        enqueueOperation: async <T>(operation: () => Promise<T>): Promise<T> => {
          // Serialized like the official chain (await-tail semantics are the
          // registry's job — the fake records chain usage and runs the op).
          registry.chainCalls += 1
          return await operation()
        },
      } as never,
    }),
    ...overrides,
  }
}

test('binding: batched archived-set removal runs one chained single-state write', async () => {
  const registry: RegistryFake = {
    archived: ['a', 'b', 'c'], workspaces: [{ id: 'w1' }], setStateCalls: [], chainCalls: 0,
  }
  const host = makeHostBinding(makeCtx({}, registry))
  await host.removeArchivedSessionIds(['a', 'c'])
  assert.equal(registry.setStateCalls.length, 1)
  const state = registry.setStateCalls[0]!.state as { initialized: boolean; workspaceIds: string[]; archivedSessionIds: string[] }
  assert.equal(state.initialized, true)
  assert.deepEqual(state.workspaceIds, ['w1'])
  assert.deepEqual(state.archivedSessionIds, ['b'])
  assert.deepEqual(registry.archived, ['b'])
  // Idempotent no-op when nothing to remove → no write.
  await host.removeArchivedSessionIds(['a'])
  assert.equal(registry.setStateCalls.length, 1)
})

test('binding: official setState failures map to item code storage', async () => {
  const registry: RegistryFake = {
    archived: ['a'], workspaces: [{ id: 'w1' }], setStateCalls: [], chainCalls: 0, failNextSetState: true,
  }
  const host = makeHostBinding(makeCtx({}, registry))
  await assert.rejects(() => host.removeArchivedSessionIds(['a']), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'storage'
  })
})

test('binding: deleteSessionContent refuses running (always) and loaded (unless forced)', async () => {
  const ctx: HostCtxServices = {
    agents: { list: () => [{ id: 'live-1', status: 'running' }, { id: 'idle-1', status: 'idle' }] },
    sessionPersistence: { locate: h => ({ kind: 'jsonl', path: join(tmpdir(), 'x', h.id) }) },
  }
  const host = makeHostBinding(ctx)
  await assert.rejects(() => host.deleteSessionContent('live-1', '/work'), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'running'
  })
  // Force never bypasses a RUNNING session (a live writer would recreate a
  // header-less artifact through open(path,"a")).
  await assert.rejects(() => host.deleteSessionContent('live-1', '/work', true), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'running'
  })
  // A merely LOADED (idle) session is refused with code `loaded`…
  await assert.rejects(() => host.deleteSessionContent('idle-1', '/work'), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'loaded'
  })
  // …and only force reaches the artifact leg (missing here: no such path).
  assert.equal(await host.deleteSessionContent('idle-1', '/work', true), 'missing')
  // Live-store membership without an agent is also `loaded`.
  const attached = makeHostBinding({
    sessions: { list: () => [{ id: 'attached-1' }] },
    sessionPersistence: { locate: () => undefined },
  })
  await assert.rejects(() => attached.deleteSessionContent('attached-1', '/work'), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'loaded'
  })
  // No header/artifact → idempotent missing (no list service mounted → the
  // cwd-less fallback must fail registry-unreadable instead of guessing).
  await assert.rejects(() => host.deleteSessionContent('unknown-1'), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'registry-unreadable'
  })
})

test('binding: a drifted agent status fails the live read loudly', async () => {
  const host = makeHostBinding({
    agents: { list: () => [{ id: 'a', status: 'waiting' }] },
    sessionPersistence: { locate: () => undefined },
  })
  await assert.rejects(() => host.listLiveSessionFacts(), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'registry-unreadable'
  })
})

test('binding: listLiveSessionFacts splits running from loaded', async () => {
  const host = makeHostBinding({
    agents: { list: () => [{ id: 'run-1', status: 'running' }, { id: 'idle-1', status: 'idle' }] },
    sessions: { list: () => [{ id: 'idle-1' }, { id: 'attached-1' }] },
  })
  const facts = await host.listLiveSessionFacts()
  assert.deepEqual([...facts.running].sort(), ['run-1'])
  assert.deepEqual([...facts.loaded].sort(), ['attached-1', 'idle-1', 'run-1'])
})

test('binding: content removal removes the official artifact and reclaims an empty dir; FS errors map to storage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-cleanup-binding-'))
  try {
    const sessionDir = join(dir, 'proj', 's1')
    mkdirSync(sessionDir, { recursive: true })
    const artifact = join(sessionDir, 'session.jsonl.zstd')
    writeFileSync(artifact, '{}')
    const locate = (h: { id: string; cwd?: string }) => {
      assert.equal(h.id, 's1')
      return { kind: 'jsonl', path: join(h.cwd ?? '', 's1', 'session.jsonl.zstd') }
    }
    const host = makeHostBinding({ sessionPersistence: { locate } })
    const outcome = await host.deleteSessionContent('s1', join(dir, 'proj'))
    assert.equal(outcome, 'deleted')
    assert.equal(existsSync(artifact), false)
    assert.equal(existsSync(sessionDir), false, 'empty session dir reclaimed')
    assert.equal(existsSync(join(dir, 'proj')), true, 'project dir survives')

    // Symlinked session dir fails closed with code storage.
    const real = join(dir, 'real-target')
    mkdirSync(real, { recursive: true })
    const linkDir = join(dir, 'link', 's2')
    mkdirSync(join(dir, 'link'), { recursive: true })
    symlinkSync(real, linkDir)
    const linkHost = makeHostBinding({
      sessionPersistence: { locate: () => ({ kind: 'jsonl', path: join(linkDir, 'session.jsonl.zstd') }) },
    })
    await assert.rejects(() => linkHost.deleteSessionContent('s2', join(dir, 'link')), (error: unknown) => {
      return error instanceof ArchiveCleanupError && error.code === 'storage'
    })
    assert.equal(existsSync(real), true, 'symlink target untouched')

    // Leftover session-local files keep the dir (rmdir ENOTEMPTY fail-closed)
    // while the artifact itself is gone.
    const stubborn = join(dir, 'proj2', 's3')
    mkdirSync(stubborn, { recursive: true })
    writeFileSync(join(stubborn, 'session.jsonl.zstd'), '{}')
    writeFileSync(join(stubborn, 'metadata.json'), '{}')
    const stubHost = makeHostBinding({
      sessionPersistence: { locate: h => ({ kind: 'jsonl', path: join(dir, 'proj2', h.id, 'session.jsonl.zstd') }) },
    })
    const stubOutcome = await stubHost.deleteSessionContent('s3', join(dir, 'proj2'))
    assert.equal(stubOutcome, 'deleted')
    assert.equal(existsSync(stubborn), true, 'non-empty leftover dir kept (fail closed)')
    assert.equal(existsSync(join(stubborn, 'session.jsonl.zstd')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('binding regression: locate runs AS a method on the persistence service (this-sensitive official locate)', async () => {
  // Real-machine E2E find (2026-09): the previous destructured
  // `const locate = persistence.locate` + detached invocation made the
  // OFFICIAL jsonl locate crash on every deletion with "Cannot read
  // properties of undefined (reading 'root')" — the official
  // SessionPersistence implementations are instance-state classes (locate
  // reads this.root / this.compression). The fake below mirrors that shape
  // (a this-sensitive method, like the official class); the old binding code
  // fails it, the fixed binding passes.
  const dir = mkdtempSync(join(tmpdir(), 'archive-cleanup-locate-this-'))
  try {
    const sessionDir = join(dir, 's9')
    mkdirSync(sessionDir, { recursive: true })
    const artifact = join(sessionDir, 'session.jsonl')
    writeFileSync(artifact, '{}')
    const persistence = {
      root: dir,
      list: async () => [],
      locate(meta: { id: string }) {
        // The official jsonl locate resolves against INSTANCE state
        // (this.root); a detached call sees `this === undefined`.
        return { kind: 'jsonl', path: join(this.root, meta.id, 'session.jsonl') }
      },
    }
    const host = makeHostBinding({ sessionPersistence: persistence } as never)
    const outcome = await host.deleteSessionContent('s9', dir)
    assert.equal(outcome, 'deleted')
    assert.equal(existsSync(artifact), false)
    assert.equal(existsSync(sessionDir), false, 'empty session dir reclaimed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('binding: registry surface guard refuses a missing setState surface', async () => {
  const host = makeHostBinding({})
  await assert.rejects(() => host.listArchivedSessionIds(), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'registry-unreadable'
  })
})

test('binding: headerToState carries cwd + lineage into snapshot states', () => {
  const top = headerToState(header('top', { cwd: '/work/a' }))
  const sub = headerToState(header('sub', { cwd: '/work/a', origin: 'subagent', parentSession: 'top' }))
  assert.equal(top.cwd, '/work/a')
  assert.equal(top.origin, undefined)
  assert.equal(sub.origin, 'subagent')
  assert.equal(sub.parentSessionId, 'top')
  assert.equal(sub.running, false)
})

// Malformed official header shapes (review F3): the binding keys its whole
// cascade on these fields structurally — a vendor rename/retype must refuse
// LOUDLY with registry-unreadable (naming the session and field), never
// silently empty the lineage/deletion cascade.
const MALFORMED_HEADERS: Array<{ name: string; header: unknown; field: string }> = [
  { name: 'non-string id', header: { id: 42 }, field: 'header.id' },
  { name: 'numeric cwd', header: { id: 'h1', cwd: 42 }, field: 'header.cwd' },
  { name: 'origin other than subagent', header: { id: 'h1', origin: 'other' }, field: 'header.origin' },
  { name: 'non-string parentSession', header: { id: 'h1', parentSession: 7 }, field: 'header.parentSession' },
]

function isRegistryUnreadableNaming(error: unknown, field: string): boolean {
  return error instanceof ArchiveCleanupError && error.code === 'registry-unreadable' && error.message.includes(field)
}

test('binding F3: listSessionStates refuses every malformed header shape loudly with registry-unreadable', async () => {
  for (const { name, header: badHeader, field } of MALFORMED_HEADERS) {
    const host = makeHostBinding({
      sessionQuery: { listSessions: async () => [{ header: badHeader }] },
    } as never)
    await assert.rejects(() => host.listSessionStates(), (error: unknown) => isRegistryUnreadableNaming(error, field), name)
  }
})

test('binding F3: headerToState refuses every malformed header shape loudly with registry-unreadable', () => {
  for (const { name, header: badHeader, field } of MALFORMED_HEADERS) {
    assert.throws(() => headerToState(badHeader as never), (error: unknown) => isRegistryUnreadableNaming(error, field), name)
  }
})

test('binding F3: absent optional header fields still pass and keep the cascade intact', async () => {
  // No cwd/parentSession/origin — an older legitimate record must pass.
  const bare = headerToState(header('plain'))
  assert.deepEqual(bare, { sessionId: 'plain', running: false })
  const host = makeHostBinding({
    sessionQuery: {
      listSessions: async () => [{ header: header('plain') }, { header: header('sub', { origin: 'subagent', parentSession: 'plain' }) }],
    },
  })
  const states = await host.listSessionStates()
  assert.equal(states.length, 2)
  assert.equal(states.find(s => s.sessionId === 'sub')?.parentSessionId, 'plain')
})

test('binding F3: a malformed header refuses a full purge before ANY mutation', async () => {
  const registry: RegistryFake = {
    archived: ['h1'], workspaces: [{ id: 'w1' }], setStateCalls: [], chainCalls: 0,
  }
  const host = makeHostBinding(makeCtx({
    sessionQuery: { listSessions: async () => [{ header: { id: 'h1', cwd: 42 } }] },
  } as never, registry))
  const core = new ArchiveCleanupCore(host)
  await assert.rejects(() => core.purge(), (error: unknown) => isRegistryUnreadableNaming(error, 'header.cwd'))
  assert.equal(registry.setStateCalls.length, 0, 'no archived-set write')
  assert.equal(registry.chainCalls, 0, 'no registry mutation')
})

test('binding F3: the snapshot-path header is shape-checked before the official locate', async () => {
  // sessionId/cwd arrive from the (validated) snapshot states in production;
  // the guard must still refuse a drifted value loudly instead of silently
  // resolving nothing — a non-string sessionId refuses before locate runs.
  const host = makeHostBinding({
    sessionPersistence: { locate: () => undefined },
  } as never)
  await assert.rejects(
    () => host.deleteSessionContent(42 as never, '/work'),
    (error: unknown) => isRegistryUnreadableNaming(error, 'header.id'),
  )
})

test('RunGate: busy refusal is retryable; sequential runs pass (design 24 §3)', async () => {
  const gate = new RunGate()
  let release!: () => void
  const first = gate.run(async () => { await new Promise<void>(resolve => { release = resolve }); return 1 })
  await assert.rejects(() => gate.run(async () => 2), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'busy' && error.retryable === true
  })
  await assert.rejects(() => gate.run(async () => 2), (error: unknown) => error instanceof Error && error.message.includes(BUSY_MESSAGE.slice(0, 24)))
  release()
  assert.equal(await first, 1)
  assert.equal(await gate.run(async () => 2), 2, 'gate frees after the in-flight run settles')
})

test('binding states mapping: listSessionStates enumerates through sessionQuery records', async () => {
  const host = makeHostBinding({
    sessionQuery: {
      listSessions: async () => [
        { header: header('h1', { cwd: '/w/h1' }) },
        { header: header('h2', { origin: 'subagent', parentSession: 'h1', cwd: '/w/h1' }) },
      ],
    },
  })
  const states = await host.listSessionStates()
  assert.equal(states.length, 2)
  assert.equal(states.find(s => s.sessionId === 'h2')?.parentSessionId, 'h1')
})

test('binding: an absent official mutation chain refuses loudly (no out-of-chain fallback)', async () => {
  let setStateCalls = 0
  const ctx = {
    workspaceRegistry: {
      archivedSessionIds: ['a'],
      list: () => [{ id: 'w1' }],
      setState: async () => { setStateCalls += 1 },
      // No enqueueOperation — an out-of-chain write must NOT happen.
    },
  }
  const host = makeHostBinding(ctx as never)
  await assert.rejects(() => host.removeArchivedSessionIds(['a']), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'registry-unreadable'
  })
  assert.equal(setStateCalls, 0)
})

test('binding: assertHostSurface passes on the full surface and refuses otherwise (probe leg)', () => {
  // Full surface (merge-round Minor-3 hardened the probe to the complete
  // domain surface): registry + session enumeration + storage locate.
  assertHostSurface({
    workspaceRegistry: { archivedSessionIds: [], list: () => [], setState: async () => {} },
    sessionQuery: { listSessions: async () => [] },
    sessionPersistence: { list: async () => [], locate: () => undefined },
  } as never)
  assert.throws(() => assertHostSurface({} as never), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'registry-unreadable'
  })
  // A registry-only host (no enumeration/locate surface) must fail the probe
  // loudly — presence without surface health would only registry-unreadable
  // on the first preview/purge.
  assert.throws(() => assertHostSurface({
    workspaceRegistry: { archivedSessionIds: [], list: () => [], setState: async () => {} },
  } as never), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'registry-unreadable'
  })
  // Enumerating without the storage locate leg also refuses (content removal
  // would be impossible).
  assert.throws(() => assertHostSurface({
    workspaceRegistry: { archivedSessionIds: [], list: () => [], setState: async () => {} },
    sessionQuery: { listSessions: async () => [] },
  } as never), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'registry-unreadable'
  })
})
