/**
 * Resident-retention PROPERTY checks (design 24 §4 step 9, 2026-13).
 *
 * WHY A GENERATED LEG ON TOP OF core.test.ts's FIXTURES: the retention rule
 * interacts with four independent dimensions at once — lineage shape (chains,
 * archived descendants that are their own roots, orphans), per-tree liveness
 * (running / loaded / clear), the delete-time residency race (a session
 * attached AFTER the tree-level recheck), and the subset/protection filters.
 * The fixture suite pins each of those one at a time; this leg walks the
 * combination space and asserts the INVARIANTS the fix promises, which is the
 * cheapest way to catch a regression that only appears in a combination nobody
 * wrote a fixture for.
 *
 * DETERMINISTIC, NEVER FLAKY: the generator is a fixed-seed xorshift32 and the
 * core is pure against the in-memory fake — the same run always exercises the
 * same cases (a failure message carries the iteration index so the case can be
 * reconstructed by re-running with a lowering ITERATIONS if needed).
 *
 * INVARIANTS
 *  I1 (the user requirement) every root whose deletion reported residency must
 *     still be in the archived set afterwards — a resident deletion may never
 *     un-hide its row;
 *  I2 every reported `residentRetainedRoots` entry is archived AND had a
 *     residency signal (no phantom labels);
 *  I3 `forcedLoaded` equals the reported-retained roots whose content THIS run
 *     removed (a root whose content was already gone is retained, not counted);
 *  I4 a force run never skips a loaded tree;
 *  I5 the rerun deletes no content, reports no item failure, never clears a
 *     LIVE member, and only clears members that have no record at all.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ArchiveCleanupCore, type ArchiveCleanupHost, type ArchivedSessionState } from '../src/core.ts'

/** Fixed seed — see the header: determinism is the point, not entropy. */
const SEED = 0x9e3779b9
const ITERATIONS = 2000

/** One randomized fake host (same seam semantics as core.test.ts's FakeHost). */
class RandomHost implements ArchiveCleanupHost {
  readonly archived = new Set<string>()
  readonly states = new Map<string, ArchivedSessionState>()
  readonly running = new Set<string>()
  readonly loaded = new Set<string>()
  /** Sessions that ATTACH during their own deletion (the mid-run race). */
  readonly attachAtDelete = new Set<string>()
  readonly deleteLog: string[] = []
  readonly removed: string[] = []
  readonly residentAtDelete = new Map<string, boolean>()

  async listArchivedSessionIds(): Promise<readonly string[]> { return [...this.archived] }
  async listSessionStates(): Promise<readonly ArchivedSessionState[]> { return [...this.states.values()] }
  async listLiveSessionFacts(): Promise<{ running: readonly string[]; loaded: readonly string[] }> {
    return { running: [...this.running], loaded: [...new Set([...this.running, ...this.loaded])] }
  }
  async hasStoredContent(id: string): Promise<boolean> { return this.states.has(id) }
  async deleteSessionContent(
    sessionId: string,
    _cwd?: string,
    force = false,
    protectedIds?: ReadonlySet<string>,
  ): Promise<{ outcome: 'deleted' | 'missing'; resident: boolean }> {
    if (protectedIds?.has(sessionId) === true) throw new Error(`protected ${sessionId}`)
    if (this.attachAtDelete.delete(sessionId)) this.loaded.add(sessionId)
    if (this.running.has(sessionId)) throw new Error(`running ${sessionId}`)
    if (!force && this.loaded.has(sessionId)) throw new Error(`loaded ${sessionId}`)
    const resident = this.loaded.has(sessionId) || this.running.has(sessionId)
    this.residentAtDelete.set(sessionId, resident)
    if (!this.states.has(sessionId)) return { outcome: 'missing', resident }
    this.states.delete(sessionId)
    this.deleteLog.push(sessionId)
    return { outcome: 'deleted', resident }
  }
  async removeArchivedSessionIds(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      this.archived.delete(id)
      this.removed.push(id)
    }
  }
  async emitSessionRemoved(): Promise<void> {}
  async emitArchivedSessionsChanged(): Promise<void> {}
}

