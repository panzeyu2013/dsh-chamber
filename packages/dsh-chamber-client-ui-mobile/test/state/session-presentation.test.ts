/**
 * The mobile tier's single presentation read: the presented session id (rc.2
 * `retainedBy.mainView`) and the one concrete Session accessor (`binding`). The
 * stall arm and the read-watermark reporter both consume this module, so these
 * locks cover the migration a fake carrying only the removed pre-rc.2 accessors
 * would hide.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  presentedConcreteSession,
  presentedSessionId,
  type SessionsConcreteLoose,
} from '../../src/client/session-presentation.ts'

test('presentedSessionId: the mainView-retained row is the presented session', () => {
  assert.equal(
    presentedSessionId({ byId: { a: { retainedBy: {} }, b: { retainedBy: { mainView: 1 } } } }),
    'b',
    'the mainView-retained row is the presented session',
  )
  // An empty list presents nothing.
  assert.equal(presentedSessionId({ byId: {} }), undefined)
})

test('presentedSessionId: zero or non-mainView retention is never presented', () => {
  assert.equal(presentedSessionId({ byId: { a: { retainedBy: { mainView: 0 } } } }), undefined,
    'a zero mainView count presents nothing')
  assert.equal(presentedSessionId({ byId: { a: { retainedBy: { sidebarView: 1 } } } }), undefined,
    'a sidebar-only retention is not the presented session')
  assert.equal(presentedSessionId({ byId: { a: {} } }), undefined,
    'a row without retention data presents nothing')
  assert.equal(presentedSessionId({}), undefined, 'a snapshot without byId presents nothing')
  // Reverse assertion: the removed pre-rc.2 \`current\` field must never revive
  // presentation when no row is retained.
  const legacyShape = { byId: { a: { retainedBy: { mainView: 0 } } }, current: 'a' }
  assert.equal(presentedSessionId(legacyShape), undefined, 'the removed current field is never read')
})

test('presentedSessionId: absent and hostile snapshots fail closed', () => {
  assert.equal(presentedSessionId(undefined), undefined)
  assert.equal(presentedSessionId(null), undefined)
  const hostile = new Proxy({}, { get: () => { throw new Error('drift') } }) as never
  assert.doesNotThrow(() => { assert.equal(presentedSessionId(hostile), undefined) })
})

test('presentedConcreteSession: binding(id) is the ONE accessor', () => {
  const session = { resync: () => {}, openState: 'loading' }
  const rc2: SessionsConcreteLoose = {
    list: { getSnapshot: () => ({ byId: { a: { retainedBy: { mainView: 1 } } } }) },
    binding: id => (id === 'a' ? { session } : undefined),
  }
  assert.equal(presentedConcreteSession(rc2), session, 'the rc.2 binding(id) carrier reaches the face')
})

test('presentedConcreteSession: a resolve-only fake is rejected (reverse assertion)', () => {
  const session = { resync: () => {} }
  // The pre-rc.2 private accessor is gone from the vendor contract: a fake that
  // carries it and no binding must yield no face, never reach the session.
  const legacyOnly = {
    list: { getSnapshot: () => ({ byId: { a: { retainedBy: { mainView: 1 } } } }) },
    resolve: () => ({ session }),
  }
  assert.equal(presentedConcreteSession(legacyOnly), undefined,
    'the removed resolve(id) accessor must not be consulted')
})

test('presentedConcreteSession: unknown and throwing shapes fail closed', () => {
  const session = { resync: () => {} }
  assert.equal(presentedConcreteSession(undefined), undefined)
  assert.equal(presentedConcreteSession({}), undefined, 'no list and no accessor is not a session')
  assert.equal(presentedConcreteSession({
    list: { getSnapshot: () => ({ byId: { a: { retainedBy: { mainView: 1 } } } }) },
  }), undefined, 'a presented id with no binding degrades to unknown')
  assert.equal(presentedConcreteSession({
    list: { getSnapshot: () => ({ byId: { a: { retainedBy: { mainView: 1 } } } }) },
    binding: () => ({ session: null }),
  }), undefined, 'a null session carrier is not a face')
  assert.equal(presentedConcreteSession({
    list: { getSnapshot: () => ({ byId: { a: { retainedBy: { mainView: 1 } } } }) },
    binding: () => { throw new Error('drift') },
  }), undefined, 'a throwing binding fails closed')
  // No presented id ⇒ the accessor is never consulted.
  let consultedWithoutPresentation = 0
  assert.equal(presentedConcreteSession({
    list: { getSnapshot: () => ({ byId: { a: { retainedBy: {} } } }) },
    binding: () => { consultedWithoutPresentation += 1; return { session } },
  }), undefined)
  assert.equal(consultedWithoutPresentation, 0)
})
