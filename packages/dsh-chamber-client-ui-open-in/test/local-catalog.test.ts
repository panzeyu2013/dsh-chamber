/**
 * Local catalog client tests (design 20 §4.2) — the browser half of the
 * `openInApp` wire.
 *
 * The transport is injected, so everything here runs without an instance, a
 * socket or the DOM: what is pinned is the wire DISCIPLINE — the argument names
 * the host reads, both envelope levels the production call really carries
 * (TRANSPORT result → host domain carrier, see `transportOf`), the fail-closed
 * reads, the `data:` URL allow-list and the launch error mapping.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLocalCatalog, displayKindOf, type OpenInAppRpcCall } from '../src/client/local-catalog.ts'
import {
  OPEN_IN_APP_APPS_METHOD,
  OPEN_IN_APP_ICON_METHOD,
  OPEN_IN_APP_OPEN_METHOD,
} from '../src/shared/open-in-wire.ts'

interface Recorded {
  readonly endpoint: string
  readonly args: Readonly<Record<string, unknown>>
}

/**
 * A transport that answers from a table while recording every call.
 *
 * Each table entry is the DOMAIN answer the host returned (the `domainResult`
 * carrier, or a deliberately drifted shape); the helper wraps it in the
 * TRANSPORT result the injected call really answers in production — the
 * page-level instance client's `callUnary` (`{ok:true, value: domainAnswer}`).
 * Without that outer level every case below would test a shape production never
 * produces, which is exactly how the empty-catalog regression stayed green.
 */
function transportOf(answers: Readonly<Record<string, unknown>>): {
  readonly call: OpenInAppRpcCall
  readonly calls: Recorded[]
} {
  const calls: Recorded[] = []
  return {
    calls,
    call: async (endpoint, args) => {
      calls.push({ endpoint, args })
      if (!(endpoint in answers)) throw new Error(`unexpected endpoint ${endpoint}`)
      const answer = answers[endpoint]
      if (answer instanceof Error) throw answer
      return { ok: true, value: answer }
    },
  }
}

test('load maps the host catalog into local entries', async () => {
  const carrier = transportOf({ [OPEN_IN_APP_APPS_METHOD]: { ok: true, value: { apps: ['finder', 'terminal', 'vscode'] } } })
  const catalog = createLocalCatalog({ call: carrier.call })

  assert.deepEqual(await catalog.load(), [
    { id: 'finder', displayKind: 'file-manager', remoteCapable: false, available: true },
    { id: 'terminal', displayKind: 'terminal', remoteCapable: false, available: true },
    { id: 'vscode', displayKind: 'vscode', remoteCapable: false, available: true },
  ])
  assert.deepEqual(carrier.calls, [{ endpoint: OPEN_IN_APP_APPS_METHOD, args: {} }])
})

test('load drops malformed ids and duplicates instead of failing the whole read', async () => {
  const carrier = transportOf({
    [OPEN_IN_APP_APPS_METHOD]: { ok: true, value: { apps: ['finder', '', 42, 'finder', 'terminal'] } },
  })
  const catalog = createLocalCatalog({ call: carrier.call })

  assert.deepEqual((await catalog.load()).map(entry => entry.id), ['finder', 'terminal'])
})

test('load is fail-closed for a drifted, failing, refusing or unreachable host', async () => {
  const cases: readonly unknown[] = [
    { ok: true, value: { apps: 'not-an-array' } },
    { ok: true, value: null },
    { ok: false, error: { code: 'unavailable-app', message: 'nope' } },
    { ok: 'yes' },
    null,
    'text',
    new Error('transport failure'),
  ]
  for (const answer of cases) {
    const carrier = transportOf({ [OPEN_IN_APP_APPS_METHOD]: answer })
    const catalog = createLocalCatalog({ call: carrier.call })
    assert.deepEqual(await catalog.load(), [], `answer ${JSON.stringify(answer)}`)
  }
})

test('load reads BOTH envelope levels: a transport failure or a one-level answer is empty', async () => {
  // Raw transport answers (not wrapped by `transportOf`): a REFUSED transport
  // result, a transport result with no `ok` flag, one with no `value`, and —
  // the regression shape — the host domain carrier handed over as if it were
  // the transport result, i.e. one unwrap too few.
  const cases: readonly unknown[] = [
    { ok: false, error: { code: 'internal', message: '实例返回未知错误' } },
    { value: { ok: true, value: { apps: ['finder'] } } },
    { ok: true },
    { ok: true, value: { apps: ['finder'] } },
    null,
    'text',
  ]
  for (const answer of cases) {
    const calls: string[] = []
    const catalog = createLocalCatalog({
      call: async (endpoint) => {
        calls.push(endpoint)
        return answer
      },
    })
    assert.deepEqual(await catalog.load(), [], `answer ${JSON.stringify(answer)}`)
    assert.deepEqual(calls, [OPEN_IN_APP_APPS_METHOD], 'the endpoint is still asked exactly once')
  }
})

