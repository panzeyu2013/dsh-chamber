/**
 * End-to-end scenario: the authority executor's snapshot drives the App's
 * escalation ladder (planLadder + sessionAuthorityEscalationLadder) with the
 * shipped table values.
 *
 * WHY THIS EXISTS: the executor and the ladder were unit-tested separately and the
 * App wiring only source-text locked. This composes the REAL reconciler with the REAL
 * ladder and pins the cross-module behaviour the old (deleted) session-liveness wiring
 * test used to assert by hand: healthy long runs never escalate; stuck evidence
 * reconnects once at the reconnect threshold and surfaces one notice at the notice
 * threshold; a healthy verdict clears the streak and suppresses the notice.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LADDER_TABLES,
  planLadder,
  sessionAuthorityEscalationLadder,
  type AuthorityOfficialRow,
  type AuthorityRead,
  type LadderObservation,
  type LadderRecord,
} from '@dsh-chamber/dsh-stream-state'
import { SessionAuthorityReconciler } from '../../src/shared/session-fact-reconcile.ts'

const LADDER = sessionAuthorityEscalationLadder(LADDER_TABLES.authority)

class Chain {
  now = 0
  official: Record<string, AuthorityOfficialRow> = {}
  private readonly reads: (AuthorityRead | undefined)[]
  private readIndex = 0
  private readonly resolvers: (() => void)[] = []
  private records: Readonly<Record<string, LadderRecord>> = {}
  readonly reconciler: SessionAuthorityReconciler

  constructor(reads: (AuthorityRead | undefined)[]) {
    this.reads = reads
    this.reconciler = new SessionAuthorityReconciler({
      now: () => this.now,
      generation: () => 'g1',
      readOfficial: () => ({ rows: this.official, listComplete: true }),
      readAuthority: async () => this.reads[this.readIndex++],
      correct: async () => true,
      warn: () => {},
      onSettled: () => { this.resolvers.shift()?.() },
    })
  }

  async reconcile(at: number, official: Record<string, AuthorityOfficialRow>): Promise<void> {
    this.now = at
    this.official = official
    const settled = new Promise<void>(resolve => { this.resolvers.push(resolve) })
    this.reconciler.request()
    await settled
  }

  /** One App watchdog tick, building the observation exactly like App.tsx does. */
  appTick(at: number): string[] {
    this.now = at
    const snapshot = this.reconciler.snapshot()
    const sticky = Object.values(this.official)
      .some(row => row.running === true && row.subagent !== true)
    const observation: LadderObservation = {
      sticky,
      symptomSinceMs: snapshot?.runningSince ?? at,
      progressStamp: snapshot?.progressStamp ?? 0,
      stuckEvidence: snapshot?.stuckSince !== undefined,
      escalationBlocked: false,
    }
    const plan = planLadder(LADDER, this.records, { source: observation }, at)
    this.records = plan.records
    return plan.actions.map(action => action.tier)
  }
}

const RUNNING = { s1: { running: true } }
const ALLOW: AuthorityRead = { ok: true, complete: true, rows: { s1: true } }
const DENY: AuthorityRead = { ok: true, complete: true, rows: { s1: false } }

test('a healthy long run never reconnects and never notices', async () => {
  const chain = new Chain([ALLOW, ALLOW, ALLOW])
  await chain.reconcile(0, RUNNING)
  await chain.reconcile(60_000, RUNNING)
  assert.deepEqual(chain.appTick(60_000), [])
  assert.deepEqual(chain.appTick(190_000), [], 'no stuck evidence: the reconnect tier must not fire')
  await chain.reconcile(260_000, RUNNING)
  assert.deepEqual(chain.appTick(310_000), [], 'no stuck evidence: the notice tier must not fire')
})

test('a probe that cannot conclude reconnects once, then surfaces one notice', async () => {
  const chain = new Chain([undefined, undefined, undefined])
  await chain.reconcile(0, RUNNING)
  await chain.reconcile(60_000, RUNNING)
  assert.notEqual(chain.reconciler.snapshot()?.stuckSince, undefined)
  assert.deepEqual(chain.appTick(60_000), [])
  await chain.reconcile(260_000, RUNNING)
  assert.deepEqual(chain.appTick(190_000), ['reconnect'], 'stuck evidence at the reconnect threshold')
  assert.deepEqual(chain.appTick(200_000), [], 'quota spent: no second reconnect')
  assert.deepEqual(chain.appTick(310_000), ['notice'], 'the notice follows the spent reconnect budget')
})

test('a later healthy verdict clears the streak and suppresses the notice', async () => {
  const chain = new Chain([undefined, ALLOW])
  await chain.reconcile(0, RUNNING)
  await chain.reconcile(60_000, RUNNING)
  assert.deepEqual(chain.appTick(60_000), [])
  await chain.reconcile(260_000, RUNNING)
  assert.equal(chain.reconciler.snapshot()?.stuckSince, undefined)
  assert.deepEqual(chain.appTick(260_000), [], 'progress resets the escalation streak')
  assert.deepEqual(chain.appTick(310_000), [], 'and the notice never comes back for this episode')
})

test('a denied, corrected session drops the bit and the ladder goes quiet', async () => {
  const chain = new Chain([DENY, DENY])
  await chain.reconcile(0, RUNNING)
  await chain.reconcile(60_000, RUNNING)
  assert.equal(chain.reconciler.snapshot()?.corrections, 1)
  // The official store now reflects the write: nothing running, nothing sticky.
  await chain.reconcile(90_000, { s1: { running: false } })
  assert.deepEqual(chain.appTick(200_000), [], 'the symptom is gone; no escalation')
})
