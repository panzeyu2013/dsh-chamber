/** Real-binding tests (design 24 §10 + security/perf review 2026-12):
 *  `src/binding.ts` is decorator-free, so the ACTUAL factory and gate run
 *  under node:test against in-memory service fakes + a real temp filesystem
 *  for the locate/remove content leg. The gateway class (index.ts) keeps TS
 *  decorators and is exercised by typecheck + M4 gateway-boot E2E. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

/**
 * Is the temp filesystem case-INSENSITIVE (macOS APFS default, Windows NTFS)?
 * There the second spelling below never becomes a distinct directory entry:
 * `session.v3.JSONL` resolves to the existing `session.v3.jsonl` (whichever
 * spelling the directory keeps), so the directory holds ONE entry and the purge
 * correctly sees only the canonical name — the refusal this suite asserts cannot
 * be exercised. Probed, not assumed: Linux CI (case-sensitive, the main leg)
 * keeps full coverage.
 * @returns true when the two spellings collapse onto one directory entry.
 */
function isCaseInsensitiveFs(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'archive-cleanup-case-'))
  try {
    writeFileSync(join(probe, 'session.v3.jsonl'), '{}')
    writeFileSync(join(probe, 'session.v3.JSONL'), '{}')
    // Counting entries (not matching a spelling) also covers a filesystem that
    // renames to the last-written case: either way a distinct near-miss entry
    // cannot exist, which is the only thing this probe needs to decide.
    return readdirSync(probe).length === 1
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}

function header(id: string, extra: Partial<{ cwd: string; parentSession: string; origin: 'subagent' }> = {}) {
  return { id, ...extra }
}

