/**
 * Pure archive-purge decisions (design 24 §21, 2026-09 fix rounds): the
 * runtime-report gate, the known-current requirement (N1), the closure-based
 * current-session refusal, the partial-lineage refusal (E-#1), the fail-closed
 * unknown-closure rule, and the outcome note KEYS + params (the module is
 * locale-free; the dialog applies `t()`). Node-tested without a React render.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  archivePurgeNote,
  purgeRefusalReason,
  runArchivePurge,
  type ArchivePurgeFlowResult,
  type PurgeNoteLine,
} from '../src/shared/archive-purge.ts'
import {
  fetchSessionRunningLineage,
  sessionPurgeClosure,
  stopSessionsForPurge,
  upwardChainComplete,
  type ArchiveCleanupPurgeResult,
  type SessionRunningLineage,
  type StopSessionsResult,
} from '../src/shared/instance-api.ts'

/** One `session/list` row, exactly the shape the reader consumes. */
interface Row {
  readonly sessionId: string
  readonly running?: boolean
  readonly origin?: 'subagent'
  readonly parentSessionId?: string
}

/** Build a lineage the way `fetchSessionRunningLineage` does (so a MISSING row
 *  really is missing, which is the whole point of the E-#1 tests). */
function lineageOfRows(rows: readonly Row[]): SessionRunningLineage {
  const running = new Set<string>()
  const parents = new Map<string, string>()
  const listed = new Set<string>()
  const subagentIds = new Set<string>()
  for (const row of rows) {
    listed.add(row.sessionId)
    if (row.running === true) running.add(row.sessionId)
    if (row.origin !== 'subagent') continue
    subagentIds.add(row.sessionId)
    if (typeof row.parentSessionId === 'string' && row.parentSessionId !== ''
      && row.parentSessionId !== row.sessionId) {
      parents.set(row.sessionId, row.parentSessionId)
    }
  }
  return { running, parents, listed, subagentIds }
}

function lineageClient(items: readonly unknown[]) {
  return { session: { list: async () => ({ ok: true as const, value: { items } }) } }
}

function purgeResult(overrides: Partial<ArchiveCleanupPurgeResult> = {}): ArchiveCleanupPurgeResult {
  return {
    deletedSessions: 0,
    deletedSubagents: 0,
    skippedRunning: 0,
    skippedLoaded: 0,
    forcedLoaded: 0,
    forceUnsupported: false,
    errors: [],
    truncated: false,
    ...overrides,
  }
}

function stopResult(overrides: Partial<StopSessionsResult> = {}): StopSessionsResult {
  return {
    cancelled: [],
    stillRunning: [],
    failures: [],
    unavailable: false,
    refusedRoots: [],
    lineage: lineageOfRows([]),
    ...overrides,
  }
}

function flowResult(overrides: Partial<ArchivePurgeFlowResult> = {}): ArchivePurgeFlowResult {
  return {
    roots: [],
    skippedCurrent: false,
    refusedRoots: [],
    stop: null,
    purge: null,
    refusal: null,
    ...overrides,
  }
}

function keysOf(lines: readonly PurgeNoteLine[]): string[] {
  return lines.map(line => line.key)
}

// ---------------------------------------------------------------------------
// The pre-flight gate: fail-closed for a missing report, an unknown current
// session (N1) and a nullish source (N2). It returns KEYS, not copy.
// ---------------------------------------------------------------------------

test('purgeRefusalReason refuses EVERY unknown runtime state (N1 + N2) and returns a dictionary key', () => {
  assert.equal(purgeRefusalReason(null), 'archive.purge.refusal.runtimeUnknown',
    'N2: a nullish source must refuse, never default to permissive')
  assert.equal(purgeRefusalReason(undefined), 'archive.purge.refusal.runtimeUnknown')
  assert.equal(purgeRefusalReason({}), 'archive.purge.refusal.runtimeUnknown')
  assert.equal(purgeRefusalReason({ runtime: undefined }), 'archive.purge.refusal.runtimeUnknown')
  assert.equal(purgeRefusalReason({ runtime: {} }), 'archive.purge.refusal.currentUnknown',
    'N1: the vendor masks `current` during a transient list gap — absent is UNKNOWN, not "nothing viewed"')
  assert.equal(purgeRefusalReason({ runtime: { current: '' } }), 'archive.purge.refusal.currentUnknown')
  assert.equal(purgeRefusalReason({ runtime: { current: 's1' } }), null,
    'only a KNOWN current session opens the force path')
})

// ---------------------------------------------------------------------------
// runArchivePurge: every refusal is NAMED, and none of them touches the wire.
// ---------------------------------------------------------------------------

