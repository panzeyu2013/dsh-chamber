/**
 * A1 seat-position lock (vendor patch 13, ownership transfer): the chamber sidebar
 * declares `sidebar.session.row.leading` itself, so it must render that seat at the
 * upstream address — BEFORE the row title. vendor ui-workspace rows/Rows.tsx renders
 * the seat (or the status dots) in the leading `.slot` ahead of the title; a
 * regression here would silently move the official schedule mark to the
 * title-trailing position and break the A1 geometry alignment.
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