test(`retention properties: ${ITERATIONS} generated runs keep the retention invariants (seed ${SEED})`, async () => {
  let seed = SEED
  const rnd = (): number => {
    seed ^= seed << 13; seed >>>= 0
    seed ^= seed >> 17
    seed ^= seed << 5; seed >>>= 0
    return seed / 0x1_0000_0000
  }
  const pick = (n: number): number => Math.floor(rnd() * n)
  const chance = (p: number): boolean => rnd() < p

  for (let iter = 0; iter < ITERATIONS; iter += 1) {
    const host = new RandomHost()
    const perTree: string[][] = []
    let next = 0
    for (let t = 0, topCount = 1 + pick(4); t < topCount; t += 1) {
      const root = `s${next++}`
      host.states.set(root, { sessionId: root, running: false })
      if (chance(0.8)) host.archived.add(root)
      const members = [root]
      let parent = root
      for (let d = 0, depth = pick(3); d < depth; d += 1) {
        const child = `s${next++}`
        const running = chance(0.15)
        host.states.set(child, { sessionId: child, origin: 'subagent', parentSessionId: parent, running })
        if (running) host.running.add(child)
        if (chance(0.4)) host.archived.add(child)
        members.push(child)
        parent = child
      }
      perTree.push(members)
    }
    for (let o = 0, orphans = pick(3); o < orphans; o += 1) host.archived.add(`orphan${o}`)

    // Per-tree liveness, then the mid-run attach race on a random root.
    for (const members of perTree) {
      const roll = rnd()
      if (roll < 0.2) for (const member of members) host.running.add(member)
      else if (roll < 0.65) host.loaded.add(members[0] as string)
    }
    for (const members of perTree) {
      if (chance(0.15)) host.attachAtDelete.add(members[0] as string)
    }

    const roots = perTree.map(members => members[0] as string)
    const selection = chance(0.5) ? roots.filter(() => chance(0.7)) : undefined
    const archivedBefore = new Set(host.archived)
    const core = new ArchiveCleanupCore(host)
    const result = await core.purge(selection, true)
    const retained = new Set(result.residentRetainedRoots ?? [])
    const context = (): string => JSON.stringify({
      iter,
      perTree,
      selection,
      archivedBefore: [...archivedBefore],
      archivedAfter: [...host.archived],
      result,
      removed: host.removed,
      deleteLog: host.deleteLog,
      residentAtDelete: [...host.residentAtDelete],
    })

    // I1 — the requirement: a resident deletion never un-hides its row.
    for (const [id, resident] of host.residentAtDelete) {
      if (!resident) continue
      assert.ok(host.archived.has(id), `I1: resident-deleted ${id} left the archived set — ${context()}`)
      assert.ok(!host.removed.includes(id), `I1: resident-deleted ${id} was cleared — ${context()}`)
    }
    // I2 — reported retention is exact and never phantom.
    for (const id of retained) {
      assert.ok(host.archived.has(id), `I2: reported-retained ${id} is not archived — ${context()}`)
      const treeWasLoaded = perTree.find(members => members[0] === id)?.some(member => host.loaded.has(member)) ?? false
      assert.ok(host.residentAtDelete.get(id) === true || treeWasLoaded,
        `I2: reported-retained ${id} had no residency signal — ${context()}`)
    }
    // I3 — honest force accounting.
    const retainedWithDeletedContent = [...retained].filter(id => host.residentAtDelete.get(id) === true)
    assert.equal(result.forcedLoaded, retainedWithDeletedContent.length,
      `I3: forcedLoaded must count only retained roots whose content was removed — ${context()}`)
    // I4 — force never skips a loaded tree.
    assert.equal(result.skippedLoaded, 0, `I4: a force run skipped a loaded tree — ${context()}`)

    // I5 — the rerun converges without deleting content and never clears a live
    // member; anything it DOES clear must have had no record at all.
    const liveIds = new Set([...host.running, ...host.loaded])
    const archivedAfterFirst = new Set(host.archived)
    const recordsBeforeRerun = new Set(host.states.keys())
    const rerun = await new ArchiveCleanupCore(host).purge(selection, true)
    assert.equal(rerun.deletedSessions, 0, `I5: rerun deleted content — ${context()}`)
    assert.equal(rerun.deletedSubagents, 0, `I5: rerun deleted subagent content — ${context()}`)
    assert.deepEqual(
      rerun.errors.filter(error => error.code !== 'archive-set' && error.sessionId !== ''),
      [],
      `I5: rerun reported item failures — ${context()}`,
    )
    for (const id of archivedAfterFirst) {
      if (liveIds.has(id)) {
        assert.ok(host.archived.has(id), `I5: rerun cleared LIVE member ${id} — ${context()}`)
      } else if (!host.archived.has(id)) {
        assert.ok(!recordsBeforeRerun.has(id), `I5: rerun cleared ${id} although it still had a record — ${context()}`)
      }
    }
  }
})
