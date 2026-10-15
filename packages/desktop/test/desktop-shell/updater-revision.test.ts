/**
 * updater-revision.test.ts — the stale-answer guard for the two update confirmation
 * actions (design 11 §4).
 *
 * ① UpdateState.revision is a monotonic generation: EVERY pushed state advances it;
 * ② download() refuses a confirmation carrying an older revision WITHOUT touching
 *    electron-updater (and the current revision still passes);
 * ③ restartAndInstall() has the same guard and never arms quitAndInstall on a stale one;
 * ④ internal callers without an expectation (undefined/null) keep the unguarded path —
 *    only the shell's IPC layer, which always supplies a revision, is fail-closed;
 * ⑤ the wire-shape parser (update-confirmation.ts) fails closed on malformed payloads;
 * ⑥ the shell wiring (shell-ipc-update.ts) parses every confirmation and re-pushes the
 *    current state on refusal — a source lock, because that module pulls the IPC graph.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isStaleConfirmation, STALE_CONFIRMATION_ERROR } from '../../updater.ts'
import { INVALID_CONFIRMATION_ERROR, parseConfirmationRevision } from '../../update-confirmation.ts'
import { makeController } from '../support/updater-harness.ts'

test('① revision is a monotonic generation: every pushed state advances it by one', () => {
  const { fake, controller } = makeController()
  assert.equal(controller.state().revision, 0, 'the initial snapshot is generation 0')
  fake.emit('checking-for-update')
  assert.equal(controller.state().revision, 1)
  fake.emit('update-available', { version: '0.2.0' })
  assert.equal(controller.state().revision, 2)
  fake.emit('download-progress', { percent: 40 })
  fake.emit('download-progress', { percent: 41 })
  assert.equal(controller.state().revision, 4, 'progress pushes advance the generation too')
})

test('② download refuses a stale revision without touching electron-updater', async () => {
  const { fake, controller } = makeController()
  fake.emit('update-available', { version: '0.2.0' })
  const current = controller.state().revision
  const stale = current - 1
  assert.deepEqual(await controller.download(stale), { ok: false, error: STALE_CONFIRMATION_ERROR })
  assert.deepEqual(await controller.download(current + 1), { ok: false, error: STALE_CONFIRMATION_ERROR },
    'a revision the process has not reached is refused too: the guard is equality, not <')
  assert.equal(fake.downloadCalls, 0, 'neither a stale nor a future confirmation may start a download')
  assert.deepEqual(await controller.download(current), { ok: true })
  assert.equal(fake.downloadCalls, 1)
})

test('③ restartAndInstall refuses a stale revision and arms only the current one', () => {
  const { fake, controller } = makeController()
  fake.emit('update-downloaded', { version: '0.2.0' })
  assert.equal(controller.state().phase, 'downloaded')
  const current = controller.state().revision
  assert.deepEqual(controller.restartAndInstall(current - 1), { ok: false, error: STALE_CONFIRMATION_ERROR })
  assert.deepEqual(controller.restartAndInstall(current + 1), { ok: false, error: STALE_CONFIRMATION_ERROR })
  assert.equal(fake.quitAndInstallCalls, 0, 'neither a stale nor a future restart may arm quitAndInstall')
  assert.deepEqual(controller.restartAndInstall(current), { ok: true })
  assert.equal(fake.quitAndInstallCalls, 1)
})

test('④ no expectation (undefined/null) is the internal-caller path, not the shell path', async () => {
  const { fake, controller } = makeController()
  fake.emit('update-available', { version: '0.2.0' })
  assert.deepEqual(await controller.download(), { ok: true })
  assert.deepEqual(await controller.download(null), { ok: true })
  assert.equal(fake.downloadCalls, 2, 'undefined/null mean "no expectation" (tests + internal callers)')
})

test('⑤ parseConfirmationRevision fails closed on every malformed payload', () => {
  assert.equal(parseConfirmationRevision({ revision: 0 }), 0)
  assert.equal(parseConfirmationRevision({ revision: 7 }), 7)
  const malformed: unknown[] = [
    null,
    undefined,
    3,
    '3',
    {},
    { revision: -1 },
    { revision: 1.5 },
    { revision: '1' },
    { revision: Number.NaN },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    [],
  ]
  for (const bad of malformed) {
    assert.equal(parseConfirmationRevision(bad), null, 'malformed payload must parse to null: ' + String(bad))
  }
  assert.match(INVALID_CONFIRMATION_ERROR, /revision/)
})

test('⑥ isStaleConfirmation: only a numeric mismatch (past OR future) is stale', () => {
  assert.equal(isStaleConfirmation(3, 3), false)
  assert.equal(isStaleConfirmation(3, 2), true, 'an older answer is stale')
  assert.equal(isStaleConfirmation(3, 4), true, 'a revision the process has not reached is not current either')
  assert.equal(isStaleConfirmation(3, undefined), false, 'no expectation = internal caller')
  assert.equal(isStaleConfirmation(3, null), false)
  // The controller is deliberately stricter than the wire parser: anything numeric that is
  // not the current generation is stale (fail-closed), which is why the shell's payload
  // validator must reject non-safe-integers BEFORE these calls.
  assert.equal(isStaleConfirmation(3, Number.NaN), true)
  assert.equal(isStaleConfirmation(3, 1.5), true)
  assert.equal(isStaleConfirmation(3, -1), true)
})

test('⑦ shell wiring: every confirmation parses the payload and re-pushes on refusal', () => {
  const source = readFileSync(join(import.meta.dirname, '..', '..', 'shell-ipc-update.ts'), 'utf8')
  const parses = source.split('parseConfirmationRevision(payload)').length - 1
  assert.equal(parses, 2, 'download and restartAndInstall must both parse { revision }')
  const resyncFailures = source.split('if (!result.ok) pushState(updater.state())').length - 1
  assert.equal(resyncFailures, 2, 'a refused confirmation must re-push the current state (renderer resync)')
  const resyncAll = source.split('pushState(updater.state())').length - 1
  assert.equal(resyncAll, 4, 'BOTH refusal kinds re-push: stale/failed action AND malformed payload')
  assert.ok(source.includes('await updater.download(revision)'), 'the parsed revision must reach download()')
  assert.ok(
    source.includes('updater.restartAndInstallAsync?.(revision) ?? updater.restartAndInstall(revision)'),
    'the parsed revision must reach both restart legs',
  )
  assert.ok(source.includes("from './update-confirmation.ts'"), 'the wire shape must come from the testable leaf')
})
