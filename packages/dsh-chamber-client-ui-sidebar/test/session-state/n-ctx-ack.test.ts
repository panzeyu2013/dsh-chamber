/**
 * N-ctx 2-shell reading-ack negative lock (design 06 §4.1/§4.2, design 19 §3).
 *
 * THE DEVIATION. The vendor reading acknowledgement is document-level
 * (`ui-session-status/src/client/acknowledge.ts`: `document.visibilityState === 'visible'
 * && document.hasFocus()` gates the mainView-retained current Session's ack). In the
 * chamber page every mounted shell shares ONE document, so a HIDDEN shell's
 * mainView-retained `current` still looks "being read": the vendor never arms its own
 * `completionUnread` bit there and may even advance the Host read record another
 * official client of the same Host sees. Chamber does not patch upstream; the window
 * blue dot is kept by the App correction arm instead (design 06 §4.1).
 *
 * These are the PERMANENT negative assertions for the 2-shell case:
 *  A. a hidden shell's ack cannot clear the correction arm — the arm has NO ack /
 *     official-bit input at all (row type = running/beforeBaseline only); its only
 *     clears are the documented row-keyed ones (re-running, being read by the painted
 *     source / open intent, leaving an authoritative list). Reading one shell never
 *     sweeps the other shell's row, and `mergeRuntimeFacts` keeps rendering the dot.
 *  B. chamber synthesizes no ack: the single arm-table writer is the pure step's exit;
 *     the only reading WRITE chamber performs is the user-invoked row-menu mark through
 *     the page-level unary `sessionStatus/mark`, whose action vocabulary is read/unread
 *     only (never the vendor `acknowledge` action); no document focus/visibility
 *     listener feeds either path.
 *  C. E decision (2026-11-23, recommended default = skip): chamber mirrors neither
 *     `sidebar.panel.trailing` nor `sidebar.panellist.trailing` — no slot contract,
 *     owner props, factory or component (design 05 §2 / 06 §4.7).
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { mergeRuntimeFacts, stepCompletionArm, type CompletionArmStepInput } from '@dsh-chamber/dsh-chamber-client-core'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')
const readPath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

// Two shells, one document. Shell A is the painted (on-screen) view with `current: 'a'`;
// shell B is hidden but holds its own mainView retain on `current: 'b'` (session keep-alive).
const HIDDEN_B: CompletionArmStepInput = {
  current: 'b',
  rows: { b: { running: false } },
  painted: false,
  listComplete: true,
  stale: false,
}
const PAINTED_A_WITH_B_ROW: CompletionArmStepInput = {
  current: 'a',
  rows: { a: { running: false }, b: { running: false } },
  painted: true,
  listComplete: true,
  stale: false,
}

test('2 shells: a hidden shell ack cannot clear the correction arm, and the dot still renders', () => {
  // Shell B (hidden) completes: its mainView-retained row is exactly the vendor hole.
  const armed = stepCompletionArm({}, { b: true }, HIDDEN_B)
  assert.deepEqual(armed.arms, { b: true }, 'the hidden shell current row arms')
  // The vendor ack then fires (visible+focused page for the hidden shell too): it clears
  // the vendor's own bit / advances the Host read record. The chamber step has no ack
  // input; the re-reported steady row is byte-identical, so nothing decays.
  const afterAck = stepCompletionArm(armed.arms, armed.running, HIDDEN_B)
  assert.deepEqual(afterAck.arms, { b: true }, 'a hidden-shell document ack must not clear the arm')
  assert.equal(afterAck.changed, false, 'an ack never reaches the step: the inputs did not change')
  // Presentation: the official bit is gone/never armed after the ack; the arm ORs the dot back.
  assert.deepEqual(mergeRuntimeFacts({ sessions: { b: { running: false } } }, afterAck.arms)?.sessions.b,
    { running: false, completed: true }, 'the merged row keeps the blue dot through the arm')
  // And the arm is not a second authority: an official bit that IS armed passes through on its own.
  assert.deepEqual(mergeRuntimeFacts({ sessions: { b: { running: false, completed: true } } }, undefined)?.sessions.b,
    { running: false, completed: true }, 'the official bit stays authoritative when present')
})

test('2 shells: reading the painted shell never sweeps the hidden shell row (row-keyed, no second clear)', () => {
  // Both rows armed in their own shells; the user reads shell A (painted, current 'a').
  const both = stepCompletionArm({ a: true, b: true }, { a: true, b: true }, PAINTED_A_WITH_B_ROW)
  assert.deepEqual(both.arms, { b: true }, 'only the READ row (painted current) clears; the other shell keeps its dot')
  // The reverse direction: painting shell B clears only B.
  const readB = stepCompletionArm({ a: true, b: true }, { a: true, b: true }, {
    ...HIDDEN_B,
    rows: { a: { running: false }, b: { running: false } },
    painted: true,
  })
  assert.deepEqual(readB.arms, { a: true }, 'reading shell B clears only its own current row')
})

test('2 shells: only the documented clears touch a hidden arm (re-run / painted read / list leave)', () => {
  const armed = { b: true }
  const running = { b: true }
  assert.deepEqual(stepCompletionArm(armed, running, { ...HIDDEN_B, rows: { b: { running: true } } }).arms, {},
    'a re-running row disarms (the vendor deletes its own bit on the same edge)')
  assert.deepEqual(stepCompletionArm(armed, running, { ...HIDDEN_B, painted: true }).arms, {},
    'the painted shell reading that row is the documented clear')
  assert.deepEqual(stepCompletionArm(armed, running, { ...HIDDEN_B, rows: {}, listComplete: true }).arms, {},
    'a row absent from the authoritative list drops the arm')
  assert.deepEqual(stepCompletionArm(armed, running, { ...HIDDEN_B, listComplete: false, rows: {} }).arms, armed,
    'without the authoritative-list gate an absent row keeps the arm (freeze direction)')
  assert.deepEqual(stepCompletionArm(armed, running, { ...HIDDEN_B, readIntent: 'b' }).arms, armed,
    'readIntent is inert for an official ctx source: the App open intent is a facts-only rule')
})

test('the arm step has no official-bit / ack input at all (structural)', () => {
  const ARM = stripComments(read('../../../../packages/dsh-chamber-client-core/src/completion-arm.ts'))
  // The rows input is running/beforeBaseline only; the official `completionUnread` bit can
  // never be read OR cleared by the arm (its presentation authority is mergeRuntimeFacts).
  assert.equal(/completed|acknowledge|official/iu.test(ARM), false,
    'the correction arm must not mention the official bit or an ack: no second authority, no ack ingest')
  assert.match(ARM, /running\?: boolean; beforeBaseline\?: boolean/u,
    'the per-row input stays the running edge + beforeBaseline bit')
})

test('chamber performs no synthesized ack: the single reading write is the explicit mark unary', () => {
  const MARKS = stripComments(read('../../src/client/session-status-marks.ts'))
  const SESSIONS = stripComments(read('../../src/client/sidebar-root-sessions.ts'))
  const HOOK = stripComments(read('../../../../packages/renderer/src/app-hooks/use-notifications.ts'))

  // (1) Mark vocabulary: read/unread only — the vendor `acknowledge` action is never sent.
  assert.equal(/acknowledge/iu.test(MARKS), false, 'the chamber mark never emits the vendor ack action')
  assert.match(MARKS, /type: 'read'/u)
  assert.match(MARKS, /type: 'unread'/u)
  // (2) The unary call is the one transport; a mark is a write, never a retried safe read.
  assert.match(MARKS, /callUnary\(/u)
  assert.match(MARKS, /\{ mutation: true \}/u)
  // (3) Exactly one caller: the user-invoked row-menu funnel (no document listener feeds it).
  assert.equal((SESSIONS.match(/markSessionForSource\(/gu) ?? []).length, 1,
    'only the explicit onMarkSessionRead funnel calls the mark')
  assert.match(SESSIONS, /const onMarkSessionRead = /u)
  assert.equal(/hasFocus|visibilitychange|addEventListener/iu.test(SESSIONS), false,
    'no focus/visibility listener drives the mark: the ack path is vendor-owned, not chamber-owned')
  // (4) The arm's single writer is the pure step's exit; its input has no ack/official bit.
  assert.equal((HOOK.match(/completedStore\.setSource\(/gu) ?? []).length, 1,
    'the App writes the arm table only through the step exit (one writer)')
  const start = HOOK.indexOf('stepCompletionArm(')
  assert.ok(start >= 0, 'the step is the single arm entry')
  const armCall = HOOK.slice(start, HOOK.indexOf('\n      },', start))
  for (const field of ['current:', 'rows:', 'painted:', 'listComplete:', 'listKnown:', 'stale:', 'factsOnly:', 'readIntent:']) {
    assert.ok(armCall.includes(field), `the step receives ${field} — and nothing else`)
  }
  for (const forbidden of ['completedUnread', 'completed:', 'acknowledge', 'hasFocus', 'visibilitychange']) {
    assert.equal(armCall.includes(forbidden), false, `the arm step receives no ${forbidden} input`)
  }
  // (5) The App read fact is the user's open intent, not a document/ack fact.
  assert.match(HOOK, /readIntent: openIntentsRef\.current\[sourceId\]/u)
  // (6) The vendor's document ack is never installed by chamber code (it runs inside the
  // covered upstream row, and stays unpatched — design 06 §4.1).
  for (const ours of ['../../src/client/index.ts', '../../../../packages/renderer/src/App.tsx']) {
    assert.equal(/installReadingAcknowledgements/u.test(stripComments(read(ours))), false,
      'chamber does not install the vendor reading acknowledgement')
  }
})

test('E resolved: the trailing holes are NOT mirrored by chamber (recommended default = skip)', () => {
  const CONTRACT = stripComments(read('../../src/client/contract/slots.ts'))
  const INDEX = stripComments(read('../../src/client/index.ts'))
  assert.equal(/'sidebar\.panel\.trailing'/u.test(CONTRACT), false, 'no factory declaration')
  assert.equal(/'sidebar\.panellist\.trailing'/u.test(CONTRACT), false, 'no inline list declaration')
  assert.equal(/SidebarPanelTrailingOwnerProps/u.test(CONTRACT), false, 'no trailing owner props')
  assert.equal(/name: 'sidebar\.panel\.trailing'/u.test(INDEX), false, 'no factory registration')
  assert.equal(/from '\.\/panel-trailing\.tsx'/u.test(INDEX), false, 'no unreachable component import')
  assert.equal(/PanelTrailing|renderFactorySlot\(/u.test(INDEX), false, 'no trailing render path')
  assert.equal(existsSync(readPath('../../src/client/panel-trailing.tsx')), false,
    'the self-built behavior mirror stays deleted')
})

const VENDOR_CONTRACT = readPath('../../../../vendor/harness-packages/@deepseek-ai/dsh-client-ui-sidebar/src/client/contract/slots.ts')
const VENDOR_ABSENT = !existsSync(VENDOR_CONTRACT)
const seeVendor = (name: string, body: () => void): void => {
  test(name, { skip: VENDOR_ABSENT && process.env.DSH_CHAMBER_VENDOR_ABSENT === 'skip'
    ? 'vendor tree absent; explicit DSH_CHAMBER_VENDOR_ABSENT=skip' : false }, () => {
    if (VENDOR_ABSENT) {
      assert.fail('vendor/harness-packages is not materialized; this lock must stay loud '
        + '(explicit DSH_CHAMBER_VENDOR_ABSENT=skip is the only skip)')
    }
    body()
  })
}

seeVendor('pinned vendor still declares the trailing holes; chamber deliberately mirrors none (E: skip)', () => {
  const vendorContract = readFileSync(VENDOR_CONTRACT, 'utf8')
  assert.match(vendorContract, /'sidebar\.panel\.trailing': \{/u, 'pinned factory hole')
  assert.match(vendorContract, /'sidebar\.panellist\.trailing':/u, 'pinned inline list hole')
  assert.match(vendorContract, /SidebarPanelTrailingOwnerProps/u, 'pinned owner props type')
  const panelIcon = readFileSync(fileURLToPath(new URL(
    '../../../../vendor/harness-packages/@deepseek-ai/dsh-client-ui-sidebar/src/client/PanelIcon.tsx',
    import.meta.url,
  )), 'utf8')
  assert.match(panelIcon, /export function PanelTrailing\(/u,
    'the pinned upstream component is still PanelTrailing; a rename means revisiting the E fallout')
})

test('2-shell premise: the per-shell vendor status row is composite-covered', () => {
  // The deviation exists because the vendor's reading acknowledgement code RUNS INSIDE EVERY
  // mounted shell (the composite covers the session-status row). If that row stops being
  // composite-covered, the premise of this lock (and the correction arm's reason) changes.
  const covered = stripComments(read('../../../../packages/renderer/src/chamber-covered.ts'))
  assert.match(covered, /'@deepseek-ai\/dsh-client-ui-session-status'/u,
    'the per-instance session-status row stays composite-covered (the vendor ack runs in every shell)')
  const entry = stripComments(read('../../../../packages/renderer/src/chamber-entry.ts'))
  assert.match(entry, /register\('@deepseek-ai\/dsh-client-ui-session-status'/u,
    'the covered row is registered by the composite (one vendor ack installer per mounted shell)')
})

seeVendor('the vendor ack this negative lock guards is still document-level (pin-upgrade trigger)', () => {
  const ack = readFileSync(fileURLToPath(new URL(
    '../../../../vendor/harness-packages/@deepseek-ai/dsh-client-ui-session-status/src/client/acknowledge.ts',
    import.meta.url,
  )), 'utf8')
  assert.match(ack, /export function installReadingAcknowledgements/u,
    'the vendor still installs the visible-main-view reading acknowledgement')
  assert.match(ack, /document\.visibilityState === 'visible' && document\.hasFocus\(\)/u,
    'the ack is document-level; in the N-ctx page every hidden shell shares the one document (design 06 §4.1)')
})
