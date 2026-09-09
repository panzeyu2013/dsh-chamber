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

/** The official not-found carrier, structurally: vendor
 *  session/session-persistence/src/errors.ts SessionPersistenceNotFoundError
 *  (name + sessionId). The binding must identify it WITHOUT importing vendor
 *  internals. */
function notFoundError(id: string): Error {
  return Object.assign(new Error(`session "${id}" not found`), {
    name: 'SessionPersistenceNotFoundError',
    sessionId: id,
  })
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

test('binding: deleteSessionContent live guard refuses running; missing stays missing', async () => {
  const ctx: HostCtxServices = {
    agents: { list: () => [{ id: 'live-1' }] },
    sessionPersistence: { locate: h => ({ kind: 'jsonl', path: join(tmpdir(), 'x', h.id) }) },
  }
  const host = makeHostBinding(ctx)
  await assert.rejects(() => host.deleteSessionContent('live-1', '/work'), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'running'
  })
  // No header/artifact → idempotent missing (no list service mounted → the
  // cwd-less fallback must fail registry-unreadable instead of guessing).
  await assert.rejects(() => host.deleteSessionContent('unknown-1'), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'registry-unreadable'
  })
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

test('binding sweep: a purge clears registry-global record-less members in ONE chained write alongside the real content deletion', async () => {
  // End-to-end (design 24 §20 residual ①) over the REAL binding: one archived
  // member with content + two historical no-directory members. The sweep must
  // remove all three memberships in the SAME single chained setState, delete
  // ONLY the content-bearing member's artifact, and never touch a record.
  const dir = mkdtempSync(join(tmpdir(), 'archive-cleanup-sweep-'))
  try {
    const projectDir = join(dir, 'proj')
    const sessionDir = join(projectDir, 'real-1')
    mkdirSync(sessionDir, { recursive: true })
    const artifact = join(sessionDir, 'session.jsonl')
    writeFileSync(artifact, '{}')
    const registry: RegistryFake = {
      archived: ['real-1', 'ghost-1', 'ghost-2'], workspaces: [{ id: 'w1' }], setStateCalls: [], chainCalls: 0,
    }
    const host = makeHostBinding(makeCtx({
      sessionQuery: {
        listSessions: async () => [{ header: header('real-1', { cwd: projectDir }) }],
      },
      sessionPersistence: {
        list: async () => [],
        locate: (h: { id: string; cwd?: string }) => ({ kind: 'jsonl', path: join(h.cwd ?? '', h.id, 'session.jsonl') }),
        // The decisive existence probe (blocker fix): resolves only while the
        // official artifact is materialized, throws the official not-found
        // carrier otherwise.
        inspect: async (id: string) => {
          if (existsSync(join(projectDir, id, 'session.jsonl'))) return {}
          throw notFoundError(id)
        },
      },
    } as never, registry))
    const core = new ArchiveCleanupCore(host)
    const result = await core.purge()
    assert.equal(result.errors.length, 0)
    assert.equal(result.deletedSessions, 1, 'content deletion counted')
    assert.equal(result.deletedSubagents, 0)
    assert.equal(result.clearedOrphanMembers, 2, 'the two record-less members are counted separately')
    assert.equal(existsSync(artifact), false, 'real content removed')
    assert.equal(registry.setStateCalls.length, 1, 'ONE official set write')
    assert.equal(registry.chainCalls, 1, 'inside the official mutation chain')
    assert.deepEqual(registry.archived, [], 'content member + swept ghosts cleared in that one write')
    // Idempotent rerun: nothing left to delete or sweep, still no error.
    const again = await core.purge()
    assert.equal(again.errors.length, 0)
    assert.equal(again.deletedSessions, 0)
    assert.equal(again.clearedOrphanMembers, undefined)
    assert.equal(registry.setStateCalls.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

/* ------------------------------------------------------------------ */
/* Orphan-sweep blocker fix (2026-12): enumeration UNION + the decisive */
/* hasStoredContent existence probe, over the REAL binding + REAL core. */
/* ------------------------------------------------------------------ */

test('binding hasStoredContent: resolves ⇒ true; the official not-found carrier ⇒ false; every other outcome fails closed to true', async () => {
  // 1. A resolved inspection ⇒ content is materializable.
  assert.equal(await makeHostBinding({ sessionPersistence: { inspect: async () => ({}) } } as never).hasStoredContent('s1'), true)
  // 2. The official carrier ⇒ no content. THE ONLY answer that may clear a
  //    membership.
  assert.equal(await makeHostBinding({
    sessionPersistence: { inspect: async (id: string) => { throw notFoundError(id) } },
  } as never).hasStoredContent('s1'), false)
  // 3. Corruption / format / transport / IO ⇒ true (fail closed).
  assert.equal(await makeHostBinding({
    sessionPersistence: { inspect: async () => { throw new Error('corrupt session log') } },
  } as never).hasStoredContent('s1'), true)
  // 4. A not-found-SHAPED error naming a different id ⇒ true.
  assert.equal(await makeHostBinding({
    sessionPersistence: { inspect: async () => { throw notFoundError('other') } },
  } as never).hasStoredContent('s1'), true)
  // 4b. Identification is STRUCTURAL, not message-based: an unrelated error
  //     whose message merely contains "not found" (an IO/ENOENT message) must
  //     still fail closed, while a name-matched carrier is recognised
  //     regardless of its message text.
  assert.equal(await makeHostBinding({
    sessionPersistence: { inspect: async () => { throw new Error('ENOENT: artifact not found') } },
  } as never).hasStoredContent('s1'), true)
  const renamedMessage = Object.assign(new Error('whatever'), { name: 'SessionPersistenceNotFoundError' })
  assert.equal(await makeHostBinding({
    sessionPersistence: { inspect: async () => { throw renamedMessage } },
  } as never).hasStoredContent('s1'), false)
  // 5. A non-Error throw ⇒ true.
  assert.equal(await makeHostBinding({
    sessionPersistence: { inspect: async () => { throw 'nope' } },
  } as never).hasStoredContent('s1'), true)
  // 6. No inspect surface at all (older/drifted host) ⇒ true — the sweep then
  //    skips entirely rather than guessing.
  assert.equal(await makeHostBinding({ sessionPersistence: { list: async () => [] } } as never).hasStoredContent('s1'), true)
  assert.equal(await makeHostBinding({} as never).hasStoredContent('s1'), true)
  // 7. inspect runs AS A METHOD on the service (instance-state classes — the
  //    2026-09 detached-locate real-machine regression).
  const thisSensitive = {
    root: '/r',
    async inspect(this: { root: string }, id: string) {
      assert.equal(this.root, '/r')
      assert.equal(id, 's1')
      return {}
    },
  }
  assert.equal(await makeHostBinding({ sessionPersistence: thisSensitive } as never).hasStoredContent('s1'), true)
})

test('binding union: a record only sessionPersistence.list reports survives and is never swept (narrowed query corpus)', async () => {
  // Vendor-verified narrowing: SessionCorpus.listSessions answers LIVE-ONLY
  // with no error when its optional persistence binding is absent. The union
  // must therefore keep a record the live-preferred leg omits.
  const dir = mkdtempSync(join(tmpdir(), 'archive-cleanup-union-'))
  try {
    const projectDir = join(dir, 'proj')
    mkdirSync(join(projectDir, 'persisted-1'), { recursive: true })
    const artifact = join(projectDir, 'persisted-1', 'session.jsonl')
    writeFileSync(artifact, '{}')
    const registry: RegistryFake = {
      archived: ['persisted-1', 'ghost-1'], workspaces: [{ id: 'w1' }], setStateCalls: [], chainCalls: 0,
    }
    const host = makeHostBinding(makeCtx({
      // NARROWED live-only leg: knows nothing about persisted-1.
      sessionQuery: { listSessions: async () => [{ header: header('live-1') }] },
      sessionPersistence: {
        list: async () => [header('persisted-1', { cwd: projectDir })],
        locate: (h: { id: string; cwd?: string }) => ({ kind: 'jsonl', path: join(h.cwd ?? '', h.id, 'session.jsonl') }),
        inspect: async (id: string) => {
          if (existsSync(join(projectDir, id, 'session.jsonl'))) return {}
          throw notFoundError(id)
        },
      },
    } as never, registry))

    // The union keeps BOTH records.
    const states = await host.listSessionStates()
    assert.deepEqual(states.map(s => s.sessionId).sort(), ['live-1', 'persisted-1'])

    // End-to-end: persisted-1 is deleted as a CONTENT member (it has a record
    // through the union), and only the genuinely record-less ghost is swept.
    const result = await new ArchiveCleanupCore(host).purge()
    assert.equal(result.errors.length, 0)
    assert.equal(result.deletedSessions, 1)
    assert.equal(result.clearedOrphanMembers, 1)
    assert.equal(existsSync(artifact), false)
    assert.deepEqual(registry.archived, [])
    assert.equal(registry.setStateCalls.length, 1, 'ONE chained official write')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('binding union: a failing enumeration leg refuses loudly instead of returning a narrowed corpus', async () => {
  // A partial corpus must never become the sweep's evidence: "one leg is
  // broken" is indistinguishable from "the other leg is narrowed", so the
  // failure propagates and the run mutates nothing.
  const registry: RegistryFake = {
    archived: ['a'], workspaces: [{ id: 'w1' }], setStateCalls: [], chainCalls: 0,
  }
  const host = makeHostBinding(makeCtx({
    sessionQuery: { listSessions: async () => [{ header: header('a', { cwd: '/w' }) }] },
    sessionPersistence: {
      list: async () => { throw new Error('fake: persistence list exploded') },
      locate: () => undefined,
      inspect: async () => ({}),
    },
  } as never, registry))
  await assert.rejects(() => host.listSessionStates(), /persistence list exploded/)
  const core = new ArchiveCleanupCore(host)
  await assert.rejects(() => core.purge(), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'registry-unreadable'
  })
  assert.equal(registry.setStateCalls.length, 0, 'no archived-set write')
  assert.equal(registry.chainCalls, 0, 'no registry mutation')
})

test('binding BLOCKER: a content-bearing member missing from BOTH bulk reads keeps its membership (real binding + real core)', async () => {
  // The reviewer's repro over the REAL seam: two archived members whose
  // artifacts exist on disk but which NEITHER bulk read reports (the corpus is
  // non-empty — `other-1` — so the G1 credibility guard does not mask the
  // probe). Pre-fix this purge cleared both memberships with clearedOrphanMembers=2.
  const dir = mkdtempSync(join(tmpdir(), 'archive-cleanup-blocker-'))
  try {
    const projectDir = join(dir, 'proj')
    for (const id of ['keep-1', 'keep-2']) {
      mkdirSync(join(projectDir, id), { recursive: true })
      writeFileSync(join(projectDir, id, 'session.jsonl'), '{}')
    }
    const registry: RegistryFake = {
      archived: ['keep-1', 'keep-2'], workspaces: [{ id: 'w1' }], setStateCalls: [], chainCalls: 0,
    }
    const host = makeHostBinding(makeCtx({
      sessionQuery: {
        // A credible (non-empty) corpus that silently omits both members.
        listSessions: async () => [{ header: header('other-1', { cwd: projectDir }) }],
      },
      sessionPersistence: {
        list: async () => [],
        locate: (h: { id: string; cwd?: string }) => ({ kind: 'jsonl', path: join(h.cwd ?? '', h.id, 'session.jsonl') }),
        // The official id→artifact resolution (jsonl findLog across all
        // project dirs, cwd unknown): the artifacts are still there.
        inspect: async (id: string) => {
          if (existsSync(join(projectDir, id, 'session.jsonl'))) return {}
          throw notFoundError(id)
        },
      },
    } as never, registry))

    const result = await new ArchiveCleanupCore(host).purge(['keep-1'])
    assert.equal(result.deletedSessions, 0, 'no record → no content-deletion candidate')
    assert.equal(result.clearedOrphanMembers, undefined, 'NOTHING was swept')
    assert.deepEqual(registry.archived, ['keep-1', 'keep-2'], 'both memberships survive')
    assert.equal(registry.setStateCalls.length, 0, 'no official set write at all')
    assert.equal(registry.chainCalls, 0)
    assert.equal(existsSync(join(projectDir, 'keep-2', 'session.jsonl')), true, 'keep-2 content untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('binding BLOCKER: a genuinely record-less member is still swept through the real probe (no over-correction)', async () => {
  // The fix must not disable the sweep: a member the official read cannot
  // materialize is still cleared, riding the same single write.
  const dir = mkdtempSync(join(tmpdir(), 'archive-cleanup-blocker-ok-'))
  try {
    const projectDir = join(dir, 'proj')
    mkdirSync(projectDir, { recursive: true })
    const registry: RegistryFake = {
      archived: ['ghost-1'], workspaces: [{ id: 'w1' }], setStateCalls: [], chainCalls: 0,
    }
    const host = makeHostBinding(makeCtx({
      sessionQuery: { listSessions: async () => [{ header: header('other-1', { cwd: projectDir }) }] },
      sessionPersistence: {
        list: async () => [],
        locate: () => undefined,
        inspect: async (id: string) => { throw notFoundError(id) },
      },
    } as never, registry))
    const result = await new ArchiveCleanupCore(host).purge([])
    assert.equal(result.errors.length, 0)
    assert.equal(result.clearedOrphanMembers, 1)
    assert.deepEqual(registry.archived, [])
    assert.equal(registry.setStateCalls.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