test('runArchivePurge refuses when the current session is UNKNOWN (N1): no stop pass, no purge', async () => {
  let purged = 0
  const run = await runArchivePurge({} as never, ['a', 'b'], undefined, {
    stop: async () => { assert.fail('no stop pass may run without a known current session') },
    purge: async () => { purged += 1; return purgeResult() },
  })
  assert.equal(run.refusal, 'current-unknown')
  assert.equal(purged, 0)
  assert.equal(run.stop, null)
  assert.equal(run.purge, null)
  const note = archivePurgeNote(run)
  assert.equal(note.kind, 'error')
  assert.deepEqual(keysOf(note.lines), ['archive.purge.refusal.currentUnknown'])
})

test('runArchivePurge: a failed session/list read with a known current REFUSES the run (closure-unknown)', async () => {
  let purged = 0
  const client = {
    session: { list: async () => { throw new Error('raw wire text: session/list exploded') } },
  }
  const run = await runArchivePurge(client as never, ['root', 'other'], 'grand', {
    purge: async () => { purged += 1; return purgeResult({ deletedSessions: 2 }) },
  })
  assert.equal(run.refusal, 'closure-unknown')
  assert.equal(purged, 0)
  assert.deepEqual(run.roots, [])
  assert.equal(run.stop?.unavailable, true)
  const note = archivePurgeNote(run)
  assert.equal(note.kind, 'error')
  assert.deepEqual(keysOf(note.lines), ['archive.purge.refusal.closureUnknown'],
    'raw wire text never reaches the note (only a dictionary key does)')
})

test('runArchivePurge REFUSES when the viewed session\'s upward chain is incomplete (E-#1, partial lineage)', async () => {
  // grand → child → root, but the intermediate `child` row is MISSING from the
  // read (the vendor skips cwd-less cold records), so the client cannot prove
  // the viewed session is outside root's tree while the HOST still would
  // delete it.
  const partial = lineageOfRows([
    { sessionId: 'root' },
    { sessionId: 'grand', origin: 'subagent', parentSessionId: 'child', running: true },
  ])
  const cancelled: string[] = []
  let purged = 0
  const run = await runArchivePurge({} as never, ['root'], 'grand', {
    stop: async (client, ids, deps) => stopSessionsForPurge(client, ids, {
      ...deps,
      fetchRunning: async () => partial,
      cancel: async (_client, sessionId) => { cancelled.push(sessionId) },
      delay: async () => {},
      attempts: 1,
    }),
    purge: async () => { purged += 1; return purgeResult({ deletedSessions: 1 }) },
  })
  assert.equal(run.refusal, 'lineage-incomplete')
  assert.equal(purged, 0, 'the host would have deleted the viewed session with the tree')
  assert.deepEqual(cancelled, [], 'nothing may be cancelled either')
  const note = archivePurgeNote(run)
  assert.equal(note.kind, 'error')
  assert.deepEqual(keysOf(note.lines), ['archive.purge.refusal.lineageIncomplete'])
})

test('runArchivePurge proceeds when the viewed session\'s upward chain is complete (E-#1 unchanged path)', async () => {
  // The viewed session hangs off a DIFFERENT root: the chain resolves fully and
  // never reaches the selected root, so the purge proceeds exactly as before.
  const complete = lineageOfRows([
    { sessionId: 'root' },
    { sessionId: 'other-root' },
    { sessionId: 'other-child', origin: 'subagent', parentSessionId: 'other-root' },
    { sessionId: 'grand', origin: 'subagent', parentSessionId: 'other-child', running: true },
  ])
  const purgeCalls: string[][] = []
  const run = await runArchivePurge({} as never, ['root'], 'grand', {
    stop: async (client, ids, deps) => stopSessionsForPurge(client, ids, {
      ...deps,
      fetchRunning: async () => complete,
      cancel: async () => {},
      delay: async () => {},
      attempts: 1,
    }),
    purge: async (_client, ids) => { purgeCalls.push([...(ids ?? [])]); return purgeResult({ deletedSessions: 1 }) },
  })
  assert.equal(run.refusal, null)
  assert.deepEqual(purgeCalls, [['root']], 'a complete chain that does not reach a selected root proceeds as before')
})

