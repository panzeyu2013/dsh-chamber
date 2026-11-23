/**
 * alpha.1 session-status consumer lock (design 06 §4.1; the "unread/failed UI" line):
 * the side panel's inject/read face, the page-level reading seat, the page-level unary
 * mark, the failure PRESENTATION overlay, the drag payload, and the E-decision default
 * for the two trailing holes.
 *
 * Each arm pins a SILENT failure mode:
 * 1. INJECT/FACE — the nested service `uiSession.sessionStatus` is only resolvable when
 *    that exact name is injected (cordis throws on an un-injected nested get), and the
 *    producer must read the alpha.1 fields (`completionFailed`, `readingReady`, `mark`)
 *    without the old inline cast. Missing either = the whole sidebar shell fails to mount.
 * 2. SEAT — a row is rendered by every shell, but a mark is per-instance: the seat's
 *    readiness must gate the menu, and teardown must retire it (or a remount inherits a
 *    stale readiness).
 * 3. MARK — the wire action direction and the Host clamp (read = MAX_SAFE_INTEGER, the
 *    Host clamps to its completedTurn) and the page-level endpoint.
 * 4. FAILED — the official `completionFailed` bit is the SEVENTH
 *    `projectRuntimeFacts` argument and writes a sparse typed row field; the red-dot /
 *    failed-label presentation reads it, and the design 14 §D4 red line holds (the
 *    notification edge never reads the failure bit).
 * 5. DRAG — the row carries `application/x-dsh-session`, the exact MIME the covered
 *    ui-subagent drop zone reads (pinned against the vendor source).
 * 6. The alpha.1 trailing holes stay declared upstream (vendor pin lock below); the
 *    E-decision arm lives in n-ctx-ack.test.ts.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import { failedFactOf } from '../../src/client/session-fact-failed.ts'
import { publishReadingSeat, readingReadyOf, readingSeatOf, subscribeReadingSeats } from '../../src/client/reading-seat.ts'
import { SESSION_STATUS_MARK_ENDPOINT, sessionStatusMarkAction } from '../../src/client/session-status-marks.ts'

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')
const INDEX = stripComments(read('../../src/client/index.ts'))
const ROWS = stripComments(read('../../src/client/ServerSectionRows.tsx'))
const STATE = stripComments(read('../../src/client/server-section-session-state.tsx'))
const FACE = stripComments(read('../../src/client/session-status-face.ts'))
const LOCALES = read('../../src/client/locales.ts')
const VENDOR_SIDEBAR = fileURLToPath(new URL(
  '../../../../vendor/harness-packages/@deepseek-ai/dsh-client-ui-sidebar/src/client/', import.meta.url))
const VENDOR_SESSION_STATUS = fileURLToPath(new URL(
  '../../../../vendor/harness-packages/@deepseek-ai/dsh-client-ui-session-status/src/', import.meta.url))
const MISSING = !existsSync(VENDOR_SIDEBAR + 'contract/slots.ts') || !existsSync(VENDOR_SESSION_STATUS + 'client/status.ts')
const OPT_OUT = process.env.DSH_CHAMBER_VENDOR_ABSENT === 'skip'

const seeIt = (name: string, body: () => void): void => {
  test(name, { skip: MISSING && OPT_OUT ? 'vendor tree absent; explicit DSH_CHAMBER_VENDOR_ABSENT=skip' : false }, () => {
    if (MISSING) {
      assert.fail('vendor/harness-packages is not materialized; this lock must stay loud '
        + '(explicit DSH_CHAMBER_VENDOR_ABSENT=skip is the only skip)')
    }
    body()
  })
}

test('the shell injects the nested session-status service and reads it through the face (no cast)', () => {
  assert.match(INDEX, /export const inject = \[[\s\S]*?'uiSession\.sessionStatus',[\s\S]*?\]/u,
    'the nested service name must be injected — an un-injected nested get throws in cordis')
  assert.match(INDEX, /'uiSession', 'uiSession\.sessionStatus',/u, 'the parent service stays injected beside the nested one')
  assert.match(INDEX, /const sessionStatus: SessionStatusFace = ctx\.uiSession\.sessionStatus/u,
    'the producer reads the nested member through the one documented face (no inline cast)')
  assert.doesNotMatch(INDEX, /as unknown as \{\s*sessionStatus/u, 'the alpha.1 cast deletion stays deleted')
  assert.match(INDEX, /completionFailed === true/u, 'the producer reads the alpha.1 failure bit')
  assert.match(INDEX, /completionUnread === true/u, 'the completion bit stays the runtime channel source')
  assert.match(INDEX,
    /projectRuntimeFacts\(\s*snapshot, subagentRunning, pendingBySession, runIds, statusRunning,\s*readStatusCompleted\(\), readStatusFailed\(\),\s*\)/u,
    'the official failed bit is the SEVENTH projection argument (formal contract, no overlay cast)')
})

seeIt('the face mirrors the pinned vendor status service', () => {
  const status = readFileSync(VENDOR_SESSION_STATUS + 'client/status.ts', 'utf8')
  for (const field of ['completionUnread', 'completionFailed']) {
    assert.ok(status.includes('readonly ' + field + ':') || status.includes(field + ':'), 'vendor status row has ' + field)
    assert.ok(FACE.includes(field), 'the chamber face documents ' + field)
  }
  assert.match(status, /readonly readingReady: HostObservable<boolean>/u, 'vendor exposes readingReady')
  assert.match(FACE, /readonly readingReady/u, 'the face carries readingReady (the seat gates on it)')
  assert.match(status, /async mark\(sessionId: SessionId, unread: boolean\): Promise<void>/u, 'vendor mark signature')
  assert.match(FACE, /mark\(sessionId: string, unread: boolean\): Promise<void>/u, 'the face carries the same mark shape')
  const nested = readFileSync(VENDOR_SESSION_STATUS + 'client/index.ts', 'utf8')
  assert.match(nested, /export const inject = \[.*'uiSession'.*\]/u, 'vendor declares the parent uiSession dependency')
})

test('the reading seat publishes readiness per source and retires on teardown', () => {
  assert.equal(readingReadyOf('nope'), false, 'an unmounted source has no ready seat (menu stays disabled)')
  const retire = publishReadingSeat('src-a', { ready: false })
  assert.equal(readingSeatOf('src-a')?.ready, false)
  assert.equal(readingReadyOf('src-a'), false)
  let notifications = 0
  const off = subscribeReadingSeats(() => { notifications += 1 })
  const retireReady = publishReadingSeat('src-a', { ready: true })
  retire() // the stale publication must NOT retire the newer one
  assert.equal(readingReadyOf('src-a'), true, 'a later publish wins; the retired earlier seat is a no-op')
  assert.ok(notifications >= 1)
  retireReady()
  off()
  assert.equal(readingSeatOf('src-a'), undefined, 'teardown retires the seat')
  assert.equal(readingReadyOf('src-a'), false)
  assert.match(INDEX, /publishReadingSeat\(chamberInstanceId/u, 'the shell publishes its seat')
  assert.match(INDEX, /readingSeatRetire\(\)/u, 'the effect teardown retires the seat')
  assert.match(INDEX, /sessionStatus\.readingReady\.subscribe\(publishSeat\)/u, 'readiness flips re-publish')
})

test('the mark action is the upstream direction with the Host clamp', () => {
  assert.equal(SESSION_STATUS_MARK_ENDPOINT, 'sessionStatus/mark')
  assert.deepEqual(sessionStatusMarkAction(true), { type: 'unread' }, 'unread keeps readTurn and arms manualUnread')
  assert.deepEqual(sessionStatusMarkAction(false), { type: 'read', throughTurn: Number.MAX_SAFE_INTEGER },
    'read uses the clamp: the Host takes min(throughTurn, completedTurn)')
  const source = stripComments(read('../../src/client/session-status-marks.ts'))
  assert.match(source, /callUnary\(/u, 'the page-level unary carrier is the transport (a row may be rendered by a foreign shell)')
  assert.match(source, /\{ mutation: true \}/u, 'a mark is a write: a lost answer is an unknown mutation, never a safe retry')
})

test('the row menu offers the upstream mark item, gated by the source seat and the unread direction', () => {
  assert.match(ROWS, /id: 'mark',/u, 'the upstream read-state menu id')
  assert.match(ROWS, /label: t\(unread \? 'menu\.markRead' : 'menu\.markUnread'\)/u, 'the label flips with the row bit')
  assert.match(ROWS, /disabled: !readingReady/u, 'reading not ready disables the verb (upstream parity)')
  assert.match(ROWS, /session\.archived === true \? \[\] : \[\{[\s\S]{0,120}id: 'mark'/u,
    'archived rows offer no reading mark (their reminders are suppressed)')
  assert.match(ROWS, /onMarkSessionRead\(server, session\.id, !unread\)/u,
    'the action carries the DESIRED state (upstream markSession(id, !unread))')
  assert.match(LOCALES, /'menu\.markRead': '标为已读'/u)
  assert.match(LOCALES, /'menu\.markUnread': '标为未读'/u)
  assert.match(LOCALES, /'menu\.markRead': 'Mark as read'/u)
})

test('the failed completion is presentation-only: red dot, failed label, machine attribute', () => {
  assert.match(LOCALES, /'status\.failed': '失败'/u)
  assert.match(LOCALES, /'status\.failed': 'Failed'/u)
  assert.match(STATE, /failedPresented\(server, session, row\) \? 'status\.failed' : 'status\.completed'/u,
    'a presented completion flips its label to Failed')
  assert.match(STATE, /failedPresented\(server, session, row\) \? cc\.stateFailed : cc\.stateCompleted/u,
    'the same slot swaps the dot colour')
  assert.match(STATE, /row\.state === 'completed' && failedFactOf\(/u,
    'only an actually PRESENTED completion turns red (pending/subagents/goal gates win)')
  assert.match(ROWS, /data-chamber-session-failed=/u, 'the row exposes the failure fact to machines')
  const css = read('../../src/client/sidebar-chamber.module.css')
  assert.match(css, /\.stateFailed \{[\s\S]{0,160}--dsw-alias-state-error-primary/u,
    'the failed dot uses the error tone, not the completed brand blue')
})

test('failedFactOf is a normal typed field read (no cast) over the client-core row type', () => {
  assert.equal(failedFactOf({ failed: true }), true, 'the sparse true bit presents')
  assert.equal(failedFactOf({ failed: undefined }), false, 'absent = no such fact')
  assert.equal(failedFactOf(undefined), false, 'a row absent from the report takes no fact')
  const source = read('../../src/client/session-fact-failed.ts')
  assert.doesNotMatch(source, /as \{ failed/u, 'the narrow cast is gone; the field is part of InstanceRuntimeReport')
  assert.match(source, /row\?\.failed === true/u, 'the read is the typed row field')
})

test('the notification edge never reads the failure bit (design 14 §D4 red line)', () => {
  const observation = readFileSync(new URL(
    '../../../../packages/renderer/src/completion-observation.ts', import.meta.url), 'utf8')
  assert.equal(/completionFailed|failedFactOf|failed\?:/u.test(observation), false,
    'the notification edge classifies turn/end kinds only; the failure bit is presentation')
})

test('the session row also writes the covered drop-zone MIME', () => {
  assert.match(ROWS, /setData\('application\/x-dsh-session', session\.id\)/u,
    'the row carries the shared session-drag type (upstream Rows.tsx contract)')
  assert.match(ROWS, /event\.dataTransfer\.effectAllowed = 'copyMove'/u,
    'a reorderable row advertises copyMove (upstream reorder arm)')
  seeIt('the covered drop zone still reads this exact MIME', () => {
    const drop = readFileSync(fileURLToPath(new URL(
      '../../../../vendor/harness-packages/@deepseek-ai/dsh-client-ui-subagent/src/client/sidebar-chat/SessionDropZone.tsx',
      import.meta.url,
    )), 'utf8')
    assert.match(drop, /SESSION_DRAG_TYPE: SessionDragType = 'application\/x-dsh-session'/u,
      'the ui-subagent overlay reads application/x-dsh-session; renaming our payload would silently kill the drop')
  })
})

seeIt('the pinned sidebar still declares the trailing holes the shell does NOT mirror (E resolved: skip)', () => {
  const vendorContract = readFileSync(VENDOR_SIDEBAR + 'contract/slots.ts', 'utf8')
  assert.match(vendorContract, /'sidebar\.panel\.trailing': \{/u, 'pinned factory hole (vendor)')
  assert.match(vendorContract, /'sidebar\.panellist\.trailing':/u, 'pinned inline list hole (vendor)')
  assert.match(vendorContract, /SidebarPanelTrailingOwnerProps/u, 'pinned owner props type (vendor)')
  const panelIcon = readFileSync(VENDOR_SIDEBAR + 'PanelIcon.tsx', 'utf8')
  assert.match(panelIcon, /export function PanelTrailing\(/u,
    'the pinned factory component is still PanelTrailing; a rename means revisiting the E decision record')
  const ours = read('../../src/client/contract/slots.ts')
  assert.equal(/'sidebar\.panel\.trailing'/u.test(ours), false,
    'E resolved: chamber mirrors neither trailing hole (user authorized recommended default = skip)')
})