test('icon builds an allow-listed data URL and records the app parameter', async () => {
  const carrier = transportOf({
    [OPEN_IN_APP_ICON_METHOD]: { ok: true, value: { mime: 'image/png', dataBase64: 'AAAA' } },
  })
  const catalog = createLocalCatalog({ call: carrier.call })

  assert.equal(await catalog.icon('finder'), 'data:image/png;base64,AAAA')
  assert.deepEqual(carrier.calls, [{ endpoint: OPEN_IN_APP_ICON_METHOD, args: { app: 'finder' } }])
})

test('icon refuses a media type outside the host output set', async () => {
  const carrier = transportOf({
    [OPEN_IN_APP_ICON_METHOD]: { ok: true, value: { mime: 'text/html', dataBase64: 'AAAA' } },
  })
  const catalog = createLocalCatalog({ call: carrier.call })

  assert.equal(await catalog.icon('finder'), null)
})

test('icon is null for every failure shape', async () => {
  const cases: readonly unknown[] = [
    { ok: false, error: { code: 'icon-unavailable', message: 'none' } },
    { ok: true, value: { mime: 'image/png' } },
    { ok: true, value: { mime: 'image/png', dataBase64: '' } },
    { ok: true, value: {} },
    new Error('transport failure'),
  ]
  for (const answer of cases) {
    const carrier = transportOf({ [OPEN_IN_APP_ICON_METHOD]: answer })
    const catalog = createLocalCatalog({ call: carrier.call })
    assert.equal(await catalog.icon('finder'), null, `answer ${JSON.stringify(answer)}`)
  }
})

test('launch posts the app and the absolute path in the host argument names', async () => {
  const carrier = transportOf({ [OPEN_IN_APP_OPEN_METHOD]: { ok: true, value: {} } })
  const catalog = createLocalCatalog({ call: carrier.call })

  await catalog.launch('terminal', '/Users/me/project')
  assert.deepEqual(carrier.calls, [
    { endpoint: OPEN_IN_APP_OPEN_METHOD, args: { app: 'terminal', path: '/Users/me/project' } },
  ])
})

test('launch surfaces the host domain failure and rejects an unrecognizable answer', async () => {
  const failing = transportOf({
    [OPEN_IN_APP_OPEN_METHOD]: { ok: false, error: { code: 'directory-missing', message: 'directory does not exist: /nope' } },
  })
  await assert.rejects(
    createLocalCatalog({ call: failing.call }).launch('terminal', '/nope'),
    /directory-missing: directory does not exist: \/nope/u,
  )

  const drifted = transportOf({ [OPEN_IN_APP_OPEN_METHOD]: { value: {} } })
  await assert.rejects(createLocalCatalog({ call: drifted.call }).launch('terminal', '/nope'), /unrecognizable/u)

  const unreachable = transportOf({ [OPEN_IN_APP_OPEN_METHOD]: new Error('transport failure') })
  await assert.rejects(createLocalCatalog({ call: unreachable.call }).launch('terminal', '/nope'), /transport failure/u)
})

test('a generic-RPC refusal fails closed and still NAMES itself on launch', async () => {
  // The refusal is the transport envelope's `{ok:false,error}` arm (the Remote
  // threw / the gateway rejected the payload) — NOT the domain carrier. It must
  // read as an empty catalog and a null icon, and a launch must report the RPC
  // code+message instead of calling a named failure "unrecognizable".
  const refusal = { ok: false, error: { code: 'internal', message: '实例返回未知错误' } }
  const call = async (): Promise<unknown> => refusal

  assert.deepEqual(await createLocalCatalog({ call }).load(), [])
  assert.equal(await createLocalCatalog({ call }).icon('finder'), null)
  await assert.rejects(
    createLocalCatalog({ call }).launch('finder', '/ws'),
    /internal: 实例返回未知错误/u,
  )

  // A refusal whose error is not the `{code,message}` carrier shape (or is
  // absent) stays fail-closed: no domain answer, loud launch refusal.
  for (const malformed of [{ ok: false }, { ok: false, error: 'nope' }]) {
    const brokenCall = async (): Promise<unknown> => malformed
    assert.deepEqual(await createLocalCatalog({ call: brokenCall }).load(), [])
    await assert.rejects(createLocalCatalog({ call: brokenCall }).launch('finder', '/ws'), /unrecognizable/u)
  }
})

test('displayKindOf groups the families the button dresses', () => {
  assert.equal(displayKindOf('finder'), 'file-manager')
  assert.equal(displayKindOf('explorer'), 'file-manager')
  assert.equal(displayKindOf('filemanager'), 'file-manager')
  assert.equal(displayKindOf('vscode'), 'vscode')
  assert.equal(displayKindOf('vscodeinsiders'), 'vscode')
  assert.equal(displayKindOf('terminal'), 'terminal')
})