test('runArchivePurge refuses a selected root whose closure contains the viewed session', async () => {
  const cancelled: string[] = []
  const purgeCalls: string[][] = []
  let chain = lineageOfRows([
    { sessionId: 'root' },
    { sessionId: 'child', origin: 'subagent', parentSessionId: 'root', running: true },
    { sessionId: 'grand', origin: 'subagent', parentSessionId: 'child', running: true },
    { sessionId: 'other', running: true },
  ])
  const run = await runArchivePurge({} as never, ['root', 'other'], 'grand', {
    stop: async (client, ids, deps) => stopSessionsForPurge(client, ids, {
      ...deps,
      fetchRunning: async () => chain,
      cancel: async (_client, sessionId) => { cancelled.push(sessionId) },
      // The settle wait re-reads the lineage; clear the running bits so the
      // note has no stillRunning line.
      delay: async () => {
        chain = lineageOfRows([
          { sessionId: 'root' },
          { sessionId: 'child', origin: 'subagent', parentSessionId: 'root' },
          { sessionId: 'grand', origin: 'subagent', parentSessionId: 'child' },
          { sessionId: 'other' },
        ])
      },
      attempts: 1,
    }),
    purge: async (_client, ids) => { purgeCalls.push([...(ids ?? [])]); return purgeResult({ deletedSessions: 1 }) },
  })
  assert.equal(run.refusal, null)
  assert.deepEqual(run.refusedRoots, ['root'],
    'the viewed session is a subagent descendant of root: root\'s whole tree would be deleted')
  assert.deepEqual(run.roots, ['other'], 'the unrelated root is still purged')
  assert.deepEqual(purgeCalls, [['other']])
  assert.deepEqual(cancelled, ['other'],
    'the refused root is never cancelled and the viewed id is excluded from the pass')
  assert.deepEqual(keysOf(archivePurgeNote(run).lines), [
    'archive.purge.note.stopped',
    'archive.purge.refusal.currentInClosure',
    'archive.purge.note.deleted',
  ])
})

test('runArchivePurge refuses EVERY root when the viewed session sits in each closure (nothing stopped, nothing purged)', async () => {
  let purged = 0
  const chain = lineageOfRows([
    { sessionId: 'root' },
    { sessionId: 'child', origin: 'subagent', parentSessionId: 'root' },
    { sessionId: 'grand', origin: 'subagent', parentSessionId: 'child' },
  ])
  const run = await runArchivePurge({} as never, ['root'], 'grand', {
    stop: async (client, ids, deps) => stopSessionsForPurge(client, ids, {
      ...deps,
      fetchRunning: async () => chain,
      cancel: async () => { assert.fail('a refused root must never be cancelled') },
      delay: async () => {},
      attempts: 1,
    }),
    purge: async () => { purged += 1; return purgeResult() },
  })
  assert.equal(run.refusal, 'current-in-closure')
  assert.deepEqual(run.refusedRoots, ['root'])
  assert.deepEqual(run.roots, [])
  assert.equal(purged, 0)
  const note = archivePurgeNote(run)
  assert.equal(note.kind, 'error')
  assert.deepEqual(note.lines[0]?.params, { count: 1 })
})

test('runArchivePurge keeps the roots leg: the viewed session itself is dropped from the selection', async () => {
  const purgeCalls: string[][] = []
  const run = await runArchivePurge({} as never, ['viewed', 'other'], 'viewed', {
    stop: async () => stopResult({
      lineage: lineageOfRows([{ sessionId: 'viewed' }, { sessionId: 'other' }]),
    }),
    purge: async (_client, ids) => { purgeCalls.push([...(ids ?? [])]); return purgeResult({ deletedSessions: 1 }) },
  })
  assert.equal(run.skippedCurrent, true)
  assert.deepEqual(run.roots, ['other'])
  assert.deepEqual(purgeCalls, [['other']])
  assert.deepEqual(keysOf(archivePurgeNote(run).lines), [
    'archive.purge.note.deleted',
    'archive.purge.note.skippedCurrent',
  ])
})

test('runArchivePurge with a selection that is only the viewed session does nothing at all', async () => {
  const run = await runArchivePurge({} as never, ['viewed'], 'viewed', {
    stop: async () => { assert.fail('no stop pass may run when nothing is purgeable') },
    purge: async () => { assert.fail('no purge may run when nothing is purgeable') },
  })
  assert.equal(run.refusal, 'current-only')
  assert.equal(run.stop, null)
  assert.equal(run.purge, null)
  const note = archivePurgeNote(run)
  assert.equal(note.kind, 'error')
  assert.deepEqual(keysOf(note.lines), ['archive.purge.refusal.currentOnly'])
})

test('runArchivePurge does NOT refuse a root when the viewed session is only a FORK child (F3)', async () => {
  const purgeCalls: string[][] = []
  // `fork` is a running fork of `root`: parentSessionId set, origin absent —
  // no lineage edge, so the chain ends at the fork row and the host's purge
  // tree never contains it.
  const forkLineage = lineageOfRows([
    { sessionId: 'root' },
    { sessionId: 'fork', parentSessionId: 'root', running: true },
  ])
  const run = await runArchivePurge({} as never, ['root'], 'fork', {
    stop: async (client, ids, deps) => stopSessionsForPurge(client, ids, {
      ...deps,
      fetchRunning: async () => forkLineage,
      cancel: async () => {},
      delay: async () => {},
      attempts: 1,
    }),
    purge: async (_client, ids) => { purgeCalls.push([...(ids ?? [])]); return purgeResult({ deletedSessions: 1 }) },
  })
  assert.equal(run.refusal, null)
  assert.deepEqual(run.refusedRoots, [], 'a fork edge is not lineage: root\'s closure does not contain the fork')
  assert.deepEqual(purgeCalls, [['root']])
  assert.deepEqual(sessionPurgeClosure(['root'], forkLineage), ['root'])
})

