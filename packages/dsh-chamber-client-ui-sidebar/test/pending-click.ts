/**
 * pending-click.ts unit tests (plain node:test, no dsh, no DOM): the shared
 * double-click-rename pending slot (design 05 deviation P2-11, 2026-08 —
 * immediate-open + double-click rename, OpenChamber model). Covers the
 * click-accounting contract: first click records + returns false (open
 * immediately), second click on the same session within the window consumes +
 * returns true (rename), window boundaries, cross-session replacement, clear,
 * and the data-session-id containment check.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetPendingClickForTests,
  clearPendingClick,
  DOUBLE_CLICK_WINDOW_MS,
  isClickInsidePendingRow,
  noteSessionRowClick,
} from '../src/shared/pending-click.ts'

test('first click records the pending and returns false (open path); second click on the same session within the window consumes it and returns true (rename path)', () => {
  __resetPendingClickForTests()
  assert.equal(noteSessionRowClick('s1', 0), false)   // first click → open immediately
  assert.equal(noteSessionRowClick('s1', 100), true)  // double click → rename
  // The pending was consumed: a third click starts a fresh window (open).
  assert.equal(noteSessionRowClick('s1', 200), false)
})

test('the window is inclusive of DOUBLE_CLICK_WINDOW_MS and exclusive just past it', () => {
  __resetPendingClickForTests()
  assert.equal(noteSessionRowClick('s1', 0), false)
  assert.equal(noteSessionRowClick('s1', DOUBLE_CLICK_WINDOW_MS), true)       // exact boundary → double click
  __resetPendingClickForTests()
  assert.equal(noteSessionRowClick('s1', 0), false)
  assert.equal(noteSessionRowClick('s1', DOUBLE_CLICK_WINDOW_MS + 1), false)  // one ms later → re-open (idempotent), never rename
})

test('a slow second click on the same session never renames — it re-opens (idempotent) and re-arms', () => {
  __resetPendingClickForTests()
  assert.equal(noteSessionRowClick('s1', 0), false)
  assert.equal(noteSessionRowClick('s1', 5000), false) // misjudged double click → open path, strictly safe
  assert.equal(noteSessionRowClick('s1', 5100), true)  // a real double click right after still works
})

test('a click on a DIFFERENT session replaces the pending (its own window starts) instead of renaming', () => {
  __resetPendingClickForTests()
  assert.equal(noteSessionRowClick('s1', 0), false)
  assert.equal(noteSessionRowClick('s2', 100), false)  // different session → open s2, pending now s2
  assert.equal(noteSessionRowClick('s2', 200), true)   // second click on s2 within its window → rename s2
  assert.equal(noteSessionRowClick('s1', 300), false)  // s1's old window is gone (replaced) → open s1
})

test('clearPendingClick drops the pending — a later same-session click starts fresh', () => {
  __resetPendingClickForTests()
  assert.equal(noteSessionRowClick('s1', 0), false)
  clearPendingClick()
  assert.equal(noteSessionRowClick('s1', 100), false) // cleared → open path, not rename
})

test('isClickInsidePendingRow matches the pending session via data-session-id closest()', () => {
  __resetPendingClickForTests()
  const rowS1 = { getAttribute: (name: string) => (name === 'data-session-id' ? 's1' : null) }
  const rowS2 = { getAttribute: (name: string) => (name === 'data-session-id' ? 's2' : null) }
  const elementInS1 = { closest: (selector: string) => (selector === '[data-session-id]' ? rowS1 : null) }
  const elementInS2 = { closest: (selector: string) => (selector === '[data-session-id]' ? rowS2 : null) }

  assert.equal(noteSessionRowClick('s1', 0), false)
  assert.equal(isClickInsidePendingRow(elementInS1), true)  // inside the pending row → keep
  assert.equal(isClickInsidePendingRow(elementInS2), false) // a different session's row → outside → clear
  clearPendingClick()
  assert.equal(isClickInsidePendingRow(elementInS1), false) // no pending → never "inside"
  assert.equal(isClickInsidePendingRow(null), false)
  assert.equal(isClickInsidePendingRow(42), false)
})

test('isClickInsidePendingRow falls back to the parent element for text-node targets', () => {
  __resetPendingClickForTests()
  const rowS1 = { getAttribute: (name: string) => (name === 'data-session-id' ? 's1' : null) }
  const elementInS1 = { closest: (selector: string) => (selector === '[data-session-id]' ? rowS1 : null) }
  const textNodeInS1 = { parentElement: elementInS1 } // a Text node has no closest(), only parentElement
  assert.equal(noteSessionRowClick('s1', 0), false)
  assert.equal(isClickInsidePendingRow(textNodeInS1), true)
})
