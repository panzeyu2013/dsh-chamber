/**
 * Hidden-tab polling gate + visibility seam (P1, 2026-11) unit tests — pure
 * Node, no document, no sidebar bridge: the gate and the injectable face
 * live in the dependency-free visibility-gate.ts module on purpose (the
 * coordinator only passes the seam through; its start()/stop() wiring is
 * covered by typecheck and the code review — the bridge it imports cannot
 * load under plain node).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isPollEligible, visibilityEvents, browserVisibility, __setVisibilityEventsForTests,
  type VisibilityEvents,
} from '../src/shared/visibility-gate.ts'

/** A fake visibility face recording the registered listener. */
function fakeVisibility(): {
  events: VisibilityEvents
  unsubscribed(): boolean
  registered(): boolean
  setVisibility(state: DocumentVisibilityState): void
  fire(): void
} {
  let listener: (() => void) | null = null
  let unsubscribed = false
  let state: DocumentVisibilityState = 'hidden'
  const events: VisibilityEvents = {
    read: () => state,
    onChange: (l) => {
      listener = l
      return () => {
        unsubscribed = true
        listener = null
      }
    },
  }
  return {
    events,
    unsubscribed: () => unsubscribed,
    registered: () => listener !== null,
    setVisibility: (next) => { state = next },
    fire: () => { listener?.() },
  }
}

test('isPollEligible: hidden gates the 30s refresh, visible runs it', () => {
  assert.equal(isPollEligible('hidden'), false)
  assert.equal(isPollEligible('visible'), true)
})

test('visibility seam: injection replaces the reader, undefined restores the browser default', () => {
  const fake = fakeVisibility()
  __setVisibilityEventsForTests(fake.events)
  try {
    // The coordinator reads the LIVE injectable, so the fake's state is what
    // the polling gate sees.
    assert.equal(visibilityEvents.read(), 'hidden')
    fake.setVisibility('visible')
    assert.equal(visibilityEvents.read(), 'visible', 'the seam serves the fake reader')
  } finally {
    __setVisibilityEventsForTests(undefined)
  }
  // Restored default is the browser face (document — not exercised here, the
  // assertion is only that the injectable slot points back at the default).
  assert.equal(visibilityEvents, browserVisibility)
})

test('visibility seam: onChange registers and the returned unsubscribe is symmetric', () => {
  const fake = fakeVisibility()
  __setVisibilityEventsForTests(fake.events)
  try {
    const unsubscribe = visibilityEvents.onChange(() => {})
    assert.equal(fake.registered(), true, 'onChange registers the listener')
    unsubscribe()
    assert.equal(fake.unsubscribed(), true, 'the returned unsubscribe is invoked')
    assert.equal(fake.registered(), false, 'listener is cleared')
  } finally {
    __setVisibilityEventsForTests(undefined)
  }
})
