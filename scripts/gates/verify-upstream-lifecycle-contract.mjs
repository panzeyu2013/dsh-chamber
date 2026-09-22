#!/usr/bin/env node
/**
 * Upstream lifecycle-contract gate (P6, design 14 §D4).
 *
 * WHY. The fork's opening deadline and its 30 → 300 s widening ladder exist only
 * because the pinned host `session/follow` has no first-frame bound and the client
 * `doOpen` awaits it without one: a lost opening frame parks `openState='loading'`
 * forever. This gate pins both halves of that contract against the pinned vendor
 * tree, so the day upstream lands a bound the retirement is loud: delete the client
 * ladder (design 14 §D4 ①/③, STATUS ③) and update this gate.
 *
 * Source text only (no build, no imports), like verify:anchors, so it runs in any
 * checkout with the vendor tree present.
 *
 * Usage: node scripts/gates/verify-upstream-lifecycle-contract.mjs [--self-test]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

const FILES = {
  hostFollow: join(ROOT, 'vendor/harness-checkout/packages/api/session-controller/src/history.ts'),
  clientSession: join(ROOT, 'vendor/harness-checkout/packages/api/session-controller/src/client/sessions/session.ts'),
  forkOpening: join(ROOT, 'packages/dsh-api-gateway/src/client/stream-client.ts'),
  proposals: join(ROOT, 'docs/progress/todo/upstream-proposals.md'),
}

/** Any of these in a pinned lifecycle source means a first-frame bound exists. */
export const FIRST_FRAME_BOUND =
  /AbortSignal\.timeout\(|firstFrameDeadline|openingFrameDeadline|followDeadline|firstFrameTimeout/iu

/**
 * The host send half: `follow` must still yield an opening snapshot first and carry
 * no deadline of its own.
 * @param history - the pinned session-controller history source.
 */
export function hostFirstFrameContract(history) {
  const follow = history.indexOf('async *follow(')
  const snapshot = follow >= 0 ? history.indexOf("type: 'snapshot'", follow) : -1
  return {
    hasFollow: follow >= 0,
    hasSnapshot: snapshot > follow,
    hasBound: FIRST_FRAME_BOUND.test(history),
  }
}

/**
 * The client receive half: `doOpen` must still await the event stream without a
 * bound, or the fork ladder is no longer the only owner.
 * @param session - the pinned session-controller client session source.
 */
export function clientOpenContract(session) {
  const start = session.indexOf('private async doOpen(')
  const end = session.indexOf('/** Apply one contiguous journal update', start)
  const body = start >= 0 ? session.slice(start, end > start ? end : start + 4_000) : ''
  return {
    hasDoOpen: start >= 0,
    awaitsOpen: /await events\.open\(/u.test(body),
    hasBound: FIRST_FRAME_BOUND.test(body),
  }
}

/**
 * The fork half: the deadline must still be armed by the reducer path, and the
 * retirement condition must still be written down.
 * @param fork - stream-client source.
 * @param proposals - the upstream proposal document.
 */
export function forkRetirementPins(fork, proposals) {
  return {
    armsDeadline: /kind: 'openingSent'/u.test(fork) && /armOpeningDeadline/u.test(fork),
    documentsRetirement: /首帧期限/u.test(proposals) && /退役/u.test(proposals),
  }
}

/**
 * Evaluate the contract.
 * @param read - file reader seam (tests inject fabricated sources).
 * @returns the failure list; empty means the pinned contract still holds.
 */
export function evaluate(read = (path) => readFileSync(path, 'utf8')) {
  const failures = []
  const host = hostFirstFrameContract(read(FILES.hostFollow))
  if (!host.hasFollow || !host.hasSnapshot) {
    failures.push('the host session/follow no longer yields an opening snapshot first')
  }
  if (host.hasBound) {
    failures.push('UPSTREAM LANDED A FIRST-FRAME BOUND: retire the client widening ladder (design 14 §D4, STATUS) and update this gate')
  }
  const client = clientOpenContract(read(FILES.clientSession))
  if (!client.hasDoOpen || !client.awaitsOpen) {
    failures.push('the client doOpen no longer awaits events.open (the client ladder may have moved)')
  }
  if (client.hasBound) {
    failures.push('the client doOpen gained a bound: the fork ladder is no longer the only owner')
  }
  const fork = forkRetirementPins(read(FILES.forkOpening), read(FILES.proposals))
  if (!fork.armsDeadline) failures.push('the fork no longer arms its opening deadline (openingSent/armOpeningDeadline)')
  if (!fork.documentsRetirement) failures.push('the retirement condition is no longer documented (upstream-proposals 首帧期限/退役)')
  return { failures }
}

/** Negative control: the detector must flag a bound and stay quiet without one. */
function selfTest() {
  const bounded = FIRST_FRAME_BOUND.test('const timeout = AbortSignal.timeout(30_000)')
  const named = FIRST_FRAME_BOUND.test('const firstFrameDeadline = Date.now() + 30_000')
  const quiet = !FIRST_FRAME_BOUND.test("async *follow() { yield { type: 'snapshot' } }")
  const ok = bounded && named && quiet
  console.log('upstream lifecycle contract self-test: ' + (ok ? 'ok' : 'FAILED'))
  process.exit(ok ? 0 : 1)
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    return
  }
  const { failures } = evaluate()
  if (failures.length === 0) {
    console.log('upstream lifecycle contract: host follow yields an opening snapshot with no first-frame bound; the fork ladder is the only owner')
    process.exit(0)
  }
  for (const failure of failures) console.error('upstream lifecycle contract: ' + failure)
  process.exit(1)
}

if (process.argv[1] && process.argv[1].endsWith('verify-upstream-lifecycle-contract.mjs')) main()
