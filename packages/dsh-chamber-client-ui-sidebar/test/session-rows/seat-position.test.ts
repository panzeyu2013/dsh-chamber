/**
 * A1 seat-position lock (vendor patch 13, ownership transfer): the chamber sidebar
 * declares `sidebar.session.row.leading` itself, so it must render that seat at the
 * upstream address — BEFORE the row title. vendor ui-workspace rows/Rows.tsx renders
 * the seat (or the status dots) in the leading `.slot` ahead of the title; a
 * regression here would silently move the official occupant (ui-schedule's schedule
 * mark, when that plugin is in the roster) to the title-trailing position and break
 * the A1 geometry alignment. The chamber's own fallback marker is retired: the pin
 * carries no `schedule` session projection (the mark reads the Host catalog), so the
 * seat is owning-source-only and passes no `opts.fallback`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const rows = readFileSync(new URL('../../src/client/ServerSectionRows.tsx', import.meta.url), 'utf8')

test('the transferred leading seat renders before the row title', () => {
  const seat = rows.indexOf("'sidebar.session.row.leading'")
  const title = rows.indexOf('className={cc.sessionTitle}')
  assert.ok(seat !== -1, 'the leading seat call site must exist')
  assert.ok(title !== -1, 'the row title span must exist')
  assert.ok(seat < title, 'the leading seat must precede the title (upstream .slot order)')
  assert.match(rows, /renderSessionSeat\(\s*'sidebar\.session\.row\.hover'/, 'the hover seat must stay inside the card content')
})

test('the leading seat carries the upstream blank-row guard', () => {
  // vendor ui-workspace rows/Rows.tsx guards the seat with `!row.archived &&
  // !row.blank`; chamber rows now carry the sparse archived bit (three-state
  // archive filter), so BOTH halves are ported — an archived or blank row must
  // not evaluate the seat at all.
  const guard = rows.indexOf('session.archived !== true && session.blank !== true')
  const seat = rows.indexOf("'sidebar.session.row.leading'")
  assert.ok(guard !== -1, 'the non-blank guard must exist')
  assert.ok(seat !== -1, 'the leading seat call site must exist')
  assert.ok(guard < seat, 'the guard must wrap the leading seat expression')
})

test('the leading seat is owning-source-only and passes no fallback marker', () => {
  // 外来源的 sessionId 交给 occupant 只会查空；chamber 不再有自有标记可回落，
  // 故座席只在本实例行上求值，且调用点不带 opts（fallback 参数已从契约删除）。
  const owning = rows.indexOf('server.id === chamberInstanceId')
  const seat = rows.indexOf("'sidebar.session.row.leading'")
  assert.ok(owning !== -1, 'the owning-source gate must exist')
  assert.ok(owning < seat, 'the owning-source gate must wrap the leading seat')
  assert.match(rows, /renderSessionSeat\(\s*'sidebar\.session\.row\.leading',\s*\{ sessionId: session\.id \}\)/,
    'the leading seat takes only the occurrence owner — no fallback opts')
  assert.doesNotMatch(rows, /schedule\.active|SessionScheduleIndicator/, 'the retired fallback marker must not come back')
})
