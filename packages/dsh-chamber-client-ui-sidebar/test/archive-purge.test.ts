/**
 * Archive-manager purge orchestration (design 24 §5, 2026-09 protection
 * amendment): the run NEVER refuses. It always stops the selection's running
 * turns (advisory) and always force-purges the same roots with the session
 * this client may be displaying in the host's protected set. Node-tested
 * without a React render.
 *
 * The regression this file exists for: the retired pre-flight gate turned an
 * unknown viewed session (nothing open, masked list gap, source shell
 * reclaimed) into a total capability loss — exactly the archived-but-running
 * sessions the force path exists for stayed undeletable.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { archivePurgeNote, purgeRemovedContent, runArchivePurge } from '../src/shared/archive-purge.ts'
import type {
  ArchiveCleanupPurgeResult,
  SessionRunningLineage,
  StopSessionsResult,
} from '../src/shared/instance-api.ts'

function purgeResult(overrides: Partial<ArchiveCleanupPurgeResult> = {}): ArchiveCleanupPurgeResult {
  return {
    deletedSessions: 0,
    deletedSubagents: 0,
    skippedRunning: 0,
    skippedLoaded: 0,
    forcedLoaded: 0,
    skippedProtected: 0,
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
    lineage: null,
    ...overrides,
  }
}

function keysOf(lines: readonly { key: string }[]): string[] {
  return lines.map(line => line.key)
}

// ---------------------------------------------------------------------------
// runArchivePurge: one shape, in every state.
// ---------------------------------------------------------------------------

test('runArchivePurge: a known viewed session is protected and force is always on', async () => {
  const stopCalls: unknown[] = []
  const purgeCalls: unknown[] = []
  const run = await runArchivePurge({} as never, ['root-a', 'root-a', 'root-b'], 'session-viewed', {
    stop: async (_client, ids, deps) => {
      stopCalls.push([ids, deps])
      return stopResult({ cancelled: ['root-a'] })
    },
    purge: async (_client, ids, protect) => {
      purgeCalls.push([ids, protect])
      return purgeResult({ deletedSessions: 2, forcedLoaded: 1, skippedProtected: 1 })
    },
  })
  assert.deepEqual(stopCalls, [[['root-a', 'root-b'], { exclude: ['session-viewed'], requireCompleteExcludeChain: true }]])
  assert.deepEqual(purgeCalls, [[['root-a', 'root-b'], ['session-viewed']]])
  assert.equal(run.protectedSessionId, 'session-viewed')
  assert.equal(run.purge.deletedSessions, 2)
})

test('runArchivePurge: an UNKNOWN viewed session still purges and protects nothing (2026-09 dead-end regression)', async () => {
  const purgeCalls: unknown[] = []
  const stopCalls: unknown[] = []
  const run = await runArchivePurge({} as never, ['root-a'], undefined, {
    stop: async (_client, ids, deps) => {
      stopCalls.push([ids, deps])
      return stopResult()
    },
    purge: async (_client, ids, protect) => {
      purgeCalls.push([ids, protect])
      return purgeResult({ deletedSessions: 1 })
    },
  })
  // No exclusion and no chain gate: with nothing to protect, the cancels still
  // run (they are what makes a running archived tree deletable).
  assert.deepEqual(stopCalls, [[['root-a'], { requireCompleteExcludeChain: false }]])
  assert.deepEqual(purgeCalls, [[['root-a'], []]], 'the purge runs WITHOUT protection instead of refusing')
  assert.equal(run.protectedSessionId, undefined)
  assert.equal(run.purge.deletedSessions, 1)
})

test('runArchivePurge: an unreadable lineage never refuses the run — the stop pass is advisory', async () => {
  const run = await runArchivePurge({} as never, ['root-a'], 'session-viewed', {
    stop: async () => stopResult({ unavailable: true }),
    purge: async () => purgeResult({ deletedSessions: 1, skippedRunning: 1 }),
  })
  assert.equal(run.stop?.unavailable, true)
  assert.equal(run.purge.deletedSessions, 1, 'the purge still ran; the host running guard is the safety net')
  const note = archivePurgeNote(run)
  assert.deepEqual(keysOf(note.lines), ['archive.purge.note.deleted', 'archive.purge.note.skippedRunning'])
  assert.equal(note.kind, 'info')
})

test('runArchivePurge: a THROWING stop pass is logged and never blocks the purge (advisory-never-fatal)', async () => {
  const run = await runArchivePurge({} as never, ['root-a'], 'session-viewed', {
    stop: async () => { throw new Error('contract violation: the pass must never throw') },
    purge: async () => purgeResult({ deletedSessions: 1 }),
  })
  assert.equal(run.stop, null, 'a contract violation leaves no stop facts — but must not refuse the run')
  assert.equal(run.purge.deletedSessions, 1)
  assert.deepEqual(keysOf(archivePurgeNote(run).lines), ['archive.purge.note.deleted'])
})

test('runArchivePurge: protection skips are whatever the HOST reports (the client refuses no root itself)', async () => {
  const run = await runArchivePurge({} as never, ['root-a', 'root-b'], 'session-viewed', {
    stop: async () => stopResult(),
    purge: async () => purgeResult({ deletedSessions: 1, skippedProtected: 1 }),
  })
  assert.deepEqual(run.roots, ['root-a', 'root-b'], 'every selected root reaches the host')
  assert.equal(run.purge.skippedProtected, 1)
})

// ---------------------------------------------------------------------------
// archivePurgeNote: dictionary keys only, no refusal copy exists anymore.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Flow × REAL stop pass (the seam the 2026-09 dead end lived on): the pure
// flow must delegate the cancel scope to `stopSessionsForPurge` and ALWAYS
// reach the purge, whatever the lineage looks like.
// ---------------------------------------------------------------------------

function sessionRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return { cwd: '/w', running: false, blank: false, updatedAt: 0, ...overrides }
}

function lineageClient(rows: readonly unknown[] | (() => readonly unknown[]), cancels: string[]) {
  return {
    session: {
      list: async () => ({ ok: true as const, value: { items: typeof rows === 'function' ? rows() : rows } }),
      cancel: async ({ sessionId }: { sessionId: string }) => {
        cancels.push(sessionId)
        return { ok: true as const, value: {} }
      },
    },
  }
}

test('runArchivePurge: a complete viewed-session chain cancels the closure (minus the viewed id) and then purges its roots', async () => {
  const cancels: string[] = []
  const purgeCalls: unknown[] = []
  // The row's running bit clears once the cancel landed, so the pass's settle
  // wait exits on its first poll instead of burning the full 3s budget.
  const rows = (): readonly unknown[] => [
    sessionRow({ sessionId: 'root' }),
    sessionRow({ sessionId: 'child', parentSessionId: 'root', origin: 'subagent', running: !cancels.includes('child') }),
    sessionRow({ sessionId: 'viewed' }),
  ]
  const run = await runArchivePurge(lineageClient(rows, cancels) as never, ['root', 'viewed'], 'viewed', {
    purge: async (_client, ids, protect) => {
      purgeCalls.push([ids, protect])
      return purgeResult({ deletedSessions: 1, skippedProtected: 1 })
    },
  })
  assert.deepEqual(cancels, ['root', 'child'], 'closure members cancel, the viewed id does not')
  assert.deepEqual(run.stop?.cancelled, ['child'], 'only the observed-running member counts as stopped')
  assert.deepEqual(run.stop?.stillRunning, [], 'the settle wait saw the cancel land')
  assert.deepEqual(purgeCalls, [[['root', 'viewed'], ['viewed']]], 'every root still reaches the host')
})

test('runArchivePurge: an INCOMPLETE viewed-session chain cancels nothing — and still purges (no dead end)', async () => {
  const cancels: string[] = []
  const purgeCalls: unknown[] = []
  // `viewed` lost its middle ancestor (the vendor drops cwd-less cold rows), so
  // whose closure contains it cannot be proven: no tree may be cancelled.
  const rows = [
    sessionRow({ sessionId: 'root' }),
    sessionRow({ sessionId: 'child', parentSessionId: 'root', origin: 'subagent', running: true }),
    sessionRow({ sessionId: 'mid', parentSessionId: 'missing', origin: 'subagent' }),
    sessionRow({ sessionId: 'viewed', parentSessionId: 'mid', origin: 'subagent' }),
  ]
  const run = await runArchivePurge(lineageClient(rows, cancels) as never, ['root'], 'viewed', {
    purge: async (_client, ids, protect) => {
      purgeCalls.push([ids, protect])
      return purgeResult({ deletedSessions: 0, skippedRunning: 1 })
    },
  })
  assert.deepEqual(cancels, [], 'no cancel may fire while the viewed session could be inside any selected tree')
  assert.equal(run.stop?.unavailable, false, 'this is a scope decision, not a failed read')
  assert.deepEqual(purgeCalls, [[['root'], ['viewed']]], 'the purge still runs; the host running guard decides')
  assert.equal(run.purge.skippedRunning, 1)
})

test('archivePurgeNote renders the stop / protected / deleted / skip lines in order', () => {
  const note = archivePurgeNote({
    roots: ['a', 'b'],
    protectedSessionId: 'viewed',
    stop: stopResult({ cancelled: ['a'], stillRunning: ['b'], failures: [{ sessionId: 'b', message: 'boom' }] }),
    purge: purgeResult({
      deletedSessions: 1,
      deletedSubagents: 2,
      forcedLoaded: 1,
      skippedRunning: 1,
      skippedLoaded: 2,
      skippedProtected: 1,
      clearedOrphanMembers: 3,
      truncated: true,
    }),
  })
  assert.deepEqual(keysOf(note.lines), [
    'archive.purge.note.stopped',
    'archive.purge.note.protected',
    'archive.purge.note.deleted',
    'archive.purge.note.orphanMembers',
    'archive.purge.note.forcedLoaded',
    'archive.purge.note.skippedRunning',
    'archive.purge.note.skippedLoaded',
    'archive.purge.note.stillRunning',
    'archive.purge.note.stopFailure',
    'archive.purge.note.truncated',
  ])
  assert.equal(note.kind, 'info')
  const byKey = new Map(note.lines.map(line => [line.key, line.params]))
  assert.deepEqual(byKey.get('archive.purge.note.protected'), { count: 1 })
  assert.deepEqual(byKey.get('archive.purge.note.deleted'), { sessions: 1, subagents: 2 })
})

test('archivePurgeNote: a protection-only run is never silent (the actionable fact is the viewed session)', () => {
  const note = archivePurgeNote({
    roots: ['a'],
    protectedSessionId: 'viewed',
    stop: stopResult(),
    purge: purgeResult({ skippedProtected: 1 }),
  })
  assert.deepEqual(keysOf(note.lines), ['archive.purge.note.protected'])
  assert.equal(note.kind, 'info')
})

test('purgeRemovedContent: only a run that actually removed something asks the dialog to drop the selection', () => {
  const base = { roots: ['a'], stop: stopResult() }
  assert.equal(purgeRemovedContent({ ...base, purge: purgeResult({ deletedSessions: 1 }) }), true)
  assert.equal(purgeRemovedContent({ ...base, purge: purgeResult({ deletedSubagents: 2 }) }), true)
  assert.equal(purgeRemovedContent({ ...base, purge: purgeResult({ clearedOrphanMembers: 1 }) }), true)
  // Nothing removed => every row survives => the documented retry ("switch away
  // and retry") must not require re-selecting anything.
  assert.equal(purgeRemovedContent({ ...base, purge: purgeResult({ skippedProtected: 1 }) }), false)
  assert.equal(purgeRemovedContent({ ...base, purge: purgeResult({ skippedRunning: 2, skippedLoaded: 3 }) }), false)
  assert.equal(purgeRemovedContent({ ...base, purge: purgeResult() }), false)
})

test('archivePurgeNote: an empty outcome is never silent (v1 E-n2 parity)', () => {
  const note = archivePurgeNote({
    roots: [],
    stop: stopResult(),
    purge: purgeResult(),
  })
  assert.deepEqual(keysOf(note.lines), ['archive.manager.empty'])
})

test('archivePurgeNote: item errors render as an error note with bounded samples', () => {
  const note = archivePurgeNote({
    roots: ['a'],
    stop: stopResult(),
    purge: purgeResult({
      deletedSessions: 1,
      errors: [
        { sessionId: 'a', code: 'storage', message: 'e1' },
        { sessionId: 'b', code: 'storage', message: 'e2' },
        { sessionId: 'c', code: 'storage', message: 'e3' },
        { sessionId: 'd', code: 'storage', message: 'e4' },
      ],
    }),
  })
  assert.equal(note.kind, 'error')
  assert.deepEqual(keysOf(note.lines), [
    'archive.purge.note.deleted',
    'archive.purge.note.errors',
    'archive.purge.note.errorSample',
    'archive.purge.note.errorSample',
    'archive.purge.note.errorSample',
  ])
})

test('archivePurgeNote: an absent viewed id and an unreadable stop pass stay out of the note (nothing was stopped/protected)', () => {
  const lineage: SessionRunningLineage | null = null
  const note = archivePurgeNote({
    roots: ['a'],
    stop: stopResult({ unavailable: true, lineage }),
    purge: purgeResult({ deletedSessions: 1 }),
  })
  assert.deepEqual(keysOf(note.lines), ['archive.purge.note.deleted'])
})