/** The official not-found carrier, structurally: vendor
 *  session/session-persistence/src/errors.ts SessionPersistenceNotFoundError
 *  (name + sessionId). The binding must identify it WITHOUT importing vendor
 *  internals. */

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
  // A unique temp dir: the previous hardcoded join(tmpdir(), 'x') collided
  // with any real /tmp/x and turned the artifact leg into a false storage
  // refusal (2026-09 audit).
  const missingDir = mkdtempSync(join(tmpdir(), 'archive-cleanup-missing-'))
  try {
    const ctx: HostCtxServices = {
      agents: { list: () => [{ id: 'live-1', status: 'running' }, { id: 'idle-1', status: 'idle' }] },
      sessionPersistence: { locate: h => ({ kind: 'jsonl', path: join(missingDir, h.id) }) },
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
  } finally {
    rmSync(missingDir, { recursive: true, force: true })
  }
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
    // dsh >= 0.1.3-alpha.1 keeps one file per immutable format generation plus
    // the write lease; locate() resolves only the CURRENT generation, so a
    // purge must remove every generation or the older content survives.
    const olderGeneration = join(sessionDir, 'session.v2.jsonl')
    const artifact = join(sessionDir, 'session.v3.jsonl')
    const lease = join(sessionDir, 'session.lock')
    writeFileSync(olderGeneration, '{}')
    writeFileSync(artifact, '{}')
    writeFileSync(lease, '')
    const locate = (h: { id: string; cwd?: string }) => {
      assert.equal(h.id, 's1')
      return { kind: 'jsonl', path: join(h.cwd ?? '', 's1', 'session.jsonl.zstd') }
    }
    const host = makeHostBinding({ sessionPersistence: { locate } })
    const outcome = await host.deleteSessionContent('s1', join(dir, 'proj'))
    assert.equal(outcome, 'deleted')
    assert.equal(existsSync(artifact), false, 'current generation removed')
    assert.equal(existsSync(olderGeneration), false, 'older generation removed too (no content left behind)')
    assert.equal(existsSync(lease), false, 'write lease removed')
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

    // An UNRECOGNIZED entry in the session directory refuses the whole purge
    // (fail closed): a partially-understood directory must never be deleted
    // entry by entry, and a layout drift must not silently leave content.
    const drifted = join(dir, 'proj2', 's3')
    mkdirSync(drifted, { recursive: true })
    writeFileSync(join(drifted, 'session.v3.jsonl'), '{}')
    writeFileSync(join(drifted, 'metadata.json'), '{}')
    const stubHost = makeHostBinding({
      sessionPersistence: { locate: h => ({ kind: 'jsonl', path: join(dir, 'proj2', h.id, 'session.v3.jsonl') }) },
    })
    await assert.rejects(() => stubHost.deleteSessionContent('s3', join(dir, 'proj2')), (error: unknown) => {
      return error instanceof ArchiveCleanupError && error.code === 'storage'
        && /unrecognized entry metadata\.json/.test(error.message)
    })
    assert.equal(existsSync(join(drifted, 'session.v3.jsonl')), true, 'nothing removed on refusal')

    // A leftover generation temp file (an interrupted publish) is this
    // session's own artifact and purges with the rest.
    const tempy = join(dir, 'proj4', 's5')
    mkdirSync(tempy, { recursive: true })
    writeFileSync(join(tempy, 'session.v3.jsonl'), '{}')
    writeFileSync(join(tempy, 'session.v3.jsonl.0123456789ab.tmp'), '{}')
    const tempHost = makeHostBinding({
      sessionPersistence: { locate: h => ({ kind: 'jsonl', path: join(dir, 'proj4', h.id, 'session.v3.jsonl') }) },
    })
    assert.equal(await tempHost.deleteSessionContent('s5', join(dir, 'proj4')), 'deleted')
    assert.equal(existsSync(tempy), false, 'generation + leftover temp removed, dir reclaimed')

    // A leftover MIGRATION staging file (an interrupted vN->vM migration) is
    // this session's own content staging and purges with the rest (2026-09
    // 二轮 W2 F5: without recognition the session was permanently unpurgeable).
    const migrated = join(dir, 'proj5', 's6')
    mkdirSync(migrated, { recursive: true })
    writeFileSync(join(migrated, 'session.v2.jsonl'), '{}')
    writeFileSync(join(migrated, 'session.v3.jsonl'), '{}')
    writeFileSync(join(migrated, 'session.migration.0123456789abcdef.jsonl.tmp'), '{}')
    writeFileSync(join(migrated, 'session.migration.fedcba9876543210.jsonl.zstd.tmp'), '{}')
    const migratedHost = makeHostBinding({
      sessionPersistence: { locate: h => ({ kind: 'jsonl', path: join(dir, 'proj5', h.id, 'session.v3.jsonl') }) },
    })
    assert.equal(await migratedHost.deleteSessionContent('s6', join(dir, 'proj5')), 'deleted')
    assert.equal(existsSync(migrated), false, 'generations + migration staging files removed, dir reclaimed')

    // The staging name is matched exactly: a 12-hex (publish-token) length or
    // an uppercase token is NOT the vendor shape and still refuses.
    const nearMiss = join(dir, 'proj6', 's7')
    mkdirSync(nearMiss, { recursive: true })
    writeFileSync(join(nearMiss, 'session.v3.jsonl'), '{}')
    writeFileSync(join(nearMiss, 'session.migration.0123456789ab.jsonl.tmp'), '{}')
    const nearMissHost = makeHostBinding({
      sessionPersistence: { locate: h => ({ kind: 'jsonl', path: join(dir, 'proj6', h.id, 'session.v3.jsonl') }) },
    })
    await assert.rejects(() => nearMissHost.deleteSessionContent('s7', join(dir, 'proj6')), (error: unknown) => {
      return error instanceof ArchiveCleanupError && error.code === 'storage'
        && /unrecognized entry session\.migration\.0123456789ab\.jsonl\.tmp/.test(error.message)
    })
    assert.equal(existsSync(join(nearMiss, 'session.v3.jsonl')), true, 'nothing removed on refusal')

    // A legacy version-zero directory (`session.jsonl`) purges normally.
    const legacy = join(dir, 'proj3', 's4')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'session.jsonl.zstd'), '{}')
    const legacyHost = makeHostBinding({
      sessionPersistence: { locate: h => ({ kind: 'jsonl', path: join(dir, 'proj3', h.id, 'session.jsonl.zstd') }) },
    })
    assert.equal(await legacyHost.deleteSessionContent('s4', join(dir, 'proj3')), 'deleted')
    assert.equal(existsSync(legacy), false, 'legacy generation dir reclaimed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('binding: the purge refuses symlink/subdirectory entries and accepts every canonical generation name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-cleanup-shape-'))
  try {
    const locateFor = (project: string) => (h: { id: string; cwd?: string }) =>
      ({ kind: 'jsonl', path: join(dir, project, h.id, 'session.v3.jsonl') })

    // A symlinked entry inside the session directory refuses the whole purge.
    const linkDir = join(dir, 'sym', 's1')
    mkdirSync(linkDir, { recursive: true })
    writeFileSync(join(linkDir, 'session.v3.jsonl'), '{}')
    symlinkSync(join(linkDir, 'session.v3.jsonl'), join(linkDir, 'session.v2.jsonl'))
    const linkHost = makeHostBinding({ sessionPersistence: { locate: locateFor('sym') } })
    await assert.rejects(() => linkHost.deleteSessionContent('s1', join(dir, 'sym')), (error: unknown) => {
      return error instanceof ArchiveCleanupError && error.code === 'storage' && /symlink/.test(error.message)
    })
    assert.equal(existsSync(join(linkDir, 'session.v3.jsonl')), true, 'nothing removed on refusal')

    // A subdirectory entry refuses too.
    const subDir = join(dir, 'sub', 's2')
    mkdirSync(join(subDir, 'nested'), { recursive: true })
    writeFileSync(join(subDir, 'session.v3.jsonl'), '{}')
    const subHost = makeHostBinding({ sessionPersistence: { locate: locateFor('sub') } })
    await assert.rejects(() => subHost.deleteSessionContent('s2', join(dir, 'sub')), (error: unknown) => {
      return error instanceof ArchiveCleanupError && error.code === 'storage' && /directory/.test(error.message)
    })

    // Every canonical generation name is removable: v0 bare, vN, and both
    // compressed forms; a leading-zero tag is NOT canonical and refuses.
    const okDir = join(dir, 'ok', 's3')
    mkdirSync(okDir, { recursive: true })
    for (const name of ['session.jsonl', 'session.v2.jsonl', 'session.v3.jsonl.zstd', 'session.v12.jsonl.zstd']) {
      writeFileSync(join(okDir, name), '{}')
    }
    const okHost = makeHostBinding({ sessionPersistence: { locate: locateFor('ok') } })
    assert.equal(await okHost.deleteSessionContent('s3', join(dir, 'ok')), 'deleted')
    assert.equal(existsSync(okDir), false, 'all canonical generations removed, dir reclaimed')

    const zeroDir = join(dir, 'zero', 's4')
    mkdirSync(zeroDir, { recursive: true })
    writeFileSync(join(zeroDir, 'session.v0.jsonl'), '{}')
    const zeroHost = makeHostBinding({ sessionPersistence: { locate: locateFor('zero') } })
    await assert.rejects(() => zeroHost.deleteSessionContent('s4', join(dir, 'zero')), (error: unknown) => {
      return error instanceof ArchiveCleanupError && error.code === 'storage' && /unrecognized entry session\.v0\.jsonl/.test(error.message)
    })

    // An out-of-range version is NOT canonical upstream either
    // (`Number.isSafeInteger` in parseSessionFormatLogFilename), so the
    // whitelist must refuse it instead of deleting it (2026-09 二轮 N13).
    const hugeDir = join(dir, 'huge', 's5')
    mkdirSync(hugeDir, { recursive: true })
    writeFileSync(join(hugeDir, 'session.v99999999999999999999.jsonl'), '{}')
    const hugeHost = makeHostBinding({ sessionPersistence: { locate: locateFor('huge') } })
    await assert.rejects(() => hugeHost.deleteSessionContent('s5', join(dir, 'huge')), (error: unknown) => {
      return error instanceof ArchiveCleanupError && error.code === 'storage'
        && /unrecognized entry session\.v99999999999999999999\.jsonl/.test(error.message)
    })
    assert.equal(existsSync(join(hugeDir, 'session.v99999999999999999999.jsonl')), true, 'nothing removed on refusal')

    // Near-miss names stay refused: uppercase suffix, leading-zero version, and
    // a lease name that merely PREFIXES the real lease (2026-09 三轮 Q3 G1–G4).
    const caseInsensitive = isCaseInsensitiveFs()
    for (const [project, name] of [
      ['upper', 'session.v3.JSONL'],
      ['zero', 'session.v01.jsonl'],
      ['lease', 'session.lock.tmp'],
    ]) {
      const nearDir = join(dir, project, 's9')
      mkdirSync(nearDir, { recursive: true })
      writeFileSync(join(nearDir, 'session.v3.jsonl'), '{}')
      writeFileSync(join(nearDir, name), '{}')
      if (name === 'session.v3.JSONL' && caseInsensitive) {
        // The two spellings are ONE directory entry here (see
        // {@link isCaseInsensitiveFs}), so there is no near-miss to refuse —
        // assert the collapsed reality instead: the canonical generation is the
        // only member and the purge reclaims the directory.
        assert.equal(readdirSync(nearDir).length, 1, 'the two spellings collapse onto one entry')
        const nearHost = makeHostBinding({ sessionPersistence: { locate: locateFor(project) } })
        assert.equal(await nearHost.deleteSessionContent('s9', join(dir, project)), 'deleted')
        assert.equal(existsSync(nearDir), false, 'uppercase spelling does not block the purge; dir reclaimed')
        continue
      }
      const nearHost = makeHostBinding({ sessionPersistence: { locate: locateFor(project) } })
      await assert.rejects(() => nearHost.deleteSessionContent('s9', join(dir, project)), (error: unknown) => {
        return error instanceof ArchiveCleanupError && error.code === 'storage'
          && new RegExp(`unrecognized entry ${name.replace(/\./g, '\\.')}`).test(error.message)
      })
      assert.equal(existsSync(join(nearDir, 'session.v3.jsonl')), true, `${name}: nothing removed on refusal`)
    }

    // The boundary itself IS canonical (MAX_SAFE_INTEGER), matching vendor.
    const maxDir = join(dir, 'max', 's6')
    mkdirSync(maxDir, { recursive: true })
    writeFileSync(join(maxDir, 'session.v9007199254740991.jsonl'), '{}')
    const maxHost = makeHostBinding({ sessionPersistence: { locate: locateFor('max') } })
    assert.equal(await maxHost.deleteSessionContent('s6', join(dir, 'max')), 'deleted')
    assert.equal(existsSync(maxDir), false, 'a safe-integer version is canonical and purges')
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
  // End-to-end (design 24 §4 step 5) over the REAL binding: one archived
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
        // The decisive existence probe: resolves only while the official
        // artifact is materialized, answers undefined otherwise.
        stat: async (id: string) => (existsSync(join(projectDir, id, 'session.jsonl')) ? { header: header(id) } : undefined),
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
  // domain surface): registry + session enumeration + storage locate + the
  // `stat` existence probe the sweep depends on.
  assertHostSurface({
    workspaceRegistry: { archivedSessionIds: [], list: () => [], setState: async () => {} },
    sessionQuery: { listSessions: async () => [] },
    sessionPersistence: { list: async () => [], locate: () => undefined, stat: async () => undefined },
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
  // …and without the decisive `stat` probe (the sweep's existence gate).
  assert.throws(() => assertHostSurface({
    workspaceRegistry: { archivedSessionIds: [], list: () => [], setState: async () => {} },
    sessionQuery: { listSessions: async () => [] },
    sessionPersistence: { list: async () => [], locate: () => undefined },
  } as never), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'registry-unreadable'
  })
})

test('binding: a non-array enumeration leg refuses the read loudly (no silent narrowing)', async () => {
  const host = makeHostBinding({
    sessionQuery: { listSessions: async () => ({ not: 'an array' }) },
  } as never)
  await assert.rejects(() => host.listSessionStates(), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'registry-unreadable'
      && /did not answer an array/.test(error.message)
  })
  const host2 = makeHostBinding({
    sessionPersistence: { list: async () => 'nope', locate: () => undefined, stat: async () => undefined },
  } as never)
  await assert.rejects(() => host2.listSessionStates(), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'registry-unreadable'
      && /did not answer an array/.test(error.message)
  })
})

