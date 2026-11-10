/** FW2 popup rate limit: 6 accepted per tab occurrence per rolling 60 s. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allowOpenRequest } from '../../src/client/browser/popup-limit.ts'

test('six popups per rolling minute, refusals are silent', () => {
  const times: number[] = []
  for (let i = 0; i < 6; i += 1) assert.equal(allowOpenRequest(times, i * 1000), true)
  // The seventh inside the window is refused (no error surface).
  assert.equal(allowOpenRequest(times, 6_000), false)
  assert.equal(allowOpenRequest(times, 59_000), false)
  // The window rolls: the first admitted slot frees after 60 s and admits again.
  assert.equal(allowOpenRequest(times, 60_001), true)
})