// ---------------------------------------------------------------------------
// The lineage reader + upward-chain helper the refusal relies on.
// ---------------------------------------------------------------------------

test('upwardChainComplete resolves a full subagent chain and rejects a dropped intermediate row', async () => {
  const rows: Row[] = [
    { sessionId: 'root' },
    { sessionId: 'child', origin: 'subagent', parentSessionId: 'root' },
    { sessionId: 'grand', origin: 'subagent', parentSessionId: 'child' },
  ]
  const complete = await fetchSessionRunningLineage(lineageClient(rows) as never)
  assert.equal(upwardChainComplete('grand', complete), true)
  assert.equal(upwardChainComplete('root', complete), true, 'a non-subagent row ends the chain')
  assert.deepEqual([...complete.listed].sort(), ['child', 'grand', 'root'])
  assert.deepEqual([...complete.subagentIds].sort(), ['child', 'grand'])

  const dropped = lineageOfRows([rows[0]!, rows[2]!])
  assert.equal(upwardChainComplete('grand', dropped), false,
    'the intermediate `child` row is missing: the chain is unresolvable')
  const linkless = lineageOfRows([rows[0]!, { sessionId: 'child', origin: 'subagent' }, rows[2]!])
  assert.equal(upwardChainComplete('grand', linkless), false,
    'a subagent row without a usable parent link is unresolvable')
  const cyclic = lineageOfRows([
    { sessionId: 'a', origin: 'subagent', parentSessionId: 'b' },
    { sessionId: 'b', origin: 'subagent', parentSessionId: 'a' },
  ])
  assert.equal(upwardChainComplete('a', cyclic), false, 'a cycle never resolves to a top-level row')
  assert.equal(upwardChainComplete('absent', complete), false, 'an unlisted row is unknown')
})

// ---------------------------------------------------------------------------
// Note composition: keys + params, the legacy-host gate and the neutral
// fallback (N5) are pinned here instead of through a React render.
// ---------------------------------------------------------------------------

test('the legacy-host line is GATED on an actual skip (forceUnsupported alone is silent)', () => {
  const silent = archivePurgeNote(flowResult({
    roots: ['a'],
    stop: stopResult(),
    purge: purgeResult({ forceUnsupported: true, deletedSessions: 1 }),
  }))
  assert.equal(silent.kind, 'info')
  assert.equal(keysOf(silent.lines).includes('archive.purge.note.legacyHost'), false,
    'nothing was skipped: the legacy clause would claim a loss that did not happen')

  const honest = archivePurgeNote(flowResult({
    roots: ['a'],
    stop: stopResult(),
    purge: purgeResult({ forceUnsupported: true, skippedLoaded: 2, deletedSessions: 1 }),
  }))
  assert.deepEqual(keysOf(honest.lines), [
    'archive.purge.note.deleted',
    'archive.purge.note.legacyHost',
    'archive.purge.note.skippedLoaded',
  ])
  assert.deepEqual(honest.lines[2]?.params, { count: 2 })
})

test('an empty outcome is never silent; item errors render as an error note with params', () => {
  const empty = archivePurgeNote(flowResult({
    roots: ['a'],
    stop: stopResult(),
    purge: purgeResult(),
  }))
  assert.equal(empty.kind, 'info')
  assert.deepEqual(keysOf(empty.lines), ['archive.manager.empty'])

  const failed = archivePurgeNote(flowResult({
    roots: ['a'],
    stop: stopResult({ stillRunning: ['child'], failures: [{ sessionId: 'x', message: 'boom' }] }),
    purge: purgeResult({ errors: [{ sessionId: 'a', code: 'running', message: 'still running' }] }),
  }))
  assert.equal(failed.kind, 'error')
  assert.deepEqual(keysOf(failed.lines), [
    'archive.purge.note.stillRunning',
    'archive.purge.note.stopFailure',
    'archive.purge.note.errors',
    'archive.purge.note.errorSample',
  ])
  assert.deepEqual(failed.lines[1]?.params, { sessionId: 'x', message: 'boom' })
  assert.deepEqual(failed.lines[3]?.params, { message: 'still running' })
})

test('N5: an outcome with no named refusal NEVER borrows a refusal\'s copy', () => {
  const note = archivePurgeNote(flowResult({ refusal: null, stop: null, purge: null }))
  assert.equal(note.kind, 'error')
  assert.deepEqual(keysOf(note.lines), ['archive.purge.note.indeterminate'],
    'the unrepresentable state gets neutral copy — no asserted cause')
})