/* ------------------------------------------------------------------ */
/* Orphan-sweep blocker fix (2026-12): enumeration UNION + the decisive */
/* hasStoredContent existence probe, over the REAL binding + REAL core. */
/* ------------------------------------------------------------------ */

test('binding hasStoredContent: a resolved snapshot ⇒ true; undefined ⇒ false; every other outcome fails closed to true', async () => {
  // 1. A resolved stat snapshot ⇒ content is materializable.
  assert.equal(await makeHostBinding({
    sessionPersistence: { stat: async () => ({ header: header('s1') }) },
  } as never).hasStoredContent('s1'), true)
  // 2. `undefined` ⇒ no materialized log. THE ONLY answer that may clear a
  //    membership (dsh >= 0.1.3-alpha.1 `stat(id)`).
  assert.equal(await makeHostBinding({
    sessionPersistence: { stat: async () => undefined },
  } as never).hasStoredContent('s1'), false)
  assert.equal(await makeHostBinding({
    sessionPersistence: { stat: async () => null },
  } as never).hasStoredContent('s1'), false)
  // 3. Corruption / format / transport / IO ⇒ true (fail closed).
  assert.equal(await makeHostBinding({
    sessionPersistence: { stat: async () => { throw new Error('corrupt session log') } },
  } as never).hasStoredContent('s1'), true)
  // 4. A non-Error throw ⇒ true.
  assert.equal(await makeHostBinding({
    sessionPersistence: { stat: async () => { throw 'nope' } },
  } as never).hasStoredContent('s1'), true)
  // 5. No stat surface at all (older/drifted host) ⇒ true — the sweep then
  //    skips entirely rather than guessing.
  assert.equal(await makeHostBinding({ sessionPersistence: { list: async () => [] } } as never).hasStoredContent('s1'), true)
  assert.equal(await makeHostBinding({} as never).hasStoredContent('s1'), true)
  // 6. stat runs AS A METHOD on the service (instance-state classes — the
  //    2026-09 detached-locate real-machine regression).
  const thisSensitive = {
    root: '/r',
    async stat(this: { root: string }, id: string) {
      assert.equal(this.root, '/r')
      assert.equal(id, 's1')
      return { header: header('s1') }
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
        // dsh >= 0.1.3-alpha.1: list() answers SessionPersistenceSnapshot[].
        list: async () => [{ header: header('persisted-1', { cwd: projectDir }) }],
        locate: (h: { id: string; cwd?: string }) => ({ kind: 'jsonl', path: join(h.cwd ?? '', h.id, 'session.jsonl') }),
        stat: async (id: string) => (existsSync(join(projectDir, id, 'session.jsonl')) ? { header: header(id) } : undefined),
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
      stat: async () => ({ header: header('s1') }),
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
        stat: async (id: string) => (existsSync(join(projectDir, id, 'session.jsonl')) ? { header: header(id) } : undefined),
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
        // No materialized log for the ghost: stat answers undefined.
        stat: async () => undefined,
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
