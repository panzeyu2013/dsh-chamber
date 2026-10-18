/**
 * Rotating refresh wave (design 08 §5 / design 26 §D7): a tick refreshes at most
 * `cap` connected sources and the next tick continues from where it stopped, so a
 * wide fleet is covered in ceil(N/cap) beats without fanning one unary per source
 * into the shared same-origin pool.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { selectPollWave } from '../../src/shared/poll-wave.ts'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const COORDINATOR = fileURLToPath(new URL('../../src/shared/coordinator.ts', import.meta.url))

test('selectPollWave: a cap at or above the roster takes everyone once, then wraps', () => {
  const plan = selectPollWave(['a', 'b'], 0, 4)
  assert.deepEqual(plan.wave, ['a', 'b'])
  assert.equal(plan.cursor, 0, 'a full-coverage wave returns to the head')
  assert.deepEqual(selectPollWave([], 0, 2), { wave: [], cursor: 0 })
  assert.deepEqual(selectPollWave(['a'], 0, 0), { wave: [], cursor: 0 }, 'cap 0 means "do not poll"')
})

test('selectPollWave: no source is skipped and none repeats inside a wave', () => {
  const ids = ['s0', 's1', 's2', 's3', 's4']
  let cursor = 0
  const waves: string[][] = []
  for (let beat = 0; beat < 5; beat += 1) {
    const plan = selectPollWave(ids, cursor, 2)
    cursor = plan.cursor
    waves.push([...plan.wave])
    assert.equal(new Set(plan.wave).size, plan.wave.length, 'a wave never repeats a source')
    assert.ok(plan.wave.length <= 2, 'the cap holds')
  }
  const covered = new Set(waves.flat())
  assert.equal(covered.size, ids.length, 'every source is reached within ceil(N/cap) beats')
  assert.deepEqual(waves[0], ['s0', 's1'])
  assert.deepEqual(waves[1], ['s2', 's3'])
  assert.deepEqual(waves[2], ['s4', 's0'], 'the tail beat wraps to the head')
})

test('selectPollWave: a negative or non-integer cursor never selects from the tail', () => {
  assert.deepEqual(selectPollWave(['a', 'b', 'c'], -1, 2).wave, ['c', 'a'])
  assert.deepEqual(selectPollWave(['a', 'b', 'c'], 1.7, 2).wave, ['b', 'c'])
})

test('lock: the coordinator owns the wave and clears its retry timers on stop', async () => {
  const source = stripComments(await readFile(COORDINATOR, 'utf8'))
  assert.match(source, /const GIT_POLL_WAVE = 2/, 'the tick wave cap stays pinned')
  assert.match(source, /const GIT_VISIBILITY_WAVE = 4/, 'the visible edge has its own (wider) cap')
  assert.match(source, /refreshWave\(GIT_VISIBILITY_WAVE, chamberBridge\.getActiveSource\(\)\)/,
    'waking the page refreshes the ACTIVE source first through the wider wave')
  assert.match(source, /for \(const timer of retryTimers\.values\(\)\) clearTimeout\(timer\)/,
    'detach must clear pending not-dispatched retries (an untracked chain outlived detach before)')
  assert.doesNotMatch(source, /setTimeout\(\(\) => \{ void refreshSource\(sourceId\) \}, 3_000\)/,
    'the unbounded 3s chain must not come back')
})
