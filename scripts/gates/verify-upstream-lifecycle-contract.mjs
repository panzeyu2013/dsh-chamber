#!/usr/bin/env node
/**
 * Upstream lifecycle-contract gate (P6, design 14 §D4).
 *
 * WHY. The fork's single-tier 30 s opening deadline exists only because the pinned
 * host `session/follow` has no first-frame bound and the client `doOpen` awaits it
 * without one: a lost opening frame parks `openState='loading'` forever. This gate
 * pins both **code** halves of that contract against the pinned vendor tree, so the
 * day upstream lands a bound the retirement is loud: re-evaluate retiring the
 * client deadline (design 14 §D4 ①/③) and update this gate.
 *
 * The fourth input is the contract's documented home, not a plan document: the
 * retirement condition must stay written where design 14 §D4 records this gate's
 * tripwire ({@link documentedRetirement}). design 17 §18.4 was checked first: it
 * keeps the *host-side* residual (if a first-frame deadline is ever needed it
 * belongs to host/session), not the retirement contract, so design 14 §D4 is the
 * stable sentence. The old check matched /首帧期限/ and /退役/ anywhere in
 * docs/progress/TODO.md — rewriting the plan turned the gate red while proving
 * only that two words existed. A documentation wording change is now a loud
 * warning, never a code-contract failure; losing the contract registration is a
 * failure because the design reference itself disappeared.
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
  // 0.2.2: the generator moved out of history.ts into the web controller (the history
  // module became the pagination split); the contract reads the new home.
  hostFollow: join(ROOT, 'vendor/harness-checkout/packages/api/session-controller/src/web/controller.ts'),
  clientSession: join(ROOT, 'vendor/harness-checkout/packages/api/session-controller/src/client/sessions/session.ts'),
  forkOpening: join(ROOT, 'packages/dsh-api-gateway/src/client/stream-client.ts'),
  retirementContract: join(ROOT, 'docs/design/14-sleep-background.md'),
}

/** The machine identifier the design contract records as its tripwire. */
export const LIFECYCLE_GATE_NAME = 'verify:upstream-lifecycle-contract'

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
 * The fork half: the deadline must still be armed by the reducer path.
 * @param fork - stream-client source.
 */
export function forkRetirementPins(fork) {
  return {
    armsDeadline: /kind: 'openingSent'/u.test(fork) && /armOpeningDeadline/u.test(fork),
  }
}

/**
 * Locate the retirement contract in its documented home: design 14 §D4's blockquote
 * "退役 tripwire" stanza. The stanza line must name BOTH the gate's machine
 * identifier AND the tripwire label; a stray mention elsewhere in the page cannot
 * register it. The stanza then runs until the next block-level item (`> ①`…/`> - `).
 *
 * Verdicts: `registered` = a tripwire stanza still names this gate (a missing
 * registration is a failure: the design contract no longer points at its tripwire);
 * `statesRetirement` = that stanza still states the upstream first-frame-bound
 * retirement condition (a missing/reworded statement is only a loud warning — prose
 * rewording must not fail the code contract).
 * @param contract - design 14 source (null/undefined when unreadable).
 * @returns {{ registered: boolean, statesRetirement: boolean }} documentation verdict.
 */
export function documentedRetirement(contract) {
  const lines = String(contract ?? '').split(/\r?\n/u)
  // Registration needs the gate identifier and the tripwire label on the SAME line:
  // a passing mention elsewhere in the page must not register the contract.
  const at = lines.findIndex((line) => line.includes(LIFECYCLE_GATE_NAME) && /[tT]ripwire/u.test(line))
  if (at === -1) return { registered: false, statesRetirement: false }
  const stanza = [lines[at]]
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('>')) break
    if (/^>\s*(?:[①②③④⑤⑥⑦⑧⑨⑩]|[-*]\s)/u.test(trimmed)) break
    stanza.push(line)
  }
  // The retirement condition is a CONDITIONAL statement about the upstream
  // first-frame bound, not the word "退役" on its own: the tripwire label and
  // sibling notes legitimately mention retirement. Requiring the bound phrase
  // near the retirement verb keeps a deleted condition (or a title-only stanza)
  // from silently passing.
  const body = stanza.slice(1).join('\n')
  const statesRetirement = /(?:首帧期限|first-frame)[^\n]{0,80}(?:退役|retire)|(?:退役|retire)[^\n]{0,80}(?:首帧期限|first-frame)|(?:客户端期限|client deadline)[^\n]{0,60}(?:退役|retire)/iu.test(body)
  return { registered: true, statesRetirement }
}

/**
 * Evaluate the contract.
 * @param read - file reader seam (tests inject fabricated sources).
 * @returns {{ failures: string[], warnings: string[] }} empty failures mean the
 *   pinned code contract still holds; warnings flag a stale documentation sentence.
 */
export function evaluate(read = (path) => readFileSync(path, 'utf8')) {
  const failures = []
  const warnings = []
  const host = hostFirstFrameContract(read(FILES.hostFollow))
  if (!host.hasFollow || !host.hasSnapshot) {
    failures.push('the host session/follow no longer yields an opening snapshot first')
  }
  if (host.hasBound) {
    failures.push('UPSTREAM LANDED A FIRST-FRAME BOUND: re-evaluate retiring the client opening deadline (design 14 §D4, STATUS) and update this gate')
  }
  const client = clientOpenContract(read(FILES.clientSession))
  if (!client.hasDoOpen || !client.awaitsOpen) {
    failures.push('the client doOpen no longer awaits events.open (the client ladder may have moved)')
  }
  if (client.hasBound) {
    failures.push('the client doOpen gained a bound: the fork opening deadline is no longer the only owner')
  }
  const fork = forkRetirementPins(read(FILES.forkOpening))
  if (!fork.armsDeadline) failures.push('the fork no longer arms its opening deadline (openingSent/armOpeningDeadline)')
  let contract = ''
  try {
    contract = read(FILES.retirementContract)
  } catch {
    contract = ''
  }
  const documentation = documentedRetirement(contract)
  if (!documentation.registered) {
    failures.push('the design 14 §D4 retirement contract no longer registers ' + LIFECYCLE_GATE_NAME + ': restore the tripwire stanza, or update this gate and the design together')
  } else if (!documentation.statesRetirement) {
    warnings.push('the design 14 §D4 tripwire stanza registers ' + LIFECYCLE_GATE_NAME + ' but no longer states the retirement condition (upstream first-frame bound ⇒ re-evaluate retiring the client deadline): review design 14 §D4 and this gate')
  }
  return { failures, warnings }
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
  const { failures, warnings } = evaluate()
  for (const warning of warnings) console.error('upstream lifecycle contract: WARNING ' + warning)
  if (failures.length === 0) {
    console.log('upstream lifecycle contract: host follow yields an opening snapshot with no first-frame bound; the fork opening deadline is the only owner' + (warnings.length > 0 ? '; documentation needs review (warning above)' : ''))
    process.exit(0)
  }
  for (const failure of failures) console.error('upstream lifecycle contract: ' + failure)
  process.exit(1)
}

if (process.argv[1] && process.argv[1].endsWith('verify-upstream-lifecycle-contract.mjs')) main()
