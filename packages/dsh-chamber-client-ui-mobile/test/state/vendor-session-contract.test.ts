/**
 * VENDOR SESSION-CONTRACT LOCKSTEP for the mobile presentation read
 * (packages/dsh-chamber-client-ui-mobile/src/client/session-presentation.ts).
 *
 * The mobile tier reads the presented session as the official list row whose
 * retainedBy.mainView count is positive, and reaches the concrete Session
 * through the sessions service's binding(id) accessor (.session carrier). Both
 * are VENDOR facts on the pinned dsh tree, not chamber inventions, so a pin
 * upgrade that moves them would leave the mobile read silently presenting
 * nothing. This file pins the facts by source text on the PINNED tree:
 *
 *  1. the ONLY producer of a mainView count is the official ui-workspace view
 *     owner: replaceMain retains with source 'mainView';
 *  2. retain() increments the caller source's count in the local retention
 *     record, and publishRetention writes that record onto the list row;
 *  3. SessionRetainInfo.retainedBy is the declared count map, ISessions.retain
 *     is the entry point, and binding(id) returns a SessionBinding whose
 *     .session is the concrete face.
 *
 * The last test is the chamber consumer half and always runs: it drives the
 * mobile read itself (presentedSessionId / presentedConcreteSession) against the
 * pinned shape, so a missing vendor tree still produces an executed test.
 *
 * The tree is resolved through the vendor symlink layout
 * (vendor/harness-packages/@deepseek-ai/...): a missing tree LOUD-SKIPS the
 * vendor locks (they read nothing and must not read as green).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalize, stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import { presentedConcreteSession, presentedSessionId } from '../../src/client/session-presentation.ts'

const VENDOR_ROOT = fileURLToPath(new URL('../../../../vendor/harness-packages/@deepseek-ai', import.meta.url))
const VENDOR_SKIP = existsSync(VENDOR_ROOT)
  ? false
  : 'vendor/harness-packages 未物化（pnpm install / 子模块缺失）：' + VENDOR_ROOT

/** Code-only, whitespace-normalized text of one repo-relative source file. */
function repoSource(path: string): string {
  return normalize(stripComments(readFileSync(fileURLToPath(new URL('../../../../' + path, import.meta.url)), 'utf8')))
}

const SESSION_CONTROLLER = 'vendor/harness-packages/@deepseek-ai/dsh-api-session-controller/src/client'
const UI_WORKSPACE = 'vendor/harness-packages/@deepseek-ai/dsh-client-ui-workspace/src/client'

test('vendor session contract: the official view owner is the only mainView producer', { skip: VENDOR_SKIP }, () => {
  const navigation = repoSource(UI_WORKSPACE + '/navigation.ts')
  assert.match(
    navigation,
    /const reference = this\.sessions\.retain\(target, \{ source: 'mainView' \}\)/,
    "replaceMain no longer retains with source 'mainView' - a positive retainedBy.mainView would no longer mean presented",
  )
})

test('vendor session contract: retain() counts the caller source and publishes it on the list row', { skip: VENDOR_SKIP }, () => {
  const service = repoSource(SESSION_CONTROLLER + '/sessions/service.ts')
  assert.match(
    service,
    /retainedBy: freezeRetainedBy\(\{ \.\.\.previous\.retainedBy, \[source\]: \(previous\.retainedBy\[source\] \?\? 0\) \+ 1 \}\)/,
    'retainScope no longer increments the caller source count - the mainView presentation fact must be re-derived',
  )
  assert.match(
    service,
    /this\.list\.set\(\{ \.\.\.state, byId: \{ \.\.\.state\.byId, \[id\]: \{ \.\.\.row, retainedBy \} \} \}\)/,
    'publishRetention no longer writes retainedBy onto the list row - the mobile read would see no presented row',
  )
})

test('vendor session contract: the contract declares retainedBy, retain and binding', { skip: VENDOR_SKIP }, () => {
  const contract = repoSource(SESSION_CONTROLLER + '/contract/sessions.ts')
  assert.match(
    contract,
    /readonly retainedBy: Readonly<Partial<Record<SessionReferenceSource, number>>>/,
    'SessionRetainInfo no longer declares the source-count map the mobile presentation read consumes',
  )
  assert.match(
    contract,
    /retain\(target: SessionTarget, options: SessionRetainOptions\): SessionReference/,
    'ISessions.retain signature changed - the retain-based presentation contract must be re-derived',
  )
  assert.match(
    contract,
    /binding\(id: SessionId\): SessionBinding \| undefined/,
    'ISessions.binding(id) is gone from the contract - the mobile concrete-session accessor must be re-derived',
  )
})

test('vendor session contract: binding(id) returns the SessionBinding carrier whose .session is the face', { skip: VENDOR_SKIP }, () => {
  const service = repoSource(SESSION_CONTROLLER + '/sessions/service.ts')
  assert.match(
    service,
    /binding\(id: SessionId\): SessionBinding \| undefined \{ return this\.scopes\.get\(id\)\?\.binding \}/,
    'ClientSessions.binding(id) changed - the mobile concrete-session accessor must be re-derived',
  )
  assert.match(
    service,
    /export interface SessionBinding \{ readonly sessionId: SessionId readonly session: SessionFace/,
    'SessionBinding.session is no longer the carrier property the mobile read consumes',
  )
})

test('chamber mobile lock: the presentation read consumes exactly those vendor facts', () => {
  assert.equal(
    presentedSessionId({ byId: { a: { retainedBy: {} }, b: { retainedBy: { mainView: 1 } } } }),
    'b',
    'the mobile presented-id read no longer keys on a positive retainedBy.mainView',
  )
  assert.equal(
    presentedSessionId({ byId: { a: { retainedBy: { mainView: 0 } } } }),
    undefined,
    'a zero mainView count must not present the row',
  )
  const session = { id: 'b' }
  assert.equal(
    presentedConcreteSession({
      list: { getSnapshot: () => ({ byId: { b: { retainedBy: { mainView: 1 } } } }) },
      binding: (id: string) => (id === 'b' ? { session } : undefined),
    }),
    session,
    'the mobile concrete-session read no longer reaches .session through binding(id)',
  )
})
